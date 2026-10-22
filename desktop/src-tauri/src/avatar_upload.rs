#[cfg(windows)]
use crate::platform_fs::OpenOptionsExt;
use base64::Engine as _;
use reqwest::{header::CONTENT_TYPE, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const MAX_AVATAR_BYTES: u64 = 5 * 1024 * 1024;
/// Original picked for a Skill avatar crop; the WebView crops it to 512×512 before upload.
const MAX_AVATAR_SOURCE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
const MIN_AVATAR_DIMENSION: u32 = 64;
const MAX_AVATAR_DIMENSION: u32 = 8192;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarUploadResult {
    pub url: String,
}

/// A validated local image handed to the WebView crop dialog (never uploaded from Rust).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AvatarSource {
    pub mime_type: String,
    pub data_base64: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AvatarFormat {
    Jpeg,
    Png,
    WebP,
}

impl AvatarFormat {
    fn mime(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::WebP => "image/webp",
        }
    }
}

struct AvatarFile {
    bytes: Vec<u8>,
    format: AvatarFormat,
    width: u32,
    height: u32,
}

fn checked_dimensions(width: u32, height: u32) -> Result<(u32, u32), String> {
    if width < MIN_AVATAR_DIMENSION || height < MIN_AVATAR_DIMENSION {
        return Err(format!(
            "头像尺寸至少需要 {MIN_AVATAR_DIMENSION}×{MIN_AVATAR_DIMENSION} 像素"
        ));
    }
    if width > MAX_AVATAR_DIMENSION || height > MAX_AVATAR_DIMENSION {
        return Err(format!(
            "头像尺寸不能超过 {MAX_AVATAR_DIMENSION}×{MAX_AVATAR_DIMENSION} 像素"
        ));
    }
    Ok((width, height))
}

fn be_u32(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.try_into().ok()?))
}

fn le_u32(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.try_into().ok()?))
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 33
        || &bytes[..8] != SIGNATURE
        || be_u32(&bytes[8..12])? != 13
        || &bytes[12..16] != b"IHDR"
    {
        return None;
    }
    let width = be_u32(&bytes[16..20])?;
    let height = be_u32(&bytes[20..24])?;
    let bit_depth = bytes[24];
    let color_type = bytes[25];
    let valid_color_depth = matches!(
        (color_type, bit_depth),
        (0, 1 | 2 | 4 | 8 | 16) | (2, 8 | 16) | (3, 1 | 2 | 4 | 8) | (4, 8 | 16) | (6, 8 | 16)
    );
    if width == 0
        || height == 0
        || !valid_color_depth
        || bytes[26] != 0
        || bytes[27] != 0
        || bytes[28] > 1
    {
        return None;
    }
    Some((width, height))
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[..3] != [0xff, 0xd8, 0xff] {
        return None;
    }
    let mut offset = 2usize;
    while offset < bytes.len() {
        if bytes[offset] != 0xff {
            return None;
        }
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        let marker = *bytes.get(offset)?;
        offset += 1;
        if matches!(marker, 0x01 | 0xd8 | 0xd9 | 0xd0..=0xd7) {
            if marker == 0xd9 {
                return None;
            }
            continue;
        }
        if marker == 0xda {
            return None;
        }
        let length =
            u16::from_be_bytes([*bytes.get(offset)?, *bytes.get(offset.checked_add(1)?)?]) as usize;
        if length < 2 {
            return None;
        }
        let segment_end = offset.checked_add(length)?;
        if segment_end > bytes.len() {
            return None;
        }
        let is_start_of_frame = matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        );
        if is_start_of_frame {
            if length < 8 {
                return None;
            }
            let height = u16::from_be_bytes([bytes[offset + 3], bytes[offset + 4]]) as u32;
            let width = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]) as u32;
            return (width > 0 && height > 0).then_some((width, height));
        }
        offset = segment_end;
    }
    None
}

fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 20 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }
    let declared_end = (le_u32(&bytes[4..8])? as usize).checked_add(8)?;
    if declared_end < 20 || declared_end > bytes.len() {
        return None;
    }
    let mut offset = 12usize;
    while offset.checked_add(8)? <= declared_end {
        let chunk = bytes.get(offset..offset + 4)?;
        let chunk_size = le_u32(bytes.get(offset + 4..offset + 8)?)? as usize;
        let data_start = offset.checked_add(8)?;
        let data_end = data_start.checked_add(chunk_size)?;
        if data_end > declared_end {
            return None;
        }
        match chunk {
            b"VP8X" if chunk_size >= 10 => {
                let width = 1
                    + u32::from(bytes[data_start + 4])
                    + (u32::from(bytes[data_start + 5]) << 8)
                    + (u32::from(bytes[data_start + 6]) << 16);
                let height = 1
                    + u32::from(bytes[data_start + 7])
                    + (u32::from(bytes[data_start + 8]) << 8)
                    + (u32::from(bytes[data_start + 9]) << 16);
                return Some((width, height));
            }
            b"VP8 " if chunk_size >= 10 => {
                if bytes.get(data_start + 3..data_start + 6)? != [0x9d, 0x01, 0x2a] {
                    return None;
                }
                let width =
                    u16::from_le_bytes([bytes[data_start + 6], bytes[data_start + 7]]) & 0x3fff;
                let height =
                    u16::from_le_bytes([bytes[data_start + 8], bytes[data_start + 9]]) & 0x3fff;
                return (width > 0 && height > 0).then_some((u32::from(width), u32::from(height)));
            }
            b"VP8L" if chunk_size >= 5 => {
                if bytes[data_start] != 0x2f {
                    return None;
                }
                let dimensions = u32::from_le_bytes([
                    bytes[data_start + 1],
                    bytes[data_start + 2],
                    bytes[data_start + 3],
                    bytes[data_start + 4],
                ]);
                let width = (dimensions & 0x3fff) + 1;
                let height = ((dimensions >> 14) & 0x3fff) + 1;
                return Some((width, height));
            }
            _ => {}
        }
        offset = data_end.checked_add(chunk_size & 1)?;
    }
    None
}

fn detect_avatar_with_size(bytes: &[u8]) -> Result<(AvatarFormat, (u32, u32)), String> {
    let (format, dimensions) = if let Some(dimensions) = png_dimensions(bytes) {
        (AvatarFormat::Png, dimensions)
    } else if let Some(dimensions) = jpeg_dimensions(bytes) {
        (AvatarFormat::Jpeg, dimensions)
    } else if let Some(dimensions) = webp_dimensions(bytes) {
        (AvatarFormat::WebP, dimensions)
    } else {
        return Err("请选择真实的 JPG、PNG 或 WebP 图片".into());
    };
    Ok((format, checked_dimensions(dimensions.0, dimensions.1)?))
}

#[cfg(all(test, unix))]
fn detect_avatar(bytes: &[u8]) -> Result<AvatarFormat, String> {
    detect_avatar_with_size(bytes).map(|(format, _)| format)
}

fn read_avatar_file(path: &Path) -> Result<AvatarFile, String> {
    read_avatar_file_limited(path, MAX_AVATAR_BYTES)
}

/// Reads a regular image file without following symlinks, bounded by `max_bytes`.
fn read_avatar_file_limited(path: &Path, max_bytes: u64) -> Result<AvatarFile, String> {
    let too_large = || format!("头像文件不能超过 {} MiB", max_bytes / (1024 * 1024));
    let path_metadata =
        fs::symlink_metadata(path).map_err(|_| "无法读取所选头像文件".to_string())?;
    if path_metadata.file_type().is_symlink() || !path_metadata.file_type().is_file() {
        return Err("请选择普通图片文件，不能使用文件夹或符号链接".into());
    }
    if path_metadata.len() > max_bytes {
        return Err(too_large());
    }

    let file = OpenOptions::new()
        .read(true)
        .custom_flags(crate::platform_fs::NOFOLLOW_FLAG)
        .open(path)
        .map_err(|_| "无法安全读取所选头像文件".to_string())?;
    let opened_metadata = file
        .metadata()
        .map_err(|_| "无法检查所选头像文件".to_string())?;
    if !opened_metadata.file_type().is_file() || opened_metadata.len() > max_bytes {
        return Err(too_large());
    }

    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取所选头像文件".to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err(too_large());
    }
    let (format, (width, height)) = detect_avatar_with_size(&bytes)?;
    Ok(AvatarFile {
        bytes,
        format,
        width,
        height,
    })
}

