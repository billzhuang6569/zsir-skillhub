use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows_agent_discovery::{find_windows_executable, DetectionIssue, DetectionIssueSource};

mod app_links;
mod avatar_upload;
mod catalog;
mod catalog_publish;
mod catalog_session;
mod cli;
mod cli_acquire;
mod cli_app;
mod cli_auth;
mod cli_cloud;
mod cli_edit;
mod cli_feedback;
mod cli_lifecycle;
mod cli_local;
mod cli_mutation;
mod cli_operations;
mod cli_server;
mod cli_team;
mod commands;
mod env_detect;
mod key_vault;
mod last_run;
mod library_organizer;
mod library_sync;
mod local_inference;
mod media;
mod migration;
mod net;
pub mod official_channel;
mod onboarding;
mod platform_fs;
mod portal_auth;
mod runtime_env;
mod server_request;
mod skill_document;
mod skill_lock;
mod spaces;
mod system_skill;
mod team_keys;
mod version_policy;
mod windows_agent_discovery;
pub use commands::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AcquisitionSource {
    Local,
    Team,
    Marketplace,
}

// ── Data types shared between Rust and TypeScript ──────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkill {
    pub version_status: String,
    pub version_problem: Option<String>,
    pub version_receipt_id: Option<String>,
    pub formal_version_id: Option<String>,
    pub formal_label: Option<String>,
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    /// Optional original HTTP/HTTPS source URL (「来源」, #329/#330). Independent
    /// of `sources` / `acquisition_source`, which describe how it was acquired.
    pub source_url: Option<String>,
    pub avatar_local_id: Option<String>,
    pub avatar_url: Option<String>,
    pub avatar_status: Option<String>,
    pub avatar_account_user_id: Option<String>,
    pub category: Option<String>,
    pub labels: Vec<String>,
    pub version: String,
    pub latest_version: String,
    pub install_count: u32,
    pub sources: Vec<String>,
    pub agents: HashMap<String, Option<String>>,
    pub installed: bool,
    pub is_own: bool,
    pub is_system: bool,
    pub system_version: Option<String>,
    pub integrity_status: Option<String>,
    pub acquisition_source: AcquisitionSource,
    pub acquisition_package_sha256: Option<String>,
    /// Transient recovery id returned only by a successful Marketplace replacement.
    /// It is never persisted in `.skillhub.json` and lets the UI roll back if a
    /// later Agent installation step fails.
    pub marketplace_replacement_recovery_id: Option<String>,
    /// Transient read-only scan result after a Marketplace / team install:
    /// keys detected in the package but not declared in its sidecar (#250).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub undeclared_env_suggestions: Vec<String>,
    pub team_shared_from: Option<String>,
    pub env_deps: Vec<EnvDep>,
    pub shared_to: HashMap<String, SharedSkillState>,
    pub versions: Vec<SkillVersion>,
    pub trigger: Option<String>,
    pub fit_scenarios: Vec<String>,
    pub unfit_scenarios: Vec<String>,
    pub compatible_agents: Vec<String>,
    pub is_orphan: bool,
    pub has_working_copy: bool,
    pub working_copy_changes: u32,
    pub working_copy_hash: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub local_path: String,
    pub server_id: Option<String>,
    pub catalog_origin: Option<String>,
    pub acquisition_version: Option<String>,
    pub server_owner_id: Option<String>,
    /// Account library binding (cloud sync); see `SkillHubProfile`.
    pub library_account_id: Option<String>,
    pub library_entry_id: Option<String>,
    pub added_by_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedSkillState {
    pub version: String,
    pub env_shared: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillSource {
    pub agent_key: String,
    pub agent_name: String,
    pub entry_name: String,
    /// Grouping folder when the Skill sits one level deeper, as in
    /// `<agent skills>/<group>/<entry_name>/SKILL.md`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmanagedSkill {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub labels: Vec<String>,
    pub version: String,
    pub sources: Vec<AgentSkillSource>,
    pub local_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkillSource {
    pub agent_key: String,
    pub agent_name: String,
    pub entry_name: String,
    pub path: String,
    pub canonical_path: String,
    pub fingerprint: String,
    pub matches_selected: bool,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkillPreflight {
    pub skill_id: String,
    pub selected_path: String,
    pub selected_fingerprint: String,
    pub sources: Vec<ImportSkillSource>,
    pub has_conflicts: bool,
    pub plan_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    pub kind: String,
    pub skill_id: String,
    pub display_name: String,
    pub created_at: u64,
    pub status: String,
    pub reason: Option<String>,
    pub source_count: usize,
    pub restorable: bool,
    pub location: String,
    pub server_id: Option<String>,
    pub server_owner_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvDep {
    pub key: String,
    pub description: Option<String>,
    pub required: bool,
    pub configured: bool,
    pub share_policy: String, // "none" | "private" | "team"
    pub shared_teams: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub obtain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillVersion {
    pub version: String,
    pub changelog: Option<String>,
    pub git_hash: Option<String>,
    pub date: String,
    pub is_current: bool,
    pub original_label: Option<String>,
    pub receipt_id: Option<String>,
    pub formal_version_id: Option<String>,
    pub formal_label: Option<String>,
    pub version_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub key: String,
    pub name: String,
    pub dir: String,
    pub detected: bool,
    pub detection_source: AgentDetectionSource,
    pub skills_status: AgentSkillsStatus,
    /// `incomplete` means no install evidence was found while a source this
    /// Agent relies on could not be read, so "not installed" is not claimed.
    /// It never grants write access: only `detected` does.
    #[serde(default)]
    pub detection_state: AgentDetectionState,
    /// Local-only diagnostics for sources this Agent relies on that failed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub detection_issues: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum AgentDetectionState {
    Detected,
    #[default]
    NotFound,
    Incomplete,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentDetectionSource {
    Application,
    Cli,
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentSkillsStatus {
    Ready,
    Missing,
    /// A Skill-root override variable is set, so the root the tool reads
    /// may not be the default one SkillHub would write. Install evidence is
    /// kept, but no write (projection, adoption, Manager repair) is admitted.
    Unconfirmed,
}

/// Whether SkillHub may read and write this Agent's default Skill root.
pub(crate) fn admits_skill_writes(agent: &AgentInfo) -> bool {
    agent.detected && agent.skills_status != AgentSkillsStatus::Unconfirmed
}

/// Why a write into `agent_key`'s default Skill root is refused, if it is.
/// Every write path (install projection, unmanage handoff) uses this so the
/// refusal and its wording stay identical.
pub(crate) fn skill_write_refusal(
    agent_key: &str,
    agent_name: &str,
    detected_agents: &[AgentInfo],
) -> Option<String> {
    let Some(info) = detected_agents
        .iter()
        .find(|agent| agent.key == agent_key && agent.detected)
    else {
        return Some(format!(
            "本机未检测到 {agent_name}，无法写入它的 Skill 目录"
        ));
    };
    (!admits_skill_writes(info)).then(|| {
        format!("{agent_name} 的 Skill 目录未确认（设置了目录覆盖变量），已阻止写入默认目录")
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String, // "add" | "del" | "ctx"
    pub content: String,
}

// ── SkillHub root directory ─────────────────────────────────────────────────

pub(crate) fn user_home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    if let Some(path) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        if path.is_absolute()
            && !path.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return Some(path);
        }
    }
    dirs::home_dir()
}

pub fn skillhub_dir() -> PathBuf {
    spaces::channel_root(
        &user_home_dir().expect("Cannot find home directory"),
        official_channel::CHANNEL,
    )
}

pub fn skills_dir() -> PathBuf {
    skillhub_dir().join("skills")
}

pub fn envs_dir() -> PathBuf {
    skillhub_dir().join("envs")
}

pub fn active_env_path() -> PathBuf {
    skillhub_dir().join("active.env")
}

pub fn ensure_skillhub_dirs() -> Result<()> {
    fs::create_dir_all(skills_dir())?;
    fs::create_dir_all(envs_dir())?;
    Ok(())
}

// ── Read .skillhub.json ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillHubJson {
    #[serde(default)]
    pub version: String,
    pub skillhub: Option<SkillHubProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillHubProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acquisition_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<spaces::SidecarScope>,
    #[serde(default)]
    pub version_metadata: crate::version_policy::VersionMetadata,
    pub id: Option<String>,
    pub avatar_local_id: Option<String>,
    pub server_id: Option<String>,
    pub server_owner_id: Option<String>,
    pub is_own: Option<bool>,
    #[serde(default)]
    pub is_system: bool,
    pub system_version: Option<String>,
    pub upstream: Option<SkillUpstream>,
    pub acquisition_source: Option<AcquisitionSource>,
    pub acquisition_package_sha256: Option<String>,
    /// Account that acquired a Team-distributed asset. This is intentionally
    /// absent for Local and Marketplace sources.
    pub acquired_by_user_id: Option<String>,
    pub team_shared_from: Option<String>,
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub description: Option<String>,
    /// Original source URL (「来源」). Absent in sidecars written before #330.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    /// The 「来源」 URL the user cleared on this device, kept until account
    /// sync carries the clear. The clear only wins while the account still
    /// holds exactly this URL; a newer source from another device beats it.
    /// A boolean written by a pre-release build reads as unknown (`None`).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_cleared_source"
    )]
    pub source_url_cleared: Option<String>,
    pub category: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub trigger_scenarios: Vec<String>,
    #[serde(default)]
    pub env_dependencies: Vec<EnvDepRaw>,
    #[serde(default)]
    pub compatible_agents: Vec<String>,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default)]
    pub changelog: Vec<serde_json::Value>,
    pub author: Option<String>,
    #[serde(default)]
    pub teams: Vec<String>,
    #[serde(default)]
    pub team_ids: Vec<String>,
    #[serde(default)]
    pub install_count: u32,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// Account whose synced library this directory belongs to. Once set, sync
    /// uses it instead of `server_owner_id` to decide ownership.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library_account_id: Option<String>,
    /// `LibraryEntry.id` this directory is bound to within that account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library_entry_id: Option<String>,
    /// Account signed in when this Skill was imported or installed into
    /// SkillHub on this device. Account sync joins an unbound store or local
    /// Skill automatically only to that account (#91); a folder that merely
    /// appears, or one added while signed out, is never uploaded on its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_by_account_id: Option<String>,
}

/// Three identity domains meet on a managed Skill: the managed directory name
/// locates files, the sidecar `id` is the stable local / account-entry identity,
/// and `serverId` names the cloud asset. Import and account sync both write a
/// UUID into `id`, so a managed directory `davinci-edit-master` normally carries a
/// sidecar `id` that is a UUID. Sidecars written before UUID identities (and the
/// system Manager) use the directory name instead. Both shapes are accepted;
/// a missing `id` or any other string is not. A valid UUID says nothing about
/// account ownership or team authorization, which stay separate checks.
pub(crate) fn sidecar_identity_matches_directory(sidecar_id: Option<&str>, skill_id: &str) -> bool {
    match sidecar_id {
        Some(id) if id == skill_id => true,
        Some(id) => uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id),
        None => false,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpstream {
    pub source: AcquisitionSource,
    pub server_skill_id: Option<String>,
    pub server_owner_id: Option<String>,
    pub team_id: Option<String>,
    pub version: String,
    pub package_sha256: Option<String>,
}

fn default_version() -> String {
    "0.1.0".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvDepRaw {
    pub key: String,
    pub description: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub share_policy: String,
    #[serde(default)]
    pub shared_teams: Vec<String>,
    /// "declared" | "detected" | "manual" | "runtime_request"；旧 sidecar 无此字段。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// 检测置信度 "declared" | "high" | "medium" | "low"；仅本机 sidecar。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<String>,
    /// SKILL.md 声明中的获取地址（仅 `https://`，只作展示链接）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub obtain: Option<String>,
    /// `true` while a runtime-requested key still awaits the author's
    /// confirmation. Never carries a value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackage {
    pub base64: String,
    pub sha256: String,
    pub size: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillProfileUpdateInput {
    pub server_id: Option<String>,
    pub server_owner_id: Option<String>,
    pub display_name: Option<String>,
    pub description: Option<String>,
    /// Omitted keeps the stored source; `null` or blank clears it (#329 contract).
    #[serde(default, deserialize_with = "deserialize_present")]
    pub source_url: Option<Option<String>>,
    /// With a clear: the source the user saw and removed (it may have come
    /// from the Server before this device synced it).
    #[serde(default)]
    pub cleared_source_url: Option<String>,
    pub category: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub trigger_scenarios: Vec<String>,
    #[serde(default)]
    pub compatible_agents: Vec<String>,
    pub version: Option<String>,
}

/// Distinguishes an omitted field (`None`, via `default`) from an explicit
/// `null` (`Some(None)`).
fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn deserialize_cleared_source<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(
        match Option::<serde_json::Value>::deserialize(deserializer)? {
            Some(serde_json::Value::String(url)) => sanitize_source_url(Some(&url)),
            _ => None,
        },
    )
}

/// Longest accepted 「来源」 URL, matching the server's `SkillSourceUrlSchema`.
pub(crate) const SOURCE_URL_MAX_LENGTH: usize = 2048;

/// Validates a 「来源」 URL exactly like the server: trimmed, at most 2048
/// UTF-16 units, an `http://` / `https://` URL with a host and without
/// user name or password, and free of whitespace, `\`, `<`, `>`, `"` and
/// control characters. Blank means "no source" (`Ok(None)`).
pub(crate) fn validate_source_url(value: &str) -> Result<Option<String>, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    let invalid = || "来源须为不含账号密码的 HTTP/HTTPS 网址".to_string();
    if value.encode_utf16().count() > SOURCE_URL_MAX_LENGTH {
        return Err("来源网址不能超过 2048 个字符".into());
    }
    let lower = value.get(..8).unwrap_or(value).to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(invalid());
    }
    if value
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '\\' | '<' | '>' | '"'))
    {
        return Err(invalid());
    }
    let parsed = reqwest::Url::parse(value).map_err(|_| invalid())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none_or(str::is_empty)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(invalid());
    }
    Ok(Some(value.to_string()))
}

