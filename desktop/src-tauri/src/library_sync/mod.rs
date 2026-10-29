//! Account sync of managed Skills ("我的 Skill" library). The GUI commands and
//! the `skillhub sync` CLI share `run_sync`, which binds every write to the
//! APP account that started the pass.

pub(crate) mod api;
pub(crate) mod content;
pub(crate) mod engine;
mod index;
pub(crate) mod profile;

pub(crate) async fn acquired_package(profile: &crate::SkillHubProfile) -> Result<Vec<u8>, String> {
    let profile = profile.clone();
    in_background(move || {
        block_on(async move {
            let sha = profile
                .acquisition_package_sha256
                .as_deref()
                .ok_or("缺少取得时的内容包")?;
            if let Some(origin) = &profile.catalog_origin {
                return crate::catalog::package(
                    &crate::skillhub_dir(),
                    origin,
                    profile.server_id.as_deref().ok_or("缺少商店来源")?,
                    sha,
                )
                .await;
            }
            let session = signed_in_session().map_err(|e| e.message())?;
            crate::spaces::require_profile(&profile, &session)?;
            HttpLibraryApi::new(&session)?
                .download_card(sha)
                .await
                .map_err(api_message)
        })
    })
    .await?
}

use crate::cli::{
    CliAccount, CliAccountState, CliCommandOutput, CliErrorCode, EXIT_AUTH, EXIT_NETWORK,
    EXIT_USAGE,
};
use crate::commands::{
    land_library_package_at, library_read_profile, library_read_profile_readonly,
    library_trash_skill, LibraryLanding, LibraryLandingError,
};
use crate::runtime_env::{acquire_current_session_lease, runtime_session_snapshot, RuntimeSession};
use crate::skill_lock::lock_skill_dir_at;
use crate::SkillHubProfile;
use api::{device_label, ApiError, HttpLibraryApi, LibraryApi, RemoteEntry};
use engine::{scan_managed, AccountGuard, Engine, Held, LocalOps, SyncOptions, SyncPaths};
pub(crate) use engine::{SyncError, SyncReport};
use index::{account_dir, ensure_private_dir, load_index, save_index, SyncIndex};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::Emitter;

struct SessionGuard {
    session: RuntimeSession,
}

impl AccountGuard for SessionGuard {
    fn space_id(&self) -> &str {
        self.session.space_id()
    }
    fn user_id(&self) -> &str {
        self.session.user_id()
    }

    fn hold(&self) -> Result<Held, SyncError> {
        match acquire_current_session_lease(&self.session) {
            Ok(Some(lease)) => Ok(Held::new(Some(lease))),
            Ok(None) => Err(SyncError::AccountChanged),
            Err(message) => Err(SyncError::Fatal(message)),
        }
    }
}

struct AppLocalOps<'a> {
    home: PathBuf,
    paths: SyncPaths,
    app: Option<tauri::AppHandle>,
    session: &'a RuntimeSession,
}

impl AppLocalOps<'_> {
    fn emit(&self, event: &str, payload: impl Serialize + Clone) {
        // Read only. Shared leases nest on every platform (#358), so taking a
        // snapshot here never blocks on the lease land() may hold.
        let current = runtime_session_snapshot().ok();
        if current
            .as_ref()
            .is_some_and(|session| session == self.session && !session.is_sync_pending())
        {
            if let Some(app) = &self.app {
                let _ = app.emit(event, payload);
            }
        }
    }
}

impl LocalOps for AppLocalOps<'_> {
    fn land(&self, landing: LibraryLanding<'_>) -> Result<(), LibraryLandingError> {
        land_library_package_at(
            &self.home,
            &self.paths.skillhub_root,
            &self.paths.managed_root,
            landing,
        )
    }

    fn trash(&self, skill_id: &str) -> Result<(), String> {
        library_trash_skill(skill_id).map(|_| ())
    }

    fn listed(&self, entries: &[RemoteEntry], index: &SyncIndex) {
        self.emit(
            "skillhub-library-list",
            LibraryEntryList {
                space: crate::server_request::SpaceRegistry::handle(Some(self.session)),
                user_id: self.session.user_id().to_string(),
                entries: summarize_entries(entries.to_vec(), index, |id| {
                    self.paths.managed_root.join(id).is_dir()
                }),
            },
        );
    }

    fn progress(
        &self,
        entry: &RemoteEntry,
        received: u64,
        total: Option<u64>,
        phase: &str,
        error: Option<&str>,
    ) {
        self.emit(
            "skillhub-library-transfer",
            serde_json::json!({
                "space": crate::server_request::SpaceRegistry::handle(Some(self.session)),
                "userId": self.session.user_id(), "entryId": entry.id, "revision": entry.revision,
                "received": received, "total": total, "phase": phase, "error": error,
            }),
        );
    }
}

fn app_paths() -> SyncPaths {
    SyncPaths {
        skillhub_root: crate::skillhub_dir(),
        managed_root: crate::skills_dir(),
    }
}

fn signed_in_session() -> Result<RuntimeSession, SyncError> {
    let session = runtime_session_snapshot().map_err(SyncError::Fatal)?;
    validate_signed_in_session(session)
}

