//! Explicit actions for an acquired Skill. The acquired tree is independent of HEAD.
use super::*;
use crate::skill_lock::lock_skill_dir_at;
use crate::{SkillPackageDiffLine, SkillPackageFileDiff};

pub(crate) fn replacement_blocked(root: &Path, profile: &SkillHubProfile) -> bool {
    working_copy_state_for_path(root).0
        || (acquired(profile)
            && changed_files(root, profile)
                .map_or_else(|_| saved_since_acquisition(root), |count| count > 0))
}

pub(super) fn saved_since_acquisition(root: &Path) -> bool {
    let Ok(repo) = git2::Repository::open(root) else {
        return true;
    };
    let Ok(head) = repo.head().and_then(|head| head.peel_to_commit()) else {
        return true;
    };
    if let Ok(acquired) = repo
        .find_reference("refs/skillhub/acquisition-snapshot")
        .and_then(|reference| reference.peel_to_commit())
    {
        return acquired.id() != head.id();
    }
    // Legacy managed repositories start with the acquired snapshot.
    head.parent_count() != 0
}

pub(super) fn package_cached(root: &Path, profile: &SkillHubProfile) -> bool {
    if acquisition_ref(profile).is_err() {
        return false;
    }
    let Ok(repo) = git2::Repository::open(root) else {
        return false;
    };
    let path = repo.path().join(format!(
        "acquired-{}.zip",
        profile.acquisition_package_sha256.as_deref().unwrap()
    ));
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
}

pub(super) fn preserve_acquisition_version(
    root: &Path,
    profile: &mut SkillHubProfile,
) -> Result<(), String> {
    if acquired(profile) && profile.acquisition_version.is_none() {
        profile.acquisition_version = Some(profile.version.clone());
        write_version_profile_at(root, profile)?;
    }
    Ok(())
}

pub(super) fn replace_team_source_at(
    home: &Path,
    root: &Path,
    managed: &Path,
    skill_id: &str,
    package: &[u8],
    mut next: SkillHubProfile,
    choice: Option<&str>,
) -> Result<(), String> {
    let destination = managed.join(skill_id);
    reconcile_skill_projection_at(root, managed, skill_id)?;
    let previous = library_read_profile_readonly(&destination)?;
    let expected = library_tree_fingerprint(&destination)?;
    let mut pending_copy = None;
    if source_edits::replacement_blocked(&destination, &previous) {
        match choice {
            Some("preserve") => {
                pending_copy = Some(prepare_personal_copy_at(
                    root, managed, skill_id, &previous,
                )?);
            }
            Some("overwrite") => {}
            _ => return Err("你修改过这个 Skill，请选择保留我的修改，再更新或直接覆盖".into()),
        }
    }
    let result = (|| {
        source_edits::snapshot(&destination, "团队更新前保存本机内容")?;
        next.version_metadata = previous.version_metadata;
        next.changelog = previous.changelog;
        next.id = previous.id;
        next.avatar_local_id = previous.avatar_local_id;
        for dependency in &mut next.env_dependencies {
            if let Some(old) = previous
                .env_dependencies
                .iter()
                .find(|old| old.key == dependency.key)
            {
                dependency.share_policy = old.share_policy.clone();
                dependency.shared_teams = old.shared_teams.clone();
            }
        }
        let expected_copy = expected.clone();
        let verify =
            move |candidate: &Path| Ok(library_tree_fingerprint(candidate)? == expected_copy);
        land_library_package_at(
            home,
            root,
            managed,
            LibraryLanding {
                skill_id,
                package,
                profile: next,
                expected_existing: Some(&expected),
                verify_existing: Some(&verify),
                message: "更新到团队最新版本",
                retain_backup: true,
            },
        )
        .map_err(|error| match error {
            LibraryLandingError::LocalChanged => "更新期间内容发生变化，已保留原版".into(),
            LibraryLandingError::Failed(message) => message,
        })
    })();
    if let Some((id, stage)) = pending_copy {
        if result.is_ok() {
            // Keep the saved edits recoverable even if publishing the copy fails.
            rename_noreplace(&stage, &managed.join(&id)).map_err(|error| {
                format!(
                    "团队已更新，但保留副本待恢复（{}）：{error}",
                    stage.display()
                )
            })?;
        } else {
            fs::remove_dir_all(&stage)
                .map_err(|error| format!("更新失败，清理临时副本失败：{error}"))?;
        }
    }
    result
}

fn cleanup_team_previews_at(managed: &Path) -> Result<usize, String> {
    validate_real_directory(managed, "SkillHub 资产目录")?;
    let mut removed = 0;
    for entry in fs::read_dir(managed).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name
            .strip_prefix(".skillhub-team-preview-")
            .is_some_and(|suffix| uuid::Uuid::parse_str(suffix).is_ok())
            && entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
        {
            fs::remove_dir_all(entry.path()).map_err(|error| error.to_string())?;
            removed += 1;
        }
    }
    Ok(removed)
}

