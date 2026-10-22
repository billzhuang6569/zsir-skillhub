use crate::cli::{
    CliAccount, CliAccountState, CliCommandOutput, CliErrorCode, EXIT_AUTH, EXIT_CONFLICT,
    EXIT_INTERNAL, EXIT_NETWORK, EXIT_USAGE,
};
use crate::cli_auth::{
    account_verification_failure, auth_guard_failure, verify_account_with_server, CliAuthGuard,
};
fn catalog_origin() -> Result<Url, String> {
    crate::spaces::normalize_base(&crate::official_channel::COMPILED.catalog_origin)
}
use crate::{AcquisitionSource, EnvDepRaw, ImportSkillPackageInput, SkillHubJson, SkillHubProfile};
use base64::Engine as _;
use reqwest::{Client, Response, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest as _, Sha256};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Read as _;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use walkdir::WalkDir;

#[cfg(windows)]
use crate::platform_fs::OpenOptionsExt as _;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as _;

pub(crate) const MARKETPLACE_ACQUIRE_USAGE: &str = concat!(
    "用法：\n",
    "  skillhub marketplace updates --json\n",
    "  skillhub marketplace install <server-skill-id> --preflight --json\n",
    "  skillhub marketplace install <server-skill-id> --apply --plan-digest <digest> --json"
);
pub(crate) const TEAM_ACQUIRE_USAGE: &str = concat!(
    "用法：\n",
    "  skillhub team updates --json\n",
    "  skillhub team install <server-skill-id> --preflight --json\n",
    "  skillhub team install <server-skill-id> --apply --plan-digest <digest> --json"
);

const MARKETPLACE_INSTALL_COMMAND: &str = "marketplace install";
const TEAM_INSTALL_COMMAND: &str = "team install";
const MARKETPLACE_UPDATES_COMMAND: &str = "marketplace updates";
const TEAM_UPDATES_COMMAND: &str = "team updates";
const MAX_METADATA_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_PROFILE_BYTES: u64 = 1024 * 1024;
const MAX_MANAGED_ENTRIES: usize = 10_000;
const MAX_UPDATE_CANDIDATES: usize = 200;
const MAX_SKILL_TREE_DEPTH: usize = 10;
const MAX_SKILL_FILE_COUNT: usize = 2_000;
const MAX_SKILL_TREE_ENTRIES: usize = 4_000;
const MAX_SKILL_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES: u64 = 100 * 1024 * 1024;
const PLAN_SCHEMA_VERSION: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum AcquireSource {
    Marketplace,
    Team,
}