fn validate_signed_in_session(session: RuntimeSession) -> Result<RuntimeSession, SyncError> {
    if session.is_sync_pending() || session.auth_token().is_none() {
        return Err(SyncError::Fatal("请先登录 SkillHub 后再同步".into()));
    }
    if uuid::Uuid::parse_str(session.user_id()).is_err() {
        return Err(SyncError::Fatal("SkillHub 当前账号标识无效".into()));
    }
    Ok(session)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredRun {
    finished_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    report: Option<SyncReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn now_iso() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("{seconds}")
}

/// Last pass outcome for the status view; best effort, never fails a pass.
fn record_run(guard: &SessionGuard, result: &Result<SyncReport, SyncError>) {
    if matches!(result, Err(SyncError::AccountChanged | SyncError::Busy)) {
        return;
    }
    let Ok(_held) = guard.hold() else {
        return;
    };
    let Ok(directory) = account_dir(
        &guard.session.storage_root(&crate::skillhub_dir()),
        guard.user_id(),
    ) else {
        return;
    };
    if ensure_private_dir(&directory).is_err() {
        return;
    }
    let run = StoredRun {
        finished_at: now_iso(),
        report: result.as_ref().ok().cloned(),
        error: result.as_ref().err().map(SyncError::message),
    };
    if let Ok(text) = serde_json::to_vec_pretty(&run) {
        let temporary = directory.join(format!(".status.{}.tmp", uuid::Uuid::new_v4()));
        if fs::write(&temporary, text).is_ok()
            && fs::rename(&temporary, directory.join("status.json")).is_err()
        {
            let _ = fs::remove_file(&temporary);
        }
    }
}

/// One full sync pass for the APP's current account.
pub(crate) async fn run_sync(retry_blocked: bool) -> Result<SyncReport, SyncError> {
    run_sync_with_app(retry_blocked, None).await
}

async fn run_sync_with_app(
    retry_blocked: bool,
    app: Option<tauri::AppHandle>,
) -> Result<SyncReport, SyncError> {
    let session = signed_in_session()?;
    run_sync_for_session(session, retry_blocked, app).await
}

pub(crate) async fn run_sync_for_session(
    session: RuntimeSession,
    retry_blocked: bool,
    app: Option<tauri::AppHandle>,
) -> Result<SyncReport, SyncError> {
    if !crate::runtime_env::runtime_session_is_current(&session).map_err(SyncError::Fatal)? {
        return Err(SyncError::AccountChanged);
    }
    let api = HttpLibraryApi::new(&session).map_err(SyncError::Fatal)?;
    let guard = SessionGuard { session };
    let paths = app_paths();
    let local = AppLocalOps {
        home: crate::user_home_dir()
            .ok_or_else(|| SyncError::Fatal("Cannot find home dir".into()))?,
        paths: paths.clone(),
        session: &guard.session,
        app,
    };
    let result = Engine::new(&api, &guard, &local, &paths, SyncOptions { retry_blocked })
        .run()
        .await;
    record_run(&guard, &result);
    result
}

fn block_on<T>(future: impl std::future::Future<Output = T>) -> Result<T, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map(|runtime| runtime.block_on(future))
        .map_err(|error| format!("无法启动账号同步: {error}"))
}

async fn in_background<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("账号同步任务异常结束: {error}"))?
}

