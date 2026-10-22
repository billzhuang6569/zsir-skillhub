//! Account library endpoints (`/api/library`, `/api/cards`) behind a trait so
//! the sync engine can be tested against an in-memory server.

use super::content::ContentIdentity;
use super::profile::SyncProfile;
use crate::version_policy::{RemoteVersion, VersionIntent, VersionReceipt};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;

pub(crate) const LIBRARY_SYNC_CAPABILITY: &str = "skills.library-sync.v1";
const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_CARD_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteCard {
    pub(crate) sha256: String,
    pub(crate) size: u64,
    pub(crate) content_hash: String,
    #[serde(default)]
    pub(crate) executable_paths: Vec<String>,
}

impl RemoteCard {
    pub(crate) fn identity(&self) -> ContentIdentity {
        let mut executable_paths = self.executable_paths.clone();
        executable_paths.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
        ContentIdentity {
            content_hash: self.content_hash.clone(),
            executable_paths,
        }
    }
}

/// One library entry as `GET /api/library` returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteEntry {
    pub(crate) source_origin: Option<String>,
    pub(crate) source_version_id: Option<String>,
    pub(crate) version_state: RemoteVersion,
    pub(crate) accepted_version_receipt: Option<VersionReceipt>,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) revision: u64,
    pub(crate) deleted: bool,
    /// Deleted entries only carry a display name.
    pub(crate) profile: SyncProfile,
    pub(crate) source_kind: String,
    pub(crate) source_skill_id: Option<String>,
    pub(crate) author_skill_id: Option<String>,
    pub(crate) migration_key: Option<String>,
    pub(crate) card: Option<RemoteCard>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEntry {
    #[serde(default)]
    source_origin: Option<String>,
    #[serde(default)]
    source_version_id: Option<String>,
    #[serde(flatten)]
    version_state: RemoteVersion,
    #[serde(default)]
    accepted_version_receipt: Option<VersionReceipt>,
    id: String,
    name: String,
    revision: u64,
    #[serde(default)]
    deleted_at: Option<Value>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    profile: Option<SyncProfile>,
    #[serde(default)]
    source_kind: Option<String>,
    #[serde(default)]
    source_skill_id: Option<String>,
    #[serde(default)]
    author_skill_id: Option<String>,
    #[serde(default)]
    migration_key: Option<String>,
    #[serde(default)]
    card: Option<RemoteCard>,
}

