use crate::cli::{
    CliAccount, CliAccountState, CliCommandOutput, CliErrorCode, EXIT_AUTH, EXIT_CONFLICT,
    EXIT_INTERNAL, EXIT_NETWORK, EXIT_USAGE,
};
use crate::cli_auth::{
    account_verification_failure, auth_guard_failure, verify_account_with_server, CliAuthGuard,
};
use crate::key_vault::PersonalSource;
use crate::{skillhub_dir, skills_dir, SkillHubJson, SkillHubProfile, SkillProfileUpdateInput};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest as _, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Read as _;
use std::path::Path;
use std::time::Duration;
use zeroize::{Zeroize as _, Zeroizing};

#[cfg(windows)]
use crate::platform_fs::{MetadataExt as _, OpenOptionsExt as _};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};

pub(crate) const ANALYZE_USAGE: &str = concat!(
    "用法：\n",
    "  skillhub skill analyze <local-skill-id> --preflight --json\n",
    "  skillhub skill analyze <local-skill-id> --apply --plan-digest <digest> --json"
);
pub(crate) const ENV_USAGE: &str = concat!(
    "用法：\n",
    "  skillhub env status [--skill-id <local-skill-id>] --json\n",
    "  skillhub env request --skill-id <local-skill-id> --key <KEY> [--reason <text>] --json"
);

const ANALYZE_COMMAND: &str = "skill analyze";
const ENV_STATUS_COMMAND: &str = "env status";
const ENV_REQUEST_COMMAND: &str = "env request";
const MAX_ENV_REQUEST_REASON_CHARS: usize = 200;
const DEFAULT_ENV_REQUEST_REASON: &str = "Agent 运行时发现需要";
const PLAN_SCHEMA_VERSION: u8 = 1;
const MAX_PROFILE_BYTES: u64 = 1024 * 1024;
const MAX_SKILL_MD_BYTES: u64 = 100_000;
const MAX_API_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ENV_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_POLICY_BYTES: u64 = 1024 * 1024;
const MAX_ENV_SKILLS: usize = 100;

#[derive(Clone, Debug, PartialEq, Eq)]
enum AnalyzeMode {
    Preflight,
    Apply { plan_digest: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum OperationArgs {
    Analyze {
        local_skill_id: String,
        mode: AnalyzeMode,
    },
    EnvStatus {
        local_skill_id: Option<String>,
    },
    EnvRequest {
        local_skill_id: String,
        key: String,
        reason: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzePlan {
    schema_version: u8,
    operation: &'static str,
    account_user_id: String,
    local_skill_id: String,
    server_skill_id: String,
    server_owner_id: String,
    profile_sha256: String,
    content_sha256: String,
}

impl AnalyzePlan {
    fn digest(&self) -> Result<String, ()> {
        serde_json::to_vec(self)
            .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
            .map_err(|_| ())
    }
}

struct AnalyzeContext {
    plan: AnalyzePlan,
    skill_md: Zeroizing<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeRequest<'a> {
    skill_md: &'a str,
    ai_analysis_consent: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnedServerSkill {
    id: String,
    author_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeEnvDependency {
    key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    required: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzedSkill {
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
    #[serde(default)]
    env_dependencies: Vec<SafeEnvDependency>,
    author_id: String,
    current_version: String,
    updated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisStatus {
    status: String,
    redacted_secrets: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeResponse {
    skill: AnalyzedSkill,
    analysis: AnalysisStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeAnalyzedSkill<'a> {
    id: &'a str,
    name: &'a str,
    display_name: &'a str,
    description: Option<&'a str>,
    category: Option<&'a str>,
    labels: &'a [String],
    trigger_scenarios: &'a [String],
    compatible_agents: &'a [String],
    current_version: &'a str,
    updated_at: &'a str,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeEnvOptions {
    skill_id: String,
    dependencies: Vec<SafeEnvDependency>,
    sources: Vec<RuntimeTeamSource>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeTeamSource {
    key: String,
    team_id: String,
    team_name: String,
    revision: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum StoredEnvSource {
    Personal,
    Team {
        #[serde(alias = "teamId")]
        team_id: String,
    },
    /// One labelled value of the personal key (#306).
    #[serde(alias = "personal_variant")]
    PersonalVariant {
        variant: Option<String>,
    },
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSourcePolicy {
    version: u8,
    #[serde(default)]
    skills: BTreeMap<String, BTreeMap<String, StoredEnvSource>>,
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

pub(crate) fn is_operations_command(args: &[String]) -> bool {
    matches!(
        (
            args.first().map(String::as_str),
            args.get(1).map(String::as_str)
        ),
        (Some("skill"), Some("analyze"))
            | (Some("env"), Some("status"))
            | (Some("env"), Some("request"))
    )
}

pub(crate) async fn execute_operations_cli(args: &[String]) -> Option<CliCommandOutput> {
    if !is_operations_command(args) {
        return None;
    }
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(command) => return Some(usage_failure(command)),
    };
    Some(match parsed {
        OperationArgs::Analyze {
            local_skill_id,
            mode,
        } => execute_analyze(local_skill_id, mode).await,
        OperationArgs::EnvStatus { local_skill_id } => execute_env_status(local_skill_id).await,
        OperationArgs::EnvRequest {
            local_skill_id,
            key,
            reason,
        } => execute_env_request(&local_skill_id, &key, reason.as_deref()),
    })
}

fn parse_args(args: &[String]) -> Result<OperationArgs, &'static str> {
    match (
        args.first().map(String::as_str),
        args.get(1).map(String::as_str),
    ) {
        (Some("skill"), Some("analyze")) => parse_analyze_args(args),
        (Some("env"), Some("status")) => parse_env_status_args(args),
        (Some("env"), Some("request")) => parse_env_request_args(args),
        _ => Err(ANALYZE_COMMAND),
    }
}

fn parse_analyze_args(args: &[String]) -> Result<OperationArgs, &'static str> {
    let local_skill_id = args.get(2).ok_or(ANALYZE_COMMAND)?;
    if !valid_skill_id(local_skill_id) {
        return Err(ANALYZE_COMMAND);
    }
    let mut preflight = false;
    let mut apply = false;
    let mut json_requested = false;
    let mut plan_digest = None;
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
            "--json" if !json_requested => {
                json_requested = true;
                index += 1;
            }
            "--plan-digest" if plan_digest.is_none() => {
                let value = args.get(index + 1).ok_or(ANALYZE_COMMAND)?;
                plan_digest = parse_digest(value);
                if plan_digest.is_none() {
                    return Err(ANALYZE_COMMAND);
                }
                index += 2;
            }
            _ => return Err(ANALYZE_COMMAND),
        }
    }
    if !json_requested || preflight == apply {
        return Err(ANALYZE_COMMAND);
    }
    let mode = if preflight {
        if plan_digest.is_some() {
            return Err(ANALYZE_COMMAND);
        }
        AnalyzeMode::Preflight
    } else {
        AnalyzeMode::Apply {
            plan_digest: plan_digest.ok_or(ANALYZE_COMMAND)?,
        }
    };
    Ok(OperationArgs::Analyze {
        local_skill_id: local_skill_id.clone(),
        mode,
    })
}

fn parse_env_status_args(args: &[String]) -> Result<OperationArgs, &'static str> {
    if args.first().map(String::as_str) != Some("env")
        || args.get(1).map(String::as_str) != Some("status")
    {
        return Err(ENV_STATUS_COMMAND);
    }
    let mut local_skill_id = None;
    let mut json_requested = false;
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--json" if !json_requested => {
                json_requested = true;
                index += 1;
            }
            "--skill-id" if local_skill_id.is_none() => {
                let value = args.get(index + 1).ok_or(ENV_STATUS_COMMAND)?;
                if !valid_skill_id(value) {
                    return Err(ENV_STATUS_COMMAND);
                }
                local_skill_id = Some(value.clone());
                index += 2;
            }
            _ => return Err(ENV_STATUS_COMMAND),
        }
    }
    if !json_requested {
        return Err(ENV_STATUS_COMMAND);
    }
    Ok(OperationArgs::EnvStatus { local_skill_id })
}

/// `env request` only takes identifiers and a short, value-free reason. Any
/// malformed or secret-looking input is a usage failure before anything is
/// read or written.
fn parse_env_request_args(args: &[String]) -> Result<OperationArgs, &'static str> {
    if args.first().map(String::as_str) != Some("env")
        || args.get(1).map(String::as_str) != Some("request")
    {
        return Err(ENV_REQUEST_COMMAND);
    }
    let mut local_skill_id = None;
    let mut key = None;
    let mut reason = None;
    let mut json_requested = false;
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--json" if !json_requested => {
                json_requested = true;
                index += 1;
            }
            "--skill-id" if local_skill_id.is_none() => {
                let value = args.get(index + 1).ok_or(ENV_REQUEST_COMMAND)?;
                if !valid_skill_id(value) {
                    return Err(ENV_REQUEST_COMMAND);
                }
                local_skill_id = Some(value.clone());
                index += 2;
            }
            "--key" if key.is_none() => {
                let value = args.get(index + 1).ok_or(ENV_REQUEST_COMMAND)?;
                if !valid_env_key(value) {
                    return Err(ENV_REQUEST_COMMAND);
                }
                key = Some(value.clone());
                index += 2;
            }
            "--reason" if reason.is_none() => {
                let value = args.get(index + 1).ok_or(ENV_REQUEST_COMMAND)?;
                if !valid_env_request_reason(value) {
                    return Err(ENV_REQUEST_COMMAND);
                }
                reason = Some(value.trim().to_string());
                index += 2;
            }
            _ => return Err(ENV_REQUEST_COMMAND),
        }
    }
    if !json_requested {
        return Err(ENV_REQUEST_COMMAND);
    }
    Ok(OperationArgs::EnvRequest {
        local_skill_id: local_skill_id.ok_or(ENV_REQUEST_COMMAND)?,
        key: key.ok_or(ENV_REQUEST_COMMAND)?,
        reason: reason.filter(|value| !value.is_empty()),
    })
}

/// A reason is a short single-line note for the user. It must never carry a
/// value: text shaped like `KEY=<long token>` or `token: <long token>` is
/// rejected rather than stored or echoed.
fn valid_env_request_reason(value: &str) -> bool {
    static SECRET_SHAPES: std::sync::OnceLock<[regex::Regex; 2]> = std::sync::OnceLock::new();
    let patterns = SECRET_SHAPES.get_or_init(|| {
        [
            regex::Regex::new(r"[A-Za-z0-9_]+\s*=\s*\S{8,}").expect("valid secret pattern"),
            regex::Regex::new(r"(?i)(key|token|secret|password|passwd)\s*[:=]\s*\S{8,}")
                .expect("valid secret pattern"),
        ]
    });
    validate_text(value, MAX_ENV_REQUEST_REASON_CHARS, false)
        && !patterns.iter().any(|pattern| pattern.is_match(value))
}

fn parse_digest(value: &str) -> Option<String> {
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

fn valid_skill_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn normalized_uuid(value: &str) -> Option<String> {
    uuid::Uuid::parse_str(value)
        .ok()
        .map(|value| value.to_string())
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
    let usage = if command == ENV_STATUS_COMMAND || command == ENV_REQUEST_COMMAND {
        ENV_USAGE
    } else {
        ANALYZE_USAGE
    };
    CliCommandOutput::failure(
        command,
        local_account(),
        CliErrorCode::ValidationFailed,
        usage,
        EXIT_USAGE,
        Vec::new(),
    )
}

fn operations_client(guard: &CliAuthGuard) -> Result<Client, String> {
    crate::net::client_builder(&guard.origin()?)?
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(60))
        .user_agent(concat!(
            "Yitan-SkillHub/",
            env!("CARGO_PKG_VERSION"),
            " cli-operations"
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
    max_bytes: usize,
) -> Result<HttpResponse, ResponseReadError> {
    if response.url().scheme() != "https" {
        return Err(ResponseReadError::EndpointChanged);
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
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
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(ResponseReadError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(HttpResponse { status, body })
}

async fn authenticated_get(
    client: &Client,
    url: Url,
    token: &str,
) -> Result<HttpResponse, ResponseReadError> {
    let response = client
        .get(url.clone())
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .send()
        .await
        .map_err(|_| ResponseReadError::Offline)?;
    if response.url() != &url {
        return Err(ResponseReadError::EndpointChanged);
    }
    read_bounded_response(response, MAX_API_RESPONSE_BYTES).await
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

fn read_bounded_regular(path: &Path, max_bytes: u64, private: bool) -> Result<Vec<u8>, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > max_bytes {
        return Err(());
    }
    if private
        && (metadata.uid() != crate::platform_fs::current_uid() || metadata.mode() & 0o077 != 0)
    {
        return Err(());
    }
    let mut file = open_regular_file(path)?;
    let opened = file.metadata().map_err(|_| ())?;
    if !opened.is_file()
        || opened.len() > max_bytes
        || opened.dev() != metadata.dev()
        || opened.ino() != metadata.ino()
        || (private
            && (opened.uid() != crate::platform_fs::current_uid() || opened.mode() & 0o077 != 0))
    {
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

/// Why a managed Skill record could not be used. Each variant maps to one
/// sanitized message, so callers never fall back to "no Key configured" when the
/// real problem is an unreadable or unsafe record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProfileReadError {
    /// No managed directory or no `.skillhub.json` for this id.
    Missing,
    /// Symlink, non-regular file, oversized file, or unsafe managed root.
    Unsafe,
    /// JSON does not parse or lacks the `skillhub` envelope.
    Malformed,
    /// Sidecar `id` is neither a UUID nor the directory name.
    Identity,
    /// More Skills with environment dependencies than the CLI reports at once.
    TooMany,
}

impl ProfileReadError {
    fn reason(self) -> &'static str {
        match self {
            Self::Missing => "profile_missing",
            Self::Unsafe => "profile_unsafe",
            Self::Malformed => "profile_malformed",
            Self::Identity => "identity_invalid",
            Self::TooMany => "too_many_skills",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::Missing => "SkillHub 中找不到该本地 Skill",
            Self::Unsafe => "本地 Skill 目录或 Profile 不是安全的普通文件，无法读取环境变量状态",
            Self::Malformed => "本地 Skill Profile JSON 无法解析，无法读取环境变量状态",
            Self::Identity => "本地 Skill Profile 身份无效：id 既不是 UUID，也不是受管目录名",
            Self::TooMany => "本地具有环境依赖的 Skill 数量超过 CLI 单次报告上限",
        }
    }
}

fn read_profile_snapshot(
    local_skill_id: &str,
) -> Result<(SkillHubProfile, String), ProfileReadError> {
    let (profile, digest) = read_profile_snapshot_at(&skills_dir(), local_skill_id)?;
    if !crate::spaces::current_profile_matches(&profile).map_err(|_| ProfileReadError::Identity)? {
        return Err(ProfileReadError::Identity);
    }
    Ok((profile, digest))
}

fn read_profile_snapshot_at(
    managed_root: &Path,
    local_skill_id: &str,
) -> Result<(SkillHubProfile, String), ProfileReadError> {
    if !valid_skill_id(local_skill_id) {
        return Err(ProfileReadError::Identity);
    }
    let managed_metadata =
        fs::symlink_metadata(managed_root).map_err(|_| ProfileReadError::Unsafe)?;
    if managed_metadata.file_type().is_symlink() || !managed_metadata.is_dir() {
        return Err(ProfileReadError::Unsafe);
    }
    let root = managed_root.join(local_skill_id);
    let metadata = match fs::symlink_metadata(&root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ProfileReadError::Missing)
        }
        Err(_) => return Err(ProfileReadError::Unsafe),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ProfileReadError::Unsafe);
    }
    let profile_path = root.join(".skillhub.json");
    match fs::symlink_metadata(&profile_path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ProfileReadError::Missing)
        }
        Err(_) => return Err(ProfileReadError::Unsafe),
    }
    let bytes = read_bounded_regular(&profile_path, MAX_PROFILE_BYTES, false)
        .map_err(|_| ProfileReadError::Unsafe)?;
    let profile_sha256 = format!("{:x}", Sha256::digest(&bytes));
    let json =
        serde_json::from_slice::<SkillHubJson>(&bytes).map_err(|_| ProfileReadError::Malformed)?;
    let profile = json.skillhub.ok_or(ProfileReadError::Malformed)?;
    crate::spaces::require_profile_at(
        managed_root.parent().ok_or(ProfileReadError::Unsafe)?,
        &profile,
    )
    .map_err(|_| ProfileReadError::Identity)?;
    if !crate::sidecar_identity_matches_directory(profile.id.as_deref(), local_skill_id) {
        return Err(ProfileReadError::Identity);
    }
    Ok((profile, profile_sha256))
}

