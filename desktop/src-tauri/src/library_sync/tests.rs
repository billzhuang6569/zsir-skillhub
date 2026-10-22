//! Engine tests against an in-memory library server. The fake server parses
//! the real ZIP packages, so these tests also prove that the client packager
//! and content identity agree with the server-side definition.

use super::api::{
    ApiError, AuthorAsset, CreateEntry, EntrySource, LibraryApi, OwnSkill, RemoteCard, RemoteEntry,
    UpdateEntry, LIBRARY_SYNC_CAPABILITY,
};
use super::content::content_hash;
use super::engine::{
    AccountGuard, Engine, Held, LocalOps, SyncError, SyncOptions, SyncPaths, SyncReport,
};
use super::engine::{KEPT_ACCOUNT_DELETED, KEPT_BY_CHOICE};
use super::index::{
    account_dir, backups_dir, load_index, local_only_dir, save_index, MigrationCandidate,
    SyncIndex, INDEX_VERSION, LEGACY_INDEX_VERSION,
};
use super::profile::SyncProfile;
use super::{
    delete_account_entry, finish_account_delete_locally, kept_local_items, summarize_entries,
    AccountDeleteResult,
};
use crate::commands::{
    land_library_package_at, library_read_profile, library_snapshot_at, library_write_profile,
    LibraryLanding, LibraryLandingError,
};
use crate::{AcquisitionSource, SkillHubProfile};
use sha2::{Digest, Sha256};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};

// ── Fake server ─────────────────────────────────────────────────────────────

#[derive(Clone)]
struct StoredCard {
    bytes: Vec<u8>,
    card: RemoteCard,
}

#[derive(Clone)]
struct StoredEntry {
    entry: RemoteEntry,
    digest: String,
    migration_key: Option<String>,
}

type Hook = Box<dyn FnMut(&str)>;

#[derive(Clone, Copy)]
enum DeleteFault {
    /// The Server commits the delete, then the reply is lost.
    CommitThenLoseReply,
    /// The request never reaches the Server.
    FailWithoutCommit,
    /// The Server refuses the request (4xx).
    Reject,
    /// Another device deleted the entry between list and DELETE (409).
    OtherDeviceDeletesThenConflict,
    /// Another device edited the entry between list and DELETE (409).
    OtherDeviceEditsThenConflict,
}

#[derive(Default)]
struct FakeServer {
    catalog_enabled: Cell<bool>,
    catalog_fault: RefCell<Option<ApiError>>,
    version_policy_enabled: Cell<bool>,
    /// An older server without `skills.source-url.v1` (strict profile schema).
    source_url_unsupported: Cell<bool>,
    /// Source a created entry inherits from its source version when the
    /// request omits `sourceUrl`.
    inherited_source_url: RefCell<Option<String>>,
    receipts: RefCell<BTreeMap<String, Vec<crate::version_policy::VersionReceipt>>>,
    receipt_reads: Cell<u32>,
    lose_save_reply: Cell<bool>,
    downloads: Cell<u32>,
    cards: RefCell<BTreeMap<String, StoredCard>>,
    grants: RefCell<std::collections::BTreeSet<String>>,
    entries: RefCell<BTreeMap<String, StoredEntry>>,
    /// Current card of marketplace/team/authored source Skills.
    sources: RefCell<BTreeMap<String, String>>,
    formal_cards: RefCell<BTreeMap<String, String>>,
    source_versions: RefCell<BTreeMap<String, String>>,
    deny_formal_lookup: Cell<bool>,
    formal_lookups: Cell<u32>,
    own_skills: RefCell<Vec<OwnSkill>>,
    quota_exceeded: Cell<bool>,
    max_entries: Cell<usize>,
    fail_creates: Cell<u32>,
    uploads: Cell<u32>,
    /// Runs after a successful create/update with the entry id.
    after_write: RefCell<Option<Hook>>,
    /// Runs once at the start of the next update (simulates a racing device).
    before_update: RefCell<Option<Hook>>,
    /// One-shot fault for the next `delete_entry`.
    delete_fault: Cell<Option<DeleteFault>>,
    list_calls: Cell<u32>,
    /// `list` fails from this call number on (1-based); 0 means never.
    fail_list_from: Cell<u32>,
    /// One-shot failure at a selected list call, including landing revalidation.
    fail_list_once_at: RefCell<Option<(u32, ApiError)>>,
    /// The next this many card downloads fail like a dropped connection.
    fail_downloads: Cell<u32>,
    delete_during_download: Cell<bool>,
    /// Runs once at the start of the next card upload.
    before_upload: RefCell<Option<Box<dyn FnOnce()>>>,
    /// Runs once when the engine asks for the user's own Skills.
    on_own_skills: RefCell<Option<Box<dyn FnOnce()>>>,
    /// Another device renames the entry right before the next update lands.
    rename_before_update: RefCell<Option<String>>,
}

fn identity_of_zip(bytes: &[u8]) -> RemoteCard {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("valid zip");
    let mut files = Vec::new();
    let mut executable = Vec::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).unwrap();
        if file.is_dir() {
            continue;
        }
        let name = super::content::nfc(file.name());
        let mode = file.unix_mode().unwrap_or(0);
        if mode & 0o170000 == 0o100000 && mode & 0o111 != 0 {
            executable.push(name.clone());
        }
        let mut data = Vec::new();
        file.read_to_end(&mut data).unwrap();
        files.push((name, data));
    }
    executable.sort();
    RemoteCard {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        size: bytes.len() as u64,
        content_hash: content_hash(&files),
        executable_paths: executable,
    }
}

impl FakeServer {
    /// What the server stores from a request profile. The engine must flag
    /// source support exactly when the server advertised it; an old server
    /// never sees the field (the HTTP client strips it).
    /// `omitted` is what an omitted `sourceUrl` means on the real server:
    /// the previous value on update, the source version's on create.
    fn received_profile(
        &self,
        profile: &SyncProfile,
        source_url_synced: bool,
        clear: bool,
        omitted: Option<String>,
    ) -> SyncProfile {
        assert_eq!(
            source_url_synced,
            !self.source_url_unsupported.get(),
            "source support must follow the advertised capability"
        );
        let mut profile = profile.normalized();
        if !source_url_synced {
            profile.source_url = None;
        } else if profile.source_url.is_none() && !clear {
            profile.source_url = omitted;
        }
        profile
    }

    fn new() -> Self {
        let server = Self::default();
        server.max_entries.set(50);
        server
    }

    fn store_card(&self, bytes: Vec<u8>) -> RemoteCard {
        let card = identity_of_zip(&bytes);
        self.cards.borrow_mut().insert(
            card.sha256.clone(),
            StoredCard {
                bytes,
                card: card.clone(),
            },
        );
        card
    }

    fn entry(&self, id: &str) -> RemoteEntry {
        self.entries.borrow()[id].entry.clone()
    }

    fn active(&self) -> Vec<RemoteEntry> {
        self.entries
            .borrow()
            .values()
            .map(|stored| stored.entry.clone())
            .filter(|entry| !entry.deleted)
            .collect()
    }

    fn card_bytes(&self, sha256: &str) -> Vec<u8> {
        self.cards.borrow()[sha256].bytes.clone()
    }

    /// Simulates another device writing a new version of an entry.
    fn remote_edit(&self, id: &str, bytes: Option<Vec<u8>>, profile: Option<SyncProfile>) {
        let card = bytes.map(|bytes| self.store_card(bytes));
        let mut entries = self.entries.borrow_mut();
        let stored = entries.get_mut(id).unwrap();
        if let Some(card) = card {
            stored.entry.card = Some(card);
        }
        if let Some(profile) = profile {
            stored.entry.profile = profile.normalized();
        }
        stored.entry.revision += 1;
    }

    fn remote_delete(&self, id: &str) {
        let mut entries = self.entries.borrow_mut();
        let stored = entries.get_mut(id).unwrap();
        stored.entry.deleted = true;
        stored.entry.revision += 1;
    }

    fn resolve(
        &self,
        source: &EntrySource,
    ) -> Result<(String, String, Option<String>, Option<String>), ApiError> {
        let forbidden = || ApiError::Rejected {
            code: None,
            status: 403,
            message: "source unavailable".into(),
        };
        match source {
            EntrySource::Catalog {
                skill_id,
                package_sha256,
                ..
            } => {
                if let Some(error) = self.catalog_fault.borrow_mut().take() {
                    return Err(error);
                }
                if !self.catalog_enabled.get() || !self.grants.borrow().contains(package_sha256) {
                    return Err(forbidden());
                }
                Ok((
                    package_sha256.clone(),
                    "catalog".into(),
                    Some(skill_id.clone()),
                    None,
                ))
            }
            EntrySource::Card {
                card_sha256,
                provenance,
            } => {
                if !self.grants.borrow().contains(card_sha256) {
                    return Err(ApiError::Rejected {
                        code: None,
                        status: 403,
                        message: "card unavailable".into(),
                    });
                }
                let kind = provenance
                    .as_ref()
                    .map(|value| value.source_kind.clone())
                    .unwrap_or_else(|| "local".into());
                Ok((card_sha256.clone(), kind, None, None))
            }
            EntrySource::Marketplace { skill_id } => {
                let card = self
                    .sources
                    .borrow()
                    .get(skill_id)
                    .cloned()
                    .ok_or_else(forbidden)?;
                Ok((card, "marketplace".into(), Some(skill_id.clone()), None))
            }
            EntrySource::Team { skill_id, .. } => {
                let card = self
                    .sources
                    .borrow()
                    .get(skill_id)
                    .cloned()
                    .ok_or_else(forbidden)?;
                Ok((card, "team".into(), Some(skill_id.clone()), None))
            }
            EntrySource::Authored { skill_id } => {
                let card = self
                    .sources
                    .borrow()
                    .get(skill_id)
                    .cloned()
                    .ok_or_else(forbidden)?;
                Ok((card, "local".into(), None, Some(skill_id.clone())))
            }
        }
    }

    fn fire(&self, id: &str) {
        let hook = self.after_write.borrow_mut().take();
        if let Some(mut hook) = hook {
            hook(id);
            *self.after_write.borrow_mut() = Some(hook);
        }
    }
}

impl LibraryApi for FakeServer {
    async fn catalog_install(&self) -> Result<bool, ApiError> {
        Ok(self.catalog_enabled.get())
    }
    async fn formal_card(
        &self,
        _skill_id: &str,
        version_id: &str,
    ) -> Result<Option<RemoteCard>, ApiError> {
        self.formal_lookups.set(self.formal_lookups.get() + 1);
        if self.deny_formal_lookup.get() {
            return Err(ApiError::Rejected {
                code: None,
                status: 403,
                message: "private source history".into(),
            });
        }
        Ok(self.formal_cards.borrow().get(version_id).and_then(|sha| {
            self.cards
                .borrow()
                .get(sha)
                .map(|stored| stored.card.clone())
        }))
    }
    async fn capabilities(&self) -> Result<Vec<String>, ApiError> {
        let mut capabilities = vec![LIBRARY_SYNC_CAPABILITY.into()];
        if self.version_policy_enabled.get() {
            capabilities.push(crate::version_policy::CAPABILITY.into());
        }
        if !self.source_url_unsupported.get() {
            capabilities.push(super::profile::SOURCE_URL_CAPABILITY.into());
        }
        Ok(capabilities)
    }

    async fn receipts(&self, id: &str) -> Result<Option<super::api::ReceiptHistory>, ApiError> {
        self.receipt_reads.set(self.receipt_reads.get() + 1);
        if !self.version_policy_enabled.get() {
            return Ok(None);
        }
        let entry = self.entry(id);
        Ok(Some(super::api::ReceiptHistory {
            entry_id: id.into(),
            entry_revision: entry.revision,
            version_policy: 1,
            version_high_water: entry.version_state.version_high_water.unwrap_or(-1),
            version_mapping_digest: entry.version_state.version_mapping_digest.clone(),
            receipts: self.receipts.borrow().get(id).cloned().unwrap_or_default(),
        }))
    }

    async fn list(&self) -> Result<Vec<RemoteEntry>, ApiError> {
        self.list_calls.set(self.list_calls.get() + 1);
        let mut fault = self.fail_list_once_at.borrow_mut();
        if fault
            .as_ref()
            .is_some_and(|(call, _)| *call == self.list_calls.get())
        {
            return Err(fault.take().unwrap().1);
        }
        drop(fault);
        let fail_from = self.fail_list_from.get();
        if fail_from > 0 && self.list_calls.get() >= fail_from {
            return Err(ApiError::Transient("无法连接 SkillHub Server".into()));
        }
        Ok(self
            .entries
            .borrow()
            .values()
            .map(|stored| stored.entry.clone())
            .collect())
    }

    async fn upload_card(&self, package: &[u8]) -> Result<RemoteCard, ApiError> {
        if let Some(hook) = self.before_upload.borrow_mut().take() {
            hook();
        }
        if self.quota_exceeded.get() {
            return Err(ApiError::Rejected {
                code: None,
                status: 413,
                message: "Skill storage quota exceeded".into(),
            });
        }
        self.uploads.set(self.uploads.get() + 1);
        let card = self.store_card(package.to_vec());
        self.grants.borrow_mut().insert(card.sha256.clone());
        Ok(card)
    }

    async fn download_card(&self, sha256: &str) -> Result<Vec<u8>, ApiError> {
        self.downloads.set(self.downloads.get() + 1);
        if self.delete_during_download.replace(false) {
            for stored in self.entries.borrow_mut().values_mut() {
                stored.entry.deleted = true;
                stored.entry.revision += 1;
            }
        }
        if self.fail_downloads.get() > 0 {
            self.fail_downloads.set(self.fail_downloads.get() - 1);
            return Err(ApiError::Transient("下载中断".into()));
        }
        if !self.grants.borrow().contains(sha256) {
            return Err(ApiError::Rejected {
                code: None,
                status: 404,
                message: "Not Found".into(),
            });
        }
        Ok(self.card_bytes(sha256))
    }

    async fn card_meta(&self, sha256: &str) -> Result<Option<RemoteCard>, ApiError> {
        if !self.grants.borrow().contains(sha256) {
            return Ok(None);
        }
        Ok(self
            .cards
            .borrow()
            .get(sha256)
            .map(|stored| stored.card.clone()))
    }

    async fn create_entry(&self, request: &CreateEntry) -> Result<RemoteEntry, ApiError> {
        if self.fail_creates.get() > 0 {
            self.fail_creates.set(self.fail_creates.get() - 1);
            return Err(ApiError::Transient("network down".into()));
        }
        let digest = serde_json::to_string(&(
            &request.name,
            &request.profile,
            &request.source,
            &request.migration_key,
        ))
        .unwrap();
        if let Some(existing) = self.entries.borrow().get(&request.id) {
            if existing.digest == digest {
                return Ok(existing.entry.clone());
            }
            return Err(ApiError::Conflict {
                code: None,
                message: "Library entry already exists with different content".into(),
                entry: Some(Box::new(existing.entry.clone())),
            });
        }
        if let Some(key) = &request.migration_key {
            if let Some(existing) = self
                .entries
                .borrow()
                .values()
                .find(|stored| stored.migration_key.as_ref() == Some(key))
            {
                return Ok(existing.entry.clone());
            }
        }
        if self.active().len() >= self.max_entries.get() {
            return Err(ApiError::Conflict {
                code: None,
                message: "Library entry limit reached".into(),
                entry: None,
            });
        }
        let (card_sha256, source_kind, source_skill_id, author_skill_id) =
            self.resolve(&request.source)?;
        self.grants.borrow_mut().insert(card_sha256.clone());
        let card = self.cards.borrow()[&card_sha256].card.clone();
        let entry = RemoteEntry {
            source_origin: matches!(request.source, EntrySource::Catalog { .. })
                .then(|| crate::catalog::origin().unwrap()),
            source_version_id: if let EntrySource::Catalog { version, .. } = &request.source {
                Some(version.clone())
            } else {
                source_skill_id
                    .as_ref()
                    .or(author_skill_id.as_ref())
                    .and_then(|id| self.source_versions.borrow().get(id).cloned())
            },
            version_state: if self.version_policy_enabled.get() {
                crate::version_policy::RemoteVersion {
                    version_policy: Some(1),
                    version_high_water: Some(-1),
                    ..Default::default()
                }
            } else {
                Default::default()
            },
            accepted_version_receipt: None,
            id: request.id.clone(),
            name: request.name.clone(),
            revision: 1,
            deleted: false,
            profile: self.received_profile(
                &request.profile,
                request.source_url_synced,
                false,
                self.inherited_source_url.borrow().clone(),
            ),
            source_kind,
            source_skill_id,
            author_skill_id,
            migration_key: request.migration_key.clone(),
            card: Some(card),
        };
        self.entries.borrow_mut().insert(
            request.id.clone(),
            StoredEntry {
                entry: entry.clone(),
                digest,
                migration_key: request.migration_key.clone(),
            },
        );
        self.fire(&request.id);
        Ok(entry)
    }

