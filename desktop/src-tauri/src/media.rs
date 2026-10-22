//! Public images only. The registry owns the instance connection and media policy.
use crate::server_request::{SpaceHandle, SpaceRegistry};
use reqwest::Url;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::Manager;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

const MAX_BYTES: usize = 10 * 1024 * 1024;
const HEALTH_TTL: Duration = Duration::from_secs(60);
const UNAVAILABLE: &str = "图片不可用";

#[derive(Default)]
pub(crate) struct MediaState {
    hosts: Mutex<Option<(String, Instant, Vec<String>)>>,
    clients: Mutex<HashMap<String, reqwest::Client>>,
}

fn segment(value: &str) -> bool {
    !value.is_empty()
        && !matches!(value, "." | "..")
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn instance_key(value: &str) -> bool {
    let Some((prefix, file)) = value.split_once('/') else {
        return false;
    };
    let Some((digest, extension)) = file.rsplit_once('.') else {
        return false;
    };
    prefix.len() == 2
        && digest.len() == 64
        && digest.starts_with(prefix)
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && matches!(extension, "jpg" | "png" | "webp")
}

/// Decode only Tauri's outer encodeURIComponent envelope, never individual segments.
/// An encoded slash in a media segment remains `%2F` after this and is rejected.
fn protocol_path(raw: &str) -> Option<String> {
    let raw = raw.strip_prefix('/')?;
    if raw.contains('/') {
        return Some(raw.to_string());
    }
    let mut decoded = Vec::new();
    let mut bytes = raw.bytes();
    while let Some(byte) = bytes.next() {
        decoded.push(if byte == b'%' {
            let hi = (bytes.next()? as char).to_digit(16)?;
            let lo = (bytes.next()? as char).to_digit(16)?;
            (hi * 16 + lo) as u8
        } else {
            byte
        });
    }
    String::from_utf8(decoded).ok()
}

fn parse_path<'a>(path: &'a str, current_space: &str) -> Option<&'a str> {
    let (space, reference) = path.split_once('/')?;
    if space != current_space || !segment(space) || !reference.split('/').all(segment) {
        return None;
    }
    if let Some(key) = reference.strip_prefix("m/") {
        return instance_key(key).then_some(reference);
    }
    let (host, path) = reference.strip_prefix("h/")?.split_once('/')?;
    let url = Url::parse(&format!("https://{host}/{path}")).ok()?;
    (url.host_str() == Some(host) && url.port().is_none()).then_some(reference)
}

fn resolve(reference: &str, base: &Url, hosts: &[String]) -> Option<Url> {
    if let Some(key) = reference.strip_prefix("m/") {
        return Url::parse(&format!(
            "{}/media/{key}",
            base.as_str().trim_end_matches('/')
        ))
        .ok();
    }
    let (host, path) = reference.strip_prefix("h/")?.split_once('/')?;
    hosts
        .iter()
        .any(|allowed| allowed == host)
        .then(|| Url::parse(&format!("https://{host}/{path}")).ok())
        .flatten()
}

pub(crate) fn image_reference(value: &str, base: &Url, hosts: &[String]) -> Option<String> {
    // Check before URL parsing, which would normalize away traversal and backslashes.
    if value.contains(['%', '?', '#', '\\']) || value.chars().any(char::is_whitespace) {
        return None;
    }
    let (_, rest) = value.split_once("://")?;
    let (_, raw_path) = rest.split_once('/')?;
    if !raw_path.split('/').all(segment) {
        return None;
    }
    let url = Url::parse(value).ok()?;
    crate::net::validate_base_url(&url).ok()?;
    let prefix = format!("{}/media/", base.path().trim_end_matches('/'));
    let reference = if url.origin() == base.origin() && url.path().starts_with(&prefix) {
        format!("m/{}", url.path().strip_prefix(&prefix)?)
    } else if url.scheme() == "https" && url.port().is_none() {
        format!("h/{}/{}", url.host_str()?, url.path().strip_prefix('/')?)
    } else {
        return None;
    };
    parse_path(&format!("current/{reference}"), "current")?;
    resolve(&reference, base, hosts)?;
    Some(reference)
}

