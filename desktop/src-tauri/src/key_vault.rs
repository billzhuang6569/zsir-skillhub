//! Personal key vault (#253).
//!
//! One account-level `KEY=value` store per runtime identity (signed-in
//! account or local guest), keyed by variable name: a value filled once is
//! usable by every Skill that declares the same key.
//!
//! Layout under `~/.skillhub/keys/<runtimeUserId>/` (directory 0700, files 0600):
//! - `vault.env`: the values, same format and decoding rules as the per-Skill
//!   files in `~/.skillhub/envs/<runtimeUserId>/<skill>.env`;
//! - `vault.meta.json`: per key `createdAt / updatedAt / allowedSkills /
//!   autoAllow` plus the account-level `autoAllow` switch (default off);
//! - `vault.usage.json`: per key `lastUsedAt` written by a successful `run`;
//! - `grants/<skill>-<KEY>`: one-shot 「仅这次」 grants, consumed by the next
//!   run and expiring after ten minutes;
//! - `consent-requests/<skill>.json`: keys a `run` was refused for
//!   (`NEEDS_CONSENT`), shown by the APP as a consent dialog;
//! - `vault-migration.json` / `vaultMigrationReport.json`: the one-time
//!   migration marker and its value-free report.
//!
//! The per-Skill files stay as an optional override layer: for the same key
//! an override wins over the vault. Values never leave this module except
//! towards the `run` child process; every listing returns names only.

#[cfg(windows)]
use crate::platform_fs::MetadataExt;
use crate::runtime_env::{
    account_env_path_at, acquire_exclusive_session_lease_at, ensure_private_directory,
    read_private_env_values, read_private_json, read_profile_at, read_session_at, valid_env_key,
    valid_personal_value, validate_skill_id, validate_user_id, write_private_json,
};
use crate::{AcquisitionSource, SkillHubProfile};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use zeroize::Zeroize;

pub(crate) const NEEDS_CONSENT_CODE: &str = "NEEDS_CONSENT";
/// `run` failed because a required key has no value (#292).
pub(crate) const MISSING_KEY_CODE: &str = "MISSING_KEY";
/// `run` failed because several team sources compete for a key (#292).
pub(crate) const NEEDS_CHOICE_CODE: &str = "NEEDS_CHOICE";
const VAULT_STORE_VERSION: u8 = 1;
/// A 「仅这次」 grant is consumed by the next run, or expires after this.
pub(crate) const ONCE_GRANT_TTL_MS: u64 = 10 * 60 * 1000;
/// A refused run's consent request stays visible to the APP this long.
pub(crate) const CONSENT_REQUEST_TTL_MS: u64 = 30 * 60 * 1000;
const MAX_VAULT_KEYS: usize = 1_000;
const MAX_ALLOWED_SKILLS: usize = 10_000;
/// A key's other variable names (#288), e.g. `FAL_API_KEY` for `FAL_KEY`.
pub(crate) const MAX_KEY_ALIASES: usize = 10;

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn keys_root_at(root: &Path) -> PathBuf {
    root.join("keys")
}

pub(crate) fn vault_dir_at(root: &Path, user_id: &str) -> PathBuf {
    keys_root_at(root).join(user_id)
}

pub(crate) fn vault_env_path_at(root: &Path, user_id: &str) -> PathBuf {
    vault_dir_at(root, user_id).join("vault.env")
}

fn vault_meta_path_at(root: &Path, user_id: &str) -> PathBuf {
    vault_dir_at(root, user_id).join("vault.meta.json")
}

fn vault_usage_path_at(root: &Path, user_id: &str) -> PathBuf {
    vault_dir_at(root, user_id).join("vault.usage.json")
}

fn grants_dir_at(root: &Path, user_id: &str) -> PathBuf {
    vault_dir_at(root, user_id).join("grants")
}

fn grant_path_at(root: &Path, user_id: &str, skill_id: &str, key: &str) -> PathBuf {
    // Keys never contain `-`, so `<skill>-<KEY>` splits unambiguously.
    grants_dir_at(root, user_id).join(format!("{skill_id}-{key}"))
}

fn consent_dir_at(root: &Path, user_id: &str) -> PathBuf {
    vault_dir_at(root, user_id).join("consent-requests")
}

fn consent_request_path_at(root: &Path, user_id: &str, skill_id: &str) -> PathBuf {
    consent_dir_at(root, user_id).join(format!("{skill_id}.json"))
}

pub(crate) fn migration_marker_path_at(root: &Path, user_id: &str) -> PathBuf {
    vault_dir_at(root, user_id).join("vault-migration.json")
}

pub(crate) fn migration_report_path_at(root: &Path, user_id: &str) -> PathBuf {
    vault_dir_at(root, user_id).join("vaultMigrationReport.json")
}

fn migration_backup_root_at(root: &Path) -> PathBuf {
    root.join("env-import-backups")
}

fn ensure_vault_dir_at(root: &Path, user_id: &str) -> Result<PathBuf, String> {
    validate_user_id(user_id)?;
    ensure_private_directory(&keys_root_at(root))?;
    let directory = vault_dir_at(root, user_id);
    ensure_private_directory(&directory)?;
    Ok(directory)
}

fn validate_vault_key(key: &str) -> Result<(), String> {
    if !valid_env_key(key) {
        return Err("钥匙名必须为大写字母、数字和下划线".into());
    }
    if is_reserved_variant_name(key) {
        return Err(reserved_name_error(key));
    }
    Ok(())
}

// ── Labelled variants (#306) ────────────────────────────────────────────────
//
// One variable name may hold several values: the first one is the default
// and carries no label; every further value carries a label and a variant id
// `V<n>`. A variant's value lives in `vault.env` under the synthetic name
// `NAME__V<n>` and its metadata (consent, auto-allow, blocked Skills) in
// `VaultMeta.keys["NAME__V<n>"]`. Aliases, the variant list and the default
// pointer live on the entry of the name itself. The synthetic pattern is
// reserved: never a key name, an alias or something a Skill can declare.

/// Labelled values per variable name.
pub(crate) const MAX_KEY_VARIANTS: usize = 20;
/// Characters in a variant label.
pub(crate) const MAX_VARIANT_LABEL_CHARS: usize = 24;

/// Declared name → the value a Skill's policy picked explicitly (#306):
/// `Some(v)` a labelled value, `None` the unlabelled value. Names without an
/// entry follow the default pointer.
pub(crate) type VariantChoices = BTreeMap<String, Option<String>>;

/// `NAME__V<n>` → (`NAME`, `V<n>`): the synthetic entry of a labelled value.
pub(crate) fn split_variant_entry(entry: &str) -> Option<(&str, &str)> {
    let index = entry.rfind("__V")?;
    let base = &entry[..index];
    let variant = &entry[index + 2..];
    let digits = &variant[1..];
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) && valid_env_key(base))
        .then_some((base, variant))
}

/// Matches `^[A-Z][A-Z0-9_]*__V[0-9]+$`, reserved for labelled values.
pub(crate) fn is_reserved_variant_name(name: &str) -> bool {
    split_variant_entry(name).is_some()
}

/// The variable name an identity (`NAME` or `NAME__V<n>`) belongs to.
pub(crate) fn identity_main(identity: &str) -> &str {
    split_variant_entry(identity).map_or(identity, |(base, _)| base)
}

pub(crate) fn variant_entry_name(key: &str, variant: &str) -> String {
    format!("{key}__{variant}")
}

fn reserved_name_error(name: &str) -> String {
    format!("{name} 是带标签钥匙的保留写法，不能用作变量名")
}