/// A source URL read from a server or an older sidecar: kept only when it
/// still passes [`validate_source_url`], otherwise treated as absent.
pub(crate) fn sanitize_source_url(value: Option<&str>) -> Option<String> {
    value.and_then(|value| validate_source_url(value).ok().flatten())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkillPackageInput {
    #[serde(default)]
    pub catalog_origin: Option<String>,
    pub skill_id: String,
    /// Stable Agent-facing projection name. The managed local id may differ
    /// when two remote assets share this name.
    #[serde(default)]
    pub name: Option<String>,
    pub package_base64: String,
    pub expected_sha256: String,
    pub server_id: String,
    pub server_owner_id: String,
    pub display_name: String,
    pub description: Option<String>,
    /// The listing's / shared version's 「来源」; absent from older callers.
    #[serde(default)]
    pub source_url: Option<String>,
    pub category: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    pub version: String,
    pub team_id: Option<String>,
    #[serde(default)]
    pub team_ids: Vec<String>,
    pub is_own: bool,
    #[serde(default)]
    pub acquisition_source: Option<AcquisitionSource>,
    #[serde(default)]
    pub acquired_by_user_id: Option<String>,
    #[serde(default)]
    pub replace_existing_marketplace: bool,
    #[serde(default)]
    pub install_count: u32,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub trigger_scenarios: Vec<String>,
    #[serde(default)]
    pub compatible_agents: Vec<String>,
    #[serde(default)]
    pub env_dependencies: Vec<EnvDepRaw>,
}

// ── Known agent configurations ──────────────────────────────────────────────

#[derive(Clone, Copy)]
struct AgentDefinition {
    key: &'static str,
    name: &'static str,
    executables: &'static [&'static str],
    // An environment variable that relocates the tool's config root (and so
    // its Skill root). SkillHub does not yet resolve overrides consistently
    // across GUI/CLI, scan, projection, uninstall and Manager, so a set,
    // non-default value marks the Skill root unconfirmed and blocks writes.
    skill_root_override: Option<SkillRootOverride>,
    macos: AgentPlatformDefinition,
    windows: AgentPlatformDefinition,
    other: AgentPlatformDefinition,
}

#[derive(Clone, Copy)]
struct SkillRootOverride {
    variable: &'static str,
    /// The home-relative directory the variable replaces.
    default_relative: &'static str,
}

#[derive(Clone, Copy)]
struct AgentPlatformDefinition {
    skills_dir: Option<&'static str>,
    application_markers: &'static [&'static str],
    store_packages: &'static [StorePackageMarker],
    // Windows desktop executables (file names) whose Uninstall/App Paths
    // registration may point at a custom install location. Only names read
    // from a real install belong here; the registered file must exist.
    installed_app_executables: &'static [&'static str],
}

// A Microsoft Store (MSIX) application. Its install directory carries the
// version and architecture (`<name>_<version>_<arch>__<publisher_id>`) and
// sits under a `WindowsApps` directory that users cannot list, so a fixed
// path marker can never match it. The package is identified by name and
// publisher id instead, and located through the current user's registration.
#[derive(Clone, Copy)]
struct StorePackageMarker {
    name: &'static str,
    publisher_id: &'static str,
    executable: &'static str,
}

/// One MSIX package registered for the current Windows user.
#[derive(Debug, Clone)]
struct InstalledStorePackage {
    full_name: String,
    root: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentPlatform {
    Macos,
    Windows,
    Other,
}

impl AgentDefinition {
    fn platform(self, platform: AgentPlatform) -> AgentPlatformDefinition {
        match platform {
            AgentPlatform::Macos => self.macos,
            AgentPlatform::Windows => self.windows,
            AgentPlatform::Other => self.other,
        }
    }
}

const fn supported_agent_platform(
    skills_dir: &'static str,
    application_markers: &'static [&'static str],
) -> AgentPlatformDefinition {
    AgentPlatformDefinition {
        skills_dir: Some(skills_dir),
        application_markers,
        store_packages: &[],
        installed_app_executables: &[],
    }
}

impl AgentPlatformDefinition {
    const fn with_store_packages(self, store_packages: &'static [StorePackageMarker]) -> Self {
        Self {
            store_packages,
            ..self
        }
    }

    const fn with_installed_app_executables(
        self,
        installed_app_executables: &'static [&'static str],
    ) -> Self {
        Self {
            installed_app_executables,
            ..self
        }
    }
}

const UNSUPPORTED_AGENT_PLATFORM: AgentPlatformDefinition = AgentPlatformDefinition {
    skills_dir: None,
    application_markers: &[],
    store_packages: &[],
    installed_app_executables: &[],
};

// v0.10 and earlier projected the pseudo-Agent `agent-skills` into this
// directory on every platform. It remains an ownership/cleanup location on
// Windows, but is never exposed there as a supported Agent or a new install
// target. On macOS the same directory is the current Doubao Work contract.
const LEGACY_GENERIC_AGENT_SKILLS_DIR: &str = ".agents/skills";

fn current_agent_platform() -> AgentPlatform {
    if cfg!(target_os = "macos") {
        AgentPlatform::Macos
    } else if cfg!(target_os = "windows") {
        AgentPlatform::Windows
    } else {
        AgentPlatform::Other
    }
}

// Windows APP evidence lists only what a real Windows host confirmed. An
// Agent whose desktop build has not been verified there is detected through
// its CLI alone; never add an install path that was not read from a real host.
const AGENT_DEFINITIONS: &[AgentDefinition] = &[
    AgentDefinition {
        key: "claude",
        name: "Claude Code",
        executables: &["claude"],
        skill_root_override: Some(SkillRootOverride {
            variable: "CLAUDE_CONFIG_DIR",
            default_relative: ".claude",
        }),
        macos: supported_agent_platform(".claude/skills", &["Claude Code.app"]),
        windows: supported_agent_platform(".claude/skills", &[]),
        other: supported_agent_platform(".claude/skills", &["claude-code.desktop"]),
    },
    AgentDefinition {
        key: "codex",
        // OpenAI now distributes the Codex desktop experience as ChatGPT.
        // Keep the stable key, CLI name, and projection directory so existing
        // installations and server compatibility metadata continue to work.
        name: "ChatGPT",
        executables: &["codex"],
        skill_root_override: Some(SkillRootOverride {
            variable: "CODEX_HOME",
            default_relative: ".codex",
        }),
        macos: supported_agent_platform(".codex/skills", &["ChatGPT.app", "Codex.app"]),
        // Verified on Windows 11 with ChatGPT 26.928 (Microsoft Store package
        // `OpenAI.Codex`): the app is `app/ChatGPT.exe` inside the package and
        // keeps its Skills in `~/.codex/skills`. The standalone Codex CLI at
        // `%LOCALAPPDATA%/Programs/OpenAI/Codex/bin/codex.exe` is CLI evidence
        // and is found through `extend_windows_executable_dirs`.
        windows: supported_agent_platform(".codex/skills", &[]).with_store_packages(&[
            StorePackageMarker {
                name: "OpenAI.Codex",
                publisher_id: "2p2nqsd0c76g0",
                executable: "app/ChatGPT.exe",
            },
        ]),
        other: supported_agent_platform(".codex/skills", &["chatgpt.desktop", "codex.desktop"]),
    },
    AgentDefinition {
        key: "workbuddy",
        name: "WorkBuddy",
        executables: &[],
        skill_root_override: None,
        macos: supported_agent_platform(".workbuddy-ai/skills", &["WorkBuddy AI.app"]),
        // The verified per-user install is
        // `%LOCALAPPDATA%/Programs/WorkBuddy/WorkBuddy.exe`. A custom install
        // location is found through the Uninstall/App Paths registration of
        // that same executable; the registered file must exist.
        windows: supported_agent_platform(
            ".workbuddy/skills",
            &["Programs/WorkBuddy/WorkBuddy.exe"],
        )
        .with_installed_app_executables(&["WorkBuddy.exe"]),
        other: UNSUPPORTED_AGENT_PLATFORM,
    },
    AgentDefinition {
        key: "doubao",
        name: "豆包工作",
        executables: &[],
        skill_root_override: None,
        macos: supported_agent_platform(".agents/skills", &["DoubaoWork.app"]),
        // 豆包工作 for Windows owns its Skill storage internally and does not
        // expose a supported directory contract. Never infer or write one.
        windows: UNSUPPORTED_AGENT_PLATFORM,
        other: UNSUPPORTED_AGENT_PLATFORM,
    },
    AgentDefinition {
        key: "opencode",
        name: "OpenCode",
        executables: &["opencode"],
        skill_root_override: Some(SkillRootOverride {
            variable: "OPENCODE_CONFIG_DIR",
            default_relative: ".config/opencode",
        }),
        macos: supported_agent_platform(".config/opencode/skills", &["OpenCode.app"]),
        windows: supported_agent_platform(".config/opencode/skills", &[]),
        other: supported_agent_platform(".config/opencode/skills", &["opencode.desktop"]),
    },
    AgentDefinition {
        key: "openclaw",
        name: "OpenClaw",
        executables: &["openclaw"],
        skill_root_override: None,
        macos: supported_agent_platform(".openclaw/skills", &["OpenClaw.app"]),
        windows: supported_agent_platform(".openclaw/skills", &[]),
        other: supported_agent_platform(".openclaw/skills", &["openclaw.desktop"]),
    },
    AgentDefinition {
        key: "gemini",
        name: "Gemini CLI",
        executables: &["gemini"],
        skill_root_override: None,
        macos: supported_agent_platform(".gemini/skills", &[]),
        windows: supported_agent_platform(".gemini/skills", &[]),
        other: supported_agent_platform(".gemini/skills", &["gemini.desktop"]),
    },
    AgentDefinition {
        key: "trae",
        name: "Trae",
        // Verified on macOS with Trae 3.5.87 (`com.trae.app`): the app's
        // product data root is `~/.trae` and its global Skill installs target
        // `~/.trae/skills`. The `trae` shell command is only the editor
        // launcher shipped inside the bundle, so the app is the install
        // evidence. Trae CN and Windows have not been verified on real hosts.
        executables: &[],
        skill_root_override: None,
        macos: supported_agent_platform(".trae/skills", &["Trae.app"]),
        windows: UNSUPPORTED_AGENT_PLATFORM,
        other: UNSUPPORTED_AGENT_PLATFORM,
    },
];

fn known_agents_for_platform(
    platform: AgentPlatform,
) -> Vec<(&'static str, &'static str, &'static str)> {
    AGENT_DEFINITIONS
        .iter()
        .filter_map(|agent| {
            agent
                .platform(platform)
                .skills_dir
                .map(|skills_dir| (agent.key, agent.name, skills_dir))
        })
        .collect()
}

fn legacy_managed_projection_dirs_for_platform(platform: AgentPlatform) -> Vec<&'static str> {
    let current = known_agents_for_platform(platform);
    if current
        .iter()
        .any(|(_, _, relative)| *relative == LEGACY_GENERIC_AGENT_SKILLS_DIR)
    {
        Vec::new()
    } else {
        vec![LEGACY_GENERIC_AGENT_SKILLS_DIR]
    }
}

fn managed_projection_dirs_for_platform(platform: AgentPlatform) -> Vec<&'static str> {
    let mut directories = known_agents_for_platform(platform)
        .into_iter()
        .map(|(_, _, relative)| relative)
        .collect::<Vec<_>>();
    directories.extend(legacy_managed_projection_dirs_for_platform(platform));
    directories
}

pub fn known_agents() -> Vec<(&'static str, &'static str, &'static str)> {
    // Skill roots are projection targets, not proof that the corresponding
    // tool is installed. `install_skill` is allowed to create these roots.
    known_agents_for_platform(current_agent_platform())
}

pub fn managed_projection_dirs() -> Vec<&'static str> {
    managed_projection_dirs_for_platform(current_agent_platform())
}

pub fn legacy_managed_projection_dirs() -> Vec<&'static str> {
    legacy_managed_projection_dirs_for_platform(current_agent_platform())
}

#[cfg(not(windows))]
fn executable_search_dirs(home: &Path) -> Vec<PathBuf> {
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    directories.extend([
        home.join(".local/bin"),
        home.join("bin"),
        home.join(".npm-global/bin"),
        home.join(".bun/bin"),
        home.join(".volta/bin"),
        home.join(".asdf/shims"),
        home.join(".local/share/mise/shims"),
        home.join(".local/share/pnpm"),
        home.join("Library/pnpm"),
        home.join(".cargo/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/snap/bin"),
    ]);
    for versions_root in [
        home.join(".nvm/versions/node"),
        home.join(".fnm/node-versions"),
        home.join(".local/share/fnm/node-versions"),
        home.join("Library/Application Support/fnm/node-versions"),
    ] {
        let Ok(versions) = fs::read_dir(versions_root) else {
            continue;
        };
        for version in versions.flatten() {
            directories.push(version.path().join("bin"));
            directories.push(version.path().join("installation/bin"));
        }
    }
    if let Some(app_data) = std::env::var_os("APPDATA") {
        directories.push(PathBuf::from(app_data).join("npm"));
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        extend_windows_executable_dirs(&mut directories, &PathBuf::from(local_app_data));
    }
    let mut seen = HashSet::new();
    directories.retain(|directory| seen.insert(directory.clone()));
    directories
}