    async fn update_entry(&self, id: &str, request: &UpdateEntry) -> Result<RemoteEntry, ApiError> {
        let racing = self.before_update.borrow_mut().take();
        if let Some(mut racing) = racing {
            racing(id);
        }
        let rename = self.rename_before_update.borrow_mut().take();
        if let Some(display_name) = rename {
            let mut profile = self.entry(id).profile;
            profile.display_name = display_name;
            self.remote_edit(id, None, Some(profile));
        }
        let current = self
            .entries
            .borrow()
            .get(id)
            .map(|stored| stored.entry.clone());
        let Some(current) = current else {
            return Err(ApiError::Rejected {
                code: None,
                status: 404,
                message: "Library entry not found".into(),
            });
        };
        if let Some(crate::version_policy::VersionIntent::Save { request_id, .. }) =
            &request.version_intent
        {
            if let Some(receipt) = self
                .receipts
                .borrow()
                .get(id)
                .and_then(|receipts| receipts.iter().find(|r| &r.receipt_id == request_id))
                .cloned()
            {
                let mut retried = current;
                retried.accepted_version_receipt = Some(receipt);
                return Ok(retried);
            }
        }
        if current.revision != request.base_revision {
            return Err(ApiError::Conflict {
                code: None,
                message: "Library entry revision conflict".into(),
                entry: Some(Box::new(current)),
            });
        }
        let source = match &request.source {
            Some(source) => Some(self.resolve(source)?),
            None => None,
        };
        let updated = {
            let mut entries = self.entries.borrow_mut();
            // Match the real transaction: a rejected version intent cannot
            // partially change the entry's content or profile.
            let mut stored = entries.get(id).unwrap().clone();
            if let Some((card_sha256, kind, source_skill_id, author_skill_id)) = source {
                stored.entry.card = Some(self.cards.borrow()[&card_sha256].card.clone());
                if matches!(
                    &request.source,
                    Some(
                        EntrySource::Team { .. }
                            | EntrySource::Catalog { .. }
                            | EntrySource::Marketplace { .. }
                            | EntrySource::Authored { .. }
                    )
                ) {
                    stored.entry.source_version_id = source_skill_id
                        .as_ref()
                        .or(author_skill_id.as_ref())
                        .and_then(|id| self.source_versions.borrow().get(id).cloned());
                    if let Some(EntrySource::Catalog { version, .. }) = &request.source {
                        stored.entry.source_version_id = Some(version.clone());
                    }
                    stored.entry.source_kind = kind;
                    stored.entry.source_skill_id = source_skill_id;
                    stored.entry.author_skill_id = author_skill_id;
                }
            }
            if let Some(profile) = &request.profile {
                stored.entry.profile = self.received_profile(
                    profile,
                    request.source_url_synced,
                    request.clear_source_url,
                    stored.entry.profile.source_url.clone(),
                );
            }
            if let Some(intent) = &request.version_intent {
                assert!(
                    self.version_policy_enabled.get(),
                    "old strict server must never receive unknown versionIntent"
                );
                let card = stored.entry.card.as_ref().unwrap();
                let receipt = match intent {
                    crate::version_policy::VersionIntent::Save {
                        request_id,
                        card_sha256,
                        allocation,
                        label,
                    } => {
                        assert_eq!(card_sha256, &card.sha256);
                        if let Some(receipt) = stored
                            .entry
                            .version_state
                            .version
                            .as_ref()
                            .filter(|r| r.card_sha256 == card.sha256)
                        {
                            receipt.clone()
                        } else {
                            let high = stored.entry.version_state.version_high_water.unwrap_or(-1);
                            let candidate = crate::version_policy::ordinal(label).unwrap();
                            if allocation == "manual" && candidate <= high {
                                return Err(ApiError::Conflict {
                                    code: Some("VERSION_LABEL_CONFLICT".into()),
                                    message: "manual label occupied".into(),
                                    entry: Some(Box::new(current)),
                                });
                            }
                            let canonical = if allocation == "auto" {
                                crate::version_policy::label(candidate.max(high + 1)).unwrap()
                            } else {
                                label.clone()
                            };
                            let receipt = crate::version_policy::VersionReceipt {
                                receipt_id: request_id.clone(),
                                label: canonical,
                                card_sha256: card.sha256.clone(),
                                formal_version_id: None,
                                formal_label: None,
                            };
                            self.receipts
                                .borrow_mut()
                                .entry(id.into())
                                .or_default()
                                .push(receipt.clone());
                            receipt
                        }
                    }
                    crate::version_policy::VersionIntent::Select { receipt_id } => {
                        self.receipts.borrow()[id]
                            .iter()
                            .find(|r| &r.receipt_id == receipt_id)
                            .unwrap()
                            .clone()
                    }
                    crate::version_policy::VersionIntent::Formal { version_id } => {
                        if self.formal_cards.borrow().get(version_id) != Some(&card.sha256) {
                            return Err(ApiError::Rejected {
                                code: None,
                                status: 403,
                                message: "formal content differs".into(),
                            });
                        }
                        let receipt = crate::version_policy::VersionReceipt {
                            receipt_id: uuid::Uuid::new_v4().to_string(),
                            label: crate::version_policy::allocate(
                                stored.entry.version_state.version_high_water.unwrap_or(-1),
                                None,
                            )
                            .unwrap(),
                            card_sha256: card.sha256.clone(),
                            formal_version_id: Some(version_id.clone()),
                            formal_label: Some("0.1.0".into()),
                        };
                        self.receipts
                            .borrow_mut()
                            .entry(id.into())
                            .or_default()
                            .push(receipt.clone());
                        receipt
                    }
                };
                stored.entry.version_state.version_high_water = Some(
                    stored
                        .entry
                        .version_state
                        .version_high_water
                        .unwrap_or(-1)
                        .max(crate::version_policy::ordinal(&receipt.label).unwrap()),
                );
                stored.entry.version_state.version = Some(receipt.clone());
                stored.entry.accepted_version_receipt = Some(receipt);
            } else if self.version_policy_enabled.get()
                && stored
                    .entry
                    .version_state
                    .version
                    .as_ref()
                    .is_some_and(|r| {
                        stored
                            .entry
                            .card
                            .as_ref()
                            .is_some_and(|c| c.sha256 != r.card_sha256)
                    })
            {
                stored.entry.version_state.version = None;
            }
            stored.entry.revision += 1;
            let updated = stored.entry.clone();
            entries.insert(id.into(), stored);
            updated
        };
        self.fire(id);
        if request.version_intent.is_some() && self.lose_save_reply.replace(false) {
            return Err(ApiError::Transient("save committed; response lost".into()));
        }
        Ok(updated)
    }

    async fn delete_entry(
        &self,
        id: &str,
        _base_revision: u64,
        _device: &str,
    ) -> Result<RemoteEntry, ApiError> {
        let conflict = || ApiError::Conflict {
            code: None,
            message: "baseRevision 已过期".into(),
            entry: None,
        };
        match self.delete_fault.take() {
            Some(DeleteFault::CommitThenLoseReply) => {
                self.remote_delete(id);
                return Err(ApiError::Transient("读取 SkillHub Server 响应失败".into()));
            }
            Some(DeleteFault::FailWithoutCommit) => {
                return Err(ApiError::Transient("无法连接 SkillHub Server".into()));
            }
            Some(DeleteFault::Reject) => {
                return Err(ApiError::Rejected {
                    code: None,
                    status: 403,
                    message: "Forbidden".into(),
                });
            }
            Some(DeleteFault::OtherDeviceDeletesThenConflict) => {
                self.remote_delete(id);
                return Err(conflict());
            }
            Some(DeleteFault::OtherDeviceEditsThenConflict) => {
                self.entries
                    .borrow_mut()
                    .get_mut(id)
                    .unwrap()
                    .entry
                    .revision += 1;
                return Err(conflict());
            }
            None => {}
        }
        self.remote_delete(id);
        Ok(self.entry(id))
    }

    async fn restore_entry(
        &self,
        id: &str,
        _base_revision: u64,
        _device: &str,
    ) -> Result<RemoteEntry, ApiError> {
        let mut entries = self.entries.borrow_mut();
        let stored = entries.get_mut(id).unwrap();
        stored.entry.deleted = false;
        stored.entry.revision += 1;
        Ok(stored.entry.clone())
    }

    async fn author_asset(&self, _id: &str) -> Result<AuthorAsset, ApiError> {
        Err(ApiError::Rejected {
            code: None,
            status: 400,
            message: "unused".into(),
        })
    }

    async fn own_skills(&self) -> Result<Vec<OwnSkill>, ApiError> {
        if let Some(hook) = self.on_own_skills.borrow_mut().take() {
            hook();
        }
        Ok(self.own_skills.borrow().clone())
    }
}

// ── Fake account and local environment ──────────────────────────────────────

struct FakeGuard {
    space_id: String,
    user_id: String,
    holds: Cell<usize>,
    /// The account "switches" once this many writes were allowed.
    switch_after: Cell<Option<usize>>,
}

impl AccountGuard for FakeGuard {
    fn space_id(&self) -> &str {
        &self.space_id
    }
    fn user_id(&self) -> &str {
        &self.user_id
    }

    fn hold(&self) -> Result<Held, SyncError> {
        if self
            .switch_after
            .get()
            .is_some_and(|limit| self.holds.get() >= limit)
        {
            return Err(SyncError::AccountChanged);
        }
        self.holds.set(self.holds.get() + 1);
        Ok(Held::new(None))
    }
}

type LandHook = Box<dyn FnMut(&str, &Path)>;

struct Device {
    ui_events: RefCell<Vec<String>>,
    home: PathBuf,
    paths: SyncPaths,
    guard: FakeGuard,
    /// Runs right before a landing with the Skill id and its directory.
    before_land: RefCell<Option<LandHook>>,
    /// "Crash": after this Skill lands, every later account check fails.
    crash_after_landing: RefCell<Option<String>>,
}

impl LocalOps for Device {
    fn listed(&self, _entries: &[RemoteEntry], _index: &SyncIndex) {
        self.ui_events.borrow_mut().push("list".into());
    }
    fn progress(
        &self,
        entry: &RemoteEntry,
        _received: u64,
        _total: Option<u64>,
        phase: &str,
        _error: Option<&str>,
    ) {
        if phase == "ready" {
            assert!(self
                .skill_ids()
                .iter()
                .any(|id| library_read_profile(&self.skill(id))
                    .unwrap()
                    .library_entry_id
                    .as_deref()
                    == Some(&entry.id)));
        }
        self.ui_events.borrow_mut().push(phase.into());
    }
    fn land(&self, landing: LibraryLanding<'_>) -> Result<(), LibraryLandingError> {
        let skill_id = landing.skill_id.to_string();
        if let Some(hook) = self.before_land.borrow_mut().as_mut() {
            hook(&skill_id, &self.paths.managed_root.join(&skill_id));
        }
        let landed = land_library_package_at(
            &self.home,
            &self.paths.skillhub_root,
            &self.paths.managed_root,
            landing,
        );
        if landed.is_ok() && self.crash_after_landing.borrow().as_deref() == Some(skill_id.as_str())
        {
            self.guard.switch_after.set(Some(self.guard.holds.get()));
        }
        landed
    }

    fn trash(&self, skill_id: &str) -> Result<(), String> {
        let trash = self.home.join("test-trash");
        fs::create_dir_all(&trash).map_err(|error| error.to_string())?;
        fs::rename(
            self.paths.managed_root.join(skill_id),
            trash.join(format!("{skill_id}-{}", uuid::Uuid::new_v4())),
        )
        .map_err(|error| error.to_string())
    }
}

impl Device {
    fn new(user_id: &str) -> Self {
        let home = std::env::temp_dir().join(format!("skillhub-sync-{}", uuid::Uuid::new_v4()));
        let skillhub_root = home.join(".skillhub");
        let managed_root = skillhub_root.join("skills");
        fs::create_dir_all(&managed_root).unwrap();
        Self {
            ui_events: RefCell::new(Vec::new()),
            home,
            paths: SyncPaths {
                skillhub_root,
                managed_root,
            },
            guard: FakeGuard {
                space_id: "official".into(),
                user_id: user_id.into(),
                holds: Cell::new(0),
                switch_after: Cell::new(None),
            },
            before_land: RefCell::new(None),
            crash_after_landing: RefCell::new(None),
        }
    }

    fn sync_with(
        &self,
        server: &FakeServer,
        options: SyncOptions,
    ) -> Result<SyncReport, SyncError> {
        let engine = Engine::new(server, &self.guard, self, &self.paths, options);
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(engine.run())
    }

    fn sync(&self, server: &FakeServer) -> SyncReport {
        self.sync_with(server, SyncOptions::default())
            .expect("sync pass")
    }

    fn skill(&self, skill_id: &str) -> PathBuf {
        self.paths.managed_root.join(skill_id)
    }

    fn create_skill(&self, skill_id: &str, body: &str, sidecar: SkillHubProfile) {
        let root = self.skill(skill_id);
        fs::create_dir_all(root.join("scripts")).unwrap();
        fs::write(root.join("SKILL.md"), body).unwrap();
        fs::write(root.join("scripts/run.sh"), "echo ok\n").unwrap();
        let sidecar = SkillHubProfile {
            id: sidecar
                .id
                .or_else(|| Some(uuid::Uuid::new_v4().to_string())),
            // Added while this device's account is signed in, like an
            // import or install in the APP; see `create_guest_skill`.
            added_by_account_id: sidecar
                .added_by_account_id
                .clone()
                .or_else(|| Some(self.guard.user_id.clone())),
            name: Some(skill_id.into()),
            display_name: sidecar
                .display_name
                .clone()
                .or_else(|| Some(skill_id.to_string())),
            ..sidecar
        };
        library_write_profile(&root, &sidecar).unwrap();
        library_snapshot_at(&root, "init").unwrap();
    }

    /// A Skill that appeared without a signed-in import (signed out, an
    /// older version, or copied into the folder): no account stamp.
    fn create_guest_skill(&self, skill_id: &str, body: &str, sidecar: SkillHubProfile) {
        self.create_skill(skill_id, body, sidecar);
        self.edit_sidecar(skill_id, |sidecar| sidecar.added_by_account_id = None);
    }

    fn write(&self, skill_id: &str, relative: &str, contents: &str) {
        fs::write(self.skill(skill_id).join(relative), contents).unwrap();
    }

    fn read(&self, skill_id: &str, relative: &str) -> String {
        fs::read_to_string(self.skill(skill_id).join(relative)).unwrap()
    }

    fn sidecar(&self, skill_id: &str) -> SkillHubProfile {
        library_read_profile(&self.skill(skill_id)).unwrap()
    }

    fn edit_sidecar(&self, skill_id: &str, update: impl FnOnce(&mut SkillHubProfile)) {
        let mut sidecar = self.sidecar(skill_id);
        update(&mut sidecar);
        library_write_profile(&self.skill(skill_id), &sidecar).unwrap();
    }

    fn index(&self) -> SyncIndex {
        let root = if self.guard.space_id == "official" {
            self.paths.skillhub_root.clone()
        } else {
            self.paths
                .skillhub_root
                .join("spaces")
                .join(&self.guard.space_id)
        };
        load_index(&root, &self.guard.user_id).unwrap()
    }

    fn complete_migration(&self) {
        let mut index = self.index();
        index.migration.completed = true;
        save_index(&self.paths.skillhub_root, &index).unwrap();
    }

    fn entry_id(&self, skill_id: &str) -> String {
        self.sidecar(skill_id)
            .library_entry_id
            .expect("bound entry")
    }

    fn skill_ids(&self) -> Vec<String> {
        let mut names = fs::read_dir(&self.paths.managed_root)
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
            .filter(|name| !name.starts_with('.'))
            .collect::<Vec<_>>();
        names.sort();
        names
    }
}

impl Device {
    /// The same computer (same home and folders) signed in as another account.
    fn signed_in_as(&self, user_id: &str) -> Device {
        Device {
            ui_events: RefCell::new(Vec::new()),
            home: self.home.clone(),
            paths: self.paths.clone(),
            guard: FakeGuard {
                space_id: "official".into(),
                user_id: user_id.into(),
                holds: Cell::new(0),
                switch_after: Cell::new(None),
            },
            before_land: RefCell::new(None),
            crash_after_landing: RefCell::new(None),
        }
    }

    /// Rewrites this account's index as the version 1 format.
    fn make_legacy(&self, update: impl FnOnce(&mut SyncIndex)) {
        let mut index = self.index();
        index.version = LEGACY_INDEX_VERSION;
        update(&mut index);
        save_index(&self.paths.skillhub_root, &index).unwrap();
    }

    fn write_legacy_marker(&self, entry_id: &str) {
        let markers = local_only_dir(&self.paths.skillhub_root, &self.guard.user_id).unwrap();
        fs::create_dir_all(&markers).unwrap();
        fs::write(markers.join(entry_id), b"").unwrap();
    }

    /// entry id -> SKILL.md of every bound folder.
    fn library(&self) -> BTreeMap<String, String> {
        self.skill_ids()
            .into_iter()
            .filter_map(|skill_id| {
                let sidecar = self.sidecar(&skill_id);
                if sidecar.library_account_id.as_deref() != Some(self.guard.user_id.as_str()) {
                    return None;
                }
                Some((sidecar.library_entry_id?, self.read(&skill_id, "SKILL.md")))
            })
            .collect()
    }

    fn backups(&self) -> Vec<PathBuf> {
        fs::read_dir(backups_dir(&self.paths.skillhub_root, &self.guard.user_id).unwrap())
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn user() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn ready_device(user_id: &str) -> Device {
    let device = Device::new(user_id);
    device.complete_migration();
    device
}

/// A second device of the same account that already downloaded everything.
fn second_device(user_id: &str, server: &FakeServer) -> Device {
    let device = ready_device(user_id);
    device.sync(server);
    device
}

// ── Basic directions ────────────────────────────────────────────────────────

#[test]
fn uploads_a_new_local_skill_once_and_downloads_it_on_another_device() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());

    let report = mac.sync(&server);
    assert_eq!((report.uploaded, report.bound), (1, 1));
    let entry_id = mac.entry_id("demo");
    assert_eq!(
        mac.sidecar("demo").library_account_id.as_deref(),
        Some(account.as_str())
    );
    assert_eq!(
        mac.sidecar("demo").id.as_deref(),
        Some(entry_id.as_str()),
        "sidecar id reused as entry id"
    );

    let again = mac.sync(&server);
    assert_eq!(
        (again.uploaded, again.downloaded, again.bound),
        (0, 0, 0),
        "no upload loop"
    );

    let windows = second_device(&account, &server);
    assert_eq!(windows.skill_ids(), vec!["demo".to_string()]);
    assert_eq!(windows.read("demo", "SKILL.md"), "# Demo\n");
    assert_eq!(windows.entry_id("demo"), entry_id);
    let report = windows.sync(&server);
    assert_eq!((report.uploaded, report.downloaded), (0, 0));
}