fn valid_variant_id(variant: &str) -> bool {
    variant.strip_prefix('V').is_some_and(|digits| {
        !digits.is_empty()
            && digits.len() <= 6
            && !digits.starts_with('0')
            && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

pub(crate) fn validate_variant_id(variant: &str) -> Result<(), String> {
    if valid_variant_id(variant) {
        Ok(())
    } else {
        Err("钥匙标签编号无效".into())
    }
}

fn variant_number(variant: &str) -> u32 {
    variant
        .strip_prefix('V')
        .and_then(|digits| digits.parse().ok())
        .unwrap_or(0)
}

fn valid_variant_label(label: &str) -> bool {
    !label.is_empty()
        && label == label.trim()
        && label.chars().count() <= MAX_VARIANT_LABEL_CHARS
        && !label.chars().any(char::is_control)
}

fn normalize_variant_label(label: &str) -> Result<String, String> {
    let label = label.trim();
    if label.is_empty() {
        return Err("请填写标签，例如「公司」或「个人」".into());
    }
    if label.chars().count() > MAX_VARIANT_LABEL_CHARS {
        return Err(format!("标签最多 {MAX_VARIANT_LABEL_CHARS} 个字"));
    }
    if !valid_variant_label(label) {
        return Err("标签不能包含换行或控制字符".into());
    }
    Ok(label.to_string())
}

/// One labelled value of a variable name.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VariantMeta {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) created_at: u64,
}

/// One entry of a name's switcher: `id`/`label` are `None` for the
/// unlabelled value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyVariantOption {
    pub id: Option<String>,
    pub label: Option<String>,
    pub is_default: bool,
}

// ── Metadata ────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VaultKeyMeta {
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
    /// Local Skill ids allowed to use this key without asking.
    #[serde(default)]
    pub(crate) allowed_skills: Vec<String>,
    /// Any Skill may use this key without asking.
    #[serde(default)]
    pub(crate) auto_allow: bool,
    /// Other variable names this key answers to (#288): a Skill declaring
    /// one of them gets this key's value under the declared name. Only the
    /// user links names; nothing is merged automatically. Left out when
    /// empty so older metadata stays byte-compatible.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) aliases: Vec<String>,
    /// Local Skill ids the user turned this key off for (#294): such a Skill
    /// runs as if the vault had no value for the key (no consent prompt;
    /// its own override still applies). Left out when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) blocked_skills: Vec<String>,
    /// Labelled values of this name (#306); only on the name's own entry.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) variants: Vec<VariantMeta>,
    /// The labelled value used by default; `None`: the unlabelled value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) default_variant: Option<String>,
    /// Highest variant number ever issued, so a deleted id is never reused
    /// (a Skill policy still naming it falls back instead of switching).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub(crate) variant_seq: u32,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

impl VaultKeyMeta {
    fn has_variant(&self, variant: &str) -> bool {
        self.variants.iter().any(|entry| entry.id == variant)
    }

    fn variant_label(&self, variant: &str) -> Option<&str> {
        self.variants
            .iter()
            .find(|entry| entry.id == variant)
            .map(|entry| entry.label.as_str())
    }

    /// The default pointer, when it names an existing variant.
    fn default_variant(&self) -> Option<&str> {
        self.default_variant
            .as_deref()
            .filter(|variant| self.has_variant(variant))
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VaultMeta {
    version: u8,
    /// 「以后不再询问，有能用的就用」: every Skill may use every key.
    #[serde(default)]
    pub(crate) auto_allow: bool,
    #[serde(default)]
    pub(crate) keys: BTreeMap<String, VaultKeyMeta>,
}

impl Default for VaultMeta {
    fn default() -> Self {
        Self {
            version: VAULT_STORE_VERSION,
            auto_allow: false,
            keys: BTreeMap::new(),
        }
    }
}

impl VaultMeta {
    fn allows(&self, skill_id: &str, key: &str) -> bool {
        self.auto_allow
            || self.keys.get(key).is_some_and(|entry| {
                entry.auto_allow || entry.allowed_skills.iter().any(|id| id == skill_id)
            })
    }

    /// The user turned `key` (main name) off for `skill_id` (#294).
    pub(crate) fn blocks(&self, skill_id: &str, key: &str) -> bool {
        self.keys
            .get(key)
            .is_some_and(|entry| entry.blocked_skills.iter().any(|id| id == skill_id))
    }

    /// The key that owns `alias`, if any.
    fn alias_owner(&self, alias: &str) -> Option<&str> {
        self.keys
            .iter()
            .find(|(_, entry)| entry.aliases.iter().any(|name| name == alias))
            .map(|(key, _)| key.as_str())
    }

    fn has_aliases(&self) -> bool {
        self.keys.values().any(|entry| !entry.aliases.is_empty())
    }

    /// Which value of `main` a Skill uses: its explicit choice when that
    /// still exists (`Some(Some(v))` a labelled value, `Some(None)` the
    /// unlabelled one), else the default variant, else the unlabelled value;
    /// the first of those that holds a value (`has_value` checks the
    /// identity). A deleted or unknown choice falls back silently.
    pub(crate) fn choose_identity(
        &self,
        main: &str,
        requested: Option<Option<&str>>,
        has_value: impl Fn(&str) -> bool,
    ) -> Option<String> {
        let entry = self.keys.get(main);
        let mut order = Vec::new();
        if requested == Some(None) {
            order.push(main.to_string());
        }
        if let Some(entry) = entry {
            if let Some(variant) = requested
                .flatten()
                .filter(|variant| entry.has_variant(variant))
            {
                order.push(variant_entry_name(main, variant));
            }
            if let Some(variant) = entry.default_variant() {
                order.push(variant_entry_name(main, variant));
            }
        }
        order.push(main.to_string());
        if let Some(entry) = entry {
            order.extend(
                entry
                    .variants
                    .iter()
                    .map(|variant| variant_entry_name(main, &variant.id)),
            );
        }
        order.into_iter().find(|identity| has_value(identity))
    }

    /// `(variant, label)` behind a synthetic identity; `None` for a name.
    pub(crate) fn identity_variant(&self, identity: &str) -> Option<(String, String)> {
        let (main, variant) = split_variant_entry(identity)?;
        let label = self.keys.get(main)?.variant_label(variant)?;
        Some((variant.to_string(), label.to_string()))
    }

    /// What the user sees for an identity: `FAL_KEY · 公司` or `FAL_KEY`.
    pub(crate) fn display_identity(&self, identity: &str) -> String {
        match self.identity_variant(identity) {
            Some((_, label)) => format!("{} · {label}", identity_main(identity)),
            None => identity.to_string(),
        }
    }

    /// The switcher of `main`: the unlabelled value (when it holds one)
    /// first, then the labelled values in creation order.
    pub(crate) fn variant_options(
        &self,
        main: &str,
        entries: &BTreeSet<String>,
    ) -> Vec<KeyVariantOption> {
        let entry = self.keys.get(main);
        let default = entry.and_then(VaultKeyMeta::default_variant);
        let mut options = Vec::new();
        if entries.contains(main) {
            options.push(KeyVariantOption {
                id: None,
                label: None,
                is_default: default.is_none(),
            });
        }
        if let Some(entry) = entry {
            let mut variants = entry
                .variants
                .iter()
                .filter(|variant| entries.contains(&variant_entry_name(main, &variant.id)))
                .collect::<Vec<_>>();
            variants.sort_by_key(|variant| variant_number(&variant.id));
            options.extend(variants.into_iter().map(|variant| KeyVariantOption {
                id: Some(variant.id.clone()),
                label: Some(variant.label.clone()),
                is_default: default == Some(variant.id.as_str()),
            }));
        }
        // No unlabelled value and a broken pointer: the first one serves.
        if !options.is_empty() && !options.iter().any(|option| option.is_default) {
            if let Some(identity) = self.choose_identity(main, None, |id| entries.contains(id)) {
                let served = split_variant_entry(&identity).map(|(_, variant)| variant);
                for option in &mut options {
                    option.is_default = option.id.as_deref() == served;
                }
            }
        }
        options
    }

    fn allow_skill(&mut self, key: &str, skill_id: &str, now: u64) {
        let entry = self
            .keys
            .entry(key.to_string())
            .or_insert_with(|| VaultKeyMeta {
                created_at: now,
                updated_at: now,
                ..Default::default()
            });
        if !entry.allowed_skills.iter().any(|id| id == skill_id) {
            entry.allowed_skills.push(skill_id.to_string());
            entry.allowed_skills.sort();
        }
        // Allowing a Skill (consent, filling from it) also turns it back on.
        entry.blocked_skills.retain(|id| id != skill_id);
    }
}

pub(crate) fn read_meta_at(root: &Path, user_id: &str) -> Result<VaultMeta, String> {
    validate_user_id(user_id)?;
    let path = vault_meta_path_at(root, user_id);
    if fs::symlink_metadata(&path).is_err() {
        return Ok(VaultMeta::default());
    }
    let meta: VaultMeta =
        read_private_json(&path).map_err(|_| "本机钥匙库元数据无法安全读取".to_string())?;
    if meta.version != VAULT_STORE_VERSION
        || meta.keys.len() > MAX_VAULT_KEYS * (MAX_KEY_VARIANTS + 1)
        || meta.keys.iter().any(|(key, entry)| {
            !valid_env_key(key)
                || !variant_meta_valid(key, entry)
                || entry.allowed_skills.len() > MAX_ALLOWED_SKILLS
                || entry.blocked_skills.len() > MAX_ALLOWED_SKILLS
                || entry
                    .allowed_skills
                    .iter()
                    .chain(&entry.blocked_skills)
                    .any(|skill_id| validate_skill_id(skill_id).is_err())
        })
    {
        return Err("本机钥匙库元数据无效".into());
    }
    if meta.has_aliases() {
        let vault_names = vault_key_names_at(root, user_id)?;
        check_aliases(&meta, &vault_names).map_err(|_| "本机钥匙库元数据无效".to_string())?;
    }
    Ok(meta)
}

/// A synthetic entry carries no aliases or variants of its own; a name's
/// variants have valid, unique ids and labels and the default pointer names
/// one of them.
fn variant_meta_valid(key: &str, entry: &VaultKeyMeta) -> bool {
    if is_reserved_variant_name(key) {
        return entry.aliases.is_empty()
            && entry.variants.is_empty()
            && entry.default_variant.is_none()
            && entry.variant_seq == 0;
    }
    let mut ids = BTreeSet::new();
    let mut labels = BTreeSet::new();
    entry.variants.len() <= MAX_KEY_VARIANTS
        && entry.variants.iter().all(|variant| {
            valid_variant_id(&variant.id)
                && variant_number(&variant.id) <= entry.variant_seq
                && valid_env_key(&variant_entry_name(key, &variant.id))
                && valid_variant_label(&variant.label)
                && ids.insert(variant.id.as_str())
                && labels.insert(variant.label.as_str())
        })
        && entry
            .default_variant
            .as_deref()
            .is_none_or(|variant| entry.has_variant(variant))
}

/// Every alias is a valid name, at most `MAX_KEY_ALIASES` per key, never a
/// main name (in the metadata or the vault) and claimed by one key only: a
/// variable name belongs to at most one key of this owner.
fn check_aliases(meta: &VaultMeta, vault_names: &BTreeSet<String>) -> Result<(), String> {
    let mut owners = BTreeMap::<&str, &str>::new();
    for (key, entry) in &meta.keys {
        if entry.aliases.len() > MAX_KEY_ALIASES {
            return Err(format!("{key} 最多只能有 {MAX_KEY_ALIASES} 个其他变量名"));
        }
        for alias in &entry.aliases {
            if !valid_env_key(alias) {
                return Err("变量名必须为大写字母、数字和下划线".into());
            }
            if is_reserved_variant_name(alias) {
                return Err(reserved_name_error(alias));
            }
            if meta.keys.contains_key(alias) || vault_names.contains(alias) {
                return Err(format!("{alias} 已经是一把钥匙的主名"));
            }
            if let Some(owner) = owners.insert(alias, key) {
                return Err(format!("{alias} 已经是另一把钥匙（{owner}）的变量名"));
            }
        }
    }
    Ok(())
}

fn write_meta_at(root: &Path, user_id: &str, meta: &VaultMeta) -> Result<(), String> {
    ensure_vault_dir_at(root, user_id)?;
    write_private_json(&vault_meta_path_at(root, user_id), meta)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultUsage {
    version: u8,
    #[serde(default)]
    last_used_at: BTreeMap<String, u64>,
}

fn read_usage_at(root: &Path, user_id: &str) -> BTreeMap<String, u64> {
    let path = vault_usage_path_at(root, user_id);
    if fs::symlink_metadata(&path).is_err() {
        return BTreeMap::new();
    }
    read_private_json::<VaultUsage>(&path)
        .ok()
        .filter(|usage| usage.version == VAULT_STORE_VERSION)
        .map(|usage| usage.last_used_at)
        .unwrap_or_default()
}

/// Best effort: a lost timestamp never fails a run.
pub(crate) fn record_vault_usage_at(root: &Path, user_id: &str, keys: &[String], now: u64) {
    if keys.is_empty() || validate_user_id(user_id).is_err() {
        return;
    }
    let mut last_used_at = read_usage_at(root, user_id);
    for key in keys {
        last_used_at.insert(key.clone(), now);
    }
    let _ = ensure_vault_dir_at(root, user_id).and_then(|_| {
        write_private_json(
            &vault_usage_path_at(root, user_id),
            &VaultUsage {
                version: VAULT_STORE_VERSION,
                last_used_at,
            },
        )
    });
}

// ── Values ──────────────────────────────────────────────────────────────────

/// Decoded vault values (optionally only `allowed` keys). The caller zeroizes.
pub(crate) fn read_vault_values_at(
    root: &Path,
    user_id: &str,
    allowed: Option<&BTreeSet<String>>,
) -> Result<BTreeMap<String, String>, String> {
    validate_user_id(user_id)?;
    read_private_env_values(&vault_env_path_at(root, user_id), allowed)
        .map_err(|_| "本机钥匙库无法安全读取，请在 SkillHub APP 的钥匙页检查".to_string())
}

/// Every entry of `vault.env`, synthetic variant entries (`NAME__V<n>`)
/// included. Names only.
pub(crate) fn vault_entry_names_at(root: &Path, user_id: &str) -> Result<BTreeSet<String>, String> {
    let mut values = read_vault_values_at(root, user_id, None)?;
    let keys = values.keys().cloned().collect();
    zeroize_map(&mut values);
    Ok(keys)
}

/// The variable names that hold at least one value (unlabelled or labelled).
/// Synthetic variant entries are never listed as names.
pub(crate) fn vault_key_names_at(root: &Path, user_id: &str) -> Result<BTreeSet<String>, String> {
    Ok(main_names(&vault_entry_names_at(root, user_id)?))
}

fn main_names(entries: &BTreeSet<String>) -> BTreeSet<String> {
    entries
        .iter()
        .map(|entry| identity_main(entry).to_string())
        .collect()
}

/// Every name the vault answers to → the key (main name) that serves it:
/// each main name maps to itself, each alias to its key. Only keys that hold
/// a value are included.
pub(crate) fn vault_lookup_names_at(
    root: &Path,
    user_id: &str,
) -> Result<BTreeMap<String, String>, String> {
    let names = vault_key_names_at(root, user_id)?;
    let meta = read_meta_at(root, user_id)?;
    Ok(lookup_names(&names, &meta))
}

/// [`vault_lookup_names_at`] as seen by `skill_id`: a name is left out when
/// the value this Skill would use (its chosen variant or the default) is
/// turned off for it (#294), as if the vault had no value.
pub(crate) fn vault_lookup_names_for_skill_at(
    root: &Path,
    user_id: &str,
    skill_id: &str,
) -> Result<BTreeMap<String, String>, String> {
    let entries = vault_entry_names_at(root, user_id)?;
    let meta = read_meta_at(root, user_id)?;
    let choices = crate::runtime_env::personal_variant_choices_at(root, user_id, skill_id);
    let mut lookup = lookup_names(&main_names(&entries), &meta);
    lookup.retain(|declared, main| {
        meta.choose_identity(main, choices.get(declared).map(Option::as_deref), |id| {
            entries.contains(id)
        })
        .is_some_and(|identity| !meta.blocks(skill_id, &identity))
    });
    Ok(lookup)
}

/// The vault value a Skill gets for one declared name (#306), names only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VaultServing {
    /// The variable name in the vault (the declared name or its alias owner).
    pub(crate) main: String,
    /// `main` or the synthetic `main__V<n>`: consent, usage and blocks key
    /// off this.
    pub(crate) identity: String,
    pub(crate) variant: Option<String>,
    pub(crate) label: Option<String>,
}

fn serving_for(
    meta: &VaultMeta,
    entries: &BTreeSet<String>,
    names: &BTreeSet<String>,
    skill_id: &str,
    declared: &str,
    choice: Option<Option<&str>>,
) -> Option<VaultServing> {
    if is_reserved_variant_name(declared) {
        return None;
    }
    let main = if names.contains(declared) {
        declared.to_string()
    } else {
        meta.alias_owner(declared)
            .filter(|owner| names.contains(*owner))?
            .to_string()
    };
    let identity = meta.choose_identity(&main, choice, |id| entries.contains(id))?;
    // Turned off for this Skill (#294): as if the vault had no value.
    if meta.blocks(skill_id, &identity) {
        return None;
    }
    let (variant, label) = meta.identity_variant(&identity).unzip();
    Some(VaultServing {
        main,
        identity,
        variant,
        label,
    })
}

/// For each of `declared` (names a Skill declares), the vault value it would
/// get: `choices` maps a declared name to the value its policy picked
/// (`Some(v)` a labelled value, `None` the unlabelled one explicitly).
pub(crate) fn vault_serving_for_skill_at(
    root: &Path,
    user_id: &str,
    skill_id: &str,
    declared: &BTreeSet<String>,
    choices: &VariantChoices,
) -> Result<BTreeMap<String, VaultServing>, String> {
    let entries = vault_entry_names_at(root, user_id)?;
    let names = main_names(&entries);
    let meta = read_meta_at(root, user_id)?;
    Ok(declared
        .iter()
        .filter_map(|key| {
            serving_for(
                &meta,
                &entries,
                &names,
                skill_id,
                key,
                choices.get(key).map(Option::as_deref),
            )
            .map(|serving| (key.clone(), serving))
        })
        .collect())
}

/// The switcher of the vault name behind `declared` (main name or alias),
/// empty when the vault has no value for it.
pub(crate) fn variant_options_for_names_at(
    root: &Path,
    user_id: &str,
    declared: &BTreeSet<String>,
) -> Result<BTreeMap<String, Vec<KeyVariantOption>>, String> {
    let entries = vault_entry_names_at(root, user_id)?;
    let names = main_names(&entries);
    let meta = read_meta_at(root, user_id)?;
    let lookup = lookup_names(&names, &meta);
    Ok(declared
        .iter()
        .filter(|key| !is_reserved_variant_name(key))
        .filter_map(|key| {
            lookup
                .get(key)
                .map(|main| (key.clone(), meta.variant_options(main, &entries)))
        })
        .collect())
}

/// Whether the vault name behind `declared` (main name or alias) holds the
/// labelled value `variant` (`None`: its unlabelled value).
pub(crate) fn variant_exists_for_name_at(
    root: &Path,
    user_id: &str,
    declared: &str,
    variant: Option<&str>,
) -> Result<bool, String> {
    if let Some(variant) = variant {
        validate_variant_id(variant)?;
    }
    let entries = vault_entry_names_at(root, user_id)?;
    let meta = read_meta_at(root, user_id)?;
    let Some(main) = lookup_names(&main_names(&entries), &meta).remove(declared) else {
        return Ok(false);
    };
    let Some(variant) = variant else {
        return Ok(entries.contains(&main));
    };
    Ok(meta
        .keys
        .get(&main)
        .is_some_and(|entry| entry.has_variant(variant))
        && entries.contains(&variant_entry_name(&main, variant)))
}

fn lookup_names(names: &BTreeSet<String>, meta: &VaultMeta) -> BTreeMap<String, String> {
    let mut lookup = names
        .iter()
        .map(|key| (key.clone(), key.clone()))
        .collect::<BTreeMap<_, _>>();
    for (key, entry) in &meta.keys {
        if !names.contains(key) {
            continue;
        }
        for alias in &entry.aliases {
            lookup.entry(alias.clone()).or_insert_with(|| key.clone());
        }
    }
    lookup
}

pub(crate) fn zeroize_map(values: &mut BTreeMap<String, String>) {
    for value in values.values_mut() {
        value.zeroize();
    }
    values.clear();
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MigrationKeyChoice {
    pub(crate) name: String,
    pub(crate) conflict: MigrationKeyConflict,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum MigrationKeyConflict {
    Skip,
    Overwrite,
    Rename { name: String },
}

pub(crate) fn validate_migration_choices(choices: &[MigrationKeyChoice]) -> Result<(), String> {
    let mut names = BTreeSet::new();
    for choice in choices {
        validate_vault_key(&choice.name)?;
        let destination = match &choice.conflict {
            MigrationKeyConflict::Rename { name } => {
                validate_vault_key(name)?;
                name
            }
            _ => &choice.name,
        };
        if !names.insert(destination) {
            return Err("MIGRATION_KEY_DUPLICATE".into());
        }
    }
    Ok(())
}

/// Called under with_current_identity_at; values never enter an IPC DTO or server request.
pub(crate) fn copy_migration_keys_at(
    source_root: &Path,
    source_user: &str,
    target_root: &Path,
    target_user: &str,
    choices: &[MigrationKeyChoice],
    mapping: &BTreeMap<String, String>,
    receipt: &str,
) -> Result<(), String> {
    validate_migration_choices(choices)?;
    validate_user_id(source_user)?;
    validate_user_id(target_user)?;
    if source_root == target_root && source_user == target_user {
        return Err("MIGRATION_SAME_IDENTITY".into());
    }
    if !migration_marker_path_at(target_root, target_user).is_file() {
        return Err("MIGRATION_TARGET_VAULT_NOT_READY".into());
    }
    apply_migration_key_journal(target_root, target_user)?;
    let receipt_path = migration_key_receipt(target_root, target_user, receipt)?;
    if receipt_path.exists() {
        let done: bool = read_private_json(&receipt_path)?;
        if done {
            return Ok(());
        }
    }
    let source_meta = read_meta_at(source_root, source_user)?;
    let mut source_values = read_vault_values_at(source_root, source_user, None)?;
    let outcome = (|| {
        let mut target_meta = read_meta_at(target_root, target_user)?;
        let mut target_values = read_vault_values_at(target_root, target_user, None)?;
        let result = (|| {
            let names: Vec<String> = choices
                .iter()
                .filter_map(|choice| {
                    let name = match &choice.conflict {
                        MigrationKeyConflict::Rename { name } => name,
                        _ => &choice.name,
                    };
                    let exists = target_meta.keys.contains_key(name)
                        || target_values.keys().any(|k| identity_main(k) == name);
                    if exists && matches!(choice.conflict, MigrationKeyConflict::Skip) {
                        None
                    } else {
                        Some(name.clone())
                    }
                })
                .collect();
            if names.is_empty() {
                return write_private_json(&receipt_path, &true);
            }
            let before_values = migration_values_hash(&target_values, &names)?;
            let before_meta = migration_meta_hash(&target_meta, &names)?;
            let backup = vault_dir_at(target_root, target_user)
                .join(format!("skill-migration-backup-{receipt}.json"));
            if !backup.exists() {
                let mut payload = serde_json::to_value((&target_meta, &target_values))
                    .map_err(|_| "MIGRATION_KEY_WRITE")?;
                let saved = write_private_json(&backup, &payload);
                scrub_json(&mut payload);
                saved?;
            }
            for choice in choices {
                let destination = match &choice.conflict {
                    MigrationKeyConflict::Rename { name } => name,
                    _ => &choice.name,
                };
                let exists = target_meta.keys.contains_key(destination)
                    || target_values
                        .keys()
                        .any(|k| identity_main(k) == destination);
                if exists {
                    match choice.conflict {
                        MigrationKeyConflict::Skip => continue,
                        MigrationKeyConflict::Rename { .. } => {
                            return Err("MIGRATION_KEY_NAME_CONFLICT".into())
                        }
                        MigrationKeyConflict::Overwrite => {}
                    }
                }
                let entries: Vec<_> = source_values
                    .iter()
                    .filter(|(k, _)| identity_main(k) == choice.name)
                    .collect();
                if entries.is_empty() {
                    return Err("MIGRATION_SOURCE_KEY_MISSING".into());
                }
                let removed: Vec<_> = target_values
                    .keys()
                    .filter(|k| identity_main(k) == destination)
                    .cloned()
                    .collect();
                for key in removed {
                    if let Some(mut value) = target_values.remove(&key) {
                        value.zeroize();
                    }
                }
                target_meta
                    .keys
                    .retain(|k, _| identity_main(k) != destination);
                for (key, value) in entries {
                    let dest = if let Some((_, variant)) = split_variant_entry(key) {
                        variant_entry_name(destination, variant)
                    } else {
                        destination.clone()
                    };
                    target_values.insert(dest.clone(), value.clone());
                    let mut meta = source_meta.keys.get(key).cloned().unwrap_or_default();
                    meta.auto_allow = false;
                    meta.allowed_skills = meta
                        .allowed_skills
                        .iter()
                        .filter_map(|s| mapping.get(s).cloned())
                        .collect();
                    meta.blocked_skills = meta
                        .blocked_skills
                        .iter()
                        .filter_map(|s| mapping.get(s).cloned())
                        .collect();
                    meta.updated_at = now_ms();
                    meta.aliases.retain(|a| a != destination);
                    target_meta.keys.insert(dest, meta);
                }
                // Labelled-only keys also have a main metadata entry (aliases/default pointer).
                if !target_meta.keys.contains_key(destination) {
                    if let Some(original) = source_meta.keys.get(&choice.name) {
                        let mut meta = original.clone();
                        meta.auto_allow = false;
                        meta.allowed_skills = meta
                            .allowed_skills
                            .iter()
                            .filter_map(|s| mapping.get(s).cloned())
                            .collect();
                        meta.blocked_skills = meta
                            .blocked_skills
                            .iter()
                            .filter_map(|s| mapping.get(s).cloned())
                            .collect();
                        meta.aliases.retain(|a| a != destination);
                        target_meta.keys.insert(destination.clone(), meta);
                    }
                }
            }
            target_meta.auto_allow = false;
            check_aliases(
                &target_meta,
                &main_names(&target_values.keys().cloned().collect()),
            )?;
            ensure_vault_dir_at(target_root, target_user)?;
            // A local recovery journal makes the two-file write replayable after a crash.
            // It is inside the private vault, never inside the migration manifest.
            let journal =
                vault_dir_at(target_root, target_user).join("skill-migration.pending.json");
            let mut payload = serde_json::to_value((
                receipt,
                &names,
                before_values,
                before_meta,
                &target_meta,
                &target_values,
            ))
            .map_err(|_| "MIGRATION_KEY_WRITE")?;
            let saved = write_private_json(&journal, &payload);
            scrub_json(&mut payload);
            saved?;
            apply_migration_key_journal(target_root, target_user)
        })();
        zeroize_map(&mut target_values);
        result
    })();
    zeroize_map(&mut source_values);
    outcome
}

pub(crate) fn migration_key_receipt(
    root: &Path,
    user: &str,
    receipt: &str,
) -> Result<PathBuf, String> {
    if receipt.len() != 64 || !receipt.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("MIGRATION_KEY_RECEIPT".into());
    }
    let dir = vault_dir_at(root, user).join("migration-receipts");
    ensure_private_directory(&dir)?;
    Ok(dir.join(format!("{receipt}.json")))
}
fn migration_values_hash(
    values: &BTreeMap<String, String>,
    names: &[String],
) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let selected: BTreeMap<_, _> = values
        .iter()
        .filter(|(k, _)| names.iter().any(|n| identity_main(k) == n))
        .collect();
    let mut bytes = serde_json::to_vec(&selected).map_err(|_| "MIGRATION_KEY_WRITE")?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    bytes.zeroize();
    Ok(hash)
}
fn migration_meta_hash(meta: &VaultMeta, names: &[String]) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let selected: BTreeMap<_, _> = meta
        .keys
        .iter()
        .filter(|(k, _)| names.iter().any(|n| identity_main(k) == n))
        .collect();
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&selected).map_err(|_| "MIGRATION_KEY_WRITE")?)
    ))
}

fn scrub_json(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => s.zeroize(),
        serde_json::Value::Array(a) => a.iter_mut().for_each(scrub_json),
        serde_json::Value::Object(o) => o.values_mut().for_each(scrub_json),
        _ => {}
    }
}

pub(crate) fn apply_migration_key_journal(root: &Path, user: &str) -> Result<(), String> {
    let journal = vault_dir_at(root, user).join("skill-migration.pending.json");
    if !journal.exists() {
        return Ok(());
    }
    let (receipt, names, before_values, before_meta, desired, mut values): (
        String,
        Vec<String>,
        String,
        String,
        VaultMeta,
        BTreeMap<String, String>,
    ) = read_private_json(&journal)?;
    let result = (|| {
        let receipt_path = migration_key_receipt(root, user, &receipt)?;
        if receipt_path.exists() && read_private_json::<bool>(&receipt_path)? {
            return fs::remove_file(journal).map_err(|_| "MIGRATION_KEY_WRITE".into());
        }
        let mut current = read_meta_at(root, user)?;
        let mut old = read_vault_values_at(root, user, None)?;
        let mut final_names: BTreeSet<String> = old
            .keys()
            .filter(|k| !names.iter().any(|n| identity_main(k) == n))
            .cloned()
            .collect();
        final_names.extend(
            values
                .keys()
                .filter(|k| names.iter().any(|n| identity_main(k) == n))
                .cloned(),
        );
        let observed = migration_values_hash(&old, &names)?;
        let old_names: Vec<String> = old
            .keys()
            .filter(|k| names.iter().any(|n| identity_main(k) == n))
            .cloned()
            .collect();
        zeroize_map(&mut old);
        if observed != before_values && observed != migration_values_hash(&values, &names)? {
            return Err("MIGRATION_KEY_CHANGED_DURING_RECOVERY".into());
        }
        let observed = migration_meta_hash(&current, &names)?;
        if observed != before_meta && observed != migration_meta_hash(&desired, &names)? {
            return Err("MIGRATION_KEY_CHANGED_DURING_RECOVERY".into());
        }
        current
            .keys
            .retain(|k, _| !names.iter().any(|n| identity_main(k) == n));
        current.keys.extend(
            desired
                .keys
                .into_iter()
                .filter(|(k, _)| names.iter().any(|n| identity_main(k) == n)),
        );
        current.auto_allow = false;
        check_aliases(&current, &main_names(&final_names))?;
        let mut edits: Vec<(&str, Option<&str>)> =
            old_names.iter().map(|k| (k.as_str(), None)).collect();
        edits.extend(
            values
                .iter()
                .filter(|(k, _)| names.iter().any(|n| identity_main(k) == n))
                .map(|(k, v)| (k.as_str(), Some(v.as_str()))),
        );
        // Remove broad permissions before making any new value available.
        write_meta_at(root, user, &current)?;
        for name in &names {
            let identities: Vec<String> = current
                .keys
                .keys()
                .filter(|k| identity_main(k) == name)
                .cloned()
                .collect();
            drop_identity_traces(root, user, &identities);
        }
        edit_env_file(&vault_env_path_at(root, user), &edits)?;
        write_private_json(&receipt_path, &true)?;
        fs::remove_file(journal).map_err(|_| "MIGRATION_KEY_WRITE".to_string())
    })();
    zeroize_map(&mut values);
    result
}

