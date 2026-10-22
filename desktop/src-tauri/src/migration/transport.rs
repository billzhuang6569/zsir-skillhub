use super::*;
use crate::runtime_env::RuntimeSession;
use crate::server_request::SpaceRegistry;
use reqwest::{Method, Url};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Side {
    Source,
    Target,
    Catalog,
    Media,
}

pub(super) struct Reply {
    pub status: u16,
    pub retry_after: u64,
    pub bytes: Vec<u8>,
}

impl Reply {
    pub fn json<T: serde::de::DeserializeOwned>(&self) -> Result<T, String> {
        if !(200..300).contains(&self.status) {
            return Err(format!("HTTP_{}", self.status));
        }
        serde_json::from_slice(&self.bytes).map_err(|_| "MIGRATION_INVALID_RESPONSE".into())
    }
}

// Fake implementations exercise the complete engine without binding a port.
pub(super) fn bound_request(
    client: &reqwest::Client,
    method: Method,
    url: Url,
    session: Option<&RuntimeSession>,
) -> Result<reqwest::RequestBuilder, String> {
    let mut request = client
        .request(method, url.clone())
        .timeout(Duration::from_secs(90));
    if let Some(session) = session {
        let base = session.deployment().base()?.ok_or("MIGRATION_NO_SERVER")?;
        let prefix = format!("{}/", crate::spaces::canonical_base(&base));
        if !url.as_str().starts_with(&prefix) {
            return Err("MIGRATION_CREDENTIAL_DESTINATION".into());
        }
        request = request.bearer_auth(session.auth_token().ok_or("MIGRATION_LOGIN_REQUIRED")?);
    }
    Ok(request)
}

pub(super) trait Transport {
    fn check(&self) -> Result<(), String>;
    async fn sync_library(&self) -> Result<(), crate::library_sync::SyncError> {
        Err(crate::library_sync::SyncError::Unsupported)
    }
    async fn request(
        &self,
        side: Side,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Reply, String>;
    async fn catalog_package(&self, id: &str, hash: &str) -> Result<Vec<u8>, String> {
        let reply = self
            .request(
                Side::Catalog,
                Method::GET,
                &format!("api/marketplace/{id}/package"),
                None,
            )
            .await?;
        if reply.status != 200 || sha(&reply.bytes) != hash {
            return Err("CATALOG_PACKAGE_UNAVAILABLE".into());
        }
        Ok(reply.bytes)
    }
    async fn wait(&self, seconds: u64) -> Result<(), String> {
        for _ in 0..seconds.max(1) {
            self.check()?;
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        self.check()
    }
}

pub(super) fn export_route(method: &Method, path: &str) -> bool {
    if *method != Method::GET {
        return false;
    }
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let parts: Vec<_> = path.split('/').collect();
    match parts.as_slice() {
        ["api", "skills"]
        | ["api", "library"]
        | ["api", "library", "tags"]
        | ["api", "library", "quick-access"] => query.is_empty(),
        ["api", "skills", id, "versions" | "package"] => resource(id) && query.is_empty(),
        ["api", "cards", sha] | ["api", "cards", sha, "meta"] => {
            hash_valid(sha) && query.is_empty()
        }
        ["api", "skill-avatars", "export"] => {
            let Some((key, ids)) = query.split_once('=') else {
                return false;
            };
            matches!(key, "skillIds" | "localSkillIds")
                && ids.split(',').count() <= 100
                && ids.split(',').all(resource)
        }
        _ => false,
    }
}

pub(super) fn preflight_route(method: &Method, path: &str) -> bool {
    *method == Method::POST
        && (path == "api/migrations"
            || matches!(path.split('/').collect::<Vec<_>>().as_slice(),
            ["api", "migrations", id, "precheck"] if uuid::Uuid::parse_str(id).is_ok()))
}

pub(super) struct Native<'a> {
    pub registry: &'a SpaceRegistry,
    pub source: Option<RuntimeSession>,
    pub target: RuntimeSession,
    pub window: Option<(RuntimeSession, RuntimeSession)>,
    pub cancel: &'a AtomicBool,
    pub started: Instant,
}

impl Native<'_> {
    fn session(&self, side: Side) -> Result<&RuntimeSession, String> {
        match side {
            Side::Source => self.source.as_ref().ok_or("MIGRATION_NO_SOURCE".into()),
            Side::Target => Ok(&self.target),
            _ => Err("MIGRATION_ANONYMOUS".into()),
        }
    }
}

