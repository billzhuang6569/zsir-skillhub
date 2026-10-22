//! Fixed-route IPC and native session custody.
use crate::runtime_env::{runtime_session_snapshot_at, RuntimeSession};
use reqwest::{Method, Url};
#[path = "server_routes.rs"]
mod routes;
use routes::{Route, RouteParams};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

// Match the Server's maximum accepted ZIP size, including private downloads.
const MAX_RESPONSE_BYTES: usize = 20 * 1024 * 1024;
const STALE_SPACE: &str = "SkillHub 空间或账号已切换，本次请求结果已丢弃";
const CANCELLED: &str = "SkillHub 请求已取消";
const RESPONSE_HEADERS: [&str; 5] = [
    "retry-after",
    "x-checksum-sha256",
    "x-skill-version",
    "content-type",
    "x-request-id",
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceHandle {
    pub(crate) space_id: String,
    pub(crate) generation: u64,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum RequestBody {
    Json(Value),
    Bytes(Vec<u8>),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServerRequest {
    request_id: String,
    space: SpaceHandle,
    route: Route,
    #[serde(default)]
    params: RouteParams,
    #[serde(default)]
    query: RouteParams,
    body: Option<RequestBody>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub(crate) enum ResponseBody {
    Empty,
    Json(Value),
    Bytes(Vec<u8>),
}

#[derive(Debug, Serialize)]
pub(crate) struct ServerResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    space: Option<SpaceHandle>,
    pub(crate) status: u16,
    #[serde(rename = "statusText")]
    status_text: String,
    pub(crate) headers: BTreeMap<String, String>,
    pub(crate) body: ResponseBody,
}

fn request_bearer(
    session: Option<&RuntimeSession>,
    authenticated: bool,
    optional: bool,
) -> Result<Option<&str>, String> {
    // Only optional routes may attach a session without requiring sign-in.
    if !authenticated && !optional {
        return Ok(None);
    }
    let token = session.and_then(RuntimeSession::auth_token);
    if authenticated && token.is_none() {
        return Err("请先在 SkillHub APP 登录".into());
    }
    Ok(token)
}

#[derive(Default)]
struct Transitions {
    serial: u64,
    pending: Option<u64>,
}

pub(crate) struct SessionTransition<'a> {
    registry: &'a SpaceRegistry,
    serial: u64,
    pub(crate) previous: Option<RuntimeSession>,
}

impl SessionTransition<'_> {
    pub(crate) async fn commit(
        &self,
        identity: Option<(&str, &str)>,
        portal_id: Option<uuid::Uuid>,
    ) -> Result<SpaceHandle, String> {
        let transitions = self.registry.transitions.clone();
        let root = self.registry.runtime_root.clone();
        let previous = self.previous.clone();
        let serial = self.serial;
        let identity = identity
            .map(|(token, user)| (zeroize::Zeroizing::new(token.to_string()), user.to_string()));
        let portal = self.registry.portal.clone();
        tokio::task::spawn_blocking(move || {
            // Do not hold in-process locks while waiting for CLI/team operations.
            let lease = crate::runtime_env::acquire_exclusive_session_lease_at(&root)
                .map_err(|error| format!("本机 skillhub 命令同步失败：{error}"))?;
            let state = transitions.lock().map_err(|_| STALE_SPACE)?;
            if state.serial != serial || state.pending != Some(serial) {
                return Err(STALE_SPACE.to_string());
            }
            let write = || {
                let generation = crate::runtime_env::replace_session_locked_at(
                    &root,
                    &root.join("skills"),
                    previous.as_ref(),
                    identity
                        .as_ref()
                        .map(|(token, user)| (token.as_str(), user.as_str())),
                    &lease,
                )
                .map_err(|error| {
                    if error == STALE_SPACE {
                        error
                    } else {
                        format!("本机 skillhub 命令同步失败：{error}")
                    }
                })?;
                Ok(SpaceHandle {
                    space_id: previous
                        .as_ref()
                        .map_or_else(crate::spaces::official_id, |s| s.space_id().into()),
                    generation,
                })
            };
            if let Some(id) = portal_id {
                portal.commit_if_active(id, write)
            } else {
                write()
            }
        })
        .await
        .map_err(|_| "本机 skillhub 命令同步失败：无法完成会话写入")?
    }
}

impl Drop for SessionTransition<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.registry.transitions.lock() {
            if state.pending == Some(self.serial) {
                state.pending = None;
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthState {
    #[serde(flatten)]
    space: SpaceHandle,
    user_id: Option<String>,
    pending: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl ServerResponse {
    fn into_ipc(mut self) -> Result<tauri::ipc::Response, String> {
        if let ResponseBody::Bytes(bytes) = &mut self.body {
            let bytes = std::mem::take(bytes);
            self.body = ResponseBody::Empty;
            let metadata = serde_json::to_vec(&self).map_err(|_| "无法编码 SkillHub 响应")?;
            // Binary IPC frame: u32 LE metadata length, JSON metadata, raw body.
            let length = u32::try_from(metadata.len()).map_err(|_| "SkillHub 响应头过大")?;
            let mut frame = length.to_le_bytes().to_vec();
            frame.extend(metadata);
            frame.extend(bytes);
            Ok(tauri::ipc::Response::new(frame))
        } else {
            Ok(tauri::ipc::Response::new(
                serde_json::to_string(&self).map_err(|_| "无法编码 SkillHub 响应")?,
            ))
        }
    }
}

struct ActiveRequest {
    space: SpaceHandle,
    cancel: watch::Sender<bool>,
}

pub(crate) struct SpaceRegistry {
    pub(crate) worker: crate::local_inference::worker::Worker,
    pub(crate) inference: crate::local_inference::TextInferenceRunner,
    pub(crate) base: Url,
    // This pool belongs to the immutable base URL; another base needs its own client.
    pub(crate) client: reqwest::Client,
    pub(crate) media: crate::media::MediaState,
    runtime_root: PathBuf,
    requests: Mutex<HashMap<String, ActiveRequest>>,
    transitions: Arc<Mutex<Transitions>>,
    pub(crate) portal: crate::portal_auth::PortalAuthState,
    connections: Mutex<HashMap<String, reqwest::Client>>,
    candidate: Arc<Mutex<Option<Candidate>>>,
}

struct Candidate {
    transaction: crate::spaces::SwitchTransaction,
    session: RuntimeSession,
    rebind: Option<(crate::spaces::Deployment, std::time::Instant)>,
}

#[cfg(test)]
mod migration_window_tests {
    use super::*;

    #[test]
    fn migration_window_is_native_only_and_tracks_pending_and_candidate_replacement() {
        let root = std::env::temp_dir().join(format!("migration-window-{}", uuid::Uuid::new_v4()));
        let source = crate::runtime_env::new_space_session_at(
            &root,
            crate::spaces::Deployment::Official,
            Some(("source-token", &uuid::Uuid::new_v4().to_string())),
            1,
        )
        .unwrap();
        crate::runtime_env::write_space_session_at(&root, &source).unwrap();
        let registry =
            SpaceRegistry::new(Url::parse("https://example.invalid").unwrap(), root.clone())
                .unwrap();
        let reader = registry.migration_window_reader();
        assert!(reader().is_err());
        assert!(registry.migration_window().is_err());
        let transaction =
            crate::spaces::SwitchTransaction::begin_expected(&root, false, Some(&source)).unwrap();
        let candidate = crate::runtime_env::new_space_session_at(
            &root,
            crate::spaces::Deployment::Official,
            Some(("candidate-token", &uuid::Uuid::new_v4().to_string())),
            transaction.pending().generation(),
        )
        .unwrap();
        let expected = (transaction.pending().clone(), candidate.clone());
        *registry.candidate.lock().unwrap() = Some(Candidate {
            transaction,
            session: candidate,
            rebind: None,
        });
        assert_eq!(registry.migration_window().unwrap(), expected);
        assert_eq!(reader().unwrap(), expected);
        assert!(expected.0.server_origin().is_err());
        assert_eq!(expected.1.auth_token(), Some("candidate-token"));
        registry
            .candidate
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .session
            .begin_switch()
            .unwrap();
        assert_ne!(registry.migration_window().unwrap(), expected);
        assert_ne!(reader().unwrap(), expected);
        let mut departed = expected.0;
        departed.finish_switch().unwrap();
        crate::runtime_env::write_space_session_at(&root, &departed).unwrap();
        assert!(registry.migration_window().is_err());
        assert!(reader().is_err());
        drop(reader);
        drop(registry);
        std::fs::remove_dir_all(root).unwrap();
    }
}

struct RequestLease<'a> {
    registry: &'a SpaceRegistry,
    id: String,
}

impl Drop for RequestLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.registry.requests.lock() {
            requests.remove(&self.id);
        }
    }
}

impl SpaceRegistry {
    /// Native migration hook only. Both credentials remain inside Rust.
    pub(crate) fn migration_window(&self) -> Result<(RuntimeSession, RuntimeSession), String> {
        self.migration_window_reader()()
    }

    /// Clone handles only; the worker checks the live candidate and session together.
    pub(crate) fn migration_window_reader(
        &self,
    ) -> impl Fn() -> Result<(RuntimeSession, RuntimeSession), String> + Send + 'static {
        let candidate = self.candidate.clone();
        let root = self.runtime_root.clone();
        move || {
            let slot = candidate.lock().map_err(|_| STALE_SPACE)?;
            let candidate = slot.as_ref().ok_or("迁移快照需要已登录的切换窗口")?;
            if candidate.rebind.is_some()
                || runtime_session_snapshot_at(&root)? != *candidate.transaction.pending()
            {
                return Err(STALE_SPACE.into());
            }
            Ok((
                candidate.transaction.pending().clone(),
                candidate.session.clone(),
            ))
        }
    }

    pub(crate) fn migration_root(&self) -> &std::path::Path {
        &self.runtime_root
    }

    pub(crate) fn from_runtime() -> Result<Self, String> {
        Self::new(
            crate::runtime_env::trusted_server_origin()?,
            crate::skillhub_dir(),
        )
    }

    pub(crate) fn new(base: Url, runtime_root: PathBuf) -> Result<Self, String> {
        let client = crate::net::client_builder_with_timeout(&base, None)?
            .user_agent(concat!(
                "Yitan-SkillHub/",
                env!("CARGO_PKG_VERSION"),
                " server-request"
            ))
            .build()
            .map_err(|_| "无法初始化 SkillHub 服务连接")?;
        Ok(Self {
            worker: crate::local_inference::worker::Worker::default(),
            inference: crate::local_inference::TextInferenceRunner::default(),
            base,
            client,
            media: crate::media::MediaState::default(),
            runtime_root,
            requests: Mutex::new(HashMap::new()),
            transitions: Arc::new(Mutex::new(Transitions::default())),
            portal: crate::portal_auth::PortalAuthState::default(),
            connections: Mutex::new(HashMap::new()),
            candidate: Arc::new(Mutex::new(None)),
        })
    }

    pub(crate) fn connection(
        &self,
        session: Option<&RuntimeSession>,
    ) -> Result<(Url, reqwest::Client), String> {
        let base = match session {
            Some(session) if session.deployment().profile() != "official" => {
                session.server_origin()?
            }
            _ => self.base.clone(),
        };
        let client = self.client_for(&base)?;
        Ok((base, client))
    }

    pub(crate) fn client_for(&self, base: &Url) -> Result<reqwest::Client, String> {
        if base == &self.base {
            return Ok(self.client.clone());
        }
        let mut clients = self.connections.lock().map_err(|_| STALE_SPACE)?;
        if let Some(client) = clients.get(base.as_str()) {
            return Ok(client.clone());
        }
        let client = crate::net::client_builder_with_timeout(base, None)?
            .build()
            .map_err(|_| "无法初始化服务连接")?;
        clients.insert(base.to_string(), client.clone());
        Ok(client)
    }

    pub(crate) fn candidate_snapshot(
        &self,
        handle: &SpaceHandle,
    ) -> Result<Option<RuntimeSession>, String> {
        let candidate = self.candidate.lock().map_err(|_| STALE_SPACE)?;
        let Some(candidate) = candidate.as_ref() else {
            return Ok(None);
        };
        if Self::handle(Some(&candidate.session)) != *handle {
            return Ok(None);
        }
        if runtime_session_snapshot_at(&self.runtime_root)? != *candidate.transaction.pending() {
            return Err(STALE_SPACE.into());
        }
        Ok(Some(candidate.session.clone()))
    }

    pub(crate) fn cancel_all(&self) -> Result<(), String> {
        self.worker.stop(self);
        self.inference.cancel_space(None);
        for request in self.requests.lock().map_err(|_| STALE_SPACE)?.values() {
            let _ = request.cancel.send(true);
        }
        self.portal.cancel().map(|_| ())
    }

    pub(crate) fn cancel_departed(&self, departed: &SpaceHandle) -> Result<(), String> {
        self.inference.cancel_space(Some(departed));
        for request in self
            .requests
            .lock()
            .map_err(|_| STALE_SPACE)?
            .values()
            .filter(|request| request.space == *departed)
        {
            let _ = request.cancel.send(true);
        }
        if self.candidate.lock().map_err(|_| STALE_SPACE)?.is_none() {
            self.portal.cancel()?;
        }
        Ok(())
    }

    pub(crate) fn establish_candidate(
        &self,
        expected: &RuntimeSession,
        token: &str,
        user_id: &str,
    ) -> Result<SpaceHandle, String> {
        let handle = Self::handle(Some(expected));
        if self.candidate_snapshot(&handle)?.as_ref() != Some(expected) {
            return Err(STALE_SPACE.into());
        }
        let mut slot = self.candidate.lock().map_err(|_| STALE_SPACE)?;
        let candidate = slot.as_mut().ok_or(STALE_SPACE)?;
        if candidate.rebind.is_some() {
            return Err("改绑确认前不能登录候选空间".into());
        }
        if candidate.session != *expected {
            return Err(STALE_SPACE.into());
        }
        candidate.session = crate::runtime_env::new_space_session_at(
            &self.runtime_root,
            expected.deployment().clone(),
            Some((token, user_id)),
            expected.generation().checked_sub(1).ok_or(STALE_SPACE)?,
        )?;
        Ok(handle)
    }

    fn apply_candidate_effect(
        &self,
        response: &mut ServerResponse,
        expected: &RuntimeSession,
        effect: Option<&str>,
    ) -> Result<(), String> {
        if self
            .candidate_snapshot(&Self::handle(Some(expected)))?
            .as_ref()
            != Some(expected)
        {
            return Err(STALE_SPACE.into());
        }
        if effect == Some("establish") && response.status < 300 {
            let (token, user_id) = take_session(response)?;
            response.reject_token(&token)?;
            response.space = Some(self.establish_candidate(expected, &token, &user_id)?);
        } else if let ResponseBody::Json(value) = &response.body {
            if value.get("token").is_some() {
                return Err("SkillHub 响应包含会话凭据，已拒绝返回".into());
            }
        }
        Ok(())
    }

    async fn apply_session_effect(
        &self,
        response: &mut ServerResponse,
        effect: Option<&str>,
        transition: Option<&SessionTransition<'_>>,
        token: Option<&str>,
        migration_attempt: Option<u64>,
    ) -> Result<(), String> {
        if response.status >= 300 && effect.is_some() {
            if let ResponseBody::Json(value) = &response.body {
                if value.get("token").is_some() {
                    return Err("SkillHub 响应包含会话凭据，已拒绝返回".into());
                }
            }
        }
        if let Some(transition) = transition {
            if response.status < 300 {
                match effect {
                    Some("migration" | "establish" | "replace") => {
                        let (new_token, user_id) = take_session(response)?;
                        response.reject_token(new_token.as_str())?;
                        if let Some(token) = token {
                            response.reject_token(token)?;
                        }
                        if effect == Some("replace")
                            && transition.previous.as_ref().map(RuntimeSession::user_id)
                                != Some(user_id.as_str())
                        {
                            return Err(STALE_SPACE.into());
                        }
                        if let Some(attempt) = migration_attempt {
                            let state = self.transitions.lock().map_err(|_| STALE_SPACE)?;
                            if state.serial != transition.serial {
                                return Err(STALE_SPACE.into());
                            }
                            self.portal.hold_migration(attempt, user_id, new_token)?;
                        } else {
                            let space = transition
                                .commit(Some((new_token.as_str(), &user_id)), None)
                                .await?;
                            if let ResponseBody::Json(value) = &mut response.body {
                                value["space"] = serde_json::to_value(&space)
                                    .map_err(|_| "无法编码 SkillHub 响应")?;
                            }
                            response.space = Some(space);
                        }
                    }
                    Some("clear") => {
                        response.space = Some(transition.commit(None, None).await?);
                    }
                    _ => {}
                }
            } else if effect == Some("clear") && response.status == 401 {
                response.space = Some(transition.commit(None, None).await?);
            }
        }
        if let Some(token) = token {
            response.reject_token(token)?;
        }
        Ok(())
    }

    pub(crate) fn portal_request(
        &self,
        mode: crate::portal_auth::PortalAuthMode,
    ) -> Result<reqwest::RequestBuilder, String> {
        let action = match mode {
            crate::portal_auth::PortalAuthMode::Login => "exchange",
            crate::portal_auth::PortalAuthMode::Link => "link",
        };
        Ok(self
            .client
            .post(route_url(&self.base, &["api", "auth", "yitan", action])?)
            .timeout(Duration::from_secs(20)))
    }

    pub(crate) async fn snapshot(
        &self,
        allow_pending: bool,
    ) -> Result<Option<RuntimeSession>, String> {
        let root = self.runtime_root.clone();
        tokio::task::spawn_blocking(move || {
            let Some(session) = crate::runtime_env::optional_session_snapshot_at(&root)? else {
                return Ok(None);
            };
            if session.is_sync_pending() && !allow_pending {
                return Err("SkillHub APP 正在同步账号，请稍后重试".into());
            }
            Ok(Some(session))
        })
        .await
        .map_err(|_| "无法读取 SkillHub 运行时会话")?
    }

    pub(crate) fn handle(session: Option<&RuntimeSession>) -> SpaceHandle {
        SpaceHandle {
            space_id: session.map_or_else(crate::spaces::official_id, |session| {
                session.space_id().into()
            }),
            generation: session.map_or(0, RuntimeSession::generation),
        }
    }

    pub(crate) async fn transition(
        &self,
        expected: Option<&RuntimeSession>,
    ) -> Result<SessionTransition<'_>, String> {
        let previous = self.snapshot(true).await?;
        if previous.as_ref() != expected {
            return Err(STALE_SPACE.into());
        }
        let mut state = self.transitions.lock().map_err(|_| STALE_SPACE)?;
        state.serial = state.serial.checked_add(1).ok_or(STALE_SPACE)?;
        state.pending = Some(state.serial);
        Ok(SessionTransition {
            registry: self,
            serial: state.serial,
            previous,
        })
    }

    async fn invalidate(&self, space: &SpaceHandle) -> Result<Option<SpaceHandle>, String> {
        let previous = self.snapshot(true).await?;
        if Self::handle(previous.as_ref()) != *space {
            return Ok(None);
        }
        self.portal.cancel()?;
        let result = async {
            let transition = self.transition(previous.as_ref()).await?;
            transition.commit(None, None).await.map(Some)
        }
        .await;
        match result {
            Err(error) if error == STALE_SPACE => Ok(None),
            result => result,
        }
    }

    async fn import_legacy(&self, token: String) -> Result<bool, String> {
        let token = zeroize::Zeroizing::new(token);
        crate::runtime_env::validate_auth_token(&token)?;
        let previous = self.snapshot(true).await?;
        if previous
            .as_ref()
            .is_some_and(|session| session.space_id() != "official" || session.is_sync_pending())
        {
            return Err("旧版登录仅可迁入官方空间".into());
        }
        let transition = self.transition(previous.as_ref()).await?;
        let route = Route::try_from("auth.me".to_string()).map_err(str::to_string)?;
        let (method, url) = route.resolve(&self.base, &RouteParams::new(), &RouteParams::new())?;
        let response = self
            .client
            .request(method, url)
            .bearer_auth(token.as_str())
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(network_error)?;
        let response = read_response(response, Some(&token)).await?;
        self.finish_legacy_import(&transition, &token, response)
            .await
    }

    async fn finish_legacy_import(
        &self,
        transition: &SessionTransition<'_>,
        token: &str,
        response: ServerResponse,
    ) -> Result<bool, String> {
        if response.status == 401 {
            return Ok(false);
        }
        if response.status != 200 {
            return Err("无法验证旧版 SkillHub 会话，请重试".into());
        }
        let ResponseBody::Json(value) = response.body else {
            return Err("SkillHub 登录响应无效，请重试".into());
        };
        let user = value["user"]["id"]
            .as_str()
            .ok_or("SkillHub 登录响应无效，请重试")?;
        transition.commit(Some((token, user)), None).await?;
        Ok(true)
    }

    fn begin(
        &self,
        request: &ServerRequest,
    ) -> Result<(RequestLease<'_>, watch::Receiver<bool>), String> {
        if request.request_id.is_empty()
            || request.request_id.len() > 128
            || !request
                .request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("SkillHub 请求编号无效".into());
        }
        let mut requests = self
            .requests
            .lock()
            .map_err(|_| "无法读取 SkillHub 请求状态")?;
        if requests.contains_key(&request.request_id) {
            return Err("SkillHub 请求编号正在使用".into());
        }
        let (cancel, receiver) = watch::channel(false);
        requests.insert(
            request.request_id.clone(),
            ActiveRequest {
                space: request.space.clone(),
                cancel,
            },
        );
        Ok((
            RequestLease {
                registry: self,
                id: request.request_id.clone(),
            },
            receiver,
        ))
    }

    fn cancel(&self, space: &SpaceHandle, request_id: &str) -> Result<bool, String> {
        let requests = self
            .requests
            .lock()
            .map_err(|_| "无法读取 SkillHub 请求状态")?;
        let Some(request) = requests
            .get(request_id)
            .filter(|request| &request.space == space)
        else {
            return Ok(false);
        };
        Ok(request.cancel.send(true).is_ok())
    }

    /// Native-only fixed routes; shares all identity, bearer and late-response checks.
    pub(crate) async fn local_ai_request(
        &self,
        space: &SpaceHandle,
        route: &str,
        lease_id: Option<&str>,
        body: Option<Value>,
    ) -> Result<ServerResponse, String> {
        if route != "health" && !route.starts_with("localAi.") {
            return Err("此原生入口不支持该路由".into());
        }
        self.request(ServerRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            space: space.clone(),
            route: Route::try_from(route.to_string()).map_err(str::to_string)?,
            params: lease_id
                .map(|id| BTreeMap::from([("leaseId".into(), id.into())]))
                .unwrap_or_default(),
            query: BTreeMap::new(),
            body: body.map(RequestBody::Json),
            timeout_ms: Some(20_000),
        })
        .await
    }

    async fn request(&self, request: ServerRequest) -> Result<ServerResponse, String> {
        let timeout = request.timeout_ms.unwrap_or(20_000);
        if timeout > 150_000 {
            return Err("SkillHub 请求超时必须在 0–150000 毫秒之间".into());
        }
        let (_lease, mut cancel) = self.begin(&request)?;
        tokio::select! {
            biased;
            _ = cancel.changed() => Err(CANCELLED.into()),
            result = async {
                // Zero preserves apiFetch's existing no-timeout default.
                if timeout == 0 {
                    self.execute(request, timeout).await
                } else {
                    tokio::time::timeout(Duration::from_millis(timeout), self.execute(request, timeout))
                        .await.map_err(|_| "SkillHub 请求超时，请重试".to_string())?
                }
            } => result
        }
    }

    async fn execute(
        &self,
        request: ServerRequest,
        timeout: u64,
    ) -> Result<ServerResponse, String> {
        let candidate = self.candidate_snapshot(&request.space)?;
        let is_candidate = candidate.is_some();
        if is_candidate
            && self
                .candidate
                .lock()
                .map_err(|_| STALE_SPACE)?
                .as_ref()
                .is_some_and(|candidate| candidate.rebind.is_some())
        {
            return Err("改绑提交前不能向候选空间发送凭据".into());
        }
        let session = if is_candidate {
            candidate
        } else {
            self.snapshot(false).await?
        };
        if request.space != Self::handle(session.as_ref()) {
            return Err(STALE_SPACE.into());
        }
        if is_candidate
            && !matches!(
                request.route.name(),
                "health"
                    | "setup.status"
                    | "setup.admin"
                    | "auth.login"
                    | "auth.register"
                    | "auth.me"
            )
        {
            return Err("切换期间只允许目标认证".into());
        }
        if !is_candidate && request.route.name().starts_with("setup.") {
            return Err("请在连接候选中初始化服务器".into());
        }
        let profile = session
            .as_ref()
            .map_or("official", |s| s.deployment().profile());
        let catalog = request.route.name().starts_with("marketplace.");
        let (base, client) = if catalog {
            #[cfg(not(test))]
            let base =
                crate::spaces::normalize_base(&crate::official_channel::COMPILED.catalog_origin)?;
            #[cfg(test)]
            let base = self.base.clone();
            let client = self.client_for(&base)?;
            (base, client)
        } else {
            self.connection(session.as_ref())?
        };
        let (method, url) = request
            .route
            .resolve(&base, &request.params, &request.query)?;
        if request.body.is_some() && matches!(method, Method::GET | Method::DELETE) {
            return Err("此 SkillHub 路由不接受请求体".into());
        }
        let definition = request.route.definition();
        let token_session = if catalog
            && (profile != "official"
                || crate::spaces::canonical_base(&base)
                    != crate::spaces::canonical_base(&self.base))
        {
            None
        } else {
            session.as_ref()
        };
        let token = request_bearer(token_session, definition.auth, definition.optional)?;
        let effect = definition.effect(if catalog { "official" } else { profile })?;
        if !catalog {
            if let Some(session) = &session {
                crate::spaces::verify_remote_identity(session).await?;
            }
        }
        if effect == Some("clear") {
            self.portal.cancel()?;
        }
        let transition = if effect.is_some() && !is_candidate {
            Some(self.transition(session.as_ref()).await?)
        } else {
            None
        };
        let migration_attempt = if effect == Some("migration") {
            Some(self.portal.begin_migration()?)
        } else {
            None
        };
        // Bind both the URL and token to this submission, never to arrival time.
        let mut outgoing = client.request(method, url);
        if timeout > 0 {
            outgoing = outgoing.timeout(Duration::from_millis(timeout));
        }
        if let Some(token) = token {
            outgoing = outgoing
                .bearer_auth(token)
                .header(reqwest::header::CACHE_CONTROL, "no-store");
        }
        if let Some(body) = request.body {
            outgoing = match body {
                RequestBody::Json(value) => outgoing.json(&value),
                RequestBody::Bytes(bytes) => outgoing
                    .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                    .body(bytes),
            };
        }
        let response = outgoing.send().await.map_err(network_error)?;
        let mut response = read_response(
            response,
            if matches!(effect, Some("migration" | "establish" | "replace")) {
                None
            } else {
                token
            },
        )
        .await?;
        let current = if is_candidate {
            self.candidate_snapshot(&request.space)?
        } else {
            self.snapshot(false).await?
        };
        if request.space != Self::handle(current.as_ref()) || session != current {
            return Err(STALE_SPACE.into());
        }
        if is_candidate {
            self.apply_candidate_effect(
                &mut response,
                session.as_ref().ok_or(STALE_SPACE)?,
                effect,
            )?;
            return Ok(response);
        }
        if request.route.name() == "auth.logoutAll"
            && ((200..300).contains(&response.status) || response.status == 401)
        {
            crate::portal_auth::cancel_catalog_login()?;
            crate::catalog_session::clear(&self.runtime_root)?;
        }
        self.apply_session_effect(
            &mut response,
            effect,
            transition.as_ref(),
            token,
            migration_attempt,
        )
        .await?;
        Ok(response)
    }
}

