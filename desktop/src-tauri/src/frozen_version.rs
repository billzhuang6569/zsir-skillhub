//! Immutable Git objects for one version submission; tokens never name caller paths.
use super::*;
use std::sync::{LazyLock, Mutex};

#[derive(Clone)]
pub(crate) struct FrozenVersion {
    skill_id: String,
    session: Option<crate::runtime_env::RuntimeSession>,
    pub(crate) hash: String,
    before: Option<String>,
}

static FROZEN: LazyLock<Mutex<HashMap<String, FrozenVersion>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn capture_at(
    root: &Path,
    message: &str,
    version: &str,
    metadata: &crate::version_policy::VersionMetadata,
) -> Result<(String, Option<String>), String> {
    crate::version_policy::ordinal(version).ok_or("版本号无效")?;
    let repo = crate::version_policy::init_repository(root).map_err(|e| e.to_string())?;
    let before = crate::version_policy::head(root);
    let tree_id = source_edits::content_tree(root, &repo)?;
    if source_edits::content_tree(root, &repo)? != tree_id {
        return Err("内容正在变化，请稍后重试".into());
    }
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    crate::version_policy::tree_content(&repo, &tree)?;
    let md = tree.get_name("SKILL.md").ok_or("快照缺少 SKILL.md")?;
    let blob = repo.find_blob(md.id()).map_err(|e| e.to_string())?;
    let text = std::str::from_utf8(blob.content()).map_err(|e| e.to_string())?;
    crate::skill_document::parse_skill_document(text).env_declarations()?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    if let Some(parent) = parent.as_ref().filter(|parent| parent.tree_id() == tree_id) {
        let mapped = metadata
            .commits
            .get(&parent.id().to_string())
            .cloned()
            .or_else(|| crate::version_policy::saved_current(root, metadata));
        let protected = mapped.as_ref().is_some_and(|mapped| {
            mapped.receipt.is_some()
                || mapped.formal_version_id.is_some()
                || matches!(
                    mapped.pending,
                    Some(crate::version_policy::VersionIntent::Formal { .. })
                )
        });
        // An exact pending save must keep its original request identity.
        let pending_save = mapped.as_ref().is_some_and(|mapped| {
            matches!(&mapped.pending,
            Some(crate::version_policy::VersionIntent::Save { label, .. }) if label == version)
        });
        let trailer = format!("SkillHub-Version: {version}");
        if protected
            || pending_save
            || parent
                .message()
                .unwrap_or("")
                .lines()
                .any(|line| line == trailer)
        {
            return Ok((parent.id().to_string(), before));
        }
    }
    let signature =
        git2::Signature::now("SkillHub", "skillhub@local").map_err(|e| e.to_string())?;
    let hash = repo
        .commit(
            None,
            &signature,
            &signature,
            &format!("{message}\n\nSkillHub-Version: {version}"),
            &tree,
            &parent.iter().collect::<Vec<_>>(),
        )
        .map_err(|e| e.to_string())?;
    Ok((hash.to_string(), before))
}

pub(crate) fn checked(token: &str, skill_id: &str) -> Result<FrozenVersion, String> {
    let frozen = FROZEN
        .lock()
        .map_err(|e| e.to_string())?
        .get(token)
        .cloned()
        .ok_or("提交快照已失效，请重新打开版本窗口")?;
    if !frozen.matches_scope(
        skill_id,
        &crate::runtime_env::optional_session_snapshot_at(&skillhub_dir())?,
    ) {
        return Err("账号或空间已切换，请通过同步核对已提交的版本".into());
    }
    Ok(frozen)
}