pub fn cleanup_team_previews() -> Result<usize, String> {
    let _lock = lock_skill_dir_at(&skillhub_dir(), "team-preview-cleanup")?;
    cleanup_team_previews_at(&skills_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn team_preview_cleanup_only_removes_reserved_real_directories() {
        let managed = std::env::temp_dir().join(format!("preview-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&managed).unwrap();
        let name = format!(".skillhub-team-preview-{}", uuid::Uuid::new_v4());
        assert!(validate_skill_id(&name).is_err());
        fs::create_dir(managed.join(&name)).unwrap();
        fs::create_dir(managed.join("demo")).unwrap();
        fs::create_dir(managed.join(".skillhub-team-preview-not-a-uuid")).unwrap();
        assert_eq!(cleanup_team_previews_at(&managed).unwrap(), 1);
        assert_eq!(cleanup_team_previews_at(&managed).unwrap(), 0);
        assert!(managed.join("demo").exists());
        assert!(managed.join(".skillhub-team-preview-not-a-uuid").exists());
        fs::remove_dir_all(managed).unwrap();
    }

    #[test]
    fn team_update_preserves_or_snapshots_local_edits_before_replacing() {
        for choice in ["preserve", "overwrite"] {
            let home = std::env::temp_dir().join(format!("team-update-{}", uuid::Uuid::new_v4()));
            let root = home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            });
            let managed = root.join("skills");
            let path = managed.join("demo");
            fs::create_dir_all(&path).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            fs::set_permissions(&managed, fs::Permissions::from_mode(0o700)).unwrap();
            let original = "---\nname: demo\ndescription: demo\n---\nOriginal\n";
            fs::write(path.join("SKILL.md"), original).unwrap();
            let package = create_skill_package_from_root(&path).unwrap();
            let bytes = BASE64.decode(&package.base64).unwrap();
            let profile = SkillHubProfile {
                id: Some(uuid::Uuid::new_v4().to_string()),
                name: Some("demo".into()),
                display_name: Some("Demo".into()),
                is_own: Some(false),
                server_id: Some("source-asset".into()),
                team_shared_from: Some("team".into()),
                team_ids: vec!["team".into()],
                acquisition_source: Some(AcquisitionSource::Team),
                acquisition_package_sha256: Some(package.sha256),
                source_version_id: Some("old-version".into()),
                version: "0.1.0".into(),
                ..Default::default()
            };
            write_profile_at_path(&path, &profile).unwrap();
            create_skill_snapshot_at_path(&path, "acquired").unwrap();
            remember_acquisition(&path, &profile, &bytes).unwrap();
            fs::write(path.join("SKILL.md"), format!("{original}My edit\n")).unwrap();
            write_private_file(&path.join(".env.local"), "EXAMPLE_SETTING=fixture").unwrap();
            let mut next = profile.clone();
            next.source_version_id = Some("new-version".into());
            next.version = "0.1.1".into();
            assert!(replace_team_source_at(
                &home,
                &root,
                &managed,
                "demo",
                &bytes,
                next.clone(),
                None
            )
            .unwrap_err()
            .contains("你修改过"));
            assert!(replace_team_source_at(
                &home,
                &root,
                &managed,
                "demo",
                b"invalid package",
                next.clone(),
                Some(choice)
            )
            .is_err());
            assert_eq!(
                fs::read_dir(&managed).unwrap().count(),
                1,
                "failed update must not leave a duplicate copy or stage"
            );
            assert!(fs::read_to_string(path.join("SKILL.md"))
                .unwrap()
                .contains("My edit"));
            replace_team_source_at(&home, &root, &managed, "demo", &bytes, next, Some(choice))
                .unwrap();
            assert_eq!(fs::read_to_string(path.join("SKILL.md")).unwrap(), original);
            assert_eq!(
                fs::read_to_string(path.join(".env.local")).unwrap(),
                "EXAMPLE_SETTING=fixture"
            );
            let updated = library_read_profile_readonly(&path).unwrap();
            assert_eq!(updated.source_version_id.as_deref(), Some("new-version"));
            assert_eq!(updated.id, profile.id);
            assert!(!replacement_blocked(&path, &updated));
            let copies: Vec<_> = fs::read_dir(&managed)
                .unwrap()
                .flatten()
                .filter(|entry| entry.file_name() != "demo")
                .collect();
            assert_eq!(copies.len(), usize::from(choice == "preserve"));
            if let Some(copy) = copies.first() {
                let copied = library_read_profile_readonly(&copy.path()).unwrap();
                assert_eq!(copied.display_name.as_deref(), Some("Demo（我的修改）"));
                assert_eq!(
                    copied.copy_origin.unwrap().server_skill_id.as_deref(),
                    Some("source-asset")
                );
                assert!(fs::read_to_string(copy.path().join("SKILL.md"))
                    .unwrap()
                    .contains("My edit"));
            }
            let repo = git2::Repository::open(&path).unwrap();
            let saved = repo
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .parent(0)
                .unwrap();
            let blob = saved
                .tree()
                .unwrap()
                .get_path(Path::new("SKILL.md"))
                .unwrap()
                .id();
            assert!(
                String::from_utf8_lossy(repo.find_blob(blob).unwrap().content())
                    .contains("My edit")
            );
            assert!(fs::read_dir(root.join("trash"))
                .unwrap()
                .flatten()
                .any(|entry| entry.path().join("skill/SKILL.md").exists()));
            drop(saved);
            drop(repo);
            fs::remove_dir_all(home).unwrap();
        }
    }

    #[test]
    fn source_edits_activation_still_rejects_stage_changes_after_env_preservation() {
        let home = std::env::temp_dir().join(format!("source-edits-race-{}", uuid::Uuid::new_v4()));
        let root = home.join(".skillhub");
        let managed = root.join("skills");
        let path = managed.join("demo");
        let stage = managed.join("stage");
        fs::create_dir_all(&path).unwrap();
        fs::create_dir(&stage).unwrap();
        fs::write(path.join("SKILL.md"), "original").unwrap();
        fs::write(stage.join("SKILL.md"), "replacement").unwrap();
        write_private_file(&path.join(".env.local"), "EXAMPLE_SETTING=fixture").unwrap();
        write_profile_at_path(&path, &SkillHubProfile::default()).unwrap();
        create_skill_snapshot_at_path(&path, "original").unwrap();
        let verify = |_: &Path| Ok(true);
        let error = activate_staged_marketplace_package_with_hooks(
            &home,
            &root,
            &stage,
            &path,
            "demo",
            "Demo",
            true,
            || {
                assert_eq!(
                    fs::read_to_string(stage.join(".env.local")).unwrap(),
                    "EXAMPLE_SETTING=fixture"
                );
                fs::write(stage.join("SKILL.md"), "changed after preparation").unwrap();
            },
            || Ok(()),
            Some(&verify),
        )
        .unwrap_err();
        assert!(error.contains("启用期间发生变化"), "{error}");
        assert_eq!(
            fs::read_to_string(path.join("SKILL.md")).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read_to_string(path.join(".env.local")).unwrap(),
            "EXAMPLE_SETTING=fixture"
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn missing_acquisition_falls_back_to_history_and_still_allows_copy() {
        for missing in ["legacy-no-hash", "card-unavailable", "catalog-delisted"] {
            let root =
                std::env::temp_dir().join(format!("acquisition-fallback-{}", uuid::Uuid::new_v4()));
            let managed = root.join("skills");
            let path = managed.join("demo");
            fs::create_dir_all(&path).unwrap();
            let profile = SkillHubProfile {
                acquisition_source: Some(AcquisitionSource::Team),
                acquisition_package_sha256: (missing != "legacy-no-hash").then(|| "c".repeat(64)),
                catalog_origin: (missing == "catalog-delisted")
                    .then(|| "https://catalog.example.test".into()),
                ..Default::default()
            };
            fs::write(path.join("SKILL.md"), "# Acquired\n").unwrap();
            write_profile_at_path(&path, &profile).unwrap();
            snapshot(&path, "acquired").unwrap();
            assert!(changed_files(&path, &profile).is_err(), "{missing}");
            assert!(!package_cached(&path, &profile));
            assert!(
                !replacement_blocked(&path, &profile),
                "clean acquisition must allow update: {missing}"
            );
            let copy = copy_personal_at(&root, &managed, "demo", &profile).unwrap();
            assert!(managed.join(copy).join("SKILL.md").exists());
            fs::write(path.join("SKILL.md"), "# Member edit\n").unwrap();
            assert!(replacement_blocked(&path, &profile));
            snapshot(&path, "finish-edit").unwrap();
            assert!(!working_copy_state_for_path(&path).0);
            assert!(
                replacement_blocked(&path, &profile),
                "saved edit must block update: {missing}"
            );
            let copy = copy_personal_at(&root, &managed, "demo", &profile).unwrap();
            assert!(fs::read_to_string(managed.join(copy).join("SKILL.md"))
                .unwrap()
                .ends_with("# Member edit\n"));
            assert!(discard_at(&root, &root, &managed, "demo", profile).is_err());
            assert_eq!(
                fs::read_to_string(path.join("SKILL.md")).unwrap(),
                "# Member edit\n"
            );
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn copy_name_preserves_other_fields_and_body() {
        for text in [
            "---\nname: old\ndescription: Keep\n---\nBody\n",
            "\u{feff}---\r\nname: old\r\ndescription: Keep\r\n---\r\nBody\n",
            "---\ndescription: Keep\n---\nBody\n",
            "Body\n",
        ] {
            let renamed = copy_document_name(text, "new-copy").unwrap();
            let document = crate::skill_document::parse_skill_document(&renamed);
            assert_eq!(document.text("name"), Some("new-copy"));
            assert_eq!(document.body, "Body\n");
            if text.contains("description:") {
                assert_eq!(document.text("description"), Some("Keep"));
            }
        }
    }

    #[test]
    fn edits_keep_sources_and_copy_and_discard_preserve_history() {
        for source in [AcquisitionSource::Team, AcquisitionSource::Marketplace] {
            let home = std::env::temp_dir().join(format!("source-edits-{}", uuid::Uuid::new_v4()));
            let root = home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            });
            let managed = root.join("skills");
            let path = managed.join("demo");
            fs::create_dir_all(&path).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            fs::set_permissions(&managed, fs::Permissions::from_mode(0o700)).unwrap();
            let original = "---\nname: demo\ndescription: demo\n---\nOriginal\n";
            fs::write(path.join("SKILL.md"), original).unwrap();
            fs::write(path.join(".gitignore"), "business.txt\n").unwrap();
            fs::write(path.join("business.txt"), "original business").unwrap();
            let package = create_skill_package_from_root(&path).unwrap();
            let bytes = BASE64.decode(&package.base64).unwrap();
            let mut profile = SkillHubProfile {
                id: Some(uuid::Uuid::new_v4().to_string()),
                name: Some("demo".into()),
                is_own: Some(false),
                server_id: Some("original-asset".into()),
                team_shared_from: Some("team".into()),
                team_ids: vec!["team".into()],
                acquisition_source: Some(source),
                acquisition_package_sha256: Some(package.sha256),
                version: "0.1.0".into(),
                ..Default::default()
            };
            write_profile_at_path(&path, &profile).unwrap();
            create_skill_snapshot_at_path(&path, "acquired").unwrap();
            remember_acquisition(&path, &profile, &bytes).unwrap();
            assert_eq!(changed_files(&path, &profile).unwrap(), 0);
            fs::write(path.join("SKILL.md"), format!("{original}Changed\n")).unwrap();
            let repo = git2::Repository::open(&path).unwrap();
            let new_blob = git2::Oid::hash_object(
                git2::ObjectType::Blob,
                format!("{original}Changed\n").as_bytes(),
            )
            .unwrap();
            assert!(repo.find_blob(new_blob).is_err());
            assert_eq!(changed_files(&path, &profile).unwrap(), 1);
            assert!(
                repo.find_blob(new_blob).is_err(),
                "list status must not write Git objects"
            );
            drop(repo);
            maintain_list_skill_version_at(&root, &managed, "demo").unwrap();
            profile = library_read_profile_readonly(&path).unwrap();
            assert_eq!(profile.acquisition_source, Some(source));
            save_snapshot_with_version_at(&path, &mut profile, "save", None, None).unwrap();
            assert_eq!(profile.server_id.as_deref(), Some("original-asset"));
            assert_eq!(profile.team_ids, vec!["team"]);
            assert!(!working_copy_state_for_path(&path).0);
            assert!(replacement_blocked(&path, &profile));
            assert!(
                capture_marketplace_replacement_guard_at(&home, &root, &managed, "demo")
                    .unwrap_err()
                    .contains("本机修改")
            );
            assert_eq!(changed_files(&path, &profile).unwrap(), 1);
            // Upgrade an older installation whose HEAD already saved the edits.
            {
                let repo = git2::Repository::open(&path).unwrap();
                repo.find_reference(&acquisition_ref(&profile).unwrap())
                    .unwrap()
                    .delete()
                    .unwrap();
            }
            assert!(changed_files(&path, &profile).is_err());
            assert!(replacement_blocked(&path, &profile));
            hydrate_acquisition_at(&path, &managed, &profile, &bytes).unwrap();
            assert_eq!(changed_files(&path, &profile).unwrap(), 1);
            let copy_id = copy_personal_at(&root, &managed, "demo", &profile).unwrap();
            let copy_path = managed.join(&copy_id);
            let copy = library_read_profile_readonly(&copy_path).unwrap();
            assert_ne!(copy.id, profile.id);
            assert_eq!(copy.acquisition_source, Some(AcquisitionSource::Local));
            assert_eq!(
                copy.upstream.as_ref().unwrap().server_skill_id,
                profile.server_id
            );
            assert_eq!(copy.upstream.as_ref().unwrap().version, "0.1.0");
            assert!(copy.library_entry_id.is_none());
            assert!(copy_path.join(".git").is_dir());
            let copied_text = fs::read_to_string(copy_path.join("SKILL.md")).unwrap();
            assert_eq!(
                crate::skill_document::parse_skill_document(&copied_text).text("name"),
                Some(copy_id.as_str())
            );
            assert!(copied_text.ends_with("Original\nChanged\n"));
            assert_eq!(
                copy.copy_origin.as_ref().unwrap().server_skill_id,
                profile.server_id
            );
            fs::write(path.join(".env.local"), "EXAMPLE_SETTING=fixture").unwrap();
            fs::set_permissions(path.join(".env.local"), fs::Permissions::from_mode(0o600))
                .unwrap();
            fs::create_dir(path.join("dist")).unwrap();
            fs::write(path.join("dist/local.txt"), "excluded local data").unwrap();
            fs::write(path.join("extra.txt"), "unsaved").unwrap();
            fs::write(path.join("business.txt"), "changed business").unwrap();
            assert_eq!(changed_files(&path, &profile).unwrap(), 3);
            discard_at(&home, &root, &managed, "demo", profile.clone()).unwrap();
            assert_eq!(
                fs::read_to_string(path.join(".env.local")).unwrap(),
                "EXAMPLE_SETTING=fixture",
                "local values must survive activation as well as remain in the backup"
            );
            let backup = fs::read_dir(root.join("trash"))
                .unwrap()
                .flatten()
                .find(|entry| entry.path().join("skill/.env.local").exists())
                .unwrap()
                .path()
                .join("skill");
            assert_eq!(
                fs::read_to_string(backup.join(".env.local")).unwrap(),
                "EXAMPLE_SETTING=fixture"
            );
            assert_eq!(
                fs::read_to_string(backup.join("dist/local.txt")).unwrap(),
                "excluded local data"
            );
            assert_eq!(fs::read_to_string(path.join("SKILL.md")).unwrap(), original);
            assert!(!path.join("extra.txt").exists());
            assert_eq!(
                fs::read_to_string(path.join("business.txt")).unwrap(),
                "original business"
            );
            assert_eq!(changed_files(&path, &profile).unwrap(), 0);
            let repo = git2::Repository::open(&path).unwrap();
            let head = repo.head().unwrap().peel_to_commit().unwrap();
            let saved = head.parent(0).unwrap();
            assert!(saved.message().unwrap().contains("放弃修改前"));
            let tree = saved.tree().unwrap();
            let file = tree.get_path(Path::new("business.txt")).unwrap();
            assert_eq!(
                repo.find_blob(file.id()).unwrap().content(),
                b"changed business"
            );
            drop(file);
            drop(tree);
            assert!(saved
                .tree()
                .unwrap()
                .get_path(Path::new("extra.txt"))
                .is_ok());
            drop(saved);
            drop(head);
            drop(repo);
            fs::remove_dir_all(home).unwrap();
        }
    }
}

pub(super) fn acquired(profile: &SkillHubProfile) -> bool {
    !profile.is_system
        && (profile.catalog_origin.is_some()
            || profile_acquisition_source(profile) != AcquisitionSource::Local)
}

fn acquisition_ref(profile: &SkillHubProfile) -> Result<String, String> {
    let sha = profile
        .acquisition_package_sha256
        .as_deref()
        .ok_or("缺少取得时的内容记录")?;
    if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("取得时的内容记录无效".into());
    }
    Ok(format!("refs/skillhub/acquired/{sha}"))
}

/// Called only after package validation and a snapshot of exactly these bytes.
pub(super) fn remember_acquisition(
    root: &Path,
    profile: &SkillHubProfile,
    bytes: &[u8],
) -> Result<(), String> {
    if !acquired(profile)
        || profile.acquisition_package_sha256.as_deref()
            != Some(format!("{:x}", Sha256::digest(bytes)).as_str())
    {
        return Ok(());
    }
    let repo = crate::version_policy::open_repository(root).map_err(|e| e.to_string())?;
    let tree = content_tree(root, &repo)?;
    repo.reference(&acquisition_ref(profile)?, tree, true, "acquired content")
        .map_err(|e| e.to_string())?;
    if let Ok(head) = repo.head().and_then(|head| head.peel_to_commit()) {
        repo.reference(
            "refs/skillhub/acquisition-snapshot",
            head.id(),
            true,
            "acquired snapshot",
        )
        .map_err(|e| e.to_string())?;
    }
    let package = repo.path().join(format!(
        "acquired-{}.zip",
        profile.acquisition_package_sha256.as_deref().unwrap()
    ));
    if !package.exists() {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(package)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn baseline<'a>(
    repo: &'a git2::Repository,
    profile: &SkillHubProfile,
) -> Result<git2::Tree<'a>, String> {
    repo.find_reference(&acquisition_ref(profile)?)
        .and_then(|r| r.peel_to_tree())
        .map_err(|_| "取得时的内容记录尚未下载，请联网后打开详情重试".into())
}

fn source_diff<'a>(
    repo: &'a git2::Repository,
    profile: &SkillHubProfile,
) -> Result<git2::Diff<'a>, String> {
    let tree = baseline(repo, profile)?;
    let current = repo
        .find_tree(content_tree(repo.workdir().ok_or("Skill 目录无效")?, repo)?)
        .map_err(|e| e.to_string())?;
    repo.diff_tree_to_tree(Some(&tree), Some(&current), None)
        .map_err(|e| e.to_string())
}