#[cfg(test)]
mod skill_migration_tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        user: String,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("skill-key-migration-{}", uuid::Uuid::new_v4()));
            ensure_private_directory(&root).unwrap();
            let user = uuid::Uuid::new_v4().to_string();
            ensure_vault_dir_at(&root, &user).unwrap();
            write_private_json(&migration_marker_path_at(&root, &user), &true).unwrap();
            Self { root, user }
        }
        fn set(&self, key: &str, value: &str) {
            set_vault_key_at(&self.root, &self.user, key, value, None, 1).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn migration_keys_copy_variants_aliases_and_mapping_without_source_grants() {
        let source = Fixture::new();
        let target = Fixture::new();
        source.set("SERVICE_KEY", "fixture-secret");
        set_vault_key_aliases_at(
            &source.root,
            &source.user,
            "SERVICE_KEY",
            vec!["SERVICE_TOKEN".into()],
            2,
        )
        .unwrap();
        let variant = create_vault_key_variant_at(
            &source.root,
            &source.user,
            "SERVICE_KEY",
            "work",
            "variant-secret",
            Some("old-folder"),
            3,
        )
        .unwrap();
        let mut meta = read_meta_at(&source.root, &source.user).unwrap();
        meta.auto_allow = true;
        let main = meta.keys.get_mut("SERVICE_KEY").unwrap();
        main.auto_allow = true;
        main.allowed_skills = vec!["old-folder".into(), "unmapped".into()];
        write_meta_at(&source.root, &source.user, &meta).unwrap();
        ensure_private_directory(&grants_dir_at(&source.root, &source.user)).unwrap();
        write_private_json(
            &grants_dir_at(&source.root, &source.user).join("once"),
            &true,
        )
        .unwrap();
        let before_env = fs::read(vault_env_path_at(&source.root, &source.user)).unwrap();
        let before_meta = fs::read(vault_meta_path_at(&source.root, &source.user)).unwrap();
        let choices = vec![MigrationKeyChoice {
            name: "SERVICE_KEY".into(),
            conflict: MigrationKeyConflict::Rename {
                name: "RENAMED_KEY".into(),
            },
        }];
        let mapping = BTreeMap::from([("old-folder".into(), "new-folder".into())]);
        let receipt = "a".repeat(64);
        copy_migration_keys_at(
            &source.root,
            &source.user,
            &target.root,
            &target.user,
            &choices,
            &mapping,
            &receipt,
        )
        .unwrap();
        let saved = read_meta_at(&target.root, &target.user).unwrap();
        assert!(!saved.auto_allow && !saved.keys["RENAMED_KEY"].auto_allow);
        assert_eq!(saved.keys["RENAMED_KEY"].allowed_skills, ["new-folder"]);
        assert_eq!(saved.keys["RENAMED_KEY"].aliases, ["SERVICE_TOKEN"]);
        assert_eq!(
            saved.keys[&variant_entry_name("RENAMED_KEY", &variant)].allowed_skills,
            ["new-folder"]
        );
        assert!(!grants_dir_at(&target.root, &target.user).exists());
        assert!(!consent_dir_at(&target.root, &target.user).exists());
        assert_eq!(
            before_env,
            fs::read(vault_env_path_at(&source.root, &source.user)).unwrap()
        );
        assert_eq!(
            before_meta,
            fs::read(vault_meta_path_at(&source.root, &source.user)).unwrap()
        );
        assert!(!serde_json::to_string(&choices)
            .unwrap()
            .contains("fixture-secret"));
        // Rename replay uses the durable receipt, even after a later user edit.
        target.set("RENAMED_KEY", "later-value");
        copy_migration_keys_at(
            &source.root,
            &source.user,
            &target.root,
            &target.user,
            &choices,
            &mapping,
            &receipt,
        )
        .unwrap();
        let mut values = read_vault_values_at(&target.root, &target.user, None).unwrap();
        assert_eq!(values["RENAMED_KEY"], "later-value");
        zeroize_map(&mut values);
        assert!(values.is_empty());
    }

    fn pending(f: &Fixture, alias: bool) {
        let names = vec!["SERVICE_KEY".to_string()];
        let mut meta = read_meta_at(&f.root, &f.user).unwrap();
        let mut values = read_vault_values_at(&f.root, &f.user, None).unwrap();
        let before_values = migration_values_hash(&values, &names).unwrap();
        let before_meta = migration_meta_hash(&meta, &names).unwrap();
        values.insert("SERVICE_KEY".into(), "after".into());
        if alias {
            meta.keys.get_mut("SERVICE_KEY").unwrap().aliases = vec!["NEW_ALIAS".into()];
        }
        write_private_json(
            &vault_dir_at(&f.root, &f.user).join("skill-migration.pending.json"),
            &(
                "b".repeat(64),
                names,
                before_values,
                before_meta,
                meta,
                &values,
            ),
        )
        .unwrap();
        zeroize_map(&mut values);
    }

    #[test]
    fn migration_journal_preserves_unselected_edits_and_rejects_selected_edits() {
        let f = Fixture::new();
        f.set("SERVICE_KEY", "before");
        pending(&f, false);
        f.set("UNRELATED_KEY", "new-after-crash");
        apply_migration_key_journal(&f.root, &f.user).unwrap();
        let mut values = read_vault_values_at(&f.root, &f.user, None).unwrap();
        assert_eq!(values["SERVICE_KEY"], "after");
        assert_eq!(values["UNRELATED_KEY"], "new-after-crash");
        zeroize_map(&mut values);

        let f = Fixture::new();
        f.set("SERVICE_KEY", "before");
        pending(&f, false);
        f.set("SERVICE_KEY", "user-edited");
        assert!(apply_migration_key_journal(&f.root, &f.user).is_err());
        let mut values = read_vault_values_at(&f.root, &f.user, None).unwrap();
        assert_eq!(values["SERVICE_KEY"], "user-edited");
        zeroize_map(&mut values);
    }

    #[test]
    fn migration_journal_restores_receipt_after_values_were_written() {
        let f = Fixture::new();
        f.set("SERVICE_KEY", "before");
        pending(&f, false);
        edit_env_file(
            &vault_env_path_at(&f.root, &f.user),
            &[("SERVICE_KEY", Some("after"))],
        )
        .unwrap();
        let receipt = migration_key_receipt(&f.root, &f.user, &"b".repeat(64)).unwrap();
        assert!(!receipt.exists());
        apply_migration_key_journal(&f.root, &f.user).unwrap();
        assert!(read_private_json::<bool>(&receipt).unwrap());
        assert!(!vault_dir_at(&f.root, &f.user)
            .join("skill-migration.pending.json")
            .exists());
    }

    #[test]
    fn migration_journal_revalidates_alias_conflicts_after_restart() {
        let f = Fixture::new();
        f.set("SERVICE_KEY", "before");
        pending(&f, true);
        f.set("NEW_ALIAS", "new-after-crash");
        assert!(apply_migration_key_journal(&f.root, &f.user).is_err());
        assert!(read_meta_at(&f.root, &f.user).unwrap().keys["SERVICE_KEY"]
            .aliases
            .is_empty());
    }

    #[test]
    fn migration_key_skip_overwrite_and_rename_conflicts_are_explicit() {
        let s = Fixture::new();
        let t = Fixture::new();
        s.set("SERVICE_KEY", "source");
        t.set("SERVICE_KEY", "target");
        for (action, expected, receipt) in [
            (MigrationKeyConflict::Skip, "target", "c".repeat(64)),
            (MigrationKeyConflict::Overwrite, "source", "d".repeat(64)),
        ] {
            copy_migration_keys_at(
                &s.root,
                &s.user,
                &t.root,
                &t.user,
                &[MigrationKeyChoice {
                    name: "SERVICE_KEY".into(),
                    conflict: action,
                }],
                &BTreeMap::new(),
                &receipt,
            )
            .unwrap();
            let mut values = read_vault_values_at(&t.root, &t.user, None).unwrap();
            assert_eq!(values["SERVICE_KEY"], expected);
            zeroize_map(&mut values);
        }
        assert!(copy_migration_keys_at(
            &s.root,
            &s.user,
            &t.root,
            &t.user,
            &[MigrationKeyChoice {
                name: "SERVICE_KEY".into(),
                conflict: MigrationKeyConflict::Rename {
                    name: "SERVICE_KEY".into()
                }
            }],
            &BTreeMap::new(),
            &"e".repeat(64)
        )
        .is_err());
    }
}

/// Writes (`Some`) or removes (`None`) keys in an owner-only env file through
/// the same line editor as the per-Skill files. Returns whether the file
/// still holds any assignment afterwards.
fn edit_env_file(path: &Path, edits: &[(&str, Option<&str>)]) -> Result<bool, String> {
    let mut contents = crate::commands::read_env_file_for_update(path)?.unwrap_or_default();
    let mut result = Ok(());
    for (key, value) in edits {
        match crate::commands::update_env_file_contents(&contents, key, *value) {
            Ok(mut updated) => {
                std::mem::swap(&mut contents, &mut updated);
                updated.zeroize();
            }
            Err(error) => {
                result = Err(error);
                break;
            }
        }
    }
    let outcome = result.and_then(|()| {
        let remaining = crate::commands::parse_env_entries(&contents).map(|mut entries| {
            let any = !entries.is_empty();
            zeroize_map(&mut entries);
            any
        })?;
        crate::commands::write_private_file(path, &contents)?;
        Ok(remaining)
    });
    contents.zeroize();
    outcome
}

/// Where a Skill's personal value comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PersonalSource {
    /// `~/.skillhub/envs/<user>/<skill>.env`: this Skill uses its own value.
    Override,
    /// The account key vault, shared by name across Skills.
    Vault,
}

impl PersonalSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Override => "override",
            Self::Vault => "vault",
        }
    }
}

/// The personal layer of the resolution order: override → vault.
#[derive(Default)]
pub(crate) struct PersonalValues {
    /// Keyed by the name the Skill declares.
    values: BTreeMap<String, String>,
    sources: BTreeMap<String, PersonalSource>,
    /// Declared name → the vault identity serving it: the main name (equal
    /// for a direct hit, the alias owner through an alias, #288) or the
    /// synthetic `MAIN__V<n>` of a labelled value (#306).
    vault_identity: BTreeMap<String, String>,
    /// Declared name → the labelled value serving it, when one does.
    vault_variants: BTreeMap<String, (String, String)>,
}

impl PersonalValues {
    pub(crate) fn values(&self) -> &BTreeMap<String, String> {
        &self.values
    }

    pub(crate) fn sources(&self) -> &BTreeMap<String, PersonalSource> {
        &self.sources
    }

    /// Keys whose personal value comes from the vault.
    pub(crate) fn vault_keys(&self) -> BTreeSet<String> {
        self.sources
            .iter()
            .filter(|(_, source)| **source == PersonalSource::Vault)
            .map(|(key, _)| key.clone())
            .collect()
    }

    pub(crate) fn vault_identity(&self) -> &BTreeMap<String, String> {
        &self.vault_identity
    }

    /// `(variant, label)` of the labelled value serving `declared`.
    pub(crate) fn vault_variant(&self, declared: &str) -> Option<&(String, String)> {
        self.vault_variants.get(declared)
    }

    /// The vault keys (main names) behind `declared` names; consent, grants
    /// and usage are recorded by key identity, whichever name was used.
    pub(crate) fn vault_main_names<'a>(
        &self,
        declared: impl IntoIterator<Item = &'a String>,
    ) -> BTreeSet<String> {
        declared
            .into_iter()
            .filter_map(|key| self.vault_identity.get(key).cloned())
            .collect()
    }
}

impl Drop for PersonalValues {
    fn drop(&mut self) {
        zeroize_map(&mut self.values);
    }
}

/// The personal layer for `skill_id`: its own override first, then the
/// vault value of the declared name (directly or through an alias). Which of
/// a name's values is used follows `choices` (declared name → variant the
/// Skill's policy picked, #306), else the name's default.
pub(crate) fn read_personal_values_at(
    root: &Path,
    env_root: &Path,
    user_id: &str,
    skill_id: &str,
    allowed: &BTreeSet<String>,
    choices: &VariantChoices,
) -> Result<PersonalValues, String> {
    validate_user_id(user_id)?;
    validate_skill_id(skill_id)?;
    let mut personal = PersonalValues {
        values: read_private_env_values(
            &account_env_path_at(env_root, user_id, skill_id),
            Some(allowed),
        )?,
        sources: BTreeMap::new(),
        vault_identity: BTreeMap::new(),
        vault_variants: BTreeMap::new(),
    };
    for key in personal.values.keys() {
        personal
            .sources
            .insert(key.clone(), PersonalSource::Override);
    }
    let wanted = allowed
        .iter()
        .filter(|key| !personal.values.contains_key(*key))
        .cloned()
        .collect::<BTreeSet<_>>();
    let serving = vault_serving_for_skill_at(root, user_id, skill_id, &wanted, choices)?;
    if serving.is_empty() {
        return Ok(personal);
    }
    let read_names = serving
        .values()
        .map(|serving| serving.identity.clone())
        .collect::<BTreeSet<_>>();
    let mut vault = read_vault_values_at(root, user_id, Some(&read_names))?;
    for (key, serving) in serving {
        if let Some(value) = vault.get(&serving.identity) {
            personal.values.insert(key.clone(), value.clone());
            personal.sources.insert(key.clone(), PersonalSource::Vault);
            if let (Some(variant), Some(label)) = (serving.variant, serving.label) {
                personal
                    .vault_variants
                    .insert(key.clone(), (variant, label));
            }
            personal.vault_identity.insert(key, serving.identity);
        }
    }
    zeroize_map(&mut vault);
    Ok(personal)
}

// ── Consent ─────────────────────────────────────────────────────────────────

/// Skills from the Marketplace or a team (and system Skills) must be allowed
/// before they can read an account key; the user's own Skills never ask.
pub(crate) fn skill_requires_consent(profile: &SkillHubProfile) -> bool {
    profile.is_system
        || profile.is_own == Some(false)
        || profile.team_shared_from.is_some()
        || crate::commands::profile_acquisition_source(profile) != AcquisitionSource::Local
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OnceGrant {
    version: u8,
    skill_id: String,
    key: String,
    expires_at: u64,
}

#[derive(Debug, Default)]
pub(crate) struct ConsentOutcome {
    /// Vault identities (`NAME` or `NAME__V<n>`) this Skill may not use yet.
    pub(crate) pending: Vec<String>,
    /// `pending` as the user reads them: `FAL_KEY · 公司` for a labelled value.
    pub(crate) pending_display: Vec<String>,
    once_grants: Vec<PathBuf>,
}

impl ConsentOutcome {
    /// Removes the one-shot grants this run relied on.
    pub(crate) fn consume_once_grants(&self) {
        for path in &self.once_grants {
            let _ = fs::remove_file(path);
        }
    }
}

fn read_once_grant(path: &Path) -> Option<OnceGrant> {
    fs::symlink_metadata(path).ok()?;
    match read_private_json::<OnceGrant>(path) {
        Ok(grant) if grant.version == VAULT_STORE_VERSION => Some(grant),
        _ => {
            let _ = fs::remove_file(path);
            None
        }
    }
}

/// Which of `vault_keys` (the vault values this run would inject) still need
/// the user's consent for `skill_id`.
pub(crate) fn evaluate_consent_at(
    root: &Path,
    user_id: &str,
    skill_id: &str,
    profile: &SkillHubProfile,
    vault_keys: &BTreeSet<String>,
    now: u64,
) -> Result<ConsentOutcome, String> {
    let mut outcome = ConsentOutcome::default();
    if vault_keys.is_empty() || !skill_requires_consent(profile) {
        return Ok(outcome);
    }
    let meta = read_meta_at(root, user_id)?;
    for key in vault_keys {
        // A key turned off for this Skill (#294) is never asked for.
        if meta.allows(skill_id, key) || meta.blocks(skill_id, key) {
            continue;
        }
        let path = grant_path_at(root, user_id, skill_id, key);
        match read_once_grant(&path) {
            Some(grant)
                if grant.skill_id == skill_id && grant.key == *key && grant.expires_at > now =>
            {
                outcome.once_grants.push(path);
                continue;
            }
            Some(_) => {
                let _ = fs::remove_file(&path);
            }
            None => {}
        }
        outcome.pending.push(key.clone());
        outcome.pending_display.push(meta.display_identity(key));
    }
    Ok(outcome)
}

/// `keys` are display names (`ConsentOutcome::pending_display`).
pub(crate) fn needs_consent_error(skill_name: &str, keys: &[String]) -> String {
    format!(
        "{NEEDS_CONSENT_CODE}: 「{skill_name}」想使用你的钥匙 {}；APP 会弹出授权窗，请用户确认后重试",
        keys.join("、")
    )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredConsentRequest {
    version: u8,
    skill_id: String,
    keys: Vec<String>,
    requested_at: u64,
}

/// Leaves a value-free note for the APP: `skill_id` was refused `keys`.
pub(crate) fn record_consent_request_at(
    root: &Path,
    user_id: &str,
    skill_id: &str,
    keys: &[String],
    now: u64,
) -> Result<(), String> {
    validate_skill_id(skill_id)?;
    ensure_vault_dir_at(root, user_id)?;
    ensure_private_directory(&consent_dir_at(root, user_id))?;
    let path = consent_request_path_at(root, user_id, skill_id);
    let mut merged = read_consent_request(&path, now)
        .map(|request| request.keys)
        .unwrap_or_default()
        .into_iter()
        .collect::<BTreeSet<_>>();
    merged.extend(keys.iter().filter(|key| valid_env_key(key)).cloned());
    write_private_json(
        &path,
        &StoredConsentRequest {
            version: VAULT_STORE_VERSION,
            skill_id: skill_id.to_string(),
            keys: merged.into_iter().collect(),
            requested_at: now,
        },
    )
}

fn read_consent_request(path: &Path, now: u64) -> Option<StoredConsentRequest> {
    fs::symlink_metadata(path).ok()?;
    match read_private_json::<StoredConsentRequest>(path) {
        Ok(request)
            if request.version == VAULT_STORE_VERSION
                && now.saturating_sub(request.requested_at) < CONSENT_REQUEST_TTL_MS =>
        {
            Some(request)
        }
        _ => {
            let _ = fs::remove_file(path);
            None
        }
    }
}

fn remove_keys_from_consent_request(root: &Path, user_id: &str, skill_id: &str, keys: &[&str]) {
    let path = consent_request_path_at(root, user_id, skill_id);
    let Some(mut request) = read_consent_request(&path, now_ms()) else {
        return;
    };
    request.keys.retain(|key| !keys.contains(&key.as_str()));
    if request.keys.is_empty() {
        let _ = fs::remove_file(&path);
    } else {
        let _ = write_private_json(&path, &request);
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyConsentRequest {
    pub skill_id: String,
    pub skill_name: String,
    /// Vault identities: `FAL_KEY`, or `FAL_KEY__V1` for a labelled value
    /// (#306); pass one back as `key` to `grant_key_access`.
    pub keys: Vec<String>,
    /// `keys` as the user reads them, same order: `FAL_KEY · 公司`.
    pub display_keys: Vec<String>,
    pub requested_at: u64,
}

/// Open consent requests whose keys are still in the vault and still not
/// allowed. Expired or settled requests are removed.
pub(crate) fn list_consent_requests_at(
    root: &Path,
    managed_root: &Path,
    user_id: &str,
    now: u64,
) -> Result<Vec<KeyConsentRequest>, String> {
    validate_user_id(user_id)?;
    let directory = consent_dir_at(root, user_id);
    let Ok(entries) = fs::read_dir(&directory) else {
        return Ok(Vec::new());
    };
    let vault_keys = vault_entry_names_at(root, user_id)?;
    let meta = read_meta_at(root, user_id)?;
    let mut requests = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(skill_id) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".json"))
            .map(str::to_string)
        else {
            continue;
        };
        if validate_skill_id(&skill_id).is_err() {
            continue;
        }
        let Some(request) = read_consent_request(&path, now) else {
            continue;
        };
        let profile = read_profile_at(managed_root, &skill_id).ok();
        let keys = request
            .keys
            .into_iter()
            .filter(|key| {
                vault_keys.contains(key)
                    && !meta.allows(&skill_id, key)
                    && !meta.blocks(&skill_id, key)
            })
            .collect::<Vec<_>>();
        if request.skill_id != skill_id || keys.is_empty() || profile.is_none() {
            let _ = fs::remove_file(&path);
            continue;
        }
        requests.push(KeyConsentRequest {
            skill_name: profile.as_ref().map_or_else(
                || skill_id.clone(),
                |profile| profile_display_name(profile, &skill_id),
            ),
            skill_id,
            display_keys: keys.iter().map(|key| meta.display_identity(key)).collect(),
            keys,
            requested_at: request.requested_at,
        });
    }
    requests.sort_by(|left, right| {
        left.requested_at
            .cmp(&right.requested_at)
            .then_with(|| left.skill_id.cmp(&right.skill_id))
    });
    Ok(requests)
}

pub(crate) fn dismiss_consent_request_at(
    root: &Path,
    user_id: &str,
    skill_id: &str,
) -> Result<(), String> {
    validate_user_id(user_id)?;
    validate_skill_id(skill_id)?;
    match fs::remove_file(consent_request_path_at(root, user_id, skill_id)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法关闭钥匙授权请求: {error}")),
    }
}

pub(crate) fn profile_display_name(profile: &SkillHubProfile, skill_id: &str) -> String {
    profile
        .display_name
        .clone()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| profile.name.clone().filter(|name| !name.trim().is_empty()))
        .unwrap_or_else(|| skill_id.to_string())
}