impl FrozenVersion {
    fn matches_scope(
        &self,
        skill_id: &str,
        session: &Option<crate::runtime_env::RuntimeSession>,
    ) -> bool {
        self.skill_id == skill_id && &self.session == session
    }
    pub(crate) fn record_hash(&self, root: &Path) -> Result<String, String> {
        let head = crate::version_policy::head(root);
        if head == self.before || head.as_deref() == Some(&self.hash) {
            return Ok(self.hash.clone());
        }
        let repo = crate::version_policy::open_repository(root).map_err(|e| e.to_string())?;
        let saved = repo
            .find_commit(git2::Oid::from_str(&self.hash).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let current = repo
            .head()
            .and_then(|h| h.peel_to_commit())
            .map_err(|e| e.to_string())?;
        if saved.tree_id() != current.tree_id() {
            return Err("本机版本记录已变化，请补全本机记录".into());
        }
        // Reuse the matching current commit; never rewind intervening history.
        Ok(current.id().to_string())
    }
    pub(crate) fn require_matching_working_tree(&self, root: &Path) -> Result<(), String> {
        let repo = crate::version_policy::open_repository(root).map_err(|e| e.to_string())?;
        let commit = repo
            .find_commit(git2::Oid::from_str(&self.hash).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let identity = crate::version_policy::commit_content(&repo, &commit)?;
        let current =
            crate::library_sync::content::local_identity(root, Some(&identity.executable_paths))?.0;
        if current != identity {
            return Err("内容已变化，请补全本机记录".into());
        }
        Ok(())
    }
    pub(crate) fn activate(&self, root: &Path) -> Result<(), String> {
        let head = crate::version_policy::head(root);
        if head.as_deref() == Some(&self.hash) {
            return Ok(());
        }
        let repo = crate::version_policy::open_repository(root).map_err(|e| e.to_string())?;
        if head != self.before {
            return Err("本机版本记录已变化，请补全本机记录".into());
        }
        let name = repo
            .find_reference("HEAD")
            .ok()
            .and_then(|h| h.symbolic_target().ok().flatten().map(str::to_string))
            .ok_or("当前历史分支状态无效，请核对后重试")?;
        let previous = self
            .before
            .as_deref()
            .map(git2::Oid::from_str)
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or(git2::Oid::ZERO_SHA1);
        repo.reference_matching(
            &name,
            git2::Oid::from_str(&self.hash).map_err(|e| e.to_string())?,
            true,
            previous,
            "保存已提交快照",
        )
        .map_err(|e| e.to_string())?;
        repo.set_head(&name).map_err(|e| e.to_string())?;
        let tree = repo
            .find_commit(git2::Oid::from_str(&self.hash).map_err(|e| e.to_string())?)
            .and_then(|c| c.tree())
            .map_err(|e| e.to_string())?;
        let mut index = repo.index().map_err(|e| e.to_string())?;
        index.read_tree(&tree).map_err(|e| e.to_string())?;
        index.write().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn freeze_skill_version(
    skill_id: String,
    message: String,
    version: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_skill_id(&skill_id)?;
        reject_system_skill_mutation(&skill_id)?;
        if message.trim().is_empty() || message.len() > 500 {
            return Err("变更说明需为 1–500 字节".into());
        }
        let _lock = crate::skill_lock::lock_skill_dir(&skill_id)?;
        reconcile_skill_projection_at(&skillhub_dir(), &skills_dir(), &skill_id)?;
        let root = skill_path(&skill_id);
        let profile = library_read_profile_readonly(&root)?;
        let session = crate::runtime_env::optional_session_snapshot_at(&skillhub_dir())?;
        let _lease = version_session_lease(&profile)?;
        let (hash, before) = capture_at(&root, &message, &version, &profile.version_metadata)?;
        let token = uuid::Uuid::new_v4().to_string();
        FROZEN.lock().map_err(|e| e.to_string())?.insert(
            token.clone(),
            FrozenVersion {
                skill_id,
                session,
                hash,
                before,
            },
        );
        Ok(token)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenPackage {
    package: SkillPackage,
    skill_md: String,
    env_dependencies: Vec<crate::skill_document::EnvDeclaration>,
}

fn package_at(root: &Path, hash: &str) -> Result<FrozenPackage, String> {
    let repo = crate::version_policy::open_repository(root).map_err(|e| e.to_string())?;
    let tree = repo
        .find_commit(git2::Oid::from_str(hash).map_err(|e| e.to_string())?)
        .and_then(|c| c.tree())
        .map_err(|e| e.to_string())?;
    let identity = crate::version_policy::tree_content(&repo, &tree)?;
    let mut files = Vec::new();
    let mut failure = None;
    tree.walk(git2::TreeWalkMode::PreOrder, |prefix, entry| {
        if entry.kind() == Some(git2::ObjectType::Blob) {
            match repo.find_blob(entry.id()) {
                Ok(blob) => files.push((
                    format!("{prefix}{}", entry.name().unwrap_or_default()),
                    blob.content().to_vec(),
                )),
                Err(e) => {
                    failure = Some(e.to_string());
                    return git2::TreeWalkResult::Abort;
                }
            }
        }
        git2::TreeWalkResult::Ok
    })
    .map_err(|e| e.to_string())?;
    if let Some(error) = failure {
        return Err(error);
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let skill_md = String::from_utf8(
        files
            .iter()
            .find(|(name, _)| name == "SKILL.md")
            .ok_or("快照缺少 SKILL.md")?
            .1
            .clone(),
    )
    .map_err(|e| e.to_string())?;
    let env_dependencies =
        crate::skill_document::parse_skill_document(&skill_md).env_declarations()?;
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        let mode = if identity.executable_paths.contains(&name) {
            0o755
        } else {
            0o644
        };
        writer
            .start_file(
                name,
                SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated)
                    .last_modified_time(ZipDateTime::default())
                    .unix_permissions(mode),
            )
            .map_err(|e| e.to_string())?;
        writer.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    let bytes = writer.finish().map_err(|e| e.to_string())?.into_inner();
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Skill 压缩包超过 20 MB".into());
    }
    Ok(FrozenPackage {
        package: SkillPackage {
            base64: BASE64.encode(&bytes),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            size: bytes.len(),
            content_hash: identity.content_hash,
            executable_paths: identity.executable_paths,
        },
        skill_md,
        env_dependencies,
    })
}

#[tauri::command]
pub async fn package_frozen_skill_version(
    skill_id: String,
    snapshot_id: String,
) -> Result<FrozenPackage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let frozen = checked(&snapshot_id, &skill_id)?;
        package_at(&skill_path(&skill_id), &frozen.hash)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_frozen_skill_version(
    skill_id: String,
    snapshot_id: String,
    version: String,
    allocation: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_skill_id(&skill_id)?;
        reject_system_skill_mutation(&skill_id)?;
        let _lock = crate::skill_lock::lock_skill_dir(&skill_id)?;
        let frozen = checked(&snapshot_id, &skill_id)?;
        let root = skill_path(&skill_id);
        let mut profile = library_read_profile_readonly(&root)?;
        let _lease = version_session_lease(&profile)?;
        checked(&snapshot_id, &skill_id)?;
        // Saving changes only version metadata; projections read content and runtime/env fields.
        save_at(&root, &mut profile, &frozen, &version, &allocation)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn save_at(
    root: &Path,
    profile: &mut SkillHubProfile,
    frozen: &FrozenVersion,
    version: &str,
    allocation: &str,
) -> Result<(), String> {
    if !matches!(allocation, "auto" | "manual") {
        return Err("版本分配方式无效".into());
    }
    source_edits::preserve_acquisition_version(root, profile)?;
    crate::version_policy::normalize_history(root, &mut profile.version_metadata)?;
    let repo = crate::version_policy::open_repository(root).map_err(|e| e.to_string())?;
    let commit = repo
        .find_commit(git2::Oid::from_str(&frozen.hash).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let content = crate::version_policy::commit_content(&repo, &commit)?;
    let mapped = profile
        .version_metadata
        .commits
        .get(&frozen.hash)
        .cloned()
        .or_else(|| {
            let head = crate::version_policy::head(root);
            let same_head_content = head.as_deref() == Some(&frozen.hash)
                || (head == frozen.before
                    && repo
                        .head()
                        .and_then(|head| head.peel_to_commit())
                        .is_ok_and(|head| head.tree_id() == commit.tree_id()));
            same_head_content
                .then(|| crate::version_policy::saved_current(root, &profile.version_metadata))
                .flatten()
        });
    if let Some(mapped) = mapped.as_ref().filter(|mapped| {
        mapped.receipt.is_some()
            || mapped.formal_version_id.is_some()
            || matches!(
                mapped.pending,
                Some(crate::version_policy::VersionIntent::Formal { .. })
            )
    }) {
        return if mapped.label == version {
            Ok(())
        } else {
            Err("当前内容已有版本；仅未确认的保存可以改号，请先修改内容再保存新版本".into())
        };
    }
    let mapped = mapped.filter(|mapped| mapped.content == content);
    let pending = mapped.as_ref().and_then(|mapped| mapped.pending.as_ref());
    let reuse = matches!(pending, Some(crate::version_policy::VersionIntent::Save { label, .. }) if label == version);
    if let Some(crate::version_policy::VersionIntent::Save {
        label,
        allocation: previous,
        ..
    }) = pending
    {
        if label == version && previous == allocation {
            frozen.activate(root)?;
            return Ok(());
        }
    }
    if !reuse {
        crate::version_policy::allocate(profile.version_metadata.high_water, Some(version))?;
    }
    frozen.activate(root)?;
    record_local_numbered_commit_at(
        root,
        profile,
        frozen.hash.clone(),
        content,
        version,
        allocation,
        true,
    )
}

#[tauri::command]
pub fn release_frozen_skill_version(snapshot_id: String) -> Result<(), String> {
    FROZEN
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&snapshot_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unchanged_unlabelled_head_gets_recoverable_trailer_without_rewriting_history() {
        let home = std::env::temp_dir().join(format!("frozen-trailer-{}", uuid::Uuid::new_v4()));
        let root = home.join("skills/demo");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("SKILL.md"), "# A\n").unwrap();
        source_edits::snapshot(&root, "external snapshot").unwrap();
        let previous = crate::version_policy::head(&root).unwrap();
        let mut profile = SkillHubProfile::default();
        let (hash, before) =
            capture_at(&root, "save A", "0.1.1", &profile.version_metadata).unwrap();
        assert_ne!(hash, previous);
        let frozen = FrozenVersion {
            skill_id: "demo".into(),
            session: None,
            hash: hash.clone(),
            before,
        };
        save_at(&root, &mut profile, &frozen, "0.1.1", "manual").unwrap();
        let mut recovered = crate::version_policy::VersionMetadata::default();
        crate::version_policy::normalize_history(&root, &mut recovered).unwrap();
        assert_eq!(recovered.commits[&hash].label, "0.1.1");
        let repo = crate::version_policy::open_repository(&root).unwrap();
        let commit = repo
            .find_commit(git2::Oid::from_str(&hash).unwrap())
            .unwrap();
        assert_eq!(commit.parent_id(0).unwrap().to_string(), previous);
        assert_eq!(
            commit.message().unwrap(),
            "save A\n\nSkillHub-Version: 0.1.1"
        );
        drop(commit);
        drop(repo);
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn same_tree_head_accepted_after_freeze_still_rejects_new_number() {
        let home =
            std::env::temp_dir().join(format!("frozen-late-receipt-{}", uuid::Uuid::new_v4()));
        let root = home.join("skills/demo");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("SKILL.md"), "# A\n").unwrap();
        let mut profile = SkillHubProfile::default();
        create_numbered_snapshot_at(&root, &mut profile, "0.1.1", "auto", "A").unwrap();
        let head = crate::version_policy::head(&root).unwrap();
        let (hash, before) =
            capture_at(&root, "renumber", "0.1.2", &profile.version_metadata).unwrap();
        assert_ne!(hash, head);
        profile
            .version_metadata
            .commits
            .get_mut(&head)
            .unwrap()
            .formal_version_id = Some("accepted-during-freeze".into());
        let original = profile.version_metadata.clone();
        let frozen = FrozenVersion {
            skill_id: "demo".into(),
            session: None,
            hash,
            before,
        };
        assert!(save_at(&root, &mut profile, &frozen, "0.1.2", "manual")
            .unwrap_err()
            .contains("当前内容已有版本"));
        assert_eq!(profile.version_metadata, original);
        assert_eq!(crate::version_policy::head(&root), Some(head));
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn accepted_or_formal_head_cannot_be_renumbered_and_same_label_is_noop() {
        for protection in ["receipt", "formal", "pending-formal"] {
            let home =
                std::env::temp_dir().join(format!("frozen-accepted-{}", uuid::Uuid::new_v4()));
            let root = home.join("skills/demo");
            fs::create_dir_all(&root).unwrap();
            fs::write(root.join("SKILL.md"), "# A\n").unwrap();
            let mut profile = SkillHubProfile::default();
            create_numbered_snapshot_at(&root, &mut profile, "0.1.1", "auto", "A").unwrap();
            let hash = crate::version_policy::head(&root).unwrap();
            let mapping = profile.version_metadata.commits.get_mut(&hash).unwrap();
            mapping.pending = None;
            match protection {
                "receipt" => {
                    mapping.receipt = Some(crate::version_policy::VersionReceipt {
                        receipt_id: "accepted".into(),
                        label: "0.1.1".into(),
                        card_sha256: String::new(),
                        formal_version_id: None,
                        formal_label: None,
                    })
                }
                "formal" => mapping.formal_version_id = Some("formal-version".into()),
                _ => {
                    mapping.pending = Some(crate::version_policy::VersionIntent::Formal {
                        version_id: "formal-version".into(),
                    })
                }
            }
            let original = profile.version_metadata.clone();
            let (hash, before) =
                capture_at(&root, "unchanged", "0.1.2", &profile.version_metadata).unwrap();
            let frozen = FrozenVersion {
                skill_id: "demo".into(),
                session: None,
                hash: hash.clone(),
                before,
            };
            assert_eq!(
                save_at(&root, &mut profile, &frozen, "0.1.2", "manual").unwrap_err(),
                "当前内容已有版本；仅未确认的保存可以改号，请先修改内容再保存新版本"
            );
            assert_eq!(profile.version_metadata, original);
            save_at(&root, &mut profile, &frozen, "0.1.1", "auto").unwrap();
            assert_eq!(profile.version_metadata, original);
            assert_eq!(crate::version_policy::head(&root), Some(hash));
            fs::remove_dir_all(home).unwrap();
        }
    }
    #[test]
    fn snapshot_scope_rejects_other_skill_account_and_space_generation() {
        let session: crate::runtime_env::RuntimeSession =
            serde_json::from_value(serde_json::json!({
                "version": 2, "userId": "account-a", "spaceId": "space-a", "generation": 1
            }))
            .unwrap();
        let frozen = FrozenVersion {
            skill_id: "demo".into(),
            session: Some(session.clone()),
            hash: "unused".into(),
            before: None,
        };
        assert!(frozen.matches_scope("demo", &Some(session.clone())));
        assert!(!frozen.matches_scope("other-skill", &Some(session.clone())));
        assert!(!frozen.matches_scope("demo", &None));
        for (user, space, generation) in [
            ("account-b", "space-a", 1),
            ("account-a", "space-b", 1),
            ("account-a", "space-a", 2),
        ] {
            let changed = serde_json::from_value(serde_json::json!({ "version": 2, "userId": user, "spaceId": space, "generation": generation })).unwrap();
            assert!(!frozen.matches_scope("demo", &Some(changed)));
        }
    }
    #[test]
    fn pending_save_keeps_original_request_while_later_edits_remain_dirty() {
        let home = std::env::temp_dir().join(format!("frozen-pending-{}", uuid::Uuid::new_v4()));
        let root = home.join("skills/demo");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("SKILL.md"), "# A\n").unwrap();
        let mut profile = SkillHubProfile::default();
        create_numbered_snapshot_at(&root, &mut profile, "0.1.1", "auto", "A").unwrap();
        let hash = crate::version_policy::head(&root).unwrap();
        let original = profile.version_metadata.commits[&hash].pending.clone();
        let (hash, before) =
            capture_at(&root, "retry A", "0.1.1", &profile.version_metadata).unwrap();
        let frozen = FrozenVersion {
            skill_id: "demo".into(),
            session: None,
            hash: hash.clone(),
            before,
        };
        fs::write(root.join("SKILL.md"), "# B\n").unwrap();
        save_at(&root, &mut profile, &frozen, "0.1.1", "auto").unwrap();
        assert_eq!(profile.version_metadata.commits[&hash].pending, original);
        assert_eq!(fs::read_to_string(root.join("SKILL.md")).unwrap(), "# B\n");
        assert!(working_copy_state_for_path(&root).0);
        save_at(&root, &mut profile, &frozen, "0.1.2", "manual").unwrap();
        let changed = profile.version_metadata.commits[&hash].pending.clone();
        assert_ne!(changed, original);
        save_at(&root, &mut profile, &frozen, "0.1.2", "manual").unwrap();
        assert_eq!(profile.version_metadata.commits[&hash].pending, changed);
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn frozen_package_and_saved_head_keep_a_while_working_tree_is_b() {
        let root = std::env::temp_dir().join(format!("frozen-version-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("SKILL.md"), "# A\r\n").unwrap();
        let (hash, before) = capture_at(&root, "save A", "0.1.1", &Default::default()).unwrap();
        let repo = crate::version_policy::open_repository(&root).unwrap();
        let commit = repo
            .find_commit(git2::Oid::from_str(&hash).unwrap())
            .unwrap();
        assert_eq!(
            commit.message().unwrap(),
            "save A\n\nSkillHub-Version: 0.1.1"
        );
        drop(commit);
        drop(repo);
        fs::write(root.join("SKILL.md"), "# B\n").unwrap();
        let first = package_at(&root, &hash).unwrap();
        let second = package_at(&root, &hash).unwrap();
        assert_eq!(first.skill_md, "# A\r\n");
        assert_eq!(first.package.base64, second.package.base64);
        let frozen = FrozenVersion {
            skill_id: "demo".into(),
            session: None,
            hash: hash.clone(),
            before,
        };
        assert!(frozen
            .require_matching_working_tree(&root)
            .unwrap_err()
            .contains("内容已变化"));
        frozen.activate(&root).unwrap();
        assert_eq!(crate::version_policy::head(&root), Some(hash.clone()));
        let mut recovered = crate::version_policy::VersionMetadata::default();
        crate::version_policy::normalize_history(&root, &mut recovered).unwrap();
        assert_eq!(recovered.commits[&hash].label, "0.1.1");
        assert_eq!(fs::read_to_string(root.join("SKILL.md")).unwrap(), "# B\n");
        assert!(working_copy_state_for_path(&root).0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn capture_rejects_missing_document_and_does_not_change_head() {
        let root = std::env::temp_dir().join(format!("frozen-invalid-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        assert!(capture_at(&root, "invalid", "0.1.1", &Default::default()).is_err());
        assert_eq!(crate::version_policy::head(&root), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn matching_later_head_is_reused_without_rewinding_history() {
        let root = std::env::temp_dir().join(format!("frozen-history-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("SKILL.md"), "# baseline\n").unwrap();
        source_edits::snapshot(&root, "baseline").unwrap();
        fs::write(root.join("SKILL.md"), "# A\n").unwrap();
        let (hash, before) = capture_at(&root, "freeze A", "0.1.1", &Default::default()).unwrap();
        let frozen = FrozenVersion {
            skill_id: "demo".into(),
            session: None,
            hash,
            before,
        };
        fs::write(root.join("SKILL.md"), "# C\n").unwrap();
        source_edits::snapshot(&root, "saved C").unwrap();
        let c = crate::version_policy::head(&root).unwrap();
        fs::write(root.join("SKILL.md"), "# A\n").unwrap();
        source_edits::snapshot(&root, "saved A again").unwrap();
        let d = crate::version_policy::head(&root).unwrap();
        assert_eq!(frozen.record_hash(&root).unwrap(), d);
        assert!(frozen.activate(&root).is_err());
        assert_eq!(crate::version_policy::head(&root), Some(d.clone()));
        let repo = crate::version_policy::open_repository(&root).unwrap();
        assert!(repo
            .graph_descendant_of(
                git2::Oid::from_str(&d).unwrap(),
                git2::Oid::from_str(&c).unwrap()
            )
            .unwrap());
        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn frozen_package_preserves_declarations_and_executable_baseline() {
        let root = std::env::temp_dir().join(format!("frozen-exec-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("SKILL.md"), "---\nname: demo\nmetadata:\n  skillhub:\n    env:\n      - key: A_KEY\n        required: true\n---\n# A\n").unwrap();
        fs::write(root.join("run.sh"), "echo A\n").unwrap();
        #[cfg(unix)]
        fs::set_permissions(root.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        source_edits::snapshot(&root, "baseline").unwrap();
        let repo = crate::version_policy::open_repository(&root).unwrap();
        // Seed a portable executable baseline, including on NTFS.
        let mut index = repo.index().unwrap();
        let mut entry = index.get_path(Path::new("run.sh"), 0).unwrap();
        entry.mode = 0o100755;
        index.add(&entry).unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        let sig = git2::Signature::now("Test", "test@example.invalid").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "executable", &tree, &[&parent])
            .unwrap();
        fs::write(root.join("run.sh"), "echo submitted\n").unwrap();
        let (hash, _) = capture_at(&root, "freeze", "0.1.1", &Default::default()).unwrap();
        fs::write(root.join("SKILL.md"), "# B\n").unwrap();
        let package = package_at(&root, &hash).unwrap();
        assert_eq!(package.env_dependencies[0].key, "A_KEY");
        assert_eq!(package.package.executable_paths, vec!["run.sh"]);
        let bytes = BASE64.decode(&package.package.base64).unwrap();
        let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert_ne!(
            archive.by_name("run.sh").unwrap().unix_mode().unwrap() & 0o111,
            0
        );
        drop(archive);
        drop(tree);
        drop(parent);
        drop(index);
        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }
}
