use crate::app_links::APP_OPEN_LINK;
use crate::cli::{
    CliAccount, CliAccountState, CliCommandOutput, CliErrorCode, EXIT_INTERNAL, EXIT_NETWORK,
    EXIT_USAGE,
};
use crate::cli_auth::CliAuthGuard;
use crate::runtime_env::trusted_server_origin;
use regex::Regex;
use reqwest::{Response, StatusCode, Url};
use serde::Deserialize;
use serde_json::json;
use std::sync::OnceLock;
use std::time::Duration;

const APP_OPEN_COMMAND: &str = "app open";
const UPDATE_CHECK_COMMAND: &str = "update check";
pub(crate) const APP_USAGE: &str = "用法：\n  skillhub app open [--json]";
pub(crate) const UPDATE_USAGE: &str = "用法：\n  skillhub update check [--json]";
const MAX_UPDATE_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct UpdatePayload {
    version: String,
    notes: String,
    pub_date: String,
    url: String,
    signature: String,
}

enum UpdateReadError {
    Offline,
    TooLarge,
}

fn current_account() -> CliAccount {
    match CliAuthGuard::capture() {
        Ok(guard) if guard.token_for_request().is_ok() => {
            CliAccount::local(CliAccountState::Unverified, guard.user_id())
        }
        Ok(_) => CliAccount::state(CliAccountState::Guest),
        Err(_) => CliAccount::state(CliAccountState::Unknown),
    }
}

fn exact_json_command(args: &[String], family: &str, action: &str) -> bool {
    (args.len() == 2 || (args.len() == 3 && args[2] == "--json"))
        && args[0] == family
        && args[1] == action
}

fn platform_release_target() -> Result<(&'static str, &'static str), String> {
    let target = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        return Err("当前平台尚不支持 SkillHub APP 内更新".into());
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else {
        return Err("当前 CPU 架构尚不支持 SkillHub APP 内更新".into());
    };
    Ok((target, arch))
}

fn update_url() -> Result<Url, String> {
    let (target, arch) = platform_release_target()?;
    let mut url = trusted_server_origin()?;
    let base = url.path().trim_end_matches('/');
    url.set_path(&format!(
        "{base}/api/app-updates/{target}/{arch}/{}",
        env!("CARGO_PKG_VERSION")
    ));
    Ok(url)
}

fn is_release_version(value: &str) -> bool {
    static VERSION_PATTERN: OnceLock<Regex> = OnceLock::new();
    VERSION_PATTERN
        .get_or_init(|| {
            Regex::new(
                r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$",
            )
            .expect("static release version pattern")
        })
        .is_match(value)
}

fn is_release_date(value: &str) -> bool {
    static DATE_PATTERN: OnceLock<Regex> = OnceLock::new();
    DATE_PATTERN
        .get_or_init(|| {
            Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$")
                .expect("static RFC 3339 date pattern")
        })
        .is_match(value)
}

