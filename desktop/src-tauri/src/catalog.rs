//! Anonymous official packages; original ZIP bytes must survive account binding.
#[cfg(windows)]
use crate::platform_fs::OpenOptionsExt;
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_PACKAGE: usize = 20 * 1024 * 1024;
const MAX_CACHE: u64 = 200 * 1024 * 1024;

pub(crate) fn origin() -> Result<String, String> {
    Ok(
        crate::spaces::normalize_base(&crate::official_channel::COMPILED.catalog_origin)?
            .as_str()
            .trim_end_matches('/')
            .to_string(),
    )
}

pub(crate) fn validate_origin(value: &str) -> Result<String, String> {
    let normalized = crate::spaces::normalize_base(value)?
        .as_str()
        .trim_end_matches('/')
        .to_string();
    if normalized != origin()? {
        return Err("商店来源不是官方地址".into());
    }
    Ok(normalized)
}

fn cache_dir(root: &Path) -> Result<PathBuf, String> {
    let cache = root.join("cache");
    crate::runtime_env::ensure_private_directory(&cache)?;
    let directory = cache.join("catalog-packages");
    crate::runtime_env::ensure_private_directory(&directory)?;
    Ok(directory)
}

fn verify(sha: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty()
        || bytes.len() > MAX_PACKAGE
        || sha.len() != 64
        || !sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || format!("{:x}", Sha256::digest(bytes)) != sha
    {
        return Err("官方商店包校验失败，请重新下载".into());
    }
    Ok(())
}

pub(crate) fn cache_package(root: &Path, sha: &str, bytes: &[u8]) -> Result<(), String> {
    verify(sha, bytes)?;
    let directory = cache_dir(root)?;
    let _lock = crate::skill_lock::lock_skill_dir_at(&directory, "packages")?;
    let target = directory.join(format!("{sha}.zip"));
    if fs::symlink_metadata(&target).is_ok() {
        // Never follow or overwrite a pre-existing link.
        if read_cached(root, sha)?.is_some() {
            return Ok(());
        }
        return Err("官方包缓存无效".into());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if meta.is_file() && entry.path().extension().is_some_and(|v| v == "zip") {
            entries.push((
                meta.modified().map_err(|e| e.to_string())?,
                meta.len(),
                entry.path(),
            ));
        }
    }
    entries.sort_by_key(|entry| entry.0);
    let mut total = entries.iter().map(|entry| entry.1).sum::<u64>() + bytes.len() as u64;
    for (_, size, path) in entries {
        if total <= MAX_CACHE {
            break;
        }
        fs::remove_file(path).map_err(|e| e.to_string())?;
        total -= size;
    }
    let temporary = directory.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        // A hard link publishes without overwriting a concurrent writer.
        match fs::hard_link(&temporary, &target) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => read_cached(root, sha)?
                .map(|_| ())
                .ok_or("官方包缓存无效".into()),
            Err(e) => Err(e.to_string()),
        }
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn read_cached(root: &Path, sha: &str) -> Result<Option<Vec<u8>>, String> {
    if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("官方包哈希无效".into());
    }
    let path = cache_dir(root)?.join(format!("{sha}.zip"));
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.is_file() || meta.len() > MAX_PACKAGE as u64 {
        return Err("官方包缓存无效".into());
    }
    let mut bytes = Vec::new();
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    options
        .open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_PACKAGE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    verify(sha, &bytes)?;
    Ok(Some(bytes))
}

pub(crate) async fn package(
    root: &Path,
    source: &str,
    skill_id: &str,
    sha: &str,
) -> Result<Vec<u8>, String> {
    let source = validate_origin(source)?;
    uuid::Uuid::parse_str(skill_id).map_err(|_| "官方 Skill 标识无效")?;
    if let Some(bytes) = read_cached(root, sha)? {
        return Ok(bytes);
    }
    let url = reqwest::Url::parse(&format!("{source}/api/marketplace/{skill_id}/package"))
        .map_err(|e| e.to_string())?;
    download_package(root, url, sha).await
}

async fn download_package(root: &Path, url: reqwest::Url, sha: &str) -> Result<Vec<u8>, String> {
    let client = crate::net::client_builder(&url)?
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "无法连接官方商店，请稍后重试")?;
    if !response.status().is_success() {
        return Err("官方商店包暂时不可用，请稍后重试".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "官方商店包下载中断")? {
        if bytes.len() + chunk.len() > MAX_PACKAGE {
            return Err("官方商店包过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    verify(sha, &bytes)?;
    cache_package(root, sha, &bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_preserves_original_bytes_and_rejects_corruption() {
        let root = std::env::temp_dir().join(format!("catalog-{}", uuid::Uuid::new_v4()));
        let bytes = b"original zip bytes";
        let sha = format!("{:x}", Sha256::digest(bytes));
        cache_package(&root, &sha, bytes).unwrap();
        assert_eq!(read_cached(&root, &sha).unwrap().unwrap(), bytes);
        assert!(read_cached(&root, &"a".repeat(64)).unwrap().is_none());
        fs::write(
            root.join("cache/catalog-packages")
                .join(format!("{sha}.zip")),
            b"changed",
        )
        .unwrap();
        assert!(read_cached(&root, &sha).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn catalog_cache_hit_requires_no_network() {
        let root = std::env::temp_dir().join(format!("catalog-{}", uuid::Uuid::new_v4()));
        let bytes = b"original bytes";
        let sha = format!("{:x}", Sha256::digest(bytes));
        cache_package(&root, &sha, bytes).unwrap();
        assert_eq!(
            package(
                &root,
                &origin().unwrap(),
                "11111111-1111-4111-8111-111111111111",
                &sha
            )
            .await
            .unwrap(),
            bytes
        );
        assert!(package(
            &root,
            "https://untrusted.invalid",
            "11111111-1111-4111-8111-111111111111",
            &sha
        )
        .await
        .is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(
                    root.join("cache/catalog-packages")
                        .join(format!("{sha}.zip"))
                )
                .unwrap()
                .permissions()
                .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn catalog_missing_package_downloads_anonymously_and_checks_hash() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = reqwest::Url::parse(&format!(
            "http://{}/api/marketplace/id/package",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let thread = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                let size = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..size]).to_lowercase();
                assert!(
                    !request.contains("authorization")
                        && !request.contains("clientid")
                        && !request.contains("deviceid")
                );
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nzip"
                )
                .unwrap();
            }
        });
        let root = std::env::temp_dir().join(format!("catalog-{}", uuid::Uuid::new_v4()));
        let sha = format!("{:x}", Sha256::digest(b"zip"));
        assert!(read_cached(&root, &sha).unwrap().is_none());
        assert_eq!(
            download_package(&root, url.clone(), &sha).await.unwrap(),
            b"zip"
        );
        assert!(download_package(&root, url, &"a".repeat(64)).await.is_err());
        thread.join().unwrap();
        assert_eq!(read_cached(&root, &sha).unwrap().unwrap(), b"zip");
        fs::remove_dir_all(root).unwrap();
    }
}