fn content_tree(root: &Path, repo: &git2::Repository) -> Result<git2::Oid, String> {
    let mut index = git2::Index::new().map_err(|e| e.to_string())?;
    for file in library_tree_files(root)? {
        let data = fs::read(&file.absolute).map_err(|e| e.to_string())?;
        let oid = repo.blob(&data).map_err(|e| e.to_string())?;
        index
            .add(&git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: if file.executable { 0o100755 } else { 0o100644 },
                uid: 0,
                gid: 0,
                file_size: data.len() as u32,
                id: oid,
                flags: 0,
                flags_extended: 0,
                path: file.path.into_bytes(),
            })
            .map_err(|e| e.to_string())?;
    }
    index.write_tree_to(repo).map_err(|e| e.to_string())
}

pub(super) fn snapshot(root: &Path, message: &str) -> Result<(), String> {
    let repo = crate::version_policy::init_repository(root).map_err(|e| e.to_string())?;
    ensure_git_excludes(root).map_err(|e| e.to_string())?;
    let tree = repo
        .find_tree(content_tree(root, &repo)?)
        .map_err(|e| e.to_string())?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let signature =
        git2::Signature::now("SkillHub", "skillhub@local").map_err(|e| e.to_string())?;
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &parent.iter().collect::<Vec<_>>(),
    )
    .map_err(|e| e.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index.read_tree(&tree).map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())
}

