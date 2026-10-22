use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use uuid::Uuid;
use zeroize::Zeroize;

const PORTAL_ISSUER: &str = "https://account.whatonearth.work/realms/yitan";
const PORTAL_AUTHORIZE_URL: &str =
    "https://account.whatonearth.work/realms/yitan/protocol/openid-connect/auth";
const PORTAL_TOKEN_URL: &str =
    "https://account.whatonearth.work/realms/yitan/protocol/openid-connect/token";
const PORTAL_ACCOUNT_URL: &str = "https://account.whatonearth.work/realms/yitan/account/";
const CLIENT_ID: &str = "skillhub-desktop";
const CALLBACK_PATH: &str = "/oauth2/callback";
const SCOPES: &str = "openid profile email";
const AUTH_TIMEOUT: Duration = Duration::from_secs(180);
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CALLBACK_BYTES: usize = 16 * 1024;
const MAX_PORTAL_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_SKILLHUB_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PortalAuthMode {
    Login,
    Link,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortalProductSession {
    #[serde(skip_serializing)]
    token: String,
    token_type: String,
    expires_in: u64,
    user: PortalProductUser,
    space: Option<crate::server_request::SpaceHandle>,
}

impl Drop for PortalProductSession {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortalProductUser {
    id: String,
    email: String,
    display_name: String,
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default)]
    marketplace_role: Option<String>,
    #[serde(default)]
    yitan_account_linked: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductSessionResponse {
    token: String,
    token_type: String,
    expires_in: u64,
    user: PortalProductUser,
}

impl ProductSessionResponse {
    fn validate(self) -> Result<PortalProductSession, String> {
        if self.token.trim() != self.token
            || self.token.is_empty()
            || self.token.len() > 16 * 1024
            || self.token.chars().any(char::is_whitespace)
            || self.token_type != "Bearer"
            || self.expires_in == 0
            || Uuid::parse_str(&self.user.id).is_err()
            || self.user.email.trim().is_empty()
            || self.user.display_name.trim().is_empty()
        {
            return Err("SkillHub 登录响应无效，请重试".into());
        }
        Ok(PortalProductSession {
            token: self.token,
            token_type: self.token_type,
            expires_in: self.expires_in,
            user: self.user,
            space: None,
        })
    }
}

struct SecretString(String);

impl SecretString {
    fn new(value: String) -> Self {
        Self(value)
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

struct SecretBytes(Vec<u8>);

impl SecretBytes {
    fn with_capacity(capacity: usize) -> Self {
        Self(Vec::with_capacity(capacity))
    }

    fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Debug, Deserialize)]
struct PortalTokenResponse {
    access_token: String,
    id_token: String,
    #[serde(default)]
    refresh_token: String,
}

impl Drop for PortalTokenResponse {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.id_token.zeroize();
        self.refresh_token.zeroize();
    }
}

struct PortalTokens {
    access_token: String,
    id_token: String,
    refresh_token: String,
}

impl PortalTokens {
    fn validate(mut value: PortalTokenResponse) -> Result<Self, String> {
        if value.access_token.trim() != value.access_token
            || value.id_token.trim() != value.id_token
            || value.access_token.is_empty()
            || value.id_token.is_empty()
            || value.access_token.len() > 16 * 1024
            || value.id_token.len() > 16 * 1024
            || value.access_token.chars().any(char::is_whitespace)
            || value.id_token.chars().any(char::is_whitespace)
        {
            return Err("一探账号门户返回了无效凭证，请重试".into());
        }
        Ok(Self {
            access_token: std::mem::take(&mut value.access_token),
            id_token: std::mem::take(&mut value.id_token),
            // The client never asks for offline_access. If the realm still returns a
            // refresh token, retain it only long enough to zeroize it on this stack.
            refresh_token: std::mem::take(&mut value.refresh_token),
        })
    }
}

impl Drop for PortalTokens {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.id_token.zeroize();
        self.refresh_token.zeroize();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PortalExchangeRequest<'a> {
    access_token: &'a str,
    id_token: &'a str,
    nonce: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_local_user_id: Option<&'a str>,
}

struct ActivePortalAuth {
    id: Uuid,
    cancel: watch::Sender<bool>,
}

#[derive(Clone, Default)]
pub(crate) struct PortalAuthState {
    active: Arc<Mutex<Option<ActivePortalAuth>>>,
    migration: Arc<Mutex<MigrationSlot>>,
}

#[derive(Default)]
struct MigrationSlot {
    attempt: u64,
    credential: Option<(String, zeroize::Zeroizing<String>)>,
}

impl PortalAuthState {
    pub(crate) fn commit_if_active<T>(
        &self,
        id: Uuid,
        write: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "一探账号登录状态不可用，请重启 APP")?;
        if active
            .as_ref()
            .is_none_or(|active| active.id != id || *active.cancel.borrow())
        {
            return Err("一探账号登录已取消".into());
        }
        write()
    }

    pub(crate) fn begin_migration(&self) -> Result<u64, String> {
        self.cancel()?;
        let mut slot = self.migration.lock().map_err(|_| "旧账号迁移状态不可用")?;
        slot.attempt = slot.attempt.checked_add(1).ok_or("旧账号迁移状态不可用")?;
        slot.credential = None;
        Ok(slot.attempt)
    }

    pub(crate) fn hold_migration(
        &self,
        attempt: u64,
        user: String,
        token: zeroize::Zeroizing<String>,
    ) -> Result<(), String> {
        let mut slot = self.migration.lock().map_err(|_| "旧账号迁移状态不可用")?;
        if slot.attempt != attempt {
            return Err("旧账号迁移已取消，请重新登录".into());
        }
        slot.credential = Some((user, token));
        Ok(())
    }

    fn take_migration(&self, expected: &str) -> Result<Option<SecretString>, String> {
        let mut slot = self.migration.lock().map_err(|_| "旧账号迁移状态不可用")?;
        Ok(slot
            .credential
            .take()
            .filter(|(user, _)| user == expected)
            .map(|(_, token)| SecretString::new(token.to_string())))
    }

    fn begin(&self) -> Result<(Uuid, watch::Receiver<bool>), String> {
        let id = Uuid::new_v4();
        let (cancel, receiver) = watch::channel(false);
        let previous = {
            let mut active = self
                .active
                .lock()
                .map_err(|_| "一探账号登录状态不可用，请重启 APP".to_string())?;
            active.replace(ActivePortalAuth { id, cancel })
        };
        if let Some(previous) = previous {
            previous.cancel.send_replace(true);
        }
        Ok((id, receiver))
    }

    fn finish(&self, id: Uuid) {
        if let Ok(mut active) = self.active.lock() {
            if active.as_ref().map(|value| value.id) == Some(id) {
                active.take();
            }
        }
    }

    pub(crate) fn cancel(&self) -> Result<bool, String> {
        let mut slot = self.migration.lock().map_err(|_| "旧账号迁移状态不可用")?;
        slot.credential = None;
        slot.attempt = slot.attempt.checked_add(1).ok_or("旧账号迁移状态不可用")?;
        drop(slot);
        let current = self
            .active
            .lock()
            .map_err(|_| "一探账号登录状态不可用，请重启 APP".to_string())?
            .take();
        if let Some(current) = current {
            current.cancel.send_replace(true);
            return Ok(true);
        }
        Ok(false)
    }
}