fn avatar_source(file: AvatarFile) -> AvatarSource {
    AvatarSource {
        mime_type: file.format.mime().into(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(&file.bytes),
        width: file.width,
        height: file.height,
    }
}

/// The original for a Skill avatar crop: ≤ 10 MiB, 64–8192 px, a real JPG / PNG / WebP.
fn read_avatar_source(path: &Path) -> Result<AvatarSource, String> {
    read_avatar_file_limited(path, MAX_AVATAR_SOURCE_BYTES).map(avatar_source)
}

fn trusted_avatar_url(value: &str, base: &Url, hosts: &[String]) -> Result<String, String> {
    let reference = crate::media::image_reference(value, base, hosts)
        .ok_or("媒体服务返回了不可信的头像地址")?;
    if reference.starts_with("h/") && reference.split('/').count() < 5 {
        return Err("媒体服务返回了无效头像地址".into());
    }
    Ok(value.to_string())
}

fn parse_upload_response(
    status: StatusCode,
    content_type: Option<&str>,
    bytes: &[u8],
    base: &Url,
    hosts: &[String],
) -> Result<AvatarUploadResult, String> {
    if !status.is_success() {
        return Err(format!("头像上传失败 ({status})"));
    }
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("媒体服务响应过大".into());
    }
    if !content_type
        .unwrap_or_default()
        .to_ascii_lowercase()
        .starts_with("application/json")
    {
        return Err("媒体服务响应格式无效".into());
    }
    let payload: AvatarUploadResult =
        serde_json::from_slice(bytes).map_err(|_| "媒体服务响应格式无效".to_string())?;
    Ok(AvatarUploadResult {
        url: trusted_avatar_url(&payload.url, base, hosts)?,
    })
}