fn take_session(
    response: &mut ServerResponse,
) -> Result<(zeroize::Zeroizing<String>, String), String> {
    let ResponseBody::Json(value) = &mut response.body else {
        return Err("SkillHub 登录响应无效，请重试".into());
    };
    let token = value
        .as_object_mut()
        .and_then(|value| value.remove("token"))
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or("SkillHub 登录响应无效，请重试")?;
    let token = zeroize::Zeroizing::new(token);
    crate::runtime_env::validate_auth_token(&token)?;
    let user_id = value["user"]["id"]
        .as_str()
        .ok_or("SkillHub 登录响应无效，请重试")?
        .to_string();
    crate::runtime_env::validate_user_id(&user_id)?;
    Ok((token, user_id))
}

impl ServerResponse {
    fn reject_token(&self, token: &str) -> Result<(), String> {
        let contains = self.headers.values().any(|value| value.contains(token))
            || match &self.body {
                ResponseBody::Json(value) => json_contains_token(value, token),
                ResponseBody::Bytes(bytes) => bytes
                    .windows(token.len())
                    .any(|part| part == token.as_bytes()),
                ResponseBody::Empty => false,
            };
        if contains {
            Err("SkillHub 响应包含会话凭据，已拒绝返回".into())
        } else {
            Ok(())
        }
    }
}

