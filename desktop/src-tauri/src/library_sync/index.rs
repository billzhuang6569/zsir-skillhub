//! Per-account sync index: the last synced state ("baseline") of every entry,
//! in-flight conflict copies and which unbound Skills stay on this device.
//! Stored as JSON under `~/.skillhub/library-sync/<userId>/`, written atomically.

use super::content::ContentIdentity;
use super::profile::SyncProfile;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// Version 2 drops every permanent "not on this device" state (#91); version 1
/// indexes are upgraded by the engine after a backup.
pub(crate) const INDEX_VERSION: u32 = 2;
pub(crate) const LEGACY_INDEX_VERSION: u32 = 1;

/// Last state both this device and the account agreed on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Baseline {
    #[serde(default)]
    pub(crate) version_state: crate::version_policy::RemoteVersion,
    #[serde(flatten)]
    pub(crate) content: ContentIdentity,
    pub(crate) profile: SyncProfile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IndexEntry {
    /// Local managed directory bound to the entry, if any.
    #[serde(default)]
    pub(crate) skill_id: Option<String>,
    pub(crate) revision: u64,
    pub(crate) card_sha256: String,
    pub(crate) baseline: Baseline,
    /// Non-retryable problem the user must resolve (quota, entry limit, ...).
    #[serde(default)]
    pub(crate) blocked: Option<String>,
    /// A rejected save may resume once the user replaces that exact intent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) blocked_version_request_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConflictKind {
    /// The account has a different version; replace the original afterwards.
    Replace,
    /// The entry was deleted from the account; trash the original afterwards.
    AccountDeleted,
    /// First binding without a trusted baseline; land the account version.
    Bind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConflictPhase {
    Snapshotted,
    CopyCreated,
    CopyPlaced,
    /// The original is being replaced with `replace_target`; on recovery the
    /// landing commit token tells whether that already happened.
    Replacing,
}

/// Account version the original directory is replaced with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplaceTarget {
    #[serde(default)]
    pub(crate) version_state: crate::version_policy::RemoteVersion,
    pub(crate) card_sha256: String,
    pub(crate) revision: u64,
    pub(crate) content: ContentIdentity,
    pub(crate) profile: SyncProfile,
}

/// What this operation last wrote to the copy entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WrittenCopy {
    #[serde(default)]
    pub(crate) version_state: crate::version_policy::RemoteVersion,
    pub(crate) card_sha256: String,
    pub(crate) content: ContentIdentity,
    pub(crate) profile: SyncProfile,
}

/// Exact state of the saved local snapshot; the original directory may only
/// be replaced while it still equals this.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotState {
    #[serde(flatten)]
    pub(crate) content: ContentIdentity,
    pub(crate) profile: SyncProfile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConflictOperation {
    pub(crate) kind: ConflictKind,
    pub(crate) original_entry_id: String,
    pub(crate) original_skill_id: String,
    /// Fixed for the whole operation, including re-snapshots and restarts.
    pub(crate) copy_entry_id: String,
    pub(crate) copy_skill_id: String,
    pub(crate) phase: ConflictPhase,
    /// Directory name under the account staging area.
    pub(crate) snapshot_dir: String,
    pub(crate) snapshot: SnapshotState,
    #[serde(default)]
    pub(crate) copy_revision: Option<u64>,
    #[serde(default)]
    pub(crate) copy_card_sha256: Option<String>,
    #[serde(default)]
    pub(crate) copy_written: Option<WrittenCopy>,
    #[serde(default)]
    pub(crate) replace_target: Option<ReplaceTarget>,
    #[serde(default)]
    pub(crate) blocked: Option<String>,
}

impl ConflictOperation {
    /// Version-message token of the landing that replaces the original.
    pub(crate) fn replace_token(&self) -> String {
        format!("[skillhub-sync:{}]", self.copy_entry_id)
    }
}

/// Version 1 confirmation-list item; read only to upgrade it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationCandidate {
    pub(crate) skill_id: String,
    pub(crate) local_id: String,
    pub(crate) display_name: String,
    /// `marketplace` | `team` | `local`
    pub(crate) kind: String,
    pub(crate) reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationState {
    /// The first pass for this account ran: managed Skills that appear later
    /// join the account automatically ("加入即同步").
    #[serde(default)]
    pub(crate) completed: bool,
    /// Unbound managed Skills (sidecar id -> reason) that stay on this device
    /// and are never uploaded automatically: they were here before this
    /// account's first pass and cannot be proven to belong to it, or the
    /// account deleted their entry. Only an explicit join adds them.
    #[serde(default)]
    pub(crate) kept_local: BTreeMap<String, String>,
    /// Explicit "加入账号同步" requests, retried until bound or refused.
    #[serde(default)]
    pub(crate) confirmed_local_ids: BTreeSet<String>,
    /// Join requests the server refused, with the reason shown to the user.
    #[serde(default)]
    pub(crate) refused: BTreeMap<String, String>,
    /// Version 1 only (confirmation list and "keep local" choices).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) candidates: Vec<MigrationCandidate>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub(crate) excluded_local_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncIndex {
    pub(crate) version: u32,
    pub(crate) user_id: String,
    #[serde(default)]
    pub(crate) entries: BTreeMap<String, IndexEntry>,
    /// Keyed by the original entry id.
    #[serde(default)]
    pub(crate) operations: BTreeMap<String, ConflictOperation>,
    #[serde(default)]
    pub(crate) migration: MigrationState,
}