fn extend_windows_executable_dirs(directories: &mut Vec<PathBuf>, local_app_data: &Path) {
    directories.extend([
        local_app_data.join("Microsoft/WinGet/Links"),
        local_app_data.join("Programs/OpenAI/Codex/bin"),
        local_app_data.join("Programs/Claude Code"),
    ]);
    let packages = local_app_data.join("Microsoft/WinGet/Packages");
    let Ok(entries) = fs::read_dir(packages) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.starts_with("anthropic.claudecode_")
            || name.starts_with("openai.codex_")
            || name.starts_with("openai.chatgpt_")
        {
            directories.push(entry.path());
            directories.push(entry.path().join("bin"));
        }
    }
}

fn application_roots(home: &Path) -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        home.join("Applications"),
        home.join(".local/share/applications"),
        PathBuf::from("/usr/share/applications"),
    ];
    for variable in [
        "LOCALAPPDATA",
        "APPDATA",
        "ProgramFiles",
        "ProgramFiles(x86)",
    ] {
        if let Some(value) = std::env::var_os(variable) {
            roots.push(PathBuf::from(value));
        }
    }
    roots
}

fn executable_exists(search_dirs: &[PathBuf], executable: &str) -> bool {
    search_dirs.iter().any(|directory| {
        ["", ".exe", ".cmd", ".bat"]
            .iter()
            .any(|suffix| is_launchable_file(&directory.join(format!("{executable}{suffix}"))))
    })
}

fn is_launchable_file(path: &Path) -> bool {
    probe_launchable_file(path).unwrap_or(false)
}

/// Like [`is_launchable_file`], but keeps the read error so a caller can tell
/// "nothing here" from "could not look".
fn probe_launchable_file(path: &Path) -> std::io::Result<bool> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        Ok(metadata.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        Ok(true)
    }
}

fn application_marker_exists(root: &Path, marker: &str) -> bool {
    let path = root.join(marker);
    if marker.ends_with(".app") {
        let Ok(executables) = fs::read_dir(path.join("Contents/MacOS")) else {
            return false;
        };
        return executables
            .flatten()
            .any(|entry| is_launchable_file(&entry.path()));
    }
    if marker.to_ascii_lowercase().ends_with(".exe") {
        return is_launchable_file(&path);
    }
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    metadata.is_file()
}

fn store_package_matches(full_name: &str, marker: &StorePackageMarker) -> bool {
    let full_name = full_name.to_ascii_lowercase();
    full_name.starts_with(&format!("{}_", marker.name).to_ascii_lowercase())
        && full_name.ends_with(&format!("_{}", marker.publisher_id).to_ascii_lowercase())
}

fn store_package_detected(packages: &[InstalledStorePackage], marker: &StorePackageMarker) -> bool {
    packages.iter().any(|package| {
        store_package_matches(&package.full_name, marker)
            && is_launchable_file(&package.root.join(marker.executable))
    })
}

/// MSIX packages registered for the current user that an Agent definition
/// names. Windows removes the registration when the package is uninstalled,
/// and the caller still requires the application executable to exist. A
/// registry read failure is reported instead of being read as "no package".
#[cfg(windows)]
fn installed_store_packages() -> (Vec<InstalledStorePackage>, Vec<DetectionIssue>) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const REPOSITORY_KEY: &str = r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages";

    let repository = match RegKey::predef(HKEY_CURRENT_USER).open_subkey(REPOSITORY_KEY) {
        Ok(repository) => repository,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (Vec::new(), Vec::new())
        }
        Err(error) => {
            return (
                Vec::new(),
                vec![DetectionIssue::new(
                    DetectionIssueSource::StorePackages,
                    format!("无法读取当前用户的 Microsoft Store 包注册信息：{error}"),
                )],
            )
        }
    };
    let mut issues = Vec::new();
    let packages = repository
        .enum_keys()
        .flatten()
        .filter(|full_name| {
            AGENT_DEFINITIONS.iter().any(|agent| {
                agent
                    .windows
                    .store_packages
                    .iter()
                    .any(|marker| store_package_matches(full_name, marker))
            })
        })
        .filter_map(|full_name| {
            let root = repository
                .open_subkey(&full_name)
                .and_then(|package| package.get_value::<String, _>("PackageRootFolder"));
            match root {
                Ok(root) => Some(InstalledStorePackage {
                    full_name,
                    root: PathBuf::from(root),
                }),
                Err(error) => {
                    issues.push(DetectionIssue::new(
                        DetectionIssueSource::StorePackages,
                        format!("无法读取 Store 包 {full_name} 的安装位置：{error}"),
                    ));
                    None
                }
            }
        })
        .collect();
    (packages, issues)
}

