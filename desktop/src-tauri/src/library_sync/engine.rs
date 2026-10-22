//! One account sync pass: reconcile every managed Skill with the account
//! library (design §4). Local changes are never discarded: whenever both
//! sides changed incompatibly, the local version is first saved as a "副本"
//! entry, and only then may the original directory be replaced.

use super::api::{
    device_label, ApiError, CreateEntry, EntrySource, LibraryApi, RemoteEntry, UpdateEntry,
    LIBRARY_SYNC_CAPABILITY,
};
use super::content::{local_identity, package_executables, ContentIdentity};
use super::index::{
    account_dir, backups_dir, ensure_private_dir, index_path, load_index, local_only_dir,
    save_index, staging_dir, sync_dir, write_durably, Baseline, ConflictKind, ConflictOperation,
    ConflictPhase, IndexEntry, ReplaceTarget, SnapshotState, SyncIndex, WrittenCopy, INDEX_VERSION,
};
use super::profile::{merge3, SyncProfile, SOURCE_URL_CAPABILITY};
use crate::commands::{
    library_copy_tree, library_history_contains, library_package_bytes, library_read_profile,
    library_skill_is_system, library_tree_fingerprint, library_write_profile, LibraryLanding,
    LibraryLandingError, LibraryStateCheck,
};
use crate::skill_lock::{lock_skill_dir_at, try_lock_skill_dir_at, SkillDirLock};
use crate::{AcquisitionSource, SkillHubProfile};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// How many times one pass re-snapshots a directory that keeps changing.
const MAX_SNAPSHOT_ROUNDS: usize = 3;

/// Why an unbound managed Skill stays on this device (shown to the user).
pub(crate) const KEPT_BY_CHOICE: &str = "升级前选择了只保留在这台电脑";
pub(crate) const KEPT_ACCOUNT_DELETED: &str = "账号中已删除这个 Skill，这台电脑保留了一份";
const KEPT_MARKETPLACE: &str = "不是在当前账号登录时从 Skill 商店安装的，无法确认属于当前账号";
const KEPT_TEAM_OTHER: &str = "由其他账号从团队取得";
const KEPT_OTHER_ACCOUNT: &str = "在其他账号登录时加入 SkillHub";
const KEPT_LOCAL: &str =
    "不是在当前账号登录时加入 SkillHub 的（例如未登录时导入），无法确认属于当前账号";
const KEPT_BEFORE_FIRST_SYNC: &str = "首次同步前已在这台电脑上，无法确认属于当前账号";

#[derive(Debug, Clone)]
pub(crate) struct SyncPaths {
    pub(crate) skillhub_root: PathBuf,
    pub(crate) managed_root: PathBuf,
}

impl SyncPaths {
    fn skill(&self, skill_id: &str) -> PathBuf {
        self.managed_root.join(skill_id)
    }
}

/// Proof that the account which started the pass is still the APP account.
pub(crate) struct Held {
    _lease: Option<crate::runtime_env::CurrentSessionLease>,
}

impl Held {
    pub(crate) fn new(lease: Option<crate::runtime_env::CurrentSessionLease>) -> Self {
        Self { _lease: lease }
    }
}

pub(crate) trait AccountGuard {
    fn user_id(&self) -> &str;
    fn space_id(&self) -> &str {
        "official"
    }
    /// Must be held across every local write; fails once the account changed.
    fn hold(&self) -> Result<Held, SyncError>;
}

