//! Version labels are metadata: Git object IDs and package bytes never change.
use crate::library_sync::content::{content_hash, local_identity, ContentIdentity};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub(crate) const CAPABILITY: &str = "skills.version-policy.v1";
pub(crate) const DEFAULT_LABEL: &str = "0.1.0";

pub(crate) fn ordinal(label: &str) -> Option<i32> {
    let b = label.as_bytes();
    (b.len() == 5
        && b[1] == b'.'
        && b[3] == b'.'
        && b[0].is_ascii_digit()
        && b[2].is_ascii_digit()
        && b[4].is_ascii_digit())
    .then(|| i32::from(b[0] - b'0') * 100 + i32::from(b[2] - b'0') * 10 + i32::from(b[4] - b'0'))
}

pub(crate) fn label(value: i32) -> Result<String, String> {
    if !(0..=999).contains(&value) {
        return Err("VERSION_RANGE_EXHAUSTED: 版本范围已用尽".into());
    }
    Ok(format!(
        "{}.{}.{}",
        value / 100,
        value / 10 % 10,
        value % 10
    ))
}

pub(crate) fn allocate(high_water: i32, requested: Option<&str>) -> Result<String, String> {
    if let Some(requested) = requested {
        let value =
            ordinal(requested).ok_or("VERSION_FORMAT_INVALID: 版本号必须是三个单数字，如 0.1.0")?;
        if value <= high_water {
            return Err("VERSION_LABEL_CONFLICT: 版本号必须大于历史最高版本".into());
        }
        return Ok(requested.into());
    }
    if high_water < 0 {
        return Ok(DEFAULT_LABEL.into());
    }
    label(high_water + 1)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionReceipt {
    pub receipt_id: String,
    pub label: String,
    pub card_sha256: String,
    pub formal_version_id: Option<String>,
    pub formal_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum VersionIntent {
    Save {
        request_id: String,
        card_sha256: String,
        allocation: String,
        label: String,
    },
    Select {
        receipt_id: String,
    },
    Formal {
        version_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteVersion {
    pub(crate) version_policy: Option<u8>,
    pub(crate) version_high_water: Option<i32>,
    pub(crate) version_mapping_digest: Option<String>,
    pub(crate) version: Option<VersionReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitVersion {
    pub label: String,
    pub original_label: String,
    pub(crate) content: ContentIdentity,
    pub receipt: Option<VersionReceipt>,
    pub formal_version_id: Option<String>,
    pub(crate) pending: Option<VersionIntent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptCommit {
    pub git_hash: String,
    pub mapping: CommitVersion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMetadata {
    pub policy: u8,
    pub account_id: Option<String>,
    pub entry_id: Option<String>,
    pub high_water: i32,
    pub mapping_digest: Option<String>,
    #[serde(default)]
    pub commits: BTreeMap<String, CommitVersion>,
    #[serde(default)]
    pub receipt_history: BTreeMap<String, ReceiptCommit>,
    #[serde(default)]
    pub source_cards: BTreeMap<String, String>,
    #[serde(default)]
    pub history_reviews: BTreeMap<String, String>,
    pub current_receipt: Option<VersionReceipt>,
}

impl Default for VersionMetadata {
    fn default() -> Self {
        Self {
            policy: 1,
            account_id: None,
            entry_id: None,
            high_water: -1,
            mapping_digest: None,
            commits: BTreeMap::new(),
            receipt_history: BTreeMap::new(),
            source_cards: BTreeMap::new(),
            history_reviews: BTreeMap::new(),
            current_receipt: None,
        }
    }
}

pub(crate) fn head(root: &Path) -> Option<String> {
    git2::Repository::open(root)
        .ok()?
        .head()
        .ok()?
        .peel_to_commit()
        .ok()
        .map(|c| c.id().to_string())
}

/// Repository-local settings every Skill history must carry. Skill histories
/// belong to SkillHub, not to the user's Git setup: Git for Windows installs
/// `core.autocrlf = true` system-wide, and libgit2 would then rewrite restored
/// files to CRLF and normalise added ones, so working-tree bytes stop matching
/// card hashes and "same bytes" snapshots (#353). Pinning the local level wins
/// over any system or global value.
const PINNED_REPOSITORY_CONFIG: &[(&str, &str)] = &[
    ("core.autocrlf", "false"),
    ("core.eol", "lf"),
    ("core.safecrlf", "false"),
];

/// Writes the pinned settings into the repository's own config when they are
/// missing or inherited with another value. Idempotent; existing histories are
/// upgraded on their next snapshot or restore.
pub(crate) fn pin_repository_config(repo: &git2::Repository) -> Result<(), git2::Error> {
    let mut config = repo.config()?;
    for (key, value) in PINNED_REPOSITORY_CONFIG {
        if config.get_string(key).ok().as_deref() != Some(*value) {
            config.set_str(key, value)?;
        }
    }
    // Attributes outrank `core.autocrlf`: a user-supplied package may carry a
    // `.gitattributes` with `* text=auto` or `eol=crlf`, and `ident` rewrites
    // `$Id$`. `.git/info/attributes` takes precedence over in-tree files.
    let attributes = repo.path().join("info/attributes");
    if std::fs::read_to_string(&attributes)
        .map(|current| current.lines().any(|line| line.trim() == PINNED_ATTRIBUTES))
        .unwrap_or(false)
    {
        return Ok(());
    }
    std::fs::create_dir_all(repo.path().join("info"))
        .map_err(|error| git2::Error::from_str(&error.to_string()))?;
    let mut current = std::fs::read_to_string(&attributes).unwrap_or_default();
    if !current.is_empty() && !current.ends_with('\n') {
        current.push('\n');
    }
    current.push_str(PINNED_ATTRIBUTES);
    current.push('\n');
    std::fs::write(&attributes, current).map_err(|error| git2::Error::from_str(&error.to_string()))
}

/// Disables every content filter for all paths (see `pin_repository_config`).
const PINNED_ATTRIBUTES: &str = "* -text -ident";

/// `git2::Repository::init` plus the pinned configuration. Use it wherever a
/// Skill history is created or written to.
pub(crate) fn init_repository(root: &Path) -> Result<git2::Repository, git2::Error> {
    let repo = git2::Repository::init(root)?;
    pin_repository_config(&repo)?;
    Ok(repo)
}

/// `git2::Repository::open` plus the pinned configuration. Use it before any
/// operation that runs content filters (checkout, index add). Read-only
/// lookups keep using `git2::Repository::open`: CLI read commands guarantee
/// they never modify the repository, so a never-pinned legacy history is
/// upgraded by its next snapshot or restore instead.
pub(crate) fn open_repository(root: &Path) -> Result<git2::Repository, git2::Error> {
    let repo = git2::Repository::open(root)?;
    pin_repository_config(&repo)?;
    Ok(repo)
}

#[cfg(test)]
thread_local! {
    /// Number of full-history normalizations performed **on this thread**.
    /// Tests use it to pin that one list read normalizes a Skill's history
    /// exactly once; being thread-local, parallel tests cannot disturb it.
    pub(crate) static NORMALIZE_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The normalized history of one repository at one HEAD, computed once per
/// read. Every derived view (`saved_current`, `current`, the version list)
/// reads it instead of walking the history again. It is request-scoped: it is
/// never stored across reads, so nothing can authorize a write from a stale
/// view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NormalizedView {
    pub(crate) metadata: VersionMetadata,
    pub(crate) head: Option<String>,
}

pub(crate) fn normalized_view(root: &Path, metadata: &VersionMetadata) -> Option<NormalizedView> {
    let mut normalized = metadata.clone();
    normalize_history(root, &mut normalized).ok()?;
    Some(NormalizedView {
        metadata: normalized,
        head: head(root),
    })
}

pub(crate) fn current(root: &Path, metadata: &VersionMetadata) -> Option<CommitVersion> {
    let saved = saved_current(root, metadata)?;
    current_from_saved(root, saved)
}

/// `saved` is the mapped version of HEAD; it is current only while the working
/// tree still carries exactly that content.
pub(crate) fn current_from_saved(root: &Path, saved: CommitVersion) -> Option<CommitVersion> {
    let (actual, _) = local_identity(root, Some(&saved.content.executable_paths)).ok()?;
    (actual == saved.content).then_some(saved)
}

/// The version of the saved HEAD; an external working-copy edit does not
/// change its label. Callers must keep dirty state separate from this view.
pub(crate) fn saved_current(root: &Path, metadata: &VersionMetadata) -> Option<CommitVersion> {
    saved_current_in(root, &normalized_view(root, metadata)?)
}

pub(crate) fn saved_current_in(root: &Path, view: &NormalizedView) -> Option<CommitVersion> {
    let normalized = &view.metadata;
    let hash = view.head.clone()?;
    if normalized.history_reviews.contains_key(&hash) {
        return None;
    }
    if let Some(mapped) = normalized.commits.get(&hash) {
        return Some(mapped.clone());
    }
    // A sync/restore operation can carry content that already has a local
    // version. Its message is not a version, and matching bytes do not prove a
    // receipt or formal UUID. Only reuse the local label along this lineage.
    // The lineage starts at the view's HEAD, never at whatever the repository
    // points to now: one view describes exactly one HEAD.
    let repo = git2::Repository::open(root).ok()?;
    let mut commit = repo.find_commit(git2::Oid::from_str(&hash).ok()?).ok()?;
    let content = commit_content(&repo, &commit).ok()?;
    while commit.parent_count() == 1 {
        commit = commit.parent(0).ok()?;
        let hash = commit.id().to_string();
        if normalized.history_reviews.contains_key(&hash) {
            continue;
        }
        if let Some(mapped) = normalized
            .commits
            .get(&hash)
            .filter(|m| m.content == content)
        {
            let mut local = mapped.clone();
            local.receipt = None;
            local.formal_version_id = None;
            local.pending = None;
            return Some(local);
        }
    }
    None
}

pub(crate) fn remember_receipts(metadata: &mut VersionMetadata) {
    for (hash, mapping) in &metadata.commits {
        if let Some(receipt) = &mapping.receipt {
            metadata.receipt_history.insert(
                receipt.receipt_id.clone(),
                ReceiptCommit {
                    git_hash: hash.clone(),
                    mapping: mapping.clone(),
                },
            );
        }
    }
}

pub(crate) fn history_for_hash(metadata: &VersionMetadata, hash: &str) -> Vec<CommitVersion> {
    if metadata.history_reviews.contains_key(hash) {
        return Vec::new();
    }
    let mut result: Vec<CommitVersion> = metadata
        .receipt_history
        .values()
        .filter(|entry| entry.git_hash == hash)
        .map(|entry| entry.mapping.clone())
        .collect();
    if let Some(mapped) = metadata.commits.get(hash) {
        if !result.iter().any(|old| {
            old.receipt.as_ref().map(|r| &r.receipt_id)
                == mapped.receipt.as_ref().map(|r| &r.receipt_id)
        }) {
            result.push(mapped.clone());
        }
    }
    result
}

pub(crate) fn commit_content(
    repo: &git2::Repository,
    commit: &git2::Commit<'_>,
) -> Result<ContentIdentity, String> {
    tree_content(repo, &commit.tree().map_err(|e| e.to_string())?)
}

pub(crate) fn tree_content(
    repo: &git2::Repository,
    tree: &git2::Tree<'_>,
) -> Result<ContentIdentity, String> {
    fn collect(
        repo: &git2::Repository,
        tree: &git2::Tree<'_>,
        prefix: &str,
        files: &mut Vec<(String, Vec<u8>)>,
        executables: &mut Vec<String>,
    ) -> Result<(), String> {
        for entry in tree.iter() {
            let name = entry.name().map_err(|_| "历史路径不是 UTF-8")?;
            let path = if prefix.is_empty() {
                name.into()
            } else {
                format!("{prefix}/{name}")
            };
            if name == ".skillhub.json"
                || path.starts_with(".skillhub/")
                || crate::commands::should_skip(Path::new(&path))
            {
                continue;
            }
            match entry.kind() {
                Some(git2::ObjectType::Tree) => collect(
                    repo,
                    &repo.find_tree(entry.id()).map_err(|e| e.to_string())?,
                    &path,
                    files,
                    executables,
                )?,
                Some(git2::ObjectType::Blob) if entry.filemode() != 0o120000 => {
                    files.push((
                        path.clone(),
                        repo.find_blob(entry.id())
                            .map_err(|e| e.to_string())?
                            .content()
                            .to_vec(),
                    ));
                    if entry.filemode() == 0o100755 {
                        executables.push(path);
                    }
                }
                _ => return Err("历史内容含不安全的符号链接或子模块".into()),
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    let mut executable_paths = Vec::new();
    collect(repo, tree, "", &mut files, &mut executable_paths)?;
    executable_paths.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    Ok(ContentIdentity {
        content_hash: content_hash(&files),
        executable_paths,
    })
}

fn historical_label(message: &str) -> Option<&str> {
    if let Some(value) = message
        .lines()
        .find_map(|line| line.strip_prefix("SkillHub-Version: "))
    {
        return ordinal(value).map(|_| value);
    }
    let value = message.lines().next()?.split(" · ").next()?;
    let numeric = value
        .strip_prefix('v')
        .unwrap_or(value)
        .split("-personal.")
        .next()?;
    let parts = numeric.split('.').collect::<Vec<_>>();
    (parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
    .then_some(value)
}

/// Sibling histories have no version order; shared ancestors predate the fork.
/// Linear snapshot histories need no reachability queries. The ceiling for
/// merge-rich imports is history × merge-parent graph queries; if that grows
/// costly, cache ancestor sets per parent instead of truncating history or
/// guessing order from commit timestamps.
fn ambiguous_history(
    repo: &git2::Repository,
    history: &[git2::Oid],
) -> Result<BTreeSet<git2::Oid>, String> {
    let mut ambiguous = BTreeSet::new();
    for oid in history {
        let commit = repo.find_commit(*oid).map_err(|e| e.to_string())?;
        if commit.parent_count() <= 1 {
            continue;
        }
        ambiguous.insert(*oid);
        let parents: Vec<_> = commit.parent_ids().collect();
        for ancestor in history {
            let mut count = 0;
            for parent in &parents {
                if parent == ancestor
                    || repo
                        .graph_descendant_of(*parent, *ancestor)
                        .map_err(|e| e.to_string())?
                {
                    count += 1;
                }
            }
            if count > 0 && count < parents.len() {
                ambiguous.insert(*ancestor);
            }
        }
    }
    Ok(ambiguous)
}

/// Scan every immutable record; unresolvable ones stay unnumbered for review.
pub(crate) fn normalize_history(
    root: &Path,
    metadata: &mut VersionMetadata,
) -> Result<bool, String> {
    #[cfg(test)]
    NORMALIZE_CALLS.with(|calls| calls.set(calls.get() + 1));
    let Ok(repo) = git2::Repository::open(root) else {
        return Ok(false);
    };
    if repo.head().is_err() {
        return Ok(false);
    }
    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE)
        .map_err(|e| e.to_string())?;
    walk.push_head().map_err(|e| e.to_string())?;
    let history: Vec<_> = walk.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    let ambiguous = ambiguous_history(&repo, &history)?;
    let before = metadata.clone();
    for oid in history {
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let hash = commit.id().to_string();
        if let Some(existing) = metadata.commits.get(&hash) {
            metadata.high_water = metadata
                .high_water
                .max(ordinal(&existing.label).unwrap_or(-1));
        }
        let original = historical_label(commit.message().unwrap_or(""));
        let content = commit_content(&repo, &commit);
        let review = if ambiguous.contains(&oid) {
            Some("版本历史有分支歧义，请核对完整父子历史".to_string())
        } else {
            content.as_ref().err().cloned()
        };
        if let Some(review) = review {
            if let Some(value) = original.and_then(|s| ordinal(s.strip_prefix('v').unwrap_or(s))) {
                metadata.high_water = metadata.high_water.max(value);
            }
            metadata.history_reviews.insert(hash, review);
            continue;
        }
        if metadata.commits.contains_key(&hash) {
            continue;
        }
        let Some(original) = original else {
            continue;
        };
        let content = content?;
        let canonical = original.strip_prefix('v').unwrap_or(original);
        let candidate = match ordinal(canonical)
            .filter(|v| *v > metadata.high_water)
            .map(label)
            .transpose()?
        {
            Some(label) => label,
            None => match allocate(metadata.high_water, None) {
                Ok(candidate) => candidate,
                Err(error) => {
                    metadata.history_reviews.insert(hash, error);
                    continue;
                }
            },
        };
        metadata.high_water = metadata.high_water.max(ordinal(&candidate).unwrap_or(-1));
        metadata.commits.insert(
            hash,
            CommitVersion {
                label: candidate,
                original_label: original.into(),
                content,
                receipt: None,
                formal_version_id: None,
                pending: None,
            },
        );
    }
    Ok(before != *metadata)
}

pub(crate) fn pending_for(
    root: &Path,
    metadata: &VersionMetadata,
    content: &ContentIdentity,
    card: &str,
) -> Option<VersionIntent> {
    let hash = head(root)?;
    let mapped = metadata.commits.get(&hash)?;
    if &mapped.content != content {
        return None;
    }
    let mut intent = mapped.pending.clone()?;
    if let VersionIntent::Save { card_sha256, .. } = &mut intent {
        *card_sha256 = card.into();
    }
    Some(intent)
}

pub(crate) fn accept(
    root: &Path,
    metadata: &mut VersionMetadata,
    account: &str,
    entry: &str,
    remote: &RemoteVersion,
    accepted: Option<&VersionReceipt>,
    identity: Option<&ContentIdentity>,
) -> Result<(), String> {
    if remote.version_policy != Some(1) {
        return Ok(());
    }
    if metadata
        .account_id
        .as_deref()
        .is_some_and(|id| id != account)
        || metadata.entry_id.as_deref().is_some_and(|id| id != entry)
    {
        for mapped in metadata.commits.values_mut() {
            mapped.receipt = None;
            mapped.pending = None;
        }
        metadata.receipt_history.clear();
        metadata.source_cards.clear();
    }
    metadata.account_id = Some(account.into());
    metadata.entry_id = Some(entry.into());
    metadata.high_water = metadata
        .high_water
        .max(remote.version_high_water.unwrap_or(-1));
    metadata.mapping_digest = remote.version_mapping_digest.clone();
    remember_receipts(metadata);
    let current_hash = head(root);
    for receipt in accepted.into_iter().chain(remote.version.as_ref()) {
        if ordinal(&receipt.label).is_none() || uuid::Uuid::parse_str(&receipt.receipt_id).is_err()
        {
            return Err("Server 版本收据无效".into());
        }
        metadata.high_water = metadata
            .high_water
            .max(ordinal(&receipt.label).unwrap_or(-1));
        for (hash, mapped) in &mut metadata.commits {
            let by_request = matches!(&mapped.pending, Some(VersionIntent::Save { request_id, .. }) if request_id == &receipt.receipt_id);
            let by_identity = current_hash.as_ref() == Some(hash)
                && remote.version.as_ref() == Some(receipt)
                && identity == Some(&mapped.content);
            let by_receipt = mapped
                .receipt
                .as_ref()
                .is_some_and(|old| old.receipt_id == receipt.receipt_id);
            let formal_matches = match &mapped.pending {
                Some(VersionIntent::Formal { version_id }) => {
                    receipt.formal_version_id.as_ref() == Some(version_id)
                }
                _ => true,
            };
            if (by_request || by_identity || by_receipt) && formal_matches {
                mapped.label = receipt.label.clone();
                mapped.receipt = Some(receipt.clone());
                mapped.formal_version_id = receipt.formal_version_id.clone();
                mapped.pending = None;
            }
        }
    }
    metadata.current_receipt = remote.version.clone().filter(|receipt| {
        identity.is_some_and(|expected| {
            local_identity(root, Some(&expected.executable_paths))
                .is_ok_and(|(current, _)| &current == expected)
        }) && remote
            .version
            .as_ref()
            .is_some_and(|v| v.card_sha256 == receipt.card_sha256)
            && current_hash
                .as_ref()
                .and_then(|h| metadata.commits.get(h))
                .is_none_or(|m| match &m.pending {
                    Some(VersionIntent::Formal { version_id }) => {
                        receipt.formal_version_id.as_ref() == Some(version_id)
                    }
                    _ => true,
                })
    });
    if let (Some(hash), Some(receipt), Some(content)) =
        (head(root), &metadata.current_receipt, identity)
    {
        metadata
            .commits
            .entry(hash)
            .or_insert_with(|| CommitVersion {
                label: receipt.label.clone(),
                original_label: String::new(),
                content: content.clone(),
                receipt: Some(receipt.clone()),
                formal_version_id: receipt.formal_version_id.clone(),
                pending: None,
            });
    }
    remember_receipts(metadata);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{
        create_numbered_snapshot_at, ensure_current_local_version_at, library_snapshot_at,
        library_write_profile, restore_skill_version_at_path, save_snapshot_with_version_at,
    };
    use std::fs;

    #[test]
    fn saved_identity_uses_the_same_generated_and_private_file_rules_as_the_package() {
        let (home, root) = fixture();
        fs::write(root.join("SKILL.md"), "# saved\n").unwrap();
        library_snapshot_at(&root, "v0.1.0 · first").unwrap();
        fs::create_dir(root.join("__pycache__")).unwrap();
        fs::write(
            root.join("__pycache__/generated.pyc"),
            "fixture generated bytes",
        )
        .unwrap();
        fs::write(root.join(".DS_Store"), "fixture generated bytes").unwrap();
        // Historical repositories may predate today's excludes. Commit their
        // ignored files explicitly without exposing or depending on env values.
        let repo = git2::Repository::open(&root).unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        let parent_tree = parent.tree().unwrap();
        let mut cache = repo.treebuilder(None).unwrap();
        cache
            .insert(
                "generated.pyc",
                repo.blob(b"fixture generated bytes").unwrap(),
                0o100644,
            )
            .unwrap();
        let mut builder = repo.treebuilder(Some(&parent_tree)).unwrap();
        builder
            .insert("__pycache__", cache.write().unwrap(), 0o040000)
            .unwrap();
        builder
            .insert(
                ".DS_Store",
                repo.blob(b"fixture generated bytes").unwrap(),
                0o100644,
            )
            .unwrap();
        let tree_id = builder.write().unwrap();
        drop(builder);
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Fixture", "fixture@local").unwrap();
        let hash = repo
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "从账号同步",
                &tree,
                &[&parent],
            )
            .unwrap();
        let commit = repo.find_commit(hash).unwrap();
        assert_eq!(
            commit_content(&repo, &commit).unwrap(),
            local_identity(&root, None).unwrap().0
        );
        let saved = current(&root, &VersionMetadata::default()).unwrap();
        assert_eq!(saved.label, "0.1.0");
        assert!(saved.receipt.is_none());
        drop(commit);
        drop(tree);
        drop(parent_tree);
        drop(parent);
        drop(cache);
        drop(repo);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn sync_carrier_reuses_exact_saved_ancestor_label_without_claiming_its_formal_identity() {
        let (home, root) = fixture();
        let _lock = crate::skill_lock::lock_skill_dir_at(
            &home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            }),
            "demo",
        )
        .unwrap();
        let mut profile = crate::SkillHubProfile::default();
        fs::write(root.join("SKILL.md"), "# first\n").unwrap();
        create_numbered_snapshot_at(&root, &mut profile, "0.1.0", "auto", "first").unwrap();
        let first = head(&root).unwrap();
        let receipt = VersionReceipt {
            receipt_id: uuid::Uuid::new_v4().to_string(),
            label: "0.1.0".into(),
            card_sha256: "fixture-card".into(),
            formal_version_id: Some(uuid::Uuid::new_v4().to_string()),
            formal_label: Some("0.1.0".into()),
        };
        let mapping = profile.version_metadata.commits.get_mut(&first).unwrap();
        mapping.receipt = Some(receipt.clone());
        mapping.formal_version_id = receipt.formal_version_id.clone();
        mapping.pending = None;
        fs::write(root.join("SKILL.md"), "# different\n").unwrap();
        create_numbered_snapshot_at(&root, &mut profile, "0.2.0", "manual", "different").unwrap();
        fs::write(root.join("SKILL.md"), "# first\n").unwrap();
        library_snapshot_at(&root, "从账号同步 [fixture operation]").unwrap();
        let carrier = head(&root).unwrap();
        let before = fs::read(root.join(".skillhub.json")).unwrap();
        let inherited = current(&root, &profile.version_metadata).unwrap();
        assert_eq!(inherited.label, "0.1.0");
        assert!(
            inherited.receipt.is_none()
                && inherited.formal_version_id.is_none()
                && inherited.pending.is_none()
        );
        assert_eq!(fs::read(root.join(".skillhub.json")).unwrap(), before);
        ensure_current_local_version_at(&root, &mut profile).unwrap();
        assert_eq!(head(&root), Some(carrier.clone()));
        assert_eq!(profile.version_metadata.high_water, 20);
        assert_eq!(
            profile.version_metadata.commits[&first].receipt.as_ref(),
            Some(&receipt)
        );
        assert_eq!(profile.version_metadata.commits[&carrier].label, "0.1.0");
        assert!(profile.version_metadata.commits[&carrier].receipt.is_none());
        let metadata = profile.version_metadata.clone();
        let persisted = fs::read(root.join(".skillhub.json")).unwrap();
        ensure_current_local_version_at(&root, &mut profile).unwrap();
        assert_eq!(profile.version_metadata, metadata);
        assert_eq!(fs::read(root.join(".skillhub.json")).unwrap(), persisted);
        drop(_lock);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn safe_first_sync_head_gets_a_real_local_number_once_even_with_existing_policy() {
        let (home, root) = fixture();
        let _lock = crate::skill_lock::lock_skill_dir_at(
            &home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            }),
            "demo",
        )
        .unwrap();
        fs::write(root.join("SKILL.md"), "# downloaded\n").unwrap();
        library_snapshot_at(&root, "从账号同步 [first download]").unwrap();
        let carrier = head(&root).unwrap();
        let mut profile = crate::SkillHubProfile::default();
        assert_eq!(profile.version_metadata.policy, 1);
        ensure_current_local_version_at(&root, &mut profile).unwrap();
        let saved = current(&root, &profile.version_metadata).unwrap();
        assert_eq!(saved.label, "0.1.0");
        assert!(saved.pending.is_none());
        assert!(saved.receipt.is_none());
        assert_eq!(head(&root), Some(carrier.clone()));
        let metadata = profile.version_metadata.clone();
        ensure_current_local_version_at(&root, &mut profile).unwrap();
        assert_eq!(profile.version_metadata, metadata);
        save_snapshot_with_version_at(&root, &mut profile, "explicit save", None, Some("auto"))
            .unwrap();
        let saved = current(&root, &profile.version_metadata).unwrap();
        assert!(
            matches!(&saved.pending, Some(VersionIntent::Save { allocation, .. }) if allocation == "auto")
        );
        assert_eq!(saved.label, "0.1.0");
        assert_eq!(profile.version_metadata.high_water, 10);
        assert_eq!(head(&root), Some(carrier));
        let request_id = match saved.pending.as_ref().unwrap() {
            VersionIntent::Save { request_id, .. } => request_id.clone(),
            _ => panic!("expected explicit save"),
        };
        let receipt = VersionReceipt {
            receipt_id: request_id,
            label: "0.2.0".into(),
            card_sha256: "fixture-card".into(),
            formal_version_id: None,
            formal_label: None,
        };
        accept(
            &root,
            &mut profile.version_metadata,
            "fixture-account",
            "fixture-entry",
            &RemoteVersion {
                version_policy: Some(1),
                version_high_water: Some(20),
                version_mapping_digest: None,
                version: Some(receipt.clone()),
            },
            Some(&receipt),
            Some(&saved.content),
        )
        .unwrap();
        let confirmed = current(&root, &profile.version_metadata).unwrap();
        assert_eq!(confirmed.receipt, Some(receipt));
        assert_eq!(confirmed.label, "0.2.0");
        assert!(confirmed.pending.is_none());
        assert_eq!(profile.version_metadata.high_water, 20);
        drop(_lock);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn initializing_saved_head_does_not_snapshot_or_number_a_dirty_working_copy() {
        let (home, root) = fixture();
        let _lock = crate::skill_lock::lock_skill_dir_at(
            &home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            }),
            "demo",
        )
        .unwrap();
        fs::write(root.join("SKILL.md"), "# saved\n").unwrap();
        library_snapshot_at(&root, "自由操作说明").unwrap();
        let carrier = head(&root).unwrap();
        fs::write(root.join("SKILL.md"), "# unsaved edit\n").unwrap();
        let mut profile = crate::SkillHubProfile::default();
        ensure_current_local_version_at(&root, &mut profile).unwrap();
        assert_eq!(
            saved_current(&root, &profile.version_metadata)
                .unwrap()
                .label,
            "0.1.0"
        );
        assert!(current(&root, &profile.version_metadata).is_none());
        assert_eq!(head(&root), Some(carrier));
        assert_eq!(
            fs::read_to_string(root.join("SKILL.md")).unwrap(),
            "# unsaved edit\n"
        );
        drop(_lock);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn safe_skill_without_git_is_initialized_and_exhaustion_never_fakes_a_version() {
        let (home, root) = fixture();
        let _lock = crate::skill_lock::lock_skill_dir_at(
            &home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            }),
            "demo",
        )
        .unwrap();
        fs::write(root.join("SKILL.md"), "# new\n").unwrap();
        let mut profile = crate::SkillHubProfile::default();
        ensure_current_local_version_at(&root, &mut profile).unwrap();
        assert_eq!(
            current(&root, &profile.version_metadata).unwrap().label,
            "0.1.0"
        );
        fs::write(root.join("SKILL.md"), "# other saved content\n").unwrap();
        library_snapshot_at(&root, "同步新的未编号内容").unwrap();
        profile.version_metadata.high_water = 999;
        let persisted = fs::read(root.join(".skillhub.json")).unwrap();
        let carrier = head(&root);
        assert!(ensure_current_local_version_at(&root, &mut profile)
            .unwrap_err()
            .contains("VERSION_RANGE_EXHAUSTED"));
        assert_eq!(head(&root), carrier);
        assert_eq!(fs::read(root.join(".skillhub.json")).unwrap(), persisted);
        assert!(current(&root, &profile.version_metadata).is_none());
        drop(_lock);
        fs::remove_dir_all(home).unwrap();
    }

    fn fixture() -> (std::path::PathBuf, std::path::PathBuf) {
        let home =
            std::env::temp_dir().join(format!("skillhub-version-policy-{}", uuid::Uuid::new_v4()));
        let root = home.join(".skillhub/skills/demo");
        fs::create_dir_all(&root).unwrap();
        library_write_profile(&root, &crate::SkillHubProfile::default()).unwrap();
        (home, root)
    }

    #[test]
    fn inherited_autocrlf_cannot_rewrite_snapshot_or_restore_bytes() {
        // Git for Windows ships `core.autocrlf = true` system-wide (#353). The
        // local level wins in libgit2, so an inherited value is simulated by
        // writing it there before SkillHub touches the repository.
        let (home, root) = fixture();
        let raw = git2::Repository::init(&root).unwrap();
        raw.config()
            .unwrap()
            .set_bool("core.autocrlf", true)
            .unwrap();
        drop(raw);
        let mut profile = crate::SkillHubProfile::default();
        fs::write(root.join("SKILL.md"), "# first\nline two\n").unwrap();
        create_numbered_snapshot_at(&root, &mut profile, "0.0.0", "manual", "first").unwrap();
        let first = head(&root).unwrap();
        let pinned = git2::Repository::open(&root).unwrap();
        let config = pinned.config().unwrap();
        assert!(!config.get_bool("core.autocrlf").unwrap());
        assert_eq!(config.get_string("core.eol").unwrap(), "lf");
        drop(config);
        drop(pinned);
        fs::write(root.join("SKILL.md"), "# second\r\nline two\r\n").unwrap();
        create_numbered_snapshot_at(&root, &mut profile, "1.0.0", "manual", "second").unwrap();
        let second = head(&root).unwrap();
        let repo = git2::Repository::open(&root).unwrap();
        let tree_of = |hash: &str| {
            repo.find_commit(git2::Oid::from_str(hash).unwrap())
                .unwrap()
                .tree_id()
        };
        assert_ne!(
            tree_of(&first),
            tree_of(&second),
            "CRLF bytes are a real content change, not normalised away"
        );
        assert!(std::fs::read_to_string(repo.path().join("info/attributes"))
            .unwrap()
            .contains("* -text -ident"));
        drop(repo);
        crate::commands::restore_skill_version_at_path(&root, &first).unwrap();
        assert_eq!(
            fs::read(root.join("SKILL.md")).unwrap(),
            b"# first\nline two\n",
            "restore writes the stored bytes verbatim"
        );
        let restored = crate::commands::library_read_profile(&root).unwrap();
        assert_eq!(
            current(&root, &restored.version_metadata).unwrap().label,
            "0.0.0"
        );
        // Restore leaves HEAD on `second`, so the first snapshot records the
        // restored tree; a second snapshot of identical bytes must then be a
        // no-op instead of re-normalising line endings into a new commit.
        crate::commands::library_snapshot_at(&root, "同步 [restored]").unwrap();
        let after_restore = head(&root).unwrap();
        assert_ne!(after_restore, second);
        crate::commands::library_snapshot_at(&root, "同步 [same bytes]").unwrap();
        assert_eq!(
            head(&root).as_deref(),
            Some(after_restore.as_str()),
            "same bytes stay the same commit"
        );
        assert_eq!(
            fs::read(root.join("SKILL.md")).unwrap(),
            b"# first\nline two\n"
        );
        fs::remove_dir_all(home).unwrap();
    }

    fn record_tree(
        repo: &git2::Repository,
        text: &str,
        note: &str,
        parents: &[git2::Oid],
        extra: Option<(&str, git2::Oid, i32)>,
    ) -> git2::Oid {
        let mut builder = repo.treebuilder(None).unwrap();
        builder
            .insert("SKILL.md", repo.blob(text.as_bytes()).unwrap(), 0o100644)
            .unwrap();
        if let Some((name, id, mode)) = extra {
            builder.insert(name, id, mode).unwrap();
        }
        let tree = repo.find_tree(builder.write().unwrap()).unwrap();
        let commits: Vec<_> = parents
            .iter()
            .map(|id| repo.find_commit(*id).unwrap())
            .collect();
        let references: Vec<_> = commits.iter().collect();
        let signature = git2::Signature::now("fixture", "fixture@example.invalid").unwrap();
        let id = repo
            .commit(None, &signature, &signature, note, &tree, &references)
            .unwrap();
        repo.set_head_detached(id).unwrap();
        id
    }

    #[test]
    fn pending_save_can_change_allocation_or_label_without_rewriting_git_or_reusing_request_id() {
        let (home, root) = fixture();
        let _lock = crate::skill_lock::lock_skill_dir_at(
            &home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            }),
            "demo",
        )
        .unwrap();
        fs::write(root.join("SKILL.md"), "# same content\n").unwrap();
        let mut profile = crate::SkillHubProfile::default();
        save_snapshot_with_version_at(
            &root,
            &mut profile,
            "original note",
            Some("0.1.0"),
            Some("manual"),
        )
        .unwrap();
        let hash = head(&root).unwrap();
        let original = profile.version_metadata.commits[&hash]
            .pending
            .clone()
            .unwrap();
        save_snapshot_with_version_at(
            &root,
            &mut profile,
            "same request",
            Some("0.1.0"),
            Some("manual"),
        )
        .unwrap();
        assert_eq!(
            profile.version_metadata.commits[&hash].pending.as_ref(),
            Some(&original)
        );
        // Switching a rejected hand-written number to auto can keep its
        // original candidate; the Server may advance it past its high-water.
        save_snapshot_with_version_at(
            &root,
            &mut profile,
            "retry auto",
            Some("0.1.0"),
            Some("auto"),
        )
        .unwrap();
        let automatic = profile.version_metadata.commits[&hash]
            .pending
            .clone()
            .unwrap();
        assert_ne!(automatic, original);
        assert!(
            matches!(&automatic, VersionIntent::Save { allocation, label, .. } if allocation == "auto" && label == "0.1.0")
        );
        save_snapshot_with_version_at(
            &root,
            &mut profile,
            "retry auto",
            Some("0.1.0"),
            Some("auto"),
        )
        .unwrap();
        assert_eq!(
            profile.version_metadata.commits[&hash].pending.as_ref(),
            Some(&automatic)
        );
        let disk = fs::read(root.join(".skillhub.json")).unwrap();
        assert!(save_snapshot_with_version_at(
            &root,
            &mut profile,
            "bad",
            Some("0.0.9"),
            Some("manual")
        )
        .unwrap_err()
        .starts_with("VERSION_LABEL_CONFLICT"));
        assert_eq!(fs::read(root.join(".skillhub.json")).unwrap(), disk);
        save_snapshot_with_version_at(
            &root,
            &mut profile,
            "new manual",
            Some("0.2.0"),
            Some("manual"),
        )
        .unwrap();
        assert_eq!(profile.version_metadata.high_water, 20);
        assert_eq!(
            profile.version_metadata.commits[&hash].original_label,
            "0.1.0"
        );
        assert_ne!(
            profile.version_metadata.commits[&hash].pending.as_ref(),
            Some(&automatic)
        );
        assert_eq!(head(&root), Some(hash.clone()));
        let repo = git2::Repository::open(&root).unwrap();
        assert_eq!(
            repo.find_commit(git2::Oid::from_str(&hash).unwrap())
                .unwrap()
                .message()
                .unwrap(),
            "original note\n\nSkillHub-Version: 0.1.0"
        );
        let confirmed = VersionReceipt {
            receipt_id: uuid::Uuid::new_v4().to_string(),
            label: "0.2.0".into(),
            card_sha256: "a".repeat(64),
            formal_version_id: None,
            formal_label: None,
        };
        profile
            .version_metadata
            .commits
            .get_mut(&hash)
            .unwrap()
            .receipt = Some(confirmed);
        profile
            .version_metadata
            .commits
            .get_mut(&hash)
            .unwrap()
            .pending = None;
        assert!(save_snapshot_with_version_at(
            &root,
            &mut profile,
            "relabel accepted",
            Some("0.3.0"),
            Some("manual")
        )
        .is_err());
        assert_eq!(head(&root), Some(hash));
        drop(repo);
        drop(_lock);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn unsafe_history_is_retained_for_review_while_safe_current_content_can_be_saved() {
        let (home, root) = fixture();
        let _lock = crate::skill_lock::lock_skill_dir_at(
            &home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            }),
            "demo",
        )
        .unwrap();
        let repo = git2::Repository::init(&root).unwrap();
        let first = record_tree(&repo, "# first\n", "v0.1.0", &[], None);
        let link = repo.blob(b"outside").unwrap();
        let unsafe_link = record_tree(
            &repo,
            "# first\n",
            "v0.1.1",
            &[first],
            Some(("linked", link, 0o120000)),
        );
        let unsafe_module = record_tree(
            &repo,
            "# first\n",
            "v0.1.2",
            &[unsafe_link],
            Some(("submodule", first, 0o160000)),
        );
        fs::write(root.join("SKILL.md"), "# repaired\n").unwrap();
        let mut profile = crate::SkillHubProfile::default();
        assert!(normalize_history(&root, &mut profile.version_metadata).unwrap());
        assert_eq!(profile.version_metadata.commits.len(), 1);
        assert_eq!(profile.version_metadata.history_reviews.len(), 2);
        assert_eq!(profile.version_metadata.high_water, 12);
        assert!(history_for_hash(&profile.version_metadata, &unsafe_link.to_string()).is_empty());
        save_snapshot_with_version_at(&root, &mut profile, "safe repair", None, Some("auto"))
            .unwrap();
        assert_eq!(profile.version, "0.1.3");
        let saved = head(&root).unwrap();
        assert_ne!(saved, unsafe_module.to_string());
        assert!(commit_content(
            &repo,
            &repo
                .find_commit(git2::Oid::from_str(&saved).unwrap())
                .unwrap()
        )
        .is_ok());
        assert!(repo.find_commit(unsafe_link).is_ok());
        assert!(repo.find_commit(unsafe_module).is_ok());
        drop(repo);
        drop(_lock);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn merge_siblings_are_not_numbered_in_arbitrary_topological_order() {
        let (home, root) = fixture();
        let repo = git2::Repository::init(&root).unwrap();
        let common = record_tree(&repo, "# common\n", "v0.1.0", &[], None);
        let left = record_tree(&repo, "# left\n", "v0.1.1", &[common], None);
        let right = record_tree(&repo, "# right\n", "v0.1.1", &[common], None);
        let merge = record_tree(&repo, "# merged\n", "v0.1.2", &[left, right], None);
        let later = record_tree(&repo, "# later\n", "v0.1.3", &[merge], None);
        fs::write(root.join("SKILL.md"), "# later\n").unwrap();
        let mut metadata = VersionMetadata::default();
        normalize_history(&root, &mut metadata).unwrap();
        assert_eq!(metadata.commits.len(), 2);
        assert_eq!(metadata.commits[&common.to_string()].label, "0.1.0");
        assert_eq!(metadata.commits[&later.to_string()].label, "0.1.3");
        assert_eq!(metadata.history_reviews.len(), 3);
        for id in [left, right, merge] {
            assert!(metadata.history_reviews.contains_key(&id.to_string()));
            assert!(!metadata.commits.contains_key(&id.to_string()));
        }
        assert_eq!(metadata.high_water, 13);
        assert!(!normalize_history(&root, &mut metadata).unwrap());
        assert_eq!(current(&root, &metadata).unwrap().label, "0.1.3");
        assert_eq!(head(&root), Some(later.to_string()));
        // The ambiguous merge itself cannot be numbered as an unchanged
        // snapshot, but a safe new child carrying edited content can be.
        repo.set_head_detached(merge).unwrap();
        fs::write(root.join("SKILL.md"), "# merged\n").unwrap();
        let mut profile = crate::SkillHubProfile {
            version_metadata: metadata,
            ..Default::default()
        };
        assert!(save_snapshot_with_version_at(
            &root,
            &mut profile,
            "unchanged merge",
            None,
            Some("auto")
        )
        .is_err());
        assert_eq!(head(&root), Some(merge.to_string()));
        fs::write(root.join("SKILL.md"), "# safe new child\n").unwrap();
        save_snapshot_with_version_at(&root, &mut profile, "safe child", None, Some("auto"))
            .unwrap();
        assert_eq!(profile.version, "0.1.4");
        assert_eq!(profile.version_metadata.history_reviews.len(), 3);
        drop(repo);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn receipt_reading_accepts_future_fields_but_keeps_required_fields_typed() {
        let receipt: VersionReceipt = serde_json::from_value(serde_json::json!({
            "receiptId": uuid::Uuid::new_v4().to_string(), "label":"0.1.0", "cardSha256":"a".repeat(64), "formalVersionId":null, "formalLabel":null, "futureCompatibleField": {"value": 1}
        })).unwrap();
        assert_eq!(receipt.label, "0.1.0");
        assert!(serde_json::from_value::<VersionReceipt>(
            serde_json::json!({"label":"0.1.0", "cardSha256":42})
        )
        .is_err());
    }

    #[test]
    fn offline_history_displays_only_current_matching_save_as_pending() {
        let (home, root) = fixture();
        let _lock = crate::skill_lock::lock_skill_dir_at(
            &home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            }),
            "demo",
        )
        .unwrap();
        let mut profile = crate::SkillHubProfile::default();
        fs::write(root.join("SKILL.md"), "# older\n").unwrap();
        save_snapshot_with_version_at(&root, &mut profile, "older note", None, Some("auto"))
            .unwrap();
        let old = head(&root).unwrap();
        fs::write(root.join("SKILL.md"), "# newer\n").unwrap();
        save_snapshot_with_version_at(&root, &mut profile, "newer note", None, Some("auto"))
            .unwrap();
        let latest = head(&root).unwrap();
        profile.version_metadata.account_id = crate::runtime_env::active_runtime_user_id();
        library_write_profile(&root, &profile).unwrap();
        let versions = crate::commands::git_versions_at_path(&root);
        let old_row = versions
            .iter()
            .find(|v| v.git_hash.as_deref() == Some(&old))
            .unwrap();
        let new_row = versions
            .iter()
            .find(|v| v.git_hash.as_deref() == Some(&latest))
            .unwrap();
        assert_eq!(old_row.version_status, "local");
        assert!(!old_row.is_current);
        assert_eq!(new_row.version_status, "pending");
        assert!(new_row.is_current);
        // Continuing to edit means even the most recent snapshot will not be
        // submitted; it must become a local history row until restored.
        fs::write(root.join("SKILL.md"), "# editing without snapshot\n").unwrap();
        assert!(crate::commands::git_versions_at_path(&root)
            .iter()
            .all(|v| v.version_status == "local"));
        drop(_lock);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn unsafe_current_content_rejects_numbering_until_the_working_tree_is_repaired() {
        let (home, root) = fixture();
        let _lock = crate::skill_lock::lock_skill_dir_at(
            &home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            }),
            "demo",
        )
        .unwrap();
        let repo = git2::Repository::init(&root).unwrap();
        let old = record_tree(
            &repo,
            "# root\n",
            "v0.1.0",
            &[],
            Some(("dangerous", repo.blob(b"../../outside").unwrap(), 0o120000)),
        );
        fs::write(root.join("SKILL.md"), "# root\n").unwrap();
        fs::write(home.join("outside"), "private fixture").unwrap();
        std::os::unix::fs::symlink(home.join("outside"), root.join("dangerous")).unwrap();
        let mut profile = crate::SkillHubProfile::default();
        let original = fs::read(root.join(".skillhub.json")).unwrap();
        assert!(save_snapshot_with_version_at(
            &root,
            &mut profile,
            "must not save",
            None,
            Some("auto")
        )
        .is_err());
        assert_eq!(head(&root), Some(old.to_string()));
        assert_eq!(fs::read(root.join(".skillhub.json")).unwrap(), original);
        fs::remove_file(root.join("dangerous")).unwrap();
        save_snapshot_with_version_at(
            &root,
            &mut profile,
            "safe repaired save",
            None,
            Some("auto"),
        )
        .unwrap();
        assert_eq!(profile.version, "0.1.1");
        assert_ne!(head(&root), Some(old.to_string()));
        assert_eq!(
            fs::read_to_string(home.join("outside")).unwrap(),
            "private fixture"
        );
        drop(repo);
        drop(_lock);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn formal_binding_snapshots_do_not_consume_an_extra_version_number() {
        let (home, root) = fixture();
        let mut metadata = VersionMetadata::default();
        for value in [11, 12] {
            metadata.high_water = value;
            fs::write(root.join("SKILL.md"), format!("# Published {value}\n")).unwrap();
            library_snapshot_at(&root, "补全正式版本记录").unwrap();
            normalize_history(&root, &mut metadata).unwrap();
            assert_eq!(metadata.high_water, value);
            assert_eq!(
                allocate(metadata.high_water, None).unwrap(),
                label(value + 1).unwrap()
            );
        }
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn complete_history_maps_each_real_tree_without_rewriting_objects_or_free_notes() {
        let (home, root) = fixture();
        let mut hashes = Vec::new();
        for value in 10..50 {
            fs::write(root.join("SKILL.md"), format!("# Content {value}\n")).unwrap();
            library_snapshot_at(&root, &format!("v{} · snapshot", label(value).unwrap())).unwrap();
            hashes.push(head(&root).unwrap());
        }
        fs::write(root.join("SKILL.md"), "# Free note\n").unwrap();
        library_snapshot_at(&root, "恢复版本 not-a-version").unwrap();
        let free_head = head(&root).unwrap();
        let mut metadata = VersionMetadata::default();
        assert!(normalize_history(&root, &mut metadata).unwrap());
        assert_eq!(metadata.commits.len(), 40);
        assert_eq!(metadata.high_water, 49);
        assert!(!metadata.commits.contains_key(&free_head));
        assert_eq!(head(&root), Some(free_head));
        let repo = git2::Repository::open(&root).unwrap();
        for (offset, hash) in hashes.iter().enumerate() {
            let commit = repo
                .find_commit(git2::Oid::from_str(hash).unwrap())
                .unwrap();
            let mapped = &metadata.commits[hash];
            assert_eq!(mapped.label, label(10 + offset as i32).unwrap());
            assert_eq!(mapped.content, commit_content(&repo, &commit).unwrap());
            assert!(commit.message().unwrap().starts_with('v'));
        }
        assert!(!normalize_history(&root, &mut metadata).unwrap());
        drop(repo);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn save_noop_restore_and_offline_snapshots_keep_the_high_water() {
        let (home, root) = fixture();
        let mut profile = crate::SkillHubProfile::default();
        fs::write(root.join("SKILL.md"), "# first\n").unwrap();
        create_numbered_snapshot_at(&root, &mut profile, "0.0.0", "manual", "first").unwrap();
        let first = head(&root).unwrap();
        fs::write(root.join("SKILL.md"), "# second\n").unwrap();
        create_numbered_snapshot_at(&root, &mut profile, "1.0.0", "manual", "second").unwrap();
        let second = head(&root).unwrap();
        create_numbered_snapshot_at(&root, &mut profile, "1.0.1", "auto", "same bytes").unwrap();
        assert_eq!(head(&root), Some(second));
        assert_eq!(profile.version_metadata.high_water, 100);
        restore_skill_version_at_path(&root, &first).unwrap();
        let mut restored = crate::commands::library_read_profile(&root).unwrap();
        assert_eq!(restored.version_metadata.high_water, 100);
        assert_eq!(
            current(&root, &restored.version_metadata).unwrap().label,
            "0.0.0"
        );
        assert_eq!(
            allocate(restored.version_metadata.high_water, None).unwrap(),
            "1.0.1"
        );
        crate::commands::library_snapshot_inner(&root, "从账号同步 [restored content]", true)
            .unwrap();
        let operation = head(&root);
        assert_eq!(
            current(&root, &restored.version_metadata).unwrap().label,
            "0.0.0"
        );
        ensure_current_local_version_at(&root, &mut restored).unwrap();
        assert_eq!(head(&root), operation);
        assert_eq!(restored.version_metadata.high_water, 100);
        let local = current(&root, &restored.version_metadata).unwrap();
        assert_eq!(local.label, "0.0.0");
        assert!(local.receipt.is_none() && local.pending.is_none());
        assert!(root
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("version-metadata-backups")
            .is_dir());
        let repo = git2::Repository::open(&root).unwrap();
        assert!(repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap()
            .get_path(Path::new(".skillhub.json"))
            .is_err());
        drop(repo);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn receipt_converges_only_the_saved_commit_and_formal_identity_is_exact() {
        let (home, root) = fixture();
        let mut profile = crate::SkillHubProfile::default();
        fs::write(root.join("SKILL.md"), "# one\n").unwrap();
        create_numbered_snapshot_at(&root, &mut profile, "0.1.0", "auto", "one").unwrap();
        let saved = head(&root).unwrap();
        let request = match &profile.version_metadata.commits[&saved].pending {
            Some(VersionIntent::Save { request_id, .. }) => request_id.clone(),
            _ => panic!(),
        };
        fs::write(root.join("SKILL.md"), "# two\n").unwrap();
        create_numbered_snapshot_at(&root, &mut profile, "0.1.1", "auto", "two").unwrap();
        let newest = head(&root).unwrap();
        let old = VersionReceipt {
            receipt_id: request,
            label: "0.2.0".into(),
            card_sha256: "a".repeat(64),
            formal_version_id: None,
            formal_label: None,
        };
        let remote = RemoteVersion {
            version_policy: Some(1),
            version_high_water: Some(20),
            version_mapping_digest: None,
            version: None,
        };
        accept(
            &root,
            &mut profile.version_metadata,
            "account",
            "entry",
            &remote,
            Some(&old),
            None,
        )
        .unwrap();
        assert_eq!(profile.version_metadata.commits[&saved].label, "0.2.0");
        assert_eq!(profile.version_metadata.commits[&newest].label, "0.1.1");
        assert!(profile.version_metadata.commits[&newest].pending.is_some());
        assert!(profile.version_metadata.current_receipt.is_none());
        let identity = profile.version_metadata.commits[&newest].content.clone();
        profile
            .version_metadata
            .commits
            .get_mut(&newest)
            .unwrap()
            .pending = Some(VersionIntent::Formal {
            version_id: "wanted".into(),
        });
        let unrelated = VersionReceipt {
            receipt_id: uuid::Uuid::new_v4().to_string(),
            formal_version_id: Some("other".into()),
            formal_label: Some("0.1.2".into()),
            ..old
        };
        let remote = RemoteVersion {
            version: Some(unrelated),
            ..remote
        };
        accept(
            &root,
            &mut profile.version_metadata,
            "account",
            "entry",
            &remote,
            None,
            Some(&identity),
        )
        .unwrap();
        assert!(profile.version_metadata.current_receipt.is_none());
        assert!(profile.version_metadata.commits[&newest].pending.is_some());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn fixed_label_vectors_and_intent_json() {
        for (high, next) in [(-1, "0.1.0"), (19, "0.2.0"), (99, "1.0.0"), (199, "2.0.0")] {
            assert_eq!(allocate(high, None).unwrap(), next);
        }
        for invalid in [
            "v0.1.0",
            "0.1.0-personal.1",
            "1.56.1",
            "01.1.0",
            " 0.1.0",
            "0.1",
            "0.1.0\n",
        ] {
            assert!(ordinal(invalid).is_none());
        }
        assert_eq!(allocate(-1, Some("0.0.0")).unwrap(), "0.0.0");
        assert_eq!(allocate(12, Some("9.9.9")).unwrap(), "9.9.9");
        assert!(allocate(999, None).is_err());
        assert!(allocate(12, Some("0.1.2")).is_err());
        let intent = VersionIntent::Save {
            request_id: "id".into(),
            card_sha256: "card".into(),
            allocation: "auto".into(),
            label: "2.3.1".into(),
        };
        assert_eq!(
            serde_json::to_value(intent).unwrap(),
            serde_json::json!({"kind":"save","requestId":"id","cardSha256":"card","allocation":"auto","label":"2.3.1"})
        );
    }
}
