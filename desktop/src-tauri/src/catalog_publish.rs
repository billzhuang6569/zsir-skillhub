use crate::library_sync::{
    api::{HttpLibraryApi, LibraryApi},
    profile::SyncProfile,
};
use crate::server_request::{SpaceHandle, SpaceRegistry};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path, sync::LazyLock};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PublishInput {
    space: SpaceHandle,
    source_skill_id: String,
    client_operation_id: String,
    profile: SyncProfile,
    note: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    catalog_origin: String,
    source_origin: String,
    source_skill_id: String,
    user_id: String,
    official_skill_id: String,
    submission_id: String,
}
struct Pending {
    operation: String,
    source: crate::runtime_env::RuntimeSession,
    user: String,
    body: Value,
}
// Keep the exact request for ambiguous network retries, including its original ZIP.
static PENDING: LazyLock<tokio::sync::Mutex<Option<Pending>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(None));

fn source_error(error: crate::library_sync::api::ApiError) -> String {
    match error {
        crate::library_sync::api::ApiError::Unauthorized => "实例登录已失效，请重新登录",
        _ => "无法读取实例当前版本，请检查连接与版本包后重试",
    }
    .into()
}

fn reject_package_token(bytes: &[u8], token: &str) -> Result<(), String> {
    let contains = |bytes: &[u8]| {
        !token.is_empty()
            && bytes
                .windows(token.len())
                .any(|part| part == token.as_bytes())
    };
    if contains(bytes) {
        return Err("实例响应包含会话凭据，已拒绝发布".into());
    }
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| "Skill 包无效")?;
    if archive.len() > crate::commands::MAX_SKILL_FILE_COUNT {
        return Err("Skill 包文件过多".into());
    }
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|_| "Skill 包无效")?;
        if contains(file.name().as_bytes()) {
            return Err("实例响应包含会话凭据，已拒绝发布".into());
        }
        let limit = crate::commands::MAX_SKILL_FILE_BYTES
            .min(crate::commands::MAX_SKILL_TOTAL_BYTES.saturating_sub(total));
        let mut content = zeroize::Zeroizing::new(Vec::new());
        file.take(limit + 1)
            .read_to_end(&mut content)
            .map_err(|_| "Skill 包无效")?;
        if content.len() as u64 > limit {
            return Err("Skill 包解压内容过大".into());
        }
        total += content.len() as u64;
        if contains(&content) {
            return Err("实例响应包含会话凭据，已拒绝发布".into());
        }
    }
    Ok(())
}