#[test]
fn store_download_uses_package_name_without_changing_folder_or_existing_identity() {
    for kind in ["catalog", "marketplace"] {
        for (body, name) in [
            (
                "---\nname: painted-animation\n---\n# Skill\n",
                "painted-animation",
            ),
            ("# No name\n", "painted-animation--device-id"),
            (
                "---\nname: ../invalid\n---\n",
                "painted-animation--device-id",
            ),
        ] {
            let server = FakeServer::new();
            let account = user();
            let mac = ready_device(&account);
            let folder = "painted-animation--device-id";
            mac.create_skill(folder, body, SkillHubProfile::default());
            mac.sync(&server);
            let entry_id = mac.entry_id(folder);
            {
                let mut entries = server.entries.borrow_mut();
                let entry = &mut entries.get_mut(&entry_id).unwrap().entry;
                entry.source_kind = kind.into();
                entry.source_skill_id = Some(user());
            }
            let second = ready_device(&account);
            assert_eq!(second.sync(&server).downloaded, 1);
            let before = second.sidecar(folder);
            assert_eq!(before.name.as_deref(), Some(name));
            assert_eq!(before.library_entry_id.as_deref(), Some(entry_id.as_str()));
            second.edit_sidecar(folder, |sidecar| sidecar.name = Some("kept-name".into()));
            second.sync(&server);
            let after = second.sidecar(folder);
            assert_eq!(after.name.as_deref(), Some("kept-name"));
            assert_eq!(after.id, before.id);
            assert_eq!(after.server_id, before.server_id);
            assert_eq!(second.skill_ids(), [folder]);
        }
    }
}

#[test]
fn profile_only_changes_sync_without_uploading_content() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let uploads = server.uploads.get();

    mac.edit_sidecar("demo", |sidecar| {
        sidecar.display_name = Some("新名字".into())
    });
    let report = mac.sync(&server);
    assert_eq!(
        server.uploads.get(),
        uploads,
        "display name change must not upload files"
    );
    assert_eq!(report.uploaded, 0);
    assert_eq!(
        server.entry(&mac.entry_id("demo")).profile.display_name,
        "新名字"
    );

    let windows = second_device(&account, &server);
    assert_eq!(
        windows.sidecar("demo").display_name.as_deref(),
        Some("新名字")
    );
}

#[test]
fn source_url_is_set_and_cleared_across_devices() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let entry_id = mac.entry_id("demo");
    assert_eq!(server.entry(&entry_id).profile.source_url, None);

    mac.edit_sidecar("demo", |sidecar| {
        sidecar.source_url = Some("https://github.com/acme/demo".into())
    });
    mac.sync(&server);
    assert_eq!(
        server.entry(&entry_id).profile.source_url.as_deref(),
        Some("https://github.com/acme/demo")
    );
    let windows = second_device(&account, &server);
    assert_eq!(
        windows.sidecar("demo").source_url.as_deref(),
        Some("https://github.com/acme/demo")
    );

    // Clearing on one device clears the account value and the other device.
    windows.edit_sidecar("demo", |sidecar| sidecar.source_url = None);
    windows.sync(&server);
    assert_eq!(server.entry(&entry_id).profile.source_url, None);
    mac.sync(&server);
    assert_eq!(mac.sidecar("demo").source_url, None);
    let report = mac.sync(&server);
    assert_eq!((report.uploaded, report.profiles_updated), (0, 0));
}

#[test]
fn creating_an_entry_omits_an_absent_source_so_the_server_value_is_inherited() {
    let server = FakeServer::new();
    *server.inherited_source_url.borrow_mut() = Some("https://clawhub.ai/acme/demo".into());
    let account = user();
    let mac = ready_device(&account);
    // A sidecar written before #330 has no source at all.
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let entry_id = mac.entry_id("demo");
    assert_eq!(
        server.entry(&entry_id).profile.source_url.as_deref(),
        Some("https://clawhub.ai/acme/demo"),
        "create must not send an explicit null"
    );
    mac.sync(&server);
    assert_eq!(
        mac.sidecar("demo").source_url.as_deref(),
        Some("https://clawhub.ai/acme/demo")
    );
    let windows = second_device(&account, &server);
    assert_eq!(
        windows.sidecar("demo").source_url.as_deref(),
        Some("https://clawhub.ai/acme/demo")
    );
}

#[test]
fn a_profile_edit_without_a_source_keeps_the_account_source() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let entry_id = mac.entry_id("demo");
    // The account gains a source the device has not pulled yet; a local
    // rename in the same pass must not erase it.
    let mut profile = server.entry(&entry_id).profile;
    profile.source_url = Some("https://x.com/acme".into());
    server.remote_edit(&entry_id, None, Some(profile));
    mac.edit_sidecar("demo", |sidecar| {
        sidecar.display_name = Some("新名字".into())
    });
    mac.sync(&server);
    let remote = server.entry(&entry_id).profile;
    assert_eq!(remote.display_name, "新名字");
    assert_eq!(remote.source_url.as_deref(), Some("https://x.com/acme"));
    assert_eq!(
        mac.sidecar("demo").source_url.as_deref(),
        Some("https://x.com/acme")
    );
}

#[test]
fn binding_an_old_sidecar_to_an_entry_with_a_source_pulls_it_without_a_copy() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let entry_id = mac.entry_id("demo");
    let mut profile = server.entry(&entry_id).profile;
    profile.source_url = Some("https://skills.sh/acme/demo".into());
    server.remote_edit(&entry_id, None, Some(profile));
    // A second device whose identical folder predates the field binds to it.
    let windows = ready_device(&account);
    let sidecar = mac.sidecar("demo");
    windows.create_skill(
        "demo",
        "# Demo\n",
        SkillHubProfile {
            library_account_id: sidecar.library_account_id.clone(),
            library_entry_id: sidecar.library_entry_id.clone(),
            id: sidecar.id.clone(),
            source_url: None,
            ..SkillHubProfile::default()
        },
    );
    let report = windows.sync(&server);
    assert_eq!(report.copies_created, 0, "{:?}", report.problems);
    assert_eq!(
        windows.sidecar("demo").source_url.as_deref(),
        Some("https://skills.sh/acme/demo")
    );
    assert_eq!(
        server.entry(&entry_id).profile.source_url.as_deref(),
        Some("https://skills.sh/acme/demo")
    );
}

#[test]
fn a_source_cleared_before_the_first_pull_is_not_resurrected() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let entry_id = mac.entry_id("demo");
    let mut profile = server.entry(&entry_id).profile;
    profile.source_url = Some("https://x.com/acme".into());
    server.remote_edit(&entry_id, None, Some(profile));
    // The user clears the source (e.g. the one shown from the Server) before
    // this device ever pulled it: base and local are both None.
    mac.edit_sidecar("demo", |sidecar| {
        sidecar.source_url = None;
        sidecar.source_url_cleared = Some("https://x.com/acme".into());
    });
    mac.sync(&server);
    assert_eq!(server.entry(&entry_id).profile.source_url, None);
    let sidecar = mac.sidecar("demo");
    assert_eq!(sidecar.source_url, None);
    assert!(
        sidecar.source_url_cleared.is_none(),
        "tombstone is dropped once synced"
    );

    // Afterwards a new source from another device applies normally.
    let mut profile = server.entry(&entry_id).profile;
    profile.source_url = Some("https://github.com/acme/demo".into());
    server.remote_edit(&entry_id, None, Some(profile));
    mac.sync(&server);
    assert_eq!(
        mac.sidecar("demo").source_url.as_deref(),
        Some("https://github.com/acme/demo")
    );
}

/// A device that cleared `cleared` before ever pulling a source.
fn cleared_offline(server: &FakeServer, cleared: &str) -> (Device, String) {
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(server);
    let entry_id = mac.entry_id("demo");
    mac.edit_sidecar("demo", |sidecar| {
        sidecar.source_url = None;
        sidecar.source_url_cleared = Some(cleared.into());
    });
    (mac, entry_id)
}

/// The account source of the entry becomes `remote` (another device's sync).
fn set_remote_source(server: &FakeServer, entry_id: &str, remote: &str) {
    let mut profile = server.entry(entry_id).profile;
    profile.source_url = Some(remote.into());
    server.remote_edit(entry_id, None, Some(profile));
}

#[test]
fn a_newer_source_from_another_device_beats_an_offline_clear() {
    let server = FakeServer::new();
    // Device A cleared X offline; meanwhile device B set Y and synced.
    let (mac, entry_id) = cleared_offline(&server, "https://x.com/acme");
    set_remote_source(&server, &entry_id, "https://github.com/acme/y");
    let report = mac.sync(&server);
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    assert_eq!(report.copies_created, 0);
    assert_eq!(
        server.entry(&entry_id).profile.source_url.as_deref(),
        Some("https://github.com/acme/y"),
        "the stale clear must not wipe the newer source"
    );
    let sidecar = mac.sidecar("demo");
    assert_eq!(
        sidecar.source_url.as_deref(),
        Some("https://github.com/acme/y")
    );
    assert_eq!(sidecar.source_url_cleared, None);
}

#[test]
fn an_offline_clear_waits_for_a_source_capable_server_and_wins_only_against_the_same_url() {
    for (remote, expected) in [
        ("https://x.com/acme", None),
        ("https://skills.sh/acme/y", Some("https://skills.sh/acme/y")),
    ] {
        let server = FakeServer::new();
        server.source_url_unsupported.set(true);
        let (mac, entry_id) = cleared_offline(&server, "https://x.com/acme");
        // An old server cannot carry the clear: the tombstone is kept.
        mac.sync(&server);
        assert_eq!(
            mac.sidecar("demo").source_url_cleared.as_deref(),
            Some("https://x.com/acme")
        );
        // After the server upgrade it is consumed: the clear wins only when
        // the account still holds the cleared URL.
        server.source_url_unsupported.set(false);
        set_remote_source(&server, &entry_id, remote);
        let report = mac.sync(&server);
        assert!(report.problems.is_empty(), "{:?}", report.problems);
        assert_eq!(
            server.entry(&entry_id).profile.source_url.as_deref(),
            expected,
            "{remote}"
        );
        let sidecar = mac.sidecar("demo");
        assert_eq!(sidecar.source_url.as_deref(), expected, "{remote}");
        assert_eq!(sidecar.source_url_cleared, None, "{remote}");
    }
}

#[test]
fn old_server_keeps_the_local_source_without_sending_it() {
    let server = FakeServer::new();
    server.source_url_unsupported.set(true);
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill(
        "demo",
        "# Demo\n",
        SkillHubProfile {
            source_url: Some("https://skills.sh/acme/demo".into()),
            ..SkillHubProfile::default()
        },
    );
    let report = mac.sync(&server);
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    let entry_id = mac.entry_id("demo");
    assert_eq!(server.entry(&entry_id).profile.source_url, None);

    // A remote profile edit lands without clearing the local-only source.
    let mut profile = server.entry(&entry_id).profile;
    profile.display_name = "Renamed".into();
    server.remote_edit(&entry_id, None, Some(profile));
    let report = mac.sync(&server);
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    let sidecar = mac.sidecar("demo");
    assert_eq!(sidecar.display_name.as_deref(), Some("Renamed"));
    assert_eq!(
        sidecar.source_url.as_deref(),
        Some("https://skills.sh/acme/demo")
    );
    let again = mac.sync(&server);
    assert_eq!((again.uploaded, again.profiles_updated), (0, 0));
    assert!(again.problems.is_empty());
}

#[cfg(unix)]
#[test]
fn executable_bit_alone_is_synced() {
    use std::os::unix::fs::PermissionsExt as _;
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);

    fs::set_permissions(
        mac.skill("demo").join("scripts/run.sh"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    library_snapshot_at(&mac.skill("demo"), "chmod").unwrap();
    assert_eq!(mac.sync(&server).uploaded, 1);
    let card = server.entry(&mac.entry_id("demo")).card.unwrap();
    assert_eq!(card.executable_paths, vec!["scripts/run.sh".to_string()]);

    windows.sync(&server);
    let mode = fs::metadata(windows.skill("demo").join("scripts/run.sh"))
        .unwrap()
        .permissions()
        .mode();
    assert_ne!(
        mode & 0o111,
        0,
        "the other device restores the executable bit"
    );
}

#[test]
fn remote_content_change_is_downloaded_when_local_is_unchanged() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);

    windows.write("demo", "SKILL.md", "# Demo v2\n");
    assert_eq!(windows.sync(&server).uploaded, 1);
    let report = mac.sync(&server);
    assert_eq!(report.downloaded, 1);
    assert_eq!(mac.read("demo", "SKILL.md"), "# Demo v2\n");
    assert_eq!(mac.sync(&server), SyncReport::default(), "converged");
    assert_eq!(
        mac.skill_ids(),
        vec!["demo".to_string()],
        "no copy for one-sided edits"
    );
}

#[test]
fn different_profile_fields_are_merged_and_same_field_creates_a_copy() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);
    let entry_id = mac.entry_id("demo");

    windows.edit_sidecar("demo", |sidecar| sidecar.labels = vec!["windows".into()]);
    windows.sync(&server);
    mac.edit_sidecar("demo", |sidecar| sidecar.category = Some("Mac".into()));
    mac.sync(&server);
    let merged = server.entry(&entry_id).profile;
    assert_eq!(merged.labels, vec!["windows".to_string()]);
    assert_eq!(merged.category.as_deref(), Some("Mac"));
    assert_eq!(mac.sidecar("demo").labels, vec!["windows".to_string()]);
    assert_eq!(mac.skill_ids(), vec!["demo".to_string()]);

    windows.sync(&server);
    windows.edit_sidecar("demo", |sidecar| sidecar.display_name = Some("W".into()));
    windows.sync(&server);
    mac.edit_sidecar("demo", |sidecar| sidecar.display_name = Some("M".into()));
    let report = mac.sync(&server);
    assert_eq!(report.copies_created, 1);
    assert_eq!(
        mac.sidecar("demo").display_name.as_deref(),
        Some("W"),
        "original takes the account version"
    );
    let copy = mac
        .skill_ids()
        .into_iter()
        .find(|id| id != "demo")
        .expect("copy directory");
    assert_eq!(
        mac.sidecar(&copy).display_name.as_deref(),
        Some("M（副本）")
    );
    assert_eq!(server.active().len(), 2);
}

// ── Conflict copies ─────────────────────────────────────────────────────────

#[test]
fn concurrent_content_edits_keep_both_versions() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);

    windows.write("demo", "SKILL.md", "# From Windows\n");
    windows.sync(&server);
    mac.write("demo", "SKILL.md", "# From Mac\n");
    let report = mac.sync(&server);
    assert_eq!(report.copies_created, 1);
    assert_eq!(mac.read("demo", "SKILL.md"), "# From Windows\n");
    let copy = mac.skill_ids().into_iter().find(|id| id != "demo").unwrap();
    assert_eq!(mac.read(&copy, "SKILL.md"), "# From Mac\n");
    assert!(mac.index().operations.is_empty());

    windows.sync(&server);
    assert_eq!(
        windows.skill_ids().len(),
        2,
        "the copy reaches the other device"
    );
    assert_eq!(mac.sync(&server), SyncReport::default());
}

#[test]
fn copy_entry_failure_never_replaces_the_original() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);
    windows.write("demo", "SKILL.md", "# W\n");
    windows.sync(&server);

    mac.write("demo", "SKILL.md", "# M\n");
    server.max_entries.set(1);
    let report = mac.sync(&server);
    assert_eq!(report.copies_created, 0);
    assert_eq!(
        mac.read("demo", "SKILL.md"),
        "# M\n",
        "local edit kept in place"
    );
    let operation = mac
        .index()
        .operations
        .values()
        .next()
        .cloned()
        .expect("pending copy");
    assert!(operation.blocked.is_some());
    // A scheduled pass does not hammer the server while blocked.
    assert_eq!(mac.sync(&server).copies_created, 0);

    server.max_entries.set(50);
    let report = mac
        .sync_with(
            &server,
            SyncOptions {
                retry_blocked: true,
            },
        )
        .unwrap();
    assert_eq!(report.copies_created, 1);
    assert_eq!(mac.read("demo", "SKILL.md"), "# W\n");
    let copies = mac
        .skill_ids()
        .into_iter()
        .filter(|id| id != "demo")
        .collect::<Vec<_>>();
    assert_eq!(copies.len(), 1);
    assert_eq!(mac.read(&copies[0], "SKILL.md"), "# M\n");
}

#[test]
fn quota_exceeded_keeps_the_local_upload_pending() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    mac.write("demo", "SKILL.md", "# Bigger\n");
    server.quota_exceeded.set(true);
    let report = mac.sync(&server);
    assert!(report
        .problems
        .iter()
        .any(|problem| problem.message.contains("空间不足")));
    assert!(
        mac.index()
            .entries
            .values()
            .next()
            .unwrap()
            .blocked
            .is_some(),
        "not counted as synced"
    );
    server.quota_exceeded.set(false);
    assert_eq!(
        mac.sync_with(
            &server,
            SyncOptions {
                retry_blocked: true
            }
        )
        .unwrap()
        .uploaded,
        1
    );
}

#[test]
fn interrupted_copy_resumes_with_the_same_copy_entry() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);
    windows.write("demo", "SKILL.md", "# W\n");
    windows.sync(&server);
    mac.write("demo", "SKILL.md", "# M\n");

    // "Crash" right after the snapshot: creating the copy entry fails.
    server.fail_creates.set(1);
    mac.sync(&server);
    let pending = mac
        .index()
        .operations
        .values()
        .next()
        .cloned()
        .expect("operation recorded");
    assert_eq!(mac.read("demo", "SKILL.md"), "# M\n");

    let report = mac.sync(&server);
    assert_eq!(report.copies_created, 1);
    assert!(
        server.entries.borrow().contains_key(&pending.copy_entry_id),
        "same copy UUID after restart"
    );
    assert_eq!(server.active().len(), 2, "exactly one copy entry");
}

#[test]
fn edits_after_the_snapshot_are_saved_into_the_same_copy() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);
    windows.write("demo", "SKILL.md", "# W\n");
    windows.sync(&server);
    mac.write("demo", "SKILL.md", "# M1\n");

    // The user keeps editing once, right after the copy entry is created.
    let edited = Cell::new(false);
    let original = mac.skill("demo");
    let edit_once: Box<dyn FnMut(&str)> = Box::new(move |_| {
        if !edited.replace(true) {
            fs::write(original.join("SKILL.md"), "# M2\n").unwrap();
        }
    });
    *server.after_write.borrow_mut() = Some(edit_once);
    let report = mac.sync(&server);
    *server.after_write.borrow_mut() = None;

    assert_eq!(report.copies_created, 1);
    assert_eq!(mac.read("demo", "SKILL.md"), "# W\n");
    let copies = mac
        .skill_ids()
        .into_iter()
        .filter(|id| id != "demo")
        .collect::<Vec<_>>();
    assert_eq!(copies.len(), 1, "one copy despite the re-snapshot");
    assert_eq!(
        mac.read(&copies[0], "SKILL.md"),
        "# M2\n",
        "the later edit is preserved"
    );
    assert_eq!(server.active().len(), 2);
}