pub(crate) fn changed_files(root: &Path, profile: &SkillHubProfile) -> Result<u32, String> {
    if !acquired(profile) {
        return Ok(0);
    }
    let repo = git2::Repository::open(root).map_err(|e| e.to_string())?;
    let tree = baseline(&repo, profile)?;
    let mut saved = BTreeMap::new();
    tree.walk(git2::TreeWalkMode::PreOrder, |prefix, entry| {
        if entry.kind() == Some(git2::ObjectType::Blob) {
            saved.insert(
                format!("{prefix}{}", entry.name().unwrap_or_default()),
                (entry.id(), entry.filemode()),
            );
        }
        git2::TreeWalkResult::Ok
    })
    .map_err(|e| e.to_string())?;
    let mut count = 0;
    for file in library_tree_files(root)? {
        let bytes = fs::read(&file.absolute).map_err(|e| e.to_string())?;
        let oid =
            git2::Oid::hash_object(git2::ObjectType::Blob, &bytes).map_err(|e| e.to_string())?;
        let mode = if file.executable { 0o100755 } else { 0o100644 };
        if saved.remove(&file.path) != Some((oid, mode)) {
            count += 1;
        }
    }
    Ok(count + saved.len() as u32)
}

fn read_package(root: &Path, profile: &SkillHubProfile) -> Result<Vec<u8>, String> {
    acquisition_ref(profile)?;
    let sha = profile.acquisition_package_sha256.as_deref().unwrap();
    let repo = crate::version_policy::open_repository(root).map_err(|e| e.to_string())?;
    let bytes = read_owned_projection_file(
        &repo.path().join(format!("acquired-{sha}.zip")),
        20 * 1024 * 1024,
        false,
        "取得时的内容包",
    )?;
    if format!("{:x}", Sha256::digest(&bytes)) != sha {
        return Err("取得时的内容包校验失败".into());
    }
    Ok(bytes)
}