pub(crate) const KEY_VAULT_ACCOUNT_CHANGED: &str = "SkillHub 账号已切换，请重新打开钥匙页";

/// Runs an APP vault operation for the current runtime identity: the
/// requested account must match, the one-time migration has run, and the
/// shared session lease is held throughout so a login, logout or switch
/// cannot land in the middle (the request is discarded instead).
pub(crate) fn with_current_identity_at<T>(
    root: &Path,
    env_root: &Path,
    requested_user_id: Option<&str>,
    expected: Option<&crate::server_request::SpaceHandle>,
    operation: impl FnOnce(&Path, &Path, &str) -> Result<T, String>,
) -> Result<T, String> {
    let session = crate::runtime_env::runtime_session_snapshot_at(root)?;
    if let Some(expected) = expected {
        crate::spaces::require_handle(&session, expected)?;
    }
    if session.is_sync_pending() {
        return Err(KEY_VAULT_ACCOUNT_CHANGED.into());
    }
    if let Some(requested) = requested_user_id {
        validate_user_id(requested)?;
        if requested != session.user_id() {
            return Err("当前身份与 SkillHub 运行时不一致，请重新打开钥匙页".into());
        }
    }
    let user_id = session.user_id().to_string();
    ensure_vault_migrated_for_at(root, env_root, &user_id, Some(&session))?;
    let _lease = crate::runtime_env::acquire_current_session_lease_at(root, &session)?
        .ok_or(KEY_VAULT_ACCOUNT_CHANGED)?;
    let data_root = session.storage_root(root);
    let data_env_root = if session.space_id() == "official" {
        env_root.to_path_buf()
    } else {
        data_root.join("envs")
    };
    operation(&data_root, &data_env_root, &user_id)
}

// ── Mutations (APP only; the CLI has none) ──────────────────────────────────

pub(crate) fn set_vault_key_at(
    root: &Path,
    user_id: &str,
    key: &str,
    value: &str,
    allow_skill: Option<&str>,
    now: u64,
) -> Result<(), String> {
    validate_vault_key(key)?;
    if !valid_personal_value(value) {
        return Err("钥匙值不能为空、不能换行，且不能超过 16 KB".into());
    }
    if let Some(skill_id) = allow_skill {
        validate_skill_id(skill_id)?;
    }
    let mut meta = read_meta_at(root, user_id)?;
    if let Some(owner) = meta.alias_owner(key) {
        return Err(format!("{key} 已经是另一把钥匙（{owner}）的变量名"));
    }
    let existing = vault_key_names_at(root, user_id)?;
    if !existing.contains(key) && existing.len() >= MAX_VAULT_KEYS {
        return Err("钥匙数量超过上限".into());
    }
    ensure_vault_dir_at(root, user_id)?;
    edit_env_file(&vault_env_path_at(root, user_id), &[(key, Some(value))])?;
    let entry = meta.keys.entry(key.to_string()).or_insert(VaultKeyMeta {
        created_at: now,
        updated_at: now,
        ..Default::default()
    });
    entry.updated_at = now;
    if let Some(skill_id) = allow_skill {
        meta.allow_skill(key, skill_id, now);
        remove_keys_from_consent_request(root, user_id, skill_id, &[key]);
    }
    write_meta_at(root, user_id, &meta)
}

/// 「撤销」 the unlabelled value of `key` (see [`delete_vault_key_variant_at`]).
#[cfg(test)]
pub(crate) fn delete_vault_key_at(root: &Path, user_id: &str, key: &str) -> Result<(), String> {
    delete_vault_key_variant_at(root, user_id, key, None)
}

/// 「撤销」 one value of `key` (#306): `None` is the unlabelled value.
///
/// The last value of a name removes the whole name: value, metadata
/// (aliases included), usage and pending grants, so every Skill that relied
/// on it, by its main name or an alias, is back to 「需要填写」 (overrides
/// are untouched). The default value cannot go while another value of the
/// name remains; the user picks another default first. A removed labelled
/// value takes its consent, usage and grants along; a Skill policy naming it
/// falls back to the default.
pub(crate) fn delete_vault_key_variant_at(
    root: &Path,
    user_id: &str,
    key: &str,
    variant: Option<&str>,
) -> Result<(), String> {
    validate_vault_key(key)?;
    if let Some(variant) = variant {
        validate_variant_id(variant)?;
    }
    let mut meta = read_meta_at(root, user_id)?;
    let entries = vault_entry_names_at(root, user_id)?;
    let entry = meta.keys.get(key).cloned().unwrap_or_default();
    if let Some(variant) = variant {
        if !entry.has_variant(variant) {
            return Err(format!("{key} 没有这把带标签的钥匙"));
        }
    }
    let identities = std::iter::once(key.to_string())
        .chain(
            entry
                .variants
                .iter()
                .map(|variant| variant_entry_name(key, &variant.id)),
        )
        .collect::<Vec<_>>();
    let target = variant.map_or_else(|| key.to_string(), |id| variant_entry_name(key, id));
    let others = identities
        .iter()
        .any(|identity| *identity != target && entries.contains(identity));
    let is_default = entry.default_variant() == variant;
    let removed = if !others {
        // The last value of this name: the name goes entirely.
        for identity in &identities {
            meta.keys.remove(identity);
        }
        identities
    } else if is_default {
        return Err(match variant {
            None => "还有带标签的钥匙，先把其中一把设为默认后再撤销".to_string(),
            Some(_) => "这把是默认钥匙，先把另一把设为默认后再撤销".to_string(),
        });
    } else {
        match variant {
            Some(variant) => {
                meta.keys.remove(&target);
                if let Some(entry) = meta.keys.get_mut(key) {
                    entry.variants.retain(|entry| entry.id != variant);
                }
            }
            // The name keeps its aliases and variants; only the unlabelled
            // value's own consent state goes.
            None => {
                if let Some(entry) = meta.keys.get_mut(key) {
                    entry.allowed_skills.clear();
                    entry.blocked_skills.clear();
                    entry.auto_allow = false;
                }
            }
        }
        vec![target]
    };
    let path = vault_env_path_at(root, user_id);
    if fs::symlink_metadata(&path).is_ok() {
        let edits = removed
            .iter()
            .map(|identity| (identity.as_str(), None))
            .collect::<Vec<_>>();
        edit_env_file(&path, &edits)?;
    }
    if fs::symlink_metadata(vault_meta_path_at(root, user_id)).is_ok() {
        write_meta_at(root, user_id, &meta)?;
    }
    drop_identity_traces(root, user_id, &removed);
    Ok(())
}

/// Usage timestamps and pending one-shot grants of removed identities.
fn drop_identity_traces(root: &Path, user_id: &str, identities: &[String]) {
    let mut usage = read_usage_at(root, user_id);
    let before = usage.len();
    usage.retain(|key, _| !identities.contains(key));
    if usage.len() != before {
        let _ = write_private_json(
            &vault_usage_path_at(root, user_id),
            &VaultUsage {
                version: VAULT_STORE_VERSION,
                last_used_at: usage,
            },
        );
    }
    if let Ok(entries) = fs::read_dir(grants_dir_at(root, user_id)) {
        let suffixes = identities
            .iter()
            .map(|identity| format!("-{identity}"))
            .collect::<Vec<_>>();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if suffixes.iter().any(|suffix| name.ends_with(suffix)) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// 「再加一把」: a further, labelled value of `key` (#306). The name needs
/// its default value first; labels are unique per name. With `allow_skill`
/// that Skill may use the new value without asking.
pub(crate) fn create_vault_key_variant_at(
    root: &Path,
    user_id: &str,
    key: &str,
    label: &str,
    value: &str,
    allow_skill: Option<&str>,
    now: u64,
) -> Result<String, String> {
    validate_vault_key(key)?;
    let label = normalize_variant_label(label)?;
    if !valid_personal_value(value) {
        return Err("钥匙值不能为空、不能换行，且不能超过 16 KB".into());
    }
    if let Some(skill_id) = allow_skill {
        validate_skill_id(skill_id)?;
    }
    let mut meta = read_meta_at(root, user_id)?;
    if let Some(owner) = meta.alias_owner(key) {
        return Err(format!("{key} 已经是另一把钥匙（{owner}）的变量名"));
    }
    if !vault_key_names_at(root, user_id)?.contains(key) {
        return Err(format!("先填写 {key} 的默认值"));
    }
    let entry = meta.keys.entry(key.to_string()).or_insert(VaultKeyMeta {
        created_at: now,
        updated_at: now,
        ..Default::default()
    });
    if entry.variants.iter().any(|variant| variant.label == label) {
        return Err(format!("标签「{label}」已存在"));
    }
    if entry.variants.len() >= MAX_KEY_VARIANTS {
        return Err(format!(
            "{key} 最多只能有 {MAX_KEY_VARIANTS} 把带标签的钥匙"
        ));
    }
    let number = entry
        .variants
        .iter()
        .map(|variant| variant_number(&variant.id))
        .max()
        .unwrap_or(0)
        .max(entry.variant_seq)
        .saturating_add(1);
    let variant = format!("V{number}");
    let identity = variant_entry_name(key, &variant);
    if !valid_variant_id(&variant) || !valid_env_key(&identity) {
        return Err(format!("{key} 太长，无法再加带标签的钥匙"));
    }
    entry.variant_seq = number;
    entry.variants.push(VariantMeta {
        id: variant.clone(),
        label,
        created_at: now,
    });
    meta.keys.insert(
        identity.clone(),
        VaultKeyMeta {
            created_at: now,
            updated_at: now,
            ..Default::default()
        },
    );
    if let Some(skill_id) = allow_skill {
        meta.allow_skill(&identity, skill_id, now);
    }
    ensure_vault_dir_at(root, user_id)?;
    edit_env_file(
        &vault_env_path_at(root, user_id),
        &[(&identity, Some(value))],
    )?;
    write_meta_at(root, user_id, &meta)?;
    if let Some(skill_id) = allow_skill {
        remove_keys_from_consent_request(root, user_id, skill_id, &[&identity]);
    }
    Ok(variant)
}

/// The labelled value `variant` of `key` must exist.
fn existing_variant<'a>(
    meta: &'a mut VaultMeta,
    key: &str,
    variant: &str,
) -> Result<&'a mut VaultKeyMeta, String> {
    validate_variant_id(variant)?;
    meta.keys
        .get_mut(key)
        .filter(|entry| entry.has_variant(variant))
        .ok_or_else(|| format!("{key} 没有这把带标签的钥匙"))
}

/// Replaces the value of one labelled value of `key`.
pub(crate) fn set_vault_key_variant_value_at(
    root: &Path,
    user_id: &str,
    key: &str,
    variant: &str,
    value: &str,
    now: u64,
) -> Result<(), String> {
    validate_vault_key(key)?;
    if !valid_personal_value(value) {
        return Err("钥匙值不能为空、不能换行，且不能超过 16 KB".into());
    }
    let mut meta = read_meta_at(root, user_id)?;
    existing_variant(&mut meta, key, variant)?;
    let identity = variant_entry_name(key, variant);
    ensure_vault_dir_at(root, user_id)?;
    edit_env_file(
        &vault_env_path_at(root, user_id),
        &[(&identity, Some(value))],
    )?;
    meta.keys
        .entry(identity)
        .or_insert(VaultKeyMeta {
            created_at: now,
            ..Default::default()
        })
        .updated_at = now;
    write_meta_at(root, user_id, &meta)
}

pub(crate) fn set_vault_key_variant_label_at(
    root: &Path,
    user_id: &str,
    key: &str,
    variant: &str,
    label: &str,
    now: u64,
) -> Result<(), String> {
    validate_vault_key(key)?;
    let label = normalize_variant_label(label)?;
    let mut meta = read_meta_at(root, user_id)?;
    let entry = existing_variant(&mut meta, key, variant)?;
    if entry
        .variants
        .iter()
        .any(|other| other.id != variant && other.label == label)
    {
        return Err(format!("标签「{label}」已存在"));
    }
    if let Some(entry) = entry.variants.iter_mut().find(|entry| entry.id == variant) {
        entry.label = label;
    }
    if let Some(entry) = meta.keys.get_mut(&variant_entry_name(key, variant)) {
        entry.updated_at = now;
    }
    write_meta_at(root, user_id, &meta)
}

/// 「设为默认」: moves the default pointer of `key` (#306); `None` makes the
/// unlabelled value the default again. Identities never swap.
pub(crate) fn set_vault_default_variant_at(
    root: &Path,
    user_id: &str,
    key: &str,
    variant: Option<&str>,
) -> Result<(), String> {
    validate_vault_key(key)?;
    let entries = vault_entry_names_at(root, user_id)?;
    if !main_names(&entries).contains(key) {
        return Err(format!("钥匙库中没有 {key}，请先填写"));
    }
    let mut meta = read_meta_at(root, user_id)?;
    match variant {
        Some(variant) => {
            let entry = existing_variant(&mut meta, key, variant)?;
            entry.default_variant = Some(variant.to_string());
        }
        None => {
            if !entries.contains(key) {
                return Err(format!("{key} 没有不带标签的值，不能设为默认"));
            }
            if let Some(entry) = meta.keys.get_mut(key) {
                entry.default_variant = None;
            }
        }
    }
    write_meta_at(root, user_id, &meta)
}

/// The vault identity behind `name` (a main name, an alias, or a synthetic
/// `NAME__V<n>` handed out by a consent request) and an optional `variant`.
fn resolve_identity_at(
    root: &Path,
    user_id: &str,
    name: &str,
    variant: Option<&str>,
) -> Result<String, String> {
    let (name, variant) = match split_variant_entry(name) {
        Some((base, parsed)) if variant.is_none_or(|variant| variant == parsed) => {
            (base, Some(parsed))
        }
        Some(_) => return Err("钥匙标签编号不一致".into()),
        None => (name, variant),
    };
    validate_vault_key(name)?;
    let main = vault_lookup_names_at(root, user_id)?
        .remove(name)
        .ok_or_else(|| format!("钥匙库中没有 {name}，请先填写"))?;
    match variant {
        None => Ok(main),
        Some(variant) => {
            let mut meta = read_meta_at(root, user_id)?;
            existing_variant(&mut meta, &main, variant)?;
            Ok(variant_entry_name(&main, variant))
        }
    }
}

#[cfg(test)]
pub(crate) fn set_key_auto_allow_at(
    root: &Path,
    user_id: &str,
    enabled: bool,
    key: Option<&str>,
    now: u64,
) -> Result<(), String> {
    set_key_auto_allow_variant_at(root, user_id, enabled, key, None, now)
}

/// Account-level 「以后不再询问」 (no `key`), or the same switch for one key
/// (with `variant`: one labelled value of it, #306).
pub(crate) fn set_key_auto_allow_variant_at(
    root: &Path,
    user_id: &str,
    enabled: bool,
    key: Option<&str>,
    variant: Option<&str>,
    now: u64,
) -> Result<(), String> {
    let mut meta = read_meta_at(root, user_id)?;
    match key {
        None => meta.auto_allow = enabled,
        Some(name) => {
            let key = resolve_identity_at(root, user_id, name, variant)?;
            let entry = meta.keys.entry(key).or_insert(VaultKeyMeta {
                created_at: now,
                updated_at: now,
                ..Default::default()
            });
            entry.auto_allow = enabled;
        }
    }
    write_meta_at(root, user_id, &meta)
}

#[cfg(test)]
pub(crate) fn grant_key_access_at(
    root: &Path,
    user_id: &str,
    skill_id: &str,
    name: &str,
    once: bool,
    now: u64,
) -> Result<(), String> {
    grant_key_access_variant_at(root, user_id, skill_id, name, None, once, now)
}

/// 「允许」 (`once = false`): remembered in `allowedSkills`. 「仅这次」
/// (`once = true`): a grant file the next run consumes, valid ten minutes.
/// Recorded for the key itself (main name), even when `name` is an alias;
/// for one labelled value with `variant` (or a synthetic `name`, #306).
pub(crate) fn grant_key_access_variant_at(
    root: &Path,
    user_id: &str,
    skill_id: &str,
    name: &str,
    variant: Option<&str>,
    once: bool,
    now: u64,
) -> Result<(), String> {
    validate_skill_id(skill_id)?;
    let key = resolve_identity_at(root, user_id, name, variant)?;
    let key = key.as_str();
    if once {
        ensure_vault_dir_at(root, user_id)?;
        ensure_private_directory(&grants_dir_at(root, user_id))?;
        write_private_json(
            &grant_path_at(root, user_id, skill_id, key),
            &OnceGrant {
                version: VAULT_STORE_VERSION,
                skill_id: skill_id.to_string(),
                key: key.to_string(),
                expires_at: now.saturating_add(ONCE_GRANT_TTL_MS),
            },
        )?;
    } else {
        let mut meta = read_meta_at(root, user_id)?;
        meta.allow_skill(key, skill_id, now);
        write_meta_at(root, user_id, &meta)?;
    }
    remove_keys_from_consent_request(root, user_id, skill_id, &[key]);
    Ok(())
}

#[cfg(test)]
pub(crate) fn revoke_key_access_at(
    root: &Path,
    user_id: &str,
    skill_id: &str,
    name: &str,
) -> Result<(), String> {
    revoke_key_access_variant_at(root, user_id, skill_id, name, None)
}

pub(crate) fn revoke_key_access_variant_at(
    root: &Path,
    user_id: &str,
    skill_id: &str,
    name: &str,
    variant: Option<&str>,
) -> Result<(), String> {
    validate_skill_id(skill_id)?;
    let (name, variant) = match split_variant_entry(name) {
        Some((base, parsed)) if variant.is_none_or(|variant| variant == parsed) => {
            (base, Some(parsed))
        }
        Some(_) => return Err("钥匙标签编号不一致".into()),
        None => (name, variant),
    };
    validate_vault_key(name)?;
    if let Some(variant) = variant {
        validate_variant_id(variant)?;
    }
    let mut meta = read_meta_at(root, user_id)?;
    let main = meta.alias_owner(name).unwrap_or(name).to_string();
    let key = variant.map_or_else(
        || main.clone(),
        |variant| variant_entry_name(&main, variant),
    );
    let key = key.as_str();
    if let Some(entry) = meta.keys.get_mut(key) {
        let before = entry.allowed_skills.len();
        entry.allowed_skills.retain(|id| id != skill_id);
        if entry.allowed_skills.len() != before {
            write_meta_at(root, user_id, &meta)?;
        }
    }
    let _ = fs::remove_file(grant_path_at(root, user_id, skill_id, key));
    Ok(())
}

