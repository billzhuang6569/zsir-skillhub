//! Hand an independently usable copy back to explicitly selected Agent folders.
//! Never export runtime credentials or overwrite an unrelated native Skill.
use super::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmanagePlan {
    pub destinations: Vec<String>,
    pub affected_agents: Vec<String>,
    pub plan_digest: String,
}

fn destinations(skill_id: &str, agents: &[String]) -> Result<Vec<PathBuf>, String> {
    if agents.is_empty() {
        return Err("请选择至少一个接收文件的工具".into());
    }
    let home = crate::user_home_dir().ok_or("无法找到用户目录")?;
    // A fresh detection pass: a handoff writes into the Agent's Skill root,
    // so it needs the same admission as an install projection.
    destinations_with(
        &home,
        skill_id,
        agents,
        &crate::known_agents(),
        &crate::detect_agents(),
    )
}

fn destinations_with(
    home: &Path,
    skill_id: &str,
    agents: &[String],
    known: &[(&'static str, &'static str, &'static str)],
    detected_agents: &[crate::AgentInfo],
) -> Result<Vec<PathBuf>, String> {
    if agents.is_empty() {
        return Err("请选择至少一个接收文件的工具".into());
    }
    let mut paths = BTreeSet::new();
    for agent in agents {
        let (key, agent_name, relative) = known
            .iter()
            .find(|(key, _, _)| key == agent)
            .ok_or("当前平台不支持所选工具")?;
        if let Some(refusal) = crate::skill_write_refusal(key, agent_name, detected_agents) {
            return Err(refusal);
        }
        let managed =
            crate::spaces::channel_root(home, crate::official_channel::CHANNEL).join("skills");
        let profile = read_current_profile_at_path(&managed.join(skill_id))?;
        crate::spaces::require_profile_at(managed.parent().ok_or("Skill 根目录无效")?, &profile)?;
        let name = projection_name_from_profile(skill_id, &profile)?;
        let parent = home.join(relative);
        validate_real_directory(&parent, "工具 Skill 目录")?;
        paths.insert(parent.join(&name));
    }
    Ok(paths.into_iter().collect())
}

fn plan_at(source: &Path, paths: &[PathBuf], owned_targets: &[PathBuf]) -> Result<String, String> {
    validate_real_directory(source, "Skill 文件夹")?;
    let mut digest = Sha256::new();
    update_plan_digest_field(&mut digest, &fingerprint_hex(source)?);
    for path in paths {
        update_plan_digest_field(&mut digest, &path.to_string_lossy());
        match fs::symlink_metadata(path) {
            Ok(_) => {
                if !owned_targets
                    .iter()
                    .any(|target| is_symlink_to_path(path, target))
                {
                    return Err(format!("{} 已有独立文件，请先处理同名冲突", path.display()));
                }
                update_plan_digest_field(
                    &mut digest,
                    &fs::read_link(path)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy(),
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                update_plan_digest_field(&mut digest, "absent")
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[tauri::command]
pub fn preflight_unmanage_skill(
    skill_id: String,
    agents: Vec<String>,
) -> Result<UnmanagePlan, String> {
    validate_skill_id(&skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    read_profile_result(&skill_id)?;
    reconcile_skill_projection_at(&skillhub_dir(), &skills_dir(), &skill_id)?;
    let paths = destinations(&skill_id, &agents)?;
    let source = skill_path(&skill_id);
    let targets = vec![
        source.clone(),
        projection_root_at(&skillhub_dir(), &skill_id).join("current"),
    ];
    let plan_digest = plan_at(&source, &paths, &targets)?;
    let affected_agents = crate::known_agents()
        .into_iter()
        .filter(|(_, _, relative)| {
            crate::user_home_dir().is_some_and(|home| {
                paths
                    .iter()
                    .any(|p| p.parent() == Some(home.join(relative).as_path()))
            })
        })
        .map(|(_, name, _)| name.to_string())
        .collect();
    Ok(UnmanagePlan {
        destinations: paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        affected_agents,
        plan_digest,
    })
}

// Use a full file copy (not hard links), retaining supporting files and executable
// bits. Refuse symlinks rather than following data outside the Skill directory.
fn copy_independent(source: &Path, stage: &Path) -> Result<(), String> {
    fs::create_dir(stage).map_err(|e| e.to_string())?;
    let mut count = 0;
    let mut bytes = 0u64;
    for entry in WalkDir::new(source)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || !matches!(
                    e.file_name().to_str(),
                    Some(".git" | ".skillhub.json" | ".DS_Store")
                )
        })
    {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.depth() == 0 {
            continue;
        }
        count += 1;
        if count > 100_000 || entry.depth() > 32 {
            return Err("文件过多，已停止取消托管".into());
        }
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|e| e.to_string())?;
        if entry.file_type().is_symlink() {
            return Err("Skill 含外部链接，请先整理为独立文件后重试".into());
        }
        if is_local_env_value_path(relative) {
            continue;
        }
        let destination = stage.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir(&destination).map_err(|e| e.to_string())?;
        } else if entry.file_type().is_file() {
            bytes = bytes.saturating_add(entry.metadata().map_err(|e| e.to_string())?.len());
            if bytes > 1024 * 1024 * 1024 {
                return Err("文件超过 1 GB，已停止取消托管".into());
            }
            fs::copy(entry.path(), destination).map_err(|e| e.to_string())?;
        } else {
            return Err("Skill 含不支持的文件类型".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn unmanage_skill(
    skill_id: String,
    agents: Vec<String>,
    plan_digest: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        unmanage_skill_blocking(skill_id, agents, plan_digest)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn unmanage_skill_blocking(
    skill_id: String,
    agents: Vec<String>,
    plan_digest: String,
) -> Result<String, String> {
    let profile = read_profile_result(&skill_id)?;
    let _lease = version_session_lease(&profile)?;
    let plan = preflight_unmanage_skill(skill_id.clone(), agents.clone())?;
    if plan.plan_digest != plan_digest {
        return Err("文件或安装状态已变化，请重新确认".into());
    }
    let paths = destinations(&skill_id, &agents)?;
    let source = skill_path(&skill_id);
    let fingerprint = fingerprint_hex(&source)?;
    let transaction_id = uuid::Uuid::new_v4().to_string();
    let journal_root = skillhub_dir().join("handoffs");
    fs::create_dir_all(&journal_root).map_err(|e| e.to_string())?;
    validate_real_directory(&journal_root, "交回文件记录目录")?;
    let journal = journal_root.join(format!("{transaction_id}.json"));
    let stages: Vec<_> = paths
        .iter()
        .map(|p| {
            p.parent()
                .unwrap()
                .join(format!(".skillhub-handoff-{transaction_id}"))
        })
        .collect();
    let backups: Vec<_> = paths
        .iter()
        .map(|p| {
            p.parent()
                .unwrap()
                .join(format!(".skillhub-link-{transaction_id}"))
        })
        .collect();
    write_private_file(&journal, &serde_json::json!({"status":"prepared", "skillId":skill_id, "destinations":paths, "stages":stages, "linkBackups":backups}).to_string())?;
    for stage in &stages {
        copy_independent(&source, stage)?;
        if fingerprint_hex(stage)? != fingerprint {
            return Err("复制期间文件发生变化，未解除托管，请重试".into());
        }
    }
    // A stale preflight never grants permission to replace a changed target.
    if preflight_unmanage_skill(skill_id.clone(), agents)?.plan_digest != plan_digest
        || fingerprint_hex(&source)? != fingerprint
    {
        return Err("文件已变化，未解除托管；暂存文件已保留供恢复".into());
    }
    let mut moved = Vec::<usize>::new();
    let mut saved_links = Vec::<usize>::new();
    let result = (|| -> Result<String, String> {
        for (i, path) in paths.iter().enumerate() {
            validate_real_directory(path.parent().ok_or("工具文件夹不存在")?, "工具 Skill 目录")?;
            if fs::symlink_metadata(path).is_ok() {
                rename_noreplace(path, &backups[i]).map_err(|e| e.to_string())?;
                saved_links.push(i);
                if !is_symlink_to_path(&backups[i], &source)
                    && !is_symlink_to_path(
                        &backups[i],
                        &projection_root_at(&skillhub_dir(), &skill_id).join("current"),
                    )
                {
                    return Err("安装位置已变化，已停止交回文件".into());
                }
            }
            rename_noreplace(&stages[i], path).map_err(|e| e.to_string())?;
            moved.push(i);
        }
        // Native deletion archives canonical files, configuration and history;
        // it never calls the Server. Independent destinations are not ours to delete.
        reconcile_skill_projection_at(&skillhub_dir(), &skills_dir(), &skill_id)?;
        if fingerprint_hex(&source)? != fingerprint {
            return Err("交回期间原文件有新修改，请重试".into());
        }
        // A Skill synced with the signed-in account stays managed and keeps
        // syncing (#91): the selected tools got their own copies in place of
        // the SkillHub links, nothing else changes.
        if read_profile_result(&skill_id)
            .ok()
            .as_ref()
            .is_some_and(crate::library_sync::synced_to_signed_in_account)
        {
            return Ok(String::new());
        }
        delete_managed_skill(skill_id.clone())
    })();
    match result {
        Ok(recovery) => {
            write_private_file(&journal, &serde_json::json!({"status":"completed", "skillId":skill_id, "destinations":paths, "recovery":recovery, "linkBackups":backups}).to_string())
                .map_err(|_| "已交回文件，但恢复记录更新失败；请检查本机回收站".to_string())?;
            Ok(recovery)
        }
        Err(error) => {
            let mut failures = Vec::new();
            for i in moved.into_iter().rev() {
                // Never erase edits made by an Agent while the transaction runs.
                if fingerprint_hex(&paths[i]).ok().as_deref() != Some(fingerprint.as_str()) {
                    failures.push("交回的文件有新修改，已保留".to_string());
                    continue;
                }
                if let Err(e) = rename_noreplace(&paths[i], &stages[i]) {
                    failures.push(e.to_string());
                }
            }
            for i in saved_links.into_iter().rev() {
                if let Err(e) = rename_noreplace(&backups[i], &paths[i]) {
                    failures.push(e.to_string());
                }
            }
            Err(if failures.is_empty() {
                format!("取消托管失败，原安装已恢复：{error}")
            } else {
                format!(
                    "取消托管未完成；文件和恢复记录已保留：{error}；{}",
                    failures.join("；")
                )
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_info(key: &str, skills_status: crate::AgentSkillsStatus) -> crate::AgentInfo {
        crate::AgentInfo {
            key: key.into(),
            name: key.into(),
            dir: String::new(),
            detected: true,
            detection_source: crate::AgentDetectionSource::Cli,
            skills_status,
            detection_state: crate::AgentDetectionState::Detected,
            detection_issues: Vec::new(),
        }
    }

    #[test]
    fn handoff_refuses_an_unconfirmed_or_undetected_agent_root() {
        let temp = TestDirectory::new();
        let home = temp.path();
        // An old default root still exists while CODEX_HOME points elsewhere.
        fs::create_dir_all(home.join(".codex/skills")).unwrap();
        fs::create_dir_all(home.join(".claude/skills")).unwrap();
        let known = [
            ("codex", "ChatGPT", ".codex/skills"),
            ("claude", "Claude Code", ".claude/skills"),
        ];
        let detected = [
            agent_info("codex", crate::AgentSkillsStatus::Unconfirmed),
            agent_info("claude", crate::AgentSkillsStatus::Ready),
        ];
        let refused = destinations_with(home, "demo", &["codex".into()], &known, &detected)
            .expect_err("an unconfirmed root must not receive a handoff");
        assert!(refused.contains("Skill 目录未确认"), "{refused}");
        assert!(!home.join(".codex/skills/demo").exists());

        let undetected = destinations_with(home, "demo", &["claude".into()], &known, &[])
            .expect_err("an undetected Agent must not receive a handoff");
        assert!(undetected.contains("本机未检测到"), "{undetected}");

        assert_eq!(
            destinations_with(home, "demo", &["claude".into()], &known, &detected).unwrap(),
            vec![home.join(".claude/skills").join("demo")]
        );
    }
    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("skillhub-unmanage-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn independent_copy_preserves_contents_not_management_or_credentials() {
        let temp = TestDirectory::new();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("SKILL.md"), "# latest changes").unwrap();
        fs::write(source.join(".skillhub.json"), "{}").unwrap();
        fs::write(source.join(".env"), "KEY=private").unwrap();
        let dest = temp.path().join("independent");
        copy_independent(&source, &dest).unwrap();
        assert_eq!(
            fs::read_to_string(dest.join("SKILL.md")).unwrap(),
            "# latest changes"
        );
        assert!(!dest.join(".skillhub.json").exists());
        assert!(!dest.join(".env").exists());
        fs::write(dest.join("SKILL.md"), "changed separately").unwrap();
        assert_eq!(
            fs::read_to_string(source.join("SKILL.md")).unwrap(),
            "# latest changes"
        );
    }
    #[test]
    fn independent_copy_and_plan_refuse_existing_native_files() {
        let temp = TestDirectory::new();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("SKILL.md"), "# skill").unwrap();
        let dest = temp.path().join("native");
        fs::create_dir(&dest).unwrap();
        assert!(copy_independent(&source, &dest).is_err());
        assert!(plan_at(&source, &[dest], &[]).is_err());
    }

    #[test]
    fn handoff_plan_changes_when_content_changes_and_rejects_foreign_links() {
        let temp = TestDirectory::new();
        let source = temp.path().join("source");
        let foreign = temp.path().join("foreign");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&foreign).unwrap();
        fs::write(source.join("SKILL.md"), "# before").unwrap();
        let target = temp.path().join("target");
        unix_fs::symlink(&source, &target).unwrap();
        let paths = vec![target.clone()];
        let owned = vec![source.clone()];
        let before = plan_at(&source, &paths, &owned).unwrap();
        fs::write(source.join("SKILL.md"), "# changed").unwrap();
        assert_ne!(before, plan_at(&source, &paths, &owned).unwrap());
        crate::platform_fs::remove_link(&target).unwrap();
        // junction::delete removes the reparse point, retaining its empty directory.
        #[cfg(windows)]
        fs::remove_dir(&target).unwrap();
        unix_fs::symlink(&foreign, &target).unwrap();
        assert!(plan_at(&source, &paths, &owned).is_err());
    }

    #[test]
    #[ignore = "run in a dedicated process with SKILLHUB_HANDOFF_TEST_HOME and isolated HOME/USERPROFILE"]
    fn isolated_handoff_end_to_end() {
        let fixture = PathBuf::from(
            std::env::var_os("SKILLHUB_HANDOFF_TEST_HOME").expect("isolated fixture required"),
        );
        assert_eq!(crate::user_home_dir().unwrap(), fixture);
        assert!(fixture
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("skillhub-handoff-e2e-"));
        assert!(!skillhub_dir().exists(), "fixture must be empty");
        let id = "handoff-fixture";
        let source = skill_path(id);
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: handoff-fixture\ndescription: fixture\n---\n# Handoff test",
        )
        .unwrap();
        let home = crate::user_home_dir().unwrap();
        // A handoff needs a detected Agent: give the isolated home a CLI.
        let cli = home.join(".local/bin/claude");
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(&cli, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let known = crate::known_agents();
        let (key, _, relative) = known.iter().find(|(key, _, _)| *key == "claude").unwrap();
        let parent = home.join(relative);
        fs::create_dir_all(&parent).unwrap();
        let target = parent.join(id);
        unix_fs::symlink(&source, &target).unwrap();
        let agents = vec![key.to_string()];
        let plan = preflight_unmanage_skill(id.into(), agents.clone()).unwrap();
        assert_eq!(plan.destinations, vec![target.to_string_lossy()]);
        let archive = unmanage_skill_blocking(id.into(), agents, plan.plan_digest).unwrap();
        assert!(!source.exists());
        assert!(Path::new(&archive).join("skill/SKILL.md").exists());
        assert!(target.join("SKILL.md").exists());
        assert!(
            fs::read_link(&target).is_err(),
            "must be independent files, not a projection"
        );
        fs::write(target.join("SKILL.md"), "independent modification").unwrap();
        assert!(
            fs::read_to_string(Path::new(&archive).join("skill/SKILL.md"))
                .unwrap()
                .contains("Handoff test")
        );
    }
}