fn route_url(base: &Url, segments: &[&str]) -> Result<Url, String> {
    let mut url = base.clone();
    let mut path = url
        .path_segments_mut()
        .map_err(|_| "SkillHub 服务地址无效")?;
    path.pop_if_empty();
    for segment in segments {
        if segment.is_empty() || matches!(*segment, "." | "..") {
            return Err("SkillHub 路由参数无效".into());
        }
        path.push(segment);
    }
    drop(path);
    Ok(url)
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "SkillHub 请求超时，请重试"
    } else {
        "无法连接 SkillHub，请检查网络与 HTTPS 配置"
    }
    .into()
}

pub(crate) fn json_contains_token(value: &Value, token: &str) -> bool {
    match value {
        Value::String(value) => value.contains(token),
        Value::Array(values) => values.iter().any(|value| json_contains_token(value, token)),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| key.contains(token) || json_contains_token(value, token)),
        _ => false,
    }
}

async fn read_response(
    mut response: reqwest::Response,
    token: Option<&str>,
) -> Result<ServerResponse, String> {
    let status = response.status().as_u16();
    let status_text = response
        .status()
        .canonical_reason()
        .unwrap_or_default()
        .to_string();
    let headers: BTreeMap<String, String> = RESPONSE_HEADERS
        .iter()
        .filter_map(|name| {
            response
                .headers()
                .get(*name)?
                .to_str()
                .ok()
                .map(|value| ((*name).into(), value.into()))
        })
        .collect();
    let mut bytes = Vec::new();
    if status != 204 {
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
        {
            return Err("SkillHub 响应过大".into());
        }
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err("SkillHub 响应过大".into());
            }
            bytes.extend_from_slice(&chunk);
        }
    }
    let json = serde_json::from_slice::<Value>(&bytes).ok();
    // A server must not be able to reflect the bearer back into the WebView.
    if token.is_some_and(|token| {
        headers.values().any(|value| value.contains(token))
            || bytes
                .windows(token.len())
                .any(|window| window == token.as_bytes())
            || json
                .as_ref()
                .is_some_and(|value| json_contains_token(value, token))
    }) {
        return Err("SkillHub 响应包含会话凭据，已拒绝返回".into());
    }
    let content_type = headers.get("content-type").map(|value| {
        value
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
    });
    let is_json =
        content_type.is_some_and(|value| value == "application/json" || value.ends_with("+json"));
    let body = if bytes.is_empty() {
        ResponseBody::Empty
    } else if is_json {
        json.map(ResponseBody::Json)
            .unwrap_or(ResponseBody::Bytes(bytes))
    } else {
        ResponseBody::Bytes(bytes)
    };
    Ok(ServerResponse {
        space: None,
        status,
        status_text,
        headers,
        body,
    })
}