/// Runs one sync pass. `manual` also retries entries blocked by quota/limits.
#[tauri::command]
pub async fn library_sync_run(app: tauri::AppHandle, manual: bool) -> Result<SyncReport, String> {
    in_background(move || {
        block_on(run_sync_with_app(manual, Some(app)))?.map_err(|error| error.message())
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySyncStatus {
    user_id: String,
    /// Managed Skills on this device that are not in the account and are
    /// never uploaded automatically; each can be joined explicitly.
    kept_local: Vec<KeptLocalItem>,
    blocked: Vec<BlockedItem>,
    pending_copies: usize,
    last_run: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeptLocalItem {
    skill_id: String,
    local_id: String,
    display_name: String,
    reason: String,
    /// "加入账号同步" was requested and is still being retried.
    joining: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BlockedItem {
    entry_id: String,
    skill_id: Option<String>,
    message: String,
}

/// Kept-local Skills that still exist here and are not bound to any account.
pub(crate) fn kept_local_items(
    index: &SyncIndex,
    managed_root: &std::path::Path,
) -> Result<Vec<KeptLocalItem>, String> {
    // A status query: never normalise or rewrite a sidecar here.
    Ok(
        scan_managed(managed_root, crate::commands::library_read_profile_readonly)?
            .into_iter()
            .filter(|local| local.sidecar.library_account_id.is_none())
            .filter_map(|local| {
                let local_id = local.sidecar.id.clone()?;
                let reason = index.migration.kept_local.get(&local_id)?.clone();
                let display_name = local
                    .sidecar
                    .display_name
                    .clone()
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| local.skill_id.clone());
                Some(KeptLocalItem {
                    joining: index.migration.confirmed_local_ids.contains(&local_id),
                    skill_id: local.skill_id,
                    local_id,
                    display_name,
                    reason,
                })
            })
            .collect(),
    )
}

fn status_for(session: &RuntimeSession) -> Result<LibrarySyncStatus, String> {
    let root = session.storage_root(&crate::skillhub_dir());
    let index = load_index(&root, session.user_id())?;
    let blocked = index
        .entries
        .iter()
        .filter_map(|(entry_id, entry)| {
            entry.blocked.clone().map(|message| BlockedItem {
                entry_id: entry_id.clone(),
                skill_id: entry.skill_id.clone(),
                message,
            })
        })
        .chain(index.operations.values().filter_map(|operation| {
            operation.blocked.clone().map(|message| BlockedItem {
                entry_id: operation.original_entry_id.clone(),
                skill_id: Some(operation.original_skill_id.clone()),
                message,
            })
        }))
        .collect();
    let last_run = fs::read(account_dir(&root, session.user_id())?.join("status.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    Ok(LibrarySyncStatus {
        user_id: session.user_id().to_string(),
        kept_local: kept_local_items(&index, &crate::skills_dir())?,
        blocked,
        pending_copies: index.operations.len(),
        last_run,
    })
}

/// One account entry with this device's view of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntrySummary {
    #[serde(flatten)]
    version_state: Option<crate::version_policy::RemoteVersion>,
    entry_id: String,
    name: String,
    display_name: String,
    revision: u64,
    deleted: bool,
    /// Managed directory on this device bound to the entry, if it still exists.
    /// Every active entry is downloaded automatically; until then it is `None`.
    local_skill_id: Option<String>,
    profile: serde_json::Value,
    source_kind: String,
    server_skill_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntryList {
    space: crate::server_request::SpaceHandle,
    user_id: String,
    entries: Vec<LibraryEntrySummary>,
}

/// Joins the Server list with the account index. Bindings come only from the
/// index (never from matching names), so an entry without one is simply not
/// on this device.
pub(crate) fn summarize_entries(
    remote: Vec<RemoteEntry>,
    index: &SyncIndex,
    skill_exists: impl Fn(&str) -> bool,
) -> Vec<LibraryEntrySummary> {
    let mut entries: Vec<LibraryEntrySummary> = remote
        .into_iter()
        .map(|entry| {
            let local_skill_id = index
                .entries
                .get(&entry.id)
                .and_then(|indexed| indexed.skill_id.clone())
                .filter(|skill_id| skill_exists(skill_id));
            LibraryEntrySummary {
                version_state: entry
                    .version_state
                    .version_policy
                    .map(|_| entry.version_state.clone()),
                profile: serde_json::to_value(&entry.profile).unwrap_or_default(),
                source_kind: entry.source_kind.clone(),
                server_skill_id: entry
                    .author_skill_id
                    .clone()
                    .or(entry.source_skill_id.clone()),
                display_name: if entry.profile.display_name.trim().is_empty() {
                    entry.name.clone()
                } else {
                    entry.profile.display_name.clone()
                },
                entry_id: entry.id,
                name: entry.name,
                revision: entry.revision,
                deleted: entry.deleted,
                local_skill_id,
            }
        })
        .collect();
    entries.sort_by(|left, right| {
        left.display_name
            .cmp(&right.display_name)
            .then_with(|| left.entry_id.cmp(&right.entry_id))
    });
    entries
}

/// Lightweight account inventory for the unified list and settings recycle
/// bin. A failed read is an error, never an empty list.
#[tauri::command]
pub async fn library_list_entries() -> Result<LibraryEntryList, String> {
    in_background(move || {
        let session = signed_in_session().map_err(|error| error.message())?;
        let api = HttpLibraryApi::new(&session)?;
        let remote = block_on(api.list())?.map_err(api_message)?;
        let current = signed_in_session().map_err(|error| error.message())?;
        if current != session {
            return Err("账号已切换，请重新打开列表".into());
        }
        let root = session.storage_root(&crate::skillhub_dir());
        let index = load_index(&root, session.user_id())?;
        let skills = crate::skills_dir();
        Ok(LibraryEntryList {
            space: crate::server_request::SpaceRegistry::handle(Some(&session)),
            user_id: session.user_id().to_string(),
            entries: summarize_entries(remote, &index, |skill_id| skills.join(skill_id).is_dir()),
        })
    })
    .await
}

#[tauri::command]
pub async fn library_sync_status() -> Result<LibrarySyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = signed_in_session().map_err(|error| error.message())?;
        status_for(&session)
    })
    .await
    .map_err(|error| format!("library_sync_status异常结束: {error}"))?
}

/// "加入账号同步" for kept-local Skills (sidecar ids): recorded first, so the
/// request survives a busy or failed pass, then synced.
#[tauri::command]
pub async fn library_join_local(local_ids: Vec<String>) -> Result<SyncReport, String> {
    in_background(move || {
        let session = signed_in_session().map_err(|error| error.message())?;
        if local_ids.is_empty()
            || local_ids
                .iter()
                .any(|id| uuid::Uuid::parse_str(id).is_err())
        {
            return Err("Skill 标识无效".into());
        }
        let root = session.storage_root(&crate::skillhub_dir());
        {
            let _run_lock =
                lock_skill_dir_at(&root, &format!("library-sync-{}", session.user_id()))?;
            let mut index = load_index(&root, session.user_id())?;
            for local_id in local_ids {
                index.migration.refused.remove(&local_id);
                index.migration.confirmed_local_ids.insert(local_id);
            }
            let _lease = acquire_current_session_lease(&session)?.ok_or("操作期间账号已切换")?;
            save_index(&root, &index)?;
        }
        match block_on(run_sync(true))? {
            // Another pass picked the request up.
            Err(SyncError::Busy) => Ok(SyncReport::default()),
            other => other.map_err(|error| error.message()),
        }
    })
    .await
}

/// The folder belongs to the signed-in account's synced library. Deleting
/// only this device's copy is not offered for it (#91): the next pass would
/// download it again, so it is deleted from the account instead.
pub(crate) fn synced_to_signed_in_account(sidecar: &SkillHubProfile) -> bool {
    sidecar.library_entry_id.is_some()
        && signed_in_session().is_ok_and(|session| {
            crate::spaces::profile_matches(sidecar, &session)
                && sidecar.library_account_id.as_deref() == Some(session.user_id())
        })
}

/// Read-only form for preflights: parses the folder's `.skillhub.json`
/// without normalising or rewriting it.
pub(crate) fn folder_synced_to_signed_in_account(skill_root: &std::path::Path) -> bool {
    let Ok(text) = fs::read_to_string(skill_root.join(".skillhub.json")) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    let binding = |key: &str| json["skillhub"][key].as_str().map(str::to_string);
    synced_to_signed_in_account(&SkillHubProfile {
        scope: serde_json::from_value(json["skillhub"]["scope"].clone()).ok(),
        library_account_id: binding("libraryAccountId"),
        library_entry_id: binding("libraryEntryId"),
        ..SkillHubProfile::default()
    })
}

pub(crate) const SYNCED_DEVICE_DELETE_REFUSED: &str =
    "这个 Skill 在当前账号的同步库中，只删除这台电脑上的副本会在下一次同步时重新下载；请在 SkillHub 中选择「从我的账号删除」";

/// Restores an entry from the account recycle bin; every device downloads it again.
#[tauri::command]
pub async fn library_restore_entry(entry_id: String) -> Result<SyncReport, String> {
    in_background(move || {
        let session = signed_in_session().map_err(|error| error.message())?;
        if uuid::Uuid::parse_str(&entry_id).is_err() {
            return Err("条目标识无效".into());
        }
        let api = HttpLibraryApi::new(&session)?;
        block_on(async {
            let entry = api
                .list()
                .await
                .map_err(api_message)?
                .into_iter()
                .find(|entry| entry.id == entry_id)
                .ok_or("账号回收站中没有这个 Skill")?;
            if entry.deleted {
                api.restore_entry(&entry_id, entry.revision, &device_label())
                    .await
                    .map_err(api_message)?;
            }
            Ok::<(), String>(())
        })??;
        block_on(run_sync(false))?.map_err(|error| error.message())
    })
    .await
}

fn bound_entry(session: &RuntimeSession, skill_id: &str) -> Result<String, String> {
    let sidecar = library_read_profile_readonly(&crate::skills_dir().join(skill_id))?;
    crate::spaces::require_profile(&sidecar, session)?;
    match (&sidecar.library_account_id, &sidecar.library_entry_id) {
        (Some(account), Some(entry)) if account == session.user_id() => Ok(entry.clone()),
        _ => Err("这个 Skill 还没有同步到当前账号，请等待同步完成后再试".into()),
    }
}

fn api_message(error: ApiError) -> String {
    error.message()
}

/// Outcome of "从我的账号删除" once the account was contacted. The command
/// only errors before that (not signed in, not bound, busy), and such an
/// error says nothing about the account: an earlier attempt may have deleted it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDeleteOutcome {
    /// `deleted` (now or earlier), `kept` (read back: still in the account),
    /// or `unconfirmed` (the account could not be read).
    account: AccountDeleteState,
    /// Why the account kept it or could not be confirmed.
    account_message: Option<String>,
    /// This device moved its copy to the recycle bin and forgot the entry.
    local_cleaned: bool,
    /// Why the device step did not finish; a retry or the next sync pass completes it.
    local_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountDeleteState {
    Deleted,
    Kept,
    Unconfirmed,
}

/// Account step result. Each variant is backed by what the Server said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AccountDeleteResult {
    Deleted,
    /// The account was read and still has the entry (the Server refused, or
    /// a re-read after a failed DELETE found it).
    Kept(String),
    /// No read could tell; an earlier or this DELETE may have taken effect.
    Unconfirmed(String),
}