fn random_urlsafe(byte_count: usize) -> String {
    let mut bytes = Vec::with_capacity(byte_count);
    while bytes.len() < byte_count {
        bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    }
    bytes.truncate(byte_count);
    let encoded = URL_SAFE_NO_PAD.encode(&bytes);
    bytes.zeroize();
    encoded
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorization_url(
    redirect_uri: &str,
    state: &str,
    nonce: &str,
    challenge: &str,
    mode: PortalAuthMode,
) -> Result<Url, String> {
    let mut url =
        Url::parse(PORTAL_AUTHORIZE_URL).map_err(|_| "一探账号门户地址配置无效".to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", CLIENT_ID)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("scope", SCOPES)
            .append_pair("state", state)
            .append_pair("nonce", nonce)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("response_mode", "query");
        if mode == PortalAuthMode::Link {
            // Linking changes account ownership, so force a recent, deliberate
            // portal authentication instead of silently reusing an old SSO tab.
            query.append_pair("prompt", "login");
        }
    }
    Ok(url)
}

fn form_body(pairs: &[(&str, &str)]) -> Result<String, String> {
    let mut url =
        Url::parse("https://form.invalid/").map_err(|_| "一探账号门户请求配置无效".to_string())?;
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in pairs {
            query.append_pair(key, value);
        }
    }
    Ok(url.query().unwrap_or_default().to_string())
}

#[cfg(test)]
fn skillhub_api_url(suffix: &str) -> Result<Url, String> {
    if !suffix.starts_with('/') || suffix.contains(['?', '#']) {
        return Err("SkillHub 登录服务路径无效".into());
    }
    let mut url = crate::runtime_env::trusted_server_origin()?;
    let base = url.path().trim_end_matches('/');
    url.set_path(&format!("{base}{suffix}"));
    Ok(url)
}

fn portal_http_client(base: &Url) -> Result<Client, String> {
    crate::net::client_builder(base)?
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .user_agent(concat!(
            "Yitan-SkillHub/",
            env!("CARGO_PKG_VERSION"),
            " portal-auth"
        ))
        .build()
        .map_err(|_| "无法初始化一探账号门户连接".to_string())
}

async fn response_bytes(
    mut response: reqwest::Response,
    max_bytes: usize,
    message: &str,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(message.into());
    }
    let mut bytes = Vec::new();
    loop {
        let chunk = match response.chunk().await {
            Ok(chunk) => chunk,
            Err(_) => {
                bytes.zeroize();
                return Err(message.into());
            }
        };
        let Some(chunk) = chunk else {
            return Ok(bytes);
        };
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            bytes.zeroize();
            return Err(message.into());
        }
        bytes.extend_from_slice(&chunk);
    }
}

