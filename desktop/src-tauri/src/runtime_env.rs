#![cfg_attr(windows, allow(dead_code))]

#[cfg(windows)]
use crate::platform_fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use crate::{envs_dir, skillhub_dir, skills_dir, SkillHubJson};
use regex::Regex;
use reqwest::{Client, StatusCode, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
#[cfg(unix)]
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};
use zeroize::Zeroize;

const RUNTIME_STORE_VERSION: u8 = 1;
pub(crate) const AUTH_SYNC_PENDING_CODE: &str = "AUTH_SYNC_PENDING";
const MAX_RUNTIME_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_CLI_SHIM_BYTES: usize = 64 * 1024;
const MAX_CLI_PAYLOAD_BYTES: usize = 128 * 1024 * 1024;
const MAX_ZPROFILE_BYTES: usize = 1024 * 1024;
const PUBLIC_CLI_ALIAS_MARKER: &str = "# Managed by Yitan SkillHub public CLI alias v1";
const PRIVATE_CLI_LAUNCHER_MARKER: &str = "# Managed by Yitan SkillHub private runtime launcher v1";
const PRIVATE_CLI_LAUNCHER_NAME: &str = "yitan-skillhub-runtime";
#[cfg(unix)]
const PRIVATE_CLI_PAYLOAD_NAME: &str = "yitan-skillhub-cli";
#[cfg(windows)]
const PRIVATE_CLI_PAYLOAD_NAME: &str = "yitan-skillhub-cli.exe";
const PRIVATE_CLI_OWNERSHIP_NAME: &str = ".yitan-skillhub-cli-ownership.json";
const PRIVATE_CLI_OWNERSHIP_MARKER: &str = "Yitan SkillHub managed CLI payload";
const PRIVATE_CLI_OWNERSHIP_VERSION: u8 = 1;
#[cfg(windows)]
const WINDOWS_PUBLIC_CLI_NAME: &str = "skillhub.cmd";
#[cfg(windows)]
const WINDOWS_PUBLIC_CLI_MARKER: &str = "@REM Managed by Yitan SkillHub Windows CLI wrapper v1";
#[cfg(windows)]
const WINDOWS_PRIVATE_CLI_LAUNCHER_NAME: &str = "yitan-skillhub-runtime.ps1";
#[cfg(windows)]
const WINDOWS_PRIVATE_CLI_LAUNCHER_MARKER_V1: &str =
    "# Managed by Yitan SkillHub Windows private runtime launcher v1";
#[cfg(windows)]
const WINDOWS_PRIVATE_CLI_LAUNCHER_MARKER: &str =
    "# Managed by Yitan SkillHub Windows private runtime launcher v2";
