//! Deployment identity, private storage and the APP/CLI switch transaction.
#[cfg(windows)]
use crate::platform_fs::MetadataExt;
use crate::runtime_env::{self, RuntimeSession, SessionLease};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub(crate) const BUSY: &str = "请在 APP 设置页切换";
pub(crate) const STALE: &str = "SkillHub 空间或账号已切换，本次请求结果已丢弃";

pub(crate) fn require_handle(
    session: &RuntimeSession,
    handle: &crate::server_request::SpaceHandle,
) -> Result<(), String> {
    if !session.is_sync_pending()
        && crate::server_request::SpaceRegistry::handle(Some(session)) == *handle
    {
        Ok(())
    } else {
        Err(STALE.into())
    }
}

pub(crate) fn require_current_handle(
    handle: &crate::server_request::SpaceHandle,
) -> Result<(), String> {
    require_handle(&runtime_env::runtime_session_snapshot()?, handle)
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstanceIdentity {
    pub id: String,
    pub public_key: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(
    tag = "profile",
    rename_all = "lowercase",
    try_from = "DeploymentInput"
)]
pub(crate) enum Deployment {
    #[default]
    Official,
    Local,
    Selfhost {
        origin: String,
        #[serde(rename = "initialOrigin")]
        initial_origin: String,
        instance: InstanceIdentity,
    },
}

#[derive(Deserialize)]
struct DeploymentInput {
    profile: String,
    #[serde(flatten)]
    fields: std::collections::BTreeMap<String, serde_json::Value>,
}

impl TryFrom<DeploymentInput> for Deployment {
    type Error = &'static str;
    fn try_from(value: DeploymentInput) -> Result<Self, Self::Error> {
        match value.profile.as_str() {
            "official" if value.fields.is_empty() => Ok(Self::Official),
            "local" if value.fields.is_empty() => Ok(Self::Local),
            "selfhost" if value.fields.len() == 2 || value.fields.len() == 3 => {
                if value
                    .fields
                    .keys()
                    .any(|key| !matches!(key.as_str(), "origin" | "initialOrigin" | "instance"))
                {
                    return Err("空间档案字段无效");
                }
                let origin = value
                    .fields
                    .get("origin")
                    .and_then(serde_json::Value::as_str)
                    .ok_or("空间档案地址无效")?
                    .to_owned();
                let instance = serde_json::from_value(
                    value.fields.get("instance").ok_or("缺少实例身份")?.clone(),
                )
                .map_err(|_| "实例身份无效")?;
                let initial_origin = match value.fields.get("initialOrigin") {
                    Some(value) => value.as_str().ok_or("首次地址无效")?.to_owned(),
                    None => origin.clone(),
                };
                Ok(Self::Selfhost {
                    origin,
                    initial_origin,
                    instance,
                })
            }
            _ => Err("空间档案字段无效"),
        }
    }
}

pub(crate) fn official_id() -> String {
    "official".into()
}

impl Deployment {
    pub(crate) fn profile(&self) -> &'static str {
        match self {
            Self::Official => "official",
            Self::Local => "local",
            Self::Selfhost { .. } => "selfhost",
        }
    }

    pub(crate) fn base(&self) -> Result<Option<Url>, String> {
        match self {
            Self::Official => {
                normalize_base(&crate::official_channel::COMPILED.server_origin).map(Some)
            }
            Self::Local => Ok(None),
            Self::Selfhost { origin, .. } => normalize_base(origin).map(Some),
        }
    }

    pub(crate) fn space_id(&self) -> String {
        match self {
            Self::Official => official_id(),
            Self::Local => "local".into(),
            Self::Selfhost { initial_origin, .. } => {
                let key = serde_json::to_vec(&["space-v1", "selfhost", initial_origin])
                    .expect("string array");
                format!("selfhost-{:x}", Sha256::digest(key))
            }
        }
    }

    pub(crate) fn root(&self, home: &Path) -> PathBuf {
        if matches!(self, Self::Official) {
            home.to_path_buf()
        } else {
            home.join("spaces").join(self.space_id())
        }
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if let Self::Selfhost {
            origin,
            initial_origin,
            instance,
        } = self
        {
            if canonical_base(&normalize_base(origin)?) != *origin
                || canonical_base(&normalize_base(initial_origin)?) != *initial_origin
                || !uuid::Uuid::parse_str(&instance.id)
                    .is_ok_and(|id| id.to_string() == instance.id)
                || !URL_SAFE_NO_PAD
                    .decode(&instance.public_key)
                    .is_ok_and(|key| key.len() == 32)
            {
                return Err("SkillHub 部署档案无效".into());
            }
        }
        self.base().map(|_| ())
    }

    pub(crate) fn verify_pin(&self, home: &Path, create: bool) -> Result<(), String> {
        let Self::Selfhost { instance, .. } = self else {
            return Ok(());
        };
        let path = self.root(home).join("instance.json");
        match std::fs::symlink_metadata(&path) {
            Ok(_) => {
                let pinned: InstancePin = runtime_env::read_private_json(&path)?;
                if pinned.identity() != *instance {
                    return Err("实例身份已改变，不能复用原空间；请使用新的服务器地址".into());
                }
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if create {
                    runtime_env::write_private_json(&path, &InstancePin::new(self)?)
                } else {
                    Ok(())
                }
            }
            Err(error) => Err(error.to_string()),
        }
    }
}