impl Transport for Native<'_> {
    async fn sync_library(&self) -> Result<(), crate::library_sync::SyncError> {
        crate::library_sync::run_sync_for_session(self.target.clone(), false, None)
            .await
            .map(|_| ())
    }
    async fn catalog_package(&self, id: &str, hash: &str) -> Result<Vec<u8>, String> {
        self.check()?;
        let bytes = crate::catalog::package(
            self.registry.migration_root(),
            &crate::catalog::origin()?,
            id,
            hash,
        )
        .await
        .map_err(|reason| match reason.as_str() {
            "无法连接官方商店，请稍后重试"
            | "官方商店包暂时不可用，请稍后重试"
            | "官方商店包下载中断" => "CATALOG_PACKAGE_UNAVAILABLE".into(),
            "官方商店包校验失败，请重新下载" => "MIGRATION_HASH_MISMATCH".into(),
            "官方商店包过大" => "MIGRATION_PACKAGE_TOO_LARGE".into(),
            "官方 Skill 标识无效" | "官方包哈希无效" => {
                "MIGRATION_INVALID_RESPONSE".into()
            }
            _ => reason,
        })?;
        self.check()?;
        Ok(bytes)
    }
    fn check(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Acquire) {
            return Err("MIGRATION_CANCELLED".into());
        }
        if let Some(expected) = &self.window {
            if self.started.elapsed() > Duration::from_secs(15 * 60)
                || self.registry.migration_window()? != *expected
            {
                return Err(crate::spaces::STALE.into());
            }
        } else if crate::runtime_env::runtime_session_snapshot_at(self.registry.migration_root())?
            != self.target
            || self.target.is_sync_pending()
        {
            return Err(crate::spaces::STALE.into());
        }
        for session in self.source.iter().chain(std::iter::once(&self.target)) {
            session
                .deployment()
                .verify_pin(self.registry.migration_root(), false)?;
        }
        Ok(())
    }

    async fn request(
        &self,
        side: Side,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Reply, String> {
        self.check()?;
        if (side == Side::Source && !export_route(&method, path))
            || (side == Side::Target && self.window.is_some() && !preflight_route(&method, path))
            || (matches!(side, Side::Catalog | Side::Media) && method != Method::GET)
        {
            return Err("MIGRATION_ROUTE_DENIED".into());
        }
        // Clients are keyed and validated by server base, never by the full request URL:
        // export routes carry a query string, which is not a valid server base.
        let (url, session, client_base) = if matches!(side, Side::Source | Side::Target) {
            let session = self.session(side)?;
            crate::spaces::verify_deployment_identity(session.deployment()).await?;
            self.check()?;
            let base = session.deployment().base()?.ok_or("MIGRATION_NO_SERVER")?;
            (append(&base, path)?, Some(session), base)
        } else if side == Side::Catalog {
            let base = crate::spaces::normalize_base(&crate::catalog::origin()?)?;
            if !matches!(path.split('/').collect::<Vec<_>>().as_slice(),
                ["api", "marketplace", id] | ["api", "marketplace", id, "package"] if resource(id))
            {
                return Err("MIGRATION_ROUTE_DENIED".into());
            }
            (append(&base, path)?, None, base)
        } else {
            let url = Url::parse(path).map_err(|_| "MIGRATION_MEDIA_URL")?;
            if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
                return Err("MIGRATION_MEDIA_URL".into());
            }
            let base = media_client_base(&url)?;
            crate::net::validate_base_url(&base).map_err(|_| "MIGRATION_MEDIA_URL")?;
            (url, None, base)
        };
        let client = self.registry.client_for(&client_base)?;
        let mut request = bound_request(&client, method, url, session)?;
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request.send().await.map_err(|_| "MIGRATION_NETWORK")?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(1);
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "MIGRATION_NETWORK")? {
            self.check()?;
            if bytes.len().saturating_add(chunk.len()) > 20 * 1024 * 1024 {
                return Err("MIGRATION_RESPONSE_TOO_LARGE".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        self.check()?;
        // Never persist or return a response that echoes either credential.
        for session in self.source.iter().chain(std::iter::once(&self.target)) {
            if let Some(token) = session.auth_token() {
                if bytes.windows(token.len()).any(|s| s == token.as_bytes()) {
                    return Err("MIGRATION_CREDENTIAL_IN_RESPONSE".into());
                }
            }
        }
        Ok(Reply {
            status,
            retry_after,
            bytes,
        })
    }
}

/// Media URLs may carry any path or query; the HTTP client only depends on the origin.
pub(super) fn media_client_base(url: &Url) -> Result<Url, String> {
    let origin = url.origin();
    if !origin.is_tuple() {
        return Err("MIGRATION_MEDIA_URL".into());
    }
    Url::parse(&origin.ascii_serialization()).map_err(|_| "MIGRATION_MEDIA_URL".into())
}

fn append(base: &Url, path: &str) -> Result<Url, String> {
    if path.starts_with('/') || path.contains("..") || path.contains('#') || path.contains('%') {
        return Err("MIGRATION_ROUTE_DENIED".into());
    }
    Url::parse(&format!("{}/{path}", base.as_str().trim_end_matches('/')))
        .map_err(|_| "MIGRATION_ROUTE_DENIED".into())
}