fn load_analyze_context(local_skill_id: &str, account_user_id: &str) -> Result<AnalyzeContext, ()> {
    let (profile, profile_sha256) = read_profile_snapshot(local_skill_id).map_err(|_| ())?;
    if profile.is_system || profile.is_own == Some(false) {
        return Err(());
    }
    let server_skill_id = profile
        .server_id
        .as_deref()
        .and_then(normalized_uuid)
        .ok_or(())?;
    let server_owner_id = profile
        .server_owner_id
        .as_deref()
        .and_then(normalized_uuid)
        .ok_or(())?;
    let account_user_id = normalized_uuid(account_user_id).ok_or(())?;
    if server_owner_id != account_user_id {
        return Err(());
    }
    let path = skills_dir().join(local_skill_id).join("SKILL.md");
    let bytes = read_bounded_regular(&path, MAX_SKILL_MD_BYTES, false)?;
    let skill_md = String::from_utf8(bytes).map_err(|_| ())?;
    if skill_md.trim().is_empty() {
        return Err(());
    }
    let content_sha256 = format!("{:x}", Sha256::digest(skill_md.as_bytes()));
    Ok(AnalyzeContext {
        plan: AnalyzePlan {
            schema_version: PLAN_SCHEMA_VERSION,
            operation: "analyze_profile",
            account_user_id,
            local_skill_id: local_skill_id.to_string(),
            server_skill_id,
            server_owner_id,
            profile_sha256,
            content_sha256,
        },
        skill_md: Zeroizing::new(skill_md),
    })
}

fn validate_text(value: &str, max_chars: usize, multiline: bool) -> bool {
    !value.trim().is_empty()
        && value.trim() == value
        && value.chars().count() <= max_chars
        && value.chars().all(|character| {
            !character.is_control() || (multiline && matches!(character, '\n' | '\r' | '\t'))
        })
}

fn validate_optional_text(value: Option<&str>, max_chars: usize, multiline: bool) -> bool {
    value.is_none_or(|value| validate_text(value, max_chars, multiline))
}

fn valid_env_key(value: &str) -> bool {
    let mut chars = value.chars();
    !value.is_empty()
        && value.len() <= 100
        && chars
            .next()
            .is_some_and(|character| character.is_ascii_uppercase())
        && chars.all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
}