/// Every evidence source one detection pass reads, gathered up front so the
/// same decision logic runs against real hosts and test fixtures.
struct AgentDiscovery {
    executable_dirs: Vec<PathBuf>,
    app_roots: Vec<PathBuf>,
    store_packages: Vec<InstalledStorePackage>,
    /// Executables named by Windows Uninstall/App Paths registrations.
    installed_app_candidates: Vec<PathBuf>,
    issues: Vec<DetectionIssue>,
    /// Values of the Skill-root override variables that are set.
    skill_root_overrides: Vec<(&'static str, String)>,
    /// Checks one Windows command candidate; tests inject read failures.
    probe: Box<CandidateProbe>,
}

type CandidateProbe = dyn Fn(&Path) -> std::io::Result<bool>;

impl Default for AgentDiscovery {
    fn default() -> Self {
        Self {
            executable_dirs: Vec::new(),
            app_roots: Vec::new(),
            store_packages: Vec::new(),
            installed_app_candidates: Vec::new(),
            issues: Vec::new(),
            skill_root_overrides: Vec::new(),
            probe: Box::new(probe_launchable_file),
        }
    }
}

/// Whether a Skill-root override value names exactly the default root. On
/// Windows paths compare case-insensitively with either separator; elsewhere
/// only identical components match (case-sensitive volumes exist, and `\`
/// is a file-name character). Anything not provably equal — a relative
/// value, `..`, different case — counts as a real override.
fn override_names_default_root(value: &str, default_root: &Path, platform: AgentPlatform) -> bool {
    if platform == AgentPlatform::Windows {
        return windows_agent_discovery::same_path_entry(value, &default_root.to_string_lossy());
    }
    // Compare as POSIX strings, not through `std::path`: the host's path rules
    // (a Windows gate host treats `/Users/...` as relative) must not leak into
    // a macOS/Linux decision.
    fn posix_components(path: &str) -> Option<Vec<&str>> {
        if !path.starts_with('/') {
            return None;
        }
        let mut components = Vec::new();
        for component in path.split('/') {
            match component {
                "" | "." => {}
                ".." => return None,
                name => components.push(name),
            }
        }
        Some(components)
    }
    match (
        posix_components(value),
        posix_components(&default_root.to_string_lossy()),
    ) {
        (Some(value), Some(default_root)) => value == default_root,
        _ => false,
    }
}

fn read_skill_root_overrides(
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Vec<(&'static str, String)> {
    AGENT_DEFINITIONS
        .iter()
        .filter_map(|agent| agent.skill_root_override)
        .filter_map(|root_override| {
            lookup(root_override.variable)
                .filter(|value| !value.trim().is_empty())
                .map(|value| (root_override.variable, value))
        })
        .collect()
}

#[cfg(windows)]
fn discover_agent_sources(home: &Path) -> AgentDiscovery {
    let (environment, mut issues) = windows_agent_discovery::read_windows_environment();
    let mut installer_dirs = Vec::new();
    if let Some(local_app_data) = environment.var("LOCALAPPDATA") {
        extend_windows_executable_dirs(&mut installer_dirs, Path::new(&local_app_data));
    }
    let executable_dirs =
        windows_agent_discovery::windows_executable_search_dirs(home, &environment, installer_dirs);
    let (store_packages, store_issues) = installed_store_packages();
    let installed_app_names = AGENT_DEFINITIONS
        .iter()
        .flat_map(|agent| agent.windows.installed_app_executables.iter().copied())
        .collect::<Vec<_>>();
    let (installed_app_candidates, app_issues) =
        windows_agent_discovery::read_installed_app_candidates(&installed_app_names, &environment);
    issues.extend(store_issues);
    issues.extend(app_issues);
    AgentDiscovery {
        executable_dirs,
        app_roots: application_roots(home),
        store_packages,
        installed_app_candidates,
        issues,
        skill_root_overrides: read_skill_root_overrides(&|name| environment.var(name)),
        probe: Box::new(probe_launchable_file),
    }
}

#[cfg(not(windows))]
fn discover_agent_sources(home: &Path) -> AgentDiscovery {
    AgentDiscovery {
        executable_dirs: executable_search_dirs(home),
        app_roots: application_roots(home),
        skill_root_overrides: read_skill_root_overrides(&|name| {
            std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
        }),
        ..AgentDiscovery::default()
    }
}

fn agent_skills_dir_label(home: &Path, relative: &str, platform: AgentPlatform) -> String {
    match platform {
        // `~` is not a Windows path, so show the directory Explorer can open.
        AgentPlatform::Windows if !home.as_os_str().is_empty() => format!(
            "{}\\{}",
            home.display().to_string().trim_end_matches(['\\', '/']),
            relative.replace('/', "\\")
        ),
        AgentPlatform::Windows => format!("~\\{}", relative.replace('/', "\\")),
        AgentPlatform::Macos | AgentPlatform::Other => format!("~/{relative}"),
    }
}

#[cfg(test)]
fn detect_agents_with_context(
    home: &Path,
    executable_dirs: &[PathBuf],
    app_roots: &[PathBuf],
    store_packages: &[InstalledStorePackage],
    platform: AgentPlatform,
) -> Vec<AgentInfo> {
    detect_agents_from_discovery(
        home,
        &AgentDiscovery {
            executable_dirs: executable_dirs.to_vec(),
            app_roots: app_roots.to_vec(),
            store_packages: store_packages.to_vec(),
            ..AgentDiscovery::default()
        },
        platform,
    )
}

fn installed_app_registered(candidates: &[PathBuf], executable_names: &[&str]) -> bool {
    candidates.iter().any(|candidate| {
        let text = candidate.to_string_lossy();
        let file_name = windows_agent_discovery::path_file_name(&text);
        executable_names
            .iter()
            .any(|name| file_name.eq_ignore_ascii_case(name))
            && is_launchable_file(candidate)
    })
}

fn detect_agents_from_discovery(
    home: &Path,
    discovery: &AgentDiscovery,
    platform: AgentPlatform,
) -> Vec<AgentInfo> {
    let issues = &discovery.issues;
    AGENT_DEFINITIONS
        .iter()
        .filter_map(|agent| {
            let platform_definition = agent.platform(platform);
            let relative = platform_definition.skills_dir?;
            // Windows commands need an `.exe`/`.cmd`/`.bat` suffix; only
            // those exact paths are probed, and a probe that could not read
            // a candidate (e.g. access denied) is kept as this Agent's issue.
            let mut probe_issues = Vec::new();
            let executable_detected = agent.executables.iter().any(|name| {
                if platform == AgentPlatform::Windows {
                    let (hit, issues) = find_windows_executable(
                        &discovery.executable_dirs,
                        name,
                        &*discovery.probe,
                    );
                    probe_issues.extend(issues);
                    hit.is_some()
                } else {
                    executable_exists(&discovery.executable_dirs, name)
                }
            });
            let application_detected = discovery.app_roots.iter().any(|root| {
                platform_definition
                    .application_markers
                    .iter()
                    .any(|marker| application_marker_exists(root, marker))
            }) || platform_definition
                .store_packages
                .iter()
                .any(|marker| store_package_detected(&discovery.store_packages, marker))
                || installed_app_registered(
                    &discovery.installed_app_candidates,
                    platform_definition.installed_app_executables,
                );
            let detection_source = if application_detected {
                AgentDetectionSource::Application
            } else if executable_detected {
                AgentDetectionSource::Cli
            } else {
                AgentDetectionSource::None
            };
            let unconfirmed_root = agent.skill_root_override.and_then(|root_override| {
                discovery
                    .skill_root_overrides
                    .iter()
                    .find(|(variable, _)| *variable == root_override.variable)
                    .filter(|(_, value)| {
                        !override_names_default_root(
                            value,
                            &home.join(root_override.default_relative),
                            platform,
                        )
                    })
            });
            let skills_status = if unconfirmed_root.is_some() {
                AgentSkillsStatus::Unconfirmed
            } else if home.join(relative).is_dir() {
                AgentSkillsStatus::Ready
            } else {
                AgentSkillsStatus::Missing
            };
            let relies_on = |source: DetectionIssueSource| match source {
                DetectionIssueSource::CliSearch => !agent.executables.is_empty(),
                DetectionIssueSource::StorePackages => {
                    !platform_definition.store_packages.is_empty()
                }
                DetectionIssueSource::InstalledApps => {
                    !platform_definition.installed_app_executables.is_empty()
                }
            };
            let relevant = issues
                .iter()
                .filter(|issue| relies_on(issue.source))
                .chain(&probe_issues)
                .collect::<Vec<_>>();
            let mut detection_issues = Vec::new();
            for issue in &relevant {
                if !detection_issues.contains(&issue.message) {
                    detection_issues.push(issue.message.clone());
                }
            }
            let detected = executable_detected || application_detected;
            let detection_state = if detected {
                AgentDetectionState::Detected
            } else if relevant.is_empty() {
                AgentDetectionState::NotFound
            } else {
                AgentDetectionState::Incomplete
            };
            if let Some((variable, value)) = unconfirmed_root {
                detection_issues.push(format!(
                    "Skill 目录未确认：检测到 {variable}={value}，已阻止写入默认目录"
                ));
            }
            Some(AgentInfo {
                key: agent.key.to_string(),
                name: agent.name.to_string(),
                dir: agent_skills_dir_label(home, relative, platform),
                detected,
                detection_source,
                skills_status,
                detection_state,
                detection_issues,
            })
        })
        .collect()
}

fn detect_agents_uncached() -> Vec<AgentInfo> {
    let home = user_home_dir().unwrap_or_default();
    detect_agents_from_discovery(
        &home,
        &discover_agent_sources(&home),
        current_agent_platform(),
    )
}

/// How long the background Skill-list change poll may reuse one detection
/// pass. A full Windows pass reads the registry PATH, Store and Uninstall
/// keys and probes every search directory, which is too heavy to repeat on
/// every 2.5 s poll.
const AGENT_DETECTION_CACHE_TTL: Duration = Duration::from_secs(30);

type AgentDetectionCache = Mutex<Option<(Instant, Vec<AgentInfo>)>>;

static AGENT_DETECTION_CACHE: AgentDetectionCache = Mutex::new(None);

fn store_agent_detection(cache: &AgentDetectionCache, now: Instant, agents: &[AgentInfo]) {
    if let Ok(mut cached) = cache.lock() {
        *cached = Some((now, agents.to_vec()));
    }
}

fn cached_agent_detection(
    cache: &AgentDetectionCache,
    now: Instant,
    ttl: Duration,
    detect: impl FnOnce() -> Vec<AgentInfo>,
) -> Vec<AgentInfo> {
    if let Ok(cached) = cache.lock() {
        if let Some((at, agents)) = cached.as_ref() {
            if now.saturating_duration_since(*at) < ttl {
                return agents.clone();
            }
        }
    }
    let agents = detect();
    store_agent_detection(cache, now, &agents);
    agents
}

/// A fresh detection pass. Every user action, write path and explicit
/// 「重新检测」 uses this, and it refreshes the cache the poll reads.
pub fn detect_agents() -> Vec<AgentInfo> {
    let agents = detect_agents_uncached();
    store_agent_detection(&AGENT_DETECTION_CACHE, Instant::now(), &agents);
    agents
}

/// Detected keys for the background change poll only: reuses a pass up to
/// [`AGENT_DETECTION_CACHE_TTL`] old. Never use it to admit writes.
pub fn cached_detected_agent_keys() -> HashSet<String> {
    cached_agent_detection(
        &AGENT_DETECTION_CACHE,
        Instant::now(),
        AGENT_DETECTION_CACHE_TTL,
        detect_agents_uncached,
    )
    .into_iter()
    .filter(admits_skill_writes)
    .map(|agent| agent.key)
    .collect()
}

/// Agents whose default Skill root SkillHub may read and write: detected,
/// with no unconfirmed root override.
pub fn detected_agent_keys() -> HashSet<String> {
    detect_agents()
        .into_iter()
        .filter(admits_skill_writes)
        .map(|agent| agent.key)
        .collect()
}

pub fn ready_detected_agent_keys() -> HashSet<String> {
    detect_agents()
        .into_iter()
        .filter(|agent| agent.detected && agent.skills_status == AgentSkillsStatus::Ready)
        .map(|agent| agent.key)
        .collect()
}

// ── Tauri app entry point ──────────────────────────────────────────────────────────────────────────────

fn app_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let onboarding_evidence = onboarding::StartupEvidence(onboarding::capture(&skillhub_dir()));
    let builder = tauri::Builder::default()
        .manage(onboarding_evidence)
        .register_asynchronous_uri_scheme_protocol(
            "skillhub-media",
            |context, request, responder| {
                media::respond(context.app_handle().clone(), request, responder);
            },
        )
        .manage(app_links::PendingDeepLinks::default())
        .manage(migration::Jobs::default())
        .manage(
            server_request::SpaceRegistry::from_runtime()
                .expect("invalid compiled server configuration"),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init());
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        app_links::enqueue_deep_links(app, args);
    }));
    let app = builder
        .setup(|app| {
            tauri::Manager::manage(
                app,
                spaces::start_app(&skillhub_dir()).map_err(anyhow::Error::msg)?,
            );
            spaces::observe_session(app.handle().clone());
            app_links::setup(app)?;
            ensure_skillhub_dirs()?;
            // Older builds aggregated every Skill secret into one shell file.
            // Retire only files that carry SkillHub's marker; values continue
            // to live per Skill and are injected into an explicit CLI session.
            commands::retire_legacy_active_env().map_err(anyhow::Error::msg)?;
            // Discover interrupted Marketplace swaps before projection refresh.
            // The refresh path skips those Skill ids so a crash-recovery pair is
            // never mistaken for a user edit during application startup.
            let _ = commands::discover_interrupted_marketplace_replacements();
            // The Manager is a bundled system protocol, not a removable user
            // asset. Startup recreates its canonical files and Agent
            // projections if they were deleted or modified outside SkillHub.
            let _ = commands::repair_system_manager();
            // A single conflicting projection or pre-existing CLI name must
            // be visible as a repairable status, never prevent the GUI from
            // opening. Each projection records its own conflict marker.
            let _ = commands::refresh_installed_projections();
            // One-time per-Skill → personal key vault migration (#253) for
            // the current runtime identity; idempotent, never blocks startup.
            if let Some(user_id) = runtime_env::active_runtime_user_id() {
                let _ = key_vault::ensure_vault_migrated_at(&skillhub_dir(), &envs_dir(), &user_id);
            }
            tauri::async_runtime::spawn(async {
                let _ = runtime_env::recheck_runtime_cli().await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            onboarding::onboarding_evidence,
            local_inference::local_inference_probe,
            local_inference::worker::local_inference_worker_configure,
            local_inference::worker::local_inference_worker_status,
            local_inference::local_inference_run,
            local_inference::local_inference_cancel,
            server_request::current_space,
            server_request::test_space_connection,
            app_links::normalize_invite_server,
            server_request::begin_space_switch,
            server_request::commit_space_switch,
            server_request::cancel_space_switch,
            media::current_media_space,
            server_request::auth_state,
            server_request::clear_auth_session,
            server_request::import_legacy_auth,
            server_request::server_request,
            server_request::cancel_server_request,
            avatar_upload::pick_and_upload_avatar,
            avatar_upload::pick_avatar_source,
            app_links::read_clipboard_text,
            app_links::take_pending_deep_links,
            portal_auth::start_yitan_portal_auth,
            portal_auth::start_catalog_login,
            portal_auth::cancel_catalog_login,
            catalog_session::catalog_session_status,
            catalog_session::catalog_logout,
            catalog_publish::catalog_publish,
            catalog_publish::catalog_submission_status,
            portal_auth::cancel_yitan_portal_auth,
            portal_auth::open_yitan_account_portal,
            commands::get_local_skills,
            commands::get_local_skill,
            commands::get_unmanaged_agent_skills,
            commands::skill_library_fingerprint,
            commands::open_agent_skill_dir,
            commands::open_agent_skill_conflict,
            commands::preflight_install_skill,
            commands::install_skill,
            commands::uninstall_skill,
            commands::unmanage::preflight_unmanage_skill,
            commands::unmanage::unmanage_skill,
            commands::delete_managed_skill,
            commands::list_trash_items_async,
            commands::restore_trash_item,
            commands::open_trash_item,
            commands::enable_skill,
            commands::disable_skill,
            commands::preflight_import_skill,
            commands::import_skill,
            commands::open_skill_dir,
            commands::get_skill_versions,
            commands::create_skill_snapshot,
            commands::create_skill_snapshot_with_version,
            commands::get_skill_version_state,
            library_sync::record_skill_formal_version,
            commands::restore_skill_version,
            commands::get_skill_diff,
            commands::get_skill_working_diff,
            commands::detect_env_vars,
            commands::detect_env_var_suggestions,
            commands::get_installed_agents,
            commands::read_skill_md,
            commands::inspect_skill_markdown,
            commands::read_skill_file,
            commands::get_skill_tree,
            commands::update_skill_profile,
            commands::ensure_skill_avatar_identity,
            commands::cache_skill_avatar,
            commands::read_avatar_parking,
            commands::write_avatar_parking,
            commands::set_skill_env,
            commands::delete_skill_env,
            commands::list_vault_keys,
            commands::get_key_vault_settings,
            commands::list_env_backups,
            commands::reveal_env_backups,
            commands::delete_env_backups,
            commands::set_vault_key,
            commands::create_vault_key_variant,
            commands::set_vault_key_variant_label,
            commands::set_vault_default_variant,
            commands::convert_skill_override_to_variant,
            commands::delete_vault_key,
            commands::set_key_auto_allow,
            commands::set_vault_key_aliases,
            commands::suggest_vault_key_alias,
            commands::grant_key_access,
            commands::list_last_run_failures,
            commands::clear_last_run_failure,
            commands::revoke_key_access,
            commands::set_vault_key_skill_access,
            commands::list_key_consent_requests,
            commands::dismiss_key_consent_request,
            commands::sync_env_dependencies,
            commands::read_env_declarations,
            commands::write_env_declarations,
            commands::check_shell_integration,
            commands::disable_legacy_shell_integration,
            commands::create_skill_package,
            commands::import_skill_package,
            commands::rollback_marketplace_replacement,
            runtime_env::get_skill_env_source_policy,
            runtime_env::set_skill_env_source,
            runtime_env::provide_personal_env_to_team,
            team_keys::list_team_keys,
            team_keys::put_team_key,
            team_keys::delete_team_key,
            team_keys::set_team_key_exclusion,
            team_keys::set_team_key_aliases,
            team_keys::team_key_usage,
            runtime_env::get_runtime_cli_status,
            runtime_env::recheck_runtime_cli,
            library_sync::library_sync_run,
            library_sync::library_sync_status,
            library_sync::library_list_entries,
            library_sync::library_join_local,
            library_sync::library_delete_from_account,
            library_sync::library_author_asset,
            library_sync::library_share_preflight,
            library_sync::library_restore_entry,
            library_organizer::organizer_load,
            library_organizer::organizer_save,
            migration::migration_snapshot_begin,
            migration::migration_set_choices,
            migration::migration_run,
            migration::migration_cancel,
            migration::migration_status,
            migration::migration_report,
            migration::migration_list,
            migration::migration_key_names,
        ])
        .build(app_context())
        .expect("error while building tauri application");
    app.run(|app, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            // Let Tauri retain the original exit code / RESTART_EXIT_CODE.
            // macOS Cmd+Q / Apple Event quit can bypass ExitRequested entirely.
            local_inference::worker::cleanup_exit(app);
        }
    });
}

const CLI_USAGE: &str = "用法：\n  skillhub --version\n  skillhub server show [--json]\n  skillhub server use <url|official|local>\n  skillhub status --json\n  skillhub doctor --json\n  skillhub auth status [--refresh] --json\n  skillhub app open --json\n  skillhub update check --json\n  skillhub agent list --json\n  skillhub skill --help\n  skillhub marketplace --help\n  skillhub team --help\n  skillhub feedback --help\n  skillhub env --help\n  skillhub sync --help\n  skillhub run <skill-id> -- <program> [args...]";

fn cli_help(args: &[String]) -> Option<String> {
    let root_help = matches!(
        args.first().map(String::as_str),
        Some("--help" | "-h" | "help")
    );
    let leaf_help = args
        .iter()
        .skip(1)
        .any(|argument| matches!(argument.as_str(), "--help" | "-h"));
    if !root_help && !leaf_help {
        return None;
    }

    match args.first().map(String::as_str) {
        Some("--help" | "-h" | "help") => Some(CLI_USAGE.to_string()),
        Some("status") => Some("用法：skillhub status --json".to_string()),
        Some("doctor") => Some("用法：skillhub doctor --json".to_string()),
        Some("auth") => Some("用法：skillhub auth status [--refresh] --json".to_string()),
        Some("server") => Some(
            "用法：skillhub server show [--json] | skillhub server use <url|official|local>"
                .to_string(),
        ),
        Some("agent") => Some("用法：skillhub agent list --json".to_string()),
        Some("app") => Some(cli_app::APP_USAGE.to_string()),
        Some("update") => Some(cli_app::UPDATE_USAGE.to_string()),
        Some("skill") => Some(format!(
            "{}\n{}",
            cli_local::SKILL_USAGE,
            cli_operations::ANALYZE_USAGE
        )),
        Some("env") => Some(cli_operations::ENV_USAGE.to_string()),
        Some("marketplace") => Some(format!(
            "{}\n{}",
            cli_cloud::MARKETPLACE_USAGE,
            cli_acquire::MARKETPLACE_ACQUIRE_USAGE
        )),
        Some("team") => Some(format!(
            "{}\n{}\n{}",
            cli_cloud::TEAM_USAGE,
            cli_acquire::TEAM_ACQUIRE_USAGE,
            cli_team::TEAM_MUTATION_USAGE
        )),
        Some("feedback") => Some(cli_feedback::FEEDBACK_USAGE.to_string()),
        Some("run") => Some(runtime_env::RUN_USAGE.to_string()),
        Some("sync") => Some(library_sync::SYNC_USAGE.to_string()),
        _ => None,
    }
}

