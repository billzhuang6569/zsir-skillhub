#[cfg(windows)]
use crate::platform_fs::{unix_fs, MetadataExt, OpenOptionsExt, PermissionsExt};
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
#[cfg(unix)]
use std::ffi::CString;
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Read, Write};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs as unix_fs;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;
use zeroize::Zeroize;
use zip::{write::SimpleFileOptions, DateTime as ZipDateTime, ZipArchive, ZipWriter};

use crate::{
    detect_agents, envs_dir, skillhub_dir, skills_dir, AcquisitionSource, AgentInfo,
    AgentSkillSource, DiffLine, EnvDep, EnvDepRaw, ImportSkillPackageInput, ImportSkillPreflight,
    ImportSkillSource, LocalSkill, SharedSkillState, SkillHubJson, SkillHubProfile, SkillPackage,
    SkillProfileUpdateInput, SkillUpstream, SkillVersion, TrashItem, UnmanagedSkill,
};

#[path = "skill_unmanage.rs"]
pub mod unmanage;

// ── Helpers ──────────────────────────────────────────────────────────────────

fn skill_path(skill_id: &str) -> PathBuf {
    skills_dir().join(skill_id)
}

#[cfg(test)]
mod portable_restore_tests {
    use super::restore_skill_version_at_path;
    use std::fs;
    use std::path::Path;

    #[test]
    fn no_replace_move_preserves_both_occupied_file_and_directory() {
        let root =
            std::env::temp_dir().join(format!("skillhub-no-replace-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("来源.json");
        let target = root.join("目标.json");
        fs::write(&source, "source").unwrap();
        fs::write(&target, "target").unwrap();
        assert!(super::rename_noreplace(&source, &target).is_err());
        assert_eq!(fs::read_to_string(&source).unwrap(), "source");
        assert_eq!(fs::read_to_string(&target).unwrap(), "target");
        fs::remove_file(&target).unwrap();
        super::rename_noreplace(&source, &target).unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "source");
        fs::create_dir(root.join("a")).unwrap();
        fs::create_dir(root.join("b")).unwrap();
        assert!(super::rename_noreplace(&root.join("a"), &root.join("b")).is_err());
        assert!(root.join("a").is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn version_restore_sink_rejects_nonportable_tree_without_mutating_repository() {
        let directory = std::env::temp_dir().join(format!(
            "skillhub-restore-nonportable-tree-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).expect("create restore fixture");
        let repository = git2::Repository::init(&directory).expect("initialize repository");
        let signature =
            git2::Signature::now("SkillHub", "skillhub@local").expect("create signature");

        let historical_skill = repository
            .blob(b"# Historical version\n")
            .expect("write historical Skill blob");
        let reserved_file = repository
            .blob(b"reserved\n")
            .expect("write reserved-name blob");
        let mut historical_builder = repository
            .treebuilder(None)
            .expect("create historical tree");
        historical_builder
            .insert("SKILL.md", historical_skill, 0o100644)
            .expect("insert historical Skill");
        historical_builder
            .insert("CON.txt", reserved_file, 0o100644)
            .expect("insert non-portable historical path");
        let historical_tree_id = historical_builder.write().expect("write historical tree");
        drop(historical_builder);
        let historical_tree = repository
            .find_tree(historical_tree_id)
            .expect("find historical tree");
        let historical_commit = repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "unsafe historical version",
                &historical_tree,
                &[],
            )
            .expect("commit historical version");
        drop(historical_tree);

        let current_contents = b"# Current safe version\n";
        fs::write(directory.join("SKILL.md"), current_contents).expect("write current Skill");
        let mut index = repository.index().expect("open current index");
        index.clear().expect("clear current index");
        index
            .add_path(Path::new("SKILL.md"))
            .expect("stage current Skill");
        index.write().expect("write current index");
        let current_tree_id = index.write_tree().expect("write current tree");
        drop(index);
        let current_tree = repository
            .find_tree(current_tree_id)
            .expect("find current tree");
        let parent = repository
            .find_commit(historical_commit)
            .expect("find historical parent");
        let current_commit = repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "current safe version",
                &current_tree,
                &[&parent],
            )
            .expect("commit current version");
        drop(parent);
        drop(current_tree);
        drop(repository);

        let error = restore_skill_version_at_path(&directory, &historical_commit.to_string())
            .expect_err("restore sink must reject a non-portable target tree");
        assert!(error.contains("Windows 保留设备名"));

        let repository = git2::Repository::open(&directory).expect("reopen repository");
        let after_head = repository
            .head()
            .expect("read HEAD")
            .peel_to_commit()
            .expect("read HEAD commit")
            .id();
        assert_eq!(after_head, current_commit);
        assert_eq!(
            fs::read(directory.join("SKILL.md")).expect("read preserved current Skill"),
            current_contents
        );
        let entries = fs::read_dir(&directory)
            .expect("read preserved worktree")
            .map(|entry| {
                entry
                    .expect("read worktree entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        assert!(!entries
            .iter()
            .any(|entry| entry.eq_ignore_ascii_case("CON.txt")));
        let statuses = repository.statuses(None).expect("read final status");
        assert!(statuses.is_empty());
        drop(statuses);
        drop(repository);

        fs::remove_dir_all(directory).expect("remove restore fixture");
    }
}

const INITIAL_SKILL_VERSION: &str = "0.1.0";
const LEGACY_UNVERSIONED_LABEL: &str = "未版本化";

fn is_system_skill_id(skill_id: &str) -> bool {
    skill_id == crate::system_skill::SYSTEM_MANAGER_ID
}

fn is_installed_system_manager_source_at(
    source_root: &Path,
    skillhub_root: &Path,
    managed_root: &Path,
) -> bool {
    let Ok(canonical_source) = fs::canonicalize(source_root) else {
        return false;
    };
    [
        managed_root.join(crate::system_skill::SYSTEM_MANAGER_ID),
        projection_root_at(skillhub_root, crate::system_skill::SYSTEM_MANAGER_ID).join("current"),
    ]
    .into_iter()
    .filter_map(|candidate| fs::canonicalize(candidate).ok())
    .any(|candidate| candidate == canonical_source)
}

fn reject_installed_system_manager_import(source_root: &Path) -> Result<(), String> {
    if is_installed_system_manager_source_at(source_root, &skillhub_dir(), &skills_dir()) {
        return Err("SkillHub Manager 是受保护的系统 Skill，不能作为普通 Skill 再导入".into());
    }
    Ok(())
}

fn reject_system_skill_mutation(skill_id: &str) -> Result<(), String> {
    if is_system_skill_id(skill_id)
        || read_profile_result(skill_id).is_ok_and(|profile| profile.is_system)
    {
        return Err(
            "SkillHub Manager 是受保护的系统 Skill，不能修改、停用、删除、Fork 或分享".into(),
        );
    }
    Ok(())
}

fn normalize_initial_version(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == LEGACY_UNVERSIONED_LABEL {
        INITIAL_SKILL_VERSION.to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_profile_initial_version(profile: &mut SkillHubProfile) -> bool {
    let normalized = normalize_initial_version(&profile.version);
    if normalized == profile.version {
        return false;
    }
    profile.version = normalized;
    true
}

fn infer_legacy_acquisition_source(profile: &SkillHubProfile) -> AcquisitionSource {
    if profile.team_shared_from.is_some() || profile.is_own == Some(false) {
        AcquisitionSource::Team
    } else {
        AcquisitionSource::Local
    }
}

pub(crate) fn profile_acquisition_source(profile: &SkillHubProfile) -> AcquisitionSource {
    profile
        .acquisition_source
        .unwrap_or_else(|| infer_legacy_acquisition_source(profile))
}

fn imported_asset_is_own(is_own: bool) -> bool {
    is_own
}

fn normalize_import_account_binding(
    source: AcquisitionSource,
    acquired_by_user_id: Option<&str>,
) -> Result<Option<String>, String> {
    match (source, acquired_by_user_id) {
        (AcquisitionSource::Team, Some(user_id)) => uuid::Uuid::parse_str(user_id)
            .map(|value| Some(value.to_string()))
            .map_err(|_| "团队 Skill 缺少有效的获取账号标识".to_string()),
        (AcquisitionSource::Team, None) => Err("团队 Skill 必须绑定当前获取账号".into()),
        (AcquisitionSource::Local | AcquisitionSource::Marketplace, Some(_)) => {
            Err("只有团队来源 Skill 可以记录获取账号".into())
        }
        (AcquisitionSource::Local | AcquisitionSource::Marketplace, None) => Ok(None),
    }
}

fn acquisition_source_label(source: AcquisitionSource) -> &'static str {
    match source {
        AcquisitionSource::Local => "本机",
        AcquisitionSource::Team => "团队共享",
        AcquisitionSource::Marketplace => "Skill 商店",
    }
}

fn normalize_profile_acquisition_source(profile: &mut SkillHubProfile) -> bool {
    if profile.acquisition_source.is_some() {
        return false;
    }
    profile.acquisition_source = Some(infer_legacy_acquisition_source(profile));
    true
}

fn validate_skill_id(skill_id: &str) -> Result<(), String> {
    let valid =
        Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$").map_err(|error| error.to_string())?;
    if skill_id == "." || skill_id == ".." || !valid.is_match(skill_id) {
        return Err("Skill id contains invalid characters".into());
    }
    Ok(())
}

pub(crate) fn write_private_file(path: &Path, contents: &str) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(format!("拒绝向符号链接写入私有配置: {}", path.display()));
    }
    let parent = path
        .parent()
        .ok_or_else(|| "无法确定配置目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skillhub"),
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("无法创建私有配置临时文件: {error}"))?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("无法设置私有配置文件权限: {error}"))?;
        crate::platform_fs::set_private_acl(&temporary)
            .map_err(|error| format!("无法设置私有配置文件 ACL: {error}"))?;
        file.write_all(contents.as_bytes())
            .map_err(|error| format!("无法写入私有配置文件: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("无法同步私有配置文件: {error}"))?;
        fs::rename(&temporary, path).map_err(|error| format!("无法提交私有配置文件: {error}"))?;
        if let Ok(directory) = fs::File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn read_profile_result(skill_id: &str) -> Result<SkillHubProfile, String> {
    let profile = read_current_profile_at_path(&skill_path(skill_id))?;
    let session = match crate::runtime_env::runtime_session_snapshot() {
        Ok(session) => session,
        Err(_)
            if profile.scope.is_none()
                && fs::symlink_metadata(skillhub_dir().join("runtime/session.json"))
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(profile)
        }
        Err(error) => return Err(error),
    };
    if session.is_sync_pending() {
        return Err(crate::spaces::STALE.into());
    }
    crate::spaces::require_profile(&profile, &session)?;
    Ok(profile)
}

fn read_current_profile_at_path(root: &Path) -> Result<SkillHubProfile, String> {
    let path = root.join(".skillhub.json");
    if !path.exists() {
        return Ok(SkillHubProfile::default());
    }
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("Skill Profile 不能是符号链接".into());
    }
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("无法读取 Skill Profile: {error}"))?;
    let json: SkillHubJson = serde_json::from_str(&contents)
        .map_err(|error| format!("Skill Profile JSON 已损坏: {error}"))?;
    let mut profile = json.skillhub.unwrap_or_default();
    if root.starts_with(skills_dir()) {
        let session = crate::runtime_env::runtime_session_snapshot()?;
        if session.is_sync_pending() || !crate::spaces::profile_matches(&profile, &session) {
            return Ok(profile);
        }
    }
    let version_changed = normalize_profile_initial_version(&mut profile);
    let source_changed = normalize_profile_acquisition_source(&mut profile);
    if version_changed || source_changed {
        write_profile_at_path(root, &profile)
            .map_err(|error| format!("无法迁移 Skill Profile: {error}"))?;
    }
    Ok(profile)
}

fn write_profile(skill_id: &str, profile: &SkillHubProfile) -> Result<()> {
    write_profile_at_path(&skill_path(skill_id), profile)
}

fn write_profile_at_path(root: &Path, profile: &SkillHubProfile) -> Result<()> {
    let path = root.join(".skillhub.json");
    let mut profile = profile.clone();
    let _lease = if root.starts_with(skills_dir()) && !profile.is_system {
        let session = crate::runtime_env::runtime_session_snapshot().map_err(anyhow::Error::msg)?;
        crate::spaces::require_profile(&profile, &session).map_err(anyhow::Error::msg)?;
        if path.exists() {
            crate::spaces::require_profile(
                &read_profile_at_path(root).map_err(anyhow::Error::msg)?,
                &session,
            )
            .map_err(anyhow::Error::msg)?;
        }
        let lease = crate::runtime_env::acquire_current_session_lease(&session)
            .map_err(anyhow::Error::msg)?
            .ok_or_else(|| anyhow::anyhow!(crate::spaces::STALE))?;
        profile.scope = Some(crate::spaces::SidecarScope::for_session(&session));
        Some(lease)
    } else {
        None
    };
    let json = SkillHubJson {
        version: "1.0".into(),
        skillhub: Some(profile),
    };
    write_private_file(&path, &serde_json::to_string_pretty(&json)?).map_err(anyhow::Error::msg)?;
    Ok(())
}

fn system_manager_profile() -> SkillHubProfile {
    SkillHubProfile {
        id: Some(crate::system_skill::SYSTEM_MANAGER_ID.into()),
        is_own: Some(false),
        is_system: true,
        system_version: Some(crate::system_skill::SYSTEM_MANAGER_VERSION.into()),
        acquisition_source: Some(AcquisitionSource::Local),
        name: Some(crate::system_skill::SYSTEM_MANAGER_ID.into()),
        display_name: Some(crate::system_skill::SYSTEM_MANAGER_DISPLAY_NAME.into()),
        description: Some(
            "Agent 与 SkillHub 之间的系统协议层，负责编辑、安装、版本、凭据、共享和恢复路由。"
                .into(),
        ),
        category: Some("系统".into()),
        labels: vec!["系统 Skill".into(), "SkillHub".into()],
        compatible_agents: crate::known_agents()
            .into_iter()
            .map(|(key, _, _)| key.to_string())
            .collect(),
        version: crate::system_skill::SYSTEM_MANAGER_VERSION.into(),
        ..Default::default()
    }
}

fn write_expected_private_file(path: &Path, contents: &str) -> Result<(), String> {
    if fs::read_to_string(path).is_ok_and(|existing| existing == contents) {
        return Ok(());
    }
    write_private_file(path, contents)
}

fn ensure_system_manager_files_at(managed_root: &Path) -> Result<PathBuf, String> {
    let root = managed_root.join(crate::system_skill::SYSTEM_MANAGER_ID);
    match fs::symlink_metadata(&root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err("SkillHub Manager 托管位置被非目录项占用，已阻止覆盖".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&root).map_err(|error| error.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    crate::system_skill::cleanup_legacy_files(&root)?;

    for (relative, contents) in crate::system_skill::files() {
        let destination = root.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
        }
        write_expected_private_file(&destination, contents)?;
    }

    let profile = system_manager_profile();
    let sidecar = SkillHubJson {
        version: "1.0".into(),
        skillhub: Some(profile),
    };
    let sidecar = serde_json::to_string_pretty(&sidecar).map_err(|error| error.to_string())?;
    write_expected_private_file(&root.join(".skillhub.json"), &sidecar)?;
    for (relative, _) in crate::system_skill::files() {
        fs::set_permissions(root.join(relative), fs::Permissions::from_mode(0o400))
            .map_err(|error| error.to_string())?;
    }
    fs::set_permissions(
        root.join(".skillhub.json"),
        fs::Permissions::from_mode(0o400),
    )
    .map_err(|error| error.to_string())?;
    fs::set_permissions(root.join("references"), fs::Permissions::from_mode(0o500))
        .map_err(|error| error.to_string())?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o500))
        .map_err(|error| error.to_string())?;
    Ok(root)
}

fn system_manager_files_are_current_at(managed_root: &Path) -> bool {
    let root = managed_root.join(crate::system_skill::SYSTEM_MANAGER_ID);
    if crate::system_skill::files()
        .into_iter()
        .any(|(relative, contents)| {
            fs::read_to_string(root.join(relative)).map_or(true, |actual| actual != contents)
        })
    {
        return false;
    }
    read_profile_at_path(&root).is_ok_and(|profile| {
        profile.is_system
            && profile.system_version.as_deref()
                == Some(crate::system_skill::SYSTEM_MANAGER_VERSION)
            && profile.name.as_deref() == Some(crate::system_skill::SYSTEM_MANAGER_ID)
    })
}

fn system_manager_is_healthy_at(
    home: &Path,
    skillhub_root: &Path,
    managed_root: &Path,
    detected_agents: &HashSet<String>,
) -> bool {
    if !system_manager_files_are_current_at(managed_root) {
        return false;
    }
    let Some((marker, generation)) = current_projection_at(
        skillhub_root,
        managed_root,
        crate::system_skill::SYSTEM_MANAGER_ID,
    ) else {
        return false;
    };
    if !projection_generation_is_coordinated(&marker, &generation) {
        return false;
    }
    let current =
        projection_root_at(skillhub_root, crate::system_skill::SYSTEM_MANAGER_ID).join("current");
    let Ok(expected) = fs::canonicalize(&current) else {
        return false;
    };
    crate::known_agents()
        .into_iter()
        .all(|(agent_key, _, relative)| {
            if !detected_agents.contains(agent_key) || !home.join(relative).is_dir() {
                return true;
            }
            fs::canonicalize(
                home.join(relative)
                    .join(crate::system_skill::SYSTEM_MANAGER_ID),
            )
            .is_ok_and(|actual| actual == expected)
        })
}

fn repair_system_manager_at(
    home: &Path,
    skillhub_root: &Path,
    managed_root: &Path,
    detected_agents: &HashSet<String>,
) -> Result<(), String> {
    if system_manager_is_healthy_at(home, skillhub_root, managed_root, detected_agents) {
        return Ok(());
    }
    let projection = projection_root_at(skillhub_root, crate::system_skill::SYSTEM_MANAGER_ID);
    if fs::symlink_metadata(&projection).is_ok() {
        remove_projection_root_at(skillhub_root, crate::system_skill::SYSTEM_MANAGER_ID)?;
    }
    ensure_system_manager_files_at(managed_root)?;
    let generated = refresh_skill_projection_at(
        skillhub_root,
        managed_root,
        crate::system_skill::SYSTEM_MANAGER_ID,
    )?;
    fs::set_permissions(
        generated.join("SKILL.md"),
        fs::Permissions::from_mode(0o400),
    )
    .map_err(|error| error.to_string())?;
    let canonical = managed_root.join(crate::system_skill::SYSTEM_MANAGER_ID);
    let mut failures = Vec::new();
    for (agent_key, agent_name, relative) in crate::known_agents() {
        if !detected_agents.contains(agent_key) || !home.join(relative).is_dir() {
            continue;
        }
        let link = home
            .join(relative)
            .join(crate::system_skill::SYSTEM_MANAGER_ID);
        if let Err(error) = migrate_agent_projection_link(
            &link,
            &canonical,
            &generated,
            skillhub_root,
        )
        .and_then(|_| {
            install_skill_projections_with(&generated, vec![link.clone()], |source, target| {
                unix_fs::symlink(source, target).map_err(|reason| reason.to_string())
            })
        }) {
            failures.push(format!("{agent_name}: {error}"));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "SkillHub Manager 部分投影修复失败：{}",
            failures.join("；")
        ))
    }
}

pub fn repair_system_manager() -> Result<(), String> {
    let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
    repair_system_manager_at(
        &home,
        &skillhub_dir(),
        &skills_dir(),
        &crate::ready_detected_agent_keys(),
    )
}

fn read_profile_at_path(root: &Path) -> Result<SkillHubProfile, String> {
    let path = root.join(".skillhub.json");
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("无法读取现有 Skill Profile: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("现有 Skill Profile 必须是真实文件".into());
    }
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("无法读取现有 Skill Profile: {error}"))?;
    let json: SkillHubJson = serde_json::from_str(&contents)
        .map_err(|error| format!("现有 Skill Profile JSON 已损坏: {error}"))?;
    json.skillhub
        .ok_or_else(|| "现有 Skill 缺少 SkillHub Profile".into())
}

fn git_versions(skill_id: &str) -> Vec<SkillVersion> {
    git_versions_at_path(&skill_path(skill_id))
}

pub(crate) fn git_versions_at_path(repo_path: &Path) -> Vec<SkillVersion> {
    let metadata = read_profile_at_path(repo_path)
        .map(|p| p.version_metadata)
        .unwrap_or_default();
    let Some(view) = SkillVersionView::read(repo_path, &metadata) else {
        return vec![];
    };
    git_versions_from_view(repo_path, &view)
}

/// Everything one read of a Skill derives from its history: the normalized
/// mapping at HEAD, the saved HEAD version, whether the working tree still
/// matches it, and the working tree's own content identity. Computed once per
/// Skill per list read and handed to every consumer, so the full-history walk
/// (`normalize_history`, which reads every historical blob) and the
/// working-tree hash are not repeated by `git_versions`, `current` and
/// `saved_current` separately. Never cached across reads.
pub(crate) struct SkillVersionView {
    pub(crate) normalized: crate::version_policy::NormalizedView,
    pub(crate) saved: Option<crate::version_policy::CommitVersion>,
    pub(crate) mapped_current: Option<crate::version_policy::CommitVersion>,
    /// Working-tree identity without an executable-path hint, as the version
    /// list compares it.
    pub(crate) identity: Option<crate::library_sync::content::ContentIdentity>,
}

impl SkillVersionView {
    pub(crate) fn read(
        root: &Path,
        metadata: &crate::version_policy::VersionMetadata,
    ) -> Option<Self> {
        Some(Self::from_normalized(
            root,
            crate::version_policy::normalized_view(root, metadata)?,
        ))
    }

    pub(crate) fn from_normalized(
        root: &Path,
        normalized: crate::version_policy::NormalizedView,
    ) -> Self {
        let saved = crate::version_policy::saved_current_in(root, &normalized);
        let mapped_current = saved
            .clone()
            .and_then(|saved| crate::version_policy::current_from_saved(root, saved));
        let identity = crate::library_sync::content::local_identity(root, None)
            .ok()
            .map(|(identity, _)| identity);
        Self {
            normalized,
            saved,
            mapped_current,
            identity,
        }
    }
}

/// The view a list build may derive from: the maintained one only when both
/// the sidecar metadata and the repository HEAD are unchanged since it was
/// taken; otherwise a fresh single read.
fn reusable_version_view(
    root: &Path,
    maintained: Option<crate::version_policy::NormalizedView>,
    on_disk: &crate::version_policy::VersionMetadata,
) -> Option<SkillVersionView> {
    maintained
        .filter(|view| view.metadata == *on_disk && view.head == crate::version_policy::head(root))
        .map(|view| SkillVersionView::from_normalized(root, view))
        .or_else(|| SkillVersionView::read(root, on_disk))
}

fn git_versions_from_view(repo_path: &Path, view: &SkillVersionView) -> Vec<SkillVersion> {
    let repo = match git2::Repository::open(repo_path) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let mut revwalk = match repo.revwalk() {
        Ok(rw) => rw,
        Err(_) => return vec![],
    };
    // Enumerate from the view's HEAD so the list, `saved` and `current` all
    // describe the same snapshot even if the repository moved meanwhile.
    let Some(head) = view.normalized.head.as_deref() else {
        return vec![];
    };
    let Ok(head_oid) = git2::Oid::from_str(head) else {
        return vec![];
    };
    if revwalk.push(head_oid).is_err() {
        return vec![];
    }
    let metadata = &view.normalized.metadata;
    let current = view.normalized.head.clone();
    let identity = view.identity.as_ref();
    let scoped =
        metadata.account_id.as_deref() == crate::runtime_env::active_runtime_user_id().as_deref();
    revwalk
        .filter_map(|oid| {
            let oid = oid.ok()?;
            let commit = repo.find_commit(oid).ok()?;
            let msg = commit.message().unwrap_or("").to_string();
            let time = commit.time().seconds();
            let dt = chrono_from_secs(time);
            let mappings = crate::version_policy::history_for_hash(metadata, &oid.to_string());
            let mappings: Vec<Option<&crate::version_policy::CommitVersion>> =
                if mappings.is_empty() {
                    vec![None]
                } else {
                    mappings.iter().map(Some).collect()
                };
            Some(
                mappings
                    .into_iter()
                    .map(|mapped| {
                        let receipt = mapped.and_then(|m| m.receipt.as_ref()).filter(|_| scoped);
                        let is_current = current.as_deref() == Some(&oid.to_string())
                            && mapped.is_some_and(|m| identity == Some(&m.content))
                            && mapped.and_then(|m| m.receipt.as_ref())
                                == current
                                    .as_ref()
                                    .and_then(|h| metadata.commits.get(h))
                                    .and_then(|m| m.receipt.as_ref());
                        let version = mapped
                            .map(|m| m.label.clone())
                            .unwrap_or_else(|| "未编号工作副本".into());
                        SkillVersion {
                            version,
                            changelog: Some(msg.clone()),
                            git_hash: Some(oid.to_string()),
                            date: dt.clone(),
                            is_current,
                            original_label: mapped.map(|m| m.original_label.clone()),
                            receipt_id: receipt.map(|r| r.receipt_id.clone()),
                            formal_version_id: mapped
                                .and_then(|m| m.formal_version_id.clone())
                                .filter(|_| scoped),
                            formal_label: receipt.and_then(|r| r.formal_label.clone()),
                            version_status: mapped
                                .map(|m| {
                                    if receipt.is_some() {
                                        "confirmed"
                                    } else if scoped && is_current && m.pending.is_some() {
                                        "pending"
                                    } else {
                                        "local"
                                    }
                                })
                                .unwrap_or("unversioned")
                                .into(),
                        }
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .flatten()
        .collect()
}

fn working_copy_state_for_path(repo_path: &Path) -> (bool, u32, Option<String>) {
    let Ok(repo) = git2::Repository::open(repo_path) else {
        return (false, 0, None);
    };
    let mut options = git2::StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let Ok(statuses) = repo.statuses(Some(&mut options)) else {
        return (false, 0, None);
    };
    let mut changed = Vec::new();
    for entry in statuses.iter() {
        let relative = match entry.path() {
            Ok(path) => PathBuf::from(path),
            // A status path that cannot be represented safely must never make
            // a modified working copy look clean.
            Err(_) => return (true, 1, None),
        };
        if relative != Path::new(".skillhub.json") && !is_generated_path(&relative) {
            changed.push(relative);
        }
    }
    if changed.is_empty() {
        return (false, 0, None);
    }

    let working_copy_hash = skill_tree_fingerprint(repo_path)
        .ok()
        .map(|fingerprint| format!("{:x}", Sha256::digest(fingerprint)));
    (
        true,
        changed.len().min(u32::MAX as usize) as u32,
        working_copy_hash,
    )
}

fn chrono_from_secs(secs: i64) -> String {
    // Simple ISO date without extra deps
    let days = secs / 86400;
    let epoch_days = 719468_i64;
    let z = days + epoch_days;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

fn is_symlink_to_path(link: &Path, expected: &Path) -> bool {
    let Ok(target) = fs::read_link(link) else {
        return false;
    };
    let absolute_target = if target.is_absolute() {
        target
    } else {
        link.parent().unwrap_or_else(|| Path::new("/")).join(target)
    };
    let Ok(absolute_target) = fs::canonicalize(absolute_target) else {
        return false;
    };
    let Ok(expected) = fs::canonicalize(expected) else {
        return false;
    };
    absolute_target == expected
}

fn symlink_declares_path(link: &Path, expected: &Path) -> bool {
    declared_symlink_target(link).is_some_and(|target| target == expected)
}

fn is_symlink_to_skill(link: &Path, skill_id: &str) -> bool {
    matches!(
        managed_skill_agent_projection_state_at(link, &skillhub_dir(), &skills_dir(), skill_id,),
        Ok(ManagedSkillAgentProjectionState::Installed)
    )
}

const PROJECTION_MARKER_NAME: &str = ".skillhub-projection.json";
const PROJECTION_CONFLICT_NAME: &str = "conflict.json";
pub(crate) const PROJECTION_MARKER_VERSION: u8 = 2;
pub(crate) const LEGACY_PROJECTION_MARKER_VERSION: u8 = 1;
pub(crate) const PROJECTION_HEADER_VERSION: u8 = 4;
pub(crate) const ENV_ONLY_PROJECTION_HEADER_VERSION: u8 = 3;
pub(crate) const SHELL_EXPORT_PROJECTION_HEADER_VERSION: u8 = 2;
pub(crate) const LEGACY_PROJECTION_HEADER_VERSION: u8 = 1;
const MAX_PROJECTION_MARKER_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectionMarker {
    version: u8,
    skill_id: String,
    source_root: String,
    generation: String,
    canonical_skill_md_sha256: String,
    rendered_skill_md_sha256: String,
    header_version: u8,
    header_token: String,
    header_injected: bool,
    #[serde(default)]
    header_separator_injected: bool,
    #[serde(default)]
    env_keys: Vec<String>,
    resource_names: Vec<String>,
}

#[cfg(unix)]
pub(crate) fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    let from = CString::new(from.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let to = CString::new(to.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub(crate) fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |path: &Path| -> std::io::Result<Vec<u16>> {
        let absolute = std::path::absolute(path)?;
        let parent = absolute.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
        let name = absolute
            .file_name()
            .ok_or(std::io::ErrorKind::InvalidInput)?;
        // Canonicalize the parent for long-path support without following the moved link.
        let mut value: Vec<u16> = fs::canonicalize(parent)?
            .join(name)
            .as_os_str()
            .encode_wide()
            .collect();
        if value.contains(&0) {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        value.push(0);
        Ok(value)
    };
    let from = wide(from)?;
    let to = wide(to)?;
    // No REPLACE_EXISTING or COPY_ALLOWED: one same-volume move, never overwrite.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn restore_quarantined_path(
    quarantine: &Path,
    original: &Path,
    context: &str,
) -> Result<(), String> {
    rename_noreplace(quarantine, original).map_err(|error| {
        format!(
            "{context}；原项保留在 {}，但恢复原路径失败: {error}",
            quarantine.display()
        )
    })
}

/// Replace `link` with the prepared `temporary` link without overwriting
/// anything unexpected. With `expected_old_target`, the existing link is first
/// isolated (preferably into SkillHub's private staging area) and verified
/// against that exact declared target; a mismatch is restored untouched. After
/// the new link is in place the verified old link entry itself is unlinked, so
/// no Agent-visible `.skillhub-old-link-*` entry survives (#272).
fn install_prepared_symlink_atomically(
    temporary: &Path,
    link: &Path,
    expected_old_target: Option<&Path>,
    skillhub_root: &Path,
) -> Result<(), String> {
    let Some(expected_old_target) = expected_old_target else {
        return rename_noreplace(temporary, link).map_err(|error| error.to_string());
    };
    let expected_targets = [expected_old_target.to_path_buf()];
    let isolated = isolate_owned_link(
        link,
        skillhub_root,
        LEGACY_OLD_LINK_PREFIX,
        |isolated, origin_parent| {
            isolated_link_declares_any(isolated, origin_parent, &expected_targets)
        },
        "符号链接在原子切换期间发生变化，已拒绝覆盖",
        "符号链接在原子切换期间发生变化，已保留原项".into(),
    )?;
    if let Err(error) = rename_noreplace(temporary, link) {
        restore_quarantined_path(&isolated, link, "新符号链接安装失败，正在恢复原项")?;
        return Err(error.to_string());
    }
    // The switch already succeeded; failing to drop the verified old link must
    // not report the install as failed. A same-directory fallback leftover is
    // removed by the startup sweep.
    let _ = remove_isolated_link_entry(&isolated);
    Ok(())
}

/// Prefix used by builds before #165 for removed projections retained inside
/// the Agent Skill directory. Agents still scan those entries, so new code
/// never leaves one behind and startup removes proven SkillHub leftovers.
const LEGACY_REMOVE_LINK_PREFIX: &str = ".skillhub-remove-link-";
/// Prefix used by builds before #272 for the previous link retained inside the
/// Agent Skill directory after a projection migration. New code only uses it
/// as a same-directory isolation fallback and unlinks the entry immediately.
const LEGACY_OLD_LINK_PREFIX: &str = ".skillhub-old-link-";
/// SkillHub-private staging directory for projection links being removed. No
/// Agent scans it, so an isolated link is never loaded as a Skill.
const PROJECTION_UNLINK_DIR: &str = "projection-unlink";

/// Declared target of a link entry, resolving a relative target against the
/// directory the entry originally lived in (the entry may already have been
/// moved into the staging area). Windows junctions report their absolute
/// target without the verbatim prefix.
fn declared_link_target_from(link: &Path, origin_parent: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if junction::exists(link).unwrap_or(false) {
            let target = junction::get_target(link).ok()?;
            return Some(strip_windows_verbatim_prefix(&target));
        }
    }
    let target = fs::read_link(link).ok()?;
    let target = if target.is_absolute() {
        target
    } else {
        origin_parent.join(target)
    };
    #[cfg(windows)]
    let target = strip_windows_verbatim_prefix(&target);
    Some(target)
}

#[cfg(windows)]
pub(crate) fn strip_windows_verbatim_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path.to_path_buf(),
    }
}

fn isolated_link_declares_any(
    isolated: &Path,
    origin_parent: &Path,
    expected_targets: &[PathBuf],
) -> bool {
    #[cfg(not(windows))]
    {
        let Ok(metadata) = fs::symlink_metadata(isolated) else {
            return false;
        };
        metadata.file_type().is_symlink()
            && declared_link_target_from(isolated, origin_parent)
                .is_some_and(|target| expected_targets.contains(&target))
    }
    #[cfg(windows)]
    {
        let _ = origin_parent;
        expected_targets
            .iter()
            .any(|expected| crate::platform_fs::projection_resource_matches(isolated, expected))
    }
}

fn projection_unlink_root_at(skillhub_root: &Path) -> Result<PathBuf, String> {
    validate_real_directory(skillhub_root, "SkillHub 根目录")?;
    let root = skillhub_root.join(PROJECTION_UNLINK_DIR);
    match fs::create_dir(&root) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    validate_real_directory(&root, "SkillHub 投影移除暂存目录")?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    Ok(root)
}

/// Remove only the link entry itself, never following it into the projection
/// or user content. On Windows `RemoveDirectoryW` deletes a junction entry
/// outright, whereas deleting only its reparse data would leave an empty
/// directory behind.
fn remove_isolated_link_entry(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        if junction::exists(path).unwrap_or(false) {
            return fs::remove_dir(path);
        }
    }
    crate::platform_fs::remove_link(path)
}

/// Atomically move `link` out of its Agent directory under a random name,
/// prove the isolated entry is still an owned SkillHub link, then unlink it.
/// The preferred destination is SkillHub's private staging area, which no
/// Agent scans and which a concurrent writer of the Agent directory cannot
/// reach. When that rename is impossible (staging unavailable, or the Agent
/// directory sits on another volume) the entry is isolated under a random
/// name in the same directory and unlinked immediately after verification,
/// so no Agent-visible quarantine entry survives. A mismatch restores the
/// original entry and never deletes it.
fn isolate_and_unlink_owned_link<F>(
    link: &Path,
    skillhub_root: &Path,
    owned: F,
) -> Result<(), String>
where
    F: Fn(&Path, &Path) -> bool,
{
    let isolated = isolate_owned_link(
        link,
        skillhub_root,
        LEGACY_REMOVE_LINK_PREFIX,
        owned,
        "Agent 投影在移除期间发生变化，已拒绝删除",
        format!("拒绝移除非 SkillHub 符号链接项: {}", link.display()),
    )?;
    remove_isolated_link_entry(&isolated)
        .map_err(|error| format!("Agent 投影已隔离但无法移除 {}: {error}", isolated.display()))
}

/// Isolation step shared by link removal and atomic link replacement: move
/// `link` under a random name into SkillHub's staging area (or, failing that,
/// next to the original with `fallback_prefix`) and verify ownership there.
/// On mismatch the entry is restored and `mismatch_error` returned; on success
/// the caller owns the isolated path and must unlink or restore it.
fn isolate_owned_link<F>(
    link: &Path,
    skillhub_root: &Path,
    fallback_prefix: &str,
    owned: F,
    restore_context: &str,
    mismatch_error: String,
) -> Result<PathBuf, String>
where
    F: Fn(&Path, &Path) -> bool,
{
    let parent = link.parent().ok_or("无法确定 Agent 投影目录")?;
    let staged = projection_unlink_root_at(skillhub_root)
        .ok()
        .map(|staging| staging.join(uuid::Uuid::new_v4().to_string()))
        .filter(|isolated| rename_noreplace(link, isolated).is_ok());
    let isolated = match staged {
        Some(isolated) => isolated,
        None => {
            let isolated = parent.join(format!("{fallback_prefix}{}", uuid::Uuid::new_v4()));
            rename_noreplace(link, &isolated).map_err(|error| error.to_string())?;
            isolated
        }
    };
    if !owned(&isolated, parent) {
        restore_quarantined_path(&isolated, link, restore_context)?;
        return Err(mismatch_error);
    }
    Ok(isolated)
}

fn remove_owned_symlink_atomically(
    link: &Path,
    expected_targets: &[PathBuf],
    skillhub_root: &Path,
) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(link) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.file_type().is_symlink() {
        return Err(format!(
            "拒绝移除非 SkillHub 符号链接项: {}",
            link.display()
        ));
    }
    let parent = link.parent().ok_or("无法确定 Agent 投影目录")?;
    validate_real_directory(parent, "Agent Skill 目录")?;
    isolate_and_unlink_owned_link(link, skillhub_root, |isolated, origin_parent| {
        isolated_link_declares_any(isolated, origin_parent, expected_targets)
    })
}

/// Owned/skipped counts for one kind of legacy leftover.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyLinkCounts {
    pub removed: usize,
    pub skipped: usize,
}

/// Counts from the sweep of legacy leftovers in Agent Skill directories.
/// `removed` / `skipped` cover pre-#165 `.skillhub-remove-link-*` entries and
/// `old_links` covers pre-#272 `.skillhub-old-link-*` entries. `removed`
/// counts proven SkillHub links (removed, or removable in a read-only scan);
/// `skipped` counts every other entry.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyRemoveLinkSweep {
    pub removed: usize,
    pub skipped: usize,
    pub old_links: LegacyLinkCounts,
}

/// Exact ownership proof for a legacy leftover: the entry is a link whose
/// declared target is this SkillHub root's `projections/<skill>/current`.
/// Windows junctions are created against the resolved generation directory,
/// so there a direct child of `projections/<skill>/` is accepted as well.
/// With `accept_managed_skill`, the canonical managed Skill directory
/// `skills/<skill>` is accepted too: a pre-#272 `.skillhub-old-link-*` is the
/// pre-projection link that migration replaced, and it pointed there.
fn legacy_remove_link_is_owned(
    link: &Path,
    origin_parent: &Path,
    skillhub_root: &Path,
    accept_managed_skill: bool,
) -> bool {
    let Ok(metadata) = fs::symlink_metadata(link) else {
        return false;
    };
    if !metadata.file_type().is_symlink() {
        return false;
    }
    let Some(target) = declared_link_target_from(link, origin_parent) else {
        return false;
    };
    #[cfg(not(windows))]
    let skillhub_roots = [skillhub_root.to_path_buf()];
    #[cfg(windows)]
    let skillhub_roots = {
        let mut roots = vec![strip_windows_verbatim_prefix(skillhub_root)];
        if let Ok(canonical) = fs::canonicalize(skillhub_root) {
            roots.push(strip_windows_verbatim_prefix(&canonical));
        }
        roots
    };
    let valid_id =
        |id: &std::ffi::OsStr| id.to_str().is_some_and(|id| validate_skill_id(id).is_ok());
    skillhub_roots.iter().any(|root| {
        let Ok(relative) = target.strip_prefix(root) else {
            return false;
        };
        let components = relative.components().collect::<Vec<_>>();
        match components.as_slice() {
            [Component::Normal(area), Component::Normal(skill_id), Component::Normal(leaf)]
                if *area == "projections" && valid_id(skill_id) =>
            {
                #[cfg(not(windows))]
                {
                    *leaf == "current"
                }
                #[cfg(windows)]
                {
                    !leaf.is_empty()
                }
            }
            [Component::Normal(area), Component::Normal(skill_id)] => {
                accept_managed_skill && *area == "skills" && valid_id(skill_id)
            }
            _ => false,
        }
    })
}

/// Classify (and with `remove`, delete) legacy `.skillhub-remove-link-*`
/// (pre-#165) and `.skillhub-old-link-*` (pre-#272) entries in the given Agent
/// Skill directories. Only links whose exact declared target is one of this
/// SkillHub root's projections (or, for old links, its managed Skill
/// directories) are removed; plain directories, files, foreign links and links
/// into another SkillHub root are skipped and counted. Idempotent.
fn sweep_legacy_remove_links_at(
    home: &Path,
    skillhub_root: &Path,
    agent_dirs: &[&str],
    remove: bool,
) -> LegacyRemoveLinkSweep {
    let mut sweep = LegacyRemoveLinkSweep::default();
    let mut seen = HashSet::new();
    for relative in agent_dirs {
        let directory = home.join(relative);
        if !seen.insert(directory.clone())
            || validate_real_directory(&directory, "Agent Skill 目录").is_err()
        {
            continue;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let accept_managed_skill = if name.starts_with(LEGACY_REMOVE_LINK_PREFIX) {
                false
            } else if name.starts_with(LEGACY_OLD_LINK_PREFIX) {
                true
            } else {
                continue;
            };
            let LegacyRemoveLinkSweep {
                removed,
                skipped,
                old_links,
            } = &mut sweep;
            let (removed, skipped) = if accept_managed_skill {
                (&mut old_links.removed, &mut old_links.skipped)
            } else {
                (removed, skipped)
            };
            let path = entry.path();
            if !legacy_remove_link_is_owned(&path, &directory, skillhub_root, accept_managed_skill)
            {
                *skipped += 1;
                continue;
            }
            if !remove {
                *removed += 1;
                continue;
            }
            // Re-isolate and re-verify the exact target before unlinking so
            // a concurrent replacement is restored, never deleted.
            match isolate_and_unlink_owned_link(&path, skillhub_root, |isolated, origin_parent| {
                legacy_remove_link_is_owned(
                    isolated,
                    origin_parent,
                    skillhub_root,
                    accept_managed_skill,
                )
            }) {
                Ok(()) => *removed += 1,
                Err(_) => *skipped += 1,
            }
        }
    }
    sweep
}

/// Remove (or with `remove == false`, only count) pre-#165 leftovers in every
/// Agent Skill directory SkillHub manages on this platform.
pub(crate) fn sweep_legacy_remove_links_in(home: &Path, remove: bool) -> LegacyRemoveLinkSweep {
    sweep_legacy_remove_links_at(
        home,
        &home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        }),
        &crate::managed_projection_dirs(),
        remove,
    )
}

fn projection_root_at(skillhub_root: &Path, skill_id: &str) -> PathBuf {
    skillhub_root.join("projections").join(skill_id)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

fn declared_symlink_target(link: &Path) -> Option<PathBuf> {
    let target = fs::read_link(link).ok()?;
    Some(if target.is_absolute() {
        target
    } else {
        link.parent()?.join(target)
    })
}

fn validate_real_directory(path: &Path, label: &str) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("无法检查{label}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{label}必须是真实目录，不能是符号链接"));
    }
    Ok(())
}

fn validate_private_projection_directory(path: &Path, label: &str) -> Result<(), String> {
    validate_real_directory(path, label)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.uid() != crate::platform_fs::current_uid() || metadata.mode() & 0o077 != 0 {
        return Err(format!("{label}所有权或权限无效"));
    }
    Ok(())
}

fn read_owned_projection_file(
    path: &Path,
    max_bytes: usize,
    private: bool,
    label: &str,
) -> Result<Vec<u8>, String> {
    let path_metadata =
        fs::symlink_metadata(path).map_err(|error| format!("无法检查{label}: {error}"))?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err(format!("{label}必须是普通文件，不能是符号链接"));
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(crate::platform_fs::NOFOLLOW_FLAG)
        .open(path)
        .map_err(|error| format!("无法安全打开{label}: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法检查{label}: {error}"))?;
    if metadata.dev() != path_metadata.dev()
        || metadata.ino() != path_metadata.ino()
        || metadata.uid() != crate::platform_fs::current_uid()
        || metadata.nlink() != 1
        || metadata.len() > max_bytes as u64
        || metadata.mode() & (if private { 0o077 } else { 0o022 }) != 0
    {
        return Err(format!("{label}所有权、硬链接、权限或大小无效"));
    }
    let mut contents = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut contents)
        .map_err(|error| format!("无法读取{label}: {error}"))?;
    if contents.len() > max_bytes {
        return Err(format!("{label}过大"));
    }
    let final_metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("读取{label}期间路径发生变化: {error}"))?;
    if final_metadata.dev() != metadata.dev() || final_metadata.ino() != metadata.ino() {
        return Err(format!("读取{label}期间路径发生变化，已保留原项"));
    }
    Ok(contents)
}

fn ensure_projection_root_at(skillhub_root: &Path, skill_id: &str) -> Result<PathBuf, String> {
    validate_real_directory(skillhub_root, "SkillHub 根目录")?;
    let projections = skillhub_root.join("projections");
    if !projections.exists() {
        fs::create_dir(&projections).map_err(|error| error.to_string())?;
    }
    validate_real_directory(&projections, "Skill 投影目录")?;
    fs::set_permissions(&projections, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    validate_private_projection_directory(&projections, "Skill 投影目录")?;
    let root = projections.join(skill_id);
    if !root.exists() {
        fs::create_dir(&root).map_err(|error| error.to_string())?;
    }
    validate_real_directory(&root, "当前 Skill 投影目录")?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    validate_private_projection_directory(&root, "当前 Skill 投影目录")?;
    Ok(root)
}

fn valid_generation_name(name: &str) -> bool {
    name.strip_prefix("generation-")
        .and_then(|value| uuid::Uuid::parse_str(value).ok())
        .is_some()
}

fn marker_is_structurally_valid(marker: &ProjectionMarker) -> bool {
    let digest = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    };
    let env_keys_are_valid = marker.env_keys.iter().all(|key| is_valid_env_key(key))
        && marker
            .env_keys
            .windows(2)
            .all(|pair| pair[0].as_str() < pair[1].as_str());
    matches!(
        marker.version,
        LEGACY_PROJECTION_MARKER_VERSION | PROJECTION_MARKER_VERSION
    ) && (marker.version != LEGACY_PROJECTION_MARKER_VERSION
        || marker.header_version == LEGACY_PROJECTION_HEADER_VERSION)
        && matches!(
            marker.header_version,
            LEGACY_PROJECTION_HEADER_VERSION
                | SHELL_EXPORT_PROJECTION_HEADER_VERSION
                | ENV_ONLY_PROJECTION_HEADER_VERSION
                | PROJECTION_HEADER_VERSION
        )
        && (marker.header_version != LEGACY_PROJECTION_HEADER_VERSION
            || (marker.env_keys.is_empty() && !marker.header_separator_injected))
        && env_keys_are_valid
        && valid_generation_name(&marker.generation)
        && validate_skill_id(&marker.skill_id).is_ok()
        && uuid::Uuid::parse_str(&marker.header_token).is_ok()
        && digest(&marker.canonical_skill_md_sha256)
        && digest(&marker.rendered_skill_md_sha256)
}

fn projection_generation_at(
    skillhub_root: &Path,
    managed_root: &Path,
    skill_id: &str,
    generation: &Path,
) -> Option<(ProjectionMarker, PathBuf)> {
    let root = projection_root_at(skillhub_root, skill_id);
    validate_private_projection_directory(&root, "当前 Skill 投影目录").ok()?;
    let generation_name = generation.file_name()?.to_str()?.to_string();
    if generation.parent()? != root || !valid_generation_name(&generation_name) {
        return None;
    }
    validate_private_projection_directory(generation, "Skill 投影 generation").ok()?;
    let marker_bytes = read_owned_projection_file(
        &generation.join(PROJECTION_MARKER_NAME),
        MAX_PROJECTION_MARKER_BYTES,
        true,
        "Skill 投影 marker",
    )
    .ok()?;
    let marker: ProjectionMarker = serde_json::from_slice(&marker_bytes).ok()?;
    let expected_source = fs::canonicalize(managed_root.join(skill_id)).ok()?;
    if !marker_is_structurally_valid(&marker)
        || marker.skill_id != skill_id
        || marker.generation != generation_name
        || Path::new(&marker.source_root) != expected_source
        || fs::canonicalize(&marker.source_root).ok() != Some(expected_source)
    {
        return None;
    }
    Some((marker, generation.to_path_buf()))
}

fn current_projection_at(
    skillhub_root: &Path,
    managed_root: &Path,
    skill_id: &str,
) -> Option<(ProjectionMarker, PathBuf)> {
    let root = projection_root_at(skillhub_root, skill_id);
    validate_real_directory(skillhub_root, "SkillHub 根目录").ok()?;
    validate_real_directory(&skillhub_root.join("projections"), "Skill 投影目录").ok()?;
    validate_real_directory(&root, "当前 Skill 投影目录").ok()?;
    let current = root.join("current");
    #[cfg(not(windows))]
    {
        let current_metadata = fs::symlink_metadata(&current).ok()?;
        if !current_metadata.file_type().is_symlink() {
            return None;
        }
        let declared = declared_symlink_target(&current)?;
        let generation_name = declared.file_name()?.to_str()?.to_string();
        if declared.parent()? != root || !valid_generation_name(&generation_name) {
            return None;
        }
        let generation = fs::canonicalize(&current).ok()?;
        if generation.parent()? != fs::canonicalize(&root).ok()? {
            return None;
        }
        projection_generation_at(
            skillhub_root,
            managed_root,
            skill_id,
            &root.join(generation_name),
        )
    }
    #[cfg(windows)]
    {
        if !junction::exists(&current).ok()? {
            return None;
        }
        let generation = fs::canonicalize(&current).ok()?;
        if generation.parent()? != fs::canonicalize(&root).ok()? {
            return None;
        }
        let generation_name = generation.file_name()?.to_str()?.to_string();
        if !valid_generation_name(&generation_name) {
            return None;
        }
        projection_generation_at(
            skillhub_root,
            managed_root,
            skill_id,
            &root.join(generation_name),
        )
    }
}

fn projection_marker_for_link_at(
    link: &Path,
    skillhub_root: &Path,
    managed_root: &Path,
) -> Option<(ProjectionMarker, PathBuf)> {
    if !fs::symlink_metadata(link).ok()?.file_type().is_symlink() {
        return None;
    }
    let target = declared_symlink_target(link)?;
    let projections = skillhub_root.join("projections");
    let skill_id = target
        .strip_prefix(&projections)
        .ok()?
        .components()
        .next()?
        .as_os_str()
        .to_str()?;
    let expected_current = projection_root_at(skillhub_root, skill_id).join("current");
    // Ownership is based on the exact declared target, not on a marker that a
    // native user Skill could forge in an unrelated directory.
    if target != expected_current {
        return None;
    }
    current_projection_at(skillhub_root, managed_root, skill_id)
}

fn projection_marker_for_link(link: &Path) -> Option<(ProjectionMarker, PathBuf)> {
    projection_marker_for_link_at(link, &skillhub_dir(), &skills_dir())
}

fn projection_generation_is_coordinated(marker: &ProjectionMarker, generation: &Path) -> bool {
    read_owned_projection_file(
        &generation.join("SKILL.md"),
        MAX_SKILL_FILE_BYTES as usize,
        false,
        "Agent 投影 SKILL.md",
    )
    .ok()
    .is_some_and(|contents| sha256_hex(&contents) == marker.rendered_skill_md_sha256)
}

fn legacy_runtime_header(skill_id: &str, token: &str, eol: &str) -> String {
    [
        format!("<!-- SKILLHUB-RUNTIME-START v1 {token} {skill_id} -->"),
        "## SkillHub 环境变量".into(),
        String::new(),
        "此 Skill 的脚本需要由 SkillHub 提供环境变量。执行脚本前，请在当前 Shell 中运行：".into(),
        String::new(),
        "```sh".into(),
        "if command -v skillhub >/dev/null 2>&1; then".into(),
        format!("  eval \"$(skillhub run {skill_id} -- env)\""),
        "else".into(),
        format!("  eval \"$(\"$HOME/.local/bin/skillhub\" run {skill_id} -- env)\""),
        "fi".into(),
        "```".into(),
        String::new(),
        "环境变量加载完成后，再继续执行本 Skill 的操作。".into(),
        format!("<!-- SKILLHUB-RUNTIME-END v1 {token} {skill_id} -->"),
        String::new(),
        String::new(),
    ]
    .join(eol)
}

fn runtime_header_v2(skill_id: &str, token: &str, eol: &str, env_keys: &[String]) -> String {
    let unset = env_keys.join(" ");
    [
        format!("<!-- SKILLHUB-RUNTIME-START v2 {token} {skill_id} -->"),
        "## SkillHub 环境变量".into(),
        String::new(),
        "此 Skill 需要 SkillHub 环境变量。每次执行实际 Skill 命令时，必须把加载步骤与实际命令放在同一次 Shell / 同一次 Agent 工具调用中，并使用 `&&` 连接；不得拆成两次调用。".into(),
        String::new(),
        "只允许调用下方 SkillHub 私有运行入口；不要调用 PATH 中其他同名 `skillhub` 程序。".into(),
        String::new(),
        "```sh".into(),
        format!("unset _skillhub_env {unset} &&"),
        format!(
            "_skillhub_env=\"$(\"$HOME/.skillhub/runtime/bin/yitan-skillhub-runtime\" run {skill_id} -- env)\" &&"
        ),
        "eval \"$_skillhub_env\" &&".into(),
        "unset _skillhub_env &&".into(),
        "# 下一行直接写入你实际要执行的 Skill 命令；不要另开一次 Shell。".into(),
        "```".into(),
        String::new(),
        "如果加载失败，命令链必须保持非零退出状态并立即停止；不得继续使用当前 Shell 中残留的旧值。".into(),
        format!("<!-- SKILLHUB-RUNTIME-END v2 {token} {skill_id} -->"),
        String::new(),
        String::new(),
    ]
    .join(eol)
}

/// v3: injected only for Skills that declared environment dependencies. Kept
/// verbatim so untampered v3 projections can be recognised and migrated.
fn runtime_header_v3(skill_id: &str, token: &str, eol: &str, _env_keys: &[String]) -> String {
    [
        format!("<!-- SKILLHUB-RUNTIME-START v3 {token} {skill_id} -->"),
        "## SkillHub 安全运行环境".into(),
        String::new(),
        "此 Skill 需要 SkillHub 环境变量。执行实际 Skill 命令时，把目标可执行程序及其参数直接放在下方 `--` 后，并保持在同一次 Agent 工具调用中。SkillHub 只把值注入该子进程，不会输出 Shell export。".into(),
        String::new(),
        "按当前平台只使用下方对应的 SkillHub 固定运行入口；不要调用 PATH 中其他同名 `skillhub` 程序，不要执行 `env`、`printenv` 或其他环境枚举命令。".into(),
        String::new(),
        "macOS / POSIX Shell：".into(),
        String::new(),
        "```sh".into(),
        format!(
            "\"$HOME/.skillhub/runtime/bin/yitan-skillhub-runtime\" run {skill_id} -- <program> [args...]"
        ),
        "```".into(),
        String::new(),
        "Windows PowerShell：".into(),
        String::new(),
        "```powershell".into(),
        format!(
            r#"& "$env:USERPROFILE\.skillhub\runtime\bin\skillhub.cmd" run {skill_id} -- <program> [args...]"#
        ),
        "```".into(),
        String::new(),
        "目标进程启动失败或账号变化时立即停止；不得改用已废弃的环境导出模式或自行读取 SkillHub 私有配置。".into(),
        format!("<!-- SKILLHUB-RUNTIME-END v3 {token} {skill_id} -->"),
        String::new(),
        String::new(),
    ]
    .join(eol)
}

/// v4: injected for every managed (non-system) Skill, whether or not it
/// declares environment dependencies, so an Agent always launches through the
/// SkillHub runtime entry and can register a newly discovered key.
fn runtime_header(skill_id: &str, token: &str, eol: &str, _env_keys: &[String]) -> String {
    [
        format!("<!-- SKILLHUB-RUNTIME-START v4 {token} {skill_id} -->"),
        "## SkillHub 运行入口".into(),
        String::new(),
        "本 Skill 通过 SkillHub 运行入口启动；它需要的钥匙（环境变量）由 SkillHub 注入。执行实际 Skill 命令时，把目标可执行程序及其参数直接放在下方 `--` 后，并保持在同一次 Agent 工具调用中。SkillHub 只把值注入该子进程，不会输出 Shell export。".into(),
        String::new(),
        "按当前平台只使用下方对应的 SkillHub 固定运行入口；不要调用 PATH 中其他同名 `skillhub` 程序，不要执行 `env`、`printenv` 或其他环境枚举命令。".into(),
        String::new(),
        "macOS / POSIX Shell：".into(),
        String::new(),
        "```sh".into(),
        format!(
            "\"$HOME/.skillhub/runtime/bin/yitan-skillhub-runtime\" run {skill_id} -- <program> [args...]"
        ),
        "```".into(),
        String::new(),
        "Windows PowerShell：".into(),
        String::new(),
        "```powershell".into(),
        format!(
            r#"& "$env:USERPROFILE\.skillhub\runtime\bin\skillhub.cmd" run {skill_id} -- <program> [args...]"#
        ),
        "```".into(),
        String::new(),
        format!(
            "如果程序因缺少某个环境变量而失败：用同一运行入口执行 `env request --skill-id {skill_id} --key <KEY> --json` 登记需求，告诉用户在 SkillHub APP 中确认并填写，用户确认后再重试。不要读取 `.env`、不要枚举环境，也不要向用户索取值。"
        ),
        String::new(),
        "目标进程启动失败或账号变化时立即停止；不得改用已废弃的环境导出模式或自行读取 SkillHub 私有配置。".into(),
        format!("<!-- SKILLHUB-RUNTIME-END v4 {token} {skill_id} -->"),
        String::new(),
        String::new(),
    ]
    .join(eol)
}

fn runtime_header_for_version(
    skill_id: &str,
    token: &str,
    eol: &str,
    env_keys: &[String],
    header_version: u8,
) -> Result<String, String> {
    match header_version {
        LEGACY_PROJECTION_HEADER_VERSION => Ok(legacy_runtime_header(skill_id, token, eol)),
        SHELL_EXPORT_PROJECTION_HEADER_VERSION => {
            Ok(runtime_header_v2(skill_id, token, eol, env_keys))
        }
        ENV_ONLY_PROJECTION_HEADER_VERSION => Ok(runtime_header_v3(skill_id, token, eol, env_keys)),
        PROJECTION_HEADER_VERSION => Ok(runtime_header(skill_id, token, eol, env_keys)),
        _ => Err("SkillHub Agent 投影运行协议版本无效".into()),
    }
}

fn frontmatter_insertion(source: &str) -> Option<(usize, &'static str)> {
    let bom_len = if source.starts_with('\u{feff}') {
        '\u{feff}'.len_utf8()
    } else {
        0
    };
    let rest = &source[bom_len..];
    let eol = if rest.starts_with("---\r\n") {
        "\r\n"
    } else if rest.starts_with("---\n") {
        "\n"
    } else {
        return None;
    };
    let mut offset = bom_len;
    for (index, segment) in source[bom_len..].split_inclusive(eol).enumerate() {
        offset += segment.len();
        if index > 0 && segment.trim_end_matches(['\r', '\n']) == "---" {
            return Some((offset, eol));
        }
    }
    None
}

fn generated_skill_md_with_header(
    source: &str,
    skill_id: &str,
    token: &str,
    has_env: bool,
    header_version: u8,
    env_keys: &[String],
) -> String {
    if !has_env {
        return source.to_string();
    }
    let (offset, eol) = frontmatter_insertion(source).unwrap_or((
        0,
        if source.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        },
    ));
    let header = runtime_header_for_version(skill_id, token, eol, env_keys, header_version)
        .expect("validated projection header version");
    let separator = if header_version != LEGACY_PROJECTION_HEADER_VERSION
        && offset > 0
        && !source[..offset].ends_with(eol)
    {
        eol
    } else {
        ""
    };
    format!(
        "{}{}{}{}",
        &source[..offset],
        separator,
        header,
        &source[offset..]
    )
}

fn projection_header_separator_is_injected(
    source: &str,
    has_env: bool,
    header_version: u8,
) -> bool {
    if !has_env || header_version == LEGACY_PROJECTION_HEADER_VERSION {
        return false;
    }
    frontmatter_insertion(source)
        .is_some_and(|(offset, eol)| offset > 0 && !source[..offset].ends_with(eol))
}

fn generated_skill_md_with_token(
    source: &str,
    skill_id: &str,
    token: &str,
    has_env: bool,
    env_keys: &[String],
) -> String {
    generated_skill_md_with_header(
        source,
        skill_id,
        token,
        has_env,
        PROJECTION_HEADER_VERSION,
        env_keys,
    )
}

#[cfg(all(test, unix))]
fn generated_skill_md(source: &str, skill_id: &str, has_env: bool) -> String {
    let env_keys = if has_env {
        vec!["API_KEY".to_string()]
    } else {
        Vec::new()
    };
    generated_skill_md_with_token(
        source,
        skill_id,
        "00000000-0000-4000-8000-000000000000",
        has_env,
        &env_keys,
    )
}

fn read_profile_at_root(managed_root: &Path, skill_id: &str) -> Result<SkillHubProfile, String> {
    let path = managed_root.join(skill_id).join(".skillhub.json");
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("Skill Profile 不能是符号链接".into());
    }
    let contents =
        fs::read_to_string(path).map_err(|error| format!("无法读取 Skill Profile: {error}"))?;
    let json: SkillHubJson = serde_json::from_str(&contents)
        .map_err(|error| format!("Skill Profile JSON 已损坏: {error}"))?;
    let mut profile = json.skillhub.unwrap_or_default();
    normalize_profile_initial_version(&mut profile);
    normalize_profile_acquisition_source(&mut profile);
    Ok(profile)
}

fn write_projection_conflict(root: &Path, reason: &str) {
    let payload = serde_json::json!({
        "version": 1,
        "reason": reason,
        "detectedAtUnixMs": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or_default(),
    });
    let _ = write_private_file(
        &root.join(PROJECTION_CONFLICT_NAME),
        &serde_json::to_string(&payload).unwrap_or_default(),
    );
}

fn clear_projection_conflict(root: &Path) {
    let path = root.join(PROJECTION_CONFLICT_NAME);
    if fs::symlink_metadata(&path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    {
        let _ = fs::remove_file(path);
    }
}

fn replace_canonical_skill_md_preserving_base(
    path: &Path,
    expected: &[u8],
    contents: &[u8],
    projection_root: &Path,
) -> Result<(), String> {
    if contents.len() > MAX_SKILL_FILE_BYTES as usize || contents.contains(&0) {
        return Err("投影中的 SKILL.md 过大或包含 NUL，拒绝回写".into());
    }
    let current = read_owned_projection_file(
        path,
        MAX_SKILL_FILE_BYTES as usize,
        false,
        "canonical SKILL.md",
    )?;
    if current != expected {
        return Err("canonical SKILL.md 在回写前发生变化；已保留双方并阻止覆盖".into());
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    let parent = path.parent().ok_or("无法确定 SKILL.md 目录")?;
    validate_real_directory(parent, "canonical Skill 目录")?;
    let recovery_root = projection_root.join("recovery");
    if recovery_root.exists() {
        validate_private_projection_directory(&recovery_root, "Skill 投影恢复目录")?;
    } else {
        fs::create_dir(&recovery_root).map_err(|error| error.to_string())?;
        fs::set_permissions(&recovery_root, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    let recovery = recovery_root.join(format!("canonical-{}.md", uuid::Uuid::new_v4()));
    let temporary = parent.join(format!(".SKILL.md.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(metadata.permissions().mode() & 0o777)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(contents)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;

        // Move the exact inode out of the canonical path before installing the
        // candidate. If an editor replaced or modified it after our first read,
        // the moved copy is retained and the candidate is never allowed to
        // overwrite that newer path.
        rename_noreplace(path, &recovery).map_err(|error| error.to_string())?;
        let moved = read_owned_projection_file(
            &recovery,
            MAX_SKILL_FILE_BYTES as usize,
            false,
            "canonical SKILL.md recovery",
        )?;
        if moved != expected {
            let restored = rename_noreplace(&recovery, path);
            return Err(match restored {
                Ok(()) => "canonical SKILL.md 在原子切换期间发生变化；已恢复并保留投影编辑"
                    .to_string(),
                Err(error) => format!(
                    "canonical SKILL.md 在原子切换期间发生变化；并发文件已保留在 {}，恢复失败: {error}",
                    recovery.display()
                ),
            });
        }
        if let Err(error) = rename_noreplace(&temporary, path) {
            let restored = rename_noreplace(&recovery, path);
            return Err(match restored {
                Ok(()) => format!("canonical SKILL.md 路径被并发占用；已恢复原内容: {error}"),
                Err(restore_error) => format!(
                    "canonical SKILL.md 路径被并发占用；原内容保留在 {}，恢复失败: {restore_error}",
                    recovery.display()
                ),
            });
        }
        if let Ok(directory) = fs::File::open(parent) {
            directory.sync_all().map_err(|error| error.to_string())?;
        }
        if let Ok(directory) = fs::File::open(&recovery_root) {
            directory.sync_all().map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn projection_resources_match(marker: &ProjectionMarker, generation: &Path) -> bool {
    let entries = fs::read_dir(generation)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            !matches!(
                entry.file_name().to_str(),
                Some("SKILL.md" | PROJECTION_MARKER_NAME)
            )
        })
        .collect::<Vec<_>>();
    let actual = entries
        .iter()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .collect::<BTreeSet<_>>();
    let expected = marker
        .resource_names
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if actual != expected || entries.len() != marker.resource_names.len() {
        return false;
    }
    entries.into_iter().all(|entry| {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            return false;
        };
        crate::platform_fs::projection_resource_matches(
            &entry.path(),
            &Path::new(&marker.source_root).join(name),
        )
    })
}

fn reconcile_projection_generation_at(
    managed_root: &Path,
    skill_id: &str,
    root: &Path,
    mut marker: ProjectionMarker,
    generation: &Path,
) -> Result<(), String> {
    if !projection_resources_match(&marker, generation) {
        let reason = format!(
            "Agent 投影 generation {} 的根目录结构已被修改；请恢复新增、删除或改名的顶层项",
            marker.generation
        );
        write_projection_conflict(root, &reason);
        return Err(reason);
    }
    let projected_path = generation.join("SKILL.md");
    let projected = read_owned_projection_file(
        &projected_path,
        MAX_SKILL_FILE_BYTES as usize,
        false,
        "Agent 投影 SKILL.md",
    )?;
    if sha256_hex(&projected) == marker.rendered_skill_md_sha256 {
        return Ok(());
    }
    if projected.len() > MAX_SKILL_FILE_BYTES as usize || projected.contains(&0) {
        let reason = "Agent 投影 SKILL.md 不安全，已保留并阻止刷新";
        write_projection_conflict(root, reason);
        return Err(reason.into());
    }
    let projected_text = std::str::from_utf8(&projected)
        .map_err(|_| "Agent 投影 SKILL.md 不是有效 UTF-8，已保留并阻止刷新".to_string())?;
    let canonical_path = managed_root.join(skill_id).join("SKILL.md");
    let canonical = read_owned_projection_file(
        &canonical_path,
        MAX_SKILL_FILE_BYTES as usize,
        false,
        "canonical SKILL.md",
    )?;
    let candidate = if marker.header_injected {
        let canonical_text = std::str::from_utf8(&canonical)
            .map_err(|_| "canonical SKILL.md 不是有效 UTF-8".to_string())?;
        let eol = frontmatter_insertion(canonical_text)
            .map(|(_, eol)| eol)
            .unwrap_or(if canonical_text.contains("\r\n") {
                "\r\n"
            } else {
                "\n"
            });
        let header = runtime_header_for_version(
            skill_id,
            &marker.header_token,
            eol,
            &marker.env_keys,
            marker.header_version,
        )?;
        if projected_text.matches(&header).count() != 1 {
            let reason = "SkillHub 环境变量提示块已被修改、删除或复制；已保留双方并阻止刷新";
            write_projection_conflict(root, reason);
            return Err(reason.into());
        }
        let header_position = projected_text
            .find(&header)
            .ok_or("无法定位 SkillHub 环境变量提示块")?;
        let expected_position = frontmatter_insertion(projected_text)
            .map(|(offset, _)| offset)
            .unwrap_or(0);
        if header_position != expected_position {
            let reason = "SkillHub 环境变量提示块位置已改变；已保留双方并阻止刷新";
            write_projection_conflict(root, reason);
            return Err(reason.into());
        }
        let injected_header = if marker.header_separator_injected {
            format!("{eol}{header}")
        } else {
            header
        };
        if projected_text.matches(&injected_header).count() != 1 {
            let reason = "SkillHub 环境变量提示块已被修改、删除或复制；已保留双方并阻止刷新";
            write_projection_conflict(root, reason);
            return Err(reason.into());
        }
        let stripped = projected_text.replacen(&injected_header, "", 1);
        stripped.into_bytes()
    } else {
        projected.clone()
    };
    let canonical_hash = sha256_hex(&canonical);
    let candidate_hash = sha256_hex(&candidate);
    if canonical_hash != marker.canonical_skill_md_sha256 && canonical_hash != candidate_hash {
        let reason = "canonical 与 Agent 投影中的 SKILL.md 同时发生不同修改；已保留双方并阻止刷新";
        write_projection_conflict(root, reason);
        return Err(reason.into());
    }
    if canonical_hash != candidate_hash {
        if let Err(error) = replace_canonical_skill_md_preserving_base(
            &canonical_path,
            &canonical,
            &candidate,
            root,
        ) {
            let reason = format!("{error}；Agent 投影仍保留在 {}", generation.display());
            write_projection_conflict(root, &reason);
            return Err(reason);
        }
    }
    marker.canonical_skill_md_sha256 = candidate_hash;
    marker.rendered_skill_md_sha256 = sha256_hex(&projected);
    write_private_file(
        &generation.join(PROJECTION_MARKER_NAME),
        &serde_json::to_string(&marker).map_err(|error| error.to_string())?,
    )?;
    Ok(())
}

fn reconcile_skill_projection_at(
    skillhub_root: &Path,
    managed_root: &Path,
    skill_id: &str,
) -> Result<(), String> {
    let root = projection_root_at(skillhub_root, skill_id);
    let current_path = root.join("current");
    let Some((current_marker, current_generation)) =
        current_projection_at(skillhub_root, managed_root, skill_id)
    else {
        if fs::symlink_metadata(&current_path).is_ok() {
            if root.exists()
                && fs::symlink_metadata(&root)
                    .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
            {
                let reason =
                    "Skill 投影身份、权限、硬链接或 current 链接无效；已保留原项并阻止刷新";
                write_projection_conflict(&root, reason);
                return Err(reason.into());
            }
            return Err("Skill 投影目录不安全；已阻止刷新".into());
        }
        return Ok(());
    };

    let current_name = current_marker.generation.clone();
    reconcile_projection_generation_at(
        managed_root,
        skill_id,
        &root,
        current_marker,
        &current_generation,
    )?;

    let mut retired = fs::read_dir(&root)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name != current_name && valid_generation_name(&name)
        })
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    retired.sort();
    for generation in retired {
        let Some((marker, generation)) =
            projection_generation_at(skillhub_root, managed_root, skill_id, &generation)
        else {
            let reason = format!(
                "旧 Agent 投影 generation {} 的身份、权限或硬链接无效；已保留并阻止刷新",
                generation.display()
            );
            write_projection_conflict(&root, &reason);
            return Err(reason);
        };
        reconcile_projection_generation_at(managed_root, skill_id, &root, marker, &generation)?;
    }
    clear_projection_conflict(&root);
    Ok(())
}

pub(crate) fn canonical_resource_names(source: &Path) -> Result<Vec<String>, String> {
    let mut names = fs::read_dir(source)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| !path_contains_local_env_values(source, &entry.path()))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .filter(|name| {
            !matches!(
                name.as_str(),
                "SKILL.md" | ".skillhub.json" | ".git" | ".DS_Store"
            )
        })
        .collect::<Vec<_>>();
    names.sort();
    Ok(names)
}

fn path_contains_local_env_values(root: &Path, path: &Path) -> bool {
    WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .any(|entry| {
            entry.file_type().is_file()
                && entry
                    .path()
                    .strip_prefix(root)
                    .is_ok_and(is_local_env_value_path)
        })
}

fn remove_projection_root_at(skillhub_root: &Path, skill_id: &str) -> Result<(), String> {
    validate_real_directory(skillhub_root, "SkillHub 根目录")?;
    let projections = skillhub_root.join("projections");
    if !projections.exists() {
        return Ok(());
    }
    validate_real_directory(&projections, "Skill 投影目录")?;
    let root = projection_root_at(skillhub_root, skill_id);
    if !root.exists() {
        return Ok(());
    }
    validate_real_directory(&root, "当前 Skill 投影目录")?;
    fs::remove_dir_all(root).map_err(|error| error.to_string())
}

fn refresh_skill_projection_at(
    skillhub_root: &Path,
    managed_root: &Path,
    skill_id: &str,
) -> Result<PathBuf, String> {
    validate_skill_id(skill_id)?;
    let source = managed_root.join(skill_id);
    // Validate the complete canonical tree before exposing any resource to an
    // Agent projection. This also rejects embedded symlinks.
    collect_skill_tree(&source)?;
    reconcile_skill_projection_at(skillhub_root, managed_root, skill_id)?;
    let profile = read_profile_at_root(managed_root, skill_id)?;
    let canonical_skill_md = read_owned_projection_file(
        &source.join("SKILL.md"),
        MAX_SKILL_FILE_BYTES as usize,
        false,
        "canonical SKILL.md",
    )?;
    let canonical_skill_md = String::from_utf8(canonical_skill_md)
        .map_err(|_| "canonical SKILL.md 不是有效 UTF-8".to_string())?;
    let canonical_source = fs::canonicalize(&source).map_err(|error| error.to_string())?;
    let root = ensure_projection_root_at(skillhub_root, skill_id)?;
    let mut env_keys = profile
        .env_dependencies
        .iter()
        .map(|dependency| dependency.key.clone())
        .collect::<Vec<_>>();
    if env_keys.iter().any(|key| !is_valid_env_key(key)) {
        return Err("Skill Profile 包含无效环境变量名，已阻止生成 Agent 投影".into());
    }
    env_keys.sort();
    env_keys.dedup();
    // Every managed Skill launches through the SkillHub runtime entry, even
    // without declared dependencies; only the protected Manager is exempt.
    let has_env = projection_injects_runtime_header(skill_id, &profile);
    let resource_names = canonical_resource_names(&source)?;
    let existing = current_projection_at(skillhub_root, managed_root, skill_id);
    if let Some((marker, generation)) = &existing {
        if marker.canonical_skill_md_sha256 == sha256_hex(canonical_skill_md.as_bytes())
            && marker.header_injected == has_env
            && marker.header_version == PROJECTION_HEADER_VERSION
            && marker.env_keys == env_keys
            && marker.resource_names == resource_names
            && projection_generation_is_coordinated(marker, generation)
        {
            return Ok(root.join("current"));
        }
    }
    let expected_current_target = existing
        .as_ref()
        .map(|(marker, _)| root.join(&marker.generation));
    let generation_name = format!("generation-{}", uuid::Uuid::new_v4());
    let generation = root.join(&generation_name);
    fs::create_dir(&generation).map_err(|error| error.to_string())?;
    fs::set_permissions(&generation, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;

    let create_result = (|| -> Result<(), String> {
        let header_token = uuid::Uuid::new_v4().to_string();
        let rendered = generated_skill_md_with_token(
            &canonical_skill_md,
            skill_id,
            &header_token,
            has_env,
            &env_keys,
        );
        let header_separator_injected = projection_header_separator_is_injected(
            &canonical_skill_md,
            has_env,
            PROJECTION_HEADER_VERSION,
        );
        let mut projected_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(generation.join("SKILL.md"))
            .map_err(|error| error.to_string())?;
        projected_file
            .write_all(rendered.as_bytes())
            .map_err(|error| error.to_string())?;
        projected_file
            .sync_all()
            .map_err(|error| error.to_string())?;
        for name in &resource_names {
            unix_fs::symlink(canonical_source.join(name), generation.join(name))
                .map_err(|error| error.to_string())?;
        }
        let marker = ProjectionMarker {
            version: PROJECTION_MARKER_VERSION,
            skill_id: skill_id.to_string(),
            source_root: canonical_source.to_string_lossy().to_string(),
            generation: generation_name.clone(),
            canonical_skill_md_sha256: sha256_hex(canonical_skill_md.as_bytes()),
            rendered_skill_md_sha256: sha256_hex(rendered.as_bytes()),
            header_version: PROJECTION_HEADER_VERSION,
            header_token,
            header_injected: has_env,
            header_separator_injected,
            env_keys: env_keys.clone(),
            resource_names: resource_names.clone(),
        };
        write_private_file(
            &generation.join(PROJECTION_MARKER_NAME),
            &serde_json::to_string(&marker).map_err(|error| error.to_string())?,
        )?;
        let temporary_current = root.join(format!(".current-{}", uuid::Uuid::new_v4()));
        unix_fs::symlink(&generation_name, &temporary_current)
            .map_err(|error| error.to_string())?;
        let current = root.join("current");
        let switch_result = install_prepared_symlink_atomically(
            &temporary_current,
            &current,
            expected_current_target.as_deref(),
            skillhub_root,
        );
        if let Err(error) = switch_result {
            let _ = crate::platform_fs::remove_link(&temporary_current);
            return Err(format!("无法原子切换 Skill 投影 current: {error}"));
        }
        if let Ok(directory) = fs::File::open(&root) {
            directory.sync_all().map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    if let Err(error) = create_result {
        let _ = fs::remove_dir_all(&generation);
        return Err(error);
    }
    clear_projection_conflict(&root);
    Ok(root.join("current"))
}

fn refresh_skill_projection(skill_id: &str) -> Result<PathBuf, String> {
    refresh_skill_projection_at(&skillhub_dir(), &skills_dir(), skill_id)
}

fn projection_injects_runtime_header(skill_id: &str, profile: &SkillHubProfile) -> bool {
    crate::official_channel::CHANNEL != "dev" && !profile.is_system && !is_system_skill_id(skill_id)
}

pub(crate) const RUNTIME_REQUEST_ORIGIN: &str = "runtime_request";

/// `skillhub env request`: records that an Agent found the Skill needs `key`
/// at run time. Only metadata is written (`required`, `origin`, `pending`);
/// no value is read or written. Idempotent: an already declared key is left
/// untouched and reported with `Ok(true)`. The projection is refreshed either
/// way so the Agent sees the current declaration immediately.
pub(crate) fn request_runtime_env_dependency_at(
    skillhub_root: &Path,
    managed_root: &Path,
    skill_id: &str,
    key: &str,
    description: &str,
) -> Result<bool, String> {
    validate_skill_id(skill_id)?;
    if !is_valid_env_key(key) {
        return Err("环境变量名无效".into());
    }
    if is_system_skill_id(skill_id) {
        return Err("SkillHub Manager 是受保护的系统 Skill，不能登记环境变量需求".into());
    }
    let root = managed_root.join(skill_id);
    validate_real_directory(&root, "SkillHub 托管 Skill 目录")?;
    let _lock = crate::skill_lock::lock_skill_dir_at(skillhub_root, skill_id)?;
    reconcile_skill_projection_at(skillhub_root, managed_root, skill_id)?;
    let profile_path = root.join(".skillhub.json");
    if !fs::symlink_metadata(&profile_path).is_ok_and(|metadata| metadata.is_file()) {
        return Err("SkillHub 中找不到该本地 Skill 的 Profile".into());
    }
    let mut profile = read_current_profile_at_path(&root)?;
    if profile.is_system {
        return Err("SkillHub Manager 是受保护的系统 Skill，不能登记环境变量需求".into());
    }
    let already_declared = profile
        .env_dependencies
        .iter()
        .any(|dependency| dependency.key == key);
    if !already_declared {
        if profile.env_dependencies.len() >= 100 {
            return Err("该 Skill 的环境变量依赖已达上限".into());
        }
        profile.env_dependencies.push(EnvDepRaw {
            key: key.to_string(),
            description: Some(description.to_string()),
            required: true,
            share_policy: "none".into(),
            shared_teams: Vec::new(),
            origin: Some(RUNTIME_REQUEST_ORIGIN.into()),
            confidence: None,
            obtain: None,
            pending: Some(true),
        });
        write_profile_at_path(&root, &profile).map_err(|error| error.to_string())?;
    }
    refresh_skill_projection_at(skillhub_root, managed_root, skill_id)?;
    Ok(already_declared)
}

/// Live-root wrapper for the CLI; also moves any Agent link that still points
/// at the canonical directory onto the generated projection.
pub(crate) fn request_runtime_env_dependency(
    skill_id: &str,
    key: &str,
    description: &str,
) -> Result<bool, String> {
    let already_declared = request_runtime_env_dependency_at(
        &skillhub_dir(),
        &skills_dir(),
        skill_id,
        key,
        description,
    )?;
    let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
    let projection_name = skill_projection_name(skill_id)?;
    let canonical = skill_path(skill_id);
    let generated = projection_root_at(&skillhub_dir(), skill_id).join("current");
    for (_, _, relative) in crate::known_agents() {
        let link = home.join(relative).join(&projection_name);
        migrate_agent_projection_link(&link, &canonical, &generated, &skillhub_dir())?;
    }
    Ok(already_declared)
}

/// Switch an Agent link that still points at the canonical managed Skill
/// (`skills/<id>`) to the generated projection. The replaced link is verified
/// against its exact declared target and unlinked, never retained in the
/// Agent directory (#272).
fn migrate_agent_projection_link(
    link: &Path,
    canonical_source: &Path,
    generated_source: &Path,
    skillhub_root: &Path,
) -> Result<(), String> {
    if is_symlink_to_path(link, generated_source) {
        return Ok(());
    }
    if !is_symlink_to_path(link, canonical_source) {
        return Ok(());
    }
    let expected_declared_target =
        declared_symlink_target(link).ok_or("无法读取待迁移 Agent 投影")?;
    let parent = link.parent().ok_or("无法确定 Agent 投影目录")?;
    let temporary = parent.join(format!(".skillhub-link-{}", uuid::Uuid::new_v4()));
    unix_fs::symlink(generated_source, &temporary).map_err(|error| error.to_string())?;
    if let Err(error) = install_prepared_symlink_atomically(
        &temporary,
        link,
        Some(&expected_declared_target),
        skillhub_root,
    ) {
        let _ = crate::platform_fs::remove_link(&temporary);
        return Err(error);
    }
    Ok(())
}

fn retire_legacy_agent_projection_links_at(
    home: &Path,
    skillhub_root: &Path,
    managed_root: &Path,
    skill_id: &str,
    projection_name: &str,
    legacy_directories: &[&str],
) -> Result<(), String> {
    let canonical = managed_root.join(skill_id);
    let projection_current = projection_root_at(skillhub_root, skill_id).join("current");
    let mut errors = Vec::new();
    for relative in legacy_directories {
        let link = home.join(relative).join(projection_name);
        let metadata = match fs::symlink_metadata(&link) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                errors.push(format!("{}: {error}", link.display()));
                continue;
            }
        };
        // A native directory or an unrelated symlink is user-owned. Retirement
        // only removes a v0.10 projection whose target proves SkillHub ownership.
        if !metadata.file_type().is_symlink() {
            continue;
        }
        let declared = declared_symlink_target(&link);
        if !matches!(
            managed_skill_agent_projection_state_at(&link, skillhub_root, managed_root, skill_id,),
            Ok(ManagedSkillAgentProjectionState::Installed)
        ) {
            continue;
        }
        let mut expected_targets = vec![canonical.clone(), projection_current.clone()];
        if let Some(target) = declared {
            expected_targets.push(target);
        }
        if let Err(error) = remove_owned_symlink_atomically(&link, &expected_targets, skillhub_root)
        {
            errors.push(format!("{}: {error}", link.display()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "无法安全移除旧版通用 Agent 投影：{}",
            errors.join("；")
        ))
    }
}

fn interrupted_marketplace_skill_ids_at(skillhub_root: &Path) -> HashSet<String> {
    let trash_root = skillhub_root.join("trash");
    fs::read_dir(&trash_root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let directory = entry.path();
            let metadata = fs::symlink_metadata(&directory).ok()?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return None;
            }
            let manifest =
                read_recovery_manifest(&directory.join("recovery-manifest.json")).ok()?;
            if manifest.get("status").and_then(serde_json::Value::as_str) != Some("in_progress")
                || manifest.get("reason").and_then(serde_json::Value::as_str)
                    != Some("marketplace_version_replacement")
                || !fs::symlink_metadata(directory.join("skill"))
                    .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
            {
                return None;
            }
            let skill_id = manifest
                .get("skillId")
                .and_then(serde_json::Value::as_str)?;
            validate_skill_id(skill_id).ok()?;
            Some(skill_id.to_string())
        })
        .collect()
}

pub fn discover_interrupted_marketplace_replacements() -> Result<usize, String> {
    let root = skillhub_dir();
    if !root.exists() {
        return Ok(0);
    }
    validate_real_directory(&root, "SkillHub 根目录")?;
    Ok(interrupted_marketplace_skill_ids_at(&root).len())
}

fn refresh_installed_projections_at(
    home: &Path,
    skillhub_root: &Path,
    managed_root: &Path,
) -> Result<(), String> {
    // Builds before #165 retained removed projections as Agent-visible
    // `.skillhub-remove-link-*` entries, and builds before #272 retained
    // migrated links as `.skillhub-old-link-*`. Remove only proven SkillHub links;
    // the sweep is idempotent and skips everything else.
    sweep_legacy_remove_links_at(home, skillhub_root, &crate::managed_projection_dirs(), true);
    let Ok(entries) = fs::read_dir(managed_root) else {
        return Ok(());
    };
    let interrupted_marketplace = interrupted_marketplace_skill_ids_at(skillhub_root);
    let mut errors = Vec::new();
    for entry in entries.flatten() {
        let skill_id = entry.file_name().to_string_lossy().to_string();
        if validate_skill_id(&skill_id).is_err() {
            continue;
        }
        if interrupted_marketplace.contains(&skill_id) {
            continue;
        }
        if let Ok(profile) = library_read_profile_readonly(&entry.path()) {
            if crate::spaces::require_profile_at(skillhub_root, &profile).is_err() {
                continue;
            }
        }
        let projection_name = match projection_name_at_root(managed_root, &skill_id) {
            Ok(name) => name,
            Err(error) => {
                if let Ok(root) = ensure_projection_root_at(skillhub_root, &skill_id) {
                    write_projection_conflict(&root, &error);
                }
                errors.push(format!("{skill_id}: {error}"));
                continue;
            }
        };
        let canonical = managed_root.join(&skill_id);
        if let Err(error) = retire_legacy_agent_projection_links_at(
            home,
            skillhub_root,
            managed_root,
            &skill_id,
            &projection_name,
            &crate::legacy_managed_projection_dirs(),
        ) {
            errors.push(format!("{skill_id}: {error}"));
        }
        let links = crate::known_agents()
            .into_iter()
            .map(|(_, _, relative)| home.join(relative).join(&projection_name))
            .filter(|link| {
                is_symlink_to_path(link, &canonical)
                    || projection_marker_for_link_at(link, skillhub_root, managed_root)
                        .is_some_and(|(marker, _)| marker.skill_id == skill_id)
            })
            .collect::<Vec<_>>();
        if links.is_empty() {
            continue;
        }
        let generated = match refresh_skill_projection_at(skillhub_root, managed_root, &skill_id) {
            Ok(path) => path,
            Err(error) => {
                if let Ok(root) = ensure_projection_root_at(skillhub_root, &skill_id) {
                    write_projection_conflict(&root, &error);
                }
                errors.push(format!("{skill_id}: {error}"));
                continue;
            }
        };
        for link in links {
            if let Err(error) =
                migrate_agent_projection_link(&link, &canonical, &generated, skillhub_root)
            {
                if let Ok(root) = ensure_projection_root_at(skillhub_root, &skill_id) {
                    write_projection_conflict(&root, &error);
                }
                errors.push(format!("{}: {error}", link.display()));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

pub fn refresh_installed_projections() -> Result<(), String> {
    let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
    refresh_installed_projections_at(&home, &skillhub_dir(), &skills_dir())
}

fn projection_name_from_profile(
    skill_id: &str,
    profile: &SkillHubProfile,
) -> Result<String, String> {
    let projection_name = profile
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(skill_id)
        .to_string();
    validate_skill_id(&projection_name)
        .map_err(|_| "Skill Profile 中的 Agent 投影名不安全，请修复 name 字段".to_string())?;
    Ok(projection_name)
}

fn skill_projection_name(skill_id: &str) -> Result<String, String> {
    projection_name_from_profile(skill_id, &read_profile_result(skill_id)?)
}

fn projection_name_at_root(managed_root: &Path, skill_id: &str) -> Result<String, String> {
    let path = managed_root.join(skill_id).join(".skillhub.json");
    if !path.exists() {
        return Ok(skill_id.to_string());
    }
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("Skill Profile 不能是符号链接".into());
    }
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("无法读取 Skill Profile: {error}"))?;
    let json: SkillHubJson = serde_json::from_str(&contents)
        .map_err(|error| format!("Skill Profile JSON 已损坏: {error}"))?;
    projection_name_from_profile(skill_id, &json.skillhub.unwrap_or_default())
}

fn is_managed_projection_with_name(link: &Path, projection_name: &str) -> bool {
    if let Some((marker, _)) = projection_marker_for_link(link) {
        return skill_projection_name(&marker.skill_id).is_ok_and(|name| name == projection_name)
            && fs::canonicalize(marker.source_root).ok()
                == fs::canonicalize(skill_path(&marker.skill_id)).ok();
    }
    let Ok(target) = fs::canonicalize(link) else {
        return false;
    };
    let managed_root = fs::canonicalize(skills_dir()).unwrap_or_else(|_| skills_dir());
    if target.parent() != Some(managed_root.as_path()) {
        return false;
    }
    let Some(skill_id) = target.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    is_symlink_to_path(link, &target)
        && skill_projection_name(skill_id).is_ok_and(|name| name == projection_name)
}

pub(crate) fn should_skip(relative: &Path) -> bool {
    is_generated_path(relative) || is_local_env_value_path(relative)
}

fn is_generated_path(relative: &Path) -> bool {
    relative.components().any(|component| {
        let Component::Normal(name) = component else {
            return false;
        };
        let name = name.to_string_lossy().to_ascii_lowercase();
        matches!(
            name.as_str(),
            ".git" | "node_modules" | "target" | "dist" | "build" | "__pycache__" | ".ds_store"
        )
    })
}

pub(crate) fn is_local_env_value_path(relative: &Path) -> bool {
    let Some(name) = relative.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    name == ".env"
        || name == ".envrc"
        || (name.starts_with(".env.")
            && !matches!(
                name.as_str(),
                ".env.example" | ".env.sample" | ".env.template"
            ))
}

fn normalized_relative_path(relative: &Path) -> Result<String, String> {
    let normalized = relative
        .components()
        .map(|component| match component {
            Component::Normal(value) => value
                .to_str()
                .filter(|part| !part.contains('/') && !part.contains('\\'))
                .map(str::to_string)
                .ok_or_else(|| format!("Skill 包含无法规范化的路径: {}", relative.display())),
            _ => Err(format!("Skill 包含不安全路径: {}", relative.display())),
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("/");
    if normalized.is_empty() {
        return Err("Skill 包含空文件路径".into());
    }
    Ok(normalized)
}

const MAX_SKILL_TREE_DEPTH: usize = 10;
pub(crate) const MAX_SKILL_FILE_COUNT: usize = 2_000;
pub(crate) const MAX_SKILL_FILE_BYTES: u64 = 20 * 1024 * 1024;
pub(crate) const MAX_SKILL_TOTAL_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug)]
struct SkillTreeEntry {
    normalized: String,
    path: PathBuf,
    relative: PathBuf,
    is_directory: bool,
    size: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillTreeViewEntry {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub depth: usize,
}

fn validate_skill_relative_path(relative: &Path) -> Result<String, String> {
    validate_skill_relative_path_with_depth(relative, MAX_SKILL_TREE_DEPTH)
}

fn validate_skill_relative_path_with_depth(
    relative: &Path,
    max_depth: usize,
) -> Result<String, String> {
    let normalized = normalized_relative_path(relative)?;
    let depth = relative.components().count();
    if depth > max_depth {
        return Err(format!(
            "Skill 路径层级超过 {max_depth} 层: {}",
            relative.display()
        ));
    }
    Ok(normalized)
}

fn validate_archive_entry_path(
    relative: &Path,
    max_depth: usize,
) -> Result<Option<String>, String> {
    if relative == Path::new(".skillhub.json") || is_generated_path(relative) {
        return Ok(None);
    }
    if is_local_env_value_path(relative) {
        if relative.components().count() > max_depth {
            return Err(format!(
                "Skill 路径层级超过 {max_depth} 层: {}",
                relative.display()
            ));
        }
        return Ok(Some(normalized_relative_path(relative)?));
    }
    validate_skill_relative_path_with_depth(relative, max_depth).map(Some)
}

fn collect_skill_tree(root: &Path) -> Result<Vec<SkillTreeEntry>, String> {
    let root_metadata = fs::symlink_metadata(root).map_err(|error| error.to_string())?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("Skill 根目录必须是真实目录，不能是符号链接".into());
    }

    let mut entries = Vec::new();
    let mut file_count = 0_usize;
    let mut total_bytes = 0_u64;
    for entry in WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.path().strip_prefix(root).map_or(true, |relative| {
                !is_generated_path(relative) || !entry.file_type().is_dir()
            })
        })
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|error| error.to_string())?;
        let file_type = entry.file_type();
        if file_type.is_symlink() {
            return Err(format!(
                "Skill 文件夹不能包含符号链接: {}",
                relative.display()
            ));
        }
        if !file_type.is_dir() && !file_type.is_file() {
            return Err(format!(
                "Skill 包含不支持的文件类型（仅允许普通文件和目录）: {}",
                relative.display()
            ));
        }
        if is_generated_path(relative) {
            continue;
        }
        // SkillHub owns this root sidecar and regenerates it for the imported
        // asset. Generated/VCS directories are pruned by the walker above.
        if relative == Path::new(".skillhub.json") {
            continue;
        }
        // Real environment files are captured into SkillHub's private env
        // store and never copied into the managed tree, Git history,
        // projections, or upload packages.
        if file_type.is_file() && is_local_env_value_path(relative) {
            if relative.components().count() > MAX_SKILL_TREE_DEPTH {
                return Err(format!(
                    "Skill 路径层级超过 {MAX_SKILL_TREE_DEPTH} 层: {}",
                    relative.display()
                ));
            }
            continue;
        }
        let normalized = validate_skill_relative_path(relative)?;
        let size = if file_type.is_file() {
            file_count = file_count.saturating_add(1);
            if file_count > MAX_SKILL_FILE_COUNT {
                return Err(format!("Skill 文件数量超过 {MAX_SKILL_FILE_COUNT}"));
            }
            let size = entry.metadata().map_err(|error| error.to_string())?.len();
            if size > MAX_SKILL_FILE_BYTES {
                return Err(format!("Skill 单个文件超过 20 MB: {}", relative.display()));
            }
            total_bytes = total_bytes.saturating_add(size);
            if total_bytes > MAX_SKILL_TOTAL_BYTES {
                return Err("Skill 文件总量超过 100 MB".into());
            }
            size
        } else {
            0
        };
        entries.push(SkillTreeEntry {
            normalized,
            path: entry.path().to_path_buf(),
            relative: relative.to_path_buf(),
            is_directory: file_type.is_dir(),
            size,
        });
    }
    entries.sort_by(|left, right| left.normalized.cmp(&right.normalized));
    if entries
        .windows(2)
        .any(|pair| pair[0].normalized == pair[1].normalized)
    {
        return Err("Skill 包含规范化后重名的文件路径".into());
    }
    Ok(entries)
}

#[tauri::command]
pub async fn get_skill_tree(skill_id: String) -> Result<Vec<SkillTreeViewEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || get_skill_tree_blocking(skill_id))
        .await
        .map_err(|error| format!("Skill 文件树读取异常结束: {error}"))?
}

pub fn get_skill_tree_blocking(skill_id: String) -> Result<Vec<SkillTreeViewEntry>, String> {
    note_read_command_thread();
    validate_skill_id(&skill_id)?;
    collect_skill_tree(&skill_path(&skill_id))?
        .into_iter()
        .map(|entry| {
            let name = entry
                .relative
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "Skill 文件名不是有效 UTF-8".to_string())?
                .to_string();
            Ok(SkillTreeViewEntry {
                path: entry.normalized,
                name,
                kind: if entry.is_directory {
                    "directory"
                } else {
                    "file"
                }
                .into(),
                depth: entry.relative.components().count().saturating_sub(1),
            })
        })
        .collect()
}

fn skill_tree_fingerprint(root: &Path) -> Result<Vec<u8>, String> {
    let mut digest = Sha256::new();
    for entry in collect_skill_tree(root)? {
        digest.update(if entry.is_directory { *b"d" } else { *b"f" });
        digest.update((entry.normalized.len() as u64).to_be_bytes());
        digest.update(entry.normalized.as_bytes());
        if !entry.is_directory {
            digest.update(entry.size.to_be_bytes());
            let mut file = fs::File::open(&entry.path).map_err(|error| error.to_string())?;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
                if count == 0 {
                    break;
                }
                digest.update(&buffer[..count]);
            }
        }
    }
    Ok(digest.finalize().to_vec())
}

const MAX_ZIP_FILE_BYTES: u64 = MAX_SKILL_FILE_BYTES;
const MAX_ZIP_TOTAL_BYTES: u64 = MAX_SKILL_TOTAL_BYTES;

fn copy_bounded_zip_entry<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    total_written: &mut u64,
    entry_name: &Path,
) -> Result<(), String> {
    let remaining_total = MAX_ZIP_TOTAL_BYTES.saturating_sub(*total_written);
    let permitted = MAX_ZIP_FILE_BYTES.min(remaining_total);
    let actual = std::io::copy(&mut reader.take(permitted.saturating_add(1)), writer)
        .map_err(|error| error.to_string())?;
    if actual > MAX_ZIP_FILE_BYTES {
        return Err(format!("ZIP 单个文件超过 20 MB: {}", entry_name.display()));
    }
    if actual > remaining_total {
        return Err("ZIP 解压后超过 100 MB".into());
    }
    *total_written = (*total_written).saturating_add(actual);
    Ok(())
}

const PRIVATE_GIT_EXCLUDE_MARKER: &str = "# SkillHub private/runtime files";
const PRIVATE_GIT_EXCLUDE_RULES: &[&str] = &[
    ".skillhub.json",
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.jks",
    "*.keystore",
    "credentials",
    "credentials.json",
    "token.json",
    "auth.json",
    "service-account.json",
    "service_account.json",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".ssh/",
    ".aws/",
    ".gnupg/",
    "node_modules/",
    "target/",
    "dist/",
    "build/",
];

fn ensure_git_excludes(repo_path: &Path) -> Result<()> {
    let exclude_path = repo_path.join(".git/info/exclude");
    if let Some(parent) = exclude_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let current = fs::read_to_string(&exclude_path).unwrap_or_default();
    let existing = current
        .lines()
        .map(str::trim)
        .collect::<std::collections::HashSet<_>>();
    let marker_exists = existing.contains(PRIVATE_GIT_EXCLUDE_MARKER);
    let mut additions = Vec::new();
    if !marker_exists {
        additions.push(PRIVATE_GIT_EXCLUDE_MARKER);
    }
    additions.extend(
        PRIVATE_GIT_EXCLUDE_RULES
            .iter()
            .copied()
            .filter(|rule| !existing.contains(rule)),
    );
    if !additions.is_empty() {
        let mut updated = current;
        if !updated.is_empty() && !updated.ends_with('\n') {
            updated.push('\n');
        }
        if !updated.is_empty() && !marker_exists {
            updated.push('\n');
        }
        for addition in additions {
            updated.push_str(addition);
            updated.push('\n');
        }
        fs::write(exclude_path, updated)?;
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn is_valid_env_key(key: &str) -> bool {
    if key.is_empty() || key.len() > 100 {
        return false;
    }
    let mut characters = key.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_uppercase())
        && characters.all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
}

fn parse_env_assignment(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    let assignment = if let Some(rest) = trimmed.strip_prefix("export") {
        if rest
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_whitespace())
        {
            rest.trim_start()
        } else {
            trimmed
        }
    } else {
        trimmed
    };
    let (key, value) = assignment.split_once('=')?;
    let key = key.trim();
    if !is_valid_env_key(key) {
        return None;
    }
    Some((key.to_string(), value.trim().to_string()))
}

pub(crate) fn decode_stored_env_value(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.starts_with('\'') {
        if !trimmed.ends_with('\'') || trimmed.len() < 2 {
            return Err("本机环境变量文件包含无效的单引号值".into());
        }
        return Ok(trimmed[1..trimmed.len() - 1].replace("'\\''", "'"));
    }
    if trimmed.starts_with('"') {
        if !trimmed.ends_with('"') || trimmed.len() < 2 {
            return Err("本机环境变量文件包含无效的双引号值".into());
        }
        return Ok(trimmed[1..trimmed.len() - 1].to_string());
    }
    Ok(trimmed.to_string())
}

pub(crate) fn parse_env_entries(contents: &str) -> Result<BTreeMap<String, String>, String> {
    let mut entries = BTreeMap::new();
    for (index, line) in contents.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (key, value) = parse_env_assignment(line)
            .ok_or_else(|| format!("本机环境变量文件第 {} 行格式无效", index.saturating_add(1)))?;
        decode_stored_env_value(&value)?;
        if entries.insert(key.clone(), value).is_some() {
            return Err(format!("本机环境变量文件包含重复变量: {key}"));
        }
    }
    Ok(entries)
}

fn env_contents_has_key(contents: &str, key: &str) -> bool {
    parse_env_entries(contents)
        .ok()
        .is_some_and(|entries| entries.contains_key(key))
}

pub(crate) fn read_env_file_for_update(path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法检查环境变量文件: {error}")),
    }
    let bytes = read_owned_projection_file(path, 8 * 1024 * 1024, true, "环境变量文件")?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "环境变量文件不是 UTF-8 文本，已保留原内容".into())
}

pub(crate) fn update_env_file_contents(
    contents: &str,
    key: &str,
    replacement: Option<&str>,
) -> Result<String, String> {
    parse_env_entries(contents)?;
    let mut output = String::with_capacity(contents.len().saturating_add(128));
    let mut found = false;
    for raw_line in contents.split_inclusive('\n') {
        let without_lf = raw_line.strip_suffix('\n').unwrap_or(raw_line);
        let line = without_lf.strip_suffix('\r').unwrap_or(without_lf);
        let line_ending = if raw_line.ends_with("\r\n") {
            "\r\n"
        } else if raw_line.ends_with('\n') {
            "\n"
        } else {
            ""
        };
        if parse_env_assignment(line).is_some_and(|(existing, _)| existing == key) {
            found = true;
            if let Some(value) = replacement {
                output.push_str(&format!("export {key}={}", shell_quote(value)));
                output.push_str(line_ending);
            }
        } else {
            output.push_str(raw_line);
        }
    }
    if !found {
        if let Some(value) = replacement {
            if !output.is_empty() && !output.ends_with('\n') {
                output.push('\n');
            }
            output.push_str(&format!("export {key}={}\n", shell_quote(value)));
        }
    }
    Ok(output)
}

fn set_env_value_in_file(path: &Path, key: &str, value: &str) -> Result<(), String> {
    let contents = read_env_file_for_update(path)?.unwrap_or_default();
    let updated = update_env_file_contents(&contents, key, Some(value))?;
    write_private_file(path, &updated)
}

fn skill_env_value_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut env_files = Vec::new();
    for entry in WalkDir::new(root)
        .min_depth(1)
        .max_depth(MAX_SKILL_TREE_DEPTH)
        .follow_links(false)
    {
        let entry = entry.map_err(|error| format!("无法扫描 Skill 环境变量文件: {error}"))?;
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|error| error.to_string())?;
        if !is_local_env_value_path(relative) {
            continue;
        }
        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            return Err(format!(
                "Skill 环境变量必须是普通文件，不能是符号链接: {}",
                relative.display()
            ));
        }
        env_files.push(entry.path().to_path_buf());
    }
    env_files.sort_by(|left, right| {
        let priority = |path: &Path| match path.file_name().and_then(|name| name.to_str()) {
            Some(".env") => 0,
            Some(".env.local") => 2,
            _ => 1,
        };
        priority(left)
            .cmp(&priority(right))
            .then_with(|| left.cmp(right))
    });
    Ok(env_files)
}

fn discover_skill_env_values(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let env_files = skill_env_value_files(root)?;

    let mut values = BTreeMap::new();
    for path in env_files {
        let bytes =
            read_owned_projection_file(&path, 8 * 1024 * 1024, false, "Skill 环境变量文件")?;
        let contents = String::from_utf8(bytes)
            .map_err(|_| format!("环境变量文件不是 UTF-8 文本: {}", path.display()))?;
        for (key, raw_value) in parse_env_entries(&contents)? {
            let value = decode_stored_env_value(&raw_value)?;
            if value.is_empty()
                || value.len() > 16_384
                || value.contains('\0')
                || value.contains('\n')
            {
                return Err(format!(
                    "{key} 的环境变量值为空、过长或包含换行，已拒绝自动保存"
                ));
            }
            values.insert(key, value);
        }
    }
    Ok(values)
}

fn archive_captured_skill_env_files(root: &Path, skill_id: &str) -> Result<(), String> {
    archive_captured_skill_env_files_at(root, skill_id, &skillhub_dir().join("env-import-backups"))
}

fn archive_captured_skill_env_files_at(
    root: &Path,
    skill_id: &str,
    backup_root: &Path,
) -> Result<(), String> {
    let env_files = skill_env_value_files(root)?;
    if env_files.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(backup_root).map_err(|error| error.to_string())?;
    fs::set_permissions(backup_root, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let transaction = backup_root.join(format!("{skill_id}-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&transaction).map_err(|error| error.to_string())?;
    fs::set_permissions(&transaction, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for source in env_files {
        let relative = source
            .strip_prefix(root)
            .map_err(|error| error.to_string())?;
        let destination = transaction.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
        }
        if let Err(error) = rename_noreplace(&source, &destination) {
            for (archived, original) in moved.into_iter().rev() {
                let _ = rename_noreplace(&archived, &original);
            }
            let _ = fs::remove_dir_all(&transaction);
            return Err(format!("环境变量已保存，但原文件备份失败: {error}"));
        }
        moved.push((destination, source));
    }
    Ok(())
}

fn persist_skill_env_values(
    skill_id: &str,
    values: &BTreeMap<String, String>,
    account_user_id: Option<&str>,
) -> Result<(), String> {
    if values.is_empty() {
        return Ok(());
    }
    let runtime_user_id = crate::runtime_env::resolve_active_runtime_user(account_user_id)?;
    persist_skill_env_values_at(&envs_dir(), &runtime_user_id, skill_id, values)
}

/// Stores env values for an explicit runtime identity. The caller proves that
/// identity (e.g. by holding its session lease); nothing is re-read here.
fn persist_skill_env_values_at(
    env_root: &Path,
    runtime_user_id: &str,
    skill_id: &str,
    values: &BTreeMap<String, String>,
) -> Result<(), String> {
    if values.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(env_root).map_err(|error| error.to_string())?;
    fs::set_permissions(env_root, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let env_path = crate::runtime_env::account_env_path_under(env_root, runtime_user_id, skill_id)?;
    let account_root = env_path.parent().ok_or("无法确定账号环境变量目录")?;
    fs::create_dir_all(account_root).map_err(|error| error.to_string())?;
    fs::set_permissions(account_root, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    for (key, value) in values {
        set_env_value_in_file(&env_path, key, value)?;
    }
    Ok(())
}

fn merge_profile_env_dependencies(
    profile: &mut SkillHubProfile,
    keys: impl IntoIterator<Item = String>,
) {
    let mut existing = profile
        .env_dependencies
        .drain(..)
        .map(|dependency| (dependency.key.clone(), dependency))
        .collect::<BTreeMap<_, _>>();
    // 本机 `.env` 里的名字也只收钥匙（#287）；配置项的值仍转存到个人配置，但不进依赖清单。
    for key in keys.into_iter().filter(|key| {
        crate::env_detect::is_candidate_key(key) && crate::env_detect::is_secret_key_name(key)
    }) {
        existing.entry(key.clone()).or_insert(EnvDepRaw {
            key,
            description: Some(crate::env_detect::LOCAL_ENV_DESCRIPTION.into()),
            required: true,
            share_policy: "none".into(),
            shared_teams: vec![],
            origin: Some(crate::env_detect::ORIGIN_DETECTED.into()),
            confidence: Some(crate::env_detect::EnvConfidence::High.as_str().into()),
            obtain: None,
            pending: None,
        });
    }
    profile.env_dependencies = existing.into_values().collect();
}

/// 导入目录自带的 `.skillhub.json` 只沿用 `envDependencies`（#251，保留 origin）：
/// 其余字段属于原机器的账号与云端状态，从不沿用；读不出或格式不对时视为没有。
fn source_sidecar_env_dependencies(source_root: &Path) -> Vec<EnvDepRaw> {
    let path = source_root.join(".skillhub.json");
    if !fs::symlink_metadata(&path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= 1024 * 1024)
    {
        return Vec::new();
    }
    let Some(items) = fs::read_to_string(&path)
        .ok()
        .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok())
        .and_then(|value| {
            value
                .get("skillhub")?
                .get("envDependencies")?
                .as_array()
                .cloned()
        })
    else {
        return Vec::new();
    };
    let mut seen = BTreeSet::new();
    items
        .into_iter()
        .filter_map(|item| serde_json::from_value::<EnvDepRaw>(item).ok())
        .filter(|dependency| {
            is_valid_env_key(&dependency.key) && seen.insert(dependency.key.clone())
        })
        .take(crate::skill_document::MAX_ENV_DECLARATIONS)
        .map(|dependency| EnvDepRaw {
            description: dependency
                .description
                .map(|value| {
                    value
                        .trim()
                        .chars()
                        .take(crate::skill_document::MAX_ENV_DESCRIPTION_CHARS)
                        .collect::<String>()
                })
                .filter(|value| !value.is_empty()),
            share_policy: "none".into(),
            shared_teams: Vec::new(),
            obtain: dependency.obtain.filter(|value| {
                value.starts_with("https://") && !value.contains(char::is_whitespace)
            }),
            ..dependency
        })
        .collect()
}

/// SKILL.md 声明（#251）；声明无效时返回明确错误，不静默丢弃。
fn skill_md_env_declarations(
    content: &str,
) -> Result<Vec<crate::skill_document::EnvDeclaration>, String> {
    crate::skill_document::parse_skill_document(content).env_declarations()
}

/// 商店 / 团队安装与账号同步落地前读取包内声明；包由 Server 校验过，读不出时
/// 不阻断安装，只是不标注声明来源。
fn staged_env_declarations(stage: &Path) -> Vec<crate::skill_document::EnvDeclaration> {
    fs::read_to_string(stage.join("SKILL.md"))
        .ok()
        .and_then(|content| skill_md_env_declarations(&content).ok())
        .unwrap_or_default()
}

pub(crate) fn merge_missing_env_values_from_file(
    source: &Path,
    destination: &Path,
) -> Result<(), String> {
    let source_contents =
        read_env_file_for_update(source)?.ok_or_else(|| "游客环境变量文件已不存在".to_string())?;
    let source_entries = parse_env_entries(&source_contents)?;
    let Some(destination_contents) = read_env_file_for_update(destination)? else {
        return write_private_file(destination, &source_contents);
    };
    let destination_entries = parse_env_entries(&destination_contents)?;
    let mut updated = destination_contents;
    let mut changed = false;

    for (key, raw_value) in source_entries {
        if destination_entries.contains_key(&key) {
            continue;
        }
        let mut value = decode_stored_env_value(&raw_value)?;
        let update_result = update_env_file_contents(&updated, &key, Some(&value));
        value.zeroize();
        updated = update_result?;
        changed = true;
    }

    if changed {
        write_private_file(destination, &updated)?;
    }
    Ok(())
}

fn delete_env_value_from_file(path: &Path, key: &str) -> Result<(), String> {
    let Some(contents) = read_env_file_for_update(path)? else {
        return Ok(());
    };
    let updated = update_env_file_contents(&contents, key, None)?;
    write_private_file(path, &updated)
}

fn parse_skill_document(
    skill_name: &str,
    content: &str,
) -> (String, Option<String>, Option<String>, Vec<String>, String) {
    let document = crate::skill_document::parse_skill_document(content);
    let display_name = document
        .display_name()
        .or_else(|| crate::skill_document::first_heading(document.body))
        .map(str::to_string);
    let description = document
        .text("description")
        .map(str::to_string)
        .or_else(|| {
            crate::skill_document::first_paragraph_line(document.body)
                .map(|line| line.chars().take(240).collect())
        });
    let labels = document
        .list("labels")
        .or_else(|| document.list("tags"))
        .unwrap_or_default()
        .into_iter()
        .take(8)
        .collect();
    (
        display_name.unwrap_or_else(|| skill_name.to_string()),
        description,
        document.text("category").map(str::to_string),
        labels,
        document
            .text("version")
            .map(normalize_initial_version)
            .unwrap_or_else(|| INITIAL_SKILL_VERSION.into()),
    )
}

// ── Tauri Commands ────────────────────────────────────────────────────────────

/// List all skills in ~/.skillhub/skills/.
///
/// The read walks every managed Skill's Git history, projections and sidecar,
/// so it runs on a blocking worker instead of the Tauri IPC main thread. Lock
/// order, session leases, maintenance semantics and the DTO are those of
/// `get_local_skills_blocking`, which the CLI keeps calling directly.
#[tauri::command]
pub async fn get_local_skills() -> Result<Vec<LocalSkill>, String> {
    tauri::async_runtime::spawn_blocking(get_local_skills_blocking)
        .await
        .map_err(|error| format!("本地 Skill 列表读取异常结束: {error}"))
}

/// Thread on which the most recent offloaded read core started. Tests use it to
/// pin that the product commands (not just Tauri's `spawn_blocking`) run their
/// blocking core away from the thread that awaited them.
#[cfg(test)]
pub(crate) static LAST_READ_COMMAND_THREAD: std::sync::Mutex<Option<std::thread::ThreadId>> =
    std::sync::Mutex::new(None);

/// Held by every test that reads `LAST_READ_COMMAND_THREAD`: the observer is a
/// single process-wide slot, so those tests must not interleave.
#[cfg(test)]
pub(crate) static READ_THREAD_OBSERVATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[inline]
fn note_read_command_thread() {
    #[cfg(test)]
    {
        *LAST_READ_COMMAND_THREAD.lock().unwrap() = Some(std::thread::current().id());
    }
}

/// One managed Skill, read exactly as the list reads it (maintenance, then
/// build from the validated history view), so an Agent toggle or a single edit
/// refreshes only the affected Skill instead of every Skill. `None` when the
/// managed directory does not exist. Runs on a blocking worker.
#[tauri::command]
pub async fn get_local_skill(skill_id: String) -> Result<Option<LocalSkill>, String> {
    tauri::async_runtime::spawn_blocking(move || get_local_skill_blocking(skill_id))
        .await
        .map_err(|error| format!("本地 Skill 读取异常结束: {error}"))?
}

pub fn get_local_skill_blocking(skill_id: String) -> Result<Option<LocalSkill>, String> {
    note_read_command_thread();
    validate_skill_id(&skill_id)?;
    let root = skill_path(&skill_id);
    if !fs::symlink_metadata(&root).is_ok_and(|metadata| metadata.is_dir()) {
        return Ok(None);
    }
    let (problem, maintained) =
        match maintain_list_skill_version_at(&skillhub_dir(), &skills_dir(), &skill_id) {
            Ok(view) => (None, view),
            Err(problem) => (Some(problem), None),
        };
    let mut skill = build_local_skill_with(&skill_id, maintained);
    skill.version_problem = problem;
    Ok(Some(skill))
}

pub fn get_local_skills_blocking() -> Vec<LocalSkill> {
    note_read_command_thread();
    let _ = repair_system_manager();
    let dir = skills_dir();
    if !dir.exists() {
        return vec![];
    }
    let mut skills: Vec<LocalSkill> = fs::read_dir(&dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let skill_id = entry.file_name().to_string_lossy().to_string();
            if skill_id.starts_with('.') {
                return None;
            }
            // Agent-side SKILL.md edits are reconciled into the canonical Git
            // working copy before its dirty/hash state is calculated. A
            // protected-header or concurrent-edit conflict remains untouched;
            // strict projection verification below reports the install as broken.
            let (problem, maintained) =
                match maintain_list_skill_version_at(&skillhub_dir(), &skills_dir(), &skill_id) {
                    Ok(view) => (None, view),
                    Err(problem) => (Some(problem), None),
                };
            let mut skill = build_local_skill_with(&skill_id, maintained);
            skill.version_problem = problem;
            Some(skill)
        })
        .collect();
    skills.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    skills
}

/// A list refresh never waits for a download or another Skill writer. Busy
/// entries retain their read-only view and are maintained on a later refresh.
///
/// On success it returns the normalized history it just validated (and wrote
/// to the sidecar if anything changed), so the list builder can reuse it
/// instead of walking the same history again; `None` means maintenance was
/// skipped (system Skill or busy) and the builder reads on its own.
fn maintain_list_skill_version_at(
    skillhub_root: &Path,
    managed_root: &Path,
    skill_id: &str,
) -> Result<Option<crate::version_policy::NormalizedView>, String> {
    if is_system_skill_id(skill_id) {
        return Ok(None);
    }
    let Some(_lock) = crate::skill_lock::try_lock_skill_dir_at(skillhub_root, skill_id)? else {
        return Ok(None);
    };
    let path = managed_root.join(skill_id);
    let mut profile = library_read_profile_readonly(&path)?;
    if profile.is_system {
        return Ok(None);
    }
    let _lease = version_session_lease_at(skillhub_root, &profile)?;
    reconcile_skill_projection_at(skillhub_root, managed_root, skill_id)?;
    profile = library_read_profile_readonly(&path)?;
    if working_copy_state_for_path(&path).0 && promote_profile_to_personal(&mut profile) {
        write_profile_at_path(&path, &profile).map_err(|error| error.to_string())?;
    }
    // Keep ownership changes and any reconciled sidecar metadata authoritative.
    profile = library_read_profile_readonly(&path)?;
    ensure_current_local_version_at(&path, &mut profile)?;
    Ok(Some(crate::version_policy::NormalizedView {
        metadata: profile.version_metadata,
        head: crate::version_policy::head(&path),
    }))
}

#[cfg(test)]
mod list_version_maintenance_tests {
    use super::*;

    #[test]
    fn busy_list_maintenance_returns_without_waiting_or_writing_the_skill() {
        let home =
            std::env::temp_dir().join(format!("skillhub-list-busy-{}", uuid::Uuid::new_v4()));
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = skillhub_root.join("skills");
        let path = managed_root.join("demo");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("SKILL.md"), "# saved fixture\n").unwrap();
        library_write_profile(&path, &SkillHubProfile::default()).unwrap();
        library_snapshot_at(&path, "自由操作说明").unwrap();
        let sidecar = fs::read(path.join(".skillhub.json")).unwrap();
        let head = crate::version_policy::head(&path);
        let lock = crate::skill_lock::lock_skill_dir_at(&skillhub_root, "demo").unwrap();
        let started = std::time::Instant::now();
        assert_eq!(
            maintain_list_skill_version_at(&skillhub_root, &managed_root, "demo").unwrap(),
            None
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert_eq!(fs::read(path.join(".skillhub.json")).unwrap(), sidecar);
        assert_eq!(crate::version_policy::head(&path), head);
        assert_eq!(
            fs::read_to_string(path.join("SKILL.md")).unwrap(),
            "# saved fixture\n"
        );
        assert!(!skillhub_root.join("version-metadata-backups").exists());
        drop(lock);
        fs::remove_dir_all(home).unwrap();
    }

    fn mtime(path: &Path) -> std::time::SystemTime {
        fs::metadata(path).unwrap().modified().unwrap()
    }

    #[test]
    fn maintenance_returns_the_validated_view_and_an_unchanged_refresh_writes_nothing() {
        let home =
            std::env::temp_dir().join(format!("skillhub-list-view-{}", uuid::Uuid::new_v4()));
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = skillhub_root.join("skills");
        let path = managed_root.join("demo");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("SKILL.md"), "# saved fixture\n").unwrap();
        library_write_profile(&path, &SkillHubProfile::default()).unwrap();
        for revision in 0..3 {
            fs::write(
                path.join("SKILL.md"),
                format!("# saved fixture {revision}\n"),
            )
            .unwrap();
            library_snapshot_at(&path, &format!("v0.1.{revision} · revision {revision}")).unwrap();
        }
        // First refresh: migration may number the history and write the sidecar.
        let first = maintain_list_skill_version_at(&skillhub_root, &managed_root, "demo")
            .unwrap()
            .expect("maintenance ran");
        let on_disk = read_profile_at_path(&path).unwrap();
        assert_eq!(
            first.metadata, on_disk.version_metadata,
            "view equals the sidecar it wrote"
        );
        assert_eq!(first.head, crate::version_policy::head(&path));
        assert!(first
            .metadata
            .commits
            .contains_key(first.head.as_deref().unwrap()));
        let sidecar = path.join(".skillhub.json");
        let bytes = fs::read(&sidecar).unwrap();
        let modified = mtime(&sidecar);
        let head = crate::version_policy::head(&path);
        std::thread::sleep(std::time::Duration::from_millis(20));
        // Second refresh with nothing changed: same view, zero writes.
        let second = maintain_list_skill_version_at(&skillhub_root, &managed_root, "demo")
            .unwrap()
            .expect("maintenance ran");
        assert_eq!(second, first);
        assert_eq!(fs::read(&sidecar).unwrap(), bytes);
        assert_eq!(mtime(&sidecar), modified);
        assert_eq!(crate::version_policy::head(&path), head);
        // The list builder reuses the view only while the sidecar still matches it.
        let reused = SkillVersionView::from_normalized(&path, second.clone());
        assert_eq!(
            reused.saved.as_ref().map(|v| v.label.as_str()),
            Some("0.1.2")
        );
        assert_eq!(reused.mapped_current, reused.saved);
        assert_eq!(git_versions_from_view(&path, &reused).len(), 3);
        fs::remove_dir_all(home).unwrap();
    }

    /// After maintenance releases the Skill lock, an external Git commit can
    /// move HEAD without touching the sidecar. The maintained view must then
    /// not be reused, and a view is always read as one snapshot of its own HEAD.
    #[test]
    fn a_maintained_view_is_not_reused_once_head_moved_and_views_stay_bound_to_their_head() {
        let home =
            std::env::temp_dir().join(format!("skillhub-list-head-{}", uuid::Uuid::new_v4()));
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = skillhub_root.join("skills");
        let path = managed_root.join("demo");
        fs::create_dir_all(&path).unwrap();
        library_write_profile(&path, &SkillHubProfile::default()).unwrap();
        for revision in 0..3 {
            fs::write(path.join("SKILL.md"), format!("# head {revision}\n")).unwrap();
            library_snapshot_at(&path, &format!("v0.1.{revision} · revision {revision}")).unwrap();
        }
        let maintained = maintain_list_skill_version_at(&skillhub_root, &managed_root, "demo")
            .unwrap()
            .expect("maintenance ran");
        let sidecar_before = fs::read(path.join(".skillhub.json")).unwrap();
        // External commit: HEAD moves, the sidecar does not.
        fs::write(path.join("SKILL.md"), "# head 3 (external)\n").unwrap();
        library_snapshot_at(&path, "v0.1.3 · external commit").unwrap();
        assert_eq!(
            fs::read(path.join(".skillhub.json")).unwrap(),
            sidecar_before
        );
        let on_disk = read_profile_at_path(&path).unwrap().version_metadata;
        assert_eq!(
            maintained.metadata, on_disk,
            "metadata alone cannot tell HEAD moved"
        );
        assert_ne!(maintained.head, crate::version_policy::head(&path));

        // Reuse is refused: the builder reads a fresh view of the new HEAD.
        let fresh = reusable_version_view(&path, Some(maintained.clone()), &on_disk).unwrap();
        assert_eq!(fresh.normalized.head, crate::version_policy::head(&path));
        assert_eq!(
            fresh.saved.as_ref().map(|v| v.label.as_str()),
            Some("0.1.3")
        );
        assert_eq!(git_versions_from_view(&path, &fresh).len(), 4);
        assert_eq!(
            git_versions_from_view(&path, &fresh)
                .iter()
                .filter(|v| v.is_current)
                .count(),
            1
        );

        // A view taken at the old HEAD stays one snapshot: list, saved and
        // fallback all bind to that HEAD, never to the repository's new one.
        let stale = SkillVersionView::from_normalized(&path, maintained.clone());
        assert_eq!(
            stale.saved.as_ref().map(|v| v.label.as_str()),
            Some("0.1.2")
        );
        assert_eq!(
            stale.mapped_current, None,
            "working tree is at the new HEAD"
        );
        let listed = git_versions_from_view(&path, &stale);
        assert_eq!(listed.len(), 3, "enumeration starts at the view's HEAD");
        assert!(listed.iter().all(|v| !v.is_current));
        // Fallback lineage search also starts at the view's HEAD: a view whose
        // HEAD is unmapped but whose parent carries the same content resolves
        // along that lineage, not from the repository HEAD.
        let mut unmapped = maintained.clone();
        let old_head = unmapped.head.clone().unwrap();
        unmapped.metadata.commits.remove(&old_head);
        let fallback = crate::version_policy::saved_current_in(&path, &unmapped);
        assert!(
            fallback.is_none() || fallback.as_ref().map(|v| v.label.as_str()) != Some("0.1.3"),
            "fallback must never resolve to the repository's newer HEAD"
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn one_list_read_normalizes_a_history_exactly_once() {
        let root =
            std::env::temp_dir().join(format!("skillhub-list-once-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        library_write_profile(&root, &SkillHubProfile::default()).unwrap();
        for revision in 0..4 {
            fs::write(root.join("SKILL.md"), format!("# once {revision}\n")).unwrap();
            library_snapshot_at(&root, &format!("v0.1.{revision} · once {revision}")).unwrap();
        }
        let metadata = read_profile_at_path(&root).unwrap().version_metadata;
        // Before: versions + current + saved_current each walked the history.
        let before = crate::version_policy::NORMALIZE_CALLS.with(|c| c.get());
        let _ = git_versions_at_path(&root);
        let _ = crate::version_policy::current(&root, &metadata);
        let _ = crate::version_policy::saved_current(&root, &metadata);
        let separate = crate::version_policy::NORMALIZE_CALLS.with(|c| c.get()) - before;
        assert_eq!(separate, 3);
        // After: one view serves all three.
        let before = crate::version_policy::NORMALIZE_CALLS.with(|c| c.get());
        let view = SkillVersionView::read(&root, &metadata).unwrap();
        let versions = git_versions_from_view(&root, &view);
        let saved = view.saved.clone();
        let current = view.mapped_current.clone();
        let shared = crate::version_policy::NORMALIZE_CALLS.with(|c| c.get()) - before;
        assert_eq!(shared, 1);
        assert_eq!(versions.len(), 4);
        assert_eq!(
            saved,
            crate::version_policy::saved_current(&root, &metadata)
        );
        assert_eq!(current, crate::version_policy::current(&root, &metadata));
        assert_eq!(
            versions.iter().filter(|v| v.is_current).count(),
            1,
            "the saved HEAD is the single current version"
        );
        fs::remove_dir_all(root).unwrap();
    }
}

/// Scan Agent-native Skill folders and return entries not projected by SkillHub.
/// Runs on a blocking worker; see `get_local_skills`.
#[tauri::command]
pub async fn get_unmanaged_agent_skills() -> Result<Vec<UnmanagedSkill>, String> {
    tauri::async_runtime::spawn_blocking(get_unmanaged_agent_skills_blocking)
        .await
        .map_err(|error| format!("Agent Skill 扫描异常结束: {error}"))?
}

pub fn get_unmanaged_agent_skills_blocking() -> Result<Vec<UnmanagedSkill>, String> {
    note_read_command_thread();
    let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
    let managed_root = fs::canonicalize(skills_dir()).unwrap_or_else(|_| skills_dir());
    let detected_agents = crate::detected_agent_keys();
    scan_unmanaged_agent_skills(&home, &managed_root, &detected_agents)
}

/// Upper bound on entries read inside one grouping folder, so a large
/// unrelated directory in an Agent root cannot stall the scan.
const MAX_GROUPED_SKILLS_PER_FOLDER: usize = 200;

/// Upper bound on entries fingerprinted per Skill root.
const MAX_FINGERPRINT_ENTRIES_PER_ROOT: usize = 2_000;

fn update_metadata_fingerprint(digest: &mut Sha256, path: &Path) {
    let Ok(metadata) = fs::metadata(path) else {
        digest.update(b"0");
        return;
    };
    digest.update(b"1");
    digest.update(metadata.len().to_be_bytes());
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    digest.update(modified.to_be_bytes());
}

/// Names, link targets and SKILL.md/Profile metadata of one Skill root, with
/// `group_depth` extra levels for folders that have no SKILL.md. Contents are
/// never read and nothing is created.
fn update_skill_root_fingerprint(digest: &mut Sha256, root: &Path, group_depth: usize) {
    update_plan_digest_field(digest, &root.to_string_lossy());
    let Ok(entries) = fs::read_dir(root) else {
        digest.update(b"missing");
        return;
    };
    let mut children = entries
        .flatten()
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().to_string(),
                entry.path(),
            )
        })
        .filter(|(name, _)| !name.starts_with('.'))
        .take(MAX_FINGERPRINT_ENTRIES_PER_ROOT)
        .collect::<Vec<_>>();
    children.sort();
    for (name, path) in children {
        update_plan_digest_field(digest, &name);
        if let Ok(target) = fs::read_link(&path) {
            update_plan_digest_field(digest, &target.to_string_lossy());
        }
        update_metadata_fingerprint(digest, &path);
        let skill_md = path.join("SKILL.md");
        update_metadata_fingerprint(digest, &skill_md);
        update_metadata_fingerprint(digest, &path.join(".skillhub.json"));
        if group_depth > 0 && !skill_md.exists() && path.is_dir() {
            update_skill_root_fingerprint(digest, &path, group_depth - 1);
        }
    }
}

fn skill_library_fingerprint_at(
    home: &Path,
    managed_root: &Path,
    detected_agents: &HashSet<String>,
) -> String {
    let mut digest = Sha256::new();
    update_plan_digest_field(&mut digest, "skillhub-library-fingerprint-v1");
    update_skill_root_fingerprint(&mut digest, managed_root, 0);
    for (agent_key, _, relative_dir) in crate::known_agents() {
        let codex_shared_root = agent_key == "doubao"
            && !detected_agents.contains("doubao")
            && detected_agents.contains("codex");
        if detected_agents.contains(agent_key) || codex_shared_root {
            update_skill_root_fingerprint(&mut digest, &home.join(relative_dir), 1);
        }
    }
    digest
        .finalize()
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A cheap change signal for the Skill list: it covers the managed store and
/// every root the unmanaged scan reads. The UI polls it while visible and
/// reloads only when it changes.
#[tauri::command]
pub async fn skill_library_fingerprint() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
        Ok(skill_library_fingerprint_at(
            &home,
            &skills_dir(),
            // The poll may reuse a recent detection pass; it only decides
            // which roots to fingerprint and never admits a write.
            &crate::cached_detected_agent_keys(),
        ))
    })
    .await
    .map_err(|error| format!("Skill 变化检查异常结束: {error}"))?
}

fn scan_unmanaged_agent_skills(
    home: &Path,
    managed_root: &Path,
    detected_agents: &HashSet<String>,
) -> Result<Vec<UnmanagedSkill>, String> {
    let mut candidates: BTreeMap<PathBuf, UnmanagedSkill> = BTreeMap::new();

    for (agent_key, agent_name, relative_dir) in crate::known_agents() {
        let codex_shared_root = agent_key == "doubao"
            && !detected_agents.contains("doubao")
            && detected_agents.contains("codex");
        if !detected_agents.contains(agent_key) && !codex_shared_root {
            continue;
        }
        let displayed_agent_name = if codex_shared_root {
            "ChatGPT（通用目录）"
        } else {
            agent_name
        };
        let source_agent_key = if codex_shared_root {
            // Preserve the historical generic identity for compatibility and
            // recovery without presenting Doubao Work as the owner of a
            // ChatGPT fallback directory.
            "agent-skills"
        } else {
            agent_key
        };
        let agent_dir = home.join(relative_dir);
        let Ok(entries) = fs::read_dir(&agent_dir) else {
            continue;
        };
        let mut found: Vec<(String, PathBuf, Option<String>)> = Vec::new();
        for entry in entries.flatten() {
            let entry_name = entry.file_name().to_string_lossy().to_string();
            if entry_name.starts_with('.') || validate_skill_id(&entry_name).is_err() {
                continue;
            }
            let entry_path = entry.path();
            if entry_path.join("SKILL.md").is_file() {
                found.push((entry_name, entry_path, None));
                continue;
            }
            // A folder without SKILL.md may group Skills one level deeper
            // (`<group>/<skill>/SKILL.md`). Only that single extra level is
            // read, never recursively, and SkillHub-owned folders are skipped.
            if projection_marker_for_link(&entry_path).is_some() {
                continue;
            }
            let Ok(canonical_group) = fs::canonicalize(&entry_path) else {
                continue;
            };
            if canonical_group.starts_with(managed_root) || !canonical_group.is_dir() {
                continue;
            }
            let Ok(children) = fs::read_dir(&entry_path) else {
                continue;
            };
            for child in children.flatten().take(MAX_GROUPED_SKILLS_PER_FOLDER) {
                let child_name = child.file_name().to_string_lossy().to_string();
                if child_name.starts_with('.') || validate_skill_id(&child_name).is_err() {
                    continue;
                }
                found.push((child_name, child.path(), Some(entry_name.clone())));
            }
        }
        for (entry_name, entry_path, group) in found {
            if projection_marker_for_link(&entry_path).is_some() {
                continue;
            }
            let Ok(canonical) = fs::canonicalize(&entry_path) else {
                continue;
            };
            if canonical.starts_with(managed_root) || !canonical.join("SKILL.md").is_file() {
                continue;
            }

            let source = AgentSkillSource {
                agent_key: source_agent_key.to_string(),
                agent_name: displayed_agent_name.to_string(),
                entry_name: entry_name.clone(),
                group,
            };
            if let Some(existing) = candidates.get_mut(&canonical) {
                if !existing
                    .sources
                    .iter()
                    .any(|item| item.agent_key == source.agent_key)
                {
                    existing.sources.push(source);
                }
                continue;
            }

            let mut file = fs::File::open(canonical.join("SKILL.md"))
                .map_err(|error| error.to_string())?
                .take(128 * 1024);
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            let content = String::from_utf8_lossy(&bytes);
            let (display_name, description, category, labels, version) =
                parse_skill_document(&entry_name, &content);
            let digest = format!(
                "{:x}",
                Sha256::digest(canonical.to_string_lossy().as_bytes())
            );
            candidates.insert(
                canonical.clone(),
                UnmanagedSkill {
                    id: format!("agent-local:{}", &digest[..16]),
                    name: entry_name,
                    display_name,
                    description,
                    category,
                    labels,
                    version,
                    sources: vec![source],
                    local_path: canonical.to_string_lossy().to_string(),
                },
            );
        }
    }

    let mut result: Vec<UnmanagedSkill> = candidates.into_values().collect();
    for skill in &mut result {
        skill
            .sources
            .sort_by(|left, right| left.agent_name.cmp(&right.agent_name));
    }
    result.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    Ok(result)
}

#[derive(Debug, Clone)]
struct AdoptionRecord {
    source: PathBuf,
    backup: PathBuf,
    agent_key: String,
    agent_name: String,
    entry_name: String,
    fingerprint: String,
    matches_selected: bool,
}

fn fingerprint_hex(root: &Path) -> Result<String, String> {
    Ok(skill_tree_fingerprint(root)?
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn update_plan_digest_field(digest: &mut Sha256, value: &str) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value.as_bytes());
}

fn build_import_preflight_at(
    home: &Path,
    source_root: &Path,
    selected_path: &Path,
    skill_id: &str,
    detected_agents: &HashSet<String>,
) -> Result<ImportSkillPreflight, String> {
    let canonical_source =
        fs::canonicalize(source_root).map_err(|error| format!("无法解析待导入 Skill: {error}"))?;
    let selected_fingerprint = fingerprint_hex(&canonical_source)
        .map_err(|error| format!("无法检查待导入 Skill 内容: {error}"))?;
    let canonical_selected_path =
        fs::canonicalize(selected_path).map_err(|error| format!("无法解析导入来源: {error}"))?;
    let mut sources_by_physical_path: BTreeMap<PathBuf, ImportSkillSource> = BTreeMap::new();
    let mut scanned_agent_roots = HashSet::new();

    for (agent_key, agent_name, relative_dir) in crate::known_agents() {
        let codex_shared_root = agent_key == "doubao"
            && !detected_agents.contains("doubao")
            && detected_agents.contains("codex");
        let source_agent_key = if codex_shared_root {
            "agent-skills"
        } else {
            agent_key
        };
        let source_agent_name = if codex_shared_root {
            "ChatGPT（通用目录）"
        } else {
            agent_name
        };
        let agent_root = home.join(relative_dir);
        let Ok(canonical_agent_root) = fs::canonicalize(&agent_root) else {
            continue;
        };
        // Different Agent roots can themselves be symlinks to the same folder.
        // Scan that physical directory once so one entry is never staged twice.
        if !scanned_agent_roots.insert(canonical_agent_root.clone()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&agent_root) else {
            continue;
        };
        for entry in entries.flatten() {
            let entry_name = entry.file_name().to_string_lossy().to_string();
            if entry_name.starts_with('.') {
                continue;
            }
            let entry_path = entry.path();
            let canonical_entry = match fs::canonicalize(&entry_path) {
                Ok(path) => path,
                Err(error) if entry_name == skill_id => {
                    return Err(format!(
                        "Agent 中存在无法解析的同名项，已拒绝迁移: {} ({error})",
                        entry_path.display()
                    ));
                }
                Err(_) => continue,
            };
            let metadata = fs::symlink_metadata(&entry_path).map_err(|error| {
                format!("无法检查 Agent Skill {}: {error}", entry_path.display())
            })?;
            if !metadata.is_dir() && !metadata.file_type().is_symlink() {
                if entry_name == skill_id {
                    return Err(format!(
                        "Agent Skill 来源不是目录或符号链接: {}",
                        entry_path.display()
                    ));
                }
                continue;
            }
            if canonical_entry == canonical_source {
                if entry_name != skill_id {
                    return Err(format!(
                        "同一个 Skill 在 Agent 中使用了不同名称（{}）；请先统一名称后再导入",
                        entry_path.display()
                    ));
                }
            } else if entry_name != skill_id {
                continue;
            }
            let fingerprint = fingerprint_hex(&canonical_entry).map_err(|error| {
                format!("无法检查同名 Agent Skill {}: {error}", entry_path.display())
            })?;
            sources_by_physical_path
                .entry(canonical_agent_root.join(&entry_name))
                .or_insert_with(|| ImportSkillSource {
                    agent_key: source_agent_key.to_string(),
                    agent_name: source_agent_name.to_string(),
                    entry_name,
                    path: entry_path.to_string_lossy().to_string(),
                    canonical_path: canonical_entry.to_string_lossy().to_string(),
                    matches_selected: fingerprint == selected_fingerprint,
                    selected: canonical_entry == canonical_source,
                    fingerprint,
                });
        }
    }

    let sources = sources_by_physical_path.into_values().collect::<Vec<_>>();
    let has_conflicts = sources.iter().any(|source| !source.matches_selected);
    let selected_path = canonical_selected_path.to_string_lossy().to_string();
    let mut digest = Sha256::new();
    update_plan_digest_field(&mut digest, "skillhub-import-plan-v1");
    update_plan_digest_field(&mut digest, skill_id);
    update_plan_digest_field(&mut digest, &selected_path);
    update_plan_digest_field(&mut digest, &selected_fingerprint);
    for source in &sources {
        update_plan_digest_field(&mut digest, &source.agent_key);
        update_plan_digest_field(&mut digest, &source.agent_name);
        update_plan_digest_field(&mut digest, &source.entry_name);
        update_plan_digest_field(&mut digest, &source.path);
        update_plan_digest_field(&mut digest, &source.canonical_path);
        update_plan_digest_field(&mut digest, &source.fingerprint);
        digest.update([u8::from(source.matches_selected), u8::from(source.selected)]);
    }
    Ok(ImportSkillPreflight {
        skill_id: skill_id.to_string(),
        selected_path,
        selected_fingerprint,
        sources,
        has_conflicts,
        plan_digest: format!("{:x}", digest.finalize()),
    })
}

fn prepare_import_source(src: &Path) -> Result<(Option<PathBuf>, PathBuf), String> {
    if src.is_dir() {
        Ok((None, src.to_path_buf()))
    } else if src.extension().and_then(|value| value.to_str()) == Some("zip") {
        let (temporary, root) = prepare_user_zip(src)?;
        Ok((Some(temporary), root))
    } else {
        Err("请选择包含 SKILL.md 的文件夹或 ZIP 压缩包".into())
    }
}

fn import_skill_id_for_source(
    src: &Path,
    source_root: &Path,
    temporary_root: Option<&Path>,
    requested_skill_id: Option<&str>,
) -> Result<String, String> {
    let derived = if src.is_dir() || temporary_root.is_some_and(|root| source_root == root) {
        src.file_stem()
    } else {
        source_root.file_name()
    }
    .unwrap_or_default()
    .to_string_lossy()
    .to_string();
    let skill_id = requested_skill_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&derived)
        .to_string();
    validate_skill_id(&skill_id)?;
    Ok(skill_id)
}

fn preflight_import_skill_blocking(
    path: String,
    skill_id: Option<String>,
) -> Result<ImportSkillPreflight, String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("Path not found: {path}"));
    }
    let (temporary_root, source_root) = prepare_import_source(&src)?;
    let result = (|| {
        reject_installed_system_manager_import(&source_root)?;
        if !source_root.join("SKILL.md").is_file() {
            return Err("所选文件夹或 ZIP 中缺少 SKILL.md".into());
        }
        let skill_md = fs::read_to_string(source_root.join("SKILL.md"))
            .map_err(|error| format!("无法读取 SKILL.md: {error}"))?;
        skill_md_env_declarations(&skill_md)?;
        let resolved_skill_id = import_skill_id_for_source(
            &src,
            &source_root,
            temporary_root.as_deref(),
            skill_id.as_deref(),
        )?;
        let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
        build_import_preflight_at(
            &home,
            &source_root,
            &src,
            &resolved_skill_id,
            &crate::detected_agent_keys(),
        )
    })();
    if let Some(temporary) = temporary_root {
        let _ = fs::remove_dir_all(temporary);
    }
    result
}

#[tauri::command]
pub async fn preflight_import_skill(
    path: String,
    skill_id: Option<String>,
) -> Result<ImportSkillPreflight, String> {
    tauri::async_runtime::spawn_blocking(move || preflight_import_skill_blocking(path, skill_id))
        .await
        .map_err(|error| format!("Skill 导入检查任务异常结束: {error}"))?
}

fn write_adoption_manifest(
    backup_dir: &Path,
    status: &str,
    destination: &Path,
    projection_target: &Path,
    records: &[AdoptionRecord],
    errors: &[String],
) -> Result<(), String> {
    let manifest_path = backup_dir.join("manifest.json");
    let created_at = fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok())
        .and_then(|value| value.get("createdAt")?.as_u64())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |duration| duration.as_secs())
        });
    let skill_id = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown");
    let payload = serde_json::json!({
        "version": 3,
        "id": backup_dir.file_name().and_then(|name| name.to_str()).unwrap_or_default(),
        "kind": if records.iter().any(|record| !record.matches_selected) { "agent_name_conflict" } else { "agent_adoption" },
        "createdAt": created_at,
        "status": status,
        "skillId": skill_id,
        "displayName": skill_id,
        "destination": destination.to_string_lossy(),
        "projectionTarget": projection_target.to_string_lossy(),
        "sources": records.iter().map(|record| serde_json::json!({
            "agentKey": record.agent_key,
            "agentName": record.agent_name,
            "entryName": record.entry_name,
            "original": record.source.to_string_lossy(),
            "backup": record.backup.to_string_lossy(),
            "fingerprint": record.fingerprint,
            "matchesSelected": record.matches_selected,
        })).collect::<Vec<_>>(),
        "errors": errors,
    });
    write_private_file(
        &manifest_path,
        &serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?,
    )
}

fn remove_new_managed_destination(destination: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!(
            "拒绝清理非普通目录的 managed destination: {}",
            destination.display()
        ));
    }
    fs::remove_dir_all(destination).map_err(|error| error.to_string())
}

fn rollback_agent_adoption(
    destination: &Path,
    projection_target: &Path,
    records: &[AdoptionRecord],
    created_links: &[PathBuf],
    remove_destination_on_rollback: bool,
) -> Vec<String> {
    let mut rollback_errors = Vec::new();
    for link in created_links.iter().rev() {
        match fs::symlink_metadata(link) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                let points_to_destination = fs::read_link(link)
                    .ok()
                    .is_some_and(|target| target == projection_target);
                if !points_to_destination {
                    rollback_errors.push(format!(
                        "回滚时发现投影已被其他内容替换，未删除: {}",
                        link.display()
                    ));
                } else if let Err(error) = crate::platform_fs::remove_link(link) {
                    rollback_errors.push(format!("无法移除投影 {}: {error}", link.display()));
                }
            }
            Ok(_) => rollback_errors.push(format!(
                "回滚时发现非符号链接项，未覆盖: {}",
                link.display()
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => rollback_errors.push(format!("无法检查投影 {}: {error}", link.display())),
        }
    }

    for record in records.iter().rev() {
        if fs::symlink_metadata(&record.source).is_ok() {
            rollback_errors.push(format!(
                "原位置已被其他内容占用，备份保留在 {}",
                record.backup.display()
            ));
            continue;
        }
        if let Some(parent) = record.source.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                rollback_errors.push(format!(
                    "无法恢复原目录 {}: {error}",
                    record.source.display()
                ));
                continue;
            }
        }
        if let Err(error) = fs::rename(&record.backup, &record.source) {
            rollback_errors.push(format!(
                "无法从备份恢复 {}: {error}",
                record.source.display()
            ));
        }
    }

    if rollback_errors.is_empty() && remove_destination_on_rollback {
        if let Err(error) = remove_new_managed_destination(destination) {
            rollback_errors.push(format!("无法清理 managed copy: {error}"));
        }
    }
    rollback_errors
}

fn adopt_agent_sources_with<F>(
    source_root: &Path,
    destination: &Path,
    projection_target: &Path,
    backup_dir: &Path,
    plan: &ImportSkillPreflight,
    remove_destination_on_rollback: bool,
    mut create_projection: F,
) -> Result<(), String>
where
    F: FnMut(&Path, &Path) -> Result<(), String>,
{
    if plan.sources.is_empty() {
        return Ok(());
    }
    let destination_metadata = fs::symlink_metadata(destination)
        .map_err(|error| format!("managed copy 不存在: {error}"))?;
    if !destination_metadata.is_dir() || destination_metadata.file_type().is_symlink() {
        return Err("managed copy 必须是普通目录".into());
    }
    let canonical_source =
        fs::canonicalize(source_root).map_err(|error| format!("无法重新验证导入来源: {error}"))?;
    let selected_fingerprint = fingerprint_hex(&canonical_source)
        .map_err(|error| format!("无法重新验证导入内容: {error}"))?;
    if selected_fingerprint != plan.selected_fingerprint {
        return Err("导入前所选 Skill 内容已发生变化，请重新确认".into());
    }
    for source in &plan.sources {
        let source_path = PathBuf::from(&source.path);
        let canonical = fs::canonicalize(&source_path)
            .map_err(|error| format!("迁移前来源已发生变化 {}: {error}", source_path.display()))?;
        if canonical.to_string_lossy() != source.canonical_path
            || fingerprint_hex(&canonical)
                .map_err(|error| format!("无法重新验证来源 {}: {error}", source_path.display()))?
                != source.fingerprint
        {
            return Err(format!(
                "迁移前同名 Skill 内容已发生变化，请重新确认: {}",
                source_path.display()
            ));
        }
    }

    fs::create_dir(backup_dir).map_err(|error| error.to_string())?;
    fs::set_permissions(backup_dir, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let entries_dir = backup_dir.join("entries");
    fs::create_dir(&entries_dir).map_err(|error| error.to_string())?;
    fs::set_permissions(&entries_dir, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;

    let records: Vec<AdoptionRecord> = plan
        .sources
        .iter()
        .enumerate()
        .map(|(index, source)| AdoptionRecord {
            source: PathBuf::from(&source.path),
            backup: entries_dir.join(format!("{index:02}-source")),
            agent_key: source.agent_key.clone(),
            agent_name: source.agent_name.clone(),
            entry_name: source.entry_name.clone(),
            fingerprint: source.fingerprint.clone(),
            matches_selected: source.matches_selected,
        })
        .collect();
    write_adoption_manifest(
        backup_dir,
        "in_progress",
        destination,
        projection_target,
        &records,
        &[],
    )?;

    let mut staged = Vec::new();
    for record in &records {
        if let Err(error) = fs::rename(&record.source, &record.backup) {
            let rollback_errors = rollback_agent_adoption(
                destination,
                projection_target,
                &staged,
                &[],
                remove_destination_on_rollback,
            );
            if rollback_errors.is_empty() {
                let _ = fs::remove_dir_all(backup_dir);
                return Err(format!(
                    "无法备份 Agent Skill {}: {error}",
                    record.source.display()
                ));
            }
            let _ = write_adoption_manifest(
                backup_dir,
                "rollback_incomplete",
                destination,
                projection_target,
                &staged,
                &rollback_errors,
            );
            return Err(format!(
                "迁移失败且回滚不完整；请保留 {} 并联系支持：{}",
                backup_dir.display(),
                rollback_errors.join("；")
            ));
        }
        staged.push(record.clone());
    }

    let mut created_links = Vec::new();
    for record in &records {
        if let Some(parent) = record.source.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                let rollback_errors = rollback_agent_adoption(
                    destination,
                    projection_target,
                    &staged,
                    &created_links,
                    remove_destination_on_rollback,
                );
                if rollback_errors.is_empty() {
                    let _ = fs::remove_dir_all(backup_dir);
                    return Err(format!("无法创建 Agent 目录 {}: {error}", parent.display()));
                }
                let _ = write_adoption_manifest(
                    backup_dir,
                    "rollback_incomplete",
                    destination,
                    projection_target,
                    &staged,
                    &rollback_errors,
                );
                return Err(format!(
                    "迁移失败且回滚不完整；请保留 {} 并联系支持：{}",
                    backup_dir.display(),
                    rollback_errors.join("；")
                ));
            }
        }
        if let Err(error) = create_projection(projection_target, &record.source) {
            let rollback_errors = rollback_agent_adoption(
                destination,
                projection_target,
                &staged,
                &created_links,
                remove_destination_on_rollback,
            );
            if rollback_errors.is_empty() {
                let _ = fs::remove_dir_all(backup_dir);
                return Err(format!(
                    "无法创建 Agent 投影 {}: {error}",
                    record.source.display()
                ));
            }
            let _ = write_adoption_manifest(
                backup_dir,
                "rollback_incomplete",
                destination,
                projection_target,
                &staged,
                &rollback_errors,
            );
            return Err(format!(
                "迁移失败且回滚不完整；请保留 {} 并联系支持：{}",
                backup_dir.display(),
                rollback_errors.join("；")
            ));
        }
        created_links.push(record.source.clone());
    }

    if let Err(error) = write_adoption_manifest(
        backup_dir,
        "complete",
        destination,
        projection_target,
        &records,
        &[],
    ) {
        let rollback_errors = rollback_agent_adoption(
            destination,
            projection_target,
            &staged,
            &created_links,
            remove_destination_on_rollback,
        );
        if rollback_errors.is_empty() {
            let _ = fs::remove_dir_all(backup_dir);
            return Err(format!("无法完成迁移清单: {error}"));
        }
        let _ = write_adoption_manifest(
            backup_dir,
            "rollback_incomplete",
            destination,
            projection_target,
            &staged,
            &rollback_errors,
        );
        return Err(format!(
            "迁移清单写入失败且回滚不完整；请保留 {} 并联系支持：{}",
            backup_dir.display(),
            rollback_errors.join("；")
        ));
    }
    Ok(())
}

fn agent_skill_directory_for_read(agent: &str) -> Option<&'static str> {
    crate::known_agents()
        .into_iter()
        .find(|(key, _, _)| *key == agent)
        .map(|(_, _, relative)| relative)
        // Historical generic entries can still appear in adoption recovery
        // and ChatGPT's macOS compatibility scan. This alias is read/reveal
        // only; it is not an install or detection capability.
        .or_else(|| (agent == "agent-skills").then_some(".agents/skills"))
}

/// Open a validated direct Agent Skill entry in Finder.
#[tauri::command]
pub fn open_agent_skill_dir(
    agent: String,
    skill_name: String,
    group: Option<String>,
) -> Result<(), String> {
    validate_skill_id(&skill_name)?;
    if let Some(group) = group.as_deref() {
        validate_skill_id(group)?;
    }
    let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
    let relative_dir =
        agent_skill_directory_for_read(&agent).ok_or_else(|| format!("Unknown Agent: {agent}"))?;
    let agent_root = home.join(relative_dir);
    let entry = match group.as_deref() {
        Some(group) => agent_root.join(group).join(&skill_name),
        None => agent_root.join(&skill_name),
    };
    let canonical = fs::canonicalize(&entry).map_err(|_| "本地 Skill 不存在".to_string())?;
    let managed_root = fs::canonicalize(skills_dir()).unwrap_or_else(|_| skills_dir());
    if canonical.starts_with(managed_root) {
        return Err("该条目已由 SkillHub 管理".into());
    }
    if !canonical.join("SKILL.md").is_file() {
        return Err("本地 Skill 缺少 SKILL.md".into());
    }
    open::that(canonical).map_err(|error| error.to_string())
}

/// Reveal the exact Agent directory containing a conflicting same-name entry.
/// This never deletes or replaces the user's item.
#[tauri::command]
pub fn open_agent_skill_conflict(agent: String, skill_name: String) -> Result<(), String> {
    validate_skill_id(&skill_name)?;
    let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
    let relative_dir =
        agent_skill_directory_for_read(&agent).ok_or_else(|| format!("Unknown Agent: {agent}"))?;
    let entry = home.join(relative_dir).join(&skill_name);
    fs::symlink_metadata(&entry).map_err(|_| "冲突项已经不存在，请刷新 Skill 数据".to_string())?;
    if is_managed_projection_with_name(&entry, &skill_name) {
        return Err("该投影已经恢复正常，请刷新 Skill 数据".into());
    }
    let parent = entry.parent().ok_or("无法定位 Agent Skill 目录")?;
    open::that(parent).map_err(|error| error.to_string())
}

fn profile_runtime_metadata(
    profile: &SkillHubProfile,
) -> (Option<String>, Vec<String>, Vec<String>) {
    let scenarios = profile.trigger_scenarios.clone();
    let trigger = (!scenarios.is_empty()).then(|| scenarios.join("、"));
    (trigger, scenarios, profile.compatible_agents.clone())
}

fn profile_team_ids(profile: &SkillHubProfile) -> Vec<String> {
    let mut seen = HashSet::new();
    profile
        .team_ids
        .iter()
        .chain(profile.teams.iter())
        .filter(|team_id| !team_id.trim().is_empty() && seen.insert((*team_id).clone()))
        .cloned()
        .collect()
}

fn promote_profile_to_personal(profile: &mut SkillHubProfile) -> bool {
    if profile.catalog_origin.is_some() || profile.is_system || profile.is_own.unwrap_or(true) {
        return false;
    }
    profile.upstream = Some(SkillUpstream {
        source: profile_acquisition_source(profile),
        server_skill_id: profile.server_id.clone(),
        server_owner_id: profile.server_owner_id.clone(),
        team_id: profile
            .team_shared_from
            .clone()
            .or_else(|| profile_team_ids(profile).into_iter().next()),
        version: profile.version.clone(),
        package_sha256: profile.acquisition_package_sha256.clone(),
    });
    profile.is_own = Some(true);
    profile.acquisition_source = Some(AcquisitionSource::Local);
    profile.acquisition_package_sha256 = None;
    profile.acquired_by_user_id = None;
    profile.team_shared_from = None;
    profile.teams.clear();
    profile.team_ids.clear();
    profile.server_id = None;
    profile.server_owner_id = crate::runtime_env::active_runtime_user_id();
    true
}

const EDIT_SESSION_VERSION: u8 = 1;
const MAX_EDIT_SESSION_BYTES: usize = 32 * 1024;
const MAX_EDIT_SESSION_AGE_SECONDS: u64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillEditSession {
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    space: Option<crate::server_request::SpaceHandle>,
    version: u8,
    id: String,
    skill_id: String,
    baseline_fingerprint: String,
    working_copy_path: String,
    projection_path: String,
    created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrepareSkillEditOutput {
    session_id: String,
    skill_id: String,
    working_copy_path: String,
    projection_path: String,
    finish_command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishSkillEditOutput {
    session_id: String,
    skill_id: String,
    changed: bool,
    promoted_to_personal: bool,
    version: String,
    working_copy_path: String,
    projection_path: String,
}

fn edit_sessions_dir_at(skillhub_root: &Path) -> PathBuf {
    skillhub_root.join("edit-sessions")
}

fn unix_timestamp_now() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| error.to_string())
}

fn ensure_edit_sessions_dir_at(skillhub_root: &Path) -> Result<PathBuf, String> {
    let directory = edit_sessions_dir_at(skillhub_root);
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err("Skill 编辑会话目录不是安全目录".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&directory).map_err(|error| error.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    validate_private_projection_directory(&directory, "Skill 编辑会话目录")?;
    Ok(directory)
}

fn remove_stale_edit_sessions_at(skillhub_root: &Path, now: u64) {
    let directory = edit_sessions_dir_at(skillhub_root);
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let Ok(age) = std::time::SystemTime::now().duration_since(modified) else {
            continue;
        };
        if !metadata.file_type().is_symlink()
            && metadata.is_file()
            && age.as_secs() > MAX_EDIT_SESSION_AGE_SECONDS
            && now > MAX_EDIT_SESSION_AGE_SECONDS
        {
            let _ = fs::remove_file(path);
        }
    }
}

fn resolve_edit_skill_at(
    skillhub_root: &Path,
    managed_root: &Path,
    skill_id: Option<&str>,
    skill_path_value: Option<&str>,
) -> Result<(String, PathBuf), String> {
    if skill_id.is_some() == skill_path_value.is_some() {
        return Err(
            "用法：skillhub skill prepare-edit (--skill-id <id> | --skill-path <SKILL.md>) --json"
                .into(),
        );
    }
    if let Some(skill_id) = skill_id {
        validate_skill_id(skill_id)?;
        let canonical = managed_root.join(skill_id);
        validate_real_directory(&canonical, "Skill 工作副本")?;
        return Ok((skill_id.to_string(), canonical));
    }

    let supplied = PathBuf::from(skill_path_value.expect("checked exactly one edit target"));
    let root = if supplied.file_name().and_then(|value| value.to_str()) == Some("SKILL.md") {
        supplied
            .parent()
            .ok_or("无法定位 SKILL 根目录")?
            .to_path_buf()
    } else {
        supplied
    };
    let resolved = fs::canonicalize(&root)
        .map_err(|error| format!("无法解析 Agent 中的 Skill 路径: {error}"))?;
    let canonical_managed = fs::canonicalize(managed_root)
        .map_err(|error| format!("无法解析 SkillHub 资产目录: {error}"))?;
    if let Ok(relative) = resolved.strip_prefix(&canonical_managed) {
        let skill_id = relative
            .components()
            .next()
            .and_then(|component| component.as_os_str().to_str())
            .ok_or("无法从路径识别 Skill id")?;
        validate_skill_id(skill_id)?;
        let canonical = canonical_managed.join(skill_id);
        validate_real_directory(&canonical, "Skill 工作副本")?;
        return Ok((skill_id.to_string(), canonical));
    }

    let marker_path = resolved.join(PROJECTION_MARKER_NAME);
    let marker_bytes = read_owned_projection_file(
        &marker_path,
        MAX_PROJECTION_MARKER_BYTES,
        true,
        "Skill 投影 marker",
    )?;
    let marker: ProjectionMarker = serde_json::from_slice(&marker_bytes)
        .map_err(|error| format!("Skill 投影 marker 已损坏: {error}"))?;
    let (_, generation) =
        projection_generation_at(skillhub_root, managed_root, &marker.skill_id, &resolved)
            .ok_or("这个路径不是当前 SkillHub 管理的安全投影")?;
    if !projection_generation_is_coordinated(&marker, &generation) {
        return Err("Agent Skill 投影存在冲突，请先在 SkillHub 中修复".into());
    }
    Ok((marker.skill_id.clone(), managed_root.join(marker.skill_id)))
}

fn prepare_skill_edit_at(
    skillhub_root: &Path,
    managed_root: &Path,
    skill_id: Option<&str>,
    skill_path_value: Option<&str>,
) -> Result<PrepareSkillEditOutput, String> {
    let (skill_id, canonical) =
        resolve_edit_skill_at(skillhub_root, managed_root, skill_id, skill_path_value)?;
    let _lock = crate::skill_lock::lock_skill_dir_at(skillhub_root, &skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    let current = crate::runtime_env::runtime_session_snapshot_at(skillhub_root).ok();
    let _lease = if let Some(session) = &current {
        crate::spaces::require_profile(&read_profile_at_path(&canonical)?, session)?;
        Some(
            crate::runtime_env::acquire_current_session_lease_at(skillhub_root, session)?
                .ok_or(crate::spaces::STALE)?,
        )
    } else {
        None
    };
    reconcile_skill_projection_at(skillhub_root, managed_root, &skill_id)?;
    let canonical =
        fs::canonicalize(canonical).map_err(|error| format!("无法解析 Skill 工作副本: {error}"))?;
    let baseline_fingerprint = fingerprint_hex(&canonical)?;
    let projection_path = projection_root_at(skillhub_root, &skill_id).join("current");
    let session_id = uuid::Uuid::new_v4().to_string();
    let now = unix_timestamp_now()?;
    let directory = ensure_edit_sessions_dir_at(skillhub_root)?;
    remove_stale_edit_sessions_at(skillhub_root, now);
    let session = SkillEditSession {
        account_id: current
            .as_ref()
            .map(|session| session.user_id().to_string()),
        space: current
            .as_ref()
            .map(|session| crate::server_request::SpaceRegistry::handle(Some(session))),
        version: EDIT_SESSION_VERSION,
        id: session_id.clone(),
        skill_id: skill_id.clone(),
        baseline_fingerprint,
        working_copy_path: canonical.to_string_lossy().to_string(),
        projection_path: projection_path.to_string_lossy().to_string(),
        created_at: now,
    };
    write_private_file(
        &directory.join(format!("{session_id}.json")),
        &serde_json::to_string_pretty(&session).map_err(|error| error.to_string())?,
    )?;
    Ok(PrepareSkillEditOutput {
        session_id: session_id.clone(),
        skill_id,
        working_copy_path: session.working_copy_path,
        projection_path: session.projection_path,
        finish_command: format!("skillhub skill finish-edit {session_id} --json"),
    })
}

fn read_edit_session_at(
    skillhub_root: &Path,
    session_id: &str,
) -> Result<SkillEditSession, String> {
    uuid::Uuid::parse_str(session_id).map_err(|_| "Skill 编辑会话 id 无效".to_string())?;
    let path = edit_sessions_dir_at(skillhub_root).join(format!("{session_id}.json"));
    let bytes = read_owned_projection_file(&path, MAX_EDIT_SESSION_BYTES, true, "Skill 编辑会话")?;
    let session: SkillEditSession =
        serde_json::from_slice(&bytes).map_err(|error| format!("Skill 编辑会话已损坏: {error}"))?;
    if session.version != EDIT_SESSION_VERSION || session.id != session_id {
        return Err("Skill 编辑会话版本或身份无效".into());
    }
    let age = unix_timestamp_now()?.saturating_sub(session.created_at);
    if age > MAX_EDIT_SESSION_AGE_SECONDS {
        return Err("Skill 编辑会话已过期，请重新 prepare-edit".into());
    }
    Ok(session)
}

fn finish_skill_edit_at(
    skillhub_root: &Path,
    managed_root: &Path,
    session_id: &str,
) -> Result<FinishSkillEditOutput, String> {
    let session = read_edit_session_at(skillhub_root, session_id)?;
    let current = crate::runtime_env::runtime_session_snapshot_at(skillhub_root).ok();
    if session.space
        != current
            .as_ref()
            .map(|session| crate::server_request::SpaceRegistry::handle(Some(session)))
        || current
            .as_ref()
            .is_some_and(crate::runtime_env::RuntimeSession::is_sync_pending)
    {
        return Err("编辑期间空间已切换，请重新 prepare-edit".into());
    }
    if session.account_id
        != current
            .as_ref()
            .map(|session| session.user_id().to_string())
    {
        return Err("编辑期间账号已切换，请在当前账号重新 prepare-edit".into());
    }
    let _lock = crate::skill_lock::lock_skill_dir_at(skillhub_root, &session.skill_id)?;
    validate_skill_id(&session.skill_id)?;
    reject_system_skill_mutation(&session.skill_id)?;
    let canonical = managed_root.join(&session.skill_id);
    let expected_canonical = fs::canonicalize(&canonical)
        .map_err(|error| format!("Skill 工作副本已经不存在: {error}"))?;
    if Path::new(&session.working_copy_path) != expected_canonical {
        return Err("Skill 编辑会话指向的工作副本已变化".into());
    }
    reconcile_skill_projection_at(skillhub_root, managed_root, &session.skill_id)?;
    let changed = fingerprint_hex(&canonical)? != session.baseline_fingerprint;
    let mut profile = read_profile_at_path(&canonical)?;
    let _lease = version_session_lease_at(skillhub_root, &profile)?;
    let normalized =
        crate::version_policy::normalize_history(&canonical, &mut profile.version_metadata)?;
    if let Some(current) = crate::version_policy::current(&canonical, &profile.version_metadata) {
        profile.version = current.label.clone();
    }
    let mut promoted_to_personal = false;
    if changed {
        promoted_to_personal = promote_profile_to_personal(&mut profile);
        let version = crate::version_policy::allocate(profile.version_metadata.high_water, None)?;
        profile.version = version.clone();
        profile.updated_at = Some(chrono_from_secs(unix_timestamp_now()? as i64));
        create_numbered_snapshot_at(
            &canonical,
            &mut profile,
            &version,
            "auto",
            "Agent 自动保存改进",
        )?;
        refresh_skill_projection_at(skillhub_root, managed_root, &session.skill_id)?;
    } else if normalized {
        write_version_profile_at(&canonical, &profile)?;
    }
    fs::remove_file(edit_sessions_dir_at(skillhub_root).join(format!("{session_id}.json")))
        .map_err(|error| format!("无法结束 Skill 编辑会话: {error}"))?;
    Ok(FinishSkillEditOutput {
        session_id: session.id,
        skill_id: session.skill_id,
        changed,
        promoted_to_personal,
        version: profile.version,
        working_copy_path: canonical.to_string_lossy().to_string(),
        projection_path: session.projection_path,
    })
}

fn cli_option_value<'a>(args: &'a [String], flag: &str) -> Result<Option<&'a str>, String> {
    let mut values = args
        .windows(2)
        .filter(|pair| pair[0] == flag)
        .map(|pair| pair[1].as_str());
    let value = values.next();
    if values.next().is_some() {
        return Err(format!("参数 {flag} 只能提供一次"));
    }
    Ok(value)
}

pub fn execute_skill_management_cli(args: &[String]) -> Option<Result<String, String>> {
    if args.first().map(String::as_str) != Some("skill") {
        return None;
    }
    let result = (|| -> Result<String, String> {
        match args.get(1).map(String::as_str) {
            Some("prepare-edit") => {
                repair_system_manager()?;
                let skill_id = cli_option_value(args, "--skill-id")?;
                let skill_path_value = cli_option_value(args, "--skill-path")?;
                let output = prepare_skill_edit_at(
                    &skillhub_dir(),
                    &skills_dir(),
                    skill_id,
                    skill_path_value,
                )?;
                serde_json::to_string(&output).map_err(|error| error.to_string())
            }
            Some("finish-edit") => {
                repair_system_manager()?;
                let session_id = args
                    .get(2)
                    .ok_or("用法：skillhub skill finish-edit <session-id> --json")?;
                let output = finish_skill_edit_at(&skillhub_dir(), &skills_dir(), session_id)?;
                serde_json::to_string(&output).map_err(|error| error.to_string())
            }
            _ => {
                Err("用法：skillhub skill prepare-edit ... | skillhub skill finish-edit ...".into())
            }
        }
    })();
    Some(result)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManagedSkillAgentProjectionState {
    Missing,
    Installed,
    Occupied,
}

/// Classify one exact Agent projection target without treating directory
/// presence as proof of SkillHub ownership.
pub(crate) fn managed_skill_agent_projection_state_at(
    link: &Path,
    skillhub_root: &Path,
    managed_root: &Path,
    skill_id: &str,
) -> Result<ManagedSkillAgentProjectionState, String> {
    validate_skill_id(skill_id)?;
    match fs::symlink_metadata(link) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ManagedSkillAgentProjectionState::Missing)
        }
        Err(error) => return Err(format!("无法检查 Agent 投影 {}: {error}", link.display())),
    }
    let legacy_owned = fs::canonicalize(managed_root.join(skill_id))
        .ok()
        .is_some_and(|managed_skill| {
            crate::platform_fs::projection_resource_matches(link, &managed_skill)
        });
    #[cfg(not(windows))]
    let generated_owned = projection_marker_for_link_at(link, skillhub_root, managed_root)
        .is_some_and(|(marker, generation)| {
            marker.skill_id == skill_id
                && projection_generation_is_coordinated(&marker, &generation)
        });
    #[cfg(windows)]
    let current = projection_root_at(skillhub_root, skill_id).join("current");
    #[cfg(windows)]
    let generated_owned = crate::platform_fs::projection_resource_matches(link, &current)
        && current_projection_at(skillhub_root, managed_root, skill_id).is_some_and(
            |(marker, generation)| {
                marker.skill_id == skill_id
                    && projection_generation_is_coordinated(&marker, &generation)
            },
        );
    let owned = legacy_owned || generated_owned;
    Ok(if owned {
        ManagedSkillAgentProjectionState::Installed
    } else {
        ManagedSkillAgentProjectionState::Occupied
    })
}

fn build_local_skill(skill_id: &str) -> LocalSkill {
    build_local_skill_with(skill_id, None)
}

/// `maintained` is the history view the list maintenance just validated for
/// this Skill. It is reused only while the sidecar on disk still carries
/// exactly that metadata **and** the repository still points at the same HEAD
/// (the Skill lock was released in between, so an external checkout/commit may
/// have moved it); otherwise, or when maintenance was skipped, the history is
/// read once here.
fn build_local_skill_with(
    skill_id: &str,
    maintained: Option<crate::version_policy::NormalizedView>,
) -> LocalSkill {
    let root = skill_path(skill_id);
    let (profile, profile_invalid) = match read_profile_at_path(&root) {
        Ok(profile) => (profile, false),
        Err(_) => (SkillHubProfile::default(), true),
    };
    let profile = if crate::spaces::current_profile_matches(&profile).unwrap_or(false) {
        profile
    } else {
        crate::spaces::local_view(profile)
    };
    let view = reusable_version_view(&root, maintained, &profile.version_metadata);
    let versions = view
        .as_ref()
        .map(|view| git_versions_from_view(&root, view))
        .unwrap_or_default();
    let mapped_current = view.as_ref().and_then(|view| view.mapped_current.clone());
    let saved = view.as_ref().and_then(|view| view.saved.clone());
    let current = if profile.is_system {
        profile.version.clone()
    } else {
        saved.as_ref().map(|m| m.label.clone()).unwrap_or_default()
    };
    let projection_name =
        projection_name_from_profile(skill_id, &profile).unwrap_or_else(|_| skill_id.to_string());
    let (has_working_copy, working_copy_changes, working_copy_hash) =
        working_copy_state_for_path(&skill_path(skill_id));
    let (trigger, fit_scenarios, compatible_agents) = profile_runtime_metadata(&profile);
    let team_ids = profile_team_ids(&profile);
    let acquisition_source = profile_acquisition_source(&profile);

    // Detect agent status via symlinks
    let home = crate::user_home_dir().unwrap_or_default();
    let agents: HashMap<String, Option<String>> = crate::known_agents()
        .iter()
        .map(|(key, _, rel_dir)| {
            let link = home.join(rel_dir).join(&projection_name);
            let status = match managed_skill_agent_projection_state_at(
                &link,
                &skillhub_dir(),
                &skills_dir(),
                skill_id,
            ) {
                Ok(ManagedSkillAgentProjectionState::Missing) => None,
                Ok(ManagedSkillAgentProjectionState::Installed) => Some("on".to_string()),
                Ok(ManagedSkillAgentProjectionState::Occupied) | Err(_) => {
                    Some("broken".to_string())
                }
            };
            (key.to_string(), status)
        })
        .collect();

    let installed = agents
        .values()
        .any(|value| matches!(value.as_deref(), Some("on") | Some("off")));

    let active_account = crate::runtime_env::active_runtime_user_id();
    let avatar_local_id = if profile.is_system {
        Some(crate::system_skill::SYSTEM_MANAGER_ID.to_string())
    } else {
        profile.avatar_local_id.clone()
    };
    let avatar = active_account
        .as_deref()
        .zip(avatar_local_id.as_deref())
        .and_then(|(account, id)| avatar_cache_path(account, id).ok())
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str::<SkillAvatarCache>(&json).ok());
    // A key is configured when this Skill has its own value or the account
    // key vault holds one under that name or as an alias (names only;
    // consent is reported by the policy rows).
    let vault_keys = if profile.env_dependencies.is_empty() {
        BTreeMap::new()
    } else {
        active_account
            .as_deref()
            .and_then(|user_id| {
                crate::key_vault::vault_lookup_names_for_skill_at(
                    &crate::runtime_env::runtime_session_snapshot()
                        .ok()?
                        .storage_root(&skillhub_dir()),
                    user_id,
                    skill_id,
                )
                .ok()
            })
            .unwrap_or_default()
    };
    let env_deps: Vec<EnvDep> = profile
        .env_dependencies
        .iter()
        .map(|e| {
            let env_file = active_account
                .as_deref()
                .and_then(|user_id| crate::runtime_env::account_env_path(user_id, skill_id).ok());
            let configured = vault_keys.contains_key(&e.key)
                || env_file.is_some_and(|env_file| {
                    fs::read_to_string(&env_file)
                        .is_ok_and(|contents| env_contents_has_key(&contents, &e.key))
                });
            EnvDep {
                key: e.key.clone(),
                description: e.description.clone(),
                required: e.required,
                configured,
                share_policy: e.share_policy.clone(),
                shared_teams: e.shared_teams.clone(),
                origin: e.origin.clone(),
                confidence: e.confidence.clone(),
                obtain: e.obtain.clone(),
                pending: e.pending,
            }
        })
        .collect();

    let mapped = mapped_current.as_ref();
    let receipt = mapped.and_then(|m| m.receipt.as_ref()).filter(|_| {
        profile.library_account_id == active_account
            && profile.version_metadata.account_id == active_account
            && profile.version_metadata.entry_id == profile.library_entry_id
    });
    LocalSkill {
        version_problem: None,
        version_status: if profile.is_system {
            "local"
        } else if receipt.is_some() {
            "confirmed"
        } else if profile.library_account_id.is_some()
            && profile.library_account_id == active_account
            && mapped.is_some_and(|m| m.pending.is_some())
        {
            "pending"
        } else if saved.is_some() {
            "local"
        } else {
            "unversioned"
        }
        .into(),
        version_receipt_id: receipt.map(|r| r.receipt_id.clone()),
        formal_version_id: receipt.and_then(|r| r.formal_version_id.clone()),
        formal_label: receipt.and_then(|r| r.formal_label.clone()),
        id: skill_id.to_string(),
        name: projection_name,
        display_name: profile
            .display_name
            .clone()
            .unwrap_or_else(|| skill_id.to_string()),
        description: profile.description.clone(),
        source_url: crate::sanitize_source_url(profile.source_url.as_deref()),
        avatar_local_id,
        avatar_url: avatar.as_ref().and_then(|value| value.avatar_url.clone()),
        avatar_status: avatar.map(|value| value.avatar_status),
        avatar_account_user_id: active_account.clone(),
        category: profile.category.clone(),
        labels: profile.labels.clone(),
        version: current.clone(),
        latest_version: current.clone(),
        install_count: profile.install_count,
        sources: if profile.is_system {
            vec!["SkillHub 内置".into()]
        } else {
            vec![acquisition_source_label(acquisition_source).to_string()]
        },
        agents,
        installed,
        is_own: profile.catalog_origin.is_none() && profile.is_own.unwrap_or(true),
        is_system: profile.is_system,
        system_version: profile.system_version.clone(),
        integrity_status: profile.is_system.then(|| {
            if system_manager_files_are_current_at(&skills_dir()) {
                "healthy".into()
            } else {
                "repairRequired".into()
            }
        }),
        acquisition_source,
        acquisition_package_sha256: profile.acquisition_package_sha256.clone(),
        marketplace_replacement_recovery_id: None,
        undeclared_env_suggestions: Vec::new(),
        team_shared_from: profile.team_shared_from.clone(),
        env_deps,
        shared_to: team_ids
            .iter()
            .map(|team_id| {
                (
                    team_id.clone(),
                    SharedSkillState {
                        version: current.clone(),
                        env_shared: false,
                    },
                )
            })
            .collect(),
        versions,
        trigger,
        fit_scenarios,
        unfit_scenarios: vec![],
        compatible_agents,
        is_orphan: profile_invalid,
        has_working_copy,
        working_copy_changes,
        working_copy_hash,
        created_at: profile.created_at.clone(),
        updated_at: profile.updated_at.clone(),
        local_path: skill_path(skill_id).to_string_lossy().to_string(),
        catalog_origin: profile.catalog_origin.clone(),
        acquisition_version: profile.acquisition_version.clone(),
        server_id: profile.server_id.clone(),
        server_owner_id: profile
            .server_owner_id
            .clone()
            .or_else(|| profile.author.clone()),
        library_account_id: profile.library_account_id.clone(),
        library_entry_id: profile.library_entry_id.clone(),
        added_by_account_id: profile.added_by_account_id.clone(),
    }
}

type AgentInstallTarget = (String, String, PathBuf);

fn resolve_install_targets(
    home: &Path,
    projection_name: &str,
    agents: &[String],
) -> Result<Vec<AgentInstallTarget>, String> {
    if agents.is_empty() {
        return Err("请至少选择一个 Agent".into());
    }
    resolve_install_targets_with(
        home,
        projection_name,
        agents,
        &crate::known_agents(),
        &crate::detect_agents(),
    )
}

fn resolve_install_targets_with(
    home: &Path,
    projection_name: &str,
    agents: &[String],
    known: &[(&'static str, &'static str, &'static str)],
    detected_agents: &[AgentInfo],
) -> Result<Vec<AgentInstallTarget>, String> {
    let mut seen = HashSet::new();
    let mut targets = Vec::new();
    for agent_key in agents {
        if !seen.insert(agent_key.clone()) {
            continue;
        }
        let (_, agent_name, relative) = known
            .iter()
            .find(|(key, _, _)| *key == agent_key.as_str())
            .ok_or_else(|| format!("未知 Agent：{agent_key}"))?;
        if !detected_agents
            .iter()
            .any(|agent| agent.key == *agent_key && agent.detected)
        {
            return Err(format!("本机未检测到 {agent_name}，无法创建安装投影"));
        }
        if let Some(refusal) = crate::skill_write_refusal(agent_key, agent_name, detected_agents) {
            return Err(refusal);
        }
        targets.push((
            agent_key.clone(),
            agent_name.to_string(),
            home.join(relative).join(projection_name),
        ));
    }
    Ok(targets)
}

fn build_install_preflight_for_targets(
    skillhub_root: &Path,
    managed_root: &Path,
    source_root: &Path,
    generated_source: &Path,
    skill_id: &str,
    targets: &[AgentInstallTarget],
) -> Result<ImportSkillPreflight, String> {
    let canonical_source = fs::canonicalize(source_root)
        .map_err(|error| format!("无法读取 SkillHub 托管资产：{error}"))?;
    let selected_fingerprint = fingerprint_hex(&canonical_source)
        .map_err(|error| format!("无法检查 SkillHub 托管内容：{error}"))?;
    let selected_path = canonical_source.to_string_lossy().to_string();
    let canonical_skillhub_root =
        fs::canonicalize(skillhub_root).unwrap_or_else(|_| skillhub_root.to_path_buf());
    let canonical_managed_root =
        fs::canonicalize(managed_root).unwrap_or_else(|_| managed_root.to_path_buf());
    let mut sources = Vec::new();
    let mut digest = Sha256::new();
    update_plan_digest_field(&mut digest, "skillhub-install-plan-v1");
    update_plan_digest_field(&mut digest, skill_id);
    update_plan_digest_field(&mut digest, &selected_path);
    update_plan_digest_field(&mut digest, &selected_fingerprint);

    for (agent_key, agent_name, target) in targets {
        let target_text = target.to_string_lossy().to_string();
        update_plan_digest_field(&mut digest, agent_key);
        update_plan_digest_field(&mut digest, agent_name);
        update_plan_digest_field(&mut digest, &target_text);
        let metadata = match fs::symlink_metadata(target) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                update_plan_digest_field(&mut digest, "missing");
                continue;
            }
            Err(error) => {
                return Err(format!("无法检查 {agent_name} 中的同名 Skill：{error}"));
            }
        };

        let owned_marker = projection_marker_for_link_at(target, skillhub_root, managed_root);
        if is_symlink_to_path(target, source_root)
            || is_symlink_to_path(target, generated_source)
            || owned_marker
                .as_ref()
                .is_some_and(|(marker, _)| marker.skill_id == skill_id)
        {
            update_plan_digest_field(&mut digest, "managed");
            continue;
        }
        if let Some((marker, _)) = owned_marker {
            return Err(format!(
                "{agent_name} 中的同名位置已由另一个 SkillHub 资产（{}）使用，请先处理该资产",
                marker.skill_id
            ));
        }
        if !metadata.is_dir() && !metadata.file_type().is_symlink() {
            return Err(format!(
                "{agent_name} 中存在同名文件，无法安全安装：{}",
                target.display()
            ));
        }
        let canonical_target = fs::canonicalize(target).map_err(|error| {
            format!(
                "{agent_name} 中的同名 Skill 无法读取，请先在文件管理器中检查：{}（{error}）",
                target.display()
            )
        })?;
        if canonical_target.starts_with(&canonical_skillhub_root)
            && !canonical_target.starts_with(canonical_managed_root.join(skill_id))
        {
            return Err(format!(
                "{agent_name} 中的同名链接指向另一个 SkillHub 内部位置，已拒绝覆盖"
            ));
        }
        if !canonical_target.is_dir() {
            return Err(format!("{agent_name} 中的同名 Skill 不是目录，已拒绝覆盖"));
        }
        let fingerprint = fingerprint_hex(&canonical_target)
            .map_err(|error| format!("无法比较 {agent_name} 中的同名 Skill：{error}"))?;
        let matches_selected = fingerprint == selected_fingerprint;
        update_plan_digest_field(
            &mut digest,
            if matches_selected {
                "matching-adoption"
            } else {
                "conflicting-adoption"
            },
        );
        update_plan_digest_field(&mut digest, &canonical_target.to_string_lossy());
        update_plan_digest_field(&mut digest, &fingerprint);
        sources.push(ImportSkillSource {
            agent_key: agent_key.clone(),
            agent_name: agent_name.clone(),
            entry_name: target
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(skill_id)
                .to_string(),
            path: target_text,
            canonical_path: canonical_target.to_string_lossy().to_string(),
            fingerprint,
            matches_selected,
            selected: false,
        });
    }

    Ok(ImportSkillPreflight {
        skill_id: skill_id.to_string(),
        selected_path,
        selected_fingerprint,
        has_conflicts: sources.iter().any(|source| !source.matches_selected),
        sources,
        plan_digest: format!("{:x}", digest.finalize()),
    })
}

fn install_preflight_for_request(
    skill_id: &str,
    agents: &[String],
) -> Result<(ImportSkillPreflight, Vec<PathBuf>), String> {
    validate_skill_id(skill_id)?;
    let canonical_source = skill_path(skill_id);
    if !canonical_source.is_dir() {
        return Err(format!("SkillHub 中不存在这个本机资产：{skill_id}"));
    }
    let home = crate::user_home_dir().ok_or("无法读取用户目录")?;
    let projection_name = skill_projection_name(skill_id)?;
    let targets = resolve_install_targets(&home, &projection_name, agents)?;
    let target_paths = targets
        .iter()
        .map(|(_, _, target)| target.clone())
        .collect::<Vec<_>>();
    let generated_source = projection_root_at(&skillhub_dir(), skill_id).join("current");
    let plan = build_install_preflight_for_targets(
        &skillhub_dir(),
        &skills_dir(),
        &canonical_source,
        &generated_source,
        skill_id,
        &targets,
    )?;
    Ok((plan, target_paths))
}

fn validate_preflight_confirmation(
    plan: &ImportSkillPreflight,
    replace_conflicts: Option<bool>,
    plan_digest: Option<&str>,
) -> Result<(), String> {
    if !plan.sources.is_empty() && plan_digest != Some(plan.plan_digest.as_str()) {
        return Err("Agent 中的同名 Skill 尚未确认或确认后发生变化，请重新确认".into());
    }
    if plan.has_conflicts && replace_conflicts != Some(true) {
        return Err("存在内容不同的同名 Skill，请确认备份并使用当前 SkillHub 版本".into());
    }
    if let Some(expected_digest) = plan_digest {
        if expected_digest != plan.plan_digest {
            return Err("Agent 安装状态在确认后发生变化，请重新确认".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn preflight_install_skill(
    skill_id: String,
    agents: Vec<String>,
) -> Result<ImportSkillPreflight, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_preflight_for_request(&skill_id, &agents).map(|(plan, _)| plan)
    })
    .await
    .map_err(|error| format!("Skill 安装检查任务异常结束：{error}"))?
}

/// Install a skill by projecting it into each selected Agent. Same-name native
/// directories are backed up before replacement and remain restorable.
fn install_skill_blocking(
    skill_id: String,
    agents: Vec<String>,
    replace_conflicts: Option<bool>,
    plan_digest: Option<String>,
) -> Result<(), String> {
    validate_skill_id(&skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    let canonical_src = skill_path(&skill_id);
    if !canonical_src.is_dir() {
        return Err(format!("SkillHub 中不存在这个本机资产：{skill_id}"));
    }
    let (confirmed_plan, targets) = install_preflight_for_request(&skill_id, &agents)?;
    validate_preflight_confirmation(&confirmed_plan, replace_conflicts, plan_digest.as_deref())?;

    let src = refresh_skill_projection(&skill_id)?;
    let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
    for link in &targets {
        migrate_agent_projection_link(link, &canonical_src, &src, &skillhub_dir())?;
    }

    let (current_plan, _) = install_preflight_for_request(&skill_id, &agents)?;
    if current_plan.plan_digest != confirmed_plan.plan_digest {
        return Err("Agent 安装状态在执行前发生变化，请重新确认".into());
    }

    let mut adoption_backup: Option<PathBuf> = None;
    if !current_plan.sources.is_empty() {
        let backups_root = skillhub_dir().join("adoption-backups");
        fs::create_dir_all(&backups_root).map_err(|error| error.to_string())?;
        fs::set_permissions(&backups_root, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
        let backup_dir = backups_root.join(uuid::Uuid::new_v4().to_string());
        adopt_agent_sources_with(
            &canonical_src,
            &canonical_src,
            &src,
            &backup_dir,
            &current_plan,
            false,
            |target, link| unix_fs::symlink(target, link).map_err(|error| error.to_string()),
        )?;
        adoption_backup = Some(backup_dir);
    }

    let install_result = install_skill_projections_with(&src, targets, |source, link| {
        unix_fs::symlink(source, link).map_err(|error| error.to_string())
    });
    if let Err(error) = install_result {
        if let Some(backup_dir) = adoption_backup {
            let manifest = backup_dir.join("manifest.json");
            return match restore_adoption_item_at(&home, &backup_dir, &manifest) {
                Ok(()) => Err(format!("{error}；已恢复安装前的 Agent 同名目录")),
                Err(rollback_error) => Err(format!(
                    "{error}；Agent 同名目录自动恢复未完成，请在设置的回收站处理：{rollback_error}"
                )),
            };
        }
        return Err(error);
    }
    // The explicit user install may have created an Agent's Skill directory.
    // Only now is the bundled Manager allowed to project into that directory.
    // A later startup will retry if this best-effort repair is interrupted.
    let _ = repair_system_manager();
    Ok(())
}

#[tauri::command]
pub async fn install_skill(
    skill_id: String,
    agents: Vec<String>,
    replace_conflicts: Option<bool>,
    plan_digest: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_skill_blocking(skill_id, agents, replace_conflicts, plan_digest)
    })
    .await
    .map_err(|error| format!("Skill 安装任务异常结束：{error}"))?
}

fn rollback_created_projections(created: &[PathBuf], source: &Path) -> Vec<String> {
    let mut failures = Vec::new();
    for link in created.iter().rev() {
        match fs::symlink_metadata(link) {
            Ok(metadata)
                if metadata.file_type().is_symlink() && is_symlink_to_path(link, source) =>
            {
                if let Err(error) = crate::platform_fs::remove_link(link) {
                    failures.push(format!("{}: {error}", link.display()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => failures.push(format!(
                "{} changed during install; refused to remove it",
                link.display()
            )),
            Err(error) => failures.push(format!("{}: {error}", link.display())),
        }
    }
    failures
}

fn install_skill_projections_with<F>(
    source: &Path,
    targets: Vec<PathBuf>,
    mut create_projection: F,
) -> Result<(), String>
where
    F: FnMut(&Path, &Path) -> Result<(), String>,
{
    let mut unique_targets = HashSet::new();
    let mut pending = Vec::new();
    for link in targets {
        if !unique_targets.insert(link.clone()) {
            continue;
        }
        match fs::symlink_metadata(&link) {
            Ok(metadata)
                if metadata.file_type().is_symlink() && is_symlink_to_path(&link, source) => {}
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    let managed_root = source.parent().unwrap_or_else(|| Path::new(""));
                    if fs::canonicalize(&link)
                        .ok()
                        .and_then(|target| target.parent().map(Path::to_path_buf))
                        == fs::canonicalize(managed_root).ok()
                    {
                        return Err(format!(
                            "Agent 投影名冲突：{} 已属于另一个 SkillHub 资产。请先停用该资产，或为其中一个资产使用不同的投影名。",
                            link.display()
                        ));
                    }
                }
                return Err(format!(
                    "Refusing to overwrite non-SkillHub item: {}",
                    link.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => pending.push(link),
            Err(error) => {
                return Err(format!(
                    "Cannot inspect Agent projection {}: {error}",
                    link.display()
                ));
            }
        }
    }

    let mut created = Vec::new();
    for link in pending {
        if let Some(agent_dir) = link.parent() {
            if let Err(error) = fs::create_dir_all(agent_dir) {
                let rollback = rollback_created_projections(&created, source);
                return Err(projection_transaction_error(
                    format!("Cannot create Agent Skill directory: {error}"),
                    rollback,
                ));
            }
        }
        if let Err(error) = create_projection(source, &link) {
            if is_symlink_to_path(&link, source) {
                created.push(link.clone());
            }
            let rollback = rollback_created_projections(&created, source);
            return Err(projection_transaction_error(error, rollback));
        }
        if !is_symlink_to_path(&link, source) {
            let rollback = rollback_created_projections(&created, source);
            return Err(projection_transaction_error(
                format!(
                    "Projection was not created at the expected target: {}",
                    link.display()
                ),
                rollback,
            ));
        }
        created.push(link);
    }
    Ok(())
}

fn projection_transaction_error(error: String, rollback_failures: Vec<String>) -> String {
    if rollback_failures.is_empty() {
        return error;
    }
    format!(
        "{error}; projection rollback was incomplete: {}",
        rollback_failures.join("; ")
    )
}

/// Uninstall — remove all symlinks, keep local files
#[tauri::command]
pub fn uninstall_skill(skill_id: String) -> Result<(), String> {
    validate_skill_id(&skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
    uninstall_skill_projections(&home, &skills_dir(), &skill_id)
}

fn uninstall_skill_projections(
    home: &Path,
    managed_root: &Path,
    skill_id: &str,
) -> Result<(), String> {
    let canonical = managed_root.join(skill_id);
    let skillhub_root = managed_root
        .parent()
        .ok_or("Cannot resolve SkillHub directory")?;
    let projection_current = projection_root_at(skillhub_root, skill_id).join("current");
    let has_generated_projection = fs::symlink_metadata(&projection_current).is_ok();
    if has_generated_projection {
        reconcile_skill_projection_at(skillhub_root, managed_root, skill_id)?;
    }
    let generated = if has_generated_projection {
        projection_current
    } else {
        canonical.clone()
    };
    let projection_name = projection_name_at_root(managed_root, skill_id)?;
    let links: Vec<PathBuf> = crate::managed_projection_dirs()
        .into_iter()
        .map(|relative| home.join(relative).join(&projection_name))
        // A same-name native Skill belongs to the user and is not part of this
        // uninstall. Remove only projections that are provably ours.
        .filter(|link| {
            matches!(
                managed_skill_agent_projection_state_at(
                    link,
                    skillhub_root,
                    managed_root,
                    skill_id,
                ),
                Ok(ManagedSkillAgentProjectionState::Installed)
            )
        })
        .collect();
    let expected_targets = vec![canonical, generated.clone()];
    uninstall_projection_links_with(
        &generated,
        links,
        |link| remove_owned_symlink_atomically(link, &expected_targets, skillhub_root),
        |source, link| unix_fs::symlink(source, link).map_err(|error| error.to_string()),
    )
}

fn rollback_removed_projections<F>(
    removed: &[PathBuf],
    source: &Path,
    restore_projection: &mut F,
) -> Vec<String>
where
    F: FnMut(&Path, &Path) -> Result<(), String>,
{
    let mut failures = Vec::new();
    for link in removed.iter().rev() {
        match fs::symlink_metadata(link) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if let Err(error) = restore_projection(source, link) {
                    failures.push(format!("{}: {error}", link.display()));
                }
            }
            Ok(metadata)
                if metadata.file_type().is_symlink() && is_symlink_to_path(link, source) => {}
            Ok(_) => failures.push(format!(
                "{} changed during uninstall; refused to overwrite it",
                link.display()
            )),
            Err(error) => failures.push(format!("{}: {error}", link.display())),
        }
    }
    failures
}

fn uninstall_projection_links_with<R, S>(
    source: &Path,
    links: Vec<PathBuf>,
    mut remove_projection: R,
    mut restore_projection: S,
) -> Result<(), String>
where
    R: FnMut(&Path) -> Result<(), String>,
    S: FnMut(&Path, &Path) -> Result<(), String>,
{
    let mut removed = Vec::new();
    for link in links {
        if let Err(error) = remove_projection(&link) {
            match fs::symlink_metadata(&link) {
                Err(reason) if reason.kind() == std::io::ErrorKind::NotFound => {
                    removed.push(link.clone());
                }
                Ok(metadata)
                    if metadata.file_type().is_symlink() && is_symlink_to_path(&link, source) => {}
                Ok(_) => {}
                Err(reason) => {
                    let rollback =
                        rollback_removed_projections(&removed, source, &mut restore_projection);
                    return Err(projection_transaction_error(
                        format!("{error}; cannot inspect {}: {reason}", link.display()),
                        rollback,
                    ));
                }
            }
            let rollback = rollback_removed_projections(&removed, source, &mut restore_projection);
            return Err(projection_transaction_error(error, rollback));
        }
        removed.push(link);
    }
    Ok(())
}

/// Remove a managed Skill from the active library without irreversibly
/// destroying the user's files. The asset is moved into SkillHub's private
/// trash so support can recover it if a later server-side operation fails.
fn account_env_paths_for_skill(skill_id: &str) -> Result<Vec<PathBuf>, String> {
    let session = crate::runtime_env::runtime_session_snapshot()?;
    let root = session.storage_root(&skillhub_dir()).join("envs");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let root_metadata = fs::symlink_metadata(&root).map_err(|error| error.to_string())?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("环境变量根目录必须是真实目录".into());
    }
    let mut paths = Vec::new();
    let legacy = root.join(format!("{skill_id}.env"));
    if session.space_id() == "official" && legacy.exists() {
        let metadata = fs::symlink_metadata(&legacy).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Refusing to delete a symbolic-link environment file".into());
        }
        paths.push(legacy);
    }
    for entry in fs::read_dir(&root)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        let user_id = entry.file_name().to_string_lossy().to_string();
        if user_id != session.user_id() || uuid::Uuid::parse_str(&user_id).is_err() {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("账号环境变量目录必须是真实目录".into());
        }
        let path = entry.path().join(format!("{skill_id}.env"));
        if path.exists() {
            let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("Refusing to delete a symbolic-link environment file".into());
            }
            paths.push(path);
        }
    }
    Ok(paths)
}

/// Moves a managed Skill to the local recycle bin. Holds the per-Skill lock.
/// A Skill in the signed-in account's synced library is refused: removing
/// only this copy is not a thing any more (#91), it is deleted from the
/// account instead.
#[tauri::command]
pub fn delete_managed_skill(skill_id: String) -> Result<String, String> {
    validate_skill_id(&skill_id)?;
    let _lock = crate::skill_lock::lock_skill_dir(&skill_id)?;
    if read_profile_result(&skill_id)
        .ok()
        .as_ref()
        .is_some_and(crate::library_sync::synced_to_signed_in_account)
    {
        return Err(crate::library_sync::SYNCED_DEVICE_DELETE_REFUSED.into());
    }
    delete_managed_skill_unlocked(skill_id)
}

/// The caller holds the Skill lock (account sync already does).
fn delete_managed_skill_unlocked(skill_id: String) -> Result<String, String> {
    validate_skill_id(&skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    let profile = read_profile_result(&skill_id)?;
    let _session = version_session_lease(&profile)?;
    let display_name = read_profile_result(&skill_id)
        .ok()
        .and_then(|profile| profile.display_name)
        .unwrap_or_else(|| skill_id.clone());
    let skillhub_root = skillhub_dir();
    let managed_root = skills_dir();
    let source = skill_path(&skill_id);
    let source_metadata = fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
    if !source_metadata.is_dir() || source_metadata.file_type().is_symlink() {
        return Err("Skill asset must be a real directory".into());
    }

    reconcile_skill_projection_at(&skillhub_root, &managed_root, &skill_id)?;
    let env_paths = account_env_paths_for_skill(&skill_id)?;
    let env_recovery_entries = env_paths
        .iter()
        .enumerate()
        .map(|(index, path)| {
            let original = path
                .strip_prefix(&skillhub_root)
                .map_err(|_| "环境变量文件不在 SkillHub 私有目录内")?;
            Ok(serde_json::json!({
                "recoveryPath": format!("env/{index}.env"),
                "originalRelativePath": original.to_string_lossy(),
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let projection_root = projection_root_at(&skillhub_root, &skill_id);
    let has_projection = fs::symlink_metadata(&projection_root).is_ok();
    if has_projection {
        validate_private_projection_directory(&projection_root, "待删除 Skill 投影目录")?;
    }

    let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
    let projection_name = skill_projection_name(&skill_id)?;
    let active_links = crate::managed_projection_dirs()
        .into_iter()
        .filter_map(|relative| {
            let link = home.join(relative).join(&projection_name);
            if !is_symlink_to_skill(&link, &skill_id) {
                return None;
            }
            fs::read_link(&link).ok().map(|target| (link, target))
        })
        .collect::<Vec<_>>();

    let trash_root = skillhub_root.join("trash");
    fs::create_dir_all(&trash_root).map_err(|error| error.to_string())?;
    fs::set_permissions(&trash_root, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    validate_private_projection_directory(&trash_root, "SkillHub 回收目录")?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let transaction = trash_root.join(format!("{skill_id}-{timestamp}-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&transaction).map_err(|error| error.to_string())?;
    fs::set_permissions(&transaction, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let env_recovery = transaction.join("env");
    fs::create_dir(&env_recovery).map_err(|error| error.to_string())?;
    fs::set_permissions(&env_recovery, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let recovery_manifest = transaction.join("recovery-manifest.json");
    let manifest = serde_json::json!({
        "version": 2,
        "kind": "managed_asset",
        "status": "trashed",
        "createdAt": u64::try_from(timestamp / 1000).unwrap_or(0),
        "skillId": skill_id.clone(),
        "displayName": display_name,
        "skillRecoveryPath": "skill",
        "projectionRecoveryPath": has_projection.then_some("projection"),
        "envFiles": env_recovery_entries,
    });
    write_private_file(
        &recovery_manifest,
        &serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?,
    )?;

    // This performs a complete preflight and reconciliation before removing
    // any Agent-visible projection. All staging destinations already exist, so
    // later work is limited to same-volume atomic renames.
    if let Err(error) = uninstall_skill(skill_id.clone()) {
        let _ = fs::remove_file(&recovery_manifest);
        let _ = fs::remove_dir(&env_recovery);
        let _ = fs::remove_dir(&transaction);
        return Err(error);
    }

    let destination = transaction.join("skill");
    let mut moved = Vec::<(PathBuf, PathBuf)>::new();
    let stage_result = (|| -> Result<(), String> {
        rename_noreplace(&source, &destination).map_err(|error| error.to_string())?;
        moved.push((source.clone(), destination.clone()));
        if has_projection {
            let recovered_projection = transaction.join("projection");
            rename_noreplace(&projection_root, &recovered_projection)
                .map_err(|error| error.to_string())?;
            moved.push((projection_root.clone(), recovered_projection));
        }
        for (index, env_path) in env_paths.iter().enumerate() {
            let recovered_env = env_recovery.join(format!("{index}.env"));
            rename_noreplace(env_path, &recovered_env).map_err(|error| error.to_string())?;
            moved.push((env_path.clone(), recovered_env));
        }
        if let Ok(directory) = fs::File::open(&transaction) {
            directory.sync_all().map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    if let Err(error) = stage_result {
        let mut rollback_failures = Vec::new();
        for (original, recovered) in moved.iter().rev() {
            if let Err(reason) = rename_noreplace(recovered, original) {
                rollback_failures.push(format!(
                    "{} 仍保留在 {}: {reason}",
                    original.display(),
                    recovered.display()
                ));
            }
        }
        for (link, target) in &active_links {
            match fs::symlink_metadata(link) {
                Err(reason) if reason.kind() == std::io::ErrorKind::NotFound => {
                    if let Err(reason) = unix_fs::symlink(target, link) {
                        rollback_failures.push(format!("{}: {reason}", link.display()));
                    }
                }
                Ok(_) => rollback_failures
                    .push(format!("{} 在删除回滚期间已被占用，未覆盖", link.display())),
                Err(reason) => rollback_failures.push(format!("{}: {reason}", link.display())),
            }
        }
        if rollback_failures.is_empty() {
            let _ = fs::remove_file(&recovery_manifest);
            let _ = fs::remove_dir(&env_recovery);
            let _ = fs::remove_dir(&transaction);
            return Err(format!("本地删除事务失败，已完整恢复: {error}"));
        }
        return Err(format!(
            "本地删除事务失败: {error}; 回滚不完整: {}",
            rollback_failures.join("; ")
        ));
    }
    Ok(transaction.to_string_lossy().to_string())
}

fn read_recovery_manifest(path: &Path) -> Result<serde_json::Value, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("无法读取回收站记录 {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err(format!("回收站记录不是安全的普通文件: {}", path.display()));
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| format!("回收站记录已损坏: {error}"))
}

fn recovery_created_at(directory: &Path, manifest: &serde_json::Value) -> u64 {
    manifest
        .get("createdAt")
        .and_then(serde_json::Value::as_u64)
        .or_else(|| {
            fs::metadata(directory)
                .ok()?
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|duration| duration.as_secs())
        })
        .unwrap_or(0)
}

fn recovery_id_segment(value: &str) -> Result<&str, String> {
    let valid = value != "."
        && value != ".."
        && !value.is_empty()
        && value.len() <= 255
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(value)
    } else {
        Err("回收站项目标识无效".into())
    }
}

fn recovery_directory_at(root: &Path, segment: &str) -> Result<PathBuf, String> {
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("无法读取回收站目录 {}: {error}", root.display()))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("回收站根目录不是安全目录".into());
    }
    let directory = root.join(segment);
    if directory.parent() != Some(root) {
        return Err("回收站项目不在允许的直属目录中".into());
    }
    let metadata = fs::symlink_metadata(&directory)
        .map_err(|error| format!("无法读取回收站项目 {}: {error}", directory.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("回收站项目不是安全目录".into());
    }
    Ok(directory)
}

fn resolve_recovery_item_at(root: &Path, id: &str) -> Result<(String, PathBuf, PathBuf), String> {
    let (kind, segment) = id.split_once(':').ok_or("回收站项目标识无效")?;
    let segment = recovery_id_segment(segment)?;
    match kind {
        "adoption" => {
            let directory = recovery_directory_at(&root.join("adoption-backups"), segment)?;
            Ok((
                kind.into(),
                directory.clone(),
                directory.join("manifest.json"),
            ))
        }
        "managed" => {
            let directory = recovery_directory_at(&root.join("trash"), segment)?;
            Ok((
                kind.into(),
                directory.clone(),
                directory.join("recovery-manifest.json"),
            ))
        }
        _ => Err("未知的回收站项目类型".into()),
    }
}

fn resolve_recovery_item(id: &str) -> Result<(String, PathBuf, PathBuf), String> {
    resolve_recovery_item_at(&skillhub_dir(), id)
}

fn profile_from_recovered_skill(directory: &Path) -> Option<SkillHubProfile> {
    let path = directory.join("skill/.skillhub.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str::<SkillHubJson>(&contents).ok())
        .and_then(|json| json.skillhub)
}

fn display_name_from_recovered_skill(directory: &Path, skill_id: &str) -> String {
    profile_from_recovered_skill(directory)
        .and_then(|profile| profile.display_name)
        .unwrap_or_else(|| skill_id.to_string())
}

fn adoption_status_can_restore(status: &str) -> bool {
    matches!(status, "complete" | "in_progress" | "rollback_incomplete")
}

fn adoption_backup_path_is_safe(entries_root: &Path, backup: &Path) -> bool {
    backup.is_absolute()
        && !backup.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
        && backup.parent() == Some(entries_root)
}

fn adoption_manifest_has_backup(directory: &Path, manifest: &serde_json::Value) -> bool {
    let status = manifest
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    if !adoption_status_can_restore(status) {
        return false;
    }
    let entries_root = directory.join("entries");
    if !fs::symlink_metadata(&entries_root)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    {
        return false;
    }
    manifest
        .get("sources")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|sources| {
            sources.iter().any(|source| {
                let Some(path) = source.get("backup").and_then(serde_json::Value::as_str) else {
                    return false;
                };
                let backup = PathBuf::from(path);
                adoption_backup_path_is_safe(&entries_root, &backup)
                    && fs::symlink_metadata(&backup).is_ok_and(|metadata| {
                        metadata.is_dir() || metadata.file_type().is_symlink()
                    })
            })
        })
}

fn managed_recovery_is_restorable(directory: &Path, status: &str, reason: Option<&str>) -> bool {
    directory.join("skill").exists()
        && (status == "trashed"
            || (status == "in_progress" && reason == Some("marketplace_version_replacement")))
}

#[tauri::command]
pub async fn list_trash_items_async() -> Result<Vec<TrashItem>, String> {
    tauri::async_runtime::spawn_blocking(list_trash_items)
        .await
        .map_err(|error| error.to_string())?
}

pub fn list_trash_items() -> Result<Vec<TrashItem>, String> {
    let root = skillhub_dir();
    let mut items = Vec::new();
    let adoption_root = root.join("adoption-backups");
    if let Ok(entries) = fs::read_dir(&adoption_root) {
        for entry in entries.flatten() {
            let directory = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&directory) else {
                continue;
            };
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let manifest_path = directory.join("manifest.json");
            let Ok(manifest) = read_recovery_manifest(&manifest_path) else {
                continue;
            };
            let status = manifest
                .get("status")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let sources = manifest
                .get("sources")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            let destination = manifest
                .get("destination")
                .and_then(serde_json::Value::as_str)
                .map(PathBuf::from);
            let skill_id = manifest
                .get("skillId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    destination
                        .as_ref()?
                        .file_name()?
                        .to_str()
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "unknown".into());
            let display_name = manifest
                .get("displayName")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&skill_id)
                .to_string();
            let restorable = adoption_manifest_has_backup(&directory, &manifest);
            let segment = entry.file_name().to_string_lossy().to_string();
            items.push(TrashItem {
                id: format!("adoption:{segment}"),
                kind: manifest
                    .get("kind")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("agent_adoption")
                    .to_string(),
                skill_id,
                display_name,
                created_at: recovery_created_at(&directory, &manifest),
                status,
                reason: manifest
                    .get("reason")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                source_count: sources.len(),
                restorable,
                location: directory.to_string_lossy().to_string(),
                server_id: None,
                server_owner_id: None,
            });
        }
    }

    let managed_root = root.join("trash");
    if let Ok(entries) = fs::read_dir(&managed_root) {
        for entry in entries.flatten() {
            let directory = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&directory) else {
                continue;
            };
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let Ok(manifest) = read_recovery_manifest(&directory.join("recovery-manifest.json"))
            else {
                continue;
            };
            let skill_id = manifest
                .get("skillId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let status = manifest
                .get("status")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("trashed")
                .to_string();
            let reason = manifest
                .get("reason")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let segment = entry.file_name().to_string_lossy().to_string();
            let recovered_profile = profile_from_recovered_skill(&directory);
            let restorable = managed_recovery_is_restorable(&directory, &status, reason.as_deref());
            items.push(TrashItem {
                id: format!("managed:{segment}"),
                kind: "managed_asset".into(),
                display_name: manifest
                    .get("displayName")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| display_name_from_recovered_skill(&directory, &skill_id)),
                created_at: recovery_created_at(&directory, &manifest),
                status: status.clone(),
                reason,
                source_count: 1,
                restorable,
                location: directory.to_string_lossy().to_string(),
                server_id: recovered_profile
                    .as_ref()
                    .and_then(|profile| profile.server_id.clone()),
                server_owner_id: recovered_profile.and_then(|profile| profile.server_owner_id),
                skill_id,
            });
        }
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.created_at));
    Ok(items)
}

fn validate_adoption_original_path(
    home: &Path,
    source: &serde_json::Value,
    original: &Path,
) -> Result<String, String> {
    let entry_name = source
        .get("entryName")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .or_else(|| original.file_name()?.to_str().map(str::to_string))
        .ok_or("恢复清单缺少安全的 Agent Skill 名称")?;
    validate_skill_id(&entry_name).map_err(|_| "恢复清单中的 Agent Skill 名称无效".to_string())?;

    const LEGACY_AGENT_SKILLS_DIR: &str = ".agents/skills";
    let known_agents = crate::known_agents();
    let expected =
        if let Some(agent_key) = source.get("agentKey").and_then(serde_json::Value::as_str) {
            let relative = known_agents
                .iter()
                .find(|(key, _, _)| *key == agent_key)
                .map(|(_, _, relative)| *relative)
                // v0.10 and earlier used this pseudo-Agent for ~/.agents/skills.
                // Keep it only for validating existing recovery manifests; it
                // must not re-enter current detection or installation targets.
                .or_else(|| (agent_key == "agent-skills").then_some(LEGACY_AGENT_SKILLS_DIR))
                .ok_or("恢复清单包含未知 Agent")?;
            home.join(relative).join(&entry_name)
        } else {
            known_agents
                .iter()
                .map(|(_, _, relative)| home.join(relative).join(&entry_name))
                .chain(std::iter::once(
                    home.join(LEGACY_AGENT_SKILLS_DIR).join(&entry_name),
                ))
                .find(|candidate| candidate == original)
                .ok_or("旧版恢复清单中的 Agent 路径无法安全推导")?
        };
    if original != expected {
        return Err("恢复清单中的 Agent 路径与 Agent/Skill 名称不一致".into());
    }
    Ok(entry_name)
}

fn normalize_absolute_path(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => normalized.push(Path::new("/")),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            std::path::Component::Normal(segment) => normalized.push(segment),
        }
    }
    Some(normalized)
}

fn validate_unmoved_adoption_source(
    home: &Path,
    source: &serde_json::Value,
    original: &Path,
    skill_id: &str,
    projection_target: Option<&Path>,
    recoverable_originals: &HashMap<PathBuf, PathBuf>,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(original)
        .map_err(|error| format!("未移动的 Agent Skill 原路径不可验证: {error}"))?;
    if !metadata.is_dir() && !metadata.file_type().is_symlink() {
        return Err("未移动的 Agent Skill 原路径类型无效".into());
    }
    if metadata.file_type().is_symlink()
        && (is_symlink_to_skill(original, skill_id)
            || projection_target.is_some_and(|target| symlink_declares_path(original, target)))
    {
        return Err("Agent Skill 备份缺失且原路径已经是 SkillHub 投影，无法安全跳过".into());
    }
    let expected_fingerprint = source
        .get("fingerprint")
        .and_then(serde_json::Value::as_str)
        .ok_or("部分恢复清单缺少原 Skill 指纹")?;
    if metadata.file_type().is_symlink() {
        let declared =
            declared_symlink_target(original).and_then(|path| normalize_absolute_path(&path));
        if let Some(recoverable_backup) = declared
            .as_ref()
            .and_then(|target| recoverable_originals.get(target))
        {
            let canonical_backup = fs::canonicalize(recoverable_backup)
                .map_err(|error| format!("无法验证未移动的 Agent Skill 链接目标备份: {error}"))?;
            let backup_fingerprint = fingerprint_hex(&canonical_backup)
                .map_err(|error| format!("无法验证未移动的 Agent Skill 链接内容: {error}"))?;
            if backup_fingerprint == expected_fingerprint {
                return Ok(());
            }
        }
    }
    let canonical = fs::canonicalize(original)
        .map_err(|error| format!("未移动的 Agent Skill 无法解析: {error}"))?;
    if !canonical.is_dir()
        || canonical.starts_with(home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        }))
    {
        return Err("未移动的 Agent Skill 未通过本地来源校验".into());
    }
    let actual_fingerprint = fingerprint_hex(&canonical)
        .map_err(|error| format!("无法验证未移动的 Agent Skill: {error}"))?;
    if actual_fingerprint != expected_fingerprint {
        return Err("未移动的 Agent Skill 内容已经变化，无法安全跳过".into());
    }
    Ok(())
}

fn restore_adoption_item_at_with_hook<F: FnOnce()>(
    home: &Path,
    directory: &Path,
    manifest_path: &Path,
    before_moves: F,
) -> Result<(), String> {
    let mut manifest = read_recovery_manifest(manifest_path)?;
    let status = manifest
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    if !adoption_status_can_restore(status) {
        return Err("该同名 Skill 恢复项当前不可恢复".into());
    }
    let partial = status != "complete";
    let skill_id = manifest
        .get("skillId")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            manifest
                .get("destination")?
                .as_str()
                .and_then(|path| Path::new(path).file_name()?.to_str())
        })
        .ok_or("恢复清单缺少 Skill 标识")?
        .to_string();
    validate_skill_id(&skill_id)?;
    let projection_target = manifest
        .get("projectionTarget")
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from);
    if projection_target.as_ref().is_some_and(|target| {
        !target.is_absolute()
            || target.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
            || !target.starts_with(
                home.join(if crate::official_channel::CHANNEL == "dev" {
                    ".skillhub-dev"
                } else {
                    ".skillhub"
                })
                .join("projections")
                .join(&skill_id),
            )
    }) {
        return Err("恢复清单包含无效投影路径".into());
    }
    let sources = manifest
        .get("sources")
        .and_then(serde_json::Value::as_array)
        .ok_or("恢复清单缺少 Agent 来源")?;
    let entries_root = directory.join("entries");
    let entries_metadata = fs::symlink_metadata(&entries_root)
        .map_err(|error| format!("无法读取 Agent Skill 备份目录: {error}"))?;
    if entries_metadata.file_type().is_symlink() || !entries_metadata.is_dir() {
        return Err("Agent Skill 备份根目录类型无效".into());
    }
    let recoverable_originals = sources
        .iter()
        .filter_map(|source| {
            let original = PathBuf::from(source.get("original")?.as_str()?);
            validate_adoption_original_path(home, source, &original).ok()?;
            let backup = PathBuf::from(source.get("backup")?.as_str()?);
            if !adoption_backup_path_is_safe(&entries_root, &backup)
                || !fs::symlink_metadata(&backup)
                    .is_ok_and(|metadata| metadata.is_dir() || metadata.file_type().is_symlink())
            {
                return None;
            }
            Some((normalize_absolute_path(&original)?, backup))
        })
        .collect::<HashMap<_, _>>();
    let links_root = directory.join("restored-links");
    let mut pairs = Vec::new();
    for (index, source) in sources.iter().enumerate() {
        let original = PathBuf::from(
            source
                .get("original")
                .and_then(serde_json::Value::as_str)
                .ok_or("恢复清单中的 Agent 原路径无效")?,
        );
        let backup = PathBuf::from(
            source
                .get("backup")
                .and_then(serde_json::Value::as_str)
                .ok_or("恢复清单中的 Agent 备份路径无效")?,
        );
        validate_adoption_original_path(home, source, &original)?;
        if !adoption_backup_path_is_safe(&entries_root, &backup) {
            return Err("恢复清单包含越界路径，已拒绝恢复".into());
        }
        let backup_metadata = match fs::symlink_metadata(&backup) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && partial => {
                validate_unmoved_adoption_source(
                    home,
                    source,
                    &original,
                    &skill_id,
                    projection_target.as_deref(),
                    &recoverable_originals,
                )?;
                continue;
            }
            Err(error) => return Err(format!("Agent Skill 备份不存在: {error}")),
        };
        if !backup_metadata.is_dir() && !backup_metadata.file_type().is_symlink() {
            return Err("Agent Skill 备份类型无效".into());
        }
        let original_snapshot = match fs::symlink_metadata(&original) {
            Ok(metadata)
                if metadata.file_type().is_symlink()
                    && (is_symlink_to_skill(&original, &skill_id)
                        || projection_target
                            .as_ref()
                            .is_some_and(|target| symlink_declares_path(&original, target))) =>
            {
                Some((
                    metadata.dev(),
                    metadata.ino(),
                    fs::read_link(&original)
                        .map_err(|error| format!("无法读取原 Agent Skill 链接: {error}"))?,
                ))
            }
            Ok(_) => return Err(format!("原路径已有新内容，未覆盖: {}", original.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("无法检查原路径: {error}")),
        };
        pairs.push((
            original,
            backup,
            links_root.join(format!("{index:02}-projection")),
            original_snapshot,
        ));
    }
    if pairs.is_empty() {
        return Err("该恢复项没有实际可恢复的 Agent Skill 备份".into());
    }
    fs::create_dir_all(&links_root).map_err(|error| error.to_string())?;
    fs::set_permissions(&links_root, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    before_moves();
    let mut restored: Vec<(PathBuf, PathBuf, Option<PathBuf>)> = Vec::new();
    for (original, backup, saved_link, original_snapshot) in pairs {
        let mut saved = None;
        if let Some((expected_device, expected_inode, expected_target)) = original_snapshot {
            if let Err(error) = rename_noreplace(&original, &saved_link) {
                for (prior_original, prior_backup, prior_link) in restored.iter().rev() {
                    let _ = rename_noreplace(prior_original, prior_backup);
                    if let Some(link) = prior_link {
                        let _ = rename_noreplace(link, prior_original);
                    }
                }
                return Err(format!("恢复 Agent Skill 失败，已回滚: {error}"));
            }
            let isolated_is_expected_link =
                fs::symlink_metadata(&saved_link).is_ok_and(|metadata| {
                    metadata.file_type().is_symlink()
                        && metadata.dev() == expected_device
                        && metadata.ino() == expected_inode
                }) && fs::read_link(&saved_link).is_ok_and(|target| target == expected_target);
            if !isolated_is_expected_link {
                let restore_result = rename_noreplace(&saved_link, &original);
                for (prior_original, prior_backup, prior_link) in restored.iter().rev() {
                    let _ = rename_noreplace(prior_original, prior_backup);
                    if let Some(link) = prior_link {
                        let _ = rename_noreplace(link, prior_original);
                    }
                }
                return Err(match restore_result {
                    Ok(()) => "原 Agent Skill 在恢复期间发生变化，已恢复新内容并停止".into(),
                    Err(error) => format!(
                        "原 Agent Skill 在恢复期间发生变化；新内容保留在 {}，无法自动放回: {error}",
                        saved_link.display()
                    ),
                });
            }
            saved = Some(saved_link.clone());
        } else if fs::symlink_metadata(&original).is_ok() {
            for (prior_original, prior_backup, prior_link) in restored.iter().rev() {
                let _ = rename_noreplace(prior_original, prior_backup);
                if let Some(link) = prior_link {
                    let _ = rename_noreplace(link, prior_original);
                }
            }
            return Err(format!("原路径出现新内容，未覆盖: {}", original.display()));
        }
        if let Err(error) = rename_noreplace(&backup, &original) {
            if let Some(link) = saved.as_ref() {
                let _ = rename_noreplace(link, &original);
            }
            for (prior_original, prior_backup, prior_link) in restored.iter().rev() {
                let _ = rename_noreplace(prior_original, prior_backup);
                if let Some(link) = prior_link {
                    let _ = rename_noreplace(link, prior_original);
                }
            }
            return Err(format!("恢复 Agent Skill 失败，已回滚: {error}"));
        }
        restored.push((original, backup, saved));
    }
    manifest["status"] = serde_json::Value::String("restored".into());
    manifest["restoredAt"] = serde_json::json!(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs()));
    if let Err(error) = write_private_file(
        manifest_path,
        &serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?,
    ) {
        let mut rollback_failures = Vec::new();
        for (original, backup, saved_link) in restored.iter().rev() {
            if let Err(rollback_error) = rename_noreplace(original, backup) {
                rollback_failures.push(format!(
                    "{} 未能放回 {}: {rollback_error}",
                    original.display(),
                    backup.display()
                ));
                continue;
            }
            if let Some(saved_link) = saved_link {
                if let Err(rollback_error) = rename_noreplace(saved_link, original) {
                    rollback_failures.push(format!(
                        "原 Agent 投影仍位于 {}: {rollback_error}",
                        saved_link.display()
                    ));
                }
            }
        }
        return if rollback_failures.is_empty() {
            Err(format!("无法记录恢复状态，文件移动已回滚: {error}"))
        } else {
            Err(format!(
                "无法记录恢复状态: {error}; 文件移动回滚不完整: {}",
                rollback_failures.join("; ")
            ))
        };
    }
    Ok(())
}

fn restore_adoption_item_at(
    home: &Path,
    directory: &Path,
    manifest_path: &Path,
) -> Result<(), String> {
    restore_adoption_item_at_with_hook(home, directory, manifest_path, || {})
}

fn safe_relative_recovery_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if value.is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::CurDir
            )
        })
    {
        return Err("恢复清单包含不安全相对路径".into());
    }
    Ok(path)
}

fn restore_managed_item_at(
    root: &Path,
    managed_root: &Path,
    directory: &Path,
    manifest_path: &Path,
) -> Result<(), String> {
    let manifest = read_recovery_manifest(manifest_path)?;
    restore_managed_item_from_manifest(root, managed_root, directory, manifest_path, manifest)
}

fn restore_managed_item_from_manifest(
    root: &Path,
    managed_root: &Path,
    directory: &Path,
    manifest_path: &Path,
    mut manifest: serde_json::Value,
) -> Result<(), String> {
    let status = manifest
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("trashed");
    if status != "trashed" {
        return Err("该 Skill 当前不可恢复".into());
    }
    let skill_id = manifest
        .get("skillId")
        .and_then(serde_json::Value::as_str)
        .ok_or("恢复清单缺少 Skill 标识")?
        .to_string();
    validate_skill_id(&skill_id)?;
    let skill_recovery = safe_relative_recovery_path(
        manifest
            .get("skillRecoveryPath")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("skill"),
    )?;
    let mut moves = vec![(directory.join(skill_recovery), managed_root.join(&skill_id))];
    if let Some(projection) = manifest
        .get("projectionRecoveryPath")
        .and_then(serde_json::Value::as_str)
    {
        moves.push((
            directory.join(safe_relative_recovery_path(projection)?),
            projection_root_at(root, &skill_id),
        ));
    }
    if let Some(env_files) = manifest
        .get("envFiles")
        .and_then(serde_json::Value::as_array)
    {
        for env_file in env_files {
            let recovery = safe_relative_recovery_path(
                env_file
                    .get("recoveryPath")
                    .and_then(serde_json::Value::as_str)
                    .ok_or("环境变量恢复路径无效")?,
            )?;
            let original = safe_relative_recovery_path(
                env_file
                    .get("originalRelativePath")
                    .and_then(serde_json::Value::as_str)
                    .ok_or("环境变量原路径无效")?,
            )?;
            moves.push((directory.join(recovery), root.join(original)));
        }
    }
    for (recovered, original) in &moves {
        if fs::symlink_metadata(recovered).is_err() {
            return Err(format!("恢复内容不存在: {}", recovered.display()));
        }
        if fs::symlink_metadata(original).is_ok() {
            return Err(format!(
                "恢复目标已有新内容，未覆盖: {}",
                original.display()
            ));
        }
        if let Some(parent) = original.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
    }
    let mut completed: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (recovered, original) in &moves {
        if let Err(error) = rename_noreplace(recovered, original) {
            for (prior_recovered, prior_original) in completed.iter().rev() {
                let _ = rename_noreplace(prior_original, prior_recovered);
            }
            return Err(format!("恢复 Skill 失败，已回滚: {error}"));
        }
        completed.push((recovered.clone(), original.clone()));
    }
    manifest["status"] = serde_json::Value::String("restored".into());
    manifest["restoredAt"] = serde_json::json!(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs()));
    if let Err(error) = write_private_file(
        manifest_path,
        &serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?,
    ) {
        let mut rollback_failures = Vec::new();
        for (recovered, original) in completed.iter().rev() {
            if let Err(rollback_error) = rename_noreplace(original, recovered) {
                rollback_failures.push(format!(
                    "{} 仍位于 {}: {rollback_error}",
                    recovered.display(),
                    original.display()
                ));
            }
        }
        return if rollback_failures.is_empty() {
            Err(format!("无法记录恢复状态，文件移动已回滚: {error}"))
        } else {
            Err(format!(
                "无法记录恢复状态: {error}; 文件移动回滚不完整: {}",
                rollback_failures.join("; ")
            ))
        };
    }
    Ok(())
}

fn restore_managed_trash_item_from_snapshot_at(
    root: &Path,
    managed_root: &Path,
    id: &str,
    manifest: serde_json::Value,
) -> Result<(), String> {
    let (kind, directory, manifest_path) = resolve_recovery_item_at(root, id)?;
    if kind != "managed" {
        return Err("回收站项目不是可恢复的托管 Skill".into());
    }
    restore_managed_item_from_manifest(root, managed_root, &directory, &manifest_path, manifest)
}

pub(crate) fn restore_managed_trash_item_from_snapshot(
    id: String,
    manifest: serde_json::Value,
) -> Result<(), String> {
    restore_managed_trash_item_from_snapshot_at(&skillhub_dir(), &skills_dir(), &id, manifest)
}

#[tauri::command]
pub fn restore_trash_item(id: String) -> Result<(), String> {
    let (kind, directory, manifest) = resolve_recovery_item(&id)?;
    match kind.as_str() {
        "adoption" => restore_adoption_item_at(
            &crate::user_home_dir().ok_or("Cannot find home dir")?,
            &directory,
            &manifest,
        ),
        "managed" => restore_managed_item_at(&skillhub_dir(), &skills_dir(), &directory, &manifest),
        _ => Err("未知的回收站项目类型".into()),
    }
}

#[tauri::command]
pub fn open_trash_item(id: String) -> Result<(), String> {
    let (_, directory, manifest) = resolve_recovery_item(&id)?;
    read_recovery_manifest(&manifest)?;
    let metadata = fs::symlink_metadata(&directory).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("回收站项目不是安全目录".into());
    }
    open::that(directory).map_err(|error| error.to_string())
}

/// Enable (re-create symlink for one agent)
#[tauri::command]
pub async fn enable_skill(skill_id: String, agent: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_skill_blocking(skill_id, vec![agent], None, None)
    })
    .await
    .map_err(|error| format!("Skill 启用任务异常结束：{error}"))?
}

/// Disable (remove symlink for one agent)
#[tauri::command]
pub fn disable_skill(skill_id: String, agent: String) -> Result<(), String> {
    validate_skill_id(&skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
    let skillhub_root = skillhub_dir();
    let managed_root = skills_dir();
    let canonical = managed_root.join(&skill_id);
    let projection_current = projection_root_at(&skillhub_root, &skill_id).join("current");
    let has_generated_projection = fs::symlink_metadata(&projection_current).is_ok();
    if has_generated_projection {
        reconcile_skill_projection_at(&skillhub_root, &managed_root, &skill_id)?;
    }
    let mut expected_targets = vec![canonical];
    if has_generated_projection {
        expected_targets.push(projection_current);
    }
    let projection_name = skill_projection_name(&skill_id)?;
    if let Some((_, _, rel)) = crate::known_agents()
        .into_iter()
        .find(|(k, _, _)| *k == agent.as_str())
    {
        let link = home.join(rel).join(&projection_name);
        if link.exists() || link.is_symlink() {
            if !is_symlink_to_skill(&link, &skill_id) {
                return Err(format!(
                    "Refusing to remove non-SkillHub item: {}",
                    link.to_string_lossy()
                ));
            }
            remove_owned_symlink_atomically(&link, &expected_targets, &skillhub_root)?;
        }
    } else {
        return Err(format!("Unknown Agent: {agent}"));
    }
    Ok(())
}

/// Import a skill from a local directory or zip
fn import_skill_blocking(
    path: String,
    skill_id: Option<String>,
    replace_conflicts: Option<bool>,
    plan_digest: Option<String>,
) -> Result<LocalSkill, String> {
    // Attributed to the account signed in now; committed only if it still is (#91).
    let attribution = crate::runtime_env::ImportAttribution::begin();
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("Path not found: {path}"));
    }
    let (temporary_root, source_root) = prepare_import_source(&src)?;
    let import_result = (|| -> Result<LocalSkill, String> {
        reject_installed_system_manager_import(&source_root)?;
        let skill_id = import_skill_id_for_source(
            &src,
            &source_root,
            temporary_root.as_deref(),
            skill_id.as_deref(),
        )?;
        if is_system_skill_id(&skill_id) {
            return Err("SkillHub Manager 是保留的系统 Skill id，不能由本地导入覆盖".into());
        }
        if !source_root.join("SKILL.md").is_file() {
            return Err("所选文件夹或 ZIP 中缺少 SKILL.md".into());
        }

        crate::ensure_skillhub_dirs()
            .map_err(|error| format!("无法准备 SkillHub 本机目录: {error}"))?;
        let destination = skills_dir().join(&skill_id);
        if fs::symlink_metadata(&destination).is_ok() {
            return Err(format!("Skill already imported: {skill_id}"));
        }
        let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
        let adoption_plan = build_import_preflight_at(
            &home,
            &source_root,
            &src,
            &skill_id,
            &crate::detected_agent_keys(),
        )?;
        validate_preflight_confirmation(&adoption_plan, replace_conflicts, plan_digest.as_deref())?;
        let profile_source = fs::read_to_string(source_root.join("SKILL.md"))
            .map_err(|error| format!("无法读取 SKILL.md: {error}"))?;
        let discovered_env_values = discover_skill_env_values(&source_root)?;
        let (display_name, description, category, labels, version) =
            parse_skill_document(&skill_id, &profile_source);
        // 声明是事实源（#251）：无效声明直接报错；目录自带 sidecar 的依赖随后补充。
        let env_declarations = skill_md_env_declarations(&profile_source)?;
        let source_env_dependencies = source_sidecar_env_dependencies(&source_root);

        let skillhub_root = skills_dir()
            .parent()
            .ok_or("Cannot resolve SkillHub directory")?
            .to_path_buf();
        let imports_root = skillhub_root.join(".imports");
        fs::create_dir_all(&imports_root)
            .map_err(|error| format!("无法创建导入事务目录: {error}"))?;
        fs::set_permissions(&imports_root, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("无法保护导入事务目录: {error}"))?;
        let transaction_root = imports_root.join(uuid::Uuid::new_v4().to_string());
        let staged_destination = transaction_root.join("managed");
        fs::create_dir(&transaction_root)
            .map_err(|error| format!("无法创建本次导入事务: {error}"))?;
        fs::set_permissions(&transaction_root, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("无法保护本次导入事务: {error}"))?;

        let stage_result: Result<(), String> = (|| {
            copy_dir(&source_root, &staged_destination)
                .map_err(|error| format!("无法暂存待导入 Skill: {error}"))?;
            crate::version_policy::init_repository(&staged_destination)
                .map_err(|error| format!("无法初始化待导入 Skill 版本库: {error}"))?;
            ensure_git_excludes(&staged_destination)
                .map_err(|error| format!("无法设置待导入 Skill 私有文件规则: {error}"))?;
            // 桌面与 CLI 导入共用这一步：同一目录得到同一份 declared / high / medium 依赖 (#250)。
            let env_suggestions = crate::env_detect::detect_env_suggestions(&staged_destination);
            // `collect_skill_tree` never copies the folder's own sidecar; its env
            // dependencies were read from the source above.
            let mut profile = SkillHubProfile {
                id: Some(uuid::Uuid::new_v4().to_string()),
                name: Some(skill_id.clone()),
                display_name: Some(display_name),
                description,
                category,
                labels,
                version: version.clone(),
                env_dependencies: source_env_dependencies,
                ..Default::default()
            };
            // 优先级：声明 > 目录 sidecar > 本机 .env > 检测（后两者只补充新 key）。
            crate::env_detect::apply_declared_dependencies(
                &mut profile.env_dependencies,
                &env_declarations,
            );
            merge_profile_env_dependencies(&mut profile, discovered_env_values.keys().cloned());
            crate::env_detect::merge_import_suggestions(
                &mut profile.env_dependencies,
                &env_suggestions,
            );
            // 目录自带 sidecar 里由旧版检测加入的配置名不带进来（#287）。
            crate::env_detect::prune_non_secret_detected(&mut profile.env_dependencies);
            normalize_profile_initial_version(&mut profile);
            normalize_profile_acquisition_source(&mut profile);
            // Never trust a stamp carried in the imported folder.
            profile.added_by_account_id = attribution.account_id().map(str::to_string);
            profile.scope = attribution.scope();
            write_profile_at_path(&staged_destination, &profile)
                .map_err(|error| format!("无法写入待导入 Skill Profile: {error}"))?;
            create_skill_snapshot_at_path(&staged_destination, &format!("{version} · 首次导入"))
                .map_err(|error| format!("无法创建待导入 Skill 初始版本: {error}"))?;
            // This staging directory is private to the import transaction;
            // activation still verifies its captured account attribution.
            ensure_current_local_version_at(&staged_destination, &mut profile)
        })();
        if let Err(error) = stage_result {
            let _ = fs::remove_dir_all(&transaction_root);
            return Err(error);
        }
        // Rename, projection/adoption and the env values all happen under the
        // session captured at the start (#91); see `commit_imported_skill_at`.
        let committed = commit_imported_skill_at(
            &skillhub_root,
            &envs_dir(),
            &attribution,
            &staged_destination,
            &destination,
            &skill_id,
            &discovered_env_values,
            || {
                adopt_imported_sources(
                    &skillhub_root,
                    &skill_id,
                    &source_root,
                    &destination,
                    &adoption_plan,
                )
            },
        );
        let _ = fs::remove_dir_all(&transaction_root);
        committed?;
        Ok(build_local_skill(&skill_id))
    })();
    if let Some(temporary) = temporary_root {
        let _ = fs::remove_dir_all(temporary);
    }
    import_result
}

/// Commit of a folder/ZIP import (#91). Fails before writing anything when
/// the APP session changed since the import started; otherwise holds that
/// session from the rename into the library, through `after_rename`
/// (projection and adoption), to storing the detected env values for the
/// same runtime identity. No login, logout or switch can happen in between,
/// so neither the Skill nor its secrets can be credited to another account.
#[allow(clippy::too_many_arguments)]
fn commit_imported_skill_at(
    skillhub_root: &Path,
    env_root: &Path,
    attribution: &crate::runtime_env::ImportAttribution,
    staged: &Path,
    destination: &Path,
    skill_id: &str,
    env_values: &BTreeMap<String, String>,
    after_rename: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _session = attribution.commit_at(skillhub_root)?;
    let identity = attribution.runtime_user_id();
    if identity.is_none() && !env_values.is_empty() {
        return Err(
            "导入开始时 SkillHub 账号正在切换，无法确定本机配置属于哪个账号；请稍后重新导入".into(),
        );
    }
    fs::rename(staged, destination).map_err(|error| format!("无法提交已导入 Skill: {error}"))?;
    after_rename()?;
    if let Some(identity) = identity {
        let data_root = attribution.storage_root(skillhub_root)?;
        let data_env_root = if data_root == skillhub_root {
            env_root.to_path_buf()
        } else {
            data_root.join("envs")
        };
        persist_skill_env_values_at(&data_env_root, identity, skill_id, env_values)?;
    }
    Ok(())
}

/// Projection and adoption of an imported Skill; on failure the new managed
/// folder and its projection are removed again.
fn adopt_imported_sources(
    skillhub_root: &Path,
    skill_id: &str,
    source_root: &Path,
    destination: &Path,
    adoption_plan: &ImportSkillPreflight,
) -> Result<(), String> {
    if adoption_plan.sources.is_empty() {
        return Ok(());
    }
    let discard = || {
        let _ = remove_projection_root_at(skillhub_root, skill_id);
        let _ = remove_new_managed_destination(destination);
    };
    let generated_projection = refresh_skill_projection(skill_id).inspect_err(|_| discard())?;
    let backups_root = skillhub_root.join("adoption-backups");
    fs::create_dir_all(&backups_root).map_err(|error| {
        discard();
        error.to_string()
    })?;
    fs::set_permissions(&backups_root, fs::Permissions::from_mode(0o700)).map_err(|error| {
        discard();
        error.to_string()
    })?;
    let backup_dir = backups_root.join(uuid::Uuid::new_v4().to_string());
    adopt_agent_sources_with(
        source_root,
        destination,
        &generated_projection,
        &backup_dir,
        adoption_plan,
        true,
        |target, link| unix_fs::symlink(target, link).map_err(|reason| reason.to_string()),
    )
    .inspect_err(|error| {
        if !error.contains("回滚不完整") {
            discard();
            let _ = fs::remove_dir_all(&backup_dir);
        }
    })
}

#[tauri::command]
pub async fn import_skill(
    path: String,
    skill_id: Option<String>,
    replace_conflicts: Option<bool>,
    plan_digest: Option<String>,
) -> Result<LocalSkill, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_skill_blocking(path, skill_id, replace_conflicts, plan_digest)
    })
    .await
    .map_err(|error| format!("Skill 后台导入任务异常结束: {error}"))?
}

fn zip_entry_type_is_supported(unix_mode: Option<u32>, is_directory: bool) -> bool {
    let kind = unix_mode.unwrap_or(0) & 0o170000;
    matches!(kind, 0 | 0o100000 | 0o040000)
        && !((is_directory && kind == 0o100000) || (!is_directory && kind == 0o040000))
}

fn canonical_archive_file_mode(unix_mode: Option<u32>) -> u32 {
    if unix_mode.unwrap_or(0) & 0o111 != 0 {
        0o755
    } else {
        0o644
    }
}

fn ensure_archive_parent_directories(root: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "无法确定 ZIP 解压目录".to_string())?;
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| "ZIP 解压路径超出目标目录".to_string())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err("ZIP 包含不安全目录".into());
        };
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(format!(
                    "ZIP 目录路径不是安全的真实目录: {}",
                    current.display()
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
        fs::set_permissions(&current, fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn restore_archive_file_mode(path: &Path, unix_mode: Option<u32>) -> Result<(), String> {
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(canonical_archive_file_mode(unix_mode)),
    )
    .map_err(|error| error.to_string())
}

fn prepare_user_zip_at(src: &Path, imports_root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let size = fs::metadata(src).map_err(|error| error.to_string())?.len();
    if size == 0 || size > 20 * 1024 * 1024 {
        return Err("Skill ZIP 必须介于 1 byte 和 20 MB 之间".into());
    }
    fs::create_dir_all(imports_root).map_err(|error| error.to_string())?;
    fs::set_permissions(imports_root, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let temporary = imports_root.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&temporary).map_err(|error| error.to_string())?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;

    let extract_result: Result<PathBuf, String> = (|| {
        let file = fs::File::open(src).map_err(|error| error.to_string())?;
        let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
        let mut total_uncompressed = 0_u64;
        let mut file_count = 0_usize;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err("ZIP 不能包含符号链接".into());
            }
            let enclosed = entry
                .enclosed_name()
                .ok_or("ZIP 包含不安全路径")?
                .to_path_buf();
            if !zip_entry_type_is_supported(entry.unix_mode(), entry.is_dir()) {
                return Err(format!("ZIP 包含不支持的文件类型: {}", enclosed.display()));
            }
            // A user ZIP may have one conventional top-level wrapper. The
            // selected Skill root is revalidated at the exact 10-level limit.
            if validate_archive_entry_path(&enclosed, MAX_SKILL_TREE_DEPTH + 1)?.is_none() {
                continue;
            }
            if entry.is_dir() {
                continue;
            }
            file_count = file_count.saturating_add(1);
            if file_count > MAX_SKILL_FILE_COUNT {
                return Err(format!("ZIP 文件数量超过 {MAX_SKILL_FILE_COUNT}"));
            }
            if entry.size() > MAX_ZIP_FILE_BYTES {
                return Err(format!("ZIP 单个文件超过 20 MB: {}", enclosed.display()));
            }
            if total_uncompressed.saturating_add(entry.size()) > MAX_ZIP_TOTAL_BYTES {
                return Err("ZIP 解压后超过 100 MB".into());
            }
            let destination = temporary.join(&enclosed);
            ensure_archive_parent_directories(&temporary, &destination)?;
            let unix_mode = entry.unix_mode();
            let mut output = fs::File::create(&destination).map_err(|error| error.to_string())?;
            copy_bounded_zip_entry(&mut entry, &mut output, &mut total_uncompressed, &enclosed)?;
            restore_archive_file_mode(&destination, unix_mode)?;
        }

        let root = if temporary.join("SKILL.md").is_file() {
            temporary.clone()
        } else {
            let roots: Vec<PathBuf> = fs::read_dir(&temporary)
                .map_err(|error| error.to_string())?
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_dir() && path.join("SKILL.md").is_file())
                .collect();
            if roots.len() != 1 {
                return Err("ZIP 必须在根目录或唯一顶层文件夹中包含 SKILL.md".into());
            }
            roots[0].clone()
        };
        collect_skill_tree(&root)?;
        Ok(root)
    })();

    match extract_result {
        Ok(root) => Ok((temporary, root)),
        Err(error) => {
            let _ = fs::remove_dir_all(&temporary);
            Err(error)
        }
    }
}

fn prepare_user_zip(src: &Path) -> Result<(PathBuf, PathBuf), String> {
    let imports_root = skills_dir()
        .parent()
        .ok_or("Cannot resolve SkillHub directory")?
        .join(".imports");
    prepare_user_zip_at(src, &imports_root)
}

fn extract_marketplace_package_to_stage(bytes: &[u8], stage: &Path) -> Result<(), String> {
    validate_real_directory(stage, "Skill 商店解压目录")?;
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
    let mut total_uncompressed: u64 = 0;
    let mut file_count = 0_usize;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("压缩包不能包含符号链接".into());
        }
        let enclosed = file
            .enclosed_name()
            .ok_or("压缩包包含不安全路径")?
            .to_path_buf();
        // Marketplace packages must never hydrate a publisher's local env
        // file on another machine, even if an older package contains one.
        if is_local_env_value_path(&enclosed) {
            continue;
        }
        if !zip_entry_type_is_supported(file.unix_mode(), file.is_dir()) {
            return Err(format!(
                "压缩包包含不支持的文件类型: {}",
                enclosed.display()
            ));
        }
        if validate_archive_entry_path(&enclosed, MAX_SKILL_TREE_DEPTH)?.is_none() {
            continue;
        }
        if file.is_dir() {
            continue;
        }
        file_count = file_count.saturating_add(1);
        if file_count > MAX_SKILL_FILE_COUNT {
            return Err(format!("压缩包文件数量超过 {MAX_SKILL_FILE_COUNT}"));
        }
        if file.size() > MAX_ZIP_FILE_BYTES {
            return Err(format!(
                "压缩包中的单个文件超过 20 MB: {}",
                enclosed.display()
            ));
        }
        if total_uncompressed.saturating_add(file.size()) > MAX_ZIP_TOTAL_BYTES {
            return Err("压缩包解压后超过 100 MB".into());
        }
        let output_path = stage.join(&enclosed);
        ensure_archive_parent_directories(stage, &output_path)?;
        let unix_mode = file.unix_mode();
        let mut output = fs::File::create(&output_path).map_err(|error| error.to_string())?;
        copy_bounded_zip_entry(&mut file, &mut output, &mut total_uncompressed, &enclosed)?;
        restore_archive_file_mode(&output_path, unix_mode)?;
    }
    if !stage.join("SKILL.md").is_file() {
        return Err("压缩包中缺少 SKILL.md".into());
    }
    Ok(())
}

fn copy_dir(src: &std::path::Path, dst: &std::path::Path) -> Result<()> {
    let entries = collect_skill_tree(src).map_err(anyhow::Error::msg)?;
    fs::create_dir_all(dst)?;
    for entry in entries {
        let dest_path = dst.join(&entry.relative);
        if entry.is_directory {
            fs::create_dir_all(&dest_path)?;
        } else {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&entry.path, &dest_path)?;
        }
    }
    Ok(())
}

/// Open skill directory in Finder
#[tauri::command]
pub fn open_skill_dir(skill_id: String) -> Result<(), String> {
    validate_skill_id(&skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    let path = skill_path(&skill_id);
    open::that(&path).map_err(|e| e.to_string())
}

/// Get version history from git log. The history walk runs on a blocking
/// worker; the lock and projection reconciliation are unchanged.
#[tauri::command]
pub async fn get_skill_versions(skill_id: String) -> Result<Vec<SkillVersion>, String> {
    tauri::async_runtime::spawn_blocking(move || get_skill_versions_blocking(skill_id))
        .await
        .map_err(|error| format!("Skill 版本历史读取异常结束: {error}"))?
}

pub fn get_skill_versions_blocking(skill_id: String) -> Result<Vec<SkillVersion>, String> {
    note_read_command_thread();
    validate_skill_id(&skill_id)?;
    let _lock = crate::skill_lock::lock_skill_dir(&skill_id)?;
    reconcile_skill_projection_at(&skillhub_dir(), &skills_dir(), &skill_id)?;
    Ok(git_versions(&skill_id))
}

/// Commit current state as a new version snapshot
fn create_skill_snapshot_at_path(path: &Path, message: &str) -> Result<(), String> {
    let repo = crate::version_policy::init_repository(path).map_err(|error| error.to_string())?;
    ensure_git_excludes(path).map_err(|error| error.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let _ = index.remove_path(Path::new(".skillhub.json"));
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    crate::version_policy::tree_content(&repo, &tree)?;
    let sig = git2::Signature::now("SkillHub", "skillhub@local").map_err(|e| e.to_string())?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    if parent.as_ref().is_some_and(|p| p.tree_id() == tree_id) {
        return Ok(());
    }
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn create_skill_snapshot(skill_id: String, message: String) -> Result<(), String> {
    create_skill_snapshot_with_version(skill_id, message, None, None)
}

#[tauri::command]
pub fn create_skill_snapshot_with_version(
    skill_id: String,
    message: String,
    version: Option<String>,
    allocation: Option<String>,
) -> Result<(), String> {
    validate_skill_id(&skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    let _lock = crate::skill_lock::lock_skill_dir(&skill_id)?;
    reconcile_skill_projection_at(&skillhub_dir(), &skills_dir(), &skill_id)?;
    let message = message.trim();
    if message.is_empty() || message.len() > 500 {
        return Err("Version note must be between 1 and 500 characters".into());
    }
    let root = skill_path(&skill_id);
    let mut profile = read_profile_at_path(&root)?;
    let _lease = version_session_lease(&profile)?;
    save_snapshot_with_version_at(
        &root,
        &mut profile,
        message,
        version.as_deref(),
        allocation.as_deref(),
    )?;
    if projection_root_at(&skillhub_dir(), &skill_id)
        .join("current")
        .exists()
    {
        refresh_skill_projection(&skill_id)?;
    }
    Ok(())
}

/// Caller holds the Skill lock and account lease. Updating an unaccepted save
/// changes its request identity, never its immutable Git commit.
pub(crate) fn save_snapshot_with_version_at(
    root: &Path,
    profile: &mut SkillHubProfile,
    message: &str,
    version: Option<&str>,
    allocation: Option<&str>,
) -> Result<(), String> {
    let before_metadata = profile.version_metadata.clone();
    let before_version = profile.version.clone();
    crate::version_policy::normalize_history(root, &mut profile.version_metadata)?;
    let mode = allocation.unwrap_or(if version.is_some() { "manual" } else { "auto" });
    if !matches!(mode, "auto" | "manual") {
        return Err("版本分配方式无效".into());
    }
    if mode == "manual" && version.is_none() {
        return Err("VERSION_FORMAT_INVALID: 手动保存需要版本号".into());
    }
    if version.is_some_and(|v| crate::version_policy::ordinal(v).is_none()) {
        return Err("VERSION_FORMAT_INVALID: 版本号必须是三个单数字，如 0.1.0".into());
    }
    if let Some(current) = crate::version_policy::current(root, &profile.version_metadata) {
        profile.version = current.label.clone();
        if let Some(crate::version_policy::VersionIntent::Save {
            allocation: previous_mode,
            label: previous_label,
            ..
        }) = current
            .pending
            .as_ref()
            .filter(|_| current.receipt.is_none())
        {
            let next = if version.is_none()
                || (version == Some(previous_label.as_str())
                    && (mode == "auto" || mode == previous_mode))
            {
                previous_label.clone()
            } else {
                crate::version_policy::allocate(profile.version_metadata.high_water, version)?
            };
            if mode != previous_mode || next != *previous_label {
                let hash = crate::version_policy::head(root).ok_or("无法读回当前提交")?;
                let mapped = profile
                    .version_metadata
                    .commits
                    .get_mut(&hash)
                    .ok_or("当前版本映射不存在")?;
                mapped.label = next.clone();
                mapped.pending = Some(crate::version_policy::VersionIntent::Save {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    card_sha256: String::new(),
                    allocation: mode.into(),
                    label: next.clone(),
                });
                profile.version_metadata.high_water = profile
                    .version_metadata
                    .high_water
                    .max(crate::version_policy::ordinal(&next).ok_or("版本号无效")?);
                profile.version = next;
                return write_version_profile_at(root, profile);
            }
        } else if current.receipt.is_none()
            && current.formal_version_id.is_none()
            && current.pending.is_none()
        {
            // Only an explicit Save asks the account to confirm a local label.
            let next = if version.is_none() || version == Some(current.label.as_str()) {
                current.label.clone()
            } else {
                crate::version_policy::allocate(profile.version_metadata.high_water, version)?
            };
            let hash = crate::version_policy::head(root).ok_or("无法读回当前提交")?;
            let mapped = profile
                .version_metadata
                .commits
                .entry(hash)
                .or_insert(current);
            mapped.label = next.clone();
            mapped.pending = Some(crate::version_policy::VersionIntent::Save {
                request_id: uuid::Uuid::new_v4().to_string(),
                card_sha256: String::new(),
                allocation: mode.into(),
                label: next.clone(),
            });
            profile.version_metadata.high_water = profile
                .version_metadata
                .high_water
                .max(crate::version_policy::ordinal(&next).ok_or("版本号无效")?);
            profile.version = next;
            return write_version_profile_at(root, profile);
        } else if version.is_some_and(|v| v != current.label) {
            return Err(
                "当前内容已有版本；仅未确认的保存可以改号，请先修改内容再保存新版本".into(),
            );
        }
        return if before_metadata != profile.version_metadata || before_version != profile.version {
            write_version_profile_at(root, profile)
        } else {
            Ok(())
        };
    }
    // A supplied auto candidate is validated against the same full-history
    // bound; it is not silently discarded in favor of a different number.
    let next = crate::version_policy::allocate(profile.version_metadata.high_water, version)?;
    promote_profile_to_personal(profile);
    create_numbered_snapshot_at(root, profile, &next, mode, message)
}

fn version_session_lease(
    profile: &SkillHubProfile,
) -> Result<Option<crate::runtime_env::CurrentSessionLease>, String> {
    version_session_lease_at(&skillhub_dir(), profile)
}

fn version_session_lease_at(
    root: &Path,
    profile: &SkillHubProfile,
) -> Result<Option<crate::runtime_env::CurrentSessionLease>, String> {
    let session = match crate::runtime_env::runtime_session_snapshot_at(root) {
        Ok(session) => session,
        Err(_)
            if profile.library_account_id.is_none()
                && !root.join("runtime/session.json").exists() =>
        {
            return Ok(None)
        }
        Err(error) => return Err(error),
    };
    if session.is_sync_pending() {
        return Err("账号正在切换，请稍后再保存版本".into());
    }
    crate::spaces::require_profile(profile, &session)?;
    if profile
        .library_account_id
        .as_deref()
        .is_some_and(|id| id != session.user_id())
    {
        return Err("这个 Skill 属于另一个账号".into());
    }
    crate::runtime_env::acquire_current_session_lease_at(root, &session)?
        .ok_or_else(|| "账号已切换".into())
        .map(Some)
}

pub(crate) fn write_version_profile_at(
    root: &Path,
    profile: &SkillHubProfile,
) -> Result<(), String> {
    let backup_root = root
        .parent()
        .and_then(Path::parent)
        .ok_or("无法定位版本备份目录")?
        .join("version-metadata-backups");
    fs::create_dir_all(&backup_root).map_err(|e| e.to_string())?;
    validate_real_directory(&backup_root, "版本元数据备份目录")?;
    fs::set_permissions(&backup_root, fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let original = root.join(".skillhub.json");
    if original.exists() {
        let bytes = fs::read(&original).map_err(|e| e.to_string())?;
        let backup = backup_root.join(format!(
            "{}.{}.json",
            root.file_name().unwrap_or_default().to_string_lossy(),
            uuid::Uuid::new_v4()
        ));
        write_private_file(
            &backup,
            &String::from_utf8(bytes).map_err(|e| e.to_string())?,
        )?;
    }
    write_profile_at_path(root, profile).map_err(|e| e.to_string())
}

pub(crate) fn create_numbered_snapshot_at(
    root: &Path,
    profile: &mut SkillHubProfile,
    version: &str,
    allocation: &str,
    message: &str,
) -> Result<(), String> {
    let (content, _) = crate::library_sync::content::local_identity(root, None)?;
    let before = crate::version_policy::head(root);
    if before
        .as_ref()
        .and_then(|h| profile.version_metadata.commits.get(h))
        .is_some_and(|m| m.content == content)
    {
        return Ok(());
    }
    create_skill_snapshot_at_path(root, &format!("{message}\n\nSkillHub-Version: {version}"))?;
    let hash = crate::version_policy::head(root).ok_or("无法读回版本快照")?;
    let repo = git2::Repository::open(root).map_err(|e| e.to_string())?;
    let commit = repo
        .find_commit(git2::Oid::from_str(&hash).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if commit.parent_count() > 1 {
        return Err("当前提交有分支歧义，请先核对或保存新的安全内容".into());
    }
    crate::version_policy::commit_content(&repo, &commit)?;
    record_local_numbered_commit_at(root, profile, hash, content, version, allocation, true)
}

fn record_local_numbered_commit_at(
    root: &Path,
    profile: &mut SkillHubProfile,
    hash: String,
    content: crate::library_sync::content::ContentIdentity,
    version: &str,
    allocation: &str,
    pending_save: bool,
) -> Result<(), String> {
    let pending = pending_save.then(|| crate::version_policy::VersionIntent::Save {
        request_id: uuid::Uuid::new_v4().to_string(),
        card_sha256: String::new(),
        allocation: allocation.into(),
        label: version.into(),
    });
    profile.version_metadata.commits.insert(
        hash,
        crate::version_policy::CommitVersion {
            label: version.into(),
            original_label: version.into(),
            content,
            receipt: None,
            formal_version_id: None,
            pending,
        },
    );
    profile.version_metadata.high_water = profile
        .version_metadata
        .high_water
        .max(crate::version_policy::ordinal(version).ok_or("版本号无效")?);
    profile.version_metadata.current_receipt = None;
    profile.version = version.into();
    write_version_profile_at(root, profile)
}

/// Called under the Skill directory lock and the account session lease (or
/// sync guard). Initialise the saved content without publishing an asset or
/// inventing a receipt. A dirty working copy remains an unsaved working copy.
pub(crate) fn ensure_current_local_version_at(
    root: &Path,
    profile: &mut SkillHubProfile,
) -> Result<(), String> {
    if profile.is_system {
        return Ok(());
    }
    let before_metadata = profile.version_metadata.clone();
    let before_version = profile.version.clone();
    crate::version_policy::normalize_history(root, &mut profile.version_metadata)?;
    // Validate the current filesystem too: unsafe edits need explicit repair,
    // even when the saved HEAD itself is safe.
    let (actual, _) = crate::library_sync::content::local_identity(root, None)?;
    if let Some(hash) = crate::version_policy::head(root) {
        let repo = git2::Repository::open(root).map_err(|e| e.to_string())?;
        let commit = repo
            .find_commit(git2::Oid::from_str(&hash).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if let Some(problem) = profile.version_metadata.history_reviews.get(&hash) {
            return Err(problem.clone());
        }
        let saved_content = crate::version_policy::commit_content(&repo, &commit)?;
        // `version_metadata` was normalized above; derive the saved version
        // from it instead of walking the history a second time.
        let normalized = crate::version_policy::NormalizedView {
            metadata: profile.version_metadata.clone(),
            head: Some(hash.clone()),
        };
        if let Some(saved) = crate::version_policy::saved_current_in(root, &normalized) {
            profile.version = saved.label.clone();
            profile
                .version_metadata
                .commits
                .entry(hash)
                .or_insert(saved);
            if before_metadata != profile.version_metadata || before_version != profile.version {
                write_version_profile_at(root, profile)?;
            }
            return Ok(());
        }
        // Assign to the existing safe saved HEAD, not the dirty working tree.
        let version = crate::version_policy::allocate(profile.version_metadata.high_water, None)?;
        return record_local_numbered_commit_at(
            root,
            profile,
            hash,
            saved_content,
            &version,
            "auto",
            false,
        );
    }
    let version = crate::version_policy::allocate(profile.version_metadata.high_water, None)?;
    create_skill_snapshot_at_path(
        root,
        &format!("初始化本机版本\n\nSkillHub-Version: {version}"),
    )?;
    let hash = crate::version_policy::head(root).ok_or("无法读回版本快照")?;
    record_local_numbered_commit_at(root, profile, hash, actual, &version, "auto", false)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillVersionState {
    high_water: i32,
    next_version: Option<String>,
    pending: bool,
    pending_allocation: Option<String>,
    pending_label: Option<String>,
    current_receipt: Option<crate::version_policy::VersionReceipt>,
}

#[tauri::command]
pub async fn get_skill_version_state(skill_id: String) -> Result<SkillVersionState, String> {
    tauri::async_runtime::spawn_blocking(move || get_skill_version_state_blocking(skill_id))
        .await
        .map_err(|error| format!("Skill 版本状态读取异常结束: {error}"))?
}

pub fn get_skill_version_state_blocking(skill_id: String) -> Result<SkillVersionState, String> {
    note_read_command_thread();
    validate_skill_id(&skill_id)?;
    let _lock = crate::skill_lock::lock_skill_dir(&skill_id)?;
    let root = skill_path(&skill_id);
    let mut profile = read_profile_at_path(&root)?;
    let _lease = version_session_lease(&profile)?;
    if crate::version_policy::normalize_history(&root, &mut profile.version_metadata)? {
        write_version_profile_at(&root, &profile)?;
    }
    let metadata = profile.version_metadata;
    let current = crate::version_policy::current(&root, &metadata);
    let scoped =
        metadata.account_id.as_deref() == crate::runtime_env::active_runtime_user_id().as_deref();
    Ok(SkillVersionState {
        high_water: metadata.high_water,
        next_version: crate::version_policy::allocate(metadata.high_water, None).ok(),
        pending: current.as_ref().is_some_and(|m| m.pending.is_some()),
        pending_allocation: current.as_ref().and_then(|m| match &m.pending {
            Some(crate::version_policy::VersionIntent::Save { allocation, .. })
                if m.receipt.is_none() =>
            {
                Some(allocation.clone())
            }
            _ => None,
        }),
        pending_label: current.as_ref().and_then(|m| match &m.pending {
            Some(crate::version_policy::VersionIntent::Save { label, .. })
                if m.receipt.is_none() =>
            {
                Some(label.clone())
            }
            _ => None,
        }),
        current_receipt: if scoped {
            current.and_then(|m| m.receipt)
        } else {
            None
        },
    })
}

fn remove_sidecar_path(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        if metadata.file_type().is_symlink() {
            crate::platform_fs::remove_link(path).map_err(|error| error.to_string())
        } else {
            fs::remove_file(path).map_err(|error| error.to_string())
        }
    }
}

#[cfg(test)]
pub(crate) fn restore_skill_version_at_path(path: &Path, hash: &str) -> Result<(), String> {
    restore_skill_version_identity_at_path(path, hash, None)
}

pub(crate) fn restore_skill_version_identity_at_path(
    path: &Path,
    hash: &str,
    receipt_id: Option<&str>,
) -> Result<(), String> {
    if hash.len() != 40 {
        return Err("版本恢复需要完整 Git hash".into());
    }
    let mut version_profile = if path.join(".skillhub.json").exists() {
        library_read_profile_readonly(path)?
    } else {
        SkillHubProfile::default()
    };
    crate::version_policy::normalize_history(path, &mut version_profile.version_metadata)?;
    let mappings = crate::version_policy::history_for_hash(&version_profile.version_metadata, hash);
    let selected = if let Some(receipt_id) = receipt_id {
        if version_profile.version_metadata.account_id != version_profile.library_account_id
            || version_profile.version_metadata.entry_id != version_profile.library_entry_id
        {
            return Err("恢复版本收据不属于当前账号条目".into());
        }
        Some(
            mappings
                .into_iter()
                .find(|m| {
                    m.receipt
                        .as_ref()
                        .is_some_and(|r| r.receipt_id == receipt_id)
                })
                .ok_or("版本收据不属于所选完整 Git hash")?,
        )
    } else if mappings.len() > 1 {
        return Err("同一内容有多个版本身份，请用 receiptId 或 --receipt-id 精确选择".into());
    } else {
        mappings.into_iter().next()
    };
    let profile_path = path.join(".skillhub.json");
    let current_profile = match fs::symlink_metadata(&profile_path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("拒绝恢复包含符号链接的 SkillHub Profile".into())
        }
        Ok(metadata) if metadata.is_file() => Some((
            fs::read(&profile_path).map_err(|error| error.to_string())?,
            metadata.permissions(),
        )),
        Ok(_) => return Err("SkillHub Profile 必须是普通文件".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };

    // Pinned open: the checkout below must write the stored bytes verbatim (#353).
    let repo = crate::version_policy::open_repository(path).map_err(|error| error.to_string())?;
    let mut status_options = git2::StatusOptions::new();
    status_options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut status_options))
        .map_err(|error| format!("无法确认版本恢复前的工作区状态: {error}"))?;
    if statuses
        .iter()
        .any(|entry| entry.path() != Ok(".skillhub.json"))
    {
        return Err(
            "版本恢复前检测到未保存内容；可能有 Agent 投影编辑刚刚回写，请先创建快照".into(),
        );
    }
    drop(statuses);
    let oid = git2::Oid::from_str(hash).map_err(|error| error.to_string())?;
    let commit = repo.find_commit(oid).map_err(|error| error.to_string())?;
    let tree = commit.tree().map_err(|error| error.to_string())?;
    crate::cli_lifecycle::validate_restore_target_tree_for_checkout(&repo, &tree)?;
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    let checkout_result = repo
        .checkout_tree(tree.as_object(), Some(&mut checkout))
        .map_err(|error| error.to_string());

    // `.skillhub.json` is current account/runtime metadata, not historical Skill content.
    // Restore it even when checkout partially fails so an old version cannot rebind the Skill.
    let profile_result = (|| -> Result<(), String> {
        remove_sidecar_path(&profile_path)?;
        if let Some((contents, permissions)) = current_profile {
            fs::write(&profile_path, contents).map_err(|error| error.to_string())?;
            fs::set_permissions(&profile_path, permissions).map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    if let Err(profile_error) = profile_result {
        return match checkout_result {
            Ok(()) => Err(format!("无法保留当前 SkillHub Profile: {profile_error}")),
            Err(checkout_error) => Err(format!(
                "版本恢复失败: {checkout_error}; 同时无法保留当前 SkillHub Profile: {profile_error}"
            )),
        };
    }
    checkout_result?;
    drop(tree);
    drop(commit);
    drop(repo);
    create_skill_snapshot_at_path(path, &format!("恢复版本 {}", &hash[..hash.len().min(8)]))?;
    if let Some(mut mapped) = selected {
        let accepted = mapped
            .receipt
            .as_ref()
            .filter(|_| {
                version_profile.version_metadata.account_id == version_profile.library_account_id
                    && version_profile.version_metadata.entry_id == version_profile.library_entry_id
            })
            .map(|r| crate::version_policy::VersionIntent::Select {
                receipt_id: r.receipt_id.clone(),
            });
        if accepted.is_some() {
            mapped.pending = accepted;
        }
        version_profile.version = mapped.label.clone();
        version_profile.version_metadata.current_receipt = None;
        if let Some(restored_hash) = crate::version_policy::head(path) {
            version_profile
                .version_metadata
                .commits
                .insert(restored_hash, mapped);
        }
        write_version_profile_at(path, &version_profile)?;
    }
    Ok(())
}

/// Restore to a specific git commit
#[tauri::command]
pub fn restore_skill_version(
    skill_id: String,
    hash: String,
    receipt_id: Option<String>,
) -> Result<(), String> {
    validate_skill_id(&skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    let _lock = crate::skill_lock::lock_skill_dir(&skill_id)?;
    let _lease = version_session_lease(&read_profile_result(&skill_id)?)?;
    reconcile_skill_projection_at(&skillhub_dir(), &skills_dir(), &skill_id)?;
    restore_skill_version_identity_at_path(&skill_path(&skill_id), &hash, receipt_id.as_deref())?;
    if projection_root_at(&skillhub_dir(), &skill_id)
        .join("current")
        .exists()
    {
        refresh_skill_projection(&skill_id)?;
    }
    Ok(())
}

const MAX_DIFF_LINES: usize = 5_000;
const MAX_DIFF_BYTES: usize = 512 * 1024;

fn collect_diff_lines(diff: &git2::Diff<'_>) -> Result<Vec<DiffLine>, String> {
    let mut lines: Vec<DiffLine> = Vec::new();
    let mut total_bytes = 0_usize;
    diff.print(git2::DiffFormat::Patch, |delta, _hunk, line| {
        let relative = delta.new_file().path().or_else(|| delta.old_file().path());
        if relative.is_some_and(|path| path == Path::new(".skillhub.json") || should_skip(path)) {
            return true;
        }
        if lines.len() >= MAX_DIFF_LINES || total_bytes >= MAX_DIFF_BYTES {
            return false;
        }
        let kind = match line.origin() {
            '+' => "add",
            '-' => "del",
            _ => "ctx",
        };
        let content = String::from_utf8_lossy(line.content()).to_string();
        total_bytes = total_bytes.saturating_add(content.len());
        lines.push(DiffLine {
            kind: kind.to_string(),
            content,
        });
        true
    })
    .map_err(|error| error.to_string())?;
    Ok(lines)
}

/// Get diff between two commits
#[tauri::command]
pub async fn get_skill_diff(
    skill_id: String,
    from_hash: String,
    to_hash: String,
) -> Result<Vec<DiffLine>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        get_skill_diff_blocking(skill_id, from_hash, to_hash)
    })
    .await
    .map_err(|error| format!("Skill 版本差异读取异常结束: {error}"))?
}

pub fn get_skill_diff_blocking(
    skill_id: String,
    from_hash: String,
    to_hash: String,
) -> Result<Vec<DiffLine>, String> {
    note_read_command_thread();
    validate_skill_id(&skill_id)?;
    let path = skill_path(&skill_id);
    let repo = git2::Repository::open(&path).map_err(|e| e.to_string())?;
    let from_oid = git2::Oid::from_str(&from_hash).map_err(|e| e.to_string())?;
    let to_oid = git2::Oid::from_str(&to_hash).map_err(|e| e.to_string())?;
    let from_tree = repo
        .find_commit(from_oid)
        .map_err(|e| e.to_string())?
        .tree()
        .map_err(|e| e.to_string())?;
    let to_tree = repo
        .find_commit(to_oid)
        .map_err(|e| e.to_string())?
        .tree()
        .map_err(|e| e.to_string())?;
    let diff = repo
        .diff_tree_to_tree(Some(&from_tree), Some(&to_tree), None)
        .map_err(|e| e.to_string())?;
    collect_diff_lines(&diff)
}

/// Get the current working-copy diff against HEAD. This is the preview shown
/// before a user creates and uploads a new Skill version.
#[tauri::command]
pub async fn get_skill_working_diff(skill_id: String) -> Result<Vec<DiffLine>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        note_read_command_thread();
        get_skill_working_diff_at(&skillhub_dir(), &skills_dir(), &skill_id)
    })
    .await
    .map_err(|error| format!("Skill 工作副本差异读取异常结束: {error}"))?
}

fn get_skill_working_diff_at(
    skillhub_root: &Path,
    managed_root: &Path,
    skill_id: &str,
) -> Result<Vec<DiffLine>, String> {
    validate_skill_id(skill_id)?;
    reconcile_skill_projection_at(skillhub_root, managed_root, skill_id)?;
    let repo =
        git2::Repository::open(managed_root.join(skill_id)).map_err(|error| error.to_string())?;
    let head_tree = repo
        .head()
        .map_err(|error| error.to_string())?
        .peel_to_tree()
        .map_err(|error| error.to_string())?;
    let mut options = git2::DiffOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true);
    let diff = repo
        .diff_tree_to_workdir_with_index(Some(&head_tree), Some(&mut options))
        .map_err(|error| error.to_string())?;
    collect_diff_lines(&diff)
}

/// Static analysis: detect env var dependencies in a skill's files.
/// Captured local `.env` values are still moved into the private store first;
/// the scan itself is read-only and returns suggestions with evidence (#250).
fn detect_env_var_suggestions_blocking(
    skill_id: String,
) -> Result<Vec<crate::env_detect::EnvSuggestion>, String> {
    validate_skill_id(&skill_id)?;
    let path = skill_path(&skill_id);
    let discovered_env_values = discover_skill_env_values(&path)?;
    {
        // 重新检测时顺带清掉存量 sidecar 里由检测加入的配置名（#287）；有改动才写回。
        let mut profile = read_profile_result(&skill_id)?;
        let before = serde_json::to_string(&profile.env_dependencies).unwrap_or_default();
        if !discovered_env_values.is_empty() {
            merge_profile_env_dependencies(&mut profile, discovered_env_values.keys().cloned());
        }
        crate::env_detect::prune_non_secret_detected(&mut profile.env_dependencies);
        if serde_json::to_string(&profile.env_dependencies).unwrap_or_default() != before {
            write_profile(&skill_id, &profile).map_err(|error| error.to_string())?;
        }
    }
    if !discovered_env_values.is_empty() {
        persist_skill_env_values(&skill_id, &discovered_env_values, None)?;
        archive_captured_skill_env_files(&path, &skill_id)?;
    }
    reconcile_skill_projection_at(&skillhub_dir(), &skills_dir(), &skill_id)?;
    let mut suggestions = crate::env_detect::detect_env_suggestions(&path);
    for key in discovered_env_values.keys() {
        if !crate::env_detect::is_candidate_key(key) || !crate::env_detect::is_secret_key_name(key)
        {
            continue;
        }
        let evidence = "本机 .env 文件（值已转存到个人配置）".to_string();
        match suggestions
            .iter_mut()
            .find(|suggestion| &suggestion.key == key)
        {
            Some(suggestion) => {
                suggestion.confidence = suggestion
                    .confidence
                    .min(crate::env_detect::EnvConfidence::High);
                suggestion.evidence.push(evidence);
            }
            None => suggestions.push(crate::env_detect::EnvSuggestion {
                key: key.clone(),
                confidence: crate::env_detect::EnvConfidence::High,
                evidence: vec![evidence],
            }),
        }
    }
    suggestions.sort_by(|left, right| left.key.cmp(&right.key));
    Ok(suggestions)
}

/// Compatibility shape: key names of every non-`low` suggestion.
fn detect_env_vars_blocking(skill_id: String) -> Result<Vec<String>, String> {
    Ok(detect_env_var_suggestions_blocking(skill_id)?
        .into_iter()
        .filter(|suggestion| suggestion.confidence != crate::env_detect::EnvConfidence::Low)
        .map(|suggestion| suggestion.key)
        .collect())
}

#[tauri::command]
pub async fn detect_env_vars(skill_id: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || detect_env_vars_blocking(skill_id))
        .await
        .map_err(|error| format!("Skill 环境变量后台扫描异常结束: {error}"))?
}

#[tauri::command]
pub async fn detect_env_var_suggestions(
    skill_id: String,
) -> Result<Vec<crate::env_detect::EnvSuggestion>, String> {
    tauri::async_runtime::spawn_blocking(move || detect_env_var_suggestions_blocking(skill_id))
        .await
        .map_err(|error| format!("Skill 环境变量后台扫描异常结束: {error}"))?
}

/// Remove the aggregate generated by older builds. Per-Skill values remain in
/// their own 0600 file and are injected only into an explicitly launched CLI.
pub fn retire_legacy_active_env() -> Result<(), String> {
    let path = crate::active_env_path();
    if !path.exists() {
        return Ok(());
    }
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("旧版 active.env 是符号链接，请手动检查后移除".into());
    }
    let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    if contents.starts_with("# Generated by SkillHub") {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Return detected agent tools
#[tauri::command]
pub async fn get_installed_agents() -> Result<Vec<AgentInfo>, String> {
    tauri::async_runtime::spawn_blocking(detect_agents)
        .await
        .map_err(|error| error.to_string())
}

/// Read the source document used for server-side AI analysis.
#[tauri::command]
pub async fn read_skill_md(skill_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_skill_md_blocking(skill_id))
        .await
        .map_err(|error| format!("SKILL.md 读取异常结束: {error}"))?
}

pub fn read_skill_md_blocking(skill_id: String) -> Result<String, String> {
    note_read_command_thread();
    validate_skill_id(&skill_id)?;
    reconcile_skill_projection_at(&skillhub_dir(), &skills_dir(), &skill_id)?;
    fs::read_to_string(skill_path(&skill_id).join("SKILL.md"))
        .map_err(|error| format!("无法读取 SKILL.md: {error}"))
}

const MAX_INSPECTED_SKILL_MD_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarkdownInspection {
    pub has_frontmatter: bool,
    pub fields: Vec<crate::skill_document::FrontmatterField>,
    pub body: String,
    pub lint: Vec<crate::skill_document::SkillLintIssue>,
}

/// Splits SKILL.md into its metadata and body and reports advisory spec
/// issues. It takes the text rather than a Skill id because the detail view
/// also shows Marketplace and Server copies that are not on disk.
#[tauri::command]
pub fn inspect_skill_markdown(content: String) -> Result<SkillMarkdownInspection, String> {
    if content.len() > MAX_INSPECTED_SKILL_MD_BYTES {
        return Err("SKILL.md 超过 4 MB，无法解析".into());
    }
    let document = crate::skill_document::parse_skill_document(&content);
    let lint = crate::skill_document::lint_skill_document(&document, content.len());
    Ok(SkillMarkdownInspection {
        has_frontmatter: document.has_frontmatter,
        fields: document.fields,
        body: document.body.to_string(),
        lint,
    })
}

const MAX_PREVIEW_FILE_BYTES: u64 = 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SkillFilePreview {
    Text {
        path: String,
        size: u64,
        content: String,
    },
    Binary {
        path: String,
        size: u64,
    },
    TooLarge {
        path: String,
        size: u64,
    },
}

/// Previews one file of a managed Skill. The requested path is only matched
/// against the entries `collect_skill_tree` lists, so it can never reach a
/// generated directory, a private env file, a symlink, or anything outside
/// the Skill root.
fn read_skill_file_at(root: &Path, requested: &str) -> Result<SkillFilePreview, String> {
    let entry = collect_skill_tree(root)?
        .into_iter()
        .find(|entry| !entry.is_directory && entry.normalized == requested)
        .ok_or_else(|| "文件不存在或不能预览".to_string())?;
    if entry.size > MAX_PREVIEW_FILE_BYTES {
        return Ok(SkillFilePreview::TooLarge {
            path: entry.normalized,
            size: entry.size,
        });
    }
    let bytes = fs::read(&entry.path).map_err(|error| format!("无法读取文件: {error}"))?;
    let sniff = &bytes[..bytes.len().min(BINARY_SNIFF_BYTES)];
    if sniff.contains(&0) {
        return Ok(SkillFilePreview::Binary {
            path: entry.normalized,
            size: entry.size,
        });
    }
    Ok(match String::from_utf8(bytes) {
        Ok(content) => SkillFilePreview::Text {
            path: entry.normalized,
            size: entry.size,
            content,
        },
        Err(_) => SkillFilePreview::Binary {
            path: entry.normalized,
            size: entry.size,
        },
    })
}

#[tauri::command]
pub async fn read_skill_file(skill_id: String, path: String) -> Result<SkillFilePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        note_read_command_thread();
        validate_skill_id(&skill_id)?;
        read_skill_file_at(&skill_path(&skill_id), &path)
    })
    .await
    .map_err(|error| format!("read_skill_file异常结束: {error}"))?
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillAvatarCache {
    avatar_url: Option<String>,
    avatar_status: String,
}

fn avatar_cache_path_at(root: &Path, account: &str, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(account).map_err(|_| "头像账号无效")?;
    if id != crate::system_skill::SYSTEM_MANAGER_ID {
        uuid::Uuid::parse_str(id).map_err(|_| "头像身份无效")?;
    }
    Ok(root
        .join("avatars")
        .join(account)
        .join(format!("{id}.json")))
}

fn avatar_cache_path(account: &str, id: &str) -> Result<PathBuf, String> {
    let session = crate::runtime_env::runtime_session_snapshot()?;
    if session.is_sync_pending() || session.user_id() != account {
        return Err(crate::spaces::STALE.into());
    }
    avatar_cache_path_at(&session.storage_root(&skillhub_dir()), account, id)
}

// ponytail: one GUI instance serializes local identity writes; CLI never creates avatar identities.
static SKILL_AVATAR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Upper bound for the per-account parking file: a few hundred entries at most.
const MAX_AVATAR_PARKING_BYTES: u64 = 256 * 1024;

fn avatar_parking_path(account: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(account).map_err(|_| "头像账号无效")?;
    let session = crate::runtime_env::runtime_session_snapshot()?;
    if session.is_sync_pending() || session.user_id() != account {
        return Err(crate::spaces::STALE.into());
    }
    Ok(session
        .storage_root(&skillhub_dir())
        .join("avatars")
        .join(account)
        .join("parked.json"))
}

/// Parked avatar identity conflicts for one account (#149), persisted so a
/// 409 stays parked across sign-out, sign-in and restarts. Only the signed-in
/// account's own file is readable; the content is opaque JSON for the UI.
#[tauri::command]
pub async fn read_avatar_parking(
    space: crate::server_request::SpaceHandle,
    account_user_id: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = crate::runtime_env::runtime_session_snapshot()?;
        crate::spaces::require_handle(&session, &space)?;
        if session.user_id() != account_user_id {
            return Err("登录账号已经切换".into());
        }
        let _lease = crate::runtime_env::acquire_current_session_lease(&session)?
            .ok_or(crate::spaces::STALE)?;
        let path = avatar_parking_path(&account_user_id)?;
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("头像停放记录不是安全的普通文件".into());
        }
        if metadata.len() > MAX_AVATAR_PARKING_BYTES {
            return Err("头像停放记录过大".into());
        }
        let json = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json)
            .map_err(|_| "头像停放记录已损坏".to_string())?;
        Ok(Some(json))
    })
    .await
    .map_err(|error| format!("read_avatar_parking异常结束: {error}"))?
}

#[tauri::command]
pub async fn write_avatar_parking(
    space: crate::server_request::SpaceHandle,
    account_user_id: String,
    json: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = crate::runtime_env::runtime_session_snapshot()?;
        crate::spaces::require_handle(&session, &space)?;
        if session.user_id() != account_user_id || session.is_sync_pending() {
            return Err("登录账号已经切换".into());
        }
        if json.len() as u64 > MAX_AVATAR_PARKING_BYTES {
            return Err("头像停放记录过大".into());
        }
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json)
            .map_err(|_| "头像停放记录无效".to_string())?;
        let _lease = crate::runtime_env::acquire_current_session_lease(&session)?
            .ok_or(crate::spaces::STALE)?;
        let path = avatar_parking_path(&account_user_id)?;
        for parent in [
            session.storage_root(&skillhub_dir()).join("avatars"),
            path.parent().ok_or("头像缓存目录无效")?.to_path_buf(),
        ] {
            if fs::symlink_metadata(&parent)
                .is_ok_and(|metadata| !metadata.is_dir() || metadata.file_type().is_symlink())
            {
                return Err("头像缓存目录无效".into());
            }
            fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
        }
        write_private_text_file(&path, &json)
    })
    .await
    .map_err(|error| format!("write_avatar_parking异常结束: {error}"))?
}

fn write_private_text_file(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("路径无效")?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("parked"),
        uuid::Uuid::new_v4()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    std::io::Write::write_all(&mut file, contents.as_bytes()).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}

#[tauri::command]
pub async fn ensure_skill_avatar_identity(skill_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_skill_avatar_identity_blocking(skill_id))
        .await
        .map_err(|error| format!("头像身份任务异常结束: {error}"))?
}

fn ensure_skill_avatar_identity_blocking(skill_id: String) -> Result<String, String> {
    let _lock = SKILL_AVATAR_LOCK.lock().map_err(|_| "头像缓存不可用")?;
    validate_skill_id(&skill_id)?;
    if !skill_path(&skill_id).join("SKILL.md").is_file() {
        return Err("Skill 不存在".into());
    }
    ensure_skill_avatar_identity_at(&skill_path(&skill_id))
}

fn ensure_skill_avatar_identity_at(root: &Path) -> Result<String, String> {
    let mut profile = read_current_profile_at_path(root)?;
    if profile.is_system {
        return Ok(crate::system_skill::SYSTEM_MANAGER_ID.to_string());
    }
    if let Some(id) = profile.avatar_local_id {
        uuid::Uuid::parse_str(&id).map_err(|_| "头像身份无效")?;
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    profile.avatar_local_id = Some(id.clone());
    write_profile_at_path(root, &profile).map_err(|error| error.to_string())?;
    Ok(id)
}

#[tauri::command]
pub(crate) async fn cache_skill_avatar(
    space: crate::server_request::SpaceHandle,
    state: tauri::State<'_, crate::server_request::SpaceRegistry>,
    skill_id: String,
    account_user_id: String,
    avatar_url: Option<String>,
    avatar_status: String,
) -> Result<(), String> {
    validate_skill_id(&skill_id)?;
    let session = crate::runtime_env::runtime_session_snapshot()?;
    crate::spaces::require_handle(&session, &space)?;
    if session.user_id() != account_user_id
        || session.auth_token().is_none()
        || session.is_sync_pending()
    {
        return Err("登录账号已经切换".into());
    }
    if !["none", "pending", "ready", "failed", "needs_review"].contains(&avatar_status.as_str()) {
        return Err("头像状态无效".into());
    }
    if let Some(value) = &avatar_url {
        state.validate_image_url(value).await?;
    }
    let _lease =
        crate::runtime_env::acquire_current_session_lease(&session)?.ok_or("登录账号已经切换")?;
    let id = ensure_skill_avatar_identity_blocking(skill_id)?;
    let path = avatar_cache_path(&account_user_id, &id)?;
    for parent in [
        session.storage_root(&skillhub_dir()).join("avatars"),
        path.parent().ok_or("头像缓存目录无效")?.to_path_buf(),
    ] {
        if fs::symlink_metadata(&parent)
            .is_ok_and(|metadata| !metadata.is_dir() || metadata.file_type().is_symlink())
        {
            return Err("头像缓存目录无效".into());
        }
        fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    let cache = SkillAvatarCache {
        avatar_url: if avatar_status == "ready" {
            avatar_url
        } else {
            None
        },
        avatar_status,
    };
    write_private_file(
        &path,
        &serde_json::to_string(&cache).map_err(|error| error.to_string())?,
    )
}

/// Persist authoritative server metadata without modifying third-party SKILL.md.
#[tauri::command]
pub fn update_skill_profile(
    space: crate::server_request::SpaceHandle,
    skill_id: String,
    profile: SkillProfileUpdateInput,
) -> Result<LocalSkill, String> {
    let session = crate::runtime_env::runtime_session_snapshot()?;
    crate::spaces::require_handle(&session, &space)?;
    let _lease =
        crate::runtime_env::acquire_current_session_lease(&session)?.ok_or(crate::spaces::STALE)?;
    validate_skill_id(&skill_id)?;
    let _lock = crate::skill_lock::lock_skill_dir(&skill_id)?;
    update_skill_profile_unlocked(skill_id, profile)
}

fn update_skill_profile_unlocked(
    skill_id: String,
    profile: SkillProfileUpdateInput,
) -> Result<LocalSkill, String> {
    validate_skill_id(&skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    let mut stored = read_profile_result(&skill_id)?;
    let _session = version_session_lease(&stored)?;
    stored.scope = Some(crate::spaces::SidecarScope::for_session(
        &crate::runtime_env::runtime_session_snapshot()?,
    ));
    if let Some(value) = profile.server_id {
        stored.server_id = Some(value);
    }
    if let Some(value) = profile.server_owner_id {
        stored.server_owner_id = Some(value);
    }
    if let Some(value) = profile.display_name {
        stored.display_name = Some(value);
    }
    if let Some(value) = profile.description {
        stored.description = Some(value);
    }
    if let Some(value) = profile.category {
        stored.category = Some(value);
    }
    // Omitted keeps the stored source; explicit null / blank clears it.
    if let Some(value) = profile.source_url {
        let previous = stored.source_url.take();
        stored.source_url = match value {
            Some(value) => crate::validate_source_url(&value)?,
            None => None,
        };
        // Remember exactly which source the user removed until account sync
        // carries the clear, so that value cannot come back but a newer one can.
        stored.source_url_cleared = if stored.source_url.is_none() {
            crate::sanitize_source_url(profile.cleared_source_url.as_deref())
                .or(previous)
                .or(stored.source_url_cleared.take())
        } else {
            None
        };
    }
    if let Some(value) = profile.version {
        stored.version = value;
    }
    stored.labels = profile.labels;
    stored.trigger_scenarios = profile.trigger_scenarios;
    stored.compatible_agents = profile.compatible_agents;
    write_profile(&skill_id, &stored).map_err(|error| error.to_string())?;
    Ok(build_local_skill(&skill_id))
}

pub(crate) fn reconcile_local_team_shares(
    skill_id: String,
    server_id: &str,
    server_owner_id: &str,
    team_ids: Vec<String>,
) -> Result<(), String> {
    validate_skill_id(&skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    let server_id = uuid::Uuid::parse_str(server_id)
        .map(|value| value.to_string())
        .map_err(|_| "服务端 Skill 标识无效".to_string())?;
    let server_owner_id = uuid::Uuid::parse_str(server_owner_id)
        .map(|value| value.to_string())
        .map_err(|_| "服务端所有者标识无效".to_string())?;
    if team_ids.len() > 1_000 {
        return Err("团队共享数量超过安全上限".into());
    }
    let mut normalized_team_ids = team_ids
        .into_iter()
        .map(|team_id| {
            uuid::Uuid::parse_str(&team_id)
                .map(|value| value.to_string())
                .map_err(|_| "团队标识无效".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    normalized_team_ids.sort();
    normalized_team_ids.dedup();

    let mut stored = read_profile_result(&skill_id)?;
    if stored.is_system
        || stored.is_own == Some(false)
        || profile_acquisition_source(&stored) != AcquisitionSource::Local
    {
        return Err("只有当前账号拥有的本地 Skill 可以同步团队共享状态".into());
    }
    if stored.server_id.as_deref() != Some(server_id.as_str())
        || stored.server_owner_id.as_deref() != Some(server_owner_id.as_str())
    {
        return Err("本地 Skill 的云端归属在共享期间发生变化".into());
    }
    stored.is_own = Some(true);
    stored.teams = normalized_team_ids.clone();
    stored.team_ids = normalized_team_ids;
    write_profile(&skill_id, &stored).map_err(|error| error.to_string())
}

/// Where 「填写个人值」 stores a value: the account key vault (default; every
/// Skill declaring the same key can use it) or only this Skill (override).
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkillEnvScope {
    #[default]
    Vault,
    Skill,
}

/// Set one personal value for a Skill's declared key: into the account key
/// vault (default, and this Skill is allowed to use it), or with
/// `scope: skill` into `~/.skillhub/envs/<user>/<skill>.env` as this Skill's
/// own override.
#[tauri::command]
pub fn set_skill_env(
    space: crate::server_request::SpaceHandle,
    skill_id: String,
    key: String,
    mut value: String,
    account_user_id: Option<String>,
    scope: Option<SkillEnvScope>,
) -> Result<(), String> {
    let result = set_skill_env_inner(
        &skill_id,
        &key,
        &value,
        account_user_id.as_deref(),
        scope.unwrap_or_default(),
        &space,
    );
    value.zeroize();
    result
}

fn set_skill_env_inner(
    skill_id: &str,
    key: &str,
    value: &str,
    account_user_id: Option<&str>,
    scope: SkillEnvScope,
    space: &crate::server_request::SpaceHandle,
) -> Result<(), String> {
    validate_skill_id(skill_id)?;
    reject_system_skill_mutation(skill_id)?;
    if !is_valid_env_key(key) {
        return Err("环境变量名必须为大写字母、数字和下划线".into());
    }
    if !read_profile_result(skill_id)?
        .env_dependencies
        .iter()
        .any(|dependency| dependency.key == key)
    {
        return Err("请先把这个变量加入 Skill 的环境依赖清单".into());
    }
    if value.is_empty() || value.len() > 16_384 || value.contains('\0') || value.contains('\n') {
        return Err("环境变量值不能为空、不能换行，且不能超过 16 KB".into());
    }
    let root = skillhub_dir();
    let env_root = envs_dir();
    crate::key_vault::with_current_identity_at(
        &root,
        &env_root,
        account_user_id,
        Some(space),
        |root, env_root, runtime_user_id| match scope {
            SkillEnvScope::Vault => {
                // A declared name linked to another key (#288) refills that key.
                let lookup = crate::key_vault::vault_lookup_names_at(root, runtime_user_id)?;
                let vault_key = lookup.get(key).map_or(key, String::as_str);
                crate::key_vault::set_vault_key_at(
                    root,
                    runtime_user_id,
                    vault_key,
                    value,
                    Some(skill_id),
                    crate::key_vault::now_ms(),
                )?;
                // Filling from this Skill means this Skill should use it.
                crate::key_vault::remove_override_at(env_root, runtime_user_id, skill_id, key)?;
                clear_run_failures_for_vault_key(root, runtime_user_id, vault_key, &[key]);
                Ok(())
            }
            SkillEnvScope::Skill => {
                persist_skill_env_values_at(
                    env_root,
                    runtime_user_id,
                    skill_id,
                    &BTreeMap::from([(key.to_string(), value.to_string())]),
                )?;
                crate::last_run::clear_failures_for_keys_at(
                    root,
                    runtime_user_id,
                    &[key],
                    Some(skill_id),
                );
                Ok(())
            }
        },
    )
}

/// Removes this Skill's own (override) value. The account key vault is only
/// changed from the 「钥匙」 page (`delete_vault_key`).
#[tauri::command]
pub fn delete_skill_env(
    skill_id: String,
    key: String,
    account_user_id: Option<String>,
) -> Result<(), String> {
    validate_skill_id(&skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    let runtime_user_id =
        crate::runtime_env::resolve_active_runtime_user(account_user_id.as_deref())?;
    if !is_valid_env_key(&key) {
        return Err("环境变量名必须为大写字母、数字和下划线".into());
    }
    let env_path = crate::runtime_env::account_env_path(&runtime_user_id, &skill_id)?;
    delete_env_value_from_file(&env_path, &key)
}

// ── 「钥匙」 page: names and metadata only, values never leave Rust ─────────

#[tauri::command]
pub async fn list_vault_keys(
    space: crate::server_request::SpaceHandle,
    account_user_id: Option<String>,
) -> Result<Vec<crate::key_vault::VaultKeyRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = skillhub_dir();
        let env_root = envs_dir();
        crate::key_vault::with_current_identity_at(
            &root,
            &env_root,
            account_user_id.as_deref(),
            Some(&space),
            |root, env_root, user_id| {
                crate::key_vault::list_vault_keys_at(root, &skills_dir(), env_root, user_id)
            },
        )
    })
    .await
    .map_err(|error| format!("读取钥匙库异常结束: {error}"))?
}

// ── Key backup files (#289) ──────────────────────────────────────────────────
//
// `~/.skillhub/env-import-backups/` holds the `.env` files moved aside when a
// Skill is imported and the vault-migration backups. Settings shows a count and
// size, can reveal the folder and can delete everything inside it. Nothing here
// reads file contents, follows a link or touches a path outside that folder.

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvBackupSummary {
    /// Immediate entries (backup folders and loose files); links are not counted.
    pub count: u64,
    /// Total size of the regular files below those entries.
    pub bytes: u64,
    /// Oldest entry modification time in Unix milliseconds.
    pub oldest_at: Option<u64>,
    pub dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvBackupDeletion {
    pub removed: u64,
}

fn env_backups_dir() -> Result<PathBuf, String> {
    let session = crate::runtime_env::runtime_session_snapshot()?;
    if session.is_sync_pending() {
        return Err(crate::spaces::STALE.into());
    }
    Ok(session
        .storage_root(&skillhub_dir())
        .join("env-import-backups"))
}

fn is_link(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

/// `None` when the folder does not exist; an error when it is not a real directory.
fn env_backups_root_metadata(dir: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(dir) {
        Ok(metadata) if is_link(&metadata) || !metadata.is_dir() => {
            Err("钥匙备份目录不是安全目录，已拒绝操作".into())
        }
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取钥匙备份目录: {error}")),
    }
}

fn env_backup_entry_bytes(path: &Path, metadata: &fs::Metadata) -> u64 {
    if metadata.is_file() {
        return metadata.len();
    }
    WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum()
}

fn env_backup_summary_at(dir: &Path) -> Result<EnvBackupSummary, String> {
    let mut summary = EnvBackupSummary {
        count: 0,
        bytes: 0,
        oldest_at: None,
        dir: dir.to_string_lossy().into_owned(),
    };
    if env_backups_root_metadata(dir)?.is_none() {
        return Ok(summary);
    }
    for entry in fs::read_dir(dir).map_err(|error| format!("无法读取钥匙备份目录: {error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取钥匙备份目录: {error}"))?;
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if is_link(&metadata) {
            continue;
        }
        summary.count += 1;
        summary.bytes += env_backup_entry_bytes(&entry.path(), &metadata);
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64);
        if let Some(modified) = modified {
            summary.oldest_at = Some(
                summary
                    .oldest_at
                    .map_or(modified, |oldest| oldest.min(modified)),
            );
        }
    }
    Ok(summary)
}

/// Removes every non-link entry directly inside `dir`. Links are left alone
/// (never followed); `remove_dir_all` does not follow links inside a folder.
fn delete_env_backups_at(dir: &Path) -> Result<EnvBackupDeletion, String> {
    let mut removed = 0;
    if env_backups_root_metadata(dir)?.is_none() {
        return Ok(EnvBackupDeletion { removed });
    }
    for entry in fs::read_dir(dir).map_err(|error| format!("无法读取钥匙备份目录: {error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取钥匙备份目录: {error}"))?;
        let path = entry.path();
        if path.parent() != Some(dir) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("无法读取钥匙备份文件: {error}"))?;
        if is_link(&metadata) {
            continue;
        }
        if metadata.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        }
        .map_err(|error| format!("删除钥匙备份文件失败: {error}"))?;
        removed += 1;
    }
    Ok(EnvBackupDeletion { removed })
}

/// 「钥匙备份文件 · N 份 · 大小」 in Settings (#289). Names and sizes only.
#[tauri::command]
pub async fn list_env_backups() -> Result<EnvBackupSummary, String> {
    tauri::async_runtime::spawn_blocking(move || env_backup_summary_at(&env_backups_dir()?))
        .await
        .map_err(|error| format!("list_env_backups异常结束: {error}"))?
}

/// Opens the backup folder in Finder / Explorer, creating it when missing.
#[tauri::command]
pub fn reveal_env_backups() -> Result<(), String> {
    let dir = env_backups_dir()?;
    if env_backups_root_metadata(&dir)?.is_none() {
        fs::create_dir_all(&dir).map_err(|error| format!("无法创建钥匙备份目录: {error}"))?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    env_backups_root_metadata(&dir)?;
    open::that(dir).map_err(|error| error.to_string())
}

/// Deletes everything inside `~/.skillhub/env-import-backups/`; the vault is untouched.
#[tauri::command]
pub fn delete_env_backups() -> Result<EnvBackupDeletion, String> {
    delete_env_backups_at(&env_backups_dir()?)
}

#[cfg(test)]
mod env_backup_tests {
    use super::{delete_env_backups_at, env_backup_summary_at};
    use std::fs;

    fn fixture(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "skillhub-env-backups-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn missing_or_empty_backup_dir_reports_zero() {
        let root = fixture("empty");
        let dir = root.join("env-import-backups");
        let summary = env_backup_summary_at(&dir).unwrap();
        assert_eq!(
            (summary.count, summary.bytes, summary.oldest_at),
            (0, 0, None)
        );
        assert_eq!(delete_env_backups_at(&dir).unwrap().removed, 0);
        fs::create_dir(&dir).unwrap();
        assert_eq!(env_backup_summary_at(&dir).unwrap().count, 0);
        assert_eq!(delete_env_backups_at(&dir).unwrap().removed, 0);
        assert!(dir.is_dir());
    }

    #[test]
    fn summary_counts_entries_and_sums_sizes_recursively() {
        let root = fixture("list");
        let dir = root.join("env-import-backups");
        fs::create_dir_all(dir.join("alpha-1/nested")).unwrap();
        fs::write(dir.join("alpha-1/.env"), b"12345").unwrap();
        fs::write(dir.join("alpha-1/nested/.env.local"), b"123").unwrap();
        fs::create_dir_all(dir.join("vault-migration-1-abcdef12")).unwrap();
        fs::write(
            dir.join("vault-migration-1-abcdef12/env.json"),
            b"1234567890",
        )
        .unwrap();
        fs::write(dir.join("loose.env"), b"12").unwrap();
        let summary = env_backup_summary_at(&dir).unwrap();
        assert_eq!(summary.count, 3);
        assert_eq!(summary.bytes, 20);
        assert!(summary.oldest_at.is_some());
        assert_eq!(summary.dir, dir.to_string_lossy());
    }

    #[cfg(unix)]
    #[test]
    fn delete_removes_only_inside_and_never_follows_links() {
        let root = fixture("delete");
        let dir = root.join("env-import-backups");
        let outside = root.join("outside");
        fs::create_dir_all(dir.join("alpha-1")).unwrap();
        fs::write(dir.join("alpha-1/.env"), b"secret").unwrap();
        fs::write(dir.join("loose.env"), b"x").unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), b"keep").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("link-out")).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("alpha-1/inner-link")).unwrap();
        assert_eq!(env_backup_summary_at(&dir).unwrap().count, 2);

        assert_eq!(delete_env_backups_at(&dir).unwrap().removed, 2);
        assert!(!dir.join("alpha-1").exists());
        assert!(!dir.join("loose.env").exists());
        assert!(fs::symlink_metadata(dir.join("link-out")).is_ok());
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"keep");
        assert!(dir.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_backup_root_is_refused() {
        let root = fixture("root-link");
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), b"keep").unwrap();
        let dir = root.join("env-import-backups");
        std::os::unix::fs::symlink(&outside, &dir).unwrap();
        assert!(env_backup_summary_at(&dir).is_err());
        assert!(delete_env_backups_at(&dir).is_err());
        assert!(outside.join("keep.txt").exists());
    }
}

#[tauri::command]
pub async fn get_key_vault_settings(
    space: crate::server_request::SpaceHandle,
    account_user_id: Option<String>,
) -> Result<crate::key_vault::KeyVaultSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = skillhub_dir();
        crate::key_vault::with_current_identity_at(
            &root,
            &envs_dir(),
            account_user_id.as_deref(),
            Some(&space),
            |root, _env_root, user_id| crate::key_vault::key_vault_settings_at(root, user_id),
        )
    })
    .await
    .map_err(|error| format!("读取钥匙库异常结束: {error}"))?
}

/// Fills or replaces a vault value: the unlabelled one, or with `variant`
/// one labelled value of `key` (#306; an unknown variant is an error).
#[tauri::command]
pub fn set_vault_key(
    space: crate::server_request::SpaceHandle,
    key: String,
    mut value: String,
    variant: Option<String>,
    account_user_id: Option<String>,
) -> Result<(), String> {
    let root = skillhub_dir();
    let result = crate::key_vault::with_current_identity_at(
        &root,
        &envs_dir(),
        account_user_id.as_deref(),
        Some(&space),
        |root, _env_root, user_id| {
            match variant.as_deref() {
                None => crate::key_vault::set_vault_key_at(
                    root,
                    user_id,
                    &key,
                    &value,
                    None,
                    crate::key_vault::now_ms(),
                )?,
                Some(variant) => crate::key_vault::set_vault_key_variant_value_at(
                    root,
                    user_id,
                    &key,
                    variant,
                    &value,
                    crate::key_vault::now_ms(),
                )?,
            }
            clear_run_failures_for_vault_key(root, user_id, &key, &[]);
            Ok(())
        },
    );
    value.zeroize();
    result
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedKeyVariant {
    /// The new labelled value's id, `V<n>`.
    pub variant: String,
}

/// 「再加一把」 (#306): a further value of `key` with a label.
#[tauri::command]
pub fn create_vault_key_variant(
    space: crate::server_request::SpaceHandle,
    key: String,
    label: String,
    mut value: String,
    account_user_id: Option<String>,
) -> Result<CreatedKeyVariant, String> {
    let root = skillhub_dir();
    let result = crate::key_vault::with_current_identity_at(
        &root,
        &envs_dir(),
        account_user_id.as_deref(),
        Some(&space),
        |root, _env_root, user_id| {
            crate::key_vault::create_vault_key_variant_at(
                root,
                user_id,
                &key,
                &label,
                &value,
                None,
                crate::key_vault::now_ms(),
            )
            .map(|variant| CreatedKeyVariant { variant })
        },
    );
    value.zeroize();
    result
}

/// Renames the label of one labelled value of `key` (#306).
#[tauri::command]
pub fn set_vault_key_variant_label(
    space: crate::server_request::SpaceHandle,
    key: String,
    variant: String,
    label: String,
    account_user_id: Option<String>,
) -> Result<(), String> {
    let root = skillhub_dir();
    crate::key_vault::with_current_identity_at(
        &root,
        &envs_dir(),
        account_user_id.as_deref(),
        Some(&space),
        |root, _env_root, user_id| {
            crate::key_vault::set_vault_key_variant_label_at(
                root,
                user_id,
                &key,
                &variant,
                &label,
                crate::key_vault::now_ms(),
            )
        },
    )
}

/// 「设为默认」 (#306): `variant: None` makes the unlabelled value default.
#[tauri::command]
pub fn set_vault_default_variant(
    space: crate::server_request::SpaceHandle,
    key: String,
    variant: Option<String>,
    account_user_id: Option<String>,
) -> Result<(), String> {
    let root = skillhub_dir();
    crate::key_vault::with_current_identity_at(
        &root,
        &envs_dir(),
        account_user_id.as_deref(),
        Some(&space),
        |root, _env_root, user_id| {
            crate::key_vault::set_vault_default_variant_at(
                root,
                user_id,
                &key,
                variant.as_deref(),
            )?;
            clear_run_failures_for_vault_key(root, user_id, &key, &[]);
            Ok(())
        },
    )
}

/// Turns a Skill's own (override) value for `key` into a labelled value of
/// the vault name behind `key` (#306): the value moves into the vault, the
/// override is removed and the Skill is pointed at the new value, so its
/// runs inject exactly the same value as before.
#[tauri::command]
pub fn convert_skill_override_to_variant(
    space: crate::server_request::SpaceHandle,
    skill_id: String,
    key: String,
    label: String,
    account_user_id: Option<String>,
) -> Result<CreatedKeyVariant, String> {
    validate_skill_id(&skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    if !is_valid_env_key(&key) {
        return Err("环境变量名必须为大写字母、数字和下划线".into());
    }
    if !read_profile_result(&skill_id)?
        .env_dependencies
        .iter()
        .any(|dependency| dependency.key == key)
    {
        return Err("这个钥匙已不在 Skill 的依赖清单中".into());
    }
    let root = skillhub_dir();
    let env_root = envs_dir();
    crate::key_vault::with_current_identity_at(
        &root,
        &env_root,
        account_user_id.as_deref(),
        Some(&space),
        |root, env_root, user_id| {
            let variant = convert_override_to_variant_at(
                root,
                env_root,
                user_id,
                &skill_id,
                &key,
                &label,
                crate::key_vault::now_ms(),
            )?;
            crate::last_run::clear_failures_for_keys_at(root, user_id, &[&key], Some(&skill_id));
            Ok(CreatedKeyVariant { variant })
        },
    )
}

/// The steps of [`convert_skill_override_to_variant`]; the caller holds the
/// identity lease. The policy is written before the override is removed so
/// an interruption never leaves the Skill on another value.
pub(crate) fn convert_override_to_variant_at(
    root: &Path,
    env_root: &Path,
    user_id: &str,
    skill_id: &str,
    key: &str,
    label: &str,
    now: u64,
) -> Result<String, String> {
    let allowed = BTreeSet::from([key.to_string()]);
    let mut own = crate::runtime_env::read_private_env_values(
        &crate::runtime_env::account_env_path_at(env_root, user_id, skill_id),
        Some(&allowed),
    )?;
    let Some(mut value) = own.remove(key) else {
        crate::key_vault::zeroize_map(&mut own);
        return Err(format!("这个 Skill 没有单独填写的 {key}"));
    };
    crate::key_vault::zeroize_map(&mut own);
    let main = crate::key_vault::vault_lookup_names_at(root, user_id)
        .ok()
        .and_then(|mut lookup| lookup.remove(key))
        .unwrap_or_else(|| key.to_string());
    let created = crate::key_vault::create_vault_key_variant_at(
        root,
        user_id,
        &main,
        label,
        &value,
        Some(skill_id),
        now,
    );
    value.zeroize();
    let variant = created?;
    crate::runtime_env::set_personal_variant_policy_at(
        root,
        user_id,
        skill_id,
        key,
        Some(&variant),
    )?;
    crate::key_vault::remove_override_at(env_root, user_id, skill_id, key)?;
    Ok(variant)
}

/// A vault key was filled or renamed (#292): failure records naming the key
/// or any of its other variable names are no longer current.
fn clear_run_failures_for_vault_key(root: &Path, user_id: &str, key: &str, extra: &[&str]) {
    let lookup = crate::key_vault::vault_lookup_names_at(root, user_id).unwrap_or_default();
    let mut names = lookup
        .iter()
        .filter(|(_, main)| main.as_str() == key)
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>();
    names.push(key);
    names.extend_from_slice(extra);
    crate::last_run::clear_failures_for_keys_at(root, user_id, &names, None);
}

#[tauri::command]
pub async fn list_last_run_failures(
    space: crate::server_request::SpaceHandle,
    account_user_id: Option<String>,
) -> Result<Vec<crate::last_run::LastRunRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = skillhub_dir();
        crate::key_vault::with_current_identity_at(
            &root,
            &envs_dir(),
            account_user_id.as_deref(),
            Some(&space),
            |root, _env_root, user_id| crate::last_run::list_last_run_failures_at(root, user_id),
        )
    })
    .await
    .map_err(|error| format!("list_last_run_failures异常结束: {error}"))?
}

#[tauri::command]
pub fn clear_last_run_failure(
    space: crate::server_request::SpaceHandle,
    skill_id: String,
    account_user_id: Option<String>,
) -> Result<(), String> {
    let root = skillhub_dir();
    crate::key_vault::with_current_identity_at(
        &root,
        &envs_dir(),
        account_user_id.as_deref(),
        Some(&space),
        |root, _env_root, user_id| {
            crate::last_run::clear_last_run_failure_at(root, user_id, &skill_id)
        },
    )
}

/// Replaces the other variable names of a vault key (#288).
#[tauri::command]
pub fn set_vault_key_aliases(
    space: crate::server_request::SpaceHandle,
    key: String,
    aliases: Vec<String>,
    account_user_id: Option<String>,
) -> Result<(), String> {
    let root = skillhub_dir();
    crate::key_vault::with_current_identity_at(
        &root,
        &envs_dir(),
        account_user_id.as_deref(),
        Some(&space),
        |root, _env_root, user_id| {
            crate::key_vault::set_vault_key_aliases_at(
                root,
                user_id,
                &key,
                aliases,
                crate::key_vault::now_ms(),
            )?;
            clear_run_failures_for_vault_key(root, user_id, &key, &[]);
            Ok(())
        },
    )
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyAliasSuggestion {
    pub service: String,
    /// The vault key (main name) of the same service.
    pub existing_key: String,
}

/// 「用 FAL_KEY」: a vault key of the same service as `key`, when `key` itself
/// is not yet a name of any vault key. Names only.
#[tauri::command]
pub async fn suggest_vault_key_alias(
    space: crate::server_request::SpaceHandle,
    key: String,
    account_user_id: Option<String>,
) -> Result<Option<KeyAliasSuggestion>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_valid_env_key(&key) {
            return Err("环境变量名必须为大写字母、数字和下划线".into());
        }
        let root = skillhub_dir();
        crate::key_vault::with_current_identity_at(
            &root,
            &envs_dir(),
            account_user_id.as_deref(),
            Some(&space),
            |root, _env_root, user_id| {
                let lookup = crate::key_vault::vault_lookup_names_at(root, user_id)?;
                Ok(crate::key_vault::suggest_alias_for(&lookup, &key).map(
                    |(service, existing_key)| KeyAliasSuggestion {
                        service,
                        existing_key,
                    },
                ))
            },
        )
    })
    .await
    .map_err(|error| format!("suggest_vault_key_alias异常结束: {error}"))?
}

/// 「撤销」 a vault value (#306: `variant` picks a labelled one). The last
/// value of a name removes the name; every Skill relying on it needs a value
/// again. The default value cannot go while other values remain.
#[tauri::command]
pub fn delete_vault_key(
    space: crate::server_request::SpaceHandle,
    key: String,
    variant: Option<String>,
    account_user_id: Option<String>,
) -> Result<(), String> {
    let root = skillhub_dir();
    crate::key_vault::with_current_identity_at(
        &root,
        &envs_dir(),
        account_user_id.as_deref(),
        Some(&space),
        |root, _env_root, user_id| {
            crate::key_vault::delete_vault_key_variant_at(root, user_id, &key, variant.as_deref())
        },
    )
}

/// 「以后不再询问，有能用的就用」 (no `key`), or the same switch for one key.
#[tauri::command]
pub fn set_key_auto_allow(
    space: crate::server_request::SpaceHandle,
    enabled: bool,
    key: Option<String>,
    variant: Option<String>,
    account_user_id: Option<String>,
) -> Result<(), String> {
    let root = skillhub_dir();
    crate::key_vault::with_current_identity_at(
        &root,
        &envs_dir(),
        account_user_id.as_deref(),
        Some(&space),
        |root, _env_root, user_id| {
            crate::key_vault::set_key_auto_allow_variant_at(
                root,
                user_id,
                enabled,
                key.as_deref(),
                variant.as_deref(),
                crate::key_vault::now_ms(),
            )
        },
    )
}

/// 「允许」 (remembered) or, with `once`, 「仅这次」 (next run, ten minutes).
#[tauri::command]
pub fn grant_key_access(
    space: crate::server_request::SpaceHandle,
    skill_id: String,
    key: String,
    once: Option<bool>,
    variant: Option<String>,
    account_user_id: Option<String>,
) -> Result<(), String> {
    let root = skillhub_dir();
    crate::key_vault::with_current_identity_at(
        &root,
        &envs_dir(),
        account_user_id.as_deref(),
        Some(&space),
        |root, _env_root, user_id| {
            crate::key_vault::grant_key_access_variant_at(
                root,
                user_id,
                &skill_id,
                &key,
                variant.as_deref(),
                once.unwrap_or(false),
                crate::key_vault::now_ms(),
            )?;
            crate::last_run::clear_failures_for_keys_at(root, user_id, &[&key], Some(&skill_id));
            Ok(())
        },
    )
}

#[tauri::command]
pub fn revoke_key_access(
    space: crate::server_request::SpaceHandle,
    skill_id: String,
    key: String,
    variant: Option<String>,
    account_user_id: Option<String>,
) -> Result<(), String> {
    let root = skillhub_dir();
    crate::key_vault::with_current_identity_at(
        &root,
        &envs_dir(),
        account_user_id.as_deref(),
        Some(&space),
        |root, _env_root, user_id| {
            crate::key_vault::revoke_key_access_variant_at(
                root,
                user_id,
                &skill_id,
                &key,
                variant.as_deref(),
            )
        },
    )
}

/// 「钥匙」 page Skill cards (#294): turns the vault key `key` (main name or
/// alias) on or off for one Skill. Off behaves as if the vault had no value
/// for that Skill; on also allows a Skill that would otherwise ask first.
#[tauri::command]
pub fn set_vault_key_skill_access(
    space: crate::server_request::SpaceHandle,
    key: String,
    skill_id: String,
    enabled: bool,
    variant: Option<String>,
    account_user_id: Option<String>,
) -> Result<(), String> {
    validate_skill_id(&skill_id)?;
    let root = skillhub_dir();
    crate::key_vault::with_current_identity_at(
        &root,
        &envs_dir(),
        account_user_id.as_deref(),
        Some(&space),
        |root, _env_root, user_id| {
            let profile = crate::runtime_env::read_profile_at(&skills_dir(), &skill_id).ok();
            if enabled && profile.is_none() {
                return Err("找不到这个 Skill，可能已被删除".into());
            }
            crate::key_vault::set_vault_key_skill_access_variant_at(
                root,
                user_id,
                &key,
                variant.as_deref(),
                &skill_id,
                profile.as_ref(),
                enabled,
                crate::key_vault::now_ms(),
            )?;
            if enabled {
                crate::last_run::clear_failures_for_keys_at(
                    root,
                    user_id,
                    &[&key],
                    Some(&skill_id),
                );
            }
            Ok(())
        },
    )
}

#[tauri::command]
pub async fn list_key_consent_requests(
    space: crate::server_request::SpaceHandle,
    account_user_id: Option<String>,
) -> Result<Vec<crate::key_vault::KeyConsentRequest>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = skillhub_dir();
        crate::key_vault::with_current_identity_at(
            &root,
            &envs_dir(),
            account_user_id.as_deref(),
            Some(&space),
            |root, _env_root, user_id| {
                crate::key_vault::list_consent_requests_at(
                    root,
                    &skills_dir(),
                    user_id,
                    crate::key_vault::now_ms(),
                )
            },
        )
    })
    .await
    .map_err(|error| format!("list_key_consent_requests异常结束: {error}"))?
}

/// 「拒绝」: nothing is stored; the next run asks again.
#[tauri::command]
pub fn dismiss_key_consent_request(
    space: crate::server_request::SpaceHandle,
    skill_id: String,
    account_user_id: Option<String>,
) -> Result<(), String> {
    let root = skillhub_dir();
    crate::key_vault::with_current_identity_at(
        &root,
        &envs_dir(),
        account_user_id.as_deref(),
        Some(&space),
        |root, _env_root, user_id| {
            crate::key_vault::dismiss_consent_request_at(root, user_id, &skill_id)
        },
    )
}

fn sync_env_dependencies_blocking(
    skill_id: String,
    keys: Vec<String>,
    suggestions: Vec<crate::env_detect::EnvSuggestion>,
) -> Result<LocalSkill, String> {
    validate_skill_id(&skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    reconcile_skill_projection_at(&skillhub_dir(), &skills_dir(), &skill_id)?;
    let mut profile = read_profile_result(&skill_id)?;
    // New keys found in `suggestions` are recorded as detected (with their
    // confidence); any other new key was added by the user by hand.
    profile.env_dependencies = crate::env_detect::resolve_synced_dependencies(
        std::mem::take(&mut profile.env_dependencies),
        keys,
        &suggestions,
    );
    write_profile(&skill_id, &profile).map_err(|error| error.to_string())?;
    let generated = refresh_skill_projection(&skill_id)?;
    let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
    let projection_name = skill_projection_name(&skill_id)?;
    let canonical = skill_path(&skill_id);
    for (_, _, relative) in crate::known_agents() {
        let link = home.join(relative).join(&projection_name);
        migrate_agent_projection_link(&link, &canonical, &generated, &skillhub_dir())?;
    }
    Ok(build_local_skill(&skill_id))
}

#[tauri::command]
pub async fn sync_env_dependencies(
    skill_id: String,
    keys: Vec<String>,
    suggestions: Option<Vec<crate::env_detect::EnvSuggestion>>,
) -> Result<LocalSkill, String> {
    tauri::async_runtime::spawn_blocking(move || {
        sync_env_dependencies_blocking(skill_id, keys, suggestions.unwrap_or_default())
    })
    .await
    .map_err(|error| format!("Skill 环境依赖后台同步异常结束: {error}"))?
}

fn read_env_declarations_blocking(
    skill_id: String,
) -> Result<Vec<crate::skill_document::EnvDeclaration>, String> {
    validate_skill_id(&skill_id)?;
    let content = fs::read_to_string(skill_path(&skill_id).join("SKILL.md"))
        .map_err(|error| format!("无法读取 SKILL.md: {error}"))?;
    skill_md_env_declarations(&content)
}

/// Keys declared in the managed SKILL.md (`metadata.skillhub.env`, #251).
#[tauri::command]
pub async fn read_env_declarations(
    skill_id: String,
) -> Result<Vec<crate::skill_document::EnvDeclaration>, String> {
    tauri::async_runtime::spawn_blocking(move || read_env_declarations_blocking(skill_id))
        .await
        .map_err(|error| format!("SKILL.md 声明读取异常结束: {error}"))?
}

fn write_env_declarations_blocking(
    skill_id: String,
    deps: Vec<crate::skill_document::EnvDeclaration>,
) -> Result<LocalSkill, String> {
    validate_skill_id(&skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    let _lock = crate::skill_lock::lock_skill_dir(&skill_id)?;
    reconcile_skill_projection_at(&skillhub_dir(), &skills_dir(), &skill_id)?;
    let mut profile = read_profile_result(&skill_id)?;
    if profile.is_own == Some(false) {
        return Err("只有作者可以修改这个 Skill 的钥匙声明".into());
    }
    let skill_md = skill_path(&skill_id).join("SKILL.md");
    if !fs::symlink_metadata(&skill_md).is_ok_and(|metadata| metadata.is_file()) {
        return Err("SKILL.md 不存在或不是普通文件".into());
    }
    let content =
        fs::read_to_string(&skill_md).map_err(|error| format!("无法读取 SKILL.md: {error}"))?;
    let declarations = crate::skill_document::validate_env_declarations(deps)?;
    let updated = crate::skill_document::write_env_declarations(&content, &declarations)?;
    if updated != content {
        fs::write(&skill_md, &updated).map_err(|error| format!("无法写入 SKILL.md: {error}"))?;
    }
    // The sidecar follows the declaration: declared keys take its values and
    // keys the author removed from it are kept as manual entries.
    for dependency in &mut profile.env_dependencies {
        let still_declared = declarations
            .iter()
            .any(|declaration| declaration.key == dependency.key);
        if !still_declared
            && dependency.origin.as_deref() == Some(crate::env_detect::ORIGIN_DECLARED)
        {
            dependency.origin = Some(crate::env_detect::ORIGIN_MANUAL.into());
            dependency.confidence = None;
            dependency.obtain = None;
        }
    }
    crate::env_detect::apply_declared_dependencies(&mut profile.env_dependencies, &declarations);
    write_profile(&skill_id, &profile).map_err(|error| error.to_string())?;
    let generated = refresh_skill_projection(&skill_id)?;
    let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
    let projection_name = skill_projection_name(&skill_id)?;
    let canonical = skill_path(&skill_id);
    for (_, _, relative) in crate::known_agents() {
        let link = home.join(relative).join(&projection_name);
        migrate_agent_projection_link(&link, &canonical, &generated, &skillhub_dir())?;
    }
    Ok(build_local_skill(&skill_id))
}

/// Writes the author's confirmed keys into the managed SKILL.md frontmatter,
/// touching only `metadata.skillhub.env` (#251), and mirrors them into the
/// sidecar. Unchecked keys are simply not part of `deps`.
#[tauri::command]
pub async fn write_env_declarations(
    skill_id: String,
    deps: Vec<crate::skill_document::EnvDeclaration>,
) -> Result<LocalSkill, String> {
    tauri::async_runtime::spawn_blocking(move || write_env_declarations_blocking(skill_id, deps))
        .await
        .map_err(|error| format!("SKILL.md 声明写入异常结束: {error}"))?
}

#[tauri::command]
pub async fn check_shell_integration() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
        let zshrc = fs::read_to_string(home.join(".zshrc")).unwrap_or_default();
        Ok(zshrc.contains(".skillhub/active.env"))
    })
    .await
    .map_err(|error| format!("check_shell_integration异常结束: {error}"))?
}

#[tauri::command]
pub fn disable_legacy_shell_integration() -> Result<Option<String>, String> {
    let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
    let zshrc = home.join(".zshrc");
    if !zshrc.exists() {
        retire_legacy_active_env()?;
        return Ok(None);
    }
    if fs::symlink_metadata(&zshrc).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(".zshrc 是符号链接，请手动移除 active.env 加载行".into());
    }
    let current = fs::read_to_string(&zshrc).map_err(|error| error.to_string())?;
    if !current.contains(".skillhub/active.env") {
        retire_legacy_active_env()?;
        return Ok(None);
    }
    let backup = home.join(format!(".zshrc.skillhub-backup-{}", uuid::Uuid::new_v4()));
    fs::copy(&zshrc, &backup).map_err(|error| error.to_string())?;
    let mut updated = current
        .lines()
        .filter(|line| !line.contains(".skillhub/active.env"))
        .collect::<Vec<_>>()
        .join("\n");
    if !updated.is_empty() {
        updated.push('\n');
    }
    write_private_file(&zshrc, &updated)?;
    retire_legacy_active_env()?;
    Ok(Some(backup.to_string_lossy().to_string()))
}

fn create_skill_package_from_root(root: &Path) -> Result<SkillPackage, String> {
    let bytes = package_skill_root(root, None)?;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    Ok(SkillPackage {
        base64: BASE64.encode(&bytes),
        sha256,
        size: bytes.len(),
    })
}

/// Deterministic package bytes. `executables` replaces the file-system
/// executable bit; account sync passes its baseline on Windows, where NTFS has
/// no Unix executable bit to read.
fn package_skill_root(
    root: &Path,
    executables: Option<&BTreeSet<String>>,
) -> Result<Vec<u8>, String> {
    if !root.join("SKILL.md").is_file() {
        return Err("Skill 缺少 SKILL.md".into());
    }
    let package_files = collect_skill_tree(root)?
        .into_iter()
        .filter(|entry| !entry.is_directory)
        .map(|entry| (entry.normalized, entry.path))
        .collect::<Vec<_>>();

    let cursor = Cursor::new(Vec::<u8>::new());
    let mut writer = ZipWriter::new(cursor);
    // A package hash is also the idempotency key used by server import recovery.
    // Keep order and mtimes deterministic, but retain the executable semantic
    // because it changes whether an Agent can invoke a bundled script directly.
    // All unrelated permission bits are normalized away.
    for (name, path) in package_files {
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        let unix_mode = Some(
            fs::metadata(&path)
                .map_err(|error| error.to_string())?
                .permissions()
                .mode(),
        );
        // Windows does not expose a Unix executable bit. Treating a writable
        // NTFS file as mode 0700 would make every packaged resource executable
        // when another platform installs it.
        #[cfg(windows)]
        let unix_mode = None;
        let unix_mode = match executables {
            Some(executables) if executables.contains(&name) => Some(0o755),
            Some(_) => Some(0o644),
            None => unix_mode,
        };
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .last_modified_time(ZipDateTime::default())
            .unix_permissions(canonical_archive_file_mode(unix_mode));
        writer
            .start_file(name, options)
            .map_err(|error| error.to_string())?;
        writer
            .write_all(&bytes)
            .map_err(|error| error.to_string())?;
    }
    let bytes = writer
        .finish()
        .map_err(|error| error.to_string())?
        .into_inner();
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Skill 压缩包超过 20 MB".into());
    }
    Ok(bytes)
}

fn create_skill_package_blocking(skill_id: String) -> Result<SkillPackage, String> {
    validate_skill_id(&skill_id)?;
    reject_system_skill_mutation(&skill_id)?;
    reconcile_skill_projection_at(&skillhub_dir(), &skills_dir(), &skill_id)?;
    create_skill_package_from_root(&skill_path(&skill_id))
}

#[tauri::command]
pub async fn create_skill_package(skill_id: String) -> Result<SkillPackage, String> {
    tauri::async_runtime::spawn_blocking(move || create_skill_package_blocking(skill_id))
        .await
        .map_err(|error| format!("Skill 后台打包任务异常结束: {error}"))?
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MarketplacePathSnapshot {
    path: PathBuf,
    device: u64,
    inode: u64,
    mode: u32,
    symlink_target: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MarketplaceCurrentProjectionGuard {
    marker: ProjectionMarker,
    generation: PathBuf,
    current: MarketplacePathSnapshot,
    generation_directory: MarketplacePathSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MarketplaceAgentLinkSnapshot {
    path: PathBuf,
    state: Option<MarketplacePathSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MarketplaceReplacementGuard {
    canonical_device: u64,
    canonical_inode: u64,
    canonical_fingerprint: Vec<u8>,
    canonical_head: git2::Oid,
    current_projection: Option<MarketplaceCurrentProjectionGuard>,
    agent_links: Vec<MarketplaceAgentLinkSnapshot>,
}

#[derive(Debug)]
struct PreparedMarketplaceProjection {
    skillhub_root: PathBuf,
    root: PathBuf,
    generation: PathBuf,
    temporary_current: PathBuf,
    old_target: PathBuf,
    new_target: PathBuf,
    marker: ProjectionMarker,
}

fn marketplace_path_snapshot(path: &Path) -> Result<Option<MarketplacePathSnapshot>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法检查路径 {}: {error}", path.display())),
    };
    Ok(Some(MarketplacePathSnapshot {
        path: path.to_path_buf(),
        device: metadata.dev(),
        inode: metadata.ino(),
        mode: metadata.mode(),
        symlink_target: metadata
            .file_type()
            .is_symlink()
            .then(|| fs::read_link(path))
            .transpose()
            .map_err(|error| error.to_string())?,
    }))
}

fn marketplace_agent_link_snapshots(
    home: &Path,
    managed_root: &Path,
    skill_id: &str,
) -> Result<Vec<MarketplaceAgentLinkSnapshot>, String> {
    let projection_name = projection_name_at_root(managed_root, skill_id)?;
    marketplace_agent_link_snapshots_for_name(home, &projection_name)
}

fn marketplace_agent_link_snapshots_for_name(
    home: &Path,
    projection_name: &str,
) -> Result<Vec<MarketplaceAgentLinkSnapshot>, String> {
    crate::managed_projection_dirs()
        .into_iter()
        .map(|relative| {
            let path = home.join(relative).join(projection_name);
            Ok(MarketplaceAgentLinkSnapshot {
                state: marketplace_path_snapshot(&path)?,
                path,
            })
        })
        .collect()
}

fn marketplace_projection_is_unedited(marker: &ProjectionMarker, generation: &Path) -> bool {
    projection_generation_is_coordinated(marker, generation)
        && projection_resources_match(marker, generation)
}

fn capture_marketplace_replacement_guard_at(
    home: &Path,
    skillhub_root: &Path,
    managed_root: &Path,
    skill_id: &str,
) -> Result<MarketplaceReplacementGuard, String> {
    let canonical = managed_root.join(skill_id);
    validate_real_directory(&canonical, "待更新的商店 Skill")?;
    let repository = git2::Repository::open(&canonical)
        .map_err(|error| format!("待更新的商店 Skill 缺少可验证版本记录: {error}"))?;
    if working_copy_state_for_path(&canonical).0 {
        return Err("当前商店 Skill 有尚未版本化的本机修改，请先创建版本或恢复后再更新".into());
    }
    let metadata = fs::symlink_metadata(&canonical).map_err(|error| error.to_string())?;
    let projection_root = projection_root_at(skillhub_root, skill_id);
    let current_path = projection_root.join("current");
    let current_projection = match current_projection_at(skillhub_root, managed_root, skill_id) {
        Some((marker, generation)) => {
            let canonical_skill_md = read_owned_projection_file(
                &canonical.join("SKILL.md"),
                MAX_SKILL_FILE_BYTES as usize,
                false,
                "待更新 canonical SKILL.md",
            )?;
            if marker.canonical_skill_md_sha256 != sha256_hex(&canonical_skill_md)
                || !marketplace_projection_is_unedited(&marker, &generation)
            {
                return Err(
                    "当前 Agent 投影或 canonical Skill 已被修改，请先处理修改后再切换商店版本"
                        .into(),
                );
            }
            Some(MarketplaceCurrentProjectionGuard {
                marker,
                generation: generation.clone(),
                current: marketplace_path_snapshot(&current_path)?
                    .ok_or("当前 Agent 投影链接已消失")?,
                generation_directory: marketplace_path_snapshot(&generation)?
                    .ok_or("当前 Agent 投影 generation 已消失")?,
            })
        }
        None => {
            if fs::symlink_metadata(&current_path).is_ok() {
                return Err("当前 Agent 投影身份无效，拒绝切换商店版本".into());
            }
            None
        }
    };
    Ok(MarketplaceReplacementGuard {
        canonical_device: metadata.dev(),
        canonical_inode: metadata.ino(),
        canonical_fingerprint: skill_tree_fingerprint(&canonical)?,
        canonical_head: repository
            .head()
            .and_then(|head| head.peel_to_commit())
            .map(|commit| commit.id())
            .map_err(|error| format!("无法验证待更新商店 Skill 的当前版本: {error}"))?,
        current_projection,
        agent_links: marketplace_agent_link_snapshots(home, managed_root, skill_id)?,
    })
}

fn validate_marketplace_replacement_guard_at(
    home: &Path,
    skillhub_root: &Path,
    managed_root: &Path,
    skill_id: &str,
    expected: &MarketplaceReplacementGuard,
) -> Result<(), String> {
    let actual =
        capture_marketplace_replacement_guard_at(home, skillhub_root, managed_root, skill_id)?;
    if &actual != expected {
        return Err("商店 Skill、Agent 投影或安装链接在切换期间发生变化".into());
    }
    Ok(())
}

fn validate_detached_marketplace_projection_guard_at(
    guard: &MarketplaceReplacementGuard,
) -> Result<(), String> {
    if let Some(current) = &guard.current_projection {
        if marketplace_path_snapshot(&current.current.path)?.as_ref() != Some(&current.current)
            || marketplace_path_snapshot(&current.generation)?.as_ref()
                != Some(&current.generation_directory)
            || !marketplace_projection_is_unedited(&current.marker, &current.generation)
        {
            return Err("Agent 投影在商店版本切换期间发生变化".into());
        }
    }
    validate_marketplace_agent_links_at(guard)?;
    Ok(())
}

fn validate_marketplace_agent_links_at(guard: &MarketplaceReplacementGuard) -> Result<(), String> {
    for expected in &guard.agent_links {
        if marketplace_path_snapshot(&expected.path)? != expected.state {
            return Err(format!(
                "Agent 安装链接在商店版本切换期间发生变化: {}",
                expected.path.display()
            ));
        }
    }
    Ok(())
}

fn validate_moved_marketplace_canonical(
    recovered: &Path,
    guard: &MarketplaceReplacementGuard,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(recovered).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.dev() != guard.canonical_device
        || metadata.ino() != guard.canonical_inode
        || skill_tree_fingerprint(recovered)? != guard.canonical_fingerprint
    {
        return Err("待更新的商店 Skill 在原子备份期间发生变化".into());
    }
    Ok(())
}

fn prepare_marketplace_projection_at(
    skillhub_root: &Path,
    managed_root: &Path,
    skill_id: &str,
    content_source: &Path,
    guard: &MarketplaceReplacementGuard,
) -> Result<Option<PreparedMarketplaceProjection>, String> {
    let Some(current) = &guard.current_projection else {
        return Ok(None);
    };
    collect_skill_tree(content_source)?;
    let profile = read_profile_at_path(content_source)?;
    let canonical_skill_md = read_owned_projection_file(
        &content_source.join("SKILL.md"),
        MAX_SKILL_FILE_BYTES as usize,
        false,
        "待切换商店版本 SKILL.md",
    )?;
    let canonical_skill_md = String::from_utf8(canonical_skill_md)
        .map_err(|_| "待切换商店版本 SKILL.md 不是有效 UTF-8".to_string())?;
    let canonical_source =
        fs::canonicalize(managed_root.join(skill_id)).map_err(|error| error.to_string())?;
    let root = projection_root_at(skillhub_root, skill_id);
    validate_private_projection_directory(&root, "当前 Skill 投影目录")?;
    let mut env_keys = profile
        .env_dependencies
        .iter()
        .map(|dependency| dependency.key.clone())
        .collect::<Vec<_>>();
    if env_keys.iter().any(|key| !is_valid_env_key(key)) {
        return Err("待切换商店版本包含无效环境变量名".into());
    }
    env_keys.sort();
    env_keys.dedup();
    let has_env = projection_injects_runtime_header(skill_id, &profile);
    let resource_names = canonical_resource_names(content_source)?;
    let generation_name = format!("generation-{}", uuid::Uuid::new_v4());
    let generation = root.join(&generation_name);
    fs::create_dir(&generation).map_err(|error| error.to_string())?;
    fs::set_permissions(&generation, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let temporary_current = root.join(format!(".current-marketplace-{}", uuid::Uuid::new_v4()));
    let prepare_result = (|| -> Result<ProjectionMarker, String> {
        let header_token = uuid::Uuid::new_v4().to_string();
        let rendered = generated_skill_md_with_token(
            &canonical_skill_md,
            skill_id,
            &header_token,
            has_env,
            &env_keys,
        );
        let header_separator_injected = projection_header_separator_is_injected(
            &canonical_skill_md,
            has_env,
            PROJECTION_HEADER_VERSION,
        );
        let mut projected_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(generation.join("SKILL.md"))
            .map_err(|error| error.to_string())?;
        projected_file
            .write_all(rendered.as_bytes())
            .map_err(|error| error.to_string())?;
        projected_file
            .sync_all()
            .map_err(|error| error.to_string())?;
        for name in &resource_names {
            unix_fs::symlink(canonical_source.join(name), generation.join(name))
                .map_err(|error| error.to_string())?;
        }
        let marker = ProjectionMarker {
            version: PROJECTION_MARKER_VERSION,
            skill_id: skill_id.to_string(),
            source_root: canonical_source.to_string_lossy().to_string(),
            generation: generation_name.clone(),
            canonical_skill_md_sha256: sha256_hex(canonical_skill_md.as_bytes()),
            rendered_skill_md_sha256: sha256_hex(rendered.as_bytes()),
            header_version: PROJECTION_HEADER_VERSION,
            header_token,
            header_injected: has_env,
            header_separator_injected,
            env_keys,
            resource_names,
        };
        write_private_file(
            &generation.join(PROJECTION_MARKER_NAME),
            &serde_json::to_string(&marker).map_err(|error| error.to_string())?,
        )?;
        unix_fs::symlink(&generation_name, &temporary_current)
            .map_err(|error| error.to_string())?;
        Ok(marker)
    })();
    let marker = match prepare_result {
        Ok(marker) => marker,
        Err(error) => {
            let _ = crate::platform_fs::remove_link(&temporary_current);
            let _ = fs::remove_dir_all(&generation);
            return Err(error);
        }
    };
    if !marketplace_projection_is_unedited(&marker, &generation) {
        let _ = crate::platform_fs::remove_link(&temporary_current);
        let _ = fs::remove_dir_all(&generation);
        return Err("无法验证待启用的商店 Agent 投影".into());
    }
    Ok(Some(PreparedMarketplaceProjection {
        skillhub_root: skillhub_root.to_path_buf(),
        root,
        generation: generation.clone(),
        temporary_current,
        old_target: current.generation.clone(),
        new_target: generation,
        marker,
    }))
}

fn discard_prepared_marketplace_projection(prepared: &PreparedMarketplaceProjection) {
    let _ = crate::platform_fs::remove_link(&prepared.temporary_current);
    let _ = fs::remove_dir_all(&prepared.generation);
}

fn commit_prepared_marketplace_projection(
    prepared: &PreparedMarketplaceProjection,
) -> Result<(), String> {
    commit_prepared_marketplace_projection_with_hook(prepared, || Ok(()))
}

fn commit_prepared_marketplace_projection_with_hook<F>(
    prepared: &PreparedMarketplaceProjection,
    after_switch: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    if !marketplace_projection_is_unedited(&prepared.marker, &prepared.generation)
        || !symlink_declares_path(&prepared.temporary_current, &prepared.new_target)
    {
        return Err("待启用的商店 Agent 投影在切换前发生变化".into());
    }
    let current = prepared.root.join("current");
    install_prepared_symlink_atomically(
        &prepared.temporary_current,
        &current,
        Some(&prepared.old_target),
        &prepared.skillhub_root,
    )?;
    after_switch()?;
    if let Ok(directory) = fs::File::open(&prepared.root) {
        directory.sync_all().map_err(|error| error.to_string())?;
    }
    if !symlink_declares_path(&current, &prepared.new_target)
        || !marketplace_projection_is_unedited(&prepared.marker, &prepared.generation)
    {
        return Err("商店 Agent 投影原子切换后校验失败".into());
    }
    Ok(())
}

fn rollback_prepared_marketplace_projection(
    prepared: &PreparedMarketplaceProjection,
) -> Result<(), String> {
    let current = prepared.root.join("current");
    if symlink_declares_path(&current, &prepared.old_target) {
        return Ok(());
    }
    if !symlink_declares_path(&current, &prepared.new_target) {
        return Err("当前 Agent 投影在回滚前已发生变化，未覆盖".into());
    }
    let temporary = prepared.root.join(format!(
        ".current-marketplace-rollback-{}",
        uuid::Uuid::new_v4()
    ));
    let old_name = prepared
        .old_target
        .file_name()
        .ok_or("无法解析旧 Agent 投影 generation")?;
    unix_fs::symlink(old_name, &temporary).map_err(|error| error.to_string())?;
    let result = install_prepared_symlink_atomically(
        &temporary,
        &current,
        Some(&prepared.new_target),
        &prepared.skillhub_root,
    );
    if result.is_err() {
        let _ = crate::platform_fs::remove_link(&temporary);
    }
    result?;
    if let Ok(directory) = fs::File::open(&prepared.root) {
        directory.sync_all().map_err(|error| error.to_string())?;
    }
    if !symlink_declares_path(&current, &prepared.old_target) {
        return Err("旧 Agent 投影恢复后校验失败".into());
    }
    Ok(())
}

fn reactivate_prepared_marketplace_projection(
    prepared: &PreparedMarketplaceProjection,
) -> Result<(), String> {
    let current = prepared.root.join("current");
    if symlink_declares_path(&current, &prepared.new_target) {
        return Ok(());
    }
    if !symlink_declares_path(&current, &prepared.old_target) {
        return Err("当前 Agent 投影在恢复新版本前已发生变化，未覆盖".into());
    }
    let temporary = prepared.root.join(format!(
        ".current-marketplace-reactivate-{}",
        uuid::Uuid::new_v4()
    ));
    let new_name = prepared
        .new_target
        .file_name()
        .ok_or("无法解析新 Agent 投影 generation")?;
    unix_fs::symlink(new_name, &temporary).map_err(|error| error.to_string())?;
    let result = install_prepared_symlink_atomically(
        &temporary,
        &current,
        Some(&prepared.old_target),
        &prepared.skillhub_root,
    );
    if result.is_err() {
        let _ = crate::platform_fs::remove_link(&temporary);
    }
    result?;
    if let Ok(directory) = fs::File::open(&prepared.root) {
        directory.sync_all().map_err(|error| error.to_string())?;
    }
    if !symlink_declares_path(&current, &prepared.new_target) {
        return Err("新 Agent 投影重新启用后校验失败".into());
    }
    Ok(())
}

fn rollback_activated_marketplace_state(
    prepared: Option<&PreparedMarketplaceProjection>,
    destination: &Path,
    candidate_stage: &Path,
    old_recovered: &Path,
) -> Result<(), String> {
    if let Some(prepared) = prepared {
        rollback_prepared_marketplace_projection(prepared)
            .map_err(|error| format!("旧 Agent 投影恢复失败，canonical 保持当前版本: {error}"))?;
    }
    if let Err(error) = rename_noreplace(destination, candidate_stage) {
        let projection_recovery = prepared
            .map(reactivate_prepared_marketplace_projection)
            .transpose();
        return Err(format!(
            "无法暂存当前 canonical 版本: {error}; projection recovery: {}",
            projection_recovery.err().unwrap_or_else(|| "ok".into())
        ));
    }
    if let Err(error) = rename_noreplace(old_recovered, destination) {
        let candidate_recovery = rename_noreplace(candidate_stage, destination);
        let projection_recovery = if candidate_recovery.is_ok() {
            prepared
                .map(reactivate_prepared_marketplace_projection)
                .transpose()
        } else {
            Ok(None)
        };
        return Err(format!(
            "无法恢复旧 canonical 版本: {error}; candidate recovery: {}; projection recovery: {}",
            candidate_recovery
                .err()
                .map_or_else(|| "ok".into(), |reason| reason.to_string()),
            projection_recovery.err().unwrap_or_else(|| "ok".into())
        ));
    }
    Ok(())
}

fn prepare_marketplace_replacement_backup(
    root: &Path,
    skill_id: &str,
    display_name: &str,
) -> Result<PathBuf, String> {
    let trash_root = root.join("trash");
    fs::create_dir_all(&trash_root).map_err(|error| error.to_string())?;
    fs::set_permissions(&trash_root, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    validate_private_projection_directory(&trash_root, "SkillHub 回收目录")?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let transaction = trash_root.join(format!("{skill_id}-{timestamp}-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&transaction).map_err(|error| error.to_string())?;
    fs::set_permissions(&transaction, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let manifest = serde_json::json!({
        "version": 2,
        "kind": "managed_asset",
        "status": "in_progress",
        "phase": "prepared",
        "reason": "marketplace_version_replacement",
        "createdAt": u64::try_from(timestamp / 1000).unwrap_or(0),
        "skillId": skill_id,
        "displayName": display_name,
        "skillRecoveryPath": "skill",
        "projectionRecoveryPath": null,
        "envFiles": [],
    });
    if let Err(error) = write_private_file(
        &transaction.join("recovery-manifest.json"),
        &serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?,
    ) {
        let _ = fs::remove_dir(&transaction);
        return Err(error);
    }
    Ok(transaction)
}

fn update_marketplace_replacement_manifest(
    manifest_path: &Path,
    status: &str,
    phase: &str,
) -> Result<serde_json::Value, String> {
    let mut manifest = read_recovery_manifest(manifest_path)?;
    if manifest.get("reason").and_then(serde_json::Value::as_str)
        != Some("marketplace_version_replacement")
    {
        return Err("回收清单不是商店版本切换事务".into());
    }
    manifest["status"] = serde_json::Value::String(status.into());
    manifest["phase"] = serde_json::Value::String(phase.into());
    if status == "restored" {
        manifest["restoredAt"] = serde_json::json!(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs()));
    }
    write_private_file(
        manifest_path,
        &serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?,
    )?;
    Ok(manifest)
}

fn validate_marketplace_replacement_target(
    destination: &Path,
    server_id: &str,
    acquisition_source: AcquisitionSource,
    acquired_by_user_id: Option<&str>,
    replace_existing: bool,
) -> Result<bool, String> {
    if replace_existing
        && !matches!(
            acquisition_source,
            AcquisitionSource::Marketplace | AcquisitionSource::Team
        )
    {
        return Err("只有服务端固定版本可以更新现有托管资产".into());
    }
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err("资产库中的同名项不是可安全更新的真实目录".into())
        }
        Ok(_) if !replace_existing => {
            Err("资产库中已存在同名 Skill，未明确确认商店版本更新".into())
        }
        Ok(_) => {
            let existing_profile = read_profile_at_path(destination)?;
            if existing_profile.server_id.as_deref() != Some(server_id) {
                return Err("现有 Skill 的服务端标识不同，拒绝覆盖".into());
            }
            let explicit_source = existing_profile.acquisition_source.or_else(|| {
                existing_profile
                    .upstream
                    .as_ref()
                    .map(|upstream| upstream.source)
            });
            if explicit_source.is_some_and(|source| source != acquisition_source)
                || (explicit_source.is_none()
                    && acquisition_source == AcquisitionSource::Team
                    && profile_acquisition_source(&existing_profile) != AcquisitionSource::Team)
            {
                return Err("现有 Skill 的来源身份不同，拒绝覆盖".into());
            }
            if acquisition_source == AcquisitionSource::Team {
                let expected_user_id = acquired_by_user_id
                    .and_then(|value| uuid::Uuid::parse_str(value).ok())
                    .map(|value| value.to_string())
                    .ok_or("团队 Skill 更新缺少有效的当前账号绑定")?;
                let existing_user_id = existing_profile
                    .acquired_by_user_id
                    .as_deref()
                    .and_then(|value| uuid::Uuid::parse_str(value).ok())
                    .map(|value| value.to_string());
                if existing_user_id.as_deref() != Some(expected_user_id.as_str()) {
                    return Err("现有团队 Skill 属于其他账号或缺少账号绑定，拒绝覆盖".into());
                }
            } else if acquired_by_user_id.is_some() {
                return Err("非团队 Skill 更新不允许携带获取账号".into());
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if replace_existing {
                Err("待更新的本机 Skill 已发生变化，请刷新后重试".into())
            } else {
                Ok(false)
            }
        }
        Err(error) => Err(error.to_string()),
    }
}

#[allow(clippy::too_many_arguments)]
fn activate_staged_marketplace_package(
    home: &Path,
    root: &Path,
    stage: &Path,
    destination: &Path,
    skill_id: &str,
    display_name: &str,
    replace_existing: bool,
) -> Result<Option<String>, String> {
    activate_staged_marketplace_package_with_hooks(
        home,
        root,
        stage,
        destination,
        skill_id,
        display_name,
        replace_existing,
        || {},
        || Ok(()),
        None,
    )
}

#[cfg(all(test, unix))]
#[allow(clippy::too_many_arguments)]
fn activate_staged_marketplace_package_with_hook<F>(
    home: &Path,
    root: &Path,
    stage: &Path,
    destination: &Path,
    skill_id: &str,
    display_name: &str,
    replace_existing: bool,
    before_move: F,
) -> Result<Option<String>, String>
where
    F: FnOnce(),
{
    activate_staged_marketplace_package_with_hooks(
        home,
        root,
        stage,
        destination,
        skill_id,
        display_name,
        replace_existing,
        before_move,
        || Ok(()),
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn activate_staged_marketplace_package_with_hooks<F, G>(
    home: &Path,
    root: &Path,
    stage: &Path,
    destination: &Path,
    skill_id: &str,
    display_name: &str,
    replace_existing: bool,
    before_move: F,
    after_projection_switch: G,
    // Account sync: full-state check of the original once it is moved aside,
    // where path-based writers can no longer change it unnoticed.
    verify_moved: Option<&LibraryStateCheck>,
) -> Result<Option<String>, String>
where
    F: FnOnce(),
    G: FnOnce() -> Result<(), String>,
{
    if !replace_existing {
        rename_noreplace(stage, destination).map_err(|error| error.to_string())?;
        return Ok(None);
    }

    let existing = fs::symlink_metadata(destination).map_err(|error| error.to_string())?;
    if existing.file_type().is_symlink() || !existing.is_dir() {
        return Err("拒绝替换非真实目录的现有 Skill".into());
    }
    let managed_root = destination.parent().ok_or("无法确定 SkillHub 资产目录")?;
    let guard = capture_marketplace_replacement_guard_at(home, root, managed_root, skill_id)?;
    let stage_metadata = fs::symlink_metadata(stage).map_err(|error| error.to_string())?;
    if stage_metadata.file_type().is_symlink() || !stage_metadata.is_dir() {
        return Err("待启用的商店版本不是安全目录".into());
    }
    // Local values never come from the public package; preserve them in the
    // staged replacement before fingerprinting and guarded activation.
    for env_file in skill_env_value_files(destination)? {
        let relative = env_file
            .strip_prefix(destination)
            .map_err(|error| error.to_string())?;
        if let Some(contents) = read_env_file_for_update(&env_file)? {
            let target = stage.join(relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            write_private_file(&target, &contents)?;
        }
    }
    let stage_fingerprint = skill_tree_fingerprint(stage)?;
    let prepared_projection =
        prepare_marketplace_projection_at(root, managed_root, skill_id, stage, &guard)?;
    before_move();
    if let Err(error) =
        validate_marketplace_replacement_guard_at(home, root, managed_root, skill_id, &guard)
    {
        if let Some(prepared) = &prepared_projection {
            discard_prepared_marketplace_projection(prepared);
        }
        return Err(error);
    }
    let transaction = prepare_marketplace_replacement_backup(root, skill_id, display_name)?;
    let manifest_path = transaction.join("recovery-manifest.json");
    let recovered = transaction.join("skill");
    if let Err(error) = rename_noreplace(destination, &recovered) {
        if let Some(prepared) = &prepared_projection {
            discard_prepared_marketplace_projection(prepared);
        }
        let _ = fs::remove_file(&manifest_path);
        let _ = fs::remove_dir(&transaction);
        return Err(format!("无法备份现有 Skill，未执行更新: {error}"));
    }
    if let Err(error) = validate_moved_marketplace_canonical(&recovered, &guard)
        .and_then(|()| match verify_moved {
            Some(verify) if !verify(&recovered)? => Err(LIBRARY_LOCAL_CHANGED.to_string()),
            _ => Ok(()),
        })
        .and_then(|()| validate_detached_marketplace_projection_guard_at(&guard))
        .and_then(|()| {
            update_marketplace_replacement_manifest(&manifest_path, "in_progress", "old_moved")
                .map(|_| ())
        })
    {
        let rollback = rename_noreplace(&recovered, destination);
        if rollback.is_ok() {
            if let Some(prepared) = &prepared_projection {
                discard_prepared_marketplace_projection(prepared);
            }
            let _ = fs::remove_file(&manifest_path);
            let _ = fs::remove_dir(&transaction);
        }
        return Err(match rollback {
            Ok(()) => format!("现有 Skill 或 Agent 投影在更新期间发生变化，已恢复原内容: {error}"),
            Err(rollback_error) => format!(
                "现有 Skill 或 Agent 投影在更新期间发生变化，原内容保留在 {}，自动恢复失败: {rollback_error}",
                recovered.display()
            ),
        });
    }
    if let Err(error) = rename_noreplace(stage, destination) {
        let rollback = rename_noreplace(&recovered, destination);
        if rollback.is_ok() {
            if let Some(prepared) = &prepared_projection {
                discard_prepared_marketplace_projection(prepared);
            }
            let _ = fs::remove_file(&manifest_path);
            let _ = fs::remove_dir(&transaction);
        }
        return Err(match rollback {
            Ok(()) => format!("新版本启用失败，已恢复原 Skill: {error}"),
            Err(rollback_error) => format!(
                "新版本启用失败；原 Skill 保留在 {}，自动恢复失败: {rollback_error}",
                recovered.display()
            ),
        });
    }
    let activated_metadata =
        fs::symlink_metadata(destination).map_err(|error| error.to_string())?;
    let activated_valid = !activated_metadata.file_type().is_symlink()
        && activated_metadata.is_dir()
        && activated_metadata.dev() == stage_metadata.dev()
        && activated_metadata.ino() == stage_metadata.ino()
        && skill_tree_fingerprint(destination)? == stage_fingerprint
        && validate_detached_marketplace_projection_guard_at(&guard).is_ok()
        && validate_marketplace_agent_links_at(&guard).is_ok();
    let projection_result = if activated_valid {
        update_marketplace_replacement_manifest(
            &manifest_path,
            "in_progress",
            "candidate_activated",
        )
        .map(|_| ())
        .and_then(|()| match prepared_projection.as_ref() {
            Some(prepared) => {
                commit_prepared_marketplace_projection_with_hook(prepared, after_projection_switch)
            }
            None => Ok(()),
        })
    } else {
        Err("新商店版本或 Agent 安装链接在启用期间发生变化".into())
    };
    if let Err(error) = projection_result {
        let rollback = rollback_activated_marketplace_state(
            prepared_projection.as_ref(),
            destination,
            stage,
            &recovered,
        );
        if rollback.is_ok() {
            if let Some(prepared) = &prepared_projection {
                if fs::symlink_metadata(&prepared.temporary_current).is_ok() {
                    discard_prepared_marketplace_projection(prepared);
                }
            }
            let _ = fs::remove_file(&manifest_path);
            let _ = fs::remove_dir(&transaction);
            return Err(format!(
                "商店版本投影启用失败，已恢复原 Skill 与 Agent 投影: {error}"
            ));
        }
        return Err(format!(
            "商店版本投影启用失败: {error}; 自动恢复失败: {}; 原版本保留在 {}",
            rollback.expect_err("checked rollback error"),
            recovered.display(),
        ));
    }
    let finalize_result = validate_marketplace_agent_links_at(&guard).and_then(|()| {
        if let Ok(directory) = fs::File::open(destination.parent().unwrap_or(destination)) {
            directory.sync_all().map_err(|error| error.to_string())?;
        }
        update_marketplace_replacement_manifest(&manifest_path, "trashed", "complete").map(|_| ())
    });
    if let Err(error) = finalize_result {
        let rollback = rollback_activated_marketplace_state(
            prepared_projection.as_ref(),
            destination,
            stage,
            &recovered,
        );
        if rollback.is_ok() {
            let _ = fs::remove_file(&manifest_path);
            let _ = fs::remove_dir(&transaction);
            return Err(format!("Agent 安装链接发生变化，已恢复原版本: {error}"));
        }
        return Err(format!(
            "Agent 安装链接发生变化且自动恢复未完成: {error}; {}; 原版本保留在 {}",
            rollback.expect_err("checked rollback error"),
            recovered.display()
        ));
    }
    let segment = transaction
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("无法生成商店版本恢复标识")?;
    Ok(Some(format!("managed:{segment}")))
}

fn marketplace_skill_md_sha256(path: &Path, label: &str) -> Result<String, String> {
    read_owned_projection_file(
        &path.join("SKILL.md"),
        MAX_SKILL_FILE_BYTES as usize,
        false,
        label,
    )
    .map(|contents| sha256_hex(&contents))
}

fn marketplace_projection_matches_recovered_at(
    root: &Path,
    managed_root: &Path,
    skill_id: &str,
    destination: &Path,
    recovered: &Path,
) -> Result<bool, String> {
    let projection_root = projection_root_at(root, skill_id);
    let current_path = projection_root.join("current");
    let Some((marker, generation)) = current_projection_at(root, managed_root, skill_id) else {
        if fs::symlink_metadata(&current_path).is_ok() {
            return Err("当前 Agent 投影身份无效，拒绝恢复商店版本".into());
        }
        return Ok(false);
    };
    if !marketplace_projection_is_unedited(&marker, &generation) {
        return Err("当前 Agent 投影已被修改，拒绝自动恢复商店版本".into());
    }
    let canonical_sha256 = marketplace_skill_md_sha256(destination, "当前商店 SKILL.md")?;
    if marker.canonical_skill_md_sha256 == canonical_sha256 {
        return Ok(false);
    }
    let recovered_sha256 = marketplace_skill_md_sha256(recovered, "待恢复商店 SKILL.md")?;
    if marker.canonical_skill_md_sha256 == recovered_sha256 {
        return Ok(true);
    }
    Err("当前 canonical、回收版本与 Agent 投影互不匹配，未移动任何用户内容".into())
}

fn capture_interrupted_marketplace_guard_at(
    home: &Path,
    root: &Path,
    managed_root: &Path,
    skill_id: &str,
) -> Result<MarketplaceReplacementGuard, String> {
    let canonical = managed_root.join(skill_id);
    validate_real_directory(&canonical, "中断恢复中的商店 Skill")?;
    let repository = git2::Repository::open(&canonical)
        .map_err(|error| format!("中断恢复中的商店 Skill 缺少版本记录: {error}"))?;
    if working_copy_state_for_path(&canonical).0 {
        return Err("当前商店 Skill 有尚未版本化的本机修改，拒绝自动恢复".into());
    }
    let metadata = fs::symlink_metadata(&canonical).map_err(|error| error.to_string())?;
    let projection_root = projection_root_at(root, skill_id);
    let current_path = projection_root.join("current");
    let (marker, generation) =
        current_projection_at(root, managed_root, skill_id).ok_or_else(|| {
            if fs::symlink_metadata(&current_path).is_ok() {
                "中断恢复中的 Agent 投影身份无效".to_string()
            } else {
                "中断恢复缺少可验证的 Agent 投影".to_string()
            }
        })?;
    if !marketplace_projection_is_unedited(&marker, &generation) {
        return Err("中断恢复中的 Agent 投影已被修改".into());
    }
    Ok(MarketplaceReplacementGuard {
        canonical_device: metadata.dev(),
        canonical_inode: metadata.ino(),
        canonical_fingerprint: skill_tree_fingerprint(&canonical)?,
        canonical_head: repository
            .head()
            .and_then(|head| head.peel_to_commit())
            .map(|commit| commit.id())
            .map_err(|error| format!("无法验证中断恢复中的商店版本: {error}"))?,
        current_projection: Some(MarketplaceCurrentProjectionGuard {
            marker,
            generation: generation.clone(),
            current: marketplace_path_snapshot(&current_path)?
                .ok_or("中断恢复中的 Agent 投影链接已消失")?,
            generation_directory: marketplace_path_snapshot(&generation)?
                .ok_or("中断恢复中的 Agent 投影 generation 已消失")?,
        }),
        agent_links: marketplace_agent_link_snapshots(home, managed_root, skill_id)?,
    })
}

#[allow(clippy::too_many_arguments)]
fn rollback_interrupted_marketplace_replacement_at(
    home: &Path,
    root: &Path,
    managed_root: &Path,
    old_transaction: &Path,
    old_manifest_path: &Path,
    destination: &Path,
    old_recovered: &Path,
    skill_id: &str,
    display_name: &str,
) -> Result<(), String> {
    rollback_interrupted_marketplace_replacement_at_with_hook(
        home,
        root,
        managed_root,
        old_transaction,
        old_manifest_path,
        destination,
        old_recovered,
        skill_id,
        display_name,
        || Ok(()),
    )
}

#[allow(clippy::too_many_arguments)]
fn rollback_interrupted_marketplace_replacement_at_with_hook<F>(
    home: &Path,
    root: &Path,
    managed_root: &Path,
    old_transaction: &Path,
    old_manifest_path: &Path,
    destination: &Path,
    old_recovered: &Path,
    skill_id: &str,
    display_name: &str,
    after_candidate_manifest_complete: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    let guard = capture_interrupted_marketplace_guard_at(home, root, managed_root, skill_id)?;
    let recovered_sha256 = marketplace_skill_md_sha256(old_recovered, "待恢复商店 SKILL.md")?;
    if guard
        .current_projection
        .as_ref()
        .is_none_or(|projection| projection.marker.canonical_skill_md_sha256 != recovered_sha256)
    {
        return Err("Agent 投影并未指向待恢复版本，未移动任何用户内容".into());
    }
    let old_metadata = fs::symlink_metadata(old_recovered).map_err(|error| error.to_string())?;
    let old_fingerprint = skill_tree_fingerprint(old_recovered)?;

    let candidate_transaction =
        prepare_marketplace_replacement_backup(root, skill_id, display_name)?;
    let candidate_manifest_path = candidate_transaction.join("recovery-manifest.json");
    let candidate_recovered = candidate_transaction.join("skill");
    if let Err(error) = capture_interrupted_marketplace_guard_at(home, root, managed_root, skill_id)
        .and_then(|actual| {
            (actual == guard)
                .then_some(())
                .ok_or_else(|| "恢复前 canonical、Agent 投影或安装链接发生变化".to_string())
        })
    {
        let _ = fs::remove_file(&candidate_manifest_path);
        let _ = fs::remove_dir(&candidate_transaction);
        return Err(error);
    }
    if let Err(error) = rename_noreplace(destination, &candidate_recovered) {
        let _ = fs::remove_file(&candidate_manifest_path);
        let _ = fs::remove_dir(&candidate_transaction);
        return Err(format!("无法备份中断恢复前的当前版本: {error}"));
    }
    let candidate_moved = validate_moved_marketplace_canonical(&candidate_recovered, &guard)
        .and_then(|()| validate_detached_marketplace_projection_guard_at(&guard))
        .and_then(|()| {
            update_marketplace_replacement_manifest(
                &candidate_manifest_path,
                "in_progress",
                "old_moved",
            )
            .map(|_| ())
        });
    if let Err(error) = candidate_moved {
        let rollback = rename_noreplace(&candidate_recovered, destination);
        if rollback.is_ok() {
            let _ = fs::remove_file(&candidate_manifest_path);
            let _ = fs::remove_dir(&candidate_transaction);
        }
        return Err(match rollback {
            Ok(()) => format!("中断恢复校验失败，已保留当前版本: {error}"),
            Err(rollback_error) => format!(
                "中断恢复校验失败；当前版本保留在 {}，自动恢复失败: {rollback_error}",
                candidate_recovered.display()
            ),
        });
    }
    if let Err(error) = rename_noreplace(old_recovered, destination) {
        let rollback = rename_noreplace(&candidate_recovered, destination);
        if rollback.is_ok() {
            let _ = fs::remove_file(&candidate_manifest_path);
            let _ = fs::remove_dir(&candidate_transaction);
        }
        return Err(match rollback {
            Ok(()) => format!("待恢复版本启用失败，已保留当前版本: {error}"),
            Err(rollback_error) => format!(
                "待恢复版本启用失败；当前版本保留在 {}，自动恢复失败: {rollback_error}",
                candidate_recovered.display()
            ),
        });
    }

    let restored_result = (|| -> Result<(), String> {
        let restored_metadata =
            fs::symlink_metadata(destination).map_err(|error| error.to_string())?;
        if restored_metadata.file_type().is_symlink()
            || !restored_metadata.is_dir()
            || restored_metadata.dev() != old_metadata.dev()
            || restored_metadata.ino() != old_metadata.ino()
            || skill_tree_fingerprint(destination)? != old_fingerprint
        {
            return Err("待恢复商店版本在原子启用期间发生变化".into());
        }
        let restored_guard =
            capture_marketplace_replacement_guard_at(home, root, managed_root, skill_id)?;
        if restored_guard.current_projection != guard.current_projection
            || restored_guard.agent_links != guard.agent_links
        {
            return Err("Agent 投影或安装链接在中断恢复期间发生变化".into());
        }
        update_marketplace_replacement_manifest(
            &candidate_manifest_path,
            "in_progress",
            "candidate_activated",
        )?;
        if let Ok(directory) = fs::File::open(managed_root) {
            directory.sync_all().map_err(|error| error.to_string())?;
        }
        update_marketplace_replacement_manifest(&candidate_manifest_path, "trashed", "complete")?;
        after_candidate_manifest_complete()?;
        update_marketplace_replacement_manifest(old_manifest_path, "restored", "complete")?;
        Ok(())
    })();
    if let Err(error) = restored_result {
        return Err(format!(
            "中断的商店版本已恢复到 canonical；收尾记录失败且未反向移动已一致的 canonical/Agent 投影: {error}; 恢复记录位于 {}，另一版本保留在 {}",
            old_transaction.display(),
            candidate_transaction.display()
        ));
    }
    Ok(())
}

fn rollback_marketplace_replacement_at(
    home: &Path,
    root: &Path,
    managed_root: &Path,
    recovery_id: &str,
) -> Result<(), String> {
    let (kind, old_transaction, old_manifest_path) = resolve_recovery_item_at(root, recovery_id)?;
    if kind != "managed" {
        return Err("商店版本恢复标识类型无效".into());
    }
    let old_manifest = read_recovery_manifest(&old_manifest_path)?;
    if old_manifest
        .get("reason")
        .and_then(serde_json::Value::as_str)
        != Some("marketplace_version_replacement")
    {
        return Err("该回收项不是可回滚的商店版本".into());
    }
    match old_manifest
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown")
    {
        "restored" => return Ok(()),
        "trashed" | "in_progress" => {}
        _ => return Err("该回收项不是可回滚的商店版本".into()),
    }
    let skill_id = old_manifest
        .get("skillId")
        .and_then(serde_json::Value::as_str)
        .ok_or("商店版本恢复清单缺少 Skill 标识")?;
    validate_skill_id(skill_id)?;
    let display_name = old_manifest
        .get("displayName")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(skill_id);
    let destination = managed_root.join(skill_id);
    let old_recovered = old_transaction.join("skill");
    validate_real_directory(&old_recovered, "待恢复的商店 Skill")?;
    let old_profile = read_profile_at_path(&old_recovered)?;
    if matches!(
        fs::symlink_metadata(&destination),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    ) {
        let current_projection = projection_root_at(root, skill_id).join("current");
        let current_snapshot = marketplace_path_snapshot(&current_projection)?;
        let projection_name = projection_name_from_profile(skill_id, &old_profile)?;
        let agent_links = marketplace_agent_link_snapshots_for_name(home, &projection_name)?;
        let recovered_metadata =
            fs::symlink_metadata(&old_recovered).map_err(|error| error.to_string())?;
        let recovered_fingerprint = skill_tree_fingerprint(&old_recovered)?;
        rename_noreplace(&old_recovered, &destination).map_err(|error| {
            format!("无法恢复中断切换留下的商店版本，未覆盖任何新内容: {error}")
        })?;
        let restored_result = (|| -> Result<(), String> {
            let restored_metadata =
                fs::symlink_metadata(&destination).map_err(|error| error.to_string())?;
            if restored_metadata.file_type().is_symlink()
                || !restored_metadata.is_dir()
                || restored_metadata.dev() != recovered_metadata.dev()
                || restored_metadata.ino() != recovered_metadata.ino()
                || skill_tree_fingerprint(&destination)? != recovered_fingerprint
            {
                return Err("中断切换留下的商店版本在恢复期间发生变化".into());
            }
            if marketplace_path_snapshot(&current_projection)? != current_snapshot
                || marketplace_agent_link_snapshots_for_name(home, &projection_name)? != agent_links
            {
                return Err("Agent 投影或安装链接在中断恢复期间发生变化".into());
            }
            if current_snapshot.is_some() {
                capture_marketplace_replacement_guard_at(home, root, managed_root, skill_id)?;
            }
            update_marketplace_replacement_manifest(&old_manifest_path, "restored", "complete")?;
            Ok(())
        })();
        if let Err(error) = restored_result {
            let rollback = rename_noreplace(&destination, &old_recovered);
            return Err(match rollback {
                Ok(()) => format!(
                    "中断切换恢复校验失败，已将原内容保留在回收站且未改动 Agent 投影: {error}"
                ),
                Err(rollback_error) => format!(
                    "中断切换恢复校验失败: {error}; canonical 自动回滚失败，原内容位于 {}: {rollback_error}",
                    destination.display()
                ),
            });
        }
        return Ok(());
    }
    validate_real_directory(&destination, "当前商店 Skill")?;
    let current_profile = read_profile_at_path(&destination)?;
    if current_profile.acquisition_source != Some(AcquisitionSource::Marketplace)
        || current_profile.server_id.is_none()
        || current_profile.server_id != old_profile.server_id
    {
        return Err("当前 Skill 已发生变化，拒绝自动回滚商店版本".into());
    }

    if marketplace_projection_matches_recovered_at(
        root,
        managed_root,
        skill_id,
        &destination,
        &old_recovered,
    )? {
        return rollback_interrupted_marketplace_replacement_at(
            home,
            root,
            managed_root,
            &old_transaction,
            &old_manifest_path,
            &destination,
            &old_recovered,
            skill_id,
            display_name,
        );
    }

    let guard = capture_marketplace_replacement_guard_at(home, root, managed_root, skill_id)?;
    let old_metadata = fs::symlink_metadata(&old_recovered).map_err(|error| error.to_string())?;
    let old_fingerprint = skill_tree_fingerprint(&old_recovered)?;
    let prepared_projection =
        prepare_marketplace_projection_at(root, managed_root, skill_id, &old_recovered, &guard)?;
    if let Err(error) =
        validate_marketplace_replacement_guard_at(home, root, managed_root, skill_id, &guard)
    {
        if let Some(prepared) = &prepared_projection {
            discard_prepared_marketplace_projection(prepared);
        }
        return Err(error);
    }

    // The approved candidate is also retained as a recoverable item. SkillHub
    // never deletes either side of a Marketplace replacement transaction.
    let candidate_transaction =
        prepare_marketplace_replacement_backup(root, skill_id, display_name)?;
    let candidate_manifest_path = candidate_transaction.join("recovery-manifest.json");
    let candidate_recovered = candidate_transaction.join("skill");
    if let Err(error) = rename_noreplace(&destination, &candidate_recovered) {
        if let Some(prepared) = &prepared_projection {
            discard_prepared_marketplace_projection(prepared);
        }
        let _ = fs::remove_file(&candidate_manifest_path);
        let _ = fs::remove_dir(&candidate_transaction);
        return Err(format!(
            "无法备份未完成安装的商店版本，旧版本仍在回收站: {error}"
        ));
    }
    if let Err(error) = validate_moved_marketplace_canonical(&candidate_recovered, &guard)
        .and_then(|()| validate_detached_marketplace_projection_guard_at(&guard))
        .and_then(|()| {
            update_marketplace_replacement_manifest(
                &candidate_manifest_path,
                "in_progress",
                "old_moved",
            )
            .map(|_| ())
        })
    {
        let rollback = rename_noreplace(&candidate_recovered, &destination);
        if rollback.is_ok() {
            if let Some(prepared) = &prepared_projection {
                discard_prepared_marketplace_projection(prepared);
            }
            let _ = fs::remove_file(&candidate_manifest_path);
            let _ = fs::remove_dir(&candidate_transaction);
        }
        return Err(match rollback {
            Ok(()) => format!("当前版本或 Agent 投影发生变化，已保留当前版本: {error}"),
            Err(rollback_error) => format!(
                "当前版本或 Agent 投影发生变化；当前版本保留在 {}，恢复当前版本失败: {rollback_error}",
                candidate_recovered.display()
            ),
        });
    }
    if let Err(error) = rename_noreplace(&old_recovered, &destination) {
        let rollback = rename_noreplace(&candidate_recovered, &destination);
        if rollback.is_ok() {
            if let Some(prepared) = &prepared_projection {
                discard_prepared_marketplace_projection(prepared);
            }
            let _ = fs::remove_file(&candidate_manifest_path);
            let _ = fs::remove_dir(&candidate_transaction);
        }
        return Err(match rollback {
            Ok(()) => format!("旧版本启用失败，已保留当前版本: {error}"),
            Err(rollback_error) => format!(
                "旧版本启用失败；当前版本保留在 {}，恢复当前版本也失败: {rollback_error}",
                candidate_recovered.display()
            ),
        });
    }
    let restored_metadata =
        fs::symlink_metadata(&destination).map_err(|error| error.to_string())?;
    let restored_valid = !restored_metadata.file_type().is_symlink()
        && restored_metadata.is_dir()
        && restored_metadata.dev() == old_metadata.dev()
        && restored_metadata.ino() == old_metadata.ino()
        && skill_tree_fingerprint(&destination)? == old_fingerprint
        && validate_detached_marketplace_projection_guard_at(&guard).is_ok();
    let projection_result = if restored_valid {
        update_marketplace_replacement_manifest(
            &candidate_manifest_path,
            "in_progress",
            "candidate_activated",
        )
        .map(|_| ())
        .and_then(|()| {
            prepared_projection
                .as_ref()
                .map_or(Ok(()), commit_prepared_marketplace_projection)
        })
    } else {
        Err("旧商店版本在启用期间发生变化".into())
    };
    let finalize_result = projection_result.and_then(|()| {
        validate_marketplace_agent_links_at(&guard)?;
        if let Ok(directory) = fs::File::open(managed_root) {
            directory.sync_all().map_err(|error| error.to_string())?;
        }
        update_marketplace_replacement_manifest(&candidate_manifest_path, "trashed", "complete")?;
        update_marketplace_replacement_manifest(&old_manifest_path, "restored", "complete")?;
        Ok(())
    });
    if let Err(error) = finalize_result {
        let rollback = rollback_activated_marketplace_state(
            prepared_projection.as_ref(),
            &destination,
            &old_recovered,
            &candidate_recovered,
        );
        if rollback.is_ok() {
            if let Some(prepared) = &prepared_projection {
                if fs::symlink_metadata(&prepared.temporary_current).is_ok() {
                    discard_prepared_marketplace_projection(prepared);
                }
            }
            let _ = fs::remove_file(&candidate_manifest_path);
            let _ = fs::remove_dir(&candidate_transaction);
            return Err(format!(
                "商店版本切换未完成，已恢复当前 Skill 与 Agent 投影: {error}"
            ));
        }
        return Err(format!(
            "商店版本切换失败且自动恢复未完成: {error}; {}; 旧版本位于 {}，当前版本位于 {}",
            rollback.expect_err("checked rollback error"),
            old_recovered.display(),
            candidate_recovered.display()
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn rollback_marketplace_replacement(recovery_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        rollback_marketplace_replacement_at(
            &crate::user_home_dir().ok_or("Cannot find home dir")?,
            &skillhub_dir(),
            &skills_dir(),
            &recovery_id,
        )
    })
    .await
    .map_err(|error| format!("商店版本恢复任务异常结束：{error}"))?
}

#[tauri::command]
pub fn import_skill_package(
    space: crate::server_request::SpaceHandle,
    data: ImportSkillPackageInput,
) -> Result<LocalSkill, String> {
    let ImportSkillPackageInput {
        catalog_origin,
        skill_id,
        name,
        package_base64,
        expected_sha256,
        server_id,
        server_owner_id,
        display_name,
        description,
        source_url,
        category,
        labels,
        version,
        team_id,
        team_ids,
        is_own,
        acquisition_source,
        acquired_by_user_id,
        replace_existing_marketplace,
        install_count,
        created_at,
        updated_at,
        trigger_scenarios,
        compatible_agents,
        env_dependencies,
    } = data;
    // Attributed to the account signed in now (#91); see the commit below.
    let attribution = crate::runtime_env::ImportAttribution::begin_expected(&space)?;
    if is_system_skill_id(&skill_id)
        || name
            .as_deref()
            .is_some_and(|projection_name| is_system_skill_id(projection_name.trim()))
    {
        return Err("SkillHub Manager 是保留的系统 Skill，不能由服务器包覆盖".into());
    }
    let acquisition_source = acquisition_source.unwrap_or_else(|| {
        if team_id.is_some() || !is_own {
            AcquisitionSource::Team
        } else {
            AcquisitionSource::Local
        }
    });
    let acquired_by_user_id =
        normalize_import_account_binding(acquisition_source, acquired_by_user_id.as_deref())?;
    // Acquisition provenance and account authorization are independent. The
    // caller derives this bit from the current account and server author id.
    let catalog_origin = if acquisition_source == AcquisitionSource::Marketplace {
        Some(crate::catalog::validate_origin(
            catalog_origin.as_deref().ok_or("商店包缺少官方来源")?,
        )?)
    } else {
        if catalog_origin.is_some() {
            return Err("非商店包不能指定官方来源".into());
        }
        None
    };
    let is_own = catalog_origin.is_none() && imported_asset_is_own(is_own);
    validate_skill_id(&skill_id)?;
    let projection_name = name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&skill_id)
        .to_string();
    validate_skill_id(&projection_name)
        .map_err(|_| "服务器 Skill name 不能作为安全的 Agent 投影名".to_string())?;
    let bytes = BASE64
        .decode(package_base64)
        .map_err(|error| error.to_string())?;
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 {
        return Err("Skill 压缩包大小无效".into());
    }
    let actual_sha256 = format!("{:x}", Sha256::digest(&bytes));
    if actual_sha256 != expected_sha256 {
        return Err("Skill 压缩包校验失败".into());
    }
    let mut persisted_team_ids = Vec::new();
    let mut seen_team_ids = HashSet::new();
    for candidate in team_id.iter().chain(team_ids.iter()) {
        let normalized = if acquisition_source == AcquisitionSource::Team {
            uuid::Uuid::parse_str(candidate)
                .map(|value| value.to_string())
                .map_err(|_| "团队 Skill 包含无效的团队标识".to_string())?
        } else {
            candidate.trim().to_string()
        };
        if !normalized.is_empty() && seen_team_ids.insert(normalized.clone()) {
            persisted_team_ids.push(normalized);
        }
    }
    persisted_team_ids.sort();
    if acquisition_source == AcquisitionSource::Team && persisted_team_ids.is_empty() {
        return Err("团队 Skill 缺少当前可见的团队共享".into());
    }
    // Team-distributed assets are account-scoped local state: the account
    // attributed at the start must be the acquiring account.
    if acquisition_source == AcquisitionSource::Team {
        let expected_user_id = acquired_by_user_id
            .as_deref()
            .ok_or("团队 Skill 缺少获取账号")?;
        let active_user_id = attribution
            .account_id()
            .ok_or("安装团队 Skill 前请先在 SkillHub APP 登录")?;
        if active_user_id != expected_user_id {
            return Err("当前账号与团队 Skill 获取账号不一致".into());
        }
    }
    // Prove the session is still the attributed one and hold it from the
    // first filesystem mutation through the completed activation, so the
    // stamp and (for Team) the acquiring account cannot go stale.
    let _session_lease = attribution.commit()?;
    let managed_root = skills_dir();
    fs::create_dir_all(&managed_root).map_err(|error| error.to_string())?;
    validate_real_directory(&managed_root, "SkillHub 资产目录")?;
    let destination = managed_root.join(&skill_id);
    // Same per-Skill lock as account sync, so a landing and an install never
    // write one directory at the same time.
    let _skill_lock = crate::skill_lock::lock_skill_dir(&skill_id)?;
    if replace_existing_marketplace {
        let previous = read_profile_at_path(&destination)?;
        if !crate::spaces::current_profile_matches(&previous)? {
            return Err("此 Skill 属于其他空间或账号，拒绝覆盖".into());
        }
    }
    validate_marketplace_replacement_target(
        &destination,
        &server_id,
        acquisition_source,
        acquired_by_user_id.as_deref(),
        replace_existing_marketplace,
    )?;
    // A version update keeps the directory's account library binding; account
    // sync then points the entry at the new version.
    let preserved = replace_existing_marketplace
        .then(|| read_profile_at_path(&destination).ok())
        .flatten();
    let stage = managed_root.join(format!(
        ".skillhub-marketplace-import-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir(&stage).map_err(|error| error.to_string())?;
    fs::set_permissions(&stage, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    if let Err(error) = extract_marketplace_package_to_stage(&bytes, &stage) {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    let initialize_result: Result<(), String> = (|| {
        git2::Repository::init(&stage).map_err(|error| error.to_string())?;
        ensure_git_excludes(&stage).map_err(|error| error.to_string())?;
        let mut profile = SkillHubProfile {
            id: Some(uuid::Uuid::new_v4().to_string()),
            catalog_origin: catalog_origin.clone(),
            acquisition_version: catalog_origin.as_ref().map(|_| version.clone()),
            library_account_id: preserved
                .as_ref()
                .and_then(|profile| profile.library_account_id.clone()),
            library_entry_id: preserved
                .as_ref()
                .and_then(|profile| profile.library_entry_id.clone()),
            server_id: Some(server_id),
            server_owner_id: Some(server_owner_id),
            is_own: Some(is_own),
            acquisition_source: Some(acquisition_source),
            acquisition_package_sha256: (acquisition_source != AcquisitionSource::Local)
                .then_some(actual_sha256.clone()),
            acquired_by_user_id,
            team_shared_from: (acquisition_source == AcquisitionSource::Team)
                .then(|| persisted_team_ids.first().cloned())
                .flatten()
                .or(team_id.clone()),
            name: Some(projection_name),
            display_name: Some(display_name.clone()),
            description,
            source_url: crate::sanitize_source_url(source_url.as_deref()),
            category,
            labels,
            trigger_scenarios,
            env_dependencies,
            compatible_agents,
            version: version.clone(),
            teams: persisted_team_ids.clone(),
            team_ids: persisted_team_ids,
            install_count,
            created_at,
            updated_at,
            added_by_account_id: attribution.account_id().map(str::to_string),
            scope: attribution.scope(),
            ..Default::default()
        };
        // 包内声明优先于 Server 元数据（#251）。
        crate::env_detect::apply_declared_dependencies(
            &mut profile.env_dependencies,
            &staged_env_declarations(&stage),
        );
        write_profile_at_path(&stage, &profile).map_err(|error| error.to_string())?;
        let source_label = match acquisition_source {
            AcquisitionSource::Local => "从个人资产导入",
            AcquisitionSource::Team => "从团队导入",
            AcquisitionSource::Marketplace => "从 Skill 商店导入",
        };
        create_skill_snapshot_at_path(&stage, &format!("{version} · {source_label}"))?;
        ensure_current_local_version_at(&stage, &mut profile)
    })();
    if let Err(error) = initialize_result {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    if catalog_origin.is_some() {
        if let Err(error) = crate::catalog::cache_package(&skillhub_dir(), &actual_sha256, &bytes) {
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }
    }
    let home = crate::user_home_dir().ok_or("Cannot find home dir")?;
    let replacement_recovery_id = match activate_staged_marketplace_package(
        &home,
        &skillhub_dir(),
        &stage,
        &destination,
        &skill_id,
        &display_name,
        replace_existing_marketplace,
    ) {
        Ok(recovery_id) => recovery_id,
        Err(error) => {
            if stage.exists() {
                let _ = fs::remove_dir_all(&stage);
            }
            return Err(error);
        }
    };
    let mut skill = build_local_skill(&skill_id);
    skill.marketplace_replacement_recovery_id = replacement_recovery_id;
    // Read-only review: the package author owns the declaration, so keys found
    // here but not declared are only reported, never written (#250).
    let declared: Vec<String> = skill.env_deps.iter().map(|dep| dep.key.clone()).collect();
    skill.undeclared_env_suggestions =
        crate::env_detect::undeclared_suggestion_keys(&skill_path(&skill_id), &declared);
    Ok(skill)
}

// ── Account library sync bridge ─────────────────────────────────────────────
//
// `library_sync` reuses the managed-tree rules, packaging and guarded
// replacement below instead of keeping its own copies of them.

pub(crate) fn validate_skill_id_for_lock(skill_id: &str) -> Result<(), String> {
    validate_skill_id(skill_id)
}

/// One regular file of a managed Skill exactly as packaging includes it.
#[derive(Debug, Clone)]
pub(crate) struct LibraryTreeFile {
    /// `/`-joined relative path, as written into the package.
    pub(crate) path: String,
    pub(crate) absolute: PathBuf,
    /// Unix executable bit; always false where the file system has none.
    pub(crate) executable: bool,
}

pub(crate) fn library_tree_files(root: &Path) -> Result<Vec<LibraryTreeFile>, String> {
    collect_skill_tree(root)?
        .into_iter()
        .filter(|entry| !entry.is_directory)
        .map(|entry| {
            #[cfg(unix)]
            let executable = fs::metadata(&entry.path)
                .map_err(|error| error.to_string())?
                .permissions()
                .mode()
                & 0o111
                != 0;
            #[cfg(windows)]
            let executable = false;
            Ok(LibraryTreeFile {
                path: entry.normalized,
                absolute: entry.path,
                executable,
            })
        })
        .collect()
}

/// Content fingerprint used by guarded replacement (excludes `.skillhub.json`).
pub(crate) fn library_tree_fingerprint(root: &Path) -> Result<Vec<u8>, String> {
    skill_tree_fingerprint(root)
}

pub(crate) fn library_package_bytes(
    root: &Path,
    executables: Option<&BTreeSet<String>>,
) -> Result<Vec<u8>, String> {
    package_skill_root(root, executables)
}

pub(crate) fn library_read_profile(root: &Path) -> Result<SkillHubProfile, String> {
    read_current_profile_at_path(root)
}

/// Same view as `library_read_profile`, normalised in memory only: for
/// read-only queries that must never rewrite `.skillhub.json`.
pub(crate) fn library_read_profile_readonly(root: &Path) -> Result<SkillHubProfile, String> {
    let mut profile = read_profile_at_path(root)?;
    normalize_profile_initial_version(&mut profile);
    normalize_profile_acquisition_source(&mut profile);
    Ok(profile)
}

pub(crate) fn library_write_profile(root: &Path, profile: &SkillHubProfile) -> Result<(), String> {
    write_profile_at_path(root, profile).map_err(|error| error.to_string())
}

pub(crate) fn library_acquisition_source(profile: &SkillHubProfile) -> AcquisitionSource {
    profile_acquisition_source(profile)
}

pub(crate) fn library_skill_is_system(skill_id: &str) -> bool {
    is_system_skill_id(skill_id)
}

/// Moves a managed Skill to the local recycle bin, like the GUI delete.
pub(crate) fn library_trash_skill(skill_id: &str) -> Result<String, String> {
    delete_managed_skill_unlocked(skill_id.to_string())
}

/// Records every working-tree change, including deletions, as one version.
pub(crate) fn library_snapshot_at(path: &Path, message: &str) -> Result<(), String> {
    library_snapshot_inner(path, message, false)
}

pub(crate) fn library_snapshot_inner(
    path: &Path,
    message: &str,
    allow_empty: bool,
) -> Result<(), String> {
    let repo = crate::version_policy::init_repository(path).map_err(|error| error.to_string())?;
    ensure_git_excludes(path).map_err(|error| error.to_string())?;
    let mut index = repo.index().map_err(|error| error.to_string())?;
    let _ = index.remove_path(Path::new(".skillhub.json"));
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|error| error.to_string())?;
    index
        .update_all(["*"].iter(), None)
        .map_err(|error| error.to_string())?;
    index.write().map_err(|error| error.to_string())?;
    let tree_id = index.write_tree().map_err(|error| error.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|error| error.to_string())?;
    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    if !allow_empty
        && parent
            .as_ref()
            .is_some_and(|commit| commit.tree_id() == tree_id)
    {
        return Ok(());
    }
    let signature =
        git2::Signature::now("SkillHub", "skillhub@local").map_err(|error| error.to_string())?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &parents,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// True when one of the recent versions of `root` carries `token` in its
/// message; sync uses it to recognise a replacement that already landed.
pub(crate) fn library_history_contains(root: &Path, token: &str) -> bool {
    let Ok(repo) = git2::Repository::open(root) else {
        return false;
    };
    let Ok(mut walk) = repo.revwalk() else {
        return false;
    };
    if walk.push_head().is_err() {
        return false;
    }
    let found = walk
        .take(50)
        .filter_map(Result::ok)
        .filter_map(|id| repo.find_commit(id).ok())
        .any(|commit| {
            commit
                .message()
                .is_ok_and(|message| message.contains(token))
        });
    found
}

/// Copies an existing `.git` so a synced update keeps the local version history.
fn copy_git_history(source_root: &Path, stage: &Path) -> Result<(), String> {
    let source = source_root.join(".git");
    match fs::symlink_metadata(&source) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        _ => return Ok(()),
    }
    for entry in WalkDir::new(&source).follow_links(false) {
        let entry = entry.map_err(|error| error.to_string())?;
        let relative = entry
            .path()
            .strip_prefix(&source)
            .map_err(|error| error.to_string())?;
        let target = stage.join(".git").join(relative);
        let file_type = entry.file_type();
        if file_type.is_dir() {
            fs::create_dir_all(&target).map_err(|error| error.to_string())?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Why a landing did not replace the local directory.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LibraryLandingError {
    /// The local directory no longer matches what sync last verified.
    LocalChanged,
    Failed(String),
}

impl From<String> for LibraryLandingError {
    fn from(value: String) -> Self {
        Self::Failed(value)
    }
}

/// Rollback reason when the moved original fails the full sync-state check.
const LIBRARY_LOCAL_CHANGED: &str = "同步期间本机 Skill 有新的修改";

/// Full sync-state check of an existing directory; see `LibraryLanding`.
pub(crate) type LibraryStateCheck = dyn Fn(&Path) -> Result<bool, String>;

pub(crate) struct LibraryLanding<'a> {
    pub(crate) skill_id: &'a str,
    pub(crate) package: &'a [u8],
    pub(crate) profile: SkillHubProfile,
    /// `library_tree_fingerprint` the existing directory must still have.
    /// Required whenever the directory exists.
    pub(crate) expected_existing: Option<&'a [u8]>,
    /// Full sync-state check of the existing directory (content hash,
    /// executable paths, synced profile). The tree fingerprint above ignores
    /// the sidecar and permission bits, so this runs too: before staging and
    /// again immediately before the switch. Required whenever it exists.
    pub(crate) verify_existing: Option<&'a LibraryStateCheck>,
    pub(crate) message: &'a str,
}

/// Both checks of an existing directory, see `LibraryLanding`.
fn library_existing_unchanged(
    destination: &Path,
    expected: Option<&[u8]>,
    verify: Option<&LibraryStateCheck>,
) -> Result<bool, LibraryLandingError> {
    let (Some(expected), Some(verify)) = (expected, verify) else {
        return Err(LibraryLandingError::Failed(
            "替换本机 Skill 前缺少已核对的同步状态".into(),
        ));
    };
    Ok(skill_tree_fingerprint(destination)? == expected && verify(destination)?)
}

/// Stages a verified card, then either places it as a new managed Skill or
/// replaces the existing directory through the guarded marketplace path
/// (backup, projection refresh, rollback). The caller holds the Skill lock.
pub(crate) fn land_library_package_at(
    home: &Path,
    skillhub_root: &Path,
    managed_root: &Path,
    landing: LibraryLanding<'_>,
) -> Result<(), LibraryLandingError> {
    let LibraryLanding {
        skill_id,
        package,
        mut profile,
        expected_existing,
        verify_existing,
        message,
    } = landing;
    validate_skill_id(skill_id)?;
    if is_system_skill_id(skill_id) {
        return Err(LibraryLandingError::Failed(
            "SkillHub Manager 是保留的系统 Skill，不参与账号同步".into(),
        ));
    }
    fs::create_dir_all(managed_root).map_err(|error| error.to_string())?;
    validate_real_directory(managed_root, "SkillHub 资产目录")?;
    let destination = managed_root.join(skill_id);
    let existing = match fs::symlink_metadata(&destination) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(LibraryLandingError::Failed(
                "资产库中的同名项不是可安全更新的真实目录".into(),
            ));
        }
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(LibraryLandingError::Failed(error.to_string())),
    };
    if existing && !library_existing_unchanged(&destination, expected_existing, verify_existing)? {
        return Err(LibraryLandingError::LocalChanged);
    }

    let stage = managed_root.join(format!(".skillhub-library-sync-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&stage).map_err(|error| error.to_string())?;
    let prepared: Result<(), String> = (|| {
        fs::set_permissions(&stage, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
        extract_marketplace_package_to_stage(package, &stage)?;
        if existing {
            copy_git_history(&destination, &stage)?;
        }
        crate::env_detect::annotate_declared_dependencies(
            &mut profile.env_dependencies,
            &staged_env_declarations(&stage),
        );
        write_profile_at_path(&stage, &profile).map_err(|error| error.to_string())?;
        // Always a new version, even when the tree is unchanged (e.g. only an
        // ignored sidecar changed): its message carries the recovery token.
        library_snapshot_inner(&stage, message, true)
    })();
    if let Err(error) = prepared {
        let _ = fs::remove_dir_all(&stage);
        return Err(LibraryLandingError::Failed(error));
    }
    if !existing {
        return rename_noreplace(&stage, &destination).map_err(|error| {
            let _ = fs::remove_dir_all(&stage);
            LibraryLandingError::Failed(error.to_string())
        });
    }

    // The guarded replacement refuses unversioned edits. The content was just
    // proven equal to the synced baseline, so recording it loses nothing.
    if working_copy_state_for_path(&destination).0 {
        if let Err(error) = library_snapshot_at(&destination, "同步前保存本机状态") {
            let _ = fs::remove_dir_all(&stage);
            return Err(LibraryLandingError::Failed(error));
        }
    }
    // Last check after staging: a profile edit or chmod made meanwhile keeps
    // the original in place (the guarded switch below pins the file bytes).
    match library_existing_unchanged(&destination, expected_existing, verify_existing) {
        Ok(true) => {}
        Ok(false) => {
            let _ = fs::remove_dir_all(&stage);
            return Err(LibraryLandingError::LocalChanged);
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }
    }
    let display_name = profile
        .display_name
        .clone()
        .unwrap_or_else(|| skill_id.to_string());
    let recovery = activate_staged_marketplace_package_with_hooks(
        home,
        skillhub_root,
        &stage,
        &destination,
        skill_id,
        &display_name,
        true,
        || {},
        || Ok(()),
        verify_existing,
    );
    match recovery {
        Ok(recovery) => {
            // The replaced content equals the previous synced card, which the
            // account still holds; drop the local backup so routine sync does
            // not fill the recycle bin.
            if let Some(segment) = recovery
                .as_deref()
                .and_then(|id| id.strip_prefix("managed:"))
            {
                let trash = skillhub_root.join("trash");
                let backup = trash.join(segment);
                if !segment.contains(['/', '\\']) && backup.starts_with(&trash) {
                    let _ = fs::remove_dir_all(backup);
                }
            }
            Ok(())
        }
        Err(error) => {
            if stage.exists() {
                let _ = fs::remove_dir_all(&stage);
            }
            // Rolled back because the original changed after the last check.
            if error.contains(LIBRARY_LOCAL_CHANGED) && !error.contains("自动恢复失败") {
                return Err(LibraryLandingError::LocalChanged);
            }
            Err(LibraryLandingError::Failed(error))
        }
    }
}

/// Copies a managed Skill directory (packaged files plus the sidecar, never
/// `.git` or local env values) for the conflict-copy snapshot. The copy keeps
/// executable bits on Unix.
pub(crate) fn library_copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for file in library_tree_files(source)? {
        let destination = target.join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(&file.absolute, &destination).map_err(|error| error.to_string())?;
    }
    let sidecar = source.join(".skillhub.json");
    if sidecar.is_file() {
        fs::copy(&sidecar, target.join(".skillhub.json")).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod windows_projection_tests {
    use super::{
        managed_skill_agent_projection_state_at, refresh_skill_projection_at, runtime_header,
        uninstall_skill_projections, ManagedSkillAgentProjectionState,
    };
    use crate::platform_fs::unix_fs;
    use std::fs;

    #[test]
    fn runtime_header_uses_the_stable_windows_cli_path() {
        let header = runtime_header("sample", "test-token", "\r\n", &[]);
        assert!(header.contains(
            r#"& "$env:USERPROFILE\.skillhub\runtime\bin\skillhub.cmd" run sample -- <program> [args...]"#
        ));
        assert!(!header.contains("skillhub run sample"));
    }

    #[test]
    fn agent_junction_matches_current_generation_but_not_retired_generation() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-windows-projection-state-{}",
            uuid::Uuid::new_v4()
        ));
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = skillhub_root.join("skills");
        let skill_root = managed_root.join("sample");
        fs::create_dir_all(&skill_root).expect("create managed Skill");
        fs::write(skill_root.join("SKILL.md"), "# First\n").expect("write canonical Skill");
        fs::write(
            skill_root.join(".skillhub.json"),
            r#"{"version":"1","skillhub":{"id":"sample","name":"sample","envDependencies":[]}}"#,
        )
        .expect("write Skill profile");

        let current = refresh_skill_projection_at(&skillhub_root, &managed_root, "sample")
            .expect("create first projection");
        let first_generation = fs::canonicalize(&current).expect("resolve first generation");
        let agent_link = home.join(".codex/skills/sample");
        fs::create_dir_all(agent_link.parent().expect("Agent root")).expect("create Agent root");
        // platform_fs resolves a directory source before creating an NTFS
        // junction, so this junction stores generation-* rather than `current`.
        unix_fs::symlink(&current, &agent_link).expect("create Agent junction");
        assert_eq!(
            fs::canonicalize(&agent_link).expect("resolve Agent junction"),
            first_generation
        );
        assert!(
            crate::platform_fs::projection_resource_matches(&agent_link, &current),
            "Agent junction must resolve to the exact active current generation"
        );
        assert!(
            super::current_projection_at(&skillhub_root, &managed_root, "sample").is_some(),
            "current junction and its marker must validate"
        );
        assert_eq!(
            managed_skill_agent_projection_state_at(
                &agent_link,
                &skillhub_root,
                &managed_root,
                "sample",
            )
            .expect("classify current Agent junction"),
            ManagedSkillAgentProjectionState::Installed
        );

        fs::write(skill_root.join("SKILL.md"), "# Second\n").expect("update canonical Skill");
        refresh_skill_projection_at(&skillhub_root, &managed_root, "sample")
            .expect("switch current projection");
        assert_ne!(
            fs::canonicalize(&current).expect("resolve refreshed current"),
            first_generation
        );
        // #272: switching `current` keeps no old junction beside it.
        assert!(fs::read_dir(skillhub_root.join("projections/sample"))
            .expect("read projection root")
            .flatten()
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with(".skillhub-old-link-")));
        assert_eq!(
            managed_skill_agent_projection_state_at(
                &agent_link,
                &skillhub_root,
                &managed_root,
                "sample",
            )
            .expect("classify retired Agent junction"),
            ManagedSkillAgentProjectionState::Occupied
        );

        crate::platform_fs::remove_link(&agent_link).expect("remove Agent junction");
        crate::platform_fs::remove_link(&current).expect("remove current junction");
        fs::remove_dir_all(home).expect("remove Windows projection fixture");
    }

    #[test]
    fn uninstall_removes_generated_agent_junction_and_preserves_canonical_skill() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-windows-uninstall-projection-{}",
            uuid::Uuid::new_v4()
        ));
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = skillhub_root.join("skills");
        let skill_root = managed_root.join("sample");
        fs::create_dir_all(&skill_root).expect("create managed Skill");
        fs::write(skill_root.join("SKILL.md"), "# Managed\n").expect("write managed Skill");
        fs::write(
            skill_root.join(".skillhub.json"),
            r#"{"version":"1","skillhub":{"id":"sample","name":"sample","envDependencies":[]}}"#,
        )
        .expect("write Skill profile");

        let current = refresh_skill_projection_at(&skillhub_root, &managed_root, "sample")
            .expect("create generated projection");
        let agent_link = home.join(".codex/skills/sample");
        let agent_root = agent_link.parent().expect("Agent root");
        fs::create_dir_all(agent_root).expect("create Agent root");
        // #272: start from a pre-projection junction to the managed Skill and
        // migrate it; the replaced junction must not stay in the Agent root.
        unix_fs::symlink(&skill_root, &agent_link).expect("create pre-projection junction");
        super::migrate_agent_projection_link(&agent_link, &skill_root, &current, &skillhub_root)
            .expect("migrate Agent junction to the projection");
        assert_eq!(
            fs::read_dir(agent_root)
                .expect("read migrated Agent root")
                .count(),
            1
        );
        assert_eq!(
            managed_skill_agent_projection_state_at(
                &agent_link,
                &skillhub_root,
                &managed_root,
                "sample",
            )
            .expect("classify installed Agent junction"),
            ManagedSkillAgentProjectionState::Installed
        );

        uninstall_skill_projections(&home, &managed_root, "sample")
            .expect("uninstall generated Agent projection");

        assert!(fs::symlink_metadata(&agent_link).is_err());
        assert!(skill_root.join("SKILL.md").is_file());
        // #165/#272: no Agent-visible quarantine or old-link entry and no
        // staged residue.
        assert_eq!(
            fs::read_dir(agent_root).expect("read Agent root").count(),
            0
        );
        assert_eq!(
            fs::read_dir(skillhub_root.join("projection-unlink"))
                .map(|entries| entries.count())
                .unwrap_or(0),
            0
        );
        crate::platform_fs::remove_link(&current).expect("remove current junction");
        fs::remove_dir_all(home).expect("remove Windows uninstall fixture");
    }
}

#[cfg(all(test, unix))]
mod tests {
    #[test]
    fn avatar_identity_survives_profile_edits_and_managed_folder_rename() {
        let root = std::env::temp_dir().join(format!("skillhub-avatar-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test Skill");
        fs::write(root.join("SKILL.md"), "# Sources").expect("write source");
        let first = super::ensure_skill_avatar_identity_at(&root).expect("persist identity");
        let mut profile = super::read_current_profile_at_path(&root).expect("read profile");
        profile.display_name = Some("Renamed".into());
        profile.description = Some("Changed introduction".into());
        super::write_profile_at_path(&root, &profile).expect("write metadata");
        let renamed = root.with_extension("renamed");
        fs::rename(&root, &renamed).expect("rename managed folder");
        assert_eq!(
            super::ensure_skill_avatar_identity_at(&renamed).expect("reuse identity"),
            first
        );
        assert!(uuid::Uuid::parse_str(&first).is_ok());
        fs::remove_dir_all(renamed).expect("cleanup");
    }

    #[test]
    fn avatar_cache_paths_are_isolated_by_account_and_stable_identity() {
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        let id = uuid::Uuid::new_v4().to_string();
        assert_ne!(
            super::avatar_cache_path_at(std::path::Path::new("root"), &first, &id).unwrap(),
            super::avatar_cache_path_at(std::path::Path::new("root"), &second, &id).unwrap()
        );
        assert!(
            super::avatar_cache_path_at(std::path::Path::new("root"), "../other", &id).is_err()
        );
        assert!(
            super::avatar_cache_path_at(std::path::Path::new("root"), &first, "../../content")
                .is_err()
        );
    }

    use super::{
        acquisition_source_label, activate_staged_marketplace_package,
        activate_staged_marketplace_package_with_hook,
        activate_staged_marketplace_package_with_hooks, adopt_agent_sources_with,
        adoption_manifest_has_backup, agent_skill_directory_for_read,
        archive_captured_skill_env_files_at, build_import_preflight_at,
        build_install_preflight_for_targets, canonical_archive_file_mode, canonical_resource_names,
        collect_skill_tree, copy_bounded_zip_entry, copy_dir, create_skill_package_from_root,
        create_skill_snapshot_at_path, current_projection_at, delete_env_value_from_file,
        discover_skill_env_values, ensure_git_excludes, env_contents_has_key,
        extract_marketplace_package_to_stage, fingerprint_hex, finish_skill_edit_at,
        generated_skill_md, get_skill_working_diff_at, imported_asset_is_own,
        inspect_skill_markdown, install_prepared_symlink_atomically,
        install_skill_projections_with, is_symlink_to_path, isolate_and_unlink_owned_link,
        managed_recovery_is_restorable, merge_missing_env_values_from_file,
        migrate_agent_projection_link, normalize_import_account_binding, parse_skill_document,
        prepare_marketplace_replacement_backup, prepare_skill_edit_at, prepare_user_zip_at,
        profile_acquisition_source, profile_runtime_metadata, profile_team_ids,
        projection_injects_runtime_header, projection_marker_for_link_at, projection_root_at,
        read_recovery_manifest, read_skill_file_at, reconcile_skill_projection_at,
        recovery_id_segment, refresh_installed_projections_at, refresh_skill_projection_at,
        remove_owned_symlink_atomically, repair_system_manager_at,
        replace_canonical_skill_md_preserving_base, restore_adoption_item_at,
        restore_adoption_item_at_with_hook, restore_managed_item_at,
        restore_managed_trash_item_from_snapshot_at, restore_skill_version_at_path,
        retire_legacy_agent_projection_links_at,
        rollback_interrupted_marketplace_replacement_at_with_hook,
        rollback_marketplace_replacement_at, runtime_header, runtime_header_v2, runtime_header_v3,
        scan_unmanaged_agent_skills, set_env_value_in_file, sha256_hex, shell_quote, should_skip,
        skill_library_fingerprint_at, skill_tree_fingerprint, sweep_legacy_remove_links_at,
        uninstall_projection_links_with, uninstall_skill_projections,
        update_marketplace_replacement_manifest, validate_adoption_original_path,
        validate_marketplace_replacement_target, validate_preflight_confirmation,
        validate_skill_id, working_copy_state_for_path, write_private_file, write_profile_at_path,
        zip_entry_type_is_supported, LegacyLinkCounts, LegacyRemoveLinkSweep, SkillFilePreview,
        BASE64, ENV_ONLY_PROJECTION_HEADER_VERSION, INITIAL_SKILL_VERSION, LEGACY_OLD_LINK_PREFIX,
        LEGACY_REMOVE_LINK_PREFIX, MAX_INSPECTED_SKILL_MD_BYTES, MAX_PREVIEW_FILE_BYTES,
        MAX_SKILL_FILE_BYTES, MAX_ZIP_FILE_BYTES, PRIVATE_GIT_EXCLUDE_MARKER,
        PROJECTION_CONFLICT_NAME, PROJECTION_HEADER_VERSION, PROJECTION_MARKER_NAME,
        PROJECTION_UNLINK_DIR, SHELL_EXPORT_PROJECTION_HEADER_VERSION,
    };
    use crate::SkillHubProfile;
    use base64::Engine as _;
    use std::collections::HashSet;
    use std::fs;
    use std::io::{Cursor, Read};
    use std::os::unix::fs as unix_fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use walkdir::WalkDir;
    use zip::ZipArchive;

    struct ProjectionFixture {
        home: PathBuf,
        skillhub_root: PathBuf,
        managed_root: PathBuf,
        skill_root: PathBuf,
        current: PathBuf,
    }

    impl ProjectionFixture {
        fn generation(&self) -> PathBuf {
            fs::canonicalize(&self.current).expect("canonical projection generation")
        }

        fn projected_skill_md(&self) -> PathBuf {
            self.current.join("SKILL.md")
        }

        fn conflict(&self) -> PathBuf {
            projection_root_at(&self.skillhub_root, "sample").join(PROJECTION_CONFLICT_NAME)
        }

        fn cleanup(self) {
            fs::remove_dir_all(self.home).expect("remove projection fixture");
        }
    }

    fn projection_fixture(skill_md: &str, with_env: bool) -> ProjectionFixture {
        let home = std::env::temp_dir().join(format!(
            "skillhub-generated-projection-{}",
            uuid::Uuid::new_v4()
        ));
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = skillhub_root.join("skills");
        let skill_root = managed_root.join("sample");
        fs::create_dir_all(skill_root.join("scripts")).expect("create canonical Skill");
        fs::write(skill_root.join("SKILL.md"), skill_md).expect("write canonical SKILL.md");
        fs::write(skill_root.join("scripts/run.sh"), "#!/bin/sh\necho ok\n")
            .expect("write canonical resource");
        let dependencies = if with_env {
            r#"[{"key":"API_KEY","description":"test","required":true,"sharePolicy":"none","sharedTeams":[]}]"#
        } else {
            "[]"
        };
        fs::write(
            skill_root.join(".skillhub.json"),
            format!(
                r#"{{"version":"1","skillhub":{{"id":"sample","name":"sample","envDependencies":{dependencies}}}}}"#
            ),
        )
        .expect("write Skill profile");
        let current = refresh_skill_projection_at(&skillhub_root, &managed_root, "sample")
            .expect("create generated projection");
        ProjectionFixture {
            home,
            skillhub_root,
            managed_root,
            skill_root,
            current,
        }
    }

    /// The Agent-visible SKILL.md without the SkillHub runtime header, which
    /// every managed projection now carries (asserted here).
    fn projected_body(path: &Path) -> String {
        let text = fs::read_to_string(path).expect("read Agent projection");
        let start = text
            .find("<!-- SKILLHUB-RUNTIME-START v4 ")
            .expect("runtime header present");
        let end_marker = text
            .find("<!-- SKILLHUB-RUNTIME-END v4 ")
            .expect("runtime header end present");
        let end = end_marker + text[end_marker..].find("-->").expect("header end") + 3;
        let rest = text[end..].strip_prefix("\n\n").unwrap_or(&text[end..]);
        format!("{}{}", &text[..start], rest)
    }

    fn marketplace_projection_fixture(
        current_skill_md: &str,
        candidate_skill_md: &str,
    ) -> (ProjectionFixture, PathBuf, PathBuf) {
        let fixture = projection_fixture(current_skill_md, false);
        let profile = crate::SkillHubProfile {
            server_id: Some("server-a".into()),
            acquisition_source: Some(crate::AcquisitionSource::Marketplace),
            name: Some("sample".into()),
            display_name: Some("Sample".into()),
            ..Default::default()
        };
        write_profile_at_path(&fixture.skill_root, &profile)
            .expect("write current Marketplace profile");
        fs::set_permissions(
            fixture.skill_root.join("scripts/run.sh"),
            fs::Permissions::from_mode(0o755),
        )
        .expect("make current Marketplace script executable");
        create_skill_snapshot_at_path(&fixture.skill_root, "v1.0.0 · Marketplace")
            .expect("snapshot current Marketplace Skill");

        let stage = fixture.managed_root.join(".stage-approved");
        fs::create_dir_all(stage.join("scripts")).expect("create Marketplace stage");
        fs::write(stage.join("SKILL.md"), candidate_skill_md)
            .expect("write approved Marketplace SKILL.md");
        fs::write(stage.join("scripts/run.sh"), "#!/bin/sh\necho approved\n")
            .expect("write approved Marketplace resource");
        fs::set_permissions(
            stage.join("scripts/run.sh"),
            fs::Permissions::from_mode(0o755),
        )
        .expect("make approved Marketplace script executable");
        write_profile_at_path(&stage, &profile).expect("write approved Marketplace profile");
        create_skill_snapshot_at_path(&stage, "v2.0.0 · Marketplace")
            .expect("snapshot approved Marketplace Skill");

        let agent_link = fixture.home.join(".codex/skills/sample");
        fs::create_dir_all(agent_link.parent().expect("Agent link parent"))
            .expect("create Agent Skill directory");
        unix_fs::symlink(&fixture.current, &agent_link)
            .expect("install real generated Agent projection");
        (fixture, stage, agent_link)
    }

    fn managed_recovery_id(transaction: &Path) -> String {
        format!(
            "managed:{}",
            transaction
                .file_name()
                .expect("recovery segment")
                .to_string_lossy()
        )
    }

    #[test]
    fn rejects_path_traversal_skill_ids() {
        assert!(validate_skill_id("../escape").is_err());
        assert!(validate_skill_id("folder/name").is_err());
        assert!(validate_skill_id(".").is_err());
    }

    #[test]
    fn accepts_portable_skill_ids() {
        assert!(validate_skill_id("humanizer-zh").is_ok());
        assert!(validate_skill_id("skill_creator.v2").is_ok());
    }

    #[test]
    fn legacy_generic_agent_identity_is_read_only_resolvable() {
        assert_eq!(
            agent_skill_directory_for_read("agent-skills"),
            Some(".agents/skills")
        );
        assert_eq!(agent_skill_directory_for_read("unknown-agent"), None);
        assert!(!crate::known_agents()
            .iter()
            .any(|(key, _, _)| *key == "agent-skills"));
    }

    #[test]
    fn profile_runtime_metadata_survives_local_profile_readback() {
        let profile = crate::SkillHubProfile {
            trigger_scenarios: vec!["发布前验收".into(), "检查投影".into()],
            compatible_agents: vec!["codex".into(), "claude".into()],
            ..Default::default()
        };

        let (trigger, scenarios, compatible_agents) = profile_runtime_metadata(&profile);
        assert_eq!(trigger.as_deref(), Some("发布前验收、检查投影"));
        assert_eq!(scenarios, profile.trigger_scenarios);
        assert_eq!(compatible_agents, profile.compatible_agents);
    }

    #[test]
    fn profile_source_url_update_distinguishes_omitted_null_and_value() {
        let parse = |value: serde_json::Value| -> crate::SkillProfileUpdateInput {
            serde_json::from_value(value).expect("deserialize profile update")
        };
        let base =
            serde_json::json!({ "labels": [], "triggerScenarios": [], "compatibleAgents": [] });
        assert_eq!(parse(base.clone()).source_url, None, "omitted keeps");
        let mut cleared = base.clone();
        cleared["sourceUrl"] = serde_json::Value::Null;
        assert_eq!(parse(cleared).source_url, Some(None), "null clears");
        let mut set = base;
        set["sourceUrl"] = "https://x.com/acme".into();
        assert_eq!(
            parse(set).source_url,
            Some(Some("https://x.com/acme".into()))
        );
    }

    #[test]
    fn profile_source_url_validation_mirrors_the_server() {
        assert_eq!(
            crate::validate_source_url("  https://github.com/acme/demo/tree/main/skills  "),
            Ok(Some("https://github.com/acme/demo/tree/main/skills".into()))
        );
        assert_eq!(
            crate::validate_source_url("HTTP://Example.com"),
            Ok(Some("HTTP://Example.com".into()))
        );
        assert_eq!(crate::validate_source_url("   "), Ok(None));
        for invalid in [
            "javascript:alert(1)",
            "data:text/html,hi",
            "ftp://example.com/",
            "example.com/path",
            "https://user:pw@example.com/",
            "https://user@example.com/",
            "https://exa mple.com/",
            "https://example.com/<script>",
            "https://example.com\\evil",
            "http://",
        ] {
            assert!(crate::validate_source_url(invalid).is_err(), "{invalid}");
        }
        let at_limit = format!("https://e.com/{}", "a".repeat(2048 - 14));
        assert_eq!(at_limit.len(), 2048);
        assert!(crate::validate_source_url(&at_limit).is_ok());
        assert!(crate::validate_source_url(&format!("{at_limit}a")).is_err());
        assert_eq!(
            crate::sanitize_source_url(Some("javascript:alert(1)")),
            None
        );
        assert_eq!(crate::sanitize_source_url(None), None);
    }

    #[test]
    fn profile_source_url_round_trips_and_legacy_sidecars_have_none() {
        let legacy: crate::SkillHubJson = serde_json::from_value(serde_json::json!({
            "version": "1",
            "skillhub": { "displayName": "Old" }
        }))
        .expect("parse legacy sidecar");
        assert_eq!(legacy.skillhub.expect("profile").source_url, None);
        let absent = serde_json::to_value(crate::SkillHubProfile::default()).unwrap();
        assert!(
            absent.get("sourceUrlCleared").is_none(),
            "no tombstone unless the user cleared"
        );
        let cleared = serde_json::to_value(crate::SkillHubProfile {
            source_url_cleared: Some("https://x.com/acme".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(cleared["sourceUrlCleared"], "https://x.com/acme");
        // A boolean from a pre-release build is an unknown tombstone.
        for legacy in [
            serde_json::json!(true),
            serde_json::json!(false),
            serde_json::json!(1),
        ] {
            let parsed: crate::SkillHubJson = serde_json::from_value(serde_json::json!({
                "version": "1",
                "skillhub": { "sourceUrlCleared": legacy }
            }))
            .expect("parse dev-build tombstone");
            assert_eq!(parsed.skillhub.unwrap().source_url_cleared, None);
        }
        assert!(
            absent.get("sourceUrl").is_none(),
            "no empty field in old-style sidecars"
        );

        let root = std::env::temp_dir().join(format!(
            "skillhub-profile-source-url-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create profile root");
        let profile = crate::SkillHubProfile {
            source_url: Some("https://clawhub.ai/acme/demo".into()),
            ..Default::default()
        };
        write_profile_at_path(&root, &profile).expect("persist profile");
        let stored: crate::SkillHubJson = serde_json::from_str(
            &fs::read_to_string(root.join(".skillhub.json")).expect("read stored profile"),
        )
        .expect("parse stored profile");
        let stored = stored.skillhub.expect("stored SkillHub profile");
        assert_eq!(stored.source_url, profile.source_url);
        fs::remove_dir_all(root).expect("remove profile root");

        let import: crate::ImportSkillPackageInput = serde_json::from_value(serde_json::json!({
            "skillId": "sample--remote",
            "packageBase64": "AA==",
            "expectedSha256": "digest",
            "serverId": "remote-id",
            "serverOwnerId": "owner-id",
            "displayName": "Sample",
            "sourceUrl": "https://skillsmp.com/skills/demo",
            "labels": [],
            "version": "v1.0.0",
            "isOwn": false
        }))
        .expect("deserialize import payload");
        assert_eq!(
            import.source_url.as_deref(),
            Some("https://skillsmp.com/skills/demo")
        );
    }

    #[test]
    fn imported_team_metadata_round_trips_and_legacy_payloads_default_safely() {
        let legacy: crate::ImportSkillPackageInput = serde_json::from_value(serde_json::json!({
            "skillId": "sample--remote",
            "packageBase64": "AA==",
            "expectedSha256": "digest",
            "serverId": "remote-id",
            "serverOwnerId": "owner-id",
            "displayName": "Sample",
            "labels": [],
            "version": "v1.0.0",
            "isOwn": false
        }))
        .expect("deserialize old import payload");
        assert!(legacy.team_ids.is_empty());
        assert_eq!(legacy.install_count, 0);
        assert!(legacy.created_at.is_none());
        assert!(legacy.trigger_scenarios.is_empty());
        assert!(legacy.env_dependencies.is_empty());
        assert!(legacy.acquisition_source.is_none());
        assert!(legacy.acquired_by_user_id.is_none());
        assert!(legacy.source_url.is_none());
        assert!(!legacy.replace_existing_marketplace);

        let root = std::env::temp_dir().join(format!(
            "skillhub-profile-team-metadata-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create profile root");
        let profile = crate::SkillHubProfile {
            teams: vec!["legacy-team".into()],
            team_ids: vec!["team-a".into(), "legacy-team".into()],
            install_count: 42,
            created_at: Some("2026-08-01T00:00:00.000Z".into()),
            updated_at: Some("2026-08-03T00:00:00.000Z".into()),
            trigger_scenarios: vec!["需要发布检查时".into()],
            compatible_agents: vec!["codex".into(), "claude".into()],
            env_dependencies: vec![crate::EnvDepRaw {
                key: "API_KEY".into(),
                description: Some("服务凭证".into()),
                required: true,
                share_policy: "team".into(),
                shared_teams: vec!["team-a".into()],
                origin: None,
                confidence: None,
                obtain: None,
                pending: None,
            }],
            ..Default::default()
        };
        write_profile_at_path(&root, &profile).expect("persist profile metadata");
        let stored: crate::SkillHubJson = serde_json::from_str(
            &fs::read_to_string(root.join(".skillhub.json")).expect("read stored profile"),
        )
        .expect("parse stored profile");
        let stored = stored.skillhub.expect("stored SkillHub profile");
        assert_eq!(profile_team_ids(&stored), vec!["team-a", "legacy-team"]);
        assert_eq!(stored.install_count, 42);
        assert_eq!(stored.created_at, profile.created_at);
        assert_eq!(stored.updated_at, profile.updated_at);
        assert_eq!(stored.trigger_scenarios, profile.trigger_scenarios);
        assert_eq!(stored.compatible_agents, profile.compatible_agents);
        assert_eq!(stored.env_dependencies.len(), 1);
        fs::remove_dir_all(root).expect("remove profile root");
    }

    #[test]
    fn import_account_binding_is_team_only_and_requires_a_uuid() {
        let user_id = "22222222-2222-4222-8222-222222222222";
        assert_eq!(
            normalize_import_account_binding(crate::AcquisitionSource::Team, Some(user_id)),
            Ok(Some(user_id.into()))
        );
        assert!(normalize_import_account_binding(crate::AcquisitionSource::Team, None).is_err());
        assert!(normalize_import_account_binding(
            crate::AcquisitionSource::Team,
            Some("not-a-user-id")
        )
        .is_err());
        assert!(
            normalize_import_account_binding(crate::AcquisitionSource::Local, Some(user_id))
                .is_err()
        );
        assert!(normalize_import_account_binding(
            crate::AcquisitionSource::Marketplace,
            Some(user_id)
        )
        .is_err());
        assert_eq!(
            normalize_import_account_binding(crate::AcquisitionSource::Marketplace, None),
            Ok(None)
        );
    }

    #[test]
    fn acquisition_source_is_explicit_and_legacy_team_profiles_remain_compatible() {
        let local = crate::SkillHubProfile::default();
        assert_eq!(
            profile_acquisition_source(&local),
            crate::AcquisitionSource::Local
        );

        let legacy_team = crate::SkillHubProfile {
            is_own: Some(false),
            team_shared_from: Some("team-a".into()),
            ..Default::default()
        };
        assert_eq!(
            profile_acquisition_source(&legacy_team),
            crate::AcquisitionSource::Team
        );

        let marketplace = crate::SkillHubProfile {
            is_own: Some(false),
            acquisition_source: Some(crate::AcquisitionSource::Marketplace),
            ..Default::default()
        };
        assert_eq!(
            profile_acquisition_source(&marketplace),
            crate::AcquisitionSource::Marketplace
        );

        let root = std::env::temp_dir().join(format!(
            "skillhub-acquisition-source-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create acquisition profile root");
        write_profile_at_path(&root, &marketplace).expect("persist Marketplace source");
        let raw =
            fs::read_to_string(root.join(".skillhub.json")).expect("read Marketplace profile");
        assert!(raw.contains(r#""acquisitionSource": "marketplace""#));
        fs::remove_dir_all(root).expect("remove acquisition profile root");

        let explicit: crate::ImportSkillPackageInput = serde_json::from_value(serde_json::json!({
            "skillId": "sample--market",
            "packageBase64": "AA==",
            "expectedSha256": "digest",
            "serverId": "remote-id",
            "serverOwnerId": "owner-id",
            "displayName": "Sample",
            "labels": [],
            "version": "v1.0.0",
            "isOwn": false,
            "acquisitionSource": "marketplace"
        }))
        .expect("deserialize Marketplace import payload");
        assert_eq!(
            explicit.acquisition_source,
            Some(crate::AcquisitionSource::Marketplace)
        );
        assert!(imported_asset_is_own(true));
        assert!(!imported_asset_is_own(false));
        assert_eq!(
            acquisition_source_label(crate::AcquisitionSource::Marketplace),
            "Skill 商店"
        );
        assert_eq!(
            acquisition_source_label(crate::AcquisitionSource::Team),
            "团队共享"
        );
    }

    #[test]
    fn catalog_acquisition_version_survives_local_version_initialization() {
        let home = std::env::temp_dir().join(format!("catalog-version-{}", uuid::Uuid::new_v4()));
        let root = home.join(".skillhub/skills/demo");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("SKILL.md"), "# Catalog").unwrap();
        git2::Repository::init(&root).unwrap();
        let mut profile = crate::SkillHubProfile {
            catalog_origin: Some(crate::catalog::origin().unwrap()),
            acquisition_version: Some("1.2.3".into()),
            version: "1.2.3".into(),
            is_own: Some(false),
            acquisition_source: Some(crate::AcquisitionSource::Marketplace),
            ..Default::default()
        };
        super::write_profile_at_path(&root, &profile).unwrap();
        super::create_skill_snapshot_at_path(&root, "import").unwrap();
        super::ensure_current_local_version_at(&root, &mut profile).unwrap();
        assert_eq!(profile.acquisition_version.as_deref(), Some("1.2.3"));
        assert!(!super::promote_profile_to_personal(&mut profile));
        assert_eq!(profile.is_own, Some(false));
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn marketplace_replacement_requires_explicit_matching_server_provenance() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-marketplace-replacement-guard-{}",
            uuid::Uuid::new_v4()
        ));
        let destination = root.join("skills/sample");
        fs::create_dir_all(&destination).expect("create existing managed Skill");
        write_profile_at_path(
            &destination,
            &crate::SkillHubProfile {
                server_id: Some("server-a".into()),
                ..Default::default()
            },
        )
        .expect("write existing profile");

        assert!(validate_marketplace_replacement_target(
            &destination,
            "server-a",
            crate::AcquisitionSource::Marketplace,
            None,
            false,
        )
        .is_err());
        assert!(validate_marketplace_replacement_target(
            &destination,
            "server-a",
            crate::AcquisitionSource::Team,
            Some("22222222-2222-4222-8222-222222222222"),
            true,
        )
        .is_err());
        assert!(validate_marketplace_replacement_target(
            &destination,
            "server-b",
            crate::AcquisitionSource::Marketplace,
            None,
            true,
        )
        .is_err());
        assert!(validate_marketplace_replacement_target(
            &destination,
            "server-a",
            crate::AcquisitionSource::Marketplace,
            None,
            true,
        )
        .expect("matching Marketplace replacement should be allowed"));

        write_profile_at_path(
            &destination,
            &crate::SkillHubProfile {
                server_id: Some("server-a".into()),
                acquisition_source: Some(crate::AcquisitionSource::Team),
                acquired_by_user_id: Some("22222222-2222-4222-8222-222222222222".into()),
                ..Default::default()
            },
        )
        .expect("write account-bound Team profile");
        assert!(validate_marketplace_replacement_target(
            &destination,
            "server-a",
            crate::AcquisitionSource::Team,
            Some("33333333-3333-4333-8333-333333333333"),
            true,
        )
        .is_err());
        assert!(validate_marketplace_replacement_target(
            &destination,
            "server-a",
            crate::AcquisitionSource::Team,
            Some("22222222-2222-4222-8222-222222222222"),
            true,
        )
        .expect("same-account Team replacement should be allowed"));
        let legacy_team = crate::SkillHubProfile {
            server_id: Some("server-a".into()),
            acquisition_source: Some(crate::AcquisitionSource::Team),
            ..Default::default()
        };
        write_profile_at_path(&destination, &legacy_team).expect("write legacy Team profile");
        assert!(validate_marketplace_replacement_target(
            &destination,
            "server-a",
            crate::AcquisitionSource::Team,
            Some("22222222-2222-4222-8222-222222222222"),
            true,
        )
        .is_err());
        fs::remove_dir_all(root).expect("remove replacement guard fixture");
    }

    #[test]
    fn marketplace_replacement_rebases_real_projection_and_switches_both_directions() {
        let (fixture, stage, agent_link) = marketplace_projection_fixture("old", "approved");
        let original_generation = fixture.generation();
        write_private_file(
            &fixture.skill_root.join(".env"),
            "LOCAL_TOKEN=fixture-only\n",
        )
        .expect("write local config");
        let recovery_id = activate_staged_marketplace_package(
            &fixture.home,
            &fixture.skillhub_root,
            &stage,
            &fixture.skill_root,
            "sample",
            "Sample",
            true,
        )
        .expect("activate approved package")
        .expect("replacement recovery id");
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join(".env")).unwrap(),
            "LOCAL_TOKEN=fixture-only\n"
        );
        assert!(!agent_link.join(".env").exists());
        let approved_generation = fixture.generation();
        assert_ne!(approved_generation, original_generation);
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md"))
                .expect("read approved canonical Skill"),
            "approved"
        );
        assert_eq!(projected_body(&agent_link.join("SKILL.md")), "approved");
        assert_eq!(
            fs::metadata(agent_link.join("scripts/run.sh"))
                .expect("read approved projected script metadata")
                .permissions()
                .mode()
                & 0o777,
            0o755
        );

        rollback_marketplace_replacement_at(
            &fixture.home,
            &fixture.skillhub_root,
            &fixture.managed_root,
            &recovery_id,
        )
        .expect("switch to recovered old version through Settings path");
        assert_eq!(projected_body(&agent_link.join("SKILL.md")), "old");
        assert_eq!(
            fs::metadata(agent_link.join("scripts/run.sh"))
                .expect("read restored projected script metadata")
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        let approved_recovery = fs::read_dir(fixture.skillhub_root.join("trash"))
            .expect("read retained approved recovery")
            .flatten()
            .find(|entry| {
                fs::read_to_string(entry.path().join("skill/SKILL.md"))
                    .is_ok_and(|contents| contents == "approved")
            })
            .expect("approved version remains recoverable");
        let approved_recovery_id = format!(
            "managed:{}",
            approved_recovery.file_name().to_string_lossy()
        );
        rollback_marketplace_replacement_at(
            &fixture.home,
            &fixture.skillhub_root,
            &fixture.managed_root,
            &approved_recovery_id,
        )
        .expect("switch back to approved version through Settings path");
        assert_eq!(projected_body(&agent_link.join("SKILL.md")), "approved");
        assert_eq!(
            fs::metadata(agent_link.join("scripts/run.sh"))
                .expect("read reactivated projected script metadata")
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        assert!(is_symlink_to_path(&agent_link, &fixture.current));
        fixture.cleanup();
    }

    #[test]
    fn marketplace_replacement_rejects_edited_projection_without_moving_canonical() {
        let (fixture, stage, agent_link) = marketplace_projection_fixture("old", "approved");
        let original_generation = fixture.generation();
        fs::write(fixture.projected_skill_md(), "user edited projection")
            .expect("edit generated projection");

        let error = activate_staged_marketplace_package(
            &fixture.home,
            &fixture.skillhub_root,
            &stage,
            &fixture.skill_root,
            "sample",
            "Sample",
            true,
        )
        .expect_err("edited projection must stop replacement");
        assert!(error.contains("已被修改"));
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md")).expect("read old canonical"),
            "old"
        );
        assert_eq!(fixture.generation(), original_generation);
        assert!(stage.is_dir());
        assert!(is_symlink_to_path(&agent_link, &fixture.current));
        fixture.cleanup();
    }

    #[test]
    fn marketplace_replacement_link_race_fails_closed_without_overwriting_racer() {
        let (fixture, stage, agent_link) = marketplace_projection_fixture("old", "approved");
        let original_generation = fixture.generation();
        let foreign = fixture.home.join("foreign-skill");
        fs::create_dir(&foreign).expect("create foreign Skill");
        fs::write(foreign.join("SKILL.md"), "foreign").expect("write foreign Skill");

        let error = activate_staged_marketplace_package_with_hook(
            &fixture.home,
            &fixture.skillhub_root,
            &stage,
            &fixture.skill_root,
            "sample",
            "Sample",
            true,
            || {
                fs::remove_file(&agent_link).expect("replace Agent link during guard window");
                unix_fs::symlink(&foreign, &agent_link).expect("install racing foreign link");
            },
        )
        .expect_err("Agent link race must stop replacement");
        assert!(error.contains("发生变化"));
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md")).expect("read old canonical"),
            "old"
        );
        assert_eq!(fixture.generation(), original_generation);
        assert!(stage.is_dir());
        assert!(is_symlink_to_path(&agent_link, &foreign));
        fixture.cleanup();
    }

    #[test]
    fn marketplace_post_projection_failure_rolls_back_canonical_and_current_together() {
        let (fixture, stage, agent_link) = marketplace_projection_fixture("old", "approved");
        let original_generation = fixture.generation();

        let error = activate_staged_marketplace_package_with_hooks(
            &fixture.home,
            &fixture.skillhub_root,
            &stage,
            &fixture.skill_root,
            "sample",
            "Sample",
            true,
            || {},
            || Err("injected post-switch failure".into()),
            None,
        )
        .expect_err("post-switch failure must roll back the complete pair");
        assert!(error.contains("已恢复原 Skill 与 Agent 投影"));
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md"))
                .expect("read rolled back canonical"),
            "old"
        );
        assert_eq!(fixture.generation(), original_generation);
        assert_eq!(projected_body(&agent_link.join("SKILL.md")), "old");
        assert!(stage.is_dir());
        assert!(fs::read_dir(fixture.skillhub_root.join("trash"))
            .expect("read empty rollback trash")
            .next()
            .is_none());
        fixture.cleanup();
    }

    #[test]
    fn marketplace_recovery_infers_old_move_when_manifest_phase_is_stale_and_is_idempotent() {
        let (fixture, _stage, agent_link) = marketplace_projection_fixture("old", "approved");
        let original_generation = fixture.generation();
        let recovery =
            prepare_marketplace_replacement_backup(&fixture.skillhub_root, "sample", "Sample")
                .expect("prepare interrupted recovery");
        fs::rename(&fixture.skill_root, recovery.join("skill"))
            .expect("simulate canonical move before phase write");
        let recovery_id = managed_recovery_id(&recovery);

        rollback_marketplace_replacement_at(
            &fixture.home,
            &fixture.skillhub_root,
            &fixture.managed_root,
            &recovery_id,
        )
        .expect("recover from disk state even though manifest still says prepared");
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md"))
                .expect("read restored canonical"),
            "old"
        );
        assert_eq!(fixture.generation(), original_generation);
        assert_eq!(projected_body(&agent_link.join("SKILL.md")), "old");
        let manifest = read_recovery_manifest(&recovery.join("recovery-manifest.json"))
            .expect("read restored recovery manifest");
        assert_eq!(
            manifest.get("status").and_then(serde_json::Value::as_str),
            Some("restored")
        );
        assert_eq!(
            manifest.get("phase").and_then(serde_json::Value::as_str),
            Some("complete")
        );

        rollback_marketplace_replacement_at(
            &fixture.home,
            &fixture.skillhub_root,
            &fixture.managed_root,
            &recovery_id,
        )
        .expect("repeated completed recovery is idempotent");
        assert_eq!(projected_body(&agent_link.join("SKILL.md")), "old");
        fixture.cleanup();
    }

    #[test]
    fn marketplace_recovery_ignores_phase_written_before_canonical_move() {
        let (fixture, _stage, agent_link) = marketplace_projection_fixture("old", "approved");
        let original_generation = fixture.generation();
        let recovery =
            prepare_marketplace_replacement_backup(&fixture.skillhub_root, "sample", "Sample")
                .expect("prepare recovery manifest");
        update_marketplace_replacement_manifest(
            &recovery.join("recovery-manifest.json"),
            "in_progress",
            "old_moved",
        )
        .expect("write phase before simulated rename");

        let error = rollback_marketplace_replacement_at(
            &fixture.home,
            &fixture.skillhub_root,
            &fixture.managed_root,
            &managed_recovery_id(&recovery),
        )
        .expect_err("phase alone must not authorize a filesystem move");
        assert!(error.contains("待恢复的商店 Skill"));
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md"))
                .expect("read untouched canonical"),
            "old"
        );
        assert_eq!(fixture.generation(), original_generation);
        assert_eq!(projected_body(&agent_link.join("SKILL.md")), "old");
        assert!(!recovery.join("skill").exists());
        fixture.cleanup();
    }

    #[test]
    fn marketplace_candidate_activated_crash_recovers_pair_and_startup_skips_reconcile() {
        let (fixture, stage, agent_link) = marketplace_projection_fixture("old", "approved");
        let original_generation = fixture.generation();
        let recovery =
            prepare_marketplace_replacement_backup(&fixture.skillhub_root, "sample", "Sample")
                .expect("prepare interrupted replacement");
        fs::rename(&fixture.skill_root, recovery.join("skill"))
            .expect("move old canonical into recovery");
        update_marketplace_replacement_manifest(
            &recovery.join("recovery-manifest.json"),
            "in_progress",
            "old_moved",
        )
        .expect("record old move");
        fs::rename(&stage, &fixture.skill_root).expect("activate candidate canonical");
        assert_eq!(
            read_recovery_manifest(&recovery.join("recovery-manifest.json"))
                .expect("read lagging replacement phase")
                .get("phase")
                .and_then(serde_json::Value::as_str),
            Some("old_moved")
        );
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md"))
                .expect("read candidate canonical"),
            "approved"
        );
        assert_eq!(projected_body(&agent_link.join("SKILL.md")), "old");

        refresh_installed_projections_at(
            &fixture.home,
            &fixture.skillhub_root,
            &fixture.managed_root,
        )
        .expect("startup projection refresh skips interrupted Marketplace pair");
        assert_eq!(fixture.generation(), original_generation);

        let recovery_id = managed_recovery_id(&recovery);
        rollback_marketplace_replacement_at(
            &fixture.home,
            &fixture.skillhub_root,
            &fixture.managed_root,
            &recovery_id,
        )
        .expect("recover candidate-activated crash from marker and disk state");
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md"))
                .expect("read recovered old canonical"),
            "old"
        );
        assert_eq!(fixture.generation(), original_generation);
        assert_eq!(projected_body(&agent_link.join("SKILL.md")), "old");
        let approved_recovery = fs::read_dir(fixture.skillhub_root.join("trash"))
            .expect("read retained candidate recovery")
            .flatten()
            .find(|entry| {
                fs::read_to_string(entry.path().join("skill/SKILL.md"))
                    .is_ok_and(|contents| contents == "approved")
            })
            .expect("candidate remains recoverable after interrupted rollback");
        let candidate_manifest =
            read_recovery_manifest(&approved_recovery.path().join("recovery-manifest.json"))
                .expect("read candidate recovery manifest");
        assert_eq!(
            candidate_manifest
                .get("status")
                .and_then(serde_json::Value::as_str),
            Some("trashed")
        );

        rollback_marketplace_replacement_at(
            &fixture.home,
            &fixture.skillhub_root,
            &fixture.managed_root,
            &recovery_id,
        )
        .expect("candidate-activated recovery remains idempotent");
        fixture.cleanup();
    }

    #[test]
    fn marketplace_interrupted_manifest_failure_keeps_matching_pair_and_safe_recovery_choices() {
        let (fixture, stage, agent_link) = marketplace_projection_fixture("old", "approved");
        let original_generation = fixture.generation();
        let recovery =
            prepare_marketplace_replacement_backup(&fixture.skillhub_root, "sample", "Sample")
                .expect("prepare interrupted replacement");
        let manifest_path = recovery.join("recovery-manifest.json");
        fs::rename(&fixture.skill_root, recovery.join("skill"))
            .expect("move old canonical into recovery");
        fs::rename(&stage, &fixture.skill_root).expect("activate candidate canonical");
        update_marketplace_replacement_manifest(
            &manifest_path,
            "in_progress",
            "candidate_activated",
        )
        .expect("record interrupted candidate state");

        let error = rollback_interrupted_marketplace_replacement_at_with_hook(
            &fixture.home,
            &fixture.skillhub_root,
            &fixture.managed_root,
            &recovery,
            &manifest_path,
            &fixture.skill_root,
            &recovery.join("skill"),
            "sample",
            "Sample",
            || Err("injected old-manifest finalize failure".into()),
        )
        .expect_err("manifest finalization failure must remain visible");
        assert!(error.contains("未反向移动"));
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md"))
                .expect("read consistent old canonical"),
            "old"
        );
        assert_eq!(fixture.generation(), original_generation);
        assert_eq!(projected_body(&agent_link.join("SKILL.md")), "old");

        let candidate_recovery = fs::read_dir(fixture.skillhub_root.join("trash"))
            .expect("read recovery transactions")
            .flatten()
            .find(|entry| {
                fs::read_to_string(entry.path().join("skill/SKILL.md"))
                    .is_ok_and(|contents| contents == "approved")
            })
            .expect("candidate recovery retained after manifest failure");
        let candidate_manifest_path = candidate_recovery.path().join("recovery-manifest.json");
        let candidate_manifest = read_recovery_manifest(&candidate_manifest_path)
            .expect("read finalized candidate manifest");
        let old_manifest =
            read_recovery_manifest(&manifest_path).expect("read unfinished old manifest");
        assert_eq!(
            candidate_manifest
                .get("status")
                .and_then(serde_json::Value::as_str),
            Some("trashed")
        );
        assert_eq!(
            old_manifest
                .get("status")
                .and_then(serde_json::Value::as_str),
            Some("in_progress")
        );
        assert!(!managed_recovery_is_restorable(
            &recovery,
            "in_progress",
            Some("marketplace_version_replacement")
        ));
        assert!(managed_recovery_is_restorable(
            &candidate_recovery.path(),
            "trashed",
            Some("marketplace_version_replacement")
        ));

        let canonical_before = skill_tree_fingerprint(&fixture.skill_root)
            .expect("fingerprint consistent canonical before repeated call");
        let candidate_before = skill_tree_fingerprint(&candidate_recovery.path().join("skill"))
            .expect("fingerprint candidate recovery before repeated call");
        rollback_marketplace_replacement_at(
            &fixture.home,
            &fixture.skillhub_root,
            &fixture.managed_root,
            &managed_recovery_id(&recovery),
        )
        .expect_err("unfinished old record without recovery payload remains non-actionable");
        assert_eq!(
            skill_tree_fingerprint(&fixture.skill_root)
                .expect("fingerprint canonical after repeated call"),
            canonical_before
        );
        assert_eq!(
            skill_tree_fingerprint(&candidate_recovery.path().join("skill"))
                .expect("fingerprint candidate after repeated call"),
            candidate_before
        );
        assert_eq!(projected_body(&agent_link.join("SKILL.md")), "old");
        fixture.cleanup();
    }

    #[test]
    fn marketplace_interrupted_recovery_fails_closed_when_marker_matches_neither_version() {
        let (fixture, stage, agent_link) = marketplace_projection_fixture("old", "approved");
        let recovery =
            prepare_marketplace_replacement_backup(&fixture.skillhub_root, "sample", "Sample")
                .expect("prepare interrupted replacement");
        fs::rename(&fixture.skill_root, recovery.join("skill"))
            .expect("move old canonical into recovery");
        fs::rename(&stage, &fixture.skill_root).expect("activate candidate canonical");
        let marker_path = fixture.generation().join(PROJECTION_MARKER_NAME);
        let mut marker: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(&marker_path).expect("read projection marker"),
        )
        .expect("parse projection marker");
        marker["canonicalSkillMdSha256"] = serde_json::Value::String("1".repeat(64));
        write_private_file(
            &marker_path,
            &serde_json::to_string(&marker).expect("serialize mismatched marker"),
        )
        .expect("write structurally valid mismatched marker");
        let canonical_before = skill_tree_fingerprint(&fixture.skill_root)
            .expect("fingerprint candidate before failed recovery");
        let recovered_before = skill_tree_fingerprint(&recovery.join("skill"))
            .expect("fingerprint recovery before failed recovery");

        let error = rollback_marketplace_replacement_at(
            &fixture.home,
            &fixture.skillhub_root,
            &fixture.managed_root,
            &managed_recovery_id(&recovery),
        )
        .expect_err("unrelated marker must fail closed");
        assert!(error.contains("互不匹配"));
        assert_eq!(
            skill_tree_fingerprint(&fixture.skill_root)
                .expect("fingerprint untouched candidate after failure"),
            canonical_before
        );
        assert_eq!(
            skill_tree_fingerprint(&recovery.join("skill"))
                .expect("fingerprint untouched recovery after failure"),
            recovered_before
        );
        assert!(is_symlink_to_path(&agent_link, &fixture.current));
        assert_eq!(
            fs::read_dir(fixture.skillhub_root.join("trash"))
                .expect("read unchanged recovery root")
                .count(),
            1
        );
        fixture.cleanup();
    }

    #[test]
    fn marketplace_recovery_restores_old_version_when_no_active_candidate_exists() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-marketplace-missing-candidate-{}",
            uuid::Uuid::new_v4()
        ));
        let managed_root = root.join("skills");
        fs::create_dir_all(&managed_root).expect("create managed root");
        let recovery = prepare_marketplace_replacement_backup(&root, "sample", "Sample")
            .expect("prepare interrupted replacement recovery");
        let recovered_skill = recovery.join("skill");
        fs::create_dir(&recovered_skill).expect("create recovered Skill");
        fs::write(recovered_skill.join("SKILL.md"), "old").expect("write recovered Skill");
        write_profile_at_path(
            &recovered_skill,
            &crate::SkillHubProfile {
                server_id: Some("server-a".into()),
                acquisition_source: Some(crate::AcquisitionSource::Marketplace),
                ..Default::default()
            },
        )
        .expect("write recovered profile");
        let recovery_id = format!(
            "managed:{}",
            recovery
                .file_name()
                .expect("recovery segment")
                .to_string_lossy()
        );

        rollback_marketplace_replacement_at(&root, &root, &managed_root, &recovery_id)
            .expect("restore old version without an active candidate");

        assert_eq!(
            fs::read_to_string(managed_root.join("sample/SKILL.md"))
                .expect("read directly restored Skill"),
            "old"
        );
        assert_eq!(
            read_recovery_manifest(&recovery.join("recovery-manifest.json"))
                .expect("read completed recovery manifest")
                .get("status")
                .and_then(serde_json::Value::as_str),
            Some("restored")
        );
        fs::remove_dir_all(root).expect("remove missing-candidate fixture");
    }

    #[test]
    fn every_adoption_requires_exact_plan_and_conflicts_require_replace_consent() {
        let source = crate::ImportSkillSource {
            agent_key: "codex".into(),
            agent_name: "Codex".into(),
            entry_name: "sample".into(),
            path: "/tmp/sample".into(),
            canonical_path: "/tmp/sample".into(),
            fingerprint: "fingerprint".into(),
            matches_selected: true,
            selected: false,
        };
        let mut plan = crate::ImportSkillPreflight {
            skill_id: "sample".into(),
            selected_path: "/tmp/source".into(),
            selected_fingerprint: "fingerprint".into(),
            sources: vec![source],
            has_conflicts: false,
            plan_digest: "confirmed-plan".into(),
        };
        assert!(validate_preflight_confirmation(&plan, None, None).is_err());
        assert!(validate_preflight_confirmation(&plan, None, Some("stale-plan")).is_err());
        validate_preflight_confirmation(&plan, None, Some("confirmed-plan"))
            .expect("matching adoption only needs exact plan confirmation");

        plan.has_conflicts = true;
        plan.sources[0].matches_selected = false;
        assert!(validate_preflight_confirmation(&plan, None, Some("confirmed-plan")).is_err());
        validate_preflight_confirmation(&plan, Some(true), Some("confirmed-plan"))
            .expect("conflict needs both exact plan and replace consent");

        plan.sources.clear();
        plan.has_conflicts = false;
        validate_preflight_confirmation(&plan, None, None)
            .expect("an install without adoption does not need a plan token");
    }

    #[test]
    fn generated_projection_keeps_canonical_bytes_and_package_unchanged() {
        let fixture = projection_fixture("---\nname: sample\n---\n# Original\n", true);
        let canonical_before =
            fs::read(fixture.skill_root.join("SKILL.md")).expect("read canonical before refresh");
        let package_before =
            create_skill_package_from_root(&fixture.skill_root).expect("package before refresh");
        refresh_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
            .expect("idempotent refresh");
        assert_eq!(
            fs::read(fixture.skill_root.join("SKILL.md")).expect("read canonical after refresh"),
            canonical_before
        );
        let package_after =
            create_skill_package_from_root(&fixture.skill_root).expect("package after refresh");
        assert_eq!(package_after.sha256, package_before.sha256);
        assert_eq!(package_after.base64, package_before.base64);
        let projected =
            fs::read_to_string(fixture.projected_skill_md()).expect("read projected SKILL.md");
        assert!(projected.contains("yitan-skillhub-runtime\" run sample -- <program> [args...]"));
        assert!(projected.contains(
            "$HOME/.skillhub/runtime/bin/yitan-skillhub-runtime\" run sample -- <program> [args...]"
        ));
        assert!(!projected.contains("$HOME/.local/bin/skillhub"));
        assert!(!projected.contains("command -v skillhub"));
        assert!(!projected.contains("-- env"));
        assert!(!projected.contains("eval \"$_skillhub_env\""));
        assert!(projected.contains("只把值注入该子进程"));
        assert_eq!(
            fs::read_to_string(fixture.current.join("scripts/run.sh"))
                .expect("read projected resource"),
            "#!/bin/sh\necho ok\n"
        );
        fixture.cleanup();
    }

    #[test]
    fn projection_refresh_migrates_untampered_v2_runtime_header_to_v3() {
        let fixture = projection_fixture("# Original\n", true);
        let (mut marker, generation) =
            current_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
                .expect("read current projection");
        let projected_path = generation.join("SKILL.md");
        let projected = fs::read_to_string(&projected_path).expect("read projected Skill");
        let current_header = runtime_header("sample", &marker.header_token, "\n", &marker.env_keys);
        let old_header = runtime_header_v2("sample", &marker.header_token, "\n", &marker.env_keys);
        let old_projected = projected.replace(&current_header, &old_header);
        assert_ne!(old_projected, projected);

        fs::set_permissions(&projected_path, fs::Permissions::from_mode(0o600))
            .expect("unlock projected Skill");
        fs::write(&projected_path, &old_projected).expect("install v2 projected Skill");
        marker.header_version = SHELL_EXPORT_PROJECTION_HEADER_VERSION;
        marker.rendered_skill_md_sha256 = sha256_hex(old_projected.as_bytes());
        fs::write(
            generation.join(PROJECTION_MARKER_NAME),
            serde_json::to_vec(&marker).expect("serialize v2 marker"),
        )
        .expect("write v2 marker");

        refresh_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
            .expect("migrate v2 projection");
        let (migrated, migrated_generation) =
            current_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
                .expect("read migrated projection");
        assert_eq!(migrated.header_version, PROJECTION_HEADER_VERSION);
        assert_ne!(migrated_generation, generation);
        let migrated_text =
            fs::read_to_string(migrated_generation.join("SKILL.md")).expect("read migrated Skill");
        assert!(migrated_text.contains("run sample -- <program> [args...]"));
        assert!(!migrated_text.contains("-- env"));
        fixture.cleanup();
    }

    /// Installs an older header version over the current projection exactly
    /// as an older SkillHub would have rendered it.
    fn install_projection_header_version(
        fixture: &ProjectionFixture,
        header_version: u8,
        old_header: impl Fn(&str, &[String]) -> String,
        header_injected: bool,
    ) -> (String, PathBuf) {
        let (mut marker, generation) =
            current_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
                .expect("read current projection");
        let projected_path = generation.join("SKILL.md");
        let projected = fs::read_to_string(&projected_path).expect("read projected Skill");
        let current_header = runtime_header("sample", &marker.header_token, "\n", &marker.env_keys);
        let old_projected = if header_injected {
            projected.replace(
                &current_header,
                &old_header(&marker.header_token, &marker.env_keys),
            )
        } else {
            projected.replace(&current_header, "")
        };
        assert_ne!(old_projected, projected);
        fs::set_permissions(&projected_path, fs::Permissions::from_mode(0o600))
            .expect("unlock projected Skill");
        fs::write(&projected_path, &old_projected).expect("install old projected Skill");
        marker.header_version = header_version;
        marker.header_injected = header_injected;
        marker.rendered_skill_md_sha256 = sha256_hex(old_projected.as_bytes());
        fs::write(
            generation.join(PROJECTION_MARKER_NAME),
            serde_json::to_vec(&marker).expect("serialize old marker"),
        )
        .expect("write old marker");
        (old_projected, generation)
    }

    #[test]
    fn projection_refresh_migrates_untampered_v3_runtime_header_to_v4() {
        let fixture = projection_fixture("# Original\n", true);
        let (_, generation) = install_projection_header_version(
            &fixture,
            ENV_ONLY_PROJECTION_HEADER_VERSION,
            |token, keys| runtime_header_v3("sample", token, "\n", keys),
            true,
        );

        refresh_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
            .expect("migrate v3 projection");
        let (migrated, migrated_generation) =
            current_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
                .expect("read migrated projection");
        assert_eq!(migrated.header_version, PROJECTION_HEADER_VERSION);
        assert_ne!(migrated_generation, generation);
        let migrated_text =
            fs::read_to_string(migrated_generation.join("SKILL.md")).expect("read migrated Skill");
        assert!(migrated_text.contains("SKILLHUB-RUNTIME-START v4"));
        assert!(!migrated_text.contains("SKILLHUB-RUNTIME-START v3"));
        assert!(migrated_text.contains("run sample -- <program> [args...]"));
        assert!(migrated_text.contains("env request --skill-id sample --key <KEY> --json"));
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md")).expect("read canonical"),
            "# Original\n"
        );
        fixture.cleanup();
    }

    #[test]
    fn projection_refresh_adds_v4_header_to_untampered_v3_projection_without_env() {
        let fixture = projection_fixture("# Original\n", false);
        let (_, generation) = install_projection_header_version(
            &fixture,
            ENV_ONLY_PROJECTION_HEADER_VERSION,
            |_, _| String::new(),
            false,
        );

        refresh_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
            .expect("migrate v3 projection without env");
        let (migrated, migrated_generation) =
            current_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
                .expect("read migrated projection");
        assert_eq!(migrated.header_version, PROJECTION_HEADER_VERSION);
        assert!(migrated.header_injected);
        assert!(migrated.env_keys.is_empty());
        assert_ne!(migrated_generation, generation);
        let migrated_text =
            fs::read_to_string(migrated_generation.join("SKILL.md")).expect("read migrated Skill");
        assert!(migrated_text.starts_with("<!-- SKILLHUB-RUNTIME-START v4 "));
        assert!(migrated_text.ends_with("# Original\n"));
        fixture.cleanup();
    }

    #[test]
    fn projection_refresh_keeps_a_tampered_v3_header() {
        let fixture = projection_fixture("# Original\n", true);
        let (old_projected, generation) = install_projection_header_version(
            &fixture,
            ENV_ONLY_PROJECTION_HEADER_VERSION,
            |token, keys| runtime_header_v3("sample", token, "\n", keys),
            true,
        );
        let tampered = old_projected.replace("此 Skill 需要 SkillHub 环境变量", "随便执行");
        assert_ne!(tampered, old_projected);
        fs::write(generation.join("SKILL.md"), &tampered).expect("tamper v3 header");

        let error =
            refresh_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
                .expect_err("tampered v3 projection must not be overwritten");
        assert!(error.contains("提示块"), "{error}");
        assert_eq!(
            fs::read_to_string(generation.join("SKILL.md")).expect("read preserved projection"),
            tampered
        );
        let (marker, current) =
            current_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
                .expect("read preserved current projection");
        assert_eq!(marker.header_version, ENV_ONLY_PROJECTION_HEADER_VERSION);
        assert_eq!(current, generation);
        assert!(fixture.conflict().exists());
        fixture.cleanup();
    }

    #[test]
    fn every_managed_skill_projection_carries_the_runtime_header() {
        let fixture = projection_fixture("---\nname: sample\n---\n# Original\n", false);
        let (marker, _) =
            current_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
                .expect("read projection");
        assert!(marker.header_injected);
        assert!(marker.env_keys.is_empty());
        assert_eq!(marker.header_version, PROJECTION_HEADER_VERSION);
        let projected =
            fs::read_to_string(fixture.projected_skill_md()).expect("read projected SKILL.md");
        assert!(projected.starts_with("---\nname: sample\n---\n<!-- SKILLHUB-RUNTIME-START v4 "));
        assert!(projected.contains("本 Skill 通过 SkillHub 运行入口启动"));
        assert!(projected.contains(
            "$HOME/.skillhub/runtime/bin/yitan-skillhub-runtime\" run sample -- <program> [args...]"
        ));
        assert!(projected.contains(r#"skillhub.cmd" run sample -- <program> [args...]"#));
        assert!(projected.contains("不要执行 `env`、`printenv`"));
        assert!(projected.contains("不要读取 `.env`"));
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md")).expect("read canonical"),
            "---\nname: sample\n---\n# Original\n"
        );
        fixture.cleanup();
    }

    #[test]
    fn system_manager_projection_stays_without_runtime_header() {
        let manager = SkillHubProfile {
            is_system: true,
            ..SkillHubProfile::default()
        };
        assert!(!projection_injects_runtime_header("sample", &manager));
        assert!(!projection_injects_runtime_header(
            crate::system_skill::SYSTEM_MANAGER_ID,
            &SkillHubProfile::default()
        ));
        assert!(projection_injects_runtime_header(
            "sample",
            &SkillHubProfile::default()
        ));
    }

    #[test]
    fn agent_projection_declares_exact_current_target() {
        let fixture = projection_fixture("# Original\n", true);
        let agent_link = fixture.home.join(".codex/skills/sample");
        fs::create_dir_all(agent_link.parent().expect("Agent root")).expect("create Agent root");
        unix_fs::symlink(&fixture.current, &agent_link).expect("create Agent projection");
        assert_eq!(
            fs::read_link(&agent_link).expect("read Agent target"),
            fixture.current
        );
        assert!(projection_marker_for_link_at(
            &agent_link,
            &fixture.skillhub_root,
            &fixture.managed_root
        )
        .is_some());
        assert_eq!(
            super::managed_skill_agent_projection_state_at(
                &agent_link,
                &fixture.skillhub_root,
                &fixture.managed_root,
                "sample",
            )
            .expect("classify exact current projection"),
            super::ManagedSkillAgentProjectionState::Installed
        );
        fixture.cleanup();
    }

    #[test]
    fn projected_body_edit_writes_back_and_marks_git_working_copy_dirty() {
        let fixture = projection_fixture("# Original\n", true);
        create_skill_snapshot_at_path(&fixture.skill_root, "baseline")
            .expect("create baseline snapshot");
        let projected =
            fs::read_to_string(fixture.projected_skill_md()).expect("read projected SKILL.md");
        fs::write(
            fixture.projected_skill_md(),
            projected.replace("# Original", "# Edited through Agent"),
        )
        .expect("edit projected body");
        reconcile_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
            .expect("reconcile projected body edit");
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md"))
                .expect("read reconciled canonical body"),
            "# Edited through Agent\n"
        );
        assert!(!fixture.conflict().exists());
        let (dirty, changes, _) = working_copy_state_for_path(&fixture.skill_root);
        assert!(dirty);
        assert!(changes >= 1);
        fixture.cleanup();
    }

    #[test]
    fn working_diff_directly_reconciles_projected_agent_edit() {
        let fixture = projection_fixture("# Original\n", true);
        create_skill_snapshot_at_path(&fixture.skill_root, "baseline")
            .expect("create baseline snapshot");
        let projected =
            fs::read_to_string(fixture.projected_skill_md()).expect("read projected SKILL.md");
        fs::write(
            fixture.projected_skill_md(),
            projected.replace("# Original", "# Diff-visible Agent edit"),
        )
        .expect("edit projected body");
        let diff =
            get_skill_working_diff_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
                .expect("read direct working diff");
        assert!(diff.iter().any(|line| {
            line.kind == "add" && line.content.contains("# Diff-visible Agent edit")
        }));
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md"))
                .expect("read reconciled canonical"),
            "# Diff-visible Agent edit\n"
        );
        fixture.cleanup();
    }

    #[test]
    fn changed_deleted_or_moved_runtime_header_preserves_both_copies() {
        for mutation in ["changed", "deleted", "moved"] {
            let fixture = projection_fixture("# Original\n", true);
            let (marker, _) =
                current_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
                    .expect("read projection marker");
            let header = runtime_header("sample", &marker.header_token, "\n", &marker.env_keys);
            let projected =
                fs::read_to_string(fixture.projected_skill_md()).expect("read projected SKILL.md");
            let mutated = match mutation {
                "changed" => projected.replace("## SkillHub 运行入口", "## Changed Header"),
                "deleted" => projected.replace(&header, ""),
                "moved" => format!("{}{}", projected.replace(&header, ""), header),
                _ => unreachable!(),
            };
            fs::write(fixture.projected_skill_md(), &mutated)
                .expect("mutate projected runtime header");
            let error = reconcile_skill_projection_at(
                &fixture.skillhub_root,
                &fixture.managed_root,
                "sample",
            )
            .expect_err("runtime header mutation must conflict");
            assert!(error.contains("提示块"));
            assert_eq!(
                fs::read_to_string(fixture.skill_root.join("SKILL.md"))
                    .expect("read preserved canonical"),
                "# Original\n"
            );
            assert_eq!(
                fs::read_to_string(fixture.projected_skill_md())
                    .expect("read preserved projection"),
                mutated
            );
            assert!(fixture.conflict().is_file());
            fixture.cleanup();
        }
    }

    #[test]
    fn concurrent_different_edits_conflict_but_identical_edits_reconcile() {
        let fixture = projection_fixture("# Original\n", true);
        let projected =
            fs::read_to_string(fixture.projected_skill_md()).expect("read projected SKILL.md");
        fs::write(fixture.skill_root.join("SKILL.md"), "# Canonical edit\n")
            .expect("edit canonical");
        fs::write(
            fixture.projected_skill_md(),
            projected.replace("# Original", "# Projection edit"),
        )
        .expect("edit projection");
        let error =
            reconcile_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
                .expect_err("different concurrent edits must conflict");
        assert!(error.contains("同时发生不同修改"));
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md")).expect("read canonical edit"),
            "# Canonical edit\n"
        );
        assert!(fs::read_to_string(fixture.projected_skill_md())
            .expect("read projection edit")
            .contains("# Projection edit"));
        fixture.cleanup();

        let fixture = projection_fixture("# Original\n", true);
        let projected =
            fs::read_to_string(fixture.projected_skill_md()).expect("read projected SKILL.md");
        fs::write(fixture.skill_root.join("SKILL.md"), "# Same edit\n")
            .expect("edit canonical identically");
        fs::write(
            fixture.projected_skill_md(),
            projected.replace("# Original", "# Same edit"),
        )
        .expect("edit projection identically");
        reconcile_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
            .expect("identical concurrent edits reconcile");
        assert!(!fixture.conflict().exists());
        fixture.cleanup();
    }

    #[test]
    fn generated_header_preserves_bom_frontmatter_and_line_endings() {
        let lf = "\u{feff}---\nname: sample\n---\n# Body\n";
        let rendered_lf = generated_skill_md(lf, "sample", true);
        assert!(rendered_lf.starts_with("\u{feff}---\nname: sample\n---\n"));
        assert!(!rendered_lf.contains("\r\n"));

        let crlf = "\u{feff}---\r\nname: sample\r\n---\r\n# Body\r\n";
        let rendered_crlf = generated_skill_md(crlf, "sample", true);
        assert!(rendered_crlf.starts_with("\u{feff}---\r\nname: sample\r\n---\r\n"));
        assert!(!rendered_crlf.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn frontmatter_closed_at_eof_round_trips_without_losing_the_boundary() {
        let original = "---\nname: sample\n---";
        let fixture = projection_fixture(original, true);
        let mut projected =
            fs::read_to_string(fixture.projected_skill_md()).expect("read projected SKILL.md");
        assert!(projected.starts_with("---\nname: sample\n---\n<!-- SKILLHUB-RUNTIME-START"));
        projected.push_str("\n# Added through Agent\n");
        fs::write(fixture.projected_skill_md(), projected).expect("edit projected body");

        reconcile_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
            .expect("reconcile EOF-frontmatter projection");
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md"))
                .expect("read reconciled canonical"),
            "---\nname: sample\n---\n# Added through Agent\n"
        );
        fixture.cleanup();
    }

    #[test]
    fn stale_canonical_compare_and_swap_preserves_the_newer_file() {
        let fixture = projection_fixture("# Original\n", true);
        let canonical = fixture.skill_root.join("SKILL.md");
        fs::write(&canonical, "# Newer canonical\n").expect("replace canonical before CAS");
        let error = replace_canonical_skill_md_preserving_base(
            &canonical,
            b"# Original\n",
            b"# Projection candidate\n",
            &projection_root_at(&fixture.skillhub_root, "sample"),
        )
        .expect_err("stale base must not overwrite canonical");
        assert!(error.contains("回写前发生变化"));
        assert_eq!(
            fs::read_to_string(&canonical).expect("read preserved canonical"),
            "# Newer canonical\n"
        );
        fixture.cleanup();
    }

    #[test]
    fn atomic_projection_removal_restores_a_foreign_link() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-atomic-link-removal-{}",
            uuid::Uuid::new_v4()
        ));
        let agent_root = home.join("agent");
        let expected = home.join("expected");
        let foreign = home.join("foreign");
        let link = agent_root.join("sample");
        fs::create_dir_all(&agent_root).expect("create Agent root");
        fs::create_dir(&expected).expect("create expected target");
        fs::create_dir(&foreign).expect("create foreign target");
        unix_fs::symlink(&foreign, &link).expect("create foreign projection");

        let error = remove_owned_symlink_atomically(
            &link,
            &[expected],
            &home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            }),
        )
        .expect_err("foreign projection must not be deleted");
        assert!(error.contains("非 SkillHub"));
        assert_eq!(fs::read_link(&link).expect("read restored link"), foreign);
        fs::remove_dir_all(home).expect("remove fixture");
    }

    fn directory_names(directory: &Path) -> Vec<String> {
        let mut names = fs::read_dir(directory)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn disabling_a_projection_leaves_no_agent_visible_or_staged_residue() {
        let fixture = projection_fixture("# Original\n", false);
        let agent_root = fixture.home.join(".claude/skills");
        fs::create_dir_all(&agent_root).expect("create Agent root");
        let link = agent_root.join("sample");
        let expected = vec![fixture.skill_root.clone(), fixture.current.clone()];

        // Disable -> undo (re-enable) cycles must never accumulate entries.
        for _ in 0..3 {
            unix_fs::symlink(&fixture.current, &link).expect("enable projection");
            remove_owned_symlink_atomically(&link, &expected, &fixture.skillhub_root)
                .expect("disable owned projection");
            assert!(fs::symlink_metadata(&link).is_err());
            assert!(directory_names(&agent_root).is_empty());
            assert!(directory_names(&fixture.skillhub_root.join(PROJECTION_UNLINK_DIR)).is_empty());
        }
        // The projection itself and the canonical Skill are untouched.
        assert!(fixture.projected_skill_md().is_file());
        assert!(fixture.skill_root.join("SKILL.md").is_file());
        fixture.cleanup();
    }

    #[test]
    fn disabling_without_a_staging_area_unlinks_in_place_without_residue() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-in-place-link-removal-{}",
            uuid::Uuid::new_v4()
        ));
        let agent_root = home.join("agent");
        let expected = home.join("expected");
        let link = agent_root.join("sample");
        fs::create_dir_all(&agent_root).expect("create Agent root");
        fs::create_dir(&expected).expect("create expected target");
        unix_fs::symlink(&expected, &link).expect("create owned projection");

        // The SkillHub root does not exist, so isolation falls back to a
        // random name inside the Agent directory followed by an immediate
        // verified unlink.
        remove_owned_symlink_atomically(
            &link,
            std::slice::from_ref(&expected),
            &home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            }),
        )
        .expect("disable owned projection");
        assert!(directory_names(&agent_root).is_empty());
        assert!(expected.is_dir());
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn isolated_link_replaced_before_verification_is_restored_not_deleted() {
        let fixture = projection_fixture("# Original\n", false);
        let agent_root = fixture.home.join(".claude/skills");
        fs::create_dir_all(&agent_root).expect("create Agent root");
        let link = agent_root.join("sample");
        let foreign = fixture.home.join("foreign");
        fs::create_dir(&foreign).expect("create foreign target");
        fs::write(foreign.join("SKILL.md"), "# Foreign\n").expect("write foreign content");
        unix_fs::symlink(&fixture.current, &link).expect("create owned projection");
        let expected = vec![fixture.current.clone()];

        // Simulate an adversarial swap of the isolated entry between the move
        // and the ownership check: verification must see the foreign link.
        let error = isolate_and_unlink_owned_link(
            &link,
            &fixture.skillhub_root,
            |isolated, origin_parent| {
                fs::remove_file(isolated).expect("drop isolated link");
                unix_fs::symlink(&foreign, isolated).expect("plant foreign link");
                super::isolated_link_declares_any(isolated, origin_parent, &expected)
            },
        )
        .expect_err("foreign replacement must not be deleted");
        assert!(error.contains("非 SkillHub"));
        assert_eq!(fs::read_link(&link).expect("restored entry"), foreign);
        assert_eq!(
            fs::read_to_string(foreign.join("SKILL.md")).expect("foreign content kept"),
            "# Foreign\n"
        );
        assert!(directory_names(&fixture.skillhub_root.join(PROJECTION_UNLINK_DIR)).is_empty());
        fixture.cleanup();
    }

    #[test]
    fn legacy_remove_link_sweep_removes_only_owned_projection_links() {
        let fixture = projection_fixture("# Original\n", false);
        let claude = fixture.home.join(".claude/skills");
        let codex = fixture.home.join(".codex/skills");
        fs::create_dir_all(&claude).expect("create Claude root");
        fs::create_dir_all(&codex).expect("create Codex root");
        let legacy = |root: &Path| {
            root.join(format!(
                "{LEGACY_REMOVE_LINK_PREFIX}{}",
                uuid::Uuid::new_v4()
            ))
        };

        // Three owned leftovers pointing at this root's projections/*/current.
        let owned = [legacy(&claude), legacy(&claude), legacy(&codex)];
        for path in &owned {
            unix_fs::symlink(&fixture.current, path).expect("create owned leftover");
        }
        // A foreign link, a link into another SkillHub root, and a real dir.
        let foreign_target = fixture.home.join("foreign");
        fs::create_dir(&foreign_target).expect("create foreign target");
        let foreign = legacy(&claude);
        unix_fs::symlink(&foreign_target, &foreign).expect("create foreign leftover");
        let other_account = legacy(&codex);
        unix_fs::symlink(
            fixture
                .home
                .join("other/.skillhub/projections/sample/current"),
            &other_account,
        )
        .expect("create other-root leftover");
        let real_directory = legacy(&claude);
        fs::create_dir(&real_directory).expect("create real leftover directory");
        fs::write(real_directory.join("SKILL.md"), "# User\n").expect("write user content");
        // A regular projection name is never touched by the sweep.
        let live = claude.join("sample");
        unix_fs::symlink(&fixture.current, &live).expect("create live projection");

        let dirs = [".claude/skills", ".codex/skills", ".missing/skills"];
        assert_eq!(
            sweep_legacy_remove_links_at(&fixture.home, &fixture.skillhub_root, &dirs, false),
            LegacyRemoveLinkSweep {
                removed: 3,
                skipped: 3,
                ..Default::default()
            }
        );
        assert!(owned.iter().all(|path| fs::symlink_metadata(path).is_ok()));

        assert_eq!(
            sweep_legacy_remove_links_at(&fixture.home, &fixture.skillhub_root, &dirs, true),
            LegacyRemoveLinkSweep {
                removed: 3,
                skipped: 3,
                ..Default::default()
            }
        );
        assert!(owned.iter().all(|path| fs::symlink_metadata(path).is_err()));
        assert_eq!(
            fs::read_link(&foreign).expect("foreign kept"),
            foreign_target
        );
        assert!(fs::symlink_metadata(&other_account).is_ok());
        assert!(real_directory.join("SKILL.md").is_file());
        assert_eq!(fs::read_link(&live).expect("live kept"), fixture.current);
        assert!(fixture.projected_skill_md().is_file());
        assert!(directory_names(&fixture.skillhub_root.join(PROJECTION_UNLINK_DIR)).is_empty());

        // Idempotent: a second pass removes nothing more.
        assert_eq!(
            sweep_legacy_remove_links_at(&fixture.home, &fixture.skillhub_root, &dirs, true),
            LegacyRemoveLinkSweep {
                removed: 0,
                skipped: 3,
                ..Default::default()
            }
        );
        fixture.cleanup();
    }

    fn old_link_names(directory: &Path) -> Vec<String> {
        directory_names(directory)
            .into_iter()
            .filter(|name| name.starts_with(LEGACY_OLD_LINK_PREFIX))
            .collect()
    }

    #[test]
    fn projection_migration_leaves_no_old_link_behind() {
        let fixture = projection_fixture("# Original\n", false);
        let agent_root = fixture.home.join(".claude/skills");
        fs::create_dir_all(&agent_root).expect("create Agent root");
        let link = agent_root.join("sample");

        // Repeated canonical -> projection migrations never accumulate entries.
        for _ in 0..3 {
            unix_fs::symlink(&fixture.skill_root, &link).expect("create pre-projection link");
            migrate_agent_projection_link(
                &link,
                &fixture.skill_root,
                &fixture.current,
                &fixture.skillhub_root,
            )
            .expect("migrate Agent link");
            assert_eq!(
                fs::read_link(&link).expect("migrated link"),
                fixture.current
            );
            assert_eq!(directory_names(&agent_root), vec!["sample".to_string()]);
            assert!(directory_names(&fixture.skillhub_root.join(PROJECTION_UNLINK_DIR)).is_empty());
            fs::remove_file(&link).expect("reset Agent link");
        }
        // Refreshing the projection switches `current` through the same path
        // and leaves no old link in the projection root either.
        fs::write(fixture.skill_root.join("SKILL.md"), "# Changed\n").expect("edit canonical");
        refresh_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
            .expect("refresh projection");
        assert!(old_link_names(&projection_root_at(&fixture.skillhub_root, "sample")).is_empty());
        assert!(fixture.skill_root.join("SKILL.md").is_file());
        fixture.cleanup();
    }

    #[test]
    fn projection_migration_without_a_staging_area_leaves_no_old_link() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-in-place-link-migration-{}",
            uuid::Uuid::new_v4()
        ));
        let agent_root = home.join("agent");
        let canonical = home.join("canonical");
        let generated = home.join("generated");
        let link = agent_root.join("sample");
        fs::create_dir_all(&agent_root).expect("create Agent root");
        fs::create_dir(&canonical).expect("create canonical");
        fs::create_dir(&generated).expect("create generated");
        unix_fs::symlink(&canonical, &link).expect("create pre-projection link");

        // The SkillHub root does not exist, so isolation falls back to a
        // same-directory `.skillhub-old-link-*` that is unlinked right away.
        migrate_agent_projection_link(
            &link,
            &canonical,
            &generated,
            &home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            }),
        )
        .expect("migrate Agent link");
        assert_eq!(fs::read_link(&link).expect("migrated link"), generated);
        assert_eq!(directory_names(&agent_root), vec!["sample".to_string()]);
        assert!(canonical.is_dir());
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn atomic_link_switch_restores_a_changed_old_link() {
        let fixture = projection_fixture("# Original\n", false);
        let agent_root = fixture.home.join(".claude/skills");
        fs::create_dir_all(&agent_root).expect("create Agent root");
        let link = agent_root.join("sample");
        let foreign = fixture.home.join("foreign");
        fs::create_dir(&foreign).expect("create foreign target");
        unix_fs::symlink(&foreign, &link).expect("create foreign link");
        let temporary = agent_root.join(".skillhub-link-test");
        unix_fs::symlink(&fixture.current, &temporary).expect("create prepared link");

        let error = install_prepared_symlink_atomically(
            &temporary,
            &link,
            Some(&fixture.skill_root),
            &fixture.skillhub_root,
        )
        .expect_err("a link with another target must not be replaced");
        assert!(error.contains("已保留原项"));
        assert_eq!(fs::read_link(&link).expect("restored link"), foreign);
        assert!(old_link_names(&agent_root).is_empty());
        assert!(directory_names(&fixture.skillhub_root.join(PROJECTION_UNLINK_DIR)).is_empty());
        fixture.cleanup();
    }

    #[test]
    fn legacy_old_link_sweep_removes_only_owned_links() {
        let fixture = projection_fixture("# Original\n", false);
        let claude = fixture.home.join(".claude/skills");
        let codex = fixture.home.join(".codex/skills");
        fs::create_dir_all(&claude).expect("create Claude root");
        fs::create_dir_all(&codex).expect("create Codex root");
        let old =
            |root: &Path| root.join(format!("{LEGACY_OLD_LINK_PREFIX}{}", uuid::Uuid::new_v4()));

        // Owned: the pre-projection link to the managed Skill (what migration
        // replaced) and a link to this root's projection.
        let owned = [old(&claude), old(&codex), old(&claude)];
        unix_fs::symlink(&fixture.skill_root, &owned[0]).expect("create managed old link");
        unix_fs::symlink(&fixture.skill_root, &owned[1]).expect("create managed old link");
        unix_fs::symlink(&fixture.current, &owned[2]).expect("create projection old link");
        // Skipped: foreign link, another account's managed Skill, the managed
        // root itself, a nested managed path, a plain directory.
        let foreign_target = fixture.home.join("foreign");
        fs::create_dir(&foreign_target).expect("create foreign target");
        let foreign = old(&claude);
        unix_fs::symlink(&foreign_target, &foreign).expect("create foreign old link");
        let other_account = old(&codex);
        unix_fs::symlink(
            fixture.home.join("other/.skillhub/skills/sample"),
            &other_account,
        )
        .expect("create other-root old link");
        let managed_root_link = old(&claude);
        unix_fs::symlink(&fixture.managed_root, &managed_root_link)
            .expect("create managed-root old link");
        let nested = old(&claude);
        unix_fs::symlink(fixture.skill_root.join("scripts"), &nested)
            .expect("create nested old link");
        let real_directory = old(&codex);
        fs::create_dir(&real_directory).expect("create real old-link directory");
        fs::write(real_directory.join("SKILL.md"), "# User\n").expect("write user content");
        // A remove-link to the managed Skill stays outside #165's proof.
        let remove_link_to_managed = claude.join(format!(
            "{LEGACY_REMOVE_LINK_PREFIX}{}",
            uuid::Uuid::new_v4()
        ));
        unix_fs::symlink(&fixture.skill_root, &remove_link_to_managed)
            .expect("create remove-link to managed Skill");
        let live = claude.join("sample");
        unix_fs::symlink(&fixture.current, &live).expect("create live projection");

        let dirs = [".claude/skills", ".codex/skills"];
        let expected = LegacyRemoveLinkSweep {
            removed: 0,
            skipped: 1,
            old_links: LegacyLinkCounts {
                removed: 3,
                skipped: 5,
            },
        };
        assert_eq!(
            sweep_legacy_remove_links_at(&fixture.home, &fixture.skillhub_root, &dirs, false),
            expected
        );
        assert!(owned.iter().all(|path| fs::symlink_metadata(path).is_ok()));
        assert_eq!(
            sweep_legacy_remove_links_at(&fixture.home, &fixture.skillhub_root, &dirs, true),
            expected
        );
        assert!(owned.iter().all(|path| fs::symlink_metadata(path).is_err()));
        assert_eq!(
            fs::read_link(&foreign).expect("foreign kept"),
            foreign_target
        );
        for kept in [
            &other_account,
            &managed_root_link,
            &nested,
            &remove_link_to_managed,
        ] {
            assert!(fs::symlink_metadata(kept).is_ok());
        }
        assert!(real_directory.join("SKILL.md").is_file());
        assert_eq!(fs::read_link(&live).expect("live kept"), fixture.current);
        assert!(fixture.skill_root.join("SKILL.md").is_file());
        assert!(fixture.projected_skill_md().is_file());
        assert!(directory_names(&fixture.skillhub_root.join(PROJECTION_UNLINK_DIR)).is_empty());

        // Idempotent.
        assert_eq!(
            sweep_legacy_remove_links_at(&fixture.home, &fixture.skillhub_root, &dirs, true),
            LegacyRemoveLinkSweep {
                removed: 0,
                skipped: 1,
                old_links: LegacyLinkCounts {
                    removed: 0,
                    skipped: 5,
                },
            }
        );
        fixture.cleanup();
    }

    #[test]
    fn legacy_link_sweep_serializes_old_link_counts_for_doctor() {
        let value = serde_json::to_value(LegacyRemoveLinkSweep {
            removed: 1,
            skipped: 2,
            old_links: LegacyLinkCounts {
                removed: 3,
                skipped: 4,
            },
        })
        .expect("serialize sweep");
        assert_eq!(
            value,
            serde_json::json!({
                "removed": 1,
                "skipped": 2,
                "oldLinks": { "removed": 3, "skipped": 4 }
            })
        );
    }

    #[test]
    fn legacy_projection_retirement_removes_only_proven_skillhub_links() {
        let fixture = projection_fixture("# Original\n", false);
        let legacy_link = fixture.home.join(".agents/skills/sample");
        fs::create_dir_all(legacy_link.parent().expect("legacy Agent root"))
            .expect("create legacy Agent root");
        unix_fs::symlink(&fixture.current, &legacy_link)
            .expect("create legacy SkillHub projection");

        retire_legacy_agent_projection_links_at(
            &fixture.home,
            &fixture.skillhub_root,
            &fixture.managed_root,
            "sample",
            "sample",
            &[".agents/skills"],
        )
        .expect("retire proven legacy projection");
        assert!(fs::symlink_metadata(&legacy_link).is_err());
        assert!(fixture.skill_root.join("SKILL.md").is_file());

        fs::create_dir_all(&legacy_link).expect("create user-owned native Skill");
        fs::write(legacy_link.join("SKILL.md"), "# User owned\n").expect("write user-owned Skill");
        retire_legacy_agent_projection_links_at(
            &fixture.home,
            &fixture.skillhub_root,
            &fixture.managed_root,
            "sample",
            "sample",
            &[".agents/skills"],
        )
        .expect("ignore user-owned native Skill");
        assert_eq!(
            fs::read_to_string(legacy_link.join("SKILL.md")).expect("read user-owned Skill"),
            "# User owned\n"
        );
        fixture.cleanup();
    }

    #[test]
    fn projection_root_symlink_is_rejected() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-projection-root-symlink-{}",
            uuid::Uuid::new_v4()
        ));
        let real_root = home.join("real");
        let linked_root = home.join("linked");
        let skill = real_root.join("skills/sample");
        fs::create_dir_all(&skill).expect("create real SkillHub root");
        fs::write(skill.join("SKILL.md"), "# Original\n").expect("write Skill");
        fs::write(
            skill.join(".skillhub.json"),
            r#"{"version":"1","skillhub":{"name":"sample","envDependencies":[]}}"#,
        )
        .expect("write profile");
        unix_fs::symlink(&real_root, &linked_root).expect("create root symlink");
        let error =
            refresh_skill_projection_at(&linked_root, &linked_root.join("skills"), "sample")
                .expect_err("symlink SkillHub root must fail closed");
        assert!(error.contains("根目录必须是真实目录"));
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn fake_marker_outside_exact_current_target_is_not_owned_or_uninstalled() {
        let fixture = projection_fixture("# Original\n", true);
        let foreign = fixture.home.join("foreign");
        fs::create_dir_all(&foreign).expect("create foreign Skill");
        fs::copy(
            fixture.generation().join(".skillhub-projection.json"),
            foreign.join(".skillhub-projection.json"),
        )
        .expect("copy forged marker");
        fs::write(foreign.join("SKILL.md"), "# User-owned\n").expect("write foreign body");
        let agent_link = fixture.home.join(".codex/skills/sample");
        fs::create_dir_all(agent_link.parent().expect("Agent root")).expect("create Agent root");
        unix_fs::symlink(&foreign, &agent_link).expect("create forged projection");
        assert!(projection_marker_for_link_at(
            &agent_link,
            &fixture.skillhub_root,
            &fixture.managed_root
        )
        .is_none());
        assert_eq!(
            super::managed_skill_agent_projection_state_at(
                &agent_link,
                &fixture.skillhub_root,
                &fixture.managed_root,
                "sample",
            )
            .expect("classify forged projection"),
            super::ManagedSkillAgentProjectionState::Occupied
        );
        uninstall_skill_projections(&fixture.home, &fixture.managed_root, "sample")
            .expect("uninstall ignores forged projection");
        assert!(fs::symlink_metadata(&agent_link)
            .expect("forged projection remains")
            .file_type()
            .is_symlink());
        fixture.cleanup();
    }

    #[test]
    fn projection_generation_is_idempotent_and_retains_prior_edit_surfaces() {
        let fixture = projection_fixture("# Version 0\n", true);
        let first_target = fs::read_link(&fixture.current).expect("read first generation target");
        refresh_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
            .expect("idempotent projection refresh");
        assert_eq!(
            fs::read_link(&fixture.current).expect("read idempotent generation target"),
            first_target
        );

        for version in 1..=4 {
            fs::write(
                fixture.skill_root.join("SKILL.md"),
                format!("# Version {version}\n"),
            )
            .expect("edit canonical version");
            refresh_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
                .expect("refresh changed canonical");
        }
        let root = projection_root_at(&fixture.skillhub_root, "sample");
        let generation_count = fs::read_dir(root)
            .expect("read projection root")
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("generation-")
            })
            .count();
        assert_eq!(generation_count, 5, "found {generation_count} generations");
        fixture.cleanup();
    }

    #[test]
    fn late_edit_in_a_retired_generation_is_reconciled_and_preserved() {
        let fixture = projection_fixture("# Original\n", true);
        let retired_generation = fixture.generation();
        fs::write(
            fixture.skill_root.join(".skillhub.json"),
            r#"{"version":"1","skillhub":{"id":"sample","name":"sample","envDependencies":[{"key":"API_KEY","required":true},{"key":"SECOND_KEY","required":true}]}}"#,
        )
        .expect("change environment dependency set");
        refresh_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
            .expect("create replacement generation");
        assert_ne!(fixture.generation(), retired_generation);

        let retired_skill_md = retired_generation.join("SKILL.md");
        let retired_contents =
            fs::read_to_string(&retired_skill_md).expect("read retired projected SKILL.md");
        fs::write(
            &retired_skill_md,
            retired_contents.replace("# Original", "# Late retired edit"),
        )
        .expect("save late editor contents");
        reconcile_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
            .expect("reconcile retired generation");

        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md"))
                .expect("read reconciled canonical"),
            "# Late retired edit\n"
        );
        let recovery = projection_root_at(&fixture.skillhub_root, "sample").join("recovery");
        assert!(fs::read_dir(recovery)
            .expect("read retained canonical bases")
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("canonical-")));
        fixture.cleanup();
    }

    #[test]
    fn startup_projection_refresh_continues_after_one_bad_skill() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-refresh-best-effort-{}",
            uuid::Uuid::new_v4()
        ));
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = skillhub_root.join("skills");
        let bad = managed_root.join("a-bad");
        let good = managed_root.join("z-good");
        fs::create_dir_all(&bad).expect("create bad Skill");
        fs::create_dir_all(&good).expect("create good Skill");
        fs::write(bad.join("SKILL.md"), "# Bad profile\n").expect("write bad Skill");
        fs::write(bad.join(".skillhub.json"), "{not-json").expect("write invalid profile");
        fs::write(good.join("SKILL.md"), "# Good\n").expect("write good Skill");
        fs::write(
            good.join(".skillhub.json"),
            r#"{"version":"1","skillhub":{"name":"z-good","envDependencies":[]}}"#,
        )
        .expect("write good profile");
        let bad_link = home.join(".codex/skills/a-bad");
        let good_link = home.join(".codex/skills/z-good");
        fs::create_dir_all(bad_link.parent().expect("Agent root")).expect("create Agent root");
        unix_fs::symlink(&bad, &bad_link).expect("link bad canonical Skill");
        unix_fs::symlink(&good, &good_link).expect("link good canonical Skill");

        let error = refresh_installed_projections_at(&home, &skillhub_root, &managed_root)
            .expect_err("bad Skill remains visible as aggregate error");
        assert!(error.contains("a-bad"));
        assert_eq!(
            fs::read_link(&good_link).expect("good Agent link migrated"),
            projection_root_at(&skillhub_root, "z-good").join("current")
        );
        assert!(projection_root_at(&skillhub_root, "a-bad")
            .join(PROJECTION_CONFLICT_NAME)
            .is_file());
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn projection_top_level_add_delete_or_retarget_conflicts() {
        for mutation in ["add", "delete", "retarget"] {
            let fixture = projection_fixture("# Original\n", true);
            match mutation {
                "add" => fs::write(fixture.current.join("extra.txt"), "unexpected")
                    .expect("add top-level file"),
                "delete" => fs::remove_file(fixture.current.join("scripts"))
                    .expect("delete projected resource link"),
                "retarget" => {
                    fs::remove_file(fixture.current.join("scripts"))
                        .expect("remove projected resource link");
                    unix_fs::symlink(&fixture.home, fixture.current.join("scripts"))
                        .expect("retarget projected resource link");
                }
                _ => unreachable!(),
            }
            let error = reconcile_skill_projection_at(
                &fixture.skillhub_root,
                &fixture.managed_root,
                "sample",
            )
            .expect_err("top-level projection mutation must conflict");
            assert!(error.contains("顶层项") || error.contains("根目录结构"));
            assert!(fixture.conflict().is_file());
            fixture.cleanup();
        }
    }

    #[test]
    fn zip_extraction_limits_actual_bytes_not_only_declared_metadata() {
        let mut reader = std::io::repeat(0).take(MAX_ZIP_FILE_BYTES + 1);
        let mut writer = std::io::sink();
        let mut total = 0;
        let result = copy_bounded_zip_entry(
            &mut reader,
            &mut writer,
            &mut total,
            Path::new("oversized.bin"),
        );
        assert!(result.is_err());
        assert_eq!(total, 0);
    }

    #[test]
    fn unmanaged_scan_ignores_residual_directories_for_undetected_agents() {
        let home =
            std::env::temp_dir().join(format!("skillhub-unmanaged-agent-{}", uuid::Uuid::new_v4()));
        let managed_root = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills");
        fs::create_dir_all(home.join(".codex/skills/real-skill"))
            .expect("create detected Agent Skill");
        fs::write(
            home.join(".codex/skills/real-skill/SKILL.md"),
            "# Real Skill\n",
        )
        .expect("write detected Agent Skill");
        fs::create_dir_all(home.join(".openclaw/skills/residual-skill"))
            .expect("create residual Agent Skill");
        fs::write(
            home.join(".openclaw/skills/residual-skill/SKILL.md"),
            "# Residual Skill\n",
        )
        .expect("write residual Agent Skill");

        let detected_agents = HashSet::from(["codex".to_string()]);
        let skills = scan_unmanaged_agent_skills(&home, &managed_root, &detected_agents)
            .expect("scan unmanaged Skills");

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "real-skill");
        assert_eq!(skills[0].sources.len(), 1);
        assert_eq!(skills[0].sources[0].agent_key, "codex");
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn unmanaged_scan_finds_skills_one_level_inside_grouping_folders() {
        let home =
            std::env::temp_dir().join(format!("skillhub-unmanaged-group-{}", uuid::Uuid::new_v4()));
        let managed_root = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills");
        let root = home.join(".claude/skills");
        for (relative, body) in [
            ("top-skill/SKILL.md", "# Top\n"),
            (
                "writing/blog-post/SKILL.md",
                "---\nname: blog-post\ndescription: >\n  Drafts posts.\n---\n",
            ),
            ("writing/notes/readme.md", "not a skill\n"),
            ("writing/deep/nested/SKILL.md", "# Too deep\n"),
        ] {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture");
            fs::write(path, body).expect("write fixture");
        }
        // A grouping folder that is itself a link into SkillHub is ignored.
        fs::create_dir_all(managed_root.join("owned/inner")).expect("create managed skill");
        fs::write(managed_root.join("owned/inner/SKILL.md"), "# Owned\n")
            .expect("write managed skill");
        unix_fs::symlink(managed_root.join("owned"), root.join("owned-group"))
            .expect("link managed group");

        // Production passes the canonical managed root (see
        // `get_unmanaged_agent_skills`); temp dirs are symlinked on macOS.
        let managed_root = fs::canonicalize(&managed_root).expect("canonical managed root");
        let detected = HashSet::from(["claude".to_string()]);
        let skills = scan_unmanaged_agent_skills(&home, &managed_root, &detected)
            .expect("scan grouped Skills");
        let names = skills
            .iter()
            .map(|skill| skill.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names.len(), 2, "{names:?}");
        let grouped = skills
            .iter()
            .find(|skill| skill.name == "blog-post")
            .expect("find grouped Skill");
        assert_eq!(grouped.description.as_deref(), Some("Drafts posts."));
        assert_eq!(grouped.sources[0].group.as_deref(), Some("writing"));
        assert_eq!(grouped.sources[0].entry_name, "blog-post");
        let top = skills
            .iter()
            .find(|skill| skill.name == "top-skill")
            .expect("find top-level Skill");
        assert_eq!(top.sources[0].group, None);
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn library_fingerprint_tracks_skill_changes_without_touching_roots() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-library-fingerprint-{}",
            uuid::Uuid::new_v4()
        ));
        let managed_root = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills");
        fs::create_dir_all(managed_root.join("managed")).expect("create managed skill");
        fs::write(managed_root.join("managed/SKILL.md"), "# Managed\n").expect("write managed");
        fs::create_dir_all(home.join(".claude/skills/native")).expect("create native skill");
        fs::write(home.join(".claude/skills/native/SKILL.md"), "# Native\n").expect("write native");
        let detected = HashSet::from(["claude".to_string()]);
        let fingerprint = || skill_library_fingerprint_at(&home, &managed_root, &detected);

        let initial = fingerprint();
        assert_eq!(initial, fingerprint(), "stable while nothing changes");
        // Roots of undetected Agents are neither read nor created.
        assert!(!home.join(".codex").exists());

        fs::write(
            home.join(".claude/skills/native/SKILL.md"),
            "# Native, edited\n",
        )
        .expect("edit native");
        let edited = fingerprint();
        assert_ne!(initial, edited);

        fs::create_dir_all(home.join(".claude/skills/group/inner")).expect("create group");
        fs::write(
            home.join(".claude/skills/group/inner/SKILL.md"),
            "# Inner\n",
        )
        .expect("write grouped");
        let grouped = fingerprint();
        assert_ne!(edited, grouped);

        fs::create_dir_all(managed_root.join("second")).expect("create second managed");
        assert_ne!(grouped, fingerprint());
        fs::remove_dir_all(home).expect("remove fingerprint fixture");
    }

    #[test]
    fn unmanaged_scan_uses_legacy_generic_identity_for_chatgpt_shared_fallback() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-unmanaged-codex-shared-{}",
            uuid::Uuid::new_v4()
        ));
        let managed_root = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills");
        let shared = home.join(".agents/skills/shared-skill");
        fs::create_dir_all(&shared).expect("create shared Codex Skill");
        fs::write(shared.join("SKILL.md"), "# Shared Skill\n").expect("write shared Codex Skill");

        let none = scan_unmanaged_agent_skills(&home, &managed_root, &HashSet::new())
            .expect("scan without detected Codex");
        assert!(none.is_empty());

        let detected = HashSet::from(["codex".to_string()]);
        let skills = scan_unmanaged_agent_skills(&home, &managed_root, &detected)
            .expect("scan Codex shared root");
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].sources.len(), 1);
        assert_eq!(skills[0].sources[0].agent_key, "agent-skills");
        assert_eq!(skills[0].sources[0].agent_name, "ChatGPT（通用目录）");

        let plan = build_import_preflight_at(&home, &shared, &shared, "shared-skill", &detected)
            .expect("keep the fallback identity through import preflight");
        assert_eq!(plan.sources.len(), 1);
        assert_eq!(plan.sources[0].agent_key, "agent-skills");
        assert_eq!(plan.sources[0].agent_name, "ChatGPT（通用目录）");
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn legacy_agent_skills_adoption_manifests_remain_safely_restorable() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-legacy-agent-skills-{}",
            uuid::Uuid::new_v4()
        ));
        let original = home.join(".agents/skills/legacy-skill");
        let keyed = serde_json::json!({
            "agentKey": "agent-skills",
            "entryName": "legacy-skill"
        });
        let unkeyed = serde_json::json!({ "entryName": "legacy-skill" });

        assert_eq!(
            validate_adoption_original_path(&home, &keyed, &original)
                .expect("accept legacy keyed manifest"),
            "legacy-skill"
        );
        assert_eq!(
            validate_adoption_original_path(&home, &unkeyed, &original)
                .expect("accept legacy unkeyed manifest"),
            "legacy-skill"
        );
    }

    fn create_adoption_fixture(
        home: &Path,
        codex_is_symlink: bool,
    ) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let source = home.join(".claude/skills/sample");
        let codex_entry = home.join(".codex/skills/sample");
        let destination = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills/sample");
        fs::create_dir_all(&source).expect("create native Claude Skill");
        fs::write(source.join("SKILL.md"), "# Original Skill\n").expect("write native Skill");
        fs::create_dir_all(codex_entry.parent().expect("Codex parent"))
            .expect("create Codex skills root");
        if codex_is_symlink {
            unix_fs::symlink(&source, &codex_entry).expect("link Codex to native Skill");
        } else {
            fs::create_dir_all(&codex_entry).expect("create copied Codex Skill");
            fs::write(codex_entry.join("SKILL.md"), "# Original Skill\n")
                .expect("write copied Codex Skill");
        }
        fs::create_dir_all(&destination).expect("create managed copy");
        fs::write(destination.join("SKILL.md"), "# Original Skill\n").expect("write managed copy");
        (source.clone(), destination, source, codex_entry)
    }

    #[test]
    fn adopts_all_native_agent_sources_to_exact_generated_projection() {
        let home =
            std::env::temp_dir().join(format!("skillhub-adopt-success-{}", uuid::Uuid::new_v4()));
        let (source_root, destination, claude_entry, codex_entry) =
            create_adoption_fixture(&home, false);
        let plan =
            build_import_preflight_at(&home, &source_root, &source_root, "sample", &HashSet::new())
                .expect("discover every native source");
        assert_eq!(plan.sources.len(), 2);
        assert!(!plan.has_conflicts);

        let backup = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("adoption-backups/transaction");
        fs::create_dir_all(backup.parent().expect("backup parent")).expect("create backup root");
        let generation = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("projections/sample/generation-test");
        fs::create_dir_all(&generation).expect("create generated projection");
        fs::write(generation.join("SKILL.md"), "# Generated Skill\n")
            .expect("write generated SKILL.md");
        let projection_target = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("projections/sample/current");
        unix_fs::symlink("generation-test", &projection_target)
            .expect("create generated current link");
        adopt_agent_sources_with(
            &source_root,
            &destination,
            &projection_target,
            &backup,
            &plan,
            true,
            |target, link| unix_fs::symlink(target, link).map_err(|error| error.to_string()),
        )
        .expect("adopt native sources");

        for entry in [&claude_entry, &codex_entry] {
            assert!(fs::symlink_metadata(entry)
                .expect("read projection metadata")
                .file_type()
                .is_symlink());
            assert_eq!(
                fs::read_link(entry).expect("exact projection target"),
                projection_target
            );
            assert_eq!(
                fs::canonicalize(entry).expect("canonical projection"),
                fs::canonicalize(&generation).expect("canonical generation")
            );
        }
        let manifest = fs::read_to_string(backup.join("manifest.json"))
            .expect("read completed adoption manifest");
        assert!(manifest.contains("\"status\": \"complete\""));

        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn adoption_projection_failure_restores_every_native_source() {
        let home =
            std::env::temp_dir().join(format!("skillhub-adopt-rollback-{}", uuid::Uuid::new_v4()));
        let (source_root, destination, claude_entry, codex_entry) =
            create_adoption_fixture(&home, true);
        let plan =
            build_import_preflight_at(&home, &source_root, &source_root, "sample", &HashSet::new())
                .expect("discover every native source");
        let backup = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("adoption-backups/transaction");
        fs::create_dir_all(backup.parent().expect("backup parent")).expect("create backup root");
        let projection_target = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("projections/sample/current");
        fs::create_dir_all(projection_target.parent().expect("projection parent"))
            .expect("create projection root");
        unix_fs::symlink("generation-test", &projection_target).expect("create projection target");
        let mut projection_count = 0;
        let error = adopt_agent_sources_with(
            &source_root,
            &destination,
            &projection_target,
            &backup,
            &plan,
            true,
            |target, link| {
                projection_count += 1;
                if projection_count == 2 {
                    return Err("injected projection failure".into());
                }
                unix_fs::symlink(target, link).map_err(|reason| reason.to_string())
            },
        )
        .expect_err("second projection must fail");

        assert!(error.contains("无法创建 Agent 投影"));
        assert!(!destination.exists());
        assert!(!backup.exists());
        assert!(claude_entry.join("SKILL.md").is_file());
        assert!(fs::symlink_metadata(&codex_entry)
            .expect("restored Codex metadata")
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::canonicalize(&claude_entry).expect("canonical restored Claude source"),
            fs::canonicalize(&codex_entry).expect("canonical restored Codex source")
        );
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn adoption_preflight_reports_inconsistent_same_name_skills_without_modifying_them() {
        let home =
            std::env::temp_dir().join(format!("skillhub-adopt-conflict-{}", uuid::Uuid::new_v4()));
        let claude_entry = home.join(".claude/skills/sample");
        let codex_entry = home.join(".codex/skills/sample");
        fs::create_dir_all(&claude_entry).expect("create Claude Skill");
        fs::create_dir_all(&codex_entry).expect("create Codex Skill");
        fs::write(claude_entry.join("SKILL.md"), "# Claude version\n")
            .expect("write Claude version");
        fs::write(codex_entry.join("SKILL.md"), "# Codex version\n").expect("write Codex version");

        let plan = build_import_preflight_at(
            &home,
            &claude_entry,
            &claude_entry,
            "sample",
            &HashSet::new(),
        )
        .expect("inspect inconsistent same-name Skill");
        assert!(plan.has_conflicts);
        assert_eq!(plan.sources.len(), 2);
        assert_eq!(
            plan.sources
                .iter()
                .filter(|source| source.matches_selected)
                .count(),
            1
        );
        assert!(claude_entry.join("SKILL.md").is_file());
        assert!(codex_entry.join("SKILL.md").is_file());
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn install_preflight_reports_only_selected_same_content_agent_entries() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-install-preflight-match-{}",
            uuid::Uuid::new_v4()
        ));
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = skillhub_root.join("skills");
        let source = managed_root.join("sample");
        let codex = home.join(".codex/skills/sample");
        let claude = home.join(".claude/skills/sample");
        for directory in [&source, &codex, &claude] {
            fs::create_dir_all(directory).expect("create Skill directory");
            fs::write(directory.join("SKILL.md"), "# Same\n").expect("write Skill");
        }
        let targets = vec![("codex".into(), "Codex".into(), codex.clone())];
        let plan = build_install_preflight_for_targets(
            &skillhub_root,
            &managed_root,
            &source,
            &skillhub_root.join("projections/sample/current"),
            "sample",
            &targets,
        )
        .expect("preflight selected Agent");

        assert_eq!(plan.sources.len(), 1);
        assert_eq!(plan.sources[0].agent_key, "codex");
        assert!(plan.sources[0].matches_selected);
        assert!(!plan.has_conflicts);
        assert!(codex.join("SKILL.md").is_file());
        assert!(claude.join("SKILL.md").is_file());
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn install_preflight_requires_confirmation_for_different_content_without_modifying_it() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-install-preflight-conflict-{}",
            uuid::Uuid::new_v4()
        ));
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = skillhub_root.join("skills");
        let source = managed_root.join("sample");
        let codex = home.join(".codex/skills/sample");
        fs::create_dir_all(&source).expect("create managed Skill");
        fs::create_dir_all(&codex).expect("create native Skill");
        fs::write(source.join("SKILL.md"), "# Managed\n").expect("write managed Skill");
        fs::write(codex.join("SKILL.md"), "# Native\n").expect("write native Skill");
        let targets = vec![("codex".into(), "Codex".into(), codex.clone())];
        let plan = build_install_preflight_for_targets(
            &skillhub_root,
            &managed_root,
            &source,
            &skillhub_root.join("projections/sample/current"),
            "sample",
            &targets,
        )
        .expect("preflight conflicting Agent");

        assert!(plan.has_conflicts);
        assert!(!plan.sources[0].matches_selected);
        assert_eq!(
            fs::read_to_string(codex.join("SKILL.md")).expect("read untouched native Skill"),
            "# Native\n"
        );
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn install_adoption_preserves_managed_asset_and_remains_restorable() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-install-adoption-restore-{}",
            uuid::Uuid::new_v4()
        ));
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = skillhub_root.join("skills");
        let managed_id = "sample--019f9d24-remote";
        let source = managed_root.join(managed_id);
        let codex = home.join(".codex/skills/sample");
        let projection = skillhub_root
            .join("projections")
            .join(managed_id)
            .join("current");
        fs::create_dir_all(&source).expect("create managed Skill");
        fs::create_dir_all(&codex).expect("create native Skill");
        fs::create_dir_all(&projection).expect("create generated projection");
        fs::write(source.join("SKILL.md"), "# Same\n").expect("write managed Skill");
        fs::write(codex.join("SKILL.md"), "# Same\n").expect("write native Skill");
        fs::write(projection.join("SKILL.md"), "# Projected\n").expect("write projection");
        let targets = vec![("codex".into(), "Codex".into(), codex.clone())];
        let plan = build_install_preflight_for_targets(
            &skillhub_root,
            &managed_root,
            &source,
            &projection,
            managed_id,
            &targets,
        )
        .expect("preflight matching native Skill");
        let backup = skillhub_root.join("adoption-backups/transaction");
        fs::create_dir_all(backup.parent().expect("backup parent")).expect("create backup root");

        adopt_agent_sources_with(
            &source,
            &source,
            &projection,
            &backup,
            &plan,
            false,
            |target, link| unix_fs::symlink(target, link).map_err(|error| error.to_string()),
        )
        .expect("adopt old native directory");
        let manifest =
            fs::read_to_string(backup.join("manifest.json")).expect("read adoption manifest");
        assert!(manifest.contains("\"entryName\": \"sample\""));
        assert!(manifest.contains("\"agentKey\": \"codex\""));
        assert!(source.join("SKILL.md").is_file());
        assert!(fs::symlink_metadata(&codex)
            .expect("read installed projection")
            .file_type()
            .is_symlink());

        restore_adoption_item_at(&home, &backup, &backup.join("manifest.json"))
            .expect("restore original Agent directory");
        assert!(source.join("SKILL.md").is_file());
        assert_eq!(
            fs::read_to_string(codex.join("SKILL.md")).expect("read restored native Skill"),
            "# Same\n"
        );
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn legacy_adoption_manifest_infers_agent_entry_when_managed_id_differs() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-legacy-adoption-name-{}",
            uuid::Uuid::new_v4()
        ));
        let managed_id = "sample--019f9d24-legacy";
        let directory = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("adoption-backups/transaction");
        let backup = directory.join("entries/00-source");
        let original = home.join(".codex/skills/sample");
        let projection = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("projections")
            .join(managed_id)
            .join("current");
        fs::create_dir_all(&backup).expect("create legacy backup");
        fs::write(backup.join("SKILL.md"), "# Legacy original\n").expect("write legacy backup");
        fs::create_dir_all(original.parent().expect("Agent parent")).expect("create Agent root");
        fs::create_dir_all(&projection).expect("create managed projection");
        unix_fs::symlink(&projection, &original).expect("create current projection");
        let manifest_path = directory.join("manifest.json");
        write_private_file(
            &manifest_path,
            &serde_json::to_string_pretty(&serde_json::json!({
                "version": 2,
                "status": "complete",
                "skillId": managed_id,
                "projectionTarget": projection,
                "sources": [{ "original": original, "backup": backup }]
            }))
            .expect("encode legacy manifest"),
        )
        .expect("write legacy manifest");

        restore_adoption_item_at(&home, &directory, &manifest_path)
            .expect("restore legacy basename safely");
        assert_eq!(
            fs::read_to_string(original.join("SKILL.md")).expect("read restored legacy Skill"),
            "# Legacy original\n"
        );
        fs::remove_dir_all(home).expect("remove legacy fixture");
    }

    #[test]
    fn partial_adoption_manifests_restore_real_backups_and_skip_verified_unmoved_sources() {
        for status in ["in_progress", "rollback_incomplete"] {
            let home = std::env::temp_dir().join(format!(
                "skillhub-partial-adoption-{status}-{}",
                uuid::Uuid::new_v4()
            ));
            let managed_id = "sample--019f9d24-partial";
            let directory = home
                .join(if crate::official_channel::CHANNEL == "dev" {
                    ".skillhub-dev"
                } else {
                    ".skillhub"
                })
                .join("adoption-backups/transaction");
            let backup = directory.join("entries/00-source");
            let missing_backup = directory.join("entries/01-source");
            let moved_original = home.join(".claude/skills/sample");
            let unmoved_original = home.join(".codex/skills/sample");
            let projection = home
                .join(if crate::official_channel::CHANNEL == "dev" {
                    ".skillhub-dev"
                } else {
                    ".skillhub"
                })
                .join("projections")
                .join(managed_id)
                .join("current");
            fs::create_dir_all(&backup).expect("create staged backup");
            fs::write(backup.join("SKILL.md"), "# Moved original\n").expect("write staged backup");
            fs::create_dir_all(moved_original.parent().expect("Claude parent"))
                .expect("create Claude root");
            fs::create_dir_all(&unmoved_original).expect("create untouched Codex Skill");
            fs::write(unmoved_original.join("SKILL.md"), "# Unmoved original\n")
                .expect("write untouched Codex Skill");
            fs::create_dir_all(&projection).expect("create partial projection");
            unix_fs::symlink(&projection, &moved_original).expect("create moved projection");
            let unmoved_fingerprint =
                fingerprint_hex(&unmoved_original).expect("fingerprint untouched Codex Skill");
            let manifest_path = directory.join("manifest.json");
            let manifest = serde_json::json!({
                "version": 3,
                "status": status,
                "skillId": managed_id,
                "projectionTarget": projection,
                "sources": [
                    {
                        "agentKey": "claude",
                        "entryName": "sample",
                        "original": moved_original,
                        "backup": backup,
                        "fingerprint": "moved-fingerprint"
                    },
                    {
                        "agentKey": "codex",
                        "entryName": "sample",
                        "original": unmoved_original,
                        "backup": missing_backup,
                        "fingerprint": unmoved_fingerprint
                    }
                ]
            });
            write_private_file(
                &manifest_path,
                &serde_json::to_string_pretty(&manifest).expect("encode partial manifest"),
            )
            .expect("write partial manifest");
            assert!(adoption_manifest_has_backup(&directory, &manifest));

            restore_adoption_item_at(&home, &directory, &manifest_path)
                .expect("restore real backup and skip verified untouched source");
            assert_eq!(
                fs::read_to_string(moved_original.join("SKILL.md"))
                    .expect("read restored moved source"),
                "# Moved original\n"
            );
            assert_eq!(
                fs::read_to_string(unmoved_original.join("SKILL.md"))
                    .expect("read still-unmoved source"),
                "# Unmoved original\n"
            );
            let restored: serde_json::Value = serde_json::from_str(
                &fs::read_to_string(&manifest_path).expect("read restored partial manifest"),
            )
            .expect("parse restored partial manifest");
            assert_eq!(
                restored.get("status").and_then(serde_json::Value::as_str),
                Some("restored")
            );
            fs::remove_dir_all(home).expect("remove partial fixture");
        }
    }

    #[test]
    fn partial_adoption_accepts_verified_dangling_alias_to_a_staged_source() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-partial-adoption-alias-{}",
            uuid::Uuid::new_v4()
        ));
        let directory = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("adoption-backups/transaction");
        let backup = directory.join("entries/00-source");
        let missing_backup = directory.join("entries/01-source");
        let moved_original = home.join(".claude/skills/sample");
        let alias_original = home.join(".codex/skills/sample");
        fs::create_dir_all(&backup).expect("create staged shared source");
        fs::write(backup.join("SKILL.md"), "# Shared native source\n")
            .expect("write staged shared source");
        fs::create_dir_all(moved_original.parent().expect("Claude parent"))
            .expect("create Claude root");
        fs::create_dir_all(alias_original.parent().expect("Codex parent"))
            .expect("create Codex root");
        unix_fs::symlink("../../.claude/skills/sample", &alias_original)
            .expect("create now-dangling relative alias");
        let fingerprint = fingerprint_hex(&backup).expect("fingerprint staged shared source");
        let manifest_path = directory.join("manifest.json");
        write_private_file(
            &manifest_path,
            &serde_json::to_string_pretty(&serde_json::json!({
                "version": 3,
                "status": "in_progress",
                "skillId": "sample--019f9d24-alias",
                "sources": [
                    {
                        "agentKey": "claude", "entryName": "sample",
                        "original": moved_original, "backup": backup,
                        "fingerprint": fingerprint
                    },
                    {
                        "agentKey": "codex", "entryName": "sample",
                        "original": alias_original, "backup": missing_backup,
                        "fingerprint": fingerprint
                    }
                ]
            }))
            .expect("encode alias manifest"),
        )
        .expect("write alias manifest");

        restore_adoption_item_at(&home, &directory, &manifest_path)
            .expect("restore staged source while preserving verified alias");
        assert_eq!(
            fs::canonicalize(&alias_original).expect("resolve restored alias"),
            fs::canonicalize(&moved_original).expect("resolve restored source")
        );
        fs::remove_dir_all(home).expect("remove alias fixture");
    }

    #[test]
    fn partial_adoption_rejects_missing_backup_when_original_changed() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-partial-adoption-unsafe-{}",
            uuid::Uuid::new_v4()
        ));
        let directory = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("adoption-backups/transaction");
        let backup = directory.join("entries/00-source");
        let missing_backup = directory.join("entries/01-source");
        let moved_original = home.join(".claude/skills/sample");
        let changed_original = home.join(".codex/skills/sample");
        let projection = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("projections/sample/current");
        fs::create_dir_all(&backup).expect("create staged backup");
        fs::write(backup.join("SKILL.md"), "# Original\n").expect("write staged backup");
        fs::create_dir_all(moved_original.parent().expect("Claude parent"))
            .expect("create Claude root");
        fs::create_dir_all(&changed_original).expect("create changed source");
        fs::write(changed_original.join("SKILL.md"), "# Changed\n").expect("write changed source");
        fs::create_dir_all(&projection).expect("create projection");
        unix_fs::symlink(&projection, &moved_original).expect("create moved projection");
        let manifest_path = directory.join("manifest.json");
        write_private_file(
            &manifest_path,
            &serde_json::to_string_pretty(&serde_json::json!({
                "version": 3,
                "status": "in_progress",
                "skillId": "sample",
                "projectionTarget": projection,
                "sources": [
                    {
                        "agentKey": "claude", "entryName": "sample",
                        "original": moved_original, "backup": backup,
                        "fingerprint": "moved"
                    },
                    {
                        "agentKey": "codex", "entryName": "sample",
                        "original": changed_original, "backup": missing_backup,
                        "fingerprint": "confirmed-before-change"
                    }
                ]
            }))
            .expect("encode unsafe partial manifest"),
        )
        .expect("write unsafe partial manifest");

        let error = restore_adoption_item_at(&home, &directory, &manifest_path)
            .expect_err("changed source must prevent partial recovery");
        assert!(error.contains("内容已经变化"));
        assert!(backup.join("SKILL.md").is_file());
        assert!(fs::symlink_metadata(&moved_original)
            .expect("moved projection preserved")
            .file_type()
            .is_symlink());
        fs::remove_dir_all(home).expect("remove unsafe partial fixture");
    }

    #[test]
    fn install_adoption_failure_restores_sources_without_removing_managed_asset() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-install-adoption-rollback-{}",
            uuid::Uuid::new_v4()
        ));
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = skillhub_root.join("skills");
        let source = managed_root.join("sample");
        let codex = home.join(".codex/skills/sample");
        let claude = home.join(".claude/skills/sample");
        let projection = skillhub_root.join("projections/sample/current");
        for directory in [&source, &codex, &claude, &projection] {
            fs::create_dir_all(directory).expect("create Skill directory");
            fs::write(directory.join("SKILL.md"), "# Same\n").expect("write Skill");
        }
        let targets = vec![
            ("codex".into(), "Codex".into(), codex.clone()),
            ("claude".into(), "Claude Code".into(), claude.clone()),
        ];
        let plan = build_install_preflight_for_targets(
            &skillhub_root,
            &managed_root,
            &source,
            &projection,
            "sample",
            &targets,
        )
        .expect("preflight native copies");
        let backup = skillhub_root.join("adoption-backups/transaction");
        fs::create_dir_all(backup.parent().expect("backup parent")).expect("create backup root");
        let mut created = 0;
        let error = adopt_agent_sources_with(
            &source,
            &source,
            &projection,
            &backup,
            &plan,
            false,
            |target, link| {
                created += 1;
                if created == 2 {
                    return Err("injected projection failure".into());
                }
                unix_fs::symlink(target, link).map_err(|reason| reason.to_string())
            },
        )
        .expect_err("second projection must fail");

        assert!(error.contains("无法创建 Agent 投影"));
        assert!(source.join("SKILL.md").is_file());
        assert!(codex.join("SKILL.md").is_file());
        assert!(claude.join("SKILL.md").is_file());
        assert!(!backup.exists());
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn confirmed_same_name_conflict_is_backed_up_projected_and_restorable() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-adopt-conflict-restore-{}",
            uuid::Uuid::new_v4()
        ));
        let claude_entry = home.join(".claude/skills/sample");
        let codex_entry = home.join(".codex/skills/sample");
        let destination = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills/sample");
        fs::create_dir_all(&claude_entry).expect("create Claude Skill");
        fs::create_dir_all(&codex_entry).expect("create Codex Skill");
        fs::create_dir_all(&destination).expect("create managed copy");
        fs::write(claude_entry.join("SKILL.md"), "# Claude version\n")
            .expect("write Claude version");
        fs::write(codex_entry.join("SKILL.md"), "# Codex version\n").expect("write Codex version");
        fs::write(destination.join("SKILL.md"), "# Claude version\n")
            .expect("write canonical version");
        let plan = build_import_preflight_at(
            &home,
            &claude_entry,
            &claude_entry,
            "sample",
            &HashSet::new(),
        )
        .expect("build conflict plan");
        assert!(plan.has_conflicts);

        let projection_generation = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("projections/sample/generation-test");
        fs::create_dir_all(&projection_generation).expect("create projection generation");
        fs::write(projection_generation.join("SKILL.md"), "# Claude version\n")
            .expect("write projected Skill");
        let projection_target = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("projections/sample/current");
        unix_fs::symlink("generation-test", &projection_target).expect("create projection target");
        let backup = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("adoption-backups/transaction");
        fs::create_dir_all(backup.parent().expect("backup parent")).expect("create backup root");

        adopt_agent_sources_with(
            &claude_entry,
            &destination,
            &projection_target,
            &backup,
            &plan,
            true,
            |target, link| unix_fs::symlink(target, link).map_err(|error| error.to_string()),
        )
        .expect("adopt confirmed conflicting sources");
        assert!(fs::symlink_metadata(&claude_entry)
            .expect("Claude projection")
            .file_type()
            .is_symlink());
        assert!(fs::symlink_metadata(&codex_entry)
            .expect("Codex projection")
            .file_type()
            .is_symlink());

        restore_adoption_item_at(&home, &backup, &backup.join("manifest.json"))
            .expect("restore both Agent originals");
        assert_eq!(
            fs::read_to_string(claude_entry.join("SKILL.md")).expect("read Claude original"),
            "# Claude version\n"
        );
        assert_eq!(
            fs::read_to_string(codex_entry.join("SKILL.md")).expect("read Codex original"),
            "# Codex version\n"
        );
        let restored_manifest =
            fs::read_to_string(backup.join("manifest.json")).expect("read restored manifest");
        assert!(restored_manifest.contains("\"status\": \"restored\""));
        assert!(destination.join("SKILL.md").is_file());
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn recovery_ids_reject_root_alias_segments() {
        for segment in ["", ".", "..", "bad/name"] {
            assert!(
                recovery_id_segment(segment).is_err(),
                "accepted {segment:?}"
            );
        }
        assert_eq!(
            recovery_id_segment("sample-1234").expect("valid recovery id"),
            "sample-1234"
        );
    }

    #[test]
    fn adoption_restore_rejects_manifest_backup_parent_traversal() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-adoption-traversal-{}",
            uuid::Uuid::new_v4()
        ));
        let directory = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("adoption-backups/transaction");
        let entries = directory.join("entries");
        let outside = directory.join("outside");
        let original = home.join(".claude/skills/sample");
        let projection = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("projections/sample/current");
        fs::create_dir_all(&entries).expect("create entries");
        fs::create_dir_all(&outside).expect("create outside backup");
        fs::create_dir_all(original.parent().expect("Agent parent")).expect("create Agent root");
        fs::create_dir_all(projection.parent().expect("projection parent"))
            .expect("create projection root");
        unix_fs::symlink(&projection, &original).expect("create current projection");
        fs::write(outside.join("SKILL.md"), "# Outside\n").expect("write outside backup");
        let manifest_path = directory.join("manifest.json");
        write_private_file(
            &manifest_path,
            &serde_json::to_string_pretty(&serde_json::json!({
                "version": 2,
                "status": "complete",
                "skillId": "sample",
                "projectionTarget": projection,
                "sources": [{
                    "original": original,
                    "backup": entries.join("../outside")
                }]
            }))
            .expect("encode manifest"),
        )
        .expect("write manifest");

        let error = restore_adoption_item_at(&home, &directory, &manifest_path)
            .expect_err("parent traversal must fail before any rename");
        assert!(error.contains("越界路径"));
        assert!(outside.join("SKILL.md").is_file());
        assert!(fs::symlink_metadata(&original)
            .expect("original projection preserved")
            .file_type()
            .is_symlink());
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn adoption_restore_rechecks_isolated_agent_link_before_replacing_it() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-adoption-restore-race-{}",
            uuid::Uuid::new_v4()
        ));
        let directory = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("adoption-backups/transaction");
        let backup = directory.join("entries/00-source");
        let original = home.join(".claude/skills/sample");
        let projection = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("projections/sample/current");
        fs::create_dir_all(&backup).expect("create backup");
        fs::write(backup.join("SKILL.md"), "# Original\n").expect("write backup Skill");
        fs::create_dir_all(original.parent().expect("Agent parent")).expect("create Agent root");
        fs::create_dir_all(projection.parent().expect("projection parent"))
            .expect("create projection root");
        unix_fs::symlink(&projection, &original).expect("create current projection");
        let manifest_path = directory.join("manifest.json");
        write_private_file(
            &manifest_path,
            &serde_json::to_string_pretty(&serde_json::json!({
                "version": 2,
                "status": "complete",
                "skillId": "sample",
                "projectionTarget": projection,
                "sources": [{ "original": original, "backup": backup }]
            }))
            .expect("encode manifest"),
        )
        .expect("write manifest");
        let original_for_race = original.clone();

        let error =
            restore_adoption_item_at_with_hook(&home, &directory, &manifest_path, move || {
                fs::remove_file(&original_for_race).expect("remove checked projection");
                fs::create_dir(&original_for_race).expect("install concurrent user directory");
                fs::write(
                    original_for_race.join("SKILL.md"),
                    "# Concurrent user content\n",
                )
                .expect("write concurrent content");
            })
            .expect_err("changed original must not be replaced");
        assert!(error.contains("发生变化"));
        assert_eq!(
            fs::read_to_string(original.join("SKILL.md")).expect("read restored user content"),
            "# Concurrent user content\n"
        );
        assert!(backup.join("SKILL.md").is_file());
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn changed_same_name_source_invalidates_the_confirmed_plan_before_any_move() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-adopt-conflict-race-{}",
            uuid::Uuid::new_v4()
        ));
        let claude_entry = home.join(".claude/skills/sample");
        let codex_entry = home.join(".codex/skills/sample");
        let destination = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills/sample");
        fs::create_dir_all(&claude_entry).expect("create Claude Skill");
        fs::create_dir_all(&codex_entry).expect("create Codex Skill");
        fs::create_dir_all(&destination).expect("create managed copy");
        fs::write(claude_entry.join("SKILL.md"), "# Claude version\n")
            .expect("write Claude version");
        fs::write(codex_entry.join("SKILL.md"), "# Codex version\n").expect("write Codex version");
        fs::write(destination.join("SKILL.md"), "# Claude version\n")
            .expect("write canonical version");
        let plan = build_import_preflight_at(
            &home,
            &claude_entry,
            &claude_entry,
            "sample",
            &HashSet::new(),
        )
        .expect("build conflict plan");
        fs::write(
            codex_entry.join("SKILL.md"),
            "# Changed after confirmation\n",
        )
        .expect("mutate Codex Skill");
        let projection_target = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("projections/sample/current");
        fs::create_dir_all(projection_target.parent().expect("projection parent"))
            .expect("create projection parent");
        let backup = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("adoption-backups/transaction");
        fs::create_dir_all(backup.parent().expect("backup parent")).expect("create backup root");

        let error = adopt_agent_sources_with(
            &claude_entry,
            &destination,
            &projection_target,
            &backup,
            &plan,
            true,
            |target, link| unix_fs::symlink(target, link).map_err(|reason| reason.to_string()),
        )
        .expect_err("changed source must invalidate plan");
        assert!(error.contains("发生变化"));
        assert!(claude_entry.join("SKILL.md").is_file());
        assert!(codex_entry.join("SKILL.md").is_file());
        assert!(!backup.exists());
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn managed_trash_restore_moves_asset_projection_and_env_back_without_overwrite() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-managed-trash-restore-{}",
            uuid::Uuid::new_v4()
        ));
        let root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = root.join("skills");
        let transaction = root.join("trash/item");
        fs::create_dir_all(transaction.join("skill")).expect("create recovered Skill");
        fs::create_dir_all(transaction.join("projection")).expect("create recovered projection");
        fs::create_dir_all(transaction.join("env")).expect("create recovered env");
        fs::write(transaction.join("skill/SKILL.md"), "# Restored\n")
            .expect("write recovered Skill");
        fs::write(transaction.join("projection/marker"), "projection")
            .expect("write recovered projection");
        fs::write(transaction.join("env/0.env"), "API_KEY='value'\n").expect("write recovered env");
        let manifest_path = transaction.join("recovery-manifest.json");
        write_private_file(
            &manifest_path,
            &serde_json::to_string_pretty(&serde_json::json!({
                "version": 2,
                "kind": "managed_asset",
                "status": "trashed",
                "skillId": "sample",
                "skillRecoveryPath": "skill",
                "projectionRecoveryPath": "projection",
                "envFiles": [{
                    "recoveryPath": "env/0.env",
                    "originalRelativePath": "envs/sample.env"
                }]
            }))
            .expect("encode manifest"),
        )
        .expect("write manifest");

        restore_managed_item_at(&root, &managed_root, &transaction, &manifest_path)
            .expect("restore managed asset");
        assert!(managed_root.join("sample/SKILL.md").is_file());
        assert!(root.join("projections/sample/marker").is_file());
        assert_eq!(
            fs::read_to_string(root.join("envs/sample.env")).expect("read restored env"),
            "API_KEY='value'\n"
        );
        assert!(fs::read_to_string(&manifest_path)
            .expect("read restored manifest")
            .contains("\"status\": \"restored\""));
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn managed_trash_restore_uses_the_verified_manifest_snapshot() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-managed-trash-snapshot-{}",
            uuid::Uuid::new_v4()
        ));
        let root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = root.join("skills");
        let transaction = root.join("trash/item");
        fs::create_dir_all(transaction.join("skill")).expect("create recovered Skill");
        fs::create_dir_all(transaction.join("env")).expect("create recovered env");
        fs::write(transaction.join("skill/SKILL.md"), "# Restored\n")
            .expect("write recovered Skill");
        fs::write(transaction.join("env/0.env"), "API_KEY='value'\n").expect("write recovered env");
        let verified_manifest = serde_json::json!({
            "version": 2,
            "kind": "managed_asset",
            "status": "trashed",
            "skillId": "sample",
            "skillRecoveryPath": "skill",
            "projectionRecoveryPath": null,
            "envFiles": [{
                "recoveryPath": "env/0.env",
                "originalRelativePath": "envs/sample.env"
            }]
        });
        let manifest_path = transaction.join("recovery-manifest.json");
        write_private_file(
            &manifest_path,
            &serde_json::to_string_pretty(&serde_json::json!({
                "version": 2,
                "kind": "managed_asset",
                "status": "trashed",
                "skillId": "swapped",
                "skillRecoveryPath": "skill",
                "projectionRecoveryPath": null,
                "envFiles": [{
                    "recoveryPath": "env/0.env",
                    "originalRelativePath": "envs/swapped.env"
                }]
            }))
            .expect("encode swapped manifest"),
        )
        .expect("write swapped manifest");

        restore_managed_trash_item_from_snapshot_at(
            &root,
            &managed_root,
            "managed:item",
            verified_manifest,
        )
        .expect("restore from verified snapshot");

        assert!(managed_root.join("sample/SKILL.md").is_file());
        assert!(!managed_root.join("swapped").exists());
        assert!(root.join("envs/sample.env").is_file());
        assert!(!root.join("envs/swapped.env").exists());
        let stored_manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(&manifest_path).expect("read updated manifest"),
        )
        .expect("parse updated manifest");
        assert_eq!(
            stored_manifest
                .get("skillId")
                .and_then(serde_json::Value::as_str),
            Some("sample")
        );
        assert_eq!(
            stored_manifest
                .get("status")
                .and_then(serde_json::Value::as_str),
            Some("restored")
        );
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn uninstall_removes_only_verified_skillhub_projections() {
        let home =
            std::env::temp_dir().join(format!("skillhub-uninstall-safe-{}", uuid::Uuid::new_v4()));
        let managed_root = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills");
        let destination = managed_root.join("sample");
        let codex_entry = home.join(".codex/skills/sample");
        let claude_entry = home.join(".claude/skills/sample");
        fs::create_dir_all(&destination).expect("create managed Skill");
        fs::write(destination.join("SKILL.md"), "# Managed\n").expect("write managed Skill");
        fs::create_dir_all(codex_entry.parent().expect("Codex parent")).expect("create Codex root");
        unix_fs::symlink(&destination, &codex_entry).expect("create managed projection");
        fs::create_dir_all(&claude_entry).expect("create unrelated native Skill");
        fs::write(claude_entry.join("SKILL.md"), "# User-owned\n")
            .expect("write unrelated native Skill");

        uninstall_skill_projections(&home, &managed_root, "sample")
            .expect("uninstall managed projections");
        assert!(fs::symlink_metadata(&codex_entry).is_err());
        assert_eq!(
            fs::read_to_string(claude_entry.join("SKILL.md")).expect("read user-owned Skill"),
            "# User-owned\n"
        );
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn projection_name_is_independent_from_managed_folder_id() {
        let home =
            std::env::temp_dir().join(format!("skillhub-projection-name-{}", uuid::Uuid::new_v4()));
        let managed_root = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills");
        let destination = managed_root.join("sample-server-a1b2c3d4");
        let codex_entry = home.join(".codex/skills/sample");
        fs::create_dir_all(&destination).expect("create managed Skill");
        fs::write(destination.join("SKILL.md"), "# Managed\n").expect("write managed Skill");
        fs::write(
            destination.join(".skillhub.json"),
            r#"{"version":"1.0","skillhub":{"name":"sample"}}"#,
        )
        .expect("write profile");
        fs::create_dir_all(codex_entry.parent().expect("Codex parent")).expect("create Codex root");
        unix_fs::symlink(&destination, &codex_entry).expect("create named projection");

        uninstall_skill_projections(&home, &managed_root, "sample-server-a1b2c3d4")
            .expect("uninstall by managed id");
        assert!(fs::symlink_metadata(&codex_entry).is_err());
        assert!(destination.is_dir());
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn install_rejects_projection_owned_by_another_skillhub_asset() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-projection-conflict-{}",
            uuid::Uuid::new_v4()
        ));
        let managed_root = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills");
        let first = managed_root.join("sample-server-a");
        let second = managed_root.join("sample-server-b");
        let projection = home.join(".codex/skills/sample");
        fs::create_dir_all(&first).expect("create first asset");
        fs::create_dir_all(&second).expect("create second asset");
        fs::create_dir_all(projection.parent().expect("projection parent"))
            .expect("create projection root");
        unix_fs::symlink(&first, &projection).expect("project first asset");

        let error =
            install_skill_projections_with(&second, vec![projection.clone()], |target, link| {
                unix_fs::symlink(target, link).map_err(|reason| reason.to_string())
            })
            .expect_err("same projection name must not overwrite first asset");
        assert!(error.contains("另一个 SkillHub 资产"));
        assert!(is_symlink_to_path(&projection, &first));
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn install_projection_failure_rolls_back_only_links_created_by_this_attempt() {
        let home =
            std::env::temp_dir().join(format!("skillhub-install-atomic-{}", uuid::Uuid::new_v4()));
        let source = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills/sample");
        let existing = home.join(".codex/skills/sample");
        let first_new = home.join(".claude/skills/sample");
        let failing_new = home.join(".agents/skills/sample");
        fs::create_dir_all(&source).expect("create managed Skill");
        fs::write(source.join("SKILL.md"), "# Managed\n").expect("write managed Skill");
        fs::create_dir_all(existing.parent().expect("existing parent"))
            .expect("create existing Agent root");
        unix_fs::symlink(&source, &existing).expect("create pre-existing projection");

        let mut attempts = 0;
        let error = install_skill_projections_with(
            &source,
            vec![existing.clone(), first_new.clone(), failing_new.clone()],
            |target, link| {
                attempts += 1;
                unix_fs::symlink(target, link).map_err(|reason| reason.to_string())?;
                if attempts == 2 {
                    return Err("injected install projection failure".into());
                }
                Ok(())
            },
        )
        .expect_err("second new projection must fail");

        assert!(error.contains("injected install projection failure"));
        assert!(is_symlink_to_path(&existing, &source));
        assert!(fs::symlink_metadata(&first_new).is_err());
        assert!(fs::symlink_metadata(&failing_new).is_err());
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn uninstall_projection_failure_restores_every_link_removed_by_this_attempt() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-uninstall-atomic-{}",
            uuid::Uuid::new_v4()
        ));
        let source = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills/sample");
        let first = home.join(".codex/skills/sample");
        let failing = home.join(".claude/skills/sample");
        let unrelated = home.join(".agents/skills/sample");
        fs::create_dir_all(&source).expect("create managed Skill");
        fs::write(source.join("SKILL.md"), "# Managed\n").expect("write managed Skill");
        for link in [&first, &failing] {
            fs::create_dir_all(link.parent().expect("projection parent"))
                .expect("create Agent root");
            unix_fs::symlink(&source, link).expect("create managed projection");
        }
        fs::create_dir_all(&unrelated).expect("create unrelated native Skill");
        fs::write(unrelated.join("SKILL.md"), "# User-owned\n")
            .expect("write unrelated native Skill");

        let mut removals = 0;
        let error = uninstall_projection_links_with(
            &source,
            vec![first.clone(), failing.clone()],
            |link| {
                removals += 1;
                fs::remove_file(link).map_err(|reason| reason.to_string())?;
                if removals == 2 {
                    return Err("injected uninstall projection failure".into());
                }
                Ok(())
            },
            |target, link| unix_fs::symlink(target, link).map_err(|reason| reason.to_string()),
        )
        .expect_err("second projection removal must fail");

        assert!(error.contains("injected uninstall projection failure"));
        assert!(is_symlink_to_path(&first, &source));
        assert!(is_symlink_to_path(&failing, &source));
        assert_eq!(
            fs::read_to_string(unrelated.join("SKILL.md")).expect("read unrelated Skill"),
            "# User-owned\n"
        );
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn skips_only_local_environment_and_generated_paths() {
        assert!(should_skip(Path::new(".env")));
        assert!(should_skip(Path::new(".envrc")));
        assert!(!should_skip(Path::new("scripts/credentials.json")));
        assert!(!should_skip(Path::new("private.pem")));
        assert!(!should_skip(Path::new("keys/signing.KEY")));
        assert!(!should_skip(Path::new(".aws/credentials")));
        assert!(!should_skip(Path::new(
            "references/wiki/concepts/external-secrets.md"
        )));
        assert!(should_skip(Path::new("node_modules/example/index.js")));
        assert!(!should_skip(Path::new("references/guide.md")));
    }

    #[test]
    fn generated_package_allows_previously_blocked_file_names() {
        let directory =
            std::env::temp_dir().join(format!("skillhub-package-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(directory.join("references")).expect("create references directory");
        fs::create_dir_all(directory.join(".aws")).expect("create credential directory");
        fs::write(directory.join("SKILL.md"), "# Safe Skill\n").expect("write skill");
        fs::write(directory.join("references/guide.md"), "safe\n").expect("write guide");
        fs::write(directory.join("private.pem"), "PRIVATE KEY\n").expect("write pem");
        fs::write(directory.join("id_rsa.key"), "PRIVATE KEY\n").expect("write key");
        fs::write(
            directory.join("credentials.json"),
            "{\"token\":\"secret\"}\n",
        )
        .expect("write credentials");
        fs::write(directory.join(".npmrc"), "//registry/:_authToken=secret\n")
            .expect("write npm credentials");
        fs::write(
            directory.join(".aws/credentials"),
            "aws_secret_access_key=secret\n",
        )
        .expect("write aws credentials");

        create_skill_package_from_root(&directory)
            .expect("file names must not block personal Skill synchronization");
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn tree_policy_rejects_deep_special_and_oversized_inputs() {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let root = PathBuf::from("/tmp").join(format!("sh-tree-{}", &token[..8]));
        fs::create_dir_all(&root).expect("create tree root");
        fs::write(root.join("SKILL.md"), "# Test\n").expect("write skill");

        let mut deep = root.clone();
        for index in 0..11 {
            deep.push(format!("level-{index}"));
        }
        fs::create_dir_all(&deep).expect("create deep tree");
        let error = skill_tree_fingerprint(&root).expect_err("reject truncated depth");
        assert!(error.contains("超过 10 层"));
        fs::remove_dir_all(root.join("level-0")).expect("remove deep tree");

        let socket_path = root.join("runtime.sock");
        let socket = std::os::unix::net::UnixListener::bind(&socket_path).expect("create socket");
        let destination = root.with_extension("copy");
        let error = copy_dir(&root, &destination).expect_err("reject special file");
        assert!(error.to_string().contains("不支持的文件类型"));
        drop(socket);
        fs::remove_file(&socket_path).expect("remove socket");

        let oversized = root.join("oversized.bin");
        fs::File::create(&oversized)
            .expect("create sparse file")
            .set_len(MAX_SKILL_FILE_BYTES + 1)
            .expect("size sparse file");
        let error = collect_skill_tree(&root).expect_err("reject oversized file");
        assert!(error.contains("单个文件超过 20 MB"));
        fs::remove_dir_all(root).expect("remove tree root");
        let _ = fs::remove_dir_all(destination);
    }

    #[test]
    fn zip_entry_type_policy_rejects_special_and_path_mode_mismatches() {
        assert!(zip_entry_type_is_supported(None, false));
        assert!(zip_entry_type_is_supported(Some(0o100644), false));
        assert!(zip_entry_type_is_supported(Some(0o040755), true));
        assert!(!zip_entry_type_is_supported(Some(0o010644), false));
        assert!(!zip_entry_type_is_supported(Some(0o020644), false));
        assert!(!zip_entry_type_is_supported(Some(0o060644), false));
        assert!(!zip_entry_type_is_supported(Some(0o120777), false));
        assert!(!zip_entry_type_is_supported(Some(0o140644), false));
        assert!(!zip_entry_type_is_supported(Some(0o040755), false));
        assert!(!zip_entry_type_is_supported(Some(0o100644), true));
        assert_eq!(canonical_archive_file_mode(None), 0o644);
        assert_eq!(canonical_archive_file_mode(Some(0o106777)), 0o755);
        assert_eq!(canonical_archive_file_mode(Some(0o101666)), 0o644);
    }

    #[test]
    fn tree_policy_prunes_generated_paths_but_allows_descriptive_file_names() {
        let root =
            std::env::temp_dir().join(format!("skillhub-tree-policy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".git/objects")).expect("create Git metadata");
        fs::write(root.join("SKILL.md"), "# Test\n").expect("write skill");
        fs::write(root.join(".git/objects/generated"), "ignored\n").expect("write Git object");
        let entries = collect_skill_tree(&root).expect("Git metadata is explicitly pruned");
        assert_eq!(
            entries
                .iter()
                .filter(|entry| !entry.is_directory)
                .map(|entry| entry.normalized.as_str())
                .collect::<Vec<_>>(),
            vec!["SKILL.md"]
        );

        unix_fs::symlink("/tmp", root.join("node_modules")).expect("create generated-path symlink");
        let error = collect_skill_tree(&root).expect_err("generated-path symlinks still fail");
        assert!(error.contains("符号链接"));
        fs::remove_file(root.join("node_modules")).expect("remove generated-path symlink");

        fs::write(root.join(".env"), "TOKEN=real-value\n").expect("write local env file");
        let entries = collect_skill_tree(&root).expect("local env files are captured separately");
        assert!(!entries.iter().any(|entry| entry.normalized == ".env"));

        fs::create_dir_all(root.join("references/wiki/concepts"))
            .expect("create documentation directories");
        fs::write(root.join("credentials.json"), "secret").expect("write credential guide");
        fs::write(
            root.join("references/wiki/concepts/external-secrets.md"),
            "# External secrets\n",
        )
        .expect("write external secrets guide");
        let entries = collect_skill_tree(&root).expect("descriptive names must be importable");
        assert!(entries
            .iter()
            .any(|entry| entry.normalized == "credentials.json"));
        assert!(entries
            .iter()
            .any(|entry| { entry.normalized == "references/wiki/concepts/external-secrets.md" }));
        fs::remove_dir_all(root).expect("remove tree root");
    }

    #[test]
    fn local_env_values_are_detected_but_never_enter_the_managed_tree_or_package() {
        let root =
            std::env::temp_dir().join(format!("skillhub-env-capture-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create env capture fixture");
        fs::write(root.join("SKILL.md"), "# Env capture\n").expect("write skill");
        fs::create_dir_all(root.join("scripts")).expect("create scripts directory");
        fs::write(root.join("scripts/run.py"), "print('safe')\n").expect("write script");
        fs::write(
            root.join(".env"),
            "OPENAI_API_KEY='base-secret'\nSHARED_KEY='base'\n",
        )
        .expect("write base env");
        fs::write(root.join(".env.local"), "SHARED_KEY='local-secret'\n")
            .expect("write local override");
        fs::write(root.join("scripts/.env"), "NESTED_KEY='nested-secret'\n")
            .expect("write nested env");

        let values = discover_skill_env_values(&root).expect("capture env values");
        assert_eq!(
            values.get("OPENAI_API_KEY").map(String::as_str),
            Some("base-secret")
        );
        assert_eq!(
            values.get("SHARED_KEY").map(String::as_str),
            Some("local-secret")
        );
        assert_eq!(
            values.get("NESTED_KEY").map(String::as_str),
            Some("nested-secret")
        );

        let resources = canonical_resource_names(&root).expect("read safe projection resources");
        assert!(!resources.contains(&".env".to_string()));
        assert!(!resources.contains(&".env.local".to_string()));
        assert!(!resources.contains(&"scripts".to_string()));

        let entries = collect_skill_tree(&root).expect("collect sanitized tree");
        assert_eq!(
            entries
                .iter()
                .filter(|entry| !entry.is_directory)
                .map(|entry| entry.normalized.as_str())
                .collect::<Vec<_>>(),
            vec!["SKILL.md", "scripts/run.py"]
        );
        let package = create_skill_package_from_root(&root).expect("create sanitized package");
        let bytes = BASE64.decode(package.base64).expect("decode package");
        let package_text = String::from_utf8_lossy(&bytes);
        assert!(!package_text.contains("base-secret"));
        assert!(!package_text.contains("local-secret"));
        assert!(!package_text.contains("nested-secret"));
        let mut archive = ZipArchive::new(Cursor::new(bytes)).expect("open package");
        let names = (0..archive.len())
            .map(|index| {
                archive
                    .by_index(index)
                    .expect("read package entry")
                    .name()
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["SKILL.md", "scripts/run.py"]);

        let backup_root = root.with_extension("env-backups");
        archive_captured_skill_env_files_at(&root, "test-skill", &backup_root)
            .expect("archive captured env files");
        assert!(!root.join(".env").exists());
        assert!(!root.join(".env.local").exists());
        assert!(!root.join("scripts/.env").exists());
        let archived_contents = WalkDir::new(&backup_root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| fs::read_to_string(entry.path()).expect("read archived env"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(archived_contents.contains("base-secret"));
        assert!(archived_contents.contains("local-secret"));
        assert!(archived_contents.contains("nested-secret"));
        fs::remove_dir_all(root).expect("remove env capture fixture");
        fs::remove_dir_all(backup_root).expect("remove env backup fixture");
    }

    #[test]
    fn generated_package_is_deterministic_across_irrelevant_permissions() {
        let first =
            std::env::temp_dir().join(format!("skillhub-package-a-{}", uuid::Uuid::new_v4()));
        let second =
            std::env::temp_dir().join(format!("skillhub-package-b-{}", uuid::Uuid::new_v4()));
        for directory in [&first, &second] {
            fs::create_dir_all(directory.join("references")).expect("create package fixture");
            fs::create_dir_all(directory.join("scripts")).expect("create script fixture");
        }
        fs::write(first.join("SKILL.md"), "# Stable Skill\n").expect("write first Skill");
        fs::write(first.join("references/zeta.md"), "zeta\n").expect("write first zeta");
        fs::write(first.join("references/alpha.md"), "alpha\n").expect("write first alpha");
        fs::write(first.join("scripts/run.sh"), "#!/bin/sh\nprintf 'ok\\n'\n")
            .expect("write first script");
        fs::write(second.join("scripts/run.sh"), "#!/bin/sh\nprintf 'ok\\n'\n")
            .expect("write second script");
        fs::write(second.join("references/alpha.md"), "alpha\n").expect("write second alpha");
        fs::write(second.join("references/zeta.md"), "zeta\n").expect("write second zeta");
        fs::write(second.join("SKILL.md"), "# Stable Skill\n").expect("write second Skill");
        fs::set_permissions(first.join("SKILL.md"), fs::Permissions::from_mode(0o666))
            .expect("change first mode");
        fs::set_permissions(second.join("SKILL.md"), fs::Permissions::from_mode(0o400))
            .expect("change second mode");
        fs::set_permissions(
            first.join("scripts/run.sh"),
            fs::Permissions::from_mode(0o777),
        )
        .expect("change first script mode");
        fs::set_permissions(
            second.join("scripts/run.sh"),
            fs::Permissions::from_mode(0o500),
        )
        .expect("change second script mode");

        let package_a = create_skill_package_from_root(&first).expect("package first fixture");
        let package_b = create_skill_package_from_root(&second).expect("package second fixture");
        assert_eq!(package_a.sha256, package_b.sha256);
        assert_eq!(package_a.base64, package_b.base64);

        let bytes = BASE64
            .decode(package_a.base64)
            .expect("decode deterministic package");
        let mut archive = ZipArchive::new(Cursor::new(bytes)).expect("open deterministic package");
        let mut names = Vec::new();
        for index in 0..archive.len() {
            let entry = archive.by_index(index).expect("read deterministic entry");
            names.push(entry.name().to_string());
            assert_eq!(entry.last_modified(), Some(zip::DateTime::default()));
            let expected_mode = if entry.name() == "scripts/run.sh" {
                0o755
            } else {
                0o644
            };
            let archive_mode = entry.unix_mode().expect("read canonical Unix mode");
            assert_eq!(archive_mode & 0o170000, 0o100000);
            assert_eq!(archive_mode & 0o777, expected_mode);
        }
        let mut sorted_names = names.clone();
        sorted_names.sort();
        assert_eq!(names, sorted_names);
        fs::remove_dir_all(first).expect("remove first fixture");
        fs::remove_dir_all(second).expect("remove second fixture");
    }

    #[test]
    fn executable_mode_round_trips_through_user_and_marketplace_zip_imports() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-executable-roundtrip-{}",
            uuid::Uuid::new_v4()
        ));
        let source = root.join("source");
        fs::create_dir_all(source.join("scripts")).expect("create executable fixture");
        fs::write(source.join("SKILL.md"), "# Executable Skill\n").expect("write Skill");
        fs::write(source.join("scripts/run.sh"), "#!/bin/sh\nprintf 'ok\\n'\n")
            .expect("write executable script");
        fs::set_permissions(source.join("SKILL.md"), fs::Permissions::from_mode(0o666))
            .expect("set noisy regular mode");
        fs::set_permissions(
            source.join("scripts/run.sh"),
            fs::Permissions::from_mode(0o777),
        )
        .expect("set noisy executable mode");

        let package = create_skill_package_from_root(&source).expect("create executable package");
        let package_bytes = BASE64
            .decode(package.base64)
            .expect("decode executable package");
        let archive_path = root.join("skill.zip");
        fs::write(&archive_path, &package_bytes).expect("write executable ZIP");

        let (user_temporary, user_root) =
            prepare_user_zip_at(&archive_path, &root.join("user-imports"))
                .expect("extract user ZIP");
        assert_eq!(
            fs::metadata(user_root.join("SKILL.md"))
                .expect("read user regular metadata")
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
        assert_eq!(
            fs::metadata(user_root.join("scripts/run.sh"))
                .expect("read user script metadata")
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        assert_eq!(
            fs::metadata(user_root.join("scripts"))
                .expect("read user directory metadata")
                .permissions()
                .mode()
                & 0o777,
            0o755
        );

        let marketplace_stage = root.join("marketplace-stage");
        fs::create_dir(&marketplace_stage).expect("create Marketplace stage");
        fs::set_permissions(&marketplace_stage, fs::Permissions::from_mode(0o700))
            .expect("protect Marketplace stage");
        extract_marketplace_package_to_stage(&package_bytes, &marketplace_stage)
            .expect("extract Marketplace ZIP");
        assert_eq!(
            fs::metadata(marketplace_stage.join("SKILL.md"))
                .expect("read Marketplace regular metadata")
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
        assert_eq!(
            fs::metadata(marketplace_stage.join("scripts/run.sh"))
                .expect("read Marketplace script metadata")
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        assert_eq!(
            fs::metadata(marketplace_stage.join("scripts"))
                .expect("read Marketplace directory metadata")
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        assert_eq!(
            fs::metadata(&marketplace_stage)
                .expect("read Marketplace root metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );

        fs::remove_dir_all(user_temporary).expect("remove user extraction");
        fs::remove_dir_all(root).expect("remove executable fixture");
    }

    #[test]
    fn generated_package_allows_credential_like_documentation() {
        let directory =
            std::env::temp_dir().join(format!("skillhub-package-secret-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create test directory");
        fs::write(directory.join("SKILL.md"), "# Unsafe Skill\n").expect("write skill");
        fs::write(
            directory.join("config.json"),
            "{\"OPENAI_API_KEY\":\"sk-1234567890abcdefghijklmnop\"}\n",
        )
        .expect("write embedded secret");

        create_skill_package_from_root(&directory)
            .expect("credential-like text must not block Skill synchronization");
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn generated_package_allows_token_assignments_in_source() {
        let directory =
            std::env::temp_dir().join(format!("skillhub-package-fixture-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(directory.join("scripts")).expect("create fixture directory");
        fs::write(
            directory.join("SKILL.md"),
            "# Fixture Skill\n\nfile_token: ordinary-resource-identifier\n",
        )
        .expect("write Skill");
        fs::write(
            directory.join("scripts/runtime.mjs"),
            "const token = 'ordinary-runtime-token-value';\n",
        )
        .expect("write runtime assignment");

        create_skill_package_from_root(&directory)
            .expect("token-like source text must not block Skill synchronization");
        fs::remove_dir_all(directory).expect("remove fixture directory");
    }

    #[test]
    fn upgrades_legacy_git_excludes_without_duplicate_rules() {
        let directory =
            std::env::temp_dir().join(format!("skillhub-excludes-{}", uuid::Uuid::new_v4()));
        let exclude_path = directory.join(".git/info/exclude");
        fs::create_dir_all(exclude_path.parent().expect("exclude parent"))
            .expect("create exclude directory");
        fs::write(
            &exclude_path,
            format!("# Existing rules\n{PRIVATE_GIT_EXCLUDE_MARKER}\n.env\n*.pem\n"),
        )
        .expect("write legacy excludes");

        ensure_git_excludes(&directory).expect("upgrade legacy excludes");
        ensure_git_excludes(&directory).expect("repeat exclude upgrade");
        let upgraded = fs::read_to_string(&exclude_path).expect("read upgraded excludes");

        for rule in [
            PRIVATE_GIT_EXCLUDE_MARKER,
            ".env",
            "*.pem",
            "*.p12",
            ".ssh/",
        ] {
            assert_eq!(
                upgraded.lines().filter(|line| line.trim() == rule).count(),
                1,
                "duplicate or missing rule: {rule}",
            );
        }
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn shell_quotes_single_quotes_without_command_expansion() {
        assert_eq!(shell_quote("safe'value"), "'safe'\\''value'");
        assert_eq!(shell_quote("$(touch /tmp/nope)"), "'$(touch /tmp/nope)'");
    }

    #[test]
    fn reads_overwrites_and_deletes_legacy_and_exported_env_assignments() {
        let directory =
            std::env::temp_dir().join(format!("skillhub-env-compat-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create test directory");
        let env_path = directory.join("compat.env");
        fs::write(
            &env_path,
            "# keep this comment\nLEGACY_KEY='legacy'\nexport MODERN_KEY='modern'\n",
        )
        .expect("write mixed env formats");
        fs::set_permissions(&env_path, fs::Permissions::from_mode(0o600))
            .expect("protect env fixture");

        let initial = fs::read_to_string(&env_path).expect("read mixed env formats");
        assert!(env_contents_has_key(&initial, "LEGACY_KEY"));
        assert!(env_contents_has_key(&initial, "MODERN_KEY"));

        set_env_value_in_file(&env_path, "LEGACY_KEY", "updated")
            .expect("overwrite legacy env value");
        let updated = fs::read_to_string(&env_path).expect("read updated env file");
        assert_eq!(updated.matches("export LEGACY_KEY=").count(), 1);
        assert!(updated.contains("export LEGACY_KEY='updated'\n"));
        assert!(updated.contains("export MODERN_KEY='modern'\n"));
        assert!(updated.starts_with("# keep this comment\n"));

        fs::write(
            &env_path,
            "DELETE_LEGACY='legacy'\nexport DELETE_MODERN='modern'\n",
        )
        .expect("write delete compatibility fixture");
        fs::set_permissions(&env_path, fs::Permissions::from_mode(0o600))
            .expect("protect delete fixture");
        delete_env_value_from_file(&env_path, "DELETE_LEGACY").expect("delete legacy assignment");
        let after_legacy_delete =
            fs::read_to_string(&env_path).expect("read after legacy deletion");
        assert!(!env_contents_has_key(&after_legacy_delete, "DELETE_LEGACY"));
        assert!(env_contents_has_key(&after_legacy_delete, "DELETE_MODERN"));
        delete_env_value_from_file(&env_path, "DELETE_MODERN").expect("delete exported assignment");
        assert_eq!(
            fs::read_to_string(&env_path).expect("read empty env file"),
            ""
        );

        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn malformed_env_file_is_preserved_on_set_and_delete() {
        let directory =
            std::env::temp_dir().join(format!("skillhub-env-malformed-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join("malformed.env");
        let original = "GOOD_KEY='good'\nthis is not an assignment\n";
        fs::write(&path, original).expect("write malformed env");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .expect("protect malformed env");
        assert!(set_env_value_in_file(&path, "GOOD_KEY", "changed").is_err());
        assert!(delete_env_value_from_file(&path, "GOOD_KEY").is_err());
        assert_eq!(
            fs::read_to_string(&path).expect("read preserved env"),
            original
        );
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn unreadable_env_file_is_preserved_on_set_and_delete() {
        let directory =
            std::env::temp_dir().join(format!("skillhub-env-unreadable-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join("unreadable.env");
        fs::write(&path, "API_KEY='keep'\n").expect("write unreadable env");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000))
            .expect("remove env permissions");
        assert!(set_env_value_in_file(&path, "API_KEY", "changed").is_err());
        assert!(delete_env_value_from_file(&path, "API_KEY").is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .expect("restore env permissions");
        assert_eq!(
            fs::read_to_string(&path).expect("read preserved env"),
            "API_KEY='keep'\n"
        );
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn symlink_env_file_is_preserved_on_set_and_delete() {
        let directory =
            std::env::temp_dir().join(format!("skillhub-env-symlink-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create test directory");
        let target = directory.join("target.env");
        let path = directory.join("linked.env");
        fs::write(&target, "API_KEY='keep'\n").expect("write symlink target");
        unix_fs::symlink(&target, &path).expect("create env symlink");
        assert!(set_env_value_in_file(&path, "API_KEY", "changed").is_err());
        assert!(delete_env_value_from_file(&path, "API_KEY").is_err());
        assert_eq!(
            fs::read_link(&path).expect("read preserved symlink"),
            target
        );
        assert_eq!(
            fs::read_to_string(&target).expect("read preserved target"),
            "API_KEY='keep'\n"
        );
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn guest_env_merge_rejects_symlink_source_or_destination() {
        let directory =
            std::env::temp_dir().join(format!("skillhub-env-merge-link-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create test directory");
        let source = directory.join("guest.env");
        let destination = directory.join("account.env");
        let target = directory.join("target.env");
        fs::write(&source, "GUEST_KEY='guest'\n").expect("write guest env");
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).expect("protect guest env");
        fs::write(&target, "ACCOUNT_KEY='keep'\n").expect("write target env");
        unix_fs::symlink(&target, &destination).expect("link account env");

        assert!(merge_missing_env_values_from_file(&source, &destination).is_err());
        assert_eq!(
            fs::read_to_string(&target).expect("read preserved account target"),
            "ACCOUNT_KEY='keep'\n"
        );

        fs::remove_file(&destination).expect("remove destination symlink");
        fs::write(&destination, "ACCOUNT_KEY='keep'\n").expect("write account env");
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o600))
            .expect("protect account env");
        let source_target = directory.join("guest-target.env");
        fs::write(&source_target, "GUEST_KEY='guest'\n").expect("write guest target");
        fs::remove_file(&source).expect("remove guest env");
        unix_fs::symlink(&source_target, &source).expect("link guest env");

        assert!(merge_missing_env_values_from_file(&source, &destination).is_err());
        assert_eq!(
            fs::read_to_string(&destination).expect("read preserved account env"),
            "ACCOUNT_KEY='keep'\n"
        );
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn reads_profile_fields_from_skill_frontmatter() {
        let content = r#"---
name: SkillHub 正式版验收
description: 验证真实安装、环境变量与 Profile 读取。
category: 开发与工程
version: 1.0.0
labels: [验收, Mac, SkillHub]
---
# Fallback title
"#;
        let (name, description, category, labels, version) =
            parse_skill_document("fallback-name", content);
        assert_eq!(name, "SkillHub 正式版验收");
        assert_eq!(
            description.as_deref(),
            Some("验证真实安装、环境变量与 Profile 读取。")
        );
        assert_eq!(category.as_deref(), Some("开发与工程"));
        assert_eq!(labels, vec!["验收", "Mac", "SkillHub"]);
        assert_eq!(version, "1.0.0");
    }

    #[test]
    fn skill_file_preview_only_serves_listed_regular_files() {
        let root =
            std::env::temp_dir().join(format!("skillhub-file-preview-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("references")).expect("create references");
        fs::write(root.join("SKILL.md"), "---\nname: preview\n---\n").expect("write SKILL.md");
        fs::write(root.join("references/guide.md"), "# 指南\n").expect("write guide");
        fs::write(root.join("logo.bin"), [0x89_u8, b'P', 0, 1]).expect("write binary");
        fs::write(root.join("latin1.txt"), [0xff_u8, 0xfe, b'a']).expect("write non-UTF-8");
        fs::write(
            root.join("big.txt"),
            vec![b'a'; (MAX_PREVIEW_FILE_BYTES + 1) as usize],
        )
        .expect("write large file");
        fs::write(root.join(".env"), "TOKEN=secret-value\n").expect("write private env");

        assert_eq!(
            read_skill_file_at(&root, "references/guide.md").expect("preview guide"),
            SkillFilePreview::Text {
                path: "references/guide.md".into(),
                size: "# 指南\n".len() as u64,
                content: "# 指南\n".into(),
            }
        );
        assert!(matches!(
            read_skill_file_at(&root, "logo.bin"),
            Ok(SkillFilePreview::Binary { .. })
        ));
        assert!(matches!(
            read_skill_file_at(&root, "latin1.txt"),
            Ok(SkillFilePreview::Binary { .. })
        ));
        assert!(matches!(
            read_skill_file_at(&root, "big.txt"),
            Ok(SkillFilePreview::TooLarge { .. })
        ));
        for refused in [
            ".env",
            "references",
            "../outside.txt",
            "/etc/hosts",
            "references/../SKILL.md",
            "missing.md",
        ] {
            assert!(
                read_skill_file_at(&root, refused).is_err(),
                "{refused} must not be previewable"
            );
        }

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", root.join("hosts-link"))
                .expect("create symlink");
            assert!(read_skill_file_at(&root, "hosts-link").is_err());
            assert!(read_skill_file_at(&root, "SKILL.md").is_err());
        }
        fs::remove_dir_all(root).expect("remove preview fixture");
    }

    #[test]
    fn markdown_inspection_splits_metadata_body_and_lint() {
        let inspection = inspect_skill_markdown(
            "---\nname: 验收\ndescription: >\n  第一行\n  第二行\n---\n# 标题\n正文\n".into(),
        )
        .expect("inspect SKILL.md");
        assert!(inspection.has_frontmatter);
        assert_eq!(inspection.body, "# 标题\n正文\n");
        assert_eq!(
            inspection.fields[1].value,
            crate::skill_document::FrontmatterValue::Text("第一行 第二行".into())
        );
        assert_eq!(
            inspection
                .lint
                .iter()
                .map(|issue| issue.code)
                .collect::<Vec<_>>(),
            vec!["invalid_name"]
        );
        assert!(inspect_skill_markdown("x".repeat(MAX_INSPECTED_SKILL_MD_BYTES + 1)).is_err());
    }

    #[test]
    fn falls_back_to_markdown_title_and_first_paragraph() {
        let content = "# 本地 Skill\n\n这是未带 Frontmatter 的真实说明。\n";
        let (name, description, category, labels, version) =
            parse_skill_document("folder-name", content);
        assert_eq!(name, "本地 Skill");
        assert_eq!(
            description.as_deref(),
            Some("这是未带 Frontmatter 的真实说明。")
        );
        assert_eq!(category, None);
        assert!(labels.is_empty());
        assert_eq!(version, INITIAL_SKILL_VERSION);
    }

    #[test]
    fn writes_environment_files_with_owner_only_permissions() {
        let directory =
            std::env::temp_dir().join(format!("skillhub-private-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join("skill.env");
        write_private_file(&path, "SKILLHUB_TEST='configured'\n").expect("write private file");
        let mode = fs::metadata(&path)
            .expect("read metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn detects_content_changes_but_ignores_skillhub_sidecar_updates() {
        let directory =
            std::env::temp_dir().join(format!("skillhub-working-copy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create test directory");
        fs::write(directory.join("SKILL.md"), "# Version one\n").expect("write skill");
        let repo = git2::Repository::init(&directory).expect("init repo");
        let mut index = repo.index().expect("open index");
        index.add_path(Path::new("SKILL.md")).expect("add skill");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("find tree");
        let signature = git2::Signature::now("SkillHub", "skillhub@local").expect("signature");
        repo.commit(Some("HEAD"), &signature, &signature, "v1.0", &tree, &[])
            .expect("commit snapshot");
        drop(tree);
        drop(repo);

        assert_eq!(working_copy_state_for_path(&directory), (false, 0, None));
        fs::write(directory.join(".skillhub.json"), "{}\n").expect("write sidecar");
        assert_eq!(working_copy_state_for_path(&directory), (false, 0, None));
        fs::write(directory.join("SKILL.md"), "# Version two\n").expect("edit skill");
        let (dirty, changes, hash) = working_copy_state_for_path(&directory);
        assert!(dirty);
        assert_eq!(changes, 1);
        assert_eq!(hash.expect("working copy hash").len(), 64);
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn version_restore_preserves_current_skillhub_account_and_team_binding() {
        let directory =
            std::env::temp_dir().join(format!("skillhub-restore-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create test directory");
        let profile_path = directory.join(".skillhub.json");
        let repository = git2::Repository::init(&directory).expect("initialize repository");
        let signature = git2::Signature::now("SkillHub", "skillhub@local").expect("signature");

        fs::write(directory.join("SKILL.md"), "# Version one\n").expect("write first version");
        fs::write(
            &profile_path,
            r#"{"skillhub":{"serverId":"old-server","serverOwnerId":"old-owner","teams":["old-team"]}}"#,
        )
        .expect("write old profile");
        let mut index = repository.index().expect("open first index");
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .expect("add first version");
        index.write().expect("write first index");
        let first_tree_id = index.write_tree().expect("write first tree");
        let first_tree = repository
            .find_tree(first_tree_id)
            .expect("find first tree");
        let first_commit = repository
            .commit(Some("HEAD"), &signature, &signature, "v1", &first_tree, &[])
            .expect("commit first version");
        drop(first_tree);

        fs::write(directory.join("SKILL.md"), "# Version two\n").expect("write second version");
        fs::write(
            &profile_path,
            r#"{"skillhub":{"serverId":"second-server","serverOwnerId":"second-owner","teams":["second-team"]}}"#,
        )
        .expect("write second profile");
        let mut index = repository.index().expect("open second index");
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .expect("add second version");
        index.write().expect("write second index");
        let second_tree_id = index.write_tree().expect("write second tree");
        let second_tree = repository
            .find_tree(second_tree_id)
            .expect("find second tree");
        let parent = repository
            .find_commit(first_commit)
            .expect("find first commit");
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "v2",
                &second_tree,
                &[&parent],
            )
            .expect("commit second version");
        drop(parent);
        drop(second_tree);
        drop(repository);

        let current_profile = r#"{"skillhub":{"serverId":"current-server","serverOwnerId":"current-owner","teamSharedFrom":"current-team","teams":["current-team"]}}"#;
        fs::write(&profile_path, current_profile).expect("write current profile binding");

        restore_skill_version_at_path(&directory, &first_commit.to_string())
            .expect("restore historical Skill content");

        assert_eq!(
            fs::read_to_string(directory.join("SKILL.md")).expect("read restored Skill"),
            "# Version one\n"
        );
        assert_eq!(
            fs::read_to_string(&profile_path).expect("read preserved profile"),
            current_profile
        );
        let repository = git2::Repository::open(&directory).expect("reopen repository");
        let head = repository
            .head()
            .expect("read head")
            .peel_to_commit()
            .expect("head commit");
        assert!(head.message().unwrap_or_default().starts_with("恢复版本 "));
        let tree = head.tree().expect("read restored snapshot tree");
        assert!(
            tree.get_path(Path::new(".skillhub.json")).is_err(),
            "account/version metadata stays outside new Git content trees"
        );
        drop(tree);
        drop(head);
        drop(repository);

        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn version_restore_refuses_projection_edits_reconciled_after_preflight() {
        let fixture = projection_fixture("# Version one\n", false);
        create_skill_snapshot_at_path(&fixture.skill_root, "v1").expect("snapshot first version");
        let first_commit = git2::Repository::open(&fixture.skill_root)
            .expect("open first repository")
            .head()
            .expect("read first head")
            .peel_to_commit()
            .expect("read first commit")
            .id()
            .to_string();

        fs::write(fixture.skill_root.join("SKILL.md"), "# Version two\n")
            .expect("write second version");
        create_skill_snapshot_at_path(&fixture.skill_root, "v2").expect("snapshot second version");
        refresh_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
            .expect("refresh second projection");
        let projected =
            fs::read_to_string(fixture.current.join("SKILL.md")).expect("read projection");
        fs::write(
            fixture.current.join("SKILL.md"),
            projected.replace("# Version two\n", "# Pending Agent projection edit\n"),
        )
        .expect("write pending projection edit");

        reconcile_skill_projection_at(&fixture.skillhub_root, &fixture.managed_root, "sample")
            .expect("reconcile pending projection edit");
        let error = restore_skill_version_at_path(&fixture.skill_root, &first_commit)
            .expect_err("dirty reconciled edit must block restore checkout");
        assert!(error.contains("未保存内容"));
        assert_eq!(
            fs::read_to_string(fixture.skill_root.join("SKILL.md"))
                .expect("read preserved canonical edit"),
            "# Pending Agent projection edit\n"
        );

        fixture.cleanup();
    }

    #[test]
    fn version_restore_sink_rejects_an_unsafe_historical_tree_before_checkout() {
        let directory = std::env::temp_dir().join(format!(
            "skillhub-restore-unsafe-tree-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).expect("create unsafe history fixture");
        fs::write(directory.join("SKILL.md"), "# Version one\n").expect("write first version");
        unix_fs::symlink("../../outside", directory.join("escape"))
            .expect("create historical symlink");
        let repository = git2::Repository::init(&directory).expect("initialize repository");
        let signature = git2::Signature::now("SkillHub", "skillhub@local").expect("signature");
        let mut index = repository.index().expect("open first index");
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .expect("add unsafe first version");
        index.write().expect("write first index");
        let first_tree_id = index.write_tree().expect("write first tree");
        let first_tree = repository
            .find_tree(first_tree_id)
            .expect("find first tree");
        let first_commit = repository
            .commit(Some("HEAD"), &signature, &signature, "v1", &first_tree, &[])
            .expect("commit unsafe first version");
        drop(first_tree);

        fs::remove_file(directory.join("escape")).expect("remove live symlink");
        fs::write(directory.join("SKILL.md"), "# Version two\n").expect("write safe version");
        let mut index = repository.index().expect("open second index");
        index
            .remove_path(Path::new("escape"))
            .expect("remove historical symlink from index");
        index
            .add_path(Path::new("SKILL.md"))
            .expect("add safe SKILL.md");
        index.write().expect("write second index");
        let second_tree_id = index.write_tree().expect("write second tree");
        let second_tree = repository
            .find_tree(second_tree_id)
            .expect("find second tree");
        let parent = repository
            .find_commit(first_commit)
            .expect("find unsafe parent");
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "v2",
                &second_tree,
                &[&parent],
            )
            .expect("commit safe second version");
        drop(parent);
        drop(second_tree);
        drop(repository);

        let error = restore_skill_version_at_path(&directory, &first_commit.to_string())
            .expect_err("unsafe target tree must be rejected before checkout");
        assert!(error.contains("符号链接"));
        assert!(!directory.join("escape").exists());
        assert_eq!(
            fs::read_to_string(directory.join("SKILL.md")).expect("read unchanged live Skill"),
            "# Version two\n"
        );

        fs::remove_dir_all(directory).expect("remove unsafe history fixture");
    }

    #[test]
    fn includes_current_cross_agent_skill_roots() {
        let agents = crate::known_agents();
        for expected in [
            "claude",
            "codex",
            "workbuddy",
            "doubao",
            "opencode",
            "openclaw",
            "gemini",
        ] {
            assert!(agents.iter().any(|(key, _, _)| *key == expected));
        }
    }

    #[test]
    fn system_manager_is_installed_and_repairs_projection_tampering() {
        let home =
            std::env::temp_dir().join(format!("skillhub-system-manager-{}", uuid::Uuid::new_v4()));
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = skillhub_root.join("skills");
        fs::create_dir_all(&managed_root).expect("create managed root");
        fs::set_permissions(&skillhub_root, fs::Permissions::from_mode(0o700))
            .expect("protect root");
        fs::set_permissions(&managed_root, fs::Permissions::from_mode(0o700))
            .expect("protect managed root");
        let detected = HashSet::from(["codex".to_string()]);
        fs::create_dir_all(home.join(".codex/skills")).expect("create ready Codex Skill root");

        repair_system_manager_at(&home, &skillhub_root, &managed_root, &detected)
            .expect("install manager");
        let canonical = managed_root.join(crate::system_skill::SYSTEM_MANAGER_ID);
        assert_eq!(
            fs::read_to_string(canonical.join("SKILL.md")).expect("read canonical manager"),
            crate::system_skill::files()[0].1
        );
        let references = canonical.join("references");
        fs::set_permissions(&canonical, fs::Permissions::from_mode(0o700))
            .expect("unlock manager for legacy fixture");
        fs::set_permissions(&references, fs::Permissions::from_mode(0o700))
            .expect("unlock references for legacy fixture");
        for filename in [
            "editing.md",
            "operations.md",
            "credentials.md",
            "sharing.md",
        ] {
            let path = references.join(filename);
            fs::write(&path, "legacy\n").expect("write legacy reference");
            fs::set_permissions(path, fs::Permissions::from_mode(0o400))
                .expect("protect legacy reference");
        }
        fs::write(references.join("keep.md"), "keep\n").expect("write unknown reference");
        let link = home
            .join(".codex/skills")
            .join(crate::system_skill::SYSTEM_MANAGER_ID);
        assert!(link.is_symlink());
        let projected = link.join("SKILL.md");
        fs::set_permissions(&projected, fs::Permissions::from_mode(0o600))
            .expect("unlock projected manager for tamper fixture");
        fs::write(&projected, "tampered\n").expect("tamper projected manager");

        repair_system_manager_at(&home, &skillhub_root, &managed_root, &detected)
            .expect("repair manager projection");
        assert_eq!(
            fs::read_to_string(link.join("SKILL.md")).expect("read repaired manager"),
            crate::system_skill::files()[0].1
        );
        for filename in [
            "editing.md",
            "operations.md",
            "credentials.md",
            "sharing.md",
        ] {
            assert!(!references.join(filename).exists());
        }
        assert_eq!(
            fs::read_to_string(references.join("keep.md")).expect("read unknown reference"),
            "keep\n"
        );

        fs::set_permissions(&canonical, fs::Permissions::from_mode(0o700))
            .expect("unlock canonical cleanup");
        fs::set_permissions(
            canonical.join("references"),
            fs::Permissions::from_mode(0o700),
        )
        .expect("unlock references cleanup");
        fs::remove_dir_all(home).expect("remove system manager fixture");
    }

    #[test]
    fn system_manager_does_not_create_agent_skill_directories_without_ready_targets() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-system-manager-no-ready-agent-{}",
            uuid::Uuid::new_v4()
        ));
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = skillhub_root.join("skills");
        fs::create_dir_all(&managed_root).expect("create managed root");
        fs::set_permissions(&skillhub_root, fs::Permissions::from_mode(0o700))
            .expect("protect root");
        fs::set_permissions(&managed_root, fs::Permissions::from_mode(0o700))
            .expect("protect managed root");

        let detected = HashSet::from([
            "workbuddy".to_string(),
            "doubao".to_string(),
            "codex".to_string(),
        ]);
        repair_system_manager_at(&home, &skillhub_root, &managed_root, &detected)
            .expect("prepare internal Manager without Agent projections");
        assert!(managed_root
            .join(crate::system_skill::SYSTEM_MANAGER_ID)
            .is_dir());
        for relative in [".workbuddy-ai/skills", ".agents/skills", ".codex/skills"] {
            assert!(
                !home.join(relative).exists(),
                "repair must not create {relative}"
            );
        }

        let canonical = managed_root.join(crate::system_skill::SYSTEM_MANAGER_ID);
        fs::set_permissions(&canonical, fs::Permissions::from_mode(0o700))
            .expect("unlock canonical cleanup");
        fs::set_permissions(
            canonical.join("references"),
            fs::Permissions::from_mode(0o700),
        )
        .expect("unlock references cleanup");
        fs::remove_dir_all(home).expect("remove system manager fixture");
    }

    #[test]
    fn edit_session_promotes_team_skill_to_personal_and_snapshots_it() {
        let home =
            std::env::temp_dir().join(format!("skillhub-edit-session-{}", uuid::Uuid::new_v4()));
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = skillhub_root.join("skills");
        let skill_root = managed_root.join("shared-skill");
        fs::create_dir_all(&skill_root).expect("create shared skill");
        fs::set_permissions(&skillhub_root, fs::Permissions::from_mode(0o700))
            .expect("protect root");
        fs::set_permissions(&managed_root, fs::Permissions::from_mode(0o700))
            .expect("protect managed root");
        fs::write(skill_root.join("SKILL.md"), "# Shared Skill\n").expect("write shared skill");
        write_profile_at_path(
            &skill_root,
            &crate::SkillHubProfile {
                is_own: Some(false),
                acquisition_source: Some(crate::AcquisitionSource::Team),
                server_id: Some("upstream-skill".into()),
                server_owner_id: Some("upstream-owner".into()),
                team_shared_from: Some("team-one".into()),
                version: "v2.3.0".into(),
                name: Some("shared-skill".into()),
                ..Default::default()
            },
        )
        .expect("write shared profile");
        create_skill_snapshot_at_path(&skill_root, "v2.3.0").expect("create baseline snapshot");
        refresh_skill_projection_at(&skillhub_root, &managed_root, "shared-skill")
            .expect("create projection");

        let prepared =
            prepare_skill_edit_at(&skillhub_root, &managed_root, Some("shared-skill"), None)
                .expect("prepare edit");
        assert_eq!(
            prepared.finish_command,
            format!("skillhub skill finish-edit {} --json", prepared.session_id)
        );
        fs::write(
            skill_root.join("SKILL.md"),
            "# Shared Skill\n\nPersonal improvement.\n",
        )
        .expect("edit working copy");
        let finished = finish_skill_edit_at(&skillhub_root, &managed_root, &prepared.session_id)
            .expect("finish edit");
        assert!(finished.changed);
        assert!(finished.promoted_to_personal);
        assert_eq!(finished.version, "2.3.1");
        let profile = super::read_profile_at_path(&skill_root).expect("read promoted profile");
        assert_eq!(profile.is_own, Some(true));
        assert_eq!(
            profile.acquisition_source,
            Some(crate::AcquisitionSource::Local)
        );
        assert!(profile.server_id.is_none());
        assert_eq!(
            profile
                .upstream
                .as_ref()
                .and_then(|value| value.server_skill_id.as_deref()),
            Some("upstream-skill")
        );
        let repo = git2::Repository::open(&skill_root).expect("open promoted repo");
        let head = repo
            .head()
            .expect("read promoted head")
            .peel_to_commit()
            .expect("read promoted commit");
        assert!(head
            .message()
            .unwrap_or_default()
            .contains("SkillHub-Version: 2.3.1"));
        drop(head);
        drop(repo);
        fs::remove_dir_all(home).expect("remove edit fixture");
    }
}

#[cfg(test)]
mod import_attribution_wiring_tests {
    //! Both import paths attribute the Skill to the account captured when the
    //! operation starts and commit only while that session is still current
    //! (#91). The switch itself is exercised in `runtime_env`'s
    //! `import_attribution_tests`; these pin the wiring of each path.
    const SOURCE: &str = include_str!("commands.rs");

    fn body(signature: &str) -> &'static str {
        let start = SOURCE.find(signature).expect("function present");
        let rest = &SOURCE[start..];
        let end = rest[1..]
            .find("\nfn ")
            .or_else(|| rest[1..].find("\npub fn "))
            .or_else(|| rest[1..].find("\n#[tauri::command]"))
            .expect("function end");
        &rest[..end + 1]
    }

    fn position(haystack: &str, needle: &str) -> usize {
        haystack
            .find(needle)
            .unwrap_or_else(|| panic!("missing: {needle}"))
    }

    #[test]
    fn folder_and_zip_import_stamp_the_starting_account_and_commit_through_it() {
        let import = body("fn import_skill_blocking(");
        let begin = position(import, "ImportAttribution::begin()");
        assert!(begin < position(import, "prepare_import_source(&src)"));
        assert!(import.contains(
            "profile.added_by_account_id = attribution.account_id().map(str::to_string);"
        ));
        // Rename, adoption and env values all go through the tested commit.
        assert!(import.contains("commit_imported_skill_at("));
        assert!(!import.contains("fs::rename(&staged_destination, &destination)"));
        assert!(!import.contains("persist_skill_env_values("));
        assert!(
            !import.contains("signed_in_user_id") && !import.contains("runtime_session_snapshot")
        );
    }

    #[test]
    fn store_and_team_installs_stamp_the_starting_account_and_hold_it_through_activation() {
        let install = body("pub fn import_skill_package(");
        let begin = position(install, "ImportAttribution::begin_expected(&space)");
        assert!(begin < position(install, "is_system_skill_id(&skill_id)"));
        assert!(
            install.contains("added_by_account_id: attribution.account_id().map(str::to_string),")
        );
        let commit = position(install, "let _session_lease = attribution.commit()?;");
        assert!(commit < position(install, "fs::create_dir_all(&managed_root)"));
        assert!(commit < position(install, "activate_staged_marketplace_package("));
        assert!(
            !install.contains("signed_in_user_id") && !install.contains("runtime_session_snapshot")
        );
    }
}

#[cfg(test)]
mod import_commit_tests {
    //! Executes the real folder-import commit (`commit_imported_skill_at`)
    //! against temporary session files, injecting account switches between
    //! the start of the import and its commit / env-value step (#91).
    use super::commit_imported_skill_at;
    use crate::runtime_env::test_sessions::{begin_switch, sign_in, sign_out, switch_possible};
    use crate::runtime_env::ImportAttribution;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;

    const USER_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const USER_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("skillhub-import-commit-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(
                root.join(if crate::official_channel::CHANNEL == "dev" {
                    ".skillhub-dev"
                } else {
                    ".skillhub"
                })
                .join("skills"),
            )
            .unwrap();
            fs::create_dir_all(root.join("stage/demo")).unwrap();
            fs::write(root.join("stage/demo/SKILL.md"), "# Demo\n").unwrap();
            Self { root }
        }
        fn skillhub(&self) -> PathBuf {
            self.root
                .join(if crate::official_channel::CHANNEL == "dev" {
                    ".skillhub-dev"
                } else {
                    ".skillhub"
                })
        }
        fn envs(&self) -> PathBuf {
            self.skillhub().join("envs")
        }
        fn destination(&self) -> PathBuf {
            self.skillhub().join("skills/demo")
        }
        fn env_file(&self, user_id: &str) -> PathBuf {
            self.envs().join(user_id).join("demo.env")
        }
        fn commit(
            &self,
            attribution: &ImportAttribution,
            values: &BTreeMap<String, String>,
            between: impl FnOnce() -> Result<(), String>,
        ) -> Result<(), String> {
            commit_imported_skill_at(
                &self.skillhub(),
                &self.envs(),
                attribution,
                &self.root.join("stage/demo"),
                &self.destination(),
                "demo",
                values,
                between,
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn secrets() -> BTreeMap<String, String> {
        BTreeMap::from([("API_KEY".to_string(), "secret-from-the-folder".to_string())])
    }

    #[test]
    fn a_switch_before_the_commit_writes_neither_the_skill_nor_its_secrets() {
        let fixture = Fixture::new();
        sign_in(&fixture.skillhub(), USER_A);
        let attribution = ImportAttribution::begin_at(&fixture.skillhub());
        sign_in(&fixture.skillhub(), USER_B);

        assert!(fixture.commit(&attribution, &secrets(), || Ok(())).is_err());
        assert!(!fixture.destination().exists(), "not committed");
        assert!(!fixture.envs().exists(), "no env values for A or B");
        assert!(
            fixture.root.join("stage/demo/SKILL.md").is_file(),
            "staged copy untouched"
        );
    }

    #[test]
    fn secrets_land_with_the_starting_account_and_no_switch_can_slip_in_after_the_rename() {
        let fixture = Fixture::new();
        sign_in(&fixture.skillhub(), USER_A);
        let attribution = ImportAttribution::begin_at(&fixture.skillhub());
        let skillhub = fixture.skillhub();
        let destination = fixture.destination();
        fixture
            .commit(&attribution, &secrets(), || {
                // Between the rename and the env values (projection/adoption
                // in the APP): a login/logout cannot take the session here.
                assert!(destination.join("SKILL.md").is_file());
                assert!(!switch_possible(&skillhub), "switch blocked mid-commit");
                Ok(())
            })
            .expect("commit");
        let stored = fs::read_to_string(fixture.env_file(USER_A)).expect("A's env file");
        assert!(stored.contains("API_KEY") && stored.contains("secret-from-the-folder"));
        assert!(!fixture.envs().join(USER_B).exists());
        assert!(
            switch_possible(&fixture.skillhub()),
            "released after the commit"
        );
        // A switch right after the commit is no longer the import's concern.
        sign_in(&fixture.skillhub(), USER_B);
        assert!(!fixture.envs().join(USER_B).exists());
    }

    #[test]
    fn a_guest_import_keeps_its_values_with_the_guest_and_a_login_in_between_aborts() {
        let fixture = Fixture::new();
        sign_out(&fixture.skillhub());
        let guest = ImportAttribution::begin_at(&fixture.skillhub());
        assert_eq!(guest.account_id(), None);
        let guest_id = guest.runtime_user_id().expect("guest identity").to_string();
        sign_in(&fixture.skillhub(), USER_B);
        assert!(fixture.commit(&guest, &secrets(), || Ok(())).is_err());
        assert!(!fixture.destination().exists());
        assert!(
            !fixture.envs().exists(),
            "B never receives the guest's values"
        );

        sign_out(&fixture.skillhub());
        let guest = ImportAttribution::begin_at(&fixture.skillhub());
        let guest_id_now = guest.runtime_user_id().expect("guest identity").to_string();
        fixture
            .commit(&guest, &secrets(), || Ok(()))
            .expect("commit as guest");
        assert!(fixture.env_file(&guest_id_now).is_file());
        assert!(!fixture.envs().join(USER_B).exists());
        let _ = guest_id;
    }

    #[test]
    fn an_import_started_mid_switch_never_stores_values_for_an_unknown_account() {
        let fixture = Fixture::new();
        sign_in(&fixture.skillhub(), USER_A);
        begin_switch(&fixture.skillhub());
        let attribution = ImportAttribution::begin_at(&fixture.skillhub());
        assert_eq!(attribution.runtime_user_id(), None);
        assert!(fixture.commit(&attribution, &secrets(), || Ok(())).is_err());
        assert!(!fixture.destination().exists() && !fixture.envs().exists());
        assert!(fixture
            .commit(&attribution, &BTreeMap::new(), || Ok(()))
            .is_err());
        assert!(!fixture.destination().exists());
    }
}

#[cfg(test)]
mod offloaded_read_commands_tests {
    //! The list, scan and detail reads run through `spawn_blocking`. These
    //! tests pin two properties of that wrapper: results and validation errors
    //! still reach the caller unchanged, and the blocking core never runs on
    //! the thread that awaited it.
    use super::*;
    use std::time::{Duration, Instant};

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn async_read_commands_propagate_validation_errors_from_the_worker() {
        let unsafe_id = "../escape".to_string();
        let expected = validate_skill_id(&unsafe_id).unwrap_err();
        assert!(!expected.is_empty());
        assert_eq!(
            block_on(get_skill_tree(unsafe_id.clone())).unwrap_err(),
            expected
        );
        assert_eq!(
            block_on(get_skill_versions(unsafe_id.clone())).unwrap_err(),
            expected
        );
        assert_eq!(
            block_on(get_skill_version_state(unsafe_id.clone()))
                .err()
                .expect("unsafe id is rejected"),
            expected
        );
        assert_eq!(
            block_on(get_skill_diff(
                unsafe_id.clone(),
                "0".repeat(40),
                "1".repeat(40)
            ))
            .unwrap_err(),
            expected
        );
        assert_eq!(
            block_on(get_skill_working_diff(unsafe_id.clone())).unwrap_err(),
            expected
        );
        assert_eq!(
            block_on(read_skill_file(unsafe_id.clone(), "SKILL.md".into()))
                .expect_err("unsafe id is rejected"),
            expected
        );
        assert_eq!(
            block_on(suggest_vault_key_alias(
                crate::server_request::SpaceHandle {
                    space_id: "local".into(),
                    generation: 0,
                },
                "invalid-key".into(),
                None,
            ))
            .expect_err("invalid key rejected"),
            "环境变量名必须为大写字母、数字和下划线"
        );
        assert_eq!(block_on(read_skill_md(unsafe_id)).unwrap_err(), expected);
    }

    /// Every offloaded command's blocking core records the thread it started
    /// on; it must never be the thread that awaited the command. The unsafe id
    /// stops each core at validation, so this touches no real Skill library.
    fn observation_guard() -> std::sync::MutexGuard<'static, ()> {
        READ_THREAD_OBSERVATION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn product_read_commands_run_their_core_off_the_awaiting_thread() {
        let _serial = observation_guard();
        let caller = std::thread::current().id();
        let observed = |name: &str| {
            let worker = LAST_READ_COMMAND_THREAD
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| panic!("{name} did not reach its blocking core"));
            assert_ne!(worker, caller, "{name} ran on the awaiting thread");
        };
        let unsafe_id = "../escape".to_string();
        let _ = block_on(get_skill_tree(unsafe_id.clone()));
        observed("get_skill_tree");
        let _ = block_on(get_skill_versions(unsafe_id.clone()));
        observed("get_skill_versions");
        let _ = block_on(get_skill_version_state(unsafe_id.clone()));
        observed("get_skill_version_state");
        let _ = block_on(get_skill_diff(
            unsafe_id.clone(),
            "0".repeat(40),
            "1".repeat(40),
        ));
        observed("get_skill_diff");
        let _ = block_on(get_skill_working_diff(unsafe_id.clone()));
        observed("get_skill_working_diff");
        let _ = block_on(read_skill_md(unsafe_id.clone()));
        observed("read_skill_md");
        let _ = block_on(read_skill_file(unsafe_id.clone(), "SKILL.md".into()));
        observed("read_skill_file");
        // The unmanaged scan is a read-only walk of Agent roots (no writes), so
        // it can be observed against the real home without side effects.
        let _ = block_on(get_unmanaged_agent_skills());
        observed("get_unmanaged_agent_skills");
        assert_eq!(
            block_on(get_local_skill(unsafe_id)).unwrap_err(),
            validate_skill_id("../escape").unwrap_err()
        );
        observed("get_local_skill");
    }

    /// Redirects the process home (both variables `user_home_dir` consults:
    /// `HOME` on Unix, `USERPROFILE` first on Windows) to an isolated root and
    /// restores the previous values on drop, including during a panic unwind.
    struct HomeRedirect {
        previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl HomeRedirect {
        fn to(root: &Path) -> Self {
            let previous = ["HOME", "USERPROFILE"]
                .into_iter()
                .map(|name| (name, std::env::var_os(name)))
                .collect();
            std::env::set_var("HOME", root);
            std::env::set_var("USERPROFILE", root);
            Self { previous }
        }
    }

    impl Drop for HomeRedirect {
        fn drop(&mut self) {
            for (name, value) in self.previous.drain(..) {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }

    /// Baseline fixture from the plan (§5.1, 常规数据集): 30 managed Skills with
    /// 10 saved versions each and 150 unmanaged Agent entries. It prints
    /// median / p95 / max of the blocking cores so 2b and 3 can be compared
    /// against the same shape. It redirects HOME, so it only runs alone:
    ///
    /// `cargo test --locked list_refresh_baseline_fixture -- --ignored --nocapture --test-threads=1`
    #[test]
    #[ignore]
    fn list_refresh_baseline_fixture() {
        const MANAGED: usize = 30;
        const VERSIONS: usize = 10;
        const UNMANAGED: usize = 150;
        const SAMPLES: usize = 30;

        let home =
            std::env::temp_dir().join(format!("skillhub-list-baseline-{}", uuid::Uuid::new_v4()));
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        let managed_root = skillhub_root.join("skills");
        fs::create_dir_all(&managed_root).unwrap();
        for index in 0..MANAGED {
            let path = managed_root.join(format!("fixture-skill-{index:03}"));
            fs::create_dir_all(&path).unwrap();
            let mut profile = SkillHubProfile {
                id: Some(uuid::Uuid::new_v4().to_string()),
                name: Some(format!("fixture-skill-{index:03}")),
                display_name: Some(format!("Fixture Skill {index:03}")),
                description: Some("baseline fixture".into()),
                is_own: Some(true),
                acquisition_source: Some(AcquisitionSource::Local),
                ..SkillHubProfile::default()
            };
            if index % 3 == 0 {
                profile.env_dependencies = vec![EnvDepRaw {
                    key: "FIXTURE_API_KEY".into(),
                    description: None,
                    required: true,
                    share_policy: "private".into(),
                    shared_teams: Vec::new(),
                    origin: None,
                    confidence: None,
                    obtain: None,
                    pending: None,
                }];
            }
            library_write_profile(&path, &profile).unwrap();
            for version in 0..VERSIONS {
                fs::write(
                    path.join("SKILL.md"),
                    format!("# Fixture {index:03}\n\nrevision {version}\n"),
                )
                .unwrap();
                library_snapshot_at(&path, &format!("revision {version}")).unwrap();
            }
        }
        let claude_root = home.join(".claude/skills");
        for index in 0..UNMANAGED {
            let path = claude_root.join(format!("unmanaged-{index:03}"));
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("SKILL.md"), format!("# Unmanaged {index:03}\n")).unwrap();
        }

        let _serial = observation_guard();
        let redirect = HomeRedirect::to(&home);
        // Nothing below may run until the process really resolves its managed
        // store inside the fixture: Manager repair and version/projection
        // maintenance write to whatever `skills_dir()` points at.
        assert_eq!(
            skillhub_dir(),
            skillhub_root,
            "home redirect did not take effect"
        );
        assert_eq!(skills_dir(), managed_root);
        assert!(crate::user_home_dir().is_some_and(|resolved| resolved == home));
        // Both list entry points are observed through their real async commands
        // here, where the home is isolated and maintenance writes land in the fixture.
        let caller = std::thread::current().id();
        block_on(get_local_skills()).expect("list command");
        let worker = LAST_READ_COMMAND_THREAD
            .lock()
            .unwrap()
            .take()
            .expect("get_local_skills");
        assert_ne!(
            worker, caller,
            "get_local_skills ran on the awaiting thread"
        );
        block_on(get_unmanaged_agent_skills()).expect("scan command");
        let worker = LAST_READ_COMMAND_THREAD
            .lock()
            .unwrap()
            .take()
            .expect("get_unmanaged_agent_skills");
        assert_ne!(
            worker, caller,
            "get_unmanaged_agent_skills ran on the awaiting thread"
        );
        let detected = HashSet::from(["claude".to_string()]);
        let mut list = Vec::with_capacity(SAMPLES);
        let mut scan = Vec::with_capacity(SAMPLES);
        let mut managed_count = 0;
        let mut unmanaged_count = 0;
        // The first refresh may migrate (number histories, install the Manager,
        // write projections). Every later refresh with nothing changed must
        // leave every sidecar and projection byte-for-byte and mtime-identical.
        let _ = get_local_skills_blocking();
        let snapshot = |root: &Path| -> std::collections::BTreeMap<
            PathBuf,
            (std::time::SystemTime, Vec<u8>),
        > {
            fn walk(
                dir: &Path,
                out: &mut std::collections::BTreeMap<PathBuf, (std::time::SystemTime, Vec<u8>)>,
            ) {
                for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
                    let path = entry.path();
                    let Ok(metadata) = fs::symlink_metadata(&path) else {
                        continue;
                    };
                    if metadata.is_dir() {
                        if path.file_name().is_some_and(|n| n == ".git") {
                            continue;
                        }
                        walk(&path, out);
                    } else if metadata.is_file() {
                        out.insert(
                            path.clone(),
                            (
                                metadata.modified().unwrap(),
                                fs::read(&path).unwrap_or_default(),
                            ),
                        );
                    } else if metadata.file_type().is_symlink() {
                        out.insert(
                            path.clone(),
                            (
                                metadata.modified().unwrap(),
                                fs::read_link(&path)
                                    .map(|p| p.into_os_string().into_encoded_bytes())
                                    .unwrap_or_default(),
                            ),
                        );
                    }
                }
            }
            let mut out = std::collections::BTreeMap::new();
            walk(root, &mut out);
            out
        };
        let before_writes = snapshot(&skillhub_root);
        for _ in 0..SAMPLES {
            let started = Instant::now();
            managed_count = get_local_skills_blocking().len();
            list.push(started.elapsed());
            let started = Instant::now();
            unmanaged_count = scan_unmanaged_agent_skills(&home, &managed_root, &detected)
                .unwrap()
                .len();
            scan.push(started.elapsed());
        }
        let after_writes = snapshot(&skillhub_root);
        let changed = before_writes
            .iter()
            .filter(|(path, state)| after_writes.get(*path) != Some(state))
            .map(|(path, _)| {
                path.strip_prefix(&skillhub_root)
                    .unwrap_or(path)
                    .display()
                    .to_string()
            })
            .chain(
                after_writes
                    .keys()
                    .filter(|path| !before_writes.contains_key(*path))
                    .map(|path| {
                        format!(
                            "+{}",
                            path.strip_prefix(&skillhub_root).unwrap_or(path).display()
                        )
                    }),
            )
            .collect::<Vec<_>>();
        drop(redirect);
        assert_ne!(
            skillhub_dir(),
            skillhub_root,
            "home redirect was not restored"
        );
        println!(
            "LIST_REFRESH_WRITES unchanged_refreshes={SAMPLES} files_written={} {:?}",
            changed.len(),
            changed.iter().take(10).collect::<Vec<_>>()
        );
        // SkillHub locks down some of what it writes (0o500 projections);
        // unlock the fixture tree before removing it.
        fn unlock(path: &Path) {
            if let Ok(metadata) = fs::symlink_metadata(path) {
                if metadata.is_dir() {
                    // `from_mode` exists on both platforms: std on Unix, the
                    // `platform_fs` shim (read-only bit) on Windows.
                    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
                    if let Ok(entries) = fs::read_dir(path) {
                        for entry in entries.flatten() {
                            unlock(&entry.path());
                        }
                    }
                }
            }
        }
        unlock(&home);
        if let Err(error) = fs::remove_dir_all(&home) {
            println!("fixture cleanup left {} behind: {error}", home.display());
        }

        fn stats(samples: &mut [Duration]) -> (Duration, Duration, Duration) {
            samples.sort();
            let percentile = |p: f64| samples[((samples.len() - 1) as f64 * p).round() as usize];
            (
                percentile(0.5),
                percentile(0.95),
                samples[samples.len() - 1],
            )
        }
        let (list_p50, list_p95, list_max) = stats(&mut list);
        let (scan_p50, scan_p95, scan_max) = stats(&mut scan);
        println!(
            "LIST_REFRESH_BASELINE managed={managed_count} versions_each={VERSIONS} unmanaged={unmanaged_count} samples={SAMPLES} \
             get_local_skills p50={:?} p95={:?} max={:?} scan_unmanaged p50={:?} p95={:?} max={:?}",
            list_p50, list_p95, list_max, scan_p50, scan_p95, scan_max
        );
        // `repair_system_manager` installs the bundled Manager into the fixture
        // home, so the managed list is the fixtures plus one system Skill.
        assert_eq!(managed_count, MANAGED + 1);
        assert_eq!(unmanaged_count, UNMANAGED);
        assert!(
            changed.is_empty(),
            "unchanged refreshes must not write: {changed:?}"
        );
    }
}

// #335 admission: an Agent found through a new Windows discovery path while
// its Skill root is overridden must not receive writes in the default root.
#[cfg(test)]
mod install_admission_root_override_tests {
    use super::resolve_install_targets_with;
    use crate::{
        detect_agents_from_discovery, known_agents_for_platform, AgentDiscovery, AgentPlatform,
    };
    use std::fs;

    #[test]
    fn install_preflight_refuses_a_detected_agent_with_an_overridden_root() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-admission-override-{}",
            uuid::Uuid::new_v4()
        ));
        let home = root.join("Users/张 三");
        // Only a package-manager location (WinGet Links) holds the CLI.
        let links = home.join("AppData/Local/Microsoft/WinGet/Links");
        fs::create_dir_all(&links).expect("create WinGet Links");
        let codex = links.join("codex.exe");
        fs::write(&codex, "exe").expect("write codex");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&codex, fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        let known = known_agents_for_platform(AgentPlatform::Windows);
        let agents = ["codex".to_string()];
        let detect = |overrides: Vec<(&'static str, String)>| {
            detect_agents_from_discovery(
                &home,
                &AgentDiscovery {
                    executable_dirs: vec![links.clone()],
                    skill_root_overrides: overrides,
                    ..AgentDiscovery::default()
                },
                AgentPlatform::Windows,
            )
        };

        let admitted =
            resolve_install_targets_with(&home, "demo", &agents, &known, &detect(vec![]))
                .expect("default root is admitted");
        assert_eq!(admitted[0].2, home.join(".codex/skills").join("demo"));

        let refused = resolve_install_targets_with(
            &home,
            "demo",
            &agents,
            &known,
            &detect(vec![("CODEX_HOME", r"D:\custom-codex".to_string())]),
        )
        .expect_err("an overridden root must block the default-root write");
        assert!(refused.contains("Skill 目录未确认"), "{refused}");
        assert!(!home.join(".codex").exists(), "nothing is created");
        fs::remove_dir_all(root).expect("remove fixture");
    }
    #[cfg(unix)]
    #[test]
    fn macos_install_refuses_a_case_different_codex_home() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = std::env::temp_dir().join(format!(
            "skillhub-admission-macos-case-{}",
            uuid::Uuid::new_v4()
        ));
        let home = root.join("Users/dev");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).expect("create bin");
        fs::write(bin.join("codex"), "#!/bin/sh\n").expect("write codex");
        fs::set_permissions(bin.join("codex"), fs::Permissions::from_mode(0o755)).expect("chmod");
        fs::create_dir_all(home.join(".codex/skills")).expect("old default root");
        let detected = detect_agents_from_discovery(
            &home,
            &AgentDiscovery {
                executable_dirs: vec![bin],
                skill_root_overrides: vec![(
                    "CODEX_HOME",
                    home.join(".CODEX").display().to_string(),
                )],
                ..AgentDiscovery::default()
            },
            AgentPlatform::Macos,
        );
        let refused = resolve_install_targets_with(
            &home,
            "demo",
            &["codex".to_string()],
            &known_agents_for_platform(AgentPlatform::Macos),
            &detected,
        )
        .expect_err("a case-different override is not the default root on macOS");
        assert!(refused.contains("Skill 目录未确认"), "{refused}");
        assert!(!home.join(".codex/skills/demo").exists());
        fs::remove_dir_all(root).expect("remove fixture");
    }
}