fn receipt_path(
    root: &Path,
    origin: &str,
    id: &str,
    user: &str,
) -> Result<std::path::PathBuf, String> {
    let key = serde_json::to_vec(&(crate::catalog::origin()?, origin, id, user))
        .map_err(|_| "投稿记录无效")?;
    Ok(root
        .join("runtime/catalog-submissions")
        .join(format!("{:x}.json", Sha256::digest(key))))
}
fn receipt(root: &Path, origin: &str, id: &str, user: &str) -> Result<Option<Receipt>, String> {
    let path = receipt_path(root, origin, id, user)?;
    if !path.try_exists().map_err(|_| "无法读取投稿记录")? {
        return Ok(None);
    }
    let r: Receipt = crate::runtime_env::read_private_json(&path)?;
    if r.catalog_origin != crate::catalog::origin()?
        || r.source_origin != origin
        || r.source_skill_id != id
        || r.user_id != user
    {
        return Err("投稿记录来源不一致".into());
    }
    uuid::Uuid::parse_str(&r.submission_id).map_err(|_| "投稿记录无效")?;
    Ok(Some(r))
}
fn source_origin(session: &crate::runtime_env::RuntimeSession) -> Result<String, String> {
    if session.deployment().profile() != "selfhost" {
        return Err("请在自部署空间发布 Skill".into());
    }
    Ok(crate::spaces::canonical_base(
        &session.deployment().base()?.ok_or("实例地址无效")?,
    ))
}
fn body(
    input: &PublishInput,
    origin: &str,
    name: &str,
    version: &str,
    bytes: &[u8],
) -> Result<Value, String> {
    uuid::Uuid::parse_str(&input.client_operation_id).map_err(|_| "发布操作标识无效")?;
    let origin = crate::spaces::canonical_base(&crate::spaces::normalize_base(origin)?);
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Skill 包过大".into());
    }
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| "Skill 包无效")?;
    let mut skill_md = String::new();
    archive
        .by_name("SKILL.md")
        .map_err(|_| "Skill 包缺少 SKILL.md")?
        .take(100_001)
        .read_to_string(&mut skill_md)
        .map_err(|_| "SKILL.md 无效")?;
    if skill_md.len() > 100_000 || skill_md.trim().is_empty() {
        return Err("SKILL.md 为空或过大".into());
    }
    let p = &input.profile;
    let mut profile = json!({"displayName":p.display_name,"description":p.description.as_deref().unwrap_or(""),"category":p.category.as_deref().unwrap_or(""),"labels":p.labels,"triggerScenarios":p.trigger_scenarios});
    if let Some(url) = &p.source_url {
        profile["sourceUrl"] = json!(url);
    }
    let mut value = json!({"clientOperationId":input.client_operation_id,"sourceOrigin":origin,"sourceSkillId":input.source_skill_id,"name":name,"version":version,"skillMd":skill_md,"packageBase64":STANDARD.encode(bytes),"packageSha256":format!("{:x}",Sha256::digest(bytes)),"profile":profile,"compatibleAgents":p.compatible_agents,"envDependencies":p.env_dependencies});
    if let Some(note) = &input.note {
        value["note"] = json!(note);
    }
    Ok(value)
}
#[tauri::command]
pub(crate) async fn catalog_publish(
    registry: tauri::State<'_, SpaceRegistry>,
    input: PublishInput,
) -> Result<Value, String> {
    let mut pending = PENDING.try_lock().map_err(|_| "正在提交，请稍候")?;
    let session = registry.snapshot(false).await?.ok_or("请先登录实例")?;
    if SpaceRegistry::handle(Some(&session)) != input.space {
        return Err(crate::spaces::STALE.into());
    }
    let origin = source_origin(&session)?;
    let user = crate::catalog_session::user_id(registry.migration_root())?;
    if pending.as_ref().is_some_and(|p| {
        p.operation == input.client_operation_id && p.body["sourceSkillId"] != input.source_skill_id
    }) {
        return Err("本次发布操作属于另一个 Skill".into());
    }
    if !pending.as_ref().is_some_and(|p| {
        p.operation == input.client_operation_id && p.source == session && p.user == user
    }) {
        let prepared_input = input.clone();
        let prepared_session = session.clone();
        let prepared_origin = origin.clone();
        let runtime = tokio::runtime::Handle::current();
        let prepared = tokio::task::spawn_blocking(move || {
            runtime.block_on(async {
                let input = prepared_input;
                let session = prepared_session;
                let origin = prepared_origin;
                let api = HttpLibraryApi::new(&session)?;
                let (version, _) = api
                    .author_share_state(&input.source_skill_id, session.user_id())
                    .await
                    .map_err(source_error)?;
                let own = api
                    .own_skills()
                    .await
                    .map_err(source_error)?
                    .into_iter()
                    .find(|s| s.id == input.source_skill_id)
                    .ok_or("当前账号没有这个 Skill 的作者权限")?;
                let formal = api
                    .formal_version_by_label(&own.id, &version)
                    .await
                    .map_err(source_error)?;
                let hash = formal
                    .package_sha256
                    .ok_or("当前版本缺少内容包，请先保存正式版本")?;
                let bytes = api.download_card(&hash).await.map_err(source_error)?;
                let token = session.auth_token().ok_or("请先登录实例")?;
                reject_package_token(&bytes, token)?;
                if format!("{:x}", Sha256::digest(&bytes)) != hash {
                    return Err("当前版本包校验失败".into());
                }
                body(&input, &origin, &own.name, &version, &bytes)
            })
        })
        .await
        .map_err(|_| "无法读取当前版本包")?;
        let prepared = match prepared {
            Ok(value) => {
                crate::catalog_session::reject(
                    &value,
                    &[session.auth_token().ok_or("请先登录实例")?],
                )?;
                value
            }
            Err(error) => {
                crate::catalog_session::reject(
                    &json!(error),
                    &[session.auth_token().ok_or("请先登录实例")?],
                )?;
                return Err(error);
            }
        };
        *pending = Some(Pending {
            operation: input.client_operation_id.clone(),
            source: session.clone(),
            user: user.clone(),
            body: prepared,
        });
    }
    if registry.snapshot(false).await?.as_ref() != Some(&session) {
        return Err(crate::spaces::STALE.into());
    }
    let response = crate::catalog_session::request(
        registry.migration_root(),
        reqwest::Method::POST,
        "/api/marketplace/catalog-submissions",
        Some(&pending.as_ref().ok_or("投稿准备失败")?.body),
        &user,
    )
    .await?;
    let submission_id = response["id"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or("投稿响应无效，请重试")?;
    let official_skill_id = response["skillId"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or("投稿响应无效，请重试")?;
    let r = Receipt {
        catalog_origin: crate::catalog::origin()?,
        source_origin: origin.clone(),
        source_skill_id: input.source_skill_id.clone(),
        user_id: user.clone(),
        official_skill_id: official_skill_id.into(),
        submission_id: submission_id.into(),
    };
    crate::runtime_env::write_private_json(
        &receipt_path(
            registry.migration_root(),
            &origin,
            &input.source_skill_id,
            &user,
        )?,
        &r,
    )?;
    *pending = None;
    if registry.snapshot(false).await?.as_ref() != Some(&session) {
        return Err(crate::spaces::STALE.into());
    }
    Ok(response)
}
#[tauri::command]
pub(crate) async fn catalog_submission_status(
    registry: tauri::State<'_, SpaceRegistry>,
    space: SpaceHandle,
    source_skill_id: String,
) -> Result<Value, String> {
    let session = registry.snapshot(false).await?.ok_or("请先登录实例")?;
    if SpaceRegistry::handle(Some(&session)) != space {
        return Err(crate::spaces::STALE.into());
    }
    let origin = source_origin(&session)?;
    let user = crate::catalog_session::user_id(registry.migration_root())?;
    let Some(r) = receipt(registry.migration_root(), &origin, &source_skill_id, &user)? else {
        return Ok(Value::Null);
    };
    let response = crate::catalog_session::request(
        registry.migration_root(),
        reqwest::Method::GET,
        &format!("/api/marketplace/mine/{}", r.submission_id),
        None,
        &user,
    )
    .await?;
    if registry.snapshot(false).await?.as_ref() != Some(&session) {
        return Err(crate::spaces::STALE.into());
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compressed_files_cannot_forward_instance_credentials() {
        use std::io::Write;
        let token = "private-instance-bearer-for-test";
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file(
            "notes.txt",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        zip.write_all(format!("do not forward {token}\n").repeat(100).as_bytes())
            .unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        assert!(!bytes
            .windows(token.len())
            .any(|part| part == token.as_bytes()));
        let error = reject_package_token(&bytes, token).unwrap_err();
        assert!(!error.contains(token));
        assert!(reject_package_token(&bytes, "another-token").is_ok());
    }
    #[test]
    fn request_uses_original_zip_hash_and_normalized_source() {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file("SKILL.md", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"---\nname: example\n---\nExample").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let input = PublishInput {
            space: SpaceHandle {
                space_id: "selfhost-test".into(),
                generation: 1,
            },
            source_skill_id: uuid::Uuid::new_v4().to_string(),
            client_operation_id: uuid::Uuid::new_v4().to_string(),
            profile: SyncProfile {
                display_name: "Example".into(),
                ..Default::default()
            },
            note: Some("review".into()),
        };
        let value = body(
            &input,
            "https://EXAMPLE.com:443/base/",
            "example",
            "0.1.0",
            &bytes,
        )
        .unwrap();
        assert_eq!(value["sourceOrigin"], "https://example.com/base");
        assert_eq!(value["sourceSkillId"], input.source_skill_id);
        assert_eq!(value["clientOperationId"], input.client_operation_id);
        assert_eq!(value["version"], "0.1.0");
        assert_eq!(
            value["packageSha256"],
            format!("{:x}", Sha256::digest(&bytes))
        );
        assert_eq!(
            STANDARD
                .decode(value["packageBase64"].as_str().unwrap())
                .unwrap(),
            bytes
        );
        assert_eq!(value["profile"]["displayName"], "Example");
        assert_eq!(value["note"], "review");
        assert!(value["compatibleAgents"].is_array());
        assert!(value["envDependencies"].is_array());
        for bad in [
            "https://user:password@example.com",
            "https://example.com?q=1",
            "https://example.com#fragment",
        ] {
            assert!(body(&input, bad, "example", "0.1.0", &bytes).is_err());
        }
    }
    #[test]
    fn receipt_is_private_and_isolated_by_source_and_catalog_user() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let r = Receipt {
            catalog_origin: crate::catalog::origin().unwrap(),
            source_origin: "https://instance.invalid".into(),
            source_skill_id: "source".into(),
            user_id: "user-a".into(),
            official_skill_id: uuid::Uuid::new_v4().to_string(),
            submission_id: uuid::Uuid::new_v4().to_string(),
        };
        let path = receipt_path(&root, &r.source_origin, &r.source_skill_id, &r.user_id).unwrap();
        crate::runtime_env::write_private_json(&path, &r).unwrap();
        assert_eq!(
            receipt(&root, &r.source_origin, &r.source_skill_id, &r.user_id)
                .unwrap()
                .unwrap()
                .submission_id,
            r.submission_id
        );
        assert!(
            receipt(&root, &r.source_origin, &r.source_skill_id, "user-b")
                .unwrap()
                .is_none()
        );
        assert!(receipt(
            &root,
            "https://another.invalid",
            &r.source_skill_id,
            &r.user_id
        )
        .unwrap()
        .is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