/// Turns the vault key behind `name` on or off for one Skill (#294), from
/// the Skill cards of the 「钥匙」 page. Off: the Skill runs as if the vault
/// had no value (its allowance and one-shot grant are dropped). On: the
/// block is lifted and, when the Skill would otherwise ask first, it is
/// allowed too, so the card reads 已启用 without a consent dialog.
#[cfg(test)]
pub(crate) fn set_vault_key_skill_access_at(
    root: &Path,
    user_id: &str,
    name: &str,
    skill_id: &str,
    profile: Option<&SkillHubProfile>,
    enabled: bool,
    now: u64,
) -> Result<(), String> {
    set_vault_key_skill_access_variant_at(
        root, user_id, name, None, skill_id, profile, enabled, now,
    )
}

/// [`set_vault_key_skill_access_at`] for one value of the name: `variant`
/// picks a labelled value (#306), `None` the unlabelled one.
#[allow(clippy::too_many_arguments)]
pub(crate) fn set_vault_key_skill_access_variant_at(
    root: &Path,
    user_id: &str,
    name: &str,
    variant: Option<&str>,
    skill_id: &str,
    profile: Option<&SkillHubProfile>,
    enabled: bool,
    now: u64,
) -> Result<(), String> {
    validate_skill_id(skill_id)?;
    let key = resolve_identity_at(root, user_id, name, variant)?;
    let key = key.as_str();
    let mut meta = read_meta_at(root, user_id)?;
    if enabled {
        let requires_consent = profile.is_none_or(skill_requires_consent);
        if requires_consent {
            meta.allow_skill(key, skill_id, now);
        } else if let Some(entry) = meta.keys.get_mut(key) {
            entry.blocked_skills.retain(|id| id != skill_id);
        }
    } else {
        let entry = meta.keys.entry(key.to_string()).or_insert(VaultKeyMeta {
            created_at: now,
            updated_at: now,
            ..Default::default()
        });
        entry.allowed_skills.retain(|id| id != skill_id);
        if !entry.blocked_skills.iter().any(|id| id == skill_id) {
            if entry.blocked_skills.len() >= MAX_ALLOWED_SKILLS {
                return Err("停用的 Skill 数量超过上限".into());
            }
            entry.blocked_skills.push(skill_id.to_string());
            entry.blocked_skills.sort();
        }
    }
    write_meta_at(root, user_id, &meta)?;
    if !enabled {
        let _ = fs::remove_file(grant_path_at(root, user_id, skill_id, key));
    }
    remove_keys_from_consent_request(root, user_id, skill_id, &[key]);
    Ok(())
}

/// Replaces the other variable names of the vault key `key` (#288). A name
/// belongs to at most one key: it may not be any key's main name nor
/// another key's alias. Duplicates in `aliases` collapse.
pub(crate) fn set_vault_key_aliases_at(
    root: &Path,
    user_id: &str,
    key: &str,
    aliases: Vec<String>,
    now: u64,
) -> Result<(), String> {
    validate_vault_key(key)?;
    let mut meta = read_meta_at(root, user_id)?;
    let names = vault_key_names_at(root, user_id)?;
    if !names.contains(key) {
        return Err(format!("钥匙库中没有 {key}，请先填写"));
    }
    let mut unique = Vec::<String>::new();
    for alias in aliases {
        if !valid_env_key(&alias) {
            return Err("变量名必须为大写字母、数字和下划线".into());
        }
        if is_reserved_variant_name(&alias) {
            return Err(reserved_name_error(&alias));
        }
        if alias == key {
            return Err(format!("{alias} 就是这把钥匙的主名"));
        }
        if names.contains(&alias) || meta.keys.contains_key(&alias) {
            return Err(format!("{alias} 已经是一把钥匙的主名"));
        }
        if let Some(owner) = meta.alias_owner(&alias).filter(|owner| *owner != key) {
            return Err(format!("{alias} 已经是另一把钥匙（{owner}）的变量名"));
        }
        if !unique.contains(&alias) {
            unique.push(alias);
        }
    }
    if unique.len() > MAX_KEY_ALIASES {
        return Err(format!("一把钥匙最多只能有 {MAX_KEY_ALIASES} 个其他变量名"));
    }
    unique.sort();
    let entry = meta.keys.entry(key.to_string()).or_insert(VaultKeyMeta {
        created_at: now,
        updated_at: now,
        ..Default::default()
    });
    entry.aliases = unique;
    entry.updated_at = now;
    check_aliases(&meta, &names)?;
    write_meta_at(root, user_id, &meta)
}

/// The vault key (main name or alias) in the same service group as `key`,
/// for the 「用 FAL_KEY」 suggestion. `None` when `key` already belongs to a
/// vault key or no key of its service is in the vault.
pub(crate) fn suggest_alias_for(
    lookup: &BTreeMap<String, String>,
    key: &str,
) -> Option<(String, String)> {
    if lookup.contains_key(key) {
        return None;
    }
    let group = crate::env_detect::service_key_group(key)?;
    group
        .keys
        .iter()
        .filter(|name| name.as_str() != key)
        .find_map(|name| lookup.get(name))
        .map(|main| (group.service.clone(), main.clone()))
}

/// Removes this Skill's own override for `key`, so it uses the vault again.
pub(crate) fn remove_override_at(
    env_root: &Path,
    user_id: &str,
    skill_id: &str,
    key: &str,
) -> Result<(), String> {
    let path = crate::runtime_env::account_env_path_under(env_root, user_id, skill_id)?;
    if fs::symlink_metadata(&path).is_err() {
        return Ok(());
    }
    if !edit_env_file(&path, &[(key, None)])? {
        let _ = fs::remove_file(&path);
    }
    Ok(())
}