pub fn run_cli(args: &[String]) -> i32 {
    if let Some(help) = cli_help(args) {
        println!("{help}");
        return 0;
    }
    if matches!(args.first().map(String::as_str), Some("--version" | "-V")) {
        println!("skillhub {}", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    if let Err(error) = spaces::recover_cli_startup(&skillhub_dir()) {
        eprintln!("{error}");
        return cli::EXIT_CONFLICT;
    }
    if args.first().map(String::as_str) == Some("server") {
        return cli_server::run(args);
    }
    if !matches!(
        args.first().map(String::as_str),
        Some(
            "auth"
                | "run"
                | "skill"
                | "status"
                | "doctor"
                | "agent"
                | "app"
                | "update"
                | "marketplace"
                | "team"
                | "feedback"
                | "env"
                | "sync"
        )
    ) {
        eprintln!("{CLI_USAGE}");
        return 2;
    }
    if cli_mutation::is_mutation_command(args) {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                eprintln!("无法启动 SkillHub CLI: {error}");
                return 1;
            }
        };
        return runtime
            .block_on(cli_mutation::execute_mutation_cli(args))
            .expect("recognized Skill mutation command")
            .write_to_stdout();
    }
    if cli_lifecycle::is_lifecycle_command(args) {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                eprintln!("无法启动 SkillHub CLI: {error}");
                return 1;
            }
        };
        return runtime
            .block_on(cli_lifecycle::execute_lifecycle_cli(args))
            .expect("recognized Skill lifecycle command")
            .write_to_stdout();
    }
    if cli_operations::is_operations_command(args) {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                eprintln!("无法启动 SkillHub CLI: {error}");
                return 1;
            }
        };
        return runtime
            .block_on(cli_operations::execute_operations_cli(args))
            .expect("recognized account operation command")
            .write_to_stdout();
    }
    if let Some(output) = cli_edit::execute_edit_cli(args) {
        return output.write_to_stdout();
    }
    if let Some(output) = cli_local::execute_local_cli(args) {
        return output.write_to_stdout();
    }
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("无法启动 SkillHub CLI: {error}");
            return 1;
        }
    };
    if args.first().map(String::as_str) == Some("auth") {
        return runtime
            .block_on(cli_auth::execute_auth_cli(args))
            .write_to_stdout();
    }
    if let Some(output) = runtime.block_on(library_sync::execute_sync_cli(args)) {
        return output.write_to_stdout();
    }
    if let Some(output) = runtime.block_on(cli_app::execute_app_cli(args)) {
        return output.write_to_stdout();
    }
    if let Some(output) = runtime.block_on(cli_feedback::execute_feedback_cli(args)) {
        return output.write_to_stdout();
    }
    if let Some(output) = runtime.block_on(cli_team::execute_team_mutation_cli(args)) {
        return output.write_to_stdout();
    }
    if let Some(output) = runtime.block_on(cli_acquire::execute_acquire_cli(args)) {
        return output.write_to_stdout();
    }
    if let Some(output) = runtime.block_on(cli_cloud::execute_cloud_cli(args)) {
        return output.write_to_stdout();
    }
    match runtime.block_on(runtime_env::execute_cli(args)) {
        Ok(exit_code) => exit_code,
        Err(error) => {
            eprintln!("{error}");
            if error.starts_with("用法：") {
                2
            } else {
                1
            }
        }
    }
}

#[cfg(test)]
mod cli_exit_tests {
    use super::{cli_help, run_cli, CLI_USAGE};

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn help_version_and_usage_keep_the_cli_exit_contract() {
        assert_eq!(run_cli(&["--help".into()]), 0);
        assert_eq!(run_cli(&["--version".into()]), 0);
        assert_eq!(run_cli(&["invalid".into()]), 2);
        assert_eq!(run_cli(&["auth".into(), "status".into()]), 2);
        assert_eq!(run_cli(&["run".into(), "sample".into(), "env".into()]), 2);
        assert_eq!(
            run_cli(&["run".into(), "sample".into(), "--".into(), "env".into(),]),
            1
        );
        assert!(CLI_USAGE.contains("run <skill-id> -- <program> [args...]"));
        assert!(!CLI_USAGE.contains("run <skill-id> -- env"));
        assert!(CLI_USAGE.contains("skillhub --version"));
    }

    #[test]
    fn every_public_leaf_help_is_handled_before_business_dispatch() {
        let leaf_commands: &[&[&str]] = &[
            &["status"],
            &["doctor"],
            &["auth", "status"],
            &["server", "show"],
            &["app", "open"],
            &["update", "check"],
            &["agent", "list"],
            &["skill", "list"],
            &["skill", "show"],
            &["skill", "discover"],
            &["skill", "import", "preflight"],
            &["skill", "import", "apply"],
            &["skill", "install", "preflight"],
            &["skill", "install", "apply"],
            &["skill", "enable", "preflight"],
            &["skill", "enable", "apply"],
            &["skill", "disable", "preflight"],
            &["skill", "disable", "apply"],
            &["skill", "uninstall", "preflight"],
            &["skill", "uninstall", "apply"],
            &["skill", "history"],
            &["skill", "diff"],
            &["skill", "snapshot"],
            &["skill", "restore-version", "preflight"],
            &["skill", "restore-version", "apply"],
            &["skill", "delete", "preflight"],
            &["skill", "delete", "apply"],
            &["skill", "trash", "list"],
            &["skill", "trash", "restore", "preflight"],
            &["skill", "trash", "restore", "apply"],
            &["skill", "prepare-edit"],
            &["skill", "finish-edit"],
            &["skill", "analyze"],
            &["marketplace", "search"],
            &["marketplace", "show"],
            &["marketplace", "updates"],
            &["marketplace", "install"],
            &["team", "list"],
            &["team", "skills"],
            &["team", "show"],
            &["team", "updates"],
            &["team", "install"],
            &["team", "share", "preflight"],
            &["team", "share", "apply"],
            &["team", "share", "status"],
            &["team", "unshare", "preflight"],
            &["team", "unshare", "apply"],
            &["feedback", "submit", "preflight"],
            &["feedback", "submit", "apply"],
            &["feedback", "status"],
            &["env", "status"],
            &["env", "request"],
            &["run"],
        ];

        for command in leaf_commands {
            let mut args = strings(command);
            args.push("--help".into());
            let help = cli_help(&args)
                .unwrap_or_else(|| panic!("leaf help was not intercepted: {command:?}"));
            assert!(
                help.starts_with("用法："),
                "unexpected help for {command:?}"
            );
            assert!(!help.contains("\"account\""));
            assert_eq!(run_cli(&args), 0, "leaf help failed: {command:?}");
        }
    }
}

#[cfg(all(test, unix))]
mod agent_detection_tests {
    use super::{
        detect_agents_with_context, executable_search_dirs, extend_windows_executable_dirs,
        known_agents_for_platform, legacy_managed_projection_dirs_for_platform,
        managed_projection_dirs_for_platform, AgentDetectionSource, AgentPlatform,
        AgentSkillsStatus,
    };
    use std::fs;
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::{Path, PathBuf};

    fn detected_keys(home: &Path, bins: &[PathBuf], apps: &[PathBuf]) -> Vec<String> {
        detect_agents_with_context(home, bins, apps, &[], AgentPlatform::Macos)
            .into_iter()
            .filter(|agent| agent.detected)
            .map(|agent| agent.key)
            .collect()
    }

