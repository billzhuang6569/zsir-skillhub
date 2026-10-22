//! Official-store credentials never participate in a space session.
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use zeroize::{Zeroize, Zeroizing};

const EXPIRED: &str = "商店登录已失效，请重新登录";
static STORE: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct User {
    pub id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Session {
    token: String,
    expires_at: String,
    user: User,
    catalog_origin: String,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionStatus {
    signed_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<User>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
}

// The server emits Date.toISOString(), always UTC with millisecond precision.
fn expiry(value: &str) -> Option<u64> {
    if value.len() != 24
        || !value.is_ascii()
        || &value[4..5] != "-"
        || &value[7..8] != "-"
        || &value[10..11] != "T"
        || &value[13..14] != ":"
        || &value[16..17] != ":"
        || &value[19..20] != "."
        || &value[23..] != "Z"
    {
        return None;
    }
    let number = |a, b| {
        let part = value.get(a..b)?;
        if !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse::<i64>().ok()
    };
    let year = number(0, 4)?;
    let month = number(5, 7)?;
    let day = number(8, 10)?;
    let hour = number(11, 13)?;
    let minute = number(14, 16)?;
    let second = number(17, 19)?;
    number(20, 23)?;
    if !(1970..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=days[(month - 1) as usize]).contains(&day) {
        return None;
    }
    let y = year - i64::from(month <= 2);
    let era = y / 400;
    let yoe = y - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    let days =
        era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * mp + 2) / 5 + day - 1 - 719468;
    u64::try_from(days * 86400 + hour * 3600 + minute * 60 + second).ok()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn path(root: &Path) -> std::path::PathBuf {
    root.join("runtime/catalog-session.json")
}
pub(crate) fn clear(root: &Path) -> Result<(), String> {
    let _guard = STORE.lock().map_err(|_| "商店会话不可用")?;
    clear_unlocked(root)
}
fn clear_unlocked(root: &Path) -> Result<(), String> {
    match std::fs::remove_file(path(root)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法清除商店登录，请重试".into()),
    }
}
fn public(session: Option<&Session>) -> SessionStatus {
    SessionStatus {
        signed_in: session.is_some(),
        user: session.map(|s| s.user.clone()),
        expires_at: session.map(|s| s.expires_at.clone()),
    }
}
fn validate(session: &Session) -> Result<(), String> {
    crate::catalog::validate_origin(&session.catalog_origin)?;
    crate::runtime_env::validate_auth_token(&session.token).map_err(|_| "商店会话无效")?;
    uuid::Uuid::parse_str(&session.user.id).map_err(|_| "商店账号无效")?;
    if session.user.display_name.trim().is_empty() || expiry(&session.expires_at).is_none() {
        return Err("商店会话无效".into());
    }
    reject(
        &serde_json::to_value(public(Some(session))).map_err(|_| "商店会话无效")?,
        &[&session.token],
    )
}
fn read(root: &Path) -> Result<Option<Session>, String> {
    let _guard = STORE.lock().map_err(|_| "商店会话不可用")?;
    read_unlocked(root)
}
fn read_unlocked(root: &Path) -> Result<Option<Session>, String> {
    if !path(root).try_exists().map_err(|_| "无法读取商店登录")? {
        return Ok(None);
    }
    let session: Session = crate::runtime_env::read_private_json(&path(root))?;
    validate(&session)?;
    if expiry(&session.expires_at).is_none_or(|time| time <= now()) {
        clear_unlocked(root)?;
        return Ok(None);
    }
    Ok(Some(session))
}
pub(crate) fn user_id(root: &Path) -> Result<String, String> {
    Ok(read(root)?.ok_or(EXPIRED)?.user.id.clone())
}
pub(crate) fn belongs_to(session: &Session, user: &str) -> bool {
    session.user.id == user
}
pub(crate) fn save(root: &Path, session: &Session) -> Result<SessionStatus, String> {
    let _guard = STORE.lock().map_err(|_| "商店会话不可用")?;
    validate(session)?;
    if expiry(&session.expires_at).is_none_or(|time| time <= now()) {
        return Err(EXPIRED.into());
    }
    crate::runtime_env::write_private_json(&path(root), session)?;
    Ok(public(Some(session)))
}
pub(crate) fn reject(value: &Value, tokens: &[&str]) -> Result<(), String> {
    if tokens
        .iter()
        .any(|token| !token.is_empty() && crate::server_request::json_contains_token(value, token))
    {
        return Err("商店响应包含会话凭据，已拒绝返回".into());
    }
    Ok(())
}
pub(crate) fn decode_exchange(
    bytes: &[u8],
    origin: String,
    tokens: &[&str],
) -> Result<Session, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Exchange {
        token: String,
        expires_at: String,
        user: User,
    }
    impl Drop for Exchange {
        fn drop(&mut self) {
            self.token.zeroize();
        }
    }
    let mut value: Exchange = serde_json::from_slice(bytes).map_err(|_| "商店登录响应无效")?;
    let session = Session {
        token: std::mem::take(&mut value.token),
        expires_at: value.expires_at.clone(),
        user: value.user.clone(),
        catalog_origin: origin,
    };
    validate(&session)?;
    reject(
        &serde_json::to_value(public(Some(&session))).map_err(|_| "商店登录响应无效")?,
        tokens,
    )?;
    Ok(session)
}
fn bound_request(
    session: &Session,
    method: Method,
    url: Url,
) -> Result<reqwest::RequestBuilder, String> {
    let origin = crate::catalog::validate_origin(&session.catalog_origin)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !url.as_str().starts_with(&format!("{origin}/api/"))
    {
        return Err("商店凭据目标地址无效".into());
    }
    Ok(crate::net::client_builder(&url)?
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| "无法连接商店")?
        .request(method, url)
        .bearer_auth(&session.token)
        .header(reqwest::header::CACHE_CONTROL, "no-store"))
}
pub(crate) async fn request(
    root: &Path,
    method: Method,
    route: &str,
    body: Option<&Value>,
    expected_user: &str,
) -> Result<Value, String> {
    let session = read(root)?.ok_or(EXPIRED)?;
    if session.user.id != expected_user {
        return Err("商店账号已切换，请重新操作".into());
    }
    send(root, &session, method, route, body).await
}
fn unauthorized(root: &Path, session: &Session) -> Result<(), String> {
    let _guard = STORE.lock().map_err(|_| "商店会话不可用")?;
    if read_unlocked(root)?.is_some_and(|current| current.token == session.token) {
        clear_unlocked(root)?;
    }
    Err(EXPIRED.into())
}
async fn send(
    root: &Path,
    session: &Session,
    method: Method,
    route: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    let url =
        Url::parse(&format!("{}{route}", crate::catalog::origin()?)).map_err(|_| "商店地址无效")?;
    let mut request = bound_request(session, method, url)?;
    if let Some(body) = body {
        request = request.json(body);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "无法连接商店，请稍后重试")?;
    let status = response.status();
    if status.as_u16() == 401 {
        unauthorized(root, session)?;
        return Err(EXPIRED.into());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| "商店响应中断")? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("商店响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).map_err(|_| "商店响应无效")?
    };
    reject(&value, &[&session.token])?;
    if !status.is_success() {
        let message = value["message"]
            .as_str()
            .or(value["error"].as_str())
            .unwrap_or("商店暂时不可用");
        return Err(match message {
            "This Skill already has an active Marketplace submission" => "已有待审核的投稿".into(),
            "Operation key already used with different content" => "内容与之前的提交不一致".into(),
            _ => message
                .chars()
                .filter(|c| !c.is_control())
                .take(240)
                .collect(),
        });
    }
    if read(root)?.is_none_or(|current| current.token != session.token) {
        return Err(EXPIRED.into());
    }
    Ok(value)
}
#[tauri::command]
pub(crate) async fn catalog_session_status(
    registry: tauri::State<'_, crate::server_request::SpaceRegistry>,
) -> Result<SessionStatus, String> {
    let root = registry.migration_root().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || Ok(public(read(&root)?.as_ref())))
        .await
        .map_err(|error| format!("catalog_session_status异常结束: {error}"))?
}
#[tauri::command]
pub(crate) async fn catalog_logout(
    registry: tauri::State<'_, crate::server_request::SpaceRegistry>,
) -> Result<(), String> {
    crate::portal_auth::cancel_catalog_login()?;
    let root = registry.migration_root();
    logout_at(root, |session| async move {
        send(
            root,
            &session,
            Method::POST,
            "/api/auth/catalog/logout",
            None,
        )
        .await
        .map(|_| ())
    })
    .await
}
async fn logout_at<F, Fut>(root: &Path, revoke: F) -> Result<(), String>
where
    F: FnOnce(Session) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    if let Some(session) = take_for_logout(root)? {
        let _ = revoke(session).await;
    }
    Ok(())
}
fn take_for_logout(root: &Path) -> Result<Option<Session>, String> {
    let _guard = STORE.lock().map_err(|_| "商店会话不可用")?;
    let session = read_unlocked(root).ok().flatten();
    clear_unlocked(root)?;
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unauthorized_clears_only_the_failed_session() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let old = session();
        save(&root, &old).unwrap();
        assert_eq!(unauthorized(&root, &old), Err(EXPIRED.into()));
        assert!(read(&root).unwrap().is_none());
        let mut new = session();
        new.token = "a-new-session".into();
        save(&root, &new).unwrap();
        assert!(unauthorized(&root, &old).is_err());
        assert_eq!(read(&root).unwrap().unwrap().token, new.token);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn logout_removes_file_before_any_network_outcome() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        for result in [Ok(()), Err("offline"), Err("HTTP 500")] {
            save(&root, &session()).unwrap();
            logout_at(&root, |_| async {
                assert!(!path(&root).exists());
                result.map_err(str::to_string)
            })
            .await
            .unwrap();
            assert!(read(&root).unwrap().is_none());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn changed_account_is_rejected_before_network() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        save(&root, &session()).unwrap();
        assert_eq!(
            request(
                &root,
                Method::POST,
                "/api/marketplace/catalog-submissions",
                None,
                "different-user"
            )
            .await
            .unwrap_err(),
            "商店账号已切换，请重新操作"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn exchange_rejects_portal_credential_echo_without_exposing_it() {
        let s = session();
        let value = serde_json::json!({"token":s.token,"expiresAt":s.expires_at,"user":{"id":s.user.id,"displayName":"portal-secret","avatarUrl":null}});
        let result = decode_exchange(
            &serde_json::to_vec(&value).unwrap(),
            s.catalog_origin.clone(),
            &["portal-secret"],
        );
        assert!(result.is_err());
        assert!(!result.err().unwrap().contains("portal-secret"));
    }
    fn session() -> Session {
        Session {
            token: "test-catalog-secret".into(),
            expires_at: "2099-01-01T00:00:00.000Z".into(),
            user: User {
                id: uuid::Uuid::new_v4().to_string(),
                display_name: "测试".into(),
                avatar_url: None,
            },
            catalog_origin: crate::catalog::origin().unwrap(),
        }
    }
    #[test]
    fn storage_expiry_permissions_and_no_public_token() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut s = session();
        let status = save(&root, &s).unwrap();
        assert!(!serde_json::to_string(&status).unwrap().contains(&s.token));
        assert!(read(&root).unwrap().is_some());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path(&root)).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        s.expires_at = "2000-01-01T00:00:00.000Z".into();
        crate::runtime_env::write_private_json(&path(&root), &s).unwrap();
        assert!(read(&root).unwrap().is_none());
        assert!(!path(&root).exists());
        assert_eq!(expiry("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(expiry("2024-02-30T00:00:00.000Z"), None);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn instance_destination_and_credential_echo_are_rejected() {
        let mut s = session();
        assert!(bound_request(
            &s,
            Method::POST,
            Url::parse("https://instance.invalid/api/marketplace/catalog-submissions").unwrap()
        )
        .is_err());
        assert!(bound_request(
            &s,
            Method::POST,
            Url::parse(&format!("{}/api/auth/catalog/logout", s.catalog_origin)).unwrap()
        )
        .is_ok());
        s.user.display_name = s.token.clone();
        assert!(validate(&s).is_err());
        assert!(reject(
            &serde_json::json!({"error": "test-catalog-secret"}),
            &[&s.token]
        )
        .is_err());
    }
}