/// Local side effects that need the real APP environment.
pub(crate) trait LocalOps {
    fn land(&self, landing: LibraryLanding<'_>) -> Result<(), LibraryLandingError>;
    fn trash(&self, skill_id: &str) -> Result<(), String>;
    fn listed(&self, _entries: &[RemoteEntry], _index: &SyncIndex) {}
    fn progress(
        &self,
        _entry: &RemoteEntry,
        _received: u64,
        _total: Option<u64>,
        _phase: &str,
        _error: Option<&str>,
    ) {
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SyncError {
    /// The APP switched or signed out; nothing more is written for the old account.
    AccountChanged,
    Unauthorized,
    /// The Server does not offer library sync yet.
    Unsupported,
    /// Another sync pass for this account is running.
    Busy,
    Fatal(String),
}

impl SyncError {
    pub(crate) fn message(&self) -> String {
        match self {
            Self::AccountChanged => "同步期间账号已切换，已停止旧账号的同步".into(),
            Self::Unauthorized => "登录已失效，请重新登录后同步".into(),
            Self::Unsupported => "当前 SkillHub Server 尚未提供账号同步".into(),
            Self::Busy => "账号同步正在进行".into(),
            Self::Fatal(message) => message.clone(),
        }
    }
}

impl From<String> for SyncError {
    fn from(value: String) -> Self {
        Self::Fatal(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncProblem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) skill_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) entry_id: Option<String>,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncReport {
    pub(crate) uploaded: u32,
    pub(crate) downloaded: u32,
    pub(crate) profiles_updated: u32,
    pub(crate) copies_created: u32,
    pub(crate) trashed: u32,
    pub(crate) bound: u32,
    /// Unbound managed Skills that stay on this device (not uploaded).
    pub(crate) kept_local: u32,
    pub(crate) problems: Vec<SyncProblem>,
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct SyncOptions {
    /// Retry entries and copies blocked by quota or limits (manual sync).
    pub(crate) retry_blocked: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalSkill {
    pub(crate) skill_id: String,
    pub(crate) sidecar: SkillHubProfile,
}

/// Managed Skill folders with a readable sidecar (system Skills excluded).
/// `read` decides whether reading may normalise the sidecar on disk: the
/// engine may, a read-only status query passes `library_read_profile_readonly`.
pub(crate) fn scan_managed(
    managed_root: &Path,
    read: impl Fn(&Path) -> Result<SkillHubProfile, String>,
) -> Result<Vec<LocalSkill>, String> {
    let mut locals = Vec::new();
    let entries = match fs::read_dir(managed_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(locals),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let Some(skill_id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if skill_id.starts_with('.')
            || library_skill_is_system(&skill_id)
            || !is_skill_name(&skill_id)
        {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || !path.join("SKILL.md").is_file()
        {
            continue;
        }
        let Ok(sidecar) = read(&path) else {
            continue;
        };
        if sidecar.is_system {
            continue;
        }
        locals.push(LocalSkill { skill_id, sidecar });
    }
    locals.sort_by(|left, right| left.skill_id.cmp(&right.skill_id));
    Ok(locals)
}

/// Local state used for every comparison, plus the replacement fingerprint.
#[derive(Debug, Clone)]
struct LocalState {
    state: SnapshotState,
    /// The user cleared 「来源」 on this device and that clear is not synced yet.
    source_url_cleared: Option<String>,
    files: Vec<crate::commands::LibraryTreeFile>,
    tree_fingerprint: Vec<u8>,
}

enum Replacement {
    Finished,
    /// The original changed after the snapshot; a newer snapshot was taken.
    Resnapshotted,
    /// The copy is saved but the replacement must be retried later.
    Deferred,
}

pub(crate) struct Engine<'a, A: LibraryApi, G: AccountGuard, L: LocalOps> {
    api: &'a A,
    guard: &'a G,
    local: &'a L,
    paths: &'a SyncPaths,
    options: SyncOptions,
    user_id: String,
    data_root: PathBuf,
    device: String,
    index: SyncIndex,
    remote: BTreeMap<String, RemoteEntry>,
    report: SyncReport,
    version_policy_supported: bool,
    catalog_install: bool,
    /// The server stores 「来源」 (`skills.source-url.v1`). Without it the
    /// field stays a local-only sidecar value: never sent, never cleared.
    source_url_synced: bool,
}

/// Equal profiles, except that a folder without any source (a sidecar written
/// before #330) matches an entry that has one: that source is an account
/// value this folder has not received yet, not a conflicting edit.
fn same_profile_but_unseen_source(local: &SyncProfile, remote: &SyncProfile) -> bool {
    local == remote
        || (local.source_url.is_none()
            && *local
                == SyncProfile {
                    source_url: None,
                    ..remote.clone()
                })
}

/// The synced profile of a sidecar; the source is left out when the server
/// cannot store it, so it neither uploads nor reads as a local change.
fn synced_profile(
    sidecar: &SkillHubProfile,
    skill_id: &str,
    source_url_synced: bool,
) -> SyncProfile {
    let mut profile = SyncProfile::from_sidecar(sidecar, skill_id);
    if !source_url_synced {
        profile.source_url = None;
    }
    profile
}

fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn is_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}

fn is_skill_name(value: &str) -> bool {
    let mut characters = value.chars();
    value.len() <= 128
        && matches!(characters.next(), Some(character) if character.is_ascii_alphanumeric())
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

impl<'a, A: LibraryApi, G: AccountGuard, L: LocalOps> Engine<'a, A, G, L> {
    pub(crate) fn new(
        api: &'a A,
        guard: &'a G,
        local: &'a L,
        paths: &'a SyncPaths,
        options: SyncOptions,
    ) -> Self {
        Self {
            api,
            guard,
            local,
            paths,
            options,
            user_id: guard.user_id().to_string(),
            data_root: if guard.space_id() == "official" {
                paths.skillhub_root.clone()
            } else {
                paths.skillhub_root.join("spaces").join(guard.space_id())
            },
            device: device_label(),
            index: SyncIndex::default(),
            remote: BTreeMap::new(),
            report: SyncReport::default(),
            version_policy_supported: false,
            catalog_install: false,
            source_url_synced: false,
        }
    }

    // ── Pass ────────────────────────────────────────────────────────────────

    pub(crate) async fn run(mut self) -> Result<SyncReport, SyncError> {
        let _run_lock =
            try_lock_skill_dir_at(&self.data_root, &format!("library-sync-{}", self.user_id))?
                .ok_or(SyncError::Busy)?;
        let capabilities = self.api.capabilities().await.map_err(api_fatal)?;
        self.catalog_install = self.api.catalog_install().await.map_err(api_fatal)?;
        self.version_policy_supported = capabilities
            .iter()
            .any(|c| c == crate::version_policy::CAPABILITY);
        self.source_url_synced = capabilities.iter().any(|c| c == SOURCE_URL_CAPABILITY);
        if !capabilities
            .iter()
            .any(|capability| capability == LIBRARY_SYNC_CAPABILITY)
        {
            return Err(SyncError::Unsupported);
        }
        self.index = load_index(&self.data_root, &self.user_id)?;
        self.upgrade_legacy_state()?;
        self.refresh_remote().await?;

        let pending = self.index.operations.keys().cloned().collect::<Vec<_>>();
        for entry_id in pending {
            self.advance_operation(&entry_id).await?;
        }

        let locals = self.scan()?;
        self.adopt_bound_locals(&locals).await?;
        let entry_ids = self.index.entries.keys().cloned().collect::<Vec<_>>();
        for entry_id in entry_ids {
            if self.index.operations.contains_key(&entry_id) {
                continue;
            }
            self.sync_entry(&entry_id, 0).await?;
        }
        // Bind local copies first, so an entry another device created for the
        // same asset (same migration key) is not downloaded a second time.
        let locals = self.scan()?;
        self.bind_unbound_locals(&locals).await?;
        let locals = self.scan()?;
        self.download_new_entries(&locals).await?;
        self.report.kept_local = self
            .scan()?
            .iter()
            .filter(|local| {
                local.sidecar.library_account_id.is_none()
                    && local
                        .sidecar
                        .id
                        .as_ref()
                        .is_some_and(|id| self.index.migration.kept_local.contains_key(id))
            })
            .count() as u32;
        self.save()?;
        Ok(self.report)
    }

    async fn refresh_remote(&mut self) -> Result<(), SyncError> {
        let entries = self.api.list().await.map_err(api_fatal)?;
        self.local.listed(&entries, &self.index);
        self.remote = entries
            .into_iter()
            .map(|entry| (entry.id.clone(), entry))
            .collect();
        Ok(())
    }

    /// One-time upgrade of version 1 state (#91). Markers that stopped
    /// downloads to this device are dropped, and "keep local" choices and the
    /// unanswered confirmation list become kept-local Skills (never uploaded
    /// automatically). Everything replaced is first copied to `backups/`;
    /// Skill folders are not touched here, so a re-download never overwrites
    /// one (`free_skill_id`).
    fn upgrade_legacy_state(&mut self) -> Result<(), SyncError> {
        let markers_dir = local_only_dir(&self.data_root, &self.user_id)?;
        let markers_exist = fs::symlink_metadata(&markers_dir).is_ok();
        if self.index.version >= INDEX_VERSION && !markers_exist {
            return Ok(());
        }
        let markers = legacy_markers(&markers_dir)?;
        // Every version 1 index is backed up before the first version 2 save
        // (v0.26 cannot read version 2), even with nothing else to convert.
        // An interrupted upgrade simply takes another backup next time.
        if self.index.version < INDEX_VERSION || !markers.is_empty() {
            let _held = self.guard.hold()?;
            self.backup_legacy_state(&markers)?;
        }
        let migration = &mut self.index.migration;
        for local_id in std::mem::take(&mut migration.excluded_local_ids) {
            migration
                .kept_local
                .entry(local_id)
                .or_insert_with(|| KEPT_BY_CHOICE.into());
        }
        for candidate in std::mem::take(&mut migration.candidates) {
            let reason = match candidate.kind.as_str() {
                "marketplace" => KEPT_MARKETPLACE,
                "team" => KEPT_TEAM_OTHER,
                _ => KEPT_BEFORE_FIRST_SYNC,
            };
            migration
                .kept_local
                .entry(candidate.local_id)
                .or_insert_with(|| reason.into());
        }
        self.index.version = INDEX_VERSION;
        // The new index is durable before any marker goes away.
        self.save()?;
        if markers_exist {
            let _held = self.guard.hold()?;
            for marker in &markers {
                fs::remove_file(marker)
                    .map_err(|error| format!("无法清理旧的“仅本机”标记，已备份: {error}"))?;
            }
            let _ = fs::remove_dir(&markers_dir);
        }
        Ok(())
    }

    /// `backups/upgrade-v2-<time>-<id>/`: the version 1 index file as it was,
    /// the marker files and a manifest. Every file and directory is fsynced
    /// in a hidden `.partial-…` directory that is then renamed into place,
    /// so a backup either exists completely and durably or not at all,
    /// before the version 2 index is saved. Caller holds the account.
    fn backup_legacy_state(&self, markers: &[PathBuf]) -> Result<(), SyncError> {
        let backups = backups_dir(&self.data_root, &self.user_id)?;
        ensure_private_dir(&backups)?;
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let name = format!("upgrade-v2-{seconds}-{}", &new_uuid()[..8]);
        let partial = backups.join(format!(".partial-{name}"));
        ensure_private_dir(&partial)?;
        let index_file = index_path(&self.data_root, &self.user_id)?;
        if index_file.is_file() {
            let bytes =
                fs::read(&index_file).map_err(|error| format!("无法备份同步索引: {error}"))?;
            write_durably(&partial.join("index.json"), &bytes)
                .map_err(|error| format!("无法备份同步索引: {error}"))?;
        }
        if !markers.is_empty() {
            let marker_backup = partial.join("local-only");
            ensure_private_dir(&marker_backup)?;
            for marker in markers {
                if let Some(name) = marker.file_name() {
                    let bytes = fs::read(marker)
                        .map_err(|error| format!("无法备份“仅本机”标记: {error}"))?;
                    write_durably(&marker_backup.join(name), &bytes)
                        .map_err(|error| format!("无法备份“仅本机”标记: {error}"))?;
                }
            }
            sync_dir(&marker_backup)?;
        }
        let migration = &self.index.migration;
        let manifest = serde_json::json!({
            "createdAt": seconds,
            "fromIndexVersion": self.index.version,
            "toIndexVersion": INDEX_VERSION,
            "note": "Version 1 sync state replaced by the #91 upgrade. Skill folders were not changed; restore by copying index.json and local-only/ back into the account directory with an older SkillHub.",
            "localOnlyEntryIds": markers
                .iter()
                .filter_map(|marker| marker.file_name()?.to_str().map(str::to_string))
                .collect::<Vec<_>>(),
            "excludedLocalIds": migration.excluded_local_ids,
            "pendingCandidates": migration.candidates,
        });
        let text = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
        write_durably(&partial.join("manifest.json"), &text)
            .map_err(|error| format!("无法写入升级备份说明: {error}"))?;
        sync_dir(&partial)?;
        fs::rename(&partial, backups.join(&name))
            .map_err(|error| format!("无法完成升级备份: {error}"))?;
        sync_dir(&backups)?;
        sync_dir(&account_dir(&self.data_root, &self.user_id)?)?;
        Ok(())
    }

    fn save(&self) -> Result<(), SyncError> {
        let _held = self.guard.hold()?;
        save_index(&self.data_root, &self.index)?;
        Ok(())
    }

    fn problem(
        &mut self,
        skill_id: Option<&str>,
        entry_id: Option<&str>,
        message: impl Into<String>,
    ) {
        self.report.problems.push(SyncProblem {
            skill_id: skill_id.map(str::to_string),
            entry_id: entry_id.map(str::to_string),
            message: message.into(),
        });
    }

    fn lock(&self, skill_id: &str) -> Result<SkillDirLock, SyncError> {
        Ok(lock_skill_dir_at(&self.paths.skillhub_root, skill_id)?)
    }

    // ── Local scan and state ────────────────────────────────────────────────

    fn scan(&self) -> Result<Vec<LocalSkill>, SyncError> {
        Ok(
            scan_managed(&self.paths.managed_root, library_read_profile)?
                .into_iter()
                .filter(|local| self.owns_scope(&local.sidecar))
                .collect(),
        )
    }

    fn owns_scope(&self, sidecar: &SkillHubProfile) -> bool {
        crate::spaces::profile_matches_identity(sidecar, self.guard.space_id(), &self.user_id)
    }

    fn scope(&self) -> crate::spaces::SidecarScope {
        crate::spaces::SidecarScope {
            space_id: self.guard.space_id().into(),
            runtime_user_id: self.user_id.clone(),
        }
    }

    fn local_state(
        &self,
        skill_id: &str,
        baseline_executables: Option<&[String]>,
    ) -> Result<LocalState, String> {
        let root = self.paths.skill(skill_id);
        let (content, files) = local_identity(&root, baseline_executables)?;
        let sidecar = library_read_profile(&root)?;
        if !self.owns_scope(&sidecar) {
            return Err("此 Skill 属于其他空间或账号".into());
        }
        Ok(LocalState {
            state: SnapshotState {
                content,
                profile: synced_profile(&sidecar, skill_id, self.source_url_synced),
            },
            source_url_cleared: sidecar.source_url_cleared.clone(),
            files,
            tree_fingerprint: library_tree_fingerprint(&root)?,
        })
    }

    fn skill_exists(&self, skill_id: &str) -> bool {
        fs::symlink_metadata(self.paths.skill(skill_id)).is_ok()
    }

    fn bound_to(&self, sidecar: &SkillHubProfile) -> Option<String> {
        (self.owns_scope(sidecar)
            && sidecar.library_account_id.as_deref() == Some(self.user_id.as_str()))
        .then(|| sidecar.library_entry_id.clone())
        .flatten()
    }

    fn write_sidecar(
        &self,
        skill_id: &str,
        update: impl FnOnce(&mut SkillHubProfile),
    ) -> Result<(), SyncError> {
        let root = self.paths.skill(skill_id);
        let mut sidecar = library_read_profile(&root)?;
        if !self.owns_scope(&sidecar) {
            return Err(SyncError::AccountChanged);
        }
        update(&mut sidecar);
        sidecar.scope = Some(self.scope());
        let _held = self.guard.hold()?;
        library_write_profile(&root, &sidecar)?;
        Ok(())
    }

    // ── Remote content transfer ─────────────────────────────────────────────

    async fn upload(&mut self, root: &Path, local: &LocalState) -> Result<String, ApiError> {
        let executables = package_executables(&local.files, &local.state.content);
        let package = library_package_bytes(root, executables.as_ref()).map_err(|message| {
            ApiError::Rejected {
                status: 400,
                message,
                code: None,
            }
        })?;
        let card = self.api.upload_card(&package).await?;
        self.report.uploaded += 1;
        Ok(card.sha256)
    }

    /// Downloads the entry's card and places it, keeping local-only sidecar
    /// data. `expected` is the full local state verified under the lock; the
    /// landing re-checks it right before switching directories.
    async fn pull(
        &mut self,
        entry: &RemoteEntry,
        skill_id: &str,
        expected: Option<&Expected>,
        profile: &SyncProfile,
        message: &str,
    ) -> Result<bool, SyncError> {
        let Some(card) = entry.card.clone() else {
            return Ok(false);
        };
        self.local
            .progress(entry, 0, Some(card.size), "downloading", None);
        let progress = |received: u64, total: Option<u64>| {
            self.local.progress(
                entry,
                received,
                total.or(Some(card.size)),
                "downloading",
                None,
            )
        };
        let package = match self
            .api
            .download_card_progress(&card.sha256, &progress)
            .await
        {
            Ok(package) => package,
            Err(ApiError::Unauthorized) => return Err(SyncError::Unauthorized),
            Err(error) => {
                self.local
                    .progress(entry, 0, Some(card.size), "error", Some(&error.message()));
                self.problem(Some(skill_id), Some(&entry.id), error.message());
                return Ok(false);
            }
        };
        // The run lock excludes this device's deletion; another device can
        // delete or update during download. Do not land a stale account card.
        let fresh = match self.api.list().await {
            Ok(entries) => entries,
            Err(ApiError::Unauthorized) => return Err(SyncError::Unauthorized),
            Err(error) => {
                self.local
                    .progress(entry, 0, Some(card.size), "error", Some(&error.message()));
                self.problem(Some(skill_id), Some(&entry.id), error.message());
                return Ok(false);
            }
        };
        if !fresh.iter().any(|remote| {
            remote.id == entry.id
                && !remote.deleted
                && remote.card.as_ref().map(|card| &card.sha256) == Some(&card.sha256)
        }) {
            self.problem(
                Some(skill_id),
                Some(&entry.id),
                "账号条目已变化，稍后重新同步",
            );
            return Ok(false);
        }
        self.local.progress(
            entry,
            package.len() as u64,
            Some(card.size),
            "landing",
            None,
        );
        let root = self.paths.skill(skill_id);
        let mut sidecar = if expected.is_some() {
            library_read_profile(&root)?
        } else {
            let mut sidecar = new_sidecar(entry, skill_id, &card.sha256);
            if let Some(name) = super::content::package_skill_name(&package) {
                sidecar.name = Some(name);
            }
            sidecar
        };
        if expected.is_some() && !self.owns_scope(&sidecar) {
            return Err(SyncError::AccountChanged);
        }
        sidecar.scope = Some(self.scope());
        if entry.source_kind == "catalog" {
            sidecar.catalog_origin = entry.source_origin.clone();
            sidecar.is_own = Some(false);
            sidecar.acquisition_source = Some(AcquisitionSource::Marketplace);
            sidecar.acquisition_package_sha256 = Some(card.sha256.clone());
            sidecar.acquisition_version = entry.source_version_id.clone();
            if let Some(version) = &entry.source_version_id {
                sidecar.version = version.clone();
            }
        }
        profile.apply_to_sidecar(&mut sidecar, self.source_url_synced);
        sidecar.library_account_id = Some(self.user_id.clone());
        sidecar.library_entry_id = Some(entry.id.clone());
        let verify = expected.map(|expected| expected.verifier(skill_id));
        let _held = self.guard.hold()?;
        match self.local.land(LibraryLanding {
            skill_id,
            package: &package,
            profile: sidecar,
            expected_existing: expected.map(|expected| expected.tree_fingerprint.as_slice()),
            verify_existing: verify.as_ref().map(|verify| verify as &LibraryStateCheck),
            message,
        }) {
            Ok(()) => {
                if !self.apply_remote_version(skill_id, entry)? {
                    return Ok(false);
                }
                self.local
                    .progress(entry, package.len() as u64, Some(card.size), "ready", None);
                self.report.downloaded += 1;
                Ok(true)
            }
            // Edited after the check (e.g. by an external editor): the next
            // pass sees both sides changed and saves a copy first.
            Err(LibraryLandingError::LocalChanged) => {
                self.local.progress(
                    entry,
                    0,
                    Some(card.size),
                    "error",
                    Some("本机内容正在修改，稍后自动重试"),
                );
                Ok(false)
            }
            Err(LibraryLandingError::Failed(message)) => {
                self.local
                    .progress(entry, 0, Some(card.size), "error", Some(&message));
                self.problem(Some(skill_id), Some(&entry.id), message);
                Ok(false)
            }
        }
    }

    // ── Bound entries ───────────────────────────────────────────────────────

    async fn sync_entry(&mut self, entry_id: &str, depth: u8) -> Result<(), SyncError> {
        let Some(indexed) = self.index.entries.get(entry_id).cloned() else {
            return Ok(());
        };
        let remote = self.remote.get(entry_id).cloned();
        // A folder only counts as the entry's when its own sidecar says so: a
        // different Skill that later took the same folder name is never read
        // as edits of this entry (and never uploaded into it).
        let local_skill = indexed.skill_id.clone().filter(|skill_id| {
            self.skill_exists(skill_id) && !self.claimed_by_other(skill_id, entry_id)
        });

        let Some(skill_id) = local_skill else {
            if indexed.blocked.is_some() && !self.options.retry_blocked {
                return Ok(());
            }
            match remote {
                // Every active entry is on every device; a missing folder
                // (deleted outside SkillHub, or never placed) is downloaded.
                Some(remote) if !remote.deleted => {
                    let skill_id = indexed
                        .skill_id
                        .clone()
                        .filter(|skill_id| self.folder_name_free_for(entry_id, skill_id))
                        .unwrap_or_else(|| self.free_skill_id(&remote.name, &remote.id));
                    self.download_into(&remote, &skill_id).await?;
                }
                _ => {
                    self.index.entries.remove(entry_id);
                }
            }
            return Ok(());
        };

        let _lock = self.lock(&skill_id)?;
        if indexed.blocked.is_some() && !self.options.retry_blocked {
            let changed_save = indexed
                .blocked_version_request_id
                .as_ref()
                .is_some_and(|old| {
                    self.pending_save_id(&skill_id)
                        .is_some_and(|current| current != *old)
                });
            if !changed_save {
                return Ok(());
            }
        }
        // Prefer a server-confirmed identity when one will be applied below.
        // Older servers have no version receipt, so initialise saved local
        // content without waiting for a protocol they do not implement.
        if remote.as_ref().is_some_and(|entry| {
            !entry.deleted
                && (!self.version_policy_supported || entry.version_state.version.is_none())
        }) {
            self.ensure_local_version(&skill_id, entry_id)?;
        }
        let local =
            match self.local_state(&skill_id, Some(&indexed.baseline.content.executable_paths)) {
                Ok(local) => local,
                Err(message) => {
                    self.problem(Some(&skill_id), Some(entry_id), message);
                    return Ok(());
                }
            };
        let local_changed = local.state.content != indexed.baseline.content
            || local.state.profile != indexed.baseline.profile;
        if library_read_profile(&self.paths.skill(&skill_id))?
            .catalog_origin
            .is_some()
            && local.state.content != indexed.baseline.content
            && self.official_update(&skill_id, &indexed).is_none()
        {
            self.problem(
                Some(&skill_id),
                Some(entry_id),
                "官方商店 Skill 的本机内容已修改，保留在本机；请重新下载官方版本后同步",
            );
            return Ok(());
        }

        let remote = match remote {
            Some(remote) if !remote.deleted && remote.card.is_some() => remote,
            _ => {
                if local_changed {
                    drop(_lock);
                    return self
                        .start_conflict(ConflictKind::AccountDeleted, entry_id, &skill_id)
                        .await;
                }
                {
                    let _held = self.guard.hold()?;
                    self.local.trash(&skill_id)?;
                }
                self.index.entries.remove(entry_id);
                self.report.trashed += 1;
                return Ok(());
            }
        };
        let remote_content = remote
            .card
            .as_ref()
            .map(|card| card.identity())
            .unwrap_or_else(|| local.state.content.clone());
        let version_profile = library_read_profile(&self.paths.skill(&skill_id))?;
        let version_metadata = &version_profile.version_metadata;
        let pending_receipt =
            crate::version_policy::current(&self.paths.skill(&skill_id), version_metadata)
                .is_some_and(|mapped| mapped.pending.is_some());
        if self.version_policy_supported
            && (remote.version_state != indexed.baseline.version_state || pending_receipt)
        {
            match self.refresh_version_history(&skill_id, &remote).await {
                Ok(()) => {}
                Err(ApiError::Unauthorized) => return Err(SyncError::Unauthorized),
                Err(error) => return self.entry_api_failure(entry_id, &skill_id, error),
            }
        }
        let base = &indexed.baseline;
        let local_files_changed = local.state.content != base.content;
        let remote_files_changed = remote_content != base.content;
        if local_files_changed && remote_files_changed && local.state.content != remote_content {
            drop(_lock);
            return self
                .start_conflict(ConflictKind::Replace, entry_id, &skill_id)
                .await;
        }
        let Some(mut merged) = merge3(&base.profile, &local.state.profile, &remote.profile) else {
            drop(_lock);
            return self
                .start_conflict(ConflictKind::Replace, entry_id, &skill_id)
                .await;
        };
        // A source the user cleared here before this entry ever synced one
        // (base and local both None) must not come back from the account —
        // but only that exact URL: a newer source set elsewhere wins.
        if self.source_url_synced
            && local.source_url_cleared.is_some()
            && local.source_url_cleared == remote.profile.source_url
            && base.profile.source_url.is_none()
            && local.state.profile.source_url.is_none()
        {
            merged.source_url = None;
        }
        // Only a source the account actually holds is cleared explicitly;
        // otherwise an absent source is omitted and the server keeps or
        // inherits its own.
        let clear_source_url = self.source_url_synced
            && merged.source_url.is_none()
            && remote.profile.source_url.is_some();

        let mut take_local_files = local_files_changed && !remote_files_changed;
        let mut revision = remote.revision;
        let mut card_sha256 = remote
            .card
            .as_ref()
            .map(|card| card.sha256.clone())
            .unwrap_or_default();
        let content = if take_local_files {
            local.state.content.clone()
        } else {
            remote_content.clone()
        };

        let mut base_revision = remote.revision;
        let pending = self
            .pending_version(&skill_id, &local.state.content, &card_sha256)
            .await?;
        let mut needs_put = take_local_files || remote.profile != merged || pending.is_some();
        // A store or team update the user installed here: point the entry at
        // the official version (granting it) instead of uploading a copy.
        if let Some(official) = (take_local_files || remote.source_kind == "catalog")
            .then(|| self.official_update(&skill_id, &indexed))
            .flatten()
        {
            let catalog = matches!(official, EntrySource::Catalog { .. });
            let refused_key = match &official {
                EntrySource::Catalog { package_sha256, .. } => {
                    format!("{entry_id}:{package_sha256}")
                }
                _ => entry_id.to_string(),
            };
            if catalog {
                if !self.catalog_install {
                    return Ok(());
                }
                if let Some(reason) = self.index.migration.refused.get(&refused_key).cloned() {
                    self.problem(Some(&skill_id), Some(entry_id), reason);
                    return Ok(());
                }
                let sidecar = library_read_profile(&self.paths.skill(&skill_id))?;
                if let Err(error) = self.upload_catalog(&official, &sidecar, &skill_id).await {
                    if matches!(error, ApiError::Unauthorized) {
                        return Err(SyncError::Unauthorized);
                    }
                    self.catalog_problem(&skill_id, &refused_key, &error);
                    return Ok(());
                }
            }
            let request = UpdateEntry {
                version_intent: None,
                base_revision,
                profile: Some(merged.clone()),
                source: Some(official),
                device: self.device.clone(),
                source_url_synced: self.source_url_synced,
                clear_source_url,
            };
            match self.api.update_entry(entry_id, &request).await {
                Ok(updated) => {
                    base_revision = updated.revision;
                    revision = updated.revision;
                    if updated.card.as_ref().map(|card| card.identity()).as_ref()
                        == Some(&local.state.content)
                    {
                        card_sha256 = updated
                            .card
                            .as_ref()
                            .map(|card| card.sha256.clone())
                            .unwrap_or(card_sha256);
                        self.remember_source_card(&skill_id, &updated)?;
                        if !self.apply_remote_version(&skill_id, &updated)? {
                            return Ok(());
                        }
                        self.remote.insert(entry_id.to_string(), updated);
                        take_local_files = false;
                        needs_put = self
                            .pending_version(&skill_id, &local.state.content, &card_sha256)
                            .await?
                            .is_some();
                    } else if catalog {
                        self.problem(
                            Some(&skill_id),
                            Some(entry_id),
                            "本机内容与官方包不同，保留在本机",
                        );
                        return Ok(());
                    }
                }
                Err(ApiError::Unauthorized) => return Err(SyncError::Unauthorized),
                Err(error) if catalog => {
                    self.catalog_problem(&skill_id, &refused_key, &error);
                    return Ok(());
                }
                // Unavailable or changed upstream: upload the local bytes instead.
                Err(_) => {}
            }
        }

        if needs_put {
            let source = if take_local_files {
                let selected = match &pending {
                    Some(crate::version_policy::VersionIntent::Select { receipt_id }) => {
                        let sidecar = library_read_profile(&self.paths.skill(&skill_id))?;
                        crate::version_policy::current(
                            &self.paths.skill(&skill_id),
                            &sidecar.version_metadata,
                        )
                        .and_then(|m| m.receipt)
                        .filter(|r| &r.receipt_id == receipt_id)
                    }
                    _ => None,
                };
                let existing_card = if let Some(receipt) = selected {
                    match self.api.card_meta(&receipt.card_sha256).await {
                        Ok(Some(card)) if card.identity() == local.state.content => {
                            Some(receipt.card_sha256)
                        }
                        Ok(_) => None,
                        Err(error) => return self.entry_api_failure(entry_id, &skill_id, error),
                    }
                } else {
                    None
                };
                let card = if let Some(card) = existing_card {
                    Ok(card)
                } else {
                    self.upload(&self.paths.skill(&skill_id), &local).await
                };
                match card {
                    Ok(sha256) => Some(EntrySource::Card {
                        card_sha256: sha256,
                        provenance: None,
                    }),
                    Err(error) => return self.entry_api_failure(entry_id, &skill_id, error),
                }
            } else {
                None
            };
            let request = UpdateEntry {
                version_intent: self
                    .pending_version(
                        &skill_id,
                        &local.state.content,
                        source
                            .as_ref()
                            .and_then(|s| match s {
                                EntrySource::Card { card_sha256, .. } => Some(card_sha256.as_str()),
                                _ => None,
                            })
                            .unwrap_or(&card_sha256),
                    )
                    .await?,
                base_revision,
                profile: Some(merged.clone()),
                source,
                device: self.device.clone(),
                source_url_synced: self.source_url_synced,
                clear_source_url,
            };
            match self.api.update_entry(entry_id, &request).await {
                Ok(updated) => {
                    if !self.apply_remote_version(&skill_id, &updated)? {
                        return Ok(());
                    }
                    if updated.profile != merged {
                        self.remote.insert(entry_id.to_string(), updated);
                        drop(_lock);
                        if depth < 2 {
                            return Box::pin(self.sync_entry(entry_id, depth + 1)).await;
                        }
                        self.problem(
                            Some(&skill_id),
                            Some(entry_id),
                            "账号资料在保存期间变化，已保留本机资料，稍后继续合并",
                        );
                        return Ok(());
                    }
                    if take_local_files {
                        let server_content = updated.card.as_ref().map(|card| card.identity());
                        if server_content.as_ref() != Some(&local.state.content) {
                            self.remote.insert(entry_id.to_string(), updated);
                            drop(_lock);
                            if depth < 2 {
                                return Box::pin(self.sync_entry(entry_id, depth + 1)).await;
                            }
                            self.problem(
                                Some(&skill_id),
                                Some(entry_id),
                                "账号当前内容已变化，已保留本机版本，稍后重试",
                            );
                            return Ok(());
                        }
                    }
                    revision = updated.revision;
                    card_sha256 = updated
                        .card
                        .as_ref()
                        .map(|card| card.sha256.clone())
                        .unwrap_or(card_sha256);
                    self.remote.insert(entry_id.to_string(), updated);
                }
                Err(ApiError::Conflict {
                    entry: Some(current),
                    ..
                }) if depth == 0 => {
                    if !self.apply_remote_version(&skill_id, &current)? {
                        return Ok(());
                    }
                    // Someone else changed it meanwhile: re-evaluate against it.
                    self.remote.insert(entry_id.to_string(), *current);
                    drop(_lock);
                    return Box::pin(self.sync_entry(entry_id, depth + 1)).await;
                }
                Err(error) => return self.entry_api_failure(entry_id, &skill_id, error),
            }
            if !take_local_files && remote.profile != merged {
                self.report.profiles_updated += 1;
            }
        }

        if remote_files_changed && !local_files_changed && local.state.content != remote_content {
            if !self
                .pull(
                    &remote,
                    &skill_id,
                    Some(&Expected::of(&local, self.source_url_synced)),
                    &merged,
                    "从账号同步",
                )
                .await?
            {
                return Ok(());
            }
        } else if local.state.profile != merged {
            let merged_profile = merged.clone();
            let source_url_synced = self.source_url_synced;
            self.write_sidecar(&skill_id, |sidecar| {
                merged_profile.apply_to_sidecar(sidecar, source_url_synced)
            })?;
            self.report.profiles_updated += 1;
        }

        if let Some(actual) = self.remote.get(entry_id).cloned() {
            if !self.apply_remote_version(&skill_id, &actual)? {
                return Ok(());
            }
        }
        let entry = self.index.entries.get_mut(entry_id).expect("indexed entry");
        entry.revision = revision;
        entry.card_sha256 = card_sha256;
        entry.baseline = Baseline {
            version_state: self
                .remote
                .get(entry_id)
                .map(|r| r.version_state.clone())
                .unwrap_or_default(),
            content,
            profile: merged,
        };
        entry.blocked = None;
        entry.blocked_version_request_id = None;
        if local.source_url_cleared.is_some() && self.source_url_synced {
            // The clear reached the account or lost to a newer source; later
            // remote sources apply normally. A clear made during this pass
            // (a different tombstone) is kept for the next one.
            let read = local.source_url_cleared.clone();
            self.write_sidecar(&skill_id, |sidecar| {
                if sidecar.source_url_cleared == read {
                    sidecar.source_url_cleared = None;
                }
            })?;
        }
        Ok(())
    }

    /// Entry source for a store/team version installed on this device since
    /// the last sync (its package hash differs from the synced card).
    fn official_update(&self, skill_id: &str, indexed: &IndexEntry) -> Option<EntrySource> {
        let sidecar = library_read_profile(&self.paths.skill(skill_id)).ok()?;
        let installed = sidecar.acquisition_package_sha256.clone()?;
        if installed == indexed.card_sha256 {
            return None;
        }
        let plan = classify(
            &LocalSkill {
                skill_id: skill_id.to_string(),
                sidecar,
            },
            &self.user_id,
        );
        matches!(
            plan.kind,
            PlanKind::Marketplace | PlanKind::TeamOwn | PlanKind::TeamOther
        )
        .then_some(plan.source)
        .flatten()
    }

    async fn pending_version(
        &self,
        skill_id: &str,
        content: &ContentIdentity,
        card: &str,
    ) -> Result<Option<crate::version_policy::VersionIntent>, SyncError> {
        if !self.version_policy_supported {
            return Ok(None);
        }
        let path = self.paths.skill(skill_id);
        let sidecar = library_read_profile(&path)?;
        if sidecar.catalog_origin.is_some() {
            return Ok(None);
        }
        let pending =
            crate::version_policy::pending_for(&path, &sidecar.version_metadata, content, card);
        if pending.is_some() {
            return Ok(pending);
        }
        let source = sidecar
            .library_entry_id
            .as_ref()
            .and_then(|id| self.remote.get(id))
            .filter(|remote| {
                remote.version_state.version.is_none()
                    && remote
                        .card
                        .as_ref()
                        .is_some_and(|c| &c.identity() == content)
            })
            .and_then(|remote| {
                Some((
                    remote
                        .source_skill_id
                        .as_deref()
                        .or(remote.author_skill_id.as_deref())?,
                    remote.source_version_id.as_deref()?,
                ))
            });
        let Some((skill, version_id)) = source else {
            return Ok(None);
        };
        if sidecar
            .version_metadata
            .source_cards
            .get(version_id)
            .is_some_and(|known| known == card)
        {
            return Ok(Some(crate::version_policy::VersionIntent::Formal {
                version_id: version_id.into(),
            }));
        }
        match self.api.formal_card(skill, version_id).await {
            Ok(Some(formal)) if &formal.identity() == content && formal.sha256 == card => {
                Ok(Some(crate::version_policy::VersionIntent::Formal {
                    version_id: version_id.into(),
                }))
            }
            Ok(_) | Err(ApiError::Rejected { .. }) => Ok(None),
            Err(error) => Err(api_fatal(error)),
        }
    }

    // Only an actual formal-source create/update response proves this pair.
    // A later GET's provenance can remain after an ordinary Card upload.
    fn remember_source_card(&self, skill_id: &str, remote: &RemoteEntry) -> Result<(), SyncError> {
        if remote.source_kind == "catalog" {
            return Ok(());
        }
        let (Some(version_id), Some(card)) = (&remote.source_version_id, &remote.card) else {
            return Ok(());
        };
        if uuid::Uuid::parse_str(version_id).is_err() {
            return Err(SyncError::Fatal("来源正式版本 UUID 无效".into()));
        }
        let _held = self.guard.hold()?;
        let path = self.paths.skill(skill_id);
        let mut sidecar = library_read_profile(&path)?;
        sidecar
            .version_metadata
            .source_cards
            .insert(version_id.clone(), card.sha256.clone());
        crate::commands::write_version_profile_at(&path, &sidecar)?;
        Ok(())
    }

    fn apply_remote_version(
        &mut self,
        skill_id: &str,
        remote: &RemoteEntry,
    ) -> Result<bool, SyncError> {
        if remote.source_kind == "catalog" {
            self.write_sidecar(skill_id, |sidecar| {
                sidecar.catalog_origin = remote.source_origin.clone();
                sidecar.acquisition_version = remote.source_version_id.clone();
                sidecar.is_own = Some(false);
                if let Some(version) = &remote.source_version_id {
                    sidecar.version = version.clone();
                }
            })?;
        }
        if !self.version_policy_supported || remote.version_state.version_policy != Some(1) {
            self.ensure_local_version(skill_id, &remote.id)?;
            return Ok(true);
        }
        if remote
            .version_state
            .version_high_water
            .is_none_or(|water| !(-1..=999).contains(&water))
            || remote
                .version_state
                .version
                .as_ref()
                .is_some_and(|receipt| {
                    remote.card.as_ref().map(|c| &c.sha256) != Some(&receipt.card_sha256)
                })
        {
            self.block_entry(
                &remote.id,
                skill_id,
                "账号版本收据与内容不一致，已暂停该条目的版本操作",
            );
            return Ok(false);
        }
        let _held = self.guard.hold()?;
        let path = self.paths.skill(skill_id);
        let mut sidecar = library_read_profile(&path)?;
        let before = sidecar.version_metadata.clone();
        let before_version = sidecar.version.clone();
        let identity = remote.card.as_ref().map(|c| c.identity());
        crate::version_policy::normalize_history(&path, &mut sidecar.version_metadata)?;
        if let Err(message) = crate::version_policy::accept(
            &path,
            &mut sidecar.version_metadata,
            &self.user_id,
            &remote.id,
            &remote.version_state,
            remote.accepted_version_receipt.as_ref(),
            identity.as_ref(),
        ) {
            self.block_entry(&remote.id, skill_id, &message);
            return Ok(false);
        }
        if let Some(mapped) = crate::version_policy::saved_current(&path, &sidecar.version_metadata)
        {
            sidecar.version = mapped.label.clone();
        }
        if before != sidecar.version_metadata || before_version != sidecar.version {
            crate::commands::write_version_profile_at(&path, &sidecar)?;
        }
        if let Err(message) = crate::commands::ensure_current_local_version_at(&path, &mut sidecar)
        {
            self.problem(Some(skill_id), Some(&remote.id), message);
        }
        Ok(true)
    }

    // Callers already hold the Skill lock. A missing local number must not
    // turn a recoverable version problem into a failure of the whole pass.
    fn ensure_local_version(&mut self, skill_id: &str, entry_id: &str) -> Result<(), SyncError> {
        let _held = self.guard.hold()?;
        let path = self.paths.skill(skill_id);
        let mut sidecar = library_read_profile(&path)?;
        if let Err(message) = crate::commands::ensure_current_local_version_at(&path, &mut sidecar)
        {
            self.problem(Some(skill_id), Some(entry_id), message);
        }
        Ok(())
    }

    async fn refresh_version_history(
        &self,
        skill_id: &str,
        remote: &RemoteEntry,
    ) -> Result<(), ApiError> {
        if remote.version_state.version_policy != Some(1) {
            return Ok(());
        }
        let Some(history) = self.api.receipts(&remote.id).await? else {
            return Ok(());
        };
        if history.entry_id != remote.id
            || history.version_policy != 1
            || history.receipts.len() > 1000
            || !(-1..=999).contains(&history.version_high_water)
        {
            return Err(ApiError::Transient(
                "版本历史完整性异常，已暂停该条目的版本操作".into(),
            ));
        }
        // A later snapshot must be re-read through the normal CAS path.
        if history.entry_revision != remote.revision {
            return Err(ApiError::Transient(
                "账号版本在读取期间变化，稍后刷新".into(),
            ));
        }
        let _held = self
            .guard
            .hold()
            .map_err(|e| ApiError::Transient(e.message()))?;
        let path = self.paths.skill(skill_id);
        let mut sidecar = library_read_profile(&path).map_err(ApiError::Transient)?;
        let before = sidecar.version_metadata.clone();
        let metadata = &mut sidecar.version_metadata;
        if metadata
            .account_id
            .as_deref()
            .is_some_and(|id| id != self.user_id)
            || metadata
                .entry_id
                .as_deref()
                .is_some_and(|id| id != remote.id)
        {
            return Ok(());
        }
        metadata.high_water = metadata.high_water.max(history.version_high_water);
        metadata.mapping_digest = history.version_mapping_digest;
        crate::version_policy::remember_receipts(metadata);
        for receipt in history.receipts {
            if crate::version_policy::ordinal(&receipt.label).is_none()
                || uuid::Uuid::parse_str(&receipt.receipt_id).is_err()
            {
                return Err(ApiError::Transient("版本历史含无效收据".into()));
            }
            if let Some(stored) = metadata.receipt_history.get_mut(&receipt.receipt_id) {
                stored.mapping.label = receipt.label.clone();
                stored.mapping.formal_version_id = receipt.formal_version_id.clone();
                stored.mapping.receipt = Some(receipt.clone());
            }
            for mapped in metadata.commits.values_mut() {
                let matches = mapped
                    .receipt
                    .as_ref()
                    .is_some_and(|r| r.receipt_id == receipt.receipt_id)
                    || matches!(&mapped.pending, Some(crate::version_policy::VersionIntent::Save {request_id,..}) if request_id == &receipt.receipt_id);
                if matches {
                    mapped.label = receipt.label.clone();
                    mapped.receipt = Some(receipt.clone());
                    mapped.formal_version_id = receipt.formal_version_id.clone();
                    if matches!(&mapped.pending, Some(crate::version_policy::VersionIntent::Save { request_id, .. }) if request_id == &receipt.receipt_id)
                    {
                        mapped.pending = None;
                    }
                }
            }
        }
        crate::version_policy::remember_receipts(metadata);
        if before != sidecar.version_metadata {
            crate::commands::write_version_profile_at(&path, &sidecar)
                .map_err(ApiError::Transient)?;
        }
        Ok(())
    }

    fn block_entry(&mut self, entry_id: &str, skill_id: &str, message: &str) {
        if let Some(entry) = self.index.entries.get_mut(entry_id) {
            entry.blocked = Some(message.to_string());
            entry.blocked_version_request_id = None;
        }
        self.problem(Some(skill_id), Some(entry_id), message);
    }

    fn pending_save_id(&self, skill_id: &str) -> Option<String> {
        let path = self.paths.skill(skill_id);
        let sidecar = library_read_profile(&path).ok()?;
        match crate::version_policy::current(&path, &sidecar.version_metadata)?.pending? {
            crate::version_policy::VersionIntent::Save { request_id, .. } => Some(request_id),
            _ => None,
        }
    }

    fn entry_api_failure(
        &mut self,
        entry_id: &str,
        skill_id: &str,
        error: ApiError,
    ) -> Result<(), SyncError> {
        match error {
            ApiError::Unauthorized => Err(SyncError::Unauthorized),
            ApiError::Conflict { ref code, .. }
                if code.as_deref().is_some_and(|code| {
                    matches!(
                        code,
                        "VERSION_LABEL_CONFLICT"
                            | "VERSION_RANGE_EXHAUSTED"
                            | "VERSION_REQUEST_CONFLICT"
                    )
                }) =>
            {
                self.block_entry(entry_id, skill_id, &error.message());
                if code.as_deref() == Some("VERSION_LABEL_CONFLICT") {
                    let pending = self.pending_save_id(skill_id);
                    if let Some(entry) = self.index.entries.get_mut(entry_id) {
                        entry.blocked_version_request_id = pending;
                    }
                }
                Ok(())
            }
            ApiError::Rejected { .. } => {
                self.block_entry(entry_id, skill_id, &error.message());
                Ok(())
            }
            other => {
                self.problem(Some(skill_id), Some(entry_id), other.message());
                Ok(())
            }
        }
    }

    // ── New entries from the account ────────────────────────────────────────

    /// The folder's sidecar names no binding or a different one than this entry.
    fn claimed_by_other(&self, skill_id: &str, entry_id: &str) -> bool {
        library_read_profile(&self.paths.skill(skill_id)).is_ok_and(|sidecar| {
            sidecar.library_account_id.as_deref() != Some(self.user_id.as_str())
                || sidecar.library_entry_id.as_deref() != Some(entry_id)
        })
    }

    /// The entry's previous folder name, while nothing else uses it.
    fn folder_name_free_for(&self, entry_id: &str, skill_id: &str) -> bool {
        !self.skill_exists(skill_id)
            && !self
                .index
                .entries
                .iter()
                .any(|(id, entry)| id != entry_id && entry.skill_id.as_deref() == Some(skill_id))
            && !self
                .index
                .operations
                .values()
                .any(|operation| operation.copy_skill_id == skill_id)
    }

    fn free_skill_id(&self, name: &str, entry_id: &str) -> String {
        let reserved = self
            .index
            .entries
            .values()
            .filter_map(|entry| entry.skill_id.clone())
            .chain(
                self.index
                    .operations
                    .values()
                    .map(|operation| operation.copy_skill_id.clone()),
            )
            .collect::<BTreeSet<_>>();
        let base = if is_skill_name(name) && !library_skill_is_system(name) {
            name
        } else {
            "skill"
        };
        let short = entry_id.replace('-', "");
        let mut candidates = vec![base.to_string()];
        for length in [8, 16, 32] {
            let mut prefix = base.chars().take(128 - length - 1).collect::<String>();
            prefix.push('-');
            prefix.push_str(&short[..length.min(short.len())]);
            candidates.push(prefix);
        }
        candidates
            .into_iter()
            .find(|candidate| !self.skill_exists(candidate) && !reserved.contains(candidate))
            .unwrap_or_else(|| format!("skill-{short}"))
    }

    async fn download_into(
        &mut self,
        remote: &RemoteEntry,
        skill_id: &str,
    ) -> Result<(), SyncError> {
        let Some(card) = remote.card.clone() else {
            return Ok(());
        };
        let _lock = self.lock(skill_id)?;
        if self.skill_exists(skill_id) {
            return Ok(());
        }
        if self
            .pull(remote, skill_id, None, &remote.profile, "从账号同步")
            .await?
        {
            self.index.entries.insert(
                remote.id.clone(),
                IndexEntry {
                    blocked_version_request_id: None,
                    skill_id: Some(skill_id.to_string()),
                    revision: remote.revision,
                    card_sha256: card.sha256.clone(),
                    baseline: Baseline {
                        version_state: remote.version_state.clone(),
                        content: card.identity(),
                        profile: remote.profile.clone(),
                    },
                    blocked: None,
                },
            );
        }
        Ok(())
    }

    async fn download_new_entries(&mut self, locals: &[LocalSkill]) -> Result<(), SyncError> {
        let candidates = self
            .remote
            .values()
            .filter(|entry| !entry.deleted && entry.card.is_some())
            .filter(|entry| !self.index.entries.contains_key(&entry.id))
            // Entries an operation is still binding or copying are placed by it.
            .filter(|entry| !self.index.operations.contains_key(&entry.id))
            .filter(|entry| {
                !self
                    .index
                    .operations
                    .values()
                    .any(|operation| operation.copy_entry_id == entry.id)
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut used = BTreeSet::new();
        for entry in candidates {
            // An unbound folder of the same store/team asset that is exactly
            // the account version becomes this entry: nothing is uploaded and
            // no second copy is placed. Anything else stays as it is and the
            // account version lands in its own folder.
            let same_asset = entry.migration_key.as_ref().and_then(|key| {
                locals.iter().find(|local| {
                    local.sidecar.library_account_id.is_none()
                        && !used.contains(&local.skill_id)
                        && classify(local, &self.user_id).migration_key.as_ref() == Some(key)
                })
            });
            if let Some(local) = same_asset {
                used.insert(local.skill_id.clone());
                if self.bind_identical(local, &entry)? {
                    continue;
                }
            }
            let skill_id = self.free_skill_id(&entry.name, &entry.id);
            self.download_into(&entry, &skill_id).await?;
        }
        Ok(())
    }

    /// Binds an unbound folder to `entry` only when its files, executable
    /// bits and profile all equal the account version.
    fn bind_identical(
        &mut self,
        local: &LocalSkill,
        entry: &RemoteEntry,
    ) -> Result<bool, SyncError> {
        let Some(card) = entry.card.clone() else {
            return Ok(false);
        };
        let _lock = self.lock(&local.skill_id)?;
        let Ok(state) = self.local_state(&local.skill_id, Some(&card.identity().executable_paths))
        else {
            return Ok(false);
        };
        let current = library_read_profile(&self.paths.skill(&local.skill_id))?;
        if state.state.content != card.identity()
            || state.state.profile != entry.profile
            || current.library_account_id.is_some()
        {
            return Ok(false);
        }
        let entry_id = entry.id.clone();
        self.write_sidecar(&local.skill_id, |sidecar| {
            sidecar.library_account_id = Some(self.user_id.clone());
            sidecar.library_entry_id = Some(entry_id);
        })?;
        if let Some(local_id) = &local.sidecar.id {
            self.index.migration.kept_local.remove(local_id);
            self.index.migration.confirmed_local_ids.remove(local_id);
        }
        self.index.entries.insert(
            entry.id.clone(),
            IndexEntry {
                blocked_version_request_id: None,
                skill_id: Some(local.skill_id.clone()),
                revision: entry.revision,
                card_sha256: card.sha256.clone(),
                baseline: Baseline {
                    version_state: entry.version_state.clone(),
                    content: card.identity(),
                    profile: entry.profile.clone(),
                },
                blocked: None,
            },
        );
        self.report.bound += 1;
        Ok(true)
    }

    // ── Binding local directories ───────────────────────────────────────────

    /// Directories whose sidecar names this account's entry but the index does
    /// not (index lost, or restored from the recycle bin).
    async fn adopt_bound_locals(&mut self, locals: &[LocalSkill]) -> Result<(), SyncError> {
        for local in locals {
            let Some(entry_id) = self.bound_to(&local.sidecar) else {
                continue;
            };
            if let Some(indexed) = self.index.entries.get_mut(&entry_id) {
                if indexed.skill_id.as_deref() != Some(local.skill_id.as_str()) {
                    if indexed
                        .skill_id
                        .as_ref()
                        .is_some_and(|skill_id| self.paths.skill(skill_id).exists())
                    {
                        // Two directories claim one entry (a manual copy): the
                        // second one becomes an independent local Skill.
                        self.unbind(&local.skill_id)?;
                        continue;
                    }
                    indexed.skill_id = Some(local.skill_id.clone());
                }
                continue;
            }
            if self
                .index
                .operations
                .values()
                .any(|operation| operation.copy_entry_id == entry_id)
            {
                continue;
            }
            match self.remote.get(&entry_id).cloned() {
                Some(remote) if !remote.deleted => {
                    self.establish_baseline(
                        &local.skill_id,
                        remote,
                        BaselineOrigin::Existing(None),
                    )
                    .await?;
                }
                _ => {
                    // Cannot tell whether it changed since the account deleted
                    // it: keep it on this device instead of guessing, and never
                    // upload it again on its own (that would undo the delete).
                    self.unbind(&local.skill_id)?;
                    if let Some(id) = local.sidecar.id.clone() {
                        self.index
                            .migration
                            .kept_local
                            .insert(id, KEPT_ACCOUNT_DELETED.into());
                    }
                    self.problem(
                        Some(&local.skill_id),
                        Some(&entry_id),
                        "该 Skill 已不在账号中，这台电脑保留了一份，未加入账号同步",
                    );
                }
            }
        }
        Ok(())
    }

    fn unbind(&self, skill_id: &str) -> Result<(), SyncError> {
        let _lock = self.lock(skill_id)?;
        self.write_sidecar(skill_id, |sidecar| {
            sidecar.library_account_id = None;
            sidecar.library_entry_id = None;
        })
    }

    async fn bind_unbound_locals(&mut self, locals: &[LocalSkill]) -> Result<(), SyncError> {
        let own_skills = if self.index.migration.completed {
            Vec::new()
        } else {
            match self.api.own_skills().await {
                Ok(skills) => skills,
                Err(ApiError::Unauthorized) => return Err(SyncError::Unauthorized),
                Err(error) => {
                    self.problem(None, None, error.message());
                    return Ok(());
                }
            }
        };
        let mut used_entry_ids = self.index.entries.keys().cloned().collect::<BTreeSet<_>>();
        used_entry_ids.extend(self.remote.keys().cloned());
        let mut seen_local_ids = BTreeSet::new();

        for local in locals {
            if local.sidecar.library_account_id.is_some()
                || self
                    .index
                    .entries
                    .values()
                    .any(|entry| entry.skill_id.as_deref() == Some(local.skill_id.as_str()))
            {
                continue;
            }
            if self
                .index
                .operations
                .values()
                .any(|operation| operation.original_skill_id == local.skill_id)
            {
                continue;
            }
            let local_id = self.stable_local_id(local, &used_entry_ids, &mut seen_local_ids)?;
            if self.index.migration.refused.contains_key(&local_id) {
                continue;
            }
            let requested = self.index.migration.confirmed_local_ids.contains(&local_id);
            if !requested && self.index.migration.kept_local.contains_key(&local_id) {
                continue;
            }
            let plan = classify(local, &self.user_id);
            let added_by = local.sidecar.added_by_account_id.as_deref();
            let automatic = requested
                || match plan.kind {
                    PlanKind::Authored | PlanKind::TeamOwn => true,
                    // "加入即同步" only for what this account added while
                    // signed in; a folder that merely appears, or one added
                    // signed out or under another account, is not uploaded.
                    PlanKind::Marketplace | PlanKind::Local => {
                        added_by == Some(self.user_id.as_str())
                    }
                    PlanKind::TeamOther => false,
                };
            if !automatic {
                let reason = match (plan.kind, added_by) {
                    (PlanKind::TeamOther, _) => KEPT_TEAM_OTHER,
                    (_, Some(_)) => KEPT_OTHER_ACCOUNT,
                    (_, None) if !self.index.migration.completed => KEPT_BEFORE_FIRST_SYNC,
                    (PlanKind::Marketplace, None) => KEPT_MARKETPLACE,
                    (_, None) => KEPT_LOCAL,
                };
                self.index
                    .migration
                    .kept_local
                    .insert(local_id, reason.into());
                continue;
            }
            // An explicit join of a store/team copy whose asset already has a
            // folder here joins as its own entry instead of claiming that one.
            let plan = if requested
                && self.asset_bound_elsewhere(&plan)
                && !matches!(plan.source, Some(EntrySource::Catalog { .. }))
            {
                BindPlan::upload()
            } else {
                plan
            };
            if self.bind_local(local, &local_id, plan).await? {
                let migration = &mut self.index.migration;
                migration.confirmed_local_ids.remove(&local_id);
                migration.kept_local.remove(&local_id);
            }
        }

        if !self.index.migration.completed {
            for skill in own_skills {
                let present_locally = locals.iter().any(|local| {
                    local.sidecar.server_id.as_deref() == Some(skill.id.as_str())
                        && local.sidecar.catalog_origin.is_none()
                        && local.sidecar.server_owner_id.as_deref() == Some(self.user_id.as_str())
                });
                let in_account = self
                    .remote
                    .values()
                    .any(|entry| entry.author_skill_id.as_deref() == Some(skill.id.as_str()));
                if present_locally || in_account || !is_skill_name(&skill.name) {
                    continue;
                }
                let request = CreateEntry {
                    version_intent: None,
                    id: new_uuid(),
                    name: skill.name.clone(),
                    profile: skill.profile(),
                    source: EntrySource::Authored {
                        skill_id: skill.id.clone(),
                    },
                    migration_key: Some(format!("authored:{}", skill.id)),
                    device: self.device.clone(),
                    source_url_synced: self.source_url_synced,
                };
                let created = match self.api.create_entry(&request).await {
                    Err(ApiError::Conflict {
                        entry: Some(entry), ..
                    }) => Ok(*entry),
                    other => other,
                };
                match created {
                    Ok(entry) => {
                        let skill_id = self.free_skill_id(&entry.name, &entry.id);
                        self.remote.insert(entry.id.clone(), entry.clone());
                        self.download_into(&entry, &skill_id).await?;
                    }
                    Err(ApiError::Unauthorized) => return Err(SyncError::Unauthorized),
                    Err(error) => {
                        self.problem(None, None, format!("{}：{}", skill.name, error.message()))
                    }
                }
            }
            self.index.migration.completed = true;
        }
        Ok(())
    }

    /// The account entry for this store/team asset is already bound to a
    /// folder on this device.
    fn asset_bound_elsewhere(&self, plan: &BindPlan) -> bool {
        let Some(key) = plan.migration_key.as_ref() else {
            return false;
        };
        self.remote.values().any(|entry| {
            entry.migration_key.as_ref() == Some(key)
                && !entry.deleted
                && self
                    .index
                    .entries
                    .get(&entry.id)
                    .is_some_and(|indexed| indexed.skill_id.is_some())
        })
    }

    /// The sidecar id doubles as the entry id so retries stay idempotent;
    /// duplicated or missing ids get a fresh one written to the sidecar first.
    fn stable_local_id(
        &self,
        local: &LocalSkill,
        used_entry_ids: &BTreeSet<String>,
        seen: &mut BTreeSet<String>,
    ) -> Result<String, SyncError> {
        if let Some(id) = local.sidecar.id.clone().filter(|id| is_uuid(id)) {
            let in_account_elsewhere = used_entry_ids.contains(&id)
                && self
                    .remote
                    .get(&id)
                    .is_some_and(|entry| entry.name != local.skill_id);
            if seen.insert(id.clone()) && !in_account_elsewhere {
                return Ok(id);
            }
        }
        let id = new_uuid();
        let _lock = self.lock(&local.skill_id)?;
        let assigned = id.clone();
        self.write_sidecar(&local.skill_id, |sidecar| sidecar.id = Some(assigned))?;
        seen.insert(id.clone());
        Ok(id)
    }

    async fn upload_catalog(
        &self,
        source: &EntrySource,
        sidecar: &SkillHubProfile,
        local_skill_id: &str,
    ) -> Result<(), ApiError> {
        let EntrySource::Catalog {
            skill_id,
            package_sha256,
            ..
        } = source
        else {
            return Ok(());
        };
        let bytes = crate::catalog::package(
            &self.paths.skillhub_root,
            sidecar.catalog_origin.as_deref().unwrap_or(""),
            skill_id,
            package_sha256,
        )
        .await
        .map_err(ApiError::Transient)?;
        let card = self.api.upload_card(&bytes).await?;
        if card.sha256 != *package_sha256 {
            return Err(ApiError::Transient("实例返回的官方包校验值不一致".into()));
        }
        let (local, _) = local_identity(
            &self.paths.skill(local_skill_id),
            Some(&card.executable_paths),
        )
        .map_err(ApiError::Transient)?;
        if local != card.identity() {
            return Err(ApiError::Transient(
                "本机内容与官方包不同，保留在本机；请重新下载官方版本".into(),
            ));
        }
        Ok(())
    }

    fn catalog_problem(&mut self, skill_id: &str, local_id: &str, error: &ApiError) {
        let message = match error {
            ApiError::Conflict {
                code: Some(code), ..
            } if code == "CATALOG_NOT_AVAILABLE" => Some("该 Skill 已不在官方商店上架，保留在本机"),
            ApiError::Conflict {
                code: Some(code), ..
            } if code == "CATALOG_MISMATCH" => {
                Some("官方商店版本或包已变化，保留在本机；请重新下载")
            }
            _ => None,
        };
        if let Some(message) = message {
            self.index
                .migration
                .refused
                .insert(local_id.into(), message.into());
            self.index
                .migration
                .kept_local
                .insert(local_id.into(), message.into());
            self.index.migration.confirmed_local_ids.remove(local_id);
        }
        self.problem(
            Some(skill_id),
            None,
            message
                .map(str::to_string)
                .unwrap_or_else(|| error.message()),
        );
    }

    async fn bind_local(
        &mut self,
        local: &LocalSkill,
        local_id: &str,
        plan: BindPlan,
    ) -> Result<bool, SyncError> {
        let skill_id = local.skill_id.clone();
        if let Some(source @ EntrySource::Catalog { .. }) = &plan.source {
            if !self.catalog_install {
                return Ok(false);
            }
            if let Err(error) = self.upload_catalog(source, &local.sidecar, &skill_id).await {
                if matches!(error, ApiError::Unauthorized) {
                    return Err(SyncError::Unauthorized);
                }
                self.catalog_problem(&skill_id, local_id, &error);
                return Ok(false);
            }
        }
        // An upload sends files and profile from one read under the lock, so
        // the new entry is exactly one real state of this folder; edits made
        // after the scan (e.g. the import's AI analysis) are not lost to a
        // stale scan-time profile.
        let (source, profile, uploaded) = match plan.source.clone() {
            Some(source) => (
                source,
                synced_profile(&local.sidecar, &skill_id, self.source_url_synced),
                None,
            ),
            None => {
                let _lock = self.lock(&skill_id)?;
                let state = match self.local_state(&skill_id, None) {
                    Ok(state) => state,
                    Err(message) => {
                        self.problem(Some(&skill_id), None, message);
                        return Ok(false);
                    }
                };
                match self.upload(&self.paths.skill(&skill_id), &state).await {
                    Ok(card_sha256) => (
                        EntrySource::Card {
                            card_sha256,
                            provenance: plan.provenance.clone(),
                        },
                        state.state.profile.clone(),
                        Some(state.state.content.clone()),
                    ),
                    Err(ApiError::Unauthorized) => return Err(SyncError::Unauthorized),
                    Err(error) => {
                        self.problem(Some(&skill_id), None, error.message());
                        return Ok(false);
                    }
                }
            }
        };
        let name = if is_skill_name(&skill_id) {
            skill_id.clone()
        } else {
            "skill".into()
        };
        let request = CreateEntry {
            version_intent: None,
            id: local_id.to_string(),
            name,
            profile,
            source,
            migration_key: plan.migration_key.clone(),
            device: self.device.clone(),
            source_url_synced: self.source_url_synced,
        };
        let entry = match self.api.create_entry(&request).await {
            Ok(entry) => entry,
            // Same id or migration key already exists for this account.
            Err(ApiError::Conflict {
                entry: Some(entry), ..
            }) => *entry,
            Err(ApiError::Unauthorized) => return Err(SyncError::Unauthorized),
            Err(error) if matches!(request.source, EntrySource::Catalog { .. }) => {
                self.catalog_problem(&skill_id, local_id, &error);
                return Ok(false);
            }
            Err(ApiError::Rejected {
                status: 403,
                message,
                ..
            }) => {
                let migration = &mut self.index.migration;
                migration
                    .refused
                    .insert(local_id.to_string(), message.clone());
                migration.confirmed_local_ids.remove(local_id);
                migration
                    .kept_local
                    .entry(local_id.to_string())
                    .or_insert_with(|| format!("无法加入账号：{message}"));
                self.problem(Some(&skill_id), None, format!("无法加入账号：{message}"));
                return Ok(false);
            }
            Err(error) => {
                self.problem(Some(&skill_id), None, error.message());
                return Ok(false);
            }
        };
        // This folder just created the entry from its own upload (its id, no
        // edit since, the very files sent): that sent state is the shared
        // baseline, so anything changed locally since is a one-sided edit. An
        // entry that already existed (another device, an older attempt) gets
        // the regular first-baseline rules and their conflict copy.
        let created_here = uploaded.as_ref().is_some_and(|content| {
            entry.id == local_id
                && entry.revision == 1
                && entry.card.as_ref().map(|card| card.identity()).as_ref() == Some(content)
        });
        self.remote.insert(entry.id.clone(), entry.clone());
        if entry.revision == 1
            && matches!(
                &request.source,
                EntrySource::Team { .. }
                    | EntrySource::Marketplace { .. }
                    | EntrySource::Authored { .. }
            )
        {
            // Other callers already hold the Skill lock. This initial bind
            // does not: protect its sidecar read/modify/write separately,
            // then release before establish_baseline acquires the same lock.
            let _lock = self.lock(&skill_id)?;
            self.remember_source_card(&skill_id, &entry)?;
        }
        let origin = if created_here {
            BaselineOrigin::CreatedHere
        } else {
            BaselineOrigin::Existing(plan.trusted_card)
        };
        self.establish_baseline(&skill_id, entry, origin).await?;
        self.report.bound += 1;
        Ok(true)
    }

    /// First baseline between a local directory and an entry (design §4,
    /// "首次基线的建立").
    async fn establish_baseline(
        &mut self,
        skill_id: &str,
        remote: RemoteEntry,
        origin: BaselineOrigin,
    ) -> Result<(), SyncError> {
        let Some(card) = remote.card.clone() else {
            return Ok(());
        };
        let trusted_card = match origin {
            BaselineOrigin::CreatedHere => {
                return self.adopt_created_baseline(skill_id, remote, card).await;
            }
            BaselineOrigin::Existing(trusted_card) => trusted_card,
        };
        let trusted = match trusted_card {
            Some(sha256) => match self.api.card_meta(&sha256).await {
                Ok(Some(meta)) => Some((sha256, meta.identity())),
                Ok(None) => None,
                Err(ApiError::Unauthorized) => return Err(SyncError::Unauthorized),
                Err(error) => {
                    self.problem(Some(skill_id), Some(&remote.id), error.message());
                    return Ok(());
                }
            },
            None => None,
        };
        let lock = self.lock(skill_id)?;
        let local = match self.local_state(
            skill_id,
            trusted
                .as_ref()
                .map(|(_, identity)| identity.executable_paths.as_slice())
                .or(Some(&card.identity().executable_paths)),
        ) {
            Ok(local) => local,
            Err(message) => {
                self.problem(Some(skill_id), Some(&remote.id), message);
                return Ok(());
            }
        };
        let same_profile = same_profile_but_unseen_source(&local.state.profile, &remote.profile);
        let baseline = match trusted {
            Some((sha256, identity)) if same_profile => Some((sha256, identity)),
            _ if local.state.content == card.identity() && same_profile => {
                Some((card.sha256.clone(), card.identity()))
            }
            _ => None,
        };
        let Some((card_sha256, content)) = baseline else {
            drop(lock);
            return self
                .start_conflict(ConflictKind::Bind, &remote.id, skill_id)
                .await;
        };
        let entry_id = remote.id.clone();
        self.write_sidecar(skill_id, |sidecar| {
            sidecar.library_account_id = Some(self.user_id.clone());
            sidecar.library_entry_id = Some(entry_id.clone());
        })?;
        drop(lock);
        self.index.entries.insert(
            remote.id.clone(),
            IndexEntry {
                blocked_version_request_id: None,
                skill_id: Some(skill_id.to_string()),
                revision: remote.revision,
                card_sha256,
                baseline: Baseline {
                    version_state: remote.version_state.clone(),
                    content,
                    // An account source this folder has not seen yet stays a
                    // remote-side value that the next merge pulls in.
                    profile: SyncProfile {
                        source_url: local.state.profile.source_url.clone(),
                        ..remote.profile.clone()
                    },
                },
                blocked: None,
            },
        );
        // A trusted older baseline may leave one-sided changes to apply now.
        self.sync_entry(&remote.id, 0).await
    }

    /// Baseline for an entry this folder created a moment ago: the entry as
    /// created. Local edits since are applied as one-sided changes by
    /// `sync_entry`; another device's edit in between still meets a 409 and
    /// the three-way merge (with a copy for real same-field conflicts).
    async fn adopt_created_baseline(
        &mut self,
        skill_id: &str,
        remote: RemoteEntry,
        card: super::api::RemoteCard,
    ) -> Result<(), SyncError> {
        let lock = self.lock(skill_id)?;
        if !self.skill_exists(skill_id) {
            // Removed right after the upload: the next pass downloads the entry.
            self.problem(
                Some(skill_id),
                Some(&remote.id),
                "加入账号后本机目录已不存在，下次同步会重新下载",
            );
            return Ok(());
        }
        let entry_id = remote.id.clone();
        let mut sent_source_url = None;
        self.write_sidecar(skill_id, |sidecar| {
            sidecar.library_account_id = Some(self.user_id.clone());
            sidecar.library_entry_id = Some(entry_id.clone());
            sent_source_url = sidecar.source_url.clone();
        })?;
        drop(lock);
        // A source the server filled in on create (inherited from the source
        // version because this folder sent none) is an account-side value
        // this folder has not seen yet, not something it cleared.
        let mut baseline_profile = remote.profile.clone();
        if self.source_url_synced {
            baseline_profile.source_url = crate::sanitize_source_url(sent_source_url.as_deref());
        }
        self.index.entries.insert(
            remote.id.clone(),
            IndexEntry {
                blocked_version_request_id: None,
                skill_id: Some(skill_id.to_string()),
                revision: remote.revision,
                card_sha256: card.sha256.clone(),
                baseline: Baseline {
                    version_state: remote.version_state.clone(),
                    content: card.identity(),
                    profile: baseline_profile,
                },
                blocked: None,
            },
        );
        self.sync_entry(&remote.id, 0).await
    }

    // ── Conflict copies ─────────────────────────────────────────────────────

    async fn start_conflict(
        &mut self,
        kind: ConflictKind,
        entry_id: &str,
        skill_id: &str,
    ) -> Result<(), SyncError> {
        if library_read_profile(&self.paths.skill(skill_id))?
            .catalog_origin
            .is_some()
        {
            self.problem(
                Some(skill_id),
                Some(entry_id),
                "官方商店 Skill 内容存在冲突，保留在本机；不会创建个人作者副本",
            );
            return Ok(());
        }
        if self.index.operations.contains_key(entry_id) {
            return Ok(());
        }
        let copy_entry_id = new_uuid();
        let copy_skill_id = {
            let base = format!("{}-copy", skill_id.chars().take(110).collect::<String>());
            self.free_skill_id(&base, &copy_entry_id)
        };
        let baseline_executables = self
            .index
            .entries
            .get(entry_id)
            .map(|entry| entry.baseline.content.executable_paths.clone());
        let mut operation = ConflictOperation {
            kind,
            original_entry_id: entry_id.to_string(),
            original_skill_id: skill_id.to_string(),
            copy_entry_id,
            copy_skill_id,
            phase: ConflictPhase::Snapshotted,
            snapshot_dir: new_uuid(),
            snapshot: SnapshotState {
                content: ContentIdentity {
                    content_hash: String::new(),
                    executable_paths: Vec::new(),
                },
                profile: SyncProfile::default(),
            },
            copy_revision: None,
            copy_card_sha256: None,
            copy_written: None,
            replace_target: None,
            blocked: None,
        };
        if !self.snapshot(&mut operation, baseline_executables.as_deref())? {
            return Ok(());
        }
        self.index
            .operations
            .insert(entry_id.to_string(), operation);
        self.save()?;
        self.advance_operation(entry_id).await
    }

    fn snapshot_path(&self, operation: &ConflictOperation) -> Result<PathBuf, SyncError> {
        Ok(staging_dir(&self.data_root, &self.user_id)?.join(&operation.snapshot_dir))
    }

    /// Copies the original directory under its lock and records exactly what
    /// was saved. Returns false when the original no longer exists.
    fn snapshot(
        &self,
        operation: &mut ConflictOperation,
        baseline_executables: Option<&[String]>,
    ) -> Result<bool, SyncError> {
        let _lock = self.lock(&operation.original_skill_id)?;
        let original = self.paths.skill(&operation.original_skill_id);
        if !original.is_dir() {
            return Ok(false);
        }
        let staging = staging_dir(&self.data_root, &self.user_id)?;
        super::index::ensure_private_dir(&staging)?;
        let target = self.snapshot_path(operation)?;
        let _held = self.guard.hold()?;
        if target.exists() {
            fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
        }
        library_copy_tree(&original, &target)?;
        let (content, _) = local_identity(&target, baseline_executables)?;
        let sidecar = library_read_profile(&target)?;
        operation.snapshot = SnapshotState {
            content,
            profile: synced_profile(
                &sidecar,
                &operation.original_skill_id,
                self.source_url_synced,
            ),
        };
        operation.phase = ConflictPhase::Snapshotted;
        Ok(true)
    }

    fn store_operation(&mut self, operation: ConflictOperation) -> Result<(), SyncError> {
        self.index
            .operations
            .insert(operation.original_entry_id.clone(), operation);
        self.save()
    }

    async fn advance_operation(&mut self, entry_id: &str) -> Result<(), SyncError> {
        for _round in 0..MAX_SNAPSHOT_ROUNDS * 4 {
            let Some(mut operation) = self.index.operations.get(entry_id).cloned() else {
                return Ok(());
            };
            if operation.blocked.is_some() && !self.options.retry_blocked {
                return Ok(());
            }
            operation.blocked = None;
            let snapshot = self.snapshot_path(&operation)?;
            match operation.phase {
                ConflictPhase::Snapshotted => {
                    if !snapshot.is_dir() {
                        let baseline = self
                            .index
                            .entries
                            .get(entry_id)
                            .map(|entry| entry.baseline.content.executable_paths.clone());
                        if !self.snapshot(&mut operation, baseline.as_deref())? {
                            self.finish_operation(entry_id, &operation)?;
                            return Ok(());
                        }
                        self.store_operation(operation)?;
                        continue;
                    }
                    if !self.create_copy_entry(&mut operation, &snapshot).await? {
                        self.store_operation(operation)?;
                        return Ok(());
                    }
                    operation.phase = ConflictPhase::CopyCreated;
                    self.store_operation(operation)?;
                }
                ConflictPhase::CopyCreated => {
                    if !self.place_copy(&mut operation, &snapshot).await? {
                        self.store_operation(operation)?;
                        return Ok(());
                    }
                    operation.phase = ConflictPhase::CopyPlaced;
                    self.store_operation(operation)?;
                }
                ConflictPhase::CopyPlaced | ConflictPhase::Replacing => {
                    match self.replace_original(&mut operation).await? {
                        Replacement::Finished => {
                            self.finish_operation(entry_id, &operation)?;
                            self.report.copies_created += 1;
                            return Ok(());
                        }
                        Replacement::Deferred => {
                            self.store_operation(operation)?;
                            return Ok(());
                        }
                        // Edited after the snapshot: save the newer state into
                        // the same copy entry and compare again.
                        Replacement::Resnapshotted => self.store_operation(operation)?,
                    }
                }
            }
        }
        Ok(())
    }

    /// Persists the completed index first; only then is the snapshot, the
    /// last local copy of the saved edits, removed.
    fn finish_operation(
        &mut self,
        entry_id: &str,
        operation: &ConflictOperation,
    ) -> Result<(), SyncError> {
        self.index.operations.remove(entry_id);
        self.save()?;
        if let Ok(path) = self.snapshot_path(operation) {
            let _ = fs::remove_dir_all(path);
        }
        Ok(())
    }

    /// Phase 2: upload the snapshot and create (or update) the copy entry.
    async fn create_copy_entry(
        &mut self,
        operation: &mut ConflictOperation,
        snapshot: &Path,
    ) -> Result<bool, SyncError> {
        if library_read_profile(snapshot)?.catalog_origin.is_some() {
            self.problem(
                Some(&operation.original_skill_id),
                None,
                "官方商店 Skill 的冲突内容已保留在本机，不创建个人作者副本",
            );
            return Ok(false);
        }
        let (content, files) =
            local_identity(snapshot, Some(&operation.snapshot.content.executable_paths))?;
        let state = LocalState {
            state: SnapshotState {
                content: content.clone(),
                profile: operation.snapshot.profile.clone(),
            },
            source_url_cleared: None,
            files,
            tree_fingerprint: Vec::new(),
        };
        let card_sha256 = match self.upload(snapshot, &state).await {
            Ok(sha256) => sha256,
            Err(error) => return self.operation_failure(operation, error),
        };
        let mut written = WrittenCopy {
            version_state: Default::default(),
            card_sha256: card_sha256.clone(),
            content,
            profile: operation.snapshot.profile.as_copy(),
        };
        // At most one fork: a copy another device edited stays its own entry.
        for _attempt in 0..2 {
            match self.write_copy_entry(operation, &written).await {
                Ok(CopyWrite::Written(entry)) => {
                    written.version_state = entry.version_state.clone();
                    operation.copy_revision = Some(entry.revision);
                    operation.copy_card_sha256 = Some(card_sha256);
                    operation.copy_written = Some(written);
                    self.remote.insert(entry.id.clone(), *entry);
                    return Ok(true);
                }
                Ok(CopyWrite::EditedElsewhere) => self.fork_copy(operation),
                Err(error) => return self.operation_failure(operation, error),
            }
        }
        self.operation_failure(
            operation,
            ApiError::Transient("副本条目正在被其他设备修改，稍后重试".into()),
        )
    }

    async fn write_copy_entry(
        &self,
        operation: &ConflictOperation,
        written: &WrittenCopy,
    ) -> Result<CopyWrite, ApiError> {
        let source = EntrySource::Card {
            card_sha256: written.card_sha256.clone(),
            provenance: None,
        };
        let update = |base_revision: u64| UpdateEntry {
            version_intent: None,
            base_revision,
            profile: Some(written.profile.clone()),
            source: Some(source.clone()),
            device: self.device.clone(),
            source_url_synced: self.source_url_synced,
            clear_source_url: false,
        };
        let current = match operation.copy_revision {
            None => {
                let request = CreateEntry {
                    version_intent: None,
                    id: operation.copy_entry_id.clone(),
                    name: operation.copy_skill_id.clone(),
                    profile: written.profile.clone(),
                    source: source.clone(),
                    migration_key: None,
                    device: self.device.clone(),
                    source_url_synced: self.source_url_synced,
                };
                match self.api.create_entry(&request).await {
                    Ok(entry) => return Ok(CopyWrite::Written(Box::new(entry))),
                    // Our own earlier request (lost response) created it.
                    Err(ApiError::Conflict {
                        entry: Some(existing),
                        ..
                    }) if existing.id == operation.copy_entry_id => *existing,
                    Err(error) => return Err(error),
                }
            }
            Some(revision) => match self
                .api
                .update_entry(&operation.copy_entry_id, &update(revision))
                .await
            {
                Ok(entry) => return Ok(CopyWrite::Written(Box::new(entry))),
                Err(ApiError::Conflict {
                    entry: Some(current),
                    ..
                }) => *current,
                Err(error) => return Err(error),
            },
        };
        // The copy changed since this operation last wrote it.
        if copy_matches(&current, written) {
            // This very write already landed (lost response).
            return Ok(CopyWrite::Written(Box::new(current)));
        }
        let still_ours = match &operation.copy_written {
            Some(previous) => copy_matches(&current, previous),
            // Created by our lost request and not edited since.
            None => current.revision == 1,
        };
        if !still_ours {
            return Ok(CopyWrite::EditedElsewhere);
        }
        match self
            .api
            .update_entry(&operation.copy_entry_id, &update(current.revision))
            .await
        {
            Ok(entry) => Ok(CopyWrite::Written(Box::new(entry))),
            Err(ApiError::Conflict { .. }) => Ok(CopyWrite::EditedElsewhere),
            Err(error) => Err(error),
        }
    }

    /// Leaves the edited copy entry to normal sync and continues with a new one.
    fn fork_copy(&mut self, operation: &mut ConflictOperation) {
        let copy_entry_id = new_uuid();
        let base = format!(
            "{}-copy",
            operation
                .original_skill_id
                .chars()
                .take(110)
                .collect::<String>()
        );
        operation.copy_skill_id = self.free_skill_id(&base, &copy_entry_id);
        operation.copy_entry_id = copy_entry_id;
        operation.copy_revision = None;
        operation.copy_card_sha256 = None;
        operation.copy_written = None;
    }

    fn operation_failure(
        &mut self,
        operation: &mut ConflictOperation,
        error: ApiError,
    ) -> Result<bool, SyncError> {
        let message = format!(
            "保存本机修改的副本失败，原 Skill 暂不替换：{}",
            error.message()
        );
        match error {
            ApiError::Unauthorized => return Err(SyncError::Unauthorized),
            ApiError::Rejected { .. } => operation.blocked = Some(message.clone()),
            ApiError::Conflict { .. } if error.message().contains("limit") => {
                operation.blocked = Some(message.clone())
            }
            _ => {}
        }
        self.problem(
            Some(&operation.original_skill_id),
            Some(&operation.original_entry_id),
            message,
        );
        Ok(false)
    }

    /// Phase 3: place the copy as its own managed Skill bound to the copy entry.
    async fn place_copy(
        &mut self,
        operation: &mut ConflictOperation,
        snapshot: &Path,
    ) -> Result<bool, SyncError> {
        let copy_id = operation.copy_skill_id.clone();
        let _lock = self.lock(&copy_id)?;
        let expected = if self.skill_exists(&copy_id) {
            let indexed = self.index.entries.get(&operation.copy_entry_id).cloned();
            let current = self.local_state(
                &copy_id,
                indexed
                    .as_ref()
                    .map(|entry| entry.baseline.content.executable_paths.as_slice()),
            )?;
            let unchanged = indexed.as_ref().is_some_and(|entry| {
                entry.baseline.content == current.state.content
                    && entry.baseline.profile == current.state.profile
            });
            if !unchanged {
                operation.blocked = Some("副本 Skill 已被修改，请先处理副本后再同步".into());
                self.problem(
                    Some(&copy_id),
                    Some(&operation.copy_entry_id),
                    "副本 Skill 已被修改，请先处理副本后再同步",
                );
                return Ok(false);
            }
            Some(Expected::of(&current, self.source_url_synced))
        } else {
            None
        };
        let (content, files) =
            local_identity(snapshot, Some(&operation.snapshot.content.executable_paths))?;
        let package =
            library_package_bytes(snapshot, package_executables(&files, &content).as_ref())?;
        let mut sidecar = library_read_profile(snapshot)?;
        let profile = operation.snapshot.profile.as_copy();
        sidecar.id = Some(new_uuid());
        sidecar.avatar_local_id = None;
        sidecar.server_id = None;
        sidecar.server_owner_id = None;
        sidecar.is_own = Some(sidecar.catalog_origin.is_none());
        sidecar.acquisition_source = Some(AcquisitionSource::Local);
        sidecar.acquisition_package_sha256 = None;
        sidecar.acquired_by_user_id = None;
        sidecar.team_shared_from = None;
        sidecar.teams.clear();
        sidecar.team_ids.clear();
        sidecar.upstream = None;
        sidecar.version_metadata = Default::default();
        sidecar.version.clear();
        sidecar.name = Some(copy_id.clone());
        sidecar.library_account_id = Some(self.user_id.clone());
        sidecar.library_entry_id = Some(operation.copy_entry_id.clone());
        profile.apply_to_sidecar(&mut sidecar, self.source_url_synced);
        {
            let verify = expected
                .as_ref()
                .map(|expected| expected.verifier(&copy_id));
            let _held = self.guard.hold()?;
            if let Err(error) = self.local.land(LibraryLanding {
                skill_id: &copy_id,
                package: &package,
                profile: sidecar,
                expected_existing: expected
                    .as_ref()
                    .map(|expected| expected.tree_fingerprint.as_slice()),
                verify_existing: verify.as_ref().map(|verify| verify as &LibraryStateCheck),
                message: "保存另一台设备上的修改（副本）",
            }) {
                let message = match error {
                    LibraryLandingError::LocalChanged => "副本 Skill 在写入时发生变化".to_string(),
                    LibraryLandingError::Failed(message) => message,
                };
                self.problem(Some(&copy_id), Some(&operation.copy_entry_id), message);
                return Ok(false);
            }
        }
        self.index.entries.insert(
            operation.copy_entry_id.clone(),
            IndexEntry {
                blocked_version_request_id: None,
                skill_id: Some(copy_id),
                revision: operation.copy_revision.unwrap_or(1),
                card_sha256: operation.copy_card_sha256.clone().unwrap_or_default(),
                baseline: Baseline {
                    version_state: operation
                        .copy_written
                        .as_ref()
                        .map(|w| w.version_state.clone())
                        .unwrap_or_default(),
                    content: operation.snapshot.content.clone(),
                    profile,
                },
                blocked: None,
            },
        );
        Ok(true)
    }

    fn record_replaced(&mut self, entry_id: &str, skill_id: &str, target: &ReplaceTarget) {
        self.index.entries.insert(
            entry_id.to_string(),
            IndexEntry {
                blocked_version_request_id: None,
                skill_id: Some(skill_id.to_string()),
                revision: target.revision,
                card_sha256: target.card_sha256.clone(),
                baseline: Baseline {
                    version_state: target.version_state.clone(),
                    content: target.content.clone(),
                    profile: target.profile.clone(),
                },
                blocked: None,
            },
        );
    }

    /// Phase 4: replace (or trash) the original only while it still equals
    /// the saved snapshot. The target is persisted (`Replacing`) before the
    /// landing, whose version message carries the operation token, so a
    /// restart recognises an already applied replacement instead of taking
    /// the account version for new local edits.
    async fn replace_original(
        &mut self,
        operation: &mut ConflictOperation,
    ) -> Result<Replacement, SyncError> {
        let skill_id = operation.original_skill_id.clone();
        let entry_id = operation.original_entry_id.clone();
        if !self.skill_exists(&skill_id) {
            return Ok(Replacement::Finished);
        }
        let lock = self.lock(&skill_id)?;
        if operation.phase == ConflictPhase::Replacing {
            if let Some(target) = operation.replace_target.clone() {
                if library_history_contains(
                    &self.paths.skill(&skill_id),
                    &operation.replace_token(),
                ) {
                    drop(lock);
                    self.record_replaced(&entry_id, &skill_id, &target);
                    return Ok(Replacement::Finished);
                }
            }
        }
        let current = self.local_state(
            &skill_id,
            Some(&operation.snapshot.content.executable_paths),
        )?;
        if current.state != operation.snapshot {
            drop(lock);
            let baseline = Some(operation.snapshot.content.executable_paths.clone());
            operation.replace_target = None;
            if !self.snapshot(operation, baseline.as_deref())? {
                return Ok(Replacement::Finished);
            }
            operation.phase = ConflictPhase::Snapshotted;
            return Ok(Replacement::Resnapshotted);
        }
        let remote = self.remote.get(&entry_id).cloned();
        match (operation.kind, remote) {
            (ConflictKind::Replace | ConflictKind::Bind, Some(remote))
                if !remote.deleted && remote.card.is_some() =>
            {
                let card = remote.card.clone().expect("checked card");
                let target = ReplaceTarget {
                    version_state: remote.version_state.clone(),
                    card_sha256: card.sha256.clone(),
                    revision: remote.revision,
                    content: card.identity(),
                    profile: remote.profile.clone(),
                };
                operation.replace_target = Some(target.clone());
                operation.phase = ConflictPhase::Replacing;
                self.store_operation(operation.clone())?;
                let message = format!("从账号同步 {}", operation.replace_token());
                let expected = Expected {
                    tree_fingerprint: current.tree_fingerprint.clone(),
                    state: current.state.clone(),
                    source_url_synced: self.source_url_synced,
                };
                if !self
                    .pull(
                        &remote,
                        &skill_id,
                        Some(&expected),
                        &remote.profile,
                        &message,
                    )
                    .await?
                {
                    // The copy is safe; retry the replacement on a later pass.
                    return Ok(Replacement::Deferred);
                }
                drop(lock);
                self.record_replaced(&entry_id, &skill_id, &target);
                Ok(Replacement::Finished)
            }
            _ => {
                {
                    let _held = self.guard.hold()?;
                    self.local.trash(&skill_id)?;
                }
                drop(lock);
                self.index.entries.remove(&entry_id);
                self.report.trashed += 1;
                Ok(Replacement::Finished)
            }
        }
    }
}

enum CopyWrite {
    Written(Box<RemoteEntry>),
    /// Another device changed the copy entry; it must not be overwritten.
    EditedElsewhere,
}

fn copy_matches(entry: &RemoteEntry, written: &WrittenCopy) -> bool {
    entry.card.as_ref().map(|card| card.identity()).as_ref() == Some(&written.content)
        && entry.profile == written.profile
}

/// What an existing directory must still be when a landing replaces it.
struct Expected {
    tree_fingerprint: Vec<u8>,
    state: SnapshotState,
    source_url_synced: bool,
}

impl Expected {
    fn of(local: &LocalState, source_url_synced: bool) -> Self {
        Self {
            tree_fingerprint: local.tree_fingerprint.clone(),
            state: local.state.clone(),
            source_url_synced,
        }
    }

    /// Full three-part check: content hash, executable paths and synced profile.
    fn verifier(&self, skill_id: &str) -> impl Fn(&Path) -> Result<bool, String> {
        let state = self.state.clone();
        let skill_id = skill_id.to_string();
        let source_url_synced = self.source_url_synced;
        move |root: &Path| {
            let (content, _) = local_identity(root, Some(&state.content.executable_paths))?;
            let profile =
                synced_profile(&library_read_profile(root)?, &skill_id, source_url_synced);
            Ok(content == state.content && profile == state.profile)
        }
    }
}

fn api_fatal(error: ApiError) -> SyncError {
    match error {
        ApiError::Unauthorized => SyncError::Unauthorized,
        other => SyncError::Fatal(other.message()),
    }
}

/// Sidecar for a Skill that first arrives on this device from the account.
fn new_sidecar(entry: &RemoteEntry, skill_id: &str, card_sha256: &str) -> SkillHubProfile {
    let source = match entry.source_kind.as_str() {
        "marketplace" | "catalog" => AcquisitionSource::Marketplace,
        "team" => AcquisitionSource::Team,
        _ => AcquisitionSource::Local,
    };
    let authored = entry.author_skill_id.is_some();
    SkillHubProfile {
        catalog_origin: entry.source_origin.clone(),
        acquisition_version: (entry.source_kind == "catalog")
            .then(|| entry.source_version_id.clone())
            .flatten(),
        id: Some(new_uuid()),
        name: Some(skill_id.to_string()),
        server_id: entry
            .author_skill_id
            .clone()
            .or_else(|| entry.source_skill_id.clone()),
        is_own: Some(
            entry.source_origin.is_none() && (authored || source == AcquisitionSource::Local),
        ),
        acquisition_source: Some(source),
        acquisition_package_sha256: (source != AcquisitionSource::Local)
            .then(|| card_sha256.to_string()),
        ..SkillHubProfile::default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlanKind {
    Authored,
    TeamOwn,
    TeamOther,
    Marketplace,
    Local,
}

/// Where the entry a folder is first bound to comes from.
enum BaselineOrigin {
    /// Created by this folder's own upload in this pass.
    CreatedHere,
    /// Already in the account; optionally a trusted earlier card of this folder.
    Existing(Option<String>),
}

#[derive(Debug, Clone)]
struct BindPlan {
    kind: PlanKind,
    /// `None`: upload the local bytes as a card.
    source: Option<EntrySource>,
    provenance: Option<super::api::Provenance>,
    migration_key: Option<String>,
    trusted_card: Option<String>,
}

impl BindPlan {
    /// Upload the local bytes as a new entry of its own.
    fn upload() -> Self {
        Self {
            kind: PlanKind::Local,
            source: None,
            provenance: None,
            migration_key: None,
            trusted_card: None,
        }
    }
}

/// Version 1 marker files (entry ids) under `local-only/`.
fn legacy_markers(directory: &Path) -> Result<Vec<PathBuf>, String> {
    match fs::symlink_metadata(directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("旧的“仅本机”标记目录不安全，已停止升级".into());
        }
        Ok(_) => {}
    }
    let mut markers = Vec::new();
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
        if metadata.is_file() {
            markers.push(entry.path());
        }
    }
    markers.sort();
    Ok(markers)
}

fn classify(local: &LocalSkill, user_id: &str) -> BindPlan {
    let sidecar = &local.sidecar;
    let server_id = sidecar.server_id.clone().filter(|id| {
        !id.is_empty()
            && id.len() <= 64
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    });
    let source = crate::commands::library_acquisition_source(sidecar);
    let trusted = sidecar.acquisition_package_sha256.clone().or_else(|| {
        sidecar
            .upstream
            .as_ref()
            .and_then(|upstream| upstream.package_sha256.clone())
    });
    let local_plan = BindPlan {
        kind: PlanKind::Local,
        source: None,
        provenance: None,
        migration_key: None,
        trusted_card: None,
    };
    let Some(server_id) = server_id else {
        return local_plan;
    };
    match source {
        AcquisitionSource::Local
            if sidecar.catalog_origin.is_none()
                && sidecar.is_own != Some(false)
                && sidecar.server_owner_id.as_deref() == Some(user_id) =>
        {
            BindPlan {
                kind: PlanKind::Authored,
                source: Some(EntrySource::Authored {
                    skill_id: server_id.clone(),
                }),
                provenance: None,
                migration_key: Some(format!("authored:{server_id}")),
                trusted_card: None,
            }
        }
        AcquisitionSource::Team => {
            let team_id = sidecar
                .team_ids
                .first()
                .cloned()
                .or_else(|| sidecar.team_shared_from.clone())
                .filter(|id| !id.is_empty() && id.len() <= 64);
            let Some(team_id) = team_id else {
                return local_plan;
            };
            let own = sidecar.acquired_by_user_id.as_deref() == Some(user_id);
            BindPlan {
                kind: if own {
                    PlanKind::TeamOwn
                } else {
                    PlanKind::TeamOther
                },
                source: Some(EntrySource::Team {
                    skill_id: server_id.clone(),
                    team_id,
                }),
                provenance: None,
                migration_key: Some(format!("team:{server_id}")),
                trusted_card: trusted,
            }
        }
        AcquisitionSource::Marketplace
            if sidecar.catalog_origin.is_some()
                && sidecar
                    .scope
                    .as_ref()
                    .is_some_and(|s| s.space_id != "official" && s.space_id != "local") =>
        {
            BindPlan {
                kind: PlanKind::Marketplace,
                source: Some(EntrySource::Catalog {
                    skill_id: server_id,
                    version: sidecar
                        .acquisition_version
                        .clone()
                        .unwrap_or_else(|| sidecar.version.clone()),
                    package_sha256: trusted.clone().unwrap_or_default(),
                }),
                provenance: None,
                migration_key: None,
                trusted_card: trusted,
            }
        }
        AcquisitionSource::Marketplace => BindPlan {
            kind: PlanKind::Marketplace,
            source: Some(EntrySource::Marketplace {
                skill_id: server_id.clone(),
            }),
            provenance: None,
            migration_key: Some(format!("marketplace:{server_id}")),
            trusted_card: trusted,
        },
        AcquisitionSource::Local => local_plan,
    }
}