pub(crate) async fn ensure_acquisition(skill_id: &str) -> Result<(), String> {
    validate_skill_id(skill_id)?;
    let path = skill_path(skill_id);
    let profile = library_read_profile_readonly(&path)?;
    if !acquired(&profile) {
        return Err("此 Skill 没有团队或商店来源".into());
    }
    let cached = read_package(&path, &profile).ok();
    if cached.is_some() && changed_files(&path, &profile).is_ok() {
        return Ok(());
    }
    let session = crate::runtime_env::runtime_session_snapshot().ok();
    let bytes = match cached {
        Some(bytes) => bytes,
        None => crate::library_sync::acquired_package(&profile).await?,
    };
    let _lock = crate::skill_lock::lock_skill_dir(skill_id)?;
    let current = library_read_profile_readonly(&path)?;
    let _lease = version_session_lease(&current)?;
    if session != crate::runtime_env::runtime_session_snapshot().ok()
        || profile.acquisition_package_sha256 != current.acquisition_package_sha256
    {
        return Err("来源或账号已变化，请重试".into());
    }
    if Some(format!("{:x}", Sha256::digest(&bytes))) != current.acquisition_package_sha256 {
        return Err("取得时的内容包校验失败".into());
    }
    hydrate_acquisition_at(&path, &skills_dir(), &current, &bytes)
}