#[cfg(windows)]
const WINDOWS_LEGACY_CLI_NAME: &str = "skillhub.exe";
#[cfg(windows)]
const WINDOWS_LEGACY_OWNERSHIP_NAME: &str = "skillhub-windows-ownership.json";
const CLI_PATH_BLOCK: &str = "# >>> Yitan SkillHub CLI >>>\nexport PATH=\"$HOME/.local/bin:$PATH\"\n# <<< Yitan SkillHub CLI <<<\n";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCliStatus {
    managed: bool,
    ready: bool,
    command_path: String,
    error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CliPayloadOwnership {
    version: u8,
    marker: String,
    accepted_sha256: BTreeSet<String>,
}

#[cfg(windows)]
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WindowsCliOwnership {
    version: u8,
    accepted_sha256: BTreeSet<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RuntimeSessionState {
    #[default]
    Stable,
    SyncPending,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimeSession {
    version: u8,
    #[serde(default)]
    deployment: crate::spaces::Deployment,
    #[serde(default = "crate::spaces::official_id")]
    space_id: String,
    user_id: String,
    #[serde(default)]
    auth_token: Option<String>,
    #[serde(default)]
    state: RuntimeSessionState,
    #[serde(default)]
    generation: u64,
}

impl std::fmt::Debug for RuntimeSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeSession")
            .field("version", &self.version)
            .field("user_id", &self.user_id)
            .field(
                "auth_token",
                &self.auth_token.as_ref().map(|_| "<redacted>"),
            )
            .field("state", &self.state)
            .field("generation", &self.generation)
            .finish()
    }
}

impl RuntimeSession {
    pub(crate) fn deployment(&self) -> &crate::spaces::Deployment {
        &self.deployment
    }
    pub(crate) fn space_id(&self) -> &str {
        &self.space_id
    }
    pub(crate) fn storage_root(&self, home: &Path) -> PathBuf {
        self.deployment.root(home)
    }
    pub(crate) fn server_origin(&self) -> Result<Url, String> {
        ensure_session_stable(self)?;
        self.deployment
            .base()?
            .ok_or_else(|| "仅本机模式不连接业务服务器".into())
    }
    pub(crate) fn begin_switch(&mut self) -> Result<(), String> {
        self.generation = self.generation.checked_add(1).ok_or("空间代次已耗尽")?;
        self.version = 2;
        self.state = RuntimeSessionState::SyncPending;
        Ok(())
    }
    pub(crate) fn finish_switch(&mut self) -> Result<(), String> {
        self.generation = self.generation.checked_add(1).ok_or("空间代次已耗尽")?;
        self.version = 2;
        self.state = RuntimeSessionState::Stable;
        Ok(())
    }
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn user_id(&self) -> &str {
        &self.user_id
    }

    pub(crate) fn auth_token(&self) -> Option<&str> {
        self.auth_token.as_deref()
    }

    pub(crate) fn is_sync_pending(&self) -> bool {
        self.state == RuntimeSessionState::SyncPending
    }

    fn same_identity(&self, other: &Self) -> bool {
        self.deployment == other.deployment
            && self.space_id == other.space_id
            && self.user_id == other.user_id
            && self.auth_token == other.auth_token
            && self.state == other.state
            && self.generation == other.generation
    }
}

impl Drop for RuntimeSession {
    fn drop(&mut self) {
        if let Some(auth_token) = self.auth_token.as_mut() {
            auth_token.zeroize();
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GuestIdentity {
    version: u8,
    user_id: String,
}

#[derive(Clone, Copy)]
enum SessionLockMode {
    Shared,
    Exclusive,
}

pub(crate) struct SessionLease {
    _file: File,
}

/// Holds a shared Runtime Session lease after proving the session still
/// matches an earlier snapshot. While this value is alive, APP login/logout
/// transitions cannot replace that session.
pub(crate) struct CurrentSessionLease {
    _lease: SessionLease,
}

/// Exclusive Runtime Session lease for one-time local data migrations (#253):
/// while held, no login, logout, account switch or `run` finalization can
/// interleave with the rewrite.
pub(crate) struct ExclusiveSessionLease {
    _lease: SessionLease,
}

pub(crate) fn acquire_exclusive_session_lease_at(
    root: &Path,
) -> Result<ExclusiveSessionLease, String> {
    acquire_session_lock_at(root, SessionLockMode::Exclusive)
        .map(|lease| ExclusiveSessionLease { _lease: lease })
}

/// Which runtime identity an import or install into SkillHub belongs to
/// (#91). Captured once, when the operation starts: the Skill is stamped with
/// that signed-in account (never whoever is signed in later) and its local
/// env values are stored for that identity (an account or the guest).
/// `commit` must be held across every step that makes the Skill or its
/// values appear: it proves the APP session is still exactly the captured
/// one (no login, logout or switch since the start) and keeps it so until
/// dropped. Mid-switch or unreadable at the start: nothing is attributed and
/// no identity is known for env values.
pub(crate) struct ImportAttribution {
    session: Option<RuntimeSession>,
    account_id: Option<String>,
}

impl ImportAttribution {
    pub(crate) fn begin_expected(
        space: &crate::server_request::SpaceHandle,
    ) -> Result<Self, String> {
        let attribution = Self::begin();
        crate::spaces::require_handle(
            attribution.session.as_ref().ok_or(IMPORT_ACCOUNT_CHANGED)?,
            space,
        )?;
        Ok(attribution)
    }
    pub(crate) fn begin() -> Self {
        Self::begin_at(&skillhub_dir())
    }

    pub(crate) fn begin_at(root: &Path) -> Self {
        let session = runtime_session_snapshot_at(root)
            .ok()
            .filter(|session| !session.is_sync_pending());
        let account_id = session
            .as_ref()
            .filter(|session| session.auth_token().is_some())
            .and_then(|session| uuid::Uuid::parse_str(session.user_id()).ok())
            .map(|id| id.to_string());
        Self {
            session,
            account_id,
        }
    }

    /// The account signed in when the operation started (none for a guest).
    pub(crate) fn account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }

    pub(crate) fn scope(&self) -> Option<crate::spaces::SidecarScope> {
        self.session
            .as_ref()
            .map(crate::spaces::SidecarScope::for_session)
    }

    pub(crate) fn storage_root(&self, home: &Path) -> Result<PathBuf, String> {
        self.session
            .as_ref()
            .map(|session| session.storage_root(home))
            .ok_or_else(|| IMPORT_ACCOUNT_CHANGED.into())
    }

    /// The runtime identity (account or guest) at the start, which owns the
    /// import's local env values.
    pub(crate) fn runtime_user_id(&self) -> Option<&str> {
        self.session.as_ref().map(RuntimeSession::user_id)
    }

    /// Hold across the commit. Fails when the account changed since `begin`.
    pub(crate) fn commit(&self) -> Result<Option<CurrentSessionLease>, String> {
        self.commit_at(&skillhub_dir())
    }

    pub(crate) fn commit_at(&self, root: &Path) -> Result<Option<CurrentSessionLease>, String> {
        let Some(session) = &self.session else {
            if root.join("runtime/session.json").exists() {
                return Err(IMPORT_ACCOUNT_CHANGED.into());
            }
            return Ok(None);
        };
        acquire_current_session_lease_at(root, session)?
            .map(Some)
            .ok_or_else(|| IMPORT_ACCOUNT_CHANGED.to_string())
    }
}

pub(crate) const IMPORT_ACCOUNT_CHANGED: &str =
    "导入期间 SkillHub 账号已切换或退出，这次导入没有完成；请在当前账号下重新导入";

struct ResolvedEnvironment {
    values: Vec<(String, String)>,
    session_lease: Option<SessionLease>,
}

impl ResolvedEnvironment {
    fn run(mut self, program: &str, args: &[String]) -> Result<i32, String> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        for (key, value) in &self.values {
            command.env(key, value);
        }

        // Keep the account lease through process creation so an APP account
        // transition cannot race between credential resolution and inheritance.
        let child = command.spawn();
        self.zeroize_values();
        self.session_lease.take();

        let mut child = child.map_err(|error| format!("无法启动目标进程: {error}"))?;
        let status = child
            .wait()
            .map_err(|error| format!("无法等待目标进程结束: {error}"))?;
        Ok(exit_status_code(status))
    }

    fn zeroize_values(&mut self) {
        for (_, value) in &mut self.values {
            value.zeroize();
        }
        self.values.clear();
    }
}

impl Drop for ResolvedEnvironment {
    fn drop(&mut self) {
        self.zeroize_values();
    }
}

fn exit_status_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt as _;
        status.signal().map_or(1, |signal| 128 + signal)
    }
    #[cfg(not(unix))]
    {
        1
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SkillEnvSource {
    Personal,
    Team {
        #[serde(rename = "teamId", alias = "team_id")]
        team_id: String,
    },
    /// One labelled value of the personal key (#306), injected under the
    /// declared name. A variant that no longer exists falls back to the
    /// name's default value silently.
    /// `variant: null` picks the unlabelled value explicitly, even when the
    /// default pointer names a labelled one; plain `Personal` follows the
    /// pointer.
    #[serde(alias = "personal_variant")]
    PersonalVariant {
        variant: Option<String>,
    },
}

/// Declared name → labelled value the Skill's policy picked (#306).
fn variant_choices(
    policy: Option<&BTreeMap<String, SkillEnvSource>>,
) -> crate::key_vault::VariantChoices {
    policy
        .into_iter()
        .flatten()
        .filter_map(|(key, source)| match source {
            SkillEnvSource::PersonalVariant { variant } => Some((key.clone(), variant.clone())),
            _ => None,
        })
        .collect()
}

/// [`variant_choices`] read from the stored policy of `skill_id`; best
/// effort (an unreadable policy picks nothing, i.e. the defaults).
pub(crate) fn personal_variant_choices_at(
    root: &Path,
    user_id: &str,
    skill_id: &str,
) -> crate::key_vault::VariantChoices {
    if validate_user_id(user_id).is_err() {
        return BTreeMap::new();
    }
    read_policy_at(root, user_id)
        .map(|policy| variant_choices(policy.skills.get(skill_id)))
        .unwrap_or_default()
}

/// Points `skill_id`'s `key` at the labelled value `variant` (#306).
pub(crate) fn set_personal_variant_policy_at(
    root: &Path,
    user_id: &str,
    skill_id: &str,
    key: &str,
    variant: Option<&str>,
) -> Result<(), String> {
    validate_skill_id(skill_id)?;
    if let Some(variant) = variant {
        crate::key_vault::validate_variant_id(variant)?;
    }
    if !valid_env_key(key) {
        return Err("环境变量名无效".into());
    }
    let mut policy = read_policy_at(root, user_id)?;
    policy
        .skills
        .entry(skill_id.to_string())
        .or_default()
        .insert(
            key.to_string(),
            SkillEnvSource::PersonalVariant {
                variant: variant.map(str::to_string),
            },
        );
    write_policy_at(root, user_id, &policy)
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccountSourcePolicy {
    version: u8,
    #[serde(default)]
    skills: BTreeMap<String, BTreeMap<String, SkillEnvSource>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SkillEnvSourceOption {
    Personal {
        available: bool,
    },
    Team {
        #[serde(rename = "teamId")]
        team_id: String,
        #[serde(rename = "teamName")]
        team_name: String,
        available: bool,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEnvSourcePolicyRow {
    key: String,
    description: Option<String>,
    required: bool,
    selected: Option<SkillEnvSource>,
    /// The source `skillhub run` would actually use right now: the explicit
    /// choice when it is available, otherwise personal, otherwise the only
    /// available team. `None` when nothing is usable or several teams compete.
    effective: Option<SkillEnvSource>,
    valid: bool,
    state: SkillEnvRowState,
    options: Vec<SkillEnvSourceOption>,
    /// Where the effective value comes from: `override` (this Skill's own
    /// value), `vault` (the account key vault) or `team`; `None` when nothing
    /// is usable.
    source: Option<&'static str>,
    /// Where the personal value, if any, comes from.
    personal_source: Option<crate::key_vault::PersonalSource>,
    /// The vault value is effective but this Skill must be allowed first; a
    /// `run` fails with `NEEDS_CONSENT` until the user answers in the APP.
    needs_consent: bool,
    /// Every value of the vault name behind this key (#306): the unlabelled
    /// one (`id: null`) and the labelled ones; empty without a vault value.
    personal_variants: Vec<crate::key_vault::KeyVariantOption>,
    /// The labelled value this Skill uses when the vault serves it; `None`
    /// for the unlabelled value or another source.
    selected_variant: Option<String>,
}

/// Distinguishes "the user must fill in a value" from "the user must pick one
/// of several available team values" so the UI can ask the right question.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillEnvRowState {
    Ready,
    NeedsValue,
    NeedsChoice,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeDependency {
    key: String,
    description: Option<String>,
    required: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeTeamSource {
    key: String,
    team_id: String,
    team_name: String,
    revision: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeOptionsResponse {
    skill_id: String,
    dependencies: Vec<RuntimeDependency>,
    sources: Vec<RuntimeTeamSource>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeTeamSelection {
    key: String,
    team_id: String,
    /// Chosen by the fixed resolution order (exactly one available team and
    /// no personal value), not by a stored policy. Local only; the Server
    /// request carries just `key` and `teamId`.
    #[serde(skip)]
    automatic: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeResolveRequest {
    skill_id: String,
    sources: Vec<RuntimeTeamSelection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeCredential {
    key: String,
    value: String,
    team_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeResolveResponse {
    dependencies: Vec<RuntimeDependency>,
    credentials: Vec<RuntimeCredential>,
}

#[derive(Debug, Deserialize)]
struct ErrorResponse {
    error: Option<String>,
    message: Option<String>,
}

pub(crate) struct RuntimeApi {
    pub(crate) client: Client,
    origin: Url,
}

impl RuntimeApi {
    pub(crate) async fn for_session(session: &RuntimeSession) -> Result<Self, String> {
        crate::spaces::verify_remote_identity(session).await?;
        let origin = session.server_origin()?;
        let client = crate::net::client_builder(&origin)?
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            .user_agent(concat!(
                "Yitan-SkillHub/",
                env!("CARGO_PKG_VERSION"),
                " runtime-env"
            ))
            .build()
            .map_err(|_| "无法初始化 SkillHub 环境变量连接".to_string())?;
        Ok(Self { client, origin })
    }

    pub(crate) fn url(&self, suffix: &str) -> Result<Url, String> {
        if !suffix.starts_with('/') || suffix.contains(['?', '#']) {
            return Err("SkillHub 运行时服务路径无效".into());
        }
        let mut url = self.origin.clone();
        let base = url.path().trim_end_matches('/');
        url.set_path(&format!("{base}{suffix}"));
        Ok(url)
    }

    async fn options(&self, token: &str, skill_id: &str) -> Result<RuntimeOptionsResponse, String> {
        let mut url = self.url("/api/runtime/env/options")?;
        url.query_pairs_mut().append_pair("skillId", skill_id);
        let response = self
            .client
            .get(url)
            .bearer_auth(token)
            .header(reqwest::header::CACHE_CONTROL, "no-store")
            .send()
            .await
            .map_err(|_| "无法读取环境变量来源".to_string())?;
        parse_response(response).await
    }

    async fn resolve(
        &self,
        token: &str,
        skill_id: &str,
        sources: Vec<RuntimeTeamSelection>,
    ) -> Result<RuntimeResolveResponse, String> {
        let response = self
            .client
            .post(self.url("/api/runtime/env")?)
            .bearer_auth(token)
            .header(reqwest::header::CACHE_CONTROL, "no-store")
            .json(&RuntimeResolveRequest {
                skill_id: skill_id.to_string(),
                sources,
            })
            .send()
            .await
            .map_err(|_| "无法获取 Skill 环境变量".to_string())?;
        parse_response(response).await
    }
}

pub(crate) fn trusted_server_origin() -> Result<Url, String> {
    let origin = Url::parse(&crate::official_channel::COMPILED.server_origin)
        .map_err(|_| "SkillHub 服务地址配置无效".to_string())?;
    crate::net::validate_base_url(&origin)?;
    Ok(origin)
}

pub(crate) async fn parse_response<T: DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, String> {
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "无法读取 SkillHub 运行时响应".to_string())?;
    if bytes.len() > MAX_RUNTIME_JSON_BYTES {
        return Err("SkillHub 运行时响应过大".into());
    }
    if !status.is_success() {
        let payload = serde_json::from_slice::<ErrorResponse>(&bytes).ok();
        let message = payload
            .and_then(|value| value.error.or(value.message))
            .unwrap_or_else(|| format!("SkillHub 运行时请求失败 ({status})"));
        return if status == StatusCode::UNAUTHORIZED {
            Err("当前 SkillHub 登录已失效，请打开 APP 重新登录".into())
        } else {
            Err(message)
        };
    }
    serde_json::from_slice(&bytes).map_err(|_| "SkillHub 运行时响应格式无效".to_string())
}

fn runtime_dir_at(root: &Path) -> PathBuf {
    root.join("runtime")
}

fn session_path_at(root: &Path) -> PathBuf {
    runtime_dir_at(root).join("session.json")
}

fn guest_identity_path_at(root: &Path) -> PathBuf {
    runtime_dir_at(root).join("guest.json")
}

fn policy_path_at(root: &Path, user_id: &str) -> PathBuf {
    runtime_dir_at(root)
        .join("policies")
        .join(format!("{user_id}.json"))
}

pub(crate) fn validate_user_id(user_id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(user_id)
        .map(|_| ())
        .map_err(|_| "SkillHub 账号编号无效".to_string())
}

pub(crate) fn validate_skill_id(skill_id: &str) -> Result<(), String> {
    let pattern =
        Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$").map_err(|error| error.to_string())?;
    if skill_id == "." || skill_id == ".." || !pattern.is_match(skill_id) {
        return Err("Skill id contains invalid characters".into());
    }
    Ok(())
}

pub(crate) fn valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    !key.is_empty()
        && key.len() <= 100
        && chars
            .next()
            .is_some_and(|character| character.is_ascii_uppercase())
        && chars.all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
}

pub(crate) fn ensure_private_directory(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(format!("拒绝使用符号链接私有目录: {}", path.display()));
    }
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())
}

fn acquire_session_lock_at(root: &Path, mode: SessionLockMode) -> Result<SessionLease, String> {
    acquire_session_lock_at_inner(root, mode, false)?
        .ok_or_else(|| "无法取得 SkillHub 运行时登录锁".to_string())
}

#[cfg(test)]
fn try_acquire_session_lock_at(
    root: &Path,
    mode: SessionLockMode,
) -> Result<Option<SessionLease>, String> {
    acquire_session_lock_at_inner(root, mode, true)
}

fn acquire_session_lock_at_inner(
    root: &Path,
    mode: SessionLockMode,
    nonblocking: bool,
) -> Result<Option<SessionLease>, String> {
    acquire_named_lock_at(root, "session.lock", mode, nonblocking)
}

pub(crate) fn try_named_lock_at(root: &Path, name: &str) -> Result<Option<SessionLease>, String> {
    if !matches!(name, "switch.lock" | "app.lock") {
        return Err("无效的空间锁".into());
    }
    acquire_named_lock_at(root, name, SessionLockMode::Exclusive, true)
}

/// Only the switch barrier has read-only observers; app ownership stays exclusive.
pub(crate) fn try_shared_switch_lock_at(root: &Path) -> Result<Option<SessionLease>, String> {
    acquire_named_lock_at(root, "switch.lock", SessionLockMode::Shared, true)
}

fn acquire_named_lock_at(
    root: &Path,
    name: &str,
    mode: SessionLockMode,
    nonblocking: bool,
) -> Result<Option<SessionLease>, String> {
    #[cfg(windows)]
    use windows_sys::Win32::Foundation::{
        ERROR_IO_PENDING, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION,
    };
    // flock belongs to the open file description: a dup or child-process copy
    // can keep it locked briefly after our lease drops, until close at exec.
    // This also applies to macOS posix_spawn (XNU fdt_fork -> fdt_exec), not
    // only fork; CLOEXEC does not prevent the temporary copy. Absorb contention for
    // both switch writers and observers, but still report a real switch as busy
    // after 200 ms. Keep blocking locks and app.lock's immediate ownership probe.
    let retry_deadline =
        (nonblocking && name == "switch.lock").then(|| Instant::now() + Duration::from_millis(200));
    let retry_expired = || retry_deadline.is_some_and(|deadline| Instant::now() >= deadline);
    let wait_for_switch_retry = || {
        let Some(remaining) = retry_deadline
            .and_then(|deadline| deadline.checked_duration_since(Instant::now()))
            .filter(|remaining| !remaining.is_zero())
        else {
            return false;
        };
        std::thread::sleep(remaining.min(Duration::from_millis(5)));
        // sleep can overshoot (notably on Windows). Never start another attempt
        // after the wall-clock budget, even if the requested sleep was shorter.
        !retry_expired()
    };
    let runtime_dir = runtime_dir_at(root);
    ensure_private_directory(&runtime_dir)?;
    let lock_path = runtime_dir.join(name);
    for _attempt in 0..400 {
        if _attempt > 0 && retry_expired() {
            return Ok(None);
        }
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(crate::platform_fs::NOFOLLOW_FLAG);
        #[cfg(windows)]
        {
            // Every lease owns its own handle, so the file itself must stay
            // openable by others; shared/exclusive semantics come from
            // LockFileEx below (#358). The private-file share mode set by
            // `custom_flags` would otherwise turn every shared lease into an
            // exclusive one and serialise all session readers.
            use std::os::windows::fs::OpenOptionsExt as _;
            options.share_mode(
                windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ
                    | windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE,
            );
        }
        let opened = options.open(&lock_path);
        #[cfg(windows)]
        let file = match opened {
            Ok(file) => file,
            // 32 is an incompatible share mode (e.g. a pre-#358 holder),
            // distinct from the byte-range lock conflict 33. Both open errors
            // consume the same switch budget as LockFileEx contention below.
            Err(error)
                if matches!(error.raw_os_error(), Some(code)
                    if code == ERROR_SHARING_VIOLATION as i32 || code == ERROR_LOCK_VIOLATION as i32) =>
            {
                if nonblocking {
                    if wait_for_switch_retry() {
                        continue;
                    }
                    return Ok(None);
                }
                if _attempt == 399 {
                    return Err("等待 SkillHub 运行时登录锁超时".into());
                }
                std::thread::sleep(Duration::from_millis(25));
                continue;
            }
            Err(error) => return Err(format!("无法打开 SkillHub 运行时登录锁: {error}")),
        };
        #[cfg(unix)]
        let file = opened.map_err(|error| format!("无法打开 SkillHub 运行时登录锁: {error}"))?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("无法检查 SkillHub 运行时登录锁: {error}"))?;
        if !metadata.is_file()
            || metadata.uid() != crate::platform_fs::current_uid()
            || metadata.nlink() != 1
            || metadata.mode() & 0o077 != 0
        {
            return Err("SkillHub 运行时登录锁不是安全的私有普通文件".into());
        }
        if _attempt > 0 && retry_expired() {
            return Ok(None);
        }
        #[cfg(unix)]
        {
            let mut operation = match mode {
                SessionLockMode::Shared => libc::LOCK_SH,
                SessionLockMode::Exclusive => libc::LOCK_EX,
            };
            if nonblocking {
                operation |= libc::LOCK_NB;
            }
            while unsafe { libc::flock(file.as_raw_fd(), operation) } != 0 {
                let error = io::Error::last_os_error();
                if nonblocking
                    && matches!(
                        error.raw_os_error(),
                        Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN
                    )
                {
                    if wait_for_switch_retry() {
                        continue;
                    }
                    return Ok(None);
                }
                return Err(format!("无法锁定 SkillHub 运行时登录: {error}"));
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
            };
            let mut flags = 0u32;
            if matches!(mode, SessionLockMode::Exclusive) {
                flags |= LOCKFILE_EXCLUSIVE_LOCK;
            }
            if nonblocking {
                flags |= LOCKFILE_FAIL_IMMEDIATELY;
            }
            // Byte-range lock over the whole (empty) file; released when the
            // handle closes, i.e. when the lease drops.
            let mut overlapped: windows_sys::Win32::System::IO::OVERLAPPED =
                unsafe { std::mem::zeroed() };
            let locked = unsafe {
                LockFileEx(
                    file.as_raw_handle() as _,
                    flags,
                    0,
                    u32::MAX,
                    u32::MAX,
                    &mut overlapped,
                )
            };
            if locked == 0 {
                let error = io::Error::last_os_error();
                // No unsuccessful contender handle survives into the sleep or
                // the next open attempt. Preserve GetLastError before closing.
                drop(file);
                if nonblocking
                    && matches!(
                        error.raw_os_error(),
                        Some(code) if code == ERROR_LOCK_VIOLATION as i32 || code == ERROR_IO_PENDING as i32
                    )
                {
                    if wait_for_switch_retry() {
                        continue;
                    }
                    return Ok(None);
                }
                return Err(format!("无法锁定 SkillHub 运行时登录: {error}"));
            }
        }
        let current = fs::symlink_metadata(&lock_path)
            .map_err(|error| format!("无法复核运行时登录锁: {error}"))?;
        if _attempt > 0 && retry_expired() {
            return Ok(None);
        }
        if current.file_type().is_symlink()
            || !current.is_file()
            || current.dev() != metadata.dev()
            || current.ino() != metadata.ino()
        {
            drop(file);
            continue;
        }
        return Ok(Some(SessionLease { _file: file }));
    }
    Err("SkillHub 运行时登录锁在取得期间被替换，请重试".into())
}

pub(crate) fn write_private_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    write_private_json_outcome(path, value).map_err(PrivateWriteError::message)
}

#[derive(Debug)]
pub(crate) enum PrivateWriteError {
    BeforeReplace(String),
    AfterReplace(String),
}
impl PrivateWriteError {
    pub(crate) fn message(self) -> String {
        match self {
            Self::BeforeReplace(message) => message,
            Self::AfterReplace(message) => {
                format!("配置已替换，收尾失败；请重新打开 APP 完成恢复：{message}")
            }
        }
    }
}
impl From<String> for PrivateWriteError {
    fn from(message: String) -> Self {
        Self::BeforeReplace(message)
    }
}
impl From<&str> for PrivateWriteError {
    fn from(message: &str) -> Self {
        Self::BeforeReplace(message.into())
    }
}

pub(crate) fn write_private_json_outcome<T: Serialize>(
    path: &Path,
    value: &T,
) -> Result<(), PrivateWriteError> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(format!("拒绝向符号链接写入私有配置: {}", path.display()).into());
    }
    let parent = path.parent().ok_or("无法确定运行时配置目录")?;
    ensure_private_directory(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("runtime"),
        uuid::Uuid::new_v4()
    ));
    let contents = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let result = (|| -> Result<(), PrivateWriteError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&contents)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        #[cfg(test)]
        if path.file_name().is_some_and(|name| name == "session.json")
            && TEST_SESSION_POST_REPLACE_ERROR.with(|fail| fail.replace(false))
        {
            return Err(PrivateWriteError::AfterReplace(
                "injected directory sync failure".into(),
            ));
        }
        #[cfg(test)]
        if path.file_name().is_some_and(|name| name == "instance.json")
            && serde_json::from_slice::<serde_json::Value>(&contents).unwrap()["pendingRebind"]
                .is_null()
            && TEST_FINAL_PIN_POST_REPLACE_ERROR.with(|fail| fail.replace(false))
        {
            return Err(PrivateWriteError::AfterReplace(
                "injected final pin sync failure".into(),
            ));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| PrivateWriteError::AfterReplace(error.to_string()))?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| PrivateWriteError::AfterReplace(error.to_string()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
thread_local! {
    pub(crate) static TEST_SESSION_POST_REPLACE_ERROR: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(crate) static TEST_FINAL_PIN_POST_REPLACE_ERROR: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub(crate) fn read_private_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "请先在 SkillHub APP 登录".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("SkillHub 运行时配置不是安全的普通文件".into());
    }
    if metadata.mode() & 0o077 != 0 || metadata.uid() != crate::platform_fs::current_uid() {
        return Err("SkillHub 运行时配置权限无效，请重新登录".into());
    }
    if metadata.len() > MAX_RUNTIME_JSON_BYTES as u64 {
        return Err("SkillHub 运行时配置过大".into());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_RUNTIME_JSON_BYTES {
        return Err("SkillHub 运行时配置过大".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "SkillHub 运行时配置已损坏".to_string())
}

fn write_runtime_session_state_at(
    root: &Path,
    auth_token: Option<&str>,
    user_id: &str,
    state: RuntimeSessionState,
    generation: u64,
) -> Result<(), String> {
    validate_user_id(user_id)?;
    if let Some(auth_token) = auth_token {
        validate_auth_token(auth_token)?;
    }
    let session = RuntimeSession {
        version: 2,
        deployment: match fs::symlink_metadata(session_path_at(root)) {
            Ok(_) => read_session_at(root)?.deployment.clone(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                crate::spaces::Deployment::Official
            }
            Err(error) => return Err(error.to_string()),
        },
        space_id: String::new(),
        user_id: user_id.to_string(),
        auth_token: auth_token.map(str::to_string),
        state,
        generation,
    };
    let mut session = session;
    session.space_id = session.deployment.space_id();
    write_space_session_at(root, &session)
}

pub(crate) fn write_space_session_at(root: &Path, session: &RuntimeSession) -> Result<(), String> {
    write_space_session_outcome_at(root, session).map_err(PrivateWriteError::message)
}

pub(crate) fn write_space_session_outcome_at(
    root: &Path,
    session: &RuntimeSession,
) -> Result<(), PrivateWriteError> {
    session.deployment.validate()?;
    validate_user_id(&session.user_id)?;
    if uuid::Uuid::parse_str(&session.user_id).is_ok_and(|id| id.to_string() != session.user_id) {
        return Err("运行时账号必须使用规范 UUID".into());
    }
    if session.space_id != session.deployment.space_id()
        || (matches!(session.deployment, crate::spaces::Deployment::Local)
            && session.auth_token.is_some())
    {
        return Err("空间与会话不匹配".into());
    }
    if let Some(token) = &session.auth_token {
        validate_auth_token(token)?;
    }
    crate::spaces::validate_session_pin(root, session)?;
    write_private_json_outcome(&session_path_at(root), session)
}

pub(crate) fn new_space_session_at(
    root: &Path,
    deployment: crate::spaces::Deployment,
    identity: Option<(&str, &str)>,
    generation: u64,
) -> Result<RuntimeSession, String> {
    let user_id = match identity {
        Some((token, user)) => {
            validate_auth_token(token)?;
            validate_user_id(user)?;
            user.to_string()
        }
        None => read_or_create_guest_user_id_at(&deployment.root(root))?,
    };
    Ok(RuntimeSession {
        version: 2,
        space_id: deployment.space_id(),
        deployment,
        user_id,
        auth_token: identity.map(|(token, _)| token.to_string()),
        state: RuntimeSessionState::Stable,
        generation: generation.checked_add(1).ok_or("空间代次已耗尽")?,
    })
}

pub(crate) fn validate_auth_token(auth_token: &str) -> Result<(), String> {
    if auth_token.trim() != auth_token
        || auth_token.is_empty()
        || auth_token.len() > 16 * 1024
        || auth_token.chars().any(char::is_whitespace)
    {
        return Err("SkillHub 登录令牌无效".into());
    }
    Ok(())
}

#[cfg(test)]
fn write_runtime_session_at(
    root: &Path,
    auth_token: Option<&str>,
    user_id: &str,
) -> Result<(), String> {
    write_runtime_session_state_at(root, auth_token, user_id, RuntimeSessionState::Stable, 0)
}

#[cfg(test)]
fn write_session_at(root: &Path, auth_token: &str, user_id: &str) -> Result<(), String> {
    write_runtime_session_at(root, Some(auth_token), user_id)
}

fn read_or_create_guest_user_id_at(root: &Path) -> Result<String, String> {
    let path = guest_identity_path_at(root);
    if path.exists() {
        let identity: GuestIdentity = read_private_json(&path)?;
        if identity.version != RUNTIME_STORE_VERSION {
            return Err("SkillHub 本机游客身份版本不受支持".into());
        }
        validate_user_id(&identity.user_id)?;
        return Ok(identity.user_id);
    }
    let identity = GuestIdentity {
        version: RUNTIME_STORE_VERSION,
        user_id: uuid::Uuid::new_v4().to_string(),
    };
    write_private_json(&path, &identity)?;
    Ok(identity.user_id)
}

fn activate_guest_session_at(root: &Path) -> Result<String, String> {
    activate_guest_session_generation_at(root, 0)
}

fn activate_guest_session_generation_at(root: &Path, generation: u64) -> Result<String, String> {
    let data_root = match fs::symlink_metadata(session_path_at(root)) {
        Ok(_) => read_session_at(root)?.storage_root(root),
        Err(error) if error.kind() == io::ErrorKind::NotFound => root.into(),
        Err(error) => return Err(error.to_string()),
    };
    let user_id = read_or_create_guest_user_id_at(&data_root)?;
    write_runtime_session_state_at(
        root,
        None,
        &user_id,
        RuntimeSessionState::Stable,
        generation,
    )?;
    Ok(user_id)
}

pub(crate) fn ensure_runtime_session_at(root: &Path) -> Result<(), String> {
    let _session_lease = acquire_session_lock_at(root, SessionLockMode::Exclusive)?;
    match fs::symlink_metadata(session_path_at(root)) {
        Ok(_) => {
            let mut session = read_session_for_recovery_at(root)?;
            if session.version == 1 {
                let backup = runtime_dir_at(root).join("session-v1-backup.json");
                if !backup.exists() {
                    let original: serde_json::Value = read_private_json(&session_path_at(root))?;
                    write_private_json(&backup, &original)?;
                }
                session.version = 2;
                write_space_session_at(root, &session)?;
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            activate_guest_session_at(root).map(|_| ())
        }
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn read_session_at(root: &Path) -> Result<RuntimeSession, String> {
    let session = read_session_for_recovery_at(root)?;
    crate::spaces::require_rebind_finished(root, &session)?;
    Ok(session)
}

pub(crate) fn read_session_for_recovery_at(root: &Path) -> Result<RuntimeSession, String> {
    let raw: serde_json::Value = read_private_json(&session_path_at(root))
        .map_err(|_| "无法读取 SkillHub 运行时会话，请重新登录".to_string())?;
    if raw["version"] == 2
        && ["deployment", "spaceId", "generation", "state"]
            .iter()
            .any(|key| raw.get(key).is_none())
    {
        return Err("空间档案缺少必要字段，已停止联网".into());
    }
    let session: RuntimeSession =
        serde_json::from_value(raw).map_err(|_| "空间档案无效，已停止联网")?;
    if !matches!(session.version, 1 | 2) {
        return Err("SkillHub 运行时登录版本不受支持，请重新登录".into());
    }
    validate_user_id(&session.user_id)?;
    if let Some(auth_token) = session.auth_token.as_deref() {
        if auth_token.trim() != auth_token
            || auth_token.is_empty()
            || auth_token.len() > 16 * 1024
            || auth_token.chars().any(char::is_whitespace)
        {
            return Err("SkillHub 运行时登录无效，请重新登录".into());
        }
    }
    session.deployment.validate()?;
    if session.space_id != session.deployment.space_id()
        || (session.version == 1 && session.deployment != crate::spaces::Deployment::Official)
        || (session.deployment == crate::spaces::Deployment::Local && session.auth_token.is_some())
    {
        return Err("空间与运行时会话不匹配".into());
    }
    if session.version == 1 && session.is_sync_pending() && session.auth_token.is_some() {
        return Err("SkillHub 运行时账号交接状态无效，请重新打开 APP".into());
    }
    crate::spaces::validate_session_pin(root, &session)?;
    Ok(session)
}

fn ensure_session_stable(session: &RuntimeSession) -> Result<(), String> {
    if session.is_sync_pending() {
        return Err(format!(
            "{AUTH_SYNC_PENDING_CODE}: SkillHub APP 正在同步账号，请稍后重试"
        ));
    }
    Ok(())
}

pub(crate) fn runtime_session_snapshot_at(root: &Path) -> Result<RuntimeSession, String> {
    let _session_lease = acquire_session_lock_at(root, SessionLockMode::Shared)?;
    read_session_at(root)
}

/// Preserve absence separately from unreadable/corrupt/busy session state.
pub(crate) fn optional_session_snapshot_at(root: &Path) -> Result<Option<RuntimeSession>, String> {
    // A read for a guest must not create a runtime directory or lock file.
    match fs::symlink_metadata(session_path_at(root)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    let _session_lease = acquire_session_lock_at(root, SessionLockMode::Shared)?;
    match fs::symlink_metadata(session_path_at(root)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
        Ok(_) => read_session_at(root).map(Some),
    }
}

/// An unreadable deployment must never silently become the official space.
pub(crate) fn recover_unreadable_session_at(root: &Path) -> Result<RuntimeSession, String> {
    let _lease = acquire_session_lock_at(root, SessionLockMode::Exclusive)?;
    read_session_at(root)
}

pub(crate) fn runtime_session_snapshot() -> Result<RuntimeSession, String> {
    runtime_session_snapshot_at(&skillhub_dir())
}

fn runtime_session_is_current_at(root: &Path, expected: &RuntimeSession) -> Result<bool, String> {
    let _session_lease = acquire_session_lock_at(root, SessionLockMode::Shared)?;
    read_session_at(root).map(|current| current.same_identity(expected))
}

pub(crate) fn runtime_session_is_current(expected: &RuntimeSession) -> Result<bool, String> {
    runtime_session_is_current_at(&skillhub_dir(), expected)
}

pub(crate) fn acquire_current_session_lease_at(
    root: &Path,
    expected: &RuntimeSession,
) -> Result<Option<CurrentSessionLease>, String> {
    let lease = acquire_session_lock_at(root, SessionLockMode::Shared)?;
    let current = read_session_at(root)?;
    if !current.same_identity(expected) {
        return Ok(None);
    }
    Ok(Some(CurrentSessionLease { _lease: lease }))
}

pub(crate) fn acquire_current_session_lease(
    expected: &RuntimeSession,
) -> Result<Option<CurrentSessionLease>, String> {
    acquire_current_session_lease_at(&skillhub_dir(), expected)
}

#[cfg(test)]
fn begin_runtime_session_transition_at(root: &Path) -> Result<u64, String> {
    let _session_lease = acquire_session_lock_at(root, SessionLockMode::Exclusive)?;
    let current = match fs::symlink_metadata(session_path_at(root)) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("运行时身份配置不是安全的普通文件".into());
        }
        Ok(_) => read_session_at(root)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            activate_guest_session_at(root)?;
            read_session_at(root)?
        }
        Err(error) => return Err(error.to_string()),
    };
    let generation = current
        .generation
        .checked_add(1)
        .ok_or("SkillHub 运行时账号代次已耗尽，请重新安装 APP")?;
    write_runtime_session_state_at(
        root,
        None,
        &current.user_id,
        RuntimeSessionState::SyncPending,
        generation,
    )?;
    Ok(generation)
}

#[cfg(test)]
fn runtime_session_matches_at(
    root: &Path,
    auth_token: &str,
    user_id: &str,
) -> Result<bool, String> {
    validate_user_id(user_id)?;
    let _session_lease = acquire_session_lock_at(root, SessionLockMode::Shared)?;
    let current = read_session_at(root)?;
    Ok(!current.is_sync_pending()
        && current.user_id == user_id
        && current.auth_token.as_deref() == Some(auth_token))
}

pub(crate) fn clear_runtime_session_if_current_at(
    root: &Path,
    expected: &RuntimeSession,
) -> Result<bool, String> {
    let _session_lease = acquire_session_lock_at(root, SessionLockMode::Exclusive)?;
    let current = read_session_at(root)?;
    if !current.same_identity(expected) {
        return Ok(false);
    }
    let generation = current
        .generation
        .checked_add(1)
        .ok_or("SkillHub 运行时账号代次已耗尽，请重新安装 APP")?;
    activate_guest_session_generation_at(root, generation)?;
    Ok(true)
}

pub(crate) fn clear_runtime_session_if_current(expected: &RuntimeSession) -> Result<bool, String> {
    clear_runtime_session_if_current_at(&skillhub_dir(), expected)
}

fn read_policy_at(root: &Path, user_id: &str) -> Result<AccountSourcePolicy, String> {
    let path = policy_path_at(root, user_id);
    if !path.exists() {
        return Ok(AccountSourcePolicy {
            version: RUNTIME_STORE_VERSION,
            ..Default::default()
        });
    }
    let policy: AccountSourcePolicy = read_private_json(&path)?;
    if policy.version != RUNTIME_STORE_VERSION {
        return Err("环境变量来源设置版本不受支持".into());
    }
    Ok(policy)
}

fn write_policy_at(root: &Path, user_id: &str, policy: &AccountSourcePolicy) -> Result<(), String> {
    validate_user_id(user_id)?;
    write_private_json(&policy_path_at(root, user_id), policy)
}

pub(crate) fn read_profile_at(
    root: &Path,
    skill_id: &str,
) -> Result<crate::SkillHubProfile, String> {
    validate_skill_id(skill_id)?;
    let skill_root = root.join(skill_id);
    let metadata = fs::symlink_metadata(&skill_root)
        .map_err(|_| format!("SkillHub 中找不到 Skill: {skill_id}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Skill 根目录不是安全的普通目录".into());
    }
    let path = skill_root.join(".skillhub.json");
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("Skill Profile 不能是符号链接".into());
    }
    let bytes = fs::read(path).map_err(|_| "Skill 缺少 .skillhub.json".to_string())?;
    if bytes.len() > MAX_RUNTIME_JSON_BYTES {
        return Err("Skill Profile 过大".into());
    }
    let json: SkillHubJson =
        serde_json::from_slice(&bytes).map_err(|_| "Skill Profile JSON 已损坏".to_string())?;
    json.skillhub
        .ok_or_else(|| "Skill Profile 缺少 SkillHub 元数据".to_string())
}

fn profile_server_id_for_runtime<'a>(
    profile: &'a crate::SkillHubProfile,
    runtime_user_id: &str,
) -> Option<&'a str> {
    if profile.catalog_origin.is_some() {
        return None;
    }
    let owned_by_runtime_user = profile.is_own != Some(false)
        && profile.server_owner_id.as_deref() == Some(runtime_user_id);
    let acquired_by_runtime_user = profile.is_own == Some(false)
        && profile.team_shared_from.is_some()
        && profile.acquired_by_user_id.as_deref() == Some(runtime_user_id);
    if owned_by_runtime_user || acquired_by_runtime_user {
        profile.server_id.as_deref()
    } else {
        None
    }
}

fn parse_stored_env_value(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if let Some(inner) = trimmed
        .strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
    {
        return Ok(inner.replace("'\\''", "'"));
    }
    if let Some(inner) = trimmed
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
    {
        return Ok(inner.to_string());
    }
    if trimmed.starts_with(['\'', '"']) {
        return Err("本机环境变量文件包含无效引号".into());
    }
    Ok(trimmed.to_string())
}

pub(crate) fn account_env_path_at(
    env_root: &Path,
    account_user_id: &str,
    skill_id: &str,
) -> PathBuf {
    env_root
        .join(account_user_id)
        .join(format!("{skill_id}.env"))
}

pub(crate) fn active_runtime_user_id() -> Option<String> {
    read_session_at(&skillhub_dir())
        .ok()
        .filter(|session| !session.is_sync_pending())
        .map(|session| session.user_id.clone())
}

pub(crate) fn resolve_active_runtime_user(
    requested_user_id: Option<&str>,
) -> Result<String, String> {
    let session = read_session_at(&skillhub_dir())?;
    ensure_session_stable(&session)?;
    if let Some(requested_user_id) = requested_user_id {
        validate_user_id(requested_user_id)?;
        if session.user_id != requested_user_id {
            return Err("当前身份与 SkillHub 运行时不一致，请重新打开环境变量页".into());
        }
    }
    Ok(session.user_id.clone())
}

pub(crate) fn account_env_path(account_user_id: &str, skill_id: &str) -> Result<PathBuf, String> {
    let session = runtime_session_snapshot()?;
    ensure_session_stable(&session)?;
    if session.user_id() != account_user_id {
        return Err(crate::spaces::STALE.into());
    }
    account_env_path_under(
        &session.storage_root(&skillhub_dir()).join("envs"),
        account_user_id,
        skill_id,
    )
}

pub(crate) fn account_env_path_under(
    env_root: &Path,
    account_user_id: &str,
    skill_id: &str,
) -> Result<PathBuf, String> {
    validate_user_id(account_user_id)?;
    validate_skill_id(skill_id)?;
    Ok(account_env_path_at(env_root, account_user_id, skill_id))
}

/// Session fixtures for tests outside this module.
#[cfg(test)]
pub(crate) mod test_sessions {
    use super::{
        activate_guest_session_at, begin_runtime_session_transition_at,
        try_acquire_session_lock_at, write_session_at, SessionLockMode,
    };
    use std::path::Path;

    pub(crate) fn sign_in(root: &Path, user_id: &str) {
        write_session_at(root, &format!("{user_id}.header.signature"), user_id)
            .expect("write session");
    }

    pub(crate) fn sign_out(root: &Path) {
        activate_guest_session_at(root).expect("guest session");
    }

    pub(crate) fn begin_switch(root: &Path) {
        begin_runtime_session_transition_at(root).expect("begin switch");
    }

    /// Whether a login/logout could take the session right now.
    pub(crate) fn switch_possible(root: &Path) -> bool {
        try_acquire_session_lock_at(root, SessionLockMode::Exclusive)
            .expect("try exclusive")
            .is_some()
    }
}

fn migrate_owned_legacy_env_files(
    skillhub_root: &Path,
    managed_root: &Path,
    user_id: &str,
) -> Result<(), String> {
    validate_user_id(user_id)?;
    let env_root = skillhub_root.join("envs");
    if !env_root.exists() {
        return Ok(());
    }
    let account_root = env_root.join(user_id);
    ensure_private_directory(&account_root)?;
    let Ok(entries) = fs::read_dir(&env_root) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        let Some(skill_id) = file_name.strip_suffix(".env") else {
            continue;
        };
        if validate_skill_id(skill_id).is_err() || !managed_root.join(skill_id).is_dir() {
            continue;
        }
        let legacy = entry.path();
        let destination = account_env_path_at(&env_root, user_id, skill_id);
        let metadata = fs::symlink_metadata(&legacy).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.mode() & 0o077 != 0
        {
            continue;
        }
        let profile = read_profile_at(managed_root, skill_id).ok();
        let belongs_to_current = profile.as_ref().is_some_and(|profile| {
            profile.is_own != Some(false) && profile.server_owner_id.as_deref() == Some(user_id)
        });
        if !belongs_to_current {
            // A legacy unscoped value can never be safely guessed into the
            // first account that happens to log in. Ownerless values are
            // quarantined for manual recovery; values bound to another known
            // owner stay in place so that owner can migrate them later.
            if profile
                .as_ref()
                .and_then(|profile| profile.server_owner_id.as_deref())
                .is_none()
                || profile
                    .as_ref()
                    .is_some_and(|profile| profile.is_own == Some(false))
            {
                let backup_root = runtime_dir_at(skillhub_root).join("legacy-env-unassigned");
                ensure_private_directory(&backup_root)?;
                let backup = backup_root.join(format!("{skill_id}-{}.env", uuid::Uuid::new_v4()));
                fs::rename(&legacy, backup).map_err(|error| error.to_string())?;
            }
            continue;
        }
        if destination.exists() {
            let backup_root = runtime_dir_at(skillhub_root).join("legacy-env-backups");
            ensure_private_directory(&backup_root)?;
            let backup = backup_root.join(format!("{skill_id}-{}.env", uuid::Uuid::new_v4()));
            fs::rename(&legacy, backup).map_err(|error| error.to_string())?;
        } else {
            fs::rename(&legacy, &destination).map_err(|error| error.to_string())?;
            fs::set_permissions(&destination, fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn copy_guest_runtime_state_at(
    root: &Path,
    guest_user_id: &str,
    account_user_id: &str,
) -> Result<(), String> {
    validate_user_id(guest_user_id)?;
    validate_user_id(account_user_id)?;
    if guest_user_id == account_user_id {
        return Ok(());
    }

    let env_root = root.join("envs");
    let guest_root = env_root.join(guest_user_id);
    if guest_root.exists() {
        let guest_metadata =
            fs::symlink_metadata(&guest_root).map_err(|error| error.to_string())?;
        if guest_metadata.file_type().is_symlink()
            || !guest_metadata.is_dir()
            || guest_metadata.uid() != crate::platform_fs::current_uid()
            || guest_metadata.mode() & 0o077 != 0
        {
            return Err("游客环境变量目录不是安全的私有目录".into());
        }
        let account_root = env_root.join(account_user_id);
        ensure_private_directory(&account_root)?;
        for entry in fs::read_dir(&guest_root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let file_name = entry.file_name().to_string_lossy().to_string();
            let Some(skill_id) = file_name.strip_suffix(".env") else {
                continue;
            };
            if validate_skill_id(skill_id).is_err() {
                continue;
            }
            let destination = account_env_path_at(&env_root, account_user_id, skill_id);
            let source_path = entry.path();
            crate::commands::merge_missing_env_values_from_file(&source_path, &destination)?;
        }
    }

    crate::key_vault::merge_guest_vault_at(root, guest_user_id, account_user_id)?;

    let guest_policy = read_policy_at(root, guest_user_id)?;
    let mut account_policy = read_policy_at(root, account_user_id)?;
    let mut policy_changed = false;
    for (skill_id, sources) in guest_policy.skills {
        if validate_skill_id(&skill_id).is_err() {
            continue;
        }
        let account_sources = account_policy.skills.entry(skill_id).or_default();
        for (key, source) in sources {
            if valid_env_key(&key)
                && source == SkillEnvSource::Personal
                && !account_sources.contains_key(&key)
            {
                account_sources.insert(key, SkillEnvSource::Personal);
                policy_changed = true;
            }
        }
    }
    if policy_changed {
        write_policy_at(root, account_user_id, &account_policy)?;
    }
    Ok(())
}

/// Reads an owner-only `KEY=value` file (a per-Skill override or the account
/// key vault). A missing file is empty. With `allowed_keys`, only those keys
/// are decoded and returned; the caller zeroizes the values.
pub(crate) fn read_private_env_values(
    path: &Path,
    allowed_keys: Option<&BTreeSet<String>>,
) -> Result<BTreeMap<String, String>, String> {
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("拒绝读取符号链接环境变量文件".into());
    }
    if metadata.uid() != crate::platform_fs::current_uid() || metadata.mode() & 0o077 != 0 {
        return Err("本机环境变量文件权限无效".into());
    }
    if metadata.len() > MAX_RUNTIME_JSON_BYTES as u64 {
        return Err("本机环境变量文件过大".into());
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut values = BTreeMap::new();
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let assignment = trimmed.strip_prefix("export ").unwrap_or(trimmed);
        let (key, raw_value) = assignment
            .split_once('=')
            .ok_or_else(|| "本机环境变量文件格式无效".to_string())?;
        let key = key.trim();
        if !valid_env_key(key) {
            return Err("本机环境变量文件包含无效变量名".into());
        }
        if allowed_keys.is_none_or(|allowed| allowed.contains(key)) {
            values.insert(key.to_string(), parse_stored_env_value(raw_value)?);
        }
    }
    Ok(values)
}

/// The value this Skill would use from the personal layer (override → vault),
/// for putting it into a team key vault. Native only: the value never reaches
/// the WebView. The Skill must declare the key; authorship is not required
/// because any active team member may put a team key (#254).
fn personal_team_value_at(
    managed_root: &Path,
    env_root: &Path,
    user_id: &str,
    skill_id: &str,
    key: &str,
) -> Result<String, String> {
    if !valid_env_key(key) {
        return Err("钥匙名无效".into());
    }
    let profile = read_profile_at(managed_root, skill_id)?;
    if !profile
        .env_dependencies
        .iter()
        .any(|dependency| dependency.key == key)
    {
        return Err("这个钥匙已不在 Skill 的依赖清单中".into());
    }
    let allowed = BTreeSet::from([key.to_string()]);
    let skillhub_root = managed_root.parent().ok_or("无法确定 SkillHub 目录")?;
    // The value this Skill would use, its chosen labelled value included.
    let choices = personal_variant_choices_at(skillhub_root, user_id, skill_id);
    let personal = crate::key_vault::read_personal_values_at(
        skillhub_root,
        env_root,
        user_id,
        skill_id,
        &allowed,
        &choices,
    )?;
    let mut value = personal
        .values()
        .get(key)
        .cloned()
        .ok_or("请先填写你的钥匙")?;
    drop(personal);
    if !valid_personal_value(&value) {
        value.zeroize();
        return Err("你的钥匙不可用，请重新填写".into());
    }
    Ok(value)
}

pub(crate) fn valid_personal_value(value: &str) -> bool {
    !value.is_empty() && value.len() <= 16_384 && !value.contains(['\0', '\n', '\r'])
}

/// A logged-in runtime session matching the WebView's account, held for the
/// duration of one team key request so the account cannot switch midway.
pub(crate) struct AuthorizedRuntimeSession {
    pub(crate) user_id: String,
    pub(crate) token: String,
    pub(crate) session: RuntimeSession,
    pub(crate) data_root: PathBuf,
    _lease: CurrentSessionLease,
}

pub(crate) fn authorized_runtime_session(
    account_user_id: &str,
) -> Result<AuthorizedRuntimeSession, String> {
    authorized_runtime_session_at(&skillhub_dir(), account_user_id)
}

fn authorized_runtime_session_at(
    root: &Path,
    account_user_id: &str,
) -> Result<AuthorizedRuntimeSession, String> {
    let session = runtime_session_snapshot_at(root)?;
    validate_session_request(&session, session.auth_token(), Some(account_user_id))?;
    let token = session
        .auth_token
        .clone()
        .ok_or("请先登录，再管理团队钥匙")?;
    let lease =
        acquire_current_session_lease_at(root, &session)?.ok_or("账号已切换，请重新打开钥匙页")?;
    Ok(AuthorizedRuntimeSession {
        user_id: session.user_id.clone(),
        token,
        data_root: session.storage_root(root),
        session,
        _lease: lease,
    })
}

/// 「共享给团队」 from a Skill: puts the value this Skill uses (override →
/// account vault) into the team key vault as `(team, KEY)`.
#[tauri::command]
pub async fn provide_personal_env_to_team(
    space: crate::server_request::SpaceHandle,
    skill_id: String,
    team_id: String,
    key: String,
    account_user_id: String,
) -> Result<crate::team_keys::TeamKeyWrite, String> {
    validate_skill_id(&skill_id)?;
    validate_user_id(&team_id)?;
    let authorized = authorized_runtime_session(&account_user_id)?;
    crate::spaces::require_handle(&authorized.session, &space)?;
    crate::spaces::require_profile(
        &read_profile_at(&skills_dir(), &skill_id)?,
        &authorized.session,
    )?;
    let mut value = personal_team_value_at(
        &skills_dir(),
        &authorized.data_root.join("envs"),
        &authorized.user_id,
        &skill_id,
        &key,
    )?;
    let result = crate::team_keys::put_team_key_value(&authorized, &team_id, &key, &value).await;
    value.zeroize();
    result
}

#[cfg(all(test, unix))]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Live team values the current account may use, per declared key. Only
/// sources with a published revision count as available.
type TeamCandidates = BTreeMap<String, Vec<String>>;

fn team_candidates(sources: &[RuntimeTeamSource]) -> TeamCandidates {
    let mut candidates = TeamCandidates::new();
    for source in sources.iter().filter(|source| source.revision > 0) {
        let teams = candidates.entry(source.key.clone()).or_default();
        if !teams.contains(&source.team_id) {
            teams.push(source.team_id.clone());
        }
    }
    candidates
}

fn ambiguous_source_error(key: &str) -> String {
    format!(
        "{}: {key} 有多个来源可选，请在 SkillHub APP 中选择用哪把钥匙",
        crate::key_vault::NEEDS_CHOICE_CODE
    )
}

/// Fixed resolution order for one run:
/// explicit policy (personal / team, never falling back) → personal value →
/// exactly one available team value (automatic) → several teams: ask the
/// user to choose → nothing: required keys fail, optional keys are skipped.
fn select_sources(
    dependencies: &[RuntimeDependency],
    personal: &BTreeMap<String, String>,
    policy: &BTreeMap<String, SkillEnvSource>,
    candidates: &TeamCandidates,
) -> Result<(BTreeMap<String, String>, Vec<RuntimeTeamSelection>), String> {
    let mut values = BTreeMap::new();
    let mut team = Vec::new();
    for dependency in dependencies {
        if !valid_env_key(&dependency.key) {
            return Err("Skill Profile 包含无效环境变量名".into());
        }
        match policy.get(&dependency.key) {
            Some(SkillEnvSource::Personal | SkillEnvSource::PersonalVariant { .. }) => {
                let value = personal.get(&dependency.key).ok_or_else(|| {
                    format!("{} 选择了个人来源，但本机值已不存在", dependency.key)
                })?;
                values.insert(dependency.key.clone(), value.clone());
            }
            Some(SkillEnvSource::Team { team_id }) => {
                validate_user_id(team_id).map_err(|_| "环境变量团队来源编号无效".to_string())?;
                team.push(RuntimeTeamSelection {
                    key: dependency.key.clone(),
                    team_id: team_id.clone(),
                    automatic: false,
                });
            }
            None => {
                if let Some(value) = personal.get(&dependency.key) {
                    values.insert(dependency.key.clone(), value.clone());
                    continue;
                }
                match candidates
                    .get(&dependency.key)
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                {
                    [team_id] => {
                        validate_user_id(team_id)
                            .map_err(|_| "环境变量团队来源编号无效".to_string())?;
                        team.push(RuntimeTeamSelection {
                            key: dependency.key.clone(),
                            team_id: team_id.clone(),
                            automatic: true,
                        });
                    }
                    [] if dependency.required => {
                        return Err(format!(
                            "{}: {} 需要填写：请在 SkillHub APP 的 Skill 详情「需要的钥匙」中填写",
                            crate::key_vault::MISSING_KEY_CODE,
                            dependency.key
                        ));
                    }
                    [] => {}
                    _ if dependency.required => {
                        return Err(ambiguous_source_error(&dependency.key));
                    }
                    // An optional key never blocks a run; with several
                    // competing teams and no choice it is simply not injected.
                    _ => {}
                }
            }
        }
    }
    Ok((values, team))
}

/// Reads the live team sources only when some dependency has neither an
/// explicit policy nor a personal value, i.e. only when the automatic team
/// step of the resolution order can matter. A guest, a Skill without a Server
/// asset, or a run whose unresolved keys are all optional and whose lookup
/// fails continues without team candidates; a failed lookup for a required
/// key is reported instead of being mistaken for "no value".
async fn automatic_team_candidates_at(
    session: &RuntimeSession,
    profile: &crate::SkillHubProfile,
    dependencies: &[RuntimeDependency],
    personal: &BTreeMap<String, String>,
    policy: &BTreeMap<String, SkillEnvSource>,
) -> Result<TeamCandidates, String> {
    let unresolved = dependencies
        .iter()
        .filter(|dependency| {
            !policy.contains_key(&dependency.key) && !personal.contains_key(&dependency.key)
        })
        .collect::<Vec<_>>();
    if unresolved.is_empty() {
        return Ok(TeamCandidates::new());
    }
    let (Some(auth_token), Some(server_skill_id)) = (
        session.auth_token.as_deref(),
        profile_server_id_for_runtime(profile, &session.user_id),
    ) else {
        return Ok(TeamCandidates::new());
    };
    let lookup = async {
        validate_user_id(server_skill_id).map_err(|_| "Skill 的服务器资产编号无效".to_string())?;
        let options = RuntimeApi::for_session(session)
            .await?
            .options(auth_token, server_skill_id)
            .await?;
        if options.skill_id != server_skill_id {
            return Err("服务器返回了错误的 Skill 环境来源".to_string());
        }
        Ok(options)
    };
    let options = match lookup.await {
        Ok(options) => options,
        Err(error) if unresolved.iter().any(|dependency| dependency.required) => return Err(error),
        Err(_) => return Ok(TeamCandidates::new()),
    };
    Ok(team_candidates(&filter_team_sources(options, dependencies)))
}

/// Keeps only sources for keys declared both locally and on the Server.
fn filter_team_sources(
    options: RuntimeOptionsResponse,
    dependencies: &[RuntimeDependency],
) -> Vec<RuntimeTeamSource> {
    let server_dependencies = options
        .dependencies
        .iter()
        .map(|dependency| dependency.key.clone())
        .collect::<BTreeSet<_>>();
    options
        .sources
        .into_iter()
        .filter(|source| {
            dependencies
                .iter()
                .any(|dependency| dependency.key == source.key)
                && server_dependencies.contains(&source.key)
        })
        .collect()
}

async fn resolve_env_at(
    root: &Path,
    managed_root: &Path,
    env_root: &Path,
    skill_id: &str,
) -> Result<ResolvedEnvironment, String> {
    let session = read_session_at(root)?;
    ensure_session_stable(&session)?;
    let profile = read_profile_at(managed_root, skill_id)?;
    crate::spaces::require_profile(&profile, &session)?;
    let dependencies = profile
        .env_dependencies
        .iter()
        .map(|dependency| RuntimeDependency {
            key: dependency.key.clone(),
            description: dependency.description.clone(),
            required: dependency.required,
        })
        .collect::<Vec<_>>();
    let allowed = dependencies
        .iter()
        .map(|dependency| dependency.key.clone())
        .collect::<BTreeSet<_>>();
    // The personal layer is override → account key vault (#253). The
    // one-time migration of per-Skill files runs before the first read.
    crate::key_vault::ensure_vault_migrated_for_at(
        root,
        env_root,
        &session.user_id,
        Some(&session),
    )?;
    let session_root = root;
    let data_root = session.storage_root(root);
    let data_env_root = if session.space_id() == "official" {
        env_root.to_path_buf()
    } else {
        data_root.join("envs")
    };
    let root = data_root.as_path();
    let env_root = data_env_root.as_path();
    let policy_store = read_policy_at(root, &session.user_id)?;
    let empty_policy = BTreeMap::new();
    let policy = policy_store.skills.get(skill_id).unwrap_or(&empty_policy);
    // A Skill pointed at a labelled value gets that one, else the default.
    let personal = crate::key_vault::read_personal_values_at(
        root,
        env_root,
        &session.user_id,
        skill_id,
        &allowed,
        &variant_choices(Some(policy)),
    )?;
    // A vault value is only used when no explicit team source overrides it;
    // a Skill that is not the user's own must be allowed to use it first.
    let mut vault_keys = personal.vault_keys();
    vault_keys.retain(|key| !matches!(policy.get(key), Some(SkillEnvSource::Team { .. })));
    // Consent, grants and usage follow the value itself (its main name, or
    // `NAME__V<n>` for a labelled value), even when this Skill declares one
    // of its aliases (#288, #306).
    let consent = crate::key_vault::evaluate_consent_at(
        root,
        &session.user_id,
        skill_id,
        &profile,
        &personal.vault_main_names(&vault_keys),
        crate::key_vault::now_ms(),
    )?;
    if !consent.pending.is_empty() {
        drop(personal);
        let _ = crate::key_vault::record_consent_request_at(
            root,
            &session.user_id,
            skill_id,
            &consent.pending,
            crate::key_vault::now_ms(),
        );
        return Err(crate::key_vault::needs_consent_error(
            &crate::key_vault::profile_display_name(&profile, skill_id),
            &consent.pending_display,
        ));
    }
    let candidates =
        automatic_team_candidates_at(&session, &profile, &dependencies, personal.values(), policy)
            .await?;
    let (mut values, team_selections) =
        select_sources(&dependencies, personal.values(), policy, &candidates)?;
    let used_vault_keys = personal
        .vault_main_names(vault_keys.iter().filter(|key| values.contains_key(*key)))
        .into_iter()
        .collect::<Vec<_>>();
    drop(personal);
    if !team_selections.is_empty() {
        let auth_token = session
            .auth_token
            .as_deref()
            .ok_or("团队环境变量需要先在 SkillHub APP 登录")?;
        let server_skill_id = profile_server_id_for_runtime(&profile, &session.user_id)
            .ok_or("当前账号不能使用这个 Skill 的团队环境变量，请重新同步 Skill")?;
        validate_user_id(server_skill_id).map_err(|_| "Skill 的服务器资产编号无效".to_string())?;
        let response = RuntimeApi::for_session(&session)
            .await?
            .resolve(auth_token, server_skill_id, team_selections.clone())
            .await?;
        let server_keys = response
            .dependencies
            .iter()
            .map(|dependency| dependency.key.as_str())
            .collect::<BTreeSet<_>>();
        if team_selections
            .iter()
            .any(|selection| !server_keys.contains(selection.key.as_str()))
        {
            return Err("服务器 Skill Profile 与已选团队环境来源不一致，请先同步 Skill".into());
        }
        let expected_team = team_selections
            .iter()
            .map(|selection| (selection.key.as_str(), selection.team_id.as_str()))
            .collect::<BTreeSet<_>>();
        let actual_team = response
            .credentials
            .iter()
            .map(|credential| (credential.key.as_str(), credential.team_id.as_str()))
            .collect::<BTreeSet<_>>();
        if expected_team != actual_team {
            return Err("服务器未返回完整的已选团队环境变量".into());
        }
        for mut credential in response.credentials {
            if !allowed.contains(&credential.key) || values.contains_key(&credential.key) {
                credential.value.zeroize();
                return Err("服务器返回了未请求或重复的环境变量".into());
            }
            values.insert(credential.key, credential.value);
        }
    }
    for dependency in &dependencies {
        if dependency.required && !values.contains_key(&dependency.key) {
            for value in values.values_mut() {
                value.zeroize();
            }
            return Err(format!(
                "{}: 缺少必需环境变量 {}",
                crate::key_vault::MISSING_KEY_CODE,
                dependency.key
            ));
        }
    }
    let environment = finalize_resolved_environment_at(session_root, &session, values)?;
    consent.consume_once_grants();
    crate::key_vault::record_vault_usage_at(
        root,
        &session.user_id,
        &used_vault_keys,
        crate::key_vault::now_ms(),
    );
    Ok(environment)
}

fn finalize_resolved_environment_at(
    root: &Path,
    expected_session: &RuntimeSession,
    mut values: BTreeMap<String, String>,
) -> Result<ResolvedEnvironment, String> {
    // Network resolution happens before this point. The shared lease is only
    // held for the final account revalidation and child-process creation,
    // so login/logout remains responsive without permitting mixed-account
    // environment inheritance.
    let session_lease = match acquire_session_lock_at(root, SessionLockMode::Shared) {
        Ok(lease) => lease,
        Err(error) => {
            for value in values.values_mut() {
                value.zeroize();
            }
            return Err(error);
        }
    };
    let current_session = match read_session_at(root) {
        Ok(session) => session,
        Err(error) => {
            for value in values.values_mut() {
                value.zeroize();
            }
            return Err(error);
        }
    };
    if !current_session.same_identity(expected_session) {
        for value in values.values_mut() {
            value.zeroize();
        }
        return Err("SkillHub 账号已切换，本次环境变量结果已丢弃".into());
    }
    Ok(ResolvedEnvironment {
        values: values.into_iter().collect(),
        session_lease: Some(session_lease),
    })
}

#[cfg(test)]
fn sync_runtime_session_generation_at(
    root: &Path,
    managed_root: &Path,
    auth_token: &str,
    user_id: &str,
    generation: u64,
) -> Result<(), String> {
    validate_auth_token(auth_token)?;
    validate_user_id(user_id)?;
    let _session_lease = acquire_session_lock_at(root, SessionLockMode::Exclusive)?;
    let session = read_session_at(root)?;
    if !session.is_sync_pending() || session.generation != generation {
        return Err("SkillHub 账号交接已被新的登录状态取代".into());
    }
    let guest_user_id = read_or_create_guest_user_id_at(root)?;
    if session.user_id == guest_user_id {
        copy_guest_runtime_state_at(root, &guest_user_id, user_id)?;
    }
    migrate_owned_legacy_env_files(root, managed_root, user_id)?;
    write_runtime_session_state_at(
        root,
        Some(auth_token),
        user_id,
        RuntimeSessionState::Stable,
        generation,
    )
}

#[cfg(test)]
fn clear_runtime_session_generation_at(root: &Path, generation: u64) -> Result<(), String> {
    let _session_lease = acquire_session_lock_at(root, SessionLockMode::Exclusive)?;
    let session = read_session_at(root)?;
    if !session.is_sync_pending() || session.generation != generation {
        return Err("SkillHub 账号交接已被新的登录状态取代".into());
    }
    activate_guest_session_generation_at(root, generation).map(|_| ())
}

#[cfg(test)]
fn sync_runtime_session_at(
    root: &Path,
    managed_root: &Path,
    auth_token: &str,
    user_id: &str,
) -> Result<(), String> {
    let generation = begin_runtime_session_transition_at(root)?;
    sync_runtime_session_generation_at(root, managed_root, auth_token, user_id, generation)
}

#[cfg(test)]
fn clear_runtime_session_at(root: &Path) -> Result<(), String> {
    let generation = begin_runtime_session_transition_at(root)?;
    clear_runtime_session_generation_at(root, generation)
}

fn validate_session_request(
    session: &RuntimeSession,
    auth_token: Option<&str>,
    account_user_id: Option<&str>,
) -> Result<(), String> {
    ensure_session_stable(session)?;
    if let Some(account_user_id) = account_user_id {
        validate_user_id(account_user_id)?;
        if session.user_id != account_user_id {
            return Err("当前身份与 SkillHub 运行时不一致，请重新打开环境变量页".into());
        }
    }
    match session.auth_token.as_deref() {
        Some(current_token)
            if auth_token == Some(current_token)
                && account_user_id == Some(session.user_id.as_str()) =>
        {
            Ok(())
        }
        Some(_) => Err("当前账号与 SkillHub 运行时登录不一致，请重新登录".into()),
        None if auth_token.is_none() => Ok(()),
        None => Err("当前为本机游客身份，请重新打开环境变量页".into()),
    }
}

/// Commit under the same file lock as CLI invalidation. Failed network operations
/// never touch the file; a successful transition advances exactly one generation.
#[cfg(test)]
pub(crate) fn replace_session_at(
    root: &Path,
    managed_root: &Path,
    expected: Option<&RuntimeSession>,
    identity: Option<(&str, &str)>,
) -> Result<u64, String> {
    let lease = acquire_exclusive_session_lease_at(root)?;
    replace_session_locked_at(root, managed_root, expected, identity, &lease)
}

pub(crate) fn replace_session_locked_at(
    root: &Path,
    managed_root: &Path,
    expected: Option<&RuntimeSession>,
    identity: Option<(&str, &str)>,
    _lease: &ExclusiveSessionLease,
) -> Result<u64, String> {
    let current = match fs::symlink_metadata(session_path_at(root)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        _ => Some(read_session_at(root)?),
    };
    if current.as_ref() != expected {
        return Err("SkillHub 空间或账号已切换，本次请求结果已丢弃".into());
    }
    if let Some(current) = &current {
        crate::spaces::recover_guest_claims(root, managed_root, current)?;
    }
    let generation = current
        .as_ref()
        .map_or(0, RuntimeSession::generation)
        .checked_add(1)
        .ok_or("SkillHub 运行时账号代次已耗尽，请重新安装 APP")?;
    if let Some((token, user_id)) = identity {
        validate_auth_token(token)?;
        validate_user_id(user_id)?;
        let data_root = current
            .as_ref()
            .map_or_else(|| root.to_path_buf(), |session| session.storage_root(root));
        let guest = read_or_create_guest_user_id_at(&data_root)?;
        let adopts_guest = current
            .as_ref()
            .is_none_or(|session| session.user_id() == guest);
        if adopts_guest {
            copy_guest_runtime_state_at(&data_root, &guest, user_id)?;
        }
        if current
            .as_ref()
            .is_none_or(|session| session.space_id() == "official")
        {
            migrate_owned_legacy_env_files(&data_root, managed_root, user_id)?;
        }
        if let Some(source) = current.as_ref().filter(|_| adopts_guest) {
            if let Err(error) =
                crate::spaces::claim_guest_skills(root, managed_root, source, user_id)
            {
                crate::spaces::recover_guest_claims(root, managed_root, source)?;
                return Err(error);
            }
        }
        let committed = write_runtime_session_state_at(
            root,
            Some(token),
            user_id,
            RuntimeSessionState::Stable,
            generation,
        );
        let observed = read_session_at(root)?;
        crate::spaces::recover_guest_claims(root, managed_root, &observed)?;
        committed?;
    } else {
        activate_guest_session_generation_at(root, generation)?;
    }
    Ok(generation)
}

#[cfg(test)]
mod custody_tests {
    use super::*;

    #[test]
    fn command_guard_reads_native_token_and_rejects_wrong_user_and_pending() {
        let root = std::env::temp_dir().join(format!("skillhub-custody-{}", uuid::Uuid::new_v4()));
        let user = uuid::Uuid::new_v4().to_string();
        write_session_at(&root, "native.jwt", &user).unwrap();
        let authorized = authorized_runtime_session_at(&root, &user).unwrap();
        assert_eq!(authorized.token, "native.jwt");
        drop(authorized);
        assert!(authorized_runtime_session_at(&root, &uuid::Uuid::new_v4().to_string()).is_err());
        begin_runtime_session_transition_at(&root).unwrap();
        assert!(authorized_runtime_session_at(&root, &user).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_session_stays_unchanged_and_blocks_network_recovery() {
        let root = std::env::temp_dir().join(format!("skillhub-corrupt-{}", uuid::Uuid::new_v4()));
        let user = uuid::Uuid::new_v4().to_string();
        write_session_at(&root, "native.jwt", &user).unwrap();
        let path = session_path_at(&root);
        fs::write(&path, b"broken fixture").unwrap();
        assert!(runtime_session_snapshot_at(&root)
            .unwrap_err()
            .contains("无法读取 SkillHub 运行时会话"));
        assert!(recover_unreadable_session_at(&root).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken fixture");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(runtime_session_snapshot_at(&root)
            .unwrap_err()
            .contains("无法读取"));
        assert!(recover_unreadable_session_at(&root).is_err());
        assert!(path.is_dir());
        fs::remove_dir_all(root).unwrap();
    }
}

#[tauri::command]
pub async fn get_skill_env_source_policy(
    space: crate::server_request::SpaceHandle,
    skill_id: String,
    account_user_id: Option<String>,
    include_team_sources: Option<bool>,
) -> Result<Vec<SkillEnvSourcePolicyRow>, String> {
    validate_skill_id(&skill_id)?;
    let session = read_session_at(&skillhub_dir())?;
    crate::spaces::require_handle(&session, &space)?;
    validate_session_request(&session, session.auth_token(), account_user_id.as_deref())?;
    let runtime_user_id = session.user_id.clone();
    let profile = read_profile_at(&skills_dir(), &skill_id)?;
    crate::spaces::require_profile(&profile, &session)?;
    let dependencies = profile
        .env_dependencies
        .iter()
        .map(|dependency| RuntimeDependency {
            key: dependency.key.clone(),
            description: dependency.description.clone(),
            required: dependency.required,
        })
        .collect::<Vec<_>>();
    let allowed = dependencies
        .iter()
        .map(|dependency| dependency.key.clone())
        .collect::<BTreeSet<_>>();
    let mut team_sources = Vec::new();
    // The UI can suppress unsupported cloud lookups without disabling personal keys.
    if let (true, Some(server_skill_id), Some(current_auth_token)) = (
        include_team_sources.unwrap_or(true),
        profile_server_id_for_runtime(&profile, &runtime_user_id),
        session.auth_token.as_deref(),
    ) {
        validate_user_id(server_skill_id).map_err(|_| "Skill 的服务器资产编号无效".to_string())?;
        let options = RuntimeApi::for_session(&session)
            .await?
            .options(current_auth_token, server_skill_id)
            .await?;
        if options.skill_id != server_skill_id {
            return Err("服务器返回了错误的 Skill 环境来源".into());
        }
        team_sources = filter_team_sources(options, &dependencies);
    }
    let current_session = read_session_at(&skillhub_dir())?;
    if current_session != session {
        return Err("SkillHub 账号已切换，请重新打开环境变量页".into());
    }
    let _lease = acquire_current_session_lease(&session)?.ok_or(crate::spaces::STALE)?;
    let root = session.storage_root(&skillhub_dir());
    let policy_store = read_policy_at(&root, &runtime_user_id)?;
    let policy = policy_store.skills.get(&skill_id);
    let personal = crate::key_vault::read_personal_values_at(
        &root,
        &root.join("envs"),
        &runtime_user_id,
        &skill_id,
        &allowed,
        &variant_choices(policy),
    )?;
    let variant_options =
        crate::key_vault::variant_options_for_names_at(&root, &runtime_user_id, &allowed)?;
    let mut vault_keys = personal.vault_keys();
    vault_keys.retain(|key| {
        !matches!(
            policy.and_then(|entries| entries.get(key)),
            Some(SkillEnvSource::Team { .. })
        )
    });
    let consent = crate::key_vault::evaluate_consent_at(
        &root,
        &runtime_user_id,
        &skill_id,
        &profile,
        &personal.vault_main_names(&vault_keys),
        crate::key_vault::now_ms(),
    )?;
    // Pending consent is per key (main name); the rows are per declared name.
    let pending = consent.pending.into_iter().collect::<BTreeSet<_>>();
    let consent_pending = vault_keys
        .into_iter()
        .filter(|key| {
            personal
                .vault_identity()
                .get(key)
                .is_some_and(|main| pending.contains(main))
        })
        .collect();
    let served_variants = personal
        .vault_identity()
        .keys()
        .map(|key| {
            (
                key.clone(),
                personal
                    .vault_variant(key)
                    .map(|(variant, _)| variant.clone()),
            )
        })
        .collect();
    let mut rows = source_policy_rows_detailed(
        dependencies,
        personal.values(),
        personal.sources(),
        &consent_pending,
        policy,
        &team_sources,
    );
    attach_personal_variants(&mut rows, &variant_options, &served_variants);
    Ok(rows)
}

/// Adds the personal switcher (#306) to the badge rows: every value of the
/// vault name behind each declared name, and the one this Skill uses when
/// its effective source is the vault (`served`: declared name → variant,
/// `None` for the unlabelled value).
fn attach_personal_variants(
    rows: &mut [SkillEnvSourcePolicyRow],
    options: &BTreeMap<String, Vec<crate::key_vault::KeyVariantOption>>,
    served: &BTreeMap<String, Option<String>>,
) {
    for row in rows {
        row.personal_variants = options.get(&row.key).cloned().unwrap_or_default();
        row.selected_variant = if row.source == Some("vault") {
            served.get(&row.key).cloned().flatten()
        } else {
            None
        };
    }
}

#[cfg(test)]
fn source_policy_rows(
    dependencies: Vec<RuntimeDependency>,
    personal: &BTreeMap<String, String>,
    policy: Option<&BTreeMap<String, SkillEnvSource>>,
    team_sources: &[RuntimeTeamSource],
) -> Vec<SkillEnvSourcePolicyRow> {
    let sources = personal
        .keys()
        .map(|key| (key.clone(), crate::key_vault::PersonalSource::Override))
        .collect();
    source_policy_rows_detailed(
        dependencies,
        personal,
        &sources,
        &BTreeSet::new(),
        policy,
        team_sources,
    )
}

/// Builds the per-key badge rows with the same resolution order as
/// `select_sources`: `valid = selected source available || personal value
/// available || exactly one team value available` (optional keys are never
/// counted as missing).
fn source_policy_rows_detailed(
    dependencies: Vec<RuntimeDependency>,
    personal: &BTreeMap<String, String>,
    personal_sources: &BTreeMap<String, crate::key_vault::PersonalSource>,
    consent_pending: &BTreeSet<String>,
    policy: Option<&BTreeMap<String, SkillEnvSource>>,
    team_sources: &[RuntimeTeamSource],
) -> Vec<SkillEnvSourcePolicyRow> {
    let mut rows = Vec::new();
    for dependency in dependencies {
        let selected = policy
            .and_then(|entries| entries.get(&dependency.key))
            .cloned();
        let personal_available = personal
            .get(&dependency.key)
            .is_some_and(|value| valid_personal_value(value));
        let mut source_options = vec![SkillEnvSourceOption::Personal {
            available: personal_available,
        }];
        let mut available_teams = Vec::new();
        for source in team_sources
            .iter()
            .filter(|source| source.key == dependency.key)
        {
            if source.revision == 0 || available_teams.contains(&source.team_id) {
                continue;
            }
            available_teams.push(source.team_id.clone());
            source_options.push(SkillEnvSourceOption::Team {
                team_id: source.team_id.clone(),
                team_name: source.team_name.clone(),
                available: true,
            });
        }
        let effective = match &selected {
            Some(SkillEnvSource::Personal | SkillEnvSource::PersonalVariant { .. }) => {
                personal_available.then_some(SkillEnvSource::Personal)
            }
            Some(SkillEnvSource::Team { team_id }) => {
                available_teams
                    .contains(team_id)
                    .then(|| SkillEnvSource::Team {
                        team_id: team_id.clone(),
                    })
            }
            None if personal_available => Some(SkillEnvSource::Personal),
            None => match available_teams.as_slice() {
                [team_id] => Some(SkillEnvSource::Team {
                    team_id: team_id.clone(),
                }),
                _ => None,
            },
        };
        let any_available = personal_available || !available_teams.is_empty();
        let state = if effective.is_some() {
            SkillEnvRowState::Ready
        } else if any_available {
            // Several teams compete, or an explicit choice is no longer
            // usable while another source is: the user picks once.
            SkillEnvRowState::NeedsChoice
        } else {
            SkillEnvRowState::NeedsValue
        };
        let valid = effective.is_some() || (selected.is_none() && !dependency.required);
        if let Some(SkillEnvSource::Team { team_id }) = &selected {
            if effective.is_none() {
                source_options.push(SkillEnvSourceOption::Team {
                    team_id: team_id.clone(),
                    team_name: "原团队来源".into(),
                    available: false,
                });
            }
        }
        let personal_source = personal_available
            .then(|| personal_sources.get(&dependency.key).copied())
            .flatten();
        let source = match &effective {
            Some(SkillEnvSource::Personal | SkillEnvSource::PersonalVariant { .. }) => {
                personal_source.map(|source| source.as_str())
            }
            Some(SkillEnvSource::Team { .. }) => Some("team"),
            None => None,
        };
        let needs_consent = source == Some("vault") && consent_pending.contains(&dependency.key);
        rows.push(SkillEnvSourcePolicyRow {
            key: dependency.key,
            description: dependency.description,
            required: dependency.required,
            selected,
            effective,
            valid,
            state,
            options: source_options,
            source,
            personal_source,
            needs_consent,
            personal_variants: Vec::new(),
            selected_variant: None,
        });
    }
    rows
}

#[tauri::command]
pub fn set_skill_env_source(
    space: crate::server_request::SpaceHandle,
    skill_id: String,
    key: String,
    source: SkillEnvSource,
    account_user_id: Option<String>,
) -> Result<(), String> {
    validate_skill_id(&skill_id)?;
    if !valid_env_key(&key) {
        return Err("环境变量名无效".into());
    }
    let session = read_session_at(&skillhub_dir())?;
    crate::spaces::require_handle(&session, &space)?;
    ensure_session_stable(&session)?;
    if let Some(account_user_id) = account_user_id.as_deref() {
        validate_user_id(account_user_id)?;
        if session.user_id != account_user_id {
            return Err("当前身份与 SkillHub 运行时不一致，请重新打开环境变量页".into());
        }
    }
    if let SkillEnvSource::Team { team_id } = &source {
        if session.auth_token.is_none() {
            return Err("团队环境变量需要先在 SkillHub APP 登录".into());
        }
        validate_user_id(team_id).map_err(|_| "环境变量团队来源编号无效".to_string())?;
    }
    let profile = read_profile_at(&skills_dir(), &skill_id)?;
    if !profile
        .env_dependencies
        .iter()
        .any(|dependency| dependency.key == key)
    {
        return Err("环境变量不在当前 Skill 的依赖清单中".into());
    }
    crate::spaces::require_profile(&profile, &session)?;
    let _lease = acquire_current_session_lease(&session)?.ok_or(crate::spaces::STALE)?;
    let data_root = session.storage_root(&skillhub_dir());
    let runtime_user_id = session.user_id.clone();
    if let SkillEnvSource::PersonalVariant { variant } = &source {
        if !crate::key_vault::variant_exists_for_name_at(
            &data_root,
            &runtime_user_id,
            &key,
            variant.as_deref(),
        )? {
            return Err(match variant {
                Some(_) => format!("{key} 没有这把带标签的钥匙，请重新选择"),
                None => format!("{key} 没有不带标签的值，请重新选择"),
            });
        }
    }
    let mut policy = read_policy_at(&data_root, &runtime_user_id)?;
    policy
        .skills
        .entry(skill_id.clone())
        .or_default()
        .insert(key, source);
    write_policy_at(&data_root, &runtime_user_id, &policy)?;
    // A chosen source answers 「需要选择」 (#292).
    crate::last_run::clear_last_run_failure_at(&data_root, &runtime_user_id, &skill_id)
}

#[derive(Clone)]
struct RegularFileSnapshot {
    contents: String,
    mode: u32,
    device: u64,
    inode: u64,
}

#[derive(Clone)]
struct RegularBinarySnapshot {
    sha256: String,
    len: u64,
    mode: u32,
    device: u64,
    inode: u64,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_owned_regular_text(
    path: &Path,
    max_bytes: usize,
    label: &str,
) -> Result<Option<RegularFileSnapshot>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法检查 {label}: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label} 不是安全的普通文件，SkillHub 未作修改"));
    }
    if metadata.uid() != crate::platform_fs::current_uid() || metadata.nlink() != 1 {
        return Err(format!(
            "{label} 的所有权或硬链接状态异常，SkillHub 未作修改"
        ));
    }
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o400 == 0 {
        return Err(format!("{label} 不可读，SkillHub 未作修改"));
    }
    if metadata.len() > max_bytes as u64 {
        return Err(format!("{label} 过大，SkillHub 未作修改"));
    }
    let bytes = fs::read(path).map_err(|error| format!("无法读取 {label}: {error}"))?;
    if bytes.len() > max_bytes {
        return Err(format!("{label} 过大，SkillHub 未作修改"));
    }
    let contents = String::from_utf8(bytes)
        .map_err(|_| format!("{label} 不是 UTF-8 文本，SkillHub 未作修改"))?;
    Ok(Some(RegularFileSnapshot {
        contents,
        mode,
        device: metadata.dev(),
        inode: metadata.ino(),
    }))
}

fn read_owned_regular_binary(
    path: &Path,
    max_bytes: usize,
    label: &str,
) -> Result<Option<RegularBinarySnapshot>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法检查 {label}: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label} 不是安全的普通文件，SkillHub 未作修改"));
    }
    if metadata.uid() != crate::platform_fs::current_uid() || metadata.nlink() != 1 {
        return Err(format!(
            "{label} 的所有权或硬链接状态异常，SkillHub 未作修改"
        ));
    }
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o400 == 0 {
        return Err(format!("{label} 不可读，SkillHub 未作修改"));
    }
    if metadata.len() == 0 || metadata.len() > max_bytes as u64 {
        return Err(format!("{label} 大小异常，SkillHub 未作修改"));
    }
    let bytes = fs::read(path).map_err(|error| format!("无法读取 {label}: {error}"))?;
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err(format!("{label} 大小异常，SkillHub 未作修改"));
    }
    Ok(Some(RegularBinarySnapshot {
        sha256: sha256_hex(&bytes),
        len: bytes.len() as u64,
        mode,
        device: metadata.dev(),
        inode: metadata.ino(),
    }))
}

fn ensure_owned_directory(path: &Path, private: bool) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!("{} 不是安全的普通目录", path.display()));
            }
            if metadata.uid() != crate::platform_fs::current_uid() {
                return Err(format!("{} 不属于当前用户", path.display()));
            }
            if private && metadata.mode() & 0o077 != 0 {
                fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                    .map_err(|error| error.to_string())?;
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|error| error.to_string())?;
            fs::set_permissions(
                path,
                fs::Permissions::from_mode(if private { 0o700 } else { 0o755 }),
            )
            .map_err(|error| error.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    Ok(())
}