async fn exchange_code(
    client: &Client,
    code: &SecretString,
    verifier: &SecretString,
    redirect_uri: &str,
) -> Result<PortalTokens, String> {
    let mut body = form_body(&[
        ("grant_type", "authorization_code"),
        ("client_id", CLIENT_ID),
        ("code", code.as_str()),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier.as_str()),
    ])?;
    let response = client
        .post(PORTAL_TOKEN_URL)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .body(body.clone())
        .send()
        .await
        .map_err(|_| "无法连接一探账号门户，请检查网络后重试".to_string());
    body.zeroize();
    let response = response?;
    let status = response.status();
    let mut bytes = response_bytes(
        response,
        MAX_PORTAL_RESPONSE_BYTES,
        "一探账号门户响应无效，请重试",
    )
    .await?;
    let parsed = if status.is_success() {
        serde_json::from_slice::<PortalTokenResponse>(&bytes)
            .map_err(|_| "一探账号门户响应无效，请重试".to_string())
            .and_then(PortalTokens::validate)
    } else {
        Err(
            if status == StatusCode::BAD_REQUEST || status == StatusCode::UNAUTHORIZED {
                "一探账号门户未接受本次登录，请重新登录".into()
            } else {
                "一探账号门户暂时不可用，请稍后重试".into()
            },
        )
    };
    bytes.zeroize();
    parsed
}

#[derive(Deserialize)]
struct SkillHubErrorResponse {
    #[serde(default)]
    code: String,
    #[serde(default)]
    error: String,
}

fn skillhub_error_message(status: StatusCode, bytes: &[u8]) -> String {
    let error = serde_json::from_slice::<SkillHubErrorResponse>(bytes).ok();
    let code = error.as_ref().map(|value| {
        if value.code.is_empty() {
            value.error.as_str()
        } else {
            value.code.as_str()
        }
    });
    match code {
        Some("ACCOUNT_LINK_REQUIRED" | "YITAN_ACCOUNT_LINK_REQUIRED") => {
            "此邮箱已有 SkillHub 账号，请先用原账号登录后完成一次绑定".into()
        }
        Some("IDENTITY_ALREADY_LINKED" | "YITAN_IDENTITY_ALREADY_LINKED") => {
            "该一探账号已绑定其他 SkillHub 账号".into()
        }
        Some("LOCAL_ACCOUNT_ALREADY_LINKED" | "YITAN_LOCAL_ACCOUNT_ALREADY_LINKED") => {
            "当前 SkillHub 账号已绑定其他一探账号".into()
        }
        Some("YITAN_LOCAL_USER_MISMATCH") => "绑定期间 SkillHub 账号已切换，请重新操作".into(),
        Some("LEGACY_MIGRATION_NOT_ALLOWED") => "当前账号暂未开放迁移，请稍后再试".into(),
        Some("OIDC_TOKEN_INVALID" | "YITAN_TOKEN_INVALID") => {
            "一探账号登录已失效，请重新登录".into()
        }
        Some("AUTH_RECENT_LOGIN_REQUIRED" | "YITAN_REAUTH_REQUIRED") => {
            "为保护账号安全，请重新登录一探账号后再绑定".into()
        }
        Some("YITAN_VERIFIED_EMAIL_REQUIRED") => "请先在一探账号门户验证邮箱".into(),
        Some("YITAN_AUTH_DISABLED") => "一探账号登录尚未开放，请稍后再试".into(),
        Some("INVALID_YITAN_TOKEN_REQUEST") => "一探账号登录请求无效，请更新 APP 后重试".into(),
        _ if status == StatusCode::UNAUTHORIZED => {
            "当前 SkillHub 登录或一探账号登录已失效，请重新登录".into()
        }
        _ if status == StatusCode::TOO_MANY_REQUESTS => "尝试次数过多，请稍后再试".into(),
        _ => format!("SkillHub 账号服务暂时不可用 ({status})"),
    }
}

async fn exchange_with_skillhub(
    registry: &crate::server_request::SpaceRegistry,
    mode: PortalAuthMode,
    tokens: &PortalTokens,
    nonce: &SecretString,
    expected_local_user_id: Option<&str>,
    product_bearer: Option<&str>,
) -> Result<PortalProductSession, String> {
    let mut request = registry
        .portal_request(mode)?
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .json(&PortalExchangeRequest {
            access_token: &tokens.access_token,
            id_token: &tokens.id_token,
            nonce: nonce.as_str(),
            expected_local_user_id,
        });
    if let Some(token) = product_bearer {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "无法连接 SkillHub 账号服务，请检查网络后重试".to_string())?;
    let status = response.status();
    let mut bytes = response_bytes(
        response,
        MAX_SKILLHUB_RESPONSE_BYTES,
        "SkillHub 账号服务响应无效，请重试",
    )
    .await?;
    let parsed = if status.is_success() {
        serde_json::from_slice::<ProductSessionResponse>(&bytes)
            .map_err(|_| "SkillHub 登录响应无效，请重试".to_string())
            .and_then(ProductSessionResponse::validate)
    } else {
        Err(skillhub_error_message(status, &bytes))
    };
    bytes.zeroize();
    parsed
}

enum CallbackDecision {
    Complete(SecretString),
    Cancel,
    Ignore,
}

enum LinkProductSession {
    Runtime(crate::runtime_env::RuntimeSession),
    Transient {
        user_id: String,
        auth_token: SecretString,
    },
}

impl LinkProductSession {
    fn user_id(&self) -> &str {
        match self {
            Self::Runtime(session) => session.user_id(),
            Self::Transient { user_id, .. } => user_id,
        }
    }