// ── Deletion ────────────────────────────────────────────────────────────────

#[test]
fn account_deletion_trashes_unchanged_and_saves_changed_copies() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("keep", "# Keep\n", SkillHubProfile::default());
    mac.create_skill("edited", "# Edited\n", SkillHubProfile::default());
    mac.sync(&server);
    server.remote_delete(&mac.entry_id("keep"));
    server.remote_delete(&mac.entry_id("edited"));
    mac.write("edited", "SKILL.md", "# Unsynced edit\n");

    let report = mac.sync(&server);
    assert_eq!(report.trashed, 2);
    assert_eq!(report.copies_created, 1);
    let remaining = mac.skill_ids();
    assert_eq!(remaining.len(), 1);
    assert_eq!(mac.read(&remaining[0], "SKILL.md"), "# Unsynced edit\n");
}

#[test]
fn a_folder_removed_outside_skillhub_comes_back_on_the_next_pass() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let entry_id = mac.entry_id("demo");
    fs::remove_dir_all(mac.skill("demo")).unwrap();

    let report = mac.sync(&server);
    assert_eq!(report.downloaded, 1, "no device-only exception any more");
    assert_eq!(mac.skill_ids(), vec!["demo".to_string()]);
    assert_eq!(mac.entry_id("demo"), entry_id);
    assert!(!server.entry(&entry_id).deleted, "the account is untouched");
}

#[test]
fn account_list_is_published_before_download_and_ready_only_after_landing() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("cloud-list", "# Contents\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = ready_device(&account);
    windows.sync(&server);
    let events = windows.ui_events.borrow();
    let position = |event: &str| events.iter().position(|item| item == event).unwrap();
    assert!(position("list") < position("downloading"));
    assert!(position("downloading") < position("landing"));
    assert!(position("landing") < position("ready"));
}

#[test]
fn deletion_during_placeholder_download_never_lands_a_stale_copy() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("cloud-race", "# Contents\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = ready_device(&account);
    server.delete_during_download.set(true);
    let report = windows.sync(&server);
    assert_eq!(report.downloaded, 0);
    assert!(!windows.skill("cloud-race").exists());
    assert!(!windows.ui_events.borrow().contains(&"ready".to_string()));
    assert!(load_index(&windows.paths.skillhub_root, &account)
        .unwrap()
        .entries
        .is_empty());
    windows.sync(&server);
    assert!(!windows.skill("cloud-race").exists());
}

#[test]
fn landing_revalidation_failures_keep_the_item_pending_and_continue_later_entries() {
    for fault in [
        ApiError::Transient("temporary revalidation failure".into()),
        ApiError::Rejected {
            code: None,
            status: 403,
            message: "revalidation denied".into(),
        },
        ApiError::Conflict {
            code: None,
            message: "revalidation changed".into(),
            entry: None,
        },
    ] {
        let server = FakeServer::new();
        let account = user();
        let mac = ready_device(&account);
        for name in ["first", "second"] {
            mac.create_skill(name, "# Contents\n", SkillHubProfile::default());
        }
        mac.sync(&server);
        // Remote entries are iterated by their stable IDs, not by display name.
        let entries = server.active();
        let first_name = entries[0].name.as_str();
        let second_name = entries[1].name.as_str();
        *server.fail_list_once_at.borrow_mut() = Some((server.list_calls.get() + 2, fault));
        let windows = ready_device(&account);
        let report = windows.sync(&server);
        assert_eq!(report.downloaded, 1);
        assert_eq!(report.problems.len(), 1);
        assert_eq!(
            report.problems[0].entry_id.as_deref(),
            Some(entries[0].id.as_str())
        );
        assert!(
            !windows.skill(first_name).exists(),
            "failed verification never lands"
        );
        assert!(
            windows.skill(second_name).exists(),
            "later entry still lands"
        );
        assert_eq!(
            windows.sync(&server).downloaded,
            1,
            "pending entry retries next pass"
        );
    }
}

#[test]
fn unauthorized_landing_revalidation_stops_the_sync_without_landing() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("unauthorized", "# Contents\n", SkillHubProfile::default());
    mac.sync(&server);
    *server.fail_list_once_at.borrow_mut() =
        Some((server.list_calls.get() + 2, ApiError::Unauthorized));
    let windows = ready_device(&account);
    assert_eq!(
        windows.sync_with(&server, SyncOptions::default()),
        Err(SyncError::Unauthorized)
    );
    assert!(!windows.skill("unauthorized").exists());
}

#[test]
fn account_entry_without_a_local_folder_can_be_deleted_and_never_downloads() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("placeholder", "# Contents\n", SkillHubProfile::default());
    mac.sync(&server);
    let entry_id = mac.entry_id("placeholder");
    let windows = ready_device(&account);
    assert!(!windows.skill("placeholder").exists());
    assert_eq!(
        run_async(delete_account_entry(&server, &entry_id, "windows")),
        AccountDeleteResult::Deleted
    );
    assert!(server.entry(&entry_id).deleted);
    windows.sync(&server);
    assert!(!windows.skill("placeholder").exists());
    assert!(windows.index().entries.is_empty());
}

#[test]
fn account_list_remains_visible_when_download_fails_and_no_ready_is_published() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("cloud-failure", "# Contents\n", SkillHubProfile::default());
    mac.sync(&server);
    server.fail_downloads.set(1);
    let windows = ready_device(&account);
    let report = windows.sync(&server);
    assert!(!report.problems.is_empty());
    let events = windows.ui_events.borrow();
    assert!(events.contains(&"list".to_string()));
    assert!(events.contains(&"error".to_string()));
    assert!(!events.contains(&"ready".to_string()));
}

#[test]
fn entry_list_shows_local_downloadable_and_recycled_entries_without_name_guessing() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    for name in ["alpha", "beta", "gamma"] {
        mac.create_skill(name, "# Skill\n", SkillHubProfile::default());
    }
    mac.sync(&server);
    let (alpha, beta, gamma) = (
        mac.entry_id("alpha"),
        mac.entry_id("beta"),
        mac.entry_id("gamma"),
    );
    // Not on this device yet (e.g. a download still pending).
    fs::remove_dir_all(mac.skill("beta")).unwrap();
    // "从我的账号删除" on another device.
    server
        .entries
        .borrow_mut()
        .get_mut(&gamma)
        .unwrap()
        .entry
        .deleted = true;
    // Another device's entry whose name matches a folder here that was never bound to it.
    let windows = ready_device(&account);
    windows.create_skill("delta", "# Windows\n", SkillHubProfile::default());
    windows.sync(&server);
    let delta = windows.entry_id("delta");
    mac.create_skill("delta", "# Mac\n", SkillHubProfile::default());

    let index = load_index(&mac.paths.skillhub_root, &account).unwrap();
    let remote = server
        .entries
        .borrow()
        .values()
        .map(|stored| stored.entry.clone())
        .collect::<Vec<_>>();
    let list = summarize_entries(remote, &index, |skill_id| mac.skill(skill_id).is_dir());
    let by_id = |id: &str| {
        list.iter()
            .find(|entry| entry.entry_id == id)
            .unwrap()
            .clone()
    };

    let local = by_id(&alpha);
    assert_eq!(
        (local.local_skill_id.as_deref(), local.deleted),
        (Some("alpha"), false)
    );
    let pending_here = by_id(&beta);
    assert_eq!(
        (pending_here.local_skill_id, pending_here.deleted),
        (None, false)
    );
    assert!(by_id(&gamma).deleted, "account recycle bin");
    assert_eq!(
        by_id(&delta).local_skill_id,
        None,
        "a same-named folder is never assumed to be the entry"
    );
}

fn run_async<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

#[test]
fn account_delete_survives_a_failed_local_cleanup_and_converges() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);
    let entry_id = mac.entry_id("demo");
    let root = mac.paths.skillhub_root.clone();

    // The Server accepts the delete…
    assert_eq!(
        run_async(delete_account_entry(&server, &entry_id, "mac")),
        AccountDeleteResult::Deleted
    );
    assert!(server.entry(&entry_id).deleted, "account step committed");
    let revision_after_delete = server.entry(&entry_id).revision;

    // …then moving to the recycle bin fails (disk full, folder in use).
    let failed = finish_account_delete_locally(&root, &account, &entry_id, "demo", |_| {
        Err("Resource busy".to_string())
    })
    .unwrap_err();
    assert!(failed.contains("没能移入本机回收站"), "{failed}");
    assert!(mac.skill("demo").exists(), "local copy kept");
    assert!(
        load_index(&root, &account)
            .unwrap()
            .entries
            .contains_key(&entry_id),
        "the entry stays indexed so the next pass can finish"
    );

    // A retry never deletes twice and finishes the device step.
    assert_eq!(
        run_async(delete_account_entry(&server, &entry_id, "mac")),
        AccountDeleteResult::Deleted
    );
    assert_eq!(
        server.entry(&entry_id).revision,
        revision_after_delete,
        "no second delete"
    );
    finish_account_delete_locally(&root, &account, &entry_id, "demo", |id| mac.trash(id)).unwrap();
    assert!(!mac.skill("demo").exists());
    assert!(!load_index(&root, &account)
        .unwrap()
        .entries
        .contains_key(&entry_id));

    // The other device follows the account delete.
    let report = windows.sync(&server);
    assert_eq!(report.trashed, 1);
    assert!(windows.skill_ids().is_empty());
}

#[test]
fn a_sync_pass_finishes_an_account_delete_whose_local_cleanup_failed() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let entry_id = mac.entry_id("demo");
    let root = mac.paths.skillhub_root.clone();

    assert_eq!(
        run_async(delete_account_entry(&server, &entry_id, "mac")),
        AccountDeleteResult::Deleted
    );
    finish_account_delete_locally(&root, &account, &entry_id, "demo", |_| Err("busy".into()))
        .unwrap_err();

    // Without any user action, the next pass recycles the unchanged copy
    // instead of keeping it as a stray local-only Skill.
    let report = mac.sync(&server);
    assert_eq!(report.trashed, 1);
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    assert!(mac.skill_ids().is_empty());
    assert!(!load_index(&root, &account)
        .unwrap()
        .entries
        .contains_key(&entry_id));
}

#[test]
fn an_index_write_failure_after_recycling_is_reported_and_cleared_by_the_next_pass() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let entry_id = mac.entry_id("demo");
    let root = mac.paths.skillhub_root.clone();
    let index_file = account_dir(&root, &account).unwrap().join("index.json");
    let saved_index = fs::read(&index_file).unwrap();

    assert_eq!(
        run_async(delete_account_entry(&server, &entry_id, "mac")),
        AccountDeleteResult::Deleted
    );
    let failed = finish_account_delete_locally(&root, &account, &entry_id, "demo", |id| {
        mac.trash(id)?;
        // Inject the failure: the index cannot be read back or replaced.
        fs::remove_file(&index_file).unwrap();
        fs::create_dir_all(index_file.join("blocked")).unwrap();
        Ok(())
    })
    .unwrap_err();
    assert!(failed.contains("本机同步记录未更新"), "{failed}");
    assert!(
        !mac.skill("demo").exists(),
        "the copy is already in the recycle bin"
    );

    // Once the disk recovers, the stale entry (no folder, deleted on the
    // Server) is dropped by the next pass without downloading anything.
    fs::remove_dir_all(&index_file).unwrap();
    fs::write(&index_file, saved_index).unwrap();
    let report = mac.sync(&server);
    assert_eq!(report.downloaded, 0);
    assert!(mac.skill_ids().is_empty());
    assert!(!load_index(&root, &account)
        .unwrap()
        .entries
        .contains_key(&entry_id));
}

/// One synced Skill on a ready device: (server, account, device, entry id).
fn synced_demo() -> (FakeServer, String, Device, String) {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let entry_id = mac.entry_id("demo");
    server.list_calls.set(0);
    (server, account, mac, entry_id)
}

#[test]
fn a_lost_delete_reply_is_checked_against_the_account_instead_of_reported_as_unchanged() {
    let (server, account, mac, entry_id) = synced_demo();
    server
        .delete_fault
        .set(Some(DeleteFault::CommitThenLoseReply));

    let result = run_async(delete_account_entry(&server, &entry_id, "mac"));
    assert_eq!(
        result,
        AccountDeleteResult::Deleted,
        "re-read shows the delete committed"
    );
    assert_eq!(
        server.list_calls.get(),
        2,
        "one read before, one re-read after the lost reply"
    );
    finish_account_delete_locally(
        &mac.paths.skillhub_root,
        &account,
        &entry_id,
        "demo",
        |id| mac.trash(id),
    )
    .unwrap();
    assert!(mac.skill_ids().is_empty());
}

#[test]
fn a_lost_delete_reply_with_an_unreadable_account_is_unconfirmed_and_converges_later() {
    let (server, account, mac, entry_id) = synced_demo();
    server
        .delete_fault
        .set(Some(DeleteFault::CommitThenLoseReply));
    server.fail_list_from.set(2);

    let result = run_async(delete_account_entry(&server, &entry_id, "mac"));
    let AccountDeleteResult::Unconfirmed(message) = result else {
        panic!("must not claim either outcome: {result:?}");
    };
    assert!(message.contains("再次确认时"), "{message}");
    // Nothing local was touched while the result is unknown.
    assert!(mac.skill("demo").exists());
    assert!(load_index(&mac.paths.skillhub_root, &account)
        .unwrap()
        .entries
        .contains_key(&entry_id));

    // Once the account can be read again, the next pass finishes the delete.
    server.fail_list_from.set(0);
    let report = mac.sync(&server);
    assert_eq!(report.trashed, 1);
    assert!(mac.skill_ids().is_empty());
}

#[test]
fn a_retry_that_cannot_read_the_account_stays_unconfirmed_after_a_committed_delete() {
    let (server, account, mac, entry_id) = synced_demo();
    // First attempt: committed on the Server, reply and re-read both lost.
    server
        .delete_fault
        .set(Some(DeleteFault::CommitThenLoseReply));
    server.fail_list_from.set(2);
    assert!(matches!(
        run_async(delete_account_entry(&server, &entry_id, "mac")),
        AccountDeleteResult::Unconfirmed(_)
    ));
    assert!(server.entry(&entry_id).deleted);

    // Retry while the account still cannot be read: no evidence either way,
    // so it must not claim the account kept the Skill.
    server.list_calls.set(0);
    server.fail_list_from.set(1);
    let AccountDeleteResult::Unconfirmed(message) =
        run_async(delete_account_entry(&server, &entry_id, "mac"))
    else {
        panic!("an unreadable account is never reported as kept");
    };
    assert!(message.contains("无法连接"), "{message}");
    assert!(mac.skill("demo").exists());
    assert!(load_index(&mac.paths.skillhub_root, &account)
        .unwrap()
        .entries
        .contains_key(&entry_id));

    // Readable again: the earlier commit is recognised, nothing is sent twice.
    server.fail_list_from.set(0);
    let revision = server.entry(&entry_id).revision;
    assert_eq!(
        run_async(delete_account_entry(&server, &entry_id, "mac")),
        AccountDeleteResult::Deleted
    );
    assert_eq!(server.entry(&entry_id).revision, revision);
}

#[test]
fn a_delete_that_never_arrived_is_not_deleted_when_the_account_can_be_read() {
    let (server, _account, mac, entry_id) = synced_demo();
    server
        .delete_fault
        .set(Some(DeleteFault::FailWithoutCommit));
    let AccountDeleteResult::Kept(error) =
        run_async(delete_account_entry(&server, &entry_id, "mac"))
    else {
        panic!("the account still has the entry")
    };
    assert!(error.contains("无法连接"), "{error}");
    assert!(!server.entry(&entry_id).deleted);
    assert!(mac.skill("demo").exists());

    // Unreadable afterwards: that is unknown too, never "unchanged".
    server
        .delete_fault
        .set(Some(DeleteFault::FailWithoutCommit));
    server.list_calls.set(0);
    server.fail_list_from.set(2);
    assert!(matches!(
        run_async(delete_account_entry(&server, &entry_id, "mac")),
        AccountDeleteResult::Unconfirmed(_)
    ));
    // A later retry deletes it for real.
    server.fail_list_from.set(0);
    assert_eq!(
        run_async(delete_account_entry(&server, &entry_id, "mac")),
        AccountDeleteResult::Deleted
    );
    assert!(server.entry(&entry_id).deleted);
}

#[test]
fn a_refused_delete_is_reported_without_a_re_read() {
    let (server, _account, _mac, entry_id) = synced_demo();
    server.delete_fault.set(Some(DeleteFault::Reject));
    server.list_calls.set(0);
    assert!(matches!(
        run_async(delete_account_entry(&server, &entry_id, "mac")),
        AccountDeleteResult::Kept(_)
    ));
    assert_eq!(server.list_calls.get(), 1);
    assert!(!server.entry(&entry_id).deleted);
}

#[test]
fn a_409_is_resolved_by_what_the_other_device_did() {
    let (server, _account, _mac, entry_id) = synced_demo();
    server
        .delete_fault
        .set(Some(DeleteFault::OtherDeviceDeletesThenConflict));
    assert_eq!(
        run_async(delete_account_entry(&server, &entry_id, "mac")),
        AccountDeleteResult::Deleted
    );

    let (server, _account, _mac, entry_id) = synced_demo();
    server
        .delete_fault
        .set(Some(DeleteFault::OtherDeviceEditsThenConflict));
    let AccountDeleteResult::Kept(error) =
        run_async(delete_account_entry(&server, &entry_id, "mac"))
    else {
        panic!("the account still has the entry")
    };
    assert!(error.contains("刚在其他设备上被修改"), "{error}");
    assert!(
        !server.entry(&entry_id).deleted,
        "never forced over a newer revision"
    );
}

// ── Account safety ──────────────────────────────────────────────────────────

#[test]
fn account_switch_stops_all_writes_for_the_old_account() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    let before = mac.index();
    mac.guard.switch_after.set(Some(0));
    assert_eq!(
        mac.sync_with(&server, SyncOptions::default()),
        Err(SyncError::AccountChanged)
    );
    assert_eq!(mac.index(), before, "index untouched");
    assert!(
        mac.sidecar("demo").library_account_id.is_none(),
        "directory not bound"
    );

    // Switch in the middle of downloads: nothing lands for the old account.
    let windows = ready_device(&account);
    mac.guard.switch_after.set(None);
    mac.sync(&server);
    windows.guard.switch_after.set(Some(0));
    assert_eq!(
        windows.sync_with(&server, SyncOptions::default()),
        Err(SyncError::AccountChanged)
    );
    assert!(windows.skill_ids().is_empty());
}

