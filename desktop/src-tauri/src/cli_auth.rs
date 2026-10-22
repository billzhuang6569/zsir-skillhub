use crate::cli::{
    CliAccount, CliAccountState, CliCommandOutput, CliErrorCode, EXIT_AUTH, EXIT_INTERNAL,
    EXIT_NETWORK, EXIT_USAGE,
};
use crate::runtime_env::{
    acquire_current_session_lease, clear_runtime_session_if_current, runtime_session_is_current,
    runtime_session_snapshot, CurrentSessionLease, RuntimeSession,
};
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

const AUTH_STATUS_COMMAND: &str = "auth status";
const AUTH_STATUS_USAGE: &str = "用法：skillhub auth status [--refresh] --json";
const MAX_AUTH_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
struct AuthStatusArgs {
    refresh: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthMeResponse {
    user: PublicUser,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PublicUser {
    id: String,
    email: String,
    display_name: String,
    avatar_url: Option<String>,
    marketplace_role: String,
}

struct AuthHttpResponse {
    status: StatusCode,
    body: Vec<u8>,
}

enum AuthFetchError {
    Offline,
    ResponseTooLarge,
}

struct AuthApi {
    client: Client,
    me_url: reqwest::Url,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CliAuthGuardError {
    AuthRequired,
    AuthExpired,
    SyncPending,
    IdentityMismatch,
    AccountChanged,
    SessionUnsafe,
}

/// Account-bound CLI operations must capture this guard before contacting the
/// Server, use its token only inside the HTTP client, and call `verify_current`
/// before committing or emitting the result. A 401 must go through
/// `invalidate_unauthorized` so a stale request cannot clear a newer login.
pub(crate) struct CliAuthGuard {
    snapshot: RuntimeSession,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CliAccountVerificationError {
    Auth(CliAuthGuardError),
    Offline,
    PermissionDenied,
    InvalidResponse,
    ServerUnavailable,
    ClientConfiguration,
}

impl CliAuthGuard {
    pub(crate) fn origin(&self) -> Result<reqwest::Url, String> {
        self.snapshot.server_origin()
    }

    pub(crate) fn session(&self) -> &RuntimeSession {
        &self.snapshot
    }

    pub(crate) fn bind_catalog_template(
        &self,
        template: &reqwest::Url,
    ) -> Result<reqwest::Url, String> {
        let catalog =
            crate::spaces::normalize_base(&crate::official_channel::COMPILED.catalog_origin)?;
        let prefix = format!("{}/api/", catalog.path().trim_end_matches('/'));
        if template.origin() != catalog.origin() {
            return Err("API 路径无效".into());
        }
        let suffix = template
            .path()
            .strip_prefix(&prefix)
            .ok_or("API 路径无效")?;
        let mut target = self.origin()?;
        target.set_path(&format!(
            "{}/api/{suffix}",
            target.path().trim_end_matches('/')
        ));
        target.set_query(template.query());
        Ok(target)
    }
    pub(crate) fn capture() -> Result<Self, CliAuthGuardError> {
        let snapshot = runtime_session_snapshot().map_err(|_| CliAuthGuardError::SessionUnsafe)?;
        if snapshot.is_sync_pending() {
            return Err(CliAuthGuardError::SyncPending);
        }
        Ok(Self { snapshot })
    }

    pub(crate) fn user_id(&self) -> &str {
        self.snapshot.user_id()
    }

    pub(crate) fn token_for_request(&self) -> Result<&str, CliAuthGuardError> {
        self.verify_current()?;
        self.snapshot
            .auth_token()
            .ok_or(CliAuthGuardError::AuthRequired)
    }

    pub(crate) fn verify_current(&self) -> Result<(), CliAuthGuardError> {
        match runtime_session_is_current(&self.snapshot) {
            Ok(true) => Ok(()),
            Ok(false) => Err(CliAuthGuardError::AccountChanged),
            Err(_) => Err(CliAuthGuardError::SessionUnsafe),
        }
    }

    /// Keep the captured account stable across a short local commit. The APP
    /// may still prepare a new login concurrently, but its exclusive session
    /// transition waits until this lease is dropped.
    pub(crate) fn acquire_current_lease(&self) -> Result<CurrentSessionLease, CliAuthGuardError> {
        match acquire_current_session_lease(&self.snapshot) {
            Ok(Some(lease)) => Ok(lease),
            Ok(None) => Err(CliAuthGuardError::AccountChanged),
            Err(_) => Err(CliAuthGuardError::SessionUnsafe),
        }
    }

    pub(crate) fn invalidate_unauthorized(&self) -> CliAuthGuardError {
        match clear_runtime_session_if_current(&self.snapshot) {
            Ok(true) => CliAuthGuardError::AuthExpired,
            Ok(false) => CliAuthGuardError::AccountChanged,
            Err(_) => CliAuthGuardError::SessionUnsafe,
        }
    }

    pub(crate) fn verify_server_user_id(
        &self,
        server_user_id: &str,
    ) -> Result<(), CliAuthGuardError> {
        if server_user_id == self.user_id() {
            return self.verify_current();
        }
        match clear_runtime_session_if_current(&self.snapshot) {
            Ok(true) => Err(CliAuthGuardError::IdentityMismatch),
            Ok(false) => Err(CliAuthGuardError::AccountChanged),
            Err(_) => Err(CliAuthGuardError::SessionUnsafe),
        }
    }
}

impl AuthApi {
    fn new(guard: &CliAuthGuard) -> Result<Self, String> {
        let mut me_url = guard.origin()?;
        let base = me_url.path().trim_end_matches('/');
        me_url.set_path(&format!("{base}/api/auth/me"));
        let client = crate::net::client_builder(&me_url)?
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            .user_agent(concat!(
                "Yitan-SkillHub/",
                env!("CARGO_PKG_VERSION"),
                " cli-auth"
            ))
            .build()
            .map_err(|_| "无法初始化 SkillHub 账号连接".to_string())?;
        Ok(Self { client, me_url })
    }

    async fn me(&self, auth_token: &str) -> Result<AuthHttpResponse, AuthFetchError> {
        let mut response = self
            .client
            .get(self.me_url.clone())
            .bearer_auth(auth_token)
            .header(reqwest::header::CACHE_CONTROL, "no-store")
            .send()
            .await
            .map_err(|_| AuthFetchError::Offline)?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_AUTH_RESPONSE_BYTES as u64)
        {
            return Err(AuthFetchError::ResponseTooLarge);
        }
        let status = response.status();
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AuthFetchError::Offline)?
        {
            if body.len().saturating_add(chunk.len()) > MAX_AUTH_RESPONSE_BYTES {
                return Err(AuthFetchError::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(AuthHttpResponse { status, body })
    }
}

fn parse_auth_status_args(args: &[String]) -> Result<AuthStatusArgs, ()> {
    if args.first().map(String::as_str) != Some("auth")
        || args.get(1).map(String::as_str) != Some("status")
    {
        return Err(());
    }
    let mut refresh = false;
    let mut json = false;
    for flag in &args[2..] {
        match flag.as_str() {
            "--refresh" if !refresh => refresh = true,
            "--json" if !json => json = true,
            _ => return Err(()),
        }
    }
    if !json {
        return Err(());
    }
    Ok(AuthStatusArgs { refresh })
}

fn unknown_account() -> CliAccount {
    CliAccount::state(CliAccountState::Unknown)
}

pub(crate) fn auth_guard_failure(
    command: &'static str,
    error: CliAuthGuardError,
) -> CliCommandOutput {
    match error {
        CliAuthGuardError::AuthRequired => CliCommandOutput::failure(
            command,
            CliAccount::state(CliAccountState::Guest),
            CliErrorCode::AuthRequired,
            "此操作需要先在 SkillHub APP 登录",
            EXIT_AUTH,
            vec!["请打开 SkillHub APP 登录后重试".into()],
        ),
        CliAuthGuardError::AuthExpired => CliCommandOutput::failure(
            command,
            CliAccount::state(CliAccountState::Expired),
            CliErrorCode::AuthExpired,
            "SkillHub 登录已失效",
            EXIT_AUTH,
            vec!["请打开 SkillHub APP 重新登录".into()],
        ),
        CliAuthGuardError::SyncPending => CliCommandOutput::failure(
            command,
            CliAccount::state(CliAccountState::SyncPending),
            CliErrorCode::AuthSyncPending,
            "SkillHub APP 正在同步账号",
            EXIT_AUTH,
            vec!["请等待 APP 完成账号切换后重试".into()],
        ),
        CliAuthGuardError::IdentityMismatch => CliCommandOutput::failure(
            command,
            CliAccount::state(CliAccountState::Invalid),
            CliErrorCode::AuthIdentityMismatch,
            "Server 账号与本机会话不一致，已拒绝继续使用",
            EXIT_AUTH,
            vec!["请打开 SkillHub APP 重新登录".into()],
        ),
        CliAuthGuardError::AccountChanged => CliCommandOutput::failure(
            command,
            unknown_account(),
            CliErrorCode::AccountChanged,
            "SkillHub 账号在请求期间发生变化，本次结果已丢弃",
            EXIT_AUTH,
            vec!["请等待 APP 完成账号切换后重试".into()],
        ),
        CliAuthGuardError::SessionUnsafe => CliCommandOutput::failure(
            command,
            unknown_account(),
            CliErrorCode::AuthSessionUnsafe,
            "无法安全读取 SkillHub APP 登录状态",
            EXIT_AUTH,
            vec!["请重新打开 SkillHub APP；如仍失败，请在设置中修复 CLI".into()],
        ),
    }
}

fn validate_public_user(user: PublicUser) -> Result<PublicUser, ()> {
    uuid::Uuid::parse_str(&user.id).map_err(|_| ())?;
    if user.email.is_empty()
        || user.email.len() > 254
        || user.email.chars().any(char::is_whitespace)
        || !user.email.contains('@')
        || user.display_name.trim() != user.display_name
        || user.display_name.is_empty()
        || user.display_name.chars().count() > 50
        || user.display_name.chars().any(char::is_control)
        || !matches!(user.marketplace_role.as_str(), "user" | "admin")
    {
        return Err(());
    }
    if let Some(avatar_url) = user.avatar_url.as_deref() {
        let parsed = reqwest::Url::parse(avatar_url).map_err(|_| ())?;
        if parsed.scheme() != "https"
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(());
        }
    }
    Ok(user)
}

fn parse_me_response(body: &[u8]) -> Result<PublicUser, ()> {
    let payload = serde_json::from_slice::<AuthMeResponse>(body).map_err(|_| ())?;
    validate_public_user(payload.user)
}

pub(crate) async fn verify_account_with_server(
    guard: &CliAuthGuard,
) -> Result<CliAccount, CliAccountVerificationError> {
    crate::spaces::verify_remote_identity(&guard.snapshot)
        .await
        .map_err(|_| CliAccountVerificationError::ClientConfiguration)?;
    let api = match AuthApi::new(guard) {
        Ok(api) => api,
        Err(_) => return Err(CliAccountVerificationError::ClientConfiguration),
    };
    let auth_token = match guard.token_for_request() {
        Ok(auth_token) => auth_token,
        Err(error) => return Err(CliAccountVerificationError::Auth(error)),
    };
    let response = match api.me(auth_token).await {
        Ok(response) => response,
        Err(AuthFetchError::Offline) => {
            guard
                .verify_current()
                .map_err(CliAccountVerificationError::Auth)?;
            return Err(CliAccountVerificationError::Offline);
        }
        Err(AuthFetchError::ResponseTooLarge) => {
            guard
                .verify_current()
                .map_err(CliAccountVerificationError::Auth)?;
            return Err(CliAccountVerificationError::InvalidResponse);
        }
    };

    if response.status == StatusCode::UNAUTHORIZED {
        return Err(CliAccountVerificationError::Auth(
            guard.invalidate_unauthorized(),
        ));
    }
    if response.status == StatusCode::FORBIDDEN {
        guard
            .verify_current()
            .map_err(CliAccountVerificationError::Auth)?;
        return Err(CliAccountVerificationError::PermissionDenied);
    }
    if !response.status.is_success() {
        guard
            .verify_current()
            .map_err(CliAccountVerificationError::Auth)?;
        return Err(CliAccountVerificationError::ServerUnavailable);
    }

    let user = match parse_me_response(&response.body) {
        Ok(user) => user,
        Err(_) => {
            guard
                .verify_current()
                .map_err(CliAccountVerificationError::Auth)?;
            return Err(CliAccountVerificationError::InvalidResponse);
        }
    };
    guard
        .verify_server_user_id(&user.id)
        .map_err(CliAccountVerificationError::Auth)?;
    Ok(CliAccount::verified(
        user.id,
        user.email,
        user.display_name,
        user.avatar_url,
        user.marketplace_role,
    ))
}

pub(crate) fn account_verification_failure(
    command: &'static str,
    guard: &CliAuthGuard,
    error: CliAccountVerificationError,
) -> CliCommandOutput {
    match error {
        CliAccountVerificationError::Auth(error) => auth_guard_failure(command, error),
        CliAccountVerificationError::Offline => CliCommandOutput::failure(
            command,
            CliAccount::local(CliAccountState::Offline, guard.user_id()),
            CliErrorCode::Offline,
            "暂时无法连接 SkillHub Server；本机会话已保留",
            EXIT_NETWORK,
            vec!["请检查网络后重试".into()],
        ),
        CliAccountVerificationError::PermissionDenied => CliCommandOutput::failure(
            command,
            CliAccount::local(CliAccountState::Unverified, guard.user_id()),
            CliErrorCode::PermissionDenied,
            "当前账号无权读取账号资料",
            EXIT_AUTH,
            vec!["请在 SkillHub APP 中检查账号状态".into()],
        ),
        CliAccountVerificationError::InvalidResponse => CliCommandOutput::failure(
            command,
            CliAccount::local(CliAccountState::Unverified, guard.user_id()),
            CliErrorCode::InternalError,
            "SkillHub Server 返回了无效的账号资料",
            EXIT_INTERNAL,
            Vec::new(),
        ),
        CliAccountVerificationError::ServerUnavailable => CliCommandOutput::failure(
            command,
            CliAccount::local(CliAccountState::Unverified, guard.user_id()),
            CliErrorCode::InternalError,
            "SkillHub Server 暂时无法完成账号验证",
            EXIT_INTERNAL,
            vec!["请稍后重试".into()],
        ),
        CliAccountVerificationError::ClientConfiguration => CliCommandOutput::failure(
            command,
            unknown_account(),
            CliErrorCode::InternalError,
            "SkillHub 服务地址配置无效",
            EXIT_INTERNAL,
            Vec::new(),
        ),
    }
}

async fn refreshed_status(guard: CliAuthGuard) -> CliCommandOutput {
    if guard.token_for_request().is_err() {
        if let Err(error) = guard.verify_current() {
            return auth_guard_failure(AUTH_STATUS_COMMAND, error);
        }
        return CliCommandOutput::success(
            AUTH_STATUS_COMMAND,
            CliAccount::state(CliAccountState::Guest),
            json!({ "refreshRequested": true, "serverValidated": false }),
            Vec::new(),
            vec!["如需使用账号功能，请打开 SkillHub APP 登录".into()],
        );
    }
    match verify_account_with_server(&guard).await {
        Ok(account) => CliCommandOutput::success(
            AUTH_STATUS_COMMAND,
            account,
            json!({ "refreshRequested": true, "serverValidated": true }),
            Vec::new(),
            Vec::new(),
        ),
        Err(error) => account_verification_failure(AUTH_STATUS_COMMAND, &guard, error),
    }
}

pub(crate) async fn execute_auth_cli(args: &[String]) -> CliCommandOutput {
    let parsed = match parse_auth_status_args(args) {
        Ok(parsed) => parsed,
        Err(()) => {
            return CliCommandOutput::failure(
                AUTH_STATUS_COMMAND,
                unknown_account(),
                CliErrorCode::ValidationFailed,
                AUTH_STATUS_USAGE,
                EXIT_USAGE,
                Vec::new(),
            )
        }
    };
    let guard = match CliAuthGuard::capture() {
        Ok(guard) => guard,
        Err(error) => return auth_guard_failure(AUTH_STATUS_COMMAND, error),
    };
    if parsed.refresh {
        return refreshed_status(guard).await;
    }
    let account = if guard.token_for_request().is_ok() {
        CliAccount::local(CliAccountState::Unverified, guard.user_id())
    } else {
        CliAccount::state(CliAccountState::Guest)
    };
    if let Err(error) = guard.verify_current() {
        return auth_guard_failure(AUTH_STATUS_COMMAND, error);
    }
    CliCommandOutput::success(
        AUTH_STATUS_COMMAND,
        account,
        json!({ "refreshRequested": false, "serverValidated": false }),
        if guard.token_for_request().is_ok() {
            vec!["本次仅检查本机会话，尚未向 Server 验证".into()]
        } else {
            Vec::new()
        },
        if guard.token_for_request().is_ok() {
            vec!["需要确认账号资料时使用 skillhub auth status --refresh --json".into()]
        } else {
            vec!["如需使用账号功能，请打开 SkillHub APP 登录".into()]
        },
    )
}

#[cfg(test)]
mod tests {
    use super::{
        auth_guard_failure, parse_auth_status_args, parse_me_response, AuthStatusArgs,
        CliAuthGuardError, AUTH_STATUS_COMMAND,
    };
    use crate::cli::EXIT_AUTH;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn auth_status_parser_requires_json_and_rejects_duplicates() {
        assert_eq!(
            parse_auth_status_args(&strings(&["auth", "status", "--json"])),
            Ok(AuthStatusArgs { refresh: false })
        );
        assert_eq!(
            parse_auth_status_args(&strings(&["auth", "status", "--json", "--refresh"])),
            Ok(AuthStatusArgs { refresh: true })
        );
        assert_eq!(
            parse_auth_status_args(&strings(&["auth", "status", "--refresh", "--json"])),
            Ok(AuthStatusArgs { refresh: true })
        );
        for rejected in [
            strings(&["auth", "status"]),
            strings(&["auth", "status", "--json", "--json"]),
            strings(&["auth", "me", "--json"]),
            strings(&["auth", "status", "--json", "extra"]),
        ] {
            assert!(parse_auth_status_args(&rejected).is_err());
        }
    }

    #[test]
    fn auth_me_parser_accepts_only_safe_public_fields() {
        let body = br#"{"user":{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email":"person@example.com","displayName":"Person","avatarUrl":"https://example.com/avatar.png","marketplaceRole":"user"}}"#;
        let user = parse_me_response(body).expect("parse public account");
        assert_eq!(user.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        assert_eq!(user.marketplace_role, "user");

        let unsafe_avatar = br#"{"user":{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email":"person@example.com","displayName":"Person","avatarUrl":"http://example.com/avatar.png","marketplaceRole":"user"}}"#;
        assert!(parse_me_response(unsafe_avatar).is_err());

        let unexpected_role = br#"{"user":{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email":"person@example.com","displayName":"Person","avatarUrl":null,"marketplaceRole":"root"}}"#;
        assert!(parse_me_response(unexpected_role).is_err());
    }

    #[test]
    fn pending_transition_has_a_stable_fail_closed_error() {
        let output = auth_guard_failure(AUTH_STATUS_COMMAND, CliAuthGuardError::SyncPending);
        let value: serde_json::Value =
            serde_json::from_str(output.json()).expect("parse pending JSON envelope");
        assert_eq!(value["account"]["state"], "sync_pending");
        assert_eq!(value["error"]["code"], "AUTH_SYNC_PENDING");
        assert_eq!(output.exit_code(), EXIT_AUTH);
        assert!(!output.json().contains("authToken"));
    }
}