fn ensure_public_cli_bin_dir(home: &Path) -> Result<PathBuf, String> {
    let local = home.join(".local");
    let bin = local.join("bin");
    for directory in [&local, &bin] {
        ensure_owned_directory(directory, false)
            .map_err(|error| format!("{error}，SkillHub 未安装公共 CLI 别名"))?;
    }
    Ok(bin)
}

fn ensure_private_cli_bin_dir(home: &Path) -> Result<PathBuf, String> {
    let skillhub = home.join(if crate::official_channel::CHANNEL == "dev" {
        ".skillhub-dev"
    } else {
        ".skillhub"
    });
    let runtime = skillhub.join("runtime");
    let bin = runtime.join("bin");
    for directory in [&skillhub, &runtime, &bin] {
        ensure_owned_directory(directory, true)
            .map_err(|error| format!("{error}，SkillHub 未安装私有 CLI launcher"))?;
    }
    Ok(bin)
}

fn path_matches_snapshot(path: &Path, snapshot: &RegularFileSnapshot) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != crate::platform_fs::current_uid()
        || metadata.nlink() != 1
        || metadata.dev() != snapshot.device
        || metadata.ino() != snapshot.inode
        || metadata.permissions().mode() & 0o777 != snapshot.mode
        || metadata.len() != snapshot.contents.len() as u64
    {
        return false;
    }
    fs::read(path).is_ok_and(|bytes| bytes == snapshot.contents.as_bytes())
}

fn path_matches_binary_snapshot(path: &Path, snapshot: &RegularBinarySnapshot) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != crate::platform_fs::current_uid()
        || metadata.nlink() != 1
        || metadata.dev() != snapshot.device
        || metadata.ino() != snapshot.inode
        || metadata.permissions().mode() & 0o777 != snapshot.mode
        || metadata.len() != snapshot.len
    {
        return false;
    }
    fs::read(path).is_ok_and(|bytes| sha256_hex(&bytes) == snapshot.sha256)
}

#[cfg(unix)]
fn path_c_string(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))
}

#[cfg(target_os = "macos")]
fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    let from = path_c_string(from)?;
    let to = path_c_string(to)?;
    let result = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    let from = path_c_string(from)?;
    let to = path_c_string(to)?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    fs::hard_link(from, to)?;
    fs::remove_file(from)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    // Windows does not expose a portable directory fsync through std. Files
    // are synced before the same-volume, no-replace commit instead.
    Ok(())
}

fn restore_quarantined_item(
    quarantine: &Path,
    destination: &Path,
    label: &str,
) -> Result<(), String> {
    rename_noreplace(quarantine, destination).map_err(|error| {
        format!(
            "{label} 在 SkillHub 更新期间发生并发变化；所有项目均已保留，原路径未被覆盖，待恢复项目位于 {} ({error})",
            quarantine.display()
        )
    })
}

fn cas_replace_regular_text_with_hook<F: FnOnce()>(
    path: &Path,
    contents: &str,
    mode: u32,
    expected: Option<&RegularFileSnapshot>,
    label: &str,
    before_claim: F,
) -> Result<(), String> {
    let parent = path.parent().ok_or("无法确定配置目录")?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|error| error.to_string())?;
    if parent_metadata.file_type().is_symlink()
        || !parent_metadata.is_dir()
        || parent_metadata.uid() != crate::platform_fs::current_uid()
    {
        return Err(format!("{} 的父目录不安全", path.display()));
    }
    let identifier = uuid::Uuid::new_v4();
    let stem = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("config");
    let temporary = parent.join(format!(".{stem}.{identifier}.tmp"));
    let quarantine = parent.join(format!(".{stem}.{identifier}.recovery"));
    let mut temporary_exists = false;
    let mut quarantine_exists = false;
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode & 0o777)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        temporary_exists = true;
        file.write_all(contents.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        drop(file);

        before_claim();
        if let Some(snapshot) = expected {
            fs::rename(path, &quarantine).map_err(|error| {
                format!("{label} 在 SkillHub 更新前发生变化，已保留现状: {error}")
            })?;
            quarantine_exists = true;
            if !path_matches_snapshot(&quarantine, snapshot) {
                restore_quarantined_item(&quarantine, path, label)?;
                quarantine_exists = false;
                return Err(format!(
                    "{label} 在 SkillHub 更新期间发生并发变化，已恢复并保留新内容"
                ));
            }
        }

        if let Err(error) = rename_noreplace(&temporary, path) {
            if quarantine_exists {
                restore_quarantined_item(&quarantine, path, label)?;
                quarantine_exists = false;
            }
            return Err(format!(
                "{label} 在 SkillHub 更新期间被其他项目占用，已保留现状: {error}"
            ));
        }
        temporary_exists = false;
        if quarantine_exists {
            let snapshot = expected.ok_or("缺少并发替换快照")?;
            if !path_matches_snapshot(&quarantine, snapshot) {
                return Err(format!(
                    "{label} 已安装新版本，但旧文件恢复项发生并发变化；未删除任何恢复项 {}",
                    quarantine.display()
                ));
            }
            // Retain the previous owned file at the hidden recovery path.
            // Unlinking after a pathname check would permit a final
            // check-to-unlink race that could delete a foreign replacement.
            // Managed scripts change rarely, so a small recoverable backup is
            // preferable to destructive cleanup.
        }
        sync_directory(parent)
    })();
    if temporary_exists {
        let _ = fs::remove_file(&temporary);
    }
    // Never delete a quarantined item on an error. If an adversarial race
    // prevented restoration, the error reports the recovery path and all bytes
    // remain intact.
    let _ = quarantine_exists;
    result
}

fn cas_replace_regular_binary(
    path: &Path,
    contents: &[u8],
    expected: Option<&RegularBinarySnapshot>,
    label: &str,
) -> Result<(), String> {
    let parent = path.parent().ok_or("无法确定 CLI 目录")?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|error| error.to_string())?;
    if parent_metadata.file_type().is_symlink()
        || !parent_metadata.is_dir()
        || parent_metadata.uid() != crate::platform_fs::current_uid()
    {
        return Err(format!("{} 的父目录不安全", path.display()));
    }
    let identifier = uuid::Uuid::new_v4();
    let stem = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("skillhub-cli");
    let temporary = parent.join(format!(".{stem}.{identifier}.tmp"));
    let quarantine = parent.join(format!(".{stem}.{identifier}.recovery"));
    let mut temporary_exists = false;
    let mut quarantine_exists = false;
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        temporary_exists = true;
        file.write_all(contents)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        drop(file);

        if let Some(snapshot) = expected {
            fs::rename(path, &quarantine).map_err(|error| {
                format!("{label} 在 SkillHub 更新前发生变化，已保留现状: {error}")
            })?;
            quarantine_exists = true;
            if !path_matches_binary_snapshot(&quarantine, snapshot) {
                restore_quarantined_item(&quarantine, path, label)?;
                quarantine_exists = false;
                return Err(format!(
                    "{label} 在 SkillHub 更新期间发生并发变化，已恢复并保留新内容"
                ));
            }
        }

        if let Err(error) = rename_noreplace(&temporary, path) {
            if quarantine_exists {
                restore_quarantined_item(&quarantine, path, label)?;
                quarantine_exists = false;
            }
            return Err(format!(
                "{label} 在 SkillHub 更新期间被其他项目占用，已保留现状: {error}"
            ));
        }
        temporary_exists = false;
        if quarantine_exists {
            let snapshot = expected.ok_or("缺少 CLI 更新快照")?;
            if !path_matches_binary_snapshot(&quarantine, snapshot) {
                return Err(format!(
                    "{label} 已安装新版本，但旧文件恢复项发生并发变化；未删除任何恢复项 {}",
                    quarantine.display()
                ));
            }
        }
        sync_directory(parent)
    })();
    if temporary_exists {
        let _ = fs::remove_file(&temporary);
    }
    let _ = quarantine_exists;
    result
}

fn validate_absolute_cli_path(executable: &Path) -> Result<(), String> {
    if !executable.is_absolute()
        || executable.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err("SkillHub 可执行文件必须使用绝对规范路径".into());
    }
    Ok(())
}

fn validate_legacy_cli_target_path(executable: &Path) -> Result<(), String> {
    // Legacy releases installed a symlink straight to the app executable.
    // That link may legitimately point into a mounted DMG or App
    // Translocation. The exact first-party bundle suffix is checked by
    // `is_exact_legacy_target`; accepting the location here lets the new
    // installer replace the fragile link with a private copied payload.
    validate_absolute_cli_path(executable)
}