impl From<RawEntry> for RemoteEntry {
    fn from(raw: RawEntry) -> Self {
        let deleted = raw
            .deleted_at
            .as_ref()
            .is_some_and(|value| !value.is_null());
        let profile = raw.profile.unwrap_or_else(|| SyncProfile {
            display_name: raw.display_name.clone().unwrap_or_else(|| raw.name.clone()),
            ..SyncProfile::default()
        });
        Self {
            source_origin: raw.source_origin,
            source_version_id: raw.source_version_id,
            version_state: raw.version_state,
            accepted_version_receipt: raw.accepted_version_receipt,
            id: raw.id,
            name: raw.name,
            revision: raw.revision,
            deleted,
            profile: profile.normalized(),
            source_kind: raw.source_kind.unwrap_or_else(|| "local".into()),
            source_skill_id: raw.source_skill_id,
            author_skill_id: raw.author_skill_id,
            migration_key: raw.migration_key,
            card: raw.card,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Provenance {
    pub(crate) source_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source_skill_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum EntrySource {
    Catalog {
        skill_id: String,
        version: String,
        package_sha256: String,
    },
    Card {
        card_sha256: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        provenance: Option<Provenance>,
    },
    Marketplace {
        skill_id: String,
    },
    Team {
        skill_id: String,
        team_id: String,
    },
    Authored {
        skill_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version_intent: Option<VersionIntent>,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) profile: SyncProfile,
    pub(crate) source: EntrySource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) migration_key: Option<String>,
    pub(crate) device: String,
    /// Whether the server advertises `skills.source-url.v1`; see [`wire_body`].
    #[serde(skip)]
    pub(crate) source_url_synced: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version_intent: Option<VersionIntent>,
    pub(crate) base_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) profile: Option<SyncProfile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source: Option<EntrySource>,
    pub(crate) device: String,
    /// Whether the server advertises `skills.source-url.v1`; see [`wire_body`].
    #[serde(skip)]
    pub(crate) source_url_synced: bool,
    /// The account entry has a source this update deliberately removes: send
    /// an explicit `null`. Otherwise a `None` source is omitted ("keep").
    #[serde(skip)]
    pub(crate) clear_source_url: bool,
}

/// Request body for a create / update. A `None` source is omitted, which the
/// server reads as "keep" on update and "inherit the source version's" on
/// create; `clear_source_url` turns it into an explicit `null` (a deliberate
/// clear). An older server has a strict profile schema, so the field is
/// never sent there.
pub(crate) fn wire_body<T: Serialize>(
    request: &T,
    source_url_synced: bool,
    clear_source_url: bool,
) -> Result<Value, ApiError> {
    let mut body = to_value(request)?;
    if let Some(profile) = body.get_mut("profile").and_then(Value::as_object_mut) {
        if !source_url_synced {
            profile.remove("sourceUrl");
        } else if clear_source_url {
            profile.entry("sourceUrl").or_insert(Value::Null);
        }
    }
    Ok(body)
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnSkill {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) display_name: Option<String>,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) source_url: Option<String>,
    #[serde(default)]
    pub(crate) category: Option<String>,
    #[serde(default)]
    pub(crate) labels: Vec<String>,
    #[serde(default)]
    pub(crate) trigger_scenarios: Vec<String>,
    #[serde(default)]
    pub(crate) compatible_agents: Vec<String>,
    #[serde(default)]
    pub(crate) env_dependencies: Vec<super::profile::SyncEnvDependency>,
}

impl OwnSkill {
    pub(crate) fn profile(&self) -> SyncProfile {
        SyncProfile {
            display_name: self
                .display_name
                .clone()
                .unwrap_or_else(|| self.name.clone()),
            description: self.description.clone(),
            source_url: self.source_url.clone(),
            category: self.category.clone(),
            labels: self.labels.clone(),
            trigger_scenarios: self.trigger_scenarios.clone(),
            compatible_agents: self.compatible_agents.clone(),
            env_dependencies: self.env_dependencies.clone(),
        }
        .normalized()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorAssetSkill {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) current_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuthorAsset {
    pub(crate) skill: AuthorAssetSkill,
    pub(crate) entry: RemoteEntry,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FormalVersion {
    pub(crate) id: String,
    pub(crate) version: String,
    pub(crate) package_sha256: Option<String>,
    #[serde(default)]
    pub(crate) aliases: Vec<String>,
    pub(crate) version_mapping_digest: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReceiptHistory {
    pub(crate) entry_id: String,
    pub(crate) entry_revision: u64,
    pub(crate) version_policy: u8,
    pub(crate) version_high_water: i32,
    pub(crate) version_mapping_digest: Option<String>,
    pub(crate) receipts: Vec<VersionReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ApiError {
    /// The session token is no longer valid; stop and let the APP re-login.
    Unauthorized,
    /// 409; carries the current server entry when the server returned one.
    Conflict {
        code: Option<String>,
        message: String,
        entry: Option<Box<RemoteEntry>>,
    },
    /// Other 4xx: retrying the same request cannot succeed.
    Rejected {
        status: u16,
        message: String,
        code: Option<String>,
    },
    /// Network, timeout or 5xx: retry on a later pass.
    Transient(String),
}

impl ApiError {
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Unauthorized => "登录已失效，请重新登录".into(),
            Self::Conflict { message, code, .. } => code
                .as_ref()
                .map(|code| format!("{code}: {message}"))
                .unwrap_or_else(|| message.clone()),
            Self::Rejected {
                status,
                message,
                code,
            } => code
                .as_ref()
                .map(|code| format!("{code}: {}", describe_rejection(*status, message)))
                .unwrap_or_else(|| describe_rejection(*status, message)),
            Self::Transient(message) => message.clone(),
        }
    }
}

fn describe_rejection(status: u16, message: &str) -> String {
    match status {
        413 => "账号的 Skill 存储空间不足".into(),
        403 => format!("没有权限：{message}"),
        429 => "请求过于频繁，稍后会自动重试".into(),
        _ => message.to_string(),
    }
}

#[allow(async_fn_in_trait)]
pub(crate) trait LibraryApi {
    async fn catalog_install(&self) -> Result<bool, ApiError> {
        Ok(false)
    }
    async fn formal_card(
        &self,
        _skill_id: &str,
        _version_id: &str,
    ) -> Result<Option<RemoteCard>, ApiError> {
        Ok(None)
    }
    async fn receipts(&self, _id: &str) -> Result<Option<ReceiptHistory>, ApiError> {
        Ok(None)
    }
    async fn capabilities(&self) -> Result<Vec<String>, ApiError>;
    async fn list(&self) -> Result<Vec<RemoteEntry>, ApiError>;
    async fn upload_card(&self, package: &[u8]) -> Result<RemoteCard, ApiError>;
    async fn download_card(&self, sha256: &str) -> Result<Vec<u8>, ApiError>;
    async fn download_card_progress(
        &self,
        sha256: &str,
        progress: &dyn Fn(u64, Option<u64>),
    ) -> Result<Vec<u8>, ApiError> {
        let bytes = self.download_card(sha256).await?;
        progress(bytes.len() as u64, Some(bytes.len() as u64));
        Ok(bytes)
    }
    /// `None` when the account holds no grant for this card.
    async fn card_meta(&self, sha256: &str) -> Result<Option<RemoteCard>, ApiError>;
    async fn create_entry(&self, request: &CreateEntry) -> Result<RemoteEntry, ApiError>;
    async fn update_entry(&self, id: &str, request: &UpdateEntry) -> Result<RemoteEntry, ApiError>;
    async fn delete_entry(
        &self,
        id: &str,
        base_revision: u64,
        device: &str,
    ) -> Result<RemoteEntry, ApiError>;
    async fn restore_entry(
        &self,
        id: &str,
        base_revision: u64,
        device: &str,
    ) -> Result<RemoteEntry, ApiError>;
    async fn author_asset(&self, id: &str) -> Result<AuthorAsset, ApiError>;
    async fn own_skills(&self) -> Result<Vec<OwnSkill>, ApiError>;
}

pub(crate) fn device_label() -> String {
    if cfg!(windows) {
        "Windows".into()
    } else if cfg!(target_os = "macos") {
        "macOS".into()
    } else {
        "Desktop".into()
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_resource_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// HTTPS client for the configured SkillHub Server, authenticated with the
/// APP session token captured when the sync run started.
pub(crate) struct HttpLibraryApi {
    client: Client,
    origin: Url,
    token: String,
    session: Option<crate::runtime_env::RuntimeSession>,
}

impl Drop for HttpLibraryApi {
    fn drop(&mut self) {
        use zeroize::Zeroize as _;
        self.token.zeroize();
    }
}

struct Response {
    status: StatusCode,
    headers: reqwest::header::HeaderMap,
    body: Vec<u8>,
}

impl HttpLibraryApi {
    pub(crate) async fn formal_version_by_label(
        &self,
        skill_id: &str,
        label: &str,
    ) -> Result<FormalVersion, ApiError> {
        let versions: Vec<FormalVersion> = self
            .json(
                Method::GET,
                &format!("api/skills/{skill_id}/versions"),
                None,
            )
            .await?;
        let mut matching = versions.into_iter().filter(|v| v.version == label);
        let first = matching
            .next()
            .ok_or_else(|| ApiError::Transient("作者资产当前版本不存在".into()))?;
        if matching.next().is_some() {
            return Err(ApiError::Transient("作者版本身份有歧义".into()));
        }
        Ok(first)
    }
    pub(crate) async fn formal_version(
        &self,
        skill_id: &str,
        version_id: &str,
    ) -> Result<FormalVersion, ApiError> {
        let versions: Vec<FormalVersion> = self
            .json(
                Method::GET,
                &format!("api/skills/{skill_id}/versions"),
                None,
            )
            .await?;
        versions
            .into_iter()
            .find(|version| version.id == version_id)
            .ok_or_else(|| ApiError::Transient("正式版本不存在或没有权限".into()))
    }
    pub(crate) fn new(session: &crate::runtime_env::RuntimeSession) -> Result<Self, String> {
        let origin = session.server_origin()?;
        let token = session.auth_token().ok_or("请先登录 SkillHub 后再同步")?;
        let client = crate::net::client_builder(&origin)?
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(90))
            .user_agent(concat!(
                "Yitan-SkillHub/",
                env!("CARGO_PKG_VERSION"),
                " library-sync"
            ))
            .build()
            .map_err(|_| "无法初始化 SkillHub Server 连接".to_string())?;
        Ok(Self {
            client,
            origin,
            token: token.to_string(),
            session: Some(session.clone()),
        })
    }

    fn url(&self, path: &str) -> Url {
        let mut url = self.origin.clone();
        let base = url.path().trim_end_matches('/').to_string();
        url.set_path(&format!("{base}/{path}"));
        url
    }

    pub(crate) async fn author_version_identity(
        &self,
        skill_id: &str,
        version: &str,
    ) -> Result<ContentIdentity, ApiError> {
        uuid::Uuid::parse_str(skill_id).map_err(|_| ApiError::Rejected {
            code: None,
            status: 400,
            message: "作者资产标识无效".into(),
        })?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct VersionPackage {
            version: String,
            package_sha256: Option<String>,
        }
        let versions: Vec<VersionPackage> = self
            .json(
                Method::GET,
                &format!("api/skills/{skill_id}/versions"),
                None,
            )
            .await?;
        let sha = versions
            .iter()
            .find(|item| item.version == version)
            .and_then(|item| item.package_sha256.as_deref())
            .ok_or_else(|| ApiError::Rejected {
                code: None,
                status: 409,
                message: "当前作者版本缺少可核验的内容包，请先在详情发布版本".into(),
            })?;
        self.card_meta(sha)
            .await?
            .map(|card| card.identity())
            .ok_or_else(|| ApiError::Rejected {
                code: None,
                status: 409,
                message: "当前作者版本内容暂不能核验，请稍后重试".into(),
            })
    }

    pub(crate) async fn author_share_state(
        &self,
        skill_id: &str,
        user_id: &str,
    ) -> Result<(String, Vec<String>), ApiError> {
        uuid::Uuid::parse_str(skill_id).map_err(|_| ApiError::Rejected {
            code: None,
            status: 400,
            message: "作者资产标识无效".into(),
        })?;
        #[derive(Deserialize)]
        struct Version {
            version: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Detail {
            author_id: String,
            current_version: String,
            versions: Vec<Version>,
        }
        let detail: Detail = self
            .json(Method::GET, &format!("api/skills/{skill_id}"), None)
            .await?;
        if detail.author_id != user_id {
            return Err(ApiError::Rejected {
                code: None,
                status: 403,
                message: "当前账号不拥有作者权限".into(),
            });
        }
        Ok((
            detail.current_version,
            detail
                .versions
                .into_iter()
                .map(|version| version.version)
                .collect(),
        ))
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        limit: usize,
    ) -> Result<Response, ApiError> {
        self.send_progress(method, path, body, limit, None).await
    }

    async fn send_progress(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        limit: usize,
        progress: Option<&dyn Fn(u64, Option<u64>)>,
    ) -> Result<Response, ApiError> {
        if path != "health" {
            if let Some(session) = &self.session {
                crate::spaces::verify_remote_identity(session)
                    .await
                    .map_err(ApiError::Transient)?;
            }
        }
        let url = self.url(path);
        let mut request = self
            .client
            .request(method, url.clone())
            .header(reqwest::header::CACHE_CONTROL, "no-store");
        if path != "health" {
            request = request.bearer_auth(&self.token);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let mut response = request
            .send()
            .await
            .map_err(|error| ApiError::Transient(format!("无法连接 SkillHub Server: {error}")))?;
        if response.url() != &url {
            return Err(ApiError::Transient("SkillHub Server 响应地址异常".into()));
        }
        let status = response.status();
        let headers = response.headers().clone();
        let total = response.content_length();
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|error| {
            ApiError::Transient(format!("读取 SkillHub Server 响应失败: {error}"))
        })? {
            if body.len() + chunk.len() > limit {
                return Err(ApiError::Transient("SkillHub Server 响应过大".into()));
            }
            body.extend_from_slice(&chunk);
            if status.is_success() {
                if let Some(progress) = progress {
                    progress(body.len() as u64, total);
                }
            }
        }
        Ok(Response {
            status,
            headers,
            body,
        })
    }

    fn error_for(response: &Response) -> ApiError {
        let parsed: Option<Value> = serde_json::from_slice(&response.body).ok();
        let code = parsed
            .as_ref()
            .and_then(|v| v.get("code"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let message = parsed
            .as_ref()
            .and_then(|value| value.get("error").or_else(|| value.get("message")))
            .and_then(Value::as_str)
            .unwrap_or("SkillHub Server 拒绝了请求")
            .chars()
            .take(300)
            .collect::<String>();
        match response.status.as_u16() {
            401 => ApiError::Unauthorized,
            409 => ApiError::Conflict {
                code,
                message,
                entry: parsed
                    .as_ref()
                    .and_then(|value| value.get("entry"))
                    .and_then(|entry| serde_json::from_value::<RawEntry>(entry.clone()).ok())
                    .map(RemoteEntry::from)
                    .map(Box::new),
            },
            429 => ApiError::Transient(describe_rejection(429, &message)),
            status @ 400..=499 => ApiError::Rejected {
                code,
                status,
                message,
            },
            status => ApiError::Transient(format!("SkillHub Server 暂时不可用（{status}）")),
        }
    }

    async fn json<T: for<'de> Deserialize<'de>>(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<T, ApiError> {
        let response = self.send(method, path, body, MAX_JSON_BYTES).await?;
        if !response.status.is_success() {
            return Err(Self::error_for(&response));
        }
        serde_json::from_slice(&response.body)
            .map_err(|_| ApiError::Transient("SkillHub Server 响应格式无效".into()))
    }

    async fn entry(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<RemoteEntry, ApiError> {
        self.json::<RawEntry>(method, path, body)
            .await
            .map(RemoteEntry::from)
    }
}

fn entry_path(id: &str) -> Result<String, ApiError> {
    if !is_resource_id(id) {
        return Err(ApiError::Rejected {
            code: None,
            status: 400,
            message: "条目标识无效".into(),
        });
    }
    Ok(format!("api/library/{id}"))
}

fn card_path(sha256: &str) -> Result<String, ApiError> {
    if !is_sha256(sha256) {
        return Err(ApiError::Rejected {
            code: None,
            status: 400,
            message: "名片标识无效".into(),
        });
    }
    Ok(format!("api/cards/{sha256}"))
}

fn to_value<T: Serialize>(value: &T) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|error| ApiError::Rejected {
        code: None,
        status: 400,
        message: error.to_string(),
    })
}

impl LibraryApi for HttpLibraryApi {
    async fn catalog_install(&self) -> Result<bool, ApiError> {
        if self
            .session
            .as_ref()
            .is_none_or(|s| s.deployment().profile() != "selfhost")
        {
            return Ok(false);
        }
        let info: Value = self.json(Method::GET, "health", None).await?;
        Ok(info["features"]["catalogInstall"].as_bool() == Some(true))
    }
    async fn formal_card(
        &self,
        skill_id: &str,
        version_id: &str,
    ) -> Result<Option<RemoteCard>, ApiError> {
        let version = match self.formal_version(skill_id, version_id).await {
            Ok(version) => version,
            Err(ApiError::Rejected { .. }) => return Ok(None),
            Err(error) => return Err(error),
        };
        let Some(package) = version.package_sha256 else {
            return Ok(None);
        };
        self.card_meta(&package).await
    }
    async fn receipts(&self, id: &str) -> Result<Option<ReceiptHistory>, ApiError> {
        self.json(Method::GET, &format!("api/library/{id}/receipts"), None)
            .await
            .map(Some)
    }
    async fn capabilities(&self) -> Result<Vec<String>, ApiError> {
        #[derive(Deserialize)]
        struct Health {
            #[serde(default)]
            capabilities: Vec<String>,
        }
        let response = self
            .send(Method::GET, "health", None, MAX_JSON_BYTES)
            .await?;
        if !response.status.is_success() {
            return Err(ApiError::Transient(format!(
                "SkillHub Server 暂时不可用（{}）",
                response.status.as_u16()
            )));
        }
        serde_json::from_slice::<Health>(&response.body)
            .map(|health| health.capabilities)
            .map_err(|_| ApiError::Transient("SkillHub Server 状态格式无效".into()))
    }

    async fn list(&self) -> Result<Vec<RemoteEntry>, ApiError> {
        #[derive(Deserialize)]
        struct List {
            entries: Vec<RawEntry>,
        }
        let list: List = self.json(Method::GET, "api/library", None).await?;
        Ok(list.entries.into_iter().map(RemoteEntry::from).collect())
    }

    async fn upload_card(&self, package: &[u8]) -> Result<RemoteCard, ApiError> {
        let body = serde_json::json!({
            "packageBase64": BASE64.encode(package),
            "packageSha256": format!("{:x}", Sha256::digest(package)),
        });
        let response = self
            .send(Method::POST, "api/cards", Some(&body), MAX_JSON_BYTES)
            .await?;
        if !response.status.is_success() {
            return Err(Self::error_for(&response));
        }
        serde_json::from_slice(&response.body)
            .map_err(|_| ApiError::Transient("SkillHub Server 响应格式无效".into()))
    }

    async fn download_card(&self, sha256: &str) -> Result<Vec<u8>, ApiError> {
        self.download_card_progress(sha256, &|_, _| {}).await
    }

    async fn download_card_progress(
        &self,
        sha256: &str,
        progress: &dyn Fn(u64, Option<u64>),
    ) -> Result<Vec<u8>, ApiError> {
        let response = self
            .send_progress(
                Method::GET,
                &card_path(sha256)?,
                None,
                MAX_CARD_BYTES,
                Some(progress),
            )
            .await?;
        if !response.status.is_success() {
            return Err(Self::error_for(&response));
        }
        let header = response
            .headers
            .get("x-checksum-sha256")
            .and_then(|value| value.to_str().ok());
        let actual = format!("{:x}", Sha256::digest(&response.body));
        if header != Some(sha256) || actual != sha256 {
            return Err(ApiError::Transient(
                "下载的 Skill 内容校验失败，稍后重试".into(),
            ));
        }
        Ok(response.body)
    }

    async fn card_meta(&self, sha256: &str) -> Result<Option<RemoteCard>, ApiError> {
        match self
            .json(Method::GET, &format!("{}/meta", card_path(sha256)?), None)
            .await
        {
            Ok(card) => Ok(Some(card)),
            Err(ApiError::Rejected { status: 404, .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn create_entry(&self, request: &CreateEntry) -> Result<RemoteEntry, ApiError> {
        let body = wire_body(request, request.source_url_synced, false)?;
        self.entry(Method::POST, "api/library", Some(&body)).await
    }

    async fn update_entry(&self, id: &str, request: &UpdateEntry) -> Result<RemoteEntry, ApiError> {
        let body = wire_body(request, request.source_url_synced, request.clear_source_url)?;
        self.entry(Method::PUT, &entry_path(id)?, Some(&body)).await
    }

    async fn delete_entry(
        &self,
        id: &str,
        base_revision: u64,
        device: &str,
    ) -> Result<RemoteEntry, ApiError> {
        // The query is built from digits and ASCII letters only.
        let device = device
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>();
        if let Some(session) = &self.session {
            crate::spaces::verify_remote_identity(session)
                .await
                .map_err(ApiError::Transient)?;
        }
        let mut url = self.url(&entry_path(id)?);
        url.set_query(Some(&format!(
            "baseRevision={base_revision}&device={device}"
        )));
        let response = self
            .client
            .request(Method::DELETE, url.clone())
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|error| ApiError::Transient(format!("无法连接 SkillHub Server: {error}")))?;
        let status = response.status();
        let headers = response.headers().clone();
        let body = response
            .bytes()
            .await
            .map_err(|error| ApiError::Transient(error.to_string()))?
            .to_vec();
        let response = Response {
            status,
            headers,
            body,
        };
        if !response.status.is_success() {
            return Err(Self::error_for(&response));
        }
        serde_json::from_slice::<RawEntry>(&response.body)
            .map(RemoteEntry::from)
            .map_err(|_| ApiError::Transient("SkillHub Server 响应格式无效".into()))
    }

    async fn restore_entry(
        &self,
        id: &str,
        base_revision: u64,
        device: &str,
    ) -> Result<RemoteEntry, ApiError> {
        let body = serde_json::json!({ "baseRevision": base_revision, "device": device });
        self.entry(
            Method::POST,
            &format!("{}/restore", entry_path(id)?),
            Some(&body),
        )
        .await
    }

    async fn author_asset(&self, id: &str) -> Result<AuthorAsset, ApiError> {
        #[derive(Deserialize)]
        struct Raw {
            skill: AuthorAssetSkill,
            entry: RawEntry,
        }
        let body = serde_json::json!({ "device": device_label() });
        let raw: Raw = self
            .json(
                Method::POST,
                &format!("{}/author-asset", entry_path(id)?),
                Some(&body),
            )
            .await?;
        Ok(AuthorAsset {
            skill: raw.skill,
            entry: raw.entry.into(),
        })
    }

    async fn own_skills(&self) -> Result<Vec<OwnSkill>, ApiError> {
        self.json(Method::GET, "api/skills", None).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_url_is_explicit_only_for_a_deliberate_clear_on_a_supporting_server() {
        let request = UpdateEntry {
            version_intent: None,
            base_revision: 3,
            profile: Some(SyncProfile {
                display_name: "Demo".into(),
                ..SyncProfile::default()
            }),
            source: None,
            device: "macOS".into(),
            source_url_synced: true,
            clear_source_url: true,
        };
        let has_source = |body: &Value| {
            body["profile"]
                .as_object()
                .unwrap()
                .contains_key("sourceUrl")
        };
        // Update that clears: explicit null (omission would keep it).
        let body = wire_body(&request, true, true).unwrap();
        assert!(has_source(&body));
        assert_eq!(body["profile"]["sourceUrl"], Value::Null);
        // Update without a clear: omitted, the server keeps its value.
        assert!(!has_source(&wire_body(&request, true, false).unwrap()));
        // Create: omitted, the server inherits the source version's value.
        let create = CreateEntry {
            version_intent: None,
            id: "e".into(),
            name: "demo".into(),
            profile: request.profile.clone().unwrap(),
            source: EntrySource::Authored {
                skill_id: "s".into(),
            },
            migration_key: None,
            device: "macOS".into(),
            source_url_synced: true,
        };
        assert!(!has_source(&wire_body(&create, true, false).unwrap()));
        // A set value is sent; an old strict server never receives the field.
        let mut with_source = request.clone();
        with_source.profile.as_mut().unwrap().source_url = Some("https://x.com/acme".into());
        assert_eq!(
            wire_body(&with_source, true, false).unwrap()["profile"]["sourceUrl"],
            "https://x.com/acme"
        );
        assert!(!has_source(&wire_body(&with_source, false, true).unwrap()));
        // A request without a profile is unchanged.
        let mut no_profile = request;
        no_profile.profile = None;
        assert!(wire_body(&no_profile, true, true)
            .unwrap()
            .get("profile")
            .is_none());
    }

    #[test]
    fn formal_history_allows_unavailable_packages_without_losing_valid_version_ids() {
        let versions: Vec<FormalVersion> = serde_json::from_value(serde_json::json!([
            {"id":"old", "version":"0.0.1", "packageSha256":null},
            {"id":"usable", "version":"0.1.0", "packageSha256":"a".repeat(64)}
        ]))
        .unwrap();
        assert!(versions[0].package_sha256.is_none());
        assert_eq!(versions[1].id, "usable");
        assert_eq!(
            versions[1].package_sha256.as_deref(),
            Some("a".repeat(64).as_str())
        );
    }

    #[test]
    fn author_share_preview_reads_owned_current_version_and_content_identity() {
        use std::io::{Read, Write};
        let skill_id = "00000000-0000-4000-8000-000000000001";
        let sha = "f".repeat(64);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let responses = [
                (
                    format!("/api/skills/{skill_id}"),
                    serde_json::json!({ "authorId": "owner", "currentVersion": "0.1.1", "versions": [{ "version": "0.1.1" }] }),
                ),
                (
                    format!("/api/skills/{skill_id}/versions"),
                    serde_json::json!([{ "version": "0.1.1", "packageSha256": sha }]),
                ),
                (
                    format!("/api/cards/{sha}/meta"),
                    serde_json::json!({ "sha256": sha, "size": 42, "contentHash": "content", "executablePaths": ["scripts/run.sh"] }),
                ),
                (
                    format!("/api/skills/{skill_id}"),
                    serde_json::json!({ "authorId": "foreign", "currentVersion": "0.1.1", "versions": [] }),
                ),
            ];
            for (path, response) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                let count = stream.read(&mut request).unwrap();
                let request = std::str::from_utf8(&request[..count]).unwrap();
                assert!(request.starts_with(&format!("GET {path} HTTP/1.1")));
                let body = response.to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let api = HttpLibraryApi {
            session: None,
            client: crate::net::client_builder(&Url::parse(&format!("http://{address}")).unwrap())
                .unwrap()
                .build()
                .unwrap(),
            origin: Url::parse(&format!("http://{address}")).unwrap(),
            token: "test-only".into(),
        };
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let (current, versions) = api.author_share_state(skill_id, "owner").await.unwrap();
                assert_eq!(versions, vec![current.clone()]);
                let identity = api
                    .author_version_identity(skill_id, &current)
                    .await
                    .unwrap();
                assert_eq!(identity.content_hash, "content");
                assert_eq!(identity.executable_paths, vec!["scripts/run.sh"]);
                assert!(matches!(
                    api.author_share_state(skill_id, "owner").await,
                    Err(ApiError::Rejected { status: 403, .. })
                ));
            });
        server.join().unwrap();
    }

    #[test]
    fn reports_real_partial_http_bytes_before_verified_download_returns() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let sha = format!("{:x}", Sha256::digest(b"abcdef"));
        let header_sha = sha.clone();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 2048];
            assert!(socket.read(&mut request).unwrap() > 0);
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nX-Checksum-Sha256: {header_sha}\r\nConnection: close\r\n\r\nabc").unwrap();
            socket.flush().unwrap();
            std::thread::sleep(Duration::from_millis(80));
            socket.write_all(b"def").unwrap();
        });
        let api = HttpLibraryApi {
            session: None,
            client: crate::net::client_builder(&Url::parse(&format!("http://{address}")).unwrap())
                .unwrap()
                .build()
                .unwrap(),
            origin: Url::parse(&format!("http://{address}")).unwrap(),
            token: "test-only".into(),
        };
        let observed = std::cell::RefCell::new(Vec::new());
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(api.download_card_progress(&sha, &|bytes, total| {
                observed.borrow_mut().push((bytes, total))
            }))
            .unwrap();
        server.join().unwrap();
        assert_eq!(result, b"abcdef");
        let observed = observed.borrow();
        assert!(observed
            .iter()
            .any(|(bytes, total)| *bytes > 0 && *bytes < 6 && *total == Some(6)));
        assert_eq!(observed.last(), Some(&(6, Some(6))));
    }

    #[test]
    fn serializes_sources_like_the_server_schema() {
        let source = EntrySource::Card {
            card_sha256: "a".repeat(64),
            provenance: Some(Provenance {
                source_kind: "team".into(),
                source_skill_id: Some("s1".into()),
            }),
        };
        assert_eq!(
            serde_json::to_value(&source).unwrap(),
            serde_json::json!({
                "kind": "card",
                "cardSha256": "a".repeat(64),
                "provenance": { "sourceKind": "team", "sourceSkillId": "s1" }
            })
        );
        let team = EntrySource::Team {
            skill_id: "s".into(),
            team_id: "t".into(),
        };
        assert_eq!(
            serde_json::to_value(&team).unwrap(),
            serde_json::json!({ "kind": "team", "skillId": "s", "teamId": "t" })
        );
    }

    #[test]
    fn parses_active_and_deleted_entries() {
        let active: RawEntry = serde_json::from_value(serde_json::json!({
            "id": "e1", "name": "demo", "revision": 3, "deletedAt": null,
            "profile": { "displayName": " Demo ", "labels": [] },
            "sourceKind": "marketplace", "sourceSkillId": "s1",
            "card": { "sha256": "b".repeat(64), "size": 10, "contentHash": "c", "executablePaths": ["z", "a"] }
        }))
        .unwrap();
        let active = RemoteEntry::from(active);
        assert!(!active.deleted);
        assert_eq!(active.profile.display_name, "Demo");
        assert_eq!(
            active.card.unwrap().identity().executable_paths,
            vec!["a", "z"]
        );
        let deleted: RawEntry = serde_json::from_value(serde_json::json!({
            "id": "e2", "name": "gone", "displayName": "Gone", "revision": 4,
            "deletedAt": "2026-10-04T00:00:00.000Z"
        }))
        .unwrap();
        let deleted = RemoteEntry::from(deleted);
        assert!(deleted.deleted);
        assert_eq!(deleted.profile.display_name, "Gone");
        assert!(deleted.card.is_none());
    }
}