    #[test]
    fn skill_projection_directories_alone_do_not_detect_agents() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-agent-detection-empty-{}",
            uuid::Uuid::new_v4()
        ));
        for relative in [
            ".claude/skills",
            ".codex/skills",
            ".workbuddy-ai/skills",
            ".agents/skills",
            ".config/opencode/skills",
            ".openclaw/skills",
            ".gemini/skills",
            ".trae/skills",
        ] {
            fs::create_dir_all(home.join(relative)).expect("create projected skills directory");
        }

        assert!(detected_keys(&home, &[], &[]).is_empty());
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn detects_real_cli_and_app_but_ignores_config_and_shared_skill_evidence() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-agent-detection-evidence-{}",
            uuid::Uuid::new_v4()
        ));
        let bin = home.join("test-bin");
        let apps = home.join("test-applications");
        fs::create_dir_all(&bin).expect("create executable directory");
        let codex_app_executable = apps.join("ChatGPT.app/Contents/MacOS/ChatGPT");
        fs::create_dir_all(
            codex_app_executable
                .parent()
                .expect("ChatGPT executable parent"),
        )
        .expect("create ChatGPT desktop marker");
        fs::write(&codex_app_executable, "test").expect("create ChatGPT app executable");
        fs::write(bin.join("claude"), "test").expect("create Claude CLI marker");
        fs::write(bin.join("gemini.cmd"), "test").expect("create Gemini Windows CLI marker");
        fs::set_permissions(&codex_app_executable, fs::Permissions::from_mode(0o755))
            .expect("make Codex app executable");
        fs::set_permissions(bin.join("claude"), fs::Permissions::from_mode(0o755))
            .expect("make Claude marker executable");
        fs::set_permissions(bin.join("gemini.cmd"), fs::Permissions::from_mode(0o755))
            .expect("make Gemini marker executable");
        fs::create_dir_all(home.join(".config/opencode")).expect("create OpenCode config root");
        fs::write(home.join(".config/opencode/opencode.json"), "{}")
            .expect("write OpenCode config");
        fs::create_dir_all(home.join(".openclaw")).expect("create OpenClaw config root");
        fs::write(home.join(".openclaw/openclaw.json"), "{}").expect("write OpenClaw config");
        fs::create_dir_all(home.join(".agents/skills/example")).expect("create generic skill");
        fs::write(home.join(".agents/skills/example/SKILL.md"), "# Example")
            .expect("write generic skill");
        fs::create_dir_all(apps.join("OpenCode.app")).expect("create incomplete OpenCode app");

        let keys = detected_keys(&home, &[bin], &[apps]);
        for expected in ["claude", "codex", "gemini"] {
            assert!(keys.iter().any(|key| key == expected), "missing {expected}");
        }
        for unexpected in ["workbuddy", "doubao", "opencode", "openclaw"] {
            assert!(
                !keys.iter().any(|key| key == unexpected),
                "unexpected {unexpected}"
            );
        }
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn chatgpt_desktop_keeps_the_codex_compatibility_key_and_new_display_name() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-agent-detection-chatgpt-{}",
            uuid::Uuid::new_v4()
        ));
        let apps = home.join("Applications");
        let executable = apps.join("ChatGPT.app/Contents/MacOS/ChatGPT");
        fs::create_dir_all(executable.parent().expect("ChatGPT executable parent"))
            .expect("create ChatGPT bundle");
        fs::write(&executable, "test").expect("create ChatGPT executable");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
            .expect("make ChatGPT executable");

        let detected = detect_agents_with_context(&home, &[], &[apps], &[], AgentPlatform::Macos);
        let chatgpt = detected
            .iter()
            .find(|agent| agent.key == "codex")
            .expect("find ChatGPT compatibility entry");
        assert!(chatgpt.detected);
        assert_eq!(chatgpt.name, "ChatGPT");
        assert_eq!(chatgpt.dir, "~/.codex/skills");
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn finder_launch_search_discovers_nvm_cli_bins() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-agent-detection-nvm-{}",
            uuid::Uuid::new_v4()
        ));
        let nvm_bin = home.join(".nvm/versions/node/v24.0.0/bin");
        fs::create_dir_all(&nvm_bin).expect("create NVM bin");
        fs::write(nvm_bin.join("claude"), "test").expect("create NVM Claude CLI");
        fs::set_permissions(nvm_bin.join("claude"), fs::Permissions::from_mode(0o755))
            .expect("make NVM Claude executable");

        let search_dirs = executable_search_dirs(&home);
        assert!(search_dirs.contains(&nvm_bin));
        assert!(detected_keys(&home, &[nvm_bin], &[])
            .iter()
            .any(|key| key == "claude"));
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn windows_install_locations_discover_winget_claude_and_openai_codex() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-agent-detection-windows-{}",
            uuid::Uuid::new_v4()
        ));
        let claude = root.join(
            "Microsoft/WinGet/Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe",
        );
        let codex = root.join("Programs/OpenAI/Codex/bin");
        fs::create_dir_all(&claude).expect("create Claude winget package");
        fs::create_dir_all(&codex).expect("create Codex application bin");
        fs::write(claude.join("claude.exe"), "test").expect("write Claude executable");
        fs::write(codex.join("codex.exe"), "test").expect("write Codex executable");
        fs::set_permissions(claude.join("claude.exe"), fs::Permissions::from_mode(0o755))
            .expect("make Claude executable");
        fs::set_permissions(codex.join("codex.exe"), fs::Permissions::from_mode(0o755))
            .expect("make Codex executable");

        let mut directories = Vec::new();
        extend_windows_executable_dirs(&mut directories, &root);
        let detected =
            detect_agents_with_context(&root, &directories, &[], &[], AgentPlatform::Windows);
        for key in ["claude", "codex"] {
            let agent = detected
                .iter()
                .find(|agent| agent.key == key)
                .expect("find CLI Agent");
            assert!(agent.detected, "{key} CLI must be detected");
            assert_eq!(agent.detection_source, AgentDetectionSource::Cli);
        }
        fs::remove_dir_all(root).expect("remove Windows detection fixture");
    }

    #[test]
    fn cli_detection_requires_a_real_executable_file() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-agent-executable-{}",
            uuid::Uuid::new_v4()
        ));
        let bin = home.join("test-bin");
        fs::create_dir_all(&bin).expect("create executable directory");
        fs::write(bin.join("codex"), "test").expect("create non-executable Codex file");
        let non_executable = detect_agents_with_context(
            &home,
            std::slice::from_ref(&bin),
            &[],
            &[],
            AgentPlatform::Macos,
        );
        assert!(
            !non_executable
                .iter()
                .find(|agent| agent.key == "codex")
                .expect("find Codex")
                .detected
        );

        fs::set_permissions(bin.join("codex"), fs::Permissions::from_mode(0o755))
            .expect("make Codex executable");
        let executable = detect_agents_with_context(&home, &[bin], &[], &[], AgentPlatform::Macos);
        assert!(
            executable
                .iter()
                .find(|agent| agent.key == "codex")
                .expect("find Codex")
                .detected
        );
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[cfg(unix)]
    #[test]
    fn skillhub_projection_is_not_generic_agent_evidence() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-agent-detection-managed-{}",
            uuid::Uuid::new_v4()
        ));
        let managed = home.join(".skillhub/skills/example");
        fs::create_dir_all(&managed).expect("create managed skill");
        fs::write(managed.join("SKILL.md"), "# Managed").expect("write managed skill");
        fs::create_dir_all(home.join(".agents/skills")).expect("create generic skills root");
        std::os::unix::fs::symlink(&managed, home.join(".agents/skills/example"))
            .expect("create SkillHub projection");

        assert!(!detected_keys(&home, &[], &[])
            .iter()
            .any(|key| key == "doubao"));
        fs::remove_dir_all(home).expect("remove test home");
    }

    #[test]
    fn app_only_agents_separate_application_evidence_from_skill_directory_readiness() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-agent-detection-apps-{}",
            uuid::Uuid::new_v4()
        ));
        let apps = home.join("Applications");
        for executable in [
            apps.join("WorkBuddy AI.app/Contents/MacOS/Electron"),
            apps.join("DoubaoWork.app/Contents/MacOS/DoubaoWork"),
        ] {
            fs::create_dir_all(executable.parent().expect("application executable parent"))
                .expect("create application bundle");
            fs::write(&executable, "test").expect("write application executable");
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
                .expect("make application executable");
        }
        fs::create_dir_all(home.join(".workbuddy-ai/skills")).expect("create WorkBuddy Skill root");

        let detected = detect_agents_with_context(
            &home,
            &[],
            std::slice::from_ref(&apps),
            &[],
            AgentPlatform::Macos,
        );
        let workbuddy = detected
            .iter()
            .find(|agent| agent.key == "workbuddy")
            .expect("find WorkBuddy");
        assert!(workbuddy.detected);
        assert_eq!(
            workbuddy.detection_source,
            AgentDetectionSource::Application
        );
        assert_eq!(workbuddy.skills_status, AgentSkillsStatus::Ready);
        assert_eq!(workbuddy.dir, "~/.workbuddy-ai/skills");

        let doubao = detected
            .iter()
            .find(|agent| agent.key == "doubao")
            .expect("find Doubao Work");
        assert!(doubao.detected);
        assert_eq!(doubao.detection_source, AgentDetectionSource::Application);
        assert_eq!(doubao.skills_status, AgentSkillsStatus::Missing);
        assert_eq!(doubao.dir, "~/.agents/skills");
        fs::remove_dir_all(home).expect("remove app-only fixture");
    }

    #[test]
    fn app_only_agents_ignore_same_named_path_executables() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-agent-detection-apps-not-cli-{}",
            uuid::Uuid::new_v4()
        ));
        let bin = home.join("bin");
        fs::create_dir_all(&bin).expect("create executable fixture");
        for executable in ["workbuddy", "doubao"] {
            let path = bin.join(executable);
            fs::write(&path, "test").expect("write misleading executable");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                .expect("make misleading executable launchable");
        }

        let detected = detect_agents_with_context(&home, &[bin], &[], &[], AgentPlatform::Macos);
        for app_only_agent in ["workbuddy", "doubao"] {
            let agent = detected
                .iter()
                .find(|agent| agent.key == app_only_agent)
                .expect("find app-only Agent");
            assert!(
                !agent.detected,
                "{app_only_agent} must require APP evidence"
            );
            assert_eq!(agent.detection_source, AgentDetectionSource::None);
        }
        fs::remove_dir_all(home).expect("remove misleading CLI fixture");
    }

    #[test]
    fn windows_agent_list_contains_workbuddy_and_omits_doubao_entirely() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-agent-detection-windows-apps-{}",
            uuid::Uuid::new_v4()
        ));
        let local_app_data = home.join("AppData/Local");
        let workbuddy_executable = local_app_data.join("Programs/WorkBuddy/WorkBuddy.exe");
        let doubao_executable = local_app_data.join("DoubaoWork/Application/DoubaoWork.exe");
        for executable in [&workbuddy_executable, &doubao_executable] {
            fs::create_dir_all(executable.parent().expect("Windows application parent"))
                .expect("create Windows application directory");
            fs::write(executable, "test").expect("write Windows executable");
            fs::set_permissions(executable, fs::Permissions::from_mode(0o755))
                .expect("make Windows fixture executable");
        }
        fs::create_dir_all(home.join(".workbuddy/skills"))
            .expect("create Windows WorkBuddy Skill root");

        let detected = detect_agents_with_context(
            &home,
            &[],
            std::slice::from_ref(&local_app_data),
            &[],
            AgentPlatform::Windows,
        );
        let workbuddy = detected
            .iter()
            .find(|agent| agent.key == "workbuddy")
            .expect("find Windows WorkBuddy");
        assert!(workbuddy.detected);
        assert_eq!(
            workbuddy.detection_source,
            AgentDetectionSource::Application
        );
        assert_eq!(workbuddy.skills_status, AgentSkillsStatus::Ready);
        assert_eq!(
            workbuddy.dir,
            format!("{}\\.workbuddy\\skills", home.display())
        );

        assert!(!detected.iter().any(|agent| agent.key == "doubao"));

        let windows_agents = known_agents_for_platform(AgentPlatform::Windows);
        assert!(windows_agents
            .iter()
            .any(|(key, _, relative)| { *key == "workbuddy" && *relative == ".workbuddy/skills" }));
        assert!(!windows_agents.iter().any(|(key, _, _)| *key == "doubao"));
        assert_eq!(
            legacy_managed_projection_dirs_for_platform(AgentPlatform::Windows),
            vec![".agents/skills"]
        );
        let managed_directories = managed_projection_dirs_for_platform(AgentPlatform::Windows);
        assert!(managed_directories.contains(&".agents/skills"));
        assert_eq!(
            managed_directories
                .iter()
                .filter(|relative| **relative == ".agents/skills")
                .count(),
            1
        );
        fs::remove_dir_all(home).expect("remove Windows app fixture");
    }

    #[test]
    fn trae_is_a_macos_app_only_agent_with_its_own_skill_root() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-agent-detection-trae-{}",
            uuid::Uuid::new_v4()
        ));
        let apps = home.join("Applications");
        let bin = home.join("bin");
        fs::create_dir_all(&bin).expect("create executable fixture");
        let launcher = bin.join("trae");
        fs::write(&launcher, "test").expect("write editor launcher");
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755))
            .expect("make editor launcher executable");
        fs::create_dir_all(home.join(".trae/skills")).expect("create Trae Skill root");

        // A leftover data folder plus the shell launcher is not an install.
        let without_app = detect_agents_with_context(
            &home,
            std::slice::from_ref(&bin),
            std::slice::from_ref(&apps),
            &[],
            AgentPlatform::Macos,
        );
        let trae = without_app
            .iter()
            .find(|agent| agent.key == "trae")
            .expect("list Trae on macOS");
        assert!(!trae.detected);
        assert_eq!(trae.detection_source, AgentDetectionSource::None);
        assert_eq!(trae.skills_status, AgentSkillsStatus::Ready);

        let executable = apps.join("Trae.app/Contents/MacOS/Electron");
        fs::create_dir_all(executable.parent().expect("Trae executable parent"))
            .expect("create Trae bundle");
        fs::write(&executable, "test").expect("write Trae executable");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
            .expect("make Trae executable");
        let with_app =
            detect_agents_with_context(&home, &[bin], &[apps], &[], AgentPlatform::Macos);
        let trae = with_app
            .iter()
            .find(|agent| agent.key == "trae")
            .expect("list Trae on macOS");
        assert!(trae.detected);
        assert_eq!(trae.name, "Trae");
        assert_eq!(trae.detection_source, AgentDetectionSource::Application);
        assert_eq!(trae.dir, "~/.trae/skills");

        for platform in [AgentPlatform::Windows, AgentPlatform::Other] {
            assert!(!known_agents_for_platform(platform)
                .iter()
                .any(|(key, _, _)| *key == "trae"));
        }
        fs::remove_dir_all(home).expect("remove Trae fixture");
    }

    #[test]
    fn each_platform_assigns_every_skill_root_to_one_agent() {
        // Projection links, conflict checks and uninstall are keyed by Agent
        // but land in the Agent's directory. Two Agents sharing one root
        // would write and remove the same link twice, so a shared root needs
        // directory-level projection before it may enter the matrix.
        for platform in [
            AgentPlatform::Macos,
            AgentPlatform::Windows,
            AgentPlatform::Other,
        ] {
            let agents = known_agents_for_platform(platform);
            let mut roots = std::collections::HashSet::new();
            for (key, _, relative) in agents {
                assert!(
                    roots.insert(relative),
                    "{key} shares {relative} with another Agent on {platform:?}"
                );
            }
        }
    }
}

#[cfg(all(test, windows))]
mod windows_agent_detection_tests {
    use super::{
        detect_agents_with_context, known_agents_for_platform, AgentDetectionSource, AgentPlatform,
        AgentSkillsStatus,
    };
    use std::fs;

    #[test]
    fn native_windows_detects_workbuddy_app_and_never_lists_doubao() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-native-windows-agent-detection-{}",
            uuid::Uuid::new_v4()
        ));
        let local_app_data = home.join("AppData/Local");
        let workbuddy = local_app_data.join("Programs/WorkBuddy/WorkBuddy.exe");
        let doubao = local_app_data.join("DoubaoWork/Application/DoubaoWork.exe");
        let bin = home.join("bin");
        fs::create_dir_all(workbuddy.parent().expect("WorkBuddy parent"))
            .expect("create WorkBuddy directory");
        fs::create_dir_all(doubao.parent().expect("Doubao parent"))
            .expect("create Doubao directory");
        fs::create_dir_all(&bin).expect("create executable directory");
        fs::write(&workbuddy, "test").expect("write WorkBuddy executable");
        fs::write(&doubao, "test").expect("write Doubao executable");
        fs::write(bin.join("workbuddy.exe"), "test").expect("write misleading WorkBuddy CLI");
        fs::write(bin.join("doubao.exe"), "test").expect("write misleading Doubao CLI");
        fs::create_dir_all(home.join(".workbuddy/skills"))
            .expect("create WorkBuddy Skill directory");

        let detected = detect_agents_with_context(
            &home,
            &[bin],
            &[local_app_data],
            &[],
            AgentPlatform::Windows,
        );
        let workbuddy = detected
            .iter()
            .find(|agent| agent.key == "workbuddy")
            .expect("find WorkBuddy capability");
        assert!(workbuddy.detected);
        assert_eq!(
            workbuddy.detection_source,
            AgentDetectionSource::Application
        );
        assert_eq!(workbuddy.skills_status, AgentSkillsStatus::Ready);
        assert_eq!(
            workbuddy.dir,
            format!("{}\\.workbuddy\\skills", home.display())
        );
        assert!(!detected.iter().any(|agent| agent.key == "doubao"));
        assert!(!known_agents_for_platform(AgentPlatform::Windows)
            .iter()
            .any(|(key, _, _)| *key == "doubao"));

        fs::remove_dir_all(home).expect("remove native Windows fixture");
    }
}

#[cfg(all(test, windows))]
mod windows_host_agent_detection_tests {
    use super::{detect_agents, installed_store_packages, store_package_matches};
    use super::{AgentPlatform, AGENT_DEFINITIONS};
    use std::path::Path;

    #[test]
    fn real_host_reports_absolute_skill_directories() {
        let agents = detect_agents();
        assert!(!agents.is_empty());
        for agent in agents {
            assert!(
                Path::new(&agent.dir).is_absolute(),
                "{} must show a real Windows path, got {}",
                agent.key,
                agent.dir
            );
        }
    }

    #[test]
    fn real_registry_only_returns_packages_an_agent_names() {
        let (packages, _) = installed_store_packages();
        for package in packages {
            assert!(package.root.is_absolute());
            assert!(AGENT_DEFINITIONS.iter().any(|agent| agent
                .platform(AgentPlatform::Windows)
                .store_packages
                .iter()
                .any(|marker| store_package_matches(&package.full_name, marker))));
        }
    }
}

// The Windows contract, checked on every CI platform: these fixtures mirror
// what a real Windows 11 host showed, not assumed install locations.
#[cfg(test)]
mod windows_agent_contract_tests {
    use super::{
        detect_agents_with_context, known_agents_for_platform, AgentDetectionSource, AgentInfo,
        AgentPlatform, InstalledStorePackage,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

    const CHATGPT_PACKAGE: &str = "OpenAI.Codex_26.928.2636.0_arm64__2p2nqsd0c76g0";

    fn fixture(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "skillhub-windows-contract-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create fixture");
        root
    }

    fn write_launchable(path: &Path) {
        fs::create_dir_all(path.parent().expect("executable parent"))
            .expect("create executable directory");
        fs::write(path, "test").expect("write executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755))
                .expect("make executable launchable");
        }
    }

    fn store_package(root: &Path, full_name: &str) -> InstalledStorePackage {
        InstalledStorePackage {
            full_name: full_name.to_string(),
            root: root.join("WindowsApps").join(full_name),
        }
    }