#[tauri::command]
pub(crate) async fn current_space(
    state: tauri::State<'_, SpaceRegistry>,
) -> Result<SpaceHandle, String> {
    Ok(SpaceRegistry::handle(state.snapshot(true).await?.as_ref()))
}

#[tauri::command]
pub(crate) async fn test_space_connection(
    target: String,
) -> Result<crate::spaces::ConnectionReport, String> {
    Ok(crate::spaces::test_connection(&crate::skillhub_dir(), &target).await)
}

#[tauri::command]
pub(crate) async fn begin_space_switch(
    state: tauri::State<'_, SpaceRegistry>,
    space: SpaceHandle,
    target: String,
    rebind: Option<bool>,
) -> Result<SpaceHandle, String> {
    begin_switch_at(&state, space, target, rebind.unwrap_or(false)).await
}

async fn begin_switch_at(
    state: &SpaceRegistry,
    space: SpaceHandle,
    target: String,
    rebind: bool,
) -> Result<SpaceHandle, String> {
    let previous = state.snapshot(false).await?;
    if SpaceRegistry::handle(previous.as_ref()) != space {
        return Err(STALE_SPACE.into());
    }
    state.cancel_all()?;
    let transaction = crate::spaces::SwitchTransaction::begin_expected(
        &state.runtime_root,
        false,
        previous.as_ref(),
    )?;
    let report = crate::spaces::test_connection(&state.runtime_root, &target).await;
    let failure = serde_json::to_string(&report).unwrap_or_else(|_| "测试连接失败".into());
    let mut deployment = report.deployment.ok_or(failure)?;
    let rebind = if rebind {
        let matched = report
            .rebind
            .and_then(|r| r.deployment)
            .ok_or("地址证明已失效，请重新测试")?;
        let origin = crate::spaces::canonical_base(&deployment.base()?.ok_or("缺少地址")?);
        deployment = matched.clone();
        if let crate::spaces::Deployment::Selfhost {
            origin: current, ..
        } = &mut deployment
        {
            *current = origin;
        }
        Some((matched, std::time::Instant::now()))
    } else {
        None
    };
    let session = crate::runtime_env::new_space_session_at(
        &state.runtime_root,
        deployment,
        None,
        transaction
            .pending()
            .generation()
            .checked_sub(1)
            .ok_or(STALE_SPACE)?,
    )?;
    let handle = SpaceRegistry::handle(Some(&session));
    *state.candidate.lock().map_err(|_| STALE_SPACE)? = Some(Candidate {
        transaction,
        session,
        rebind,
    });
    Ok(handle)
}

#[tauri::command]
pub(crate) async fn commit_space_switch(
    state: tauri::State<'_, SpaceRegistry>,
    space: SpaceHandle,
) -> Result<SpaceHandle, String> {
    commit_switch_at(&state, space).await
}

async fn commit_switch_at(
    state: &SpaceRegistry,
    space: SpaceHandle,
) -> Result<SpaceHandle, String> {
    let session = state.candidate_snapshot(&space)?.ok_or(STALE_SPACE)?;
    let rebound = {
        let mut candidate = state.candidate.lock().map_err(|_| STALE_SPACE)?;
        let slot = candidate.as_mut().ok_or(STALE_SPACE)?;
        if let Some((old, proved_at)) = &slot.rebind {
            if proved_at.elapsed() >= Duration::from_secs(60) || slot.session != session {
                return Err(STALE_SPACE.into());
            }
            let origin =
                crate::spaces::canonical_base(&session.deployment().base()?.ok_or("缺少地址")?);
            let committed = slot.transaction.commit_rebind(old, &origin)?;
            Some((committed, candidate.take().ok_or(STALE_SPACE)?))
        } else {
            None
        }
    };
    if let Some((committed, transaction)) = rebound {
        // The old bearer becomes usable only after the session commit and pin recovery finish.
        if let Some(token) = committed.auth_token() {
            let (base, client) = state.connection(Some(&committed))?;
            if crate::runtime_env::read_session_for_recovery_at(&state.runtime_root)? != committed {
                return Err(STALE_SPACE.into());
            }
            let response = client
                .get(route_url(&base, &["api", "auth", "me"])?)
                .bearer_auth(token)
                .timeout(Duration::from_secs(20))
                .send()
                .await;
            let invalid = match response {
                Ok(response) => {
                    let status = response.status();
                    match read_response(response, Some(token)).await {
                        Ok(response) => {
                            status == reqwest::StatusCode::UNAUTHORIZED
                                || (status.is_success()
                                    && !matches!(response.body, ResponseBody::Json(ref value) if value["user"]["id"].as_str() == Some(committed.user_id())))
                        }
                        Err(_) => status == reqwest::StatusCode::UNAUTHORIZED,
                    }
                }
                Err(_) => false,
            };
            if invalid {
                drop(transaction);
                crate::runtime_env::clear_runtime_session_if_current_at(
                    &state.runtime_root,
                    &committed,
                )?;
                return Ok(SpaceRegistry::handle(Some(&runtime_session_snapshot_at(
                    &state.runtime_root,
                )?)));
            }
        }
        drop(transaction);
        return Ok(SpaceRegistry::handle(Some(&committed)));
    }
    if session.deployment().profile() != "local" {
        crate::spaces::verify_remote_identity(&session).await?;
        crate::spaces::verify_initialized(&session).await?;
        let token = session.auth_token().ok_or("请先登录目标空间")?;
        let (base, client) = state.connection(Some(&session))?;
        let response = client
            .get(route_url(&base, &["api", "auth", "me"])?)
            .bearer_auth(token)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(network_error)?;
        let response = read_response(response, Some(token)).await?;
        let ResponseBody::Json(value) = response.body else {
            return Err("无法验证目标账号".into());
        };
        if response.status != 200 || value["user"]["id"].as_str() != Some(session.user_id()) {
            return Err("目标账号验证失败".into());
        }
    }
    let mut candidate = state.candidate.lock().map_err(|_| STALE_SPACE)?;
    let slot = candidate.as_mut().ok_or(STALE_SPACE)?;
    if slot.session != session {
        return Err(STALE_SPACE.into());
    }
    let committed = slot.transaction.commit(
        session.deployment().clone(),
        session.auth_token().map(|token| (token, session.user_id())),
    )?;
    *candidate = None;
    Ok(SpaceRegistry::handle(Some(&committed)))
}

#[tauri::command]
pub(crate) fn cancel_space_switch(
    state: tauri::State<'_, SpaceRegistry>,
    space: SpaceHandle,
) -> Result<(), String> {
    let mut candidate = state.candidate.lock().map_err(|_| STALE_SPACE)?;
    let slot = candidate.as_mut().ok_or(STALE_SPACE)?;
    if SpaceRegistry::handle(Some(&slot.session)) != space {
        return Err(STALE_SPACE.into());
    }
    slot.transaction.cancel()?;
    *candidate = None;
    Ok(())
}