#[test]
fn a_running_pass_rejects_a_second_one() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    let _held = crate::skill_lock::lock_skill_dir_at(
        &mac.paths.skillhub_root,
        &format!("library-sync-{account}"),
    )
    .unwrap();
    assert_eq!(
        mac.sync_with(&server, SyncOptions::default()),
        Err(SyncError::Busy)
    );
}

#[test]
fn revision_conflicts_are_reevaluated_instead_of_overwritten() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let entry_id = mac.entry_id("demo");
    mac.edit_sidecar("demo", |sidecar| sidecar.category = Some("Mine".into()));
    // Another device changes a different field right before our PUT lands.
    let server_ref: *const FakeServer = &server;
    let racing: Box<dyn FnMut(&str)> = Box::new(move |id| {
        // SAFETY: the server outlives the sync pass that runs this hook.
        let server = unsafe { &*server_ref };
        server.remote_edit(
            id,
            None,
            Some(SyncProfile {
                display_name: "demo".into(),
                labels: vec!["theirs".into()],
                ..SyncProfile::default()
            }),
        );
    });
    *server.before_update.borrow_mut() = Some(racing);
    mac.sync(&server);
    let profile = server.entry(&entry_id).profile;
    assert_eq!(profile.category.as_deref(), Some("Mine"));
    assert_eq!(profile.labels, vec!["theirs".to_string()]);
}

// ── First-run migration ─────────────────────────────────────────────────────

fn server_with_source(server: &FakeServer, skill_id: &str, body: &str) -> String {
    let device = Device::new(&user());
    device.create_skill("source", body, SkillHubProfile::default());
    let package = crate::commands::library_package_bytes(&device.skill("source"), None).unwrap();
    let card = server.store_card(package);
    server
        .sources
        .borrow_mut()
        .insert(skill_id.into(), card.sha256.clone());
    card.sha256
}

#[test]
fn first_pass_binds_own_assets_and_keeps_unproven_ones_local_without_asking() {
    let server = FakeServer::new();
    let account = user();
    let mac = Device::new(&account);
    let own_card = server_with_source(&server, "own-skill", "# Own\n");
    let market_card = server_with_source(&server, "market-skill", "# Market\n");
    server_with_source(&server, "cloud-only", "# Cloud\n");
    server.own_skills.borrow_mut().push(OwnSkill {
        id: "cloud-only".into(),
        name: "cloud".into(),
        display_name: Some("Cloud".into()),
        description: None,
        source_url: None,
        category: None,
        labels: Vec::new(),
        trigger_scenarios: Vec::new(),
        compatible_agents: Vec::new(),
        env_dependencies: Vec::new(),
    });
    mac.create_skill(
        "own",
        "# Own\n",
        SkillHubProfile {
            server_id: Some("own-skill".into()),
            server_owner_id: Some(account.clone()),
            is_own: Some(true),
            acquisition_source: Some(AcquisitionSource::Local),
            display_name: Some("source".into()),
            ..SkillHubProfile::default()
        },
    );
    mac.create_guest_skill("market", "# Market\n", market_sidecar(&market_card));
    mac.create_guest_skill("mine-local", "# Local\n", SkillHubProfile::default());
    mac.create_skill(
        "their-team",
        "# Team\n",
        SkillHubProfile {
            server_id: Some("team-skill".into()),
            is_own: Some(false),
            acquisition_source: Some(AcquisitionSource::Team),
            acquired_by_user_id: Some(user()),
            team_ids: vec![uuid::Uuid::new_v4().to_string()],
            ..SkillHubProfile::default()
        },
    );

    let report = mac.sync(&server);
    assert_eq!(
        mac.sidecar("own").library_account_id.as_deref(),
        Some(account.as_str()),
        "own asset bound automatically"
    );
    assert_eq!(
        server.entry(&mac.entry_id("own")).card.unwrap().sha256,
        own_card
    );
    assert!(
        mac.skill_ids().contains(&"cloud".to_string()),
        "cloud-only author asset downloaded"
    );
    assert!(
        mac.index().migration.completed,
        "nothing waits for a confirmation list"
    );
    assert_eq!(report.kept_local, 3);
    let mut kept = kept_local_items(&mac.index(), &mac.paths.managed_root)
        .unwrap()
        .into_iter()
        .map(|item| (item.skill_id, item.reason))
        .collect::<Vec<_>>();
    kept.sort();
    assert_eq!(
        kept,
        vec![
            (
                "market".to_string(),
                "首次同步前已在这台电脑上，无法确认属于当前账号".to_string()
            ),
            (
                "mine-local".to_string(),
                "首次同步前已在这台电脑上，无法确认属于当前账号".to_string()
            ),
            ("their-team".to_string(), "由其他账号从团队取得".to_string()),
        ]
    );
    assert_eq!(
        server.active().len(),
        2,
        "own + cloud-only; nothing unproven uploaded"
    );
    for skill in ["market", "mine-local", "their-team"] {
        assert!(mac.sidecar(skill).library_account_id.is_none(), "{skill}");
    }
    let again = mac.sync(&server);
    assert_eq!((again.uploaded, again.bound, again.kept_local), (0, 0, 3));

    // Explicit "加入账号同步" for two of them; the team Skill stays local.
    let mut index = mac.index();
    for skill in ["market", "mine-local"] {
        index
            .migration
            .confirmed_local_ids
            .insert(mac.sidecar(skill).id.unwrap());
    }
    save_index(&mac.paths.skillhub_root, &index).unwrap();
    let report = mac.sync(&server);
    assert!(mac.sidecar("market").library_entry_id.is_some());
    assert!(mac.sidecar("mine-local").library_entry_id.is_some());
    assert!(mac.sidecar("their-team").library_entry_id.is_none());
    assert_eq!(
        report.copies_created, 0,
        "trusted baselines create no copies"
    );
    assert_eq!(report.kept_local, 1);
    assert!(mac.index().migration.confirmed_local_ids.is_empty());

    // Skills added after the first pass join automatically ("加入即同步").
    mac.create_skill("later", "# Later\n", SkillHubProfile::default());
    assert_eq!(mac.sync(&server).bound, 1);
}

fn market_sidecar(card: &str) -> SkillHubProfile {
    SkillHubProfile {
        server_id: Some("market-skill".into()),
        is_own: Some(false),
        acquisition_source: Some(AcquisitionSource::Marketplace),
        acquisition_package_sha256: Some(card.to_string()),
        display_name: Some("source".into()),
        ..SkillHubProfile::default()
    }
}

#[test]
fn two_devices_migrating_one_asset_preserve_unpublished_edits() {
    let server = FakeServer::new();
    let account = user();
    server_with_source(&server, "own-skill", "# Published\n");
    let own = |display: &str| SkillHubProfile {
        server_id: Some("own-skill".into()),
        server_owner_id: Some(account.clone()),
        is_own: Some(true),
        acquisition_source: Some(AcquisitionSource::Local),
        display_name: Some(display.into()),
        ..SkillHubProfile::default()
    };
    let mac = Device::new(&account);
    mac.create_skill("asset", "# Published\n", own("source"));
    let windows = Device::new(&account);
    windows.create_skill("asset", "# Published\n\nUnpublished edit\n", own("source"));

    mac.sync(&server);
    let report = windows.sync(&server);
    assert_eq!(server.active().len(), 2, "one shared entry plus one copy");
    assert_eq!(report.copies_created, 1);
    let copy = windows
        .skill_ids()
        .into_iter()
        .find(|id| id != "asset")
        .unwrap();
    assert!(windows.read(&copy, "SKILL.md").contains("Unpublished edit"));
    assert_eq!(windows.read("asset", "SKILL.md"), "# Published\n");
    assert_eq!(
        windows.entry_id("asset"),
        mac.entry_id("asset"),
        "same migrationKey, same entry"
    );
}

#[test]
fn migration_with_trusted_history_treats_local_edits_as_one_sided() {
    let server = FakeServer::new();
    let account = user();
    let team_card = server_with_source(&server, "team-skill", "# Team v1\n");
    let mac = Device::new(&account);
    mac.create_skill(
        "team",
        "# Team v1\n\nmy notes\n",
        SkillHubProfile {
            server_id: Some("team-skill".into()),
            is_own: Some(false),
            acquisition_source: Some(AcquisitionSource::Team),
            acquired_by_user_id: Some(account.clone()),
            acquisition_package_sha256: Some(team_card),
            team_ids: vec![uuid::Uuid::new_v4().to_string()],
            display_name: Some("source".into()),
            ..SkillHubProfile::default()
        },
    );
    let report = mac.sync(&server);
    assert_eq!(report.copies_created, 0);
    assert_eq!(
        report.uploaded, 1,
        "local edit uploaded as a one-sided change"
    );
    assert_eq!(mac.read("team", "SKILL.md"), "# Team v1\n\nmy notes\n");
}

#[test]
fn bound_directory_without_index_reattaches_without_duplicates() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    fs::remove_file(
        super::index::account_dir(&mac.paths.skillhub_root, &account)
            .unwrap()
            .join("index.json"),
    )
    .unwrap();
    mac.complete_migration();
    let report = mac.sync(&server);
    assert_eq!(
        (report.uploaded, report.downloaded, report.copies_created),
        (0, 0, 0)
    );
    assert_eq!(server.active().len(), 1);
    assert_eq!(mac.skill_ids(), vec!["demo".to_string()]);
}

#[test]
fn guessing_a_card_hash_cannot_create_an_entry() {
    let server = FakeServer::new();
    let other = Device::new(&user());
    other.create_skill("x", "# Secret\n", SkillHubProfile::default());
    let foreign =
        server.store_card(crate::commands::library_package_bytes(&other.skill("x"), None).unwrap());
    let request = CreateEntry {
        version_intent: None,
        id: uuid::Uuid::new_v4().to_string(),
        name: "steal".into(),
        profile: SyncProfile {
            display_name: "steal".into(),
            ..SyncProfile::default()
        },
        source: EntrySource::Card {
            card_sha256: foreign.sha256,
            provenance: None,
        },
        migration_key: None,
        device: "test".into(),
        source_url_synced: true,
    };
    let result = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(server.create_entry(&request));
    assert!(matches!(
        result,
        Err(ApiError::Rejected { status: 403, .. })
    ));
}

#[test]
fn packaged_content_identity_matches_the_local_identity() {
    let device = Device::new(&user());
    device.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    fs::create_dir_all(device.skill("demo").join("资料")).unwrap();
    device.write("demo", "资料/说明.md", "中文\n");
    let (local, _) = super::content::local_identity(&device.skill("demo"), None).unwrap();
    let package = crate::commands::library_package_bytes(&device.skill("demo"), None).unwrap();
    let server = identity_of_zip(&package);
    assert_eq!(server.content_hash, local.content_hash);
    assert_eq!(server.executable_paths, local.executable_paths);
}

#[test]
fn installed_store_update_repoints_the_entry_without_uploading() {
    let server = FakeServer::new();
    let account = user();
    let v1 = server_with_source(&server, "market-skill", "# Market v1\n");
    let mac = ready_device(&account);
    mac.create_skill(
        "market",
        "# Market v1\n",
        SkillHubProfile {
            server_id: Some("market-skill".into()),
            is_own: Some(false),
            acquisition_source: Some(AcquisitionSource::Marketplace),
            acquisition_package_sha256: Some(v1),
            display_name: Some("source".into()),
            ..SkillHubProfile::default()
        },
    );
    mac.sync(&server);
    let entry_id = mac.entry_id("market");
    let uploads = server.uploads.get();

    // The store publishes v2 and the user installs it on this device.
    let v2 = server_with_source(&server, "market-skill", "# Market v2\n");
    mac.write("market", "SKILL.md", "# Market v2\n");
    mac.edit_sidecar("market", |sidecar| {
        sidecar.acquisition_package_sha256 = Some(v2.clone())
    });
    library_snapshot_at(&mac.skill("market"), "v2").unwrap();

    mac.sync(&server);
    assert_eq!(
        server.uploads.get(),
        uploads,
        "official version is granted, not re-uploaded"
    );
    assert_eq!(server.entry(&entry_id).card.unwrap().sha256, v2);
    assert_eq!(mac.sync(&server), SyncReport::default());
}

// ── Review regressions (PR #58) ─────────────────────────────────────────────

/// Re-review: a profile write right after the last pre-switch check must
/// still be caught (by the check on the moved-aside original) and kept.
#[test]
fn profile_edit_after_the_last_check_is_preserved() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);
    windows.write("demo", "SKILL.md", "# Cloud\n");
    let package = crate::commands::library_package_bytes(&windows.skill("demo"), None).unwrap();
    let expected_profile = mac.sidecar("demo");
    let expected_tree = crate::commands::library_tree_fingerprint(&mac.skill("demo")).unwrap();
    let checks = std::rc::Rc::new(Cell::new(0));
    let callback_checks = checks.clone();
    let expected_display_name = expected_profile.display_name.clone();
    let verify = move |root: &Path| -> Result<bool, String> {
        let checked = library_read_profile(root)?.display_name == expected_display_name;
        callback_checks.set(callback_checks.get() + 1);
        if callback_checks.get() == 2 {
            // A concurrent editor writes just after the last pre-switch read.
            let mut late = library_read_profile(root)?;
            late.display_name = Some("Late local profile".into());
            library_write_profile(root, &late)?;
        }
        Ok(checked)
    };
    let result = land_library_package_at(
        &mac.home,
        &mac.paths.skillhub_root,
        &mac.paths.managed_root,
        LibraryLanding {
            skill_id: "demo",
            package: &package,
            profile: expected_profile.clone(),
            expected_existing: Some(&expected_tree),
            verify_existing: Some(&verify),
            message: "landing race",
        },
    );
    assert_eq!(result, Err(LibraryLandingError::LocalChanged));
    assert!(checks.get() >= 3, "the moved-aside original is checked too");
    assert_eq!(
        mac.sidecar("demo").display_name.as_deref(),
        Some("Late local profile")
    );
    assert_eq!(
        mac.read("demo", "SKILL.md"),
        "# Demo\n",
        "original restored"
    );
}

#[test]
fn profile_only_crash_with_ignored_sidecar_keeps_local_work() {
    profile_only_crash(true);
}

#[test]
fn profile_only_crash_with_tracked_sidecar_keeps_local_work() {
    profile_only_crash(false);
}

/// Re-review: when only an ignored sidecar changes, the landing still records
/// a version carrying the recovery token.
fn profile_only_crash(ignore_sidecar: bool) {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    if ignore_sidecar {
        fs::create_dir_all(mac.skill("demo")).unwrap();
        fs::write(mac.skill("demo").join(".gitignore"), ".skillhub.json\n").unwrap();
    }
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);
    windows.edit_sidecar("demo", |profile| {
        profile.display_name = Some("Cloud profile".into());
    });
    windows.sync(&server);
    mac.edit_sidecar("demo", |profile| {
        profile.display_name = Some("Local unique profile".into());
    });
    *mac.crash_after_landing.borrow_mut() = Some("demo".into());
    assert_eq!(
        mac.sync_with(&server, SyncOptions::default()),
        Err(SyncError::AccountChanged)
    );
    assert_eq!(
        mac.sidecar("demo").display_name.as_deref(),
        Some("Cloud profile")
    );
    let copy = mac.skill_ids().into_iter().find(|id| id != "demo").unwrap();
    assert_eq!(
        mac.sidecar(&copy).display_name.as_deref(),
        Some("Local unique profile（副本）")
    );
    *mac.crash_after_landing.borrow_mut() = None;
    mac.guard.switch_after.set(None);
    mac.sync(&server);
    assert_eq!(
        mac.sidecar(&copy).display_name.as_deref(),
        Some("Local unique profile（副本）"),
        "crash recovery must retain the saved local profile"
    );
    assert_eq!(
        server.entry(&mac.entry_id(&copy)).profile.display_name,
        "Local unique profile（副本）"
    );
    assert!(mac.index().operations.is_empty());
}

fn package_of(body: &str) -> Vec<u8> {
    let device = Device::new(&user());
    device.create_skill("pkg", body, SkillHubProfile::default());
    crate::commands::library_package_bytes(&device.skill("pkg"), None).unwrap()
}

fn catalog_device() -> Device {
    let mut device = Device::new(&user());
    device.guard.space_id = "selfhost-test".into();
    device
}

fn install_catalog(device: &Device, body: &str, version: &str) -> String {
    let bytes = package_of(body);
    let sha = format!("{:x}", Sha256::digest(&bytes));
    crate::catalog::cache_package(&device.paths.skillhub_root, &sha, &bytes).unwrap();
    let profile = SkillHubProfile {
        scope: Some(crate::spaces::SidecarScope {
            space_id: device.guard.space_id.clone(),
            runtime_user_id: device.guard.user_id.clone(),
        }),
        catalog_origin: Some(crate::catalog::origin().unwrap()),
        acquisition_version: Some(version.into()),
        acquisition_source: Some(AcquisitionSource::Marketplace),
        acquisition_package_sha256: Some(sha.clone()),
        server_id: Some("11111111-1111-4111-8111-111111111111".into()),
        server_owner_id: Some(device.guard.user_id.clone()),
        is_own: Some(false),
        version: version.into(),
        ..Default::default()
    };
    device.create_skill("catalog-demo", body, profile);
    sha
}

#[test]
fn catalog_binding_uploads_original_bytes_and_rebuilds_provenance_on_another_device() {
    let server = FakeServer::new();
    server.catalog_enabled.set(true);
    let mac = catalog_device();
    let sha = install_catalog(&mac, "# Original", "1.2.3");
    let report = mac.sync(&server);
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    let entry = server.entry(&mac.entry_id("catalog-demo"));
    assert_eq!(entry.source_kind, "catalog");
    assert_eq!(entry.source_version_id.as_deref(), Some("1.2.3"));
    assert_eq!(entry.card.unwrap().sha256, sha);
    assert_eq!(server.uploads.get(), 1);
    let mut windows = catalog_device();
    windows.guard.user_id = mac.guard.user_id.clone();
    let report = windows.sync(&server);
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    let restored = windows.sidecar(&windows.skill_ids()[0]);
    assert_eq!(
        restored.catalog_origin,
        Some(crate::catalog::origin().unwrap())
    );
    assert_eq!(restored.is_own, Some(false));
    assert_eq!(restored.acquisition_package_sha256, Some(sha));
}