fn read_cli_source(executable: &Path) -> Result<Vec<u8>, String> {
    validate_absolute_cli_path(executable)?;
    let inspected = executable
        .canonicalize()
        .map_err(|error| format!("无法定位 SkillHub CLI 复制源: {error}"))?;
    let metadata = fs::symlink_metadata(&inspected)
        .map_err(|error| format!("无法检查 SkillHub CLI 复制源: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("SkillHub CLI 复制源不是普通文件".into());
    }
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err("SkillHub CLI 复制源不可执行".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_CLI_PAYLOAD_BYTES as u64 {
        return Err("SkillHub CLI 复制源大小异常".into());
    }
    let bytes =
        fs::read(&inspected).map_err(|error| format!("无法读取 SkillHub CLI 复制源: {error}"))?;
    if bytes.is_empty() || bytes.len() > MAX_CLI_PAYLOAD_BYTES {
        return Err("SkillHub CLI 复制源大小异常".into());
    }
    Ok(bytes)
}

fn install_managed_script_with_hook<F: FnOnce()>(
    path: &Path,
    contents: &str,
    marker: &str,
    label: &str,
    before_claim: F,
) -> Result<(), String> {
    let snapshot = read_owned_regular_text(path, MAX_CLI_SHIM_BYTES, label)?;
    if let Some(existing) = snapshot.as_ref() {
        if existing.contents.lines().next() != Some("#!/bin/sh")
            || existing.contents.lines().nth(1) != Some(marker)
        {
            return Err(format!("{label} 已存在且不属于 SkillHub；已保留原文件"));
        }
        if existing.contents == contents && existing.mode == 0o700 {
            return Ok(());
        }
    }
    cas_replace_regular_text_with_hook(
        path,
        contents,
        0o700,
        snapshot.as_ref(),
        label,
        before_claim,
    )
}

fn install_managed_script(
    path: &Path,
    contents: &str,
    marker: &str,
    label: &str,
) -> Result<(), String> {
    install_managed_script_with_hook(path, contents, marker, label, || {})
}

fn read_cli_payload_ownership(
    path: &Path,
) -> Result<(CliPayloadOwnership, Option<RegularFileSnapshot>), String> {
    let snapshot = read_owned_regular_text(path, MAX_CLI_SHIM_BYTES, "SkillHub CLI 所有权记录")?;
    let Some(snapshot) = snapshot else {
        return Ok((
            CliPayloadOwnership {
                version: PRIVATE_CLI_OWNERSHIP_VERSION,
                marker: PRIVATE_CLI_OWNERSHIP_MARKER.into(),
                accepted_sha256: BTreeSet::new(),
            },
            None,
        ));
    };
    let ownership = serde_json::from_str::<CliPayloadOwnership>(&snapshot.contents)
        .map_err(|error| format!("SkillHub CLI 所有权记录无效，已保留原文件: {error}"))?;
    if ownership.version != PRIVATE_CLI_OWNERSHIP_VERSION
        || ownership.marker != PRIVATE_CLI_OWNERSHIP_MARKER
        || ownership.accepted_sha256.iter().any(|digest| {
            digest.len() != 64 || !digest.bytes().all(|value| value.is_ascii_hexdigit())
        })
    {
        return Err("SkillHub CLI 所有权记录无法验证，已保留原文件".into());
    }
    Ok((ownership, Some(snapshot)))
}

fn write_cli_payload_ownership(
    path: &Path,
    ownership: &CliPayloadOwnership,
    expected: Option<&RegularFileSnapshot>,
) -> Result<(), String> {
    let mut contents = serde_json::to_string(ownership)
        .map_err(|error| format!("无法编码 SkillHub CLI 所有权记录: {error}"))?;
    contents.push('\n');
    cas_replace_regular_text_with_hook(
        path,
        &contents,
        0o600,
        expected,
        "SkillHub CLI 所有权记录",
        || {},
    )
}

fn install_cli_payload_at(private_bin: &Path, executable: &Path) -> Result<PathBuf, String> {
    let source = read_cli_source(executable)?;
    let source_sha256 = sha256_hex(&source);
    let payload = private_bin.join(PRIVATE_CLI_PAYLOAD_NAME);
    let ownership_path = private_bin.join(PRIVATE_CLI_OWNERSHIP_NAME);
    let (mut ownership, ownership_snapshot) = read_cli_payload_ownership(&ownership_path)?;
    let payload_snapshot =
        read_owned_regular_binary(&payload, MAX_CLI_PAYLOAD_BYTES, "SkillHub CLI 稳定副本")?;

    if let Some(existing) = payload_snapshot.as_ref() {
        if ownership_snapshot.is_none() || !ownership.accepted_sha256.contains(&existing.sha256) {
            return Err("SkillHub CLI 稳定副本无法证明由 SkillHub 管理；已保留原文件".into());
        }
    }

    // Claim the exact source bytes before the atomic replacement. If the app
    // stops between these two writes, the next launch can distinguish either
    // the old managed payload or the pending new one from an unrelated file.
    if ownership.accepted_sha256.insert(source_sha256.clone()) {
        write_cli_payload_ownership(&ownership_path, &ownership, ownership_snapshot.as_ref())?;
    }

    if payload_snapshot
        .as_ref()
        .is_some_and(|existing| existing.sha256 == source_sha256 && existing.mode == 0o700)
    {
        return Ok(payload);
    }
    cas_replace_regular_binary(
        &payload,
        &source,
        payload_snapshot.as_ref(),
        "SkillHub CLI 稳定副本",
    )?;
    Ok(payload)
}

fn private_cli_launcher_contents() -> String {
    format!(
        "#!/bin/sh\n{PRIVATE_CLI_LAUNCHER_MARKER}\nSKILLHUB_CLI=1 exec \"$HOME/.skillhub/runtime/bin/{PRIVATE_CLI_PAYLOAD_NAME}\" \"$@\"\n"
    )
}

fn public_cli_alias_contents() -> String {
    format!(
        "#!/bin/sh\n{PUBLIC_CLI_ALIAS_MARKER}\nexec \"$HOME/.skillhub/runtime/bin/{PRIVATE_CLI_LAUNCHER_NAME}\" \"$@\"\n"
    )
}

fn private_cli_launcher_is_managed(contents: &str) -> bool {
    contents == private_cli_launcher_contents()
}

fn probe_managed_cli_at(home: &Path, expected_version: &str) -> Result<PathBuf, String> {
    let public_alias = home.join(".local/bin/skillhub");
    let private_launcher = home
        .join(".skillhub/runtime/bin")
        .join(PRIVATE_CLI_LAUNCHER_NAME);
    let private_bin = home.join(".skillhub/runtime/bin");
    let payload = private_bin.join(PRIVATE_CLI_PAYLOAD_NAME);
    let ownership_path = private_bin.join(PRIVATE_CLI_OWNERSHIP_NAME);
    let public_snapshot =
        read_owned_regular_text(&public_alias, MAX_CLI_SHIM_BYTES, "~/.local/bin/skillhub")?
            .ok_or("尚未安装 ~/.local/bin/skillhub")?;
    let private_snapshot = read_owned_regular_text(
        &private_launcher,
        MAX_CLI_SHIM_BYTES,
        "SkillHub 私有 CLI launcher",
    )?
    .ok_or("尚未安装 SkillHub 私有 CLI launcher")?;
    let payload_snapshot =
        read_owned_regular_binary(&payload, MAX_CLI_PAYLOAD_BYTES, "SkillHub CLI 稳定副本")?
            .ok_or("尚未安装 SkillHub CLI 稳定副本")?;
    let (ownership, ownership_snapshot) = read_cli_payload_ownership(&ownership_path)?;
    if public_snapshot.contents != public_cli_alias_contents()
        || !private_cli_launcher_is_managed(&private_snapshot.contents)
        || public_snapshot.mode & 0o111 == 0
        || private_snapshot.mode & 0o111 == 0
        || payload_snapshot.mode & 0o111 == 0
        || ownership_snapshot.is_none()
        || !ownership.accepted_sha256.contains(&payload_snapshot.sha256)
    {
        return Err("SkillHub CLI 入口或稳定副本无法验证，已拒绝执行".into());
    }

    let output = cli_probe_output(
        Command::new(&public_alias)
            .arg("--version")
            .env("HOME", home),
    )?;
    let actual = String::from_utf8(output.stdout)
        .map_err(|_| "SkillHub CLI 健康检查输出不是 UTF-8".to_string())?;
    let expected = format!("skillhub {expected_version}");
    if !output.status.success() || actual.trim() != expected {
        return Err(format!(
            "SkillHub CLI 健康检查失败：预期 {expected}，实际 {}",
            actual.trim()
        ));
    }
    Ok(public_alias)
}

struct LegacyPublicAliasClaim {
    quarantine: PathBuf,
    target: PathBuf,
    device: u64,
    inode: u64,
}

fn is_exact_legacy_target(target: &Path) -> bool {
    if validate_legacy_cli_target_path(target).is_err()
        || target.file_name().and_then(|name| name.to_str()) != Some("yitan-skillhub")
        || target
            .parent()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            != Some("MacOS")
        || target
            .parent()
            .and_then(Path::parent)
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            != Some("Contents")
        || target
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            != Some("一探 SkillHub.app")
    {
        return false;
    }
    true
}

fn legacy_claim_identity_is_unchanged(claim: &LegacyPublicAliasClaim) -> bool {
    fs::symlink_metadata(&claim.quarantine)
        .is_ok_and(|metadata| metadata.dev() == claim.device && metadata.ino() == claim.inode)
}

fn legacy_claim_is_unchanged(claim: &LegacyPublicAliasClaim) -> bool {
    legacy_claim_identity_is_unchanged(claim)
        && fs::symlink_metadata(&claim.quarantine)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        && fs::read_link(&claim.quarantine)
            .is_ok_and(|target| target.as_path() == claim.target.as_path())
}

fn restore_legacy_public_alias_claim(
    claim: &LegacyPublicAliasClaim,
    public_alias: &Path,
) -> Result<(), String> {
    if !legacy_claim_identity_is_unchanged(claim) {
        return Err(format!(
            "旧版 SkillHub CLI 链接的恢复项发生变化；未删除任何项目，恢复项位于 {}",
            claim.quarantine.display()
        ));
    }
    restore_quarantined_item(&claim.quarantine, public_alias, "旧版 SkillHub CLI 链接")
}

fn quarantine_proven_legacy_public_alias(
    public_alias: &Path,
) -> Result<Option<LegacyPublicAliasClaim>, String> {
    let metadata = match fs::symlink_metadata(public_alias) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法检查旧版 SkillHub CLI 链接: {error}")),
    };
    if !metadata.file_type().is_symlink() {
        return Ok(None);
    }
    let parent = public_alias.parent().ok_or("无法确定公共 CLI 目录")?;
    let quarantine = parent.join(format!(
        ".skillhub-legacy-{}.recovery",
        uuid::Uuid::new_v4()
    ));
    fs::rename(public_alias, &quarantine)
        .map_err(|error| format!("无法隔离检查旧版 SkillHub CLI 链接: {error}"))?;
    let claimed_metadata = match fs::symlink_metadata(&quarantine) {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = rename_noreplace(&quarantine, public_alias);
            return Err(format!("无法复核旧版 SkillHub CLI 链接: {error}"));
        }
    };
    let target = fs::read_link(&quarantine).unwrap_or_default();
    let claim = LegacyPublicAliasClaim {
        quarantine,
        target,
        device: claimed_metadata.dev(),
        inode: claimed_metadata.ino(),
    };
    if !claimed_metadata.file_type().is_symlink() || !is_exact_legacy_target(&claim.target) {
        restore_legacy_public_alias_claim(&claim, public_alias)?;
        return Err("~/.local/bin/skillhub 是无法证明归属的符号链接；已原样恢复并保留".into());
    }
    Ok(Some(claim))
}

fn install_cli_shim_at_with_public_hook<F: FnOnce()>(
    home: &Path,
    executable: &Path,
    after_legacy_claim: F,
) -> Result<PathBuf, String> {
    let private_bin = ensure_private_cli_bin_dir(home)?;
    install_cli_payload_at(&private_bin, executable)?;
    let private_launcher = private_bin.join(PRIVATE_CLI_LAUNCHER_NAME);
    let private_contents = private_cli_launcher_contents();
    install_managed_script(
        &private_launcher,
        &private_contents,
        PRIVATE_CLI_LAUNCHER_MARKER,
        "SkillHub 私有 CLI launcher",
    )?;

    let public_bin = ensure_public_cli_bin_dir(home)?;
    let public_alias = public_bin.join("skillhub");
    let legacy_claim = quarantine_proven_legacy_public_alias(&public_alias)?;
    after_legacy_claim();
    let public_contents = public_cli_alias_contents();
    if let Err(error) = install_managed_script(
        &public_alias,
        &public_contents,
        PUBLIC_CLI_ALIAS_MARKER,
        "~/.local/bin/skillhub",
    ) {
        if let Some(claim) = legacy_claim.as_ref() {
            restore_legacy_public_alias_claim(claim, &public_alias)?;
        }
        return Err(error);
    }
    if let Some(claim) = legacy_claim {
        if !legacy_claim_is_unchanged(&claim) {
            return Err(format!(
                "新版 CLI 已安装，但旧链接恢复项发生并发变化；未删除恢复项 {}",
                claim.quarantine.display()
            ));
        }
        // Keep the proven legacy link at its exact hidden recovery path. A
        // check-then-unlink sequence would reintroduce a destructive race if
        // another process replaced that pathname between verification and
        // deletion. The one-time backup is tiny and makes the migration fully
        // recoverable.
        sync_directory(&public_bin)?;
    }
    Ok(public_alias)
}

fn install_cli_shim_at(home: &Path, executable: &Path) -> Result<PathBuf, String> {
    install_cli_shim_at_with_public_hook(home, executable, || {})
}

fn ensure_zsh_cli_path_with_hook<F: FnOnce()>(home: &Path, before_claim: F) -> Result<(), String> {
    let path = home.join(".zprofile");
    let snapshot = read_owned_regular_text(&path, MAX_ZPROFILE_BYTES, "~/.zprofile")?;
    let current = snapshot
        .as_ref()
        .map(|snapshot| snapshot.contents.as_str())
        .unwrap_or_default();
    if current.contains("# >>> Yitan SkillHub CLI >>>") {
        if current.contains(CLI_PATH_BLOCK) {
            return Ok(());
        }
        return Err("~/.zprofile 中的 SkillHub PATH 区块不完整，请先手动修复".into());
    }
    let mut updated = current.to_string();
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(CLI_PATH_BLOCK);
    let mode = snapshot.as_ref().map_or(0o600, |snapshot| snapshot.mode);
    cas_replace_regular_text_with_hook(
        &path,
        &updated,
        mode,
        snapshot.as_ref(),
        "~/.zprofile",
        before_claim,
    )
}

fn ensure_zsh_cli_path(home: &Path) -> Result<(), String> {
    ensure_zsh_cli_path_with_hook(home, || {})
}

fn install_and_probe_cli_at(
    home: &Path,
    executable: &Path,
    expected_version: &str,
) -> Result<PathBuf, String> {
    let installation = install_cli_shim_at(home, executable)
        .and_then(|shim| ensure_zsh_cli_path(home).map(|_| shim))
        .and_then(|_| probe_managed_cli_at(home, expected_version));
    match installation {
        Ok(shim) => Ok(shim),
        Err(install_error) => match probe_managed_cli_at(home, expected_version) {
            Ok(existing) => Ok(existing),
            Err(probe_error) => Err(format!("{install_error}；{probe_error}")),
        },
    }
}

fn cli_status_path_at(root: &Path) -> PathBuf {
    runtime_dir_at(root).join("cli-status.json")
}

#[cfg(unix)]
fn initialize_managed_cli_shim() -> RuntimeCliStatus {
    let home = crate::user_home_dir();
    let command_path = home
        .as_ref()
        .map(|path| path.join(".local/bin/skillhub").display().to_string())
        .unwrap_or_else(|| "~/.local/bin/skillhub".into());
    let result = match (home.as_ref(), std::env::current_exe()) {
        (Some(home), Ok(executable)) => {
            install_and_probe_cli_at(home, &executable, env!("CARGO_PKG_VERSION"))
                .map(|_| ())
                .and_then(|_| ensure_runtime_session_at(&skillhub_dir()))
        }
        (None, _) => Err("Cannot find home directory".into()),
        (_, Err(error)) => Err(format!("无法定位 SkillHub 可执行文件: {error}")),
    };
    let status = RuntimeCliStatus {
        managed: true,
        ready: result.is_ok(),
        command_path,
        error: result.err(),
    };
    if let Some(home) = home {
        let _ = write_private_json(
            &cli_status_path_at(&home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })),
            &status,
        );
    }
    if let Ok(mut cached) = CLI_STATUS.lock() {
        *cached = Some(status.clone());
    }
    status
}

#[cfg(windows)]
fn ensure_windows_user_path(bin: &Path) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let bin = bin
        .to_str()
        .ok_or_else(|| "SkillHub Windows CLI 路径不是有效 Unicode".to_string())?;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (environment, _) = hkcu
        .create_subkey("Environment")
        .map_err(|error| format!("无法打开 Windows 用户环境变量: {error}"))?;
    let current = environment
        .get_value::<String, _>("Path")
        .unwrap_or_default();
    let exists = current
        .split(';')
        .map(str::trim)
        .any(|entry| entry.eq_ignore_ascii_case(bin));
    if !exists {
        let updated = if current.trim().is_empty() {
            bin.to_string()
        } else {
            format!("{};{bin}", current.trim_end_matches(';'))
        };
        environment
            .set_value("Path", &updated)
            .map_err(|error| format!("无法更新 Windows 用户 PATH: {error}"))?;
    }
    let process_path = std::env::var_os("PATH").unwrap_or_default();
    let process_has_bin = std::env::split_paths(&process_path)
        .any(|entry| entry.to_string_lossy().eq_ignore_ascii_case(bin));
    if !process_has_bin {
        let mut entries = std::env::split_paths(&process_path).collect::<Vec<_>>();
        entries.push(PathBuf::from(bin));
        let joined = std::env::join_paths(entries)
            .map_err(|error| format!("无法更新当前 SkillHub PATH: {error}"))?;
        std::env::set_var("PATH", joined);
    }
    Ok(())
}

#[cfg(windows)]
fn windows_cli_wrapper_contents() -> String {
    format!(
        "{WINDOWS_PUBLIC_CLI_MARKER}\r\n@echo off\r\nsetlocal\r\nset \"SKILLHUB_CLI=1\"\r\n\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"%~dp0{WINDOWS_PRIVATE_CLI_LAUNCHER_NAME}\" %*\r\nset \"YITAN_SKILLHUB_EXIT_CODE=%ERRORLEVEL%\"\r\nendlocal & exit /b %YITAN_SKILLHUB_EXIT_CODE%\r\n"
    )
}

#[cfg(windows)]
fn windows_private_cli_launcher_contents() -> String {
    format!(
        "{WINDOWS_PRIVATE_CLI_LAUNCHER_MARKER}\r\n\
param(\r\n\
    [Parameter(ValueFromRemainingArguments = $true)]\r\n\
    [AllowEmptyString()]\r\n\
    [string[]] $ForwardedArgs\r\n\
)\r\n\
function ConvertTo-SkillHubCommandLineArgument {{\r\n\
    param([AllowEmptyString()][string] $Value)\r\n\
    if ($Value.Length -gt 0 -and $Value -notmatch '[\\s\"]') {{\r\n\
        return $Value\r\n\
    }}\r\n\
    $Builder = New-Object System.Text.StringBuilder\r\n\
    $Backslash = [char]92\r\n\
    $Quote = [char]34\r\n\
    [void] $Builder.Append($Quote)\r\n\
    $BackslashCount = 0\r\n\
    foreach ($Character in $Value.ToCharArray()) {{\r\n\
        if ($Character -eq $Backslash) {{\r\n\
            $BackslashCount += 1\r\n\
            continue\r\n\
        }}\r\n\
        if ($Character -eq $Quote) {{\r\n\
            [void] $Builder.Append($Backslash, (($BackslashCount * 2) + 1))\r\n\
            [void] $Builder.Append($Quote)\r\n\
            $BackslashCount = 0\r\n\
            continue\r\n\
        }}\r\n\
        if ($BackslashCount -gt 0) {{\r\n\
            [void] $Builder.Append($Backslash, $BackslashCount)\r\n\
            $BackslashCount = 0\r\n\
        }}\r\n\
        [void] $Builder.Append($Character)\r\n\
    }}\r\n\
    if ($BackslashCount -gt 0) {{\r\n\
        [void] $Builder.Append($Backslash, ($BackslashCount * 2))\r\n\
    }}\r\n\
    [void] $Builder.Append($Quote)\r\n\
    $Builder.ToString()\r\n\
}}\r\n\
$ArgumentLine = (@($ForwardedArgs) | ForEach-Object {{\r\n\
    ConvertTo-SkillHubCommandLineArgument $_\r\n\
}}) -join ' '\r\n\
$StartOptions = @{{\r\n\
    FilePath = (Join-Path $PSScriptRoot '{PRIVATE_CLI_PAYLOAD_NAME}')\r\n\
    NoNewWindow = $true\r\n\
    Wait = $true\r\n\
    PassThru = $true\r\n\
    ErrorAction = 'Stop'\r\n\
}}\r\n\
if (@($ForwardedArgs).Count -gt 0) {{\r\n\
    $StartOptions.ArgumentList = $ArgumentLine\r\n\
}}\r\n\
try {{\r\n\
    $Process = Start-Process @StartOptions\r\n\
}} catch {{\r\n\
    exit 1\r\n\
}}\r\n\
$ExitCode = $Process.ExitCode\r\n\
$Process.Dispose()\r\n\
exit $ExitCode\r\n"
    )
}

#[cfg(windows)]
fn windows_private_cli_launcher_v1_contents() -> String {
    format!(
        "{WINDOWS_PRIVATE_CLI_LAUNCHER_MARKER_V1}\r\nparam(\r\n    [Parameter(ValueFromRemainingArguments = $true)]\r\n    [string[]] $ForwardedArgs\r\n)\r\n& (Join-Path $PSScriptRoot '{PRIVATE_CLI_PAYLOAD_NAME}') @ForwardedArgs\r\nexit $LASTEXITCODE\r\n"
    )
}

#[cfg(windows)]
fn windows_private_cli_launcher_is_managed(contents: &str) -> bool {
    contents == windows_private_cli_launcher_contents()
        || contents == windows_private_cli_launcher_v1_contents()
}

#[cfg(windows)]
pub(crate) fn windows_cli_entry_path_at(home: &Path) -> PathBuf {
    home.join(".skillhub/runtime/bin")
        .join(WINDOWS_PUBLIC_CLI_NAME)
}

#[cfg(windows)]
fn windows_command_processor() -> Result<PathBuf, String> {
    let command_processor = std::env::var_os("ComSpec")
        .map(PathBuf::from)
        .ok_or("无法定位 Windows 命令处理器")?;
    if !command_processor.is_absolute()
        || command_processor
            .file_name()
            .and_then(|name| name.to_str())
            .is_none_or(|name| !name.eq_ignore_ascii_case("cmd.exe"))
    {
        return Err("Windows 命令处理器路径无效".into());
    }
    let metadata = fs::symlink_metadata(&command_processor)
        .map_err(|error| format!("无法检查 Windows 命令处理器: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Windows 命令处理器不是安全的普通文件".into());
    }
    Ok(command_processor)
}

#[cfg(windows)]
fn read_legacy_windows_cli_ownership(path: &Path) -> Result<Option<WindowsCliOwnership>, String> {
    let Some(snapshot) =
        read_owned_regular_text(path, MAX_CLI_SHIM_BYTES, "旧版 Windows CLI 所有权记录")?
    else {
        return Ok(None);
    };
    let ownership = serde_json::from_str::<WindowsCliOwnership>(&snapshot.contents)
        .map_err(|error| format!("旧版 Windows CLI 所有权记录无效，已保留原文件: {error}"))?;
    if ownership.version != 1
        || ownership.accepted_sha256.iter().any(|digest| {
            digest.len() != 64 || !digest.bytes().all(|value| value.is_ascii_hexdigit())
        })
    {
        return Err("旧版 Windows CLI 所有权记录无法验证，已保留原文件".into());
    }
    Ok(Some(ownership))
}

#[cfg(windows)]
fn reject_windows_cli_shadowing_entries(bin: &Path) -> Result<(), String> {
    for name in ["skillhub.com", "skillhub.bat", "skillhub.ps1"] {
        let path = bin.join(name);
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                return Err(format!(
                    "Windows CLI 入口可能被无法证明归属的 {name} 遮蔽，已保留原项"
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法检查 Windows CLI 冲突项 {name}: {error}")),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn preflight_windows_cli_entries(bin: &Path) -> Result<Option<RegularBinarySnapshot>, String> {
    reject_windows_cli_shadowing_entries(bin)?;
    let wrapper = bin.join(WINDOWS_PUBLIC_CLI_NAME);
    if read_owned_regular_text(&wrapper, MAX_CLI_SHIM_BYTES, "Windows CLI 入口")?
        .is_some_and(|snapshot| snapshot.contents != windows_cli_wrapper_contents())
    {
        return Err("Windows CLI 入口已有无法证明归属的文件，已保留原项".into());
    }
    let launcher = bin.join(WINDOWS_PRIVATE_CLI_LAUNCHER_NAME);
    if read_owned_regular_text(&launcher, MAX_CLI_SHIM_BYTES, "Windows 私有 CLI launcher")?
        .is_some_and(|snapshot| !windows_private_cli_launcher_is_managed(&snapshot.contents))
    {
        return Err("Windows 私有 CLI launcher 已有无法证明归属的文件，已保留原项".into());
    }

    let legacy = bin.join(WINDOWS_LEGACY_CLI_NAME);
    let legacy_snapshot =
        read_owned_regular_binary(&legacy, MAX_CLI_PAYLOAD_BYTES, "旧版 Windows CLI")?;
    if let Some(snapshot) = legacy_snapshot.as_ref() {
        let ownership =
            read_legacy_windows_cli_ownership(&bin.join(WINDOWS_LEGACY_OWNERSHIP_NAME))?
                .ok_or("旧版 Windows CLI 缺少可验证的所有权记录，已保留原项")?;
        if !ownership.accepted_sha256.contains(&snapshot.sha256) {
            return Err("旧版 Windows CLI 无法证明由 SkillHub 管理，已保留原项".into());
        }
    }
    Ok(legacy_snapshot)
}

#[cfg(windows)]
fn install_exact_windows_cli_text_at(
    path: &Path,
    contents: &str,
    label: &str,
) -> Result<(), String> {
    let snapshot = read_owned_regular_text(path, MAX_CLI_SHIM_BYTES, label)?;
    if let Some(snapshot) = snapshot.as_ref() {
        if snapshot.contents != contents {
            return Err(format!("{label} 已有无法证明归属的文件，已保留原项"));
        }
        return Ok(());
    }
    cas_replace_regular_text_with_hook(path, contents, 0o700, None, label, || {})
}

#[cfg(windows)]
fn install_windows_private_cli_launcher_at(path: &Path) -> Result<(), String> {
    let contents = windows_private_cli_launcher_contents();
    let snapshot = read_owned_regular_text(path, MAX_CLI_SHIM_BYTES, "Windows 私有 CLI launcher")?;
    if let Some(existing) = snapshot.as_ref() {
        if existing.contents == contents {
            return Ok(());
        }
        if existing.contents != windows_private_cli_launcher_v1_contents() {
            return Err("Windows 私有 CLI launcher 已有无法证明归属的文件，已保留原项".into());
        }
    }
    cas_replace_regular_text_with_hook(
        path,
        &contents,
        0o700,
        snapshot.as_ref(),
        "Windows 私有 CLI launcher",
        || {},
    )
}

#[cfg(windows)]
fn install_windows_cli_wrapper_at(bin: &Path) -> Result<PathBuf, String> {
    let launcher = bin.join(WINDOWS_PRIVATE_CLI_LAUNCHER_NAME);
    install_windows_private_cli_launcher_at(&launcher)?;
    let wrapper = bin.join(WINDOWS_PUBLIC_CLI_NAME);
    install_exact_windows_cli_text_at(
        &wrapper,
        &windows_cli_wrapper_contents(),
        "Windows CLI 入口",
    )?;
    Ok(wrapper)
}

#[cfg(windows)]
fn quarantine_proven_legacy_windows_cli(
    bin: &Path,
    snapshot: Option<&RegularBinarySnapshot>,
) -> Result<Option<PathBuf>, String> {
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    let legacy = bin.join(WINDOWS_LEGACY_CLI_NAME);
    let recovery = bin.join(format!(
        ".skillhub-legacy-{}.recovery.exe",
        uuid::Uuid::new_v4()
    ));
    fs::rename(&legacy, &recovery)
        .map_err(|error| format!("无法隔离旧版 Windows CLI，已保留现状: {error}"))?;
    if !path_matches_binary_snapshot(&recovery, snapshot) {
        restore_quarantined_item(&recovery, &legacy, "旧版 Windows CLI")?;
        return Err("旧版 Windows CLI 在迁移期间发生并发变化，已恢复并保留".into());
    }
    sync_directory(bin)?;
    Ok(Some(recovery))
}

#[cfg(windows)]
fn install_windows_cli_files_at(home: &Path, executable: &Path) -> Result<PathBuf, String> {
    let bin = ensure_private_cli_bin_dir(home)?;
    for directory in [
        home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        }),
        home.join(".skillhub/runtime"),
        bin.clone(),
    ] {
        crate::platform_fs::set_private_acl(&directory)?;
    }

    // Preflight every public name before writing the new private payload. In
    // particular, an unknown skillhub.exe must remain untouched because CMD's
    // default PATHEXT would otherwise select it ahead of skillhub.cmd.
    let legacy_snapshot = preflight_windows_cli_entries(&bin)?;
    install_cli_payload_at(&bin, executable)?;
    let wrapper = install_windows_cli_wrapper_at(&bin)?;
    quarantine_proven_legacy_windows_cli(&bin, legacy_snapshot.as_ref())?;
    Ok(wrapper)
}

#[cfg(windows)]
fn install_windows_cli_at(home: &Path, executable: &Path) -> Result<PathBuf, String> {
    let wrapper = install_windows_cli_files_at(home, executable)?;
    ensure_windows_user_path(&home.join(".skillhub/runtime/bin"))?;
    Ok(wrapper)
}

#[cfg(windows)]
fn probe_windows_managed_cli_at(home: &Path, expected_version: &str) -> Result<PathBuf, String> {
    let bin = home.join(".skillhub/runtime/bin");
    reject_windows_cli_shadowing_entries(&bin)?;
    if fs::symlink_metadata(bin.join(WINDOWS_LEGACY_CLI_NAME)).is_ok() {
        return Err("旧版 skillhub.exe 仍会遮蔽受管 Windows CLI 入口".into());
    }
    let wrapper = windows_cli_entry_path_at(home);
    let wrapper_snapshot =
        read_owned_regular_text(&wrapper, MAX_CLI_SHIM_BYTES, "Windows CLI 入口")?
            .ok_or("尚未安装 Windows CLI 入口")?;
    if wrapper_snapshot.contents != windows_cli_wrapper_contents() {
        return Err("Windows CLI 入口无法验证，已拒绝执行".into());
    }
    let launcher = bin.join(WINDOWS_PRIVATE_CLI_LAUNCHER_NAME);
    let launcher_snapshot =
        read_owned_regular_text(&launcher, MAX_CLI_SHIM_BYTES, "Windows 私有 CLI launcher")?
            .ok_or("尚未安装 Windows 私有 CLI launcher")?;
    if launcher_snapshot.contents != windows_private_cli_launcher_contents() {
        return Err("Windows 私有 CLI launcher 无法验证，已拒绝执行".into());
    }
    let payload = bin.join(PRIVATE_CLI_PAYLOAD_NAME);
    let payload_snapshot =
        read_owned_regular_binary(&payload, MAX_CLI_PAYLOAD_BYTES, "Windows CLI 稳定副本")?
            .ok_or("尚未安装 Windows CLI 稳定副本")?;
    let (ownership, ownership_snapshot) =
        read_cli_payload_ownership(&bin.join(PRIVATE_CLI_OWNERSHIP_NAME))?;
    if ownership_snapshot.is_none() || !ownership.accepted_sha256.contains(&payload_snapshot.sha256)
    {
        return Err("Windows CLI 稳定副本无法验证，已拒绝执行".into());
    }

    let output = cli_probe_output(
        Command::new(windows_command_processor()?)
            .args(["/d", "/s", "/c", "skillhub.cmd --version"])
            .current_dir(&bin),
    )?;
    let actual = String::from_utf8(output.stdout)
        .map_err(|_| "Windows CLI 健康检查输出不是 UTF-8".to_string())?;
    let expected = format!("skillhub {expected_version}");
    if !output.status.success() || actual.trim() != expected || !output.stderr.is_empty() {
        return Err(format!(
            "Windows CLI 健康检查失败：预期 {expected}，实际 {}",
            actual.trim()
        ));
    }
    Ok(wrapper)
}

#[cfg(windows)]
fn install_and_probe_windows_cli_at(
    home: &Path,
    executable: &Path,
    expected_version: &str,
) -> Result<PathBuf, String> {
    let installation = install_windows_cli_at(home, executable)
        .and_then(|_| probe_windows_managed_cli_at(home, expected_version));
    match installation {
        Ok(wrapper) => Ok(wrapper),
        Err(install_error) => match probe_windows_managed_cli_at(home, expected_version) {
            Ok(existing) => Ok(existing),
            Err(probe_error) => Err(format!("{install_error}；{probe_error}")),
        },
    }
}

#[cfg(windows)]
fn initialize_managed_cli_shim() -> RuntimeCliStatus {
    let home = crate::user_home_dir();
    let command_path = home
        .as_ref()
        .map(|path| windows_cli_entry_path_at(path).display().to_string())
        .unwrap_or_else(|| "%USERPROFILE%\\.skillhub\\runtime\\bin\\skillhub.cmd".into());
    let result = match (home.as_ref(), std::env::current_exe()) {
        (Some(home), Ok(executable)) => {
            install_and_probe_windows_cli_at(home, &executable, env!("CARGO_PKG_VERSION"))
                .map(|_| ())
                .and_then(|_| ensure_runtime_session_at(&skillhub_dir()))
        }
        (None, _) => Err("Cannot find home directory".into()),
        (_, Err(error)) => Err(format!("无法定位 SkillHub 可执行文件: {error}")),
    };
    let status = RuntimeCliStatus {
        managed: true,
        ready: result.is_ok(),
        command_path,
        error: result.err(),
    };
    if let Some(home) = home {
        let _ = write_private_json(
            &cli_status_path_at(&home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })),
            &status,
        );
    }
    if let Ok(mut cached) = CLI_STATUS.lock() {
        *cached = Some(status.clone());
    }
    status
}

fn unmanaged_cli_status() -> RuntimeCliStatus {
    RuntimeCliStatus {
        managed: false,
        ready: false,
        command_path: String::new(),
        error: None,
    }
}

pub fn initialize_cli_shim() -> RuntimeCliStatus {
    // Dev must not replace the official payload, shim, PATH or persisted status.
    if crate::official_channel::CHANNEL == "dev" {
        return unmanaged_cli_status();
    }
    initialize_managed_cli_shim()
}

// Reading Settings never reinstalls or hashes the CLI payload.
static CLI_STATUS: std::sync::Mutex<Option<RuntimeCliStatus>> = std::sync::Mutex::new(None);
static CLI_CHECK_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tauri::command]
pub fn get_runtime_cli_status() -> Result<RuntimeCliStatus, String> {
    if crate::official_channel::CHANNEL == "dev" {
        return Ok(unmanaged_cli_status());
    }
    Ok(CLI_STATUS
        .lock()
        .map_err(|_| "CLI 状态不可用")?
        .clone()
        .unwrap_or(RuntimeCliStatus {
            managed: true,
            ready: false,
            command_path: String::new(),
            error: Some("CLI 正在初始化，可稍后重新检查".into()),
        }))
}

#[tauri::command]
pub async fn recheck_runtime_cli() -> Result<RuntimeCliStatus, String> {
    if crate::official_channel::CHANNEL == "dev" {
        return Ok(unmanaged_cli_status());
    }
    let Ok(_guard) = CLI_CHECK_LOCK.try_lock() else {
        return Err("CLI 检查正在进行，请稍后重试".into());
    };
    tauri::async_runtime::spawn_blocking(initialize_cli_shim)
        .await
        .map_err(|error| error.to_string())
}

fn cli_probe_output(command: &mut Command) -> Result<std::process::Output, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 CLI 检查: {error}"))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().map_err(|error| error.to_string()),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(error) => format!("CLI 检查失败: {error}"),
                    _ => "CLI 检查超时，请重试".into(),
                });
            }
        }
    }
}

pub(crate) const RUN_USAGE: &str = "用法：skillhub run <skill-id> -- <program> [args...]";

#[derive(Debug, PartialEq, Eq)]
struct CliRunCommand<'a> {
    skill_id: &'a str,
    program: &'a str,
    args: &'a [String],
}

fn normalized_program_name(value: &str) -> String {
    let name = value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(value)
        .trim_matches(['\'', '"'])
        .to_ascii_lowercase();
    name.strip_suffix(".exe").unwrap_or(&name).to_string()
}

fn source_enumerates_environment(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    let has_env_program = source
        .split(|character: char| {
            character.is_whitespace() || matches!(character, ';' | '|' | '&' | '(' | ')')
        })
        .map(|token| token.trim_matches(['\'', '"', '`']))
        .any(|token| matches!(normalized_program_name(token).as_str(), "env" | "printenv"));
    has_env_program
        || lower.contains("get-childitem env:")
        || lower.contains("get-childitem -path env:")
        || lower.contains("gci env:")
        || lower.contains("dir env:")
        || lower.contains("[environment]::getenvironmentvariables")
        || lower.contains("[system.environment]::getenvironmentvariables")
        || lower.contains("process.env")
        || lower.contains("os.environ")
        || lower.contains("export -p")
        || lower.contains("declare -x")
}