    fn auth_token(&self) -> Option<&str> {
        match self {
            Self::Runtime(session) => session.auth_token(),
            Self::Transient { auth_token, .. } => Some(auth_token.as_str()),
        }
    }
}

fn link_credential(
    expected_user_id: Option<&str>,
    migration: Option<SecretString>,
    runtime: Option<crate::runtime_env::RuntimeSession>,
) -> Result<LinkProductSession, String> {
    let expected = expected_user_id
        .filter(|value| Uuid::parse_str(value).is_ok())
        .ok_or("绑定的一探账号目标无效，请重新打开账号设置")?;
    if let Some(auth_token) = migration {
        crate::runtime_env::validate_auth_token(auth_token.as_str())?;
        return Ok(LinkProductSession::Transient {
            user_id: expected.to_string(),
            auth_token,
        });
    }
    let session = runtime.ok_or("请先登录现有 SkillHub 账号，再绑定一探账号")?;
    if session.space_id() != "official"
        || session.is_sync_pending()
        || session.auth_token().is_none()
    {
        return Err("请先登录现有 SkillHub 账号，再绑定一探账号".into());
    }
    if session.user_id() != expected {
        return Err("APP 与本机运行时账号不一致，请重新登录后再绑定".into());
    }
    Ok(LinkProductSession::Runtime(session))
}

fn unique_query_values(url: &Url) -> Result<BTreeMap<String, String>, ()> {
    let mut values = BTreeMap::new();
    for (key, value) in url.query_pairs() {
        if values
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err(());
        }
    }
    Ok(values)
}

