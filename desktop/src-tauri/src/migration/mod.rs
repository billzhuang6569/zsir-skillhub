//! Local snapshots cross the switch boundary; credentials never do.
mod engine;
mod snapshot;
#[cfg(test)]
mod tests;
mod transport;

use crate::library_sync::profile::SyncProfile;
#[cfg(windows)]
use crate::platform_fs::{MetadataExt, OpenOptionsExt};
use crate::runtime_env::{read_private_json, write_private_json, RuntimeSession};
use crate::server_request::{SpaceHandle, SpaceRegistry};
use crate::spaces::Deployment;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Manager};
use transport::{Native, Side, Transport};

const MAX_JSON: usize = 8 * 1024 * 1024;
const MAX_PACKAGE: usize = 20 * 1024 * 1024;

fn resource(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
        && s != "."
        && s != ".."
}
fn hash_valid(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if serde_json::to_vec(value)
        .map_err(|_| "MIGRATION_SERIALIZE")?
        .len()
        > MAX_JSON
    {
        return Err("MIGRATION_MANIFEST_TOO_LARGE".into());
    }
    write_private_json(path, value)
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    profile: String,
    origin: String,
    user_id: String,
}
impl Identity {
    fn from_session(s: &RuntimeSession) -> Result<Self, String> {
        Ok(Self {
            profile: match s.deployment() {
                Deployment::Official => "yitan-official",
                d => d.profile(),
            }
            .into(),
            origin: s
                .deployment()
                .base()?
                .map(|u| crate::spaces::canonical_base(&u))
                .unwrap_or_else(|| "http://localhost/skillhub-local".into()),
            user_id: s.user_id().into(),
        })
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Avatar {
    id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    style_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    style_version: Option<u64>,
    mime_type: String,
    size: usize,
    sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreCopy {
    listing_id: String,
    version: String,
    state: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    source_origin: String,
    source_user_id: String,
    source_skill_id: String,
    content_hash: String,
    kind: String,
    version: String,
    name: String,
    #[serde(flatten)]
    profile: SyncProfile,
    package_size: usize,
    package_sha256: String,
    avatars: Vec<Avatar>,
    selected_avatar_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    store_copy: Option<StoreCopy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    map_to_skill_id: Option<String>,
}
impl Item {
    fn operation_key(&self) -> String {
        sha(&serde_json::to_vec(&[
            &self.source_origin,
            &self.source_user_id,
            &self.source_skill_id,
            &self.content_hash,
        ])
        .expect("string array"))
    }
}
#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Choice {
    #[default]
    Skip,
    Copy {
        #[serde(rename = "targetName")]
        target_name: Option<String>,
    },
    Map {
        #[serde(rename = "mapToSkillId")]
        map_to_skill_id: String,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    id: String,
    source_skill_id: String,
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    category: String,
    item: Option<Item>,
    choice: Choice,
    source_entry_id: Option<String>,
    source_local_id: Option<String>,
    #[serde(default)]
    source_entry_aliases: Vec<String>,
    #[serde(default)]
    source_local_aliases: Vec<String>,
    target_entry_id: String,
    target_local_id: Option<String>,
    state: String,
    reason: String,
    #[serde(default)]
    warnings: Vec<String>,
    pending_delta: bool,
    result: Option<ItemResult>,
    precheck: Option<Precheck>,
    library_done: bool,
    organizer_done: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemResult {
    operation_key: String,
    status: String,
    target_skill_id: Option<String>,
    version: Option<String>,
    #[serde(default)]
    avatars: Vec<AvatarResult>,
    #[serde(default)]
    errors: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AvatarResult {
    id: String,
    status: String,
    code: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Precheck {
    operation_key: String,
    status: String,
    reason: String,
    existing_skill_id: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u8,
    local_migration_id: String,
    source: Identity,
    target: Identity,
    source_deployment: Deployment,
    target_deployment: Deployment,
    migration_id: Option<String>,
    records: Vec<String>,
    snapshot_at: u64,
    state: String,
    #[serde(default)]
    last_error: Option<String>,
    limits: Limits,
    organizer: crate::library_organizer::OrganizerState,
    keys: Vec<crate::key_vault::MigrationKeyChoice>,
    keys_done: bool,
    #[serde(default)]
    key_results: Vec<KeyResult>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyResult {
    name: String,
    target_name: String,
    status: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Limits {
    #[serde(default)]
    package: BTreeMap<String, u64>,
    #[serde(default)]
    unlimited: Vec<String>,
    #[serde(flatten)]
    values: BTreeMap<String, Option<u64>>,
}

struct Store {
    root: PathBuf,
}
impl Store {
    fn at(home: &Path, target: &RuntimeSession, id: &str) -> Result<Self, String> {
        Self::locate(home, target, id, true)
    }
    fn existing(home: &Path, target: &RuntimeSession, id: &str) -> Result<Self, String> {
        Self::locate(home, target, id, false)
    }
    fn locate(
        home: &Path,
        target: &RuntimeSession,
        id: &str,
        create: bool,
    ) -> Result<Self, String> {
        uuid::Uuid::parse_str(id).map_err(|_| "MIGRATION_INVALID_ID")?;
        crate::runtime_env::validate_user_id(target.user_id())?;
        let mut root = target.storage_root(home);
        for part in ["migrations", target.user_id(), id] {
            root.push(part);
            if create {
                crate::runtime_env::ensure_private_directory(&root)?;
                crate::platform_fs::set_private_acl(&root)?;
            } else {
                let meta = fs::symlink_metadata(&root).map_err(|_| "MIGRATION_NOT_FOUND")?;
                if !meta.is_dir()
                    || meta.file_type().is_symlink()
                    || meta.mode() & 0o077 != 0
                    || meta.uid() != crate::platform_fs::current_uid()
                {
                    return Err("MIGRATION_UNSAFE_DIRECTORY".into());
                }
            }
        }
        Ok(Self { root })
    }
    fn manifest(&self) -> Result<Manifest, String> {
        let m: Manifest = read_private_json(&self.root.join("manifest.json"))?;
        if m.version != 1 || m.records.len() > 100_000 {
            return Err("MIGRATION_MANIFEST_VERSION".into());
        }
        Ok(m)
    }
    fn save(&self, m: &Manifest) -> Result<(), String> {
        save(&self.root.join("manifest.json"), m)
    }
    fn record_path(&self, id: &str) -> Result<PathBuf, String> {
        uuid::Uuid::parse_str(id).map_err(|_| "MIGRATION_INVALID_ID")?;
        Ok(self.root.join(format!("{id}.json")))
    }
    fn record(&self, id: &str) -> Result<Record, String> {
        read_private_json(&self.record_path(id)?)
    }
    fn put(&self, r: &Record) -> Result<(), String> {
        save(&self.record_path(&r.id)?, r)
    }
    fn blob_path(&self, kind: &str, hash: &str) -> Result<PathBuf, String> {
        if !matches!(kind, "pkg" | "avatar") || !hash_valid(hash) {
            return Err("MIGRATION_HASH_INVALID".into());
        }
        let mut path = self.root.clone();
        for part in ["staging", kind] {
            path.push(part);
            crate::runtime_env::ensure_private_directory(&path)?;
            crate::platform_fs::set_private_acl(&path)?;
        }
        Ok(path.join(if kind == "pkg" {
            format!("{hash}.zip")
        } else {
            hash.into()
        }))
    }
    fn stage(&self, kind: &str, bytes: &[u8]) -> Result<String, String> {
        if bytes.len() > MAX_PACKAGE {
            return Err("MIGRATION_PACKAGE_TOO_LARGE".into());
        }
        let hash = sha(bytes);
        let path = self.blob_path(kind, &hash)?;
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(mut file) => {
                crate::platform_fs::set_private_acl(&path)?;
                file.write_all(bytes)
                    .and_then(|()| file.sync_all())
                    .map_err(|_| "MIGRATION_DISK_WRITE")?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("MIGRATION_DISK_WRITE".into()),
        }
        self.blob(kind, &hash).map_err(|reason| {
            if reason == "MIGRATION_HASH_MISMATCH" {
                "MIGRATION_STAGING_INVALID".into()
            } else {
                reason
            }
        })?;
        Ok(hash)
    }
    fn blob(&self, kind: &str, hash: &str) -> Result<Vec<u8>, String> {
        let path = self.blob_path(kind, hash)?;
        let m = fs::symlink_metadata(&path).map_err(|_| "MIGRATION_BLOB_MISSING")?;
        if !m.is_file()
            || m.file_type().is_symlink()
            || m.len() > MAX_PACKAGE as u64
            || m.mode() & 0o077 != 0
            || m.uid() != crate::platform_fs::current_uid()
        {
            return Err("MIGRATION_BLOB_UNSAFE".into());
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|_| "MIGRATION_BLOB_MISSING")?
            .take(MAX_PACKAGE as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "MIGRATION_BLOB_READ")?;
        if bytes.len() > MAX_PACKAGE || sha(&bytes) != hash {
            return Err("MIGRATION_HASH_MISMATCH".into());
        }
        Ok(bytes)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ItemStatus {
    id: String,
    source_skill_id: String,
    name: String,
    category: String,
    state: String,
    reason: String,
    pending_delta: bool,
    warnings: Vec<String>,
    avatars: Vec<AvatarResult>,
    target_skill_id: Option<String>,
    target_entry_id: Option<String>,
    precheck: Option<Precheck>,
    avatar_count: usize,
    store_state: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationStatus {
    local_migration_id: String,
    state: String,
    last_error: Option<String>,
    snapshot_at: u64,
    items: Vec<ItemStatus>,
    limits: Limits,
    keys: Vec<crate::key_vault::MigrationKeyChoice>,
    keys_done: bool,
    key_results: Vec<KeyResult>,
}
fn safe_error(error: &str) -> String {
    // Only protocol codes may enter the durable report; native errors can contain paths or URLs.
    if error.len() <= 100
        && error.starts_with(|c: char| c.is_ascii_uppercase())
        && error
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    {
        error.into()
    } else {
        "MIGRATION_RETRY_REQUIRED".into()
    }
}

fn report(store: &Store) -> Result<MigrationStatus, String> {
    let m = store.manifest()?;
    let mut items = Vec::new();
    for id in &m.records {
        let r = store.record(id)?;
        items.push(ItemStatus {
            id: r.id,
            source_skill_id: r.source_skill_id,
            name: r
                .display_name
                .as_deref()
                .or_else(|| {
                    r.item
                        .as_ref()
                        .filter(|_| matches!(r.category.as_str(), "reacquire" | "store_copy"))
                        .map(|item| item.profile.display_name.trim())
                        .filter(|name| !name.is_empty())
                })
                .unwrap_or(&r.name)
                .to_string(),
            category: r.category,
            state: r.state,
            reason: r.reason,
            pending_delta: r.pending_delta,
            warnings: {
                let mut warnings = r.warnings;
                if r.pending_delta {
                    warnings.push("PENDING_DELTA".into());
                }
                warnings
            },
            avatars: r
                .result
                .as_ref()
                .map(|result| result.avatars.clone())
                .unwrap_or_default(),
            target_skill_id: r.result.and_then(|result| result.target_skill_id),
            target_entry_id: r.library_done.then_some(r.target_entry_id),
            precheck: r.precheck,
            avatar_count: r.item.as_ref().map_or(0, |item| item.avatars.len()),
            store_state: r
                .item
                .and_then(|item| item.store_copy.map(|copy| copy.state)),
        });
    }
    Ok(MigrationStatus {
        local_migration_id: m.local_migration_id,
        state: m.state,
        last_error: m.last_error,
        snapshot_at: m.snapshot_at,
        items,
        limits: m.limits,
        keys: m.keys,
        keys_done: m.keys_done,
        key_results: m.key_results,
    })
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SourceKind {
    Pending,
    Candidate,
    Local,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SnapshotOptions {
    pub space: SpaceHandle,
    #[serde(default)]
    pub keys: Vec<crate::key_vault::MigrationKeyChoice>,
}

#[derive(Clone, Default)]
pub(crate) struct Jobs(Arc<Mutex<BTreeMap<String, Arc<AtomicBool>>>>);
struct Job {
    jobs: Jobs,
    id: String,
    cancel: Arc<AtomicBool>,
}
impl Jobs {
    fn start(&self, id: &str) -> Result<Job, String> {
        let mut jobs = self.0.lock().map_err(|_| "MIGRATION_BUSY")?;
        // Only one snapshot/import mutates the active target library at a time.
        if !jobs.is_empty() {
            return Err("MIGRATION_BUSY".into());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        jobs.insert(id.into(), cancel.clone());
        Ok(Job {
            jobs: self.clone(),
            id: id.into(),
            cancel,
        })
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.jobs.0.lock() {
            jobs.remove(&self.id);
        }
    }
}

fn target_store(registry: &SpaceRegistry, id: &str) -> Result<(RuntimeSession, Store), String> {
    target_store_at(registry.migration_root(), id)
}

fn target_store_at(root: &Path, id: &str) -> Result<(RuntimeSession, Store), String> {
    let s = crate::runtime_env::runtime_session_snapshot_at(root)?;
    crate::spaces::require_handle(&s, &SpaceRegistry::handle(Some(&s)))?;
    let store = Store::existing(root, &s, id)?;
    let m = store.manifest()?;
    if m.local_migration_id != id
        || m.target != Identity::from_session(&s)?
        || m.target_deployment != *s.deployment()
    {
        return Err("MIGRATION_TARGET_CHANGED".into());
    }
    Ok((s, store))
}

fn readable_store(registry: &SpaceRegistry, id: &str) -> Result<Store, String> {
    readable_store_at(
        registry.migration_root(),
        id,
        registry.migration_window_reader(),
    )
}

fn readable_store_at(
    root: &Path,
    id: &str,
    window: impl FnOnce() -> Result<(RuntimeSession, RuntimeSession), String>,
) -> Result<Store, String> {
    if let Ok((_, store)) = target_store_at(root, id) {
        return Ok(store);
    }
    let (pending, candidate) = window()?;
    for session in [pending, candidate] {
        let Ok(store) = Store::existing(root, &session, id) else {
            continue;
        };
        let m = store.manifest()?;
        if m.local_migration_id == id
            && m.target == Identity::from_session(&session)?
            && m.target_deployment == *session.deployment()
        {
            return Ok(store);
        }
    }
    Err("MIGRATION_TARGET_CHANGED".into())
}

#[tauri::command]
pub(crate) async fn migration_snapshot_begin(
    source_kind: SourceKind,
    options: SnapshotOptions,
    app: tauri::AppHandle,
) -> Result<MigrationStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<SpaceRegistry>();
        let jobs = app.state::<Jobs>();
        let id = uuid::Uuid::new_v4().to_string();
        let job = jobs.start(&id)?;
        let window = registry.migration_window()?;
        let (source, target) = match source_kind {
            SourceKind::Local if window.1.deployment() == &Deployment::Local => {
                (window.1.clone(), window.0.clone())
            }
            SourceKind::Pending | SourceKind::Local => (window.0.clone(), window.1.clone()),
            SourceKind::Candidate => (window.1.clone(), window.0.clone()),
        };
        if SpaceRegistry::handle(Some(&target)) != options.space
            || target.auth_token().is_none()
            || (matches!(source_kind, SourceKind::Local)
                && source.deployment() != &Deployment::Local)
        {
            return Err("MIGRATION_INVALID_CONTEXT".into());
        }
        if Identity::from_session(&source)? == Identity::from_session(&target)? {
            return Err("MIGRATION_SAME_IDENTITY".into());
        }
        let native = Native {
            registry: &registry,
            source: Some(source.clone()),
            target: target.clone(),
            window: Some(window),
            cancel: &job.cancel,
            started: std::time::Instant::now(),
        };
        let store = Store::at(registry.migration_root(), &target, &id)?;
        let _ = app.emit(
            "migration-progress",
            json!({"localMigrationId":id,"state":"snapshotting",
                "space": options.space, "userId": target.user_id()}),
        );
        let result = block_on(snapshot::snapshot(
            &native,
            &store,
            registry.migration_root(),
            &source,
            &target,
            id,
            options.keys,
        ));
        if let Err(error) = result {
            if let Ok(mut m) = store.manifest() {
                m.state = if job.cancel.load(Ordering::Acquire) {
                    "cancelled"
                } else {
                    "snapshotFailed"
                }
                .into();
                store.save(&m)?;
            }
            return Err(error);
        }
        report(&store)
    })
    .await
    .map_err(|_| "MIGRATION_WORKER_FAILED")?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ItemChoice {
    id: String,
    #[serde(flatten)]
    choice: Choice,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Choices {
    items: Vec<ItemChoice>,
    #[serde(default)]
    keys: Vec<crate::key_vault::MigrationKeyChoice>,
}

#[tauri::command]
pub(crate) fn migration_set_choices(
    local_migration_id: String,
    choices: Choices,
    registry: tauri::State<'_, SpaceRegistry>,
    jobs: tauri::State<'_, Jobs>,
) -> Result<(), String> {
    let _job = jobs.start(&local_migration_id)?;
    // Choices may be made while the target is still a candidate/pending.
    let store = readable_store(&registry, &local_migration_id)?;
    set_choices(&store, choices)
}

fn set_choices(store: &Store, choices: Choices) -> Result<(), String> {
    let mut m = store.manifest()?;
    if m.keys_done || m.state == "completed" {
        return Err("MIGRATION_FINALIZED_START_NEW".into());
    }
    let mut updated = Vec::new();
    for choice in choices.items {
        if !m.records.contains(&choice.id) {
            return Err("MIGRATION_ITEM_NOT_FOUND".into());
        }
        let mut r = store.record(&choice.id)?;
        if r.result.is_some() || r.library_done || r.state == "submitting" {
            return Err("MIGRATION_ITEM_FINALIZED".into());
        }
        if r.category == "reacquire"
            && matches!(
                choice.choice,
                Choice::Map { .. }
                    | Choice::Copy {
                        target_name: Some(_)
                    }
            )
        {
            return Err("MIGRATION_CATALOG_CHOICE_INVALID".into());
        }
        if r.item.is_none() && choice.choice != Choice::Skip {
            return Err("MIGRATION_ITEM_UNAVAILABLE".into());
        }
        if let Some(item) = r.item.as_mut() {
            item.target_name = None;
            item.map_to_skill_id = None;
            match &choice.choice {
                Choice::Copy {
                    target_name: Some(name),
                } => {
                    crate::commands::validate_skill_id_for_lock(name)?;
                    item.target_name = Some(name.clone());
                }
                Choice::Map { map_to_skill_id } => {
                    uuid::Uuid::parse_str(map_to_skill_id)
                        .map_err(|_| "MIGRATION_INVALID_TARGET")?;
                    item.map_to_skill_id = Some(map_to_skill_id.clone());
                }
                _ => {}
            }
        }
        r.choice = choice.choice;
        r.state = "pending".into();
        r.reason.clear();
        updated.push(r);
    }
    crate::key_vault::validate_migration_choices(&choices.keys)?;
    for r in updated {
        store.put(&r)?;
    }
    m.keys = choices.keys;
    m.keys_done = false;
    m.state = "ready".into();
    store.save(&m)
}

fn block_on<T>(f: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "MIGRATION_RUNTIME")?
        .block_on(f)
}

#[tauri::command]
pub(crate) fn migration_run(
    local_migration_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let registry = app.state::<SpaceRegistry>();
    let (target, _) = target_store(&registry, &local_migration_id)?;
    let space = SpaceRegistry::handle(Some(&target));
    let user_id = target.user_id().to_string();
    let jobs = app.state::<Jobs>();
    let job = jobs.start(&local_migration_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<SpaceRegistry>();
        let result = (|| {
            let (target, store) = target_store(&registry, &local_migration_id)?;
            let native = Native {
                registry: &registry,
                source: None,
                target,
                window: None,
                cancel: &job.cancel,
                started: std::time::Instant::now(),
            };
            block_on(engine::run(&native, &store, |status| {
                let _ = app.emit(
                    "migration-progress",
                    json!({
                        "space": space, "userId": user_id,
                        "localMigrationId": status.local_migration_id, "state": status.state
                    }),
                );
            }))?;
            Ok::<_, String>(())
        })();
        if let Err(error) = result {
            let state = if job.cancel.load(Ordering::Acquire) {
                "cancelled"
            } else {
                "paused"
            };
            if let Ok((_, store)) = target_store(&registry, &local_migration_id) {
                if let Ok(mut manifest) = store.manifest() {
                    manifest.state = state.into();
                    manifest.last_error = Some(safe_error(&error));
                    let _ = store.save(&manifest);
                }
            }
            let _ = app.emit(
                "migration-progress",
                json!({"localMigrationId":local_migration_id,
                "space":space,"userId":user_id,"state":state,"reason":safe_error(&error)}),
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn migration_cancel(
    local_migration_id: String,
    jobs: tauri::State<'_, Jobs>,
    registry: tauri::State<'_, SpaceRegistry>,
) -> Result<(), String> {
    let root = registry.migration_root().to_path_buf();
    let window = registry.migration_window_reader();
    let jobs = jobs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(cancel) = jobs
            .0
            .lock()
            .map_err(|_| "MIGRATION_BUSY")?
            .get(&local_migration_id)
        {
            // A snapshot announces its job before its first manifest write.
            cancel.store(true, Ordering::Release);
        } else {
            let store = readable_store_at(&root, &local_migration_id, &window)?;
            let mut manifest = store.manifest()?;
            if manifest.state != "completed" {
                manifest.state = "cancelled".into();
                store.save(&manifest)?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("迁移取消异常结束: {error}"))?
}
#[tauri::command]
pub(crate) async fn migration_status(
    local_migration_id: String,
    registry: tauri::State<'_, SpaceRegistry>,
    jobs: tauri::State<'_, Jobs>,
) -> Result<MigrationStatus, String> {
    let root = registry.migration_root().to_path_buf();
    let window = registry.migration_window_reader();
    let jobs = jobs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        live_report(
            &readable_store_at(&root, &local_migration_id, &window)?,
            &jobs,
        )
    })
    .await
    .map_err(|error| format!("migration_status异常结束: {error}"))?
}
#[tauri::command]
pub(crate) async fn migration_report(
    local_migration_id: String,
    registry: tauri::State<'_, SpaceRegistry>,
    jobs: tauri::State<'_, Jobs>,
) -> Result<MigrationStatus, String> {
    migration_status(local_migration_id, registry, jobs).await
}
fn live_report(store: &Store, jobs: &Jobs) -> Result<MigrationStatus, String> {
    let mut status = report(store)?;
    let active = jobs
        .0
        .lock()
        .map_err(|_| "MIGRATION_BUSY")?
        .contains_key(&status.local_migration_id);
    if active
        && matches!(
            status.state.as_str(),
            "ready" | "running" | "imported" | "paused"
        )
    {
        status.state = "running".into();
    } else if !active {
        if matches!(status.state.as_str(), "running" | "imported" | "paused")
            && status.last_error.is_none()
        {
            status.last_error = Some("MIGRATION_INTERRUPTED".into());
        }
        status.state = match status.state.as_str() {
            "running" | "imported" => "paused".into(),
            "snapshotting" => "snapshotFailed".into(),
            _ => status.state,
        };
    }
    Ok(status)
}
#[tauri::command]
pub(crate) async fn migration_list(
    registry: tauri::State<'_, SpaceRegistry>,
    jobs: tauri::State<'_, Jobs>,
) -> Result<Vec<MigrationStatus>, String> {
    let root = registry.migration_root().to_path_buf();
    let jobs = jobs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = crate::runtime_env::runtime_session_snapshot_at(&root)?;
        crate::spaces::require_handle(&s, &SpaceRegistry::handle(Some(&s)))?;
        let dir = s.storage_root(&root).join("migrations").join(s.user_id());
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err("MIGRATION_LIST_FAILED".into()),
        };
        let mut reports = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|_| "MIGRATION_LIST_FAILED")?;
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            let (_, store) = target_store_at(&root, &id)?;
            let status = live_report(&store, &jobs)?;
            reports.push(status);
        }
        reports.sort_by_key(|status| std::cmp::Reverse(status.snapshot_at));
        Ok(reports)
    })
    .await
    .map_err(|error| format!("migration_list异常结束: {error}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationKeyName {
    name: String,
    authorized_skill_count: usize,
    conflict: bool,
}

fn key_names(home: &Path, manifest: &Manifest) -> Result<Vec<MigrationKeyName>, String> {
    let source = manifest.source_deployment.root(home);
    let target = manifest.target_deployment.root(home);
    let names = crate::key_vault::vault_key_names_at(&source, &manifest.source.user_id)?;
    let existing = crate::key_vault::vault_lookup_names_at(&target, &manifest.target.user_id)?;
    let meta = crate::key_vault::read_meta_at(&source, &manifest.source.user_id)?;
    Ok(names
        .into_iter()
        .map(|name| MigrationKeyName {
            authorized_skill_count: meta
                .keys
                .get(&name)
                .map_or(0, |key| key.allowed_skills.len()),
            conflict: existing.contains_key(&name),
            name,
        })
        .collect())
}

#[tauri::command]
pub(crate) async fn migration_key_names(
    local_migration_id: String,
    registry: tauri::State<'_, SpaceRegistry>,
) -> Result<Vec<MigrationKeyName>, String> {
    let root = registry.migration_root().to_path_buf();
    let window = registry.migration_window_reader();
    tauri::async_runtime::spawn_blocking(move || {
        let store = readable_store_at(&root, &local_migration_id, &window)?;
        let result = key_names(&root, &store.manifest()?)?;
        readable_store_at(&root, &local_migration_id, &window)?;
        Ok(result)
    })
    .await
    .map_err(|error| format!("migration_key_names异常结束: {error}"))?
}