async fn upload_avatar(
    file: AvatarFile,
    session: &crate::runtime_env::AuthorizedRuntimeSession,
    state: &crate::server_request::SpaceRegistry,
) -> Result<AvatarUploadResult, String> {
    crate::spaces::verify_remote_identity(&session.session).await?;
    let (origin, client) = state.connection(Some(&session.session))?;
    let endpoint = format!(
        "{}/api/media/avatars",
        origin.as_str().trim_end_matches('/')
    );
    let mut response = client
        .post(endpoint)
        .timeout(Duration::from_secs(90))
        .bearer_auth(&session.token)
        .json(&serde_json::json!({ "mimeType": file.format.mime(), "dataBase64": base64::engine::general_purpose::STANDARD.encode(&file.bytes) }))
        .send()
        .await
        .map_err(|_| "无法连接 SkillHub，请检查网络后重试".to_string())?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    if response
        .content_length()
        .is_some_and(|length| length > u64::try_from(MAX_RESPONSE_BYTES).unwrap_or(u64::MAX))
    {
        return Err("媒体服务响应过大".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "无法读取媒体服务响应".to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("媒体服务响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let needs_hosts = serde_json::from_slice::<AvatarUploadResult>(&bytes)
        .is_ok_and(|payload| crate::media::image_reference(&payload.url, &origin, &[]).is_none());
    let hosts = if status.is_success() && needs_hosts {
        state.image_hosts().await?
    } else {
        Vec::new()
    };
    parse_upload_response(status, content_type.as_deref(), &bytes, &origin, &hosts)
}

#[tauri::command]
pub(crate) async fn pick_and_upload_avatar(
    app: AppHandle,
    state: tauri::State<'_, crate::server_request::SpaceRegistry>,
    account_user_id: String,
    space: crate::server_request::SpaceHandle,
) -> Result<Option<AvatarUploadResult>, String> {
    crate::spaces::require_current_handle(&space)?;
    let Some(path) = pick_avatar_path(&app).await? else {
        return Ok(None);
    };
    let file = read_avatar_file(&path)?;
    let session = tokio::task::spawn_blocking(move || {
        let session = crate::runtime_env::authorized_runtime_session(&account_user_id)?;
        crate::spaces::require_handle(&session.session, &space)?;
        Ok::<_, String>(session)
    })
    .await
    .map_err(|_| "无法读取 SkillHub 运行时会话")??;
    let space = state.media_space().await?;
    let uploaded = upload_avatar(file, &session, &state).await?;
    if state.media_space().await? != space {
        return Err("登录账号已经切换".into());
    }
    Ok(Some(uploaded))
}

async fn pick_avatar_path(app: &AppHandle) -> Result<Option<std::path::PathBuf>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择头像")
        .set_can_create_directories(false)
        .add_filter("头像图片", &["jpg", "jpeg", "png", "webp"])
        .pick_file(move |selected| {
            let _ = sender.send(selected);
        });
    let selected = receiver
        .await
        .map_err(|_| "头像文件选择器意外关闭".to_string())?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    selected
        .into_path()
        .map(Some)
        .map_err(|_| "无法读取所选头像路径".to_string())
}

/// Picks a local image for the Skill avatar crop dialog (#214). The bytes go to the
/// WebView only; cropping and the upload to the Skill avatar route happen there.
#[tauri::command]
pub async fn pick_avatar_source(app: AppHandle) -> Result<Option<AvatarSource>, String> {
    let Some(path) = pick_avatar_path(&app).await? else {
        return Ok(None);
    };
    read_avatar_source(&path).map(Some)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::symlink;
    use uuid::Uuid;

    fn test_root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("skillhub-avatar-test-{}", Uuid::new_v4()))
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::from(&b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"[..]);
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes
    }

    fn jpeg(width: u16, height: u16) -> Vec<u8> {
        vec![
            0xff,
            0xd8,
            0xff,
            0xc0,
            0x00,
            0x11,
            0x08,
            (height >> 8) as u8,
            height as u8,
            (width >> 8) as u8,
            width as u8,
            0x03,
            0x01,
            0x11,
            0x00,
            0x02,
            0x11,
            0x00,
            0x03,
            0x11,
            0x00,
        ]
    }

    fn webp_vp8x(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::from(&b"RIFF\0\0\0\0WEBPVP8X\n\0\0\0\0\0\0\0"[..]);
        let width_minus_one = width - 1;
        let height_minus_one = height - 1;
        bytes.extend_from_slice(&[
            width_minus_one as u8,
            (width_minus_one >> 8) as u8,
            (width_minus_one >> 16) as u8,
            height_minus_one as u8,
            (height_minus_one >> 8) as u8,
            (height_minus_one >> 16) as u8,
        ]);
        let riff_size = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
        bytes
    }

    #[test]
    fn detects_supported_formats_and_dimensions() {
        assert_eq!(detect_avatar(&png(256, 256)), Ok(AvatarFormat::Png));
        assert_eq!(detect_avatar(&jpeg(320, 240)), Ok(AvatarFormat::Jpeg));
        assert_eq!(detect_avatar(&webp_vp8x(512, 300)), Ok(AvatarFormat::WebP));
        assert_eq!(
            detect_avatar(include_bytes!("../icons/128x128.png")),
            Ok(AvatarFormat::Png)
        );
    }

    #[test]
    fn rejects_fake_and_out_of_range_images() {
        assert!(detect_avatar(b"not an image").is_err());
        assert!(detect_avatar(&png(32, 256)).is_err());
        assert!(detect_avatar(&png(9000, 256)).is_err());
    }

    #[test]
    fn rejects_symlinks_and_oversized_files() {
        let root = test_root();
        fs::create_dir_all(&root).expect("create test root");
        let image = root.join("avatar.png");
        fs::write(&image, png(256, 256)).expect("write image");
        let link = root.join("avatar-link.png");
        symlink(&image, &link).expect("create symlink");
        assert!(read_avatar_file(&link).is_err());

        let oversized = root.join("oversized.png");
        let mut file = fs::File::create(&oversized).expect("create oversized image");
        file.write_all(b"x").expect("seed oversized image");
        file.set_len(MAX_AVATAR_BYTES + 1)
            .expect("size oversized image");
        assert!(read_avatar_file(&oversized).is_err());
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn avatar_source_returns_bytes_type_and_size_for_the_crop_dialog() {
        let root = test_root();
        fs::create_dir_all(&root).expect("create test root");
        let image = root.join("source.png");
        let bytes = png(1200, 800);
        fs::write(&image, &bytes).expect("write image");
        assert_eq!(
            read_avatar_source(&image),
            Ok(AvatarSource {
                mime_type: "image/png".into(),
                data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                width: 1200,
                height: 800,
            })
        );
        let json =
            serde_json::to_value(read_avatar_source(&image).expect("source")).expect("serialize");
        assert_eq!(json["mimeType"], "image/png");
        assert_eq!(json["width"], 1200);

        // The same symlink, folder and type checks as the account avatar upload.
        let link = root.join("source-link.png");
        symlink(&image, &link).expect("create symlink");
        assert!(read_avatar_source(&link).is_err());
        assert!(read_avatar_source(&root).is_err());
        let fake = root.join("fake.png");
        fs::write(&fake, b"not an image").expect("write fake");
        assert!(read_avatar_source(&fake).is_err());
        let tiny = root.join("tiny.png");
        fs::write(&tiny, png(32, 32)).expect("write tiny");
        assert!(read_avatar_source(&tiny).is_err());
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn avatar_source_allows_up_to_10_mib_while_account_avatars_stay_at_5_mib() {
        let root = test_root();
        fs::create_dir_all(&root).expect("create test root");
        let large = root.join("large.png");
        let mut bytes = png(4000, 3000);
        bytes.resize(7 * 1024 * 1024, 0);
        fs::write(&large, &bytes).expect("write large image");
        assert!(read_avatar_file(&large).is_err());
        assert_eq!(
            read_avatar_source(&large).map(|source| (source.width, source.height)),
            Ok((4000, 3000))
        );

        let oversized = root.join("oversized.png");
        let mut file = fs::File::create(&oversized).expect("create oversized image");
        file.write_all(&png(4000, 3000))
            .expect("seed oversized image");
        file.set_len(MAX_AVATAR_SOURCE_BYTES + 1)
            .expect("size oversized image");
        assert_eq!(
            read_avatar_source(&oversized),
            Err("头像文件不能超过 10 MiB".into())
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn accepts_only_instance_or_allowed_image_urls() {
        let base = Url::parse("http://127.0.0.1:3001/skillhub").unwrap();
        let hosts = vec!["picem-media.whatonearth.work".into()];
        let local = format!("{}/media/aa/{}.png", base, "a".repeat(64));
        assert_eq!(trusted_avatar_url(&local, &base, &hosts), Ok(local.clone()));
        let valid =
            "https://picem-media.whatonearth.work/public/app_skillhub/ast_image/original.png";
        assert_eq!(trusted_avatar_url(valid, &base, &hosts), Ok(valid.into()));
        for invalid in [
            "http://picem-media.whatonearth.work/public/app/ast/a.jpg",
            "https://evil.example/public/app/ast/a.jpg",
            "https://pictshare.whatonearth.work/a.jpg",
            "https://picem-media.whatonearth.work/a.jpg",
            "https://picem-media.whatonearth.work/public/app/ast/a.jpg?token=1",
        ] {
            assert!(
                trusted_avatar_url(invalid, &base, &hosts).is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[test]
    fn parses_public_link_and_drops_upstream_credentials() {
        let base = Url::parse("https://instance.example").unwrap();
        let hosts = vec!["picem-media.whatonearth.work".into()];
        let body = br#"{"url":"https://picem-media.whatonearth.work/public/app/ast/original.png","assetId":"ast_image","api_key":"private"}"#;
        let result = parse_upload_response(
            StatusCode::CREATED,
            Some("application/json"),
            body,
            &base,
            &hosts,
        )
        .expect("parse response");
        assert_eq!(
            serde_json::to_value(result).expect("serialize"),
            serde_json::json!({"url":"https://picem-media.whatonearth.work/public/app/ast/original.png"})
        );
        assert!(parse_upload_response(
            StatusCode::UNAUTHORIZED,
            Some("application/json"),
            body,
            &base,
            &hosts
        )
        .is_err());
        assert!(
            parse_upload_response(StatusCode::OK, Some("text/html"), body, &base, &hosts).is_err()
        );
        assert!(parse_upload_response(
            StatusCode::OK,
            Some("application/json"),
            br#"{"error":"secret"}"#,
            &base,
            &hosts
        )
        .is_err());
    }
}