fn state_matches(actual: &str, expected: &str) -> bool {
    if actual.len() != expected.len() {
        return false;
    }
    actual
        .as_bytes()
        .iter()
        .zip(expected.as_bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn parse_callback_request(request: &[u8], expected_state: &str) -> CallbackDecision {
    let request = match std::str::from_utf8(request) {
        Ok(value) => value,
        Err(_) => return CallbackDecision::Ignore,
    };
    let mut parts = match request.lines().next() {
        Some(line) => line.split_whitespace(),
        None => return CallbackDecision::Ignore,
    };
    if parts.next() != Some("GET") {
        return CallbackDecision::Ignore;
    }
    let target = match parts.next() {
        Some(value) if value.starts_with('/') && !value.starts_with("//") => value,
        _ => return CallbackDecision::Ignore,
    };
    if target.split('?').next() != Some(CALLBACK_PATH) {
        return CallbackDecision::Ignore;
    }
    if !matches!(parts.next(), Some("HTTP/1.0") | Some("HTTP/1.1")) || parts.next().is_some() {
        return CallbackDecision::Ignore;
    }
    let url = match Url::parse(&format!("http://127.0.0.1{target}")) {
        Ok(value) if value.path() == CALLBACK_PATH && value.fragment().is_none() => value,
        _ => return CallbackDecision::Ignore,
    };
    let values = match unique_query_values(&url) {
        Ok(values) => values,
        Err(_) => return CallbackDecision::Ignore,
    };
    let allowed = [
        "code",
        "error",
        "error_description",
        "iss",
        "session_state",
        "state",
    ];
    if values.keys().any(|key| !allowed.contains(&key.as_str()))
        || !values
            .get("state")
            .is_some_and(|actual| state_matches(actual, expected_state))
        || values
            .get("iss")
            .is_some_and(|issuer| issuer != PORTAL_ISSUER)
    {
        return CallbackDecision::Ignore;
    }
    if values.contains_key("error") {
        return CallbackDecision::Cancel;
    }
    match values.get("code") {
        Some(code)
            if !code.is_empty()
                && code.len() <= 8 * 1024
                && !code.chars().any(char::is_control)
                && !code.chars().any(char::is_whitespace) =>
        {
            CallbackDecision::Complete(SecretString::new(code.clone()))
        }
        _ => CallbackDecision::Ignore,
    }
}

async fn read_callback_headers(stream: &mut TcpStream) -> Result<SecretBytes, String> {
    // The loopback request target contains the one-time authorization code.
    // Keep the complete header buffer in a zeroizing wrapper on every success
    // and error path instead of relying on allocator reuse after Vec::drop.
    let mut request = SecretBytes::with_capacity(2048);
    loop {
        if request.0.len() >= MAX_CALLBACK_BYTES {
            return Err("一探账号回调请求过大".into());
        }
        let mut buffer = [0_u8; 2048];
        let read = tokio::time::timeout(CALLBACK_READ_TIMEOUT, stream.read(&mut buffer))
            .await
            .map_err(|_| "一探账号回调读取超时".to_string())?
            .map_err(|_| "无法读取一探账号回调".to_string())?;
        if read == 0 {
            return Err("一探账号回调不完整".into());
        }
        request.0.extend_from_slice(&buffer[..read]);
        if request.0.len() > MAX_CALLBACK_BYTES {
            return Err("一探账号回调请求过大".into());
        }
        if request.0.windows(4).any(|window| window == b"\r\n\r\n")
            || request.0.windows(2).any(|window| window == b"\n\n")
        {
            return Ok(request);
        }
    }
}

async fn write_callback_page(stream: &mut TcpStream, success: bool) {
    let (status, body) = if success {
        (
            "200 OK",
            "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>登录完成</title><style>body{font:16px system-ui;margin:12vh auto;max-width:34rem;padding:2rem;color:#20242c}small{color:#69707d}</style><h1>已返回一探 SkillHub</h1><small>可以关闭此页面，继续使用 APP。</small>",
        )
    } else {
        (
            "400 Bad Request",
            "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>回调无效</title><style>body{font:16px system-ui;margin:12vh auto;max-width:34rem;padding:2rem;color:#20242c}small{color:#69707d}</style><h1>这不是有效的登录回调</h1><small>请返回一探 SkillHub 重试。</small>",
        )
    };
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(headers.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn wait_for_callback(
    listener: TcpListener,
    expected_state: &str,
) -> Result<SecretString, String> {
    loop {
        let (mut stream, peer) = listener
            .accept()
            .await
            .map_err(|_| "无法接收一探账号登录回调".to_string())?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let request = match read_callback_headers(&mut stream).await {
            Ok(request) => request,
            Err(_) => {
                write_callback_page(&mut stream, false).await;
                continue;
            }
        };
        match parse_callback_request(request.as_slice(), expected_state) {
            CallbackDecision::Complete(code) => {
                write_callback_page(&mut stream, true).await;
                return Ok(code);
            }
            CallbackDecision::Cancel => {
                write_callback_page(&mut stream, true).await;
                return Err("一探账号登录已取消".into());
            }
            CallbackDecision::Ignore => write_callback_page(&mut stream, false).await,
        }
    }
}

async fn run_portal_auth(
    registry: &crate::server_request::SpaceRegistry,
    mode: PortalAuthMode,
    mut cancel: watch::Receiver<bool>,
    expected_user_id: Option<&str>,
    legacy_auth_token: Option<SecretString>,
    runtime: Option<crate::runtime_env::RuntimeSession>,
    use_other_account: bool,
) -> Result<PortalProductSession, String> {
    let product_session = match mode {
        PortalAuthMode::Login => None,
        PortalAuthMode::Link => Some(link_credential(
            expected_user_id,
            legacy_auth_token,
            runtime,
        )?),
    };

    let (tokens, nonce) = portal_credentials(
        if use_other_account {
            PortalAuthMode::Link
        } else {
            mode
        },
        &mut cancel,
    )
    .await?;
    let product_request = exchange_with_skillhub(
        registry,
        mode,
        &tokens,
        &nonce,
        product_session.as_ref().map(LinkProductSession::user_id),
        product_session
            .as_ref()
            .and_then(LinkProductSession::auth_token),
    );
    let product = tokio::select! {
        biased;
        _ = cancel.changed() => return Err("一探账号登录已取消".into()),
        result = product_request => result?,
    };
    let public = serde_json::to_value(&product).map_err(|_| "SkillHub 登录响应无效，请重试")?;
    for secret in [
        Some(product.token.as_str()),
        Some(tokens.access_token.as_str()),
        Some(tokens.id_token.as_str()),
        Some(tokens.refresh_token.as_str()),
        product_session
            .as_ref()
            .and_then(LinkProductSession::auth_token),
    ]
    .into_iter()
    .flatten()
    .filter(|secret| !secret.is_empty())
    {
        if crate::server_request::json_contains_token(&public, secret) {
            return Err("SkillHub 响应包含会话凭据，已拒绝返回".into());
        }
    }
    if let Some(snapshot) = product_session.as_ref() {
        if product.user.id != snapshot.user_id() {
            return Err("绑定期间 SkillHub 账号已切换，请重新操作".into());
        }
        if let LinkProductSession::Runtime(snapshot) = snapshot {
            if registry.snapshot(false).await?.as_ref() != Some(snapshot) {
                return Err("绑定期间 SkillHub 账号已切换，请重新操作".into());
            }
        }
    }
    Ok(product)
}

async fn portal_credentials(
    mode: PortalAuthMode,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(PortalTokens, SecretString), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| "无法启动一探账号安全回调，请检查本机网络权限".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "无法确定一探账号安全回调端口".to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let verifier = SecretString::new(random_urlsafe(48));
    let state = SecretString::new(random_urlsafe(32));
    let nonce = SecretString::new(random_urlsafe(32));
    let challenge = pkce_challenge(verifier.as_str());
    let authorize_url = authorization_url(
        &redirect_uri,
        state.as_str(),
        nonce.as_str(),
        &challenge,
        mode,
    )?;
    open::that(authorize_url.as_str())
        .map_err(|_| "无法打开系统浏览器，请检查默认浏览器设置".to_string())?;
    drop(authorize_url);

    let callback = wait_for_callback(listener, state.as_str());
    let code = tokio::select! {
        biased;
        _ = cancel.changed() => return Err("一探账号登录已取消".into()),
        result = tokio::time::timeout(AUTH_TIMEOUT, callback) => {
            result.map_err(|_| "一探账号登录已超时，请重试".to_string())??
        }
    };

    let client =
        portal_http_client(&Url::parse(PORTAL_TOKEN_URL).map_err(|_| "一探账号门户地址无效")?)?;
    let tokens = tokio::select! {
        biased;
        _ = cancel.changed() => return Err("一探账号登录已取消".into()),
        result = exchange_code(&client, &code, &verifier, &redirect_uri) => result?,
    };
    Ok((tokens, nonce))
}

static CATALOG_LOGIN: std::sync::LazyLock<PortalAuthState> =
    std::sync::LazyLock::new(PortalAuthState::default);

#[tauri::command]
pub(crate) fn cancel_catalog_login() -> Result<bool, String> {
    CATALOG_LOGIN.cancel()
}

#[tauri::command]
pub(crate) async fn start_catalog_login(
    registry: State<'_, crate::server_request::SpaceRegistry>,
    expected_user_id: Option<String>,
) -> Result<crate::catalog_session::SessionStatus, String> {
    let (id, mut cancel) = CATALOG_LOGIN.begin()?;
    let result = async {
        if expected_user_id.is_some() { crate::catalog_session::clear(registry.migration_root())?; }
        let (tokens, nonce) = portal_credentials(PortalAuthMode::Login, &mut cancel).await?;
        let origin = crate::catalog::origin()?;
        let url = Url::parse(&format!("{origin}/api/auth/yitan/exchange")).map_err(|_| "商店地址无效")?;
        let request = crate::net::client_builder(&url)?
            .redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(20))
            .build().map_err(|_| "无法连接商店")?.post(url)
            .json(&serde_json::json!({"accessToken": tokens.access_token, "idToken": tokens.id_token, "nonce": nonce.as_str(), "purpose": "catalog"}));
        let response = tokio::select! {
            biased;
            _ = cancel.changed() => return Err("一探账号登录已取消".into()),
            result = request.send() => result.map_err(|_| "无法连接商店，请稍后重试")?,
        };
        let status = response.status();
        let bytes = zeroize::Zeroizing::new(response_bytes(response, MAX_SKILLHUB_RESPONSE_BYTES, "商店登录响应无效").await?);
        if !status.is_success() { return Err(skillhub_error_message(status, &bytes)); }
        let session = crate::catalog_session::decode_exchange(&bytes, origin, &[&tokens.access_token, &tokens.id_token, &tokens.refresh_token])?;
        if expected_user_id.as_deref().is_some_and(|id| !crate::catalog_session::belongs_to(&session, id)) {
            return Err("浏览器中的一探账号与原官方账号不同，请在设置中重新登录商店".into());
        }
        CATALOG_LOGIN.commit_if_active(id, || crate::catalog_session::save(registry.migration_root(), &session))
    }.await;
    CATALOG_LOGIN.finish(id);
    result
}

#[tauri::command]
pub(crate) async fn start_yitan_portal_auth(
    registry: State<'_, crate::server_request::SpaceRegistry>,
    mode: PortalAuthMode,
    expected_user_id: Option<String>,
    space: Option<crate::server_request::SpaceHandle>,
    use_other_account: Option<bool>,
) -> Result<PortalProductSession, String> {
    if mode == PortalAuthMode::Login && expected_user_id.is_some() {
        return Err("一探账号登录请求无效".into());
    }
    let controller = &registry.portal;
    if let Some(space) = space {
        let candidate = registry
            .candidate_snapshot(&space)?
            .ok_or("切换候选已失效")?;
        if candidate.space_id() != "official" || mode != PortalAuthMode::Login {
            return Err("候选空间仅支持官方登录".into());
        }
        controller.cancel()?;
        let (id, cancel) = controller.begin()?;
        let result = run_portal_auth(
            &registry,
            mode,
            cancel,
            None,
            None,
            None,
            use_other_account.unwrap_or(false),
        )
        .await;
        let mut product = match result {
            Ok(product) => product,
            Err(error) => {
                controller.finish(id);
                return Err(error);
            }
        };
        let staged = controller.commit_if_active(id, || {
            registry.establish_candidate(&candidate, &product.token, &product.user.id)
        });
        controller.finish(id);
        product.token.zeroize();
        product.space = Some(staged?);
        return Ok(product);
    }
    let previous = registry.snapshot(false).await?;
    if previous
        .as_ref()
        .is_some_and(|session| session.space_id() != "official")
    {
        return Err("此空间不支持一探门户登录".into());
    }
    let legacy = if mode == PortalAuthMode::Link {
        controller.take_migration(
            expected_user_id
                .as_deref()
                .ok_or("绑定的一探账号目标无效，请重新打开账号设置")?,
        )?
    } else {
        controller.cancel()?;
        None
    };
    let transition = registry.transition(previous.as_ref()).await?;
    let (id, cancel) = controller.begin()?;
    let result = run_portal_auth(
        &registry,
        mode,
        cancel,
        expected_user_id.as_deref(),
        legacy,
        previous.clone(),
        use_other_account.unwrap_or(false),
    )
    .await;
    let mut product = match result {
        Ok(product) => product,
        Err(error) => {
            controller.finish(id);
            return Err(error);
        }
    };
    // Never let a late link (including the in-memory migration path) replace a newer space.
    let committed = transition
        .commit(Some((&product.token, &product.user.id)), Some(id))
        .await;
    controller.finish(id);
    product.token.zeroize();
    product.space = Some(committed.map_err(|error| {
        if mode == PortalAuthMode::Link && error == "SkillHub 空间或账号已切换，本次请求结果已丢弃"
        {
            "绑定期间 SkillHub 账号已切换，请重新操作".to_string()
        } else {
            error
        }
    })?);
    Ok(product)
}

#[tauri::command]
pub(crate) fn cancel_yitan_portal_auth(
    registry: State<'_, crate::server_request::SpaceRegistry>,
) -> Result<bool, String> {
    registry.portal.cancel()
}

#[tauri::command]
pub(crate) fn open_yitan_account_portal() -> Result<(), String> {
    open::that(PORTAL_ACCOUNT_URL)
        .map_err(|_| "无法打开一探账号门户，请检查默认浏览器设置".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_slot_is_consumed_and_cleared_on_cancel_new_attempt_and_mismatch() {
        let state = PortalAuthState::default();
        for action in ["consume", "cancel", "new", "mismatch"] {
            let attempt = state.begin_migration().unwrap();
            state
                .hold_migration(
                    attempt,
                    "user".into(),
                    zeroize::Zeroizing::new("migration.jwt".into()),
                )
                .unwrap();
            match action {
                "consume" => assert_eq!(
                    state.take_migration("user").unwrap().unwrap().as_str(),
                    "migration.jwt"
                ),
                "cancel" => {
                    state.cancel().unwrap();
                }
                "new" => {
                    state.begin_migration().unwrap();
                }
                _ => assert!(state.take_migration("other").unwrap().is_none()),
            }
            assert!(state.take_migration("user").unwrap().is_none());
        }
        let attempt = state.begin_migration().unwrap();
        state.cancel().unwrap();
        assert!(state
            .hold_migration(
                attempt,
                "user".into(),
                zeroize::Zeroizing::new("late.jwt".into())
            )
            .is_err());
    }

    #[test]
    fn link_uses_matching_migration_or_runtime_and_rejects_a_different_user() {
        let root = std::env::temp_dir().join(format!("skillhub-link-{}", Uuid::new_v4()));
        let user = Uuid::new_v4().to_string();
        crate::runtime_env::test_sessions::sign_in(&root, &user);
        let snapshot = crate::runtime_env::runtime_session_snapshot_at(&root).unwrap();
        let transient = link_credential(
            Some(&user),
            Some(SecretString::new("migration.jwt".into())),
            Some(snapshot.clone()),
        )
        .unwrap();
        assert_eq!(transient.auth_token(), Some("migration.jwt"));
        let runtime = link_credential(Some(&user), None, Some(snapshot.clone())).unwrap();
        assert_eq!(runtime.auth_token(), snapshot.auth_token());
        assert!(link_credential(Some(&Uuid::new_v4().to_string()), None, Some(snapshot)).is_err());
        assert!(link_credential(Some(&user), None, None).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancelled_or_superseded_portal_cannot_commit_even_with_a_ready_result() {
        let state = PortalAuthState::default();
        let (old, _receiver) = state.begin().unwrap();
        state.cancel().unwrap();
        assert!(state
            .commit_if_active::<()>(old, || panic!("cancelled result committed"))
            .is_err());
        let (old, _receiver) = state.begin().unwrap();
        let (current, _receiver) = state.begin().unwrap();
        assert!(state
            .commit_if_active::<()>(old, || panic!("superseded result committed"))
            .is_err());
        assert_eq!(state.commit_if_active(current, || Ok(7)).unwrap(), 7);
    }

    #[test]
    fn pkce_s256_matches_the_rfc_7636_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            pkce_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn authorize_url_uses_loopback_state_nonce_and_no_refresh_scope() {
        let url = authorization_url(
            "http://127.0.0.1:43123/oauth2/callback",
            "state-value",
            "nonce-value",
            "challenge-value",
            PortalAuthMode::Login,
        )
        .expect("authorize URL");
        let values = unique_query_values(&url).expect("unique query");
        assert_eq!(url.scheme(), "https");
        assert_eq!(
            values.get("response_type").map(String::as_str),
            Some("code")
        );
        assert_eq!(values.get("client_id").map(String::as_str), Some(CLIENT_ID));
        assert_eq!(
            values.get("redirect_uri").map(String::as_str),
            Some("http://127.0.0.1:43123/oauth2/callback")
        );
        assert_eq!(values.get("state").map(String::as_str), Some("state-value"));
        assert_eq!(values.get("nonce").map(String::as_str), Some("nonce-value"));
        assert_eq!(
            values.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(values.get("scope").map(String::as_str), Some(SCOPES));
        assert!(!url.as_str().contains("offline_access"));
        assert!(!url.as_str().contains("client_secret"));
    }

    #[test]
    fn link_authorization_requires_a_fresh_portal_login() {
        let url = authorization_url(
            "http://127.0.0.1:43123/oauth2/callback",
            "state-value",
            "nonce-value",
            "challenge-value",
            PortalAuthMode::Link,
        )
        .expect("authorize URL");
        let values = unique_query_values(&url).expect("unique query");
        assert_eq!(values.get("prompt").map(String::as_str), Some("login"));
    }

    #[test]
    fn link_exchange_binds_the_expected_local_user_without_changing_login_shape() {
        let login = serde_json::to_value(&PortalExchangeRequest {
            access_token: "access",
            id_token: "id",
            nonce: "nonce",
            expected_local_user_id: None,
        })
        .expect("serialize login exchange");
        assert!(login.get("expectedLocalUserId").is_none());

        let link = serde_json::to_value(&PortalExchangeRequest {
            access_token: "access",
            id_token: "id",
            nonce: "nonce",
            expected_local_user_id: Some("11111111-1111-4111-8111-111111111111"),
        })
        .expect("serialize link exchange");
        assert_eq!(
            link.get("expectedLocalUserId")
                .and_then(serde_json::Value::as_str),
            Some("11111111-1111-4111-8111-111111111111")
        );
    }

    #[test]
    fn callback_accepts_only_the_exact_path_and_state() {
        let valid = b"GET /oauth2/callback?code=one-time-code&state=expected HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        assert!(matches!(
            parse_callback_request(valid, "expected"),
            CallbackDecision::Complete(_)
        ));
        for invalid in [
            b"GET /oauth/callback?code=one-time-code&state=expected HTTP/1.1\r\n\r\n".as_slice(),
            b"GET /oauth2/../oauth2/callback?code=one-time-code&state=expected HTTP/1.1\r\n\r\n".as_slice(),
            b"GET /oauth2/callback?code=one-time-code&state=wrong HTTP/1.1\r\n\r\n".as_slice(),
            b"POST /oauth2/callback?code=one-time-code&state=expected HTTP/1.1\r\n\r\n".as_slice(),
            b"GET /oauth2/callback?code=first&code=second&state=expected HTTP/1.1\r\n\r\n".as_slice(),
            b"GET //evil.example/oauth2/callback?code=one-time-code&state=expected HTTP/1.1\r\n\r\n".as_slice(),
        ] {
            assert!(matches!(
                parse_callback_request(invalid, "expected"),
                CallbackDecision::Ignore
            ));
        }
    }

    #[test]
    fn callback_checks_optional_issuer_and_handles_portal_cancellation() {
        let wrong_issuer = b"GET /oauth2/callback?error=access_denied&state=expected&iss=https%3A%2F%2Fevil.example HTTP/1.1\r\n\r\n";
        assert!(matches!(
            parse_callback_request(wrong_issuer, "expected"),
            CallbackDecision::Ignore
        ));
        let cancel = b"GET /oauth2/callback?error=access_denied&state=expected&iss=https%3A%2F%2Faccount.whatonearth.work%2Frealms%2Fyitan HTTP/1.1\r\n\r\n";
        assert!(matches!(
            parse_callback_request(cancel, "expected"),
            CallbackDecision::Cancel
        ));
    }

    #[tokio::test]
    async fn loopback_listener_ignores_bad_state_and_consumes_one_valid_callback() {
        async fn send(addr: std::net::SocketAddr, target: &str) -> Vec<u8> {
            let mut stream = TcpStream::connect(addr).await.expect("connect callback");
            stream
                .write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
                .await
                .expect("write callback");
            let mut response = Vec::new();
            stream
                .read_to_end(&mut response)
                .await
                .expect("read callback response");
            response
        }

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind loopback");
        let addr = listener.local_addr().expect("callback address");
        let callback = tokio::spawn(async move { wait_for_callback(listener, "expected").await });

        let rejected = send(addr, "/oauth2/callback?code=attacker-code&state=wrong").await;
        assert!(String::from_utf8_lossy(&rejected).starts_with("HTTP/1.1 400"));

        let accepted = send(addr, "/oauth2/callback?code=one-time-code&state=expected").await;
        assert!(String::from_utf8_lossy(&accepted).starts_with("HTTP/1.1 200"));
        let code = callback
            .await
            .expect("callback task")
            .expect("valid callback");
        assert_eq!(code.as_str(), "one-time-code");
        assert!(TcpStream::connect(addr).await.is_err());
    }

    #[test]
    fn controller_cancels_and_replaces_an_active_transaction() {
        let state = PortalAuthState::default();
        let (first_id, mut first) = state.begin().expect("first transaction");
        let (second_id, _second) = state.begin().expect("second transaction");
        assert_ne!(first_id, second_id);
        assert!(*first.borrow_and_update());
        state.finish(first_id);
        assert!(state.cancel().expect("cancel second"));
        assert!(!state.cancel().expect("nothing left"));
    }

    #[test]
    fn skillhub_error_codes_are_presented_without_raw_server_details() {
        assert_eq!(
            skillhub_error_message(
                StatusCode::CONFLICT,
                br#"{"error":"YITAN_ACCOUNT_LINK_REQUIRED","message":"raw detail"}"#,
            ),
            "此邮箱已有 SkillHub 账号，请先用原账号登录后完成一次绑定"
        );
        assert_eq!(
            skillhub_error_message(
                StatusCode::UNAUTHORIZED,
                br#"{"error":"YITAN_REAUTH_REQUIRED","message":"raw detail"}"#,
            ),
            "为保护账号安全，请重新登录一探账号后再绑定"
        );
    }

    #[test]
    fn skillhub_endpoints_preserve_the_configured_base_path() {
        let exchange = skillhub_api_url("/api/auth/yitan/exchange").expect("exchange URL");
        let link = skillhub_api_url("/api/auth/yitan/link").expect("link URL");
        assert!(exchange
            .path()
            .ends_with("/skillhub/api/auth/yitan/exchange"));
        assert!(link.path().ends_with("/skillhub/api/auth/yitan/link"));
        assert!(exchange.query().is_none());
    }
}