fn valid_string_list(values: &[String], max_items: usize, max_chars: usize) -> bool {
    values.len() <= max_items
        && values
            .iter()
            .all(|value| validate_text(value, max_chars, false))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

fn validate_analyze_response(
    response: AnalyzeResponse,
    plan: &AnalyzePlan,
) -> Result<AnalyzeResponse, ()> {
    let skill = &response.skill;
    if normalized_uuid(&skill.id).as_deref() != Some(plan.server_skill_id.as_str())
        || normalized_uuid(&skill.author_id).as_deref() != Some(plan.account_user_id.as_str())
        || !valid_skill_id(&skill.name)
        || !validate_text(&skill.display_name, 80, false)
        || !validate_optional_text(skill.description.as_deref(), 500, true)
        || !validate_optional_text(skill.category.as_deref(), 100, false)
        || !valid_string_list(&skill.labels, 100, 200)
        || !valid_string_list(&skill.trigger_scenarios, 100, 500)
        || !valid_string_list(&skill.compatible_agents, 32, 128)
        || !validate_text(&skill.current_version, 40, false)
        || !validate_text(&skill.updated_at, 80, false)
        || skill.env_dependencies.len() > 100
        || !skill.env_dependencies.iter().all(|dependency| {
            valid_env_key(&dependency.key)
                && validate_optional_text(dependency.description.as_deref(), 200, true)
        })
        || !matches!(response.analysis.status.as_str(), "completed" | "fallback")
        || response.analysis.redacted_secrets > 100_000
    {
        return Err(());
    }
    if response.analysis.status == "completed"
        && (skill.description.is_none() || skill.category.is_none())
    {
        return Err(());
    }
    Ok(response)
}

fn parse_owned_server_skill(body: &[u8], plan: &AnalyzePlan) -> Result<bool, ()> {
    let skill = serde_json::from_slice::<OwnedServerSkill>(body).map_err(|_| ())?;
    Ok(
        normalized_uuid(&skill.id).as_deref() == Some(plan.server_skill_id.as_str())
            && normalized_uuid(&skill.author_id).as_deref() == Some(plan.account_user_id.as_str()),
    )
}

fn parse_analyze_response(body: &[u8], plan: &AnalyzePlan) -> Result<AnalyzeResponse, ()> {
    let response = serde_json::from_slice::<AnalyzeResponse>(body).map_err(|_| ())?;
    validate_analyze_response(response, plan)
}

fn response_failure(
    command: &'static str,
    guard: &CliAuthGuard,
    account: CliAccount,
    status: StatusCode,
    mutating_request: bool,
) -> CliCommandOutput {
    if status == StatusCode::UNAUTHORIZED {
        return auth_guard_failure(command, guard.invalidate_unauthorized());
    }
    let outcome_may_be_unknown = mutating_request
        && !matches!(
            status,
            StatusCode::BAD_REQUEST
                | StatusCode::FORBIDDEN
                | StatusCode::NOT_FOUND
                | StatusCode::CONFLICT
                | StatusCode::UNPROCESSABLE_ENTITY
                | StatusCode::TOO_MANY_REQUESTS
        );
    if outcome_may_be_unknown {
        return analyze_outcome_unknown(
            account,
            guard.verify_current().is_ok(),
            "Server 返回异常，AI 分析结果可能已经落库，禁止自动重试",
        );
    }
    if let Err(error) = guard.verify_current() {
        return auth_guard_failure(command, error);
    }
    let (code, message, exit_code, next_actions) = if status == StatusCode::FORBIDDEN {
        (
            CliErrorCode::PermissionDenied,
            "当前账号不是这个 Server Skill 的所有者",
            EXIT_AUTH,
            vec!["请在 SkillHub APP 中切换到拥有该 Skill 的账号".into()],
        )
    } else if status == StatusCode::NOT_FOUND {
        (
            CliErrorCode::NotFound,
            "Server 上找不到对应的 Skill",
            EXIT_INTERNAL,
            vec!["请在 SkillHub APP 中重新同步该 Skill".into()],
        )
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        (
            CliErrorCode::ValidationFailed,
            "AI 分析请求过于频繁",
            EXIT_NETWORK,
            vec!["请等待 Server 提示的限流窗口结束后重新预检".into()],
        )
    } else if status.is_server_error() {
        (
            CliErrorCode::InternalError,
            "SkillHub Server 暂时无法完成预检",
            EXIT_INTERNAL,
            vec!["请检查 Server 状态后重新预检".into()],
        )
    } else {
        (
            CliErrorCode::ValidationFailed,
            "Server 拒绝了本次 AI 分析请求",
            EXIT_INTERNAL,
            vec!["请重新执行预检，并在 SkillHub APP 中核对 Skill 状态".into()],
        )
    };
    CliCommandOutput::failure(command, account, code, message, exit_code, next_actions)
}

fn analyze_outcome_unknown(
    account: CliAccount,
    account_is_current: bool,
    message: &'static str,
) -> CliCommandOutput {
    let account = if account_is_current {
        account
    } else {
        CliAccount::state(CliAccountState::Unknown)
    };
    CliCommandOutput::failure(
        ANALYZE_COMMAND,
        account,
        CliErrorCode::OperationOutcomeUnknown,
        message,
        EXIT_NETWORK,
        vec![
            "先运行 skillhub skill list --json，并用 skill show 复核目标；再在 APP 中刷新 Server Profile，确认结果前不要重试 apply".into(),
        ],
    )
}

fn response_read_failure(
    command: &'static str,
    guard: &CliAuthGuard,
    account: CliAccount,
    error: ResponseReadError,
    mutating_request: bool,
) -> CliCommandOutput {
    if mutating_request {
        let message = match error {
            ResponseReadError::Offline => "AI 分析请求已发出但响应中断，结果未知，禁止自动重试",
            ResponseReadError::TooLarge => {
                "AI 分析请求已发出但响应超过安全上限，结果未知，禁止自动重试"
            }
            ResponseReadError::EndpointChanged => {
                "AI 分析请求已发出但端点状态异常，结果未知，禁止自动重试"
            }
        };
        return analyze_outcome_unknown(account, guard.verify_current().is_ok(), message);
    }
    if let Err(auth_error) = guard.verify_current() {
        return auth_guard_failure(command, auth_error);
    }
    let message = match error {
        ResponseReadError::Offline => "暂时无法连接 SkillHub Server",
        ResponseReadError::TooLarge => "SkillHub Server 响应超过安全上限",
        ResponseReadError::EndpointChanged => "SkillHub Server 端点发生了未授权变化",
    };
    CliCommandOutput::failure(
        command,
        account,
        if error == ResponseReadError::Offline {
            CliErrorCode::Offline
        } else {
            CliErrorCode::InternalError
        },
        message,
        if error == ResponseReadError::Offline {
            EXIT_NETWORK
        } else {
            EXIT_INTERNAL
        },
        vec!["请检查网络和 SkillHub Server 状态后重新预检".into()],
    )
}

fn local_preflight_failure(account: CliAccount) -> CliCommandOutput {
    CliCommandOutput::failure(
        ANALYZE_COMMAND,
        account,
        CliErrorCode::ValidationFailed,
        "该本地 Skill 不能安全执行 AI 分析：必须是当前账号拥有、已绑定 Server 的非系统托管 Skill",
        EXIT_INTERNAL,
        vec!["请先在 SkillHub APP 中完成同步并确认 Skill 所属账号".into()],
    )
}

async fn verified_guard(
    command: &'static str,
) -> Result<(CliAuthGuard, CliAccount), CliCommandOutput> {
    let guard = CliAuthGuard::capture().map_err(|error| auth_guard_failure(command, error))?;
    if let Err(error) = guard.token_for_request() {
        return Err(auth_guard_failure(command, error));
    }
    let account = verify_account_with_server(&guard)
        .await
        .map_err(|error| account_verification_failure(command, &guard, error))?;
    Ok((guard, account))
}

async fn verify_remote_ownership(
    client: &Client,
    guard: &CliAuthGuard,
    account: CliAccount,
    plan: &AnalyzePlan,
) -> Result<(), CliCommandOutput> {
    let url = api_url(guard, &format!("skills/{}", plan.server_skill_id)).map_err(|_| {
        CliCommandOutput::failure(
            ANALYZE_COMMAND,
            account.clone(),
            CliErrorCode::InternalError,
            "SkillHub 服务地址配置无效",
            EXIT_INTERNAL,
            Vec::new(),
        )
    })?;
    let token = guard
        .token_for_request()
        .map_err(|error| auth_guard_failure(ANALYZE_COMMAND, error))?;
    let response = authenticated_get(client, url, token)
        .await
        .map_err(|error| {
            response_read_failure(ANALYZE_COMMAND, guard, account.clone(), error, false)
        })?;
    if !response.status.is_success() {
        return Err(response_failure(
            ANALYZE_COMMAND,
            guard,
            account,
            response.status,
            false,
        ));
    }
    let ownership_matches = match parse_owned_server_skill(&response.body, plan) {
        Ok(matches) => matches,
        Err(()) => {
            return Err(CliCommandOutput::failure(
                ANALYZE_COMMAND,
                account,
                CliErrorCode::InternalError,
                "SkillHub Server 返回了无效的 Skill 所属资料",
                EXIT_INTERNAL,
                Vec::new(),
            ))
        }
    };
    if !ownership_matches {
        return Err(CliCommandOutput::failure(
            ANALYZE_COMMAND,
            account,
            CliErrorCode::PermissionDenied,
            "本地 Skill 与当前账号拥有的 Server 资产不一致",
            EXIT_AUTH,
            vec!["请在 SkillHub APP 中重新同步该 Skill".into()],
        ));
    }
    guard
        .verify_current()
        .map_err(|error| auth_guard_failure(ANALYZE_COMMAND, error))
}

async fn execute_analyze(local_skill_id: String, mode: AnalyzeMode) -> CliCommandOutput {
    let (guard, account) = match verified_guard(ANALYZE_COMMAND).await {
        Ok(value) => value,
        Err(output) => return output,
    };
    let context = match load_analyze_context(&local_skill_id, guard.user_id()) {
        Ok(context) => context,
        Err(()) => return local_preflight_failure(account),
    };
    let plan_digest = match context.plan.digest() {
        Ok(digest) => digest,
        Err(()) => {
            return CliCommandOutput::failure(
                ANALYZE_COMMAND,
                account,
                CliErrorCode::InternalError,
                "无法生成 AI 分析预检摘要",
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let client = match operations_client(&guard) {
        Ok(client) => client,
        Err(message) => {
            return CliCommandOutput::failure(
                ANALYZE_COMMAND,
                account,
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    if let Err(output) =
        verify_remote_ownership(&client, &guard, account.clone(), &context.plan).await
    {
        return output;
    }
    if mode == AnalyzeMode::Preflight {
        if let Err(error) = guard.verify_current() {
            return auth_guard_failure(ANALYZE_COMMAND, error);
        }
        return CliCommandOutput::success(
            ANALYZE_COMMAND,
            account,
            json!({
                "mode": "preflight",
                "canApply": true,
                "localSkillId": context.plan.local_skill_id,
                "serverSkillId": context.plan.server_skill_id,
                "contentSha256": context.plan.content_sha256,
                "planDigest": plan_digest,
                "serverOwnershipValidated": true,
                "requiresAiAnalysisConsent": true,
            }),
            vec!["执行请求可能调用第三方 AI；请求发出后若断连，禁止自动重试".into()],
            vec![format!(
                "确认后执行 skillhub skill analyze {} --apply --plan-digest {} --json",
                local_skill_id, plan_digest
            )],
        );
    }
    let expected_digest = match mode {
        AnalyzeMode::Apply { plan_digest } => plan_digest,
        AnalyzeMode::Preflight => unreachable!(),
    };
    if expected_digest != plan_digest {
        return CliCommandOutput::failure(
            ANALYZE_COMMAND,
            account,
            CliErrorCode::PlanStale,
            "AI 分析预检摘要已失效；本地内容、绑定资产或账号已变化",
            EXIT_CONFLICT,
            vec!["请重新执行 --preflight，并由用户重新确认".into()],
        );
    }
    if let Err(error) = guard.verify_current() {
        return auth_guard_failure(ANALYZE_COMMAND, error);
    }
    let analyze_url = match api_url(
        &guard,
        &format!("skills/{}/analyze", context.plan.server_skill_id),
    ) {
        Ok(url) => url,
        Err(_) => {
            return CliCommandOutput::failure(
                ANALYZE_COMMAND,
                account,
                CliErrorCode::InternalError,
                "SkillHub 服务地址配置无效",
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let token = match guard.token_for_request() {
        Ok(token) => token,
        Err(error) => return auth_guard_failure(ANALYZE_COMMAND, error),
    };
    let response = match client
        .post(analyze_url.clone())
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .json(&AnalyzeRequest {
            skill_md: context.skill_md.as_str(),
            ai_analysis_consent: true,
        })
        .send()
        .await
    {
        Ok(response) if response.url() == &analyze_url => response,
        Ok(_) => {
            return response_read_failure(
                ANALYZE_COMMAND,
                &guard,
                account,
                ResponseReadError::EndpointChanged,
                true,
            )
        }
        Err(_) => {
            return response_read_failure(
                ANALYZE_COMMAND,
                &guard,
                account,
                ResponseReadError::Offline,
                true,
            )
        }
    };
    let response = match read_bounded_response(response, MAX_API_RESPONSE_BYTES).await {
        Ok(response) => response,
        Err(error) => return response_read_failure(ANALYZE_COMMAND, &guard, account, error, true),
    };
    if !response.status.is_success() {
        return response_failure(ANALYZE_COMMAND, &guard, account, response.status, true);
    }
    let analyzed = match parse_analyze_response(&response.body, &context.plan) {
        Ok(analyzed) => analyzed,
        Err(()) => {
            return analyze_outcome_unknown(
                account,
                guard.verify_current().is_ok(),
                "Server 已响应，但分析结果格式无法安全确认；禁止自动重试",
            );
        }
    };
    if guard.verify_current().is_err() {
        return analyze_outcome_unknown(
            account,
            false,
            "Server 已完成 AI 分析，但本机账号随后发生变化；结果需要复核，禁止自动重试",
        );
    }

    let mut local_profile_updated = false;
    let mut warnings = Vec::new();
    if analyzed.analysis.status == "completed" {
        match guard.acquire_current_lease() {
            Ok(_lease) => {
                let current_matches = load_analyze_context(&local_skill_id, guard.user_id())
                    .is_ok_and(|current| current.plan == context.plan);
                if current_matches {
                    let result = crate::commands::update_skill_profile(
                        crate::server_request::SpaceRegistry::handle(Some(guard.session())),
                        local_skill_id.clone(),
                        SkillProfileUpdateInput {
                            // Server responses never overwrite a hand-filled source (#329).
                            source_url: None,
                            cleared_source_url: None,
                            server_id: Some(analyzed.skill.id.clone()),
                            server_owner_id: Some(analyzed.skill.author_id.clone()),
                            display_name: Some(analyzed.skill.display_name.clone()),
                            description: analyzed.skill.description.clone(),
                            category: analyzed.skill.category.clone(),
                            labels: analyzed.skill.labels.clone(),
                            trigger_scenarios: analyzed.skill.trigger_scenarios.clone(),
                            compatible_agents: analyzed.skill.compatible_agents.clone(),
                            version: Some(analyzed.skill.current_version.clone()),
                        },
                    );
                    if result.is_ok() {
                        local_profile_updated = true;
                    } else {
                        warnings.push(
                            "Server 分析已确认，但本地 Profile 写入失败；请在 APP 中刷新同步"
                                .into(),
                        );
                    }
                } else {
                    warnings.push(
                        "Server 分析已确认，但本地 Skill 在请求期间发生变化，未覆盖本地 Profile"
                            .into(),
                    );
                }
            }
            Err(_) => {
                return analyze_outcome_unknown(
                    account,
                    false,
                    "Server 已完成 AI 分析，但无法安全提交本地结果；结果需要复核，禁止自动重试",
                )
            }
        }
    } else {
        warnings.push("AI 本次未返回有效 Profile；Server 保留了原资料，本地 Profile 未改动".into());
    }
    if guard.verify_current().is_err() {
        return analyze_outcome_unknown(
            account,
            false,
            "Server 已完成 AI 分析，但本机账号随后发生变化；结果需要复核，禁止自动重试",
        );
    }
    let safe_skill = SafeAnalyzedSkill {
        id: &analyzed.skill.id,
        name: &analyzed.skill.name,
        display_name: &analyzed.skill.display_name,
        description: analyzed.skill.description.as_deref(),
        category: analyzed.skill.category.as_deref(),
        labels: &analyzed.skill.labels,
        trigger_scenarios: &analyzed.skill.trigger_scenarios,
        compatible_agents: &analyzed.skill.compatible_agents,
        current_version: &analyzed.skill.current_version,
        updated_at: &analyzed.skill.updated_at,
    };
    CliCommandOutput::success(
        ANALYZE_COMMAND,
        account,
        json!({
            "mode": "apply",
            "serverConfirmed": true,
            "localProfileUpdated": local_profile_updated,
            "skill": safe_skill,
            "analysis": {
                "status": analyzed.analysis.status,
                "redactedSecrets": analyzed.analysis.redacted_secrets,
            },
        }),
        warnings,
        if local_profile_updated {
            vec![format!(
                "使用 skillhub skill show --skill-id {} --json 复核本地 Profile",
                local_skill_id
            )]
        } else {
            vec!["请在 SkillHub APP 中刷新该 Skill Profile".into()]
        },
    )
}

fn read_policy_at(skillhub_root: &Path, account_user_id: &str) -> Result<StoredSourcePolicy, ()> {
    let path = skillhub_root
        .join("runtime")
        .join("policies")
        .join(format!("{account_user_id}.json"));
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StoredSourcePolicy::default())
        }
        Err(_) => return Err(()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(());
    }
    let bytes = read_bounded_regular(&path, MAX_POLICY_BYTES, true)?;
    let policy = serde_json::from_slice::<StoredSourcePolicy>(&bytes).map_err(|_| ())?;
    if policy.version != 1 || policy.skills.len() > 10_000 {
        return Err(());
    }
    for (skill_id, sources) in &policy.skills {
        if !valid_skill_id(skill_id) || sources.len() > 100 {
            return Err(());
        }
        for (key, source) in sources {
            if !valid_env_key(key)
                || matches!(source, StoredEnvSource::Team { team_id } if normalized_uuid(team_id).is_none())
                || matches!(source, StoredEnvSource::PersonalVariant { variant: Some(variant) } if crate::key_vault::validate_variant_id(variant).is_err())
            {
                return Err(());
            }
        }
    }
    Ok(policy)
}

fn read_personal_env_keys_at(
    envs_root: &Path,
    account_user_id: &str,
    local_skill_id: &str,
    allowed: &BTreeSet<String>,
) -> Result<BTreeSet<String>, ()> {
    let path =
        crate::runtime_env::account_env_path_under(envs_root, account_user_id, local_skill_id)
            .map_err(|_| ())?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeSet::new()),
        Err(_) => return Err(()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(());
    }
    let mut bytes = read_bounded_regular(&path, MAX_ENV_FILE_BYTES, true)?;
    let result = (|| -> Result<BTreeSet<String>, ()> {
        let contents = std::str::from_utf8(&bytes).map_err(|_| ())?;
        let mut keys = BTreeSet::new();
        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let assignment = trimmed.strip_prefix("export ").unwrap_or(trimmed);
            let (key, value) = assignment.split_once('=').ok_or(())?;
            let key = key.trim();
            if !valid_env_key(key) {
                return Err(());
            }
            if allowed.contains(key) && !value.trim().is_empty() {
                keys.insert(key.to_string());
            }
        }
        Ok(keys)
    })();
    bytes.zeroize();
    result
}

/// A managed record that the full status could not include, with a sanitized
/// reason. The directory name is omitted when it is itself unsafe to echo.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkippedProfile {
    local_skill_id: Option<String>,
    reason: &'static str,
}

#[derive(Debug, Default)]
struct ProfileTargets {
    targets: Vec<(String, SkillHubProfile)>,
    skipped: Vec<SkippedProfile>,
}

fn profile_targets_at(
    managed_root: &Path,
    local_skill_id: Option<&str>,
) -> Result<ProfileTargets, ProfileReadError> {
    if let Some(local_skill_id) = local_skill_id {
        let (profile, _) = read_profile_snapshot_at(managed_root, local_skill_id)?;
        return Ok(ProfileTargets {
            targets: vec![(local_skill_id.to_string(), profile)],
            skipped: Vec::new(),
        });
    }
    let metadata = fs::symlink_metadata(managed_root).map_err(|_| ProfileReadError::Unsafe)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ProfileReadError::Unsafe);
    }
    let mut result = ProfileTargets::default();
    for entry in fs::read_dir(managed_root).map_err(|_| ProfileReadError::Unsafe)? {
        let entry = entry.map_err(|_| ProfileReadError::Unsafe)?;
        let local_skill_id = entry.file_name().to_string_lossy().to_string();
        let file_type = entry.file_type().map_err(|_| ProfileReadError::Unsafe)?;
        if file_type.is_symlink() {
            result.skipped.push(SkippedProfile {
                local_skill_id: valid_skill_id(&local_skill_id).then_some(local_skill_id),
                reason: "unsafe_directory",
            });
            continue;
        }
        if !file_type.is_dir() {
            // Loose files in the managed root (e.g. `.DS_Store`) are not Skill
            // records at all.
            continue;
        }
        if !valid_skill_id(&local_skill_id) {
            result.skipped.push(SkippedProfile {
                local_skill_id: None,
                reason: "invalid_directory_name",
            });
            continue;
        }
        let (profile, _) = match read_profile_snapshot_at(managed_root, &local_skill_id) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                result.skipped.push(SkippedProfile {
                    local_skill_id: Some(local_skill_id),
                    reason: error.reason(),
                });
                continue;
            }
        };
        if !profile.env_dependencies.is_empty() {
            result.targets.push((local_skill_id, profile));
        }
        if result.targets.len() > MAX_ENV_SKILLS {
            return Err(ProfileReadError::TooMany);
        }
    }
    result.targets.sort_by(|left, right| left.0.cmp(&right.0));
    result.skipped.sort_by(|left, right| {
        left.local_skill_id
            .cmp(&right.local_skill_id)
            .then(left.reason.cmp(right.reason))
    });
    Ok(result)
}

fn validate_runtime_options(
    options: RuntimeEnvOptions,
    expected_server_id: &str,
) -> Result<RuntimeEnvOptions, ()> {
    if normalized_uuid(&options.skill_id).as_deref() != Some(expected_server_id)
        || options.dependencies.len() > 100
        || options.sources.len() > 10_000
        || !options.dependencies.iter().all(|dependency| {
            valid_env_key(&dependency.key)
                && validate_optional_text(dependency.description.as_deref(), 200, true)
        })
        || !options.sources.iter().all(|source| {
            valid_env_key(&source.key)
                && normalized_uuid(&source.team_id).is_some()
                && validate_text(&source.team_name, 256, false)
                && source.revision > 0
        })
    {
        return Err(());
    }
    let dependency_keys = options
        .dependencies
        .iter()
        .map(|dependency| dependency.key.as_str())
        .collect::<BTreeSet<_>>();
    if dependency_keys.len() != options.dependencies.len()
        || options
            .sources
            .iter()
            .any(|source| !dependency_keys.contains(source.key.as_str()))
    {
        return Err(());
    }
    Ok(options)
}

fn env_http_failure(
    guard: &CliAuthGuard,
    account: CliAccount,
    status: StatusCode,
) -> CliCommandOutput {
    if status == StatusCode::UNAUTHORIZED {
        return auth_guard_failure(ENV_STATUS_COMMAND, guard.invalidate_unauthorized());
    }
    if let Err(error) = guard.verify_current() {
        return auth_guard_failure(ENV_STATUS_COMMAND, error);
    }
    let (code, message, exit_code) = if status == StatusCode::FORBIDDEN {
        (
            CliErrorCode::PermissionDenied,
            "当前账号无权读取该 Skill 的环境变量来源状态",
            EXIT_AUTH,
        )
    } else if status == StatusCode::NOT_FOUND {
        (
            CliErrorCode::NotFound,
            "Server 上找不到该 Skill 的环境变量配置",
            EXIT_INTERNAL,
        )
    } else {
        (
            CliErrorCode::InternalError,
            "SkillHub Server 暂时无法读取环境变量来源状态",
            EXIT_INTERNAL,
        )
    };
    CliCommandOutput::failure(
        ENV_STATUS_COMMAND,
        account,
        code,
        message,
        exit_code,
        vec!["请在 SkillHub APP 的钥匙页核对状态".into()],
    )
}

async fn fetch_runtime_options(
    client: &Client,
    guard: &CliAuthGuard,
    account: CliAccount,
    server_skill_id: &str,
) -> Result<RuntimeEnvOptions, CliCommandOutput> {
    let mut url = api_url(guard, "runtime/env/options").map_err(|_| {
        CliCommandOutput::failure(
            ENV_STATUS_COMMAND,
            account.clone(),
            CliErrorCode::InternalError,
            "SkillHub 服务地址配置无效",
            EXIT_INTERNAL,
            Vec::new(),
        )
    })?;
    url.query_pairs_mut()
        .append_pair("skillId", server_skill_id);
    let token = guard
        .token_for_request()
        .map_err(|error| auth_guard_failure(ENV_STATUS_COMMAND, error))?;
    let response = authenticated_get(client, url, token)
        .await
        .map_err(|error| {
            response_read_failure(ENV_STATUS_COMMAND, guard, account.clone(), error, false)
        })?;
    if !response.status.is_success() {
        return Err(env_http_failure(guard, account, response.status));
    }
    let parsed = serde_json::from_slice::<RuntimeEnvOptions>(&response.body)
        .map_err(|_| {
            CliCommandOutput::failure(
                ENV_STATUS_COMMAND,
                account.clone(),
                CliErrorCode::InternalError,
                "SkillHub Server 返回了无效的环境变量来源状态",
                EXIT_INTERNAL,
                Vec::new(),
            )
        })
        .and_then(|options| {
            validate_runtime_options(options, server_skill_id).map_err(|_| {
                CliCommandOutput::failure(
                    ENV_STATUS_COMMAND,
                    account,
                    CliErrorCode::InternalError,
                    "SkillHub Server 返回了不一致的环境变量来源状态",
                    EXIT_INTERNAL,
                    Vec::new(),
                )
            })
        })?;
    guard
        .verify_current()
        .map_err(|error| auth_guard_failure(ENV_STATUS_COMMAND, error))?;
    Ok(parsed)
}

/// `personal` maps each key with a personal value to where it lives
/// (`override` for this Skill's own value, `vault` for the account key
/// vault); `via_keys` maps a declared name served through another vault key's
/// alias to that key (`viaKey`, #288); `needs_consent` lists vault keys this
/// Skill must be allowed to use first (`run` fails with `NEEDS_CONSENT` until
/// the user answers in the APP).
fn env_rows(
    profile: &SkillHubProfile,
    personal: &BTreeMap<String, PersonalSource>,
    via_keys: &BTreeMap<String, String>,
    served_variants: &BTreeMap<String, (String, String)>,
    needs_consent: &BTreeSet<String>,
    policy: Option<&BTreeMap<String, StoredEnvSource>>,
    options: Option<&RuntimeEnvOptions>,
) -> Vec<serde_json::Value> {
    let mut dependencies = profile.env_dependencies.clone();
    dependencies.sort_by(|left, right| left.key.cmp(&right.key));
    dependencies
        .into_iter()
        .map(|dependency| {
            let selected = policy.and_then(|sources| sources.get(&dependency.key));
            let personal_source = personal.get(&dependency.key).map(|source| source.as_str());
            let personal_available = personal_source.is_some();
            let local_authorization =
                if personal_source == Some("vault") && needs_consent.contains(&dependency.key) {
                    "needs_consent"
                } else {
                    "local"
                };
            let team = match selected {
                Some(StoredEnvSource::Team { team_id }) => options.and_then(|options| {
                    options
                        .sources
                        .iter()
                        .find(|source| source.key == dependency.key && source.team_id == *team_id)
                }),
                _ => None,
            };
            // Same fixed order as `skillhub run`: with no explicit choice and
            // no personal value, exactly one available team is used
            // automatically; several teams require a choice in the APP.
            let mut automatic_teams = options
                .map(|options| {
                    options
                        .sources
                        .iter()
                        .filter(|source| source.key == dependency.key && source.revision > 0)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            automatic_teams.dedup_by(|left, right| left.team_id == right.team_id);
            let (source, selection, authorization, missing, team_value) = match selected {
                Some(StoredEnvSource::Personal | StoredEnvSource::PersonalVariant { .. }) => (
                    personal_source.unwrap_or("personal"),
                    "explicit",
                    if personal_available {
                        local_authorization
                    } else {
                        "unavailable"
                    },
                    !personal_available,
                    None,
                ),
                Some(StoredEnvSource::Team { team_id }) => (
                    "team",
                    "explicit",
                    if team.is_some() {
                        "authorized"
                    } else {
                        "unavailable"
                    },
                    team.is_none(),
                    Some(json!({
                        "teamId": team_id,
                        "teamName": team.map(|source| source.team_name.as_str()),
                        "revision": team.map(|source| source.revision),
                    })),
                ),
                None if personal_available => (
                    personal_source.unwrap_or("personal"),
                    "automatic",
                    local_authorization,
                    false,
                    None,
                ),
                None if automatic_teams.len() == 1 => {
                    let source = automatic_teams[0];
                    (
                        "team",
                        "automatic_team",
                        "authorized",
                        false,
                        Some(json!({
                            "teamId": source.team_id,
                            "teamName": source.team_name.as_str(),
                            "revision": source.revision,
                        })),
                    )
                }
                None if automatic_teams.len() > 1 => {
                    ("unselected", "none", "needs_choice", true, None)
                }
                None => (
                    "unselected",
                    "none",
                    if dependency.required {
                        "not_selected"
                    } else {
                        "not_required"
                    },
                    true,
                    None,
                ),
            };
            let mut row = json!({
                "key": dependency.key,
                "required": dependency.required,
                "missing": missing,
                "source": source,
                "selection": selection,
                "authorization": authorization,
            });
            if let Some(team_value) = team_value {
                row.as_object_mut()
                    .expect("env row is an object")
                    .insert("team".into(), team_value);
            }
            if source == "vault" {
                let fields = row.as_object_mut().expect("env row is an object");
                if let Some(via_key) = via_keys.get(&dependency.key) {
                    fields.insert("viaKey".into(), json!(via_key));
                }
                // Served from a labelled value of the name (#306).
                if let Some((variant, label)) = served_variants.get(&dependency.key) {
                    fields.insert("variant".into(), json!(variant));
                    fields.insert("label".into(), json!(label));
                }
            }
            row
        })
        .collect()
}

/// Where `env status` reads: the managed store, the SkillHub root (runtime
/// policies) and the per-account env files. Tests point it at a fixture.
struct EnvStatusRoots {
    skillhub_root: std::path::PathBuf,
    managed_root: std::path::PathBuf,
    envs_root: std::path::PathBuf,
}

impl EnvStatusRoots {
    fn current(guard: &CliAuthGuard) -> Self {
        Self {
            skillhub_root: guard.session().storage_root(&skillhub_dir()),
            managed_root: skills_dir(),
            envs_root: guard.session().storage_root(&skillhub_dir()).join("envs"),
        }
    }

    #[cfg(test)]
    fn under(home: &Path) -> Self {
        let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
        Self {
            managed_root: skillhub_root.join("skills"),
            envs_root: skillhub_root.join("envs"),
            skillhub_root,
        }
    }
}

/// The account-bound side of `env status`: who is asking, the authorized
/// Server lookup for team sources, and the final session re-check. The live
/// implementation wraps the CLI auth guard and HTTP client; tests substitute a
/// fixture so the full command response can be asserted without a Server.
trait EnvStatusSession {
    fn user_id(&self) -> &str;
    async fn runtime_options(
        &self,
        account: CliAccount,
        server_skill_id: &str,
    ) -> Result<RuntimeEnvOptions, CliCommandOutput>;
    fn verify_current(&self) -> Result<(), CliCommandOutput>;
}

struct LiveEnvStatusSession<'a> {
    guard: &'a CliAuthGuard,
    client: Client,
}

impl EnvStatusSession for LiveEnvStatusSession<'_> {
    fn user_id(&self) -> &str {
        self.guard.user_id()
    }

    async fn runtime_options(
        &self,
        account: CliAccount,
        server_skill_id: &str,
    ) -> Result<RuntimeEnvOptions, CliCommandOutput> {
        fetch_runtime_options(&self.client, self.guard, account, server_skill_id).await
    }

    fn verify_current(&self) -> Result<(), CliCommandOutput> {
        self.guard
            .verify_current()
            .map_err(|error| auth_guard_failure(ENV_STATUS_COMMAND, error))
    }
}

async fn execute_env_status(local_skill_id: Option<String>) -> CliCommandOutput {
    let (guard, account) = match verified_guard(ENV_STATUS_COMMAND).await {
        Ok(value) => value,
        Err(output) => return output,
    };
    let client = match operations_client(&guard) {
        Ok(client) => client,
        Err(message) => {
            return CliCommandOutput::failure(
                ENV_STATUS_COMMAND,
                account,
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let session = LiveEnvStatusSession {
        guard: &guard,
        client,
    };
    env_status_report(
        &session,
        account,
        local_skill_id.as_deref(),
        &EnvStatusRoots::current(&guard),
    )
    .await
}

/// Builds the full `env status` response from the given roots. Every failure
/// is a typed, sanitized envelope; the success envelope carries `complete` and
/// `skipped` so a shortened list is never mistaken for a full one.
async fn env_status_report<S: EnvStatusSession>(
    session: &S,
    account: CliAccount,
    local_skill_id: Option<&str>,
    roots: &EnvStatusRoots,
) -> CliCommandOutput {
    let ProfileTargets { targets, skipped } =
        match profile_targets_at(&roots.managed_root, local_skill_id) {
            Ok(targets) => targets,
            Err(ProfileReadError::Missing) => {
                return CliCommandOutput::failure(
                    ENV_STATUS_COMMAND,
                    account,
                    CliErrorCode::NotFound,
                    ProfileReadError::Missing.message(),
                    EXIT_USAGE,
                    vec!["请用 skillhub skill list --json 确认本地 Skill 的 id".into()],
                )
            }
            Err(error) => {
                return CliCommandOutput::failure(
                    ENV_STATUS_COMMAND,
                    account,
                    CliErrorCode::ValidationFailed,
                    error.message(),
                    EXIT_INTERNAL,
                    vec![
                    "这是状态查询失败，不代表环境变量缺失；请在 SkillHub APP 中检查该本地 Skill"
                        .into(),
                ],
                )
            }
        };
    let policy = match read_policy_at(&roots.skillhub_root, session.user_id()) {
        Ok(policy) => policy,
        Err(()) => {
            return CliCommandOutput::failure(
                ENV_STATUS_COMMAND,
                account,
                CliErrorCode::ValidationFailed,
                "无法安全读取当前账号的环境变量来源策略",
                EXIT_INTERNAL,
                vec!["请在 SkillHub APP 的钥匙页重新保存来源设置".into()],
            )
        }
    };
    let mut output = Vec::new();
    let mut server_target_count = 0_usize;
    for (skill_id, profile) in targets {
        if !crate::sidecar_identity_matches_directory(profile.id.as_deref(), &skill_id) {
            return CliCommandOutput::failure(
                ENV_STATUS_COMMAND,
                account,
                CliErrorCode::ValidationFailed,
                ProfileReadError::Identity.message(),
                EXIT_INTERNAL,
                vec!["请在 SkillHub APP 中修复该 Skill".into()],
            );
        }
        if profile.env_dependencies.len() > 100
            || !profile.env_dependencies.iter().all(|dependency| {
                valid_env_key(&dependency.key)
                    && validate_optional_text(dependency.description.as_deref(), 200, true)
            })
        {
            return CliCommandOutput::failure(
                ENV_STATUS_COMMAND,
                account,
                CliErrorCode::ValidationFailed,
                "本地 Skill 的环境变量依赖清单无效",
                EXIT_INTERNAL,
                vec!["请在 SkillHub APP 中修复该 Skill Profile".into()],
            );
        }
        let allowed = profile
            .env_dependencies
            .iter()
            .map(|dependency| dependency.key.clone())
            .collect::<BTreeSet<_>>();
        if allowed.len() != profile.env_dependencies.len() {
            return CliCommandOutput::failure(
                ENV_STATUS_COMMAND,
                account,
                CliErrorCode::ValidationFailed,
                "本地 Skill 存在重复的环境变量依赖",
                EXIT_INTERNAL,
                vec!["请在 SkillHub APP 中修复该 Skill Profile".into()],
            );
        }
        let overrides = match read_personal_env_keys_at(
            &roots.envs_root,
            session.user_id(),
            &skill_id,
            &allowed,
        ) {
            Ok(personal) => personal,
            Err(()) => {
                return CliCommandOutput::failure(
                    ENV_STATUS_COMMAND,
                    account,
                    CliErrorCode::ValidationFailed,
                    "无法安全读取本地环境变量文件",
                    EXIT_INTERNAL,
                    vec!["请在 SkillHub APP 的钥匙页重新保存个人值".into()],
                )
            }
        };
        // Personal layer: this Skill's override first, then the account key
        // vault (#253). Names only; values are never read into the report.
        let mut personal = overrides
            .into_iter()
            .map(|key| (key, PersonalSource::Override))
            .collect::<BTreeMap<_, _>>();
        // Declared name → vault key (main name) when served through an alias
        // of another key (#288); reported as `viaKey`.
        let mut via_keys = BTreeMap::<String, String>::new();
        // Declared name → labelled value serving it (#306).
        let mut served_variants = BTreeMap::<String, (String, String)>::new();
        let consent_check = (|| -> Result<BTreeSet<String>, String> {
            let choices = policy
                .skills
                .get(&skill_id)
                .into_iter()
                .flatten()
                .filter_map(|(key, source)| match source {
                    StoredEnvSource::PersonalVariant { variant } => {
                        Some((key.clone(), variant.clone()))
                    }
                    _ => None,
                })
                .collect::<BTreeMap<_, _>>();
            let serving = crate::key_vault::vault_serving_for_skill_at(
                &roots.skillhub_root,
                session.user_id(),
                &skill_id,
                &allowed,
                &choices,
            )?;
            // Declared name → vault identity (`NAME` or `NAME__V<n>`).
            let mut vault_used = BTreeMap::<String, String>::new();
            for (key, serving) in serving {
                if personal.contains_key(&key) {
                    continue;
                }
                personal.insert(key.clone(), PersonalSource::Vault);
                if serving.main != key {
                    via_keys.insert(key.clone(), serving.main.clone());
                }
                if let (Some(variant), Some(label)) = (serving.variant, serving.label) {
                    served_variants.insert(key.clone(), (variant, label));
                }
                if !matches!(
                    policy
                        .skills
                        .get(&skill_id)
                        .and_then(|sources| sources.get(&key)),
                    Some(StoredEnvSource::Team { .. })
                ) {
                    vault_used.insert(key, serving.identity);
                }
            }
            // Consent is per value (main name or `NAME__V<n>`); rows are per
            // declared name.
            let pending = crate::key_vault::evaluate_consent_at(
                &roots.skillhub_root,
                session.user_id(),
                &skill_id,
                &profile,
                &vault_used.values().cloned().collect(),
                crate::key_vault::now_ms(),
            )?
            .pending
            .into_iter()
            .collect::<BTreeSet<_>>();
            Ok(vault_used
                .into_iter()
                .filter(|(_, main)| pending.contains(main))
                .map(|(key, _)| key)
                .collect())
        })();
        let needs_consent = match consent_check {
            Ok(needs_consent) => needs_consent,
            Err(_) => {
                return CliCommandOutput::failure(
                    ENV_STATUS_COMMAND,
                    account,
                    CliErrorCode::ValidationFailed,
                    "无法安全读取本机钥匙库",
                    EXIT_INTERNAL,
                    vec!["请在 SkillHub APP 的钥匙页检查个人钥匙".into()],
                )
            }
        };
        let server_skill_id = match profile.server_id.as_deref() {
            Some(value) => match normalized_uuid(value) {
                Some(value) => Some(value),
                None => {
                    return CliCommandOutput::failure(
                        ENV_STATUS_COMMAND,
                        account,
                        CliErrorCode::ValidationFailed,
                        "本地 Skill 绑定的 Server 资产编号无效",
                        EXIT_INTERNAL,
                        vec!["请在 SkillHub APP 中重新同步该 Skill".into()],
                    )
                }
            },
            None => None,
        };
        let options = if let Some(server_skill_id) = server_skill_id.as_deref() {
            server_target_count += 1;
            match session
                .runtime_options(account.clone(), server_skill_id)
                .await
            {
                Ok(options) => Some(options),
                Err(output) => return output,
            }
        } else {
            None
        };
        let rows = env_rows(
            &profile,
            &personal,
            &via_keys,
            &served_variants,
            &needs_consent,
            policy.skills.get(&skill_id),
            options.as_ref(),
        );
        let consent_keys = rows
            .iter()
            .filter(|row| row["authorization"] == "needs_consent")
            .filter_map(|row| row["key"].as_str().map(str::to_string))
            .collect::<Vec<_>>();
        let required_missing = rows
            .iter()
            .filter(|row| row["required"] == true && row["missing"] == true)
            .count();
        let server_profile_in_sync = options.as_ref().map(|options| {
            let remote = options
                .dependencies
                .iter()
                .map(|dependency| dependency.key.as_str())
                .collect::<BTreeSet<_>>();
            let local = allowed.iter().map(String::as_str).collect::<BTreeSet<_>>();
            remote == local
        });
        output.push(json!({
            "localSkillId": skill_id,
            "serverSkillId": server_skill_id,
            "skillAccess": if options.is_some() { "authorized" } else { "local_only" },
            "serverProfileInSync": server_profile_in_sync,
            "ready": required_missing == 0 && consent_keys.is_empty(),
            "requiredMissing": required_missing,
            "needsConsent": consent_keys,
            "dependencies": rows,
            "lastRun": crate::last_run::read_last_run_at(
                &roots.skillhub_root,
                session.user_id(),
                &skill_id,
            ),
        }));
    }
    if let Err(output) = session.verify_current() {
        return output;
    }
    let (warnings, next_actions) = env_status_completeness_notes(&skipped);
    CliCommandOutput::success(
        ENV_STATUS_COMMAND,
        account,
        json!({
            "skillCount": output.len(),
            "serverTargetCount": server_target_count,
            "skills": output,
            "complete": skipped.is_empty(),
            "skipped": skipped,
            "valuesExposed": false,
            "accountValidated": true,
            "serverValidated": server_target_count > 0,
        }),
        warnings,
        next_actions,
    )
}

fn execute_env_request(local_skill_id: &str, key: &str, reason: Option<&str>) -> CliCommandOutput {
    env_request_report(
        local_account(),
        &skills_dir(),
        local_skill_id,
        key,
        reason,
        crate::commands::request_runtime_env_dependency,
    )
}

/// Registers a key an Agent found missing at run time. Works for guests and
/// signed-in accounts alike: only sidecar metadata changes, no value is read,
/// written, resolved or sent anywhere.
fn env_request_report(
    account: CliAccount,
    managed_root: &Path,
    local_skill_id: &str,
    key: &str,
    reason: Option<&str>,
    apply: impl FnOnce(&str, &str, &str) -> Result<bool, String>,
) -> CliCommandOutput {
    let failure = |account: CliAccount, code, message: &str, exit_code, next: Vec<String>| {
        CliCommandOutput::failure(ENV_REQUEST_COMMAND, account, code, message, exit_code, next)
    };
    if !valid_env_key(key) || reason.is_some_and(|value| !valid_env_request_reason(value)) {
        return usage_failure(ENV_REQUEST_COMMAND);
    }
    let profile = match read_profile_snapshot_at(managed_root, local_skill_id) {
        Ok((profile, _)) => profile,
        Err(ProfileReadError::Missing) => {
            return failure(
                account,
                CliErrorCode::NotFound,
                ProfileReadError::Missing.message(),
                EXIT_USAGE,
                vec!["请用 skillhub skill list --json 确认本地 Skill 的 id".into()],
            )
        }
        Err(error) => {
            return failure(
                account,
                CliErrorCode::ValidationFailed,
                error.message(),
                EXIT_INTERNAL,
                vec!["请在 SkillHub APP 中检查该本地 Skill".into()],
            )
        }
    };
    if profile.is_system {
        return failure(
            account,
            CliErrorCode::PermissionDenied,
            "SkillHub Manager 是受保护的系统 Skill，不能登记环境变量需求",
            EXIT_AUTH,
            Vec::new(),
        );
    }
    let description = reason.unwrap_or(DEFAULT_ENV_REQUEST_REASON);
    let already_declared = match apply(local_skill_id, key, description) {
        Ok(already_declared) => already_declared,
        Err(message) => {
            let (code, exit_code) = if message.contains("正被其他 SkillHub 操作修改") {
                (CliErrorCode::Conflict, EXIT_CONFLICT)
            } else {
                (CliErrorCode::InternalError, EXIT_INTERNAL)
            };
            return failure(
                account,
                code,
                &message,
                exit_code,
                vec!["请在 SkillHub APP 中检查该 Skill 后再重试".into()],
            );
        }
    };
    let declared = read_profile_snapshot_at(managed_root, local_skill_id)
        .ok()
        .and_then(|(profile, _)| {
            profile
                .env_dependencies
                .into_iter()
                .find(|dependency| dependency.key == key)
        });
    CliCommandOutput::success(
        ENV_REQUEST_COMMAND,
        account,
        json!({
            "localSkillId": local_skill_id,
            "key": key,
            "alreadyDeclared": already_declared,
            "required": declared.as_ref().map(|dependency| dependency.required),
            "origin": declared.as_ref().and_then(|dependency| dependency.origin.clone()),
            "pending": declared.as_ref().and_then(|dependency| dependency.pending).unwrap_or(false),
            "projectionRefreshed": true,
            "valuesExposed": false,
        }),
        Vec::new(),
        vec![format!(
            "请告诉用户在 SkillHub APP 中确认并填写 {key}，用户确认后再重试；不要向用户索取值"
        )],
    )
}

/// The full status must never pass off a silently shortened list as complete:
/// a record that could not be read safely is named (when its directory name is
/// safe to echo) and the caller is told the count is partial.
fn env_status_completeness_notes(skipped: &[SkippedProfile]) -> (Vec<String>, Vec<String>) {
    if skipped.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let named = skipped
        .iter()
        .filter_map(|entry| entry.local_skill_id.as_deref())
        .collect::<Vec<_>>();
    let mut warning = format!(
        "{} 个本地 Skill 记录无法安全读取，已从清单省略；skillCount 不是完整清单",
        skipped.len()
    );
    if !named.is_empty() {
        warning.push('：');
        warning.push_str(&named.join("、"));
    }
    (
        vec![warning],
        vec!["请在 SkillHub APP 中检查被省略的本地 Skill；这不代表它们的环境变量缺失".into()],
    )
}

#[cfg(test)]
mod tests {
    use super::{
        analyze_outcome_unknown, env_rows, env_status_completeness_notes, is_operations_command,
        parse_analyze_args, parse_analyze_response, parse_args, parse_env_status_args,
        profile_targets_at, read_profile_snapshot_at, AnalyzePlan, OperationArgs, ProfileReadError,
        RuntimeEnvOptions, RuntimeTeamSource, SkippedProfile, StoredEnvSource, StoredSourcePolicy,
        ANALYZE_COMMAND,
    };
    use crate::cli::{CliAccount, EXIT_NETWORK};
    use crate::key_vault::PersonalSource;
    use crate::{EnvDepRaw, SkillHubProfile};
    use serde_json::json;
    use std::collections::{BTreeMap, BTreeSet};

    const USER_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const SERVER_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    fn plan() -> AnalyzePlan {
        AnalyzePlan {
            schema_version: 1,
            operation: "analyze_profile",
            account_user_id: USER_ID.into(),
            local_skill_id: "writer".into(),
            server_skill_id: SERVER_ID.into(),
            server_owner_id: USER_ID.into(),
            profile_sha256: "1".repeat(64),
            content_sha256: "2".repeat(64),
        }
    }

    #[test]
    fn parser_requires_exact_two_phase_analyze_contract() {
        assert!(matches!(
            parse_analyze_args(&strings(&[
                "skill",
                "analyze",
                "writer",
                "--preflight",
                "--json"
            ])),
            Ok(OperationArgs::Analyze { .. })
        ));
        assert!(matches!(
            parse_analyze_args(&strings(&[
                "skill",
                "analyze",
                "writer",
                "--apply",
                "--plan-digest",
                &"a".repeat(64),
                "--json"
            ])),
            Ok(OperationArgs::Analyze { .. })
        ));
        for rejected in [
            strings(&["skill", "analyze", "writer", "--json"]),
            strings(&[
                "skill",
                "analyze",
                "writer",
                "--preflight",
                "--apply",
                "--json",
            ]),
            strings(&[
                "skill",
                "analyze",
                "writer",
                "--apply",
                "--plan-digest",
                "bad",
                "--json",
            ]),
            strings(&["skill", "analyze", "../writer", "--preflight", "--json"]),
        ] {
            assert_eq!(parse_analyze_args(&rejected), Err(ANALYZE_COMMAND));
        }
    }

    #[test]
    fn parser_keeps_env_status_isolated_from_secret_resolution() {
        assert!(matches!(
            parse_env_status_args(&strings(&["env", "status", "--json"])),
            Ok(OperationArgs::EnvStatus {
                local_skill_id: None
            })
        ));
        assert!(parse_env_status_args(&strings(&["env", "resolve", "--json"])).is_err());
        assert!(parse_args(&strings(&["env", "run", "writer", "--json"])).is_err());
        assert!(parse_args(&strings(&["skill", "share", "writer", "--json"])).is_err());
        assert!(is_operations_command(&strings(&[
            "skill",
            "analyze",
            "writer",
            "--preflight",
            "--json"
        ])));
        assert!(is_operations_command(&strings(&[
            "env", "status", "--json"
        ])));
        assert!(!is_operations_command(&strings(&[
            "env", "resolve", "--json"
        ])));
        assert!(!is_operations_command(&strings(&[
            "skill", "install", "writer", "--json"
        ])));
    }

    #[test]
    fn source_policy_parser_keeps_only_metadata_and_never_a_value() {
        let parsed = serde_json::from_value::<StoredSourcePolicy>(json!({
            "version": 1,
            "skills": {
                "writer": {
                    "PERSONAL_KEY": {"kind": "personal"},
                    "TEAM_KEY": {
                        "kind": "team",
                        "team_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
                    }
                }
            }
        }))
        .expect("safe source metadata");
        assert_eq!(
            parsed.skills["writer"]["TEAM_KEY"],
            StoredEnvSource::Team {
                team_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into()
            }
        );
        let tainted = serde_json::from_value::<StoredSourcePolicy>(json!({
            "version": 1,
            "skills": {
                "writer": {
                    "PERSONAL_KEY": {"kind": "personal", "value": "never-read"}
                }
            }
        }))
        .expect("unknown unit-variant fields are discarded by serde");
        assert_eq!(
            tainted.skills["writer"]["PERSONAL_KEY"],
            StoredEnvSource::Personal
        );
    }

    #[test]
    fn runtime_team_source_accepts_camel_case_and_legacy_policy_field() {
        let team_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        let current = serde_json::from_value::<crate::runtime_env::SkillEnvSource>(json!({
            "kind": "team",
            "teamId": team_id,
        }))
        .expect("current APP contract");
        let legacy = serde_json::from_value::<crate::runtime_env::SkillEnvSource>(json!({
            "kind": "team",
            "team_id": team_id,
        }))
        .expect("legacy policy contract");
        assert_eq!(current, legacy);
        let serialized = serde_json::to_value(current).expect("serialize source");
        assert_eq!(serialized["teamId"], team_id);
        assert!(serialized.get("team_id").is_none());
    }

    #[test]
    fn analyze_digest_binds_account_asset_profile_and_content() {
        let original = plan();
        let digest = original.digest().expect("digest");
        assert_eq!(digest.len(), 64);
        for changed in [
            AnalyzePlan {
                account_user_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into(),
                ..original.clone()
            },
            AnalyzePlan {
                server_skill_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd".into(),
                ..original.clone()
            },
            AnalyzePlan {
                profile_sha256: "3".repeat(64),
                ..original.clone()
            },
            AnalyzePlan {
                content_sha256: "4".repeat(64),
                ..original.clone()
            },
        ] {
            assert_ne!(changed.digest().expect("changed digest"), digest);
        }
    }

    #[test]
    fn analyze_response_drops_unknown_secret_fields() {
        let payload = json!({
            "skill": {
                "id": SERVER_ID,
                "name": "writer",
                "displayName": "Writer",
                "description": "Writes",
                "category": "内容与创作",
                "labels": ["内容写作", "通用工具"],
                "triggerScenarios": ["draft"],
                "compatibleAgents": ["codex"],
                "envDependencies": [{"key": "EXAMPLE_KEY", "required": true, "value": "secret"}],
                "authorId": USER_ID,
                "currentVersion": "v1.0.0",
                "updatedAt": "2026-09-09T00:00:00Z",
                "authToken": "never-output",
                "sourceContent": "never-output"
            },
            "analysis": {
                "status": "completed",
                "provider": "provider.example",
                "redactedSecrets": 1,
                "apiKey": "never-output"
            },
            "token": "never-output"
        });
        let parsed =
            parse_analyze_response(&serde_json::to_vec(&payload).expect("payload"), &plan())
                .expect("safe response");
        let safe = json!({
            "id": parsed.skill.id,
            "analysisStatus": parsed.analysis.status,
            "redactedSecrets": parsed.analysis.redacted_secrets,
        });
        let output = serde_json::to_string(&safe).expect("safe output");
        assert!(!output.contains("never-output"));
        assert!(!output.to_ascii_lowercase().contains("token"));
        assert!(!output.to_ascii_lowercase().contains("apikey"));
    }

    #[test]
    fn account_change_after_analyze_dispatch_keeps_the_unknown_outcome_contract() {
        let output = analyze_outcome_unknown(
            CliAccount::verified(
                USER_ID.into(),
                "old-account@example.com".into(),
                "Old Account".into(),
                None,
                "user".into(),
            ),
            false,
            "结果需要复核，禁止自动重试",
        );
        assert_eq!(output.exit_code(), EXIT_NETWORK);
        let envelope: serde_json::Value =
            serde_json::from_str(output.json()).expect("parse unknown outcome envelope");
        assert_eq!(envelope["command"], ANALYZE_COMMAND);
        assert_eq!(envelope["error"]["code"], "OPERATION_OUTCOME_UNKNOWN");
        assert_eq!(envelope["account"]["state"], "unknown");
        assert!(envelope["account"].get("email").is_none());
        assert!(envelope["nextActions"][0]
            .as_str()
            .is_some_and(|value| value.contains("不要重试")));
    }

    #[test]
    fn env_rows_never_contain_values_and_report_missing_sources() {
        let profile = SkillHubProfile {
            env_dependencies: vec![
                EnvDepRaw {
                    key: "PERSONAL_KEY".into(),
                    description: None,
                    required: true,
                    share_policy: String::new(),
                    shared_teams: Vec::new(),
                    origin: None,
                    confidence: None,
                    obtain: None,
                    pending: None,
                },
                EnvDepRaw {
                    key: "TEAM_KEY".into(),
                    description: None,
                    required: true,
                    share_policy: String::new(),
                    shared_teams: Vec::new(),
                    origin: None,
                    confidence: None,
                    obtain: None,
                    pending: None,
                },
            ],
            ..SkillHubProfile::default()
        };
        let personal = BTreeMap::from([("PERSONAL_KEY".to_string(), PersonalSource::Override)]);
        let policy = BTreeMap::from([
            ("PERSONAL_KEY".into(), StoredEnvSource::Personal),
            (
                "TEAM_KEY".into(),
                StoredEnvSource::Team {
                    team_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into(),
                },
            ),
        ]);
        let options = RuntimeEnvOptions {
            skill_id: SERVER_ID.into(),
            dependencies: Vec::new(),
            sources: vec![RuntimeTeamSource {
                key: "TEAM_KEY".into(),
                team_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into(),
                team_name: "Team".into(),
                revision: 2,
            }],
        };
        let rows = env_rows(
            &profile,
            &personal,
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeSet::new(),
            Some(&policy),
            Some(&options),
        );
        assert_eq!(rows[0]["source"], "override");
        assert_eq!(rows[0]["missing"], false);
        assert_eq!(rows[1]["source"], "team");
        assert_eq!(rows[1]["authorization"], "authorized");
        assert_eq!(rows[1]["missing"], false);
        let output = serde_json::to_string(&rows).expect("rows");
        assert!(!output.to_ascii_lowercase().contains("value"));
        assert!(!output.contains("secret"));
    }

    #[test]
    fn env_dependency_origin_and_pending_round_trip_and_stay_optional() {
        let legacy: EnvDepRaw =
            serde_json::from_str(r#"{"key":"API_KEY","required":true,"sharePolicy":"none"}"#)
                .expect("legacy dependency without new fields");
        assert_eq!(legacy.origin, None);
        assert_eq!(legacy.pending, None);
        let legacy_json = serde_json::to_value(&legacy).expect("serialize legacy");
        assert!(legacy_json.get("origin").is_none());
        assert!(legacy_json.get("pending").is_none());

        let requested: EnvDepRaw = serde_json::from_str(
            r#"{"key":"FAL_KEY","description":"Agent 运行时发现需要","required":true,"sharePolicy":"none","sharedTeams":[],"origin":"runtime_request","pending":true}"#,
        )
        .expect("runtime-requested dependency");
        let json = serde_json::to_value(&requested).expect("serialize requested");
        assert_eq!(json["origin"], "runtime_request");
        assert_eq!(json["pending"], true);
        let again: EnvDepRaw = serde_json::from_value(json).expect("round trip");
        assert_eq!(again.origin.as_deref(), Some("runtime_request"));
        assert_eq!(again.pending, Some(true));
    }

    #[test]
    fn env_rows_apply_the_fixed_resolution_order() {
        let dependency = |key: &str| EnvDepRaw {
            key: key.into(),
            description: None,
            required: true,
            share_policy: String::new(),
            shared_teams: Vec::new(),
            origin: None,
            confidence: None,
            obtain: None,
            pending: None,
        };
        let profile = SkillHubProfile {
            env_dependencies: vec![
                dependency("BOTH_KEY"),
                dependency("CHOICE_KEY"),
                dependency("NONE_KEY"),
                dependency("SOLO_KEY"),
            ],
            ..SkillHubProfile::default()
        };
        let source = |key: &str, team: &str| RuntimeTeamSource {
            key: key.into(),
            team_id: team.into(),
            team_name: format!("Team {team}"),
            revision: 1,
        };
        let team_a = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        let team_b = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        let options = RuntimeEnvOptions {
            skill_id: SERVER_ID.into(),
            dependencies: Vec::new(),
            sources: vec![
                source("BOTH_KEY", team_a),
                source("CHOICE_KEY", team_a),
                source("CHOICE_KEY", team_b),
                source("SOLO_KEY", team_a),
            ],
        };
        let personal = BTreeMap::from([("BOTH_KEY".to_string(), PersonalSource::Vault)]);
        let rows = env_rows(
            &profile,
            &personal,
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeSet::new(),
            None,
            Some(&options),
        );
        // Personal value (here from the account key vault) wins over an
        // available team value.
        assert_eq!(rows[0]["source"], "vault");
        assert_eq!(rows[0]["selection"], "automatic");
        assert_eq!(rows[0]["missing"], false);
        // Several teams: a choice is needed.
        assert_eq!(rows[1]["selection"], "none");
        assert_eq!(rows[1]["authorization"], "needs_choice");
        assert_eq!(rows[1]["missing"], true);
        // Nothing at all: unchanged "not_selected".
        assert_eq!(rows[2]["authorization"], "not_selected");
        assert_eq!(rows[2]["missing"], true);
        // Exactly one team: used automatically.
        assert_eq!(rows[3]["source"], "team");
        assert_eq!(rows[3]["selection"], "automatic_team");
        assert_eq!(rows[3]["authorization"], "authorized");
        assert_eq!(rows[3]["missing"], false);
        assert_eq!(rows[3]["team"]["teamId"], team_a);
    }

    #[test]
    fn env_rows_report_a_key_served_through_an_alias() {
        let dependency = |key: &str| EnvDepRaw {
            key: key.into(),
            description: None,
            required: true,
            share_policy: String::new(),
            shared_teams: Vec::new(),
            origin: None,
            confidence: None,
            obtain: None,
            pending: None,
        };
        let profile = SkillHubProfile {
            env_dependencies: vec![dependency("FAL_API_KEY"), dependency("OPENAI_API_KEY")],
            ..SkillHubProfile::default()
        };
        let personal = BTreeMap::from([
            ("FAL_API_KEY".to_string(), PersonalSource::Vault),
            ("OPENAI_API_KEY".to_string(), PersonalSource::Vault),
        ]);
        let via_keys = BTreeMap::from([("FAL_API_KEY".to_string(), "FAL_KEY".to_string())]);
        let rows = env_rows(
            &profile,
            &personal,
            &via_keys,
            &BTreeMap::new(),
            &BTreeSet::from(["FAL_API_KEY".to_string()]),
            None,
            None,
        );
        assert_eq!(rows[0]["key"], "FAL_API_KEY");
        assert_eq!(rows[0]["source"], "vault");
        assert_eq!(rows[0]["missing"], false);
        assert_eq!(rows[0]["viaKey"], "FAL_KEY");
        assert_eq!(rows[0]["authorization"], "needs_consent");
        assert_eq!(rows[1]["source"], "vault");
        assert!(rows[1].get("viaKey").is_none());
    }

    #[test]
    fn env_request_parser_accepts_only_identifiers_and_value_free_reasons() {
        assert_eq!(
            parse_args(&strings(&[
                "env",
                "request",
                "--skill-id",
                "writer",
                "--key",
                "FAL_KEY",
                "--json",
            ])),
            Ok(OperationArgs::EnvRequest {
                local_skill_id: "writer".into(),
                key: "FAL_KEY".into(),
                reason: None,
            })
        );
        assert_eq!(
            parse_args(&strings(&[
                "env",
                "request",
                "--json",
                "--key",
                "FAL_KEY",
                "--skill-id",
                "writer",
                "--reason",
                "生成图片时提示缺少 FAL_KEY",
            ])),
            Ok(OperationArgs::EnvRequest {
                local_skill_id: "writer".into(),
                key: "FAL_KEY".into(),
                reason: Some("生成图片时提示缺少 FAL_KEY".into()),
            })
        );
        assert!(is_operations_command(&strings(&["env", "request"])));
        for invalid in [
            // --json is mandatory.
            vec!["env", "request", "--skill-id", "writer", "--key", "FAL_KEY"],
            // Key and Skill id are both required and validated.
            vec!["env", "request", "--skill-id", "writer", "--json"],
            vec!["env", "request", "--key", "FAL_KEY", "--json"],
            vec![
                "env",
                "request",
                "--skill-id",
                "writer",
                "--key",
                "fal_key",
                "--json",
            ],
            vec![
                "env",
                "request",
                "--skill-id",
                "writer",
                "--key",
                "1KEY",
                "--json",
            ],
            vec![
                "env",
                "request",
                "--skill-id",
                "../x",
                "--key",
                "FAL_KEY",
                "--json",
            ],
            // Never a value flag.
            vec![
                "env",
                "request",
                "--skill-id",
                "writer",
                "--key",
                "FAL_KEY",
                "--value",
                "x",
                "--json",
            ],
        ] {
            assert!(parse_args(&strings(&invalid)).is_err(), "{invalid:?}");
        }
        let too_long = "说".repeat(201);
        for reason in [
            too_long.as_str(),
            "FAL_KEY=sk-live-0123456789",
            "use token: abcdefgh12345678",
            "secret=abcdefgh1",
            "line one\nline two",
        ] {
            assert!(
                parse_args(&strings(&[
                    "env",
                    "request",
                    "--skill-id",
                    "writer",
                    "--key",
                    "FAL_KEY",
                    "--reason",
                    reason,
                    "--json",
                ]))
                .is_err(),
                "reason accepted: {reason:?}"
            );
        }
        assert!(super::valid_env_request_reason(&"说".repeat(200)));
        assert!(super::valid_env_request_reason(
            "API key required for image generation"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn env_request_is_idempotent_metadata_only_and_refreshes_the_projection() {
        let home = home_with(
            &[("writer", &sidecar(Some(LOCAL_UUID), "writer", ""))],
            &["writer"],
        );
        let skillhub_root = home
            .path()
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            });
        let managed_root = skillhub_root.join("skills");
        let sidecar_path = managed_root.join("writer/.skillhub.json");
        let env_file = skillhub_root.join("envs").join(USER_ID).join("writer.env");
        let env_before = std::fs::read(&env_file).expect("read personal env");
        let request = |key: &str, reason: Option<&str>| {
            let output = super::env_request_report(
                CliAccount::state(crate::cli::CliAccountState::Guest),
                &managed_root,
                "writer",
                key,
                reason,
                |skill_id, key, description| {
                    crate::commands::request_runtime_env_dependency_at(
                        &skillhub_root,
                        &managed_root,
                        skill_id,
                        key,
                        description,
                    )
                },
            );
            let json = output.json().to_string();
            assert!(!json.contains(SECRET_VALUE));
            (
                serde_json::from_str::<serde_json::Value>(&json).expect("CLI JSON envelope"),
                output.exit_code(),
            )
        };

        for attempt in 0..3 {
            let (json, exit) = request("FAL_KEY", None);
            assert_eq!(exit, 0, "{json}");
            assert_eq!(json["ok"], true);
            assert_eq!(json["command"], "env request");
            assert_eq!(json["account"]["state"], "guest");
            assert_eq!(json["data"]["alreadyDeclared"], attempt > 0);
            assert_eq!(json["data"]["origin"], "runtime_request");
            assert_eq!(json["data"]["pending"], true);
            assert_eq!(json["data"]["valuesExposed"], false);
        }
        let profile: crate::SkillHubJson =
            serde_json::from_slice(&std::fs::read(&sidecar_path).expect("read sidecar"))
                .expect("parse sidecar");
        let dependencies = profile.skillhub.expect("profile").env_dependencies;
        let requested = dependencies
            .iter()
            .filter(|dependency| dependency.key == "FAL_KEY")
            .collect::<Vec<_>>();
        assert_eq!(requested.len(), 1, "repeated requests must not duplicate");
        assert!(requested[0].required);
        assert_eq!(requested[0].origin.as_deref(), Some("runtime_request"));
        assert_eq!(requested[0].pending, Some(true));
        assert_eq!(
            requested[0].description.as_deref(),
            Some("Agent 运行时发现需要")
        );
        assert_eq!(
            std::fs::read(&env_file).expect("reread personal env"),
            env_before,
            "env request must never touch values"
        );
        let projected =
            std::fs::read_to_string(skillhub_root.join("projections/writer/current/SKILL.md"))
                .expect("read refreshed projection");
        assert!(projected.contains("SKILLHUB-RUNTIME-START v4"));
        let marker: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(
                skillhub_root.join("projections/writer/current/.skillhub-projection.json"),
            )
            .expect("read projection marker"),
        )
        .expect("parse projection marker");
        assert!(marker["envKeys"]
            .as_array()
            .expect("env keys")
            .iter()
            .any(|key| key == "FAL_KEY"));

        // An author-declared key is reported, not rewritten.
        let (json, exit) = request("FIXTURE_API_KEY", Some("运行脚本时报错缺少该变量"));
        assert_eq!(exit, 0);
        assert_eq!(json["data"]["alreadyDeclared"], true);
        assert_eq!(json["data"]["pending"], false);
        assert!(json["data"]["origin"].is_null());

        // Unmanaged Skill and invalid input are rejected without writes.
        let missing = super::env_request_report(
            CliAccount::state(crate::cli::CliAccountState::Guest),
            &managed_root,
            "not-managed",
            "FAL_KEY",
            None,
            |_, _, _| panic!("must not write for an unmanaged Skill"),
        );
        assert_eq!(missing.exit_code(), crate::cli::EXIT_USAGE);
        let missing: serde_json::Value = serde_json::from_str(missing.json()).unwrap();
        assert_eq!(missing["error"]["code"], "NOT_FOUND");
        let secret_reason = super::env_request_report(
            CliAccount::state(crate::cli::CliAccountState::Guest),
            &managed_root,
            "writer",
            "FAL_KEY",
            Some("FAL_KEY=abcdefgh12345678"),
            |_, _, _| panic!("must not write a secret-looking reason"),
        );
        assert_eq!(secret_reason.exit_code(), crate::cli::EXIT_USAGE);
    }

    // ── On-disk identity fixtures ────────────────────────────────────────
    //
    // The primary fixture mirrors a real import: the managed directory is a
    // slug, the sidecar `id` is a UUID, and the projection `name` may differ
    // from both. Legacy `id == directory` sidecars are a separate compatibility
    // case, not the main path.

    const LOCAL_UUID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const ENTRY_ID: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    struct ManagedRoot(std::path::PathBuf);

    impl ManagedRoot {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "skillhub-cli-env-identity-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&root).expect("create managed root");
            Self(root)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }

        fn write_skill(&self, directory: &str, sidecar: &str) -> std::path::PathBuf {
            let skill = self.0.join(directory);
            std::fs::create_dir_all(&skill).expect("create skill directory");
            std::fs::write(skill.join("SKILL.md"), "# fixture\n").expect("write SKILL.md");
            std::fs::write(skill.join(".skillhub.json"), sidecar).expect("write sidecar");
            skill
        }
    }

    impl Drop for ManagedRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn sidecar(id: Option<&str>, name: &str, extra: &str) -> String {
        let id = id.map_or("null".to_string(), |id| format!("\"{id}\""));
        format!(
            concat!(
                "{{\"version\":\"1\",\"skillhub\":{{\"id\":{id},\"name\":\"{name}\",",
                "\"displayName\":\"Fixture\",\"version\":\"1.0.0\",",
                "\"envDependencies\":[{{\"key\":\"FIXTURE_API_KEY\",\"required\":true,",
                "\"sharePolicy\":\"private\",\"sharedTeams\":[]}}]{extra}}}}}"
            ),
            id = id,
            name = name,
            extra = extra
        )
    }

    #[test]
    fn imported_skill_with_uuid_sidecar_and_slug_directory_reads_successfully() {
        let root = ManagedRoot::new();
        root.write_skill(
            "davinci-edit-master",
            &sidecar(Some(LOCAL_UUID), "davinci-edit-master", ""),
        );

        let (profile, sha256) = read_profile_snapshot_at(root.path(), "davinci-edit-master")
            .expect("UUID sidecar reads");
        assert_eq!(profile.id.as_deref(), Some(LOCAL_UUID));
        assert_eq!(sha256.len(), 64);
        assert_eq!(profile.env_dependencies.len(), 1);
    }

    #[test]
    fn migrated_account_library_skill_keeps_slug_directory_and_uuid_identity() {
        let root = ManagedRoot::new();
        let extra = format!(
            ",\"libraryAccountId\":\"{USER_ID}\",\"libraryEntryId\":\"{ENTRY_ID}\",\"addedByAccountId\":\"{USER_ID}\""
        );
        root.write_skill("writer", &sidecar(Some(LOCAL_UUID), "writer", &extra));

        let (profile, _) =
            read_profile_snapshot_at(root.path(), "writer").expect("migrated sidecar reads");
        assert_eq!(profile.library_entry_id.as_deref(), Some(ENTRY_ID));
        assert_eq!(profile.id.as_deref(), Some(LOCAL_UUID));
    }

    #[test]
    fn projection_name_may_differ_from_managed_directory() {
        let root = ManagedRoot::new();
        // A store/team asset named `writer` landed in a distinct managed
        // directory because `writer` was already taken locally.
        root.write_skill("writer-2", &sidecar(Some(LOCAL_UUID), "writer", ""));

        let (profile, _) =
            read_profile_snapshot_at(root.path(), "writer-2").expect("name != directory is valid");
        assert_eq!(profile.name.as_deref(), Some("writer"));
    }

    #[test]
    fn legacy_sidecar_named_after_directory_remains_compatible() {
        let root = ManagedRoot::new();
        root.write_skill(
            "legacy-skill",
            &sidecar(Some("legacy-skill"), "legacy-skill", ""),
        );

        assert!(read_profile_snapshot_at(root.path(), "legacy-skill").is_ok());
    }

    #[test]
    fn sidecar_identity_outside_both_domains_is_rejected() {
        let root = ManagedRoot::new();
        root.write_skill("missing-id", &sidecar(None, "missing-id", ""));
        root.write_skill(
            "other-slug",
            &sidecar(Some("some-other-skill"), "other-slug", ""),
        );
        root.write_skill(
            "uppercase-uuid",
            &sidecar(
                Some("CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC"),
                "uppercase-uuid",
                "",
            ),
        );

        for directory in ["missing-id", "other-slug", "uppercase-uuid"] {
            assert_eq!(
                read_profile_snapshot_at(root.path(), directory).unwrap_err(),
                ProfileReadError::Identity,
                "{directory}"
            );
        }
        assert_eq!(
            read_profile_snapshot_at(root.path(), "../escape").unwrap_err(),
            ProfileReadError::Identity
        );
    }

    #[test]
    fn unsafe_or_broken_records_are_classified_not_collapsed() {
        let root = ManagedRoot::new();
        assert_eq!(
            read_profile_snapshot_at(root.path(), "absent").unwrap_err(),
            ProfileReadError::Missing
        );
        std::fs::create_dir_all(root.path().join("no-sidecar")).unwrap();
        assert_eq!(
            read_profile_snapshot_at(root.path(), "no-sidecar").unwrap_err(),
            ProfileReadError::Missing
        );
        root.write_skill("broken-json", "{\"version\":\"1\",\"skillhub\":{");
        assert_eq!(
            read_profile_snapshot_at(root.path(), "broken-json").unwrap_err(),
            ProfileReadError::Malformed
        );
        root.write_skill("no-envelope", "{\"version\":\"1\"}");
        assert_eq!(
            read_profile_snapshot_at(root.path(), "no-envelope").unwrap_err(),
            ProfileReadError::Malformed
        );
        #[cfg(unix)]
        {
            let real = root.write_skill("real", &sidecar(Some(LOCAL_UUID), "real", ""));
            std::os::unix::fs::symlink(&real, root.path().join("linked")).unwrap();
            assert_eq!(
                read_profile_snapshot_at(root.path(), "linked").unwrap_err(),
                ProfileReadError::Unsafe
            );
            let linked_sidecar = root.path().join("linked-sidecar");
            std::fs::create_dir_all(&linked_sidecar).unwrap();
            std::os::unix::fs::symlink(
                real.join(".skillhub.json"),
                linked_sidecar.join(".skillhub.json"),
            )
            .unwrap();
            assert_eq!(
                read_profile_snapshot_at(root.path(), "linked-sidecar").unwrap_err(),
                ProfileReadError::Unsafe
            );
        }
    }

    #[test]
    fn full_status_reports_skipped_records_instead_of_a_silent_empty_list() {
        let root = ManagedRoot::new();
        root.write_skill(
            "davinci-edit-master",
            &sidecar(Some(LOCAL_UUID), "davinci-edit-master", ""),
        );
        root.write_skill(
            "legacy-skill",
            &sidecar(Some("legacy-skill"), "legacy-skill", ""),
        );
        root.write_skill(
            "other-slug",
            &sidecar(Some("some-other-skill"), "other-slug", ""),
        );
        root.write_skill("broken-json", "not json");
        std::fs::create_dir_all(root.path().join("no-sidecar")).unwrap();
        std::fs::create_dir_all(root.path().join(".hidden-name")).unwrap();
        std::fs::write(root.path().join("stray-file.txt"), "ignored").unwrap();
        // A Skill without environment dependencies is simply not a target.
        root.write_skill(
            "no-env",
            "{\"version\":\"1\",\"skillhub\":{\"id\":\"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee\",\"name\":\"no-env\",\"version\":\"1.0.0\"}}",
        );

        #[cfg(unix)]
        std::os::unix::fs::symlink(root.path().join("legacy-skill"), root.path().join("linked"))
            .unwrap();

        let result =
            profile_targets_at(root.path(), None).expect("partial failure is not a hard failure");
        let targets = result
            .targets
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(targets, ["davinci-edit-master", "legacy-skill"]);
        assert_eq!(
            result.skipped,
            vec![
                SkippedProfile {
                    local_skill_id: None,
                    reason: "invalid_directory_name",
                },
                SkippedProfile {
                    local_skill_id: Some("broken-json".into()),
                    reason: "profile_malformed",
                },
                #[cfg(unix)]
                SkippedProfile {
                    local_skill_id: Some("linked".into()),
                    reason: "unsafe_directory",
                },
                SkippedProfile {
                    local_skill_id: Some("no-sidecar".into()),
                    reason: "profile_missing",
                },
                SkippedProfile {
                    local_skill_id: Some("other-slug".into()),
                    reason: "identity_invalid",
                },
            ]
        );

        let (warnings, next_actions) = env_status_completeness_notes(&result.skipped);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("个本地 Skill 记录无法安全读取"));
        assert!(warnings[0].contains("broken-json、"));
        assert!(warnings[0].contains("no-sidecar、other-slug"));
        assert!(!warnings[0].contains(".hidden-name"));
        assert_eq!(next_actions.len(), 1);
        assert!(next_actions[0].contains("不代表它们的环境变量缺失"));

        assert_eq!(env_status_completeness_notes(&[]), (Vec::new(), Vec::new()));
    }

    #[test]
    fn single_target_propagates_the_typed_read_error() {
        let root = ManagedRoot::new();
        root.write_skill(
            "other-slug",
            &sidecar(Some("some-other-skill"), "other-slug", ""),
        );
        assert_eq!(
            profile_targets_at(root.path(), Some("other-slug")).unwrap_err(),
            ProfileReadError::Identity
        );
        assert_eq!(
            profile_targets_at(root.path(), Some("absent")).unwrap_err(),
            ProfileReadError::Missing
        );
        let single = profile_targets_at(root.path(), Some("other-slug"));
        assert!(single.is_err());
    }

    #[test]
    fn sidecar_identity_helper_accepts_only_uuid_or_directory_name() {
        use crate::sidecar_identity_matches_directory as matches;
        assert!(matches(Some(LOCAL_UUID), "writer"));
        assert!(matches(Some("writer"), "writer"));
        assert!(!matches(None, "writer"));
        assert!(!matches(Some("Writer"), "writer"));
        assert!(!matches(
            Some("CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC"),
            "writer"
        ));
        assert!(!matches(Some("cccccccccccc4ccc8ccccccccccccccc"), "writer"));
    }

    // ── Command-level responses ──────────────────────────────────────────
    //
    // The full `env status` envelope, built from fixture roots through the
    // same report function the live command uses, with a session that has no
    // Server. These pin `ok`, `complete`, `skipped`, `skillCount`, the error
    // codes and exit codes, and that no stored value ever reaches the output.

    struct FixtureSession;

    impl super::EnvStatusSession for FixtureSession {
        fn user_id(&self) -> &str {
            USER_ID
        }
        async fn runtime_options(
            &self,
            _account: crate::cli::CliAccount,
            _server_skill_id: &str,
        ) -> Result<RuntimeEnvOptions, crate::cli::CliCommandOutput> {
            panic!("fixtures have no serverId, so the Server is never consulted")
        }
        fn verify_current(&self) -> Result<(), crate::cli::CliCommandOutput> {
            Ok(())
        }
    }

    const SECRET_VALUE: &str = "fixture-secret-value-do-not-print";

    fn status(home: &ManagedRoot, skill: Option<&str>) -> (serde_json::Value, i32) {
        let roots = super::EnvStatusRoots::under(home.path());
        let output = tauri::async_runtime::block_on(super::env_status_report(
            &FixtureSession,
            CliAccount::local(crate::cli::CliAccountState::Unverified, USER_ID),
            skill,
            &roots,
        ));
        let json = output.json().to_string();
        assert!(
            !json.contains(SECRET_VALUE),
            "env status leaked a stored value"
        );
        assert!(!json.to_ascii_lowercase().contains("\"value\""));
        (
            serde_json::from_str(&json).expect("CLI JSON envelope"),
            output.exit_code(),
        )
    }

    /// A fixture home: `<home>/.skillhub/skills/<dir>` plus a personal env file
    /// for the account so `missing` can be asserted both ways.
    fn home_with(skills: &[(&str, &str)], env_for: &[&str]) -> ManagedRoot {
        let home = ManagedRoot::new();
        let managed = home.path().join(".skillhub/skills");
        std::fs::create_dir_all(&managed).unwrap();
        for (directory, sidecar_json) in skills {
            let skill = managed.join(directory);
            std::fs::create_dir_all(&skill).unwrap();
            std::fs::write(skill.join("SKILL.md"), "# fixture\n").unwrap();
            std::fs::write(skill.join(".skillhub.json"), sidecar_json).unwrap();
        }
        // Personal env files are private storage: the reader insists on
        // owner-only permissions, as the APP writes them.
        let envs = home.path().join(".skillhub/envs").join(USER_ID);
        std::fs::create_dir_all(&envs).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            for dir in [home.path().join(".skillhub/envs"), envs.clone()] {
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
        }
        for directory in env_for {
            let path = envs.join(format!("{directory}.env"));
            std::fs::write(&path, format!("FIXTURE_API_KEY={SECRET_VALUE}\n")).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            }
        }
        home
    }

    #[test]
    fn env_status_single_uuid_skill_reports_ready_with_full_envelope() {
        let home = home_with(
            &[(
                "davinci-edit-master",
                &sidecar(Some(LOCAL_UUID), "davinci-edit-master", ""),
            )],
            &["davinci-edit-master"],
        );
        let (json, exit) = status(&home, Some("davinci-edit-master"));
        assert_eq!(exit, 0);
        assert_eq!(json["ok"], true);
        assert_eq!(json["command"], "env status");
        assert_eq!(json["data"]["skillCount"], 1);
        assert_eq!(json["data"]["complete"], true);
        assert_eq!(json["data"]["skipped"], json!([]));
        assert_eq!(json["data"]["valuesExposed"], false);
        assert_eq!(json["data"]["serverTargetCount"], 0);
        let skill = &json["data"]["skills"][0];
        assert_eq!(skill["localSkillId"], "davinci-edit-master");
        assert_eq!(skill["skillAccess"], "local_only");
        assert_eq!(skill["ready"], true);
        assert_eq!(skill["requiredMissing"], 0);
        assert_eq!(skill["dependencies"][0]["key"], "FIXTURE_API_KEY");
        assert_eq!(skill["dependencies"][0]["missing"], false);
        assert_eq!(skill["dependencies"][0]["source"], "override");
        assert_eq!(json["warnings"], json!([]));
    }

    #[test]
    fn env_status_reports_vault_source_and_pending_consent_without_values() {
        let home = home_with(
            &[
                ("own-skill", &sidecar(Some("own-skill"), "own-skill", "")),
                (
                    "store-skill",
                    &sidecar(
                        Some("store-skill"),
                        "store-skill",
                        r#","isOwn":false,"acquisitionSource":"marketplace""#,
                    ),
                ),
            ],
            &[],
        );
        let skillhub_root = home
            .path()
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            });
        crate::key_vault::set_vault_key_at(
            &skillhub_root,
            USER_ID,
            "FIXTURE_API_KEY",
            SECRET_VALUE,
            None,
            1,
        )
        .expect("fill vault");
        let (json, exit) = status(&home, None);
        assert_eq!(exit, 0);
        let skills = json["data"]["skills"].as_array().expect("skills");
        let own = skills
            .iter()
            .find(|skill| skill["localSkillId"] == "own-skill")
            .expect("own");
        assert_eq!(own["dependencies"][0]["source"], "vault");
        assert_eq!(own["dependencies"][0]["authorization"], "local");
        assert_eq!(own["ready"], true);
        let store = skills
            .iter()
            .find(|skill| skill["localSkillId"] == "store-skill")
            .expect("store");
        assert_eq!(store["dependencies"][0]["source"], "vault");
        assert_eq!(store["dependencies"][0]["authorization"], "needs_consent");
        assert_eq!(store["dependencies"][0]["missing"], false);
        assert_eq!(store["needsConsent"], json!(["FIXTURE_API_KEY"]));
        assert_eq!(store["ready"], false);
        assert_eq!(own["lastRun"], serde_json::Value::Null);
    }

    #[test]
    fn env_status_names_the_labelled_value_a_skill_uses() {
        let home = home_with(
            &[
                ("own-skill", &sidecar(Some("own-skill"), "own-skill", "")),
                (
                    "other-skill",
                    &sidecar(Some("other-skill"), "other-skill", ""),
                ),
            ],
            &[],
        );
        let skillhub_root = home
            .path()
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            });
        crate::key_vault::set_vault_key_at(
            &skillhub_root,
            USER_ID,
            "FIXTURE_API_KEY",
            SECRET_VALUE,
            None,
            1,
        )
        .expect("fill vault");
        let variant = crate::key_vault::create_vault_key_variant_at(
            &skillhub_root,
            USER_ID,
            "FIXTURE_API_KEY",
            "公司",
            "fixture-work-value",
            None,
            2,
        )
        .expect("variant");
        crate::runtime_env::set_personal_variant_policy_at(
            &skillhub_root,
            USER_ID,
            "own-skill",
            "FIXTURE_API_KEY",
            Some(&variant),
        )
        .expect("policy");
        let (json, exit) = status(&home, None);
        assert_eq!(exit, 0);
        let skills = json["data"]["skills"].as_array().expect("skills");
        let row = |id: &str| {
            skills
                .iter()
                .find(|skill| skill["localSkillId"] == id)
                .expect("skill")["dependencies"][0]
                .clone()
        };
        let own = row("own-skill");
        assert_eq!(own["source"], "vault");
        assert_eq!(own["selection"], "explicit");
        assert_eq!(own["variant"], "V1");
        assert_eq!(own["label"], "公司");
        let other = row("other-skill");
        assert_eq!(other["source"], "vault");
        assert!(other.get("variant").is_none() && other.get("label").is_none());
        let text = json.to_string();
        assert!(!text.contains(SECRET_VALUE) && !text.contains("fixture-work-value"));
    }

    #[test]
    fn env_status_includes_the_last_run_record_without_values() {
        let home = home_with(
            &[("own-skill", &sidecar(Some("own-skill"), "own-skill", ""))],
            &[],
        );
        let skillhub_root = home
            .path()
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            });
        crate::last_run::record_run_outcome_at(
            &skillhub_root,
            Some(USER_ID),
            "own-skill",
            &crate::last_run::RunObservation::ResolveFailed(
                "MISSING_KEY: FIXTURE_API_KEY 需要填写：请在 SkillHub APP 的 Skill 详情「需要的钥匙」中填写",
            ),
            Some("codex"),
        );
        let (json, exit) = status(&home, None);
        assert_eq!(exit, 0);
        let last_run = &json["data"]["skills"][0]["lastRun"];
        assert_eq!(last_run["outcome"], "failed");
        assert_eq!(last_run["reasonCode"], "missing_key");
        assert_eq!(last_run["keys"], json!(["FIXTURE_API_KEY"]));
        assert_eq!(last_run["agent"], "codex");
        assert!(!json.to_string().contains(SECRET_VALUE));
    }

    #[test]
    fn env_status_full_report_keeps_good_records_and_names_the_skipped_ones() {
        let home = home_with(
            &[
                (
                    "davinci-edit-master",
                    &sidecar(Some(LOCAL_UUID), "davinci-edit-master", ""),
                ),
                (
                    "legacy-skill",
                    &sidecar(Some("legacy-skill"), "legacy-skill", ""),
                ),
                (
                    "other-slug",
                    &sidecar(Some("some-other-skill"), "other-slug", ""),
                ),
                ("broken-json", "{\"version\":\"1\",\"skillhub\":{"),
            ],
            &["davinci-edit-master"],
        );
        std::fs::create_dir_all(home.path().join(".skillhub/skills/no-sidecar")).unwrap();
        std::fs::write(home.path().join(".skillhub/skills/.DS_Store"), "x").unwrap();
        let (json, exit) = status(&home, None);
        assert_eq!(exit, 0);
        assert_eq!(json["ok"], true, "partial failure is reported, not fatal");
        assert_eq!(json["data"]["skillCount"], 2);
        assert_eq!(json["data"]["complete"], false);
        assert_eq!(
            json["data"]["skipped"],
            json!([
                { "localSkillId": "broken-json", "reason": "profile_malformed" },
                { "localSkillId": "no-sidecar", "reason": "profile_missing" },
                { "localSkillId": "other-slug", "reason": "identity_invalid" },
            ])
        );
        let ids = json["data"]["skills"]
            .as_array()
            .unwrap()
            .iter()
            .map(|skill| skill["localSkillId"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(ids, ["davinci-edit-master", "legacy-skill"]);
        assert_eq!(json["data"]["skills"][0]["ready"], true);
        assert_eq!(
            json["data"]["skills"][1]["ready"], false,
            "legacy skill has no stored value"
        );
        assert_eq!(json["data"]["skills"][1]["requiredMissing"], 1);
        let warning = json["warnings"][0].as_str().unwrap();
        assert!(
            warning.starts_with("3 个本地 Skill 记录无法安全读取"),
            "{warning}"
        );
        assert!(warning.contains("broken-json、no-sidecar、other-slug"));
        assert!(json["nextActions"][0]
            .as_str()
            .unwrap()
            .contains("不代表它们的环境变量缺失"));
    }

    #[test]
    fn env_status_with_only_invalid_records_is_an_explicit_empty_partial_result() {
        let home = home_with(
            &[
                (
                    "other-slug",
                    &sidecar(Some("some-other-skill"), "other-slug", ""),
                ),
                ("broken-json", "nope"),
            ],
            &[],
        );
        let (json, exit) = status(&home, None);
        assert_eq!(exit, 0);
        assert_eq!(json["ok"], true);
        assert_eq!(json["data"]["skillCount"], 0);
        assert_eq!(
            json["data"]["complete"], false,
            "zero skills with skipped records is not a clean empty list"
        );
        assert_eq!(json["data"]["skipped"].as_array().unwrap().len(), 2);
        assert_eq!(json["warnings"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn env_status_single_failures_are_typed_and_never_look_like_missing_keys() {
        let home = home_with(
            &[
                (
                    "other-slug",
                    &sidecar(Some("some-other-skill"), "other-slug", ""),
                ),
                ("broken-json", "nope"),
            ],
            &[],
        );
        std::fs::create_dir_all(home.path().join(".skillhub/skills/no-sidecar")).unwrap();

        let (json, exit) = status(&home, Some("absent-skill"));
        assert_eq!(
            (json["ok"].clone(), json["error"]["code"].clone(), exit),
            (json!(false), json!("NOT_FOUND"), 2)
        );
        assert!(json["nextActions"][0]
            .as_str()
            .unwrap()
            .contains("skill list"));

        let (json, exit) = status(&home, Some("no-sidecar"));
        assert_eq!(
            (json["error"]["code"].clone(), exit),
            (json!("NOT_FOUND"), 2),
            "missing sidecar is NOT_FOUND too"
        );

        let (json, exit) = status(&home, Some("other-slug"));
        assert_eq!(
            (json["error"]["code"].clone(), exit),
            (json!("VALIDATION_FAILED"), 1)
        );
        assert!(json["error"]["message"]
            .as_str()
            .unwrap()
            .contains("身份无效"));
        assert!(json["nextActions"][0]
            .as_str()
            .unwrap()
            .contains("不代表环境变量缺失"));

        let (json, exit) = status(&home, Some("broken-json"));
        assert_eq!(
            (json["error"]["code"].clone(), exit),
            (json!("VALIDATION_FAILED"), 1)
        );
        assert!(json["error"]["message"].as_str().unwrap().contains("JSON"));

        let (json, exit) = status(&home, Some("../escape"));
        assert_eq!(
            (json["error"]["code"].clone(), exit),
            (json!("VALIDATION_FAILED"), 1)
        );
    }
}