#[test]
fn catalog_unreachable_retries_but_unavailable_and_mismatch_stay_local() {
    for code in [
        "CATALOG_UNREACHABLE",
        "CATALOG_NOT_AVAILABLE",
        "CATALOG_MISMATCH",
    ] {
        let server = FakeServer::new();
        server.catalog_enabled.set(true);
        let device = catalog_device();
        install_catalog(&device, "# Original", "0.1.0");
        *server.catalog_fault.borrow_mut() = Some(if code == "CATALOG_UNREACHABLE" {
            ApiError::Transient("503 CATALOG_UNREACHABLE".into())
        } else {
            ApiError::Conflict {
                code: Some(code.into()),
                message: code.into(),
                entry: None,
            }
        });
        device.sync(&server);
        assert!(server.active().is_empty());
        assert!(device.sidecar("catalog-demo").library_entry_id.is_none());
        let retryable = code == "CATALOG_UNREACHABLE";
        assert_eq!(device.index().migration.refused.is_empty(), retryable);
        device.sync(&server);
        assert_eq!(server.active().len(), usize::from(retryable));
    }
}

#[test]
fn catalog_old_instance_keeps_local_without_errors_or_uploads() {
    let server = FakeServer::new();
    let device = catalog_device();
    install_catalog(&device, "# Original", "0.1.0");
    let report = device.sync(&server);
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    assert!(server.active().is_empty());
    assert_eq!(server.uploads.get(), 0);
}

#[test]
fn catalog_update_uploads_original_package_and_never_falls_back_on_503() {
    let server = FakeServer::new();
    server.catalog_enabled.set(true);
    let device = catalog_device();
    let original_sha = install_catalog(&device, "# Original", "0.1.0");
    device.sync(&server);
    let entry_id = device.entry_id("catalog-demo");
    let bytes = package_of("# Updated");
    let sha = format!("{:x}", Sha256::digest(&bytes));
    crate::catalog::cache_package(&device.paths.skillhub_root, &sha, &bytes).unwrap();
    device.write("catalog-demo", "SKILL.md", "# Updated");
    device.edit_sidecar("catalog-demo", |profile| {
        profile.acquisition_package_sha256 = Some(sha.clone());
        profile.version = "0.2.0".into();
        profile.acquisition_version = Some("0.2.0".into());
    });
    *server.catalog_fault.borrow_mut() =
        Some(ApiError::Transient("503 CATALOG_UNREACHABLE".into()));
    device.sync(&server);
    assert_eq!(server.entry(&entry_id).card.unwrap().sha256, original_sha);
    device.sync(&server);
    assert_eq!(server.entry(&entry_id).card.unwrap().sha256, sha);
    assert_eq!(server.entry(&entry_id).source_kind, "catalog");
}

#[test]
fn catalog_rejected_update_can_retry_a_new_package_without_author_copy() {
    let server = FakeServer::new();
    server.catalog_enabled.set(true);
    let device = catalog_device();
    let original = install_catalog(&device, "# Original", "0.1.0");
    device.sync(&server);
    let entry_id = device.entry_id("catalog-demo");
    for (body, version, reject) in [("# Rejected", "0.2.0", true), ("# Latest", "0.3.0", false)] {
        let bytes = package_of(body);
        let sha = format!("{:x}", Sha256::digest(&bytes));
        crate::catalog::cache_package(&device.paths.skillhub_root, &sha, &bytes).unwrap();
        device.write("catalog-demo", "SKILL.md", body);
        device.edit_sidecar("catalog-demo", |profile| {
            profile.acquisition_package_sha256 = Some(sha.clone());
            profile.acquisition_version = Some(version.into());
        });
        if reject {
            *server.catalog_fault.borrow_mut() = Some(ApiError::Conflict {
                code: Some("CATALOG_MISMATCH".into()),
                message: "changed".into(),
                entry: None,
            });
        }
        device.sync(&server);
        assert_eq!(
            server.entry(&entry_id).card.unwrap().sha256,
            if reject { original.clone() } else { sha }
        );
        assert_eq!(server.active().len(), 1);
        assert_eq!(server.entry(&entry_id).source_kind, "catalog");
    }
}

#[test]
fn catalog_local_edits_and_deleted_entry_conflicts_never_become_author_assets() {
    for deleted in [false, true] {
        let server = FakeServer::new();
        server.catalog_enabled.set(true);
        let device = catalog_device();
        install_catalog(&device, "# Original", "0.1.0");
        device.sync(&server);
        if deleted {
            server.remote_delete(&device.entry_id("catalog-demo"));
        }
        device.write("catalog-demo", "SKILL.md", "# Personal edits");
        let uploads = server.uploads.get();
        let report = device.sync(&server);
        assert!(!report.problems.is_empty());
        assert_eq!(server.uploads.get(), uploads);
        assert_eq!(device.read("catalog-demo", "SKILL.md"), "# Personal edits");
        assert!(server
            .entries
            .borrow()
            .values()
            .all(|entry| entry.entry.source_kind == "catalog"));
        assert!(device.index().operations.is_empty());
    }
}

fn active_bodies(server: &FakeServer) -> Vec<String> {
    let mut bodies = server
        .active()
        .into_iter()
        .map(|entry| {
            let bytes = server.card_bytes(&entry.card.unwrap().sha256);
            let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
            let mut body = String::new();
            archive
                .by_name("SKILL.md")
                .unwrap()
                .read_to_string(&mut body)
                .unwrap();
            body
        })
        .collect::<Vec<_>>();
    bodies.sort();
    bodies
}

#[test]
fn crash_after_replacing_the_original_keeps_the_copy_local_work() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);
    windows.write("demo", "SKILL.md", "# Cloud\n");
    windows.sync(&server);
    mac.write("demo", "SKILL.md", "# Local unique work\n");

    // The original lands, then the process "dies" before the index is saved.
    *mac.crash_after_landing.borrow_mut() = Some("demo".into());
    assert_eq!(
        mac.sync_with(&server, SyncOptions::default()),
        Err(SyncError::AccountChanged)
    );
    assert_eq!(mac.read("demo", "SKILL.md"), "# Cloud\n");
    *mac.crash_after_landing.borrow_mut() = None;
    mac.guard.switch_after.set(None);

    let report = mac.sync(&server);
    assert_eq!(report.copies_created, 1);
    let copies = mac
        .skill_ids()
        .into_iter()
        .filter(|id| id != "demo")
        .collect::<Vec<_>>();
    assert_eq!(copies.len(), 1);
    assert_eq!(mac.read(&copies[0], "SKILL.md"), "# Local unique work\n");
    assert_eq!(mac.read("demo", "SKILL.md"), "# Cloud\n");
    assert_eq!(
        active_bodies(&server),
        vec!["# Cloud\n".to_string(), "# Local unique work\n".to_string()]
    );
    assert!(mac.index().operations.is_empty());
    assert_eq!(mac.sync(&server), SyncReport::default());
}

#[test]
fn profile_edit_during_a_download_is_kept() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);
    windows.write("demo", "SKILL.md", "# Demo v2\n");
    windows.sync(&server);

    let hook: LandHook = Box::new(|skill_id, root| {
        if skill_id == "demo" {
            let mut sidecar = library_read_profile(root).unwrap();
            sidecar.display_name = Some("Late local edit".into());
            library_write_profile(root, &sidecar).unwrap();
        }
    });
    *mac.before_land.borrow_mut() = Some(hook);
    mac.sync(&server);
    *mac.before_land.borrow_mut() = None;
    assert_eq!(
        mac.sidecar("demo").display_name.as_deref(),
        Some("Late local edit"),
        "the landing must not overwrite the late edit"
    );

    mac.sync(&server);
    assert_eq!(mac.read("demo", "SKILL.md"), "# Demo v2\n");
    assert_eq!(
        mac.sidecar("demo").display_name.as_deref(),
        Some("Late local edit")
    );
    assert_eq!(
        server.entry(&mac.entry_id("demo")).profile.display_name,
        "Late local edit"
    );
    assert_eq!(mac.skill_ids(), vec!["demo".to_string()]);
}

#[cfg(unix)]
#[test]
fn chmod_during_a_download_is_kept() {
    use std::os::unix::fs::PermissionsExt as _;
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);
    windows.write("demo", "SKILL.md", "# Demo v2\n");
    windows.sync(&server);

    let hook: LandHook = Box::new(|skill_id, root| {
        if skill_id == "demo" {
            fs::set_permissions(
                root.join("scripts/run.sh"),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
    });
    *mac.before_land.borrow_mut() = Some(hook);
    mac.sync(&server);
    *mac.before_land.borrow_mut() = None;
    let mode = || {
        fs::metadata(mac.skill("demo").join("scripts/run.sh"))
            .unwrap()
            .permissions()
            .mode()
    };
    assert_ne!(
        mode() & 0o111,
        0,
        "the landing must not drop the late chmod"
    );

    // Executable bits are part of the files: a chmod racing a content
    // download is a two-sided change, so it is saved as a copy first.
    let report = mac.sync(&server);
    assert_eq!(report.copies_created, 1);
    assert_eq!(mac.read("demo", "SKILL.md"), "# Demo v2\n");
    let copy = mac
        .skill_ids()
        .into_iter()
        .find(|id| id != "demo")
        .expect("copy keeps the chmod");
    let copy_mode = fs::metadata(mac.skill(&copy).join("scripts/run.sh"))
        .unwrap()
        .permissions()
        .mode();
    assert_ne!(copy_mode & 0o111, 0);
    assert_eq!(
        server
            .entry(&mac.entry_id(&copy))
            .card
            .unwrap()
            .executable_paths,
        vec!["scripts/run.sh".to_string()]
    );
}

#[test]
fn copy_edited_on_another_device_is_never_overwritten() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);
    windows.write("demo", "SKILL.md", "# W\n");
    windows.sync(&server);
    mac.write("demo", "SKILL.md", "# M1\n");

    // The user edits the original again right after the copy entry exists...
    let edited = Cell::new(false);
    let original = mac.skill("demo");
    let edit_once: Box<dyn FnMut(&str)> = Box::new(move |_| {
        if !edited.replace(true) {
            fs::write(original.join("SKILL.md"), "# M2\n").unwrap();
        }
    });
    *server.after_write.borrow_mut() = Some(edit_once);
    // ...and a third device edits that copy before the re-snapshot is saved.
    let third = package_of("# Third device\n");
    let server_ref: *const FakeServer = &server;
    let racing: Box<dyn FnMut(&str)> = Box::new(move |id| {
        // SAFETY: the server outlives the sync pass that runs this hook.
        let server = unsafe { &*server_ref };
        server.remote_edit(id, Some(third.clone()), None);
    });
    *server.before_update.borrow_mut() = Some(racing);
    mac.sync(&server);
    *server.after_write.borrow_mut() = None;
    *server.before_update.borrow_mut() = None;

    mac.sync(&server);
    let bodies = active_bodies(&server);
    assert!(
        bodies.contains(&"# Third device\n".to_string()),
        "{bodies:?}"
    );
    assert!(bodies.contains(&"# M2\n".to_string()), "{bodies:?}");
    assert!(bodies.contains(&"# W\n".to_string()), "{bodies:?}");
    assert_eq!(mac.read("demo", "SKILL.md"), "# W\n");
    assert!(mac.index().operations.is_empty());
}

// ── #91: one library on every device, legacy state upgrade ─────────────────

fn save_fixture_version(device: &Device, skill_id: &str, requested: Option<&str>) -> String {
    let _lock =
        crate::skill_lock::lock_skill_dir_at(&device.paths.skillhub_root, skill_id).unwrap();
    let root = device.skill(skill_id);
    let mut profile = library_read_profile(&root).unwrap();
    crate::commands::save_snapshot_with_version_at(
        &root,
        &mut profile,
        "user save",
        requested,
        Some(if requested.is_some() {
            "manual"
        } else {
            "auto"
        }),
    )
    .unwrap();
    crate::version_policy::head(&root).unwrap()
}

#[test]
fn published_content_compatibility_requires_formal_identity_only_with_new_server_policy() {
    let mut state = crate::version_policy::RemoteVersion::default();
    assert!(super::formal_content_matches(&state, "formal-a"));
    state.version_policy = Some(1);
    assert!(!super::formal_content_matches(&state, "formal-a"));
    state.version = Some(crate::version_policy::VersionReceipt {
        receipt_id: uuid::Uuid::new_v4().to_string(),
        label: "0.1.0".into(),
        card_sha256: "a".repeat(64),
        formal_version_id: Some("formal-a".into()),
        formal_label: Some("0.1.0".into()),
    });
    assert!(super::formal_content_matches(&state, "formal-a"));
    assert!(!super::formal_content_matches(&state, "formal-b"));
}

#[test]
fn same_card_formal_identities_survive_metadata_sync_and_later_content_updates() {
    let server = FakeServer::new();
    server.version_policy_enabled.set(true);
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill(
        "demo",
        "# same formal content\n",
        SkillHubProfile::default(),
    );
    mac.sync(&server);
    let id = mac.entry_id("demo");
    let mut receipts = Vec::new();
    for (index, version_label) in ["0.1.0", "0.1.1", "0.1.2"].iter().enumerate() {
        if index == 2 {
            server.remote_edit(&id, Some(package_of("# changed content\n")), None);
        }
        let receipt = crate::version_policy::VersionReceipt {
            receipt_id: uuid::Uuid::new_v4().to_string(),
            label: (*version_label).into(),
            card_sha256: server.entry(&id).card.unwrap().sha256,
            formal_version_id: Some(uuid::Uuid::new_v4().to_string()),
            formal_label: Some((*version_label).into()),
        };
        receipts.push(receipt);
    }
    // Install A and B on two independently downloaded devices before C.
    let original_card = server.store_card(package_of("# same formal content\n"));
    server
        .grants
        .borrow_mut()
        .insert(original_card.sha256.clone());
    server.entries.borrow_mut().get_mut(&id).unwrap().entry.card = Some(original_card.clone());
    receipts[0].card_sha256 = original_card.sha256.clone();
    receipts[1].card_sha256 = original_card.sha256;
    let install = |receipt: &crate::version_policy::VersionReceipt| {
        let mut entries = server.entries.borrow_mut();
        let entry = &mut entries.get_mut(&id).unwrap().entry;
        entry.version_state.version = Some(receipt.clone());
        entry.version_state.version_high_water =
            Some(crate::version_policy::ordinal(&receipt.label).unwrap());
        entry.accepted_version_receipt = None;
        entry.revision += 1;
        server
            .receipts
            .borrow_mut()
            .entry(id.clone())
            .or_default()
            .push(receipt.clone());
    };
    install(&receipts[0]);
    let restored = mac.sync(&server);
    assert!(restored.problems.is_empty(), "{:?}", restored.problems);
    let windows = ready_device(&account);
    windows.sync(&server);
    let mac_hash = crate::version_policy::head(&mac.skill("demo")).unwrap();
    let windows_hash = crate::version_policy::head(&windows.skill("demo")).unwrap();
    let uploads = server.uploads.get();
    let downloads = server.downloads.get();
    install(&receipts[1]);
    for device in [&mac, &windows] {
        let report = device.sync(&server);
        assert!(report.problems.is_empty(), "{:?}", report.problems);
        assert_eq!(report.copies_created, 0);
        let sidecar = device.sidecar("demo");
        assert_eq!(sidecar.version, "0.1.1");
        assert_eq!(
            sidecar.version_metadata.current_receipt.as_ref(),
            Some(&receipts[1])
        );
        assert!(sidecar
            .version_metadata
            .receipt_history
            .contains_key(&receipts[0].receipt_id));
        assert!(sidecar
            .version_metadata
            .receipt_history
            .contains_key(&receipts[1].receipt_id));
    }
    assert_eq!(
        crate::version_policy::head(&mac.skill("demo")),
        Some(mac_hash.clone())
    );
    assert_eq!(
        crate::version_policy::head(&windows.skill("demo")),
        Some(windows_hash)
    );
    assert_eq!(
        (server.uploads.get(), server.downloads.get()),
        (uploads, downloads)
    );
    server.remote_edit(&id, Some(package_of("# changed content\n")), None);
    receipts[2].card_sha256 = server.entry(&id).card.unwrap().sha256;
    server
        .grants
        .borrow_mut()
        .insert(receipts[2].card_sha256.clone());
    install(&receipts[2]);
    for device in [&mac, &windows] {
        let report = device.sync(&server);
        assert!(report.problems.is_empty(), "{:?}", report.problems);
        let metadata = device.sidecar("demo").version_metadata;
        assert_eq!(metadata.current_receipt.as_ref(), Some(&receipts[2]));
        assert_eq!(metadata.receipt_history.len(), 3);
        assert_eq!(
            crate::version_policy::history_for_hash(
                &metadata,
                &metadata.receipt_history[&receipts[0].receipt_id].git_hash
            )
            .len(),
            2
        );
    }
    crate::commands::restore_skill_version_identity_at_path(
        &mac.skill("demo"),
        &mac_hash,
        Some(&receipts[0].receipt_id),
    )
    .unwrap();
    let report = mac.sync(&server);
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    assert_eq!(
        mac.sidecar("demo")
            .version_metadata
            .current_receipt
            .as_ref(),
        Some(&receipts[0])
    );
    assert_eq!(mac.sidecar("demo").version_metadata.high_water, 12);
}

