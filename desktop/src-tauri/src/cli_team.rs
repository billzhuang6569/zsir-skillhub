use crate::cli::{
    CliAccount, CliAccountState, CliCommandOutput, CliErrorCode, EXIT_AUTH, EXIT_CONFLICT,
    EXIT_INTERNAL, EXIT_NETWORK, EXIT_USAGE,
};
use crate::cli_auth::{
    account_verification_failure, auth_guard_failure, verify_account_with_server, CliAuthGuard,
};
use crate::{AcquisitionSource, SkillHubJson, SkillHubProfile, SkillProfileUpdateInput};
use git2::{Repository, StatusOptions};
use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use std::collections::{BTreeSet, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Read as _;
use std::path::Path;
use std::time::Duration;
use zeroize::{Zeroize as _, Zeroizing};

#[cfg(windows)]
use crate::platform_fs::OpenOptionsExt as _;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as _;

pub(crate) const TEAM_MUTATION_USAGE: &str = concat!(
    "用法：\n",
    "  skillhub team share preflight --local-skill-id <id> --team-id <uuid> [--json]\n",
    "  skillhub team share apply --local-skill-id <id> --team-id <uuid> --plan-digest <64hex> [--json]\n",
    "  skillhub team share status --local-skill-id <id> --team-id <uuid> [--json]\n",
    "  skillhub team unshare preflight --local-skill-id <id> --team-id <uuid> [--json]\n",
    "  skillhub team unshare apply --local-skill-id <id> --team-id <uuid> --plan-digest <64hex> [--json]"
);

const SHARE_PREFLIGHT_COMMAND: &str = "team share preflight";
const SHARE_APPLY_COMMAND: &str = "team share apply";
const SHARE_STATUS_COMMAND: &str = "team share status";
const UNSHARE_PREFLIGHT_COMMAND: &str = "team unshare preflight";
const UNSHARE_APPLY_COMMAND: &str = "team unshare apply";
const PLAN_SCHEMA_VERSION: u8 = 1;
const MAX_PROFILE_BYTES: u64 = 1024 * 1024;
const MAX_SKILL_MD_BYTES: usize = 100_000;
const MAX_API_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_PACKAGE_BASE64_BYTES: usize = 28_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum TeamMutationKind {
    Share,
    Unshare,
}

impl TeamMutationKind {
    fn preflight_command(self) -> &'static str {
        match self {
            Self::Share => SHARE_PREFLIGHT_COMMAND,
            Self::Unshare => UNSHARE_PREFLIGHT_COMMAND,
        }
    }

    fn apply_command(self) -> &'static str {
        match self {
            Self::Share => SHARE_APPLY_COMMAND,
            Self::Unshare => UNSHARE_APPLY_COMMAND,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum TeamMutationCommand {
    Preflight {
        kind: TeamMutationKind,
        local_skill_id: String,
        team_id: String,
    },
    Apply {
        kind: TeamMutationKind,
        local_skill_id: String,
        team_id: String,
        plan_digest: String,
    },
    Status {
        local_skill_id: String,
        team_id: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ServerPreparation {
    None,
    Import,
    UploadVersion,
    BlockedVersionConflict,
}

impl ServerPreparation {
    fn can_prepare(&self) -> bool {
        !matches!(self, Self::BlockedVersionConflict)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamMutationPlan {
    schema_version: u8,
    operation: TeamMutationKind,
    account_user_id: String,
    local_skill_id: String,
    team_id: String,
    profile_sha256: String,
    content_sha256: String,
    package_sha256: String,
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    git_head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_skill_id: Option<String>,
    server_preparation: ServerPreparation,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_current_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_current_package_sha256: Option<String>,
    currently_shared: bool,
    has_working_changes: bool,
    can_apply: bool,
}

impl TeamMutationPlan {
    fn digest(&self) -> Result<String, ()> {
        serde_json::to_vec(self)
            .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
            .map_err(|_| ())
    }
}

struct LocalShareContext {
    profile: SkillHubProfile,
    skill_md: Zeroizing<String>,
    package_base64: Zeroizing<String>,
    profile_sha256: String,
    content_sha256: String,
    package_sha256: String,
    git_head: Option<String>,
    working_copy_dirty: bool,
}

#[derive(Clone, Copy)]
struct TeamTarget<'a> {
    local_skill_id: &'a str,
    team_id: &'a str,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteVersion {
    id: String,
    version: String,
    #[serde(default)]
    package_sha256: Option<String>,
    #[serde(default)]
    package_size: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTeamShare {
    team_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnedSkillDetail {
    id: String,
    name: String,
    display_name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    trigger_scenarios: Vec<String>,
    #[serde(default)]
    compatible_agents: Vec<String>,
    author_id: String,
    current_version: String,
    #[serde(default)]
    versions: Vec<RemoteVersion>,
    #[serde(default)]
    team_shares: Vec<RemoteTeamShare>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamSummary {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportResponse {
    skill: ImportedSkill,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportedSkill {
    id: String,
    name: String,
    display_name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    trigger_scenarios: Vec<String>,
    #[serde(default)]
    compatible_agents: Vec<String>,
    author_id: String,
    current_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatedVersion {
    id: String,
    version: String,
    #[serde(default)]
    package_sha256: Option<String>,
}

struct HttpResponse {
    status: StatusCode,
    body: Vec<u8>,
}

impl Drop for HttpResponse {
    fn drop(&mut self) {
        self.body.zeroize();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResponseReadError {
    Offline,
    TooLarge,
    EndpointChanged,
}

enum ExactWriteError {
    Definitive(StatusCode),
    Unknown,
}

pub(crate) fn is_team_mutation_command(args: &[String]) -> bool {
    args.first().map(String::as_str) == Some("team")
        && matches!(args.get(1).map(String::as_str), Some("share" | "unshare"))
}

pub(crate) async fn execute_team_mutation_cli(args: &[String]) -> Option<CliCommandOutput> {
    if !is_team_mutation_command(args) {
        return None;
    }
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(command) => return Some(usage_failure(command)),
    };
    Some(match parsed {
        TeamMutationCommand::Preflight {
            kind,
            local_skill_id,
            team_id,
        } => execute_preflight(kind, local_skill_id, team_id).await,
        TeamMutationCommand::Apply {
            kind,
            local_skill_id,
            team_id,
            plan_digest,
        } => execute_apply(kind, local_skill_id, team_id, plan_digest).await,
        TeamMutationCommand::Status {
            local_skill_id,
            team_id,
        } => execute_status(local_skill_id, team_id).await,
    })
}

fn parse_args(args: &[String]) -> Result<TeamMutationCommand, &'static str> {
    let kind = match args.get(1).map(String::as_str) {
        Some("share") => TeamMutationKind::Share,
        Some("unshare") => TeamMutationKind::Unshare,
        _ => return Err(SHARE_PREFLIGHT_COMMAND),
    };
    let phase = args.get(2).map(String::as_str);
    let command = match (kind, phase) {
        (TeamMutationKind::Share, Some("preflight")) => SHARE_PREFLIGHT_COMMAND,
        (TeamMutationKind::Share, Some("apply")) => SHARE_APPLY_COMMAND,
        (TeamMutationKind::Share, Some("status")) => SHARE_STATUS_COMMAND,
        (TeamMutationKind::Unshare, Some("preflight")) => UNSHARE_PREFLIGHT_COMMAND,
        (TeamMutationKind::Unshare, Some("apply")) => UNSHARE_APPLY_COMMAND,
        (TeamMutationKind::Share, _) => return Err(SHARE_PREFLIGHT_COMMAND),
        (TeamMutationKind::Unshare, _) => return Err(UNSHARE_PREFLIGHT_COMMAND),
    };
    let mut local_skill_id = None;
    let mut team_id = None;
    let mut plan_digest = None;
    let mut json_requested = false;
    let mut index = 3;
    while index < args.len() {
        match args[index].as_str() {
            "--local-skill-id" if local_skill_id.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                if !valid_local_skill_id(value) {
                    return Err(command);
                }
                local_skill_id = Some(value.clone());
                index += 2;
            }
            "--team-id" if team_id.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                team_id = normalized_uuid(value);
                if team_id.is_none() {
                    return Err(command);
                }
                index += 2;
            }
            "--plan-digest" if plan_digest.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                plan_digest = normalized_digest(value);
                if plan_digest.is_none() {
                    return Err(command);
                }
                index += 2;
            }
            "--json" if !json_requested => {
                json_requested = true;
                index += 1;
            }
            _ => return Err(command),
        }
    }
    let local_skill_id = local_skill_id.ok_or(command)?;
    let team_id = team_id.ok_or(command)?;
    match phase {
        Some("preflight") if plan_digest.is_none() => Ok(TeamMutationCommand::Preflight {
            kind,
            local_skill_id,
            team_id,
        }),
        Some("apply") => Ok(TeamMutationCommand::Apply {
            kind,
            local_skill_id,
            team_id,
            plan_digest: plan_digest.ok_or(command)?,
        }),
        Some("status") if kind == TeamMutationKind::Share && plan_digest.is_none() => {
            Ok(TeamMutationCommand::Status {
                local_skill_id,
                team_id,
            })
        }
        _ => Err(command),
    }
}

fn normalized_uuid(value: &str) -> Option<String> {
    uuid::Uuid::parse_str(value)
        .ok()
        .map(|value| value.to_string())
}

fn normalized_digest(value: &str) -> Option<String> {
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

fn normalized_sha256(value: &str) -> Option<String> {
    normalized_digest(value)
}

fn valid_local_skill_id(value: &str) -> bool {
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

fn local_account() -> CliAccount {
    match CliAuthGuard::capture() {
        Ok(guard) if guard.token_for_request().is_ok() => {
            CliAccount::local(CliAccountState::Unverified, guard.user_id())
        }
        Ok(_) => CliAccount::state(CliAccountState::Guest),
        Err(_) => CliAccount::state(CliAccountState::Unknown),
    }
}

fn usage_failure(command: &'static str) -> CliCommandOutput {
    CliCommandOutput::failure(
        command,
        local_account(),
        CliErrorCode::ValidationFailed,
        TEAM_MUTATION_USAGE,
        EXIT_USAGE,
        Vec::new(),
    )
}

fn team_client(guard: &CliAuthGuard) -> Result<Client, String> {
    crate::net::client_builder(&guard.origin()?)?
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(90))
        .user_agent(concat!(
            "Yitan-SkillHub/",
            env!("CARGO_PKG_VERSION"),
            " cli-team"
        ))
        .build()
        .map_err(|_| "无法初始化 SkillHub Server 连接".to_string())
}

fn api_url(guard: &CliAuthGuard, path: &str) -> Result<Url, String> {
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
    let mut url = guard.origin()?;
    let base = url.path().trim_end_matches('/');
    url.set_path(&format!("{base}/api/{path}"));
    Ok(url)
}

async fn read_bounded_response(
    mut response: reqwest::Response,
) -> Result<HttpResponse, ResponseReadError> {
    if response.url().scheme() != "https" {
        return Err(ResponseReadError::EndpointChanged);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_API_RESPONSE_BYTES as u64)
    {
        return Err(ResponseReadError::TooLarge);
    }
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ResponseReadError::Offline)?
    {
        if body
            .len()
            .checked_add(chunk.len())
            .is_none_or(|length| length > MAX_API_RESPONSE_BYTES)
        {
            return Err(ResponseReadError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(HttpResponse { status, body })
}

async fn authenticated_request(
    client: &Client,
    method: Method,
    url: Url,
    token: &str,
    body: Option<&Value>,
) -> Result<HttpResponse, ResponseReadError> {
    let mut request = client
        .request(method, url.clone())
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CACHE_CONTROL, "no-store");
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| ResponseReadError::Offline)?;
    if response.url() != &url {
        return Err(ResponseReadError::EndpointChanged);
    }
    read_bounded_response(response).await
}

async fn authenticated_get(
    client: &Client,
    url: Url,
    token: &str,
) -> Result<HttpResponse, ResponseReadError> {
    authenticated_request(client, Method::GET, url, token, None).await
}

async fn authenticated_post(
    client: &Client,
    url: Url,
    token: &str,
    body: &Value,
) -> Result<HttpResponse, ResponseReadError> {
    authenticated_request(client, Method::POST, url, token, Some(body)).await
}

async fn authenticated_delete(
    client: &Client,
    url: Url,
    token: &str,
) -> Result<HttpResponse, ResponseReadError> {
    authenticated_request(client, Method::DELETE, url, token, None).await
}

/// Import and version creation are keyed by an exact package/content digest on
/// the Server. One bounded retry is therefore recovery of the same operation,
/// not a new write. Other mutating endpoints must use Server truth readback.
async fn authenticated_exact_post(
    client: &Client,
    guard: &CliAuthGuard,
    url: Url,
    token: &str,
    body: &Value,
) -> Result<HttpResponse, ExactWriteError> {
    for attempt in 0..2 {
        match authenticated_post(client, url.clone(), token, body).await {
            Ok(response) if response.status.is_success() => return Ok(response),
            Ok(response) if is_definitive_mutation_status(response.status) => {
                return Err(ExactWriteError::Definitive(response.status));
            }
            Ok(_) | Err(_) if attempt == 0 => {
                guard
                    .verify_current()
                    .map_err(|_| ExactWriteError::Unknown)?;
                continue;
            }
            Ok(_) | Err(_) => return Err(ExactWriteError::Unknown),
        }
    }
    Err(ExactWriteError::Unknown)
}

fn open_regular_file(path: &Path) -> Result<fs::File, ()> {
    let mut options = OpenOptions::new();
    options.read(true);
    options.custom_flags(crate::platform_fs::NOFOLLOW_FLAG);
    let file = options.open(path).map_err(|_| ())?;
    file.metadata()
        .map_err(|_| ())?
        .is_file()
        .then_some(file)
        .ok_or(())
}

fn read_bounded_regular(path: &Path, max_bytes: u64) -> Result<Vec<u8>, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > max_bytes {
        return Err(());
    }
    let mut file = open_regular_file(path)?;
    let opened = file.metadata().map_err(|_| ())?;
    if !opened.is_file() || opened.len() != metadata.len() || opened.len() > max_bytes {
        return Err(());
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    file.by_ref()
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > max_bytes {
        bytes.zeroize();
        return Err(());
    }
    Ok(bytes)
}

fn inferred_source(profile: &SkillHubProfile) -> AcquisitionSource {
    profile.acquisition_source.unwrap_or_else(|| {
        if profile.team_shared_from.is_some() || profile.is_own == Some(false) {
            AcquisitionSource::Team
        } else {
            AcquisitionSource::Local
        }
    })
}

fn valid_text(value: &str, max_chars: usize, multiline: bool) -> bool {
    !value.trim().is_empty()
        && value.trim() == value
        && value.chars().count() <= max_chars
        && value.chars().all(|character| {
            !character.is_control() || (multiline && matches!(character, '\n' | '\r' | '\t'))
        })
}

fn valid_optional_text(value: Option<&str>, max_chars: usize, multiline: bool) -> bool {
    value.is_none_or(|value| valid_text(value, max_chars, multiline))
}

fn valid_text_list(values: &[String], max_items: usize, max_chars: usize) -> bool {
    values.len() <= max_items
        && values
            .iter()
            .all(|value| valid_text(value, max_chars, false))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
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

fn valid_local_profile(profile: &SkillHubProfile, local_skill_id: &str) -> bool {
    // The sidecar `id` is the stable local identity (a UUID after import or
    // account sync); the directory name only locates the files. `name` is the
    // Agent projection name and is validated for shape, never for equality.
    crate::sidecar_identity_matches_directory(profile.id.as_deref(), local_skill_id)
        && profile.is_own == Some(true)
        && !profile.is_system
        && inferred_source(profile) == AcquisitionSource::Local
        && profile.name.as_deref().is_some_and(valid_local_skill_id)
        && profile
            .display_name
            .as_deref()
            .is_none_or(|value| valid_text(value, 80, false))
        && valid_optional_text(profile.description.as_deref(), 500, true)
        && valid_optional_text(profile.category.as_deref(), 100, false)
        && valid_text_list(&profile.labels, 100, 200)
        && valid_text_list(&profile.trigger_scenarios, 100, 500)
        && valid_text_list(&profile.compatible_agents, 32, 128)
        && profile.compatible_agents.iter().all(|agent| {
            matches!(
                agent.as_str(),
                "claude"
                    | "codex"
                    | "agent-skills"
                    | "workbuddy"
                    | "workbuddy-ai"
                    | "doubao"
                    | "opencode"
                    | "openclaw"
                    | "gemini"
                    | "trae"
            )
        })
        && profile.env_dependencies.len() <= 100
        && profile.env_dependencies.iter().all(|dependency| {
            valid_env_key(&dependency.key)
                && dependency.description.as_deref().is_none_or(|description| {
                    description.trim() == description && valid_text(description, 200, true)
                })
        })
        && profile
            .env_dependencies
            .iter()
            .map(|dependency| &dependency.key)
            .collect::<HashSet<_>>()
            .len()
            == profile.env_dependencies.len()
}

fn generated_git_path(path: &Path) -> bool {
    path.components().any(|component| {
        let std::path::Component::Normal(name) = component else {
            return false;
        };
        matches!(
            name.to_string_lossy().to_ascii_lowercase().as_str(),
            ".git" | "node_modules" | "target" | "dist" | "build" | "__pycache__" | ".ds_store"
        )
    })
}

fn git_state(root: &Path) -> (Option<String>, bool) {
    let Ok(repository) = Repository::open(root) else {
        return (None, true);
    };
    let head = repository
        .head()
        .and_then(|head| head.peel_to_commit())
        .map(|commit| commit.id().to_string())
        .ok();
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let dirty = repository
        .statuses(Some(&mut options))
        .map_or(true, |statuses| {
            statuses.iter().any(|entry| {
                entry.path().map_or(true, |path| {
                    let relative = Path::new(path);
                    relative != Path::new(".skillhub.json") && !generated_git_path(relative)
                })
            })
        });
    (head, dirty)
}

fn read_profile(local_skill_id: &str) -> Result<(SkillHubProfile, String), ()> {
    let managed_root = crate::skills_dir();
    let managed_metadata = fs::symlink_metadata(&managed_root).map_err(|_| ())?;
    if managed_metadata.file_type().is_symlink() || !managed_metadata.is_dir() {
        return Err(());
    }
    let root = managed_root.join(local_skill_id);
    let root_metadata = fs::symlink_metadata(&root).map_err(|_| ())?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(());
    }
    let bytes = read_bounded_regular(&root.join(".skillhub.json"), MAX_PROFILE_BYTES)?;
    let profile_sha256 = format!("{:x}", Sha256::digest(&bytes));
    let envelope = serde_json::from_slice::<SkillHubJson>(&bytes).map_err(|_| ())?;
    let profile = envelope.skillhub.ok_or(())?;
    if !crate::spaces::current_profile_matches(&profile).map_err(|_| ())? {
        return Err(());
    }
    valid_local_profile(&profile, local_skill_id)
        .then_some((profile, profile_sha256))
        .ok_or(())
}

#[derive(Debug, PartialEq, Eq)]
enum LocalContextError {
    Invalid,
    Unversioned,
}

impl From<()> for LocalContextError {
    fn from(_: ()) -> Self {
        Self::Invalid
    }
}

fn resolve_local_version(
    root: &Path,
    profile: &mut SkillHubProfile,
    require_version: bool,
) -> Result<(), LocalContextError> {
    // The sidecar's display version can still contain a legacy label. Only a
    // saved mapping for the actual current content authorizes a formal write.
    let current = crate::version_policy::current(root, &profile.version_metadata)
        .filter(|mapping| crate::version_policy::ordinal(&mapping.label).is_some());
    profile.version = match current {
        Some(mapping) => mapping.label,
        None if require_version => return Err(LocalContextError::Unversioned),
        None => String::new(),
    };
    Ok(())
}

async fn load_local_context(
    local_skill_id: &str,
    account_user_id: &str,
    require_version: bool,
) -> Result<LocalShareContext, LocalContextError> {
    let (mut profile, profile_sha256) = read_profile(local_skill_id)?;
    let account_user_id = normalized_uuid(account_user_id).ok_or(())?;
    let server_id = match profile.server_id.as_deref() {
        Some(value) => Some(normalized_uuid(value).ok_or(())?),
        None => None,
    };
    let server_owner_id = match profile.server_owner_id.as_deref() {
        Some(value) => Some(normalized_uuid(value).ok_or(())?),
        None => None,
    };
    if server_id.is_some() != server_owner_id.is_some()
        || server_owner_id
            .as_deref()
            .is_some_and(|owner_id| owner_id != account_user_id)
    {
        return Err(LocalContextError::Invalid);
    }
    let root = crate::skills_dir().join(local_skill_id);
    resolve_local_version(&root, &mut profile, require_version)?;
    let skill_md_bytes = read_bounded_regular(&root.join("SKILL.md"), MAX_SKILL_MD_BYTES as u64)?;
    let skill_md = String::from_utf8(skill_md_bytes).map_err(|_| ())?;
    if skill_md.trim().is_empty() {
        return Err(LocalContextError::Invalid);
    }
    let package = crate::commands::create_skill_package(local_skill_id.to_string())
        .await
        .map_err(|_| ())?;
    if package.base64.len() > MAX_PACKAGE_BASE64_BYTES
        || normalized_sha256(&package.sha256).as_deref() != Some(package.sha256.as_str())
        || package.size == 0
        || package.size > 20 * 1024 * 1024
    {
        return Err(LocalContextError::Invalid);
    }
    let (git_head, working_copy_dirty) = git_state(&root);
    Ok(LocalShareContext {
        profile,
        skill_md: Zeroizing::new(skill_md.clone()),
        package_base64: Zeroizing::new(package.base64),
        profile_sha256,
        content_sha256: format!("{:x}", Sha256::digest(skill_md.as_bytes())),
        package_sha256: package.sha256,
        git_head,
        working_copy_dirty,
    })
}

fn validate_remote(detail: OwnedSkillDetail, expected_owner: &str) -> Result<OwnedSkillDetail, ()> {
    if normalized_uuid(&detail.id).as_deref() != Some(detail.id.as_str())
        || normalized_uuid(&detail.author_id).as_deref() != Some(expected_owner)
        || !valid_local_skill_id(&detail.name)
        || !valid_text(&detail.display_name, 80, false)
        || !valid_optional_text(detail.description.as_deref(), 500, true)
        || !valid_optional_text(detail.category.as_deref(), 100, false)
        || !valid_text_list(&detail.labels, 100, 200)
        || !valid_text_list(&detail.trigger_scenarios, 100, 500)
        || !valid_text_list(&detail.compatible_agents, 32, 128)
        || !valid_text(&detail.current_version, 40, false)
        || detail.versions.len() > 1_000
        || detail.team_shares.len() > 1_000
        || !detail.versions.iter().all(|version| {
            normalized_uuid(&version.id).as_deref() == Some(version.id.as_str())
                && valid_text(&version.version, 40, false)
                && version
                    .package_sha256
                    .as_deref()
                    .is_none_or(|sha| normalized_sha256(sha).as_deref() == Some(sha))
                && version
                    .package_size
                    .is_none_or(|size| size > 0 && size <= 20 * 1024 * 1024)
        })
        || !detail
            .team_shares
            .iter()
            .all(|share| normalized_uuid(&share.team_id).as_deref() == Some(share.team_id.as_str()))
    {
        return Err(());
    }
    Ok(detail)
}

fn parse_remote(
    body: &[u8],
    expected_id: &str,
    expected_owner: &str,
) -> Result<OwnedSkillDetail, ()> {
    let detail = serde_json::from_slice::<OwnedSkillDetail>(body).map_err(|_| ())?;
    if detail.id != expected_id {
        return Err(());
    }
    validate_remote(detail, expected_owner)
}

fn team_ids(detail: &OwnedSkillDetail) -> Vec<String> {
    let mut ids = detail
        .team_shares
        .iter()
        .map(|share| share.team_id.clone())
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    ids
}

fn current_remote_version(detail: &OwnedSkillDetail) -> Option<&RemoteVersion> {
    let mut matches = detail
        .versions
        .iter()
        .filter(|version| version.version == detail.current_version);
    let current = matches.next()?;
    matches.next().is_none().then_some(current)
}

fn plan_for(
    kind: TeamMutationKind,
    local_skill_id: &str,
    team_id: &str,
    account_user_id: &str,
    local: &LocalShareContext,
    remote: Option<&OwnedSkillDetail>,
) -> TeamMutationPlan {
    let currently_shared = remote.is_some_and(|detail| {
        detail
            .team_shares
            .iter()
            .any(|share| share.team_id == team_id)
    });
    let (server_preparation, current_version, current_package) = match remote {
        None => (ServerPreparation::Import, None, None),
        Some(detail) => {
            let current = current_remote_version(detail);
            let current_version = Some(detail.current_version.clone());
            let current_package = current.and_then(|version| version.package_sha256.clone());
            let matching = detail
                .versions
                .iter()
                .filter(|version| version.version == local.profile.version)
                .collect::<Vec<_>>();
            let preparation = if matching.is_empty() {
                ServerPreparation::UploadVersion
            } else if matching.len() == 1
                && matching[0].package_sha256.as_deref() == Some(local.package_sha256.as_str())
                && detail.current_version == local.profile.version
            {
                ServerPreparation::None
            } else {
                ServerPreparation::BlockedVersionConflict
            };
            (preparation, current_version, current_package)
        }
    };
    let preparation = if kind == TeamMutationKind::Unshare {
        ServerPreparation::None
    } else {
        server_preparation
    };
    let can_apply = match kind {
        TeamMutationKind::Share => {
            preparation.can_prepare()
                && (!matches!(
                    preparation,
                    ServerPreparation::Import | ServerPreparation::UploadVersion
                ) || (!local.working_copy_dirty && local.git_head.is_some()))
        }
        TeamMutationKind::Unshare => remote.is_some(),
    };
    TeamMutationPlan {
        schema_version: PLAN_SCHEMA_VERSION,
        operation: kind,
        account_user_id: account_user_id.to_string(),
        local_skill_id: local_skill_id.to_string(),
        team_id: team_id.to_string(),
        profile_sha256: local.profile_sha256.clone(),
        content_sha256: local.content_sha256.clone(),
        package_sha256: local.package_sha256.clone(),
        version: local.profile.version.clone(),
        git_head: local.git_head.clone(),
        server_skill_id: remote.map(|detail| detail.id.clone()),
        server_preparation: preparation,
        remote_current_version: current_version,
        remote_current_package_sha256: current_package,
        currently_shared,
        has_working_changes: local.working_copy_dirty,
        can_apply,
    }
}

async fn verified_guard(
    command: &'static str,
) -> Result<(CliAuthGuard, CliAccount), CliCommandOutput> {
    let guard =
        CliAuthGuard::capture_for_server().map_err(|error| auth_guard_failure(command, error))?;
    guard
        .token_for_request()
        .map_err(|error| auth_guard_failure(command, error))?;
    let account = verify_account_with_server(&guard)
        .await
        .map_err(|error| account_verification_failure(command, &guard, error))?;
    Ok((guard, account))
}

fn operation_unknown(
    command: &'static str,
    guard: &CliAuthGuard,
    account: CliAccount,
    message: &'static str,
    local_skill_id: &str,
    team_id: &str,
) -> CliCommandOutput {
    let account = if guard.verify_current().is_ok() {
        account
    } else {
        CliAccount::state(CliAccountState::Unknown)
    };
    CliCommandOutput::failure(
        command,
        account,
        CliErrorCode::OperationOutcomeUnknown,
        message,
        EXIT_NETWORK,
        vec![format!(
            "先运行 skillhub team share status --local-skill-id {local_skill_id} --team-id {team_id} --json 复核 Server 状态；确认前不要重试 apply"
        )],
    )
}

fn import_outcome_unknown(
    command: &'static str,
    guard: &CliAuthGuard,
    account: CliAccount,
    message: &'static str,
) -> CliCommandOutput {
    let account = if guard.verify_current().is_ok() {
        account
    } else {
        CliAccount::state(CliAccountState::Unknown)
    };
    CliCommandOutput::failure(
        command,
        account,
        CliErrorCode::OperationOutcomeUnknown,
        message,
        EXIT_NETWORK,
        vec![
            "该导入端点以固定版本和包摘要幂等；请原样重试同一条 apply，让 Server 返回同一资产并补齐本地绑定"
                .into(),
        ],
    )
}

fn read_failure(
    command: &'static str,
    guard: &CliAuthGuard,
    account: CliAccount,
    error: ResponseReadError,
) -> CliCommandOutput {
    if let Err(auth_error) = guard.verify_current() {
        return auth_guard_failure(command, auth_error);
    }
    let (code, message, exit_code) = match error {
        ResponseReadError::Offline => (
            CliErrorCode::Offline,
            "暂时无法连接 SkillHub Server",
            EXIT_NETWORK,
        ),
        ResponseReadError::TooLarge => (
            CliErrorCode::InternalError,
            "SkillHub Server 响应超过安全上限",
            EXIT_INTERNAL,
        ),
        ResponseReadError::EndpointChanged => (
            CliErrorCode::InternalError,
            "SkillHub Server 端点发生了未授权变化",
            EXIT_INTERNAL,
        ),
    };
    CliCommandOutput::failure(
        command,
        account,
        code,
        message,
        exit_code,
        vec!["请检查网络和 SkillHub Server 状态后重新预检".into()],
    )
}

fn definitive_response_failure(
    command: &'static str,
    guard: &CliAuthGuard,
    account: CliAccount,
    status: StatusCode,
) -> CliCommandOutput {
    if status == StatusCode::UNAUTHORIZED {
        return auth_guard_failure(command, guard.invalidate_unauthorized());
    }
    if let Err(error) = guard.verify_current() {
        return auth_guard_failure(command, error);
    }
    let (code, message, exit_code, actions) = match status {
        StatusCode::FORBIDDEN => (
            CliErrorCode::PermissionDenied,
            "当前账号无权访问目标团队或 Server Skill",
            EXIT_AUTH,
            vec!["请在 SkillHub APP 中核对账号、Skill 所属与团队成员状态".into()],
        ),
        StatusCode::NOT_FOUND | StatusCode::GONE => (
            CliErrorCode::NotFound,
            "目标团队或 Server Skill 已不存在",
            EXIT_CONFLICT,
            vec!["请在 SkillHub APP 中刷新，再重新运行 preflight".into()],
        ),
        StatusCode::CONFLICT => (
            CliErrorCode::Conflict,
            "Server 拒绝了冲突的 Skill 版本或共享状态",
            EXIT_CONFLICT,
            vec!["请创建新的本地版本或刷新共享状态后重新预检".into()],
        ),
        StatusCode::TOO_MANY_REQUESTS => (
            CliErrorCode::ValidationFailed,
            "Server 暂时限制了写入频率",
            EXIT_NETWORK,
            vec!["请等待限流窗口结束后重新运行 preflight".into()],
        ),
        StatusCode::PAYLOAD_TOO_LARGE
        | StatusCode::BAD_REQUEST
        | StatusCode::UNPROCESSABLE_ENTITY => (
            CliErrorCode::ValidationFailed,
            "Server 拒绝了本地 Skill 包或共享参数",
            EXIT_CONFLICT,
            vec!["请在 SkillHub APP 中检查 Skill 内容与版本，再重新预检".into()],
        ),
        _ => (
            CliErrorCode::InternalError,
            "SkillHub Server 暂时无法完成请求",
            EXIT_INTERNAL,
            vec!["请稍后重新运行 preflight".into()],
        ),
    };
    CliCommandOutput::failure(command, account, code, message, exit_code, actions)
}

fn is_definitive_mutation_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::BAD_REQUEST
            | StatusCode::UNAUTHORIZED
            | StatusCode::FORBIDDEN
            | StatusCode::NOT_FOUND
            | StatusCode::CONFLICT
            | StatusCode::GONE
            | StatusCode::PAYLOAD_TOO_LARGE
            | StatusCode::UNPROCESSABLE_ENTITY
            | StatusCode::TOO_MANY_REQUESTS
    )
}

fn local_failure(command: &'static str, account: CliAccount) -> CliCommandOutput {
    CliCommandOutput::failure(
        command,
        account,
        CliErrorCode::ValidationFailed,
        "只有当前账号拥有的非系统本地 Skill 可以管理团队共享",
        EXIT_CONFLICT,
        vec!["请在 SkillHub APP 中核对 Skill 来源、所属账号和本地版本状态".into()],
    )
}

fn local_context_failure(
    command: &'static str,
    account: CliAccount,
    error: LocalContextError,
) -> CliCommandOutput {
    if error == LocalContextError::Unversioned {
        CliCommandOutput::failure(
            command,
            account,
            CliErrorCode::ValidationFailed,
            "当前内容尚未保存为本机版本，请先保存本机版本再共享",
            EXIT_CONFLICT,
            vec!["请在 SkillHub APP 的版本历史中保存当前内容，再重新执行共享预检".into()],
        )
    } else {
        local_failure(command, account)
    }
}

fn configuration_failure(command: &'static str, account: CliAccount) -> CliCommandOutput {
    CliCommandOutput::failure(
        command,
        account,
        CliErrorCode::InternalError,
        "SkillHub 服务地址配置无效",
        EXIT_INTERNAL,
        Vec::new(),
    )
}

async fn fetch_remote(
    command: &'static str,
    client: &Client,
    guard: &CliAuthGuard,
    account: CliAccount,
    profile: &SkillHubProfile,
) -> Result<Option<OwnedSkillDetail>, CliCommandOutput> {
    let Some(server_id) = profile.server_id.as_deref() else {
        return Ok(None);
    };
    let server_id =
        normalized_uuid(server_id).ok_or_else(|| local_failure(command, account.clone()))?;
    let url = api_url(guard, &format!("skills/{server_id}"))
        .map_err(|_| configuration_failure(command, account.clone()))?;
    let token = guard
        .token_for_request()
        .map_err(|error| auth_guard_failure(command, error))?;
    let response = authenticated_get(client, url, token)
        .await
        .map_err(|error| read_failure(command, guard, account.clone(), error))?;
    if !response.status.is_success() {
        return Err(definitive_response_failure(
            command,
            guard,
            account,
            response.status,
        ));
    }
    let detail = parse_remote(&response.body, &server_id, guard.user_id()).map_err(|_| {
        CliCommandOutput::failure(
            command,
            account.clone(),
            CliErrorCode::InternalError,
            "SkillHub Server 返回了无效的 Skill 所属或版本资料",
            EXIT_INTERNAL,
            Vec::new(),
        )
    })?;
    guard
        .verify_current()
        .map_err(|error| auth_guard_failure(command, error))?;
    Ok(Some(detail))
}

async fn fetch_remote_by_id(
    client: &Client,
    guard: &CliAuthGuard,
    server_skill_id: &str,
) -> Result<OwnedSkillDetail, ()> {
    let server_skill_id = normalized_uuid(server_skill_id).ok_or(())?;
    let url = api_url(guard, &format!("skills/{server_skill_id}")).map_err(|_| ())?;
    let token = guard.token_for_request().map_err(|_| ())?;
    let response = authenticated_get(client, url, token)
        .await
        .map_err(|_| ())?;
    if !response.status.is_success() {
        return Err(());
    }
    let detail = parse_remote(&response.body, &server_skill_id, guard.user_id())?;
    guard.verify_current().map_err(|_| ())?;
    Ok(detail)
}

async fn verify_team_membership(
    command: &'static str,
    client: &Client,
    guard: &CliAuthGuard,
    account: CliAccount,
    team_id: &str,
) -> Result<(), CliCommandOutput> {
    let url =
        api_url(guard, "teams").map_err(|_| configuration_failure(command, account.clone()))?;
    let token = guard
        .token_for_request()
        .map_err(|error| auth_guard_failure(command, error))?;
    let response = authenticated_get(client, url, token)
        .await
        .map_err(|error| read_failure(command, guard, account.clone(), error))?;
    if !response.status.is_success() {
        return Err(definitive_response_failure(
            command,
            guard,
            account,
            response.status,
        ));
    }
    let teams = serde_json::from_slice::<Vec<TeamSummary>>(&response.body).map_err(|_| {
        CliCommandOutput::failure(
            command,
            account.clone(),
            CliErrorCode::InternalError,
            "SkillHub Server 返回了无效的团队列表",
            EXIT_INTERNAL,
            Vec::new(),
        )
    })?;
    if teams.len() > 1_000
        || teams
            .iter()
            .any(|team| normalized_uuid(&team.id).as_deref() != Some(team.id.as_str()))
    {
        return Err(CliCommandOutput::failure(
            command,
            account,
            CliErrorCode::InternalError,
            "SkillHub Server 返回了无效的团队列表",
            EXIT_INTERNAL,
            Vec::new(),
        ));
    }
    if !teams.iter().any(|team| team.id == team_id) {
        return Err(CliCommandOutput::failure(
            command,
            account,
            CliErrorCode::PermissionDenied,
            "当前账号不是目标团队的有效成员",
            EXIT_AUTH,
            vec!["请先在 SkillHub APP 中加入该团队".into()],
        ));
    }
    guard
        .verify_current()
        .map_err(|error| auth_guard_failure(command, error))
}

async fn build_current_plan(
    kind: TeamMutationKind,
    command: &'static str,
    local_skill_id: &str,
    team_id: &str,
    guard: &CliAuthGuard,
    account: CliAccount,
    client: &Client,
) -> Result<
    (
        LocalShareContext,
        Option<OwnedSkillDetail>,
        TeamMutationPlan,
    ),
    CliCommandOutput,
> {
    let local = load_local_context(
        local_skill_id,
        guard.user_id(),
        kind == TeamMutationKind::Share,
    )
    .await
    .map_err(|error| local_context_failure(command, account.clone(), error))?;
    if kind == TeamMutationKind::Share {
        verify_team_membership(command, client, guard, account.clone(), team_id).await?;
    }
    let remote = fetch_remote(command, client, guard, account.clone(), &local.profile).await?;
    let plan = plan_for(
        kind,
        local_skill_id,
        team_id,
        guard.user_id(),
        &local,
        remote.as_ref(),
    );
    Ok((local, remote, plan))
}

fn preflight_output(account: CliAccount, plan: &TeamMutationPlan) -> CliCommandOutput {
    let command = plan.operation.preflight_command();
    let digest = match plan.digest() {
        Ok(digest) => digest,
        Err(()) => {
            return CliCommandOutput::failure(
                command,
                account,
                CliErrorCode::InternalError,
                "无法生成团队共享预检摘要",
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let mut warnings = Vec::new();
    if matches!(
        plan.server_preparation,
        ServerPreparation::Import | ServerPreparation::UploadVersion
    ) && plan.has_working_changes
    {
        warnings.push("本地工作副本有未提交改动；请先创建可恢复版本快照，再重新预检".into());
    }
    if plan.server_preparation == ServerPreparation::BlockedVersionConflict {
        warnings.push("Server 已有同名版本但包内容不同，拒绝覆盖或重用该版本号".into());
    }
    if plan.operation == TeamMutationKind::Unshare && !plan.currently_shared {
        warnings.push("Server 当前已经没有该团队共享；apply 只会回读并同步本地状态".into());
    }
    let next_actions = if plan.can_apply {
        vec![format!(
            "确认后执行 skillhub {} apply --local-skill-id {} --team-id {} --plan-digest {} --json",
            match plan.operation {
                TeamMutationKind::Share => "team share",
                TeamMutationKind::Unshare => "team unshare",
            },
            plan.local_skill_id,
            plan.team_id,
            digest
        )]
    } else {
        vec!["先处理本地快照、Server 版本冲突或云端绑定，再重新运行 preflight".into()]
    };
    CliCommandOutput::success(
        command,
        account,
        json!({
            "phase": "preflight",
            "operation": plan.operation,
            "localSkillId": plan.local_skill_id,
            "teamId": plan.team_id,
            "serverSkillId": plan.server_skill_id,
            "version": plan.version,
            "packageSha256": plan.package_sha256,
            "gitHead": plan.git_head,
            "serverPreparation": plan.server_preparation,
            "remoteCurrentVersion": plan.remote_current_version,
            "remoteCurrentPackageSha256": plan.remote_current_package_sha256,
            "currentlyShared": plan.currently_shared,
            "localModified": plan.has_working_changes,
            "canApply": plan.can_apply,
            "planDigest": digest,
        }),
        warnings,
        next_actions,
    )
}

async fn execute_preflight(
    kind: TeamMutationKind,
    local_skill_id: String,
    team_id: String,
) -> CliCommandOutput {
    let command = kind.preflight_command();
    let (guard, account) = match verified_guard(command).await {
        Ok(value) => value,
        Err(output) => return output,
    };
    let client = match team_client(&guard) {
        Ok(client) => client,
        Err(message) => {
            return CliCommandOutput::failure(
                command,
                account,
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let (_, _, plan) = match build_current_plan(
        kind,
        command,
        &local_skill_id,
        &team_id,
        &guard,
        account.clone(),
        &client,
    )
    .await
    {
        Ok(value) => value,
        Err(output) => return output,
    };
    if let Err(error) = guard.verify_current() {
        return auth_guard_failure(command, error);
    }
    preflight_output(account, &plan)
}

async fn execute_status(local_skill_id: String, team_id: String) -> CliCommandOutput {
    let (guard, account) = match verified_guard(SHARE_STATUS_COMMAND).await {
        Ok(value) => value,
        Err(output) => return output,
    };
    let client = match team_client(&guard) {
        Ok(client) => client,
        Err(message) => {
            return CliCommandOutput::failure(
                SHARE_STATUS_COMMAND,
                account,
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let (profile, _) = match read_profile(&local_skill_id) {
        Ok(local) => local,
        Err(()) => return local_failure(SHARE_STATUS_COMMAND, account),
    };
    let remote = match fetch_remote(
        SHARE_STATUS_COMMAND,
        &client,
        &guard,
        account.clone(),
        &profile,
    )
    .await
    {
        Ok(remote) => remote,
        Err(output) => return output,
    };
    if remote.is_none() {
        return CliCommandOutput::failure(
            SHARE_STATUS_COMMAND,
            account,
            CliErrorCode::ValidationFailed,
            "该本地 Skill 尚未绑定 Server 资产，无法查询团队共享真相",
            EXIT_CONFLICT,
            vec!["先运行 team share preflight；如需共享，由用户确认后执行 apply".into()],
        );
    }
    if let Err(error) = guard.verify_current() {
        return auth_guard_failure(SHARE_STATUS_COMMAND, error);
    }
    let shared = remote.as_ref().is_some_and(|detail| {
        detail
            .team_shares
            .iter()
            .any(|share| share.team_id == team_id)
    });
    let current = remote.as_ref().and_then(current_remote_version);
    CliCommandOutput::success(
        SHARE_STATUS_COMMAND,
        account,
        json!({
            "localSkillId": local_skill_id,
            "teamId": team_id,
            "serverSkillId": remote.as_ref().map(|detail| detail.id.as_str()),
            "shared": shared,
            "serverCurrentVersion": remote.as_ref().map(|detail| detail.current_version.as_str()),
            "serverCurrentPackageSha256": current.and_then(|version| version.package_sha256.as_deref()),
            "serverConfirmed": true,
        }),
        Vec::new(),
        Vec::new(),
    )
}

fn safe_env_dependencies(profile: &SkillHubProfile) -> Vec<Value> {
    profile
        .env_dependencies
        .iter()
        .map(|dependency| {
            json!({
                "key": dependency.key,
                "description": dependency.description,
                "required": dependency.required,
            })
        })
        .collect()
}

fn valid_imported_skill(
    skill: &ImportedSkill,
    local: &LocalShareContext,
    account_user_id: &str,
) -> bool {
    normalized_uuid(&skill.id).as_deref() == Some(skill.id.as_str())
        && normalized_uuid(&skill.author_id).as_deref() == Some(account_user_id)
        && local.profile.name.as_deref() == Some(skill.name.as_str())
        && local.profile.version == skill.current_version
        && valid_text(&skill.display_name, 80, false)
        && valid_optional_text(skill.description.as_deref(), 500, true)
        && valid_optional_text(skill.category.as_deref(), 100, false)
        && valid_text_list(&skill.labels, 100, 200)
        && valid_text_list(&skill.trigger_scenarios, 100, 500)
        && valid_text_list(&skill.compatible_agents, 32, 128)
}

async fn import_skill(
    command: &'static str,
    client: &Client,
    guard: &CliAuthGuard,
    account: CliAccount,
    local: &LocalShareContext,
) -> Result<ImportedSkill, CliCommandOutput> {
    let url = api_url(guard, "skills/import")
        .map_err(|_| configuration_failure(command, account.clone()))?;
    let token = guard
        .token_for_request()
        .map_err(|error| auth_guard_failure(command, error))?;
    let body = json!({
        "name": local.profile.name,
        "skillMd": local.skill_md.as_str(),
        "compatibleAgents": local.profile.compatible_agents,
        "envDependencies": safe_env_dependencies(&local.profile),
        "currentVersion": local.profile.version,
        "aiAnalysisConsent": true,
        "packageBase64": local.package_base64.as_str(),
        "packageSha256": local.package_sha256,
    });
    let response = match authenticated_exact_post(client, guard, url, token, &body).await {
        Ok(response) => response,
        Err(ExactWriteError::Definitive(status)) => {
            return Err(definitive_response_failure(command, guard, account, status))
        }
        Err(ExactWriteError::Unknown) => {
            return Err(import_outcome_unknown(
                command,
                guard,
                account,
                "Server 导入响应连续中断；已安全重试同一幂等请求一次，最终结果仍未知",
            ))
        }
    };
    let response = serde_json::from_slice::<ImportResponse>(&response.body).map_err(|_| {
        import_outcome_unknown(
            command,
            guard,
            account.clone(),
            "Server 已接受 Skill 导入，但响应无法安全验证；请仅按幂等恢复流程重试",
        )
    })?;
    if !valid_imported_skill(&response.skill, local, guard.user_id()) {
        return Err(import_outcome_unknown(
            command,
            guard,
            account,
            "Server 已接受 Skill 导入，但返回的归属或版本不匹配；请仅按幂等恢复流程重试",
        ));
    }
    Ok(response.skill)
}

async fn upload_version(
    command: &'static str,
    client: &Client,
    guard: &CliAuthGuard,
    account: CliAccount,
    target: TeamTarget<'_>,
    server_skill_id: &str,
    local: &LocalShareContext,
) -> Result<(), CliCommandOutput> {
    let url = api_url(guard, &format!("skills/{server_skill_id}/versions"))
        .map_err(|_| configuration_failure(command, account.clone()))?;
    let token = guard
        .token_for_request()
        .map_err(|error| auth_guard_failure(command, error))?;
    let mut body = json!({
        "version": local.profile.version,
        "gitHash": local.git_head,
        "skillMd": local.skill_md.as_str(),
        "envDependencies": safe_env_dependencies(&local.profile),
        "packageBase64": local.package_base64.as_str(),
        "packageSha256": local.package_sha256,
    });
    if let Some(receipt) = local
        .profile
        .version_metadata
        .current_receipt
        .as_ref()
        .filter(|receipt| {
            receipt.label == local.profile.version
                && receipt.card_sha256 == local.package_sha256
                && local.profile.library_account_id.as_deref() == Some(guard.user_id())
                && local.profile.version_metadata.account_id.as_deref() == Some(guard.user_id())
        })
    {
        body["libraryVersionReceiptId"] = json!(receipt.receipt_id);
    }
    let response = match authenticated_exact_post(client, guard, url, token, &body).await {
        Ok(response) => response,
        Err(ExactWriteError::Definitive(status)) => {
            return Err(definitive_response_failure(command, guard, account, status))
        }
        Err(ExactWriteError::Unknown) => {
            return Err(operation_unknown(
                command,
                guard,
                account,
                "Server 版本上传响应连续中断，且回读未能确认固定包；禁止盲目重试",
                target.local_skill_id,
                target.team_id,
            ));
        }
    };
    let created = serde_json::from_slice::<CreatedVersion>(&response.body)
        .ok()
        .filter(|created| {
            normalized_uuid(&created.id).as_deref() == Some(created.id.as_str())
                && created.version == local.profile.version
                && created.package_sha256.as_deref() == Some(local.package_sha256.as_str())
        })
        .ok_or_else(|| {
            operation_unknown(
                command,
                guard,
                account.clone(),
                "Server 已接受版本但未返回可核验的稳定身份，禁止按标签或包推断成功",
                target.local_skill_id,
                target.team_id,
            )
        })?;
    crate::library_sync::record_skill_formal_version(
        target.local_skill_id.into(),
        created.id,
        local.git_head.clone(),
        None,
    )
    .await
    .map_err(|_| {
        operation_unknown(
            command,
            guard,
            account,
            "正式版本已创建，本机版本映射未完成；核验正式 ID 后补全，勿重新发布",
            target.local_skill_id,
            target.team_id,
        )
    })?;
    Ok(())
}

fn persist_import_binding(
    command: &'static str,
    guard: &CliAuthGuard,
    account: CliAccount,
    local_skill_id: &str,
    team_id: &str,
    expected_profile_sha256: &str,
    imported: &ImportedSkill,
) -> Result<(), CliCommandOutput> {
    let _lease = guard
        .acquire_current_lease()
        .map_err(|error| auth_guard_failure(command, error))?;
    let (_, observed_sha256) = read_profile(local_skill_id).map_err(|_| {
        operation_unknown(
            command,
            guard,
            account.clone(),
            "Server 已导入 Skill，但本地 Profile 无法安全读取，禁止自动重试",
            local_skill_id,
            team_id,
        )
    })?;
    if observed_sha256 != expected_profile_sha256 {
        return Err(operation_unknown(
            command,
            guard,
            account,
            "Server 已导入 Skill，但本地 Profile 同时发生变化，未覆盖本地资料",
            local_skill_id,
            team_id,
        ));
    }
    crate::commands::update_skill_profile(
        crate::server_request::SpaceRegistry::handle(Some(guard.session())),
        local_skill_id.to_string(),
        SkillProfileUpdateInput {
            // Server responses never overwrite a hand-filled source (#329).
            source_url: None,
            cleared_source_url: None,
            server_id: Some(imported.id.clone()),
            server_owner_id: Some(imported.author_id.clone()),
            display_name: Some(imported.display_name.clone()),
            description: imported.description.clone(),
            category: imported.category.clone(),
            labels: imported.labels.clone(),
            trigger_scenarios: imported.trigger_scenarios.clone(),
            compatible_agents: imported.compatible_agents.clone(),
            version: Some(imported.current_version.clone()),
        },
    )
    .map(|_| ())
    .map_err(|_| {
        operation_unknown(
            command,
            guard,
            account,
            "Server 已导入 Skill，但本地绑定写入失败，禁止自动重试",
            local_skill_id,
            team_id,
        )
    })
}

async fn set_share_state(
    command: &'static str,
    client: &Client,
    guard: &CliAuthGuard,
    account: CliAccount,
    target: TeamTarget<'_>,
    server_skill_id: &str,
    desired_shared: bool,
) -> Result<(), CliCommandOutput> {
    let token = guard
        .token_for_request()
        .map_err(|error| auth_guard_failure(command, error))?;
    let response = if desired_shared {
        let url = api_url(guard, &format!("skills/{server_skill_id}/shares"))
            .map_err(|_| configuration_failure(command, account.clone()))?;
        let body = json!({ "teamId": target.team_id });
        authenticated_post(client, url, token, &body).await
    } else {
        let url = api_url(
            guard,
            &format!("skills/{server_skill_id}/shares/{}", target.team_id),
        )
        .map_err(|_| configuration_failure(command, account.clone()))?;
        authenticated_delete(client, url, token).await
    };
    match response {
        Ok(response) if response.status.is_success() => Ok(()),
        Ok(response) if is_definitive_mutation_status(response.status) => Err(
            definitive_response_failure(command, guard, account, response.status),
        ),
        Ok(_) | Err(_) => {
            let recovered = fetch_remote_by_id(client, guard, server_skill_id)
                .await
                .is_ok_and(|detail| {
                    detail
                        .team_shares
                        .iter()
                        .any(|share| share.team_id == target.team_id)
                        == desired_shared
                });
            if recovered {
                return Ok(());
            }
            Err(operation_unknown(
                command,
                guard,
                account,
                "Server 共享写入响应异常，且真相回读未能确认目标状态；禁止盲目重试",
                target.local_skill_id,
                target.team_id,
            ))
        }
    }
}

fn reconcile_local_state(
    command: &'static str,
    guard: &CliAuthGuard,
    account: CliAccount,
    local_skill_id: &str,
    team_id: &str,
    detail: &OwnedSkillDetail,
    expected_profile_sha256: Option<&str>,
) -> Result<(), CliCommandOutput> {
    let _lease = guard
        .acquire_current_lease()
        .map_err(|error| auth_guard_failure(command, error))?;
    let (profile, observed_sha256) = read_profile(local_skill_id).map_err(|_| {
        operation_unknown(
            command,
            guard,
            account.clone(),
            "Server 已确认共享状态，但本地 Profile 无法安全读取",
            local_skill_id,
            team_id,
        )
    })?;
    if expected_profile_sha256.is_some_and(|expected| expected != observed_sha256)
        || profile.server_id.as_deref() != Some(detail.id.as_str())
        || profile.server_owner_id.as_deref() != Some(detail.author_id.as_str())
    {
        return Err(operation_unknown(
            command,
            guard,
            account,
            "Server 已确认共享状态，但本地 Skill 绑定同时发生变化，未覆盖本地资料",
            local_skill_id,
            team_id,
        ));
    }
    crate::commands::reconcile_local_team_shares(
        local_skill_id.to_string(),
        &detail.id,
        &detail.author_id,
        team_ids(detail),
    )
    .map_err(|_| {
        operation_unknown(
            command,
            guard,
            account,
            "Server 已确认共享状态，但本地共享资料同步失败",
            local_skill_id,
            team_id,
        )
    })
}

async fn execute_apply(
    kind: TeamMutationKind,
    local_skill_id: String,
    team_id: String,
    expected_digest: String,
) -> CliCommandOutput {
    let command = kind.apply_command();
    let (guard, account) = match verified_guard(command).await {
        Ok(value) => value,
        Err(output) => return output,
    };
    let client = match team_client(&guard) {
        Ok(client) => client,
        Err(message) => {
            return CliCommandOutput::failure(
                command,
                account,
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let (local, mut remote, plan) = match build_current_plan(
        kind,
        command,
        &local_skill_id,
        &team_id,
        &guard,
        account.clone(),
        &client,
    )
    .await
    {
        Ok(value) => value,
        Err(output) => return output,
    };
    let digest = match plan.digest() {
        Ok(digest) => digest,
        Err(()) => {
            return CliCommandOutput::failure(
                command,
                account,
                CliErrorCode::InternalError,
                "无法验证团队共享预检摘要",
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    if digest != expected_digest {
        return CliCommandOutput::failure(
            command,
            account,
            CliErrorCode::PlanStale,
            "账号、本地 Skill、Server 版本或团队共享状态在预检后发生变化",
            EXIT_CONFLICT,
            vec!["请重新运行 preflight，并仅使用新返回的 planDigest".into()],
        );
    }
    if !plan.can_apply {
        return CliCommandOutput::failure(
            command,
            account,
            CliErrorCode::Conflict,
            "当前预检计划不能安全执行",
            EXIT_CONFLICT,
            vec!["请先创建本地版本快照或解决 Server 同版本包冲突".into()],
        );
    }
    if let Err(error) = guard.verify_current() {
        return auth_guard_failure(command, error);
    }

    let imported_binding = if kind == TeamMutationKind::Share
        && plan.server_preparation == ServerPreparation::Import
    {
        let imported = match import_skill(command, &client, &guard, account.clone(), &local).await {
            Ok(imported) => imported,
            Err(output) => return output,
        };
        if let Err(output) = persist_import_binding(
            command,
            &guard,
            account.clone(),
            &local_skill_id,
            &team_id,
            &plan.profile_sha256,
            &imported,
        ) {
            return output;
        }
        let rebound = match load_local_context(&local_skill_id, guard.user_id(), true).await {
            Ok(rebound) => rebound,
            Err(_) => {
                return operation_unknown(
                    command,
                    &guard,
                    account,
                    "Server 已导入 Skill，但本地绑定无法重新读取",
                    &local_skill_id,
                    &team_id,
                )
            }
        };
        remote =
            match fetch_remote(command, &client, &guard, account.clone(), &rebound.profile).await {
                Ok(remote) => remote,
                Err(output) => return output,
            };
        true
    } else {
        false
    };

    if kind == TeamMutationKind::Share
        && plan.server_preparation == ServerPreparation::UploadVersion
    {
        let server_skill_id = match plan.server_skill_id.as_deref() {
            Some(id) => id,
            None => {
                return operation_unknown(
                    command,
                    &guard,
                    account,
                    "版本上传计划缺少 Server Skill 绑定",
                    &local_skill_id,
                    &team_id,
                )
            }
        };
        if let Err(output) = upload_version(
            command,
            &client,
            &guard,
            account.clone(),
            TeamTarget {
                local_skill_id: &local_skill_id,
                team_id: &team_id,
            },
            server_skill_id,
            &local,
        )
        .await
        {
            return output;
        }
        let rebound = match load_local_context(&local_skill_id, guard.user_id(), true).await {
            Ok(rebound) => rebound,
            Err(_) => {
                return operation_unknown(
                    command,
                    &guard,
                    account,
                    "Server 已接收版本，但本地 Skill 无法重新验证",
                    &local_skill_id,
                    &team_id,
                )
            }
        };
        remote =
            match fetch_remote(command, &client, &guard, account.clone(), &rebound.profile).await {
                Ok(remote) => remote,
                Err(output) => return output,
            };
    }

    let remote_before_share = match remote.as_ref() {
        Some(remote) => remote,
        None => {
            return operation_unknown(
                command,
                &guard,
                account,
                "Server 写入完成后无法确认 Skill 资产",
                &local_skill_id,
                &team_id,
            )
        }
    };
    let is_shared = remote_before_share
        .team_shares
        .iter()
        .any(|share| share.team_id == team_id);
    let desired_shared = kind == TeamMutationKind::Share;
    if is_shared != desired_shared {
        if let Err(output) = set_share_state(
            command,
            &client,
            &guard,
            account.clone(),
            TeamTarget {
                local_skill_id: &local_skill_id,
                team_id: &team_id,
            },
            &remote_before_share.id,
            desired_shared,
        )
        .await
        {
            return output;
        }
    }

    let rebound = match load_local_context(
        &local_skill_id,
        guard.user_id(),
        kind == TeamMutationKind::Share,
    )
    .await
    {
        Ok(rebound) => rebound,
        Err(_) => {
            return operation_unknown(
                command,
                &guard,
                account,
                "Server 已处理共享状态，但本地 Skill 无法重新验证",
                &local_skill_id,
                &team_id,
            )
        }
    };
    let confirmed =
        match fetch_remote(command, &client, &guard, account.clone(), &rebound.profile).await {
            Ok(Some(remote)) => remote,
            Ok(None) => {
                return operation_unknown(
                    command,
                    &guard,
                    account,
                    "Server 已处理共享状态，但无法回读 Skill 资产",
                    &local_skill_id,
                    &team_id,
                )
            }
            Err(_) => {
                return operation_unknown(
                    command,
                    &guard,
                    account,
                    "Server 已处理共享状态，但最终真相回读失败",
                    &local_skill_id,
                    &team_id,
                )
            }
        };
    let confirmed_shared = confirmed
        .team_shares
        .iter()
        .any(|share| share.team_id == team_id);
    let package_confirmed = kind == TeamMutationKind::Unshare
        || (confirmed.current_version == local.profile.version
            && current_remote_version(&confirmed)
                .and_then(|version| version.package_sha256.as_deref())
                == Some(local.package_sha256.as_str()));
    if confirmed_shared != desired_shared || !package_confirmed {
        return operation_unknown(
            command,
            &guard,
            account,
            "Server 最终状态与已确认计划不一致，禁止自动重试",
            &local_skill_id,
            &team_id,
        );
    }
    let expected_profile_sha = (!imported_binding).then_some(plan.profile_sha256.as_str());
    if let Err(output) = reconcile_local_state(
        command,
        &guard,
        account.clone(),
        &local_skill_id,
        &team_id,
        &confirmed,
        expected_profile_sha,
    ) {
        return output;
    }
    if guard.verify_current().is_err() {
        return operation_unknown(
            command,
            &guard,
            account,
            "Server 已确认共享状态，但本机账号随后发生变化",
            &local_skill_id,
            &team_id,
        );
    }
    CliCommandOutput::success(
        command,
        account,
        json!({
            "phase": "apply",
            "operation": kind,
            "localSkillId": local_skill_id,
            "teamId": team_id,
            "serverSkillId": confirmed.id,
            "version": confirmed.current_version,
            "packageSha256": current_remote_version(&confirmed).and_then(|version| version.package_sha256.as_deref()),
            "shared": confirmed_shared,
            "serverConfirmed": true,
            "localProfileReconciled": true,
        }),
        Vec::new(),
        Vec::new(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCAL_ID: &str = "local-skill";
    /// Sidecar identity written by import / account sync; distinct from the
    /// managed directory name `LOCAL_ID`.
    const LOCAL_SIDECAR_ID: &str = "5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a5a";
    const TEAM_ID: &str = "11111111-1111-4111-8111-111111111111";
    const USER_ID: &str = "22222222-2222-4222-8222-222222222222";
    const SKILL_ID: &str = "33333333-3333-4333-8333-333333333333";

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    fn local_context(dirty: bool) -> LocalShareContext {
        LocalShareContext {
            profile: SkillHubProfile {
                id: Some(LOCAL_SIDECAR_ID.into()),
                is_own: Some(true),
                acquisition_source: Some(AcquisitionSource::Local),
                name: Some(LOCAL_ID.into()),
                display_name: Some("Local Skill".into()),
                version: "1.0.0".into(),
                ..SkillHubProfile::default()
            },
            skill_md: Zeroizing::new("# local".into()),
            package_base64: Zeroizing::new("cGFja2FnZQ==".into()),
            profile_sha256: "a".repeat(64),
            content_sha256: "b".repeat(64),
            package_sha256: "c".repeat(64),
            git_head: Some("d".repeat(40)),
            working_copy_dirty: dirty,
        }
    }

    fn remote(package_sha256: &str, shared: bool) -> OwnedSkillDetail {
        OwnedSkillDetail {
            id: SKILL_ID.into(),
            name: LOCAL_ID.into(),
            display_name: "Local Skill".into(),
            description: None,
            category: None,
            labels: vec![],
            trigger_scenarios: vec![],
            compatible_agents: vec![],
            author_id: USER_ID.into(),
            current_version: "1.0.0".into(),
            versions: vec![RemoteVersion {
                id: "44444444-4444-4444-8444-444444444444".into(),
                version: "1.0.0".into(),
                package_sha256: Some(package_sha256.into()),
                package_size: Some(7),
            }],
            team_shares: shared
                .then(|| RemoteTeamShare {
                    team_id: TEAM_ID.into(),
                })
                .into_iter()
                .collect(),
        }
    }

    fn saved_fixture(message: &str) -> (std::path::PathBuf, SkillHubProfile) {
        let root =
            std::env::temp_dir().join(format!("skillhub-cli-version-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("SKILL.md"), "# local\n").unwrap();
        crate::commands::library_snapshot_at(&root, message).unwrap();
        (root, local_context(false).profile)
    }

    #[test]
    fn local_profile_identity_accepts_uuid_sidecar_and_legacy_directory_name_only() {
        let mut profile = local_context(false).profile;
        assert_eq!(profile.id.as_deref(), Some(LOCAL_SIDECAR_ID));
        assert!(valid_local_profile(&profile, LOCAL_ID));

        // A store/team asset whose projection name differs from the managed
        // directory is still a valid local profile.
        profile.name = Some("local-skill-from-store".into());
        assert!(valid_local_profile(&profile, LOCAL_ID));

        // Legacy sidecars named after their directory keep working.
        profile.id = Some(LOCAL_ID.into());
        assert!(valid_local_profile(&profile, LOCAL_ID));

        // Anything else is rejected: missing, foreign slug, non-canonical UUID.
        profile.id = None;
        assert!(!valid_local_profile(&profile, LOCAL_ID));
        profile.id = Some("another-skill".into());
        assert!(!valid_local_profile(&profile, LOCAL_ID));
        profile.id = Some(LOCAL_SIDECAR_ID.to_ascii_uppercase());
        assert!(!valid_local_profile(&profile, LOCAL_ID));

        // A valid UUID is not ownership: the other gates still apply.
        profile.id = Some(LOCAL_SIDECAR_ID.into());
        profile.is_own = Some(false);
        assert!(!valid_local_profile(&profile, LOCAL_ID));
    }

    #[test]
    fn local_profile_accepts_both_workbuddy_targets_but_rejects_unknown_agents() {
        let mut profile = local_context(false).profile;
        profile.compatible_agents = vec!["workbuddy".into(), "workbuddy-ai".into()];
        assert!(valid_local_profile(&profile, LOCAL_ID));
        profile.compatible_agents.push("unknown".into());
        assert!(!valid_local_profile(&profile, LOCAL_ID));
    }

    #[test]
    fn sharing_uses_current_normalized_label_without_rewriting_the_sidecar_or_git() {
        let (root, mut profile) = saved_fixture("v0.1.1 · legacy snapshot");
        profile.version = "v9.9.9 · stale sidecar display".into();
        assert!(valid_local_profile(&profile, LOCAL_ID));
        let original_metadata = profile.version_metadata.clone();
        let original_head = crate::version_policy::head(&root);
        resolve_local_version(&root, &mut profile, true).unwrap();
        assert_eq!(profile.version, "0.1.1");
        assert_eq!(profile.version_metadata, original_metadata);
        assert_eq!(crate::version_policy::head(&root), original_head);
        assert!(!root.join(".skillhub.json").exists());

        let mut local = local_context(false);
        local.profile = profile;
        let plan = plan_for(
            TeamMutationKind::Share,
            LOCAL_ID,
            TEAM_ID,
            USER_ID,
            &local,
            None,
        );
        assert_eq!(plan.version, "0.1.1");
        assert_eq!(plan.server_preparation, ServerPreparation::Import);
        assert!(plan.can_apply);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unnumbered_content_needs_a_save_before_sharing_but_can_still_unshare() {
        let (root, mut profile) = saved_fixture("导入 Skill");
        // A syntactically valid sidecar number alone is not a saved version.
        profile.version = "0.1.1".into();
        assert_eq!(
            resolve_local_version(&root, &mut profile, true),
            Err(LocalContextError::Unversioned)
        );
        let failure = local_context_failure(
            SHARE_PREFLIGHT_COMMAND,
            local_account(),
            LocalContextError::Unversioned,
        );
        assert_eq!(failure.exit_code(), EXIT_CONFLICT);
        let output: Value = serde_json::from_str(failure.json()).unwrap();
        assert_eq!(output["error"]["code"], "VALIDATION_FAILED");
        assert!(output["error"]["message"]
            .as_str()
            .unwrap()
            .contains("先保存本机版本"));
        resolve_local_version(&root, &mut profile, false).unwrap();
        assert!(profile.version.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changed_content_cannot_reuse_a_saved_label_for_sharing() {
        let (root, mut profile) = saved_fixture("v0.1.1 · legacy snapshot");
        fs::write(root.join("SKILL.md"), "# changed\n").unwrap();
        assert_eq!(
            resolve_local_version(&root, &mut profile, true),
            Err(LocalContextError::Unversioned)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_share_status_and_apply_strictly() {
        assert_eq!(
            parse_args(&args(&[
                "team",
                "share",
                "status",
                "--local-skill-id",
                LOCAL_ID,
                "--team-id",
                TEAM_ID,
                "--json",
            ])),
            Ok(TeamMutationCommand::Status {
                local_skill_id: LOCAL_ID.into(),
                team_id: TEAM_ID.into(),
            })
        );
        assert!(matches!(
            parse_args(&args(&[
                "team",
                "unshare",
                "apply",
                "--local-skill-id",
                LOCAL_ID,
                "--team-id",
                TEAM_ID,
                "--plan-digest",
                &"A".repeat(64),
                "--json",
            ])),
            Ok(TeamMutationCommand::Apply {
                kind: TeamMutationKind::Unshare,
                plan_digest,
                ..
            }) if plan_digest == "a".repeat(64)
        ));
        assert!(parse_args(&args(&[
            "team",
            "unshare",
            "status",
            "--local-skill-id",
            LOCAL_ID,
            "--team-id",
            TEAM_ID,
            "--json",
        ]))
        .is_err());
    }

    #[test]
    fn import_requires_clean_versioned_working_copy() {
        let clean = local_context(false);
        let clean_plan = plan_for(
            TeamMutationKind::Share,
            LOCAL_ID,
            TEAM_ID,
            USER_ID,
            &clean,
            None,
        );
        assert_eq!(clean_plan.server_preparation, ServerPreparation::Import);
        assert!(clean_plan.can_apply);

        let dirty = local_context(true);
        let dirty_plan = plan_for(
            TeamMutationKind::Share,
            LOCAL_ID,
            TEAM_ID,
            USER_ID,
            &dirty,
            None,
        );
        assert!(!dirty_plan.can_apply);
        assert_ne!(clean_plan.digest().unwrap(), dirty_plan.digest().unwrap());
    }

    #[test]
    fn same_version_with_different_package_is_fail_closed() {
        let local = local_context(false);
        let remote = remote(&"e".repeat(64), false);
        let plan = plan_for(
            TeamMutationKind::Share,
            LOCAL_ID,
            TEAM_ID,
            USER_ID,
            &local,
            Some(&remote),
        );
        assert_eq!(
            plan.server_preparation,
            ServerPreparation::BlockedVersionConflict
        );
        assert!(!plan.can_apply);
    }

    #[test]
    fn exact_remote_package_can_share_and_status_is_bound_in_digest() {
        let local = local_context(false);
        let unshared = remote(&local.package_sha256, false);
        let shared = remote(&local.package_sha256, true);
        let share_plan = plan_for(
            TeamMutationKind::Share,
            LOCAL_ID,
            TEAM_ID,
            USER_ID,
            &local,
            Some(&unshared),
        );
        let shared_plan = plan_for(
            TeamMutationKind::Share,
            LOCAL_ID,
            TEAM_ID,
            USER_ID,
            &local,
            Some(&shared),
        );
        assert_eq!(share_plan.server_preparation, ServerPreparation::None);
        assert!(share_plan.can_apply);
        assert_ne!(share_plan.digest().unwrap(), shared_plan.digest().unwrap());
    }

    #[test]
    fn serialized_plan_does_not_contain_content_token_or_path() {
        let local = local_context(false);
        let plan = plan_for(
            TeamMutationKind::Share,
            LOCAL_ID,
            TEAM_ID,
            USER_ID,
            &local,
            None,
        );
        let serialized = serde_json::to_string(&plan).unwrap();
        assert!(!serialized.contains("# local"));
        assert!(!serialized.contains("cGFja2FnZQ"));
        assert!(!serialized.contains("/Users/"));
        assert!(!serialized.contains("Bearer"));
    }
    #[test]
    fn json_flag_is_optional_and_duplicate_flags_are_rejected() {
        let cases: &[&[&str]] = &[
            &[
                "team",
                "share",
                "preflight",
                "--local-skill-id",
                "sample",
                "--team-id",
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ],
            &[
                "team",
                "share",
                "apply",
                "--local-skill-id",
                "sample",
                "--team-id",
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "--plan-digest",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ],
            &[
                "team",
                "share",
                "status",
                "--local-skill-id",
                "sample",
                "--team-id",
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ],
            &[
                "team",
                "unshare",
                "preflight",
                "--local-skill-id",
                "sample",
                "--team-id",
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ],
            &[
                "team",
                "unshare",
                "apply",
                "--local-skill-id",
                "sample",
                "--team-id",
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "--plan-digest",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ],
        ];
        for case in cases {
            let mut args: Vec<String> = case.iter().map(|value| (*value).to_owned()).collect();
            let default = parse_args(&args);
            assert!(default.is_ok(), "{case:?}: {default:?}");
            args.push("--json".into());
            assert_eq!(default, parse_args(&args), "{case:?}");
            args.push("--json".into());
            assert!(parse_args(&args).is_err(), "{case:?}");
        }
    }
}