fn explicit_environment_enumerator(program: &str, args: &[String]) -> bool {
    let name = normalized_program_name(program);
    if matches!(name.as_str(), "env" | "printenv") {
        return true;
    }
    if matches!(name.as_str(), "busybox" | "toybox")
        && args.first().is_some_and(|value| {
            matches!(normalized_program_name(value).as_str(), "env" | "printenv")
        })
    {
        return true;
    }

    let inline_source = match name.as_str() {
        "sh" | "bash" | "dash" | "zsh" | "ksh" | "fish" => args
            .iter()
            .position(|value| value.starts_with('-') && value.contains('c'))
            .and_then(|index| args.get(index + 1))
            .cloned(),
        "cmd" => args
            .iter()
            .position(|value| value.eq_ignore_ascii_case("/c"))
            .map(|index| &args[index + 1..])
            .filter(|values| !values.is_empty())
            .map(|values| values.join(" ")),
        "powershell" | "pwsh" => args
            .iter()
            .position(|value| {
                value.eq_ignore_ascii_case("-command") || value.eq_ignore_ascii_case("-c")
            })
            .and_then(|index| args.get(index + 1))
            .cloned(),
        "python" | "python3" => args
            .iter()
            .position(|value| value == "-c")
            .and_then(|index| args.get(index + 1))
            .cloned(),
        "node" | "ruby" | "perl" => args
            .iter()
            .position(|value| value == "-e")
            .and_then(|index| args.get(index + 1))
            .cloned(),
        _ => None,
    };
    if inline_source
        .as_deref()
        .is_some_and(source_enumerates_environment)
    {
        return true;
    }

    if name == "cmd" {
        let source = args
            .iter()
            .position(|value| value.eq_ignore_ascii_case("/c"))
            .map(|index| args[index + 1..].join(" "))
            .unwrap_or_default();
        let source = source.trim().to_ascii_lowercase();
        if source == "set" || source.starts_with("set ") {
            return true;
        }
    }
    false
}

fn parse_cli_run_command(args: &[String]) -> Result<CliRunCommand<'_>, String> {
    if args.len() < 4 || args[0] != "run" || args[2] != "--" {
        return Err(RUN_USAGE.into());
    }
    validate_skill_id(&args[1])?;
    let program = args[3].as_str();
    if program.is_empty() || program.chars().any(char::is_control) {
        return Err(RUN_USAGE.into());
    }
    let program_args = &args[4..];
    if explicit_environment_enumerator(program, program_args) {
        return Err("安全策略拒绝执行会枚举环境变量的命令".into());
    }
    Ok(CliRunCommand {
        skill_id: &args[1],
        program,
        args: program_args,
    })
}

pub async fn execute_cli(args: &[String]) -> Result<i32, String> {
    execute_cli_at(
        &skillhub_dir(),
        &skills_dir(),
        &envs_dir(),
        args,
        crate::last_run::detect_agent(),
    )
    .await
}

/// Runs and records the outcome under the runtime identity that started the
/// run (#292); without a readable identity nothing is recorded.
async fn execute_cli_at(
    root: &Path,
    managed_root: &Path,
    env_root: &Path,
    args: &[String],
    agent: Option<&str>,
) -> Result<i32, String> {
    use crate::last_run::{record_run_outcome_at, RunObservation};
    let command = parse_cli_run_command(args)?;
    let session = read_session_at(root).ok();
    let record = |observation: &RunObservation| {
        if let Some(session) = &session {
            if let Ok(Some(_lease)) = acquire_current_session_lease_at(root, session) {
                record_run_outcome_at(
                    &session.storage_root(root),
                    Some(session.user_id()),
                    command.skill_id,
                    observation,
                    agent,
                );
            }
        }
    };
    let environment = match resolve_env_at(root, managed_root, env_root, command.skill_id).await {
        Ok(environment) => environment,
        Err(error) => {
            record(&RunObservation::ResolveFailed(&error));
            return Err(error);
        }
    };
    let result = environment.run(command.program, command.args);
    let observation = match &result {
        Ok(code) => RunObservation::Exited(*code),
        Err(error) => RunObservation::ChildFailed(error),
    };
    record(&observation);
    result
}

#[cfg(test)]
mod cli_channel_tests {
    use super::*;

    #[tokio::test]
    async fn dev_channel_skips_every_cli_write_path() {
        if crate::official_channel::CHANNEL != "dev" {
            return;
        }
        const CHILD_HOME: &str = "SKILLHUB_DEV_CLI_TEST_HOME";
        if let Some(home) = std::env::var_os(CHILD_HOME) {
            let home = PathBuf::from(home);
            assert_eq!(crate::user_home_dir().as_ref(), Some(&home));
            let snapshot = || {
                let mut entries = walkdir::WalkDir::new(&home)
                    .into_iter()
                    .map(|entry| {
                        let entry = entry.unwrap();
                        let path = entry.path();
                        let metadata = fs::symlink_metadata(path).unwrap();
                        let contents = if metadata.is_symlink() {
                            fs::read_link(path)
                                .unwrap()
                                .into_os_string()
                                .into_encoded_bytes()
                        } else if metadata.is_file() {
                            fs::read(path).unwrap()
                        } else {
                            Vec::new()
                        };
                        (
                            path.to_path_buf(),
                            contents,
                            metadata.modified().unwrap(),
                            format!("{:?}", metadata.permissions()),
                        )
                    })
                    .collect::<Vec<_>>();
                entries.sort();
                entries
            };
            let before = snapshot();
            // Include a busy repair and cached official status: dev must ignore both.
            let _lock = CLI_CHECK_LOCK.lock().await;
            *CLI_STATUS.lock().unwrap() = Some(RuntimeCliStatus {
                managed: true,
                ready: true,
                command_path: "official-cli".into(),
                error: None,
            });
            for status in [
                get_runtime_cli_status().unwrap(),
                initialize_cli_shim(),
                recheck_runtime_cli().await.unwrap(),
            ] {
                assert!(!status.managed);
                assert!(!status.ready);
                assert!(status.command_path.is_empty());
                assert!(status.error.is_none());
                assert_eq!(snapshot(), before);
            }
            assert!(CLI_STATUS.lock().unwrap().as_ref().unwrap().managed);
            return;
        }

        for populated in [false, true] {
            let home =
                std::env::temp_dir().join(format!("skillhub-dev-cli-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&home).unwrap();
            if populated {
                for path in [
                    ".local/bin/skillhub",
                    ".zprofile",
                    ".skillhub/runtime/cli-status.json",
                    ".skillhub/runtime/session.json",
                ] {
                    let path = home.join(path);
                    fs::create_dir_all(path.parent().unwrap()).unwrap();
                    fs::write(path, b"preserve official CLI state").unwrap();
                }
                let bin = home.join(".skillhub/runtime/bin");
                fs::create_dir_all(&bin).unwrap();
                for name in [
                    PRIVATE_CLI_PAYLOAD_NAME,
                    PRIVATE_CLI_OWNERSHIP_NAME,
                    "skillhub.cmd",
                    "skillhub.exe",
                ] {
                    fs::write(bin.join(name), b"preserve official CLI payload").unwrap();
                }
                #[cfg(unix)]
                {
                    fs::remove_file(home.join(".local/bin/skillhub")).unwrap();
                    std::os::unix::fs::symlink(
                        bin.join(PRIVATE_CLI_PAYLOAD_NAME),
                        home.join(".local/bin/skillhub"),
                    )
                    .unwrap();
                }
            }
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "runtime_env::cli_channel_tests::dev_channel_skips_every_cli_write_path",
                    "--nocapture",
                ])
                .env(CHILD_HOME, &home)
                .env("HOME", &home)
                .env("USERPROFILE", &home)
                .output()
                .unwrap();
            fs::remove_dir_all(&home).unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}

#[cfg(test)]
mod portable_session_contract_tests {
    use super::{
        begin_runtime_session_transition_at, clear_runtime_session_generation_at,
        clear_runtime_session_if_current_at, finalize_resolved_environment_at,
        parse_cli_run_command, read_session_at, runtime_session_is_current_at,
        runtime_session_matches_at, runtime_session_snapshot_at, session_path_at,
        sync_runtime_session_generation_at, write_private_json, write_session_at,
        RuntimeSessionState,
    };
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::fs;

    const USER_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const USER_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const CHILD_MODE_KEY: &str = "SKILLHUB_RUNTIME_TEST_CHILD_MODE";
    const CHILD_SECRET_KEY: &str = "SKILLHUB_RUNTIME_TEST_CHILD_SECRET";

    fn fixture() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "skillhub-portable-session-contract-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create fixture");
        root
    }