// ── Listing for the 「钥匙」 page (names and metadata only) ─────────────────

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultKeySkill {
    pub id: String,
    pub name: String,
    /// The name this Skill declares: the key itself or one of its aliases.
    pub declared_key: String,
    pub declared_description: Option<String>,
    /// Store, team and system Skills ask before using an account key.
    pub requires_consent: bool,
    /// This Skill can use this value now (#294): not turned off, and either
    /// it never asks or it is allowed (per Skill, per value or account-wide).
    pub enabled: bool,
    /// This row's value is the one the Skill resolves to (#306): its chosen
    /// variant or the default, and no own override for the declared name.
    pub in_use: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultKeyRow {
    /// The variable name (never a synthetic `NAME__V<n>`).
    pub key: String,
    /// `None` for the unlabelled value; `V<n>` for a labelled one (#306).
    pub variant: Option<String>,
    pub label: Option<String>,
    /// This value is what Skills without an explicit choice use.
    pub is_default: bool,
    /// Every value of this name (same list on each of its rows).
    pub variants: Vec<KeyVariantOption>,
    /// Other variable names this key answers to (#288); they belong to the
    /// name and apply to every value of it.
    pub aliases: Vec<String>,
    pub created_at: Option<u64>,
    pub updated_at: Option<u64>,
    /// Managed Skills that declare this key, by its main name or an alias.
    pub used_by_skills: Vec<VaultKeySkill>,
    pub allowed_skills: Vec<String>,
    /// Skills this value is turned off for (#294).
    pub blocked_skills: Vec<String>,
    pub auto_allow: bool,
    /// Skills that keep their own value for this key (override layer), e.g.
    /// after a migration found a different value: 「有 N 个 Skill 使用不同的」.
    /// Only on the default row.
    pub override_skills: Vec<String>,
    pub last_used_at: Option<u64>,
}

struct DeclaredUse {
    id: String,
    name: String,
    declared_key: String,
    declared_description: Option<String>,
    requires_consent: bool,
    choice: Option<Option<String>>,
    has_override: bool,
}

/// One row per value: the unlabelled value of a name and each labelled one.
pub(crate) fn list_vault_keys_at(
    root: &Path,
    managed_root: &Path,
    env_root: &Path,
    user_id: &str,
) -> Result<Vec<VaultKeyRow>, String> {
    let entries = vault_entry_names_at(root, user_id)?;
    let keys = main_names(&entries);
    let meta = read_meta_at(root, user_id)?;
    let lookup = lookup_names(&keys, &meta);
    let usage = read_usage_at(root, user_id);
    let mut used_by = BTreeMap::<String, Vec<DeclaredUse>>::new();
    let mut overrides = BTreeMap::<String, Vec<String>>::new();
    if !keys.is_empty() {
        if let Ok(dir_entries) = fs::read_dir(managed_root) {
            for entry in dir_entries.flatten() {
                let skill_id = entry.file_name().to_string_lossy().to_string();
                if validate_skill_id(&skill_id).is_err() {
                    continue;
                }
                let Ok(profile) = read_profile_at(managed_root, &skill_id) else {
                    continue;
                };
                let declared = profile
                    .env_dependencies
                    .iter()
                    .filter(|dependency| lookup.contains_key(&dependency.key))
                    .collect::<Vec<_>>();
                if declared.is_empty() {
                    continue;
                }
                let name = profile_display_name(&profile, &skill_id);
                let requires_consent = skill_requires_consent(&profile);
                let choices =
                    crate::runtime_env::personal_variant_choices_at(root, user_id, &skill_id);
                let allowed = declared
                    .iter()
                    .map(|dependency| dependency.key.clone())
                    .collect::<BTreeSet<_>>();
                let mut own_keys = BTreeSet::new();
                if let Ok(mut own) = read_private_env_values(
                    &account_env_path_at(env_root, user_id, &skill_id),
                    Some(&allowed),
                ) {
                    for key in own.keys() {
                        own_keys.insert(key.clone());
                        if let Some(main) = lookup.get(key) {
                            let skills = overrides.entry(main.clone()).or_default();
                            if !skills.contains(&skill_id) {
                                skills.push(skill_id.clone());
                            }
                        }
                    }
                    zeroize_map(&mut own);
                }
                for dependency in declared {
                    let Some(main) = lookup.get(&dependency.key) else {
                        continue;
                    };
                    used_by.entry(main.clone()).or_default().push(DeclaredUse {
                        id: skill_id.clone(),
                        name: name.clone(),
                        declared_key: dependency.key.clone(),
                        declared_description: dependency.description.clone(),
                        requires_consent,
                        choice: choices.get(&dependency.key).cloned(),
                        has_override: own_keys.contains(&dependency.key),
                    });
                }
            }
        }
    }
    let mut rows = Vec::new();
    for key in keys {
        let options = meta.variant_options(&key, &entries);
        let main_entry = meta.keys.get(&key);
        let aliases = main_entry
            .map(|entry| entry.aliases.clone())
            .unwrap_or_default();
        let declared = used_by.remove(&key).unwrap_or_default();
        let mut override_skills = overrides.remove(&key).unwrap_or_default();
        override_skills.sort();
        for option in &options {
            let identity = option
                .id
                .as_deref()
                .map_or_else(|| key.clone(), |variant| variant_entry_name(&key, variant));
            let entry = meta.keys.get(&identity);
            let mut used_by_skills = declared
                .iter()
                .map(|skill| VaultKeySkill {
                    id: skill.id.clone(),
                    name: skill.name.clone(),
                    declared_key: skill.declared_key.clone(),
                    declared_description: skill.declared_description.clone(),
                    requires_consent: skill.requires_consent,
                    enabled: !meta.blocks(&skill.id, &identity)
                        && (!skill.requires_consent || meta.allows(&skill.id, &identity)),
                    in_use: !skill.has_override
                        && meta
                            .choose_identity(
                                &key,
                                skill.choice.as_ref().map(Option::as_deref),
                                |id| entries.contains(id),
                            )
                            .is_some_and(|served| served == identity),
                })
                .collect::<Vec<_>>();
            used_by_skills.sort_by(|left, right| {
                left.name
                    .cmp(&right.name)
                    .then(left.id.cmp(&right.id))
                    .then(left.declared_key.cmp(&right.declared_key))
            });
            rows.push(VaultKeyRow {
                key: key.clone(),
                variant: option.id.clone(),
                label: option.label.clone(),
                is_default: option.is_default,
                variants: options.clone(),
                aliases: aliases.clone(),
                created_at: entry.map(|entry| entry.created_at),
                updated_at: entry.map(|entry| entry.updated_at),
                allowed_skills: entry
                    .map(|entry| entry.allowed_skills.clone())
                    .unwrap_or_default(),
                blocked_skills: entry
                    .map(|entry| entry.blocked_skills.clone())
                    .unwrap_or_default(),
                auto_allow: entry.is_some_and(|entry| entry.auto_allow),
                last_used_at: usage.get(&identity).copied(),
                used_by_skills,
                override_skills: if option.is_default {
                    override_skills.clone()
                } else {
                    Vec::new()
                },
            });
        }
    }
    Ok(rows)
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationConflict {
    pub key: String,
    /// Skills whose different value stayed as their own override.
    pub skill_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationSkipped {
    pub skill_id: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultMigrationReport {
    pub version: u8,
    pub migrated_at: u64,
    pub backup_dir: Option<String>,
    pub migrated_keys: Vec<String>,
    pub conflicts: Vec<MigrationConflict>,
    pub skipped: Vec<MigrationSkipped>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyVaultSettings {
    pub auto_allow: bool,
    pub migration: Option<VaultMigrationReport>,
}

pub(crate) fn key_vault_settings_at(
    root: &Path,
    user_id: &str,
) -> Result<KeyVaultSettings, String> {
    let meta = read_meta_at(root, user_id)?;
    let report_path = migration_report_path_at(root, user_id);
    let migration = fs::symlink_metadata(&report_path)
        .ok()
        .and_then(|_| read_private_json::<VaultMigrationReport>(&report_path).ok());
    Ok(KeyVaultSettings {
        auto_allow: meta.auto_allow,
        migration,
    })
}

// ── One-time migration and guest merge ──────────────────────────────────────

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MigrationMarker {
    version: u8,
    migrated_at: u64,
}

/// Runs the one-time per-Skill → vault migration for `user_id` if it has not
/// run yet. It holds the exclusive Runtime Session lease and only migrates
/// the identity that is current and stable; otherwise it does nothing (the
/// caller's own identity checks then fail as before).
pub(crate) fn ensure_vault_migrated_at(
    root: &Path,
    env_root: &Path,
    user_id: &str,
) -> Result<(), String> {
    ensure_vault_migrated_for_at(root, env_root, user_id, None)
}

pub(crate) fn ensure_vault_migrated_for_at(
    root: &Path,
    env_root: &Path,
    user_id: &str,
    expected: Option<&crate::runtime_env::RuntimeSession>,
) -> Result<(), String> {
    validate_user_id(user_id)?;
    let _lease = acquire_exclusive_session_lease_at(root)?;
    let session = read_session_at(root)?;
    if expected.is_some_and(|expected| *expected != session) {
        return Err(KEY_VAULT_ACCOUNT_CHANGED.into());
    }
    if session.user_id() != user_id || session.is_sync_pending() {
        return Ok(());
    }
    let data_root = session.storage_root(root);
    if fs::symlink_metadata(migration_marker_path_at(&data_root, user_id)).is_ok() {
        return Ok(());
    }
    let data_env_root = if session.space_id() == "official" {
        env_root.to_path_buf()
    } else {
        data_root.join("envs")
    };
    migrate_vault_locked_at(&data_root, &data_env_root, user_id, now_ms()).map(|_| ())
}

struct ParsedOverride {
    skill_id: String,
    path: PathBuf,
    contents: String,
    entries: BTreeMap<String, String>,
}

impl Drop for ParsedOverride {
    fn drop(&mut self) {
        self.contents.zeroize();
        zeroize_map(&mut self.entries);
    }
}

fn parse_override_file(path: &Path) -> Result<(String, BTreeMap<String, String>), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "unreadable")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("unsafe_file");
    }
    if metadata.uid() != crate::platform_fs::current_uid() || metadata.mode() & 0o077 != 0 {
        return Err("unsafe_permissions");
    }
    let mut bytes = fs::read(path).map_err(|_| "unreadable")?;
    let contents = match String::from_utf8(std::mem::take(&mut bytes)) {
        Ok(contents) => contents,
        Err(error) => {
            let mut bytes = error.into_bytes();
            bytes.zeroize();
            return Err("not_utf8");
        }
    };
    let mut contents = contents;
    let mut raw = match crate::commands::parse_env_entries(&contents) {
        Ok(raw) => raw,
        Err(_) => {
            contents.zeroize();
            return Err("invalid_format");
        }
    };
    let mut entries = BTreeMap::new();
    for (key, raw_value) in std::mem::take(&mut raw) {
        let mut raw_value = raw_value;
        let decoded = crate::commands::decode_stored_env_value(&raw_value);
        raw_value.zeroize();
        match decoded {
            Ok(value) => {
                entries.insert(key, value);
            }
            Err(_) => {
                contents.zeroize();
                zeroize_map(&mut entries);
                zeroize_map(&mut raw);
                return Err("invalid_format");
            }
        }
    }
    Ok((contents, entries))
}

/// The migration itself; the caller holds the exclusive session lease.
///
/// Per-Skill files are visited in Skill id order. Same key + same value →
/// into the vault (first one) and removed from the Skill file; same key +
/// different value → the first stays in the vault, the others remain as that
/// Skill's override and are reported. Every migrated Skill is recorded in
/// `allowedSkills`, so nothing that ran before asks for consent afterwards.
/// Unsafe, unreadable or malformed files are skipped and reported. Every file
/// that will be touched (and an existing vault) is copied to
/// `env-import-backups/vault-migration-<ts>/` before any change.
pub(crate) fn migrate_vault_locked_at(
    root: &Path,
    env_root: &Path,
    user_id: &str,
    now: u64,
) -> Result<VaultMigrationReport, String> {
    validate_user_id(user_id)?;
    let mut report = VaultMigrationReport {
        version: VAULT_STORE_VERSION,
        migrated_at: now,
        ..Default::default()
    };
    let account_root = env_root.join(user_id);
    let mut candidates = Vec::new();
    match fs::symlink_metadata(&account_root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            report.skipped.push(MigrationSkipped {
                skill_id: None,
                reason: "unsafe_directory".into(),
            });
        }
        Ok(_) => {
            let entries = fs::read_dir(&account_root)
                .map_err(|error| format!("无法读取本机环境变量目录: {error}"))?;
            for entry in entries.flatten() {
                let file_name = entry.file_name().to_string_lossy().to_string();
                let Some(skill_id) = file_name.strip_suffix(".env") else {
                    continue;
                };
                if validate_skill_id(skill_id).is_err() {
                    continue;
                }
                candidates.push((skill_id.to_string(), entry.path()));
            }
        }
        Err(_) => {}
    }
    candidates.sort();

    let mut parsed = Vec::new();
    for (skill_id, path) in candidates {
        match parse_override_file(&path) {
            Ok((contents, entries)) => parsed.push(ParsedOverride {
                skill_id,
                path,
                contents,
                entries,
            }),
            Err(reason) => report.skipped.push(MigrationSkipped {
                skill_id: Some(skill_id),
                reason: reason.into(),
            }),
        }
    }
    parsed.retain(|file| !file.entries.is_empty());

    ensure_vault_dir_at(root, user_id)?;
    if !parsed.is_empty() {
        let backup_root = migration_backup_root_at(root);
        ensure_private_directory(&backup_root)?;
        let backup_dir = backup_root.join(format!(
            "vault-migration-{now}-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        ensure_private_directory(&backup_dir)?;
        for file in &parsed {
            crate::commands::write_private_file(
                &backup_dir.join(format!("{}.env", file.skill_id)),
                &file.contents,
            )?;
        }
        let vault_path = vault_env_path_at(root, user_id);
        if let Some(mut existing) = crate::commands::read_env_file_for_update(&vault_path)? {
            let written =
                crate::commands::write_private_file(&backup_dir.join("vault.env"), &existing);
            existing.zeroize();
            written?;
        }
        report.backup_dir = Some(backup_dir.to_string_lossy().to_string());

        let mut vault = read_vault_values_at(root, user_id, None)?;
        let mut meta = read_meta_at(root, user_id)?;
        let mut additions = Vec::<String>::new();
        let mut removals = BTreeMap::<usize, Vec<String>>::new();
        let mut conflicts = BTreeMap::<String, BTreeSet<String>>::new();
        for (index, file) in parsed.iter().enumerate() {
            for (key, value) in &file.entries {
                // A name the user linked to another key stays this Skill's
                // own value; it never becomes a second key of that name.
                // A reserved `NAME__V<n>` never becomes a vault entry (#306).
                if !valid_personal_value(value)
                    || meta.alias_owner(key).is_some()
                    || is_reserved_variant_name(key)
                {
                    continue;
                }
                match vault.get(key) {
                    None => {
                        vault.insert(key.clone(), value.clone());
                        additions.push(key.clone());
                    }
                    Some(existing) if existing == value => {}
                    Some(_) => {
                        conflicts
                            .entry(key.clone())
                            .or_default()
                            .insert(file.skill_id.clone());
                        continue;
                    }
                }
                meta.allow_skill(key, &file.skill_id, now);
                removals.entry(index).or_default().push(key.clone());
            }
        }
        let edits = additions
            .iter()
            .map(|key| (key.as_str(), vault.get(key).map(String::as_str)))
            .collect::<Vec<_>>();
        let written = if edits.is_empty() {
            Ok(true)
        } else {
            edit_env_file(&vault_path, &edits)
        };
        zeroize_map(&mut vault);
        written?;
        write_meta_at(root, user_id, &meta)?;
        for (index, keys) in removals {
            let file = &parsed[index];
            let edits = keys
                .iter()
                .map(|key| (key.as_str(), None))
                .collect::<Vec<_>>();
            if !edit_env_file(&file.path, &edits)? {
                fs::remove_file(&file.path)
                    .map_err(|error| format!("无法清理已迁移的环境变量文件: {error}"))?;
            }
        }
        report.migrated_keys = additions;
        report.migrated_keys.sort();
        report.conflicts = conflicts
            .into_iter()
            .map(|(key, skill_ids)| MigrationConflict {
                key,
                skill_ids: skill_ids.into_iter().collect(),
            })
            .collect();
    }
    if report.backup_dir.is_some() || !report.skipped.is_empty() {
        write_private_json(&migration_report_path_at(root, user_id), &report)?;
    }
    write_private_json(
        &migration_marker_path_at(root, user_id),
        &MigrationMarker {
            version: VAULT_STORE_VERSION,
            migrated_at: now,
        },
    )?;
    Ok(report)
}

/// Login: the guest vault joins the account vault without overwriting any
/// key the account already has. Allowed Skills come along with each new key;
/// the account-level 「以后不再询问」 switch never does.
pub(crate) fn merge_guest_vault_at(
    root: &Path,
    guest_user_id: &str,
    account_user_id: &str,
) -> Result<(), String> {
    validate_user_id(guest_user_id)?;
    validate_user_id(account_user_id)?;
    if guest_user_id == account_user_id {
        return Ok(());
    }
    let guest_dir = vault_dir_at(root, guest_user_id);
    let Ok(metadata) = fs::symlink_metadata(&guest_dir) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != crate::platform_fs::current_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err("游客钥匙库目录不是安全的私有目录".into());
    }
    let mut guest_values = read_vault_values_at(root, guest_user_id, None)?;
    if guest_values.is_empty() {
        return Ok(());
    }
    let result = (|| -> Result<(), String> {
        let guest_meta = read_meta_at(root, guest_user_id)?;
        let account_keys = vault_key_names_at(root, account_user_id)?;
        let mut meta = read_meta_at(root, account_user_id)?;
        let now = now_ms();
        let edits = guest_values
            .iter()
            // A name joins with all its values (labelled ones included,
            // #306) or not at all.
            .filter(|(key, value)| {
                let main = identity_main(key);
                !account_keys.contains(main)
                    && meta.alias_owner(main).is_none()
                    && valid_personal_value(value)
            })
            .map(|(key, value)| (key.as_str(), Some(value.as_str())))
            .collect::<Vec<_>>();
        if edits.is_empty() {
            return Ok(());
        }
        ensure_vault_dir_at(root, account_user_id)?;
        edit_env_file(&vault_env_path_at(root, account_user_id), &edits)?;
        let copied = edits
            .iter()
            .flat_map(|(key, _)| [*key, identity_main(key)])
            .collect::<BTreeSet<_>>();
        for key in copied {
            let mut entry = guest_meta.keys.get(key).cloned().unwrap_or(VaultKeyMeta {
                created_at: now,
                updated_at: now,
                ..Default::default()
            });
            entry.auto_allow = false;
            meta.keys.insert(key.to_string(), entry);
        }
        // A guest alias comes along only while that name is still free in
        // the account: never a main name, never another key's alias.
        let names = account_keys
            .iter()
            .cloned()
            .chain(edits.iter().map(|(key, _)| identity_main(key).to_string()))
            .collect::<BTreeSet<_>>();
        let mains = edits
            .iter()
            .map(|(key, _)| identity_main(key))
            .collect::<BTreeSet<_>>();
        for key in mains {
            let aliases = meta
                .keys
                .get(key)
                .map(|entry| entry.aliases.clone())
                .unwrap_or_default();
            let mut kept = Vec::new();
            for alias in aliases {
                let claimed = names.contains(&alias)
                    || meta.keys.contains_key(&alias)
                    || meta
                        .keys
                        .iter()
                        .any(|(other, entry)| other != key && entry.aliases.contains(&alias));
                if !claimed && !kept.contains(&alias) {
                    kept.push(alias);
                }
            }
            if let Some(entry) = meta.keys.get_mut(key) {
                entry.aliases = kept;
            }
        }
        write_meta_at(root, account_user_id, &meta)
    })();
    zeroize_map(&mut guest_values);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use crate::platform_fs::PermissionsExt;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    const USER_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const USER_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    fn fixture() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("skillhub-key-vault-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create fixture");
        root
    }

    fn write_override(root: &Path, user: &str, skill: &str, contents: &[u8], mode: u32) -> PathBuf {
        let directory = root.join("envs").join(user);
        fs::create_dir_all(&directory).expect("create env dir");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).expect("private dir");
        let path = directory.join(format!("{skill}.env"));
        fs::write(&path, contents).expect("write env");
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).expect("chmod env");
        path
    }

    fn vault_values(root: &Path, user: &str) -> BTreeMap<String, String> {
        read_vault_values_at(root, user, None).expect("read vault")
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        fs::metadata(path).expect("metadata").permissions().mode() & 0o777
    }

    #[test]
    fn migration_with_no_files_only_writes_the_marker() {
        let root = fixture();
        let report =
            migrate_vault_locked_at(&root, &root.join("envs"), USER_A, 1).expect("migrate");
        assert!(report.backup_dir.is_none());
        assert!(report.migrated_keys.is_empty());
        assert!(migration_marker_path_at(&root, USER_A).exists());
        assert!(!migration_report_path_at(&root, USER_A).exists());
        assert!(!vault_env_path_at(&root, USER_A).exists());
        assert!(!root.join("env-import-backups").exists());
        #[cfg(unix)]
        assert_eq!(mode_of(&vault_dir_at(&root, USER_A)), 0o700);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn migration_moves_same_values_into_the_vault_and_backs_up_first() {
        let root = fixture();
        let first = write_override(
            &root,
            USER_A,
            "alpha",
            b"FAL_KEY=fake-fal\nOTHER=keep-me\n",
            0o600,
        );
        let second = write_override(&root, USER_A, "beta", b"export FAL_KEY='fake-fal'\n", 0o600);
        let report =
            migrate_vault_locked_at(&root, &root.join("envs"), USER_A, 7).expect("migrate");
        assert_eq!(
            report.migrated_keys,
            vec!["FAL_KEY".to_string(), "OTHER".to_string()]
        );
        assert!(report.conflicts.is_empty());
        let vault = vault_values(&root, USER_A);
        assert_eq!(vault.get("FAL_KEY").map(String::as_str), Some("fake-fal"));
        assert_eq!(vault.get("OTHER").map(String::as_str), Some("keep-me"));
        #[cfg(unix)]
        assert_eq!(mode_of(&vault_env_path_at(&root, USER_A)), 0o600);
        assert!(!first.exists() && !second.exists());
        let meta = read_meta_at(&root, USER_A).expect("meta");
        assert_eq!(meta.keys["FAL_KEY"].allowed_skills, vec!["alpha", "beta"]);
        assert!(!meta.auto_allow);
        let backup = PathBuf::from(report.backup_dir.expect("backup dir"));
        #[cfg(unix)]
        assert_eq!(mode_of(&backup), 0o700);
        assert_eq!(
            fs::read_to_string(backup.join("alpha.env")).expect("backup alpha"),
            "FAL_KEY=fake-fal\nOTHER=keep-me\n"
        );
        #[cfg(unix)]
        assert_eq!(mode_of(&backup.join("beta.env")), 0o600);
        let report_text =
            fs::read_to_string(migration_report_path_at(&root, USER_A)).expect("report");
        assert!(!report_text.contains("fake-fal") && !report_text.contains("keep-me"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn migration_keeps_conflicting_values_as_overrides_and_reports_them() {
        let root = fixture();
        write_override(&root, USER_A, "alpha", b"FAL_KEY=fake-first\n", 0o600);
        let beta = write_override(
            &root,
            USER_A,
            "beta",
            b"FAL_KEY=fake-second\nEXTRA=x\n",
            0o600,
        );
        let report =
            migrate_vault_locked_at(&root, &root.join("envs"), USER_A, 7).expect("migrate");
        assert_eq!(
            report.conflicts,
            vec![MigrationConflict {
                key: "FAL_KEY".into(),
                skill_ids: vec!["beta".into()],
            }]
        );
        assert_eq!(vault_values(&root, USER_A)["FAL_KEY"], "fake-first");
        assert_eq!(
            fs::read_to_string(&beta).expect("override kept"),
            "FAL_KEY=fake-second\n"
        );
        let meta = read_meta_at(&root, USER_A).expect("meta");
        assert_eq!(meta.keys["FAL_KEY"].allowed_skills, vec!["alpha"]);
        let report_text =
            fs::read_to_string(migration_report_path_at(&root, USER_A)).expect("report");
        assert!(report_text.contains("beta") && !report_text.contains("fake-"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn migration_skips_and_reports_corrupt_files_without_stopping() {
        let root = fixture();
        let _loose = write_override(&root, USER_A, "loose", b"FAL_KEY=fake-loose\n", 0o644);
        let binary = write_override(&root, USER_A, "binary", b"FAL_KEY=\xff\xfe\n", 0o600);
        let broken = write_override(&root, USER_A, "broken", b"not an assignment\n", 0o600);
        write_override(&root, USER_A, "good", b"FAL_KEY=fake-good\n", 0o600);
        let report =
            migrate_vault_locked_at(&root, &root.join("envs"), USER_A, 7).expect("migrate");
        let reasons = report
            .skipped
            .iter()
            .map(|skipped| {
                (
                    skipped.skill_id.clone().unwrap_or_default(),
                    skipped.reason.clone(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(reasons["binary"], "not_utf8");
        assert_eq!(reasons["broken"], "invalid_format");
        #[cfg(unix)]
        assert_eq!(reasons["loose"], "unsafe_permissions");
        assert_eq!(vault_values(&root, USER_A)["FAL_KEY"], "fake-good");
        assert!(binary.exists() && broken.exists());
        #[cfg(unix)]
        assert!(_loose.exists());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn ensure_migrates_once_for_the_current_identity_only() {
        let root = fixture();
        crate::runtime_env::test_sessions::sign_in(&root, USER_A);
        write_override(&root, USER_A, "alpha", b"FAL_KEY=fake-a\n", 0o600);
        write_override(&root, USER_B, "alpha", b"FAL_KEY=fake-b\n", 0o600);
        // B is not the current identity: nothing happens for B.
        ensure_vault_migrated_at(&root, &root.join("envs"), USER_B).expect("skip B");
        assert!(!migration_marker_path_at(&root, USER_B).exists());
        ensure_vault_migrated_at(&root, &root.join("envs"), USER_A).expect("migrate A");
        assert!(migration_marker_path_at(&root, USER_A).exists());
        // A per-Skill value written after the migration is an intentional
        // override; a second start must not fold it into the vault.
        write_override(&root, USER_A, "beta", b"FAL_KEY=fake-override\n", 0o600);
        ensure_vault_migrated_at(&root, &root.join("envs"), USER_A).expect("re-run is a no-op");
        assert_eq!(
            fs::read_dir(root.join("env-import-backups"))
                .expect("backups")
                .count(),
            1
        );
        assert!(root.join("envs").join(USER_A).join("beta.env").exists());
        assert_eq!(vault_values(&root, USER_A)["FAL_KEY"], "fake-a");
        assert!(vault_values(&root, USER_B).is_empty());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn guest_vault_merges_into_the_account_without_overwriting() {
        let root = fixture();
        set_vault_key_at(&root, USER_B, "FAL_KEY", "fake-guest", Some("alpha"), 1).expect("guest");
        set_vault_key_at(&root, USER_B, "NEW_KEY", "fake-guest-new", Some("alpha"), 1)
            .expect("guest new");
        set_key_auto_allow_at(&root, USER_B, true, None, 1).expect("guest auto allow");
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-account", None, 2).expect("account");
        merge_guest_vault_at(&root, USER_B, USER_A).expect("merge");
        let vault = vault_values(&root, USER_A);
        assert_eq!(vault["FAL_KEY"], "fake-account");
        assert_eq!(vault["NEW_KEY"], "fake-guest-new");
        let meta = read_meta_at(&root, USER_A).expect("meta");
        assert!(!meta.auto_allow);
        assert_eq!(meta.keys["NEW_KEY"].allowed_skills, vec!["alpha"]);
        assert!(meta.keys["FAL_KEY"].allowed_skills.is_empty());
        merge_guest_vault_at(&root, USER_B, USER_A).expect("idempotent merge");
        assert_eq!(vault_values(&root, USER_A).len(), 2);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn consent_rules_follow_ownership_grants_and_auto_allow() {
        let root = fixture();
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake", None, 1).expect("set");
        let keys = BTreeSet::from(["FAL_KEY".to_string()]);
        let own = SkillHubProfile::default();
        let team = SkillHubProfile {
            is_own: Some(false),
            acquisition_source: Some(AcquisitionSource::Team),
            team_shared_from: Some("team".into()),
            ..Default::default()
        };
        let market = SkillHubProfile {
            is_own: Some(false),
            acquisition_source: Some(AcquisitionSource::Marketplace),
            ..Default::default()
        };
        assert!(evaluate_consent_at(&root, USER_A, "own", &own, &keys, 1)
            .expect("own")
            .pending
            .is_empty());
        assert_eq!(
            evaluate_consent_at(&root, USER_A, "team", &team, &keys, 1)
                .expect("team")
                .pending,
            vec!["FAL_KEY"]
        );
        // 仅这次: valid once, expires, and is consumed.
        grant_key_access_at(&root, USER_A, "team", "FAL_KEY", true, 100).expect("once");
        assert!(read_meta_at(&root, USER_A).expect("meta").keys["FAL_KEY"]
            .allowed_skills
            .is_empty());
        let expired =
            evaluate_consent_at(&root, USER_A, "team", &team, &keys, 100 + ONCE_GRANT_TTL_MS)
                .expect("expired");
        assert_eq!(expired.pending, vec!["FAL_KEY"]);
        grant_key_access_at(&root, USER_A, "team", "FAL_KEY", true, 200).expect("once again");
        let once = evaluate_consent_at(&root, USER_A, "team", &team, &keys, 201).expect("once");
        assert!(once.pending.is_empty());
        once.consume_once_grants();
        assert_eq!(
            evaluate_consent_at(&root, USER_A, "team", &team, &keys, 202)
                .expect("consumed")
                .pending,
            vec!["FAL_KEY"]
        );
        // 允许 is remembered; revoke takes it back.
        grant_key_access_at(&root, USER_A, "team", "FAL_KEY", false, 300).expect("allow");
        assert!(
            evaluate_consent_at(&root, USER_A, "team", &team, &keys, 301)
                .expect("allowed")
                .pending
                .is_empty()
        );
        revoke_key_access_at(&root, USER_A, "team", "FAL_KEY").expect("revoke");
        assert_eq!(
            evaluate_consent_at(&root, USER_A, "team", &team, &keys, 302)
                .expect("revoked")
                .pending,
            vec!["FAL_KEY"]
        );
        // 以后不再询问 bypasses, and can be switched back off.
        set_key_auto_allow_at(&root, USER_A, true, None, 400).expect("auto");
        assert!(
            evaluate_consent_at(&root, USER_A, "market", &market, &keys, 401)
                .expect("auto")
                .pending
                .is_empty()
        );
        set_key_auto_allow_at(&root, USER_A, false, None, 402).expect("auto off");
        assert_eq!(
            evaluate_consent_at(&root, USER_A, "market", &market, &keys, 403)
                .expect("auto off")
                .pending,
            vec!["FAL_KEY"]
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn consent_requests_are_value_free_and_settled_by_a_grant() {
        let root = fixture();
        let managed = root.join("skills");
        fs::create_dir_all(managed.join("team")).expect("skill dir");
        fs::write(
            managed.join("team").join(".skillhub.json"),
            r#"{"version":"1","skillhub":{"id":"team","displayName":"Team Image","isOwn":false,"acquisitionSource":"marketplace","envDependencies":[{"key":"FAL_KEY","required":true}]}}"#,
        )
        .expect("profile");
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-secret-value", None, 1).expect("set");
        record_consent_request_at(&root, USER_A, "team", &["FAL_KEY".into()], now_ms())
            .expect("record");
        let requests = list_consent_requests_at(&root, &managed, USER_A, now_ms()).expect("list");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].skill_name, "Team Image");
        assert_eq!(requests[0].keys, vec!["FAL_KEY"]);
        assert!(!serde_json::to_string(&requests)
            .expect("json")
            .contains("fake-secret-value"));
        grant_key_access_at(&root, USER_A, "team", "FAL_KEY", false, now_ms()).expect("allow");
        assert!(list_consent_requests_at(&root, &managed, USER_A, now_ms())
            .expect("list after grant")
            .is_empty());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn listing_returns_names_and_metadata_but_never_values() {
        let root = fixture();
        let managed = root.join("skills");
        for (id, name) in [("alpha", "Alpha"), ("beta", "Beta")] {
            fs::create_dir_all(managed.join(id)).expect("skill dir");
            fs::write(
                managed.join(id).join(".skillhub.json"),
                format!(r#"{{"version":"1","skillhub":{{"id":"{id}","displayName":"{name}","envDependencies":[{{"key":"FAL_KEY","description":"fal.ai","required":true}}]}}}}"#),
            )
            .expect("profile");
        }
        set_vault_key_at(
            &root,
            USER_A,
            "FAL_KEY",
            "fake-vault-secret",
            Some("alpha"),
            5,
        )
        .expect("set");
        write_override(
            &root,
            USER_A,
            "beta",
            b"FAL_KEY=fake-override-secret\n",
            0o600,
        );
        record_vault_usage_at(&root, USER_A, &["FAL_KEY".into()], 9);
        let rows = list_vault_keys_at(&root, &managed, &root.join("envs"), USER_A).expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].used_by_skills.len(), 2);
        assert_eq!(
            rows[0].used_by_skills[0].declared_description.as_deref(),
            Some("fal.ai")
        );
        assert_eq!(rows[0].allowed_skills, vec!["alpha"]);
        assert_eq!(rows[0].override_skills, vec!["beta"]);
        assert_eq!(rows[0].last_used_at, Some(9));
        let json = serde_json::to_string(&rows).expect("json");
        assert!(!json.contains("fake-vault-secret") && !json.contains("fake-override-secret"));
        let settings =
            serde_json::to_string(&key_vault_settings_at(&root, USER_A).expect("settings"))
                .expect("settings json");
        assert!(!settings.contains("fake-"));
        delete_vault_key_at(&root, USER_A, "FAL_KEY").expect("delete");
        assert!(
            list_vault_keys_at(&root, &managed, &root.join("envs"), USER_A)
                .expect("list after delete")
                .is_empty()
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    fn write_profile(managed: &Path, id: &str, key: &str) {
        fs::create_dir_all(managed.join(id)).expect("skill dir");
        fs::write(
            managed.join(id).join(".skillhub.json"),
            format!(r#"{{"version":"1","skillhub":{{"id":"{id}","displayName":"Skill {id}","isOwn":false,"acquisitionSource":"marketplace","envDependencies":[{{"key":"{key}","description":"fal.ai","required":true}}]}}}}"#),
        )
        .expect("profile");
    }

    #[test]
    fn aliases_round_trip_in_meta_and_invalid_meta_is_rejected() {
        let root = fixture();
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-fal", None, 1).expect("fal");
        set_vault_key_at(&root, USER_A, "OPENAI_API_KEY", "fake-openai", None, 1).expect("openai");
        set_vault_key_aliases_at(
            &root,
            USER_A,
            "FAL_KEY",
            vec![
                "FAL_API_KEY".into(),
                "FAL_AI_KEY".into(),
                "FAL_API_KEY".into(),
            ],
            5,
        )
        .expect("aliases");
        let meta = read_meta_at(&root, USER_A).expect("meta");
        assert_eq!(
            meta.keys["FAL_KEY"].aliases,
            vec!["FAL_AI_KEY", "FAL_API_KEY"]
        );
        assert_eq!(meta.keys["FAL_KEY"].updated_at, 5);
        // A key without aliases keeps the old on-disk shape.
        let text = fs::read_to_string(vault_meta_path_at(&root, USER_A)).expect("meta text");
        assert_eq!(text.matches("\"aliases\"").count(), 1);
        assert!(!text.contains("fake-"));
        let lookup = vault_lookup_names_at(&root, USER_A).expect("lookup");
        assert_eq!(lookup["FAL_API_KEY"], "FAL_KEY");
        assert_eq!(lookup["FAL_KEY"], "FAL_KEY");
        assert_eq!(lookup["OPENAI_API_KEY"], "OPENAI_API_KEY");

        // Hand-edited metadata: the same alias on two keys, or an alias that
        // is a main name, makes the metadata invalid.
        let mut duplicate = read_meta_at(&root, USER_A).expect("meta");
        duplicate
            .keys
            .get_mut("OPENAI_API_KEY")
            .expect("openai meta")
            .aliases = vec!["FAL_API_KEY".into()];
        write_meta_at(&root, USER_A, &duplicate).expect("write dup");
        assert_eq!(
            read_meta_at(&root, USER_A).err().as_deref(),
            Some("本机钥匙库元数据无效")
        );
        let mut main_name = duplicate;
        main_name
            .keys
            .get_mut("OPENAI_API_KEY")
            .expect("openai meta")
            .aliases = vec!["FAL_KEY".into()];
        write_meta_at(&root, USER_A, &main_name).expect("write main");
        assert_eq!(
            read_meta_at(&root, USER_A).err().as_deref(),
            Some("本机钥匙库元数据无效")
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn setting_aliases_names_the_clashing_key() {
        let root = fixture();
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-fal", None, 1).expect("fal");
        set_vault_key_at(&root, USER_A, "OPENAI_API_KEY", "fake-openai", None, 1).expect("openai");
        set_vault_key_aliases_at(
            &root,
            USER_A,
            "OPENAI_API_KEY",
            vec!["FAL_API_KEY".into()],
            2,
        )
        .expect("openai alias");
        assert_eq!(
            set_vault_key_aliases_at(&root, USER_A, "FAL_KEY", vec!["FAL_API_KEY".into()], 3),
            Err("FAL_API_KEY 已经是另一把钥匙（OPENAI_API_KEY）的变量名".into())
        );
        assert_eq!(
            set_vault_key_aliases_at(&root, USER_A, "FAL_KEY", vec!["OPENAI_API_KEY".into()], 3),
            Err("OPENAI_API_KEY 已经是一把钥匙的主名".into())
        );
        assert!(
            set_vault_key_aliases_at(&root, USER_A, "FAL_KEY", vec!["FAL_KEY".into()], 3).is_err()
        );
        assert!(
            set_vault_key_aliases_at(&root, USER_A, "FAL_KEY", vec!["bad name".into()], 3).is_err()
        );
        assert!(set_vault_key_aliases_at(
            &root,
            USER_A,
            "FAL_KEY",
            (0..=MAX_KEY_ALIASES)
                .map(|i| format!("FAL_ALIAS_{i}"))
                .collect(),
            3
        )
        .is_err());
        assert!(
            set_vault_key_aliases_at(&root, USER_A, "MISSING_KEY", vec!["X_KEY".into()], 3)
                .is_err()
        );
        // A new key may not take a name that is already another key's alias.
        assert_eq!(
            set_vault_key_at(&root, USER_A, "FAL_API_KEY", "fake-other", None, 4),
            Err("FAL_API_KEY 已经是另一把钥匙（OPENAI_API_KEY）的变量名".into())
        );
        // Moving the alias: free it first, then link it elsewhere.
        set_vault_key_aliases_at(&root, USER_A, "OPENAI_API_KEY", Vec::new(), 5).expect("clear");
        set_vault_key_aliases_at(&root, USER_A, "FAL_KEY", vec!["FAL_API_KEY".into()], 6)
            .expect("move");
        // Deleting a key drops its aliases with it.
        delete_vault_key_at(&root, USER_A, "FAL_KEY").expect("delete");
        assert!(!vault_lookup_names_at(&root, USER_A)
            .expect("lookup")
            .contains_key("FAL_API_KEY"));
        set_vault_key_at(&root, USER_A, "FAL_API_KEY", "fake-own", None, 7)
            .expect("name is free again");
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn personal_values_serve_an_alias_under_the_requested_name() {
        let root = fixture();
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-fal", None, 1).expect("fal");
        let requested = BTreeSet::from(["FAL_API_KEY".to_string()]);
        let read = |root: &Path| {
            read_personal_values_at(
                root,
                &root.join("envs"),
                USER_A,
                "alpha",
                &requested,
                &BTreeMap::new(),
            )
            .expect("personal")
        };
        assert!(read(&root).values().is_empty());
        set_vault_key_aliases_at(&root, USER_A, "FAL_KEY", vec!["FAL_API_KEY".into()], 2)
            .expect("alias");
        let personal = read(&root);
        assert_eq!(
            personal.values().get("FAL_API_KEY").map(String::as_str),
            Some("fake-fal")
        );
        assert!(!personal.values().contains_key("FAL_KEY"));
        assert_eq!(personal.sources()["FAL_API_KEY"], PersonalSource::Vault);
        assert_eq!(personal.vault_identity()["FAL_API_KEY"], "FAL_KEY");
        assert_eq!(
            personal.vault_main_names(&personal.vault_keys()),
            BTreeSet::from(["FAL_KEY".to_string()])
        );
        drop(personal);
        // This Skill's own value for the declared name still wins.
        write_override(&root, USER_A, "alpha", b"FAL_API_KEY=fake-own\n", 0o600);
        let personal = read(&root);
        assert_eq!(personal.values()["FAL_API_KEY"], "fake-own");
        assert_eq!(personal.sources()["FAL_API_KEY"], PersonalSource::Override);
        assert!(personal.vault_identity().is_empty());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn consent_and_listing_follow_the_key_identity_across_aliases() {
        let root = fixture();
        let managed = root.join("skills");
        write_profile(&managed, "direct", "FAL_KEY");
        write_profile(&managed, "aliased", "FAL_API_KEY");
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-secret", None, 1).expect("fal");
        set_vault_key_aliases_at(&root, USER_A, "FAL_KEY", vec!["FAL_API_KEY".into()], 2)
            .expect("alias");
        // A grant given through the alias name is stored for FAL_KEY.
        grant_key_access_at(&root, USER_A, "aliased", "FAL_API_KEY", false, 3).expect("grant");
        assert_eq!(
            read_meta_at(&root, USER_A).expect("meta").keys["FAL_KEY"].allowed_skills,
            vec!["aliased"]
        );
        revoke_key_access_at(&root, USER_A, "aliased", "FAL_API_KEY").expect("revoke");
        assert!(read_meta_at(&root, USER_A).expect("meta").keys["FAL_KEY"]
            .allowed_skills
            .is_empty());
        set_key_auto_allow_at(&root, USER_A, true, Some("FAL_API_KEY"), 4).expect("auto");
        assert!(read_meta_at(&root, USER_A).expect("meta").keys["FAL_KEY"].auto_allow);
        assert!(!read_meta_at(&root, USER_A)
            .expect("meta")
            .keys
            .contains_key("FAL_API_KEY"));

        let rows = list_vault_keys_at(&root, &managed, &root.join("envs"), USER_A).expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, "FAL_KEY");
        assert_eq!(rows[0].aliases, vec!["FAL_API_KEY"]);
        let declared = rows[0]
            .used_by_skills
            .iter()
            .map(|skill| (skill.id.as_str(), skill.declared_key.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            declared,
            vec![("aliased", "FAL_API_KEY"), ("direct", "FAL_KEY")]
        );
        let json = serde_json::to_value(&rows).expect("json");
        assert_eq!(json[0]["aliases"][0], "FAL_API_KEY");
        assert_eq!(json[0]["usedBySkills"][0]["declaredKey"], "FAL_API_KEY");
        assert!(!json.to_string().contains("fake-secret"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn listing_reports_per_skill_enabled_state_and_blocked_skills() {
        let root = fixture();
        let managed = root.join("skills");
        write_profile(&managed, "market", "FAL_API_KEY");
        fs::create_dir_all(managed.join("own")).expect("own dir");
        fs::write(
            managed.join("own").join(".skillhub.json"),
            r#"{"version":"1","skillhub":{"id":"own","displayName":"Zed own","envDependencies":[{"key":"FAL_KEY","required":true}]}}"#,
        )
        .expect("own profile");
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-secret", None, 1).expect("fal");
        set_vault_key_aliases_at(&root, USER_A, "FAL_KEY", vec!["FAL_API_KEY".into()], 2)
            .expect("alias");
        let state = |root: &Path| {
            let rows =
                list_vault_keys_at(root, &managed, &root.join("envs"), USER_A).expect("list");
            let skills = rows[0]
                .used_by_skills
                .iter()
                .map(|skill| (skill.id.clone(), skill.requires_consent, skill.enabled))
                .collect::<Vec<_>>();
            (skills, rows[0].blocked_skills.clone())
        };
        // Own Skills never ask; a store Skill is off until allowed.
        assert_eq!(
            state(&root).0,
            vec![("market".into(), true, false), ("own".into(), false, true)]
        );
        let market = read_profile_at(&managed, "market").ok();
        set_vault_key_skill_access_at(
            &root,
            USER_A,
            "FAL_API_KEY",
            "market",
            market.as_ref(),
            true,
            3,
        )
        .expect("on");
        assert_eq!(
            read_meta_at(&root, USER_A).expect("meta").keys["FAL_KEY"].allowed_skills,
            vec!["market"]
        );
        assert!(state(&root).0[0].2);
        let own = read_profile_at(&managed, "own").ok();
        set_vault_key_skill_access_at(&root, USER_A, "FAL_KEY", "own", own.as_ref(), false, 4)
            .expect("off");
        set_vault_key_skill_access_at(
            &root,
            USER_A,
            "FAL_KEY",
            "market",
            market.as_ref(),
            false,
            5,
        )
        .expect("off market");
        let (skills, blocked) = state(&root);
        assert_eq!(
            skills,
            vec![("market".into(), true, false), ("own".into(), false, false)]
        );
        assert_eq!(blocked, vec!["market", "own"]);
        let meta = read_meta_at(&root, USER_A).expect("meta");
        assert!(meta.keys["FAL_KEY"].allowed_skills.is_empty());
        // Even account-wide auto-allow does not undo a block.
        set_key_auto_allow_at(&root, USER_A, true, None, 6).expect("auto");
        assert!(!state(&root).0[1].2);
        // Blocked names drop out of the per-Skill lookup only.
        assert!(!vault_lookup_names_for_skill_at(&root, USER_A, "market")
            .expect("lookup")
            .contains_key("FAL_API_KEY"));
        assert!(vault_lookup_names_for_skill_at(&root, USER_A, "other")
            .expect("lookup")
            .contains_key("FAL_API_KEY"));
        set_vault_key_skill_access_at(&root, USER_A, "FAL_KEY", "own", own.as_ref(), true, 7)
            .expect("on own");
        let (skills, blocked) = state(&root);
        assert!(skills[1].2);
        assert_eq!(blocked, vec!["market"]);
        // Own Skills are not added to the allow list when turned back on.
        assert!(!read_meta_at(&root, USER_A).expect("meta").keys["FAL_KEY"]
            .allowed_skills
            .contains(&"own".to_string()));
        let json = serde_json::to_value(
            list_vault_keys_at(&root, &managed, &root.join("envs"), USER_A).expect("list"),
        )
        .expect("json");
        assert_eq!(json[0]["blockedSkills"][0], "market");
        assert_eq!(json[0]["usedBySkills"][0]["requiresConsent"], true);
        assert_eq!(json[0]["usedBySkills"][0]["enabled"], false);
        assert!(
            set_vault_key_skill_access_at(&root, USER_A, "NOPE_KEY", "own", None, false, 8)
                .is_err()
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn alias_suggestion_points_at_a_vault_key_of_the_same_service() {
        let lookup = BTreeMap::from([
            ("FAL_KEY".to_string(), "FAL_KEY".to_string()),
            ("HF_TOKEN".to_string(), "HF_TOKEN".to_string()),
            ("HUGGINGFACE_TOKEN".to_string(), "HF_TOKEN".to_string()),
        ]);
        assert_eq!(
            suggest_alias_for(&lookup, "FAL_API_KEY"),
            Some(("fal.ai".to_string(), "FAL_KEY".to_string()))
        );
        // Already a name of a vault key (main name or alias): no suggestion.
        assert_eq!(suggest_alias_for(&lookup, "FAL_KEY"), None);
        assert_eq!(suggest_alias_for(&lookup, "HUGGINGFACE_TOKEN"), None);
        // Found through another key's alias, it names that key.
        let via_alias = BTreeMap::from([("HUGGINGFACE_TOKEN".to_string(), "MY_HF".to_string())]);
        assert_eq!(
            suggest_alias_for(&via_alias, "HF_TOKEN"),
            Some(("Hugging Face".to_string(), "MY_HF".to_string()))
        );
        // No key of the service, or no service group at all.
        assert_eq!(suggest_alias_for(&lookup, "OPENAI_API_KEY"), None);
        assert_eq!(suggest_alias_for(&lookup, "OUTPUT_DIR"), None);
    }

    #[test]
    fn guest_aliases_join_only_while_the_name_is_free() {
        let root = fixture();
        set_vault_key_at(&root, USER_B, "FAL_KEY", "fake-guest", None, 1).expect("guest fal");
        set_vault_key_at(&root, USER_B, "NEW_KEY", "fake-guest-new", None, 1).expect("guest new");
        set_vault_key_aliases_at(
            &root,
            USER_B,
            "NEW_KEY",
            vec!["SHARED_NAME".into(), "FREE_NAME".into()],
            2,
        )
        .expect("guest aliases");
        set_vault_key_at(&root, USER_A, "OTHER_KEY", "fake-account", None, 3).expect("account");
        set_vault_key_aliases_at(
            &root,
            USER_A,
            "OTHER_KEY",
            vec!["SHARED_NAME".into(), "FAL_KEY_ALT".into()],
            4,
        )
        .expect("account aliases");
        merge_guest_vault_at(&root, USER_B, USER_A).expect("merge");
        let meta = read_meta_at(&root, USER_A).expect("valid merged meta");
        assert_eq!(meta.keys["NEW_KEY"].aliases, vec!["FREE_NAME"]);
        assert_eq!(
            meta.keys["OTHER_KEY"].aliases,
            vec!["FAL_KEY_ALT", "SHARED_NAME"]
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn vaults_are_isolated_by_runtime_identity() {
        let root = fixture();
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-a", None, 1).expect("set A");
        assert!(vault_values(&root, USER_B).is_empty());
        assert!(vault_key_names_at(&root, USER_B)
            .expect("names B")
            .is_empty());
        let personal = read_personal_values_at(
            &root,
            &root.join("envs"),
            USER_B,
            "alpha",
            &BTreeSet::from(["FAL_KEY".to_string()]),
            &BTreeMap::new(),
        )
        .expect("B personal");
        assert!(personal.values().is_empty());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    // ── Labelled variants (#306) ────────────────────────────────────────────

    fn personal_for(
        root: &Path,
        skill: &str,
        declared: &str,
        choice: Option<&str>,
    ) -> (Option<String>, Option<String>, Option<(String, String)>) {
        let choices = choice
            .map(|variant| {
                // `-` stands for 「the unlabelled value, explicitly」.
                let variant = (variant != "-").then(|| variant.to_string());
                VariantChoices::from([(declared.to_string(), variant)])
            })
            .unwrap_or_default();
        let personal = read_personal_values_at(
            root,
            &root.join("envs"),
            USER_A,
            skill,
            &BTreeSet::from([declared.to_string()]),
            &choices,
        )
        .expect("personal");
        (
            personal.values().get(declared).cloned(),
            personal.vault_identity().get(declared).cloned(),
            personal.vault_variant(declared).cloned(),
        )
    }

    #[test]
    fn variants_need_a_default_unique_labels_and_a_limit() {
        let root = fixture();
        assert_eq!(
            create_vault_key_variant_at(&root, USER_A, "FAL_KEY", "公司", "fake-work", None, 1),
            Err("先填写 FAL_KEY 的默认值".into())
        );
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-default", None, 1).expect("default");
        assert_eq!(
            create_vault_key_variant_at(&root, USER_A, "FAL_KEY", "  ", "fake-work", None, 2),
            Err("请填写标签，例如「公司」或「个人」".into())
        );
        assert!(create_vault_key_variant_at(
            &root,
            USER_A,
            "FAL_KEY",
            &"长".repeat(MAX_VARIANT_LABEL_CHARS + 1),
            "fake-work",
            None,
            2
        )
        .is_err());
        assert_eq!(
            create_vault_key_variant_at(&root, USER_A, "FAL_KEY", " 公司 ", "fake-work", None, 2),
            Ok("V1".into())
        );
        assert_eq!(
            create_vault_key_variant_at(&root, USER_A, "FAL_KEY", "公司", "fake-other", None, 3),
            Err("标签「公司」已存在".into())
        );
        assert_eq!(
            create_vault_key_variant_at(&root, USER_A, "FAL_KEY", "个人", "fake-home", None, 3),
            Ok("V2".into())
        );
        // Stored under the synthetic entry; never listed as a key name.
        let values = vault_values(&root, USER_A);
        assert_eq!(values["FAL_KEY__V1"], "fake-work");
        assert_eq!(values["FAL_KEY__V2"], "fake-home");
        assert_eq!(
            vault_key_names_at(&root, USER_A).expect("names"),
            BTreeSet::from(["FAL_KEY".to_string()])
        );
        assert!(vault_entry_names_at(&root, USER_A)
            .expect("entries")
            .contains("FAL_KEY__V1"));
        assert!(!vault_lookup_names_at(&root, USER_A)
            .expect("lookup")
            .contains_key("FAL_KEY__V1"));
        let meta = read_meta_at(&root, USER_A).expect("meta");
        assert_eq!(meta.keys["FAL_KEY"].variants[0].label, "公司");
        assert!(meta.keys["FAL_KEY__V1"].aliases.is_empty());
        // Label rename keeps uniqueness; values can be replaced per variant.
        assert_eq!(
            set_vault_key_variant_label_at(&root, USER_A, "FAL_KEY", "V2", "公司", 4),
            Err("标签「公司」已存在".into())
        );
        set_vault_key_variant_label_at(&root, USER_A, "FAL_KEY", "V2", "家里", 4).expect("label");
        set_vault_key_variant_value_at(&root, USER_A, "FAL_KEY", "V2", "fake-home-2", 5)
            .expect("value");
        assert_eq!(vault_values(&root, USER_A)["FAL_KEY__V2"], "fake-home-2");
        assert!(set_vault_key_variant_value_at(&root, USER_A, "FAL_KEY", "V9", "fake", 5).is_err());
        // At most MAX_KEY_VARIANTS labelled values per name.
        for index in 3..=MAX_KEY_VARIANTS {
            create_vault_key_variant_at(
                &root,
                USER_A,
                "FAL_KEY",
                &format!("标签{index}"),
                "fake-more",
                None,
                6,
            )
            .expect("more");
        }
        assert!(create_vault_key_variant_at(
            &root,
            USER_A,
            "FAL_KEY",
            "多一把",
            "fake-more",
            None,
            7
        )
        .is_err());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn default_pointer_and_delete_rules() {
        let root = fixture();
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-default", None, 1).expect("default");
        let work =
            create_vault_key_variant_at(&root, USER_A, "FAL_KEY", "公司", "fake-work", None, 2)
                .expect("work");
        let home =
            create_vault_key_variant_at(&root, USER_A, "FAL_KEY", "个人", "fake-home", None, 2)
                .expect("home");
        // The unlabelled value is the default: it cannot go while others remain.
        assert_eq!(
            delete_vault_key_variant_at(&root, USER_A, "FAL_KEY", None),
            Err("还有带标签的钥匙，先把其中一把设为默认后再撤销".into())
        );
        set_vault_default_variant_at(&root, USER_A, "FAL_KEY", Some(&work)).expect("default work");
        assert!(set_vault_default_variant_at(&root, USER_A, "FAL_KEY", Some("V9")).is_err());
        assert_eq!(
            personal_for(&root, "alpha", "FAL_KEY", None).0.as_deref(),
            Some("fake-work")
        );
        assert_eq!(
            delete_vault_key_variant_at(&root, USER_A, "FAL_KEY", Some(&work)),
            Err("这把是默认钥匙，先把另一把设为默认后再撤销".into())
        );
        // Now the unlabelled value is not the default and may go.
        delete_vault_key_variant_at(&root, USER_A, "FAL_KEY", None).expect("drop unlabelled");
        assert!(!vault_values(&root, USER_A).contains_key("FAL_KEY"));
        assert!(vault_key_names_at(&root, USER_A)
            .expect("names")
            .contains("FAL_KEY"));
        assert_eq!(
            set_vault_default_variant_at(&root, USER_A, "FAL_KEY", None),
            Err("FAL_KEY 没有不带标签的值，不能设为默认".into())
        );
        // A non-default variant goes with its traces; ids are never reused.
        record_vault_usage_at(&root, USER_A, &["FAL_KEY__V2".into()], 3);
        grant_key_access_variant_at(&root, USER_A, "market", "FAL_KEY", Some(&home), true, 3)
            .expect("once");
        delete_vault_key_variant_at(&root, USER_A, "FAL_KEY", Some(&home)).expect("drop home");
        assert!(!read_usage_at(&root, USER_A).contains_key("FAL_KEY__V2"));
        assert!(!grant_path_at(&root, USER_A, "market", "FAL_KEY__V2").exists());
        assert!(!read_meta_at(&root, USER_A)
            .expect("meta")
            .keys
            .contains_key("FAL_KEY__V2"));
        assert_eq!(
            create_vault_key_variant_at(&root, USER_A, "FAL_KEY", "新的", "fake-new", None, 4),
            Ok("V3".into())
        );
        delete_vault_key_variant_at(&root, USER_A, "FAL_KEY", Some("V3")).expect("drop new");
        // The last value (the default variant) takes the whole name along.
        delete_vault_key_variant_at(&root, USER_A, "FAL_KEY", Some(&work)).expect("drop last");
        assert!(vault_values(&root, USER_A).is_empty());
        assert!(read_meta_at(&root, USER_A).expect("meta").keys.is_empty());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn resolution_uses_choice_then_default_and_falls_back_after_delete() {
        let root = fixture();
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-default", None, 1).expect("default");
        let work =
            create_vault_key_variant_at(&root, USER_A, "FAL_KEY", "公司", "fake-work", None, 2)
                .expect("work");
        let home =
            create_vault_key_variant_at(&root, USER_A, "FAL_KEY", "个人", "fake-home", None, 2)
                .expect("home");
        assert_eq!(
            personal_for(&root, "alpha", "FAL_KEY", None),
            (Some("fake-default".into()), Some("FAL_KEY".into()), None)
        );
        assert_eq!(
            personal_for(&root, "alpha", "FAL_KEY", Some(&work)),
            (
                Some("fake-work".into()),
                Some("FAL_KEY__V1".into()),
                Some(("V1".into(), "公司".into()))
            )
        );
        // An unknown choice falls back to the default silently.
        assert_eq!(
            personal_for(&root, "alpha", "FAL_KEY", Some("V9"))
                .0
                .as_deref(),
            Some("fake-default")
        );
        set_vault_default_variant_at(&root, USER_A, "FAL_KEY", Some(&home)).expect("default home");
        assert_eq!(
            personal_for(&root, "alpha", "FAL_KEY", None).0.as_deref(),
            Some("fake-home")
        );
        // The unlabelled value can still be picked explicitly.
        assert_eq!(
            personal_for(&root, "alpha", "FAL_KEY", Some("-")),
            (Some("fake-default".into()), Some("FAL_KEY".into()), None)
        );
        assert!(variant_exists_for_name_at(&root, USER_A, "FAL_KEY", None).expect("unlabelled"));
        assert_eq!(
            personal_for(&root, "alpha", "FAL_KEY", Some(&work))
                .0
                .as_deref(),
            Some("fake-work")
        );
        delete_vault_key_variant_at(&root, USER_A, "FAL_KEY", Some(&work)).expect("drop work");
        assert_eq!(
            personal_for(&root, "alpha", "FAL_KEY", Some(&work))
                .0
                .as_deref(),
            Some("fake-home")
        );
        // A Skill declaring the synthetic name never gets a vault value.
        assert_eq!(personal_for(&root, "alpha", "FAL_KEY__V2", None).0, None);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn an_alias_declaring_skill_is_served_from_a_variant() {
        let root = fixture();
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-default", None, 1).expect("default");
        let work =
            create_vault_key_variant_at(&root, USER_A, "FAL_KEY", "公司", "fake-work", None, 2)
                .expect("work");
        set_vault_key_aliases_at(&root, USER_A, "FAL_KEY", vec!["FAL_API_KEY".into()], 3)
            .expect("alias");
        assert_eq!(
            personal_for(&root, "alpha", "FAL_API_KEY", Some(&work)),
            (
                Some("fake-work".into()),
                Some("FAL_KEY__V1".into()),
                Some(("V1".into(), "公司".into()))
            )
        );
        assert!(
            variant_exists_for_name_at(&root, USER_A, "FAL_API_KEY", Some(&work)).expect("exists")
        );
        assert!(
            !variant_exists_for_name_at(&root, USER_A, "FAL_API_KEY", Some("V7")).expect("missing")
        );
        // Aliases stay on the name: the variant entry never carries any.
        assert!(
            read_meta_at(&root, USER_A).expect("meta").keys["FAL_KEY__V1"]
                .aliases
                .is_empty()
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn consent_and_blocks_are_per_variant() {
        let root = fixture();
        let market = SkillHubProfile {
            is_own: Some(false),
            acquisition_source: Some(AcquisitionSource::Marketplace),
            ..Default::default()
        };
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-default", None, 1).expect("default");
        let work =
            create_vault_key_variant_at(&root, USER_A, "FAL_KEY", "公司", "fake-work", None, 2)
                .expect("work");
        let both = BTreeSet::from(["FAL_KEY".to_string(), "FAL_KEY__V1".to_string()]);
        let pending = |now| {
            evaluate_consent_at(&root, USER_A, "market", &market, &both, now).expect("consent")
        };
        assert_eq!(pending(3).pending, vec!["FAL_KEY", "FAL_KEY__V1"]);
        assert_eq!(
            pending(3).pending_display,
            vec!["FAL_KEY", "FAL_KEY · 公司"]
        );
        assert_eq!(
            needs_consent_error("Market", &pending(3).pending_display),
            "NEEDS_CONSENT: 「Market」想使用你的钥匙 FAL_KEY、FAL_KEY · 公司；APP 会弹出授权窗，请用户确认后重试"
        );
        // A grant for the labelled value does not cover the default one.
        grant_key_access_variant_at(&root, USER_A, "market", "FAL_KEY", Some(&work), false, 4)
            .expect("grant work");
        assert_eq!(pending(5).pending, vec!["FAL_KEY"]);
        // The synthetic name from a consent request resolves the same way.
        revoke_key_access_variant_at(&root, USER_A, "market", "FAL_KEY__V1", None).expect("revoke");
        assert_eq!(pending(6).pending.len(), 2);
        grant_key_access_variant_at(&root, USER_A, "market", "FAL_KEY__V1", None, false, 7)
            .expect("grant synthetic");
        assert_eq!(pending(8).pending, vec!["FAL_KEY"]);
        set_key_auto_allow_variant_at(&root, USER_A, true, Some("FAL_KEY"), None, 9)
            .expect("auto default");
        assert!(pending(10).pending.is_empty());
        assert!(!read_meta_at(&root, USER_A).expect("meta").keys["FAL_KEY__V1"].auto_allow);
        // Consent requests show the label next to the identity.
        let managed = root.join("skills");
        write_profile(&managed, "market", "FAL_KEY");
        set_key_auto_allow_variant_at(&root, USER_A, false, Some("FAL_KEY"), None, 11)
            .expect("auto off");
        revoke_key_access_variant_at(&root, USER_A, "market", "FAL_KEY", Some(&work))
            .expect("revoke work");
        record_consent_request_at(&root, USER_A, "market", &["FAL_KEY__V1".into()], now_ms())
            .expect("record");
        let requests = list_consent_requests_at(&root, &managed, USER_A, now_ms()).expect("list");
        assert_eq!(requests[0].keys, vec!["FAL_KEY__V1"]);
        assert_eq!(requests[0].display_keys, vec!["FAL_KEY · 公司"]);
        // Turning one value off for a Skill leaves the other one alone.
        set_vault_key_skill_access_variant_at(
            &root,
            USER_A,
            "FAL_KEY",
            Some(&work),
            "alpha",
            None,
            false,
            12,
        )
        .expect("block work");
        assert_eq!(personal_for(&root, "alpha", "FAL_KEY", Some(&work)).0, None);
        assert_eq!(
            personal_for(&root, "alpha", "FAL_KEY", None).0.as_deref(),
            Some("fake-default")
        );
        assert!(vault_lookup_names_for_skill_at(&root, USER_A, "alpha")
            .expect("lookup")
            .contains_key("FAL_KEY"));
        assert_eq!(
            read_meta_at(&root, USER_A).expect("meta").keys["FAL_KEY__V1"].blocked_skills,
            vec!["alpha"]
        );
        assert!(read_meta_at(&root, USER_A).expect("meta").keys["FAL_KEY"]
            .blocked_skills
            .is_empty());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn synthetic_names_are_reserved() {
        let root = fixture();
        assert!(is_reserved_variant_name("FAL_KEY__V1"));
        assert!(is_reserved_variant_name("MY__KEY__V12"));
        assert!(!is_reserved_variant_name("FAL_KEY_V1"));
        assert!(!is_reserved_variant_name("FAL_KEY__V"));
        assert!(!is_reserved_variant_name("__V1"));
        assert_eq!(
            split_variant_entry("MY__KEY__V12"),
            Some(("MY__KEY", "V12"))
        );
        assert_eq!(
            set_vault_key_at(&root, USER_A, "FAL_KEY__V1", "fake", None, 1),
            Err("FAL_KEY__V1 是带标签钥匙的保留写法，不能用作变量名".into())
        );
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake", None, 1).expect("default");
        assert!(
            set_vault_key_aliases_at(&root, USER_A, "FAL_KEY", vec!["OTHER__V3".into()], 2)
                .is_err()
        );
        assert!(
            create_vault_key_variant_at(&root, USER_A, "FAL_KEY__V1", "公司", "fake", None, 2)
                .is_err()
        );
        // A per-Skill file holding a reserved name stays an override.
        write_override(&root, USER_A, "alpha", b"FAL_KEY__V1=fake-own\n", 0o600);
        let report =
            migrate_vault_locked_at(&root, &root.join("envs"), USER_A, 3).expect("migrate");
        assert!(report.migrated_keys.is_empty());
        assert!(!vault_values(&root, USER_A).contains_key("FAL_KEY__V1"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn listing_returns_one_row_per_value_with_the_switcher() {
        let root = fixture();
        let managed = root.join("skills");
        write_profile(&managed, "market", "FAL_API_KEY");
        fs::create_dir_all(managed.join("own")).expect("own dir");
        fs::write(
            managed.join("own").join(".skillhub.json"),
            r#"{"version":"1","skillhub":{"id":"own","displayName":"Zed own","envDependencies":[{"key":"FAL_KEY","required":true}]}}"#,
        )
        .expect("own profile");
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-default", None, 1).expect("default");
        set_vault_key_aliases_at(&root, USER_A, "FAL_KEY", vec!["FAL_API_KEY".into()], 2)
            .expect("alias");
        let work =
            create_vault_key_variant_at(&root, USER_A, "FAL_KEY", "公司", "fake-work", None, 3)
                .expect("work");
        grant_key_access_variant_at(
            &root,
            USER_A,
            "market",
            "FAL_API_KEY",
            Some(&work),
            false,
            4,
        )
        .expect("grant work");
        record_vault_usage_at(&root, USER_A, &["FAL_KEY__V1".into()], 9);
        write_override(&root, USER_A, "own", b"FAL_KEY=fake-own\n", 0o600);
        let rows = list_vault_keys_at(&root, &managed, &root.join("envs"), USER_A).expect("list");
        assert_eq!(rows.len(), 2);
        assert_eq!(
            (rows[0].variant.as_deref(), rows[0].is_default),
            (None, true)
        );
        assert_eq!(rows[1].variant.as_deref(), Some("V1"));
        assert_eq!(rows[1].label.as_deref(), Some("公司"));
        assert!(!rows[1].is_default);
        assert_eq!(rows[1].aliases, vec!["FAL_API_KEY"]);
        assert_eq!(rows[0].variants, rows[1].variants);
        assert_eq!(rows[1].last_used_at, Some(9));
        assert_eq!(rows[0].last_used_at, None);
        assert_eq!(rows[0].override_skills, vec!["own"]);
        assert!(rows[1].override_skills.is_empty());
        // `enabled` follows each value's own consent.
        let market = |row: &VaultKeyRow| {
            row.used_by_skills
                .iter()
                .find(|skill| skill.id == "market")
                .map(|skill| (skill.enabled, skill.in_use))
                .expect("market")
        };
        assert_eq!(market(&rows[0]), (false, true));
        assert_eq!(market(&rows[1]), (true, false));
        // `own` keeps its override, so neither value is in use for it.
        assert!(rows
            .iter()
            .flat_map(|row| &row.used_by_skills)
            .filter(|skill| skill.id == "own")
            .all(|skill| !skill.in_use));
        let json = serde_json::to_value(&rows).expect("json");
        assert_eq!(json[1]["key"], "FAL_KEY");
        assert_eq!(json[1]["variant"], "V1");
        assert_eq!(json[1]["label"], "公司");
        assert_eq!(json[1]["isDefault"], false);
        assert_eq!(
            json[0]["variants"],
            serde_json::json!([
                {"id": null, "label": null, "isDefault": true},
                {"id": "V1", "label": "公司", "isDefault": false}
            ])
        );
        assert_eq!(json[0]["usedBySkills"][0]["inUse"], true);
        assert!(!json.to_string().contains("fake-"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn old_metadata_loads_unchanged_and_keeps_its_shape() {
        let root = fixture();
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake", None, 1).expect("set");
        let path = vault_meta_path_at(&root, USER_A);
        fs::write(
            &path,
            r#"{"version":1,"autoAllow":false,"keys":{"FAL_KEY":{"createdAt":1,"updatedAt":2,"allowedSkills":["alpha"],"autoAllow":false}}}"#,
        )
        .expect("old meta");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("private");
        let meta = read_meta_at(&root, USER_A).expect("old meta loads");
        assert!(meta.keys["FAL_KEY"].variants.is_empty());
        assert_eq!(meta.keys["FAL_KEY"].default_variant, None);
        set_key_auto_allow_at(&root, USER_A, false, None, 3).expect("rewrite");
        let text = fs::read_to_string(&path).expect("meta text");
        assert!(!text.contains("variants") && !text.contains("defaultVariant"));
        assert!(!text.contains("variantSeq"));
        // Hand-edited variant metadata is checked like the rest.
        fs::write(
            &path,
            r#"{"version":1,"keys":{"FAL_KEY":{"createdAt":1,"updatedAt":2,"variants":[{"id":"V1","label":"公司","createdAt":1}],"defaultVariant":"V2","variantSeq":1}}}"#,
        )
        .expect("bad pointer");
        assert_eq!(
            read_meta_at(&root, USER_A).err().as_deref(),
            Some("本机钥匙库元数据无效")
        );
        fs::write(
            &path,
            r#"{"version":1,"keys":{"FAL_KEY__V1":{"createdAt":1,"updatedAt":2,"aliases":["X_KEY"]}}}"#,
        )
        .expect("bad variant aliases");
        assert_eq!(
            read_meta_at(&root, USER_A).err().as_deref(),
            Some("本机钥匙库元数据无效")
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn guest_variants_join_with_their_name() {
        let root = fixture();
        set_vault_key_at(&root, USER_B, "FAL_KEY", "fake-guest", None, 1).expect("guest");
        create_vault_key_variant_at(&root, USER_B, "FAL_KEY", "公司", "fake-guest-work", None, 2)
            .expect("guest work");
        set_vault_key_at(&root, USER_B, "NEW_KEY", "fake-guest-new", None, 1).expect("guest new");
        create_vault_key_variant_at(&root, USER_B, "NEW_KEY", "公司", "fake-new-work", None, 2)
            .expect("guest new work");
        set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-account", None, 3).expect("account");
        merge_guest_vault_at(&root, USER_B, USER_A).expect("merge");
        let values = vault_values(&root, USER_A);
        assert_eq!(values["FAL_KEY"], "fake-account");
        assert!(!values.contains_key("FAL_KEY__V1"));
        assert_eq!(values["NEW_KEY__V1"], "fake-new-work");
        let meta = read_meta_at(&root, USER_A).expect("merged meta");
        assert!(meta.keys["FAL_KEY"].variants.is_empty());
        assert_eq!(meta.keys["NEW_KEY"].variants[0].label, "公司");
        fs::remove_dir_all(root).expect("remove fixture");
    }
}