impl SyncIndex {
    pub(crate) fn new(user_id: &str) -> Self {
        Self {
            version: INDEX_VERSION,
            user_id: user_id.to_string(),
            ..Self::default()
        }
    }
}

/// `~/.skillhub/library-sync/<userId>`; the user id must be a UUID.
pub(crate) fn account_dir(skillhub_root: &Path, user_id: &str) -> Result<PathBuf, String> {
    let user_id = uuid::Uuid::parse_str(user_id)
        .map_err(|_| "SkillHub 当前账号标识无效".to_string())?
        .to_string();
    Ok(skillhub_root.join("library-sync").join(user_id))
}

/// Version 1 marker files ("仅从这台电脑删除" / "交给工具自行管理") that
/// stopped downloads to this device; only read to upgrade them.
pub(crate) fn local_only_dir(skillhub_root: &Path, user_id: &str) -> Result<PathBuf, String> {
    Ok(account_dir(skillhub_root, user_id)?.join("local-only"))
}

/// Recoverable copies of state an upgrade replaced.
pub(crate) fn backups_dir(skillhub_root: &Path, user_id: &str) -> Result<PathBuf, String> {
    Ok(account_dir(skillhub_root, user_id)?.join("backups"))
}

pub(crate) fn staging_dir(skillhub_root: &Path, user_id: &str) -> Result<PathBuf, String> {
    Ok(account_dir(skillhub_root, user_id)?.join("staging"))
}

pub(crate) fn ensure_private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("无法创建同步目录: {error}"))?;
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("同步目录不是安全的真实目录".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Writes a new private file and fsyncs it before returning.
pub(crate) fn write_durably(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

/// Flushes a directory's entries to disk. On Unix a failure is an error, so
/// callers never treat an unflushed backup as durable. Windows cannot open a
/// directory for flushing through std; there NTFS journals the metadata and
/// this is a no-op (documented limitation of the upgrade backup guarantee).
pub(crate) fn sync_dir(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("无法把目录写入磁盘 {}: {error}", path.display()))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

pub(crate) fn index_path(skillhub_root: &Path, user_id: &str) -> Result<PathBuf, String> {
    Ok(account_dir(skillhub_root, user_id)?.join("index.json"))
}

pub(crate) fn load_index(skillhub_root: &Path, user_id: &str) -> Result<SyncIndex, String> {
    let path = index_path(skillhub_root, user_id)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("同步索引不是安全的普通文件".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SyncIndex::new(user_id));
        }
        Err(error) => return Err(error.to_string()),
    }
    let text = fs::read_to_string(&path).map_err(|error| format!("无法读取同步索引: {error}"))?;
    let index: SyncIndex =
        serde_json::from_str(&text).map_err(|error| format!("同步索引已损坏: {error}"))?;
    if !(LEGACY_INDEX_VERSION..=INDEX_VERSION).contains(&index.version) || index.user_id != user_id
    {
        return Err("同步索引不属于当前账号或版本不受支持".into());
    }
    Ok(index)
}

/// Temporary file, fsync, atomic rename, then fsync of the directory.
pub(crate) fn save_index(skillhub_root: &Path, index: &SyncIndex) -> Result<(), String> {
    let directory = account_dir(skillhub_root, &index.user_id)?;
    ensure_private_dir(&directory)?;
    let path = directory.join("index.json");
    let temporary = directory.join(format!(".index.{}.tmp", uuid::Uuid::new_v4()));
    let text = serde_json::to_vec_pretty(index).map_err(|error| error.to_string())?;
    let written: Result<(), String> = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&text).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
        if let Ok(directory) = File::open(&directory) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written.map_err(|error| format!("无法保存同步索引: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_atomically_and_rejects_other_accounts() {
        let root = std::env::temp_dir().join(format!("skillhub-index-{}", uuid::Uuid::new_v4()));
        let user = uuid::Uuid::new_v4().to_string();
        let mut index = load_index(&root, &user).unwrap();
        assert!(index.entries.is_empty());
        index.migration.completed = true;
        save_index(&root, &index).unwrap();
        assert_eq!(load_index(&root, &user).unwrap(), index);
        let other = uuid::Uuid::new_v4().to_string();
        fs::create_dir_all(account_dir(&root, &other).unwrap()).unwrap();
        fs::copy(
            account_dir(&root, &user).unwrap().join("index.json"),
            account_dir(&root, &other).unwrap().join("index.json"),
        )
        .unwrap();
        assert!(load_index(&root, &other).is_err());
        assert!(account_dir(&root, "../escape").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_that_cannot_be_flushed_is_an_error_on_unix() {
        let missing =
            std::env::temp_dir().join(format!("skillhub-missing-{}", uuid::Uuid::new_v4()));
        assert!(sync_dir(&missing).is_err());
        assert!(sync_dir(&std::env::temp_dir()).is_ok());
    }
}