    #[test]
    fn compare_and_clear_never_logs_out_a_newer_session() {
        let root = fixture();
        write_session_at(&root, "old.header.signature", USER_A).expect("write user A session");
        let session_a = runtime_session_snapshot_at(&root).expect("snapshot user A");
        assert!(runtime_session_is_current_at(&root, &session_a).expect("compare user A"));

        write_session_at(&root, "new.header.signature", USER_B).expect("write user B session");
        assert!(!clear_runtime_session_if_current_at(&root, &session_a)
            .expect("stale clear should be ignored"));
        let session_b = read_session_at(&root).expect("read current session");
        assert_eq!(session_b.user_id(), USER_B);
        assert_eq!(session_b.auth_token(), Some("new.header.signature"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn compare_and_clear_replaces_only_the_matching_session_with_guest() {
        let root = fixture();
        write_session_at(&root, "current.header.signature", USER_A).expect("write current session");
        let session = runtime_session_snapshot_at(&root).expect("snapshot current session");
        assert!(
            clear_runtime_session_if_current_at(&root, &session).expect("clear matching session")
        );
        let guest = read_session_at(&root).expect("read guest session");
        assert!(guest.auth_token().is_none());
        assert_ne!(guest.user_id(), USER_A);
        assert_eq!(guest.generation, session.generation + 1);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn legacy_v1_session_without_transition_fields_remains_stable() {
        let root = fixture();
        write_private_json(
            &session_path_at(&root),
            &json!({
                "version": 1,
                "userId": USER_A,
                "authToken": "legacy.header.signature",
            }),
        )
        .expect("write legacy v1 session");

        let session = read_session_at(&root).expect("read legacy v1 session");
        assert_eq!(session.state, RuntimeSessionState::Stable);
        assert_eq!(session.generation, 0);
        assert_eq!(session.auth_token(), Some("legacy.header.signature"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn begin_transition_atomically_removes_token_and_increments_generation() {
        let root = fixture();
        write_session_at(&root, "private.header.signature", USER_A).expect("write user session");

        let generation = begin_runtime_session_transition_at(&root).expect("begin transition");
        let pending = read_session_at(&root).expect("read pending session");
        assert_eq!(generation, 1);
        assert_eq!(pending.generation, generation);
        assert_eq!(pending.state, RuntimeSessionState::SyncPending);
        assert_eq!(pending.user_id(), USER_A);
        assert!(pending.auth_token().is_none());
        assert!(
            !runtime_session_matches_at(&root, "private.header.signature", USER_A)
                .expect("compare pending session")
        );
        assert!(!format!("{pending:?}").contains("private.header.signature"));
        assert!(!fs::read_to_string(session_path_at(&root))
            .expect("read pending JSON")
            .contains("private.header.signature"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn stale_generation_cannot_promote_over_a_newer_transition() {
        let root = fixture();
        let managed = root.join("skills");
        write_session_at(&root, "old.header.signature", USER_A).expect("write old session");
        let stale = begin_runtime_session_transition_at(&root).expect("begin stale transition");
        let current = begin_runtime_session_transition_at(&root).expect("begin current transition");
        assert!(current > stale);

        assert!(sync_runtime_session_generation_at(
            &root,
            &managed,
            "stale.header.signature",
            USER_A,
            stale,
        )
        .is_err());
        assert!(clear_runtime_session_generation_at(&root, stale).is_err());
        let pending = read_session_at(&root).expect("newer transition remains pending");
        assert_eq!(pending.state, RuntimeSessionState::SyncPending);
        assert_eq!(pending.generation, current);
        assert!(pending.auth_token().is_none());

        sync_runtime_session_generation_at(
            &root,
            &managed,
            "new.header.signature",
            USER_B,
            current,
        )
        .expect("promote current transition");
        let authenticated = read_session_at(&root).expect("read promoted session");
        assert_eq!(authenticated.state, RuntimeSessionState::Stable);
        assert_eq!(authenticated.generation, current);
        assert_eq!(authenticated.user_id(), USER_B);
        assert_eq!(authenticated.auth_token(), Some("new.header.signature"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn matching_clear_promotes_pending_transition_to_stable_guest() {
        let root = fixture();
        write_session_at(&root, "current.header.signature", USER_A).expect("write user session");
        let generation = begin_runtime_session_transition_at(&root).expect("begin logout");
        clear_runtime_session_generation_at(&root, generation).expect("complete logout");

        let guest = read_session_at(&root).expect("read stable guest");
        assert_eq!(guest.state, RuntimeSessionState::Stable);
        assert_eq!(guest.generation, generation);
        assert_ne!(guest.user_id(), USER_A);
        assert!(guest.auth_token().is_none());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn run_child_process_probe() {
        match std::env::var(CHILD_MODE_KEY).as_deref() {
            Ok("verify-injected-environment") => {
                if std::env::var(CHILD_SECRET_KEY).as_deref() != Ok("child-only-value") {
                    std::process::exit(91);
                }
            }
            Ok("exit-23") => std::process::exit(23),
            _ => {}
        }
    }

    fn child_test_args() -> Vec<String> {
        vec![
            "--exact".into(),
            "runtime_env::portable_session_contract_tests::run_child_process_probe".into(),
            "--nocapture".into(),
        ]
    }

    #[test]
    fn direct_child_receives_injected_environment_without_parent_export() {
        assert!(std::env::var_os(CHILD_SECRET_KEY).is_none());
        let root = fixture();
        write_session_at(&root, "header.payload.signature", USER_A).expect("write session");
        let session = read_session_at(&root).expect("read session");
        let environment = finalize_resolved_environment_at(
            &root,
            &session,
            BTreeMap::from([
                (CHILD_MODE_KEY.into(), "verify-injected-environment".into()),
                (CHILD_SECRET_KEY.into(), "child-only-value".into()),
            ]),
        )
        .expect("finalize child environment");
        let test_binary = std::env::current_exe().expect("current test binary");
        let code = environment
            .run(
                test_binary.to_str().expect("UTF-8 test binary path"),
                &child_test_args(),
            )
            .expect("run environment probe");
        assert_eq!(code, 0);
        assert!(std::env::var_os(CHILD_SECRET_KEY).is_none());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn direct_child_exit_code_is_propagated() {
        let root = fixture();
        write_session_at(&root, "header.payload.signature", USER_A).expect("write session");
        let session = read_session_at(&root).expect("read session");
        let environment = finalize_resolved_environment_at(
            &root,
            &session,
            BTreeMap::from([(CHILD_MODE_KEY.into(), "exit-23".into())]),
        )
        .expect("finalize child environment");
        let test_binary = std::env::current_exe().expect("current test binary");
        let code = environment
            .run(
                test_binary.to_str().expect("UTF-8 test binary path"),
                &child_test_args(),
            )
            .expect("run exit-code probe");
        assert_eq!(code, 23);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn run_parser_is_portable_and_rejects_explicit_environment_enumerators() {
        let accepted = ["run", "sample", "--", "tool.exe", "--mode", "safe"].map(str::to_string);
        let command = parse_cli_run_command(&accepted).expect("parse direct child command");
        assert_eq!(command.skill_id, "sample");
        assert_eq!(command.program, "tool.exe");
        assert_eq!(command.args, &["--mode".to_string(), "safe".to_string()]);

        for rejected in [
            vec!["run", "sample", "--", "env"],
            vec!["run", "sample", "--", "PRINTENV.EXE"],
            vec!["run", "sample", "--", r"C:\Windows\System32\env.exe"],
            vec!["run", "sample", "--", "busybox", "env"],
            vec!["run", "sample", "--", "sh", "-lc", "/usr/bin/env"],
            vec!["run", "sample", "--", "cmd.exe", "/C", "set"],
            vec![
                "run",
                "sample",
                "--",
                "powershell.exe",
                "-Command",
                "Get-ChildItem Env:",
            ],
            vec!["run", "sample", "--", "python3", "-c", "print(os.environ)"],
            vec![
                "run",
                "sample",
                "--",
                "node",
                "-e",
                "console.log(process.env)",
            ],
        ] {
            let rejected = rejected.into_iter().map(str::to_string).collect::<Vec<_>>();
            let error = parse_cli_run_command(&rejected)
                .expect_err("environment enumeration must be rejected");
            assert!(error.contains("枚举环境变量"));
        }
    }
}

#[cfg(all(test, windows))]
mod windows_cli_tests {
    use super::{
        install_windows_cli_files_at, sha256_hex, windows_cli_entry_path_at,
        windows_cli_wrapper_contents, windows_command_processor,
        windows_private_cli_launcher_contents, windows_private_cli_launcher_v1_contents,
        write_private_json, WindowsCliOwnership, PRIVATE_CLI_OWNERSHIP_NAME,
        PRIVATE_CLI_PAYLOAD_NAME, WINDOWS_LEGACY_CLI_NAME, WINDOWS_LEGACY_OWNERSHIP_NAME,
        WINDOWS_PRIVATE_CLI_LAUNCHER_NAME, WINDOWS_PUBLIC_CLI_MARKER,
    };
    use std::collections::BTreeSet;
    use std::fs;
    use std::process::{Command, Output};

    fn fixture() -> std::path::PathBuf {
        let home =
            std::env::temp_dir().join(format!("skillhub-windows-cli-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&home).expect("create Windows CLI fixture");
        home
    }

    fn write_source(path: &std::path::Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().expect("source parent")).expect("create source parent");
        fs::write(path, bytes).expect("write Windows CLI source");
    }

    fn remove_fixture(home: &std::path::Path) {
        for attempt in 0..20 {
            match fs::remove_dir_all(home) {
                Ok(()) => return,
                Err(error)
                    if attempt < 19 && error.kind() == std::io::ErrorKind::PermissionDenied =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                Err(error) => panic!("remove Windows CLI fixture {}: {error}", home.display()),
            }
        }
    }

    fn copy_command_processor(path: &std::path::Path) {
        fs::create_dir_all(path.parent().expect("source parent")).expect("create source parent");
        fs::copy(windows_command_processor().expect("locate cmd.exe"), path)
            .expect("copy cmd.exe fixture");
    }

    // A renamed copy of the system cmd.exe intermittently exits 1 on the
    // GitHub-hosted Windows runner before running its command (#18). Tests
    // that only need "a console program the CLI can launch" copy this Rust
    // test binary instead and ask libtest to list one test, which needs no
    // Windows message resources and always exits 0.
    fn copy_test_executable(path: &std::path::Path) {
        fs::create_dir_all(path.parent().expect("source parent")).expect("create source parent");
        fs::copy(
            std::env::current_exe().expect("locate the test executable"),
            path,
        )
        .expect("copy test executable fixture");
    }

    const LISTED_TEST: &str =
        "runtime_env::windows_cli_tests::restart_refresh_and_source_removal_keep_the_private_cli_runnable";

    fn windows_powershell() -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var_os("SystemRoot").expect("locate SystemRoot"))
            .join("System32/WindowsPowerShell/v1.0/powershell.exe")
    }

    fn run_public_cli(home: &std::path::Path, command: &str) -> Output {
        Command::new(windows_command_processor().expect("locate cmd.exe"))
            .args(["/d", "/s", "/c", command])
            .current_dir(home.join(".skillhub/runtime/bin"))
            .env("USERPROFILE", home)
            .env("HOME", home)
            .output()
            .expect("run public Windows CLI wrapper")
    }

    // Runs each layer of the Windows CLI on its own so a CI failure shows
    // which one turned a successful payload run into a non-zero exit code.
    fn windows_cli_layer_diagnostics(home: &std::path::Path, payload_args: &[&str]) -> String {
        let bin = home.join(".skillhub/runtime/bin");
        let describe = |label: &str, output: std::io::Result<Output>| match output {
            Ok(output) => format!(
                "{label}: {:?} stdout={} stderr={}",
                output.status.code(),
                String::from_utf8_lossy(&output.stdout).trim(),
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            Err(error) => format!("{label}: spawn error {error}"),
        };
        let payload = bin.join(PRIVATE_CLI_PAYLOAD_NAME);
        let launcher = bin.join(WINDOWS_PRIVATE_CLI_LAUNCHER_NAME);
        let start_process = format!(
            "try {{ $p = Start-Process -FilePath '{}' -ArgumentList '{}' -NoNewWindow -Wait -PassThru -ErrorAction Stop; 'exit=' + $p.ExitCode }} catch {{ 'caught: ' + $_.Exception.ToString() }}",
            payload.display(),
            payload_args.join(" ")
        );
        let wrapper_command = format!("skillhub.cmd {}", payload_args.join(" "));
        [
            describe(
                "payload",
                Command::new(&payload)
                    .args(payload_args)
                    .current_dir(&bin)
                    .output(),
            ),
            describe(
                "launcher",
                Command::new(windows_powershell())
                    .args([
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                    ])
                    .arg(&launcher)
                    .args(payload_args)
                    .current_dir(&bin)
                    .output(),
            ),
            describe(
                "start-process",
                Command::new(windows_powershell())
                    .args([
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        &start_process,
                    ])
                    .current_dir(&bin)
                    .output(),
            ),
            describe("wrapper-again", Ok(run_public_cli(home, &wrapper_command))),
        ]
        .join("\n")
    }

    fn run_public_cli_from_powershell(home: &std::path::Path, script: &str) -> Output {
        Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-Command", script])
            .current_dir(home.join(".skillhub/runtime/bin"))
            .env("USERPROFILE", home)
            .env("HOME", home)
            .output()
            .expect("run public Windows CLI wrapper from PowerShell")
    }

    fn pe_subsystem(bytes: &[u8]) -> Option<u16> {
        let pe_offset = u32::from_le_bytes(bytes.get(0x3c..0x40)?.try_into().ok()?) as usize;
        if bytes.get(pe_offset..pe_offset + 4)? != b"PE\0\0" {
            return None;
        }
        let optional = pe_offset.checked_add(24)?;
        let magic = u16::from_le_bytes(bytes.get(optional..optional + 2)?.try_into().ok()?);
        if !matches!(magic, 0x10b | 0x20b) {
            return None;
        }
        let subsystem_offset = 68;
        let offset = optional.checked_add(subsystem_offset)?;
        Some(u16::from_le_bytes(
            bytes.get(offset..offset + 2)?.try_into().ok()?,
        ))
    }

    #[test]
    fn wrapper_waits_pipes_output_and_propagates_exit_code() {
        let home = fixture();
        let source = home.join("app/skillhub.exe");
        copy_command_processor(&source);
        let wrapper =
            install_windows_cli_files_at(&home, &source).expect("install Windows CLI wrapper");
        assert_eq!(wrapper, windows_cli_entry_path_at(&home));
        let contents = fs::read_to_string(&wrapper).expect("read wrapper");
        assert!(contents.starts_with(WINDOWS_PUBLIC_CLI_MARKER));
        assert!(contents.contains("WindowsPowerShell\\v1.0\\powershell.exe"));
        assert!(contents.contains(WINDOWS_PRIVATE_CLI_LAUNCHER_NAME));
        assert_eq!(
            fs::read_to_string(
                home.join(".skillhub/runtime/bin")
                    .join(WINDOWS_PRIVATE_CLI_LAUNCHER_NAME)
            )
            .expect("read private launcher"),
            windows_private_cli_launcher_contents()
        );

        let ordinary = run_public_cli(&home, "skillhub.cmd /d /q /c echo wrapper-output");
        assert!(ordinary.status.success());
        assert_eq!(
            String::from_utf8_lossy(&ordinary.stdout).trim(),
            "wrapper-output"
        );

        let piped = run_public_cli(
            &home,
            "skillhub.cmd /d /q /c echo wrapper-pipeline | findstr.exe wrapper-pipeline",
        );
        assert!(
            piped.status.success(),
            "pipeline status={:?} stdout={} stderr={}",
            piped.status.code(),
            String::from_utf8_lossy(&piped.stdout),
            String::from_utf8_lossy(&piped.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&piped.stdout).trim(),
            "wrapper-pipeline"
        );

        let stderr = run_public_cli(&home, "skillhub.cmd /d /q /c echo wrapper-error 1>&2");
        assert!(stderr.status.success());
        assert!(stderr.stdout.is_empty());
        assert_eq!(
            String::from_utf8_lossy(&stderr.stderr).trim(),
            "wrapper-error"
        );

        let powershell_wrapper = wrapper.to_string_lossy().replace('\'', "''");
        let powershell = run_public_cli_from_powershell(
            &home,
            &format!(
                "$value = & '{powershell_wrapper}' /d /q /c 'echo wrapper-powershell' | ForEach-Object {{ $_.ToUpperInvariant() }}; Write-Output $value; exit $LASTEXITCODE"
            ),
        );
        assert!(
            powershell.status.success(),
            "PowerShell stdout={} stderr={}",
            String::from_utf8_lossy(&powershell.stdout),
            String::from_utf8_lossy(&powershell.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&powershell.stdout).trim(),
            "WRAPPER-POWERSHELL"
        );

        let failed = run_public_cli(&home, "skillhub.cmd /d /q /c exit /b 23");
        assert_eq!(failed.status.code(), Some(23));
        remove_fixture(&home);
    }

    #[test]
    fn private_launcher_preserves_windows_argument_boundaries() {
        let home = fixture();
        let source = home.join("app/powershell.exe");
        fs::create_dir_all(source.parent().expect("PowerShell source parent"))
            .expect("create PowerShell source parent");
        fs::copy(windows_powershell(), &source).expect("copy PowerShell fixture");
        install_windows_cli_files_at(&home, &source).expect("install private launcher fixture");

        let probe = home.join("argument probe.ps1");
        fs::write(
            &probe,
            "param(\r\n    [Parameter(ValueFromRemainingArguments = $true)]\r\n    [AllowEmptyString()]\r\n    [string[]] $Values\r\n)\r\n[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($Values)))\r\nexit 29\r\n",
        )
        .expect("write argument probe");
        let launcher = home
            .join(".skillhub/runtime/bin")
            .join(WINDOWS_PRIVATE_CLI_LAUNCHER_NAME);
        let output = Command::new(windows_powershell())
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&launcher)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&probe)
            .arg("value with spaces")
            .arg("")
            .arg("quote\"value")
            .arg("C:\\trailing\\")
            .current_dir(home.join(".skillhub/runtime/bin"))
            .env("USERPROFILE", &home)
            .env("HOME", &home)
            .output()
            .expect("run private launcher argument probe");
        assert_eq!(
            output.status.code(),
            Some(29),
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let values: serde_json::Value =
            serde_json::from_slice(&output.stdout).expect("parse argument probe output");
        assert_eq!(
            values,
            serde_json::json!(["value with spaces", "", "quote\"value", "C:\\trailing\\"])
        );
        assert!(output.stderr.is_empty());
        remove_fixture(&home);
    }

    #[test]
    fn release_gui_payload_is_waited_and_json_is_pipeable_from_cmd_and_powershell() {
        let Some(source) =
            std::env::var_os("SKILLHUB_TEST_GUI_PAYLOAD").map(std::path::PathBuf::from)
        else {
            return;
        };
        let source_bytes = fs::read(&source).expect("read packaged GUI payload");
        assert_eq!(
            pe_subsystem(&source_bytes),
            Some(2),
            "native fixture must be a Windows GUI-subsystem executable"
        );
        let home = fixture();
        let wrapper = install_windows_cli_files_at(&home, &source)
            .expect("install packaged GUI payload behind wrapper");

        let version = run_public_cli(&home, "skillhub.cmd --version");
        assert!(
            version.status.success(),
            "version stdout={} stderr={}",
            String::from_utf8_lossy(&version.stdout),
            String::from_utf8_lossy(&version.stderr)
        );
        assert!(
            String::from_utf8_lossy(&version.stdout)
                .trim()
                .starts_with("skillhub "),
            "version stdout={} stderr={}",
            String::from_utf8_lossy(&version.stdout),
            String::from_utf8_lossy(&version.stderr)
        );

        let json = run_public_cli(&home, "skillhub.cmd skill prepare-edit --json");
        assert!(
            !json.status.success(),
            "status code={:?} stdout={} stderr={}",
            json.status.code(),
            String::from_utf8_lossy(&json.stdout),
            String::from_utf8_lossy(&json.stderr)
        );
        let payload: serde_json::Value =
            serde_json::from_slice(&json.stdout).unwrap_or_else(|error| {
                panic!(
                    "CMD captures complete SkillHub JSON: {error}; stdout={} stderr={}",
                    String::from_utf8_lossy(&json.stdout),
                    String::from_utf8_lossy(&json.stderr)
                )
            });
        assert_eq!(payload.get("schemaVersion"), Some(&serde_json::json!(1)));
        assert_eq!(payload.get("ok"), Some(&serde_json::json!(false)));

        let missing_skill = home.join("missing skill/SKILL.md");
        let powershell_wrapper = wrapper.to_string_lossy().replace('\'', "''");
        let powershell_missing_skill = missing_skill.to_string_lossy().replace('\'', "''");
        let missing = run_public_cli_from_powershell(
            &home,
            &format!(
                r#"$payload = & '{powershell_wrapper}' skill prepare-edit --skill-path '{powershell_missing_skill}' --json; $code = $LASTEXITCODE; if ($payload -match '"nextActions":\[\]') {{ exit 93 }}; Write-Output 'spaced-path-preserved'; exit $code"#
            ),
        );
        assert_eq!(missing.status.code(), Some(2));
        assert_eq!(
            String::from_utf8_lossy(&missing.stdout).trim(),
            "spaced-path-preserved",
            "spaced path must remain one argument; stderr={}",
            String::from_utf8_lossy(&missing.stderr)
        );

        let piped = run_public_cli(
            &home,
            r#"skillhub.cmd skill prepare-edit --json | findstr.exe /c:"schemaVersion""#,
        );
        assert!(
            piped.status.success(),
            "CMD JSON pipe stdout={} stderr={}",
            String::from_utf8_lossy(&piped.stdout),
            String::from_utf8_lossy(&piped.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&piped.stdout)
            .expect("CMD pipeline preserves complete SkillHub JSON");

        let powershell = run_public_cli_from_powershell(
            &home,
            &format!(
                "$payload = & '{powershell_wrapper}' skill prepare-edit --json | ConvertFrom-Json; if ($payload.schemaVersion -ne 1 -or $payload.ok) {{ exit 91 }}; Write-Output $payload.schemaVersion"
            ),
        );
        assert!(
            powershell.status.success(),
            "PowerShell JSON stdout={} stderr={}",
            String::from_utf8_lossy(&powershell.stdout),
            String::from_utf8_lossy(&powershell.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&powershell.stdout).trim(), "1");

        let invalid = run_public_cli(&home, "skillhub.cmd invalid");
        assert_eq!(invalid.status.code(), Some(2));
        assert!(invalid.stdout.is_empty());
        assert!(!invalid.stderr.is_empty());
        remove_fixture(&home);
    }

    #[test]
    fn restart_refresh_and_source_removal_keep_the_private_cli_runnable() {
        let home = fixture();
        let source = home.join("installed-app/skillhub.exe");
        copy_test_executable(&source);
        let first =
            install_windows_cli_files_at(&home, &source).expect("install first Windows CLI");
        let second = install_windows_cli_files_at(&home, &source).expect("refresh Windows CLI");
        assert_eq!(first, second);
        fs::remove_file(&source).expect("simulate removing the installed APP source");

        let payload_args = ["--list", "--format", "terse", "--exact", LISTED_TEST];
        let output = run_public_cli(&home, &format!("skillhub.cmd {}", payload_args.join(" ")));
        assert!(
            output.status.success(),
            "CLI failed after source removal: {:?}\nstdout: {}\nstderr: {}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
            windows_cli_layer_diagnostics(&home, &payload_args)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            format!("{LISTED_TEST}: test")
        );
        let recoveries = fs::read_dir(home.join(".skillhub/runtime/bin"))
            .expect("read CLI bin")
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(".recovery"))
            .count();
        assert_eq!(recoveries, 0);
        remove_fixture(&home);
    }

    #[test]
    fn exact_v1_private_launcher_is_recoverably_upgraded_to_v2() {
        let home = fixture();
        let bin = home.join(".skillhub/runtime/bin");
        fs::create_dir_all(&bin).expect("create existing Windows CLI bin");
        fs::write(
            bin.join(WINDOWS_PRIVATE_CLI_LAUNCHER_NAME),
            windows_private_cli_launcher_v1_contents(),
        )
        .expect("write exact v1 private launcher");
        fs::write(bin.join("skillhub.cmd"), windows_cli_wrapper_contents())
            .expect("write existing public wrapper");
        let source = home.join("app/skillhub.exe");
        copy_command_processor(&source);

        install_windows_cli_files_at(&home, &source).expect("upgrade v1 private launcher");
        assert_eq!(
            fs::read_to_string(bin.join(WINDOWS_PRIVATE_CLI_LAUNCHER_NAME))
                .expect("read upgraded private launcher"),
            windows_private_cli_launcher_contents()
        );
        let recoveries = fs::read_dir(&bin)
            .expect("read Windows CLI bin")
            .flatten()
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with(".yitan-skillhub-runtime.ps1.") && name.ends_with(".recovery")
            })
            .map(|entry| fs::read_to_string(entry.path()).expect("read v1 launcher recovery"))
            .collect::<Vec<_>>();
        assert_eq!(recoveries, vec![windows_private_cli_launcher_v1_contents()]);
        remove_fixture(&home);
    }

    #[test]
    fn proven_legacy_exe_is_recoverably_migrated_to_private_payload_and_wrapper() {
        let home = fixture();
        let bin = home.join(".skillhub/runtime/bin");
        fs::create_dir_all(&bin).expect("create legacy CLI bin");
        let legacy_bytes = b"owned legacy app bytes";
        fs::write(bin.join(WINDOWS_LEGACY_CLI_NAME), legacy_bytes).expect("write owned legacy CLI");
        write_private_json(
            &bin.join(WINDOWS_LEGACY_OWNERSHIP_NAME),
            &WindowsCliOwnership {
                version: 1,
                accepted_sha256: BTreeSet::from([sha256_hex(legacy_bytes)]),
            },
        )
        .expect("write legacy ownership");
        let source = home.join("app/new-skillhub.exe");
        let new_bytes = b"new private app bytes";
        write_source(&source, new_bytes);

        install_windows_cli_files_at(&home, &source).expect("migrate legacy Windows CLI");
        assert!(!bin.join(WINDOWS_LEGACY_CLI_NAME).exists());
        assert_eq!(
            fs::read(bin.join(PRIVATE_CLI_PAYLOAD_NAME)).expect("read private payload"),
            new_bytes
        );
        assert_eq!(
            fs::read_to_string(windows_cli_entry_path_at(&home)).expect("read public wrapper"),
            windows_cli_wrapper_contents()
        );
        assert_eq!(
            fs::read_to_string(bin.join(WINDOWS_PRIVATE_CLI_LAUNCHER_NAME))
                .expect("read private launcher"),
            windows_private_cli_launcher_contents()
        );
        let recoveries = fs::read_dir(&bin)
            .expect("read migrated CLI bin")
            .flatten()
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with(".skillhub-legacy-") && name.ends_with(".recovery.exe")
            })
            .map(|entry| fs::read(entry.path()).expect("read legacy recovery"))
            .collect::<Vec<_>>();
        assert_eq!(recoveries, vec![legacy_bytes.to_vec()]);
        remove_fixture(&home);
    }

    #[test]
    fn unknown_legacy_exe_is_preserved_before_any_new_cli_file_is_written() {
        let home = fixture();
        let bin = home.join(".skillhub/runtime/bin");
        fs::create_dir_all(&bin).expect("create conflicting CLI bin");
        let legacy = bin.join(WINDOWS_LEGACY_CLI_NAME);
        fs::write(&legacy, b"foreign executable").expect("write foreign legacy executable");
        let source = home.join("app/skillhub.exe");
        write_source(&source, b"first-party source");

        let error = install_windows_cli_files_at(&home, &source)
            .expect_err("unknown legacy executable must block migration");
        assert!(error.contains("缺少可验证的所有权记录"));
        assert_eq!(
            fs::read(&legacy).expect("read preserved legacy executable"),
            b"foreign executable"
        );
        assert!(!windows_cli_entry_path_at(&home).exists());
        assert!(!bin.join(WINDOWS_PRIVATE_CLI_LAUNCHER_NAME).exists());
        assert!(!bin.join(PRIVATE_CLI_PAYLOAD_NAME).exists());
        assert!(!bin.join(PRIVATE_CLI_OWNERSHIP_NAME).exists());
        remove_fixture(&home);
    }

    #[test]
    fn unknown_wrapper_launcher_and_shadowing_batch_file_are_preserved() {
        for conflict_name in [
            "skillhub.cmd",
            "skillhub.bat",
            WINDOWS_PRIVATE_CLI_LAUNCHER_NAME,
        ] {
            let home = fixture();
            let bin = home.join(".skillhub/runtime/bin");
            fs::create_dir_all(&bin).expect("create conflicting CLI bin");
            let conflict = bin.join(conflict_name);
            let contents = if conflict_name == WINDOWS_PRIVATE_CLI_LAUNCHER_NAME {
                format!(
                    "{}Write-Output 'foreign addition'\r\n",
                    windows_private_cli_launcher_v1_contents()
                )
                .into_bytes()
            } else {
                b"@echo foreign\r\n".to_vec()
            };
            fs::write(&conflict, &contents).expect("write foreign CLI entry");
            let source = home.join("app/skillhub.exe");
            write_source(&source, b"first-party source");

            install_windows_cli_files_at(&home, &source)
                .expect_err("unknown public entry must block installation");
            assert_eq!(
                fs::read(&conflict).expect("read preserved public entry"),
                contents
            );
            assert!(!bin.join(PRIVATE_CLI_PAYLOAD_NAME).exists());
            assert!(!bin.join(PRIVATE_CLI_OWNERSHIP_NAME).exists());
            remove_fixture(&home);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::session_lock_semantics_tests::run_lock_probe;
    use super::{
        account_env_path_at, clear_runtime_session_at, copy_guest_runtime_state_at,
        ensure_zsh_cli_path, ensure_zsh_cli_path_with_hook, finalize_resolved_environment_at,
        guest_identity_path_at, install_and_probe_cli_at, install_cli_shim_at,
        install_cli_shim_at_with_public_hook, install_managed_script_with_hook,
        migrate_owned_legacy_env_files, parse_cli_run_command, personal_team_value_at,
        policy_path_at, profile_server_id_for_runtime, read_policy_at, read_session_at,
        resolve_env_at, select_sources, session_path_at, shell_quote, source_policy_rows,
        sync_runtime_session_at, team_candidates, validate_absolute_cli_path, write_policy_at,
        write_session_at, AccountSourcePolicy, RuntimeDependency, RuntimeTeamSelection,
        RuntimeTeamSource, SkillEnvRowState, SkillEnvSource, SkillEnvSourceOption, TeamCandidates,
        MAX_RUNTIME_JSON_BYTES, PRIVATE_CLI_LAUNCHER_MARKER, PRIVATE_CLI_LAUNCHER_NAME,
        PRIVATE_CLI_OWNERSHIP_NAME, PRIVATE_CLI_PAYLOAD_NAME, PUBLIC_CLI_ALIAS_MARKER,
        RUNTIME_STORE_VERSION,
    };
    use std::collections::BTreeMap;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::process::Command;

    const USER_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const USER_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    #[test]
    fn remote_environment_lookup_requires_the_current_account_binding() {
        let owned = crate::SkillHubProfile {
            server_id: Some("server-skill".into()),
            server_owner_id: Some(USER_A.into()),
            ..Default::default()
        };
        assert_eq!(
            profile_server_id_for_runtime(&owned, USER_A),
            Some("server-skill")
        );
        assert_eq!(profile_server_id_for_runtime(&owned, USER_B), None);

        let team = crate::SkillHubProfile {
            server_id: Some("team-skill".into()),
            server_owner_id: Some(USER_B.into()),
            is_own: Some(false),
            acquisition_source: Some(crate::AcquisitionSource::Team),
            acquired_by_user_id: Some(USER_A.into()),
            team_shared_from: Some("team-id".into()),
            ..Default::default()
        };
        assert_eq!(
            profile_server_id_for_runtime(&team, USER_A),
            Some("team-skill")
        );
        assert_eq!(profile_server_id_for_runtime(&team, USER_B), None);

        let marketplace = crate::SkillHubProfile {
            server_id: Some("marketplace-skill".into()),
            server_owner_id: Some(USER_B.into()),
            is_own: Some(false),
            acquisition_source: Some(crate::AcquisitionSource::Marketplace),
            ..Default::default()
        };
        assert_eq!(profile_server_id_for_runtime(&marketplace, USER_A), None);
    }

    fn fixture() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("skillhub-runtime-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn putting_a_personal_value_into_a_team_reads_override_then_vault_for_a_declared_key() {
        let root = fixture();
        let managed = root.join("skills");
        let env_root = root.join("envs");
        let skill = managed.join("sample");
        fs::create_dir_all(&skill).expect("create managed skill");
        // A team-installed Skill (not authored by this account) may still
        // hand its key to the team vault: any member can put team keys.
        fs::write(
            skill.join(".skillhub.json"),
            format!(r#"{{"version":"1","skillhub":{{"id":"sample","name":"sample","isOwn":false,"serverOwnerId":"{USER_B}","envDependencies":[{{"key":"API_KEY","required":true}},{{"key":"VAULT_ONLY","required":true}}]}}}}"#),
        ).expect("write profile");
        crate::key_vault::set_vault_key_at(&root, USER_A, "API_KEY", "vault-test-value", None, 1)
            .expect("vault API_KEY");
        crate::key_vault::set_vault_key_at(
            &root,
            USER_A,
            "VAULT_ONLY",
            "vault-only-value",
            None,
            1,
        )
        .expect("vault VAULT_ONLY");
        assert_eq!(
            personal_team_value_at(&managed, &env_root, USER_A, "sample", "VAULT_ONLY")
                .expect("vault value"),
            "vault-only-value",
        );
        let env_path = account_env_path_at(&env_root, USER_A, "sample");
        fs::create_dir_all(env_path.parent().expect("account env parent"))
            .expect("create account env");
        fs::write(&env_path, "API_KEY=override-test-value\n").expect("write test value");
        fs::set_permissions(&env_path, fs::Permissions::from_mode(0o600))
            .expect("private env file");
        assert_eq!(
            personal_team_value_at(&managed, &env_root, USER_A, "sample", "API_KEY")
                .expect("override wins"),
            "override-test-value",
        );
        // Undeclared key, other account, invalid name or empty value: refused.
        assert!(personal_team_value_at(&managed, &env_root, USER_A, "sample", "OTHER").is_err());
        assert!(personal_team_value_at(&managed, &env_root, USER_B, "sample", "API_KEY").is_err());
        assert!(personal_team_value_at(&managed, &env_root, USER_A, "sample", "bad key").is_err());
        fs::write(&env_path, "API_KEY=\n").expect("replace with empty test value");
        assert!(personal_team_value_at(&managed, &env_root, USER_A, "sample", "API_KEY").is_err());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    fn write_cli_source_at(path: &std::path::Path, version: &str) {
        fs::create_dir_all(path.parent().expect("CLI source parent"))
            .expect("create CLI source parent");
        fs::write(
            path,
            format!(
                "#!/bin/sh\nif [ \"${{1:-}}\" = \"--version\" ]; then\n  echo 'skillhub {version}'\n  exit 0\nfi\nexit 2\n"
            ),
        )
        .expect("write CLI source");
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))
            .expect("make CLI source executable");
    }

    fn legacy_executable_fixture() -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::path::PathBuf::from("/tmp")
            .join(format!("skillhub-legacy-cli-{}", uuid::Uuid::new_v4()));
        let executable = root.join("一探 SkillHub.app/Contents/MacOS/yitan-skillhub");
        fs::create_dir_all(executable.parent().expect("legacy executable parent"))
            .expect("create legacy app fixture");
        fs::write(&executable, "#!/bin/sh\nexit 0\n").expect("write legacy executable");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
            .expect("make legacy executable");
        (root, executable)
    }

    #[test]
    fn shell_output_quote_is_safe_for_single_quotes_and_newlines() {
        assert_eq!(shell_quote("a'b\nc"), "'a'\\''b\nc'");
    }

    #[test]
    fn runtime_session_is_private() {
        let root = fixture();
        write_session_at(&root, "header.payload.signature", USER_A).expect("write session");
        let mode = fs::metadata(session_path_at(&root))
            .expect("session metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn legacy_authenticated_session_json_remains_readable() {
        let root = fixture();
        let path = session_path_at(&root);
        fs::create_dir_all(path.parent().expect("runtime parent")).expect("create runtime dir");
        fs::set_permissions(
            path.parent().expect("runtime parent"),
            fs::Permissions::from_mode(0o700),
        )
        .expect("make runtime dir private");
        fs::write(
            &path,
            format!(
                r#"{{"version":1,"userId":"{USER_A}","authToken":"header.payload.signature"}}"#
            ),
        )
        .expect("write legacy session JSON");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .expect("make legacy session private");

        let session = read_session_at(&root).expect("read legacy session");
        assert_eq!(session.user_id, USER_A);
        assert_eq!(
            session.auth_token.as_deref(),
            Some("header.payload.signature")
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn logout_reuses_a_private_stable_guest_identity() {
        let root = fixture();
        write_session_at(&root, "header.payload.signature", USER_A).expect("write session");

        clear_runtime_session_at(&root).expect("activate first guest session");
        let first = read_session_at(&root).expect("read first guest session");
        assert!(first.auth_token.is_none());
        assert_ne!(first.user_id, USER_A);
        uuid::Uuid::parse_str(&first.user_id).expect("guest identity is a UUID");

        clear_runtime_session_at(&root).expect("reactivate guest session");
        let second = read_session_at(&root).expect("read second guest session");
        assert_eq!(second.user_id, first.user_id);
        assert!(second.auth_token.is_none());
        for path in [session_path_at(&root), guest_identity_path_at(&root)] {
            let mode = fs::metadata(path)
                .expect("guest identity metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn login_copies_guest_personal_state_without_overwriting_account_values() {
        let root = fixture();
        let managed = root.join("skills");
        clear_runtime_session_at(&root).expect("activate guest session");
        let guest = read_session_at(&root).expect("read guest session");
        let guest_env_root = root.join("envs").join(&guest.user_id);
        fs::create_dir_all(&guest_env_root).expect("create guest env root");
        fs::set_permissions(&guest_env_root, fs::Permissions::from_mode(0o700))
            .expect("make guest env root private");
        let guest_env = guest_env_root.join("sample.env");
        fs::write(&guest_env, "API_KEY=guest-secret\n").expect("write guest env");
        fs::set_permissions(&guest_env, fs::Permissions::from_mode(0o600))
            .expect("make guest env private");

        let account_env_root = root.join("envs").join(USER_A);
        fs::create_dir_all(&account_env_root).expect("create account env root");
        fs::set_permissions(&account_env_root, fs::Permissions::from_mode(0o700))
            .expect("make account env root private");
        let existing_account_env = account_env_root.join("existing.env");
        fs::write(
            &existing_account_env,
            "TOKEN=account-secret\nOPENAI_API_KEY=account-openai\n",
        )
        .expect("write existing account env");
        fs::set_permissions(&existing_account_env, fs::Permissions::from_mode(0o600))
            .expect("make existing account env private");
        let guest_existing_env = guest_env_root.join("existing.env");
        fs::write(
            &guest_existing_env,
            "TOKEN=guest-must-not-overwrite\nOPENAI_API_KEY=guest-openai\nANTHROPIC_API_KEY=guest-anthropic\n",
        )
            .expect("write conflicting guest env");
        fs::set_permissions(&guest_existing_env, fs::Permissions::from_mode(0o600))
            .expect("make conflicting guest env private");

        let mut guest_policy = AccountSourcePolicy {
            version: RUNTIME_STORE_VERSION,
            ..Default::default()
        };
        guest_policy
            .skills
            .entry("sample".into())
            .or_default()
            .insert("API_KEY".into(), SkillEnvSource::Personal);
        let guest_existing_sources = guest_policy.skills.entry("existing".into()).or_default();
        guest_existing_sources.insert("OPENAI_API_KEY".into(), SkillEnvSource::Personal);
        guest_existing_sources.insert("ANTHROPIC_API_KEY".into(), SkillEnvSource::Personal);
        write_policy_at(&root, &guest.user_id, &guest_policy).expect("write guest policy");

        let mut account_policy = AccountSourcePolicy {
            version: RUNTIME_STORE_VERSION,
            ..Default::default()
        };
        account_policy
            .skills
            .entry("existing".into())
            .or_default()
            .insert(
                "OPENAI_API_KEY".into(),
                SkillEnvSource::Team {
                    team_id: USER_B.into(),
                },
            );
        write_policy_at(&root, USER_A, &account_policy).expect("write account policy");

        sync_runtime_session_at(&root, &managed, "header.payload.signature", USER_A)
            .expect("login and carry guest state forward");
        let authenticated = read_session_at(&root).expect("read authenticated session");
        assert_eq!(authenticated.user_id, USER_A);
        assert_eq!(
            fs::read_to_string(account_env_root.join("sample.env")).expect("read copied guest env"),
            "API_KEY=guest-secret\n"
        );
        assert_eq!(
            fs::metadata(account_env_root.join("sample.env"))
                .expect("read copied guest env metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::read_to_string(existing_account_env).expect("read preserved account env"),
            "TOKEN=account-secret\nOPENAI_API_KEY=account-openai\nexport ANTHROPIC_API_KEY='guest-anthropic'\n"
        );
        assert_eq!(
            read_policy_at(&root, USER_A)
                .expect("read copied account policy")
                .skills
                .get("sample")
                .and_then(|sources| sources.get("API_KEY")),
            Some(&SkillEnvSource::Personal)
        );
        let merged_policy = read_policy_at(&root, USER_A).expect("read merged account policy");
        let existing_sources = merged_policy
            .skills
            .get("existing")
            .expect("read existing Skill policy");
        assert_eq!(
            existing_sources.get("OPENAI_API_KEY"),
            Some(&SkillEnvSource::Team {
                team_id: USER_B.into(),
            })
        );
        assert_eq!(
            existing_sources.get("ANTHROPIC_API_KEY"),
            Some(&SkillEnvSource::Personal)
        );

        // The helper is idempotent and keeps the same no-overwrite contract.
        copy_guest_runtime_state_at(&root, &guest.user_id, USER_A)
            .expect("repeat guest state copy");
        assert_eq!(
            fs::read_to_string(account_env_root.join("existing.env"))
                .expect("read idempotently merged account env"),
            "TOKEN=account-secret\nOPENAI_API_KEY=account-openai\nexport ANTHROPIC_API_KEY='guest-anthropic'\n"
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn guest_cli_resolves_personal_environment_without_login() {
        let root = fixture();
        let managed = root.join("skills");
        let env_root = root.join("envs");
        let skill = managed.join("sample");
        fs::create_dir_all(&skill).expect("create managed skill");
        fs::write(
            skill.join(".skillhub.json"),
            r#"{"version":"1","skillhub":{"id":"sample","name":"sample","envDependencies":[{"key":"API_KEY","required":true}]}}"#,
        )
        .expect("write profile");
        clear_runtime_session_at(&root).expect("activate guest session");
        let guest = read_session_at(&root).expect("read guest session");
        let env_path = account_env_path_at(&env_root, &guest.user_id, "sample");
        fs::create_dir_all(env_path.parent().expect("guest env parent"))
            .expect("create guest env dir");
        fs::write(&env_path, "API_KEY=guest-secret\n").expect("write guest env");
        fs::set_permissions(&env_path, fs::Permissions::from_mode(0o600))
            .expect("make guest env private");

        let environment = resolve_env_at(&root, &managed, &env_root, "sample")
            .await
            .expect("resolve guest personal environment");
        let code = environment
            .run(
                "/bin/sh",
                &["-c".into(), "test \"$API_KEY\" = guest-secret".into()],
            )
            .expect("run child with guest environment");
        assert_eq!(code, 0);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn run_without_declared_dependencies_spawns_and_injects_nothing() {
        let root = fixture();
        let managed = root.join("skills");
        let env_root = root.join("envs");
        let skill = managed.join("sample");
        fs::create_dir_all(&skill).expect("create managed skill");
        // A signed-in account and a Server asset: with nothing declared the
        // run must not need the Server at all.
        fs::write(
            skill.join(".skillhub.json"),
            r#"{"version":"1","skillhub":{"id":"sample","serverId":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","name":"sample","envDependencies":[]}}"#,
        )
        .expect("write profile");
        write_session_at(&root, "header.payload.signature", USER_A).expect("write session");
        let env_path = account_env_path_at(&env_root, USER_A, "sample");
        fs::create_dir_all(env_path.parent().expect("env parent")).expect("create env dir");
        fs::set_permissions(
            env_path.parent().expect("env parent"),
            fs::Permissions::from_mode(0o700),
        )
        .expect("make env dir private");
        fs::write(&env_path, "UNDECLARED_KEY=must-not-leak\n").expect("write env");
        fs::set_permissions(&env_path, fs::Permissions::from_mode(0o600))
            .expect("make env private");

        let environment = resolve_env_at(&root, &managed, &env_root, "sample")
            .await
            .expect("resolve empty environment");
        assert!(environment.values.is_empty());
        let code = environment
            .run(
                "/bin/sh",
                &["-c".into(), "test -z \"${UNDECLARED_KEY+x}\"".into()],
            )
            .expect("run child without declared dependencies");
        assert_eq!(code, 0);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn guest_cli_rejects_team_source_before_network_resolution() {
        let root = fixture();
        let managed = root.join("skills");
        let env_root = root.join("envs");
        let skill = managed.join("sample");
        fs::create_dir_all(&skill).expect("create managed skill");
        fs::write(
            skill.join(".skillhub.json"),
            r#"{"version":"1","skillhub":{"id":"sample","serverId":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","name":"sample","envDependencies":[{"key":"API_KEY","required":true}]}}"#,
        )
        .expect("write profile");
        clear_runtime_session_at(&root).expect("activate guest session");
        let guest = read_session_at(&root).expect("read guest session");
        let mut policy = AccountSourcePolicy {
            version: RUNTIME_STORE_VERSION,
            ..Default::default()
        };
        policy.skills.entry("sample".into()).or_default().insert(
            "API_KEY".into(),
            SkillEnvSource::Team {
                team_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into(),
            },
        );
        write_policy_at(&root, &guest.user_id, &policy).expect("write guest policy");

        let error = resolve_env_at(&root, &managed, &env_root, "sample")
            .await
            .err()
            .expect("guest team source must require login");
        assert!(error.contains("团队环境变量需要先"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn resolved_environment_holds_cross_process_shared_lease_through_spawn() {
        let root = fixture();
        write_session_at(&root, "header.payload.signature", USER_A).expect("write session");
        let session = read_session_at(&root).expect("read expected session");
        let environment = finalize_resolved_environment_at(
            &root,
            &session,
            BTreeMap::from([("API_KEY".into(), "resolved-secret".into())]),
        )
        .expect("create resolved environment lease");

        run_lock_probe(&root, "exclusive", false);
        assert_eq!(
            environment
                .run("/usr/bin/true", &[])
                .expect("spawn child process"),
            0
        );
        run_lock_probe(&root, "exclusive", true);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn environment_revalidation_rejects_account_switch_before_lease() {
        let root = fixture();
        write_session_at(&root, "header.payload.signature", USER_A).expect("write session A");
        let session_a = read_session_at(&root).expect("read session A");
        write_session_at(&root, "other.payload.signature", USER_B).expect("switch to session B");
        let error = finalize_resolved_environment_at(
            &root,
            &session_a,
            BTreeMap::from([("API_KEY".into(), "must-not-escape".into())]),
        )
        .err()
        .expect("account switch must reject child environment");
        assert!(error.contains("账号已切换"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn cli_parser_accepts_direct_child_route_and_rejects_environment_dumping() {
        let accepted = ["run", "sample", "--", "tool", "--mode", "safe"].map(str::to_string);
        let parsed = parse_cli_run_command(&accepted).expect("direct child route");
        assert_eq!(parsed.skill_id, "sample");
        assert_eq!(parsed.program, "tool");
        assert_eq!(parsed.args, &["--mode".to_string(), "safe".to_string()]);
        for rejected in [
            vec!["run", "sample", "env"],
            vec!["run", "sample", "--", "env"],
            vec!["run", "sample", "--", "printenv"],
            vec!["run", "sample", "--", "/usr/bin/env"],
            vec!["run", "sample", "--", "sh", "-c", "env"],
            vec!["RUN", "sample", "--", "env"],
        ] {
            let rejected = rejected.into_iter().map(str::to_string).collect::<Vec<_>>();
            assert!(parse_cli_run_command(&rejected).is_err());
        }
    }

    #[test]
    fn source_policy_is_isolated_by_account() {
        let root = fixture();
        let mut policy = AccountSourcePolicy {
            version: RUNTIME_STORE_VERSION,
            ..Default::default()
        };
        policy.skills.entry("sample".into()).or_default().insert(
            "API_KEY".into(),
            SkillEnvSource::Team {
                team_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into(),
            },
        );
        write_policy_at(&root, USER_A, &policy).expect("write user A policy");
        assert!(policy_path_at(&root, USER_A).exists());
        assert!(!policy_path_at(&root, USER_B).exists());
        assert!(read_policy_at(&root, USER_B)
            .expect("read empty user B policy")
            .skills
            .is_empty());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn personal_is_default_but_explicit_team_never_falls_back() {
        let dependencies = vec![RuntimeDependency {
            key: "API_KEY".into(),
            description: None,
            required: true,
        }];
        let personal = BTreeMap::from([("API_KEY".into(), "personal".into())]);
        let (values, team) = select_sources(
            &dependencies,
            &personal,
            &BTreeMap::new(),
            &TeamCandidates::new(),
        )
        .expect("default personal");
        assert_eq!(values.get("API_KEY").map(String::as_str), Some("personal"));
        assert!(team.is_empty());

        let selected = BTreeMap::from([(
            "API_KEY".into(),
            SkillEnvSource::Team {
                team_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into(),
            },
        )]);
        let (values, team) =
            select_sources(&dependencies, &personal, &selected, &TeamCandidates::new())
                .expect("explicit team source");
        assert!(values.is_empty());
        assert_eq!(team.len(), 1);
    }

    #[test]
    fn missing_explicit_personal_or_unselected_required_value_fails() {
        let dependencies = vec![RuntimeDependency {
            key: "API_KEY".into(),
            description: None,
            required: true,
        }];
        let empty = BTreeMap::new();
        let personal = BTreeMap::from([("API_KEY".into(), SkillEnvSource::Personal)]);
        assert!(
            select_sources(&dependencies, &empty, &personal, &TeamCandidates::new())
                .expect_err("missing explicit personal")
                .contains("本机值已不存在")
        );
        assert!(select_sources(
            &dependencies,
            &empty,
            &BTreeMap::new(),
            &TeamCandidates::new()
        )
        .expect_err("unconfigured required value")
        .contains("需要填写"));
    }

    const TEAM_ONE: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const TEAM_TWO: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    fn team_source(key: &str, team_id: &str, revision: u32) -> RuntimeTeamSource {
        RuntimeTeamSource {
            key: key.into(),
            team_id: team_id.into(),
            team_name: format!("team {team_id}"),
            revision,
        }
    }

    fn dependency(key: &str, required: bool) -> RuntimeDependency {
        RuntimeDependency {
            key: key.into(),
            description: None,
            required,
        }
    }

    /// Resolution order matrix (#252): personal only / team only / two teams /
    /// personal + team / explicit team revoked / optional key.
    #[test]
    fn resolution_order_matrix_for_runs() {
        let required = vec![dependency("API_KEY", true)];
        let no_personal = BTreeMap::new();
        let personal = BTreeMap::from([("API_KEY".to_string(), "personal".to_string())]);
        let no_policy = BTreeMap::new();
        let one_team = team_candidates(&[team_source("API_KEY", TEAM_ONE, 2)]);
        let two_teams = team_candidates(&[
            team_source("API_KEY", TEAM_ONE, 2),
            team_source("API_KEY", TEAM_TWO, 1),
        ]);

        // Personal only.
        let (values, team) =
            select_sources(&required, &personal, &no_policy, &TeamCandidates::new())
                .expect("personal only");
        assert_eq!(values.get("API_KEY").map(String::as_str), Some("personal"));
        assert!(team.is_empty());

        // Team only: the single available team is used automatically.
        let (values, team) =
            select_sources(&required, &no_personal, &no_policy, &one_team).expect("team only");
        assert!(values.is_empty());
        assert_eq!(
            team,
            vec![RuntimeTeamSelection {
                key: "API_KEY".into(),
                team_id: TEAM_ONE.into(),
                automatic: true,
            }]
        );
        // The automatic marker never reaches the Server request.
        let request = serde_json::to_value(&team[0]).expect("serialize selection");
        assert_eq!(
            request,
            serde_json::json!({"key": "API_KEY", "teamId": TEAM_ONE})
        );

        // A revision-0 binding is not an available value.
        let unpublished = team_candidates(&[team_source("API_KEY", TEAM_ONE, 0)]);
        assert!(
            select_sources(&required, &no_personal, &no_policy, &unpublished)
                .expect_err("unpublished team")
                .contains("需要填写")
        );

        // Two teams: the user must choose once.
        assert_eq!(
            select_sources(&required, &no_personal, &no_policy, &two_teams)
                .expect_err("ambiguous teams"),
            "NEEDS_CHOICE: API_KEY 有多个来源可选，请在 SkillHub APP 中选择用哪把钥匙"
        );

        // Personal + team: personal wins.
        let (values, team) =
            select_sources(&required, &personal, &no_policy, &two_teams).expect("personal first");
        assert_eq!(values.get("API_KEY").map(String::as_str), Some("personal"));
        assert!(team.is_empty());

        // Explicit team that is no longer available: still requested from the
        // Server (which then reports it unavailable), never personal fallback.
        let explicit = BTreeMap::from([(
            "API_KEY".to_string(),
            SkillEnvSource::Team {
                team_id: TEAM_TWO.into(),
            },
        )]);
        let (values, team) = select_sources(&required, &personal, &explicit, &one_team)
            .expect("explicit team stays explicit");
        assert!(values.is_empty());
        assert_eq!(
            team,
            vec![RuntimeTeamSelection {
                key: "API_KEY".into(),
                team_id: TEAM_TWO.into(),
                automatic: false,
            }]
        );

        // Optional key: never blocks, auto-uses a single team, skips when
        // ambiguous or absent.
        let optional = vec![dependency("API_KEY", false)];
        let (values, team) =
            select_sources(&optional, &no_personal, &no_policy, &TeamCandidates::new())
                .expect("optional absent");
        assert!(values.is_empty() && team.is_empty());
        let (values, team) = select_sources(&optional, &no_personal, &no_policy, &two_teams)
            .expect("optional ambiguous");
        assert!(values.is_empty() && team.is_empty());
        let (_, team) = select_sources(&optional, &no_personal, &no_policy, &one_team)
            .expect("optional single team");
        assert_eq!(team.len(), 1);
        assert!(team[0].automatic);

        // A Skill with no declared dependencies resolves to nothing at all.
        let (values, team) = select_sources(&[], &personal, &no_policy, &two_teams)
            .expect("no declared dependencies");
        assert!(values.is_empty() && team.is_empty());
    }

    #[test]
    fn resolution_order_matrix_for_badges() {
        let personal = BTreeMap::from([("API_KEY".to_string(), "personal".to_string())]);
        let no_personal = BTreeMap::new();
        let one = vec![team_source("API_KEY", TEAM_ONE, 2)];
        let two = vec![
            team_source("API_KEY", TEAM_ONE, 2),
            team_source("API_KEY", TEAM_TWO, 1),
        ];
        let row = |required: bool,
                   personal: &BTreeMap<String, String>,
                   policy: Option<&BTreeMap<String, SkillEnvSource>>,
                   sources: &[RuntimeTeamSource]| {
            source_policy_rows(
                vec![dependency("API_KEY", required)],
                personal,
                policy,
                sources,
            )
            .remove(0)
        };

        let personal_only = row(true, &personal, None, &[]);
        assert!(personal_only.valid);
        assert_eq!(personal_only.state, SkillEnvRowState::Ready);
        assert_eq!(personal_only.effective, Some(SkillEnvSource::Personal));

        let team_only = row(true, &no_personal, None, &one);
        assert!(team_only.valid);
        assert_eq!(team_only.state, SkillEnvRowState::Ready);
        assert_eq!(
            team_only.effective,
            Some(SkillEnvSource::Team {
                team_id: TEAM_ONE.into()
            })
        );

        let two_teams = row(true, &no_personal, None, &two);
        assert!(!two_teams.valid);
        assert_eq!(two_teams.state, SkillEnvRowState::NeedsChoice);
        assert_eq!(two_teams.effective, None);

        let both = row(true, &personal, None, &two);
        assert!(both.valid);
        assert_eq!(both.effective, Some(SkillEnvSource::Personal));

        let nothing = row(true, &no_personal, None, &[]);
        assert!(!nothing.valid);
        assert_eq!(nothing.state, SkillEnvRowState::NeedsValue);

        let revoked_policy = BTreeMap::from([(
            "API_KEY".to_string(),
            SkillEnvSource::Team {
                team_id: TEAM_TWO.into(),
            },
        )]);
        let revoked = row(true, &personal, Some(&revoked_policy), &one);
        assert!(!revoked.valid, "explicit revoked team must not fall back");
        assert_eq!(revoked.effective, None);
        assert_eq!(revoked.state, SkillEnvRowState::NeedsChoice);
        assert!(revoked.options.iter().any(|option| matches!(
            option,
            SkillEnvSourceOption::Team { team_id, available: false, .. } if team_id == TEAM_TWO
        )));
        let revoked_alone = row(true, &no_personal, Some(&revoked_policy), &[]);
        assert!(!revoked_alone.valid);
        assert_eq!(revoked_alone.state, SkillEnvRowState::NeedsValue);

        let optional = row(false, &no_personal, None, &[]);
        assert!(optional.valid);
        assert_eq!(optional.state, SkillEnvRowState::NeedsValue);
        let optional_ambiguous = row(false, &no_personal, None, &two);
        assert!(optional_ambiguous.valid);
        assert_eq!(optional_ambiguous.state, SkillEnvRowState::NeedsChoice);

        let serialized = serde_json::to_value(&two_teams).expect("serialize row");
        assert_eq!(serialized["state"], "needs_choice");
        assert!(serialized["effective"].is_null());
    }

    #[test]
    fn personal_env_paths_are_account_scoped() {
        let root = fixture();
        let first = account_env_path_at(&root, USER_A, "sample");
        let second = account_env_path_at(&root, USER_B, "sample");
        assert_ne!(first, second);
        assert_eq!(first, root.join(USER_A).join("sample.env"));
        assert_eq!(second, root.join(USER_B).join("sample.env"));
    }

    #[test]
    fn legacy_env_waits_for_its_declared_owner() {
        let root = fixture();
        let managed = root.join("skills");
        let skill = managed.join("sample");
        fs::create_dir_all(root.join("envs")).expect("create env root");
        fs::create_dir_all(&skill).expect("create skill");
        fs::write(
            skill.join(".skillhub.json"),
            format!(
                "{{\"version\":\"1\",\"skillhub\":{{\"serverOwnerId\":\"{USER_A}\",\"isOwn\":true}}}}"
            ),
        )
        .expect("write profile");
        let legacy = root.join("envs/sample.env");
        fs::write(&legacy, "API_KEY=owner-a\n").expect("write legacy value");
        fs::set_permissions(&legacy, fs::Permissions::from_mode(0o600)).expect("set legacy mode");

        migrate_owned_legacy_env_files(&root, &managed, USER_B)
            .expect("user B migration must not claim A value");
        assert!(legacy.exists());
        assert!(!account_env_path_at(&root.join("envs"), USER_B, "sample").exists());

        migrate_owned_legacy_env_files(&root, &managed, USER_A)
            .expect("declared owner migrates value");
        assert!(!legacy.exists());
        assert_eq!(
            fs::read_to_string(account_env_path_at(&root.join("envs"), USER_A, "sample"))
                .expect("read migrated value"),
            "API_KEY=owner-a\n"
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn cli_installer_never_replaces_an_existing_symlink() {
        let home = fixture();
        fs::create_dir_all(home.join(".local/bin")).expect("create bin");
        let source = home.join("source/skillhub");
        write_cli_source_at(&source, env!("CARGO_PKG_VERSION"));
        let occupied = home.join("other-skillhub");
        fs::write(&occupied, "other").expect("write occupied target");
        let shim = home.join(".local/bin/skillhub");
        symlink(&occupied, &shim).expect("create occupied symlink");

        let error =
            install_cli_shim_at(&home, &source).expect_err("existing symlink must be preserved");
        assert!(error.contains("无法证明归属"));
        assert_eq!(
            fs::read_link(&shim).expect("read unchanged symlink"),
            occupied
        );
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn cli_installer_preserves_foreign_public_alias_file() {
        let home = fixture();
        fs::create_dir_all(home.join(".local/bin")).expect("create bin");
        let source = home.join("source/skillhub");
        write_cli_source_at(&source, env!("CARGO_PKG_VERSION"));
        let alias = home.join(".local/bin/skillhub");
        fs::write(&alias, "#!/bin/sh\necho foreign\n").expect("write foreign alias");
        install_cli_shim_at(&home, &source).expect_err("foreign public alias must fail closed");
        assert_eq!(
            fs::read_to_string(&alias).expect("read preserved alias"),
            "#!/bin/sh\necho foreign\n"
        );
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn cli_installer_migrates_exact_broken_legacy_symlink_for_upgrade() {
        let home = fixture();
        fs::create_dir_all(home.join(".local/bin")).expect("create bin");
        let source = home.join("source/skillhub");
        write_cli_source_at(&source, env!("CARGO_PKG_VERSION"));
        let legacy_target = std::path::PathBuf::from(
            "/Users/legacy/old-build/一探 SkillHub.app/Contents/MacOS/yitan-skillhub",
        );
        let shim = home.join(".local/bin/skillhub");
        symlink(&legacy_target, &shim).expect("create exact legacy symlink");

        install_cli_shim_at(&home, &source)
            .expect("an exact legacy SkillHub link should migrate even after its old build moved");
        assert!(fs::symlink_metadata(&shim)
            .expect("read migrated alias")
            .is_file());
        assert!(fs::read_to_string(&shim)
            .expect("read public alias")
            .contains("$HOME/.skillhub/runtime/bin/yitan-skillhub-runtime"));
        let recovery_targets = fs::read_dir(shim.parent().expect("alias parent"))
            .expect("read public bin")
            .flatten()
            .filter_map(|entry| fs::read_link(entry.path()).ok())
            .collect::<Vec<_>>();
        assert_eq!(recovery_targets, vec![legacy_target]);
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn cli_installer_migrates_legacy_links_from_transient_app_locations() {
        for legacy_target in [
            "/Volumes/SkillHub/一探 SkillHub.app/Contents/MacOS/yitan-skillhub",
            "/private/var/folders/example/AppTranslocation/一探 SkillHub.app/Contents/MacOS/yitan-skillhub",
        ] {
            let home = fixture();
            fs::create_dir_all(home.join(".local/bin")).expect("create bin");
            let source = home.join("source/skillhub");
            write_cli_source_at(&source, env!("CARGO_PKG_VERSION"));
            let shim = home.join(".local/bin/skillhub");
            symlink(legacy_target, &shim).expect("create transient legacy symlink");

            install_cli_shim_at(&home, &source)
                .expect("transient first-party legacy link should migrate");
            assert!(fs::symlink_metadata(&shim)
                .expect("read migrated alias")
                .is_file());
            assert!(fs::read_to_string(&shim)
                .expect("read public alias")
                .contains("$HOME/.skillhub/runtime/bin/yitan-skillhub-runtime"));
            let recovery_targets = fs::read_dir(shim.parent().expect("alias parent"))
                .expect("read public bin")
                .flatten()
                .filter_map(|entry| fs::read_link(entry.path()).ok())
                .collect::<Vec<_>>();
            assert_eq!(
                recovery_targets,
                vec![std::path::PathBuf::from(legacy_target)]
            );
            fs::remove_dir_all(home).expect("remove fixture");
        }
    }

    #[test]
    fn cli_installer_migrates_only_proven_executable_legacy_symlink() {
        let home = fixture();
        let (legacy_root, legacy_target) = legacy_executable_fixture();
        fs::create_dir_all(home.join(".local/bin")).expect("create bin");
        let source = home.join("source/skillhub");
        write_cli_source_at(&source, env!("CARGO_PKG_VERSION"));
        let alias = home.join(".local/bin/skillhub");
        symlink(&legacy_target, &alias).expect("create proven legacy link");

        install_cli_shim_at(&home, &source).expect("migrate proven legacy link");
        let metadata = fs::symlink_metadata(&alias).expect("read migrated alias");
        assert!(metadata.is_file());
        assert!(!metadata.file_type().is_symlink());
        assert!(fs::read_to_string(&alias)
            .expect("read public alias")
            .contains("$HOME/.skillhub/runtime/bin/yitan-skillhub-runtime"));
        let recovery_targets = fs::read_dir(alias.parent().expect("alias parent"))
            .expect("read public bin")
            .flatten()
            .filter_map(|entry| fs::read_link(entry.path()).ok())
            .collect::<Vec<_>>();
        assert_eq!(recovery_targets, vec![legacy_target]);
        fs::remove_dir_all(home).expect("remove fixture");
        fs::remove_dir_all(legacy_root).expect("remove legacy fixture");
    }

    #[test]
    fn legacy_migration_race_preserves_public_intruder_and_old_link() {
        let home = fixture();
        let (legacy_root, legacy_target) = legacy_executable_fixture();
        fs::create_dir_all(home.join(".local/bin")).expect("create bin");
        let source = home.join("source/skillhub");
        write_cli_source_at(&source, env!("CARGO_PKG_VERSION"));
        let alias = home.join(".local/bin/skillhub");
        symlink(&legacy_target, &alias).expect("create proven legacy link");
        let alias_for_race = alias.clone();

        let error = install_cli_shim_at_with_public_hook(&home, &source, move || {
            fs::write(&alias_for_race, "concurrent foreign alias\n")
                .expect("install concurrent foreign alias");
        })
        .expect_err("concurrent public alias must stop migration");
        assert!(error.contains("待恢复项目位于"));
        assert_eq!(
            fs::read_to_string(&alias).expect("read preserved intruder"),
            "concurrent foreign alias\n"
        );
        let recovery_targets = fs::read_dir(alias.parent().expect("alias parent"))
            .expect("read public bin")
            .flatten()
            .filter_map(|entry| fs::read_link(entry.path()).ok())
            .collect::<Vec<_>>();
        assert_eq!(recovery_targets, vec![legacy_target]);
        fs::remove_dir_all(home).expect("remove fixture");
        fs::remove_dir_all(legacy_root).expect("remove legacy fixture");
    }

    #[test]
    fn cli_payload_upgrade_keeps_recovery_while_launchers_stay_path_independent() {
        let home = fixture();
        fs::create_dir_all(&home).expect("create home");
        let old_source =
            home.join("Volumes/Old SkillHub/一探 SkillHub.app/Contents/MacOS/skillhub");
        let new_source = home.join(
            "private/var/folders/example/AppTranslocation/New SkillHub.app/Contents/MacOS/skillhub",
        );
        write_cli_source_at(&old_source, "0.5.0");
        write_cli_source_at(&new_source, "0.6.0");
        let old_bytes = fs::read(&old_source).expect("read old source");
        install_cli_shim_at(&home, &old_source).expect("install first payload");
        let public_alias = home.join(".local/bin/skillhub");
        let private_bin = home.join(".skillhub/runtime/bin");
        let private_launcher = private_bin.join(PRIVATE_CLI_LAUNCHER_NAME);
        let payload = private_bin.join(PRIVATE_CLI_PAYLOAD_NAME);
        let public_before = fs::read_to_string(&public_alias).expect("read public alias");
        let private_before = fs::read_to_string(&private_launcher).expect("read private launcher");
        assert!(public_before.contains("$HOME/.skillhub/runtime/bin/yitan-skillhub-runtime"));
        assert!(private_before.contains("$HOME/.skillhub/runtime/bin/yitan-skillhub-cli"));
        assert!(!private_before.contains(&old_source.display().to_string()));
        assert!(!private_before.contains(&new_source.display().to_string()));

        install_cli_shim_at(&home, &new_source).expect("install updated payload");
        assert_eq!(
            fs::read_to_string(&public_alias).expect("read stable public alias"),
            public_before
        );
        assert_eq!(
            fs::read_to_string(&private_launcher).expect("read stable private launcher"),
            private_before
        );
        let output = Command::new(&payload)
            .arg("--version")
            .output()
            .expect("run updated payload");
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "skillhub 0.6.0"
        );
        let recoveries = fs::read_dir(&private_bin)
            .expect("read private bin")
            .flatten()
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with(".yitan-skillhub-cli.") && name.ends_with(".recovery")
            })
            .map(|entry| fs::read(entry.path()).expect("read payload recovery"))
            .collect::<Vec<_>>();
        assert_eq!(recoveries, vec![old_bytes]);
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn private_launcher_collision_is_preserved() {
        let home = fixture();
        fs::create_dir_all(home.join(".skillhub/runtime/bin")).expect("create private bin");
        let source = home.join("source/skillhub");
        write_cli_source_at(&source, env!("CARGO_PKG_VERSION"));
        let launcher = home
            .join(".skillhub/runtime/bin")
            .join(PRIVATE_CLI_LAUNCHER_NAME);
        fs::write(&launcher, "foreign launcher\n").expect("write foreign launcher");
        let error = install_cli_shim_at(&home, &source)
            .expect_err("private launcher collision must fail closed");
        assert!(error.contains("不属于 SkillHub"));
        assert_eq!(
            fs::read_to_string(&launcher).expect("read preserved launcher"),
            "foreign launcher\n"
        );
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn public_alias_concurrent_change_is_restored_and_preserved() {
        let home = fixture();
        fs::create_dir_all(home.join(".local/bin")).expect("create public bin");
        let alias = home.join(".local/bin/skillhub");
        fs::write(
            &alias,
            format!("#!/bin/sh\n{PUBLIC_CLI_ALIAS_MARKER}\nexec old \"$@\"\n"),
        )
        .expect("write managed alias");
        fs::set_permissions(&alias, fs::Permissions::from_mode(0o700)).expect("set alias mode");
        let alias_for_race = alias.clone();
        let error = install_managed_script_with_hook(
            &alias,
            &format!("#!/bin/sh\n{PUBLIC_CLI_ALIAS_MARKER}\nexec new \"$@\"\n"),
            PUBLIC_CLI_ALIAS_MARKER,
            "test public alias",
            move || {
                fs::write(&alias_for_race, "concurrent user replacement\n")
                    .expect("simulate concurrent replacement");
            },
        )
        .expect_err("concurrent alias change must abort");
        assert!(error.contains("并发变化"));
        assert_eq!(
            fs::read_to_string(&alias).expect("read preserved concurrent alias"),
            "concurrent user replacement\n"
        );
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn cli_source_validation_allows_volume_and_app_translocation_paths() {
        for executable in [
            "/Volumes/SkillHub/一探 SkillHub.app/Contents/MacOS/skillhub",
            "/private/var/folders/example/AppTranslocation/一探 SkillHub.app/Contents/MacOS/skillhub",
        ] {
            validate_absolute_cli_path(std::path::Path::new(executable))
                .expect("temporary location is allowed as a copy source");
        }
    }

    #[test]
    fn cli_installed_from_dmg_survives_source_removal_and_healthy_fallback() {
        let home = fixture();
        fs::create_dir_all(&home).expect("create home");
        let source = home.join("Volumes/SkillHub/一探 SkillHub.app/Contents/MacOS/skillhub");
        write_cli_source_at(&source, env!("CARGO_PKG_VERSION"));
        let installed = install_and_probe_cli_at(&home, &source, env!("CARGO_PKG_VERSION"))
            .expect("install and verify CLI from DMG source");
        let private_launcher = home
            .join(".skillhub/runtime/bin")
            .join(PRIVATE_CLI_LAUNCHER_NAME);
        for launcher in [&installed, &private_launcher] {
            let contents = fs::read_to_string(launcher).expect("read stable launcher");
            assert!(!contents.contains(source.to_string_lossy().as_ref()));
        }
        fs::remove_file(&source).expect("remove transient source");

        for command in [&installed, &private_launcher] {
            let output = Command::new(command)
                .arg("--version")
                .env("HOME", &home)
                .output()
                .expect("run copied CLI after source removal");
            assert!(
                output.status.success(),
                "{}: {}",
                command.display(),
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                String::from_utf8_lossy(&output.stdout).trim(),
                format!("skillhub {}", env!("CARGO_PKG_VERSION"))
            );
        }
        assert_eq!(
            install_and_probe_cli_at(&home, &source, env!("CARGO_PKG_VERSION"))
                .expect("healthy installed CLI must survive a failed refresh"),
            installed
        );
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn legacy_private_launcher_is_never_executed_as_a_managed_fallback() {
        let home = fixture();
        let private_bin = home.join(".skillhub/runtime/bin");
        let public_bin = home.join(".local/bin");
        fs::create_dir_all(&private_bin).expect("create private bin");
        fs::create_dir_all(&public_bin).expect("create public bin");
        let legacy_target = home.join("installed-app/skillhub");
        write_cli_source_at(&legacy_target, env!("CARGO_PKG_VERSION"));
        let private_launcher = private_bin.join(PRIVATE_CLI_LAUNCHER_NAME);
        fs::write(
            &private_launcher,
            format!(
                "#!/bin/sh\n{PRIVATE_CLI_LAUNCHER_MARKER}\nSKILLHUB_CLI=1 exec {} \"$@\"\n",
                shell_quote(legacy_target.to_string_lossy().as_ref())
            ),
        )
        .expect("write legacy private launcher");
        fs::set_permissions(&private_launcher, fs::Permissions::from_mode(0o700))
            .expect("make legacy private launcher executable");
        let public_alias = public_bin.join("skillhub");
        fs::write(
            &public_alias,
            format!(
                "#!/bin/sh\n{PUBLIC_CLI_ALIAS_MARKER}\nexec \"$HOME/.skillhub/runtime/bin/{PRIVATE_CLI_LAUNCHER_NAME}\" \"$@\"\n"
            ),
        )
        .expect("write public alias");
        fs::set_permissions(&public_alias, fs::Permissions::from_mode(0o700))
            .expect("make public alias executable");

        let missing_source = home.join("missing/AppTranslocation/skillhub");
        let error = install_and_probe_cli_at(&home, &missing_source, env!("CARGO_PKG_VERSION"))
            .expect_err("legacy launcher without an owned payload must not execute");
        assert!(error.contains("稳定副本"));
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn tampered_cli_payload_is_rejected_without_executing_version_probe() {
        let home = fixture();
        fs::create_dir_all(&home).expect("create home");
        let source = home.join("source/skillhub");
        write_cli_source_at(&source, env!("CARGO_PKG_VERSION"));
        install_cli_shim_at(&home, &source).expect("install owned payload");
        let payload = home
            .join(".skillhub/runtime/bin")
            .join(PRIVATE_CLI_PAYLOAD_NAME);
        let executed = home.join("tampered-payload-executed");
        fs::write(
            &payload,
            format!(
                "#!/bin/sh\ntouch {}\nprintf 'skillhub {}\\n'\n",
                shell_quote(executed.to_string_lossy().as_ref()),
                env!("CARGO_PKG_VERSION")
            ),
        )
        .expect("tamper payload");
        fs::set_permissions(&payload, fs::Permissions::from_mode(0o700))
            .expect("make tampered payload executable");

        let error = install_and_probe_cli_at(&home, &source, env!("CARGO_PKG_VERSION"))
            .expect_err("unowned payload bytes must fail before execution");
        assert!(error.contains("无法证明由 SkillHub 管理") || error.contains("无法验证"));
        assert!(!executed.exists());
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn cli_payload_install_is_idempotent() {
        let home = fixture();
        fs::create_dir_all(&home).expect("create home");
        let source = home.join("source/skillhub");
        write_cli_source_at(&source, env!("CARGO_PKG_VERSION"));
        install_cli_shim_at(&home, &source).expect("first CLI install");
        install_cli_shim_at(&home, &source).expect("idempotent CLI install");
        let private_bin = home.join(".skillhub/runtime/bin");
        let payload_recoveries = fs::read_dir(&private_bin)
            .expect("read private bin")
            .flatten()
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with(".yitan-skillhub-cli.") && name.ends_with(".recovery")
            })
            .count();
        assert_eq!(payload_recoveries, 0);
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn cli_health_check_uses_installed_version_output() {
        let home = fixture();
        fs::create_dir_all(&home).expect("create home");
        let source = home.join("source/skillhub");
        write_cli_source_at(&source, "0.5.0");
        let error = install_and_probe_cli_at(&home, &source, "0.6.0")
            .expect_err("wrong installed CLI version must not be ready");
        assert!(error.contains("预期 skillhub 0.6.0，实际 skillhub 0.5.0"));
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn cli_payload_collision_without_ownership_is_preserved() {
        let home = fixture();
        let private_bin = home.join(".skillhub/runtime/bin");
        fs::create_dir_all(&private_bin).expect("create private bin");
        let payload = private_bin.join(PRIVATE_CLI_PAYLOAD_NAME);
        fs::write(&payload, "foreign payload\n").expect("write foreign payload");
        fs::set_permissions(&payload, fs::Permissions::from_mode(0o700))
            .expect("make foreign payload executable");
        let source = home.join("source/skillhub");
        write_cli_source_at(&source, env!("CARGO_PKG_VERSION"));

        let error = install_cli_shim_at(&home, &source)
            .expect_err("unowned private payload must be preserved");
        assert!(error.contains("无法证明由 SkillHub 管理"));
        assert_eq!(
            fs::read_to_string(&payload).expect("read preserved payload"),
            "foreign payload\n"
        );
        assert!(!private_bin.join(PRIVATE_CLI_OWNERSHIP_NAME).exists());
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn zprofile_update_is_idempotent_and_preserves_user_content() {
        let home = fixture();
        fs::create_dir_all(&home).expect("create home");
        let profile = home.join(".zprofile");
        fs::write(&profile, "export USER_SETTING=1").expect("write profile");
        ensure_zsh_cli_path(&home).expect("first PATH integration");
        ensure_zsh_cli_path(&home).expect("idempotent PATH integration");
        let updated = fs::read_to_string(&profile).expect("read profile");
        assert!(updated.starts_with("export USER_SETTING=1\n"));
        assert_eq!(updated.matches("# >>> Yitan SkillHub CLI >>>").count(), 1);
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn zprofile_concurrent_change_is_restored_and_preserved() {
        let home = fixture();
        fs::create_dir_all(&home).expect("create home");
        let profile = home.join(".zprofile");
        fs::write(&profile, "export BEFORE=1\n").expect("write initial profile");
        let profile_for_race = profile.clone();
        let error = ensure_zsh_cli_path_with_hook(&home, move || {
            fs::write(&profile_for_race, "export USER_CHANGED=1\n")
                .expect("simulate concurrent profile edit");
        })
        .expect_err("concurrent profile edit must abort");
        assert!(error.contains("并发变化"));
        assert_eq!(
            fs::read_to_string(&profile).expect("read preserved profile"),
            "export USER_CHANGED=1\n"
        );
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn invalid_utf8_zprofile_fails_without_modification() {
        let home = fixture();
        fs::create_dir_all(&home).expect("create home");
        let profile = home.join(".zprofile");
        let original = [0xff, 0xfe, b'\n'];
        fs::write(&profile, original).expect("write invalid profile");
        let error = ensure_zsh_cli_path(&home).expect_err("invalid UTF-8 must fail closed");
        assert!(error.contains("不是 UTF-8"));
        assert_eq!(
            fs::read(&profile).expect("read unchanged profile"),
            original
        );
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn unreadable_zprofile_fails_without_modification() {
        let home = fixture();
        fs::create_dir_all(&home).expect("create home");
        let profile = home.join(".zprofile");
        fs::write(&profile, "keep-me\n").expect("write profile");
        fs::set_permissions(&profile, fs::Permissions::from_mode(0o000))
            .expect("remove read access");
        let error = ensure_zsh_cli_path(&home).expect_err("unreadable profile must fail closed");
        assert!(error.contains("不可读"));
        fs::set_permissions(&profile, fs::Permissions::from_mode(0o600))
            .expect("restore test permissions");
        assert_eq!(
            fs::read_to_string(&profile).expect("read unchanged profile"),
            "keep-me\n"
        );
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn clean_zsh_login_path_resolves_installed_cli() {
        let home = fixture();
        fs::create_dir_all(&home).expect("create home");
        let source = home.join("source/skillhub");
        write_cli_source_at(&source, env!("CARGO_PKG_VERSION"));
        install_cli_shim_at(&home, &source).expect("install shim");
        ensure_zsh_cli_path(&home).expect("install PATH block");
        let output = Command::new("/bin/zsh")
            .args(["-lc", "command -v skillhub"])
            .env_clear()
            .env("HOME", &home)
            .env("PATH", "/usr/bin:/bin")
            .output()
            .expect("run clean login shell");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8(output.stdout)
                .expect("UTF-8 command output")
                .trim(),
            home.join(".local/bin/skillhub").display().to_string()
        );
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn runtime_response_budget_covers_server_contract() {
        const SERVER_MAX_ENV_COUNT: usize = 100;
        const SERVER_MAX_VALUE_BYTES: usize = 65_536;
        const JSON_OVERHEAD_BUDGET: usize = 256 * 1024;
        const {
            assert!(
                MAX_RUNTIME_JSON_BYTES
                    >= SERVER_MAX_ENV_COUNT * SERVER_MAX_VALUE_BYTES + JSON_OVERHEAD_BUDGET
            );
        }
    }
}

#[cfg(test)]
mod import_attribution_tests {
    use super::{
        activate_guest_session_at, begin_runtime_session_transition_at,
        try_acquire_session_lock_at, write_session_at, ImportAttribution, SessionLockMode,
        IMPORT_ACCOUNT_CHANGED,
    };
    use std::fs;

    const USER_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const USER_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    fn fixture() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "skillhub-import-attribution-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create fixture");
        root
    }

    #[test]
    fn an_import_that_straddles_an_account_switch_is_not_committed() {
        let root = fixture();
        write_session_at(&root, "a.header.signature", USER_A).expect("sign in A");
        let attribution = ImportAttribution::begin_at(&root);
        assert_eq!(attribution.account_id(), Some(USER_A));
        // Switched to B while the import was still copying files.
        begin_runtime_session_transition_at(&root).expect("switch begins");
        write_session_at(&root, "b.header.signature", USER_B).expect("sign in B");
        assert_eq!(
            attribution.account_id(),
            Some(USER_A),
            "never re-read later"
        );
        assert_eq!(
            attribution.commit_at(&root).err().as_deref(),
            Some(IMPORT_ACCOUNT_CHANGED)
        );
        // Signed out in between: also not committed as A's import.
        let as_b = ImportAttribution::begin_at(&root);
        assert_eq!(as_b.account_id(), Some(USER_B));
        activate_guest_session_at(&root).expect("sign out");
        assert!(as_b.commit_at(&root).is_err());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn a_committing_import_holds_its_account_until_the_commit_is_done() {
        let root = fixture();
        write_session_at(&root, "a.header.signature", USER_A).expect("sign in A");
        let attribution = ImportAttribution::begin_at(&root);
        let lease = attribution
            .commit_at(&root)
            .expect("same account")
            .expect("lease");
        assert!(
            try_acquire_session_lock_at(&root, SessionLockMode::Exclusive)
                .expect("try exclusive")
                .is_none(),
            "no login/logout can happen during the commit"
        );
        drop(lease);
        assert!(
            try_acquire_session_lock_at(&root, SessionLockMode::Exclusive)
                .expect("try exclusive")
                .is_some()
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn an_import_started_signed_out_or_mid_switch_is_never_attributed() {
        let root = fixture();
        activate_guest_session_at(&root).expect("guest");
        let guest = ImportAttribution::begin_at(&root);
        assert_eq!(guest.account_id(), None);
        // The guest's import (and its env values) is not B's: a login in
        // between fails the commit instead of handing it to B.
        write_session_at(&root, "b.header.signature", USER_B).expect("sign in B");
        assert_eq!(
            guest.commit_at(&root).err().as_deref(),
            Some(IMPORT_ACCOUNT_CHANGED)
        );
        assert_eq!(guest.account_id(), None, "B is never credited");

        begin_runtime_session_transition_at(&root).expect("switch begins");
        assert_eq!(ImportAttribution::begin_at(&root).account_id(), None);
        assert_eq!(
            ImportAttribution::begin_at(&root.join("missing")).account_id(),
            None
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }
}

/// End-to-end `run` resolution against the personal key vault (#253).
#[cfg(all(test, unix))]
mod key_vault_run_tests {
    use super::{
        account_env_path_at, begin_runtime_session_transition_at, clear_runtime_session_at,
        execute_cli_at, read_session_at, resolve_env_at, source_policy_rows_detailed,
        write_session_at, RuntimeDependency, SkillEnvRowState,
    };
    use crate::key_vault;
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    const USER_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const USER_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const SECRET: &str = "fake-vault-secret-value";

    fn fixture() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("skillhub-vault-run-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create fixture");
        root
    }

    /// `extra` is spliced into the sidecar, e.g. a Marketplace source.
    fn write_skill(root: &Path, id: &str, extra: &str) {
        let skill = root.join("skills").join(id);
        fs::create_dir_all(&skill).expect("create managed skill");
        fs::write(
            skill.join(".skillhub.json"),
            format!(
                r#"{{"version":"1","skillhub":{{"id":"{id}","name":"{id}","displayName":"Skill {id}"{extra},"envDependencies":[{{"key":"FAL_KEY","description":"fal.ai","required":true}}]}}}}"#
            ),
        )
        .expect("write profile");
    }

    const MARKETPLACE: &str = r#","isOwn":false,"acquisitionSource":"marketplace""#;

    async fn run_checks_value(root: &Path, skill: &str) -> Result<i32, String> {
        let environment =
            resolve_env_at(root, &root.join("skills"), &root.join("envs"), skill).await?;
        environment.run(
            "/bin/sh",
            &["-c".into(), format!("test \"$FAL_KEY\" = {SECRET}")],
        )
    }

    async fn run_cli(root: &Path, skill: &str, script: &str) -> Result<i32, String> {
        let args = ["run", skill, "--", "/bin/sh", "-c", script].map(str::to_string);
        execute_cli_at(
            root,
            &root.join("skills"),
            &root.join("envs"),
            &args,
            Some("claude"),
        )
        .await
    }

    fn last_run_json(root: &Path, user: &str, skill: &str) -> serde_json::Value {
        let path = root
            .join("runtime")
            .join("last-run")
            .join(user)
            .join(format!("{skill}.json"));
        serde_json::from_str(&fs::read_to_string(path).expect("record")).expect("json")
    }

    /// #292: every run outcome is recorded per identity, without values.
    #[tokio::test]
    async fn run_outcomes_are_recorded_per_identity_without_values() {
        let root = fixture();
        write_skill(&root, "alpha", "");
        write_session_at(&root, "header.payload.signature", USER_A).expect("session");

        let error = run_cli(&root, "alpha", "exit 0")
            .await
            .expect_err("missing key");
        assert!(
            error.starts_with("MISSING_KEY: FAL_KEY 需要填写"),
            "{error}"
        );
        let record = last_run_json(&root, USER_A, "alpha");
        assert_eq!(record["outcome"], "failed");
        assert_eq!(record["reasonCode"], "missing_key");
        assert_eq!(record["keys"], serde_json::json!(["FAL_KEY"]));
        assert_eq!(record["agent"], "claude");
        assert_eq!(record["skillId"], "alpha");

        // Filling the key clears the failure; the run then records ok.
        key_vault::set_vault_key_at(&root, USER_A, "FAL_KEY", SECRET, None, 1).expect("vault");
        crate::last_run::clear_failures_for_keys_at(&root, USER_A, &["FAL_KEY"], None);
        assert!(crate::last_run::list_last_run_failures_at(&root, USER_A)
            .expect("list")
            .is_empty());

        assert_eq!(run_cli(&root, "alpha", "exit 3").await, Ok(3));
        let record = last_run_json(&root, USER_A, "alpha");
        assert_eq!(record["reasonCode"], "exit_code");
        assert_eq!(record["exitCode"], 3);

        assert_eq!(
            run_cli(&root, "alpha", &format!("test \"$FAL_KEY\" = {SECRET}")).await,
            Ok(0)
        );
        let record = last_run_json(&root, USER_A, "alpha");
        assert_eq!(record["outcome"], "ok");
        assert_eq!(record["reasonCode"], serde_json::Value::Null);
        assert_eq!(record["exitCode"], 0);

        let spawn = execute_cli_at(
            &root,
            &root.join("skills"),
            &root.join("envs"),
            &["run", "alpha", "--", "/definitely/missing/program"].map(str::to_string),
            None,
        )
        .await;
        assert!(spawn
            .expect_err("spawn fails")
            .starts_with("无法启动目标进程"));
        let record = last_run_json(&root, USER_A, "alpha");
        assert_eq!(record["reasonCode"], "spawn_failed");
        assert_eq!(record["agent"], serde_json::Value::Null);

        // Another identity has its own records.
        write_session_at(&root, "other.payload.signature", USER_B).expect("session B");
        run_cli(&root, "alpha", "exit 0")
            .await
            .expect_err("B has no key");
        assert_eq!(
            last_run_json(&root, USER_B, "alpha")["reasonCode"],
            "missing_key"
        );
        assert_eq!(
            last_run_json(&root, USER_A, "alpha")["reasonCode"],
            "spawn_failed"
        );

        for entry in fs::read_dir(root.join("runtime").join("last-run").join(USER_A))
            .expect("records")
            .flatten()
        {
            let text = fs::read_to_string(entry.path()).expect("read record");
            assert!(!text.contains(SECRET), "{text}");
        }
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn one_vault_value_serves_every_declaring_skill_until_revoked() {
        let root = fixture();
        write_skill(&root, "alpha", "");
        write_skill(&root, "beta", "");
        write_session_at(&root, "header.payload.signature", USER_A).expect("session");
        key_vault::set_vault_key_at(&root, USER_A, "FAL_KEY", SECRET, Some("alpha"), 1)
            .expect("fill once");
        assert_eq!(run_checks_value(&root, "alpha").await, Ok(0));
        assert_eq!(run_checks_value(&root, "beta").await, Ok(0));
        let rows =
            key_vault::list_vault_keys_at(&root, &root.join("skills"), &root.join("envs"), USER_A)
                .expect("list");
        assert!(rows[0].last_used_at.is_some());
        assert_eq!(rows[0].used_by_skills.len(), 2);

        key_vault::delete_vault_key_at(&root, USER_A, "FAL_KEY").expect("revoke");
        for skill in ["alpha", "beta"] {
            let error = run_checks_value(&root, skill)
                .await
                .expect_err("revoked key is missing");
            assert!(error.contains("FAL_KEY"), "{error}");
            assert!(!error.contains(SECRET));
        }
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn override_wins_over_the_vault_for_its_own_skill_only() {
        let root = fixture();
        write_skill(&root, "alpha", "");
        write_skill(&root, "beta", "");
        write_session_at(&root, "header.payload.signature", USER_A).expect("session");
        key_vault::set_vault_key_at(&root, USER_A, "FAL_KEY", SECRET, None, 1).expect("vault");
        let path = account_env_path_at(&root.join("envs"), USER_A, "beta");
        fs::create_dir_all(path.parent().expect("parent")).expect("env dir");
        fs::set_permissions(
            path.parent().expect("parent"),
            fs::Permissions::from_mode(0o700),
        )
        .expect("private dir");
        fs::write(&path, "FAL_KEY=fake-override\n").expect("override");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("private");
        // Mark the account as migrated so the override stays an override.
        key_vault::migrate_vault_locked_at(&root, &root.join("envs"), USER_A, 2).expect("migrate");
        assert_eq!(run_checks_value(&root, "alpha").await, Ok(0));
        let environment = resolve_env_at(&root, &root.join("skills"), &root.join("envs"), "beta")
            .await
            .expect("resolve override");
        let code = environment
            .run(
                "/bin/sh",
                &["-c".into(), "test \"$FAL_KEY\" = fake-override".into()],
            )
            .expect("run override");
        assert_eq!(code, 0);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn per_skill_values_are_migrated_before_the_first_run_with_the_same_result() {
        let root = fixture();
        write_skill(&root, "alpha", "");
        write_skill(&root, "beta", "");
        write_session_at(&root, "header.payload.signature", USER_A).expect("session");
        let path = account_env_path_at(&root.join("envs"), USER_A, "alpha");
        fs::create_dir_all(path.parent().expect("parent")).expect("env dir");
        fs::set_permissions(
            path.parent().expect("parent"),
            fs::Permissions::from_mode(0o700),
        )
        .expect("private dir");
        fs::write(&path, format!("FAL_KEY={SECRET}\n")).expect("legacy value");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("private");
        assert_eq!(run_checks_value(&root, "alpha").await, Ok(0));
        assert!(!path.exists(), "migrated per-Skill entry is removed");
        assert!(key_vault::migration_marker_path_at(&root, USER_A).exists());
        // The value filled for alpha is now usable by beta as well.
        assert_eq!(run_checks_value(&root, "beta").await, Ok(0));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn store_or_team_skill_needs_consent_and_own_skill_never_asks() {
        let root = fixture();
        write_skill(&root, "own", "");
        write_skill(&root, "market", MARKETPLACE);
        write_session_at(&root, "header.payload.signature", USER_A).expect("session");
        key_vault::set_vault_key_at(&root, USER_A, "FAL_KEY", SECRET, None, 1).expect("vault");

        assert_eq!(run_checks_value(&root, "own").await, Ok(0));

        // Deny = nothing stored: every attempt fails with NEEDS_CONSENT.
        for _ in 0..2 {
            let error = run_checks_value(&root, "market")
                .await
                .expect_err("consent required");
            assert!(error.starts_with("NEEDS_CONSENT: "), "{error}");
            assert!(error.contains("FAL_KEY") && error.contains("Skill market"));
            assert!(error.contains("APP 会弹出授权窗"));
            assert!(!error.contains(SECRET));
            let requests = key_vault::list_consent_requests_at(
                &root,
                &root.join("skills"),
                USER_A,
                key_vault::now_ms(),
            )
            .expect("requests");
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].keys, vec!["FAL_KEY"]);
            key_vault::dismiss_consent_request_at(&root, USER_A, "market").expect("deny");
        }

        // 仅这次: exactly one run, nothing persisted.
        key_vault::grant_key_access_at(
            &root,
            USER_A,
            "market",
            "FAL_KEY",
            true,
            key_vault::now_ms(),
        )
        .expect("once");
        assert_eq!(run_checks_value(&root, "market").await, Ok(0));
        assert!(run_checks_value(&root, "market")
            .await
            .expect_err("once grant consumed")
            .starts_with("NEEDS_CONSENT"));
        assert!(
            key_vault::read_meta_at(&root, USER_A).expect("meta").keys["FAL_KEY"]
                .allowed_skills
                .is_empty()
        );

        // 以后不再询问 bypasses; switching it back off asks again.
        key_vault::set_key_auto_allow_at(&root, USER_A, true, None, 5).expect("auto");
        assert_eq!(run_checks_value(&root, "market").await, Ok(0));
        key_vault::set_key_auto_allow_at(&root, USER_A, false, None, 6).expect("auto off");
        assert!(run_checks_value(&root, "market")
            .await
            .expect_err("asks again")
            .starts_with("NEEDS_CONSENT"));

        // 允许 is remembered.
        key_vault::grant_key_access_at(&root, USER_A, "market", "FAL_KEY", false, 7)
            .expect("allow");
        assert_eq!(run_checks_value(&root, "market").await, Ok(0));
        assert_eq!(run_checks_value(&root, "market").await, Ok(0));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn account_vaults_are_isolated_and_switches_discard_requests() {
        let root = fixture();
        write_skill(&root, "alpha", "");
        write_session_at(&root, "a.header.signature", USER_A).expect("session A");
        key_vault::set_vault_key_at(&root, USER_A, "FAL_KEY", SECRET, None, 1).expect("A vault");
        assert_eq!(run_checks_value(&root, "alpha").await, Ok(0));

        write_session_at(&root, "b.header.signature", USER_B).expect("session B");
        assert!(run_checks_value(&root, "alpha").await.is_err());
        let b_rows =
            key_vault::list_vault_keys_at(&root, &root.join("skills"), &root.join("envs"), USER_B)
                .expect("B list");
        assert!(b_rows.is_empty());
        // A request made for A while B is signed in is refused.
        let stale = key_vault::with_current_identity_at(
            &root,
            &root.join("envs"),
            Some(USER_A),
            None,
            |_, _, _| Ok(()),
        );
        assert!(stale.is_err());
        // Mid-switch every vault request is discarded.
        begin_runtime_session_transition_at(&root).expect("begin switch");
        let pending = key_vault::with_current_identity_at(
            &root,
            &root.join("envs"),
            None,
            None,
            |_, _, _| Ok(()),
        );
        assert_eq!(
            pending,
            Err(key_vault::KEY_VAULT_ACCOUNT_CHANGED.to_string())
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn guest_vault_joins_the_account_at_login() {
        let root = fixture();
        write_skill(&root, "alpha", "");
        clear_runtime_session_at(&root).expect("guest session");
        let guest = read_session_at(&root).expect("guest").user_id().to_string();
        key_vault::set_vault_key_at(&root, &guest, "FAL_KEY", SECRET, Some("alpha"), 1)
            .expect("guest fills");
        assert_eq!(run_checks_value(&root, "alpha").await, Ok(0));
        super::sync_runtime_session_at(
            &root,
            &root.join("skills"),
            "header.payload.signature",
            USER_A,
        )
        .expect("login");
        assert_eq!(run_checks_value(&root, "alpha").await, Ok(0));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    /// A Skill declaring `FAL_API_KEY` (an alias of the vault key `FAL_KEY`).
    fn write_aliased_skill(root: &Path, id: &str, extra: &str) {
        let skill = root.join("skills").join(id);
        fs::create_dir_all(&skill).expect("create managed skill");
        fs::write(
            skill.join(".skillhub.json"),
            format!(
                r#"{{"version":"1","skillhub":{{"id":"{id}","name":"{id}","displayName":"Skill {id}"{extra},"envDependencies":[{{"key":"FAL_API_KEY","description":"fal.ai","required":true}}]}}}}"#
            ),
        )
        .expect("write profile");
    }

    async fn run_checks_alias(root: &Path, skill: &str) -> Result<i32, String> {
        let environment =
            resolve_env_at(root, &root.join("skills"), &root.join("envs"), skill).await?;
        environment.run(
            "/bin/sh",
            &[
                "-c".into(),
                format!("test \"$FAL_API_KEY\" = {SECRET} && test -z \"${{FAL_KEY+x}}\""),
            ],
        )
    }

    #[tokio::test]
    async fn run_injects_a_vault_key_under_the_alias_the_skill_declares() {
        let root = fixture();
        write_aliased_skill(&root, "alpha", "");
        write_session_at(&root, "header.payload.signature", USER_A).expect("session");
        key_vault::set_vault_key_at(&root, USER_A, "FAL_KEY", SECRET, None, 1).expect("vault");
        let error = run_checks_alias(&root, "alpha")
            .await
            .expect_err("no alias yet");
        assert!(error.contains("FAL_API_KEY 需要填写"), "{error}");

        key_vault::set_vault_key_aliases_at(
            &root,
            USER_A,
            "FAL_KEY",
            vec!["FAL_API_KEY".into()],
            2,
        )
        .expect("alias");
        assert_eq!(run_checks_alias(&root, "alpha").await, Ok(0));
        // Usage is recorded for the key itself.
        let rows =
            key_vault::list_vault_keys_at(&root, &root.join("skills"), &root.join("envs"), USER_A)
                .expect("list");
        assert!(rows[0].last_used_at.is_some());
        assert_eq!(rows[0].used_by_skills[0].declared_key, "FAL_API_KEY");

        key_vault::set_vault_key_aliases_at(&root, USER_A, "FAL_KEY", Vec::new(), 3)
            .expect("unlink");
        let error = run_checks_alias(&root, "alpha")
            .await
            .expect_err("alias removed");
        assert!(error.contains("FAL_API_KEY 需要填写"), "{error}");
        assert!(!error.contains(SECRET));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    /// #294: a key turned off for one Skill behaves as if the vault had no
    /// value for it; other Skills keep using it, and turning it back on
    /// restores the run (allowing a store Skill without a consent prompt).
    #[tokio::test]
    async fn a_vault_key_turned_off_for_a_skill_is_missing_until_turned_back_on() {
        let root = fixture();
        write_skill(&root, "alpha", "");
        write_skill(&root, "beta", "");
        write_aliased_skill(&root, "market", MARKETPLACE);
        write_session_at(&root, "header.payload.signature", USER_A).expect("session");
        key_vault::set_vault_key_at(&root, USER_A, "FAL_KEY", SECRET, None, 1).expect("vault");
        key_vault::set_vault_key_aliases_at(
            &root,
            USER_A,
            "FAL_KEY",
            vec!["FAL_API_KEY".into()],
            2,
        )
        .expect("alias");
        let alpha = crate::runtime_env::read_profile_at(&root.join("skills"), "alpha").ok();
        key_vault::set_vault_key_skill_access_at(
            &root,
            USER_A,
            "FAL_KEY",
            "alpha",
            alpha.as_ref(),
            false,
            3,
        )
        .expect("turn off");
        let error = run_cli(&root, "alpha", "exit 0")
            .await
            .expect_err("blocked key is missing");
        assert!(
            error.starts_with("MISSING_KEY: FAL_KEY 需要填写"),
            "{error}"
        );
        assert!(!error.contains(SECRET));
        assert_eq!(run_checks_value(&root, "beta").await, Ok(0));

        key_vault::set_vault_key_skill_access_at(
            &root,
            USER_A,
            "FAL_KEY",
            "alpha",
            alpha.as_ref(),
            true,
            4,
        )
        .expect("turn on");
        assert_eq!(run_checks_value(&root, "alpha").await, Ok(0));

        // The alias-declared store Skill is blocked through the main key and
        // never asked for consent while blocked.
        let market = crate::runtime_env::read_profile_at(&root.join("skills"), "market").ok();
        key_vault::set_vault_key_skill_access_at(
            &root,
            USER_A,
            "FAL_API_KEY",
            "market",
            market.as_ref(),
            false,
            5,
        )
        .expect("turn off market");
        let error = run_checks_alias(&root, "market")
            .await
            .expect_err("blocked alias is missing");
        assert!(!error.starts_with("NEEDS_CONSENT"), "{error}");
        assert!(error.contains("FAL_API_KEY 需要填写"), "{error}");
        assert!(key_vault::list_consent_requests_at(
            &root,
            &root.join("skills"),
            USER_A,
            key_vault::now_ms()
        )
        .expect("requests")
        .is_empty());
        key_vault::set_vault_key_skill_access_at(
            &root,
            USER_A,
            "FAL_KEY",
            "market",
            market.as_ref(),
            true,
            6,
        )
        .expect("turn on market");
        assert_eq!(run_checks_alias(&root, "market").await, Ok(0));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn consent_through_an_alias_is_asked_and_granted_for_the_key_itself() {
        let root = fixture();
        write_aliased_skill(&root, "market", MARKETPLACE);
        write_session_at(&root, "header.payload.signature", USER_A).expect("session");
        key_vault::set_vault_key_at(&root, USER_A, "FAL_KEY", SECRET, None, 1).expect("vault");
        key_vault::set_vault_key_aliases_at(
            &root,
            USER_A,
            "FAL_KEY",
            vec!["FAL_API_KEY".into()],
            2,
        )
        .expect("alias");
        let error = run_checks_alias(&root, "market")
            .await
            .expect_err("consent required");
        assert!(error.starts_with("NEEDS_CONSENT: "), "{error}");
        assert!(
            error.contains("FAL_KEY") && !error.contains("FAL_API_KEY"),
            "{error}"
        );
        let requests = key_vault::list_consent_requests_at(
            &root,
            &root.join("skills"),
            USER_A,
            key_vault::now_ms(),
        )
        .expect("requests");
        assert_eq!(requests[0].keys, vec!["FAL_KEY"]);
        // 仅这次 for FAL_KEY covers the Skill that declares FAL_API_KEY, once.
        key_vault::grant_key_access_at(
            &root,
            USER_A,
            "market",
            "FAL_KEY",
            true,
            key_vault::now_ms(),
        )
        .expect("once");
        assert_eq!(run_checks_alias(&root, "market").await, Ok(0));
        assert!(run_checks_alias(&root, "market")
            .await
            .expect_err("once grant consumed")
            .starts_with("NEEDS_CONSENT"));
        // 允许 for FAL_KEY is remembered for the alias as well.
        key_vault::grant_key_access_at(&root, USER_A, "market", "FAL_KEY", false, 5)
            .expect("allow");
        assert_eq!(run_checks_alias(&root, "market").await, Ok(0));
        assert!(key_vault::list_consent_requests_at(
            &root,
            &root.join("skills"),
            USER_A,
            key_vault::now_ms(),
        )
        .expect("requests")
        .is_empty());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn policy_rows_name_the_personal_source_and_consent_without_values() {
        let dependencies = vec![
            RuntimeDependency {
                key: "FAL_KEY".into(),
                description: None,
                required: true,
            },
            RuntimeDependency {
                key: "OWN_KEY".into(),
                description: None,
                required: true,
            },
        ];
        let personal = BTreeMap::from([
            ("FAL_KEY".to_string(), SECRET.to_string()),
            ("OWN_KEY".to_string(), "fake-override-secret".to_string()),
        ]);
        let sources = BTreeMap::from([
            ("FAL_KEY".to_string(), key_vault::PersonalSource::Vault),
            ("OWN_KEY".to_string(), key_vault::PersonalSource::Override),
        ]);
        let rows = source_policy_rows_detailed(
            dependencies,
            &personal,
            &sources,
            &BTreeSet::from(["FAL_KEY".to_string()]),
            None,
            &[],
        );
        assert_eq!(rows[0].state, SkillEnvRowState::Ready);
        assert_eq!(rows[0].source, Some("vault"));
        assert!(rows[0].needs_consent);
        assert_eq!(rows[1].source, Some("override"));
        assert!(!rows[1].needs_consent);
        let json = serde_json::to_string(&rows).expect("rows json");
        assert!(json.contains("\"personalSource\":\"vault\""));
        assert!(json.contains("\"needsConsent\":true"));
        assert!(!json.contains(SECRET) && !json.contains("fake-override-secret"));
    }

    // ── Labelled variants (#306) ────────────────────────────────────────────

    async fn run_expects(root: &Path, skill: &str, expected: &str) -> Result<i32, String> {
        let environment =
            resolve_env_at(root, &root.join("skills"), &root.join("envs"), skill).await?;
        environment.run(
            "/bin/sh",
            &["-c".into(), format!("test \"$FAL_KEY\" = {expected}")],
        )
    }

    #[test]
    fn personal_variant_policy_serializes_next_to_the_other_sources() {
        use super::SkillEnvSource;
        assert_eq!(
            serde_json::to_value(SkillEnvSource::PersonalVariant {
                variant: Some("V1".into())
            })
            .expect("json"),
            serde_json::json!({"kind": "personalVariant", "variant": "V1"})
        );
        assert_eq!(
            serde_json::to_value(SkillEnvSource::PersonalVariant { variant: None }).expect("json"),
            serde_json::json!({"kind": "personalVariant", "variant": null})
        );
        for text in [
            r#"{"kind":"personalVariant","variant":"V2"}"#,
            r#"{"kind":"personal_variant","variant":"V2"}"#,
        ] {
            assert_eq!(
                serde_json::from_str::<SkillEnvSource>(text).expect("parse"),
                SkillEnvSource::PersonalVariant {
                    variant: Some("V2".into())
                }
            );
        }
        assert_eq!(
            serde_json::from_str::<SkillEnvSource>(r#"{"kind":"personalVariant"}"#).expect("parse"),
            SkillEnvSource::PersonalVariant { variant: None }
        );
    }

    #[tokio::test]
    async fn run_follows_the_policy_variant_and_falls_back_after_delete() {
        let root = fixture();
        write_skill(&root, "alpha", "");
        write_skill(&root, "beta", "");
        write_session_at(&root, "header.payload.signature", USER_A).expect("session");
        key_vault::set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-default", None, 1)
            .expect("default");
        let work = key_vault::create_vault_key_variant_at(
            &root,
            USER_A,
            "FAL_KEY",
            "公司",
            "fake-work",
            None,
            2,
        )
        .expect("work");
        super::set_personal_variant_policy_at(&root, USER_A, "alpha", "FAL_KEY", Some(&work))
            .expect("policy");
        assert_eq!(run_expects(&root, "alpha", "fake-work").await, Ok(0));
        assert_eq!(run_expects(&root, "beta", "fake-default").await, Ok(0));
        // Usage is recorded per value.
        let rows =
            key_vault::list_vault_keys_at(&root, &root.join("skills"), &root.join("envs"), USER_A)
                .expect("list");
        assert!(rows.iter().all(|row| row.last_used_at.is_some()));
        // 「设为默认」 moves beta; an explicit unlabelled choice stays put.
        key_vault::set_vault_default_variant_at(&root, USER_A, "FAL_KEY", Some(&work))
            .expect("default work");
        assert_eq!(run_expects(&root, "beta", "fake-work").await, Ok(0));
        super::set_personal_variant_policy_at(&root, USER_A, "beta", "FAL_KEY", None)
            .expect("explicit unlabelled");
        assert_eq!(run_expects(&root, "beta", "fake-default").await, Ok(0));
        key_vault::set_vault_default_variant_at(&root, USER_A, "FAL_KEY", None)
            .expect("default back");
        let home = key_vault::create_vault_key_variant_at(
            &root,
            USER_A,
            "FAL_KEY",
            "个人",
            "fake-home",
            None,
            3,
        )
        .expect("home");
        key_vault::delete_vault_key_variant_at(&root, USER_A, "FAL_KEY", Some(&work))
            .expect("drop work");
        // The policy still names V1: it falls back to the default silently.
        assert_eq!(run_expects(&root, "alpha", "fake-default").await, Ok(0));
        assert_eq!(home, "V2");
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn consent_for_a_variant_names_its_label() {
        let root = fixture();
        write_skill(&root, "market", MARKETPLACE);
        write_session_at(&root, "header.payload.signature", USER_A).expect("session");
        key_vault::set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-default", None, 1)
            .expect("default");
        let work = key_vault::create_vault_key_variant_at(
            &root,
            USER_A,
            "FAL_KEY",
            "公司",
            "fake-work",
            None,
            2,
        )
        .expect("work");
        key_vault::grant_key_access_at(&root, USER_A, "market", "FAL_KEY", false, 3)
            .expect("allow default");
        assert_eq!(run_expects(&root, "market", "fake-default").await, Ok(0));
        super::set_personal_variant_policy_at(&root, USER_A, "market", "FAL_KEY", Some(&work))
            .expect("policy");
        let error = run_expects(&root, "market", "fake-work")
            .await
            .expect_err("variant needs its own consent");
        assert!(
            error.starts_with("NEEDS_CONSENT: 「Skill market」想使用你的钥匙 FAL_KEY · 公司；"),
            "{error}"
        );
        assert_eq!(
            crate::last_run::classify_run_failure(&error).1,
            vec!["FAL_KEY".to_string()]
        );
        let requests = key_vault::list_consent_requests_at(
            &root,
            &root.join("skills"),
            USER_A,
            key_vault::now_ms(),
        )
        .expect("requests");
        assert_eq!(requests[0].keys, vec!["FAL_KEY__V1"]);
        key_vault::grant_key_access_at(&root, USER_A, "market", "FAL_KEY__V1", false, 4)
            .expect("allow variant");
        assert_eq!(run_expects(&root, "market", "fake-work").await, Ok(0));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn converting_an_override_keeps_the_run_identical() {
        let root = fixture();
        write_skill(&root, "alpha", "");
        write_session_at(&root, "header.payload.signature", USER_A).expect("session");
        key_vault::set_vault_key_at(&root, USER_A, "FAL_KEY", "fake-default", None, 1)
            .expect("default");
        key_vault::migrate_vault_locked_at(&root, &root.join("envs"), USER_A, 1).expect("migrate");
        let path = account_env_path_at(&root.join("envs"), USER_A, "alpha");
        fs::create_dir_all(path.parent().expect("parent")).expect("env dir");
        fs::set_permissions(
            path.parent().expect("parent"),
            fs::Permissions::from_mode(0o700),
        )
        .expect("private dir");
        fs::write(&path, "FAL_KEY=fake-own\n").expect("override");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("private");
        assert_eq!(run_expects(&root, "alpha", "fake-own").await, Ok(0));
        assert_eq!(
            crate::commands::convert_override_to_variant_at(
                &root,
                &root.join("envs"),
                USER_A,
                "beta",
                "FAL_KEY",
                "公司",
                2,
            ),
            Err("这个 Skill 没有单独填写的 FAL_KEY".into())
        );
        let variant = crate::commands::convert_override_to_variant_at(
            &root,
            &root.join("envs"),
            USER_A,
            "alpha",
            "FAL_KEY",
            "公司",
            2,
        )
        .expect("convert");
        assert_eq!(variant, "V1");
        assert!(!path.exists(), "override removed");
        assert_eq!(
            super::personal_variant_choices_at(&root, USER_A, "alpha"),
            BTreeMap::from([("FAL_KEY".to_string(), Some("V1".to_string()))])
        );
        assert_eq!(run_expects(&root, "alpha", "fake-own").await, Ok(0));
        let rows =
            key_vault::list_vault_keys_at(&root, &root.join("skills"), &root.join("envs"), USER_A)
                .expect("list");
        assert_eq!(rows[1].label.as_deref(), Some("公司"));
        assert!(rows[1].used_by_skills[0].in_use);
        assert!(rows[0].override_skills.is_empty());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn policy_rows_carry_the_personal_switcher() {
        let mut rows = source_policy_rows_detailed(
            vec![RuntimeDependency {
                key: "FAL_KEY".into(),
                description: None,
                required: true,
            }],
            &BTreeMap::from([("FAL_KEY".to_string(), "fake".to_string())]),
            &BTreeMap::from([("FAL_KEY".to_string(), key_vault::PersonalSource::Vault)]),
            &BTreeSet::new(),
            Some(&BTreeMap::from([(
                "FAL_KEY".to_string(),
                super::SkillEnvSource::PersonalVariant {
                    variant: Some("V1".into()),
                },
            )])),
            &[],
        );
        let options = BTreeMap::from([(
            "FAL_KEY".to_string(),
            vec![
                key_vault::KeyVariantOption {
                    id: None,
                    label: None,
                    is_default: true,
                },
                key_vault::KeyVariantOption {
                    id: Some("V1".into()),
                    label: Some("公司".into()),
                    is_default: false,
                },
            ],
        )]);
        super::attach_personal_variants(
            &mut rows,
            &options,
            &BTreeMap::from([("FAL_KEY".to_string(), Some("V1".to_string()))]),
        );
        let json = serde_json::to_value(&rows).expect("json");
        assert_eq!(json[0]["selected"]["kind"], "personalVariant");
        assert_eq!(json[0]["effective"]["kind"], "personal");
        assert_eq!(json[0]["source"], "vault");
        assert_eq!(json[0]["selectedVariant"], "V1");
        assert_eq!(json[0]["personalVariants"][1]["label"], "公司");
        assert_eq!(
            json[0]["personalVariants"][0]["id"],
            serde_json::Value::Null
        );
        assert_eq!(json[0]["state"], "ready");
    }
}

/// Lock semantics run on every platform (#358): the Windows build used to ship
/// with zero lock coverage because the cross-process probes lived in the
/// unix-only test module.
#[cfg(test)]
mod session_lock_semantics_tests {
    use super::{
        acquire_current_session_lease_at, acquire_session_lock_at, runtime_session_snapshot_at,
        try_acquire_session_lock_at, write_session_at, SessionLockMode,
    };
    use std::process::Command;
    use std::time::{Duration, Instant};

    const USER_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    fn root() -> std::path::PathBuf {
        let root =
            std::env::temp_dir().join(format!("skillhub-session-lock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create lock fixture");
        root
    }

    fn retained_switch_lock(root: &std::path::Path) -> super::SessionLease {
        let lease = super::try_named_lock_at(root, "switch.lock")
            .unwrap()
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            // Model the inherited open file description without actually forking
            // a multithreaded test runner. Closing only the original must not unlock.
            let fd = unsafe { libc::dup(lease._file.as_raw_fd()) };
            assert!(fd >= 0, "dup: {}", std::io::Error::last_os_error());
            // Restore CLOEXEC so concurrent process tests cannot inherit this
            // fixture beyond exec. File owns the duplicate even if an assertion fails.
            let duplicate = unsafe { std::fs::File::from_raw_fd(fd) };
            assert_eq!(
                unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) },
                0
            );
            drop(lease);
            super::SessionLease { _file: duplicate }
        }
        #[cfg(windows)]
        {
            // LockFileEx locks are handle-owned, not inherited by DuplicateHandle.
            // Keep this independent handle locked while the contender opens its own.
            lease
        }
    }

    fn release_switch_lock_after_delay(
        lease: super::SessionLease,
    ) -> (std::thread::JoinHandle<()>, std::sync::mpsc::Receiver<()>) {
        let (released, notification) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(lease);
            released.send(()).unwrap();
        });
        (thread, notification)
    }

    #[test]
    fn switch_transaction_waits_for_retained_lock_copy() {
        let home = crate::spaces::rebind_tests::Home::new();
        let copy = retained_switch_lock(&home.0);
        let (release, released) = release_switch_lock_after_delay(copy);
        let result = crate::spaces::SwitchTransaction::begin(&home.0, false);
        released.recv_timeout(Duration::from_secs(1)).unwrap();
        release.join().unwrap();
        let transaction = result.expect("short-lived inherited lock must not report a busy switch");
        // begin also recovers/locks the session and durably writes session.json.
        // Its total duration is not the switch-lock wait (Windows measured 2.67 s).
        // Assert the lock's timing directly below; retain transaction integration here.
        drop(transaction);
    }

    #[test]
    fn switch_writer_waits_for_retained_lock_copy() {
        let home = crate::spaces::rebind_tests::Home::new();
        let copy = retained_switch_lock(&home.0);
        let (release, released) = release_switch_lock_after_delay(copy);
        let started = Instant::now();
        let result = super::try_named_lock_at(&home.0, "switch.lock");
        let elapsed = started.elapsed();
        released.recv_timeout(Duration::from_secs(1)).unwrap();
        release.join().unwrap();
        let writer = result
            .unwrap()
            .expect("writer must wait for transient lock");
        assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
        drop(writer);
    }

    #[test]
    fn switch_writer_times_out_while_retained_lock_copy_is_held() {
        let home = crate::spaces::rebind_tests::Home::new();
        let copy = retained_switch_lock(&home.0);
        let started = Instant::now();
        assert!(super::try_named_lock_at(&home.0, "switch.lock")
            .unwrap()
            .is_none());
        let elapsed = started.elapsed();
        assert!(elapsed >= Duration::from_millis(200), "{elapsed:?}");
        assert!(elapsed < Duration::from_millis(1500), "{elapsed:?}");
        drop(copy);
    }

    #[test]
    fn switch_transaction_times_out_while_retained_lock_copy_is_held() {
        let home = crate::spaces::rebind_tests::Home::new();
        let before = runtime_session_snapshot_at(&home.0).unwrap();
        let copy = retained_switch_lock(&home.0);
        let started = Instant::now();
        let result = crate::spaces::SwitchTransaction::begin(&home.0, false);
        let elapsed = started.elapsed();
        // Retain the copy until the call returns: success or an unbounded wait
        // cannot be hidden by a timer eventually releasing the lock.
        assert_eq!(
            result.err().as_deref(),
            Some("SkillHub 正在切换空间，请稍后重试")
        );
        assert!(elapsed >= Duration::from_millis(200), "{elapsed:?}");
        assert!(elapsed < Duration::from_millis(1500), "{elapsed:?}");
        drop(copy);
        assert_eq!(runtime_session_snapshot_at(&home.0).unwrap(), before);
        drop(crate::spaces::SwitchTransaction::begin(&home.0, false).unwrap());
    }

    #[test]
    fn switch_observer_waits_for_retained_lock_copy() {
        let home = crate::spaces::rebind_tests::Home::new();
        let copy = retained_switch_lock(&home.0);
        let (release, released) = release_switch_lock_after_delay(copy);
        let started = Instant::now();
        let result = super::try_shared_switch_lock_at(&home.0);
        let elapsed = started.elapsed();
        released.recv_timeout(Duration::from_secs(1)).unwrap();
        release.join().unwrap();
        let observer = result
            .unwrap()
            .expect("observer must wait for transient lock");
        assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
        drop(observer);
    }

    #[test]
    fn switch_observer_times_out_while_retained_lock_copy_is_held() {
        let home = crate::spaces::rebind_tests::Home::new();
        let copy = retained_switch_lock(&home.0);
        let started = Instant::now();
        assert!(super::try_shared_switch_lock_at(&home.0).unwrap().is_none());
        let elapsed = started.elapsed();
        assert!(elapsed >= Duration::from_millis(200), "{elapsed:?}");
        assert!(elapsed < Duration::from_millis(1500), "{elapsed:?}");
        drop(copy);
    }

    #[cfg(windows)]
    fn incompatible_switch_handle(root: &std::path::Path) -> super::SessionLease {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        // Reproduce the legacy open-time sharing conflict (32), not a
        // LockFileEx byte-range conflict (33). Both contenders require write access.
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(FILE_SHARE_READ)
            .open(super::runtime_dir_at(root).join("switch.lock"))
            .unwrap();
        super::SessionLease { _file: file }
    }

    #[cfg(windows)]
    #[test]
    fn switch_waits_for_incompatible_share_handle_to_close() {
        for mode in [SessionLockMode::Exclusive, SessionLockMode::Shared] {
            let home = crate::spaces::rebind_tests::Home::new();
            let holder = incompatible_switch_handle(&home.0);
            let (release, released) = release_switch_lock_after_delay(holder);
            let started = Instant::now();
            let result = super::acquire_named_lock_at(&home.0, "switch.lock", mode, true);
            let elapsed = started.elapsed();
            released.recv_timeout(Duration::from_secs(1)).unwrap();
            release.join().unwrap();
            let lease = result.unwrap().expect("sharing conflict must be retried");
            assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
            drop(lease);
        }
    }

    #[cfg(windows)]
    #[test]
    fn switch_times_out_while_incompatible_share_handle_is_held() {
        for mode in [SessionLockMode::Exclusive, SessionLockMode::Shared] {
            let home = crate::spaces::rebind_tests::Home::new();
            let holder = incompatible_switch_handle(&home.0);
            let started = Instant::now();
            assert!(
                super::acquire_named_lock_at(&home.0, "switch.lock", mode, true)
                    .unwrap()
                    .is_none()
            );
            let elapsed = started.elapsed();
            assert!(elapsed >= Duration::from_millis(200), "{elapsed:?}");
            assert!(elapsed < Duration::from_millis(1500), "{elapsed:?}");
            drop(holder);
            drop(
                super::acquire_named_lock_at(&home.0, "switch.lock", mode, true)
                    .unwrap()
                    .unwrap(),
            );
        }
    }

    #[test]
    fn switch_readers_coexist_but_exclude_switch_commits() {
        let root = root();
        let first = super::try_shared_switch_lock_at(&root).unwrap().unwrap();
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let second = super::try_shared_switch_lock_at(&root).unwrap();
                    assert!(second.is_some(), "concurrent readers must coexist");
                    assert!(super::try_named_lock_at(&root, "switch.lock")
                        .unwrap()
                        .is_none());
                })
                .join()
                .unwrap();
        });
        drop(first);
        let writer =
            super::acquire_named_lock_at(&root, "switch.lock", SessionLockMode::Exclusive, false)
                .unwrap()
                .unwrap();
        assert!(super::try_shared_switch_lock_at(&root).unwrap().is_none());
        drop(writer);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn optional_snapshot_distinguishes_missing_from_unreadable_session() {
        let root = root();
        assert!(super::optional_session_snapshot_at(&root)
            .unwrap()
            .is_none());
        assert!(
            !root.join("runtime").exists(),
            "absent guest read must not create runtime files"
        );
        std::fs::create_dir(root.join("runtime")).unwrap();
        std::fs::write(super::session_path_at(&root), b"invalid-json").unwrap();
        assert!(super::optional_session_snapshot_at(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Readers coexist and writers wait, on every platform (#358): Windows
    /// used to turn every lease into an exclusive one, so the APP's own
    /// session readers serialised behind each other for up to 10 s each.
    #[test]
    fn shared_leases_coexist_and_exclude_writers_in_one_process() {
        let root = root();
        let first =
            acquire_session_lock_at(&root, SessionLockMode::Shared).expect("first shared lease");
        let second = try_acquire_session_lock_at(&root, SessionLockMode::Shared)
            .expect("probe second shared lease");
        assert!(
            second.is_some(),
            "a second shared lease must not block on the first"
        );
        assert!(
            try_acquire_session_lock_at(&root, SessionLockMode::Exclusive)
                .expect("probe exclusive lease")
                .is_none(),
            "an exclusive lease must wait while shared leases are held"
        );
        drop(second);
        assert!(
            try_acquire_session_lock_at(&root, SessionLockMode::Exclusive)
                .expect("probe exclusive lease")
                .is_none()
        );
        drop(first);
        // Blocking on purpose: a concurrent test may fork a child while a
        // lease is open, and the child keeps the file description alive
        // until exec; waiting is the semantic ("once readers are gone").
        let exclusive = acquire_session_lock_at(&root, SessionLockMode::Exclusive)
            .expect("exclusive lease once readers are gone");
        assert!(
            try_acquire_session_lock_at(&root, SessionLockMode::Shared)
                .expect("probe shared lease")
                .is_none(),
            "readers wait behind a writer"
        );
        drop(exclusive);
        drop(acquire_session_lock_at(&root, SessionLockMode::Shared).expect("readers resume"));
        std::fs::remove_dir_all(root).expect("remove lock fixture");
    }

    pub(super) fn run_lock_probe(root: &std::path::Path, mode: &str, expected_available: bool) {
        // A concurrent test may fork a child while our lease is still open; that child keeps
        // the lock's file description until it execs, so "available" can lag the drop by a
        // moment (wider under Rosetta, #379). Only the "available" side waits; "blocked" is
        // still judged from a single probe.
        let attempts = if expected_available { 50 } else { 1 };
        let mut output = probe_lock_once(root, mode, expected_available);
        for _ in 1..attempts {
            if output.status.success() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
            output = probe_lock_once(root, mode, expected_available);
        }
        assert!(
            output.status.success(),
            "child lock probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn probe_lock_once(
        root: &std::path::Path,
        mode: &str,
        expected_available: bool,
    ) -> std::process::Output {
        Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--exact",
                "runtime_env::session_lock_semantics_tests::session_lock_child_process_probe",
                "--nocapture",
            ])
            .env("SKILLHUB_TEST_LOCK_ROOT", root)
            .env("SKILLHUB_TEST_LOCK_MODE", mode)
            .env(
                "SKILLHUB_TEST_LOCK_AVAILABLE",
                if expected_available { "1" } else { "0" },
            )
            .output()
            .expect("run child lock probe")
    }

    #[test]
    fn session_lock_child_process_probe() {
        let Some(root) = std::env::var_os("SKILLHUB_TEST_LOCK_ROOT") else {
            return;
        };
        let mode = match std::env::var("SKILLHUB_TEST_LOCK_MODE").as_deref() {
            Ok("shared") => SessionLockMode::Shared,
            Ok("exclusive") => SessionLockMode::Exclusive,
            other => panic!("unexpected child lock mode: {other:?}"),
        };
        let expected_available =
            std::env::var("SKILLHUB_TEST_LOCK_AVAILABLE").as_deref() == Ok("1");
        let lease = try_acquire_session_lock_at(std::path::Path::new(&root), mode)
            .expect("probe runtime lock");
        assert_eq!(lease.is_some(), expected_available);
    }

    #[test]
    fn current_session_lease_blocks_account_transition_until_local_commit_finishes() {
        let root = root();
        write_session_at(&root, "header.payload.signature", USER_A).expect("write session");
        let snapshot = runtime_session_snapshot_at(&root).expect("snapshot session");
        let lease = acquire_current_session_lease_at(&root, &snapshot)
            .expect("acquire guarded lease")
            .expect("matching session");

        run_lock_probe(&root, "shared", true);
        run_lock_probe(&root, "exclusive", false);
        drop(lease);
        run_lock_probe(&root, "exclusive", true);
        std::fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn session_write_lease_blocks_cross_process_read_lease() {
        let root = root();
        let lease = acquire_session_lock_at(&root, SessionLockMode::Exclusive)
            .expect("take exclusive session lease");
        run_lock_probe(&root, "shared", false);
        drop(lease);
        run_lock_probe(&root, "shared", true);
        std::fs::remove_dir_all(root).expect("remove fixture");
    }
}