/// Account step: deletes the entry unless the account already did, so a
/// retry never deletes twice. Nothing is concluded without reading the
/// account: an unreadable list is `Unconfirmed` (a previous attempt may
/// already have deleted it), and a DELETE whose reply was lost or unreadable
/// (or a 409 from another device acting in between) is read back first.
pub(crate) async fn delete_account_entry(
    api: &impl LibraryApi,
    entry_id: &str,
    device: &str,
) -> AccountDeleteResult {
    let find = |entries: Vec<RemoteEntry>| entries.into_iter().find(|entry| entry.id == entry_id);
    let current = match api.list().await {
        Ok(entries) => find(entries),
        Err(error) => return AccountDeleteResult::Unconfirmed(api_message(error)),
    };
    let Some(entry) = current.filter(|entry| !entry.deleted) else {
        return AccountDeleteResult::Deleted;
    };
    let error = match api.delete_entry(entry_id, entry.revision, device).await {
        Ok(_) => return AccountDeleteResult::Deleted,
        // The Server refused the request itself; the list just showed the entry.
        Err(error @ (ApiError::Unauthorized | ApiError::Rejected { .. })) => {
            return AccountDeleteResult::Kept(api_message(error))
        }
        Err(error) => error,
    };
    match api.list().await {
        Ok(entries) => match find(entries) {
            Some(entry) if !entry.deleted => AccountDeleteResult::Kept(match error {
                ApiError::Conflict { .. } => {
                    "这个 Skill 刚在其他设备上被修改，请稍后重试".to_string()
                }
                other => api_message(other),
            }),
            _ => AccountDeleteResult::Deleted,
        },
        Err(recheck) => AccountDeleteResult::Unconfirmed(format!(
            "{}；再次确认时：{}",
            api_message(error),
            api_message(recheck)
        )),
    }
}

/// Device step after the account deleted the entry. The copy goes to the
/// recycle bin before the index forgets the entry: if moving fails, the
/// still-indexed entry lets a retry or the next sync pass finish it
/// (unchanged copies are recycled, edited ones kept as a copy) instead of
/// leaving a folder bound to an entry the index no longer knows.
pub(crate) fn finish_account_delete_locally(
    skillhub_root: &std::path::Path,
    user_id: &str,
    entry_id: &str,
    skill_id: &str,
    trash: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    trash(skill_id).map_err(|error| format!("没能移入本机回收站：{error}"))?;
    let mut index = load_index(skillhub_root, user_id)
        .map_err(|error| format!("本机同步记录未更新：{error}"))?;
    index.entries.remove(entry_id);
    save_index(skillhub_root, &index).map_err(|error| format!("本机同步记录未更新：{error}"))
}