pub(crate) fn raster_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() > MAX_BYTES {
        return None;
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else {
        None
    }
}

async fn read_response(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response.status() != 200
        || response
            .content_length()
            .is_some_and(|size| size > limit as u64)
    {
        return Err(UNAVAILABLE.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNAVAILABLE)? {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(UNAVAILABLE.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn media_identity(session: Option<&crate::runtime_env::RuntimeSession>) -> String {
    session.map_or_else(
        || "official".into(),
        |session| {
            format!(
                "{}_{}_{}",
                session.space_id(),
                session.user_id(),
                session.generation()
            )
        },
    )
}

fn health_image_hosts(
    health: &serde_json::Value,
    legacy_official: bool,
) -> Result<Vec<String>, String> {
    match health["media"].get("allowedImageHosts") {
        None if legacy_official => Ok(Vec::new()),
        Some(hosts) => serde_json::from_value(hosts.clone()).map_err(|_| UNAVAILABLE.into()),
        None => Err(UNAVAILABLE.into()),
    }
}

impl SpaceRegistry {
    pub(crate) async fn media_space(&self) -> Result<SpaceHandle, String> {
        Ok(Self::handle(self.snapshot(false).await?.as_ref()))
    }

    pub(crate) async fn media_key(&self) -> Result<String, String> {
        Ok(media_identity(self.snapshot(false).await?.as_ref()))
    }

    fn media_connection(
        &self,
        session: Option<&crate::runtime_env::RuntimeSession>,
        catalog: bool,
    ) -> Result<(Url, reqwest::Client), String> {
        if !catalog {
            return self.connection(session);
        }
        let base =
            crate::spaces::normalize_base(&crate::official_channel::COMPILED.catalog_origin)?;
        let client = crate::net::client_builder(&base)?
            .build()
            .map_err(|_| UNAVAILABLE)?;
        Ok((base, client))
    }

    pub(crate) async fn image_hosts(&self) -> Result<Vec<String>, String> {
        self.image_hosts_for(false, &self.media_space().await?)
            .await
    }

    async fn image_hosts_for(
        &self,
        catalog: bool,
        expected: &SpaceHandle,
    ) -> Result<Vec<String>, String> {
        // A waiter must capture the session after the preceding refresh releases the cache.
        let mut cache = self.media.hosts.lock().await;
        let session = self.snapshot(false).await?;
        if Self::handle(session.as_ref()) != *expected {
            return Err(UNAVAILABLE.into());
        }
        let (base, client) = self.media_connection(session.as_ref(), catalog)?;
        let key = format!(
            "{}{}",
            if catalog { "catalog_" } else { "" },
            media_identity(session.as_ref())
        );
        if let Some((_, _, hosts)) = cache
            .as_ref()
            .filter(|(cached, time, _)| cached == &key && time.elapsed() < HEALTH_TTL)
        {
            return Ok(hosts.clone());
        }
        let response = client
            .get(format!("{}/health", base.as_str().trim_end_matches('/')))
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|_| UNAVAILABLE)?;
        let bytes = read_response(response, 64 * 1024).await?;
        let health: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE)?;
        let hosts = health_image_hosts(
            &health,
            catalog
                || session
                    .as_ref()
                    .is_none_or(|s| s.deployment().profile() == "official"),
        )?;
        if format!(
            "{}{}",
            if catalog { "catalog_" } else { "" },
            self.media_key().await?
        ) != key
        {
            return Err(UNAVAILABLE.into());
        }
        *cache = Some((key, Instant::now(), hosts.clone()));
        Ok(hosts)
    }

    pub(crate) async fn validate_image_url(&self, value: &str) -> Result<String, String> {
        let session = self.snapshot(false).await?;
        let (base, _) = self.connection(session.as_ref())?;
        // Instance media does not depend on the external-host allowlist being available.
        if image_reference(value, &base, &[]).is_some() {
            return Ok(value.to_string());
        }
        let space = Self::handle(session.as_ref());
        image_reference(value, &base, &self.image_hosts_for(false, &space).await?)
            .map(|_| value.to_string())
            .ok_or_else(|| UNAVAILABLE.into())
    }

    async fn image_client(&self, url: &Url) -> Result<reqwest::Client, String> {
        let origin = url.origin().ascii_serialization();
        let mut clients = self.media.clients.lock().await;
        if let Some(client) = clients.get(&origin) {
            return Ok(client.clone());
        }
        // A loopback instance's no-proxy/plaintext DNS policy must not leak to HTTPS media.
        let client = crate::net::client_builder(url)?
            .build()
            .map_err(|_| UNAVAILABLE)?;
        clients.insert(origin, client.clone());
        Ok(client)
    }

    async fn load_image_for(
        &self,
        root: &Path,
        space: &SpaceHandle,
        reference: &str,
        catalog: bool,
    ) -> Result<Vec<u8>, String> {
        let session = self.snapshot(false).await?;
        if Self::handle(session.as_ref()) != *space {
            return Err(UNAVAILABLE.into());
        }
        let (base, _) = self.media_connection(session.as_ref(), catalog)?;
        let cache_scope = session.as_ref().map_or_else(
            || space.space_id.clone(),
            |session| format!("{}/{}", space.space_id, session.user_id()),
        );
        let cache_scope = if catalog {
            format!("catalog/{cache_scope}")
        } else {
            cache_scope
        };
        let path = cache_path(root, &cache_scope, reference);
        // Cache entries are only written after host and raster validation. Already-approved
        // immutable images work offline; /health's short TTL applies to new network fetches.
        let mut readable = vec![path.clone()];
        if !catalog
            && session
                .as_ref()
                .is_some_and(|session| session.space_id() == "official")
        {
            readable.push(cache_path(root, "official", reference));
        }
        for cached in readable {
            if let Ok(file) = tokio::fs::File::open(&cached).await {
                let mut bytes = Vec::new();
                file.take((MAX_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|_| UNAVAILABLE)?;
                if raster_type(&bytes).is_some() {
                    if reference.starts_with("h/") {
                        // Honor the latest known policy for hits; misses refresh it using the TTL.
                        let key = format!(
                            "{}{}",
                            if catalog { "catalog_" } else { "" },
                            media_identity(session.as_ref())
                        );
                        if let Some((_, _, hosts)) = self
                            .media
                            .hosts
                            .lock()
                            .await
                            .as_ref()
                            .filter(|(cached, _, _)| cached == &key)
                        {
                            resolve(reference, &base, hosts).ok_or(UNAVAILABLE)?;
                        }
                    }
                    return Ok(bytes);
                }
            }
        }
        let hosts = if reference.starts_with("h/") {
            self.image_hosts_for(catalog, space).await?
        } else {
            Vec::new()
        };
        let url = resolve(reference, &base, &hosts).ok_or(UNAVAILABLE)?;
        let response = self
            .image_client(&url)
            .await?
            .get(url)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|_| UNAVAILABLE)?;
        let bytes = read_response(response, MAX_BYTES).await?;
        raster_type(&bytes).ok_or(UNAVAILABLE)?;
        if self.media_space().await? != *space {
            return Err(UNAVAILABLE.into());
        }
        if let Some(parent) = path.parent() {
            // shortcut: no eviction beyond the per-file cap; add a quota when cache growth warrants it.
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|_| UNAVAILABLE)?;
            let temporary = parent.join(format!(".{}", uuid::Uuid::new_v4()));
            tokio::fs::write(&temporary, &bytes)
                .await
                .map_err(|_| UNAVAILABLE)?;
            // Windows cannot replace a concurrently-created file; either valid copy is sufficient.
            if tokio::fs::rename(&temporary, &path).await.is_err() {
                let _ = tokio::fs::remove_file(&temporary).await;
            }
        }
        Ok(bytes)
    }

    pub(crate) async fn serve_media(
        &self,
        root: &Path,
        request: &tauri::http::Request<Vec<u8>>,
    ) -> tauri::http::Response<Vec<u8>> {
        let result = async {
            if request.method() != tauri::http::Method::GET || request.uri().query().is_some() {
                return None;
            }
            let space = self.media_space().await.ok()?;
            let path = protocol_path(request.uri().path())?;
            let catalog = path.starts_with("catalog_");
            let key = format!(
                "{}{}",
                if catalog { "catalog_" } else { "" },
                self.media_key().await.ok()?
            );
            let reference = parse_path(&path, &key)?;
            let bytes = self
                .load_image_for(root, &space, reference, catalog)
                .await
                .ok()?;
            if self.media_space().await.ok()? != space {
                return None;
            }
            let content_type = raster_type(&bytes)?;
            Some(
                tauri::http::Response::builder()
                    .header("Content-Type", content_type)
                    .header("Cache-Control", "private, max-age=86400")
                    .header("X-Content-Type-Options", "nosniff")
                    .body(bytes)
                    .expect("static media headers"),
            )
        }
        .await;
        result.unwrap_or_else(not_found)
    }
}

fn cache_path(root: &Path, space: &str, reference: &str) -> PathBuf {
    root.join("skillhub-media")
        .join(space)
        .join(format!("{:x}", Sha256::digest(reference.as_bytes())))
}

pub(crate) fn not_found() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(404)
        .body(Vec::new())
        .expect("static status")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaSpace {
    space: SpaceHandle,
    server_base: String,
    media_key: String,
    allowed_image_hosts: Option<Vec<String>>,
    previous_origins: Vec<String>,
}

#[tauri::command]
pub(crate) async fn current_media_space(
    state: tauri::State<'_, SpaceRegistry>,
    catalog: Option<bool>,
) -> Result<MediaSpace, String> {
    let catalog = catalog.unwrap_or(false);
    let session = state.snapshot(false).await?;
    let space = SpaceRegistry::handle(session.as_ref());
    let hosts = if catalog {
        Some(state.image_hosts_for(true, &space).await?)
    } else {
        None
    };
    if state.media_space().await? != space {
        return Err(UNAVAILABLE.into());
    }
    Ok(MediaSpace {
        previous_origins: if catalog {
            Vec::new()
        } else {
            session
                .as_ref()
                .map(|session| crate::spaces::previous_origins(&crate::skillhub_dir(), session))
                .transpose()?
                .unwrap_or_default()
        },
        space,
        server_base: state
            .media_connection(session.as_ref(), catalog)?
            .0
            .to_string(),
        media_key: format!(
            "{}{}",
            if catalog { "catalog_" } else { "" },
            media_identity(session.as_ref())
        ),
        allowed_image_hosts: hosts,
    })
}

pub(crate) fn respond(
    app: tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    tauri::async_runtime::spawn(async move {
        let cache_root = if crate::official_channel::CHANNEL == "dev" {
            Ok(crate::skillhub_dir().join("cache"))
        } else {
            app.path().app_cache_dir()
        };
        let response = match cache_root {
            Ok(root) => {
                app.state::<SpaceRegistry>()
                    .serve_media(&root, &request)
                    .await
            }
            Err(_) => not_found(),
        };
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[test]
    fn legacy_official_health_has_no_external_hosts_but_selfhost_stays_strict() {
        let legacy = serde_json::json!({"status":"ok", "version":"0.31.0", "capabilities":["skills.avatars.v1"]});
        assert!(health_image_hosts(&legacy, true).unwrap().is_empty());
        assert!(health_image_hosts(&legacy, false).is_err());
        let modern = serde_json::json!({"media":{"allowedImageHosts":["images.example"]}});
        assert_eq!(
            health_image_hosts(&modern, true).unwrap(),
            ["images.example"]
        );
        assert_eq!(
            health_image_hosts(&modern, false).unwrap(),
            ["images.example"]
        );
    }

    fn key() -> String {
        format!("aa/{}.png", "a".repeat(64))
    }
    fn base() -> Url {
        Url::parse("http://127.0.0.1:9/skillhub").unwrap()
    }
    fn root() -> PathBuf {
        std::env::temp_dir().join(format!("skillhub-media-test-{}", uuid::Uuid::new_v4()))
    }
    fn request(path: &str) -> tauri::http::Request<Vec<u8>> {
        tauri::http::Request::builder()
            .uri(format!("skillhub-media://localhost/{path}"))
            .body(Vec::new())
            .unwrap()
    }

    #[test]
    fn paths_and_urls_reject_traversal_encoded_segments_and_untrusted_hosts() {
        let media = format!("m/{}", key());
        assert_eq!(
            parse_path(&format!("official/{media}"), "official"),
            Some(media.as_str())
        );
        let hosts = vec!["images.example".to_string()];
        let reference = "h/images.example/public/app/image.png";
        assert_eq!(
            parse_path(&format!("official/{reference}"), "official"),
            Some(reference)
        );
        assert_eq!(
            resolve(reference, &base(), &hosts).unwrap().as_str(),
            "https://images.example/public/app/image.png"
        );
        assert!(resolve(reference, &base(), &[]).is_none());
        for value in [
            "official/unknown/a",
            "other/m/a/b",
            "official/h/images.example/../x",
            "official/h/images.example/./x",
            "official/h/images.example//x",
            "official/h/images.example/a%2fb",
            "official/h/images.example/%2e%2e/x",
            "official/h/images.example/a?x",
            "official/h/images.example/a#x",
            "official/h/images.example:443/a",
            "official/h/user@images.example/a",
            "official/m/aa/not-a-key.png",
        ] {
            assert!(parse_path(value, "official").is_none(), "{value}");
        }
        let encoded = format!("/official%2Fm%2F{}", key().replace('/', "%2F"));
        assert_eq!(protocol_path(&encoded), Some(format!("official/{media}")));
        for raw in [
            "/official%2Fh%2Fimages.example%2Fa%252fb",
            "/official%2Fh%2Fimages.example%2F%252e%252e%2Fx",
            "/official/h/images.example/a%2fb",
        ] {
            assert!(parse_path(&protocol_path(raw).unwrap(), "official").is_none());
        }
        assert!(protocol_path("/official%xx").is_none());
        let local = format!("{}/media/{}", base(), key());
        assert_eq!(image_reference(&local, &base(), &[]), Some(media));
        for value in [
            "http://images.example/public/a.png",
            "https://evil.example/public/a.png",
            "https://images.example/a/../b.png",
            "https://images.example/a/./b.png",
            "https://images.example/a%2fb.png",
            "https://images.example/a.png?",
            "https://images.example/a.png#",
            "https://user:pass@images.example/a.png",
            "https://images.example:444/a.png",
        ] {
            assert!(image_reference(value, &base(), &hosts).is_none(), "{value}");
        }
    }

    #[test]
    fn raster_magic_and_size_are_required() {
        for (bytes, mime) in [
            (b"\x89PNG\r\n\x1a\n".as_slice(), "image/png"),
            (b"\xff\xd8\xff", "image/jpeg"),
            (b"RIFF0000WEBP", "image/webp"),
            (b"GIF87a", "image/gif"),
            (b"GIF89a", "image/gif"),
        ] {
            assert_eq!(raster_type(bytes), Some(mime));
        }
        for bytes in [
            b"<svg></svg>".as_slice(),
            b"<html>image/png</html>",
            b"RIFF",
            b"not an image",
        ] {
            assert_eq!(raster_type(bytes), None);
        }
        let mut bytes = b"GIF89a".to_vec();
        bytes.resize(MAX_BYTES, 0);
        assert_eq!(raster_type(&bytes), Some("image/gif"));
        bytes.push(0);
        assert_eq!(raster_type(&bytes), None);
    }

    #[tokio::test]
    async fn same_uuid_media_is_scoped_and_local_only_allows_explicit_catalog() {
        let root = root();
        let user = uuid::Uuid::new_v4().to_string();
        let deployment = |host: &str| crate::spaces::Deployment::Selfhost {
            initial_origin: format!("https://{host}/prefix"),
            origin: format!("https://{host}/prefix"),
            instance: crate::spaces::InstanceIdentity {
                id: "00000000-0000-0000-0000-000000000001".into(),
                public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
            },
        };
        let a = crate::runtime_env::new_space_session_at(
            &root,
            deployment("a.test"),
            Some(("token-a", &user)),
            1,
        )
        .unwrap();
        let b = crate::runtime_env::new_space_session_at(
            &root,
            deployment("b.test"),
            Some(("token-b", &user)),
            3,
        )
        .unwrap();
        assert_ne!(media_identity(Some(&a)), media_identity(Some(&b)));
        let reference = format!("m/{}", key());
        let cache = |session: &crate::runtime_env::RuntimeSession| {
            cache_path(
                &root,
                &format!("{}/{}", session.space_id(), session.user_id()),
                &reference,
            )
        };
        tokio::fs::create_dir_all(cache(&a).parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(cache(&a), b"GIF89a").await.unwrap();
        assert!(!cache(&b).exists());
        let registry = SpaceRegistry::new(base(), root.clone()).unwrap();
        let local = crate::runtime_env::new_space_session_at(
            &root,
            crate::spaces::Deployment::Local,
            None,
            5,
        )
        .unwrap();
        assert!(registry.media_connection(Some(&local), false).is_err());
        assert_eq!(
            crate::spaces::canonical_base(
                &registry.media_connection(Some(&local), true).unwrap().0
            ),
            crate::official_channel::COMPILED
                .catalog_origin
                .trim_end_matches('/')
        );
        crate::runtime_env::write_space_session_at(&root, &b).unwrap();
        *registry.media.hosts.lock().await = Some((
            media_identity(Some(&b)),
            Instant::now(),
            vec!["b-only.example".into()],
        ));
        assert!(registry
            .image_hosts_for(false, &SpaceRegistry::handle(Some(&a)))
            .await
            .is_err());
        assert_eq!(
            registry
                .image_hosts_for(false, &SpaceRegistry::handle(Some(&b)))
                .await
                .unwrap(),
            ["b-only.example"]
        );
        let response = registry
            .serve_media(
                &root,
                &request(&format!("{}/{reference}", media_identity(Some(&a)))),
            )
            .await;
        assert_eq!(response.status(), 404);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn cached_files_need_no_network_and_other_spaces_cannot_read_them() {
        let root = root();
        let registry = SpaceRegistry::new(base(), root.join("runtime-root")).unwrap();
        let reference = format!("m/{}", key());
        let path = cache_path(&root, "official", &reference);
        assert_ne!(path, cache_path(&root, "other", &reference));
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&path, b"GIF89a").await.unwrap();
        // Port 9 has no fixture: any network attempt would fail this assertion.
        let response = registry
            .serve_media(&root, &request(&format!("official/{reference}")))
            .await;
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["Content-Type"], "image/gif");
        assert_eq!(
            response.headers()["Cache-Control"],
            "private, max-age=86400"
        );
        assert_eq!(response.body(), b"GIF89a");
        let external = "h/images.example/public/app/image.png";
        tokio::fs::write(cache_path(&root, "official", external), b"GIF89a")
            .await
            .unwrap();
        *registry.media.hosts.lock().await = Some((
            registry.media_key().await.unwrap(),
            Instant::now(),
            vec!["images.example".into()],
        ));
        assert_eq!(
            registry
                .serve_media(&root, &request(&format!("official/{external}")))
                .await
                .status(),
            200
        );
        *registry.media.hosts.lock().await = Some((
            registry.media_key().await.unwrap(),
            Instant::now(),
            Vec::new(),
        ));
        assert_eq!(
            registry
                .serve_media(&root, &request(&format!("official/{external}")))
                .await
                .status(),
            404
        );
        // Another generation's policy cannot invalidate this space's verified offline cache.
        *registry.media.hosts.lock().await =
            Some(("another-generation".into(), Instant::now(), Vec::new()));
        assert_eq!(
            registry
                .serve_media(&root, &request(&format!("official/{external}")))
                .await
                .status(),
            200
        );
        let windows = tauri::http::Request::builder()
            .uri(format!(
                "http://skillhub-media.localhost/official%2F{}",
                reference.replace('/', "%2F")
            ))
            .body(Vec::new())
            .unwrap();
        assert_eq!(registry.serve_media(&root, &windows).await.status(), 200);
        for path in [
            format!("other/{reference}"),
            format!("unknown/{reference}"),
            format!("official/{reference}?x=1"),
        ] {
            let response = registry.serve_media(&root, &request(&path)).await;
            assert_eq!(response.status(), 404);
            assert!(response.body().is_empty());
        }
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn public_media_and_health_never_send_authorization_and_cache_hits_skip_network() {
        let root = root();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!(
            "http://{}/skillhub",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = tokio::spawn(async move {
            for (path, bytes) in [
                (
                    "/skillhub/health".to_string(),
                    br#"{"media":{"allowedImageHosts":["images.example"]}}"#.as_slice(),
                ),
                (
                    "/skillhub/health".to_string(),
                    br#"{"media":{"allowedImageHosts":["images.example"]}}"#.as_slice(),
                ),
                (format!("/skillhub/media/{}", key()), b"GIF89a".as_slice()),
            ] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).await.unwrap();
                    request.extend(byte);
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.starts_with(&format!("GET {path} HTTP/1.1\r\n")));
                assert!(!request.to_ascii_lowercase().contains("authorization:"));
                assert!(!request.to_ascii_lowercase().contains("cookie:"));
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).as_bytes()).await.unwrap();
                stream.write_all(bytes).await.unwrap();
            }
        });
        let registry = SpaceRegistry::new(base, root.join("runtime-root")).unwrap();
        crate::runtime_env::replace_session_at(
            &root.join("runtime-root"),
            &root.join("runtime-root/skills"),
            None,
            Some(("fixture.jwt", &uuid::Uuid::new_v4().to_string())),
        )
        .unwrap();
        let media_key = registry.media_key().await.unwrap();
        *registry.media.hosts.lock().await = Some((
            media_key.clone(),
            Instant::now() - HEALTH_TTL,
            vec!["old.example".into()],
        ));
        // A miss must refresh an expired policy, even when the old list rejected this host.
        assert_eq!(
            registry
                .serve_media(
                    &root,
                    &request(&format!("{media_key}/h/rejected.example/a.png"))
                )
                .await
                .status(),
            404
        );
        assert_eq!(
            registry.media.hosts.lock().await.as_ref().unwrap().2,
            ["images.example"]
        );
        assert_eq!(registry.image_hosts().await.unwrap(), ["images.example"]);
        let previous =
            crate::runtime_env::runtime_session_snapshot_at(&root.join("runtime-root")).unwrap();
        *registry.media.hosts.lock().await = Some((
            media_key.clone(),
            Instant::now(),
            vec!["old.example".into()],
        ));
        crate::runtime_env::replace_session_at(
            &root.join("runtime-root"),
            &root.join("runtime-root/skills"),
            Some(&previous),
            Some(("next.fixture.jwt", previous.user_id())),
        )
        .unwrap();
        // A new generation refreshes even a policy whose TTL has not expired.
        assert_eq!(registry.image_hosts().await.unwrap(), ["images.example"]);
        let media_key = registry.media_key().await.unwrap();
        let image_request = request(&format!("{media_key}/m/{}", key()));
        let first = registry.serve_media(&root, &image_request).await;
        assert_eq!(first.status(), 200);
        assert_eq!(first.headers()["Content-Type"], "image/gif");
        server.await.unwrap();
        assert_eq!(
            registry.serve_media(&root, &image_request).await.body(),
            first.body()
        );
        assert_eq!(
            registry
                .serve_media(
                    &root,
                    &request(&format!("{media_key}/h/evil.example/public/a.png"))
                )
                .await
                .status(),
            404
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn response_rejects_redirect_html_svg_and_oversized_streams() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            for response in ["HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/private\r\nContent-Length: 0\r\n\r\n".to_string(),
                format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", MAX_BYTES + 1),
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\nGIF89ax\r\n0\r\n\r\n".to_string(),
                "HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\n<html>".to_string(),
                "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n<svg>".to_string()] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 2048];
                assert!(stream.read(&mut buffer).await.unwrap() > 0);
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let client = crate::net::client_builder(&url).unwrap().build().unwrap();
        for limit in [MAX_BYTES, MAX_BYTES, 6] {
            assert!(
                read_response(client.get(url.clone()).send().await.unwrap(), limit)
                    .await
                    .is_err()
            );
        }
        for _ in 0..2 {
            let bytes = read_response(client.get(url.clone()).send().await.unwrap(), MAX_BYTES)
                .await
                .unwrap();
            assert_eq!(raster_type(&bytes), None);
        }
        server.await.unwrap();
    }
}