fn valid_update_notes(value: &str) -> bool {
    value.len() <= 20_000
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

fn validate_update_payload(payload: UpdatePayload) -> Result<UpdatePayload, String> {
    if payload.version.len() > 80
        || !is_release_version(&payload.version)
        || !valid_update_notes(&payload.notes)
        || payload.pub_date.len() > 80
        || !is_release_date(&payload.pub_date)
        || payload.signature.trim().is_empty()
        || payload.signature.len() > 4_096
    {
        return Err("SkillHub Server 返回了无效的更新资料".into());
    }
    let url = Url::parse(&payload.url).map_err(|_| "SkillHub Server 返回了无效的更新地址")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || payload.url.len() > 2_048
    {
        return Err("SkillHub Server 返回了不安全的更新地址".into());
    }
    Ok(payload)
}

fn update_body_exceeds_limit(current_length: usize, next_length: usize) -> bool {
    current_length
        .checked_add(next_length)
        .is_none_or(|length| length > MAX_UPDATE_RESPONSE_BYTES)
}

async fn read_update_response(mut response: Response) -> Result<Vec<u8>, UpdateReadError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_UPDATE_RESPONSE_BYTES as u64)
    {
        return Err(UpdateReadError::TooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| UpdateReadError::Offline)?
    {
        if update_body_exceeds_limit(body.len(), chunk.len()) {
            return Err(UpdateReadError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn available_update_data(payload: &UpdatePayload) -> serde_json::Value {
    json!({
        "available": true,
        "currentVersion": env!("CARGO_PKG_VERSION"),
        "latestVersion": payload.version,
        "notes": payload.notes,
        "publishedAt": payload.pub_date,
    })
}

async fn check_update() -> CliCommandOutput {
    let url = match update_url() {
        Ok(url) => url,
        Err(message) => {
            return CliCommandOutput::failure(
                UPDATE_CHECK_COMMAND,
                current_account(),
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let client = match crate::net::client_builder(&url).and_then(|builder| {
        builder
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            .user_agent(concat!(
                "Yitan-SkillHub/",
                env!("CARGO_PKG_VERSION"),
                " cli-update"
            ))
            .build()
            .map_err(|_| "无法初始化 SkillHub 更新检查".to_string())
    }) {
        Ok(client) => client,
        Err(_) => {
            return CliCommandOutput::failure(
                UPDATE_CHECK_COMMAND,
                current_account(),
                CliErrorCode::InternalError,
                "无法初始化 SkillHub 更新检查",
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let response = match client.get(url).send().await {
        Ok(response) => response,
        Err(_) => {
            return CliCommandOutput::failure(
                UPDATE_CHECK_COMMAND,
                current_account(),
                CliErrorCode::Offline,
                "暂时无法连接 SkillHub Server",
                EXIT_NETWORK,
                vec!["请检查网络后重试".into()],
            )
        }
    };
    if response.status() == StatusCode::NO_CONTENT {
        return CliCommandOutput::success(
            UPDATE_CHECK_COMMAND,
            current_account(),
            json!({
                "available": false,
                "currentVersion": env!("CARGO_PKG_VERSION"),
            }),
            Vec::new(),
            Vec::new(),
        );
    }
    if !response.status().is_success() {
        return CliCommandOutput::failure(
            UPDATE_CHECK_COMMAND,
            current_account(),
            CliErrorCode::InternalError,
            "SkillHub Server 暂时无法完成更新检查",
            EXIT_INTERNAL,
            vec!["请稍后重试".into()],
        );
    }
    let bytes = match read_update_response(response).await {
        Ok(bytes) => bytes,
        Err(UpdateReadError::Offline) => {
            return CliCommandOutput::failure(
                UPDATE_CHECK_COMMAND,
                current_account(),
                CliErrorCode::Offline,
                "读取 SkillHub Server 更新资料失败",
                EXIT_NETWORK,
                vec!["请检查网络后重试".into()],
            )
        }
        Err(UpdateReadError::TooLarge) => {
            return CliCommandOutput::failure(
                UPDATE_CHECK_COMMAND,
                current_account(),
                CliErrorCode::InternalError,
                "SkillHub Server 返回了过大的更新资料",
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let payload = match serde_json::from_slice::<UpdatePayload>(&bytes)
        .map_err(|_| "SkillHub Server 返回了无效的更新资料".to_string())
        .and_then(validate_update_payload)
    {
        Ok(payload) => payload,
        Err(message) => {
            return CliCommandOutput::failure(
                UPDATE_CHECK_COMMAND,
                current_account(),
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    CliCommandOutput::success(
        UPDATE_CHECK_COMMAND,
        current_account(),
        available_update_data(&payload),
        Vec::new(),
        vec!["使用 skillhub app open --json 打开 APP，并在 APP 内确认更新".into()],
    )
}

fn open_app() -> CliCommandOutput {
    match open::that(APP_OPEN_LINK) {
        Ok(()) => CliCommandOutput::success(
            APP_OPEN_COMMAND,
            current_account(),
            json!({ "requested": true }),
            Vec::new(),
            Vec::new(),
        ),
        Err(_) => CliCommandOutput::failure(
            APP_OPEN_COMMAND,
            current_account(),
            CliErrorCode::InternalError,
            "无法打开已安装的一探 SkillHub APP",
            EXIT_INTERNAL,
            vec!["请手动打开一探 SkillHub APP".into()],
        ),
    }
}

pub(crate) async fn execute_app_cli(args: &[String]) -> Option<CliCommandOutput> {
    if args.first().map(String::as_str) == Some("app") {
        return Some(if exact_json_command(args, "app", "open") {
            open_app()
        } else {
            CliCommandOutput::failure(
                APP_OPEN_COMMAND,
                current_account(),
                CliErrorCode::ValidationFailed,
                APP_USAGE,
                EXIT_USAGE,
                Vec::new(),
            )
        });
    }
    if args.first().map(String::as_str) == Some("update") {
        return Some(if exact_json_command(args, "update", "check") {
            check_update().await
        } else {
            CliCommandOutput::failure(
                UPDATE_CHECK_COMMAND,
                current_account(),
                CliErrorCode::ValidationFailed,
                UPDATE_USAGE,
                EXIT_USAGE,
                Vec::new(),
            )
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        available_update_data, exact_json_command, platform_release_target,
        update_body_exceeds_limit, update_url, validate_update_payload, MAX_UPDATE_RESPONSE_BYTES,
    };
    use serde_json::from_value;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn app_and_update_commands_accept_optional_json() {
        assert!(exact_json_command(
            &strings(&["app", "open", "--json"]),
            "app",
            "open"
        ));
        assert!(exact_json_command(
            &strings(&["update", "check", "--json"]),
            "update",
            "check"
        ));
        assert!(exact_json_command(
            &strings(&["update", "check"]),
            "update",
            "check"
        ));
        assert!(exact_json_command(
            &strings(&["app", "open"]),
            "app",
            "open"
        ));
        assert!(!exact_json_command(
            &strings(&["app", "open", "--json", "extra"]),
            "app",
            "open"
        ));
    }

    #[test]
    fn update_payload_rejects_non_https_url() {
        let payload = from_value(serde_json::json!({
            "version": "9.9.9",
            "notes": "test",
            "pub_date": "2026-09-09T00:00:00Z",
            "url": "http://example.com/update.tar.gz",
            "signature": "signed"
        }))
        .expect("payload");
        assert!(validate_update_payload(payload).is_err());
    }

    #[test]
    fn update_payload_enforces_server_contract_and_safe_url() {
        for (version, pub_date, url) in [
            (
                "v1.2.3",
                "2026-09-09T00:00:00Z",
                "https://example.com/update.tar.gz",
            ),
            (
                "01.2.3",
                "2026-09-09T00:00:00Z",
                "https://example.com/update.tar.gz",
            ),
            ("1.2.3", "not-a-date", "https://example.com/update.tar.gz"),
            (
                "1.2.3",
                "2026-09-09T00:00:00Z",
                "https://user@example.com/update.tar.gz",
            ),
            (
                "1.2.3",
                "2026-09-09T00:00:00Z",
                "https://example.com/update.tar.gz#fragment",
            ),
        ] {
            let payload = from_value(serde_json::json!({
                "version": version,
                "notes": "test",
                "pub_date": pub_date,
                "url": url,
                "signature": "signed"
            }))
            .expect("payload");
            assert!(validate_update_payload(payload).is_err());
        }

        let payload = from_value(serde_json::json!({
            "version": "1.2.3-beta.1+build.4",
            "notes": "test",
            "pub_date": "2026-09-09T00:00:00+08:00",
            "url": "https://downloads.example.com/update.tar.gz?token=temporary",
            "signature": "private-signature"
        }))
        .expect("payload");
        let payload = validate_update_payload(payload).expect("valid update payload");
        let output = serde_json::to_string(&available_update_data(&payload)).expect("output");
        assert!(!output.contains("private-signature"));
        assert!(!output.contains("downloads.example.com"));
    }

    #[test]
    fn update_body_limit_is_overflow_safe_and_inclusive() {
        assert!(!update_body_exceeds_limit(0, MAX_UPDATE_RESPONSE_BYTES));
        assert!(!update_body_exceeds_limit(MAX_UPDATE_RESPONSE_BYTES - 1, 1));
        assert!(update_body_exceeds_limit(MAX_UPDATE_RESPONSE_BYTES, 1));
        assert!(update_body_exceeds_limit(usize::MAX, 1));
    }

    #[test]
    fn supported_platform_builds_the_production_update_url() {
        if platform_release_target().is_ok() {
            let url = update_url().expect("update URL");
            assert_eq!(url.scheme(), "https");
            assert!(url.path().contains("/api/app-updates/"));
            assert!(url.path().ends_with(env!("CARGO_PKG_VERSION")));
        }
    }
}