/// "从我的账号删除": deletes the entry for every device, then moves this
/// device's copy to the local recycle bin. Errors only before the account
/// was contacted; every account result and device-step failure is reported
/// in the outcome.
#[tauri::command]
pub async fn library_delete_from_account(
    skill_id: Option<String>,
    account_id: Option<String>,
    entry_id: Option<String>,
) -> Result<AccountDeleteOutcome, String> {
    in_background(move || {
        let session = signed_in_session().map_err(|error| error.message())?;
        let root = session.storage_root(&crate::skillhub_dir());
        let _run_lock = lock_skill_dir_at(&root, &format!("library-sync-{}", session.user_id()))?;
        let entry_id = match (account_id, entry_id) {
            (Some(account), Some(entry)) if account == session.user_id() => {
                uuid::Uuid::parse_str(&entry).map_err(|_| "账号条目标识无效")?;
                entry
            }
            (None, None) => {
                let id = skill_id.as_deref().ok_or("缺少账号条目标识")?;
                crate::commands::validate_skill_id_for_lock(id)?;
                bound_entry(&session, id)?
            }
            _ => return Err("登录账号已经切换，请重新选择 Skill".into()),
        };
        // Resolve under the same lock as sync: a placeholder may have landed
        // while this command waited. Never trust a caller's folder association.
        let index = load_index(&root, session.user_id())?;
        let local_id = index
            .entries
            .get(&entry_id)
            .and_then(|entry| entry.skill_id.clone())
            .or_else(|| {
                skill_id.filter(|id| {
                    crate::commands::validate_skill_id_for_lock(id).is_ok()
                        && bound_entry(&session, id).is_ok_and(|entry| entry == entry_id)
                })
            });
        let _skill_lock = local_id
            .as_deref()
            .map(|id| {
                crate::commands::validate_skill_id_for_lock(id)?;
                lock_skill_dir_at(&crate::skillhub_dir(), id)
            })
            .transpose()?;
        let _lease = acquire_current_session_lease(&session)?.ok_or("删除期间账号已切换")?;
        let api = HttpLibraryApi::new(&session)?;
        let (account, message) =
            match block_on(delete_account_entry(&api, &entry_id, &device_label()))? {
                AccountDeleteResult::Deleted => (AccountDeleteState::Deleted, None),
                AccountDeleteResult::Kept(message) => (AccountDeleteState::Kept, Some(message)),
                AccountDeleteResult::Unconfirmed(message) => {
                    (AccountDeleteState::Unconfirmed, Some(message))
                }
            };
        if account != AccountDeleteState::Deleted {
            // Copy and index stay untouched: a retry or the next pass settles it.
            return Ok(AccountDeleteOutcome {
                account,
                account_message: message,
                local_cleaned: false,
                local_error: None,
            });
        }
        let local = (|| -> Result<(), String> {
            let Some(skill_id) = local_id else {
                let mut index = load_index(&root, session.user_id())?;
                index.entries.remove(&entry_id);
                return save_index(&root, &index);
            };
            if !crate::skills_dir().join(&skill_id).exists() {
                let mut index = load_index(&root, session.user_id())?;
                index.entries.remove(&entry_id);
                return save_index(&root, &index);
            }
            if bound_entry(&session, &skill_id)? != entry_id {
                return Err("本机副本的账号关联已变化，请等待同步核对".into());
            }
            finish_account_delete_locally(&root, session.user_id(), &entry_id, &skill_id, |id| {
                library_trash_skill(id).map(|_| ())
            })
        })();
        Ok(AccountDeleteOutcome {
            account: AccountDeleteState::Deleted,
            account_message: None,
            local_cleaned: local.is_ok(),
            local_error: local.err(),
        })
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAuthorAsset {
    formal_version_id: Option<String>,
    server_id: String,
    server_owner_id: String,
    name: String,
    current_version: String,
    content_matches_version: bool,
}

/// Read-only batch preview. Publishing and sync remain behind confirmation.
#[tauri::command]
pub async fn library_share_preflight(
    skill_id: String,
    account_id: String,
) -> Result<String, String> {
    in_background(move || {
        crate::commands::validate_skill_id_for_lock(&skill_id)?;
        let session = signed_in_session().map_err(|error| error.message())?;
        if session.user_id() != account_id {
            return Err("账号已切换".into());
        }
        let root = session.storage_root(&crate::skillhub_dir());
        let _run_lock = lock_skill_dir_at(&root, &format!("library-sync-{}", session.user_id()))?;
        let _lock = lock_skill_dir_at(&crate::skillhub_dir(), &skill_id)?;
        let _lease = acquire_current_session_lease(&session)?.ok_or("账号已切换")?;
        let entry_id = bound_entry(&session, &skill_id)?;
        let api = HttpLibraryApi::new(&session)?;
        let entries = block_on(api.list())?.map_err(api_message)?;
        let remote = entries
            .iter()
            .find(|entry| entry.id == entry_id && !entry.deleted)
            .ok_or("账号条目已删除")?;
        let Some(server_id) = remote.author_skill_id.as_deref() else {
            return Ok("将准备作者资产并共享已保存内容".into());
        };
        let (current, versions) =
            block_on(api.author_share_state(server_id, session.user_id()))?.map_err(api_message)?;
        let identity =
            block_on(api.author_version_identity(server_id, &current))?.map_err(api_message)?;
        let index = load_index(&root, session.user_id())?;
        let baseline = index
            .entries
            .get(&entry_id)
            .map(|entry| entry.baseline.content.executable_paths.as_slice());
        let skill_root = crate::skills_dir().join(&skill_id);
        let (local, _) = content::local_identity(&skill_root, baseline)?;
        let formal =
            block_on(api.formal_version_by_label(server_id, &current))?.map_err(api_message)?;
        if identity == local && formal_content_matches(&remote.version_state, &formal.id) {
            return Ok(format!("共享已发布版本 {current}"));
        }
        let profile = library_read_profile_readonly(&skill_root)?;
        let version = profile.version.as_str();
        if version.is_empty() {
            return Err("请先保存本机新版本".into());
        }
        if versions.iter().any(|label| label == version) {
            return Err("同号版本已存在且内容不同，请先保存为新版本".into());
        }
        Ok(format!("将先发布已保存版本 {version}，再共享"))
    })
    .await
}

/// Publishes the synced entry as the user's own author asset (needed for
/// team sharing, marketplace submission and formal versions) and records the
/// server Skill id in the sidecar. Idempotent per entry.
#[tauri::command]
pub async fn library_author_asset(skill_id: String) -> Result<LibraryAuthorAsset, String> {
    in_background(move || {
        crate::commands::validate_skill_id_for_lock(&skill_id)?;
        if library_read_profile(&crate::skills_dir().join(&skill_id))?
            .catalog_origin
            .is_some()
        {
            return Err("官方商店 Skill 不拥有作者权限".into());
        }
        let starting_session = signed_in_session().map_err(|error| error.message())?;
        let starting_entry = bound_entry(&starting_session, &skill_id)?;
        // Publish the latest local content, not an older synced card.
        match block_on(run_sync(false))? {
            Ok(report)
                if report.problems.iter().any(|problem| {
                    problem.skill_id.as_deref() == Some(&skill_id)
                        || problem.entry_id.as_deref() == Some(&starting_entry)
                }) =>
            {
                return Err("这个 Skill 同步仍有未处理的冲突，请先处理后再共享".into())
            }
            Ok(_) => {}
            Err(error) => return Err(error.message()),
        }
        let session = signed_in_session().map_err(|error| error.message())?;
        if session.user_id() != starting_session.user_id()
            || session.auth_token() != starting_session.auth_token()
        {
            return Err("发布期间账号已切换".into());
        }
        let root = session.storage_root(&crate::skillhub_dir());
        let _run_lock = lock_skill_dir_at(&root, &format!("library-sync-{}", session.user_id()))?;
        let _lock = lock_skill_dir_at(&crate::skillhub_dir(), &skill_id)?;
        let _lease = acquire_current_session_lease(&session)?.ok_or("发布期间账号已切换")?;
        let entry_id = bound_entry(&session, &skill_id)?;
        let index = load_index(&root, session.user_id())?;
        let entry = index
            .entries
            .get(&entry_id)
            .ok_or("这个 Skill 尚未完成同步")?;
        let skill_root = crate::skills_dir().join(&skill_id);
        let (identity, _) =
            content::local_identity(&skill_root, Some(&entry.baseline.content.executable_paths))?;
        if identity != entry.baseline.content {
            return Err("Skill 内容在同步后又发生变化，请重试".into());
        }
        let api = HttpLibraryApi::new(&session)?;
        let sidecar = library_read_profile(&skill_root)?;
        let inherit_from = sidecar
            .copy_origin
            .as_ref()
            .and_then(|origin| origin.server_skill_id.as_deref());
        let mut asset =
            block_on(api.author_asset(&entry_id, inherit_from))?.map_err(api_message)?;
        let formal =
            block_on(api.formal_version_by_label(&asset.skill.id, &asset.skill.current_version))?
                .map_err(api_message)?;
        let published_identity = block_on(
            api.card_meta(
                formal
                    .package_sha256
                    .as_deref()
                    .ok_or("正式版本没有内容包")?,
            ),
        )?
        .map_err(api_message)?
        .ok_or("正式版本内容无法核验")?
        .identity();
        if asset.entry.card.as_ref().map(|card| card.identity()) != Some(identity.clone()) {
            return Err("账号内容在准备期间发生变化，请重新核验后共享".into());
        }
        if content::local_identity(&skill_root, Some(&entry.baseline.content.executable_paths))?.0
            != identity
        {
            return Err("本机内容在准备期间发生变化，请重新确认共享".into());
        }
        if published_identity == identity
            && asset.entry.version_state.version_policy == Some(1)
            && !formal_content_matches(&asset.entry.version_state, &formal.id)
        {
            asset.entry = block_on(api.update_entry(
                &entry_id,
                &api::UpdateEntry {
                    base_revision: asset.entry.revision,
                    source: None,
                    profile: None,
                    device: device_label(),
                    source_url_synced: false,
                    clear_source_url: false,
                    version_intent: Some(crate::version_policy::VersionIntent::Formal {
                        version_id: formal.id.clone(),
                    }),
                },
            ))?
            .map_err(api_message)?;
            if !formal_content_matches(&asset.entry.version_state, &formal.id) {
                return Err("作者资产的正式版本身份尚未确认，请重试".into());
            }
        }
        let mut sidecar = library_read_profile(&skill_root)?;
        sidecar.server_id = Some(asset.skill.id.clone());
        sidecar.server_owner_id = Some(session.user_id().to_string());
        sidecar.is_own = Some(true);
        crate::version_policy::accept(
            &skill_root,
            &mut sidecar.version_metadata,
            session.user_id(),
            &entry_id,
            &asset.entry.version_state,
            asset.entry.accepted_version_receipt.as_ref(),
            Some(&identity),
        )?;
        if published_identity == identity && asset.entry.version_state.version_policy.is_none() {
            if let Some(hash) = crate::version_policy::head(&skill_root) {
                crate::version_policy::remember_receipts(&mut sidecar.version_metadata);
                let previous = sidecar.version_metadata.commits.get(&hash);
                let label = previous
                    .map(|m| m.label.clone())
                    .unwrap_or_else(|| formal.version.clone());
                if crate::version_policy::ordinal(&label).is_some() {
                    sidecar.version_metadata.commits.insert(
                        hash,
                        crate::version_policy::CommitVersion {
                            label: label.clone(),
                            original_label: formal.version.clone(),
                            content: identity.clone(),
                            receipt: None,
                            formal_version_id: Some(formal.id.clone()),
                            pending: Some(crate::version_policy::VersionIntent::Formal {
                                version_id: formal.id.clone(),
                            }),
                        },
                    );
                    sidecar.version = label;
                }
            }
        }
        crate::commands::write_version_profile_at(&skill_root, &sidecar)?;
        let mut index = load_index(&root, session.user_id())?;
        if let Some(entry) = index.entries.get_mut(&entry_id) {
            entry.revision = asset.entry.revision;
            entry.baseline.version_state = asset.entry.version_state.clone();
            save_index(&root, &index)?;
        }
        Ok(LibraryAuthorAsset {
            formal_version_id: (published_identity == identity).then_some(formal.id.clone()),
            server_id: asset.skill.id,
            server_owner_id: session.user_id().to_string(),
            name: asset.skill.name,
            current_version: asset.skill.current_version,
            content_matches_version: published_identity == identity
                && formal_content_matches(&asset.entry.version_state, &formal.id),
        })
    })
    .await
}

fn formal_content_matches(state: &crate::version_policy::RemoteVersion, version_id: &str) -> bool {
    state.version_policy.is_none()
        || state
            .version
            .as_ref()
            .is_some_and(|r| r.formal_version_id.as_deref() == Some(version_id))
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/// Bind a stable, authorized formal UUID only after checking its actual bytes.
#[tauri::command]
pub async fn record_skill_formal_version(
    skill_id: String,
    version_id: String,
    git_hash: Option<String>,
    frozen_token: Option<String>,
) -> Result<(), String> {
    in_background(move || {
        crate::commands::validate_skill_id_for_lock(&skill_id)?;
        uuid::Uuid::parse_str(&version_id).map_err(|_| "正式版本标识无效")?;
        let initial = signed_in_session().map_err(|e| e.message())?;
        if let Some(token) = frozen_token.as_deref() {
            let _lock = lock_skill_dir_at(&crate::skillhub_dir(), &skill_id)?;
            let _lease = acquire_current_session_lease(&initial)?.ok_or("账号已切换")?;
            let frozen = crate::commands::frozen_version::checked(token, &skill_id)?;
            // The existing account binding API requires the current library card.
            frozen.require_matching_working_tree(&crate::skills_dir().join(&skill_id))?;
        }
        let initial_profile = library_read_profile_readonly(&crate::skills_dir().join(&skill_id))?;
        if initial_profile.library_account_id.as_deref() == Some(initial.user_id()) {
            let report = match block_on(run_sync_for_session(initial.clone(), false, None))? {
                Err(SyncError::Busy) => SyncReport::default(),
                other => other.map_err(|e| e.message())?,
            };
            if report
                .problems
                .iter()
                .any(|p| p.skill_id.as_deref() == Some(&skill_id))
            {
                return Err("正式版本已创建，本机同步仍待处理，请处理后补全记录".into());
            }
        }
        let session = signed_in_session().map_err(|e| e.message())?;
        if session.user_id() != initial.user_id() || session.auth_token() != initial.auth_token() {
            return Err("正式版本记录期间账号已切换".into());
        }
        let root = session.storage_root(&crate::skillhub_dir());
        let _run = lock_skill_dir_at(&root, &format!("library-sync-{}", session.user_id()))?;
        let _lock = lock_skill_dir_at(&crate::skillhub_dir(), &skill_id)?;
        let _lease = acquire_current_session_lease(&session)?.ok_or("账号已切换")?;
        let path = crate::skills_dir().join(&skill_id);
        let frozen = frozen_token
            .as_deref()
            .map(|token| crate::commands::frozen_version::checked(token, &skill_id))
            .transpose()?;
        let git_hash = frozen
            .as_ref()
            .map(|f| f.record_hash(&path))
            .transpose()?
            .or(git_hash);
        let mut sidecar = library_read_profile(&path)?;
        if sidecar
            .library_account_id
            .as_deref()
            .is_some_and(|id| id != session.user_id())
        {
            return Err("Skill 属于另一个账号".into());
        }
        let server_id = sidecar
            .server_id
            .as_deref()
            .or_else(|| {
                sidecar
                    .upstream
                    .as_ref()
                    .and_then(|u| u.server_skill_id.as_deref())
            })
            .ok_or("Skill 未关联正式资产")?;
        let api = HttpLibraryApi::new(&session)?;
        let formal = block_on(api.formal_version(server_id, &version_id))?.map_err(api_message)?;
        if crate::version_policy::ordinal(&formal.version).is_none() {
            return Err("VERSION_LABEL_MIGRATION_REQUIRED: 来源版本待规范化".into());
        }
        let card = block_on(
            api.card_meta(
                formal
                    .package_sha256
                    .as_deref()
                    .ok_or("正式版本没有内容包")?,
            ),
        )?
        .map_err(api_message)?
        .ok_or("正式版本内容未获授权")?;
        if git_hash.is_none() {
            let current =
                content::local_identity(&path, Some(&card.identity().executable_paths))?.0;
            if current != card.identity() {
                return Err("正式版本已创建，但本机文件又发生变化；请核验后补全记录".into());
            }
            let carries = crate::version_policy::head(&path)
                .and_then(|h| {
                    git2::Repository::open(&path).ok().and_then(|r| {
                        git2::Oid::from_str(&h).ok().and_then(|id| {
                            r.find_commit(id)
                                .ok()
                                .and_then(|c| crate::version_policy::commit_content(&r, &c).ok())
                        })
                    })
                })
                .is_some_and(|i| i == current);
            if !carries {
                // The authorized receipt assigns this snapshot's number; it is not a new local save.
                crate::commands::library_snapshot_at(&path, "补全正式版本记录")?;
            }
        }
        let hash = git_hash
            .or_else(|| crate::version_policy::head(&path))
            .ok_or("没有本机提交")?;
        if hash.len() != 40 {
            return Err("需要完整 Git hash".into());
        }
        let repo = git2::Repository::open(&path).map_err(|e| e.to_string())?;
        let commit = repo
            .find_commit(git2::Oid::from_str(&hash).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let identity = crate::version_policy::commit_content(&repo, &commit)?;
        if identity != card.identity() {
            return Err("正式版本与本机提交内容不同".into());
        }
        crate::version_policy::normalize_history(&path, &mut sidecar.version_metadata)?;
        crate::version_policy::remember_receipts(&mut sidecar.version_metadata);
        let entry_id = sidecar.library_entry_id.clone();
        let supported = block_on(api.capabilities())?
            .map_err(api_message)?
            .iter()
            .any(|c| c == crate::version_policy::CAPABILITY);
        let mut receipt = None;
        if let Some(entry_id) = entry_id.filter(|_| supported) {
            let entries = block_on(api.list())?.map_err(api_message)?;
            let entry = entries
                .iter()
                .find(|entry| entry.id == entry_id && !entry.deleted)
                .ok_or("账号条目不存在")?;
            if entry.card.as_ref().map(|c| c.identity()) != Some(identity.clone()) {
                return Err("请先同步目标内容，再绑定正式版本".into());
            }
            let request = api::UpdateEntry {
                base_revision: entry.revision,
                source: None,
                profile: None,
                device: device_label(),
                source_url_synced: false,
                clear_source_url: false,
                version_intent: Some(crate::version_policy::VersionIntent::Formal {
                    version_id: version_id.clone(),
                }),
            };
            let updated = block_on(api.update_entry(&entry_id, &request))?.map_err(api_message)?;
            receipt = updated
                .accepted_version_receipt
                .clone()
                .or(updated.version_state.version.clone())
                .filter(|r| r.formal_version_id.as_deref() == Some(&version_id));
            if receipt.is_none() {
                return Err("正式绑定缺少准确版本收据".into());
            }
            crate::version_policy::accept(
                &path,
                &mut sidecar.version_metadata,
                session.user_id(),
                &entry_id,
                &updated.version_state,
                receipt.as_ref(),
                Some(&identity),
            )?;
            let mut index = load_index(&root, session.user_id())?;
            if let Some(indexed) = index.entries.get_mut(&entry_id) {
                indexed.revision = updated.revision;
                if let Some(card) = updated.card.as_ref() {
                    indexed.card_sha256 = card.sha256.clone();
                }
                indexed.baseline.version_state = updated.version_state;
            }
            save_index(&root, &index)?;
        }
        let label = receipt
            .as_ref()
            .map(|r| r.label.clone())
            .unwrap_or(formal.version.clone());
        if crate::version_policy::ordinal(&label).is_none() {
            return Err("VERSION_LABEL_MIGRATION_REQUIRED: 来源版本待规范化".into());
        }
        sidecar.version_metadata.high_water = sidecar
            .version_metadata
            .high_water
            .max(crate::version_policy::ordinal(&label).unwrap_or(-1));
        let original_label = sidecar
            .version_metadata
            .commits
            .get(&hash)
            .map(|m| m.original_label.clone())
            .unwrap_or_else(|| formal.aliases.first().cloned().unwrap_or(formal.version));
        if let Some(frozen) = frozen.as_ref().filter(|f| f.hash == hash) {
            frozen.activate(&path)?;
        }
        sidecar.version_metadata.commits.insert(
            hash,
            crate::version_policy::CommitVersion {
                label: label.clone(),
                original_label,
                content: identity,
                receipt: receipt.clone(),
                formal_version_id: Some(version_id.clone()),
                pending: receipt
                    .is_none()
                    .then_some(crate::version_policy::VersionIntent::Formal { version_id }),
            },
        );
        sidecar.version_metadata.mapping_digest = formal.version_mapping_digest;
        crate::version_policy::remember_receipts(&mut sidecar.version_metadata);
        sidecar.version = label;
        crate::commands::write_version_profile_at(&path, &sidecar)
    })
    .await
}

pub(crate) const SYNC_USAGE: &str =
    "用法：\n  skillhub sync [--retry] [--json]\n  skillhub sync status [--json]";

fn cli_account(state: CliAccountState) -> CliAccount {
    match runtime_session_snapshot() {
        Ok(session) if session.auth_token().is_some() && !session.is_sync_pending() => {
            CliAccount::local(state, session.user_id())
        }
        _ => CliAccount::state(CliAccountState::Guest),
    }
}

fn cli_failure(command: &'static str, error: &SyncError) -> CliCommandOutput {
    let (code, exit) = match error {
        SyncError::Unauthorized => (CliErrorCode::AuthExpired, EXIT_AUTH),
        SyncError::AccountChanged => (CliErrorCode::AccountChanged, EXIT_AUTH),
        SyncError::Busy => (CliErrorCode::Conflict, crate::cli::EXIT_CONFLICT),
        SyncError::Unsupported => (CliErrorCode::NotFound, EXIT_NETWORK),
        SyncError::Fatal(_) => (CliErrorCode::InternalError, crate::cli::EXIT_INTERNAL),
    };
    CliCommandOutput::failure(
        command,
        cli_account(CliAccountState::Unverified),
        code,
        error.message(),
        exit,
        Vec::new(),
    )
}

/// `skillhub sync ...`; shares `run_sync` with the APP.
pub(crate) async fn execute_sync_cli(args: &[String]) -> Option<CliCommandOutput> {
    if args.first().map(String::as_str) != Some("sync") {
        return None;
    }
    let rest = args[1..]
        .iter()
        .map(String::as_str)
        .filter(|arg| *arg != "--json")
        .collect::<Vec<_>>();
    let output = match rest.as_slice() {
        [] | ["--retry"] => {
            let retry = rest.contains(&"--retry");
            let session = match cli_sync_session("sync") {
                Ok(session) => session,
                Err(output) => return Some(output),
            };
            match run_sync_for_session(session, retry, None).await {
                Ok(report) => CliCommandOutput::success(
                    "sync",
                    cli_account(CliAccountState::Authenticated),
                    serde_json::to_value(&report).unwrap_or_default(),
                    report
                        .problems
                        .iter()
                        .map(|problem| problem.message.clone())
                        .collect(),
                    if report.kept_local > 0 {
                        vec![format!(
                            "{} 个 Skill 只保留在这台电脑、未加入账号；需要同步时在 SkillHub APP「账号中的其他 Skill」里加入",
                            report.kept_local
                        )]
                    } else {
                        Vec::new()
                    },
                ),
                Err(error) => cli_failure("sync", &error),
            }
        }
        ["status"] => {
            let session = match cli_sync_session("sync status") {
                Ok(session) => session,
                Err(output) => return Some(output),
            };
            match status_for(&session) {
                Ok(status) => CliCommandOutput::success(
                    "sync status",
                    cli_account(CliAccountState::Unverified),
                    serde_json::to_value(&status).unwrap_or_default(),
                    Vec::new(),
                    Vec::new(),
                ),
                Err(message) => cli_failure("sync status", &SyncError::Fatal(message)),
            }
        }
        _ => CliCommandOutput::failure(
            "sync",
            cli_account(CliAccountState::Unverified),
            CliErrorCode::ValidationFailed,
            SYNC_USAGE,
            EXIT_USAGE,
            Vec::new(),
        ),
    };
    Some(output)
}

fn cli_sync_session(command: &'static str) -> Result<RuntimeSession, CliCommandOutput> {
    let session = runtime_session_snapshot()
        .map_err(|message| cli_failure(command, &SyncError::Fatal(message)))?;
    crate::cli_auth::require_server_space(&session)
        .map_err(|error| crate::cli_auth::auth_guard_failure(command, error))?;
    validate_signed_in_session(session).map_err(|error| cli_failure(command, &error))
}

#[cfg(test)]
mod tests;