fn hydrate_acquisition_at(
    path: &Path,
    managed: &Path,
    profile: &SkillHubProfile,
    bytes: &[u8],
) -> Result<(), String> {
    if Some(format!("{:x}", Sha256::digest(bytes))) != profile.acquisition_package_sha256 {
        return Err("取得时的内容包校验失败".into());
    }
    let stage = managed.join(format!(".skillhub-acquired-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        extract_marketplace_package_to_stage(bytes, &stage)?;
        let repo = crate::version_policy::open_repository(path).map_err(|e| e.to_string())?;
        let tree = content_tree(&stage, &repo)?;
        repo.reference(
            &acquisition_ref(profile)?,
            tree,
            true,
            "verified acquired package",
        )
        .map_err(|e| e.to_string())?;
        let target = repo.path().join(format!(
            "acquired-{}.zip",
            profile.acquisition_package_sha256.as_deref().unwrap()
        ));
        if target.exists() {
            return read_package(path, profile).map(|_| ());
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(target)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())
    })();
    let _ = fs::remove_dir_all(stage);
    result
}

fn copy_document_name(text: &str, name: &str) -> Result<String, String> {
    let document = crate::skill_document::parse_skill_document(text);
    if document.unterminated {
        return Err("SKILL.md 资料区未完整结束，请先修复".into());
    }
    let result = if document.has_frontmatter {
        let end = text.len() - document.body.len();
        let header = &text[..end];
        let names =
            Regex::new(r"(?m)^name:[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*").map_err(|e| e.to_string())?;
        if names.is_match(header) {
            format!(
                "{}{}",
                names.replace_all(header, format!("name: {name}")),
                document.body
            )
        } else {
            let start = text.find('\n').ok_or("SKILL.md 资料区无效")? + 1;
            format!("{}name: {name}\n{}", &text[..start], &text[start..])
        }
    } else {
        format!("---\nname: {name}\n---\n{text}")
    };
    if crate::skill_document::parse_skill_document(&result).text("name") != Some(name) {
        return Err("无法安全修改 Skill 名称，请先检查 SKILL.md 资料区".into());
    }
    Ok(result)
}

pub(super) fn copy_personal_at(
    root: &Path,
    managed: &Path,
    id: &str,
    profile: &SkillHubProfile,
) -> Result<String, String> {
    let (new_id, stage) = prepare_personal_copy_at(root, managed, id, profile)?;
    let result =
        rename_noreplace(&stage, &managed.join(&new_id)).map_err(|error| error.to_string());
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result.map(|_| new_id)
}