#[test]
fn marketplace_acquisition_binds_trusted_source_response_without_private_history_access() {
    let server = FakeServer::new();
    server.version_policy_enabled.set(true);
    server.deny_formal_lookup.set(true);
    let account = user();
    let mac = ready_device(&account);
    let card = server.store_card(package_of("# marketplace\n"));
    let version_id = uuid::Uuid::new_v4().to_string();
    server
        .sources
        .borrow_mut()
        .insert("market-source".into(), card.sha256.clone());
    server
        .source_versions
        .borrow_mut()
        .insert("market-source".into(), version_id.clone());
    server
        .formal_cards
        .borrow_mut()
        .insert(version_id.clone(), card.sha256.clone());
    mac.create_skill(
        "demo",
        "# marketplace\n",
        SkillHubProfile {
            server_id: Some("market-source".into()),
            acquisition_source: Some(AcquisitionSource::Marketplace),
            acquisition_package_sha256: Some(card.sha256),
            is_own: Some(false),
            ..Default::default()
        },
    );
    let report = mac.sync(&server);
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    assert_eq!(server.formal_lookups.get(), 0);
    let receipt = mac
        .sidecar("demo")
        .version_metadata
        .current_receipt
        .unwrap();
    assert_eq!(receipt.formal_version_id, Some(version_id));
    assert_eq!(server.uploads.get(), 0);
    mac.write("demo", "SKILL.md", "# unsaved marketplace change\n");
    for _ in 0..2 {
        assert!(mac.sync(&server).problems.is_empty());
    }
    assert!(mac
        .sidecar("demo")
        .version_metadata
        .current_receipt
        .is_none());
}

#[test]
fn source_provenance_does_not_bind_old_formal_uuid_after_unsaved_content_changes() {
    let server = FakeServer::new();
    server.version_policy_enabled.set(true);
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# source\n", SkillHubProfile::default());
    mac.sync(&server);
    let id = mac.entry_id("demo");
    let version_id = uuid::Uuid::new_v4().to_string();
    server
        .formal_cards
        .borrow_mut()
        .insert(version_id.clone(), server.entry(&id).card.unwrap().sha256);
    {
        let mut entries = server.entries.borrow_mut();
        let entry = &mut entries.get_mut(&id).unwrap().entry;
        entry.source_skill_id = Some("trusted-source".into());
        entry.source_version_id = Some(version_id.clone());
        entry.revision += 1;
    }
    assert!(mac.sync(&server).problems.is_empty());
    assert_eq!(
        mac.sidecar("demo")
            .version_metadata
            .current_receipt
            .unwrap()
            .formal_version_id,
        Some(version_id.clone())
    );
    mac.write("demo", "SKILL.md", "# unsaved modification\n");
    for _ in 0..2 {
        let report = mac.sync(&server);
        assert!(report.problems.is_empty(), "{:?}", report.problems);
    }
    assert!(server.entry(&id).version_state.version.is_none());
    assert_eq!(server.entry(&id).source_version_id, Some(version_id));
    assert!(mac
        .sidecar("demo")
        .version_metadata
        .current_receipt
        .is_none());
    assert_eq!(server.receipts.borrow()[&id].len(), 1);
}

#[test]
fn version_metadata_only_converges_without_packages_copies_or_git_commits() {
    let server = FakeServer::new();
    server.version_policy_enabled.set(true);
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# first\n", SkillHubProfile::default());
    mac.sync(&server);
    mac.write("demo", "SKILL.md", "# saved\n");
    let hash = save_fixture_version(&mac, "demo", None);
    mac.sync(&server);
    let id = mac.entry_id("demo");
    let windows = ready_device(&account);
    windows.sync(&server);
    let receipt = library_read_profile(&windows.skill("demo"))
        .unwrap()
        .version_metadata
        .current_receipt
        .unwrap();
    assert_eq!(
        receipt.receipt_id,
        server.entry(&id).version_state.version.unwrap().receipt_id
    );
    let uploads = server.uploads.get();
    let downloads = server.downloads.get();
    {
        let mut entries = server.entries.borrow_mut();
        let remote = &mut entries.get_mut(&id).unwrap().entry;
        remote.version_state.version.as_mut().unwrap().label = "0.5.0".into();
        remote.version_state.version_high_water = Some(50);
        remote.version_state.version_mapping_digest = Some("a".repeat(64));
        remote.revision += 1;
        remote.accepted_version_receipt = None;
        server.receipts.borrow_mut().get_mut(&id).unwrap()[0].label = "0.5.0".into();
    }
    let report = mac.sync(&server);
    windows.sync(&server);
    assert_eq!(report.copies_created, 0);
    assert_eq!(server.uploads.get(), uploads);
    assert_eq!(server.downloads.get(), downloads);
    assert_eq!(
        crate::version_policy::head(&mac.skill("demo")),
        Some(hash.clone())
    );
    let metadata = library_read_profile(&mac.skill("demo"))
        .unwrap()
        .version_metadata;
    assert_eq!(metadata.commits[&hash].label, "0.5.0");
    assert_eq!(metadata.high_water, 50);
    assert_eq!(
        mac.index().entries[&id]
            .baseline
            .version_state
            .version_mapping_digest,
        Some("a".repeat(64))
    );
}

#[test]
fn offline_snapshots_upload_only_current_save_and_lost_reply_recovers_stable_receipt() {
    let server = FakeServer::new();
    server.version_policy_enabled.set(true);
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# initial\n", SkillHubProfile::default());
    mac.sync(&server);
    mac.write("demo", "SKILL.md", "# offline one\n");
    let old = save_fixture_version(&mac, "demo", None);
    mac.write("demo", "SKILL.md", "# offline two\n");
    let latest = save_fixture_version(&mac, "demo", None);
    server.lose_save_reply.set(true);
    let report = mac.sync(&server);
    assert!(!report.problems.is_empty());
    let id = mac.entry_id("demo");
    let receipt_id = server.entry(&id).version_state.version.unwrap().receipt_id;
    assert_eq!(server.receipts.borrow()[&id].len(), 1);
    mac.sync(&server);
    let metadata = library_read_profile(&mac.skill("demo"))
        .unwrap()
        .version_metadata;
    assert!(metadata.commits[&old].receipt.is_none());
    assert!(metadata.commits[&old].pending.is_some());
    assert_eq!(
        metadata.commits[&latest]
            .receipt
            .as_ref()
            .unwrap()
            .receipt_id,
        receipt_id
    );
    assert!(metadata.commits[&latest].pending.is_none());
    assert_eq!(server.receipts.borrow()[&id].len(), 1);
}

#[test]
fn simultaneous_same_content_saves_accept_one_receipt_without_a_conflict_copy() {
    let server = FakeServer::new();
    server.version_policy_enabled.set(true);
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# initial\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = ready_device(&account);
    windows.sync(&server);
    mac.write("demo", "SKILL.md", "# identical\n");
    let m = save_fixture_version(&mac, "demo", Some("0.1.1"));
    windows.write("demo", "SKILL.md", "# identical\n");
    let w = save_fixture_version(&windows, "demo", Some("0.3.0"));
    mac.sync(&server);
    let report = windows.sync(&server);
    assert_eq!(report.copies_created, 0);
    let id = mac.entry_id("demo");
    assert_eq!(server.receipts.borrow()[&id].len(), 1);
    let mm = library_read_profile(&mac.skill("demo"))
        .unwrap()
        .version_metadata;
    let wm = library_read_profile(&windows.skill("demo"))
        .unwrap()
        .version_metadata;
    assert_eq!(mm.commits[&m].receipt, wm.commits[&w].receipt);
    assert_eq!(wm.commits[&w].label, "0.1.1");
    assert_eq!(wm.high_water, 30);
}

#[test]
fn offline_auto_save_converges_after_other_device_consumes_its_candidate_label() {
    let server = FakeServer::new();
    server.version_policy_enabled.set(true);
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# initial\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);
    mac.write("demo", "SKILL.md", "# offline edit\n");
    let hash = save_fixture_version(&mac, "demo", None);
    save_fixture_version(&windows, "demo", Some("0.1.1"));
    windows.sync(&server);
    let report = mac.sync(&server);
    assert!(report.problems.is_empty(), "{report:?}");
    let id = mac.entry_id("demo");
    assert_eq!(
        server.entry(&id).version_state.version.unwrap().label,
        "0.1.2"
    );
    assert_eq!(
        mac.sidecar("demo").version_metadata.commits[&hash].label,
        "0.1.2"
    );
    assert!(mac.index().entries[&id].blocked.is_none());
    assert_eq!(report.copies_created, 0);
    let reads = server.receipt_reads.get();
    mac.sync(&server);
    assert_eq!(
        server.receipt_reads.get(),
        reads,
        "unchanged entries need no history GET"
    );
}

#[test]
fn replacing_a_rejected_manual_save_intent_resumes_without_changing_content() {
    let server = FakeServer::new();
    server.version_policy_enabled.set(true);
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# initial\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = second_device(&account, &server);
    mac.write("demo", "SKILL.md", "# offline edit\n");
    let hash = save_fixture_version(&mac, "demo", Some("0.1.1"));
    save_fixture_version(&windows, "demo", Some("0.1.1"));
    windows.sync(&server);
    let report = mac.sync(&server);
    assert!(report
        .problems
        .iter()
        .any(|p| p.message.contains("VERSION_LABEL_CONFLICT")));
    let id = mac.entry_id("demo");
    let blocked = mac.index().entries[&id]
        .blocked_version_request_id
        .clone()
        .unwrap();
    assert_eq!(mac.sync(&server).uploaded, 0);
    let mut sidecar = mac.sidecar("demo");
    crate::commands::save_snapshot_with_version_at(
        &mac.skill("demo"),
        &mut sidecar,
        "adjust pending label",
        Some("0.1.2"),
        Some("auto"),
    )
    .unwrap();
    let mapped = &sidecar.version_metadata.commits[&hash];
    let Some(crate::version_policy::VersionIntent::Save { request_id, .. }) = &mapped.pending
    else {
        panic!("pending save")
    };
    assert_ne!(request_id, &blocked);
    let report = mac.sync(&server);
    assert!(report.problems.is_empty(), "{report:?}");
    assert!(mac.index().entries[&id].blocked.is_none());
    assert_eq!(crate::version_policy::head(&mac.skill("demo")), Some(hash));
    assert_eq!(mac.read("demo", "SKILL.md"), "# offline edit\n");
    assert_eq!(
        server.entry(&id).version_state.version.unwrap().label,
        "0.1.2"
    );
}

#[test]
fn invalid_entry_receipt_blocks_only_that_entry_and_the_pass_continues() {
    let server = FakeServer::new();
    server.version_policy_enabled.set(true);
    let account = user();
    let mac = ready_device(&account);
    for skill in ["bad", "healthy"] {
        mac.create_skill(skill, "# initial\n", SkillHubProfile::default());
    }
    mac.sync(&server);
    save_fixture_version(&mac, "bad", None);
    mac.sync(&server);
    let bad = mac.entry_id("bad");
    server
        .entries
        .borrow_mut()
        .get_mut(&bad)
        .unwrap()
        .entry
        .version_state
        .version
        .as_mut()
        .unwrap()
        .card_sha256 = "f".repeat(64);
    mac.write("healthy", "SKILL.md", "# changed\n");
    save_fixture_version(&mac, "healthy", None);
    let report = mac.sync(&server);
    assert!(report
        .problems
        .iter()
        .any(|p| p.entry_id.as_deref() == Some(&bad)));
    assert!(mac.index().entries[&bad].blocked.is_some());
    assert!(server
        .entry(&mac.entry_id("healthy"))
        .version_state
        .version
        .is_some());
}

#[test]
fn old_server_download_initializes_a_real_local_number_once() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# initial\n", SkillHubProfile::default());
    mac.sync(&server);
    let windows = ready_device(&account);
    let report = windows.sync(&server);
    assert!(report.problems.is_empty(), "{report:?}");
    let root = windows.skill("demo");
    let hash = crate::version_policy::head(&root).unwrap();
    let before = windows.sidecar("demo").version_metadata;
    let mapped = &before.commits[&hash];
    assert_eq!(mapped.label, "0.1.0");
    assert!(mapped.pending.is_none());
    assert!(mapped.receipt.is_none());
    assert!(mapped.formal_version_id.is_none());
    let uploads = server.uploads.get();
    assert!(windows.sync(&server).problems.is_empty());
    assert_eq!(crate::version_policy::head(&root), Some(hash));
    assert_eq!(windows.sidecar("demo").version_metadata, before);
    assert_eq!(server.uploads.get(), uploads);
}

#[test]
fn legacy_sync_operation_reuses_saved_content_number_without_rewinding_high_water() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# initial\n", SkillHubProfile::default());
    assert!(mac.sync(&server).problems.is_empty());
    let id = mac.entry_id("demo");
    let first = mac.sidecar("demo").version;
    mac.write("demo", "SKILL.md", "# saved edit\n");
    save_fixture_version(&mac, "demo", None);
    assert!(mac.sync(&server).problems.is_empty());
    let high_water = mac.sidecar("demo").version_metadata.high_water;
    server.remote_edit(&id, Some(package_of("# initial\n")), None);
    let report = mac.sync(&server);
    assert!(report.problems.is_empty(), "{report:?}");
    let sidecar = mac.sidecar("demo");
    let root = mac.skill("demo");
    let hash = crate::version_policy::head(&root).unwrap();
    let current = &sidecar.version_metadata.commits[&hash];
    assert_eq!(current.label, first);
    assert_eq!(sidecar.version_metadata.high_water, high_water);
    assert!(current.receipt.is_none());
    assert!(current.formal_version_id.is_none());
    assert!(current.pending.is_none());
    assert!(git2::Repository::open(&root)
        .unwrap()
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .message()
        .unwrap()
        .starts_with("从账号同步"));
}

#[test]
fn old_server_keeps_pending_local_versions_and_receives_no_unknown_intent_fields() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# initial\n", SkillHubProfile::default());
    mac.sync(&server);
    mac.write("demo", "SKILL.md", "# saved offline\n");
    let hash = save_fixture_version(&mac, "demo", None);
    mac.sync(&server);
    let metadata = library_read_profile(&mac.skill("demo"))
        .unwrap()
        .version_metadata;
    assert!(metadata.commits[&hash].pending.is_some());
    assert!(metadata.commits[&hash].receipt.is_none());
    assert!(metadata.current_receipt.is_none());
}

#[test]
fn legacy_markers_are_backed_up_and_entries_land_again_without_overwriting_anything() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("alpha", "# Alpha\n", SkillHubProfile::default());
    mac.create_skill(
        "beta",
        "# Beta from the account\n",
        SkillHubProfile::default(),
    );
    mac.sync(&server);
    let beta = mac.entry_id("beta");
    // Version 1: "仅从这台电脑删除" of beta, then an unrelated Skill that the
    // user kept on this device took the folder name.
    fs::remove_dir_all(mac.skill("beta")).unwrap();
    mac.write_legacy_marker(&beta);
    mac.create_guest_skill(
        "beta",
        "# Mine, never in the account\n",
        SkillHubProfile::default(),
    );
    let mine = mac.sidecar("beta").id.unwrap();
    mac.make_legacy(|index| {
        index.migration.excluded_local_ids.insert(mine.clone());
    });
    let uploads = server.uploads.get();

    let report = mac.sync(&server);
    assert_eq!(report.downloaded, 1, "the marked entry lands again");
    assert_eq!(
        server.uploads.get(),
        uploads,
        "the kept Skill is not uploaded"
    );
    assert_eq!(server.active().len(), 2);
    assert_eq!(
        mac.read("beta", "SKILL.md"),
        "# Mine, never in the account\n",
        "an existing folder is never overwritten"
    );
    assert!(mac.sidecar("beta").library_account_id.is_none());
    let landed = mac
        .skill_ids()
        .into_iter()
        .find(|id| id.starts_with("beta-"))
        .expect("account version in its own folder");
    assert_eq!(mac.entry_id(&landed), beta);
    assert_eq!(mac.read(&landed, "SKILL.md"), "# Beta from the account\n");

    let index = mac.index();
    assert_eq!(index.version, INDEX_VERSION);
    assert!(index.migration.excluded_local_ids.is_empty());
    assert_eq!(
        index.migration.kept_local.get(&mine).map(String::as_str),
        Some(KEPT_BY_CHOICE)
    );
    assert!(!local_only_dir(&mac.paths.skillhub_root, &account)
        .unwrap()
        .exists());

    // The backup holds the version 1 index and the marker.
    let backups = mac.backups();
    assert_eq!(backups.len(), 1);
    let saved: SyncIndex =
        serde_json::from_slice(&fs::read(backups[0].join("index.json")).unwrap()).unwrap();
    assert_eq!(saved.version, LEGACY_INDEX_VERSION);
    assert!(saved.migration.excluded_local_ids.contains(&mine));
    assert!(backups[0].join("local-only").join(&beta).is_file());
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(backups[0].join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["localOnlyEntryIds"][0], beta.as_str());

    // Settled: the next pass changes nothing and takes no second backup.
    let again = mac.sync(&server);
    assert_eq!((again.downloaded, again.uploaded, again.bound), (0, 0, 0));
    assert_eq!(mac.backups().len(), 1);
}

#[test]
fn an_unanswered_confirmation_list_becomes_kept_local_and_never_blocks_the_library() {
    let server = FakeServer::new();
    let account = user();
    let windows = ready_device(&account);
    windows.create_skill("shared", "# Shared\n", SkillHubProfile::default());
    windows.sync(&server);

    let mac = Device::new(&account);
    mac.create_guest_skill("guest-notes", "# Private\n", SkillHubProfile::default());
    let guest = mac.sidecar("guest-notes").id.unwrap();
    // Version 1 state: the "首次同步待确认" list was never answered.
    mac.make_legacy(|index| {
        index.migration.completed = false;
        index.migration.candidates.push(MigrationCandidate {
            skill_id: "guest-notes".into(),
            local_id: guest.clone(),
            display_name: "guest-notes".into(),
            kind: "local".into(),
            reason: "仅保存在这台电脑".into(),
        });
    });

    let report = mac.sync(&server);
    assert!(mac.index().migration.completed);
    assert!(mac.index().migration.candidates.is_empty());
    assert_eq!(report.kept_local, 1);
    assert!(
        mac.skill_ids().contains(&"shared".to_string()),
        "the library still lands"
    );
    assert_eq!(server.active().len(), 1, "the guest file is not uploaded");
    assert_eq!(mac.backups().len(), 1);
}