    fn agent(detected: &[AgentInfo], key: &str) -> AgentInfo {
        detected
            .iter()
            .find(|agent| agent.key == key)
            .cloned()
            .expect("Agent is listed on Windows")
    }

    #[test]
    fn store_chatgpt_is_application_evidence_without_any_cli() {
        let home = fixture("store-chatgpt");
        let package = store_package(&home, CHATGPT_PACKAGE);
        write_launchable(&package.root.join("app/ChatGPT.exe"));

        let detected =
            detect_agents_with_context(&home, &[], &[], &[package], AgentPlatform::Windows);
        let chatgpt = agent(&detected, "codex");
        assert!(chatgpt.detected);
        assert_eq!(chatgpt.name, "ChatGPT");
        assert_eq!(chatgpt.detection_source, AgentDetectionSource::Application);
        assert_eq!(
            detected.iter().filter(|agent| agent.detected).count(),
            1,
            "a ChatGPT package must not detect any other Agent"
        );
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn store_registration_needs_the_named_package_and_its_executable() {
        let home = fixture("store-negative");
        // Registered, but the application executable is gone.
        let leftover = store_package(&home, CHATGPT_PACKAGE);
        fs::create_dir_all(&leftover.root).expect("create leftover package root");
        // Complete packages that are not the one the Agent names.
        let other_publisher =
            store_package(&home, "OpenAI.Codex_26.928.2636.0_arm64__aaaaaaaaaaaaa");
        let other_name = store_package(&home, "OpenAI.CodexTools_1.0.0.0_arm64__2p2nqsd0c76g0");
        for package in [&other_publisher, &other_name] {
            write_launchable(&package.root.join("app/ChatGPT.exe"));
        }

        let detected = detect_agents_with_context(
            &home,
            &[],
            &[],
            &[leftover, other_publisher, other_name],
            AgentPlatform::Windows,
        );
        let chatgpt = agent(&detected, "codex");
        assert!(!chatgpt.detected);
        assert_eq!(chatgpt.detection_source, AgentDetectionSource::None);
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn standalone_codex_cli_is_cli_evidence_not_an_application() {
        let home = fixture("codex-cli");
        let local_app_data = home.join("AppData/Local");
        let bin = local_app_data.join("Programs/OpenAI/Codex/bin");
        write_launchable(&bin.join("codex.exe"));

        let detected = detect_agents_with_context(
            &home,
            &[bin],
            std::slice::from_ref(&local_app_data),
            &[],
            AgentPlatform::Windows,
        );
        let chatgpt = agent(&detected, "codex");
        assert!(chatgpt.detected);
        assert_eq!(chatgpt.detection_source, AgentDetectionSource::Cli);
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn unverified_windows_install_paths_are_not_application_evidence() {
        let home = fixture("unverified-paths");
        let local_app_data = home.join("AppData/Local");
        for relative in [
            "Programs/Claude Code/Claude Code.exe",
            "Claude Code/Claude Code.exe",
            "Programs/ChatGPT/ChatGPT.exe",
            "ChatGPT/ChatGPT.exe",
            "Programs/Codex/Codex.exe",
            "Codex/Codex.exe",
            "Programs/OpenCode/OpenCode.exe",
            "OpenCode/OpenCode.exe",
            "Programs/OpenClaw/OpenClaw.exe",
            "OpenClaw/OpenClaw.exe",
            "Programs/Gemini/Gemini.exe",
        ] {
            write_launchable(&local_app_data.join(relative));
        }

        let detected = detect_agents_with_context(
            &home,
            &[],
            std::slice::from_ref(&local_app_data),
            &[],
            AgentPlatform::Windows,
        );
        assert!(
            detected.iter().all(|agent| !agent.detected),
            "only host-verified markers may detect an Agent"
        );
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn windows_skill_directory_label_is_the_absolute_path() {
        let home = fixture("absolute-label");
        let detected = detect_agents_with_context(&home, &[], &[], &[], AgentPlatform::Windows);
        let known = known_agents_for_platform(AgentPlatform::Windows);
        assert_eq!(detected.len(), known.len());
        for (key, _, relative) in known {
            assert_eq!(
                agent(&detected, key).dir,
                format!("{}\\{}", home.display(), relative.replace('/', "\\"))
            );
        }

        let macos = detect_agents_with_context(&home, &[], &[], &[], AgentPlatform::Macos);
        assert_eq!(agent(&macos, "codex").dir, "~/.codex/skills");
        fs::remove_dir_all(home).expect("remove fixture");
    }
}

// Windows discovery scenarios from issue #335, checked on every platform
// through injected context. These are fixtures, not real-host evidence.
#[cfg(test)]
mod windows_agent_discovery_scenario_tests {
    use super::windows_agent_discovery::{
        windows_executable_search_dirs, RegistryEnvValue, WindowsEnvironment,
    };
    use super::{
        detect_agents_from_discovery, AgentDetectionSource, AgentDetectionState, AgentDiscovery,
        AgentInfo, AgentPlatform, DetectionIssue, DetectionIssueSource,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

    const WINDOWS_CLI_AGENTS: [&str; 5] = ["claude", "codex", "opencode", "openclaw", "gemini"];

    /// A profile on a non-C drive whose user name has CJK characters and a
    /// space, so no assumption about `C:\Users\Administrator` can pass.
    struct Profile {
        root: PathBuf,
        home: PathBuf,
        local_app_data: PathBuf,
        app_data: PathBuf,
    }

    impl Profile {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "skillhub-windows-scenario-{label}-{}",
                uuid::Uuid::new_v4()
            ));
            let home = root.join("D盘/Users/张 三");
            let local_app_data = home.join("AppData/Local");
            let app_data = home.join("AppData/Roaming");
            fs::create_dir_all(&local_app_data).expect("create LOCALAPPDATA");
            fs::create_dir_all(&app_data).expect("create APPDATA");
            Self {
                root,
                home,
                local_app_data,
                app_data,
            }
        }

        fn process(&self, path: &str) -> Vec<(String, String)> {
            vec![
                ("PATH".to_string(), path.to_string()),
                ("USERPROFILE".to_string(), self.home.display().to_string()),
                (
                    "LOCALAPPDATA".to_string(),
                    self.local_app_data.display().to_string(),
                ),
                ("APPDATA".to_string(), self.app_data.display().to_string()),
            ]
        }

        fn search_dirs(&self, environment: &WindowsEnvironment) -> Vec<PathBuf> {
            windows_executable_search_dirs(&self.home, environment, Vec::new())
        }

        fn detect(&self, discovery: &AgentDiscovery) -> Vec<AgentInfo> {
            detect_agents_from_discovery(&self.home, discovery, AgentPlatform::Windows)
        }
    }

    impl Drop for Profile {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn write_launchable(path: &Path) {
        fs::create_dir_all(path.parent().expect("executable parent"))
            .expect("create executable directory");
        fs::write(path, "test").expect("write executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755))
                .expect("make executable launchable");
        }
    }

    fn agent<'a>(detected: &'a [AgentInfo], key: &str) -> &'a AgentInfo {
        detected
            .iter()
            .find(|agent| agent.key == key)
            .expect("Agent is listed on Windows")
    }

    fn cli_discovery(executable_dirs: Vec<PathBuf>) -> AgentDiscovery {
        AgentDiscovery {
            executable_dirs,
            ..AgentDiscovery::default()
        }
    }

    #[test]
    fn every_windows_cli_agent_is_found_through_npm_cmd_shims() {
        let profile = Profile::new("npm-shims");
        let npm = profile.app_data.join("npm");
        for key in WINDOWS_CLI_AGENTS {
            write_launchable(&npm.join(format!("{key}.cmd")));
        }
        let environment = WindowsEnvironment::new(profile.process(""), [], []);
        let detected = profile.detect(&cli_discovery(profile.search_dirs(&environment)));
        for key in WINDOWS_CLI_AGENTS {
            let agent = agent(&detected, key);
            assert!(agent.detected, "{key} npm shim must be detected");
            assert_eq!(agent.detection_source, AgentDetectionSource::Cli);
            assert_eq!(agent.detection_state, AgentDetectionState::Detected);
            assert!(agent.detection_issues.is_empty());
        }
        assert!(!agent(&detected, "workbuddy").detected);
    }

    #[test]
    fn windows_cli_names_need_a_windows_suffix() {
        // Name case is matched by NTFS itself (see the Windows-only probe
        // test); these fixtures exercise the suffix rule on every host.
        let profile = Profile::new("suffix");
        let bin = profile.home.join(".local/bin");
        write_launchable(&bin.join("claude.exe"));
        write_launchable(&bin.join("gemini.bat"));
        // Unix-style shims and script associations are not Windows commands.
        write_launchable(&bin.join("codex"));
        write_launchable(&bin.join("opencode.ps1"));
        write_launchable(&bin.join("openclaw.js"));
        let detected = profile.detect(&cli_discovery(vec![bin]));
        assert!(agent(&detected, "claude").detected);
        assert!(agent(&detected, "gemini").detected);
        for key in ["codex", "opencode", "openclaw"] {
            let agent = agent(&detected, key);
            assert!(!agent.detected, "{key} must not be detected");
            assert_eq!(agent.detection_state, AgentDetectionState::NotFound);
        }
    }

    #[test]
    fn package_manager_layouts_and_overrides_find_clis_without_process_path() {
        let profile = Profile::new("managers");
        let custom_prefix = profile.root.join("E盘/npm global");
        let pnpm_home = profile.root.join("E盘/pnpm");
        let volta_home = profile.root.join("E盘/volta");
        write_launchable(&custom_prefix.join("claude.cmd"));
        write_launchable(&pnpm_home.join("gemini.cmd"));
        write_launchable(&volta_home.join("bin/opencode.exe"));
        write_launchable(&profile.home.join("scoop/shims/openclaw.exe"));
        write_launchable(
            &profile
                .local_app_data
                .join("Microsoft/WinGet/Links/codex.exe"),
        );
        let mut process = profile.process("");
        process.extend([
            (
                "NPM_CONFIG_PREFIX".to_string(),
                custom_prefix.display().to_string(),
            ),
            ("PNPM_HOME".to_string(), pnpm_home.display().to_string()),
            ("VOLTA_HOME".to_string(), volta_home.display().to_string()),
        ]);
        let environment = WindowsEnvironment::new(process, [], []);
        let detected = profile.detect(&cli_discovery(profile.search_dirs(&environment)));
        for key in WINDOWS_CLI_AGENTS {
            assert!(agent(&detected, key).detected, "{key} must be detected");
        }
    }

    #[test]
    fn redetection_reads_the_registry_path_a_stale_process_never_saw() {
        let profile = Profile::new("stale-path");
        let stale = profile.root.join("stale");
        fs::create_dir_all(&stale).expect("create stale PATH entry");
        let new_tool = profile.root.join("F盘/Tools/claude cli");
        let before = WindowsEnvironment::new(profile.process(&stale.display().to_string()), [], []);
        assert!(
            !agent(
                &profile.detect(&cli_discovery(profile.search_dirs(&before))),
                "claude"
            )
            .detected
        );

        // Installed while SkillHub was running: only the registry knows.
        write_launchable(&new_tool.join("claude.exe"));
        let after = WindowsEnvironment::new(
            profile.process(&stale.display().to_string()),
            [
                (
                    "CLAUDE_TOOLS".to_string(),
                    RegistryEnvValue {
                        value: new_tool.display().to_string(),
                        expand: false,
                    },
                ),
                (
                    "Path".to_string(),
                    RegistryEnvValue {
                        value: "%CLAUDE_TOOLS%;%UNDEFINED_TOOL%\\bin".to_string(),
                        expand: true,
                    },
                ),
            ],
            [],
        );
        let dirs = profile.search_dirs(&after);
        assert_eq!(dirs[0], stale, "process PATH keeps its priority");
        assert!(dirs.contains(&new_tool));
        let claude = agent(&profile.detect(&cli_discovery(dirs)), "claude").clone();
        assert!(claude.detected);
        assert_eq!(claude.detection_source, AgentDetectionSource::Cli);
    }

    #[test]
    fn config_skills_and_shared_directories_alone_are_never_installs() {
        let profile = Profile::new("config-only");
        for (relative, body) in [
            (".claude/settings.json", "{}"),
            (".codex/config.toml", ""),
            (".config/opencode/opencode.json", "{}"),
            (".openclaw/openclaw.json", "{}"),
            (".gemini/settings.json", "{}"),
            // Antigravity shares `~/.gemini`; it is not Gemini CLI.
            (".gemini/antigravity/brain/state.json", "{}"),
            (".workbuddy/settings.json", "{}"),
            (".agents/skills/example/SKILL.md", "# shared"),
        ] {
            let path = profile.home.join(relative);
            fs::create_dir_all(path.parent().expect("config parent")).expect("create config");
            fs::write(path, body).expect("write config");
        }
        for relative in [
            ".claude/skills",
            ".codex/skills",
            ".workbuddy/skills",
            ".config/opencode/skills",
            ".openclaw/skills",
            ".gemini/skills",
        ] {
            fs::create_dir_all(profile.home.join(relative)).expect("create skills directory");
        }
        // Empty npm directory and an empty uninstalled program folder.
        fs::create_dir_all(profile.app_data.join("npm")).expect("create npm dir");
        fs::create_dir_all(profile.local_app_data.join("Programs/WorkBuddy"))
            .expect("create leftover program dir");
        let environment = WindowsEnvironment::new(profile.process(""), [], []);
        let discovery = AgentDiscovery {
            executable_dirs: profile.search_dirs(&environment),
            app_roots: vec![profile.local_app_data.clone()],
            ..AgentDiscovery::default()
        };
        let detected = profile.detect(&discovery);
        assert_eq!(detected.len(), 6);
        for agent in &detected {
            assert!(!agent.detected, "{} must not be detected", agent.key);
            assert_eq!(agent.detection_state, AgentDetectionState::NotFound);
        }
    }

    #[test]
    fn workbuddy_custom_install_location_comes_from_its_registration() {
        let profile = Profile::new("workbuddy-custom");
        let custom = profile.root.join("G盘/Apps/Work Buddy/WorkBuddy.exe");
        write_launchable(&custom);
        let discovery = AgentDiscovery {
            installed_app_candidates: vec![custom],
            ..AgentDiscovery::default()
        };
        let workbuddy = agent(&profile.detect(&discovery), "workbuddy").clone();
        assert!(workbuddy.detected);
        assert_eq!(
            workbuddy.detection_source,
            AgentDetectionSource::Application
        );
    }

    #[test]
    fn uninstall_leftovers_and_other_registered_programs_are_not_workbuddy() {
        let profile = Profile::new("workbuddy-negative");
        // Registration left behind after the program files were removed.
        let leftover = profile.root.join("G盘/Apps/WorkBuddy/WorkBuddy.exe");
        fs::create_dir_all(leftover.parent().expect("leftover parent")).expect("create dir");
        // A real program that is not WorkBuddy, and a directory named like it.
        let other = profile.root.join("G盘/Apps/WorkBuddy/Updater.exe");
        write_launchable(&other);
        let directory = profile.root.join("H盘/WorkBuddy.exe");
        fs::create_dir_all(&directory).expect("create directory named like the exe");
        let discovery = AgentDiscovery {
            installed_app_candidates: vec![leftover, other, directory],
            ..AgentDiscovery::default()
        };
        let detected = profile.detect(&discovery);
        assert!(detected.iter().all(|agent| !agent.detected));
        // No CLI may be detected through a registered desktop executable.
        write_launchable(&profile.root.join("G盘/Apps/Claude/claude.exe"));
        let discovery = AgentDiscovery {
            installed_app_candidates: vec![profile.root.join("G盘/Apps/Claude/claude.exe")],
            ..AgentDiscovery::default()
        };
        assert!(profile
            .detect(&discovery)
            .iter()
            .all(|agent| !agent.detected));
    }

    #[test]
    fn a_failed_source_marks_only_dependent_agents_incomplete() {
        let profile = Profile::new("incomplete");
        let discovery = AgentDiscovery {
            issues: vec![DetectionIssue::new(
                DetectionIssueSource::CliSearch,
                "无法读取注册表 HKCU\\Environment：拒绝访问",
            )],
            ..AgentDiscovery::default()
        };
        let detected = profile.detect(&discovery);
        for key in WINDOWS_CLI_AGENTS {
            let agent = agent(&detected, key);
            assert!(!agent.detected, "incomplete never grants detection");
            assert_eq!(agent.detection_state, AgentDetectionState::Incomplete);
            assert_eq!(agent.detection_issues.len(), 1);
        }
        let workbuddy = agent(&detected, "workbuddy");
        assert_eq!(workbuddy.detection_state, AgentDetectionState::NotFound);
        assert!(workbuddy.detection_issues.is_empty());

        let discovery = AgentDiscovery {
            issues: vec![DetectionIssue::new(
                DetectionIssueSource::InstalledApps,
                "无法读取注册表 HKLM\\Uninstall：拒绝访问",
            )],
            ..AgentDiscovery::default()
        };
        let detected = profile.detect(&discovery);
        assert_eq!(
            agent(&detected, "workbuddy").detection_state,
            AgentDetectionState::Incomplete
        );
        assert_eq!(
            agent(&detected, "claude").detection_state,
            AgentDetectionState::NotFound
        );
    }

    #[test]
    fn a_failed_source_keeps_evidence_found_elsewhere() {
        let profile = Profile::new("partial");
        let bin = profile.home.join(".local/bin");
        write_launchable(&bin.join("codex.exe"));
        let discovery = AgentDiscovery {
            executable_dirs: vec![bin],
            issues: vec![DetectionIssue::new(
                DetectionIssueSource::StorePackages,
                "无法读取当前用户的 Microsoft Store 包注册信息：拒绝访问",
            )],
            ..AgentDiscovery::default()
        };
        let detected = profile.detect(&discovery);
        let chatgpt = agent(&detected, "codex");
        assert!(chatgpt.detected);
        assert_eq!(chatgpt.detection_state, AgentDetectionState::Detected);
        assert_eq!(chatgpt.detection_issues.len(), 1);
        // Store issues only concern the Agent that names a Store package.
        assert!(agent(&detected, "claude").detection_issues.is_empty());
    }

    // Absent PATH entries are simply "not here". Permission-denied candidates are
    // covered by the injected-probe tests, which do not depend on running as root.
    #[test]
    fn missing_path_directories_never_make_cli_agents_incomplete() {
        let profile = Profile::new("missing-path-dirs");
        let detected = profile.detect(&cli_discovery(vec![
            profile.root.join("offline-drive"),
            profile.root.join("removed").join("bin"),
        ]));
        for key in WINDOWS_CLI_AGENTS {
            let agent = agent(&detected, key);
            assert_eq!(agent.detection_state, AgentDetectionState::NotFound);
            assert!(agent.detection_issues.is_empty());
        }
    }

    #[test]
    fn a_non_default_root_override_keeps_evidence_but_blocks_writes() {
        let profile = Profile::new("root-override");
        let npm = profile.app_data.join("npm");
        write_launchable(&npm.join("codex.cmd"));
        write_launchable(&npm.join("claude.cmd"));
        fs::create_dir_all(profile.home.join(".codex/skills")).expect("default root");
        let discovery = AgentDiscovery {
            executable_dirs: vec![npm],
            skill_root_overrides: vec![
                ("CODEX_HOME", r"D:\custom-codex".to_string()),
                // Pointing at the default location is consistent.
                (
                    "CLAUDE_CONFIG_DIR",
                    profile.home.join(".claude").display().to_string(),
                ),
            ],
            ..AgentDiscovery::default()
        };
        let detected = profile.detect(&discovery);
        let chatgpt = agent(&detected, "codex");
        assert!(chatgpt.detected, "install evidence is kept");
        assert_eq!(chatgpt.detection_state, AgentDetectionState::Detected);
        assert_eq!(chatgpt.skills_status, super::AgentSkillsStatus::Unconfirmed);
        assert!(!super::admits_skill_writes(chatgpt));
        assert!(chatgpt.detection_issues[0].contains("Skill 目录未确认：检测到 CODEX_HOME"));
        let claude = agent(&detected, "claude");
        assert!(super::admits_skill_writes(claude));
        assert_eq!(claude.skills_status, super::AgentSkillsStatus::Missing);
        assert!(claude.detection_issues.is_empty());
    }

    #[test]
    fn access_denied_on_a_cli_candidate_makes_only_unfound_agents_incomplete() {
        let profile = Profile::new("denied-probe");
        let denied = profile.root.join("acl-denied");
        let readable = profile.home.join(".local/bin");
        write_launchable(&readable.join("claude.exe"));
        let denied_for_probe = denied.clone();
        let discovery = AgentDiscovery {
            executable_dirs: vec![denied, readable],
            probe: Box::new(move |path: &Path| {
                if path.starts_with(&denied_for_probe) {
                    Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
                } else {
                    super::probe_launchable_file(path)
                }
            }),
            ..AgentDiscovery::default()
        };
        let detected = profile.detect(&discovery);
        let claude = agent(&detected, "claude");
        assert!(claude.detected, "a hit elsewhere keeps the evidence");
        assert_eq!(claude.detection_state, AgentDetectionState::Detected);
        assert_eq!(claude.detection_issues.len(), 1);
        let chatgpt = agent(&detected, "codex");
        assert!(!chatgpt.detected);
        assert_eq!(chatgpt.detection_state, AgentDetectionState::Incomplete);
        assert!(chatgpt.detection_issues[0].contains("codex.exe"));
        // An Agent without a CLI does not inherit CLI probe failures.
        assert_eq!(
            agent(&detected, "workbuddy").detection_state,
            AgentDetectionState::NotFound
        );
    }

    #[test]
    fn missing_cli_candidates_stay_not_found() {
        let profile = Profile::new("missing-probe");
        let detected = profile.detect(&cli_discovery(vec![profile.root.join("nowhere")]));
        for key in WINDOWS_CLI_AGENTS {
            assert_eq!(
                agent(&detected, key).detection_state,
                AgentDetectionState::NotFound
            );
        }
    }

    #[test]
    fn unix_override_roots_compare_exactly() {
        use super::override_names_default_root;
        let default = Path::new("/Users/dev/.codex");
        let macos = AgentPlatform::Macos;
        assert!(override_names_default_root(
            "/Users/dev/.codex",
            default,
            macos
        ));
        assert!(override_names_default_root(
            "/Users/dev/.codex/",
            default,
            macos
        ));
        assert!(override_names_default_root(
            "/Users/dev/./.codex",
            default,
            macos
        ));
        // A case-sensitive volume may hold both; `\\` is a name character.
        assert!(!override_names_default_root(
            "/Users/dev/.CODEX",
            default,
            macos
        ));
        assert!(!override_names_default_root(
            "/Users/dev/x/../.codex",
            default,
            macos
        ));
        assert!(!override_names_default_root("~/.codex", default, macos));
        assert!(!override_names_default_root(
            "/Users\\dev/.codex",
            default,
            macos
        ));
        assert!(override_names_default_root(
            r"c:/users/dev/.CODEX/",
            Path::new(r"C:\Users\dev\.codex"),
            AgentPlatform::Windows
        ));
    }

    #[test]
    fn a_case_different_override_on_macos_is_unconfirmed() {
        let profile = Profile::new("macos-case");
        let bin = profile.root.join("bin");
        write_launchable(&bin.join("codex"));
        let upper = profile.home.join(".CODEX").display().to_string();
        let detected = detect_agents_from_discovery(
            &profile.home,
            &AgentDiscovery {
                executable_dirs: vec![bin],
                skill_root_overrides: vec![("CODEX_HOME", upper)],
                ..AgentDiscovery::default()
            },
            AgentPlatform::Macos,
        );
        let chatgpt = agent(&detected, "codex");
        assert!(chatgpt.detected);
        assert_eq!(chatgpt.skills_status, super::AgentSkillsStatus::Unconfirmed);
        assert!(!super::admits_skill_writes(chatgpt));
    }

    #[test]
    fn agent_info_serializes_detection_state_and_omits_empty_issues() {
        let profile = Profile::new("serialize");
        let detected = profile.detect(&AgentDiscovery {
            issues: vec![DetectionIssue::new(
                DetectionIssueSource::CliSearch,
                "failed",
            )],
            ..AgentDiscovery::default()
        });
        let claude = serde_json::to_value(agent(&detected, "claude")).expect("serialize");
        assert_eq!(claude["detectionState"], "incomplete");
        assert_eq!(claude["detectionIssues"][0], "failed");
        let workbuddy = serde_json::to_value(agent(&detected, "workbuddy")).expect("serialize");
        assert_eq!(workbuddy["detectionState"], "notFound");
        assert!(workbuddy.get("detectionIssues").is_none());

        // Older payloads without the new fields still deserialize.
        let legacy: AgentInfo = serde_json::from_value(serde_json::json!({
            "key": "claude", "name": "Claude Code", "dir": "~/.claude/skills",
            "detected": true, "detectionSource": "cli", "skillsStatus": "ready"
        }))
        .expect("deserialize legacy AgentInfo");
        assert!(legacy.detection_issues.is_empty());
    }
}

#[cfg(test)]
mod agent_detection_cache_tests {
    use super::{cached_agent_detection, store_agent_detection, AgentDetectionCache, AgentInfo};
    use std::cell::Cell;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    fn agents(key: &str) -> Vec<AgentInfo> {
        vec![serde_json::from_value(serde_json::json!({
            "key": key, "name": key, "dir": "~/x", "detected": true,
            "detectionSource": "cli", "skillsStatus": "ready"
        }))
        .expect("agent")]
    }