pub(crate) fn channel_root(home: &Path, channel: &str) -> PathBuf {
    home.join(if channel == "dev" {
        ".skillhub-dev"
    } else {
        ".skillhub"
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingRebind {
    origin: String,
    expected_generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstancePin {
    id: String,
    public_key: String,
    #[serde(default)]
    initial_origin: Option<String>,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    previous_origins: Vec<String>,
    #[serde(default)]
    committed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_rebind: Option<PendingRebind>,
}

impl InstancePin {
    fn identity(&self) -> InstanceIdentity {
        InstanceIdentity {
            id: self.id.clone(),
            public_key: self.public_key.clone(),
        }
    }
    fn new(deployment: &Deployment) -> Result<Self, String> {
        let Deployment::Selfhost {
            origin,
            initial_origin,
            instance,
        } = deployment
        else {
            return Err("不是自部署空间".into());
        };
        Ok(Self {
            id: instance.id.clone(),
            public_key: instance.public_key.clone(),
            origin: Some(origin.clone()),
            initial_origin: Some(initial_origin.clone()),
            previous_origins: Vec::new(),
            committed: false,
            pending_rebind: None,
        })
    }
    fn deployment(&self) -> Result<Deployment, String> {
        let deployment = Deployment::Selfhost {
            origin: self.origin.clone().ok_or("缺少历史地址")?,
            initial_origin: self.initial_origin.clone().ok_or("缺少首次地址")?,
            instance: self.identity(),
        };
        deployment.validate()?;
        if self.previous_origins.len() > 128
            || self.previous_origins.iter().any(|origin| {
                normalize_base(origin).map_or(true, |base| canonical_base(&base) != *origin)
            })
        {
            return Err("历史地址无效".into());
        }
        if let Some(pending) = &self.pending_rebind {
            if canonical_base(&normalize_base(&pending.origin)?) != pending.origin {
                return Err("恢复地址无效".into());
            }
        }
        Ok(deployment)
    }
}

fn pin_path(home: &Path, deployment: &Deployment) -> PathBuf {
    deployment.root(home).join("instance.json")
}

// Only completed connections may become trust sources. A prepared pin alone is not evidence.
fn finish_pin(home: &Path, session: &RuntimeSession) -> Result<(), String> {
    let deployment = session.deployment();
    if !matches!(deployment, Deployment::Selfhost { .. }) {
        return Ok(());
    }
    deployment.verify_pin(home, true)?;
    let path = pin_path(home, deployment);
    let mut pin: InstancePin = runtime_env::read_private_json(&path)?;
    let current = canonical_base(&deployment.base()?.ok_or("缺少地址")?);
    if pin.initial_origin.is_none() && pin.origin.is_none() {
        pin = InstancePin::new(deployment)?;
    }
    if pin.deployment()?.space_id() != session.space_id() {
        return Err("空间 pin 不匹配".into());
    }
    if let Some(pending) = pin.pending_rebind.take() {
        if current == pending.origin && session.generation() == pending.expected_generation {
            let old = pin.origin.replace(current.clone()).ok_or("缺少历史地址")?;
            if old != current && !pin.previous_origins.contains(&old) {
                pin.previous_origins.push(old);
            }
        } else if pin.origin.as_ref() != Some(&current) {
            return Err("空间改绑恢复记录不匹配".into());
        }
    }
    if pin.origin.as_ref() != Some(&current) {
        return Err("空间地址与 pin 不匹配".into());
    }
    pin.committed = true;
    match runtime_env::write_private_json_outcome(&path, &pin) {
        Ok(()) => Ok(()),
        Err(runtime_env::PrivateWriteError::AfterReplace(_))
            if runtime_env::read_private_json::<InstancePin>(&path).as_ref() == Ok(&pin) =>
        {
            // Session is durable; either the pending or final pin is recoverable after power loss.
            eprintln!("空间地址已提交，pin 持久化收尾未完成，下次启动将重试");
            Ok(())
        }
        Err(error) => Err(error.message()),
    }
}

fn pins(home: &Path) -> Result<Vec<(Deployment, InstancePin)>, String> {
    let root = home.join("spaces");
    if !root.exists() {
        return Ok(Vec::new());
    }
    if !std::fs::symlink_metadata(&root)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("空间根目录无效".into());
    }
    let mut result = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if metadata.mode() & 0o077 != 0 || metadata.uid() != crate::platform_fs::current_uid() {
            continue;
        }
        let Ok(pin) =
            runtime_env::read_private_json::<InstancePin>(&entry.path().join("instance.json"))
        else {
            continue;
        };
        let Ok(deployment) = pin.deployment() else {
            continue;
        };
        if entry.file_name().to_str() == Some(deployment.space_id().as_str()) {
            result.push((deployment, pin));
        }
    }
    Ok(result)
}

fn recover_rebinds(home: &Path, session: &RuntimeSession) -> Result<(), String> {
    for (deployment, mut pin) in pins(home)? {
        if pin.pending_rebind.is_none() {
            continue;
        }
        if deployment.space_id() == session.space_id() {
            finish_pin(home, session)?;
        } else {
            pin.pending_rebind = None;
            runtime_env::write_private_json(&pin_path(home, &deployment), &pin)?;
        }
    }
    finish_pin(home, session)
}

pub(crate) fn previous_origins(
    home: &Path,
    session: &RuntimeSession,
) -> Result<Vec<String>, String> {
    if !matches!(session.deployment(), Deployment::Selfhost { .. }) {
        return Ok(Vec::new());
    }
    let pin: InstancePin = runtime_env::read_private_json(&pin_path(home, session.deployment()))?;
    if pin.identity()
        != match session.deployment() {
            Deployment::Selfhost { instance, .. } => instance.clone(),
            _ => unreachable!(),
        }
        || pin.deployment()?.space_id() != session.space_id()
    {
        return Err("空间 pin 不匹配".into());
    }
    Ok(pin.previous_origins)
}

pub(crate) fn require_rebind_finished(home: &Path, session: &RuntimeSession) -> Result<(), String> {
    if session.is_sync_pending() || !matches!(session.deployment(), Deployment::Selfhost { .. }) {
        return Ok(());
    }
    let path = pin_path(home, session.deployment());
    if !path.exists() {
        return Ok(());
    }
    let pin: InstancePin = runtime_env::read_private_json(&path)?;
    if pin.pending_rebind.is_some() {
        return Err("空间改绑尚未恢复，请打开 APP 完成恢复后重试".into());
    }
    // Keep background/CLI readers paused until the committing command has checked auth.me.
    if !pin.previous_origins.is_empty() && runtime_env::try_shared_switch_lock_at(home)?.is_none() {
        return Err("空间改绑正在核验登录，请稍后重试".into());
    }
    Ok(())
}

pub(crate) fn validate_session_pin(home: &Path, session: &RuntimeSession) -> Result<(), String> {
    let Deployment::Selfhost {
        origin,
        initial_origin,
        instance,
    } = session.deployment()
    else {
        return Ok(());
    };
    let path = pin_path(home, session.deployment());
    let pin: InstancePin = match std::fs::symlink_metadata(&path) {
        Ok(_) => runtime_env::read_private_json(&path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && origin == initial_origin => {
            return Ok(())
        }
        Err(_) => return Err("改绑空间缺少可信 pin".into()),
    };
    if pin.identity() != *instance {
        return Err("空间实例身份与 pin 不匹配".into());
    }
    if pin.initial_origin.is_none() && pin.origin.is_none() && origin == initial_origin {
        return Ok(());
    }
    if pin.initial_origin.as_ref() != Some(initial_origin)
        || pin.deployment()?.space_id() != session.space_id()
    {
        return Err("空间首次地址与 pin 不匹配".into());
    }
    if pin.origin.as_ref() == Some(origin)
        || pin.pending_rebind.as_ref().is_some_and(|pending| {
            pending.origin == *origin && pending.expected_generation == session.generation()
        })
    {
        return Ok(());
    }
    Err("空间地址未经改绑确认".into())
}

pub(crate) fn known_instance(home: &Path, candidate: &Deployment) -> Option<Deployment> {
    let Deployment::Selfhost {
        origin, instance, ..
    } = candidate
    else {
        return None;
    };
    let entries = pins(home).ok()?;
    if entries.iter().any(|(d, p)| {
        p.committed
            && d.base()
                .ok()
                .flatten()
                .is_some_and(|b| canonical_base(&b) == *origin)
    }) {
        return None;
    }
    let matches: Vec<_> = entries
        .into_iter()
        .filter(|(_, pin)| pin.committed && pin.id == instance.id)
        .collect();
    if matches.len() != 1 {
        return None;
    }
    let (deployment, pin) = matches.into_iter().next()?;
    (pin.public_key == instance.public_key && pin.pending_rebind.is_none()).then_some(deployment)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RebindCandidate {
    pub previous_origin: String,
    pub active: bool,
    #[serde(skip)]
    pub deployment: Option<Deployment>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddressProof {
    payload: String,
    signature: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProofPayload {
    purpose: String,
    instance_id: String,
    origin: String,
    nonce: String,
}

struct AddressChallenge {
    nonce: Option<String>,
    origin: String,
    deployment: Deployment,
    generation: u64,
    created: std::time::Instant,
}
impl AddressChallenge {
    fn new(deployment: Deployment, origin: String, generation: u64) -> Result<Self, String> {
        use ring::rand::SecureRandom;
        let mut nonce = [0; 32];
        ring::rand::SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "无法生成地址挑战")?;
        Ok(Self {
            nonce: Some(URL_SAFE_NO_PAD.encode(nonce)),
            origin,
            deployment,
            generation,
            created: std::time::Instant::now(),
        })
    }
    fn verify(&mut self, bytes: &[u8], generation: u64) -> Result<(), String> {
        let nonce = self.nonce.take().ok_or("地址挑战已使用")?;
        if bytes.len() > 8192
            || generation != self.generation
            || self.created.elapsed().as_secs() >= 60
        {
            return Err("地址挑战已失效".into());
        }
        let proof: AddressProof = serde_json::from_slice(bytes).map_err(|_| "地址证明无效")?;
        let decode = |value: &str| {
            URL_SAFE_NO_PAD
                .decode(value)
                .map_err(|_| "地址证明编码无效")
        };
        let payload = decode(&proof.payload)?;
        let signature = decode(&proof.signature)?;
        let Deployment::Selfhost { instance, .. } = &self.deployment else {
            return Err("不是自部署空间".into());
        };
        let key = decode(&instance.public_key)?;
        ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
            .verify(&payload, &signature)
            .map_err(|_| "地址证明签名无效")?;
        let payload: ProofPayload =
            serde_json::from_slice(&payload).map_err(|_| "地址证明字段无效")?;
        if payload.purpose != "skillhub-instance-address-proof-v1"
            || payload.instance_id != instance.id
            || payload.origin != self.origin
            || payload.nonce != nonce
        {
            return Err("地址证明不匹配".into());
        }
        Ok(())
    }
}

async fn prove_address(home: &Path, candidate: &Deployment) -> Result<RebindCandidate, String> {
    let deployment = known_instance(home, candidate).ok_or("无唯一已知实例")?;
    let source = runtime_env::runtime_session_snapshot_at(home)?;
    let origin = canonical_base(&candidate.base()?.ok_or("缺少地址")?);
    let mut challenge =
        AddressChallenge::new(deployment.clone(), origin.clone(), source.generation())?;
    let base = normalize_base(&origin)?;
    let client = crate::net::client_builder(&base)?
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .post(format!("{origin}/api/instance/address-proof"))
        .json(&serde_json::json!({ "nonce": challenge.nonce, "expectedBaseUrl": origin }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "地址证明连接失败")?;
    if response.status() != reqwest::StatusCode::OK
        || response.content_length().is_some_and(|size| size > 8192)
    {
        return Err("地址证明响应无效".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "地址证明读取失败")? {
        if bytes.len() + chunk.len() > 8192 {
            return Err("地址证明过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let current = runtime_env::runtime_session_snapshot_at(home)?;
    if current != source {
        return Err(STALE.into());
    }
    challenge.verify(&bytes, current.generation())?;
    Ok(RebindCandidate {
        previous_origin: canonical_base(&deployment.base()?.ok_or("缺少历史地址")?),
        active: source.space_id() == deployment.space_id(),
        deployment: Some(deployment),
    })
}

pub(crate) fn canonical_base(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_string()
}

pub(crate) fn normalize_base(value: &str) -> Result<Url, String> {
    // Check before URL parsing, which would silently remove dot segments.
    if value.trim() != value || value.contains(['\\', '%']) || value.chars().any(char::is_control) {
        return Err("SkillHub 服务地址包含歧义编码或路径".into());
    }
    let tail = value.split_once("://").ok_or("SkillHub 服务地址无效")?.1;
    if tail
        .split('/')
        .skip(1)
        .any(|part| part == "." || part == "..")
    {
        return Err("SkillHub 服务地址包含无效路径".into());
    }
    let mut url = Url::parse(value).map_err(|_| "SkillHub 服务地址无效")?;
    crate::net::validate_base_url(&url)?;
    if url.path().contains('%') {
        return Err("SkillHub 服务地址路径必须使用无转义 ASCII 字符".into());
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&path);
    Ok(url)
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidecarScope {
    pub space_id: String,
    pub runtime_user_id: String,
}

impl SidecarScope {
    pub(crate) fn for_session(session: &RuntimeSession) -> Self {
        Self {
            space_id: session.space_id().into(),
            runtime_user_id: session.user_id().into(),
        }
    }
}

pub(crate) fn profile_matches(profile: &crate::SkillHubProfile, session: &RuntimeSession) -> bool {
    profile_matches_identity(profile, session.space_id(), session.user_id())
}

pub(crate) fn profile_matches_identity(
    profile: &crate::SkillHubProfile,
    space_id: &str,
    user_id: &str,
) -> bool {
    match &profile.scope {
        Some(scope) => scope.space_id == space_id && scope.runtime_user_id == user_id,
        None => space_id == "official",
    }
}

pub(crate) fn require_profile(
    profile: &crate::SkillHubProfile,
    session: &RuntimeSession,
) -> Result<(), String> {
    if profile.is_system || profile_matches(profile, session) {
        Ok(())
    } else {
        Err("此 Skill 属于其他空间或账号，请创建本机副本后再操作".into())
    }
}

pub(crate) fn require_profile_at(
    home: &Path,
    profile: &crate::SkillHubProfile,
) -> Result<(), String> {
    if std::fs::symlink_metadata(home.join("runtime/session.json"))
        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        return if profile.scope.is_none() {
            Ok(())
        } else {
            Err(STALE.into())
        };
    }
    match runtime_env::runtime_session_snapshot_at(home) {
        Ok(session) if !session.is_sync_pending() => require_profile(profile, &session),
        Ok(_) => Err(STALE.into()),
        Err(error) => Err(error),
    }
}

pub(crate) fn current_profile_matches(profile: &crate::SkillHubProfile) -> Result<bool, String> {
    match runtime_env::runtime_session_snapshot() {
        Ok(session) if !session.is_sync_pending() => {
            Ok(profile.is_system || profile_matches(profile, &session))
        }
        Ok(_) => Err(STALE.into()),
        Err(_)
            if std::fs::symlink_metadata(crate::skillhub_dir().join("runtime/session.json"))
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(profile.scope.is_none())
        }
        Err(error) => Err(error),
    }
}

pub(crate) fn local_view(mut profile: crate::SkillHubProfile) -> crate::SkillHubProfile {
    profile.catalog_origin = None;
    profile.acquisition_version = None;
    profile.version_metadata = Default::default();
    profile.server_id = None;
    profile.server_owner_id = None;
    profile.library_account_id = None;
    profile.library_entry_id = None;
    profile.added_by_account_id = None;
    profile.acquired_by_user_id = None;
    profile.avatar_local_id = None;
    profile.upstream = None;
    profile.team_shared_from = None;
    profile.teams.clear();
    profile.team_ids.clear();
    profile.is_own = Some(false);
    profile.acquisition_source = Some(crate::AcquisitionSource::Local);
    profile.acquisition_package_sha256 = None;
    profile.source_url = None;
    profile.source_url_cleared = None;
    profile
}

pub(crate) fn try_lock(home: &Path, name: &str) -> Result<Option<SessionLease>, String> {
    runtime_env::try_named_lock_at(home, name)
}

pub(crate) struct AppLease {
    _app: SessionLease,
}

fn observed_session_change<T: PartialEq>(
    previous: &Option<T>,
    snapshot: Result<Option<T>, String>,
) -> Option<Option<T>> {
    // An error is unknown, not logout. Keep the last known identity until
    // a successful read proves a change (including a missing session file).
    snapshot.ok().filter(|current| current != previous)
}

pub(crate) fn observe_session(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    tauri::async_runtime::spawn(async move {
        let registry = app.state::<crate::server_request::SpaceRegistry>();
        let mut previous = registry.snapshot(true).await.ok().flatten();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let Some(current) = observed_session_change(&previous, registry.snapshot(true).await)
            else {
                continue;
            };
            let _ = registry.cancel_departed(&crate::server_request::SpaceRegistry::handle(
                previous.as_ref(),
            ));
            let _ = app.emit(
                "space-changed",
                serde_json::json!({
                    "space": crate::server_request::SpaceRegistry::handle(current.as_ref()),
                    "pending": current.as_ref().is_none_or(RuntimeSession::is_sync_pending)
                }),
            );
            previous = current;
        }
    });
}

pub(crate) fn start_app(home: &Path) -> Result<AppLease, String> {
    let _switch = try_lock(home, "switch.lock")?.ok_or("SkillHub 正在切换空间，请稍后打开 APP")?;
    let app = try_lock(home, "app.lock")?.ok_or("另一个 SkillHub APP 正在管理此空间")?;
    runtime_env::ensure_runtime_session_at(home)?;
    recover_pending(home)?;
    Ok(AppLease { _app: app })
}

pub(crate) fn recover_pending(home: &Path) -> Result<(), String> {
    let _lease = runtime_env::acquire_exclusive_session_lease_at(home)?;
    let mut current = runtime_env::read_session_for_recovery_at(home)?;
    #[cfg(unix)]
    std::fs::File::open(home.join("runtime"))
        .and_then(|directory| directory.sync_all())
        .map_err(|e| e.to_string())?;
    recover_rebinds(home, &current)?;
    recover_guest_claims(home, &home.join("skills"), &current)?;
    if current.is_sync_pending() {
        current.finish_switch()?;
        runtime_env::write_space_session_at(home, &current)?;
    }
    Ok(())
}

pub(crate) fn recover_cli_startup(home: &Path) -> Result<(), String> {
    if !home.join("runtime/session.json").exists() {
        return Ok(());
    }
    let session = runtime_env::read_session_for_recovery_at(home)?;
    if !session.is_sync_pending()
        && !pins(home)?
            .iter()
            .any(|(_, pin)| pin.pending_rebind.is_some())
    {
        return Ok(());
    }
    let _switch = try_lock(home, "switch.lock")?.ok_or(BUSY)?;
    let _app = try_lock(home, "app.lock")?.ok_or(BUSY)?;
    recover_pending(home)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GuestClaim {
    space_id: String,
    guest_id: String,
    user_id: String,
    backup_id: uuid::Uuid,
    original: serde_json::Value,
    assigned: serde_json::Value,
}

fn replace_claim_sidecar(
    path: &Path,
    expected: &serde_json::Value,
    replacement: &serde_json::Value,
    backup: &Path,
) -> Result<(), String> {
    let stage = backup.with_extension("next");
    runtime_env::write_private_json(&stage, replacement)?;
    let result = (|| {
        crate::commands::rename_noreplace(path, backup).map_err(|error| error.to_string())?;
        let current: serde_json::Value = runtime_env::read_private_json(backup)?;
        if current != *expected {
            return Err("游客 Skill 在登录期间已修改，请保留恢复记录并重新检查".into());
        }
        crate::commands::rename_noreplace(&stage, path).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        // Never replace a concurrently created path. Keep the exact moved inode,
        // including writes from an editor that already had it open.
        let _ = std::fs::hard_link(backup, path);
        let _ = std::fs::remove_file(stage);
    }
    result
}

// The caller holds the exclusive session lease. Each sidecar has its own bounded
// recovery record, so a crash cannot leave a partially adopted guest library.
pub(crate) fn claim_guest_skills(
    home: &Path,
    managed: &Path,
    source: &RuntimeSession,
    user_id: &str,
) -> Result<(), String> {
    recover_guest_claims(home, managed, source)?;
    let journal = source.storage_root(home).join("runtime/guest-claims");
    let entries = match std::fs::read_dir(managed) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let skill_id = entry.file_name().to_string_lossy().to_string();
        crate::commands::validate_skill_id_for_lock(&skill_id)?;
        let path = entry.path().join(".skillhub.json");
        if !path.exists() {
            continue;
        }
        let original: serde_json::Value = runtime_env::read_private_json(&path)?;
        let profile: crate::SkillHubProfile =
            match serde_json::from_value(original["skillhub"].clone()) {
                Ok(profile) => profile,
                Err(_) => continue,
            };
        if profile.is_system || profile.scope.as_ref() != Some(&SidecarScope::for_session(source)) {
            continue;
        }
        let mut assigned = original.clone();
        assigned["skillhub"]["scope"] = serde_json::to_value(SidecarScope {
            space_id: source.space_id().into(),
            runtime_user_id: user_id.into(),
        })
        .map_err(|error| error.to_string())?;
        let record = GuestClaim {
            space_id: source.space_id().into(),
            guest_id: source.user_id().into(),
            user_id: user_id.into(),
            backup_id: uuid::Uuid::new_v4(),
            original: original.clone(),
            assigned: assigned.clone(),
        };
        let backup = source
            .storage_root(home)
            .join("runtime/guest-claim-recovery")
            .join(&skill_id)
            .join(record.backup_id.to_string())
            .join("claim.json");
        runtime_env::write_private_json(&journal.join(format!("{skill_id}.json")), &record)?;
        replace_claim_sidecar(&path, &original, &assigned, &backup)?;
    }
    Ok(())
}

pub(crate) fn recover_guest_claims(
    home: &Path,
    managed: &Path,
    current: &RuntimeSession,
) -> Result<(), String> {
    let journal = current.storage_root(home).join("runtime/guest-claims");
    let entries = match std::fs::read_dir(&journal) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let skill_id = name.strip_suffix(".json").ok_or("游客归属恢复记录无效")?;
        crate::commands::validate_skill_id_for_lock(skill_id)?;
        let record: GuestClaim = runtime_env::read_private_json(&entry.path())?;
        if record.space_id != current.space_id()
            || (current.user_id() != record.guest_id && current.user_id() != record.user_id)
        {
            return Err("游客归属恢复身份不匹配".into());
        }
        let directory = managed.join(skill_id);
        let metadata = std::fs::symlink_metadata(&directory).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("游客 Skill 恢复目录不安全".into());
        }
        let path = directory.join(".skillhub.json");
        let backups = current
            .storage_root(home)
            .join("runtime/guest-claim-recovery")
            .join(skill_id)
            .join(record.backup_id.to_string());
        let saved_files = match std::fs::read_dir(&backups) {
            Ok(entries) => entries
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.to_string()),
        };
        let mut has_backup = false;
        for entry in saved_files {
            let backup = entry.path();
            if backup
                .extension()
                .is_none_or(|extension| extension != "json")
            {
                continue;
            }
            has_backup = true;
            let saved: serde_json::Value = runtime_env::read_private_json(&backup)?;
            if saved != record.original && saved != record.assigned {
                let _ = std::fs::hard_link(&backup, &path);
                return Err("游客 Skill 恢复副本已被外部修改，请保留并重新检查".into());
            }
        }
        let expected = if current.user_id() == record.user_id {
            &record.assigned
        } else {
            &record.original
        };
        if has_backup && !path.exists() {
            let stage = backups.join("recover.next");
            runtime_env::write_private_json(&stage, expected)?;
            crate::commands::rename_noreplace(&stage, &path).map_err(|error| error.to_string())?;
        }
        let observed: serde_json::Value = runtime_env::read_private_json(&path)?;
        if observed != record.original && observed != record.assigned {
            return Err("游客 Skill 在登录期间已修改，请保留恢复记录并重新检查".into());
        }
        if observed != *expected {
            replace_claim_sidecar(
                &path,
                &observed,
                expected,
                &backups.join(format!("{}.json", uuid::Uuid::new_v4())),
            )?;
        }
        std::fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) struct SwitchTransaction {
    home: PathBuf,
    pending: RuntimeSession,
    _switch: SessionLease,
    _app: Option<SessionLease>,
    finished: bool,
}

impl SwitchTransaction {
    pub(crate) fn begin(home: &Path, cli: bool) -> Result<Self, String> {
        Self::begin_expected(home, cli, None)
    }

    pub(crate) fn begin_expected(
        home: &Path,
        cli: bool,
        expected: Option<&RuntimeSession>,
    ) -> Result<Self, String> {
        let switch = try_lock(home, "switch.lock")?.ok_or("SkillHub 正在切换空间，请稍后重试")?;
        let app = if cli {
            Some(try_lock(home, "app.lock")?.ok_or(BUSY)?)
        } else {
            None
        };
        runtime_env::ensure_runtime_session_at(home)?;
        recover_pending(home)?;
        let _lease = runtime_env::acquire_exclusive_session_lease_at(home)?;
        let mut pending = runtime_env::read_session_for_recovery_at(home)?;
        if expected.is_some_and(|expected| *expected != pending) {
            return Err(STALE.into());
        }
        pending.begin_switch()?;
        runtime_env::write_space_session_at(home, &pending)?;
        Ok(Self {
            home: home.into(),
            pending,
            _switch: switch,
            _app: app,
            finished: false,
        })
    }

    pub(crate) fn pending(&self) -> &RuntimeSession {
        &self.pending
    }

    pub(crate) fn commit(
        &mut self,
        deployment: Deployment,
        identity: Option<(&str, &str)>,
    ) -> Result<RuntimeSession, String> {
        self.commit_using(
            deployment,
            identity,
            runtime_env::write_space_session_outcome_at,
        )
    }

    fn commit_using(
        &mut self,
        deployment: Deployment,
        identity: Option<(&str, &str)>,
        write: impl FnOnce(&Path, &RuntimeSession) -> Result<(), runtime_env::PrivateWriteError>,
    ) -> Result<RuntimeSession, String> {
        deployment.validate()?;
        deployment.verify_pin(&self.home, true)?;
        let _lease = runtime_env::acquire_exclusive_session_lease_at(&self.home)?;
        if runtime_env::read_session_at(&self.home)? != self.pending {
            return Err(STALE.into());
        }
        let session = runtime_env::new_space_session_at(
            &self.home,
            deployment,
            identity,
            self.pending.generation(),
        )?;
        if let Err(error) = write(&self.home, &session) {
            self.finished = matches!(error, runtime_env::PrivateWriteError::AfterReplace(_));
            return Err(error.message());
        }
        self.finished = true;
        finish_pin(&self.home, &session)?;
        Ok(session)
    }

    pub(crate) fn commit_rebind(
        &mut self,
        old: &Deployment,
        origin: &str,
    ) -> Result<RuntimeSession, String> {
        self.commit_rebind_using(old, origin, |_| Ok(()))
    }

    fn commit_rebind_using(
        &mut self,
        old: &Deployment,
        origin: &str,
        mut checkpoint: impl FnMut(&str) -> Result<(), String>,
    ) -> Result<RuntimeSession, String> {
        let mut deployment = old.clone();
        let Deployment::Selfhost {
            origin: current_origin,
            ..
        } = &mut deployment
        else {
            return Err("不是自部署空间".into());
        };
        *current_origin = origin.into();
        deployment.validate()?;
        let _lease = runtime_env::acquire_exclusive_session_lease_at(&self.home)?;
        if runtime_env::read_session_at(&self.home)? != self.pending {
            return Err(STALE.into());
        }
        if known_instance(&self.home, &deployment).as_ref() != Some(old) {
            return Err("改绑空间或地址已改变，请重新测试".into());
        }
        let path = pin_path(&self.home, old);
        let mut pin: InstancePin = runtime_env::read_private_json(&path)?;
        if pin.deployment()? != *old || pin.pending_rebind.is_some() {
            return Err(STALE.into());
        }
        if pin.previous_origins.len() >= 128 {
            return Err("历史地址数量已达上限".into());
        }
        let identity = if self.pending.space_id() == old.space_id() {
            self.pending
                .auth_token()
                .map(|token| (token, self.pending.user_id()))
        } else {
            None
        };
        let session = runtime_env::new_space_session_at(
            &self.home,
            deployment,
            identity,
            self.pending.generation(),
        )?;
        pin.pending_rebind = Some(PendingRebind {
            origin: origin.into(),
            expected_generation: session.generation(),
        });
        runtime_env::write_private_json(&path, &pin)?;
        checkpoint("pending_rebind")?;
        checkpoint("before_session")?;
        if let Err(error) = runtime_env::write_space_session_outcome_at(&self.home, &session) {
            self.finished = matches!(error, runtime_env::PrivateWriteError::AfterReplace(_));
            return Err(error.message());
        }
        self.finished = true;
        checkpoint("after_session")?;
        checkpoint("before_pin_finish")?;
        finish_pin(&self.home, &session)?;
        Ok(session)
    }

    pub(crate) fn cancel(&mut self) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }
        let _lease = runtime_env::acquire_exclusive_session_lease_at(&self.home)?;
        if runtime_env::read_session_at(&self.home)? != self.pending {
            return Err(STALE.into());
        }
        let mut restored = self.pending.clone();
        recover_rebinds(&self.home, &restored)?;
        restored.finish_switch()?;
        runtime_env::write_space_session_at(&self.home, &restored)?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for SwitchTransaction {
    fn drop(&mut self) {
        let _ = self.cancel();
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerInfo {
    pub profile: String,
    pub auth: AuthModes,
    pub features: Features,
    pub media: MediaInfo,
    pub min_client_version: Option<String>,
    pub instance: Option<InstanceIdentity>,
    pub status: String,
    pub version: String,
    pub capabilities: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthModes {
    pub password: bool,
    pub yitan_oidc: bool,
    pub registration: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Features {
    pub marketplace: bool,
    pub ai: bool,
    pub avatars: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaInfo {
    pub allowed_image_hosts: Vec<String>,
}

fn official_server_info(raw: &serde_json::Value) -> ServerInfo {
    let capabilities: Vec<String> =
        serde_json::from_value(raw["capabilities"].clone()).unwrap_or_default();
    let feature = |name: &str, fallback: bool| raw["features"][name].as_bool().unwrap_or(fallback);
    ServerInfo {
        profile: "official".into(),
        auth: AuthModes {
            password: false,
            yitan_oidc: true,
            registration: "closed".into(),
        },
        features: Features {
            marketplace: feature(
                "marketplace",
                capabilities.iter().any(|c| c == "marketplace.public.v1"),
            ),
            // Legacy official AI has no capability bit; keep the existing client behavior.
            ai: feature("ai", true),
            avatars: feature(
                "avatars",
                capabilities.iter().any(|c| c == "skills.avatars.v1"),
            ),
        },
        media: MediaInfo {
            allowed_image_hosts: serde_json::from_value(raw["media"]["allowedImageHosts"].clone())
                .unwrap_or_default(),
        },
        min_client_version: raw["minClientVersion"].as_str().map(str::to_owned),
        instance: None,
        status: raw["status"].as_str().unwrap_or("ok").into(),
        version: raw["version"].as_str().unwrap_or("unknown").into(),
        capabilities,
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionCheck {
    pub item: &'static str,
    pub state: &'static str,
    pub message: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionReport {
    pub origin: Option<String>,
    pub checks: Vec<ConnectionCheck>,
    pub info: Option<ServerInfo>,
    pub deployment: Option<Deployment>,
    pub error: Option<crate::net::ConnectionError>,
    pub rebind: Option<RebindCandidate>,
}

impl ConnectionReport {
    fn check(&mut self, check: ConnectionCheck) {
        if let Some(existing) = self
            .checks
            .iter_mut()
            .find(|entry| entry.item == check.item)
        {
            *existing = check;
        } else {
            self.checks.push(check);
        }
    }
}

fn release_version(value: &str) -> Option<([u64; 3], Option<&str>)> {
    let identifiers = |value: &str| {
        !value.is_empty()
            && value.split('.').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
    };
    let version = if let Some((version, build)) = value.split_once('+') {
        if !identifiers(build) {
            return None;
        }
        version
    } else {
        value
    };
    let (core, pre) = match version.split_once('-') {
        Some((core, pre))
            if identifiers(pre)
                && pre.split('.').all(|part| {
                    !(part.len() > 1
                        && part.starts_with('0')
                        && part.bytes().all(|byte| byte.is_ascii_digit()))
                }) =>
        {
            (core, Some(pre))
        }
        Some(_) => return None,
        None => (version, None),
    };
    let parts: Vec<_> = core.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut result = [0; 3];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        result[index] = part.parse().ok()?;
    }
    Some((result, pre))
}

fn version_compatible(app: &str, minimum: &str) -> bool {
    use std::cmp::Ordering;
    let Some((app, min)) = release_version(app).zip(release_version(minimum)) else {
        return false;
    };
    if app.0 != min.0 {
        return app.0 > min.0;
    }
    match (app.1, min.1) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(app), Some(min)) => {
            let mut left = app.split('.');
            let mut right = min.split('.');
            loop {
                let (a, b) = match (left.next(), right.next()) {
                    (_, None) => return true,
                    (None, Some(_)) => return false,
                    (Some(a), Some(b)) => (a, b),
                };
                let numeric = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
                let order = match (numeric(a), numeric(b)) {
                    (true, true) => a.len().cmp(&b.len()).then_with(|| a.cmp(b)),
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    _ => a.cmp(b),
                };
                if order != Ordering::Equal {
                    return order == Ordering::Greater;
                }
            }
        }
    }
}

async fn public_json(
    client: &reqwest::Client,
    base: &Url,
    path: &str,
) -> Result<serde_json::Value, crate::net::ConnectionError> {
    let invalid = || crate::net::ConnectionError {
        code: "invalid_server_info",
        message: "服务器返回无效或不兼容的连接信息",
    };
    let mut response = client
        .get(format!("{}{path}", canonical_base(base)))
        .send()
        .await
        .map_err(|error| crate::net::connection_error(&error))?;
    if !response.status().is_success() || response.content_length().is_some_and(|size| size > 65536)
    {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| crate::net::connection_error(&error))?
    {
        if bytes.len() + chunk.len() > 65536 {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}

pub(crate) async fn verify_remote_identity(session: &RuntimeSession) -> Result<(), String> {
    // Ordinary callers must still reject pending sessions.
    if matches!(session.deployment(), Deployment::Selfhost { .. }) {
        session.server_origin()?;
    }
    verify_deployment_identity(session.deployment()).await
}

pub(crate) async fn verify_deployment_identity(deployment: &Deployment) -> Result<(), String> {
    let Deployment::Selfhost { instance, .. } = deployment else {
        return Ok(());
    };
    let base = deployment.base()?.ok_or("本机空间没有服务器")?;
    let client = crate::net::client_builder(&base)?
        .build()
        .map_err(|_| "无法初始化连接")?;
    let info = public_json(&client, &base, "/health")
        .await
        .map_err(|error| error.message.to_string())?;
    let identity: InstanceIdentity =
        serde_json::from_value(info["instance"].clone()).map_err(|_| "实例身份无效")?;
    if info["profile"] != "selfhost" || identity != *instance {
        return Err("实例身份已改变，已阻止发送凭据；请使用新的服务器地址".into());
    }
    Ok(())
}

pub(crate) async fn verify_initialized(session: &RuntimeSession) -> Result<(), String> {
    if !matches!(session.deployment(), Deployment::Selfhost { .. }) {
        return Ok(());
    }
    let base = session.server_origin()?;
    let client = crate::net::client_builder(&base)?
        .build()
        .map_err(|_| "无法初始化连接")?;
    let status = public_json(&client, &base, "/api/setup/status")
        .await
        .map_err(|error| error.message.to_string())?;
    if status["initialized"] != true {
        return Err("实例尚未完成初始化".into());
    }
    Ok(())
}

pub(crate) async fn test_connection(home: &Path, target: &str) -> ConnectionReport {
    let mut report = inspect_connection(home, target).await;
    if let Some(deployment) = &report.deployment {
        report.rebind = prove_address(home, deployment).await.ok();
    }
    report
}

pub(crate) async fn inspect_connection(home: &Path, target: &str) -> ConnectionReport {
    let mut report = ConnectionReport {
        rebind: None,
        origin: None,
        checks: ["security", "version", "instance", "auth", "ai", "avatars"]
            .into_iter()
            .map(|item| ConnectionCheck {
                item,
                state: "unavailable",
                message: "尚未验证".into(),
            })
            .collect(),
        info: None,
        deployment: None,
        error: None,
    };
    if target == "local" {
        report.checks.clear();
        report.deployment = Some(Deployment::Local);
        return report;
    }
    let target = if target == "official" {
        crate::official_channel::COMPILED.server_origin.as_str()
    } else {
        target
    };
    let base = match normalize_base(target) {
        Ok(base) => base,
        Err(message) => {
            report.check(ConnectionCheck {
                item: "security",
                state: "blocked",
                message,
            });
            return report;
        }
    };
    report.origin = Some(canonical_base(&base));
    let client = match crate::net::client_builder(&base)
        .and_then(|builder| builder.build().map_err(|e| e.to_string()))
    {
        Ok(client) => client,
        Err(message) => {
            report.check(ConnectionCheck {
                item: "security",
                state: "blocked",
                message,
            });
            return report;
        }
    };
    let raw = match public_json(&client, &base, "/health").await {
        Ok(raw) => raw,
        Err(error) => {
            report.check(ConnectionCheck {
                item: "security",
                state: "blocked",
                message: error.message.into(),
            });
            report.error = Some(error);
            return report;
        }
    };
    report_from_health(home, &base, &client, raw, report).await
}

async fn report_from_health(
    home: &Path,
    base: &Url,
    client: &reqwest::Client,
    raw: serde_json::Value,
    mut report: ConnectionReport,
) -> ConnectionReport {
    let official = Deployment::Official
        .base()
        .ok()
        .flatten()
        .is_some_and(|compiled| canonical_base(&compiled) == canonical_base(base));
    let parsed = if official {
        Ok(official_server_info(&raw))
    } else {
        serde_json::from_value(raw)
    };
    let info: ServerInfo = match parsed {
        Ok(info) => info,
        Err(_) => {
            report.error = Some(crate::net::ConnectionError {
                code: "invalid_server_info",
                message: "服务器返回无效或不兼容的连接信息",
            });
            return report;
        }
    };
    report.check(ConnectionCheck {
        item: "security",
        state: "pass",
        message: if base.scheme() == "http" {
            "本机回环地址，允许 HTTP"
        } else {
            "HTTPS 系统证书验证通过"
        }
        .into(),
    });
    let compatible = match info.min_client_version.as_deref() {
        None => true,
        Some(min) if official && release_version(min).is_none() => true,
        Some(min) => version_compatible(env!("CARGO_PKG_VERSION"), min),
    };
    report.check(ConnectionCheck {
        item: "version",
        state: if compatible { "pass" } else { "blocked" },
        message: if compatible {
            format!("Server {}", info.version)
        } else {
            "请升级 APP；最低客户端版本不兼容".into()
        },
    });
    let mut initialized = true;
    let mut deployment = if official {
        Some(Deployment::Official)
    } else if info.profile == "selfhost" {
        match public_json(client, base, "/api/setup/status").await {
            Ok(value) => match value
                .get("initialized")
                .and_then(serde_json::Value::as_bool)
            {
                Some(value) => initialized = value,
                None => {
                    report.error = Some(crate::net::ConnectionError {
                        code: "invalid_setup_status",
                        message: "服务器初始化状态无效",
                    });
                }
            },
            Err(error) => report.error = Some(error),
        }
        info.instance.clone().map(|instance| Deployment::Selfhost {
            origin: canonical_base(base),
            initial_origin: canonical_base(base),
            instance,
        })
    } else {
        None
    };
    let valid = deployment
        .as_ref()
        .is_some_and(|d| d.validate().and_then(|_| d.verify_pin(home, false)).is_ok());
    if valid {
        if let Some(candidate) = &deployment {
            if let Ok(entries) = pins(home) {
                let same_address: Vec<_> = entries
                    .into_iter()
                    .filter(|(known, pin)| {
                        pin.committed && known.base().ok() == candidate.base().ok()
                    })
                    .collect();
                if same_address.len() == 1 {
                    let (known, pin) = &same_address[0];
                    if candidate.verify_pin(home, false).is_ok()
                        && matches!(candidate, Deployment::Selfhost { instance, .. } if *instance == pin.identity())
                    {
                        deployment = Some(known.clone());
                    } else {
                        report.error = Some(crate::net::ConnectionError {
                            code: "instance_changed",
                            message: "实例身份已改变",
                        });
                    }
                }
            }
        }
    }
    report.check(ConnectionCheck {
        item: "instance",
        state: if !valid || (!official && !matches!(info.status.as_str(), "ok" | "ready")) {
            "blocked"
        } else if initialized {
            "pass"
        } else {
            "actionRequired"
        },
        message: if !valid {
            "实例身份不兼容或已改变"
        } else if initialized {
            "已初始化"
        } else {
            "尚未初始化，需要创建管理员"
        }
        .into(),
    });
    let auth_supported = matches!(
        info.auth.registration.as_str(),
        "open" | "invite" | "closed"
    ) && if official {
        info.auth.yitan_oidc
    } else {
        info.auth.password
    };
    report.check(ConnectionCheck {
        item: "auth",
        state: if auth_supported { "pass" } else { "blocked" },
        message: if official {
            "一探账号"
        } else if auth_supported {
            "邮箱密码"
        } else {
            "不支持此服务器的登录方式"
        }
        .into(),
    });
    for (item, enabled) in [("ai", info.features.ai), ("avatars", info.features.avatars)] {
        report.check(ConnectionCheck {
            item,
            state: "pass",
            message: if enabled { "已配置" } else { "未配置" }.into(),
        });
    }
    if compatible
        && valid
        && auth_supported
        && (official || matches!(info.status.as_str(), "ok" | "ready"))
        && report.error.is_none()
    {
        report.deployment = deployment;
    }
    report.info = Some(info);
    report
}

#[cfg(test)]
pub(crate) mod rebind_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };

    pub const TEST_ID: &str = "00000000-0000-4000-8000-000000000400";
    pub const TEST_USER: &str = "00000000-0000-4000-8000-000000000401";
    pub const TEST_KEY: &str = "_RckOFqgx1tk-3jNYC-h2ZH96_drE8WO1wLqyDXp9hg";
    pub fn deployment(origin: &str) -> Deployment {
        Deployment::Selfhost {
            origin: origin.into(),
            initial_origin: origin.into(),
            instance: InstanceIdentity {
                id: TEST_ID.into(),
                public_key: TEST_KEY.into(),
            },
        }
    }
    pub struct Home(pub PathBuf);
    impl Home {
        pub fn new() -> Self {
            let home = Self(
                std::env::temp_dir().join(format!("skillhub-rebind-{}", uuid::Uuid::new_v4())),
            );
            runtime_env::ensure_runtime_session_at(&home.0).unwrap();
            home
        }
        pub fn signed_in(&self, deployment: Deployment) -> RuntimeSession {
            SwitchTransaction::begin(&self.0, false)
                .unwrap()
                .commit(deployment, Some(("fixture-old-token", TEST_USER)))
                .unwrap()
        }
    }
    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // Fixed TEST-ONLY Ed25519 seed (32 bytes of 0x09); never a real instance credential.
    pub fn node_sign(payload: &serde_json::Value) -> Vec<u8> {
        let script = r#"const c=require('node:crypto'); const key=c.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,9)]),format:'der',type:'pkcs8'}); const bytes=Buffer.from(process.argv[1],'utf8'); process.stdout.write(JSON.stringify({payload:bytes.toString('base64url'),signature:c.sign(null,bytes,key).toString('base64url')}));"#;
        let result = std::process::Command::new("node")
            .args(["-e", script, &payload.to_string()])
            .output()
            .expect("Node is required for the Server signing interoperability fixture");
        assert!(result.status.success());
        result.stdout
    }
    fn payload(challenge: &AddressChallenge) -> serde_json::Value {
        serde_json::json!({"purpose":"skillhub-instance-address-proof-v1", "instanceId":TEST_ID,"origin":challenge.origin,"nonce":challenge.nonce})
    }
    fn challenge() -> AddressChallenge {
        AddressChallenge::new(
            deployment("https://old.test/prefix"),
            "https://new.test/prefix".into(),
            12,
        )
        .unwrap()
    }

    #[test]
    fn node_signature_interop_and_replay_wrong_key_fields_tampering_size_expiry() {
        let mut valid = challenge();
        let bytes = node_sign(&payload(&valid));
        valid.verify(&bytes, 12).unwrap();
        assert!(valid.verify(&bytes, 12).is_err(), "nonce is single use");
        for field in ["purpose", "instanceId", "origin", "nonce", "unknown"] {
            let mut c = challenge();
            let mut value = payload(&c);
            value[field] = serde_json::json!("wrong");
            assert!(c.verify(&node_sign(&value), 12).is_err(), "{field}");
        }
        let mut c = challenge();
        let bytes = node_sign(&payload(&c));
        if let Deployment::Selfhost { instance, .. } = &mut c.deployment {
            instance.public_key = URL_SAFE_NO_PAD.encode([1; 32]);
        }
        assert!(c.verify(&bytes, 12).is_err());
        let mut c = challenge();
        let mut proof: serde_json::Value =
            serde_json::from_slice(&node_sign(&payload(&c))).unwrap();
        let mut tampered = URL_SAFE_NO_PAD
            .decode(proof["payload"].as_str().unwrap())
            .unwrap();
        tampered[3] ^= 1;
        proof["payload"] = serde_json::json!(URL_SAFE_NO_PAD.encode(tampered));
        assert!(c.verify(&serde_json::to_vec(&proof).unwrap(), 12).is_err());
        assert!(challenge().verify(&vec![b' '; 8193], 12).is_err());
        let mut c = challenge();
        let bytes = node_sign(&payload(&c));
        assert!(c.verify(&bytes, 13).is_err());
        let mut c = challenge();
        let bytes = node_sign(&payload(&c));
        c.created -= std::time::Duration::from_secs(61);
        assert!(c.verify(&bytes, 12).is_err());
    }

    #[test]
    fn enumeration_excludes_legacy_orphan_multiple_occupied_and_changed_key() {
        let home = Home::new();
        let old = deployment("https://old.test/prefix");
        let next = deployment("https://new.test/prefix");
        old.verify_pin(&home.0, true).unwrap();
        assert!(known_instance(&home.0, &next).is_none(), "prepared orphan");
        runtime_env::write_private_json(
            &pin_path(&home.0, &old),
            &InstanceIdentity {
                id: TEST_ID.into(),
                public_key: TEST_KEY.into(),
            },
        )
        .unwrap();
        assert!(
            known_instance(&home.0, &next).is_none(),
            "inactive legacy pin"
        );
        let active = home.signed_in(old.clone());
        assert_eq!(known_instance(&home.0, &next), Some(old.clone()));
        assert_eq!(
            previous_origins(&home.0, &active).unwrap(),
            Vec::<String>::new()
        );
        let mut changed = next.clone();
        if let Deployment::Selfhost { instance, .. } = &mut changed {
            instance.public_key = URL_SAFE_NO_PAD.encode([2; 32]);
        }
        assert!(known_instance(&home.0, &changed).is_none());
        home.signed_in(deployment("https://second.test/prefix"));
        assert!(
            known_instance(&home.0, &next).is_none(),
            "ambiguous same ID"
        );
        let home = Home::new();
        home.signed_in(old.clone());
        let mut occupied = next.clone();
        if let Deployment::Selfhost { instance, .. } = &mut occupied {
            instance.id = uuid::Uuid::new_v4().to_string();
        }
        home.signed_in(occupied);
        assert!(
            known_instance(&home.0, &next).is_none(),
            "address owned by other space"
        );
    }

    #[test]
    fn interrupted_rebind_recovers_only_old_or_new_and_never_rolls_generation_back() {
        for stage in [
            "pending_rebind",
            "before_session",
            "after_session",
            "before_pin_finish",
        ] {
            let home = Home::new();
            let old = deployment("https://old.test/prefix");
            let source = home.signed_in(old.clone());
            let mut tx = SwitchTransaction::begin(&home.0, false).unwrap();
            assert!(tx
                .commit_rebind_using(&old, "https://new.test/prefix", |at| if at == stage {
                    Err("simulated power loss".into())
                } else {
                    Ok(())
                })
                .is_err());
            let interrupted = runtime_env::read_session_for_recovery_at(&home.0).unwrap();
            if !interrupted.is_sync_pending() {
                assert!(
                    runtime_env::runtime_session_snapshot_at(&home.0).is_err(),
                    "all request entry points block until recovery"
                );
            }
            tx.finished = true;
            drop(tx); // Simulate process death: no destructor rollback.
            recover_pending(&home.0).unwrap();
            let recovered = runtime_env::runtime_session_snapshot_at(&home.0).unwrap();
            assert_eq!(recovered.space_id(), source.space_id());
            assert_eq!(recovered.auth_token(), source.auth_token());
            assert!(recovered.generation() >= interrupted.generation());
            let committed = matches!(stage, "after_session" | "before_pin_finish");
            assert_eq!(
                canonical_base(&recovered.server_origin().unwrap()),
                if committed {
                    "https://new.test/prefix"
                } else {
                    "https://old.test/prefix"
                }
            );
            assert_eq!(
                previous_origins(&home.0, &recovered).unwrap(),
                if committed {
                    vec!["https://old.test/prefix".to_string()]
                } else {
                    vec![]
                }
            );
            let pin: InstancePin =
                runtime_env::read_private_json(&pin_path(&home.0, &old)).unwrap();
            assert!(pin.pending_rebind.is_none());
            recover_pending(&home.0).unwrap();
            assert_eq!(runtime_env::read_session_at(&home.0).unwrap(), recovered);
        }
    }

    #[test]
    fn initial_origin_v2_login_logout_restart_and_forgery() {
        let home = Home::new();
        let old = deployment("https://old.test/prefix");
        let source = home.signed_in(old.clone());
        let mut legacy = serde_json::to_value(&source).unwrap();
        legacy["deployment"]
            .as_object_mut()
            .unwrap()
            .remove("initialOrigin");
        runtime_env::write_private_json(&home.0.join("runtime/session.json"), &legacy).unwrap();
        assert_eq!(runtime_env::read_session_at(&home.0).unwrap(), source);
        let rebound = SwitchTransaction::begin(&home.0, false)
            .unwrap()
            .commit_rebind(&old, "https://new.test/prefix")
            .unwrap();
        runtime_env::clear_runtime_session_if_current_at(&home.0, &rebound).unwrap();
        let guest = runtime_env::read_session_at(&home.0).unwrap();
        assert_eq!(guest.space_id(), source.space_id());
        let login = home.signed_in(guest.deployment().clone());
        recover_pending(&home.0).unwrap();
        assert_eq!(
            runtime_env::read_session_at(&home.0).unwrap().space_id(),
            source.space_id()
        );
        for field in ["initialOrigin", "origin"] {
            let mut forged = serde_json::to_value(&login).unwrap();
            forged["deployment"][field] = serde_json::json!("https://attacker.test");
            runtime_env::write_private_json(&home.0.join("runtime/session.json"), &forged).unwrap();
            assert!(runtime_env::read_session_at(&home.0).is_err(), "{field}");
        }
    }

    #[test]
    fn inactive_rebind_is_guest_and_cas_rechecks_destination_and_pin() {
        let home = Home::new();
        let old = deployment("https://old.test/prefix");
        let original = home.signed_in(old.clone());
        home.signed_in(Deployment::Official);
        let rebound = SwitchTransaction::begin(&home.0, false)
            .unwrap()
            .commit_rebind(&old, "https://new.test/prefix")
            .unwrap();
        assert_eq!(rebound.space_id(), original.space_id());
        assert!(rebound.auth_token().is_none());
        assert_ne!(rebound.user_id(), original.user_id());
        let mut tx = SwitchTransaction::begin(&home.0, false).unwrap();
        let mut occupied = deployment("https://third.test/prefix");
        if let Deployment::Selfhost { instance, .. } = &mut occupied {
            instance.id = uuid::Uuid::new_v4().to_string();
        }
        let mut occupied_pin = InstancePin::new(&occupied).unwrap();
        occupied_pin.committed = true;
        runtime_env::write_private_json(&pin_path(&home.0, &occupied), &occupied_pin).unwrap();
        assert!(
            tx.commit_rebind(rebound.deployment(), "https://third.test/prefix")
                .is_err(),
            "destination was claimed after proof"
        );
        std::fs::remove_dir_all(occupied.root(&home.0)).unwrap();
        let mut pin: InstancePin =
            runtime_env::read_private_json(&pin_path(&home.0, &old)).unwrap();
        pin.public_key = URL_SAFE_NO_PAD.encode([1; 32]);
        runtime_env::write_private_json(&pin_path(&home.0, &old), &pin).unwrap();
        assert!(tx
            .commit_rebind(rebound.deployment(), "https://third.test/prefix")
            .is_err());
        tx.finished = true;
    }

    #[test]
    fn post_replace_error_keeps_journal_and_cli_recovers_before_any_reader() {
        let home = Home::new();
        let old = deployment("https://old.test/prefix");
        let original = home.signed_in(old.clone());
        let mut tx = SwitchTransaction::begin(&home.0, false).unwrap();
        runtime_env::TEST_SESSION_POST_REPLACE_ERROR.with(|fail| fail.set(true));
        let error = tx
            .commit_rebind(&old, "https://new.test/prefix")
            .unwrap_err();
        assert!(error.contains("已替换"));
        assert!(tx.finished);
        let committed = runtime_env::read_session_for_recovery_at(&home.0).unwrap();
        assert!(committed.generation() > original.generation());
        let pin: InstancePin = runtime_env::read_private_json(&pin_path(&home.0, &old)).unwrap();
        assert_eq!(pin.origin.as_deref(), Some("https://old.test/prefix"));
        assert!(pin.pending_rebind.is_some());
        assert!(runtime_env::read_session_at(&home.0).is_err());
        assert!(runtime_env::recover_unreadable_session_at(&home.0).is_err());
        assert!(
            recover_cli_startup(&home.0).is_err(),
            "CLI cannot recover an APP-owned transaction"
        );
        drop(tx);
        recover_cli_startup(&home.0).unwrap();
        assert_eq!(runtime_env::read_session_at(&home.0).unwrap(), committed);
        assert_eq!(
            previous_origins(&home.0, &committed).unwrap(),
            vec!["https://old.test/prefix"]
        );
    }

    #[test]
    fn completed_rebind_blocks_readers_until_transaction_releases_validation_gate() {
        let home = Home::new();
        let old = deployment("https://old.test/prefix");
        home.signed_in(old.clone());
        let mut tx = SwitchTransaction::begin(&home.0, false).unwrap();
        let committed = tx.commit_rebind(&old, "https://new.test/prefix").unwrap();
        assert!(runtime_env::read_session_at(&home.0).is_err());
        assert!(runtime_env::runtime_session_snapshot_at(&home.0).is_err());
        drop(tx);
        let _other_reader = runtime_env::try_shared_switch_lock_at(&home.0)
            .unwrap()
            .unwrap();
        // A pin with previous_origins exercises the actual rebind read gate:
        // another observer must not turn a healthy session into an error.
        assert_eq!(
            runtime_env::runtime_session_snapshot_at(&home.0).unwrap(),
            committed
        );
        assert_eq!(runtime_env::read_session_at(&home.0).unwrap(), committed);
    }

    #[test]
    fn final_pin_post_replace_error_continues_committed_validation_path() {
        let home = Home::new();
        let old = deployment("https://old.test/prefix");
        home.signed_in(old.clone());
        let mut tx = SwitchTransaction::begin(&home.0, false).unwrap();
        runtime_env::TEST_FINAL_PIN_POST_REPLACE_ERROR.with(|fail| fail.set(true));
        let committed = tx.commit_rebind(&old, "https://new.test/prefix").unwrap();
        assert!(tx.finished);
        assert!(runtime_env::runtime_session_snapshot_at(&home.0).is_err());
        assert!(runtime_env::TEST_FINAL_PIN_POST_REPLACE_ERROR.with(|fail| !fail.get()));
        drop(tx);
        recover_cli_startup(&home.0).unwrap();
        assert_eq!(runtime_env::read_session_at(&home.0).unwrap(), committed);
    }

    #[test]
    fn enumeration_rejects_corrupt_oversized_unknown_fields_and_symlink_pins() {
        let home = Home::new();
        let old = deployment("https://old.test/prefix");
        home.signed_in(old.clone());
        let path = pin_path(&home.0, &old);
        let pin: serde_json::Value = runtime_env::read_private_json(&path).unwrap();
        let mut unknown = pin.clone();
        unknown["unexpected"] = serde_json::json!(true);
        runtime_env::write_private_json(&path, &unknown).unwrap();
        assert!(known_instance(&home.0, &deployment("https://new.test/prefix")).is_none());
        std::fs::write(&path, vec![b' '; 1024 * 1024]).unwrap();
        assert!(known_instance(&home.0, &deployment("https://new.test/prefix")).is_none());
        std::fs::write(&path, b"broken").unwrap();
        assert!(known_instance(&home.0, &deployment("https://new.test/prefix")).is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::{symlink, PermissionsExt};
            runtime_env::write_private_json(&path, &pin).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(known_instance(&home.0, &deployment("https://new.test/prefix")).is_none());
            std::fs::remove_file(&path).unwrap();
            let outside = home.0.join("pin.json");
            runtime_env::write_private_json(&outside, &pin).unwrap();
            symlink(&outside, &path).unwrap();
            assert!(known_instance(&home.0, &deployment("https://new.test/prefix")).is_none());
        }
    }

    pub struct HttpFixture {
        pub origin: String,
        pub requests: Arc<Mutex<Vec<String>>>,
        errors: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl HttpFixture {
        pub fn start(mode: &str) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0")
                .expect("socket fixture requires unsandboxed Rust gate");
            listener.set_nonblocking(true).unwrap();
            let origin = format!("http://{}/prefix", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let errors = Arc::new(Mutex::new(Vec::new()));
            let thread_errors = errors.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let (record, stopping, base, mode) = (
                requests.clone(),
                stop.clone(),
                origin.clone(),
                mode.to_owned(),
            );
            let thread = std::thread::spawn(move || {
                'connections: while !stopping.load(Ordering::SeqCst) {
                    let (mut stream, _) = match listener.accept() {
                        Ok(value) => value,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(std::time::Duration::from_millis(5));
                            continue;
                        }
                        Err(e) => {
                            thread_errors.lock().unwrap().push(format!("accept: {e}"));
                            std::thread::sleep(std::time::Duration::from_millis(5));
                            continue;
                        }
                    };
                    // BSD sockets inherit O_NONBLOCK from the listener.
                    if let Err(e) = stream.set_nonblocking(false).and_then(|()| {
                        stream.set_read_timeout(Some(std::time::Duration::from_secs(3)))?;
                        stream.set_write_timeout(Some(std::time::Duration::from_secs(3)))
                    }) {
                        thread_errors
                            .lock()
                            .unwrap()
                            .push(format!("configure: {e}"));
                        continue;
                    }
                    let mut bytes = Vec::new();
                    let mut buf = [0u8; 4096];
                    loop {
                        let n = match stream.read(&mut buf) {
                            Ok(n) => n,
                            Err(e) => {
                                thread_errors.lock().unwrap().push(format!("read: {e}"));
                                continue 'connections;
                            }
                        };
                        if n == 0 {
                            thread_errors
                                .lock()
                                .unwrap()
                                .push("read: incomplete HTTP request".into());
                            continue 'connections;
                        }
                        bytes.extend_from_slice(&buf[..n]);
                        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&bytes[..end]);
                            let length = headers
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length: ")
                                        .and_then(|n| n.parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            if bytes.len() >= end + 4 + length {
                                break;
                            }
                        }
                    }
                    let request = String::from_utf8(bytes).unwrap();
                    record.lock().unwrap().push(request.clone());
                    let path = request
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap();
                    let mut status = 200;
                    let mut extra = String::new();
                    let body = if path == "/prefix/health" {
                        serde_json::to_vec(&serde_json::json!({"profile":"selfhost","status":"ok","version":"0.31.0","auth":{"password":true,"yitanOidc":false,"registration":"closed"},"features":{"marketplace":false,"ai":false,"avatars":false},"media":{"allowedImageHosts":[]},"instance":{"id":TEST_ID,"publicKey":TEST_KEY},"capabilities":[]})).unwrap()
                    } else if path == "/prefix/api/setup/status" {
                        br#"{"initialized":true}"#.to_vec()
                    } else if path == "/prefix/api/auth/me" {
                        if mode == "unauthorized" {
                            status = 401;
                        }
                        serde_json::to_vec(&serde_json::json!({"user":{"id":TEST_USER}})).unwrap()
                    } else if path == "/prefix/api/instance/address-proof" {
                        match mode.as_str() {
                            "429" => {
                                status = 429;
                                b"{}".to_vec()
                            }
                            "503" => {
                                status = 503;
                                b"{}".to_vec()
                            }
                            "redirect" => {
                                status = 307;
                                extra = format!("Location: {base}/redirected\r\n");
                                b"{}".to_vec()
                            }
                            "oversized" => vec![b' '; 8193],
                            "impostor" => br#"{"payload":"e30","signature":"AA"}"#.to_vec(),
                            _ => {
                                let request: serde_json::Value =
                                    serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1)
                                        .unwrap();
                                node_sign(
                                    &serde_json::json!({"purpose":"skillhub-instance-address-proof-v1","instanceId":TEST_ID,"origin":if mode == "relay" {"https://real.test/prefix"} else {&base},"nonce":request["nonce"]}),
                                )
                            }
                        }
                    } else {
                        status = 404;
                        b"{}".to_vec()
                    };
                    if let Err(e) = write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n", body.len())
                        .and_then(|()| stream.write_all(&body))
                    {
                        thread_errors.lock().unwrap().push(format!("write: {e}"));
                    }
                }
            });
            Self {
                origin,
                requests,
                errors,
                stop,
                thread: Some(thread),
            }
        }
    }
    impl Drop for HttpFixture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if self.thread.take().unwrap().join().is_err() {
                self.errors
                    .lock()
                    .unwrap()
                    .push("fixture thread panicked".into());
            }
            let errors = self.errors.lock().unwrap();
            if std::thread::panicking() {
                eprintln!("HTTP fixture errors: {errors:?}");
            } else {
                assert!(errors.is_empty(), "HTTP fixture errors: {errors:?}");
            }
        }
    }

    #[test]
    fn socket_fixture_records_read_errors_and_serves_next_connection() {
        let server = HttpFixture::start("ok");
        let address = server
            .origin
            .strip_prefix("http://")
            .unwrap()
            .strip_suffix("/prefix")
            .unwrap();
        for disconnect in [false, true] {
            let mut broken = std::net::TcpStream::connect(address).unwrap();
            broken
                .write_all(b"GET /prefix/health HTTP/1.1\r\n")
                .unwrap();
            if disconnect {
                broken.shutdown(std::net::Shutdown::Write).unwrap();
            }
            let mut next = std::net::TcpStream::connect(address).unwrap();
            next.set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            next.write_all(b"GET /prefix/health HTTP/1.1\r\nHost: fixture\r\n\r\n")
                .unwrap();
            let mut response = String::new();
            next.read_to_string(&mut response).unwrap();
            assert!(
                response.starts_with("HTTP/1.1 200 Fixture\r\n"),
                "{response}"
            );
            let errors = std::mem::take(&mut *server.errors.lock().unwrap());
            assert_eq!(errors.len(), 1, "{errors:?}");
            assert!(errors[0].starts_with("read:"), "{errors:?}");
            if disconnect {
                assert_eq!(errors[0], "read: incomplete HTTP request");
            }
        }
        assert_eq!(server.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn socket_proof_failures_are_anonymous_and_redirects_and_relay_are_rejected() {
        for mode in ["429", "503", "redirect", "oversized", "impostor", "relay"] {
            let home = Home::new();
            home.signed_in(deployment("https://old.test/prefix"));
            let server = HttpFixture::start(mode);
            let report = test_connection(&home.0, &server.origin).await;
            assert!(report.deployment.is_some());
            assert!(report.rebind.is_none(), "{mode}");
            let requests = server.requests.lock().unwrap();
            assert!(requests
                .iter()
                .all(|request| !request.to_ascii_lowercase().contains("authorization:")));
            assert!(requests
                .iter()
                .all(|request| !request.contains("/redirected")));
            assert_eq!(
                runtime_env::read_session_at(&home.0).unwrap().auth_token(),
                Some("fixture-old-token")
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observer_ignores_read_errors_but_reports_proven_changes_and_absence() {
        let previous = Some("signed-in");
        assert_eq!(
            observed_session_change(&previous, Err("lock busy".into())),
            None
        );
        assert_eq!(observed_session_change(&previous, Ok(previous)), None);
        assert_eq!(observed_session_change(&previous, Ok(None)), Some(None));
        assert_eq!(
            observed_session_change(&previous, Ok(Some("other"))),
            Some(Some("other"))
        );
        assert_eq!(
            observed_session_change(&None::<&str>, Err("unreadable".into())),
            None
        );
    }

    fn legacy_health() -> serde_json::Value {
        serde_json::json!({
            "status": "ok", "version": "0.31.0", "buildId": "fixture-build",
            "migrationMarker": "fixture-migration", "timestamp": "2026-10-18T00:00:00Z",
            "capabilities": ["auth.yitan-oidc.v1", "marketplace.public.v1", "skills.avatars.v1", "skills.library-sync.v1"]
        })
    }

    async fn fixture_health_report(
        home: &Path,
        base: &Url,
        raw: serde_json::Value,
    ) -> ConnectionReport {
        let client = crate::net::client_builder(base).unwrap().build().unwrap();
        // Feed the bounded /health response into the same APP/CLI admission path, without sockets.
        report_from_health(
            home,
            base,
            &client,
            raw,
            ConnectionReport {
                rebind: None,
                origin: Some(canonical_base(base)),
                checks: Vec::new(),
                info: None,
                deployment: None,
                error: None,
            },
        )
        .await
    }

    #[tokio::test]
    async fn legacy_official_health_allows_app_and_cli_switch_without_instance_pin() {
        let base = Deployment::Official.base().unwrap().unwrap();
        for cli in [false, true] {
            let f = Fixture::new();
            SwitchTransaction::begin(&f.0, cli)
                .unwrap()
                .commit(Deployment::Local, None)
                .unwrap();
            let mut switch = SwitchTransaction::begin(&f.0, cli).unwrap();
            let report = fixture_health_report(&f.0, &base, legacy_health()).await;
            assert!(report.error.is_none());
            assert!(report.checks.iter().all(|check| check.state == "pass"));
            let info = report.info.unwrap();
            assert_eq!(info.profile, "official");
            assert!(info.auth.yitan_oidc);
            assert!(!info.auth.password);
            assert!(info.instance.is_none());
            assert!(info.media.allowed_image_hosts.is_empty());
            assert!(info.features.marketplace && info.features.avatars && info.features.ai);
            assert!(info.capabilities.contains(&"skills.library-sync.v1".into()));
            let user = uuid::Uuid::new_v4().to_string();
            let identity = if cli {
                None
            } else {
                Some(("fixture-token", user.as_str()))
            };
            let committed = switch.commit(report.deployment.unwrap(), identity).unwrap();
            assert_eq!(committed.deployment(), &Deployment::Official);
            assert_eq!(committed.auth_token().is_none(), cli);
            assert!(!f.0.join("instance.json").exists());
        }
    }

    #[tokio::test]
    async fn legacy_official_health_blocks_an_explicit_higher_minimum_client() {
        let f = Fixture::new();
        let mut raw = legacy_health();
        raw["minClientVersion"] = "999.0.0".into();
        let report =
            fixture_health_report(&f.0, &Deployment::Official.base().unwrap().unwrap(), raw).await;
        assert!(report.deployment.is_none());
        assert!(report
            .checks
            .iter()
            .any(|check| check.item == "version" && check.state == "blocked"));
    }

    #[tokio::test]
    async fn selfhost_rejects_the_legacy_official_health_payload() {
        let f = Fixture::new();
        let report = fixture_health_report(
            &f.0,
            &normalize_base("https://selfhost.example/skillhub").unwrap(),
            legacy_health(),
        )
        .await;
        assert!(report.deployment.is_none());
        assert_eq!(report.error.unwrap().code, "invalid_server_info");
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let home =
                std::env::temp_dir().join(format!("skillhub-spaces-{}", uuid::Uuid::new_v4()));
            runtime_env::ensure_runtime_session_at(&home).unwrap();
            Self(home)
        }
        fn session(&self) -> RuntimeSession {
            runtime_env::read_session_at(&self.0).unwrap()
        }
        fn signed_in(&self, deployment: Deployment, user: &str) -> RuntimeSession {
            let session = runtime_env::new_space_session_at(
                &self.0,
                deployment,
                Some(("test-token", user)),
                self.session().generation(),
            )
            .unwrap();
            runtime_env::write_space_session_at(&self.0, &session).unwrap();
            session
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn remote(host: &str) -> Deployment {
        Deployment::Selfhost {
            initial_origin: format!("https://{host}/skillhub"),
            origin: format!("https://{host}/skillhub"),
            instance: InstanceIdentity {
                id: uuid::Uuid::new_v4().to_string(),
                public_key: URL_SAFE_NO_PAD.encode([7; 32]),
            },
        }
    }

    #[test]
    fn upgrade_031_startup_preserves_official_account_skills_and_projections() {
        #[cfg(windows)]
        use crate::platform_fs::unix_fs;
        #[cfg(unix)]
        use std::os::unix::fs as unix_fs;

        let f = Fixture(
            std::env::temp_dir().join(format!("skillhub-upgrade-031-{}", uuid::Uuid::new_v4())),
        );
        let user = uuid::Uuid::new_v4().to_string();
        let v1 = serde_json::json!({"version":1,"userId":user,"authToken":"v1-test-token","generation":41,"state":"stable"});
        runtime_env::write_private_json(&f.0.join("runtime/session.json"), &v1).unwrap();
        let skills = f.0.join("skills");
        let skill = skills.join("example");
        std::fs::create_dir_all(skill.join("references")).unwrap();
        runtime_env::write_private_json(
            &skill.join(".skillhub.json"),
            &serde_json::json!({"version":"1.0","id":"example","skillhub":{"name":"example","serverOwnerId":user}}),
        )
        .unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: example\ndescription: Upgrade fixture\n---\n旧版内容\n",
        )
        .unwrap();
        std::fs::write(skill.join("references/data.bin"), [0, 255, 13, 10]).unwrap();
        let projection = f.0.join("projections/example");
        std::fs::create_dir_all(projection.join("generation-001")).unwrap();
        std::fs::write(projection.join("generation-001/SKILL.md"), "projection\n").unwrap();
        unix_fs::symlink("generation-001", projection.join("current")).unwrap();
        std::fs::create_dir_all(f.0.join("envs")).unwrap();
        std::fs::write(f.0.join("envs/example.env"), "FIXTURE_KEY=placeholder\n").unwrap();

        let file_bytes = || -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
            walkdir::WalkDir::new(&skills)
                .into_iter()
                .map(Result::unwrap)
                .filter(|entry| entry.file_type().is_file())
                .map(|entry| {
                    (
                        entry.path().strip_prefix(&skills).unwrap().to_path_buf(),
                        std::fs::read(entry.path()).unwrap(),
                    )
                })
                .collect()
        };
        let managed_names = || -> Vec<_> {
            let mut names: Vec<_> = std::fs::read_dir(&skills)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            names.sort();
            names
        };
        let original_files = file_bytes();
        let original_names = managed_names();
        let original_target = std::fs::read_link(projection.join("current")).unwrap();
        let mut first_session = None;
        for _ in 0..2 {
            // APP captures evidence before ensuring and reading the runtime session.
            let evidence = serde_json::to_value(crate::onboarding::capture(&f.0).unwrap()).unwrap();
            assert_eq!(evidence["hasSession"], true);
            assert_eq!(evidence["hasManagedSkills"], true);
            runtime_env::ensure_runtime_session_at(&f.0).unwrap();
            let session = runtime_env::runtime_session_snapshot_at(&f.0).unwrap();
            assert_eq!(session.deployment(), &Deployment::Official);
            assert_eq!(session.space_id(), "official");
            assert_eq!(session.storage_root(&f.0), f.0);
            assert_eq!(session.user_id(), user);
            assert_eq!(session.auth_token(), Some("v1-test-token"));
            assert_eq!(session.generation(), 41);
            let bytes = std::fs::read(f.0.join("runtime/session.json")).unwrap();
            let persisted: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(persisted["version"], 2);
            assert_eq!(persisted["spaceId"], "official");
            if let Some(first) = &first_session {
                assert_eq!(&bytes, first);
            } else {
                first_session = Some(bytes);
            }
            let backup: serde_json::Value =
                runtime_env::read_private_json(&f.0.join("runtime/session-v1-backup.json"))
                    .unwrap();
            assert_eq!(backup, v1);
            assert_eq!(managed_names(), original_names);
            assert_eq!(file_bytes(), original_files);
            assert_eq!(
                std::fs::read_link(projection.join("current")).unwrap(),
                original_target
            );
            assert_eq!(
                std::fs::read(projection.join("current/SKILL.md")).unwrap(),
                b"projection\n"
            );
            assert_eq!(
                std::fs::read(f.0.join("envs/example.env")).unwrap(),
                b"FIXTURE_KEY=placeholder\n"
            );
        }
    }

    #[test]
    fn upgrade_keeps_v1_credentials_generation_and_original_backup() {
        let f = Fixture::new();
        let user = uuid::Uuid::new_v4().to_string();
        let v1 = serde_json::json!({"version":1,"userId":user,"authToken":"v1-token","generation":41,"state":"stable"});
        runtime_env::write_private_json(&f.0.join("runtime/session.json"), &v1).unwrap();
        runtime_env::ensure_runtime_session_at(&f.0).unwrap();
        let upgraded = f.session();
        assert_eq!(upgraded.user_id(), user);
        assert_eq!(upgraded.auth_token(), Some("v1-token"));
        assert_eq!(upgraded.generation(), 41);
        assert_eq!(upgraded.space_id(), "official");
        assert_eq!(upgraded.storage_root(&f.0), f.0);
        let backup: serde_json::Value =
            runtime_env::read_private_json(&f.0.join("runtime/session-v1-backup.json")).unwrap();
        assert_eq!(backup, v1);
        runtime_env::ensure_runtime_session_at(&f.0).unwrap();
        assert_eq!(f.session(), upgraded);
    }

    #[test]
    fn switch_cancel_failure_and_crash_restore_source_with_new_generation() {
        let f = Fixture::new();
        let source = f.signed_in(Deployment::Official, &uuid::Uuid::new_v4().to_string());
        let handle = crate::server_request::SpaceRegistry::handle(Some(&source));
        {
            let mut tx = SwitchTransaction::begin(&f.0, true).unwrap();
            assert!(f.session().is_sync_pending());
            assert!(require_handle(&f.session(), &handle).is_err());
            let bad = Deployment::Selfhost {
                initial_origin: "http://unsafe.test".into(),
                origin: "http://unsafe.test".into(),
                instance: InstanceIdentity {
                    id: "invalid".into(),
                    public_key: "invalid".into(),
                },
            };
            assert!(tx.commit(bad, None).is_err());
            tx.cancel().unwrap();
        }
        let restored = f.session();
        assert_eq!(restored.auth_token(), source.auth_token());
        assert_eq!(restored.deployment(), source.deployment());
        assert!(restored.generation() > source.generation());
        assert!(require_handle(&restored, &handle).is_err());
        let mut pending = restored.clone();
        pending.begin_switch().unwrap();
        runtime_env::write_space_session_at(&f.0, &pending).unwrap();
        recover_pending(&f.0).unwrap();
        assert!(!f.session().is_sync_pending());
        assert_eq!(f.session().auth_token(), source.auth_token());
        assert!(f.session().generation() > pending.generation());
    }

    #[test]
    fn cli_refuses_app_lock_and_commits_guest_a_b_a_without_resurrecting_token() {
        let f = Fixture::new();
        let a = f.signed_in(Deployment::Official, &uuid::Uuid::new_v4().to_string());
        let app = start_app(&f.0).unwrap();
        assert_eq!(SwitchTransaction::begin(&f.0, true).err().unwrap(), BUSY);
        assert_eq!(f.session(), a);
        drop(app);
        let b = {
            let mut tx = SwitchTransaction::begin(&f.0, true).unwrap();
            tx.commit(remote("b.test"), None).unwrap()
        };
        assert!(b.auth_token().is_none());
        let returned = {
            let mut tx = SwitchTransaction::begin(&f.0, true).unwrap();
            tx.commit(Deployment::Official, None).unwrap()
        };
        assert_eq!(returned.space_id(), a.space_id());
        assert!(returned.auth_token().is_none());
        assert!(returned.generation() > b.generation());
        assert!(require_handle(
            &returned,
            &crate::server_request::SpaceRegistry::handle(Some(&a))
        )
        .is_err());
    }

    #[test]
    fn commit_write_failure_preserves_pending_source_for_recovery() {
        let f = Fixture::new();
        let a = f.signed_in(Deployment::Official, &uuid::Uuid::new_v4().to_string());
        let mut tx = SwitchTransaction::begin(&f.0, true).unwrap();
        // An existing non-directory blocks target guest creation before the commit point.
        let target = Deployment::Local;
        std::fs::create_dir_all(target.root(&f.0)).unwrap();
        std::fs::write(target.root(&f.0).join("runtime"), "blocked").unwrap();
        assert!(tx.commit(target, None).is_err());
        assert_eq!(f.session(), *tx.pending());
        tx.cancel().unwrap();
        assert_eq!(f.session().auth_token(), a.auth_token());
    }

    #[test]
    fn same_uuid_isolates_sidecar_keys_sources_queue_index_and_organizer() {
        let f = Fixture::new();
        let user = uuid::Uuid::new_v4().to_string();
        let a = f.signed_in(remote("a.test"), &user);
        let b = runtime_env::new_space_session_at(
            &f.0,
            remote("b.test"),
            Some(("other-token", &user)),
            a.generation(),
        )
        .unwrap();
        let profile = crate::SkillHubProfile {
            scope: Some(SidecarScope::for_session(&a)),
            server_id: Some("server-skill-a".into()),
            ..Default::default()
        };
        assert!(require_profile(&profile, &a).is_ok());
        assert!(require_profile(&profile, &b).is_err());
        assert!(local_view(profile.clone()).server_id.is_none());
        for relative in [
            format!("library-sync/{user}/index.json"),
            format!("library-sync/{user}/staging/source.json"),
            format!("library-sync/{user}/backups/entry.json"),
            format!("organizer/{user}.json"),
            format!("runtime/policies/{user}.json"),
        ] {
            let path = a.storage_root(&f.0).join(&relative);
            runtime_env::write_private_json(&path, &serde_json::json!({"owner":"a"})).unwrap();
            assert!(!b.storage_root(&f.0).join(relative).exists());
        }
        crate::key_vault::set_vault_key_at(
            &a.storage_root(&f.0),
            &user,
            "TEST_KEY",
            "a-value",
            None,
            1,
        )
        .unwrap();
        assert!(!b.storage_root(&f.0).join("keys").join(&user).exists());
        let expected = crate::server_request::SpaceRegistry::handle(Some(&a));
        runtime_env::write_space_session_at(&f.0, &b).unwrap();
        assert!(crate::key_vault::with_current_identity_at(
            &f.0,
            &f.0.join("envs"),
            Some(&user),
            Some(&expected),
            |_, _, _| -> Result<(), String> { panic!("stale write must not run") }
        )
        .is_err());
    }

    #[test]
    fn version_compatibility_obeys_semver_and_rejects_malformed_minimum() {
        for (app, min, expected) in [
            ("0.32.0", "0.31.9", true),
            ("0.32.0-rc.1", "0.32.0", false),
            ("0.32.0", "0.32.0-rc.1", true),
            ("0.32.0-rc.10", "0.32.0-rc.2", true),
            ("0.32.0+dev", "0.32.0", true),
            ("0.32.0", "0.032.0", false),
            ("0.32.0", "0.32", false),
        ] {
            assert_eq!(version_compatible(app, min), expected, "{app} / {min}");
        }
    }

    #[test]
    fn guest_claims_are_same_space_recoverable_and_survive_sign_in() {
        let f = Fixture::new();
        let source = f.session();
        let managed = f.0.join("skills");
        let path = managed.join("example/.skillhub.json");
        let original = serde_json::json!({"version":"1","skillhub": {"scope":SidecarScope::for_session(&source),"name":"example"}});
        runtime_env::write_private_json(&path, &original).unwrap();
        let foreign =
            runtime_env::new_space_session_at(&f.0, remote("foreign.test"), None, 0).unwrap();
        let foreign_path = managed.join("foreign/.skillhub.json");
        let foreign_value = serde_json::json!({"version":"1","skillhub":{"scope":SidecarScope::for_session(&foreign),"name":"foreign"}});
        runtime_env::write_private_json(&foreign_path, &foreign_value).unwrap();
        let user = uuid::Uuid::new_v4().to_string();
        claim_guest_skills(&f.0, &managed, &source, &user).unwrap();
        recover_guest_claims(&f.0, &managed, &source).unwrap();
        let restored: serde_json::Value = runtime_env::read_private_json(&path).unwrap();
        assert_eq!(restored, original);
        runtime_env::replace_session_at(&f.0, &managed, Some(&source), Some(("signed-in", &user)))
            .unwrap();
        let adopted: crate::SkillHubJson = runtime_env::read_private_json(&path).unwrap();
        assert!(require_profile(&adopted.skillhub.unwrap(), &f.session()).is_ok());
        let unchanged: serde_json::Value = runtime_env::read_private_json(&foreign_path).unwrap();
        assert_eq!(unchanged, foreign_value);
        assert_eq!(
            std::fs::read_dir(f.0.join("runtime/guest-claims"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn guest_claim_recovery_never_overwrites_a_later_edit() {
        let f = Fixture::new();
        let source = f.session();
        let managed = f.0.join("skills");
        let path = managed.join("example/.skillhub.json");
        runtime_env::write_private_json(
            &path,
            &serde_json::json!({"skillhub":{"scope":SidecarScope::for_session(&source)}}),
        )
        .unwrap();
        claim_guest_skills(&f.0, &managed, &source, &uuid::Uuid::new_v4().to_string()).unwrap();
        let edited = serde_json::json!({"skillhub":{"name":"edited externally"}});
        runtime_env::write_private_json(&path, &edited).unwrap();
        assert!(recover_guest_claims(&f.0, &managed, &source).is_err());
        let current: serde_json::Value = runtime_env::read_private_json(&path).unwrap();
        assert_eq!(current, edited);
        assert!(replace_claim_sidecar(
            &path,
            &serde_json::json!({}),
            &serde_json::json!({"replacement":true}),
            &f.0.join("actual-inode.json"),
        )
        .is_err());
        assert_eq!(
            runtime_env::read_private_json::<serde_json::Value>(&path).unwrap(),
            edited
        );
        assert_eq!(
            std::fs::read_dir(managed.join("example")).unwrap().count(),
            1
        );
        assert_eq!(
            runtime_env::read_private_json::<serde_json::Value>(&f.0.join("actual-inode.json"))
                .unwrap(),
            edited
        );
    }

    #[test]
    fn guest_claim_crash_after_move_restores_from_retained_inode() {
        let f = Fixture::new();
        let source = f.session();
        let managed = f.0.join("skills");
        let path = managed.join("example/.skillhub.json");
        let original = serde_json::json!({"skillhub":{"scope":SidecarScope::for_session(&source)}});
        runtime_env::write_private_json(&path, &original).unwrap();
        claim_guest_skills(&f.0, &managed, &source, &uuid::Uuid::new_v4().to_string()).unwrap();
        // The claim already retained the original inode; simulate a crash before landing.
        std::fs::remove_file(&path).unwrap();
        recover_guest_claims(&f.0, &managed, &source).unwrap();
        assert_eq!(
            runtime_env::read_private_json::<serde_json::Value>(&path).unwrap(),
            original
        );
    }

    #[test]
    fn canonicalization_preserves_prefix_and_rejects_ambiguous_paths() {
        assert_eq!(
            canonical_base(&normalize_base("https://EXAMPLE.test:443/skillhub/").unwrap()),
            "https://example.test/skillhub"
        );
        for value in [
            "https://example.test/a/../b",
            "https://example.test/%2e",
            "https://example.test/a%2fb",
            "https://user@example.test",
            "https://example.test/?q=1",
            "http://example.test",
        ] {
            assert!(normalize_base(value).is_err(), "{value}");
        }
    }

    #[test]
    fn official_cannot_be_overridden_and_dev_root_is_separate() {
        assert!(serde_json::from_str::<Deployment>(
            r#"{"profile":"official","origin":"https://evil.test"}"#
        )
        .is_err());
        assert_ne!(
            channel_root(Path::new("home"), "dev"),
            channel_root(Path::new("home"), "official")
        );
        assert!(
            serde_json::from_str::<Deployment>(r#"{"profile":"official","origin":null}"#).is_err()
        );
    }

    #[test]
    fn final_commit_write_failure_keeps_source_recoverable() {
        let f = Fixture::new();
        let source = f.signed_in(Deployment::Official, &uuid::Uuid::new_v4().to_string());
        let mut tx = SwitchTransaction::begin(&f.0, true).unwrap();
        let pending = f.session();
        assert!(tx
            .commit_using(Deployment::Local, None, |_, _| Err(
                "injected atomic write failure".into()
            ))
            .is_err());
        assert_eq!(f.session(), pending);
        tx.cancel().unwrap();
        assert_eq!(f.session().auth_token(), source.auth_token());
    }

    #[test]
    fn same_uuid_never_shares_space_or_scope() {
        let instance = InstanceIdentity {
            id: uuid::Uuid::new_v4().to_string(),
            public_key: URL_SAFE_NO_PAD.encode([1u8; 32]),
        };
        let a = Deployment::Selfhost {
            initial_origin: "https://a.test/api".into(),
            origin: "https://a.test/api".into(),
            instance: instance.clone(),
        };
        let b = Deployment::Selfhost {
            initial_origin: "https://a.test/other".into(),
            origin: "https://a.test/other".into(),
            instance,
        };
        assert_ne!(a.space_id(), b.space_id());
        assert_ne!(a.root(Path::new("home")), b.root(Path::new("home")));
    }
}