#[test]
fn a_same_asset_folder_equal_to_the_account_version_is_bound_and_a_changed_one_is_kept() {
    let server = FakeServer::new();
    let account = user();
    let card = server_with_source(&server, "market-skill", "# Market\n");
    // Windows installed the store Skill after its first pass: it joined.
    let windows = ready_device(&account);
    windows.create_skill("market", "# Market\n", market_sidecar(&card));
    windows.sync(&server);
    let entry = windows.entry_id("market");
    assert_eq!(
        server.entry(&entry).migration_key.as_deref(),
        Some("marketplace:market-skill")
    );

    // Mac had the same install before its first pass (ownership unproven).
    let mac = Device::new(&account);
    mac.create_guest_skill("market", "# Market\n", market_sidecar(&card));
    let uploads = server.uploads.get();
    let report = mac.sync(&server);
    assert_eq!(
        mac.entry_id("market"),
        entry,
        "identical folder becomes the entry"
    );
    assert_eq!(mac.skill_ids(), vec!["market".to_string()], "no duplicate");
    assert_eq!((report.downloaded, report.kept_local), (0, 0));
    assert_eq!(server.uploads.get(), uploads, "nothing uploaded");

    // Another device with local edits to its old copy keeps them untouched.
    let linux = Device::new(&account);
    linux.create_guest_skill("market", "# Market\n\nmy notes\n", market_sidecar(&card));
    let report = linux.sync(&server);
    assert_eq!(report.kept_local, 1);
    assert_eq!(linux.read("market", "SKILL.md"), "# Market\n\nmy notes\n");
    assert!(linux.sidecar("market").library_account_id.is_none());
    let landed = linux
        .skill_ids()
        .into_iter()
        .find(|id| id != "market")
        .expect("account version lands separately");
    assert_eq!(linux.entry_id(&landed), entry);
    assert_eq!(server.active().len(), 1, "edits not uploaded");

    // Joining it explicitly makes it its own entry, not a claim on the asset.
    let mut index = linux.index();
    index
        .migration
        .confirmed_local_ids
        .insert(linux.sidecar("market").id.unwrap());
    save_index(&linux.paths.skillhub_root, &index).unwrap();
    let report = linux.sync(&server);
    assert_eq!(report.bound, 1);
    assert_eq!(server.active().len(), 2);
    assert_ne!(linux.entry_id("market"), entry);
    assert_eq!(
        linux.entry_id(&landed),
        entry,
        "the asset folder keeps its entry"
    );
    assert_eq!(linux.read("market", "SKILL.md"), "# Market\n\nmy notes\n");
}

#[test]
fn a_restored_folder_whose_entry_the_account_deleted_stays_local_and_is_not_reuploaded() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    let entry = mac.entry_id("demo");
    server.remote_delete(&entry);
    // The index forgot the entry (e.g. restored from the local recycle bin).
    let mut index = mac.index();
    index.entries.clear();
    save_index(&mac.paths.skillhub_root, &index).unwrap();

    let report = mac.sync(&server);
    assert!(mac.sidecar("demo").library_account_id.is_none());
    assert_eq!(report.kept_local, 1);
    let local_id = mac.sidecar("demo").id.unwrap();
    assert_eq!(
        mac.index()
            .migration
            .kept_local
            .get(&local_id)
            .map(String::as_str),
        Some(KEPT_ACCOUNT_DELETED)
    );
    let again = mac.sync(&server);
    assert_eq!(
        (again.uploaded, again.bound),
        (0, 0),
        "the account delete is not undone"
    );
    assert!(server.active().is_empty());
}

#[test]
fn a_failed_download_is_reported_and_retried_automatically() {
    let server = FakeServer::new();
    let account = user();
    let windows = ready_device(&account);
    windows.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    windows.sync(&server);

    let mac = ready_device(&account);
    server.fail_downloads.set(1);
    let report = mac.sync(&server);
    assert!(mac.skill_ids().is_empty());
    assert_eq!(report.problems.len(), 1);
    assert_eq!(
        report.problems[0].entry_id.as_deref(),
        Some(windows.entry_id("demo").as_str()),
        "the reason is tied to the entry"
    );
    let report = mac.sync(&server);
    assert_eq!(report.downloaded, 1);
    assert_eq!(mac.read("demo", "SKILL.md"), "# Demo\n");
}

#[test]
fn another_account_on_the_same_computer_never_takes_or_uploads_the_first_accounts_skills() {
    let server = FakeServer::new();
    let alice = user();
    let mac = ready_device(&alice);
    mac.create_skill("alice-skill", "# Alice\n", SkillHubProfile::default());
    mac.sync(&server);
    mac.create_skill("left-unbound", "# Guest\n", SkillHubProfile::default());
    let alice_entry = mac.entry_id("alice-skill");

    let bob_session = mac.signed_in_as(&user());
    let report = bob_session.sync(&server);
    assert_eq!(report.uploaded, 0);
    assert_eq!(
        report.kept_local, 1,
        "the unbound guest file stays local for Bob"
    );
    assert_eq!(server.active().len(), 1, "only Alice's entry exists");
    assert_eq!(
        bob_session
            .sidecar("alice-skill")
            .library_entry_id
            .as_deref(),
        Some(alice_entry.as_str()),
        "Alice's binding is untouched"
    );
    assert!(bob_session
        .sidecar("left-unbound")
        .library_account_id
        .is_none());
}

#[test]
fn ten_devices_of_one_account_converge_without_any_manual_download() {
    let server = FakeServer::new();
    let account = user();
    let devices = (0..10).map(|_| ready_device(&account)).collect::<Vec<_>>();
    let round = |devices: &[Device]| {
        for device in devices {
            device.sync(&server);
        }
    };
    let converged = |devices: &[Device]| {
        let expected = devices[0].library();
        for (number, device) in devices.iter().enumerate() {
            assert_eq!(device.library(), expected, "device {number}");
        }
        expected
    };

    // Every device adds one Skill.
    for (number, device) in devices.iter().enumerate() {
        device.create_skill(
            &format!("skill-{number}"),
            &format!("# {number}\n"),
            SkillHubProfile::default(),
        );
    }
    round(&devices);
    round(&devices);
    assert_eq!(converged(&devices).len(), 10);

    // An edit on one device reaches all others.
    devices[3].write("skill-7", "SKILL.md", "# 7 edited on device 3\n");
    round(&devices);
    round(&devices);
    let library = converged(&devices);
    assert!(library
        .values()
        .any(|body| body == "# 7 edited on device 3\n"));

    // Concurrent edits of one Skill: both versions survive everywhere.
    devices[1].write("skill-0", "SKILL.md", "# 0 from device 1\n");
    devices[2].write("skill-0", "SKILL.md", "# 0 from device 2\n");
    round(&devices);
    round(&devices);
    let library = converged(&devices);
    assert_eq!(library.len(), 11, "one copy entry");
    for body in ["# 0 from device 1\n", "# 0 from device 2\n"] {
        assert!(library.values().any(|value| value == body), "{body}");
    }

    // An account delete removes it everywhere; a restore brings it back.
    let gone = devices[5].entry_id("skill-4");
    server.remote_delete(&gone);
    round(&devices);
    round(&devices);
    assert!(!converged(&devices).contains_key(&gone));
    let revision = server.entry(&gone).revision;
    run_async(server.restore_entry(&gone, revision, "test")).unwrap();
    round(&devices);
    assert!(converged(&devices).contains_key(&gone));
}

// ── #91 review: explicit joins, v1 backups, read-only status ───────────────

#[test]
fn a_skill_imported_while_signed_out_is_never_uploaded_to_the_next_account() {
    let server = FakeServer::new();
    let alice = user();
    let mac = ready_device(&alice);
    mac.create_skill("first", "# First\n", SkillHubProfile::default());
    mac.sync(&server);
    // Signed out: a private Skill appears without an account stamp.
    mac.create_guest_skill("private", "# Private\n", SkillHubProfile::default());
    let uploads = server.uploads.get();

    let report = mac.sync(&server);
    assert_eq!(
        (report.uploaded, report.bound, report.kept_local),
        (0, 0, 1)
    );
    assert_eq!(server.uploads.get(), uploads);
    assert_eq!(server.active().len(), 1, "only Alice's earlier Skill");
    assert!(mac.sidecar("private").library_account_id.is_none());
    let kept = kept_local_items(&mac.index(), &mac.paths.managed_root).unwrap();
    assert_eq!(kept[0].skill_id, "private");
    assert!(kept[0].reason.contains("未登录"), "{}", kept[0].reason);

    // Another account whose first sync already ran on this computer.
    let bob = user();
    let bob_session = mac.signed_in_as(&bob);
    bob_session.complete_migration();
    let report = bob_session.sync(&server);
    assert_eq!((report.uploaded, report.bound), (0, 0));
    assert_eq!(server.active().len(), 1);

    // Only an explicit "加入账号同步" adds it.
    let mut index = mac.index();
    index
        .migration
        .confirmed_local_ids
        .insert(mac.sidecar("private").id.unwrap());
    save_index(&mac.paths.skillhub_root, &index).unwrap();
    assert_eq!(mac.sync(&server).bound, 1);
    assert_eq!(server.active().len(), 2);
}

#[test]
fn a_skill_added_under_another_account_or_obtained_by_one_stays_local() {
    let server = FakeServer::new();
    let alice = user();
    let bob = user();
    let mac = ready_device(&alice);
    // Imported while Bob was signed in on this computer.
    mac.create_skill(
        "bobs-import",
        "# Bob\n",
        SkillHubProfile {
            added_by_account_id: Some(bob.clone()),
            ..SkillHubProfile::default()
        },
    );
    // A team Skill another account obtained, even if installed while Alice was signed in.
    let team_card = server_with_source(&server, "team-skill", "# Team\n");
    let team_id = uuid::Uuid::new_v4().to_string();
    mac.create_skill(
        "their-team",
        "# Team\n",
        SkillHubProfile {
            server_id: Some("team-skill".into()),
            is_own: Some(false),
            acquisition_source: Some(AcquisitionSource::Team),
            acquired_by_user_id: Some(bob.clone()),
            acquisition_package_sha256: Some(team_card.clone()),
            team_ids: vec![team_id.clone()],
            ..SkillHubProfile::default()
        },
    );
    // The same team Skill activated by Alice herself joins.
    mac.create_skill(
        "my-team",
        "# Team\n",
        SkillHubProfile {
            server_id: Some("team-skill".into()),
            is_own: Some(false),
            acquisition_source: Some(AcquisitionSource::Team),
            acquired_by_user_id: Some(alice.clone()),
            acquisition_package_sha256: Some(team_card),
            team_ids: vec![team_id],
            display_name: Some("source".into()),
            ..SkillHubProfile::default()
        },
    );

    let report = mac.sync(&server);
    assert_eq!(report.kept_local, 2);
    assert!(mac.sidecar("my-team").library_entry_id.is_some());
    assert!(mac.sidecar("bobs-import").library_account_id.is_none());
    assert!(mac.sidecar("their-team").library_account_id.is_none());
    assert_eq!(server.active().len(), 1, "only Alice's own team Skill");
    let mut reasons = kept_local_items(&mac.index(), &mac.paths.managed_root)
        .unwrap()
        .into_iter()
        .map(|item| (item.skill_id, item.reason))
        .collect::<Vec<_>>();
    reasons.sort();
    assert_eq!(
        reasons,
        vec![
            (
                "bobs-import".to_string(),
                "在其他账号登录时加入 SkillHub".to_string()
            ),
            ("their-team".to_string(), "由其他账号从团队取得".to_string()),
        ]
    );
}

#[test]
fn every_version_1_index_is_backed_up_before_the_first_version_2_save_even_if_interrupted() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    mac.sync(&server);
    // An ordinary v0.26 index: no markers, exclusions or pending list.
    mac.make_legacy(|_| {});
    let legacy_bytes = fs::read(
        account_dir(&mac.paths.skillhub_root, &account)
            .unwrap()
            .join("index.json"),
    )
    .unwrap();

    // Interrupted right after the backup, before the v2 save.
    mac.guard.switch_after.set(Some(mac.guard.holds.get() + 1));
    assert_eq!(
        mac.sync_with(&server, SyncOptions::default()).unwrap_err(),
        SyncError::AccountChanged
    );
    mac.guard.switch_after.set(None);
    let index_file = account_dir(&mac.paths.skillhub_root, &account)
        .unwrap()
        .join("index.json");
    assert_eq!(
        fs::read(&index_file).unwrap(),
        legacy_bytes,
        "still the readable v1 index"
    );
    assert_eq!(mac.backups().len(), 1);

    mac.sync(&server);
    assert_eq!(mac.index().version, INDEX_VERSION);
    let backups = mac.backups();
    assert_eq!(backups.len(), 2, "the retry backs up again before saving");
    for backup in backups {
        let name = backup.file_name().unwrap().to_str().unwrap().to_string();
        assert!(
            name.starts_with("upgrade-v2-"),
            "complete backups only, no .partial-: {name}"
        );
        assert_eq!(fs::read(backup.join("index.json")).unwrap(), legacy_bytes);
        assert!(backup.join("manifest.json").is_file());
    }
    assert_eq!(
        mac.entry_id("demo"),
        mac.index().entries.keys().next().unwrap().clone()
    );
    // Already version 2: no further backups.
    mac.sync(&server);
    assert_eq!(mac.backups().len(), 2);
}

#[test]
fn the_kept_local_status_query_never_rewrites_a_sidecar() {
    let account = user();
    let mac = ready_device(&account);
    let local_id = uuid::Uuid::new_v4().to_string();
    let root = mac.skill("legacy");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("SKILL.md"), "# Legacy\n").unwrap();
    // A compact v0.2x sidecar that the normalising reader would rewrite.
    let sidecar = format!(
        r#"{{"version":"1.0","skillhub":{{"id":"{local_id}","name":"legacy","displayName":"Legacy"}}}}"#
    );
    fs::write(root.join(".skillhub.json"), &sidecar).unwrap();
    let mut index = mac.index();
    index
        .migration
        .kept_local
        .insert(local_id.clone(), "test".into());

    let items = kept_local_items(&index, &mac.paths.managed_root).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].display_name, "Legacy");
    assert_eq!(
        fs::read_to_string(root.join(".skillhub.json")).unwrap(),
        sidecar
    );
}

// ── #91 review: first binding of a folder this device just added ───────────

fn set_display_name(root: &Path, name: &str) {
    let mut profile = library_read_profile(root).unwrap();
    profile.display_name = Some(name.into());
    library_write_profile(root, &profile).unwrap();
}

#[test]
fn a_profile_update_right_after_the_entry_is_created_is_one_sided_and_makes_no_copy() {
    // The APP import: AI analysis updates the profile while the first sync
    // is creating the entry (Codex's native repro on #94).
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    let root = mac.skill("demo");
    let once = Cell::new(false);
    *server.after_write.borrow_mut() = Some(Box::new(move |_| {
        if !once.replace(true) {
            set_display_name(&root, "AI finished locally");
        }
    }));
    let report = mac.sync(&server);
    *server.after_write.borrow_mut() = None;

    assert_eq!(
        report.copies_created, 0,
        "only this device edited the new Skill"
    );
    assert_eq!(server.active().len(), 1);
    assert_eq!(mac.skill_ids(), vec!["demo".to_string()]);
    assert_eq!(
        mac.sidecar("demo").display_name.as_deref(),
        Some("AI finished locally")
    );
    let entry = server.entry(&mac.entry_id("demo"));
    assert_eq!(
        entry.profile.display_name, "AI finished locally",
        "the later profile reached the account"
    );
    let again = mac.sync(&server);
    assert_eq!((again.uploaded, again.copies_created), (0, 0));
}

#[test]
fn a_file_edit_right_after_the_entry_is_created_is_uploaded_without_a_copy() {
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    let root = mac.skill("demo");
    let once = Cell::new(false);
    *server.after_write.borrow_mut() = Some(Box::new(move |_| {
        if !once.replace(true) {
            fs::write(root.join("SKILL.md"), "# Demo\n\nfinished by AI\n").unwrap();
        }
    }));
    let report = mac.sync(&server);
    *server.after_write.borrow_mut() = None;

    assert_eq!(report.copies_created, 0);
    assert_eq!(server.active().len(), 1);
    assert_eq!(
        report.uploaded, 2,
        "the created version, then the one-sided edit"
    );
    assert_eq!(
        active_bodies(&server),
        vec!["# Demo\n\nfinished by AI\n".to_string()]
    );
}

#[test]
fn edits_between_the_scan_and_the_upload_are_sent_or_synced_without_a_copy() {
    let server = FakeServer::new();
    let account = user();
    // Before the scan's results are used (own-Skills request of the first pass).
    let mac = Device::new(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    let root = mac.skill("demo");
    *server.on_own_skills.borrow_mut() = Some(Box::new(move || {
        set_display_name(&root, "Renamed after the scan")
    }));
    let report = mac.sync(&server);
    assert_eq!(report.copies_created, 0);
    let entry = server.entry(&mac.entry_id("demo"));
    assert_eq!(
        entry.profile.display_name, "Renamed after the scan",
        "sent from the locked read, not the scan"
    );

    // While the upload is in flight (after the locked read).
    let windows = ready_device(&account);
    windows.create_skill("other", "# Other\n", SkillHubProfile::default());
    let root = windows.skill("other");
    *server.before_upload.borrow_mut() = Some(Box::new(move || {
        set_display_name(&root, "Renamed during upload")
    }));
    let report = windows.sync(&server);
    assert_eq!(report.copies_created, 0);
    let entry = server.entry(&windows.entry_id("other"));
    assert_eq!(entry.profile.display_name, "Renamed during upload");
    assert_eq!(server.active().len(), 2);
}

#[test]
fn another_devices_edit_in_the_same_window_still_keeps_both_versions() {
    // Real concurrency right after creation: this device renames the new
    // Skill while another device already renamed the entry differently.
    let server = FakeServer::new();
    let account = user();
    let mac = ready_device(&account);
    mac.create_skill("demo", "# Demo\n", SkillHubProfile::default());
    let root = mac.skill("demo");
    let once = Cell::new(false);
    *server.after_write.borrow_mut() = Some(Box::new(move |_| {
        if !once.replace(true) {
            set_display_name(&root, "Local rename");
        }
    }));
    *server.rename_before_update.borrow_mut() = Some("Other device rename".into());
    let report = mac.sync(&server);
    *server.after_write.borrow_mut() = None;

    assert_eq!(
        report.copies_created, 1,
        "a same-field conflict is preserved as a copy"
    );
    let names = server
        .active()
        .into_iter()
        .map(|entry| entry.profile.display_name)
        .collect::<Vec<_>>();
    assert!(
        names.iter().any(|name| name == "Other device rename"),
        "{names:?}"
    );
    assert!(
        names.iter().any(|name| name.contains("Local rename")),
        "{names:?}"
    );
}