    const TTL: Duration = Duration::from_secs(30);

    #[test]
    fn poll_reuses_a_recent_pass_and_redetects_after_the_ttl() {
        let cache: AgentDetectionCache = Mutex::new(None);
        let t0 = Instant::now();
        let calls = Cell::new(0);
        let detect = |key: &'static str| {
            let calls = &calls;
            move || {
                calls.set(calls.get() + 1);
                agents(key)
            }
        };
        assert_eq!(
            cached_agent_detection(&cache, t0, TTL, detect("a"))[0].key,
            "a"
        );
        assert_eq!(
            cached_agent_detection(&cache, t0 + Duration::from_secs(29), TTL, detect("b"))[0].key,
            "a",
            "a pass younger than the TTL is reused"
        );
        assert_eq!(calls.get(), 1);
        assert_eq!(
            cached_agent_detection(&cache, t0 + TTL, TTL, detect("c"))[0].key,
            "c",
            "an expired pass is redetected"
        );
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn an_explicit_fresh_detection_replaces_what_the_poll_sees() {
        let cache: AgentDetectionCache = Mutex::new(None);
        let t0 = Instant::now();
        cached_agent_detection(&cache, t0, TTL, || agents("old"));
        // 「重新检测」 / get_installed_agents run a fresh pass and store it.
        store_agent_detection(&cache, t0 + Duration::from_secs(1), &agents("new"));
        let seen = cached_agent_detection(&cache, t0 + Duration::from_secs(2), TTL, || {
            panic!("a fresh pass must be reused")
        });
        assert_eq!(seen[0].key, "new");
    }
}