fn prepare_personal_copy_at(
    root: &Path,
    managed: &Path,
    id: &str,
    profile: &SkillHubProfile,
) -> Result<(String, PathBuf), String> {
    if !acquired(profile) {
        return Err("只有团队或商店来源可另存为自己的 Skill".into());
    }
    let source = managed.join(id);
    let expected = library_tree_fingerprint(&source)?;
    let new_id = format!(
        "{}-{}",
        id.chars().take(40).collect::<String>(),
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    let stage = managed.join(format!(".skillhub-copy-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        library_copy_tree(&source, &stage)?;
        copy_git_history(&source, &stage)?;
        let skill_md = stage.join("SKILL.md");
        let text = fs::read_to_string(&skill_md).map_err(|e| e.to_string())?;
        fs::write(&skill_md, copy_document_name(&text, &new_id)?).map_err(|e| e.to_string())?;
        let mut copy = profile.clone();
        promote_profile_to_personal(&mut copy);
        copy.copy_origin = copy.upstream.clone();
        copy.id = Some(uuid::Uuid::new_v4().to_string());
        copy.name = Some(new_id.clone());
        copy.avatar_local_id = None;
        copy.library_entry_id = None;
        copy.library_account_id = None;
        copy.added_by_account_id = crate::runtime_env::runtime_session_snapshot_at(root)
            .ok()
            .map(|s| s.user_id().to_string());
        copy.version_metadata = Default::default();
        copy.display_name = Some(format!(
            "{}（我的修改）",
            profile.display_name.as_deref().unwrap_or(id)
        ));
        write_profile_at_path(&stage, &copy).map_err(|e| e.to_string())?;
        snapshot(&stage, "另存为我自己的 Skill")?;
        if expected != library_tree_fingerprint(&source)? {
            return Err("复制期间内容发生变化，请重试".into());
        }
        Ok((new_id, stage.clone()))
    })();
    if result.is_err() && stage.exists() {
        let _ = fs::remove_dir_all(stage);
    }
    result
}

fn discard_at(
    home: &Path,
    root: &Path,
    managed: &Path,
    id: &str,
    profile: SkillHubProfile,
) -> Result<(), String> {
    if !acquired(&profile) {
        return Err("只有团队或商店来源可放弃修改".into());
    }
    let path = managed.join(id);
    let package = read_package(&path, &profile)?;
    let expected = library_tree_fingerprint(&path)?;
    snapshot(&path, "放弃修改前保存本机内容")?;
    let expected_copy = expected.clone();
    let verify = move |candidate: &Path| Ok(library_tree_fingerprint(candidate)? == expected_copy);
    land_library_package_at(
        home,
        root,
        managed,
        LibraryLanding {
            skill_id: id,
            package: &package,
            profile,
            expected_existing: Some(&expected),
            verify_existing: Some(&verify),
            message: "放弃我的修改，恢复取得时的内容",
            retain_backup: true,
        },
    )
    .map_err(|e| match e {
        LibraryLandingError::LocalChanged => "恢复期间内容发生变化，已保留修改".into(),
        LibraryLandingError::Failed(e) => e,
    })
}

#[tauri::command]
pub async fn get_skill_source_diff(skill_id: String) -> Result<Vec<DiffLine>, String> {
    ensure_acquisition(&skill_id).await?;
    tauri::async_runtime::spawn_blocking(move || {
        validate_skill_id(&skill_id)?;
        let _lock = crate::skill_lock::lock_skill_dir(&skill_id)?;
        let path = skill_path(&skill_id);
        let profile = library_read_profile_readonly(&path)?;
        let _lease = version_session_lease(&profile)?;
        reconcile_skill_projection_at(&skillhub_dir(), &skills_dir(), &skill_id)?;
        let repo = crate::version_policy::open_repository(&path).map_err(|e| e.to_string())?;
        let diff = source_diff(&repo, &profile)?;
        collect_diff_lines(&diff)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_skill_package_diff(
    skill_id: String,
    package_base64: String,
    expected_sha256: String,
) -> Result<(usize, Vec<DiffLine>), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_skill_id(&skill_id)?;
        let _lock = crate::skill_lock::lock_skill_dir(&skill_id)?;
        let path = skill_path(&skill_id);
        let profile = library_read_profile_readonly(&path)?;
        let _lease = version_session_lease(&profile)?;
        let bytes = BASE64
            .decode(package_base64)
            .map_err(|error| error.to_string())?;
        if bytes.len() > 20 * 1024 * 1024
            || format!("{:x}", Sha256::digest(&bytes)) != expected_sha256
        {
            return Err("内容包校验失败".into());
        }
        let _preview_lock = lock_skill_dir_at(&skillhub_dir(), "team-preview-cleanup")?;
        let stage = skills_dir().join(format!(".skillhub-team-preview-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&stage).map_err(|error| error.to_string())?;
        let result = (|| {
            extract_marketplace_package_to_stage(&bytes, &stage)?;
            let repo =
                crate::version_policy::open_repository(&path).map_err(|error| error.to_string())?;
            let before = repo
                .find_tree(content_tree(&stage, &repo)?)
                .map_err(|error| error.to_string())?;
            let after = repo
                .find_tree(content_tree(&path, &repo)?)
                .map_err(|error| error.to_string())?;
            let diff = repo
                .diff_tree_to_tree(Some(&before), Some(&after), None)
                .map_err(|error| error.to_string())?;
            Ok((diff.deltas().len(), collect_diff_lines(&diff)?))
        })();
        let _ = fs::remove_dir_all(stage);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn get_skill_package_file_diffs(
    skill_id: String,
    package_base64: String,
    expected_sha256: String,
) -> Result<Vec<SkillPackageFileDiff>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_skill_id(&skill_id)?;
        let _lock = crate::skill_lock::lock_skill_dir(&skill_id)?;
        let path = skill_path(&skill_id);
        let profile = library_read_profile_readonly(&path)?;
        let _lease = version_session_lease(&profile)?;
        let bytes = BASE64
            .decode(package_base64)
            .map_err(|error| error.to_string())?;
        if bytes.len() > 20 * 1024 * 1024
            || format!("{:x}", Sha256::digest(&bytes)) != expected_sha256
        {
            return Err("内容包校验失败".into());
        }
        let _preview_lock = lock_skill_dir_at(&skillhub_dir(), "team-preview-cleanup")?;
        let stage = skills_dir().join(format!(".skillhub-team-preview-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&stage).map_err(|error| error.to_string())?;
        let result = (|| {
            extract_marketplace_package_to_stage(&bytes, &stage)?;
            let repo =
                crate::version_policy::open_repository(&path).map_err(|error| error.to_string())?;
            let before = repo
                .find_tree(content_tree(&stage, &repo)?)
                .map_err(|error| error.to_string())?;
            let after = repo
                .find_tree(content_tree(&path, &repo)?)
                .map_err(|error| error.to_string())?;
            let diff = repo
                .diff_tree_to_tree(Some(&before), Some(&after), None)
                .map_err(|error| error.to_string())?;
            collect_package_file_diffs(&repo, &diff)
        })();
        let _ = fs::remove_dir_all(stage);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

fn collect_package_file_diffs(
    repo: &git2::Repository,
    diff: &git2::Diff<'_>,
) -> Result<Vec<SkillPackageFileDiff>, String> {
    let mut files = std::collections::BTreeMap::new();
    for delta in diff.deltas() {
        let file = delta.new_file().path().or_else(|| delta.old_file().path());
        let Some(path) = file else { continue };
        if path == Path::new(".skillhub.json") || should_skip(path) {
            continue;
        }
        let status = match delta.status() {
            git2::Delta::Added => "added",
            git2::Delta::Deleted => "deleted",
            _ => "modified",
        };
        let too_large = [delta.old_file().id(), delta.new_file().id()]
            .into_iter()
            .filter(|id| !id.is_zero())
            .any(|id| {
                repo.find_blob(id).is_ok_and(|blob| {
                    let content = blob.content();
                    let lines = content.iter().filter(|byte| **byte == b'\n').count()
                        + usize::from(!content.is_empty() && !content.ends_with(b"\n"));
                    lines > 2_000
                })
            });
        files.insert(
            path.to_string_lossy().to_string(),
            SkillPackageFileDiff {
                path: path.to_string_lossy().to_string(),
                status: status.to_string(),
                binary: delta.flags().contains(git2::DiffFlags::BINARY),
                too_large,
                lines: Vec::new(),
            },
        );
    }
    diff.print(git2::DiffFormat::Patch, |delta, _hunk, line| {
        let path = delta.new_file().path().or_else(|| delta.old_file().path());
        let Some(path) = path else { return true };
        let Some(file) = files.get_mut(&path.to_string_lossy().to_string()) else {
            return true;
        };
        if file.binary || file.too_large {
            return true;
        }
        if !matches!(line.origin(), '+' | '-' | ' ') {
            return true;
        }
        if file.lines.len() >= 2_000 {
            file.too_large = true;
            file.lines.clear();
            return true;
        }
        let kind = match line.origin() {
            '+' => "add",
            '-' => "del",
            _ => "ctx",
        };
        file.lines.push(SkillPackageDiffLine {
            kind: kind.to_string(),
            old_line: line.old_lineno(),
            new_line: line.new_lineno(),
            content: String::from_utf8_lossy(line.content())
                .trim_end_matches(['\r', '\n'])
                .to_string(),
        });
        true
    })
    .map_err(|error| error.to_string())?;
    Ok(files.into_values().collect())
}

#[tauri::command]
pub async fn save_skill_as_personal(skill_id: String) -> Result<LocalSkill, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_skill_id(&skill_id)?;
        let _lock = crate::skill_lock::lock_skill_dir(&skill_id)?;
        let profile = library_read_profile_readonly(&skill_path(&skill_id))?;
        let _lease = version_session_lease(&profile)?;
        reconcile_skill_projection_at(&skillhub_dir(), &skills_dir(), &skill_id)?;
        if package_cached(&skill_path(&skill_id), &profile)
            && changed_files(&skill_path(&skill_id), &profile) == Ok(0)
        {
            return Err("内容与取得时相同，无需另存为自己的 Skill".into());
        }
        let id = copy_personal_at(&skillhub_dir(), &skills_dir(), &skill_id, &profile)?;
        Ok(build_local_skill(&id))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn discard_skill_source_changes(skill_id: String) -> Result<LocalSkill, String> {
    ensure_acquisition(&skill_id).await?;
    tauri::async_runtime::spawn_blocking(move || {
        validate_skill_id(&skill_id)?;
        let _lock = crate::skill_lock::lock_skill_dir(&skill_id)?;
        let profile = library_read_profile_readonly(&skill_path(&skill_id))?;
        let _lease = version_session_lease(&profile)?;
        reconcile_skill_projection_at(&skillhub_dir(), &skills_dir(), &skill_id)?;
        discard_at(
            &crate::user_home_dir().ok_or("无法找到用户目录")?,
            &skillhub_dir(),
            &skills_dir(),
            &skill_id,
            profile,
        )?;
        Ok(build_local_skill(&skill_id))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod package_diff_tests {
    use super::*;

    #[test]
    fn package_file_diff_reports_paths_statuses_and_line_numbers() {
        let root =
            std::env::temp_dir().join(format!("skillhub-file-diff-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("references")).unwrap();
        fs::create_dir_all(root.join("scripts")).unwrap();
        fs::write(root.join("SKILL.md"), "before\nkeep\n").unwrap();
        fs::write(root.join("references/guide.md"), "gone\n").unwrap();
        let repo = git2::Repository::init(&root).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("SKILL.md")).unwrap();
        index.add_path(Path::new("references/guide.md")).unwrap();
        index.write().unwrap();
        let first_tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("SkillHub Test", "test@example.invalid").unwrap();
        let first = repo
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "before",
                &first_tree,
                &[],
            )
            .unwrap();

        fs::write(root.join("SKILL.md"), "after\nkeep\n").unwrap();
        fs::remove_file(root.join("references/guide.md")).unwrap();
        fs::write(root.join("scripts/run.sh"), "echo ready\n").unwrap();
        index.add_path(Path::new("SKILL.md")).unwrap();
        index.remove_path(Path::new("references/guide.md")).unwrap();
        index.add_path(Path::new("scripts/run.sh")).unwrap();
        index.write().unwrap();
        let second_tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let before = repo.find_commit(first).unwrap().tree().unwrap();
        let diff = repo
            .diff_tree_to_tree(Some(&before), Some(&second_tree), None)
            .unwrap();
        let files = collect_package_file_diffs(&repo, &diff).unwrap();
        let by_path: std::collections::HashMap<_, _> = files
            .iter()
            .map(|file| (file.path.as_str(), file))
            .collect();
        assert_eq!(by_path["SKILL.md"].status, "modified");
        assert_eq!(
            by_path["SKILL.md"]
                .lines
                .iter()
                .find(|line| line.kind == "del")
                .unwrap()
                .old_line,
            Some(1)
        );
        assert_eq!(
            by_path["SKILL.md"]
                .lines
                .iter()
                .find(|line| line.kind == "add")
                .unwrap()
                .new_line,
            Some(1)
        );
        assert_eq!(by_path["references/guide.md"].status, "deleted");
        assert_eq!(by_path["scripts/run.sh"].status, "added");
        fs::remove_dir_all(root).unwrap();
    }
}