#[tauri::command]
pub(crate) async fn auth_state(
    state: tauri::State<'_, SpaceRegistry>,
) -> Result<AuthState, String> {
    if matches!(state.snapshot(true).await, Ok(None)) {
        let root = state.runtime_root.clone();
        tokio::task::spawn_blocking(move || crate::runtime_env::ensure_runtime_session_at(&root))
            .await
            .map_err(|_| "本机 skillhub 命令同步失败：无法创建游客会话")??;
    }
    let (session, error) = match state.snapshot(true).await {
        Ok(session) => (session, None),
        Err(_) => {
            let root = state.runtime_root.clone();
            let recovered = tokio::task::spawn_blocking(move || {
                crate::runtime_env::recover_unreadable_session_at(&root)
            })
            .await
            .map_err(|_| "无法读取 SkillHub 运行时会话")?;
            match recovered {
                Ok(session) => (
                    Some(session),
                    Some("本机登录信息无法读取，已保留恢复副本，请重新登录".to_string()),
                ),
                Err(error) => (None, Some(error)),
            }
        }
    };
    let pending = state
        .transitions
        .lock()
        .map_err(|_| STALE_SPACE)?
        .pending
        .is_some()
        || session
            .as_ref()
            .is_some_and(RuntimeSession::is_sync_pending);
    Ok(AuthState {
        space: SpaceRegistry::handle(session.as_ref()),
        user_id: session
            .as_ref()
            .filter(|session| session.auth_token().is_some())
            .map(|session| session.user_id().to_string()),
        pending,
        error,
    })
}

#[tauri::command]
pub(crate) async fn clear_auth_session(
    state: tauri::State<'_, SpaceRegistry>,
    space: SpaceHandle,
) -> Result<Option<SpaceHandle>, String> {
    state.invalidate(&space).await
}

#[tauri::command]
pub(crate) async fn import_legacy_auth(
    state: tauri::State<'_, SpaceRegistry>,
    token: String,
) -> Result<bool, String> {
    state.import_legacy(token).await
}

#[tauri::command]
pub(crate) async fn server_request(
    state: tauri::State<'_, SpaceRegistry>,
    request: ServerRequest,
) -> Result<tauri::ipc::Response, String> {
    // Lease input and generated profiles never cross the WebView boundary.
    if request.route.name().starts_with("localAi.") {
        return Err("本机 AI 租约仅供原生 worker 使用".into());
    }
    state.request(request).await?.into_ipc()
}