impl AcquireSource {
    fn command(self) -> &'static str {
        match self {
            Self::Marketplace => MARKETPLACE_INSTALL_COMMAND,
            Self::Team => TEAM_INSTALL_COMMAND,
        }
    }

    fn acquisition_source(self) -> AcquisitionSource {
        match self {
            Self::Marketplace => AcquisitionSource::Marketplace,
            Self::Team => AcquisitionSource::Team,
        }
    }

    fn metadata_path(self, skill_id: &str) -> String {
        match self {
            Self::Marketplace => format!("marketplace/{skill_id}"),
            Self::Team => format!("skills/{skill_id}"),
        }
    }

    fn package_path(self, skill_id: &str) -> String {
        match self {
            Self::Marketplace => format!("marketplace/{skill_id}/package"),
            Self::Team => format!("skills/{skill_id}/package"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum AcquireMode {
    Preflight,
    Apply { plan_digest: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AcquireArgs {
    source: AcquireSource,
    server_skill_id: String,
    mode: AcquireMode,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteEnvDependency {
    key: String,
    #[serde(default)]
    description: Option<String>,
    required: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketplaceAuthor {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteVersion {
    id: String,
    version: String,
    #[serde(default)]
    package_sha256: Option<String>,
    #[serde(default)]
    package_size: Option<u64>,
    created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketplaceDetail {
    id: String,
    name: String,
    display_name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    source_url: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    trigger_scenarios: Vec<String>,
    #[serde(default)]
    compatible_agents: Vec<String>,
    #[serde(default)]
    env_dependencies: Vec<RemoteEnvDependency>,
    current_version: String,
    author: MarketplaceAuthor,
    version: RemoteVersion,
    download_count: u64,
    published_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamShare {
    team_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamSkillDetail {
    id: String,
    name: String,
    display_name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    source_url: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    trigger_scenarios: Vec<String>,
    #[serde(default)]
    compatible_agents: Vec<String>,
    #[serde(default)]
    env_dependencies: Vec<RemoteEnvDependency>,
    author_id: String,
    current_version: String,
    install_count: u64,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    versions: Option<Vec<RemoteVersion>>,
    #[serde(default)]
    team_shares: Option<Vec<TeamShare>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSkill {
    source: AcquireSource,
    server_skill_id: String,
    remote_version_id: String,
    name: String,
    display_name: String,
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_url: Option<String>,
    category: Option<String>,
    labels: Vec<String>,
    trigger_scenarios: Vec<String>,
    compatible_agents: Vec<String>,
    env_dependencies: Vec<RemoteEnvDependency>,
    version: String,
    package_sha256: String,
    package_size: u64,
    server_owner_id: String,
    team_ids: Vec<String>,
    created_at: String,
    updated_at: String,
    // Download/install counters are mutable telemetry and therefore must not
    // invalidate an otherwise identical fixed-package preflight plan.
    #[serde(skip)]
    install_count: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum AcquireAction {
    Import,
    AlreadyPresent,
    ReplaceMarketplaceSource,
    ReplaceTeamSource,
    BlockedManagedIdCollision,
    BlockedSourceMismatch,
    BlockedAccountMismatch,
    BlockedMarketplaceLocalChanges,
}

impl AcquireAction {
    fn can_apply(&self) -> bool {
        matches!(
            self,
            Self::Import
                | Self::AlreadyPresent
                | Self::ReplaceMarketplaceSource
                | Self::ReplaceTeamSource
        )
    }

    fn replaces_existing_source(&self) -> bool {
        matches!(
            self,
            Self::ReplaceMarketplaceSource | Self::ReplaceTeamSource
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalPlanState {
    state: String,
    local_skill_id: String,
    profile_id: Option<String>,
    server_skill_id: Option<String>,
    server_owner_id: Option<String>,
    acquisition_source: Option<AcquisitionSource>,
    version: Option<String>,
    package_sha256: Option<String>,
    team_ids: Option<Vec<String>>,
    acquired_by_user_id: Option<String>,
    profile_sha256: Option<String>,
    content_sha256: Option<String>,
    git_head: Option<String>,
    working_copy_dirty: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcquirePlan {
    schema_version: u8,
    source: AcquireSource,
    account_user_id: Option<String>,
    remote: RemoteSkill,
    local: LocalPlanState,
    action: AcquireAction,
}

impl AcquirePlan {
    fn digest(&self) -> Result<String, ()> {
        serde_json::to_vec(self)
            .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
            .map_err(|_| ())
    }
}

struct ProfileSnapshot {
    profile: SkillHubProfile,
    profile_sha256: String,
}

struct ExistingAsset {
    local_skill_id: String,
    profile: SkillHubProfile,
    profile_sha256: String,
    content_sha256: String,
    git_head: Option<String>,
    working_copy_dirty: bool,
}

#[derive(Clone, Debug)]
struct UpdateCandidate {
    local_skill_id: String,
    server_skill_id: String,
    display_name: String,
    version: String,
    package_sha256: Option<String>,
    server_owner_id: Option<String>,
    team_ids: Option<Vec<String>>,
    acquired_by_user_id: Option<String>,
    account_matches: bool,
    team_metadata_sha256: Option<String>,
    working_copy_dirty: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateItem {
    local_skill_id: String,
    server_skill_id: String,
    display_name: String,
    current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_package_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_package_sha256: Option<String>,
    status: &'static str,
    local_modified: bool,
    can_update: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    preflight_command: Option<String>,
}

struct HttpResponse {
    status: StatusCode,
    headers: reqwest::header::HeaderMap,
    body: Vec<u8>,
}

enum ResponseReadError {
    Offline,
    TooLarge,
    EndpointChanged,
}

fn parse_args(args: &[String]) -> Result<AcquireArgs, ()> {
    let source = match args.first().map(String::as_str) {
        Some("marketplace") => AcquireSource::Marketplace,
        Some("team") => AcquireSource::Team,
        _ => return Err(()),
    };
    if args.get(1).map(String::as_str) != Some("install") {
        return Err(());
    }
    let server_skill_id = args.get(2).ok_or(())?;
    let server_skill_id = uuid::Uuid::parse_str(server_skill_id)
        .map(|value| value.to_string())
        .map_err(|_| ())?;

    let mut preflight = false;
    let mut apply = false;
    let mut plan_digest = None;
    let mut json_requested = false;
    let mut index = 3;
    while index < args.len() {
        match args[index].as_str() {
            "--preflight" if !preflight => {
                preflight = true;
                index += 1;
            }
            "--apply" if !apply => {
                apply = true;
                index += 1;
            }
            "--plan-digest" if plan_digest.is_none() => {
                let value = args.get(index + 1).ok_or(())?;
                plan_digest = Some(parse_digest(value).ok_or(())?);
                index += 2;
            }
            "--json" if !json_requested => {
                json_requested = true;
                index += 1;
            }
            _ => return Err(()),
        }
    }
    if !json_requested || preflight == apply {
        return Err(());
    }
    let mode = if preflight {
        if plan_digest.is_some() {
            return Err(());
        }
        AcquireMode::Preflight
    } else {
        AcquireMode::Apply {
            plan_digest: plan_digest.ok_or(())?,
        }
    };
    Ok(AcquireArgs {
        source,
        server_skill_id,
        mode,
    })
}

fn parse_digest(value: &str) -> Option<String> {
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

fn public_account() -> CliAccount {
    match CliAuthGuard::capture() {
        Ok(guard) if guard.token_for_request().is_ok() => {
            CliAccount::local(CliAccountState::Unverified, guard.user_id())
        }
        Ok(_) => CliAccount::state(CliAccountState::Guest),
        Err(_) => CliAccount::state(CliAccountState::Unknown),
    }
}

fn updates_command(source: AcquireSource) -> &'static str {
    match source {
        AcquireSource::Marketplace => MARKETPLACE_UPDATES_COMMAND,
        AcquireSource::Team => TEAM_UPDATES_COMMAND,
    }
}

fn updates_usage_failure(source: AcquireSource) -> CliCommandOutput {
    let usage = match source {
        AcquireSource::Marketplace => MARKETPLACE_ACQUIRE_USAGE,
        AcquireSource::Team => TEAM_ACQUIRE_USAGE,
    };
    CliCommandOutput::failure(
        updates_command(source),
        public_account(),
        CliErrorCode::ValidationFailed,
        usage,
        EXIT_USAGE,
        Vec::new(),
    )
}

fn usage_failure(source: AcquireSource) -> CliCommandOutput {
    let usage = match source {
        AcquireSource::Marketplace => MARKETPLACE_ACQUIRE_USAGE,
        AcquireSource::Team => TEAM_ACQUIRE_USAGE,
    };
    CliCommandOutput::failure(
        source.command(),
        public_account(),
        CliErrorCode::ValidationFailed,
        usage,
        EXIT_USAGE,
        Vec::new(),
    )
}

fn acquire_client(guard: Option<&CliAuthGuard>) -> Result<Client, String> {
    let origin = match guard {
        Some(guard) => guard.origin()?,
        None => catalog_origin()?,
    };
    crate::net::client_builder(&origin)?
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(60))
        .user_agent(concat!(
            "Yitan-SkillHub/",
            env!("CARGO_PKG_VERSION"),
            " cli-acquire"
        ))
        .build()
        .map_err(|_| "无法初始化 SkillHub Server 连接".to_string())
}

fn api_url(guard: Option<&CliAuthGuard>, path: &str) -> Result<Url, String> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains(['?', '#', '\\'])
        || path
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
        || path.chars().any(char::is_control)
    {
        return Err("SkillHub API 路径无效".into());
    }
    let mut url = match guard {
        Some(guard) => guard.origin()?,
        None => catalog_origin()?,
    };
    let base = url.path().trim_end_matches('/');
    url.set_path(&format!("{base}/api/{path}"));
    Ok(url)
}

async fn bounded_get(
    client: &Client,
    url: Url,
    auth_token: Option<&str>,
    max_bytes: usize,
) -> Result<HttpResponse, ResponseReadError> {
    let mut request = client
        .get(url.clone())
        .header(reqwest::header::CACHE_CONTROL, "no-store");
    if let Some(token) = auth_token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|_| ResponseReadError::Offline)?;
    if response.url() != &url {
        return Err(ResponseReadError::EndpointChanged);
    }
    read_bounded_response(response, max_bytes).await
}

async fn read_bounded_response(
    mut response: Response,
    max_bytes: usize,
) -> Result<HttpResponse, ResponseReadError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(ResponseReadError::TooLarge);
    }
    let status = response.status();
    let headers = response.headers().clone();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ResponseReadError::Offline)?
    {
        if body
            .len()
            .checked_add(chunk.len())
            .is_none_or(|length| length > max_bytes)
        {
            return Err(ResponseReadError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

fn valid_text(value: &str, max_chars: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.trim().is_empty())
        && value.chars().count() <= max_chars
        && !value.chars().any(char::is_control)
}

fn valid_multiline_text(value: &str, max_chars: usize) -> bool {
    value.chars().count() <= max_chars
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

fn valid_optional_text(value: Option<&str>, max_chars: usize) -> bool {
    value.is_none_or(|text| valid_multiline_text(text, max_chars))
}

fn valid_text_list(values: &[String], max_items: usize, max_chars: usize) -> bool {
    values.len() <= max_items
        && values
            .iter()
            .all(|value| valid_text(value, max_chars, false))
}

fn valid_portable_skill_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && value != "."
        && value != ".."
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn normalized_uuid(value: &str) -> Option<String> {
    uuid::Uuid::parse_str(value)
        .ok()
        .map(|value| value.to_string())
}

fn normalized_sha256(value: &str) -> Option<String> {
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

fn valid_env_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 100
        && bytes[0].is_ascii_uppercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn valid_env_dependencies(values: &[RemoteEnvDependency]) -> bool {
    if values.len() > 100 {
        return false;
    }
    let mut keys = HashSet::new();
    values.iter().all(|value| {
        valid_env_key(&value.key)
            && value.description.as_deref().is_none_or(|description| {
                description.trim() == description && valid_text(description, 200, true)
            })
            && keys.insert(value.key.clone())
    })
}

fn validate_remote_common(remote: &RemoteSkill, expected_id: &str) -> bool {
    normalized_uuid(&remote.server_skill_id).as_deref() == Some(expected_id)
        && normalized_uuid(&remote.remote_version_id).is_some()
        && valid_portable_skill_id(&remote.name)
        && valid_text(&remote.display_name, 256, false)
        && valid_optional_text(remote.description.as_deref(), 20_000)
        && valid_optional_text(remote.category.as_deref(), 256)
        && valid_text_list(&remote.labels, 64, 256)
        && valid_text_list(&remote.trigger_scenarios, 128, 2_000)
        && valid_text_list(&remote.compatible_agents, 32, 128)
        && valid_env_dependencies(&remote.env_dependencies)
        && valid_text(&remote.version, 80, false)
        && normalized_sha256(&remote.package_sha256).as_deref()
            == Some(remote.package_sha256.as_str())
        && remote.package_size > 0
        && remote.package_size <= MAX_PACKAGE_BYTES as u64
        && normalized_uuid(&remote.server_owner_id).is_some()
        && remote.team_ids.len() <= 1_000
        && remote
            .team_ids
            .iter()
            .all(|team_id| normalized_uuid(team_id).as_deref() == Some(team_id.as_str()))
        && valid_text(&remote.created_at, 80, false)
        && valid_text(&remote.updated_at, 80, false)
}

fn parse_marketplace_metadata(body: &[u8], expected_id: &str) -> Result<RemoteSkill, ()> {
    let detail = serde_json::from_slice::<MarketplaceDetail>(body).map_err(|_| ())?;
    let server_skill_id = normalized_uuid(&detail.id).ok_or(())?;
    let remote_version_id = normalized_uuid(&detail.version.id).ok_or(())?;
    let server_owner_id = normalized_uuid(&detail.author.id).ok_or(())?;
    let package_sha256 = detail
        .version
        .package_sha256
        .as_deref()
        .and_then(normalized_sha256)
        .ok_or(())?;
    let package_size = detail.version.package_size.ok_or(())?;
    if detail.current_version != detail.version.version {
        return Err(());
    }
    let install_count = u32::try_from(detail.download_count).map_err(|_| ())?;
    let remote = RemoteSkill {
        source: AcquireSource::Marketplace,
        server_skill_id,
        remote_version_id,
        name: detail.name,
        display_name: detail.display_name,
        description: detail.description,
        source_url: crate::sanitize_source_url(detail.source_url.as_deref()),
        category: detail.category,
        labels: detail.labels,
        trigger_scenarios: detail.trigger_scenarios,
        compatible_agents: detail.compatible_agents,
        env_dependencies: detail.env_dependencies,
        version: detail.version.version,
        package_sha256,
        package_size,
        server_owner_id,
        team_ids: Vec::new(),
        created_at: detail.version.created_at,
        updated_at: detail.published_at,
        install_count,
    };
    validate_remote_common(&remote, expected_id)
        .then_some(remote)
        .ok_or(())
}

fn parse_team_metadata(body: &[u8], expected_id: &str) -> Result<RemoteSkill, ()> {
    let detail = serde_json::from_slice::<TeamSkillDetail>(body).map_err(|_| ())?;
    let server_skill_id = normalized_uuid(&detail.id).ok_or(())?;
    let server_owner_id = normalized_uuid(&detail.author_id).ok_or(())?;
    let versions = detail.versions.ok_or(())?;
    if versions.len() > 1_000 {
        return Err(());
    }
    let mut matching = versions
        .into_iter()
        .filter(|version| version.version == detail.current_version);
    let version = matching.next().ok_or(())?;
    if matching.next().is_some() {
        return Err(());
    }
    let remote_version_id = normalized_uuid(&version.id).ok_or(())?;
    let package_sha256 = version
        .package_sha256
        .as_deref()
        .and_then(normalized_sha256)
        .ok_or(())?;
    let package_size = version.package_size.ok_or(())?;
    let team_shares = detail.team_shares.ok_or(())?;
    if team_shares.len() > 1_000 {
        return Err(());
    }
    let mut team_ids = team_shares
        .into_iter()
        .map(|share| normalized_uuid(&share.team_id).ok_or(()))
        .collect::<Result<Vec<_>, _>>()?;
    team_ids.sort();
    team_ids.dedup();
    // `team install` must be backed by a currently visible Team share. An
    // owned but unshared server asset belongs to a different command family.
    if team_ids.is_empty() {
        return Err(());
    }
    let install_count = u32::try_from(detail.install_count).map_err(|_| ())?;
    let remote = RemoteSkill {
        source: AcquireSource::Team,
        server_skill_id,
        remote_version_id,
        name: detail.name,
        display_name: detail.display_name,
        description: detail.description,
        source_url: crate::sanitize_source_url(detail.source_url.as_deref()),
        category: detail.category,
        labels: detail.labels,
        trigger_scenarios: detail.trigger_scenarios,
        compatible_agents: detail.compatible_agents,
        env_dependencies: detail.env_dependencies,
        version: detail.current_version,
        package_sha256,
        package_size,
        server_owner_id,
        team_ids,
        created_at: detail.created_at,
        updated_at: detail.updated_at,
        install_count,
    };
    validate_remote_common(&remote, expected_id)
        .then_some(remote)
        .ok_or(())
}

fn remote_managed_skill_id(name: &str, server_id: &str) -> Result<String, ()> {
    scoped_remote_managed_skill_id(name, server_id, "official")
}

fn scoped_remote_managed_skill_id(
    name: &str,
    server_id: &str,
    space_id: &str,
) -> Result<String, ()> {
    if !valid_portable_skill_id(name)
        || space_id.is_empty()
        || space_id.len() > 80
        || !space_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(());
    }
    let server_id = normalized_uuid(server_id)
        .filter(|normalized| {
            normalized.eq_ignore_ascii_case(server_id)
                && (b'1'..=b'8').contains(&normalized.as_bytes()[14])
                && matches!(normalized.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
        })
        .ok_or(())?;
    let mut suffix = server_id
        .bytes()
        .filter(|byte| *byte != b'-')
        .take(12)
        .map(char::from)
        .collect::<String>()
        .to_ascii_lowercase();
    if space_id != "official" {
        suffix.push('-');
        if let Some(hash) = space_id.strip_prefix("selfhost-").filter(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            suffix.push('s');
            suffix.push_str(&hash[..12]);
        } else {
            suffix.push_str(space_id);
        }
    }
    let max_name_length = 128_usize
        .checked_sub(suffix.len())
        .and_then(|value| value.checked_sub(2))
        .ok_or(())?;
    let mut base = name.chars().take(max_name_length).collect::<String>();
    while base.ends_with(['.', '_', '-']) {
        base.pop();
    }
    if base.is_empty() {
        return Err(());
    }
    let managed_id = format!("{base}--{suffix}");
    valid_portable_skill_id(&managed_id)
        .then_some(managed_id)
        .ok_or(())
}

fn open_regular_file(path: &Path) -> Result<fs::File, ()> {
    let mut options = OpenOptions::new();
    options.read(true);
    options.custom_flags(crate::platform_fs::NOFOLLOW_FLAG);
    let file = options.open(path).map_err(|_| ())?;
    let metadata = file.metadata().map_err(|_| ())?;
    if !metadata.is_file() {
        return Err(());
    }
    Ok(file)
}

fn read_profile_snapshot(root: &Path) -> Result<Option<ProfileSnapshot>, ()> {
    let path = root.join(".skillhub.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_PROFILE_BYTES
    {
        return Err(());
    }
    let mut file = open_regular_file(&path)?;
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    file.by_ref()
        .take(MAX_PROFILE_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > MAX_PROFILE_BYTES {
        return Err(());
    }
    let json = serde_json::from_slice::<SkillHubJson>(&bytes).map_err(|_| ())?;
    let profile = json.skillhub.ok_or(())?;
    if !crate::spaces::current_profile_matches(&profile).map_err(|_| ())? {
        return Ok(None);
    }
    Ok(Some(ProfileSnapshot {
        profile,
        profile_sha256: format!("{:x}", Sha256::digest(&bytes)),
    }))
}

fn is_generated_path(relative: &Path) -> bool {
    relative.components().any(|component| {
        let Component::Normal(name) = component else {
            return false;
        };
        matches!(
            name.to_string_lossy().to_ascii_lowercase().as_str(),
            ".git" | "node_modules" | "target" | "dist" | "build" | "__pycache__" | ".ds_store"
        )
    })
}

fn is_local_env_value_path(relative: &Path) -> bool {
    let Some(name) = relative.file_name().and_then(|name| name.to_str()) else {
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

struct FingerprintEntry {
    normalized: String,
    path: PathBuf,
    is_directory: bool,
    size: u64,
}

fn normalized_relative_path(relative: &Path) -> Result<String, ()> {
    let parts = relative
        .components()
        .map(|component| match component {
            Component::Normal(value) => value
                .to_str()
                .filter(|part| {
                    !part.is_empty()
                        && *part != "."
                        && *part != ".."
                        && !part.contains(['/', '\\'])
                        && !part.chars().any(char::is_control)
                })
                .map(str::to_string)
                .ok_or(()),
            _ => Err(()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if parts.is_empty() || parts.len() > MAX_SKILL_TREE_DEPTH {
        return Err(());
    }
    Ok(parts.join("/"))
}

fn skill_content_fingerprint(root: &Path) -> Result<String, ()> {
    let root_metadata = fs::symlink_metadata(root).map_err(|_| ())?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(());
    }
    let mut entries = Vec::new();
    let mut file_count = 0_usize;
    let mut total_bytes = 0_u64;
    for entry in WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry
                .path()
                .strip_prefix(root)
                .map_or(true, |relative| !is_generated_path(relative))
        })
    {
        let entry = entry.map_err(|_| ())?;
        let relative = entry.path().strip_prefix(root).map_err(|_| ())?;
        if relative == Path::new(".skillhub.json") || is_local_env_value_path(relative) {
            continue;
        }
        let file_type = entry.file_type();
        if file_type.is_symlink() || (!file_type.is_dir() && !file_type.is_file()) {
            return Err(());
        }
        let normalized = normalized_relative_path(relative)?;
        let size = if file_type.is_file() {
            file_count = file_count.checked_add(1).ok_or(())?;
            if file_count > MAX_SKILL_FILE_COUNT {
                return Err(());
            }
            let size = entry.metadata().map_err(|_| ())?.len();
            if size > MAX_SKILL_FILE_BYTES {
                return Err(());
            }
            total_bytes = total_bytes.checked_add(size).ok_or(())?;
            if total_bytes > MAX_SKILL_TOTAL_BYTES {
                return Err(());
            }
            size
        } else {
            0
        };
        if entries.len() >= MAX_SKILL_TREE_ENTRIES {
            return Err(());
        }
        entries.push(FingerprintEntry {
            normalized,
            path: entry.path().to_path_buf(),
            is_directory: file_type.is_dir(),
            size,
        });
    }
    entries.sort_by(|left, right| left.normalized.cmp(&right.normalized));
    if entries
        .windows(2)
        .any(|pair| pair[0].normalized == pair[1].normalized)
    {
        return Err(());
    }
    let mut digest = Sha256::new();
    for entry in entries {
        digest.update(if entry.is_directory { *b"d" } else { *b"f" });
        digest.update((entry.normalized.len() as u64).to_be_bytes());
        digest.update(entry.normalized.as_bytes());
        if !entry.is_directory {
            digest.update(entry.size.to_be_bytes());
            let mut file = open_regular_file(&entry.path)?;
            let mut observed = 0_u64;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let count = file.read(&mut buffer).map_err(|_| ())?;
                if count == 0 {
                    break;
                }
                observed = observed.checked_add(count as u64).ok_or(())?;
                if observed > entry.size {
                    return Err(());
                }
                digest.update(&buffer[..count]);
            }
            if observed != entry.size {
                return Err(());
            }
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn git_state(root: &Path) -> (Option<String>, bool) {
    let Ok(repository) = git2::Repository::open(root) else {
        return (None, true);
    };
    let head = repository
        .head()
        .and_then(|head| head.peel_to_commit())
        .map(|commit| commit.id().to_string())
        .ok();
    let mut options = git2::StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let dirty = match repository.statuses(Some(&mut options)) {
        Ok(statuses) => statuses.iter().any(|entry| {
            entry.path().map_or(true, |path| {
                let relative = Path::new(path);
                relative != Path::new(".skillhub.json") && !is_generated_path(relative)
            })
        }),
        Err(_) => true,
    };
    (head, dirty)
}

fn profile_package_sha256(profile: &SkillHubProfile) -> Option<String> {
    profile
        .acquisition_package_sha256
        .as_deref()
        .and_then(normalized_sha256)
        .or_else(|| {
            profile
                .upstream
                .as_ref()
                .and_then(|upstream| upstream.package_sha256.as_deref())
                .and_then(normalized_sha256)
        })
}

fn profile_source(profile: &SkillHubProfile) -> Option<AcquisitionSource> {
    profile
        .acquisition_source
        .or_else(|| profile.upstream.as_ref().map(|upstream| upstream.source))
}

fn normalized_profile_team_ids(profile: &SkillHubProfile) -> Option<Vec<String>> {
    if profile.team_ids.len().saturating_add(profile.teams.len()) > 2_000 {
        return None;
    }
    let mut team_ids = profile
        .team_ids
        .iter()
        .chain(profile.teams.iter())
        .map(|team_id| normalized_uuid(team_id).ok_or(()))
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    team_ids.sort();
    team_ids.dedup();
    Some(team_ids)
}

fn normalized_profile_acquired_by(profile: &SkillHubProfile) -> Option<String> {
    profile
        .acquired_by_user_id
        .as_deref()
        .and_then(normalized_uuid)
}

fn team_profile_metadata_sha256(profile: &SkillHubProfile) -> Option<String> {
    let server_owner_id = profile
        .server_owner_id
        .as_deref()
        .and_then(normalized_uuid)?;
    let team_ids = normalized_profile_team_ids(profile)?;
    let acquired_by_user_id = normalized_profile_acquired_by(profile)?;
    let name = profile.name.as_ref()?;
    let display_name = profile.display_name.as_ref()?;
    let is_own = profile.is_own?;
    let env_dependencies = profile
        .env_dependencies
        .iter()
        .map(|dependency| {
            json!({
                "key": dependency.key,
                "description": dependency.description,
                "required": dependency.required,
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_vec(&json!({
        "serverOwnerId": server_owner_id,
        "teamIds": team_ids,
        "acquiredByUserId": acquired_by_user_id,
        "isOwn": is_own,
        "name": name,
        "displayName": display_name,
        "description": profile.description,
        "category": profile.category,
        "labels": profile.labels,
        "triggerScenarios": profile.trigger_scenarios,
        "compatibleAgents": profile.compatible_agents,
        "envDependencies": env_dependencies,
    }))
    .ok()
    .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
}

fn team_remote_metadata_sha256(remote: &RemoteSkill, account_user_id: &str) -> Option<String> {
    if remote.source != AcquireSource::Team {
        return None;
    }
    let account_user_id = normalized_uuid(account_user_id)?;
    let env_dependencies = remote
        .env_dependencies
        .iter()
        .map(|dependency| {
            json!({
                "key": dependency.key,
                "description": dependency.description,
                "required": dependency.required,
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_vec(&json!({
        "serverOwnerId": remote.server_owner_id,
        "teamIds": remote.team_ids,
        "acquiredByUserId": account_user_id,
        "isOwn": account_user_id == remote.server_owner_id,
        "name": remote.name,
        "displayName": remote.display_name,
        "description": remote.description,
        "category": remote.category,
        "labels": remote.labels,
        "triggerScenarios": remote.trigger_scenarios,
        "compatibleAgents": remote.compatible_agents,
        "envDependencies": env_dependencies,
    }))
    .ok()
    .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
}

fn update_candidates(
    source: AcquireSource,
    account_user_id: Option<&str>,
) -> Result<Vec<UpdateCandidate>, ()> {
    let account_user_id = match source {
        AcquireSource::Marketplace if account_user_id.is_none() => None,
        AcquireSource::Team => Some(normalized_uuid(account_user_id.ok_or(())?).ok_or(())?),
        AcquireSource::Marketplace => return Err(()),
    };
    let managed_root = crate::skills_dir();
    let metadata = match fs::symlink_metadata(&managed_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(());
    }
    let expected_source = source.acquisition_source();
    let session = crate::runtime_env::runtime_session_snapshot().map_err(|_| ())?;
    let mut candidates = Vec::new();
    for (index, entry) in fs::read_dir(&managed_root).map_err(|_| ())?.enumerate() {
        if index >= MAX_MANAGED_ENTRIES {
            return Err(());
        }
        let entry = entry.map_err(|_| ())?;
        let Some(local_skill_id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !valid_portable_skill_id(&local_skill_id) {
            continue;
        }
        let entry_metadata = fs::symlink_metadata(entry.path()).map_err(|_| ())?;
        if entry_metadata.file_type().is_symlink() || !entry_metadata.is_dir() {
            continue;
        }
        let Some(snapshot) = read_profile_snapshot(&entry.path())? else {
            continue;
        };
        let profile = snapshot.profile;
        if !crate::spaces::current_profile_matches(&profile).map_err(|_| ())?
            || !matches_remote_namespace(
                source,
                session.space_id(),
                profile.catalog_origin.as_deref(),
            )
        {
            continue;
        }
        if profile.is_system || profile_source(&profile) != Some(expected_source) {
            continue;
        }
        if candidates.len() >= MAX_UPDATE_CANDIDATES {
            return Err(());
        }
        let server_skill_id = profile
            .server_id
            .as_deref()
            .and_then(normalized_uuid)
            .ok_or(())?;
        let package_sha256 = profile_package_sha256(&profile);
        let server_owner_id = profile.server_owner_id.as_deref().and_then(normalized_uuid);
        let team_ids = normalized_profile_team_ids(&profile);
        let acquired_by_user_id = normalized_profile_acquired_by(&profile);
        let account_matches = source == AcquireSource::Marketplace
            || acquired_by_user_id.as_deref() == account_user_id.as_deref();
        let team_metadata_sha256 = (source == AcquireSource::Team)
            .then(|| team_profile_metadata_sha256(&profile))
            .flatten();
        let display_name = profile
            .display_name
            .as_deref()
            .filter(|value| valid_text(value, 256, false))
            .unwrap_or(&local_skill_id)
            .to_string();
        let (_, working_copy_dirty) = git_state(&entry.path());
        candidates.push(UpdateCandidate {
            local_skill_id,
            server_skill_id,
            display_name,
            version: profile.acquisition_version.unwrap_or(profile.version),
            package_sha256,
            server_owner_id,
            team_ids,
            acquired_by_user_id,
            account_matches,
            team_metadata_sha256,
            working_copy_dirty,
        });
    }
    candidates.sort_by(|left, right| left.local_skill_id.cmp(&right.local_skill_id));
    Ok(candidates)
}

fn unavailable_update_item(candidate: UpdateCandidate, status: &'static str) -> UpdateItem {
    UpdateItem {
        local_skill_id: candidate.local_skill_id,
        server_skill_id: candidate.server_skill_id,
        display_name: candidate.display_name,
        current_version: candidate.version,
        latest_version: None,
        current_package_sha256: candidate.package_sha256,
        latest_package_sha256: None,
        status,
        local_modified: candidate.working_copy_dirty,
        can_update: false,
        preflight_command: None,
    }
}

fn compared_update_item(candidate: UpdateCandidate, remote: RemoteSkill) -> UpdateItem {
    let local_metadata_complete = candidate.package_sha256.is_some()
        && (remote.source != AcquireSource::Team || candidate.team_metadata_sha256.is_some());
    let source_metadata_matches = candidate.server_owner_id.as_deref()
        == Some(remote.server_owner_id.as_str())
        && match remote.source {
            AcquireSource::Marketplace => true,
            AcquireSource::Team => {
                candidate.team_ids.as_deref() == Some(remote.team_ids.as_slice())
                    && candidate.acquired_by_user_id.is_some()
                    && candidate.account_matches
                    && candidate.team_metadata_sha256.as_deref()
                        == candidate
                            .acquired_by_user_id
                            .as_deref()
                            .and_then(|account_user_id| {
                                team_remote_metadata_sha256(&remote, account_user_id)
                            })
                            .as_deref()
            }
        };
    let same_fixed_package = candidate.version == remote.version
        && candidate.package_sha256.as_deref() == Some(remote.package_sha256.as_str())
        && source_metadata_matches;
    let status = if !candidate.account_matches {
        "account_mismatch"
    } else if candidate.working_copy_dirty {
        "local_modified"
    } else if !local_metadata_complete {
        "local_metadata_incomplete"
    } else if same_fixed_package {
        "up_to_date"
    } else {
        "update_available"
    };
    let can_update = status == "update_available";
    let source_label = match remote.source {
        AcquireSource::Marketplace => "marketplace",
        AcquireSource::Team => "team",
    };
    UpdateItem {
        local_skill_id: candidate.local_skill_id,
        server_skill_id: candidate.server_skill_id,
        display_name: candidate.display_name,
        current_version: candidate.version,
        latest_version: Some(remote.version),
        current_package_sha256: candidate.package_sha256,
        latest_package_sha256: Some(remote.package_sha256),
        status,
        local_modified: candidate.working_copy_dirty,
        can_update,
        preflight_command: can_update.then(|| {
            format!(
                "skillhub {source_label} install {} --preflight --json",
                remote.server_skill_id
            )
        }),
    }
}

fn updates_failure(
    source: AcquireSource,
    account: CliAccount,
    code: CliErrorCode,
    message: &'static str,
    exit_code: i32,
) -> CliCommandOutput {
    CliCommandOutput::failure(
        updates_command(source),
        account,
        code,
        message,
        exit_code,
        vec!["请检查本机托管状态与网络后重新查询更新".into()],
    )
}

async fn execute_updates(source: AcquireSource) -> CliCommandOutput {
    let (guard, account) = if source == AcquireSource::Team {
        let guard = match CliAuthGuard::capture() {
            Ok(guard) => guard,
            Err(error) => return auth_guard_failure(TEAM_UPDATES_COMMAND, error),
        };
        let account = match verify_account_with_server(&guard).await {
            Ok(account) => account,
            Err(error) => return account_verification_failure(TEAM_UPDATES_COMMAND, &guard, error),
        };
        (Some(guard), account)
    } else {
        (None, public_account())
    };
    let candidate_account_user_id = guard.as_ref().map(|guard| guard.user_id().to_string());
    let candidates = match tauri::async_runtime::spawn_blocking(move || {
        update_candidates(source, candidate_account_user_id.as_deref())
    })
    .await
    {
        Ok(Ok(candidates)) => candidates,
        _ => {
            return updates_failure(
                source,
                account,
                CliErrorCode::ValidationFailed,
                "无法安全读取本地远端托管 Skill 状态",
                EXIT_INTERNAL,
            )
        }
    };
    let client = match acquire_client(guard.as_ref()) {
        Ok(client) => client,
        Err(_) => {
            return updates_failure(
                source,
                account,
                CliErrorCode::InternalError,
                "无法初始化 SkillHub Server 连接",
                EXIT_INTERNAL,
            )
        }
    };
    let mut items = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let url = match api_url(
            guard.as_ref(),
            &source.metadata_path(&candidate.server_skill_id),
        ) {
            Ok(url) => url,
            Err(_) => {
                return updates_failure(
                    source,
                    account,
                    CliErrorCode::InternalError,
                    "无法构造安全的更新查询地址",
                    EXIT_INTERNAL,
                )
            }
        };
        if source == AcquireSource::Team && !candidate.account_matches {
            items.push(unavailable_update_item(candidate, "account_mismatch"));
            if let Some(guard) = guard.as_ref() {
                if let Err(error) = guard.verify_current() {
                    return auth_guard_failure(TEAM_UPDATES_COMMAND, error);
                }
            }
            continue;
        }
        let token = match guard.as_ref() {
            Some(guard) => match guard.token_for_request() {
                Ok(token) => Some(token),
                Err(error) => return auth_guard_failure(TEAM_UPDATES_COMMAND, error),
            },
            None => None,
        };
        let response = match bounded_get(&client, url, token, MAX_METADATA_RESPONSE_BYTES).await {
            Ok(response) => response,
            Err(ResponseReadError::Offline) => {
                return updates_failure(
                    source,
                    account,
                    CliErrorCode::Offline,
                    "读取 SkillHub Server 更新信息失败",
                    EXIT_NETWORK,
                )
            }
            Err(_) => {
                return updates_failure(
                    source,
                    account,
                    CliErrorCode::InternalError,
                    "SkillHub Server 更新响应不符合安全要求",
                    EXIT_INTERNAL,
                )
            }
        };
        if response.status == StatusCode::UNAUTHORIZED {
            let Some(guard) = guard.as_ref() else {
                return updates_failure(
                    source,
                    account,
                    CliErrorCode::InternalError,
                    "公开更新端点意外要求登录",
                    EXIT_INTERNAL,
                );
            };
            return auth_guard_failure(TEAM_UPDATES_COMMAND, guard.invalidate_unauthorized());
        }
        if matches!(
            response.status,
            StatusCode::NOT_FOUND | StatusCode::FORBIDDEN
        ) {
            let status = if response.status == StatusCode::FORBIDDEN {
                "access_revoked"
            } else {
                "remote_unavailable"
            };
            items.push(unavailable_update_item(candidate, status));
        } else if response.status == StatusCode::TOO_MANY_REQUESTS {
            return updates_failure(
                source,
                account,
                CliErrorCode::Offline,
                "更新查询过于频繁，请稍后重试",
                EXIT_NETWORK,
            );
        } else if !response.status.is_success() {
            return updates_failure(
                source,
                account,
                CliErrorCode::InternalError,
                "SkillHub Server 暂时无法完成更新查询",
                EXIT_INTERNAL,
            );
        } else {
            let remote = match source {
                AcquireSource::Marketplace => {
                    parse_marketplace_metadata(&response.body, &candidate.server_skill_id)
                }
                AcquireSource::Team => {
                    parse_team_metadata(&response.body, &candidate.server_skill_id)
                }
            };
            let remote = match remote {
                Ok(remote) => remote,
                Err(()) => {
                    return updates_failure(
                        source,
                        account,
                        CliErrorCode::InternalError,
                        "SkillHub Server 返回了无效的固定版本资料",
                        EXIT_INTERNAL,
                    )
                }
            };
            items.push(compared_update_item(candidate, remote));
        }
        if let Some(guard) = guard.as_ref() {
            if let Err(error) = guard.verify_current() {
                return auth_guard_failure(TEAM_UPDATES_COMMAND, error);
            }
        }
    }
    if let Some(guard) = guard.as_ref() {
        if let Err(error) = guard.verify_current() {
            return auth_guard_failure(TEAM_UPDATES_COMMAND, error);
        }
    }
    let available_count = items.iter().filter(|item| item.can_update).count();
    let attention_count = items
        .iter()
        .filter(|item| {
            matches!(
                item.status,
                "local_modified"
                    | "local_metadata_incomplete"
                    | "account_mismatch"
                    | "remote_unavailable"
                    | "access_revoked"
            )
        })
        .count();
    let mut warnings = Vec::new();
    if attention_count > 0 {
        warnings.push(format!(
            "{attention_count} 个本地 Skill 需要先处理本地修改、账号绑定、旧版元数据或访问权限"
        ));
    }
    CliCommandOutput::success(
        updates_command(source),
        account,
        json!({
            "source": match source {
                AcquireSource::Marketplace => "marketplace",
                AcquireSource::Team => "team",
            },
            "checkedCount": items.len(),
            "availableCount": available_count,
            "items": items,
        }),
        warnings,
        if available_count > 0 {
            vec!["逐项运行返回的 preflightCommand，并在用户确认计划后执行 apply".into()]
        } else {
            Vec::new()
        },
    )
}

fn load_existing_asset(
    root: &Path,
    local_skill_id: String,
    snapshot: ProfileSnapshot,
) -> Result<ExistingAsset, ()> {
    let content_sha256 = skill_content_fingerprint(root)?;
    let (git_head, working_copy_dirty) = git_state(root);
    Ok(ExistingAsset {
        local_skill_id,
        profile: snapshot.profile,
        profile_sha256: snapshot.profile_sha256,
        content_sha256,
        git_head,
        working_copy_dirty,
    })
}

fn action_for_existing(
    remote: &RemoteSkill,
    existing: &ExistingAsset,
    account_user_id: Option<&str>,
) -> AcquireAction {
    let source = profile_source(&existing.profile);
    if source != Some(remote.source.acquisition_source()) {
        return AcquireAction::BlockedSourceMismatch;
    }
    let package_sha256 = profile_package_sha256(&existing.profile);
    match remote.source {
        AcquireSource::Marketplace => {
            let metadata_matches = existing
                .profile
                .server_owner_id
                .as_deref()
                .and_then(normalized_uuid)
                .as_deref()
                == Some(remote.server_owner_id.as_str())
                && normalized_profile_acquired_by(&existing.profile).is_none();
            if existing
                .profile
                .acquisition_version
                .as_deref()
                .unwrap_or(&existing.profile.version)
                == remote.version
                && package_sha256.as_deref() == Some(remote.package_sha256.as_str())
                && metadata_matches
            {
                AcquireAction::AlreadyPresent
            } else if existing.working_copy_dirty || existing.git_head.is_none() {
                AcquireAction::BlockedMarketplaceLocalChanges
            } else {
                AcquireAction::ReplaceMarketplaceSource
            }
        }
        AcquireSource::Team => {
            let account_matches = account_user_id.is_some_and(|account_user_id| {
                normalized_profile_acquired_by(&existing.profile).as_deref()
                    == Some(account_user_id)
            });
            if !account_matches {
                return AcquireAction::BlockedAccountMismatch;
            }
            let metadata_matches = team_profile_metadata_sha256(&existing.profile).as_deref()
                == account_user_id
                    .and_then(|account_user_id| {
                        team_remote_metadata_sha256(remote, account_user_id)
                    })
                    .as_deref();
            if existing.profile.version == remote.version
                && package_sha256.as_deref() == Some(remote.package_sha256.as_str())
                && metadata_matches
            {
                AcquireAction::AlreadyPresent
            } else if existing.working_copy_dirty || existing.git_head.is_none() {
                AcquireAction::BlockedMarketplaceLocalChanges
            } else {
                AcquireAction::ReplaceTeamSource
            }
        }
    }
}

fn matches_remote_namespace(
    source: AcquireSource,
    space_id: &str,
    catalog_origin: Option<&str>,
) -> bool {
    match source {
        AcquireSource::Team => catalog_origin.is_none(),
        AcquireSource::Marketplace if space_id == "official" => true,
        AcquireSource::Marketplace => {
            catalog_origin.is_some_and(|value| crate::catalog::validate_origin(value).is_ok())
        }
    }
}

fn local_plan_for(remote: RemoteSkill, account_user_id: Option<String>) -> Result<AcquirePlan, ()> {
    let account_user_id = match remote.source {
        AcquireSource::Marketplace if account_user_id.is_none() => None,
        AcquireSource::Team => {
            Some(normalized_uuid(account_user_id.as_deref().ok_or(())?).ok_or(())?)
        }
        AcquireSource::Marketplace => return Err(()),
    };
    let session = crate::runtime_env::runtime_session_snapshot().map_err(|_| ())?;
    let expected_id = if remote.source == AcquireSource::Marketplace {
        scoped_remote_managed_skill_id(&remote.name, &remote.server_skill_id, session.space_id())?
    } else {
        remote_managed_skill_id(&remote.name, &remote.server_skill_id)?
    };
    let managed_root = crate::skills_dir();
    let root_metadata = match fs::symlink_metadata(&managed_root) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(()),
    };
    if root_metadata
        .as_ref()
        .is_some_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_dir())
    {
        return Err(());
    }

    let mut expected_exists = false;
    let mut same_remote = Vec::new();
    if root_metadata.is_some() {
        for (index, entry) in fs::read_dir(&managed_root).map_err(|_| ())?.enumerate() {
            if index >= MAX_MANAGED_ENTRIES {
                return Err(());
            }
            let entry = entry.map_err(|_| ())?;
            let Some(local_skill_id) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let metadata = fs::symlink_metadata(entry.path()).map_err(|_| ())?;
            if local_skill_id == expected_id {
                expected_exists = true;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    continue;
                }
            }
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let snapshot = match read_profile_snapshot(&entry.path()) {
                Ok(Some(snapshot)) => snapshot,
                Ok(None) => continue,
                Err(()) if local_skill_id == expected_id => return Err(()),
                Err(()) => continue,
            };
            if !crate::spaces::current_profile_matches(&snapshot.profile).map_err(|_| ())? {
                continue;
            }
            if !matches_remote_namespace(
                remote.source,
                session.space_id(),
                snapshot.profile.catalog_origin.as_deref(),
            ) {
                continue;
            }
            let matches_remote = snapshot
                .profile
                .server_id
                .as_deref()
                .and_then(normalized_uuid)
                .is_some_and(|server_id| server_id == remote.server_skill_id);
            if matches_remote {
                if !valid_portable_skill_id(&local_skill_id) {
                    return Err(());
                }
                same_remote.push(load_existing_asset(
                    &entry.path(),
                    local_skill_id,
                    snapshot,
                )?);
            }
        }
    }
    if same_remote.len() > 1 {
        return Err(());
    }

    let (local, action) = if let Some(existing) = same_remote.pop() {
        let source = profile_source(&existing.profile);
        let local_package_sha256 = profile_package_sha256(&existing.profile);
        let action = action_for_existing(&remote, &existing, account_user_id.as_deref());
        let local = LocalPlanState {
            state: if action == AcquireAction::BlockedAccountMismatch {
                "account_mismatch".into()
            } else {
                "same_remote_source".into()
            },
            local_skill_id: existing.local_skill_id,
            profile_id: existing.profile.id.clone(),
            server_skill_id: existing
                .profile
                .server_id
                .as_deref()
                .and_then(normalized_uuid),
            server_owner_id: existing
                .profile
                .server_owner_id
                .as_deref()
                .and_then(normalized_uuid),
            acquisition_source: source,
            version: Some(
                existing
                    .profile
                    .acquisition_version
                    .clone()
                    .unwrap_or_else(|| existing.profile.version.clone()),
            ),
            package_sha256: local_package_sha256.clone(),
            team_ids: normalized_profile_team_ids(&existing.profile),
            acquired_by_user_id: normalized_profile_acquired_by(&existing.profile),
            profile_sha256: Some(existing.profile_sha256),
            content_sha256: Some(existing.content_sha256),
            git_head: existing.git_head.clone(),
            working_copy_dirty: existing.working_copy_dirty,
        };
        (local, action)
    } else if expected_exists {
        (
            LocalPlanState {
                state: "managed_id_occupied".into(),
                local_skill_id: expected_id,
                profile_id: None,
                server_skill_id: None,
                server_owner_id: None,
                acquisition_source: None,
                version: None,
                package_sha256: None,
                team_ids: None,
                acquired_by_user_id: None,
                profile_sha256: None,
                content_sha256: None,
                git_head: None,
                working_copy_dirty: false,
            },
            AcquireAction::BlockedManagedIdCollision,
        )
    } else {
        (
            LocalPlanState {
                state: "absent".into(),
                local_skill_id: expected_id,
                profile_id: None,
                server_skill_id: None,
                server_owner_id: None,
                acquisition_source: None,
                version: None,
                package_sha256: None,
                team_ids: None,
                acquired_by_user_id: None,
                profile_sha256: None,
                content_sha256: None,
                git_head: None,
                working_copy_dirty: false,
            },
            AcquireAction::Import,
        )
    };
    Ok(AcquirePlan {
        schema_version: PLAN_SCHEMA_VERSION,
        source: remote.source,
        account_user_id,
        remote,
        local,
        action,
    })
}

fn preflight_output(account: CliAccount, plan: &AcquirePlan) -> CliCommandOutput {
    let digest = match plan.digest() {
        Ok(digest) => digest,
        Err(()) => {
            return CliCommandOutput::failure(
                plan.source.command(),
                account,
                CliErrorCode::InternalError,
                "无法生成安全的获取计划",
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let mut warnings = Vec::new();
    match plan.action {
        AcquireAction::AlreadyPresent if plan.local.working_copy_dirty => warnings
            .push("同源版本已经存在，但本地托管源包含未版本化修改；本次不会覆盖这些修改".into()),
        AcquireAction::ReplaceMarketplaceSource => {
            warnings.push("执行后将通过可恢复备份事务替换同源 Marketplace 托管版本".into())
        }
        AcquireAction::ReplaceTeamSource => {
            warnings.push("执行后将通过可恢复备份事务替换同源团队托管版本".into())
        }
        AcquireAction::BlockedManagedIdCollision => {
            warnings.push("目标托管标识已由其他本地资产占用；不会静默覆盖".into())
        }
        AcquireAction::BlockedSourceMismatch => {
            warnings.push("同一服务端资产已通过另一来源托管；不会静默改变来源身份".into())
        }
        AcquireAction::BlockedAccountMismatch => warnings
            .push("该团队 Skill 属于另一账号或来自未绑定账号的旧版记录；不会复用或覆盖".into()),
        AcquireAction::BlockedMarketplaceLocalChanges => {
            warnings.push("现有远端托管源有本地修改或缺少可验证版本记录；不会覆盖".into())
        }
        _ => {}
    }
    let next_actions = if plan.action.can_apply() {
        match plan.action {
            AcquireAction::AlreadyPresent => vec![format!(
                "托管源已存在；使用 skillhub skill install preflight --skill-id {} --agent <agent-key> --json 检查 Agent 投影",
                plan.local.local_skill_id
            )],
            _ => vec![format!(
                "确认后执行 skillhub {} install {} --apply --plan-digest {} --json",
                match plan.source {
                    AcquireSource::Marketplace => "marketplace",
                    AcquireSource::Team => "team",
                },
                plan.remote.server_skill_id,
                digest
            )],
        }
    } else {
        vec!["先处理本地冲突或改动，再重新运行 preflight；不要直接执行 apply".into()]
    };
    CliCommandOutput::success(
        plan.source.command(),
        account,
        json!({
            "phase": "preflight",
            "serverSkillId": plan.remote.server_skill_id,
            "localSkillId": plan.local.local_skill_id,
            "version": plan.remote.version,
            "packageSha256": plan.remote.package_sha256,
            "packageSize": plan.remote.package_size,
            "localState": plan.local.state,
            "localModified": plan.local.working_copy_dirty,
            "action": plan.action,
            "canApply": plan.action.can_apply(),
            "replaceExistingSource": plan.action.replaces_existing_source(),
            "requiresExplicitApply": !matches!(plan.action, AcquireAction::AlreadyPresent),
            "planDigest": digest,
        }),
        warnings,
        next_actions,
    )
}

fn plan_changed_failure(source: AcquireSource, account: CliAccount) -> CliCommandOutput {
    CliCommandOutput::failure(
        source.command(),
        account,
        CliErrorCode::PlanStale,
        "远端固定版本或本地托管源在预检后发生变化；本次未继续执行",
        EXIT_CONFLICT,
        vec!["重新运行 preflight，并仅使用新返回的 planDigest".into()],
    )
}

fn blocked_plan_failure(
    source: AcquireSource,
    account: CliAccount,
    action: &AcquireAction,
) -> CliCommandOutput {
    let message = match action {
        AcquireAction::BlockedManagedIdCollision => "本地托管标识已由其他资产占用，拒绝覆盖",
        AcquireAction::BlockedSourceMismatch => {
            "同一服务端资产已通过另一来源托管，拒绝改变来源身份"
        }
        AcquireAction::BlockedAccountMismatch => "现有团队 Skill 与当前账号不匹配，拒绝复用或覆盖",
        AcquireAction::BlockedMarketplaceLocalChanges => {
            "现有远端托管源包含本地修改或缺少可验证版本记录，拒绝更新"
        }
        _ => "当前获取计划不能安全执行",
    };
    CliCommandOutput::failure(
        source.command(),
        account,
        CliErrorCode::Conflict,
        message,
        EXIT_CONFLICT,
        vec!["处理本地状态后重新运行 preflight".into()],
    )
}

fn local_state_failure(source: AcquireSource, account: CliAccount) -> CliCommandOutput {
    CliCommandOutput::failure(
        source.command(),
        account,
        CliErrorCode::ValidationFailed,
        "无法安全确认当前 SkillHub 托管源状态",
        EXIT_USAGE,
        vec!["请在 SkillHub APP 中检查本地资产完整性后重新运行 preflight".into()],
    )
}

fn invalid_remote_failure(source: AcquireSource, account: CliAccount) -> CliCommandOutput {
    CliCommandOutput::failure(
        source.command(),
        account,
        CliErrorCode::InternalError,
        "SkillHub Server 返回的固定版本资料不完整或不符合安全合同",
        EXIT_INTERNAL,
        vec!["请稍后刷新远端 Skill 资料后重试".into()],
    )
}

fn response_read_failure(
    source: AcquireSource,
    account: CliAccount,
    error: ResponseReadError,
) -> CliCommandOutput {
    match error {
        ResponseReadError::Offline => CliCommandOutput::failure(
            source.command(),
            account,
            CliErrorCode::Offline,
            "读取 SkillHub Server 响应失败",
            EXIT_NETWORK,
            vec!["请检查网络后重试".into()],
        ),
        ResponseReadError::TooLarge => CliCommandOutput::failure(
            source.command(),
            account,
            CliErrorCode::ValidationFailed,
            "SkillHub Server 响应超过安全大小上限",
            EXIT_INTERNAL,
            Vec::new(),
        ),
        ResponseReadError::EndpointChanged => CliCommandOutput::failure(
            source.command(),
            account,
            CliErrorCode::InternalError,
            "SkillHub Server 响应来源发生变化，已拒绝继续",
            EXIT_INTERNAL,
            Vec::new(),
        ),
    }
}

fn public_http_failure(status: StatusCode) -> CliCommandOutput {
    let (code, message, exit_code) = if status == StatusCode::NOT_FOUND {
        (
            CliErrorCode::NotFound,
            "没有找到对应的 Marketplace Skill",
            EXIT_INTERNAL,
        )
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        (
            CliErrorCode::Offline,
            "Marketplace 请求过于频繁，请稍后重试",
            EXIT_NETWORK,
        )
    } else if status == StatusCode::CONFLICT {
        (
            CliErrorCode::Conflict,
            "Marketplace 固定版本当前没有可安全安装的包",
            EXIT_CONFLICT,
        )
    } else {
        (
            CliErrorCode::InternalError,
            "SkillHub Server 暂时无法完成 Marketplace 获取",
            EXIT_INTERNAL,
        )
    };
    CliCommandOutput::failure(
        MARKETPLACE_INSTALL_COMMAND,
        public_account(),
        code,
        message,
        exit_code,
        vec!["请稍后重试".into()],
    )
}

fn team_http_failure(
    guard: &CliAuthGuard,
    account: CliAccount,
    status: StatusCode,
) -> CliCommandOutput {
    if status == StatusCode::UNAUTHORIZED {
        return auth_guard_failure(TEAM_INSTALL_COMMAND, guard.invalidate_unauthorized());
    }
    if let Err(error) = guard.verify_current() {
        return auth_guard_failure(TEAM_INSTALL_COMMAND, error);
    }
    let (code, message, exit_code) = if status == StatusCode::FORBIDDEN {
        (
            CliErrorCode::PermissionDenied,
            "当前账号没有获取该团队 Skill 的权限",
            EXIT_AUTH,
        )
    } else if status == StatusCode::NOT_FOUND {
        (
            CliErrorCode::NotFound,
            "没有找到对应的团队 Skill",
            EXIT_INTERNAL,
        )
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        (
            CliErrorCode::Offline,
            "团队 Skill 请求过于频繁，请稍后重试",
            EXIT_NETWORK,
        )
    } else if status == StatusCode::CONFLICT {
        (
            CliErrorCode::Conflict,
            "团队 Skill 当前版本没有可安全安装的包",
            EXIT_CONFLICT,
        )
    } else {
        (
            CliErrorCode::InternalError,
            "SkillHub Server 暂时无法完成团队 Skill 获取",
            EXIT_INTERNAL,
        )
    };
    CliCommandOutput::failure(
        TEAM_INSTALL_COMMAND,
        account,
        code,
        message,
        exit_code,
        vec!["请稍后重试".into()],
    )
}

fn package_header<'a>(
    headers: &'a reqwest::header::HeaderMap,
    name: &'static str,
) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(value)
}

fn verify_package(response: HttpResponse, remote: &RemoteSkill) -> Result<Vec<u8>, ()> {
    if !response.status.is_success()
        || response.body.is_empty()
        || response.body.len() > MAX_PACKAGE_BYTES
        || response.body.len() as u64 != remote.package_size
    {
        return Err(());
    }
    let version = package_header(&response.headers, "x-skill-version").ok_or(())?;
    let header_sha256 = package_header(&response.headers, "x-checksum-sha256")
        .and_then(normalized_sha256)
        .ok_or(())?;
    let actual_sha256 = format!("{:x}", Sha256::digest(&response.body));
    if version != remote.version
        || header_sha256 != remote.package_sha256
        || actual_sha256 != remote.package_sha256
    {
        return Err(());
    }
    Ok(response.body)
}

fn import_input(
    plan: &AcquirePlan,
    package: &[u8],
    account_user_id: Option<&str>,
) -> ImportSkillPackageInput {
    let env_dependencies = plan
        .remote
        .env_dependencies
        .iter()
        .map(|dependency| EnvDepRaw {
            key: dependency.key.clone(),
            description: dependency.description.clone(),
            required: dependency.required,
            share_policy: "none".into(),
            shared_teams: Vec::new(),
            origin: None,
            confidence: None,
            obtain: None,
            pending: None,
        })
        .collect::<Vec<_>>();
    ImportSkillPackageInput {
        catalog_origin: (plan.remote.source == AcquireSource::Marketplace)
            .then(|| crate::catalog::origin().expect("compiled catalog origin")),
        skill_id: plan.local.local_skill_id.clone(),
        name: Some(plan.remote.name.clone()),
        package_base64: base64::engine::general_purpose::STANDARD.encode(package),
        expected_sha256: plan.remote.package_sha256.clone(),
        server_id: plan.remote.server_skill_id.clone(),
        server_owner_id: plan.remote.server_owner_id.clone(),
        display_name: plan.remote.display_name.clone(),
        description: plan.remote.description.clone(),
        source_url: plan.remote.source_url.clone(),
        category: plan.remote.category.clone(),
        labels: plan.remote.labels.clone(),
        version: plan.remote.version.clone(),
        team_id: plan.remote.team_ids.first().cloned(),
        team_ids: plan.remote.team_ids.clone(),
        is_own: account_user_id.is_some_and(|user_id| user_id == plan.remote.server_owner_id),
        acquisition_source: Some(plan.source.acquisition_source()),
        acquired_by_user_id: (plan.source == AcquireSource::Team)
            .then(|| plan.account_user_id.clone())
            .flatten(),
        replace_existing_marketplace: plan.action.replaces_existing_source(),
        install_count: match plan.source {
            AcquireSource::Marketplace => plan.remote.install_count.saturating_add(1),
            AcquireSource::Team => plan.remote.install_count,
        },
        created_at: Some(plan.remote.created_at.clone()),
        updated_at: Some(plan.remote.updated_at.clone()),
        trigger_scenarios: plan.remote.trigger_scenarios.clone(),
        compatible_agents: plan.remote.compatible_agents.clone(),
        env_dependencies,
    }
}

fn apply_success(
    account: CliAccount,
    plan: &AcquirePlan,
    acquired: bool,
    backup_created: bool,
) -> CliCommandOutput {
    CliCommandOutput::success(
        plan.source.command(),
        account,
        json!({
            "phase": "apply",
            "acquired": acquired,
            "alreadyPresent": !acquired,
            "serverSkillId": plan.remote.server_skill_id,
            "localSkillId": plan.local.local_skill_id,
            "version": plan.remote.version,
            "packageSha256": plan.remote.package_sha256,
            "sourceReplacement": plan.action.replaces_existing_source(),
            "replacementBackupCreated": backup_created,
        }),
        Vec::new(),
        vec![format!(
            "使用 skillhub skill install preflight --skill-id {} --agent <agent-key> --json 检查并确认 Agent 投影；本次获取没有代替该步骤",
            plan.local.local_skill_id
        )],
    )
}

fn import_failure(source: AcquireSource, account: CliAccount) -> CliCommandOutput {
    CliCommandOutput::failure(
        source.command(),
        account,
        CliErrorCode::ValidationFailed,
        "远端包已通过校验，但未能安全写入 SkillHub 托管源",
        EXIT_INTERNAL,
        vec![
            "先使用 skillhub skill list --json 复核本地状态；不要直接重试 apply".into(),
            "需要重试时重新运行 preflight 并使用新的 planDigest".into(),
        ],
    )
}

async fn build_plan(
    remote: RemoteSkill,
    account_user_id: Option<String>,
) -> Result<AcquirePlan, ()> {
    tauri::async_runtime::spawn_blocking(move || local_plan_for(remote, account_user_id))
        .await
        .map_err(|_| ())?
}

async fn import_plan(
    plan: &AcquirePlan,
    package: Vec<u8>,
    space: crate::server_request::SpaceHandle,
) -> Result<bool, ()> {
    let input = import_input(plan, &package, plan.account_user_id.as_deref());
    let imported = tauri::async_runtime::spawn_blocking(move || {
        crate::commands::import_skill_package(space, input)
    })
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    if imported.id != plan.local.local_skill_id
        || imported.server_id.as_deref() != Some(plan.remote.server_skill_id.as_str())
        || imported
            .acquisition_version
            .as_deref()
            .unwrap_or(&imported.version)
            != plan.remote.version
    {
        return Err(());
    }
    Ok(imported.marketplace_replacement_recovery_id.is_some())
}

async fn fetch_marketplace_remote(
    client: &Client,
    server_skill_id: &str,
) -> Result<RemoteSkill, CliCommandOutput> {
    let url = api_url(
        None,
        &AcquireSource::Marketplace.metadata_path(server_skill_id),
    )
    .map_err(|message| {
        CliCommandOutput::failure(
            MARKETPLACE_INSTALL_COMMAND,
            public_account(),
            CliErrorCode::InternalError,
            message,
            EXIT_INTERNAL,
            Vec::new(),
        )
    })?;
    let response = bounded_get(client, url, None, MAX_METADATA_RESPONSE_BYTES)
        .await
        .map_err(|error| {
            response_read_failure(AcquireSource::Marketplace, public_account(), error)
        })?;
    if !response.status.is_success() {
        return Err(public_http_failure(response.status));
    }
    parse_marketplace_metadata(&response.body, server_skill_id)
        .map_err(|_| invalid_remote_failure(AcquireSource::Marketplace, public_account()))
}

async fn marketplace_acquire(parsed: AcquireArgs) -> CliCommandOutput {
    let session = match crate::runtime_env::runtime_session_snapshot() {
        Ok(session) if !session.is_sync_pending() => session,
        _ => return local_state_failure(AcquireSource::Marketplace, public_account()),
    };
    let space = crate::server_request::SpaceRegistry::handle(Some(&session));
    let client = match acquire_client(None) {
        Ok(client) => client,
        Err(message) => {
            return CliCommandOutput::failure(
                MARKETPLACE_INSTALL_COMMAND,
                public_account(),
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let remote = match fetch_marketplace_remote(&client, &parsed.server_skill_id).await {
        Ok(remote) => remote,
        Err(output) => return output,
    };
    let plan = match build_plan(remote, None).await {
        Ok(plan) => plan,
        Err(()) => return local_state_failure(AcquireSource::Marketplace, public_account()),
    };
    let AcquireMode::Apply { plan_digest } = parsed.mode else {
        return preflight_output(public_account(), &plan);
    };
    let current_digest = match plan.digest() {
        Ok(digest) => digest,
        Err(()) => return local_state_failure(AcquireSource::Marketplace, public_account()),
    };
    if current_digest != plan_digest {
        return plan_changed_failure(AcquireSource::Marketplace, public_account());
    }
    if !plan.action.can_apply() {
        return blocked_plan_failure(AcquireSource::Marketplace, public_account(), &plan.action);
    }
    if matches!(plan.action, AcquireAction::AlreadyPresent) {
        return apply_success(public_account(), &plan, false, false);
    }
    let package_url = match api_url(
        None,
        &AcquireSource::Marketplace.package_path(&parsed.server_skill_id),
    ) {
        Ok(url) => url,
        Err(message) => {
            return CliCommandOutput::failure(
                MARKETPLACE_INSTALL_COMMAND,
                public_account(),
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let package_response = match bounded_get(&client, package_url, None, MAX_PACKAGE_BYTES).await {
        Ok(response) => response,
        Err(error) => {
            return response_read_failure(AcquireSource::Marketplace, public_account(), error)
        }
    };
    if !package_response.status.is_success() {
        return public_http_failure(package_response.status);
    }
    let package = match verify_package(package_response, &plan.remote) {
        Ok(package) => package,
        Err(()) => return invalid_remote_failure(AcquireSource::Marketplace, public_account()),
    };
    let confirmed_plan = match build_plan(plan.remote.clone(), None).await {
        Ok(confirmed_plan) => confirmed_plan,
        Err(()) => return local_state_failure(AcquireSource::Marketplace, public_account()),
    };
    if confirmed_plan.digest().ok().as_deref() != Some(plan_digest.as_str()) {
        return plan_changed_failure(AcquireSource::Marketplace, public_account());
    }
    let backup_created = match import_plan(&confirmed_plan, package, space).await {
        Ok(backup_created) => backup_created,
        Err(()) => return import_failure(AcquireSource::Marketplace, public_account()),
    };
    apply_success(public_account(), &confirmed_plan, true, backup_created)
}

async fn fetch_team_remote(
    client: &Client,
    guard: &CliAuthGuard,
    account: CliAccount,
    server_skill_id: &str,
) -> Result<RemoteSkill, CliCommandOutput> {
    let url = match api_url(
        Some(guard),
        &AcquireSource::Team.metadata_path(server_skill_id),
    ) {
        Ok(url) => url,
        Err(message) => {
            guard
                .verify_current()
                .map_err(|error| auth_guard_failure(TEAM_INSTALL_COMMAND, error))?;
            return Err(CliCommandOutput::failure(
                TEAM_INSTALL_COMMAND,
                account,
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            ));
        }
    };
    let token = guard
        .token_for_request()
        .map_err(|error| auth_guard_failure(TEAM_INSTALL_COMMAND, error))?;
    let response = match bounded_get(client, url, Some(token), MAX_METADATA_RESPONSE_BYTES).await {
        Ok(response) => response,
        Err(error) => {
            guard
                .verify_current()
                .map_err(|guard_error| auth_guard_failure(TEAM_INSTALL_COMMAND, guard_error))?;
            return Err(response_read_failure(AcquireSource::Team, account, error));
        }
    };
    if !response.status.is_success() {
        return Err(team_http_failure(guard, account, response.status));
    }
    let remote = match parse_team_metadata(&response.body, server_skill_id) {
        Ok(remote) => remote,
        Err(()) => {
            guard
                .verify_current()
                .map_err(|error| auth_guard_failure(TEAM_INSTALL_COMMAND, error))?;
            return Err(invalid_remote_failure(AcquireSource::Team, account));
        }
    };
    guard
        .verify_current()
        .map_err(|error| auth_guard_failure(TEAM_INSTALL_COMMAND, error))?;
    Ok(remote)
}

async fn team_acquire(parsed: AcquireArgs) -> CliCommandOutput {
    let guard = match CliAuthGuard::capture() {
        Ok(guard) => guard,
        Err(error) => return auth_guard_failure(TEAM_INSTALL_COMMAND, error),
    };
    let account = match verify_account_with_server(&guard).await {
        Ok(account) => account,
        Err(error) => return account_verification_failure(TEAM_INSTALL_COMMAND, &guard, error),
    };
    let client = match acquire_client(Some(&guard)) {
        Ok(client) => client,
        Err(message) => {
            if let Err(error) = guard.verify_current() {
                return auth_guard_failure(TEAM_INSTALL_COMMAND, error);
            }
            return CliCommandOutput::failure(
                TEAM_INSTALL_COMMAND,
                account,
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            );
        }
    };
    let remote =
        match fetch_team_remote(&client, &guard, account.clone(), &parsed.server_skill_id).await {
            Ok(remote) => remote,
            Err(output) => return output,
        };
    let plan = match build_plan(remote, Some(guard.user_id().to_string())).await {
        Ok(plan) => plan,
        Err(()) => {
            if let Err(error) = guard.verify_current() {
                return auth_guard_failure(TEAM_INSTALL_COMMAND, error);
            }
            return local_state_failure(AcquireSource::Team, account);
        }
    };
    let AcquireMode::Apply { plan_digest } = parsed.mode else {
        if let Err(error) = guard.verify_current() {
            return auth_guard_failure(TEAM_INSTALL_COMMAND, error);
        }
        return preflight_output(account, &plan);
    };
    let current_digest = match plan.digest() {
        Ok(digest) => digest,
        Err(()) => {
            if let Err(error) = guard.verify_current() {
                return auth_guard_failure(TEAM_INSTALL_COMMAND, error);
            }
            return local_state_failure(AcquireSource::Team, account);
        }
    };
    if current_digest != plan_digest {
        if let Err(error) = guard.verify_current() {
            return auth_guard_failure(TEAM_INSTALL_COMMAND, error);
        }
        return plan_changed_failure(AcquireSource::Team, account);
    }
    if !plan.action.can_apply() {
        if let Err(error) = guard.verify_current() {
            return auth_guard_failure(TEAM_INSTALL_COMMAND, error);
        }
        return blocked_plan_failure(AcquireSource::Team, account, &plan.action);
    }
    if matches!(plan.action, AcquireAction::AlreadyPresent) {
        if let Err(error) = guard.verify_current() {
            return auth_guard_failure(TEAM_INSTALL_COMMAND, error);
        }
        return apply_success(account, &plan, false, false);
    }
    let package_url = match api_url(
        Some(&guard),
        &AcquireSource::Team.package_path(&parsed.server_skill_id),
    ) {
        Ok(url) => url,
        Err(message) => {
            if let Err(error) = guard.verify_current() {
                return auth_guard_failure(TEAM_INSTALL_COMMAND, error);
            }
            return CliCommandOutput::failure(
                TEAM_INSTALL_COMMAND,
                account,
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            );
        }
    };
    let token = match guard.token_for_request() {
        Ok(token) => token,
        Err(error) => return auth_guard_failure(TEAM_INSTALL_COMMAND, error),
    };
    let package_response =
        match bounded_get(&client, package_url, Some(token), MAX_PACKAGE_BYTES).await {
            Ok(response) => response,
            Err(error) => {
                if let Err(guard_error) = guard.verify_current() {
                    return auth_guard_failure(TEAM_INSTALL_COMMAND, guard_error);
                }
                return response_read_failure(AcquireSource::Team, account, error);
            }
        };
    if !package_response.status.is_success() {
        return team_http_failure(&guard, account, package_response.status);
    }
    let package = match verify_package(package_response, &plan.remote) {
        Ok(package) => package,
        Err(()) => {
            if let Err(error) = guard.verify_current() {
                return auth_guard_failure(TEAM_INSTALL_COMMAND, error);
            }
            return invalid_remote_failure(AcquireSource::Team, account);
        }
    };
    // The package response proves access only at download time. Re-read Team
    // metadata before touching disk so revoked membership/share state fails
    // closed and so the digest binds the latest authorized Team scope.
    let confirmed_remote =
        match fetch_team_remote(&client, &guard, account.clone(), &parsed.server_skill_id).await {
            Ok(remote) => remote,
            Err(output) => return output,
        };
    let confirmed_plan = match build_plan(confirmed_remote, Some(guard.user_id().to_string())).await
    {
        Ok(confirmed_plan) => confirmed_plan,
        Err(()) => {
            if let Err(error) = guard.verify_current() {
                return auth_guard_failure(TEAM_INSTALL_COMMAND, error);
            }
            return local_state_failure(AcquireSource::Team, account);
        }
    };
    if confirmed_plan.digest().ok().as_deref() != Some(plan_digest.as_str()) {
        if let Err(error) = guard.verify_current() {
            return auth_guard_failure(TEAM_INSTALL_COMMAND, error);
        }
        return plan_changed_failure(AcquireSource::Team, account);
    }
    // Revalidate the JWT and server identity immediately before the only
    // filesystem commit, then hold a shared Runtime Session lease across that
    // commit so APP login/logout cannot bind Team data to a different account.
    let account = match verify_account_with_server(&guard).await {
        Ok(account) => account,
        Err(error) => return account_verification_failure(TEAM_INSTALL_COMMAND, &guard, error),
    };
    let session_lease = match guard.acquire_current_lease() {
        Ok(lease) => lease,
        Err(error) => return auth_guard_failure(TEAM_INSTALL_COMMAND, error),
    };
    let import_result = import_plan(
        &confirmed_plan,
        package,
        crate::server_request::SpaceRegistry::handle(Some(guard.session())),
    )
    .await;
    drop(session_lease);
    let backup_created = match import_result {
        Ok(backup_created) => backup_created,
        Err(()) => {
            if let Err(error) = guard.verify_current() {
                return auth_guard_failure(TEAM_INSTALL_COMMAND, error);
            }
            return import_failure(AcquireSource::Team, account);
        }
    };
    if let Err(error) = guard.verify_current() {
        return auth_guard_failure(TEAM_INSTALL_COMMAND, error);
    }
    apply_success(account, &confirmed_plan, true, backup_created)
}

/// Claims only the two acquire commands so the existing read-only
/// Marketplace/Team router can continue handling search/show/list.
pub(crate) async fn execute_acquire_cli(args: &[String]) -> Option<CliCommandOutput> {
    if !matches!(
        args.first().map(String::as_str),
        Some("marketplace" | "team")
    ) {
        return None;
    }
    let source = if args.first().map(String::as_str) == Some("team") {
        AcquireSource::Team
    } else {
        AcquireSource::Marketplace
    };
    if args.get(1).map(String::as_str) == Some("updates") {
        return Some(
            if args.len() == 3 && args.get(2).map(String::as_str) == Some("--json") {
                execute_updates(source).await
            } else {
                updates_usage_failure(source)
            },
        );
    }
    if args.get(1).map(String::as_str) != Some("install") {
        return None;
    }
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(()) => return Some(usage_failure(source)),
    };
    Some(match parsed.source {
        AcquireSource::Marketplace => marketplace_acquire(parsed).await,
        AcquireSource::Team => team_acquire(parsed).await,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        action_for_existing, compared_update_item, execute_acquire_cli, parse_args,
        remote_managed_skill_id, team_remote_metadata_sha256, verify_package, AcquireAction,
        AcquireArgs, AcquireMode, AcquirePlan, AcquireSource, ExistingAsset, HttpResponse,
        LocalPlanState, RemoteEnvDependency, RemoteSkill, UpdateCandidate, PLAN_SCHEMA_VERSION,
    };
    use reqwest::StatusCode;
    use sha2::{Digest as _, Sha256};

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    fn server_id() -> &'static str {
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    }

    fn digest() -> &'static str {
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }

    fn account_a() -> &'static str {
        "11111111-1111-4111-8111-111111111111"
    }

    fn account_b() -> &'static str {
        "22222222-2222-4222-8222-222222222222"
    }

    fn team_id() -> &'static str {
        "33333333-3333-4333-8333-333333333333"
    }

    fn remote() -> RemoteSkill {
        RemoteSkill {
            source: AcquireSource::Marketplace,
            server_skill_id: server_id().into(),
            remote_version_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
            name: "hollywood-writer".into(),
            display_name: "Hollywood Writer".into(),
            description: Some("Writes scenes".into()),
            source_url: Some("https://github.com/acme/hollywood-writer".into()),
            category: Some("Writing".into()),
            labels: vec!["screenplay".into()],
            trigger_scenarios: vec!["write a scene".into()],
            compatible_agents: vec!["codex".into()],
            env_dependencies: vec![RemoteEnvDependency {
                key: "EXAMPLE_KEY".into(),
                description: Some("Example".into()),
                required: false,
            }],
            version: "v1.2.0".into(),
            package_sha256: "c".repeat(64),
            package_size: 1_024,
            server_owner_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into(),
            team_ids: Vec::new(),
            created_at: "2026-09-01T00:00:00.000Z".into(),
            updated_at: "2026-09-02T00:00:00.000Z".into(),
            install_count: 5,
        }
    }

    fn local() -> LocalPlanState {
        LocalPlanState {
            state: "same_remote_source".into(),
            local_skill_id: "hollywood-writer--aaaaaaaaaaaa".into(),
            profile_id: Some("dddddddd-dddd-4ddd-8ddd-dddddddddddd".into()),
            server_skill_id: Some(server_id().into()),
            server_owner_id: Some("cccccccc-cccc-4ccc-8ccc-cccccccccccc".into()),
            acquisition_source: Some(crate::AcquisitionSource::Marketplace),
            version: Some("v1.1.0".into()),
            package_sha256: Some("d".repeat(64)),
            team_ids: Some(Vec::new()),
            acquired_by_user_id: None,
            profile_sha256: Some("e".repeat(64)),
            content_sha256: Some("f".repeat(64)),
            git_head: Some("1".repeat(40)),
            working_copy_dirty: false,
        }
    }

    fn team_remote() -> RemoteSkill {
        let mut remote = remote();
        remote.source = AcquireSource::Team;
        remote.team_ids = vec![team_id().into()];
        remote
    }

    fn team_existing(acquired_by_user_id: Option<&str>, team_ids: &[&str]) -> ExistingAsset {
        ExistingAsset {
            local_skill_id: "hollywood-writer--aaaaaaaaaaaa".into(),
            profile: crate::SkillHubProfile {
                id: Some("dddddddd-dddd-4ddd-8ddd-dddddddddddd".into()),
                server_id: Some(server_id().into()),
                server_owner_id: Some("cccccccc-cccc-4ccc-8ccc-cccccccccccc".into()),
                acquisition_source: Some(crate::AcquisitionSource::Team),
                acquisition_package_sha256: Some("c".repeat(64)),
                acquired_by_user_id: acquired_by_user_id.map(str::to_string),
                name: Some("hollywood-writer".into()),
                display_name: Some("Hollywood Writer".into()),
                description: Some("Writes scenes".into()),
                category: Some("Writing".into()),
                labels: vec!["screenplay".into()],
                trigger_scenarios: vec!["write a scene".into()],
                compatible_agents: vec!["codex".into()],
                env_dependencies: vec![crate::EnvDepRaw {
                    key: "EXAMPLE_KEY".into(),
                    description: Some("Example".into()),
                    required: false,
                    share_policy: "none".into(),
                    shared_teams: Vec::new(),
                    origin: None,
                    confidence: None,
                    obtain: None,
                    pending: None,
                }],
                is_own: Some(false),
                version: "v1.2.0".into(),
                teams: team_ids.iter().map(|value| (*value).to_string()).collect(),
                team_ids: team_ids.iter().map(|value| (*value).to_string()).collect(),
                ..Default::default()
            },
            profile_sha256: "e".repeat(64),
            content_sha256: "f".repeat(64),
            git_head: Some("1".repeat(40)),
            working_copy_dirty: false,
        }
    }

    #[test]
    fn parser_requires_exact_two_phase_json_contract() {
        assert_eq!(
            parse_args(&strings(&[
                "marketplace",
                "install",
                server_id(),
                "--preflight",
                "--json",
            ])),
            Ok(AcquireArgs {
                source: AcquireSource::Marketplace,
                server_skill_id: server_id().into(),
                mode: AcquireMode::Preflight,
            })
        );
        assert_eq!(
            parse_args(&strings(&[
                "team",
                "install",
                server_id(),
                "--json",
                "--plan-digest",
                digest(),
                "--apply",
            ])),
            Ok(AcquireArgs {
                source: AcquireSource::Team,
                server_skill_id: server_id().into(),
                mode: AcquireMode::Apply {
                    plan_digest: digest().into(),
                },
            })
        );
        for rejected in [
            strings(&["marketplace", "install", server_id(), "--preflight"]),
            strings(&[
                "marketplace",
                "install",
                server_id(),
                "--preflight",
                "--apply",
                "--json",
            ]),
            strings(&["marketplace", "install", server_id(), "--apply", "--json"]),
            strings(&[
                "team",
                "install",
                server_id(),
                "--preflight",
                "--plan-digest",
                digest(),
                "--json",
            ]),
            strings(&[
                "team",
                "install",
                server_id(),
                "--preflight",
                "--json",
                "--json",
            ]),
        ] {
            assert!(parse_args(&rejected).is_err());
        }
    }

    #[test]
    fn plan_digest_is_stable_and_binds_remote_and_local_state() {
        let plan = AcquirePlan {
            schema_version: PLAN_SCHEMA_VERSION,
            source: AcquireSource::Marketplace,
            account_user_id: None,
            remote: remote(),
            local: local(),
            action: AcquireAction::ReplaceMarketplaceSource,
        };
        let digest = plan.digest().expect("digest plan");
        assert_eq!(digest, plan.clone().digest().expect("repeat digest"));

        let mut changed_version = plan.clone();
        changed_version.remote.version = "v1.3.0".into();
        assert_ne!(digest, changed_version.digest().expect("remote digest"));

        let mut changed_content = plan.clone();
        changed_content.local.content_sha256 = Some("0".repeat(64));
        assert_ne!(digest, changed_content.digest().expect("local digest"));

        let mut changed_profile = plan;
        changed_profile.local.version = Some("v1.0.0".into());
        assert_ne!(digest, changed_profile.digest().expect("profile digest"));
    }

    #[test]
    fn team_plan_digest_binds_the_acquiring_account() {
        let plan = AcquirePlan {
            schema_version: PLAN_SCHEMA_VERSION,
            source: AcquireSource::Team,
            account_user_id: Some(account_a().into()),
            remote: team_remote(),
            local: local(),
            action: AcquireAction::Import,
        };
        let digest = plan.digest().expect("digest account-bound plan");
        let mut other_account = plan;
        other_account.account_user_id = Some(account_b().into());
        assert_ne!(
            digest,
            other_account.digest().expect("other account digest")
        );
    }

    #[test]
    fn team_existing_asset_cannot_cross_accounts_or_reuse_legacy_binding() {
        let remote = team_remote();
        let account_a_asset = team_existing(Some(account_a()), &[team_id()]);
        assert_eq!(
            action_for_existing(&remote, &account_a_asset, Some(account_b())),
            AcquireAction::BlockedAccountMismatch
        );
        assert_eq!(
            action_for_existing(
                &remote,
                &team_existing(None, &[team_id()]),
                Some(account_a())
            ),
            AcquireAction::BlockedAccountMismatch
        );
        assert_eq!(
            action_for_existing(&remote, &account_a_asset, Some(account_a())),
            AcquireAction::AlreadyPresent
        );
    }

    #[test]
    fn team_metadata_change_replaces_even_when_version_and_package_match() {
        let remote = team_remote();
        let other_team = "44444444-4444-4444-8444-444444444444";
        assert_eq!(
            action_for_existing(
                &remote,
                &team_existing(Some(account_a()), &[other_team]),
                Some(account_a())
            ),
            AcquireAction::ReplaceTeamSource
        );
        let mut owner_changed = team_existing(Some(account_a()), &[team_id()]);
        owner_changed.profile.server_owner_id = Some("55555555-5555-4555-8555-555555555555".into());
        assert_eq!(
            action_for_existing(&remote, &owner_changed, Some(account_a())),
            AcquireAction::ReplaceTeamSource
        );
        let mut description_changed = team_existing(Some(account_a()), &[team_id()]);
        description_changed.profile.description = Some("Updated description".into());
        assert_eq!(
            action_for_existing(&remote, &description_changed, Some(account_a())),
            AcquireAction::ReplaceTeamSource
        );
    }

    #[test]
    fn managed_ids_match_shared_rust_typescript_vectors() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Case {
            name: String,
            server_id: String,
            space_id: String,
            expected: Option<String>,
        }
        let cases: Vec<Case> = serde_json::from_str(include_str!(
            "../../tests/fixtures/remote-managed-skill-ids.json"
        ))
        .unwrap();
        for case in cases {
            assert_eq!(
                super::scoped_remote_managed_skill_id(&case.name, &case.server_id, &case.space_id)
                    .ok(),
                case.expected,
                "{}",
                case.space_id
            );
        }
    }

    #[test]
    fn managed_id_matches_desktop_remote_identity_rule() {
        assert_eq!(
            remote_managed_skill_id("hollywood-writer", server_id()),
            Ok("hollywood-writer--aaaaaaaaaaaa".into())
        );
        let long_name = "a".repeat(128);
        let managed = remote_managed_skill_id(&long_name, server_id())
            .expect("truncate a portable remote name");
        assert_eq!(managed.len(), 128);
        assert!(managed.ends_with("--aaaaaaaaaaaa"));
        assert!(!managed
            .trim_end_matches("--aaaaaaaaaaaa")
            .ends_with(['.', '_', '-']));
    }

    #[test]
    fn catalog_import_keeps_origin_and_scoped_folder_identity() {
        let plan = AcquirePlan {
            schema_version: PLAN_SCHEMA_VERSION,
            source: AcquireSource::Marketplace,
            account_user_id: None,
            remote: remote(),
            local: local(),
            action: AcquireAction::Import,
        };
        let input = super::import_input(&plan, b"zip", None);
        assert_eq!(
            input.catalog_origin,
            Some(crate::catalog::origin().unwrap())
        );
        assert!(!input.is_own);
        assert_eq!(input.version, plan.remote.version);
        let official =
            super::scoped_remote_managed_skill_id("demo", server_id(), "official").unwrap();
        let selfhost =
            super::scoped_remote_managed_skill_id("demo", server_id(), "selfhost-abc").unwrap();
        assert_eq!(selfhost, "demo--aaaaaaaaaaaa-selfhost-abc");
        assert_ne!(official, selfhost);
        let origin = crate::catalog::origin().unwrap();
        assert!(!super::matches_remote_namespace(
            AcquireSource::Marketplace,
            "selfhost-abc",
            None
        ));
        assert!(super::matches_remote_namespace(
            AcquireSource::Marketplace,
            "selfhost-abc",
            Some(&origin)
        ));
        assert!(super::matches_remote_namespace(
            AcquireSource::Marketplace,
            "official",
            None
        ));
        assert!(!super::matches_remote_namespace(
            AcquireSource::Team,
            "selfhost-abc",
            Some(&origin)
        ));
        assert!(super::matches_remote_namespace(
            AcquireSource::Team,
            "selfhost-abc",
            None
        ));
    }

    #[test]
    fn update_comparison_requires_a_clean_verified_fixed_package() {
        let candidate = UpdateCandidate {
            local_skill_id: "hollywood-writer--aaaaaaaaaaaa".into(),
            server_skill_id: server_id().into(),
            display_name: "Hollywood Writer".into(),
            version: "v1.2.0".into(),
            package_sha256: Some("c".repeat(64)),
            server_owner_id: Some("cccccccc-cccc-4ccc-8ccc-cccccccccccc".into()),
            team_ids: Some(Vec::new()),
            acquired_by_user_id: None,
            account_matches: true,
            team_metadata_sha256: None,
            working_copy_dirty: false,
        };
        let current = compared_update_item(candidate.clone(), remote());
        assert_eq!(current.status, "up_to_date");
        assert!(!current.can_update);

        let mut newer = remote();
        newer.version = "v1.3.0".into();
        newer.package_sha256 = "d".repeat(64);
        let available = compared_update_item(candidate.clone(), newer.clone());
        assert_eq!(available.status, "update_available");
        assert!(available.can_update);
        assert!(available
            .preflight_command
            .as_deref()
            .is_some_and(|command| command.contains("marketplace install")));

        let mut dirty = candidate.clone();
        dirty.working_copy_dirty = true;
        let blocked = compared_update_item(dirty, newer.clone());
        assert_eq!(blocked.status, "local_modified");
        assert!(!blocked.can_update);

        let mut legacy = candidate;
        legacy.package_sha256 = None;
        let incomplete = compared_update_item(legacy, newer);
        assert_eq!(incomplete.status, "local_metadata_incomplete");
        assert!(!incomplete.can_update);
    }

    #[test]
    fn team_update_comparison_includes_account_owner_and_team_metadata() {
        let remote = team_remote();
        let candidate = UpdateCandidate {
            local_skill_id: "hollywood-writer--aaaaaaaaaaaa".into(),
            server_skill_id: server_id().into(),
            display_name: "Hollywood Writer".into(),
            version: "v1.2.0".into(),
            package_sha256: Some("c".repeat(64)),
            server_owner_id: Some("cccccccc-cccc-4ccc-8ccc-cccccccccccc".into()),
            team_ids: Some(vec![team_id().into()]),
            acquired_by_user_id: Some(account_a().into()),
            account_matches: true,
            team_metadata_sha256: team_remote_metadata_sha256(&remote, account_a()),
            working_copy_dirty: false,
        };
        assert_eq!(
            compared_update_item(candidate.clone(), remote.clone()).status,
            "up_to_date"
        );

        let mut changed_team = candidate.clone();
        changed_team.team_ids = Some(vec!["44444444-4444-4444-8444-444444444444".into()]);
        let changed = compared_update_item(changed_team, remote.clone());
        assert_eq!(changed.status, "update_available");
        assert!(changed.can_update);

        let mut changed_description = remote.clone();
        changed_description.description = Some("Updated description".into());
        let changed = compared_update_item(candidate.clone(), changed_description);
        assert_eq!(changed.status, "update_available");
        assert!(changed.can_update);

        let mut mismatched = candidate;
        mismatched.account_matches = false;
        mismatched.acquired_by_user_id = Some(account_b().into());
        let blocked = compared_update_item(mismatched, remote);
        assert_eq!(blocked.status, "account_mismatch");
        assert!(!blocked.can_update);
    }

    #[test]
    fn team_source_replacement_uses_the_recoverable_apply_path() {
        assert!(AcquireAction::ReplaceTeamSource.can_apply());
        assert!(AcquireAction::ReplaceTeamSource.replaces_existing_source());
        assert!(!AcquireAction::AlreadyPresent.replaces_existing_source());
    }

    #[tokio::test]
    async fn unrelated_cloud_commands_are_not_claimed() {
        assert!(
            execute_acquire_cli(&strings(&["marketplace", "show", server_id(), "--json",]))
                .await
                .is_none()
        );
        assert!(execute_acquire_cli(&strings(&["team", "list", "--json"]))
            .await
            .is_none());
    }

    #[test]
    fn package_verification_binds_both_headers_and_actual_bytes() {
        let body = b"verified zip bytes".to_vec();
        let checksum = format!("{:x}", Sha256::digest(&body));
        let mut remote = remote();
        remote.package_sha256 = checksum.clone();
        remote.package_size = body.len() as u64;
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-skill-version", "v1.2.0".parse().expect("version"));
        headers.insert("x-checksum-sha256", checksum.parse().expect("checksum"));
        assert_eq!(
            verify_package(
                HttpResponse {
                    status: StatusCode::OK,
                    headers: headers.clone(),
                    body: body.clone(),
                },
                &remote,
            ),
            Ok(body.clone())
        );

        headers.append(
            "x-checksum-sha256",
            "0".repeat(64).parse().expect("duplicate checksum"),
        );
        assert!(verify_package(
            HttpResponse {
                status: StatusCode::OK,
                headers,
                body,
            },
            &remote,
        )
        .is_err());
    }
}