#[tauri::command]
pub(crate) fn cancel_server_request(
    state: tauri::State<'_, SpaceRegistry>,
    space: SpaceHandle,
    request_id: String,
) -> Result<bool, String> {
    state.cancel(&space, &request_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn socket_rebind_token_only_after_confirmation_and_commit_at_exact_base() {
        use crate::spaces::rebind_tests::{deployment, Home, HttpFixture};
        let home = Home::new();
        let source = home.signed_in(deployment("https://old.test/prefix"));
        let server = HttpFixture::start("ok");
        let registry =
            SpaceRegistry::new(Url::parse("https://official.test").unwrap(), home.0.clone())
                .unwrap();
        let report = crate::spaces::test_connection(&home.0, &server.origin).await;
        assert!(report.rebind.unwrap().active);
        assert!(server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| !r.to_ascii_lowercase().contains("authorization:")));
        let handle = begin_switch_at(
            &registry,
            SpaceRegistry::handle(Some(&source)),
            server.origin.clone(),
            true,
        )
        .await
        .unwrap();
        let candidate = registry.candidate_snapshot(&handle).unwrap().unwrap();
        assert!(candidate.auth_token().is_none());
        assert!(registry
            .establish_candidate(&candidate, "forged-token", source.user_id())
            .is_err());
        assert!(server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| !r.to_ascii_lowercase().contains("authorization:")));
        {
            let mut slot = registry.candidate.lock().unwrap();
            slot.as_mut().unwrap().transaction.cancel().unwrap();
            *slot = None;
        }
        assert!(commit_switch_at(&registry, handle).await.is_err());
        assert!(server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| !r.to_ascii_lowercase().contains("authorization:")));
        let current = runtime_session_snapshot_at(&home.0).unwrap();
        let handle = begin_switch_at(
            &registry,
            SpaceRegistry::handle(Some(&current)),
            server.origin.clone(),
            true,
        )
        .await
        .unwrap();
        crate::runtime_env::TEST_FINAL_PIN_POST_REPLACE_ERROR.with(|fail| fail.set(true));
        let result = commit_switch_at(&registry, handle.clone()).await.unwrap();
        assert!(
            commit_switch_at(&registry, handle).await.is_err(),
            "one-time confirmation"
        );
        let committed = runtime_session_snapshot_at(&home.0).unwrap();
        assert_eq!(result.space_id, source.space_id());
        assert_eq!(committed.auth_token(), source.auth_token());
        assert_eq!(
            crate::spaces::canonical_base(&committed.server_origin().unwrap()),
            server.origin
        );
        let requests = server.requests.lock().unwrap();
        let authenticated: Vec<_> = requests
            .iter()
            .filter(|r| r.to_ascii_lowercase().contains("authorization:"))
            .collect();
        assert_eq!(authenticated.len(), 1);
        assert!(authenticated[0].starts_with("GET /prefix/api/auth/me "));
        assert!(authenticated[0].contains("Bearer fixture-old-token"));
    }

    #[tokio::test]
    async fn socket_rebind_401_keeps_space_and_inactive_space_never_inherits_token() {
        use crate::spaces::rebind_tests::{deployment, Home, HttpFixture};
        for active in [true, false] {
            let home = Home::new();
            let original = home.signed_in(deployment("https://old.test/prefix"));
            if !active {
                home.signed_in(crate::spaces::Deployment::Official);
            }
            let source = runtime_session_snapshot_at(&home.0).unwrap();
            let server = HttpFixture::start("unauthorized");
            let registry =
                SpaceRegistry::new(Url::parse("https://official.test").unwrap(), home.0.clone())
                    .unwrap();
            let handle = begin_switch_at(
                &registry,
                SpaceRegistry::handle(Some(&source)),
                server.origin.clone(),
                true,
            )
            .await
            .unwrap();
            commit_switch_at(&registry, handle).await.unwrap();
            let committed = runtime_session_snapshot_at(&home.0).unwrap();
            assert_eq!(committed.space_id(), original.space_id());
            assert!(committed.auth_token().is_none());
            if !active {
                assert!(server
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .all(|r| !r.to_ascii_lowercase().contains("authorization:")));
                let login = begin_switch_at(
                    &registry,
                    SpaceRegistry::handle(Some(&committed)),
                    server.origin.clone(),
                    false,
                )
                .await
                .unwrap();
                assert_eq!(
                    login.space_id,
                    original.space_id(),
                    "the login after rebind must retain the original data space"
                );
                let candidate = registry.candidate_snapshot(&login).unwrap().unwrap();
                registry
                    .establish_candidate(&candidate, "new-login-token", original.user_id())
                    .unwrap();
                let mut slot = registry.candidate.lock().unwrap();
                slot.as_mut().unwrap().transaction.cancel().unwrap();
                *slot = None;
            }
        }
    }

    #[tokio::test]
    async fn socket_rebind_impostor_failed_proof_and_expired_candidate_never_receive_token() {
        use crate::spaces::rebind_tests::{deployment, Home, HttpFixture};
        let home = Home::new();
        let source = home.signed_in(deployment("https://old.test/prefix"));
        let registry =
            SpaceRegistry::new(Url::parse("https://official.test").unwrap(), home.0.clone())
                .unwrap();
        let impostor = HttpFixture::start("impostor");
        assert!(begin_switch_at(
            &registry,
            SpaceRegistry::handle(Some(&source)),
            impostor.origin.clone(),
            true
        )
        .await
        .is_err());
        assert!(impostor
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| !r.to_ascii_lowercase().contains("authorization:")));
        assert_eq!(
            runtime_session_snapshot_at(&home.0).unwrap().auth_token(),
            source.auth_token()
        );
        let server = HttpFixture::start("ok");
        let current = runtime_session_snapshot_at(&home.0).unwrap();
        let handle = begin_switch_at(
            &registry,
            SpaceRegistry::handle(Some(&current)),
            server.origin.clone(),
            true,
        )
        .await
        .unwrap();
        registry
            .candidate
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .rebind
            .as_mut()
            .unwrap()
            .1 -= Duration::from_secs(61);
        assert!(commit_switch_at(&registry, handle).await.is_err());
        assert!(server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| !r.to_ascii_lowercase().contains("authorization:")));
    }
    use crate::runtime_env::test_sessions;
    use std::sync::Arc;
    use tauri::ipc::{InvokeResponseBody, IpcResponse};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    struct TestRoot(PathBuf);
    impl TestRoot {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("skillhub-net-{}", uuid::Uuid::new_v4())))
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn request(route: &str) -> ServerRequest {
        ServerRequest {
            request_id: "request-1".into(),
            space: SpaceRegistry::handle(None),
            route: Route::try_from(route.to_string()).unwrap(),
            params: RouteParams::new(),
            query: RouteParams::new(),
            body: None,
            timeout_ms: Some(2_000),
        }
    }

    #[test]
    fn candidate_login_and_setup_keep_tokens_native_and_cancel_restores_source() {
        use base64::Engine as _;
        for route in ["auth.login", "auth.register", "setup.admin"] {
            let root = TestRoot::new();
            let user = uuid::Uuid::new_v4().to_string();
            test_sessions::sign_in(&root.0, &user);
            let source = runtime_session_snapshot_at(&root.0).unwrap();
            let registry =
                SpaceRegistry::new(Url::parse("https://official.test").unwrap(), root.0.clone())
                    .unwrap();
            let transaction = crate::spaces::SwitchTransaction::begin(&root.0, false).unwrap();
            let deployment = crate::spaces::Deployment::Selfhost {
                initial_origin: "https://private.test".into(),
                origin: "https://private.test".into(),
                instance: crate::spaces::InstanceIdentity {
                    id: uuid::Uuid::new_v4().to_string(),
                    public_key: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([1; 32]),
                },
            };
            let session = crate::runtime_env::new_space_session_at(
                &root.0,
                deployment,
                None,
                transaction.pending().generation() - 1,
            )
            .unwrap();
            let handle = SpaceRegistry::handle(Some(&session));
            *registry.candidate.lock().unwrap() = Some(Candidate {
                rebind: None,
                transaction,
                session: session.clone(),
            });
            let mut response = ServerResponse {
                space: None,
                status: 201,
                status_text: "Created".into(),
                headers: BTreeMap::new(),
                body: ResponseBody::Json(
                    serde_json::json!({"token":"candidate.secret", "user":{"id":user}}),
                ),
            };
            let route = Route::try_from(route.to_owned()).unwrap();
            registry
                .apply_candidate_effect(
                    &mut response,
                    &session,
                    route.definition().effect("selfhost").unwrap(),
                )
                .unwrap();
            assert!(!serde_json::to_string(&response)
                .unwrap()
                .contains("candidate.secret"));
            let candidate = registry.candidate_snapshot(&handle).unwrap().unwrap();
            assert_eq!(candidate.auth_token(), Some("candidate.secret"));
            let disk = runtime_session_snapshot_at(&root.0).unwrap();
            assert_eq!(disk.auth_token(), source.auth_token());
            assert!(disk.is_sync_pending());
            let mut failed = ServerResponse {
                space: None,
                status: 401,
                status_text: "Unauthorized".into(),
                headers: BTreeMap::new(),
                body: ResponseBody::Json(serde_json::json!({"error":"invalid password"})),
            };
            registry
                .apply_candidate_effect(&mut failed, &candidate, Some("establish"))
                .unwrap();
            assert_eq!(runtime_session_snapshot_at(&root.0).unwrap(), disk);
            registry
                .candidate
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .transaction
                .cancel()
                .unwrap();
            assert!(registry
                .establish_candidate(&candidate, "late-token", &user)
                .is_err());
            let restored = runtime_session_snapshot_at(&root.0).unwrap();
            assert_eq!(restored.auth_token(), source.auth_token());
            assert!(restored.generation() > disk.generation());
        }
    }

    #[test]
    fn registry_rejects_urls_unknown_routes_parameters_and_auth_mutations() {
        for route in ["https://example.com", "/api/auth/me", "other"] {
            assert!(serde_json::from_value::<Route>(Value::String(route.into())).is_err());
        }
        assert!(Route::try_from("health".to_string())
            .unwrap()
            .resolve(
                &Url::parse("https://example.com").unwrap(),
                &BTreeMap::from([("url".into(), "https://example.com".into())]),
                &RouteParams::new(),
            )
            .is_err());
        assert!(serde_json::from_value::<ServerRequest>(serde_json::json!({
            "requestId": "r", "space": {"spaceId":"official", "generation":0},
            "route":"health", "url":"https://example.com"
        }))
        .is_err());
        let base = Url::parse("https://example.com/skillhub/").unwrap();
        assert_eq!(
            route_url(&base, &["api", "auth", "me"]).unwrap().as_str(),
            "https://example.com/skillhub/api/auth/me"
        );
        assert_eq!(
            route_url(&base, &["items", "a/b ?#%", "https://evil.test"])
                .unwrap()
                .as_str(),
            "https://example.com/skillhub/items/a%2Fb%20%3F%23%25/https:%2F%2Fevil.test"
        );
        assert!(route_url(&base, &[".."]).is_err());
    }

    #[tokio::test]
    async fn rejects_stale_handles_guests_bodies_and_duplicate_ids_before_io() {
        let root = TestRoot::new();
        let registry =
            SpaceRegistry::new(Url::parse("http://127.0.0.1:1").unwrap(), root.0.clone()).unwrap();
        let mut stale = request("health");
        stale.space.generation = 1;
        assert_eq!(registry.request(stale).await.unwrap_err(), STALE_SPACE);
        let mut foreign = request("health");
        foreign.space.space_id = "other".into();
        assert_eq!(registry.request(foreign).await.unwrap_err(), STALE_SPACE);
        assert!(registry
            .request(request("auth.me"))
            .await
            .unwrap_err()
            .contains("登录"));
        for body in [RequestBody::Json(Value::Null), RequestBody::Bytes(vec![1])] {
            let mut with_body = request("health");
            with_body.body = Some(body);
            assert!(registry
                .request(with_body)
                .await
                .unwrap_err()
                .contains("请求体"));
        }
        let pending = request("health");
        let (lease, _cancel) = registry.begin(&pending).unwrap();
        assert!(registry.begin(&pending).is_err());
        assert!(!registry
            .cancel(
                &SpaceHandle {
                    space_id: "other".into(),
                    generation: 0
                },
                &pending.request_id
            )
            .unwrap());
        drop(lease);
        assert!(registry.requests.lock().unwrap().is_empty());
        assert!(
            !root.0.exists(),
            "guest requests must not create session files"
        );
    }

    async fn fixture(response: Vec<u8>) -> (Url, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!(
            "http://{}/skillhub",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let count = socket.read(&mut request).await.unwrap();
            socket.write_all(&response).await.unwrap();
            String::from_utf8(request[..count].to_vec()).unwrap()
        });
        (base, server)
    }

    fn http_response(status: u16, headers: &str, body: &[u8]) -> Vec<u8> {
        let mut bytes = format!(
            "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
            body.len()
        )
        .into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }

    #[tokio::test]
    async fn sequential_requests_reuse_one_connection_with_request_local_headers() {
        let root = TestRoot::new();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let registry = SpaceRegistry::new(base, root.0.clone()).unwrap();
        let server = tokio::spawn(async move {
            // Accept only once: both requests must arrive on this same connection.
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = BufReader::new(socket);
            for authenticated in [true, false] {
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    assert!(socket.read_until(b'\n', &mut headers).await.unwrap() > 0);
                    assert!(headers.len() < 4096);
                }
                let headers = String::from_utf8(headers).unwrap().to_ascii_lowercase();
                assert!(headers.starts_with(if authenticated {
                    "get /api/auth/me http/1.1\r\n"
                } else {
                    "get /health http/1.1\r\n"
                }));
                assert_eq!(
                    headers.contains("authorization: bearer fixture.jwt\r\n"),
                    authenticated
                );
                assert_eq!(
                    headers.contains("cache-control: no-store\r\n"),
                    authenticated
                );
                assert!(!headers.contains("cookie:"));
                socket.get_mut().write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: application/json\r\nSet-Cookie: fixture=value\r\nConnection: keep-alive\r\n\r\n{}",
                ).await.unwrap();
            }
        });
        crate::runtime_env::replace_session_at(
            &root.0,
            &root.0.join("skills"),
            None,
            Some(("fixture.jwt", &uuid::Uuid::new_v4().to_string())),
        )
        .unwrap();
        // A bounded (non-zero) and an unbounded request; the values only need to exceed a loaded
        // build machine's loopback latency, the outer bound only guards hangs.
        tokio::time::timeout(Duration::from_secs(60), async {
            for timeout in [20_000, 0] {
                let mut pending = request(if timeout > 0 { "auth.me" } else { "health" });
                pending.space =
                    SpaceRegistry::handle(registry.snapshot(false).await.unwrap().as_ref());
                pending.timeout_ms = Some(timeout);
                let response = registry.request(pending).await.unwrap();
                assert_eq!(response.status, 200);
                assert_eq!(response.body, ResponseBody::Json(serde_json::json!({})));
            }
            server.await.unwrap();
        })
        .await
        .expect("both requests must complete on the single accepted connection");
    }

    #[tokio::test]
    async fn response_contract_and_binary_frame_without_network() {
        for (status, mime, bytes, expected) in [
            (
                429,
                "application/problem+json",
                b"{\"error\":\"busy\"}".to_vec(),
                ResponseBody::Json(serde_json::json!({"error":"busy"})),
            ),
            (
                200,
                "application/octet-stream",
                vec![0, 255],
                ResponseBody::Bytes(vec![0, 255]),
            ),
            (204, "application/json", vec![], ResponseBody::Empty),
        ] {
            let response = tauri::http::Response::builder()
                .status(status)
                .header("Content-Type", mime)
                .header("Retry-After", "2")
                .header("Set-Cookie", "private")
                .body(bytes.clone())
                .unwrap();
            let decoded = read_response(response.into(), None).await.unwrap();
            assert_eq!(decoded.status, status);
            assert_eq!(decoded.body, expected);
            assert_eq!(decoded.headers.len(), 2);
            let wire = decoded.into_ipc().unwrap().body().unwrap();
            if let ResponseBody::Bytes(_) = expected {
                let InvokeResponseBody::Raw(frame) = wire else {
                    panic!("expected binary IPC")
                };
                let length = u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize;
                let metadata: Value = serde_json::from_slice(&frame[4..4 + length]).unwrap();
                assert_eq!(metadata["status"], status);
                assert_eq!(&frame[4 + length..], bytes);
            } else {
                assert!(matches!(wire, InvokeResponseBody::Json(_)));
            }
        }
        let oversized = tauri::http::Response::builder()
            .header("Content-Length", MAX_RESPONSE_BYTES + 1)
            .body(vec![0u8; MAX_RESPONSE_BYTES + 1])
            .unwrap();
        assert!(read_response(oversized.into(), None)
            .await
            .unwrap_err()
            .contains("过大"));
        for (header, bytes) in [
            ("safe", b"{\"token\":\"fixture\\u002eJWT\"}".to_vec()),
            ("fixture.JWT", vec![]),
            ("safe", b"fixture.JWT".to_vec()),
        ] {
            let reflected = tauri::http::Response::builder()
                .header("X-Request-ID", header)
                .body(bytes)
                .unwrap();
            assert!(read_response(reflected.into(), Some("fixture.JWT"))
                .await
                .unwrap_err()
                .contains("凭据"));
        }
    }

    #[tokio::test]
    async fn session_token_and_pending_state_never_accept_frontend_credentials() {
        let root = TestRoot::new();
        let user = uuid::Uuid::new_v4().to_string();
        test_sessions::sign_in(&root.0, &user);
        let registry =
            SpaceRegistry::new(Url::parse("http://127.0.0.1:1").unwrap(), root.0.clone()).unwrap();
        let session = registry.snapshot(false).await.unwrap();
        assert_eq!(
            request_bearer(session.as_ref(), true, false).unwrap(),
            session.as_ref().unwrap().auth_token()
        );
        assert_eq!(
            request_bearer(session.as_ref(), false, false).unwrap(),
            None
        );
        assert!(request_bearer(None, true, false).is_err());
        assert!(serde_json::from_value::<ServerRequest>(serde_json::json!({
            "requestId":"r", "space":{"spaceId":"official", "generation":0}, "route":"auth.me", "bearer":"forbidden"
        })).is_err());
        test_sessions::begin_switch(&root.0);
        assert!(registry
            .snapshot(false)
            .await
            .unwrap_err()
            .contains("同步账号"));
        assert_eq!(
            registry.snapshot(true).await.unwrap().unwrap().generation(),
            1
        );
    }

    #[tokio::test]
    async fn optional_auth_uses_native_token_or_accepts_guest_without_a_token() {
        let root = TestRoot::new();
        test_sessions::sign_in(&root.0, &uuid::Uuid::new_v4().to_string());
        let signed_in = runtime_session_snapshot_at(&root.0).unwrap();
        test_sessions::sign_out(&root.0);
        let guest = runtime_session_snapshot_at(&root.0).unwrap();
        for id in [
            "feedback.create",
            "marketplace.install-intents.create",
            "marketplace.install-intents.update",
        ] {
            let route = Route::try_from(id.to_string()).unwrap();
            let definition = route.definition();
            for session in [Some(&signed_in), Some(&guest), None] {
                assert_eq!(
                    request_bearer(session, definition.auth, definition.optional).unwrap(),
                    session.and_then(RuntimeSession::auth_token),
                    "{id}",
                );
            }
        }
    }

    #[tokio::test]
    async fn optional_routes_send_bearer_only_for_signed_in_requests() {
        for signed_in in [true, false] {
            for (id, parameter) in [
                ("feedback.create", None),
                ("marketplace.install-intents.create", Some("skillId")),
                ("marketplace.install-intents.update", Some("intentId")),
            ] {
                let root = TestRoot::new();
                if signed_in {
                    test_sessions::sign_in(&root.0, &uuid::Uuid::new_v4().to_string());
                } else {
                    test_sessions::sign_out(&root.0);
                }
                let (base, server) = fixture(http_response(
                    200,
                    "Content-Type: application/json\r\n",
                    b"{}",
                ))
                .await;
                let registry = SpaceRegistry::new(base, root.0.clone()).unwrap();
                let session = registry.snapshot(false).await.unwrap();
                let mut pending = request(id);
                pending.space = SpaceRegistry::handle(session.as_ref());
                if let Some(parameter) = parameter {
                    pending.params.insert(parameter.into(), "fixture".into());
                }
                assert_eq!(registry.request(pending).await.unwrap().status, 200);
                let received = server.await.unwrap().to_ascii_lowercase();
                if let Some(token) = session.as_ref().and_then(RuntimeSession::auth_token) {
                    assert!(received.contains(&format!("authorization: bearer {token}\r\n")));
                } else {
                    assert!(!received.contains("authorization:"));
                }
            }
        }
    }

    #[tokio::test]
    async fn native_effects_strip_tokens_establish_replace_and_clear_sessions() {
        let root = TestRoot::new();
        let registry =
            SpaceRegistry::new(Url::parse("http://127.0.0.1:1").unwrap(), root.0.clone()).unwrap();
        let user = uuid::Uuid::new_v4().to_string();
        for effect in ["establish", "replace"] {
            let previous = registry.snapshot(false).await.unwrap();
            let transition = registry.transition(previous.as_ref()).await.unwrap();
            let mut response = ServerResponse {
                space: None,
                status: 200,
                status_text: "OK".into(),
                headers: BTreeMap::new(),
                body: ResponseBody::Json(
                    serde_json::json!({"token":"new.jwt", "user":{"id":user}}),
                ),
            };
            registry
                .apply_session_effect(&mut response, Some(effect), Some(&transition), None, None)
                .await
                .unwrap();
            assert!(!serde_json::to_string(&response)
                .unwrap()
                .contains("new.jwt"));
            let current = registry.snapshot(false).await.unwrap().unwrap();
            assert_eq!(current.auth_token(), Some("new.jwt"));
            assert_eq!(
                current.generation(),
                previous.as_ref().map_or(0, RuntimeSession::generation) + 1
            );
        }
        let previous = registry.snapshot(false).await.unwrap();
        let transition = registry.transition(previous.as_ref()).await.unwrap();
        let mut response = ServerResponse {
            space: None,
            status: 204,
            status_text: "".into(),
            headers: BTreeMap::new(),
            body: ResponseBody::Empty,
        };
        registry
            .apply_session_effect(
                &mut response,
                Some("clear"),
                Some(&transition),
                Some("new.jwt"),
                None,
            )
            .await
            .unwrap();
        assert!(registry
            .snapshot(false)
            .await
            .unwrap()
            .unwrap()
            .auth_token()
            .is_none());
    }

    #[tokio::test]
    async fn logout_401_clears_but_server_failure_keeps_the_session() {
        for status in [401, 500] {
            let root = TestRoot::new();
            test_sessions::sign_in(&root.0, &uuid::Uuid::new_v4().to_string());
            let registry =
                SpaceRegistry::new(Url::parse("http://127.0.0.1:1").unwrap(), root.0.clone())
                    .unwrap();
            let previous = registry.snapshot(false).await.unwrap();
            let transition = registry.transition(previous.as_ref()).await.unwrap();
            let mut response = ServerResponse {
                space: None,
                status,
                status_text: String::new(),
                headers: BTreeMap::new(),
                body: ResponseBody::Empty,
            };
            registry
                .apply_session_effect(&mut response, Some("clear"), Some(&transition), None, None)
                .await
                .unwrap();
            let current = registry.snapshot(false).await.unwrap();
            if status == 401 {
                assert!(current.unwrap().auth_token().is_none());
            } else {
                assert!(current == previous);
            }
        }
    }

    #[tokio::test]
    async fn explicit_clear_recovers_old_pending_session_and_ignores_stale_space() {
        let root = TestRoot::new();
        test_sessions::begin_switch(&root.0);
        let registry =
            SpaceRegistry::new(Url::parse("http://127.0.0.1:1").unwrap(), root.0.clone()).unwrap();
        let previous = registry.snapshot(true).await.unwrap();
        let space = SpaceRegistry::handle(previous.as_ref());
        let cleared = registry.invalidate(&space).await.unwrap().unwrap();
        assert!(cleared.generation > space.generation);
        assert!(registry
            .snapshot(false)
            .await
            .unwrap()
            .unwrap()
            .auth_token()
            .is_none());
        assert!(registry.invalidate(&space).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn legacy_import_valid_rejected_and_network_failure_preserve_the_right_session() {
        let root = TestRoot::new();
        let registry =
            SpaceRegistry::new(Url::parse("http://127.0.0.1:1").unwrap(), root.0.clone()).unwrap();
        let user = uuid::Uuid::new_v4().to_string();
        test_sessions::sign_in(&root.0, &user);
        for status in [401, 503, 200] {
            let before = std::fs::read(root.0.join("runtime/session.json")).unwrap();
            let previous = registry.snapshot(false).await.unwrap();
            let transition = registry.transition(previous.as_ref()).await.unwrap();
            let response = ServerResponse {
                space: None,
                status,
                status_text: "".into(),
                headers: BTreeMap::new(),
                body: ResponseBody::Json(serde_json::json!({"user":{"id":user}})),
            };
            let result = registry
                .finish_legacy_import(&transition, "import.jwt", response)
                .await;
            if status == 200 {
                assert!(result.unwrap());
                assert_eq!(
                    registry
                        .snapshot(false)
                        .await
                        .unwrap()
                        .unwrap()
                        .auth_token(),
                    Some("import.jwt")
                );
            } else {
                if status == 401 {
                    assert!(!result.unwrap());
                } else {
                    assert!(result.is_err());
                }
                assert_eq!(
                    std::fs::read(root.0.join("runtime/session.json")).unwrap(),
                    before
                );
            }
        }
        let before = std::fs::read(root.0.join("runtime/session.json")).unwrap();
        assert!(registry
            .import_legacy("unreachable.jwt".into())
            .await
            .is_err());
        assert_eq!(
            std::fs::read(root.0.join("runtime/session.json")).unwrap(),
            before
        );
    }

    #[tokio::test]
    async fn migration_login_never_writes_runtime_and_reflected_tokens_are_rejected() {
        let root = TestRoot::new();
        let registry =
            SpaceRegistry::new(Url::parse("http://127.0.0.1:1").unwrap(), root.0.clone()).unwrap();
        let user = uuid::Uuid::new_v4().to_string();
        let transition = registry.transition(None).await.unwrap();
        let attempt = registry.portal.begin_migration().unwrap();
        let mut response = ServerResponse {
            space: None,
            status: 200,
            status_text: "".into(),
            headers: BTreeMap::new(),
            body: ResponseBody::Json(
                serde_json::json!({"token":"migration.jwt", "user":{"id":user}}),
            ),
        };
        registry
            .apply_session_effect(
                &mut response,
                Some("migration"),
                Some(&transition),
                None,
                Some(attempt),
            )
            .await
            .unwrap();
        assert!(!root.0.join("runtime/session.json").exists());
        assert!(!serde_json::to_string(&response)
            .unwrap()
            .contains("migration.jwt"));
        response.body = ResponseBody::Json(
            serde_json::json!({"token":"migration.jwt", "user":{"id":user,"displayName":"migration.jwt"}}),
        );
        assert!(registry
            .apply_session_effect(
                &mut response,
                Some("establish"),
                Some(&transition),
                None,
                None
            )
            .await
            .unwrap_err()
            .contains("凭据"));
        assert!(!root.0.join("runtime/session.json").exists());
    }

    #[tokio::test]
    async fn unauthorized_clear_only_matches_the_failed_space() {
        let root = TestRoot::new();
        let registry =
            SpaceRegistry::new(Url::parse("http://127.0.0.1:1").unwrap(), root.0.clone()).unwrap();
        let old = SpaceRegistry::handle(None);
        registry
            .transition(None)
            .await
            .unwrap()
            .commit(Some(("new.jwt", &uuid::Uuid::new_v4().to_string())), None)
            .await
            .unwrap();
        assert!(registry.invalidate(&old).await.unwrap().is_none());
        let current = SpaceRegistry::handle(registry.snapshot(false).await.unwrap().as_ref());
        assert!(registry.invalidate(&current).await.unwrap().is_some());
        assert!(registry
            .snapshot(false)
            .await
            .unwrap()
            .unwrap()
            .auth_token()
            .is_none());
    }

    #[tokio::test]
    async fn later_login_or_logout_wins_and_failed_transition_preserves_disk() {
        let root = TestRoot::new();
        let registry =
            SpaceRegistry::new(Url::parse("http://127.0.0.1:1").unwrap(), root.0.clone()).unwrap();
        for later_login in [true, false] {
            let previous = registry.snapshot(false).await.unwrap();
            let early = registry.transition(previous.as_ref()).await.unwrap();
            let later = registry.transition(previous.as_ref()).await.unwrap();
            let user = uuid::Uuid::new_v4().to_string();
            later
                .commit(
                    if later_login {
                        Some(("new.jwt", &user))
                    } else {
                        None
                    },
                    None,
                )
                .await
                .unwrap();
            assert_eq!(early.commit(None, None).await.unwrap_err(), STALE_SPACE);
            let before = std::fs::read(root.0.join("runtime/session.json")).unwrap();
            let previous = registry.snapshot(false).await.unwrap();
            drop(registry.transition(previous.as_ref()).await.unwrap());
            assert_eq!(
                std::fs::read(root.0.join("runtime/session.json")).unwrap(),
                before
            );
        }
    }

    #[tokio::test]
    async fn accepts_maximum_server_package_size() {
        let bytes = vec![255; 20 * 1024 * 1024];
        let response = tauri::http::Response::builder()
            .header("Content-Length", bytes.len())
            .body(bytes.clone())
            .unwrap();
        assert_eq!(
            read_response(response.into(), None).await.unwrap().body,
            ResponseBody::Bytes(bytes)
        );
    }

    #[tokio::test]
    async fn cancellation_is_remembered_and_dropped_requests_release_their_ids() {
        let root = TestRoot::new();
        let registry =
            SpaceRegistry::new(Url::parse("http://127.0.0.1:1").unwrap(), root.0.clone()).unwrap();
        let pending = request("health");
        let (lease, mut receiver) = registry.begin(&pending).unwrap();
        assert!(registry
            .cancel(&pending.space, &pending.request_id)
            .unwrap());
        receiver.changed().await.unwrap();
        assert!(*receiver.borrow());
        drop(lease);
        assert!(!registry
            .cancel(&pending.space, &pending.request_id)
            .unwrap());
        assert!(registry.begin(&pending).is_ok());
    }

    #[tokio::test]
    async fn passes_status_json_binary_empty_and_only_allowlisted_headers() {
        for (status, content_type, bytes, expected) in [
            (
                429,
                "application/json",
                b"{\"error\":\"busy\"}".to_vec(),
                ResponseBody::Json(serde_json::json!({"error":"busy"})),
            ),
            (
                200,
                "application/octet-stream",
                vec![0, 255, 128],
                ResponseBody::Bytes(vec![0, 255, 128]),
            ),
            (
                200,
                "application/json",
                b"invalid json".to_vec(),
                ResponseBody::Bytes(b"invalid json".to_vec()),
            ),
            (204, "application/json", vec![], ResponseBody::Empty),
            (302, "text/plain", vec![], ResponseBody::Empty),
        ] {
            let root = TestRoot::new();
            let headers = format!("Content-Type: {content_type}\r\nRetry-After: 2\r\nX-Checksum-Sha256: abc\r\nX-Skill-Version: 0.1.0\r\nX-Request-ID: req-1\r\nSet-Cookie: secret\r\nLocation: http://203.0.113.1/\r\n");
            let (base, server) = fixture(http_response(status, &headers, &bytes)).await;
            let registry = SpaceRegistry::new(base, root.0.clone()).unwrap();
            let response = registry.request(request("health")).await.unwrap();
            assert_eq!(response.status, status);
            assert_eq!(response.body, expected);
            assert_eq!(response.headers.len(), 5);
            assert_eq!(response.headers["retry-after"], "2");
            assert_eq!(response.headers["x-request-id"], "req-1");
            let received = server.await.unwrap();
            assert!(received.starts_with("GET /skillhub/health HTTP/1.1"));
            assert!(!received.to_ascii_lowercase().contains("authorization:"));
            let wire = response.into_ipc().unwrap().body().unwrap();
            if let ResponseBody::Bytes(expected) = expected {
                let InvokeResponseBody::Raw(frame) = wire else {
                    panic!("expected binary IPC")
                };
                let length = u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize;
                let metadata: Value = serde_json::from_slice(&frame[4..4 + length]).unwrap();
                assert_eq!(metadata["status"], status);
                assert_eq!(&frame[4 + length..], expected);
            } else {
                assert!(matches!(wire, InvokeResponseBody::Json(_)));
            }
        }
    }

    #[tokio::test]
    async fn auth_me_reads_session_without_writing_or_returning_bearer() {
        let root = TestRoot::new();
        let user = uuid::Uuid::new_v4().to_string();
        test_sessions::sign_in(&root.0, &user);
        let session_path = root.0.join("runtime/session.json");
        let before = std::fs::read(&session_path).unwrap();
        let token = format!("{user}.header.signature");
        for status in [200, 401] {
            let (base, server) = fixture(http_response(
                status,
                "Content-Type: application/json\r\n",
                b"{\"user\":{\"id\":\"fixture\"}}",
            ))
            .await;
            let registry = SpaceRegistry::new(base, root.0.clone()).unwrap();
            let response = registry.request(request("auth.me")).await.unwrap();
            assert_eq!(response.status, status);
            assert!(!serde_json::to_string(&response).unwrap().contains(&token));
            let received = server.await.unwrap();
            assert!(received.starts_with("GET /skillhub/api/auth/me HTTP/1.1"));
            assert!(received.contains(&format!("authorization: Bearer {token}")));
            assert_eq!(std::fs::read(&session_path).unwrap(), before);
        }
        for (headers, bytes) in [
            (
                "Content-Type: application/json\r\n".to_string(),
                format!("{{\"token\":\"{token}\"}}").into_bytes(),
            ),
            (
                "Content-Type: application/octet-stream\r\n".to_string(),
                token.as_bytes().to_vec(),
            ),
            (format!("X-Request-ID: {token}\r\n"), vec![]),
        ] {
            let (base, server) = fixture(http_response(200, &headers, &bytes)).await;
            let registry = SpaceRegistry::new(base, root.0.clone()).unwrap();
            let error = registry.request(request("auth.me")).await.unwrap_err();
            assert!(error.contains("凭据"));
            assert!(!error.contains(&token));
            server.await.unwrap();
            assert_eq!(std::fs::read(&session_path).unwrap(), before);
        }
    }

    #[tokio::test]
    async fn timeout_cancellation_and_session_changes_discard_inflight_results() {
        for action in ["timeout", "cancel", "switch", "replace"] {
            let root = TestRoot::new();
            test_sessions::sign_in(&root.0, &uuid::Uuid::new_v4().to_string());
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let registry = Arc::new(
                SpaceRegistry::new(
                    Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap(),
                    root.0.clone(),
                )
                .unwrap(),
            );
            let mut pending = request("auth.me");
            if action == "timeout" {
                pending.timeout_ms = Some(100);
            }
            let worker = registry.clone();
            let mut task = tokio::spawn(async move { worker.request(pending).await });
            // Under load a 100 ms request may time out before it connects or sends; only that
            // case may finish without the server seeing it. The long bound only guards hangs.
            let accepted = tokio::time::timeout(Duration::from_secs(60), async {
                tokio::select! {
                    accepted = listener.accept() => Ok(accepted.unwrap().0),
                    result = &mut task => Err(result.unwrap()),
                }
            })
            .await
            .expect("request neither connected nor finished");
            let mut socket = match accepted {
                Ok(socket) => socket,
                Err(result) => {
                    assert_eq!(action, "timeout");
                    assert_eq!(result.unwrap_err(), "SkillHub 请求超时，请重试");
                    assert!(registry.requests.lock().unwrap().is_empty());
                    continue;
                }
            };
            let mut received = [0; 4096];
            let read = socket.read(&mut received).await.unwrap_or(0);
            assert!(read > 0 || action == "timeout");
            let expected = match action {
                "cancel" => {
                    assert!(registry
                        .cancel(&SpaceRegistry::handle(None), "request-1")
                        .unwrap());
                    CANCELLED
                }
                "switch" => {
                    test_sessions::begin_switch(&root.0);
                    let current = runtime_session_snapshot_at(&root.0).unwrap();
                    assert_eq!(SpaceRegistry::handle(Some(&current)).generation, 1);
                    socket
                        .write_all(&http_response(
                            200,
                            "Content-Type: application/json\r\n",
                            b"{\"late\":true}",
                        ))
                        .await
                        .unwrap();
                    "SkillHub APP 正在同步账号，请稍后重试"
                }
                "replace" => {
                    test_sessions::sign_in(&root.0, &uuid::Uuid::new_v4().to_string());
                    socket
                        .write_all(&http_response(
                            200,
                            "Content-Type: application/json\r\n",
                            b"{\"late\":true}",
                        ))
                        .await
                        .unwrap();
                    STALE_SPACE
                }
                _ => "SkillHub 请求超时，请重试",
            };
            assert_eq!(task.await.unwrap().unwrap_err(), expected);
            assert!(registry.requests.lock().unwrap().is_empty());
        }
    }
}
