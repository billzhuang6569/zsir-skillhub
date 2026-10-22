use crate::cli::{
    CliAccount, CliAccountState, CliCommandOutput, CliErrorCode, EXIT_AUTH, EXIT_CONFLICT,
    EXIT_INTERNAL, EXIT_NETWORK, EXIT_USAGE,
};
use crate::cli_auth::{
    account_verification_failure, auth_guard_failure, verify_account_with_server, CliAuthGuard,
    CliAuthGuardError,
};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest as _, Sha256};
use std::time::Duration;

pub(crate) const FEEDBACK_USAGE: &str = concat!(
    "用法：\n",
    "  skillhub feedback submit preflight --type <bug|usage|feature|other> --content <text> [--contact <text>] [--include-diagnostics] --json\n",
    "  skillhub feedback submit apply --type <bug|usage|feature|other> --content <text> [--contact <text>] [--include-diagnostics] --operation-id <uuid> --plan-digest <64hex> --json\n",
    "  skillhub feedback status --operation-id <uuid> --json"
);

const SUBMIT_PREFLIGHT_COMMAND: &str = "feedback submit preflight";
const SUBMIT_APPLY_COMMAND: &str = "feedback submit apply";
const STATUS_COMMAND: &str = "feedback status";
const PLAN_SCHEMA_VERSION: u8 = 1;
const DIAGNOSTIC_SCHEMA_VERSION: u8 = 1;
const MAX_CONTENT_CHARS: usize = 2_000;
const MAX_CONTACT_CHARS: usize = 200;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const GUEST_SCOPE_HEADER: &str = "x-skillhub-feedback-guest-scope";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum FeedbackType {
    Bug,
    Usage,
    Feature,
    Other,
}

impl FeedbackType {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "bug" => Some(Self::Bug),
            "usage" => Some(Self::Usage),
            "feature" => Some(Self::Feature),
            "other" => Some(Self::Other),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FeedbackFields {
    feedback_type: FeedbackType,
    content: String,
    contact: Option<String>,
    include_diagnostics: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum FeedbackCommand {
    SubmitPreflight(FeedbackFields),
    SubmitApply {
        fields: FeedbackFields,
        operation_id: String,
        plan_digest: String,
    },
    Status {
        operation_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedbackDiagnostics {
    schema_version: u8,
    source: &'static str,
    app_version: &'static str,
    platform: &'static str,
    architecture: &'static str,
}

impl FeedbackDiagnostics {
    fn current() -> Self {
        Self {
            schema_version: DIAGNOSTIC_SCHEMA_VERSION,
            source: "skillhub-cli",
            app_version: env!("CARGO_PKG_VERSION"),
            platform: if cfg!(target_os = "macos") {
                "darwin"
            } else {
                std::env::consts::OS
            },
            architecture: std::env::consts::ARCH,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedbackRequest<'a> {
    client_operation_id: &'a str,
    #[serde(rename = "type")]
    feedback_type: FeedbackType,
    content: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    contact: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostics: Option<&'a FeedbackDiagnostics>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedbackPlan<'a> {
    schema_version: u8,
    operation: &'static str,
    account_scope_id: &'a str,
    authenticated: bool,
    operation_id: &'a str,
    payload_sha256: &'a str,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FeedbackReceipt {
    id: String,
    status: String,
    created_at: String,
}

#[derive(Debug)]
struct HttpResponse {
    status: StatusCode,
    body: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResponseReadError {
    Offline,
    TooLarge,
    EndpointChanged,
}

enum OperationLookup {
    Found(FeedbackReceipt),
    NotFound,
    Unauthorized,
    Forbidden,
    Unavailable,
}

pub(crate) fn is_feedback_command(args: &[String]) -> bool {
    args.first().map(String::as_str) == Some("feedback")
}

pub(crate) async fn execute_feedback_cli(args: &[String]) -> Option<CliCommandOutput> {
    if !is_feedback_command(args) {
        return None;
    }
    let command = match parse_command(args) {
        Ok(command) => command,
        Err(command) => return Some(usage_failure(command)),
    };
    Some(match command {
        FeedbackCommand::SubmitPreflight(fields) => submit_preflight(fields),
        FeedbackCommand::SubmitApply {
            fields,
            operation_id,
            plan_digest,
        } => submit_apply(fields, operation_id, plan_digest).await,
        FeedbackCommand::Status { operation_id } => operation_status(operation_id).await,
    })
}

fn parse_command(args: &[String]) -> Result<FeedbackCommand, &'static str> {
    match args.get(1).map(String::as_str) {
        Some("submit") => parse_submit(args),
        Some("status") => parse_status(args),
        _ => Err(SUBMIT_PREFLIGHT_COMMAND),
    }
}

fn parse_submit(args: &[String]) -> Result<FeedbackCommand, &'static str> {
    let action = args.get(2).map(String::as_str);
    let command = match action {
        Some("preflight") => SUBMIT_PREFLIGHT_COMMAND,
        Some("apply") => SUBMIT_APPLY_COMMAND,
        _ => return Err(SUBMIT_PREFLIGHT_COMMAND),
    };
    let mut feedback_type = None;
    let mut content = None;
    let mut contact = None;
    let mut contact_seen = false;
    let mut include_diagnostics = false;
    let mut operation_id = None;
    let mut plan_digest = None;
    let mut json_requested = false;
    let mut index = 3;
    while index < args.len() {
        match args[index].as_str() {
            "--json" if !json_requested => {
                json_requested = true;
                index += 1;
            }
            "--include-diagnostics" if !include_diagnostics => {
                include_diagnostics = true;
                index += 1;
            }
            "--type" if feedback_type.is_none() => {
                feedback_type =
                    Some(FeedbackType::parse(args.get(index + 1).ok_or(command)?).ok_or(command)?);
                index += 2;
            }
            "--content" if content.is_none() => {
                content = Some(
                    normalize_content(args.get(index + 1).ok_or(command)?).map_err(|()| command)?,
                );
                index += 2;
            }
            "--contact" if !contact_seen => {
                contact_seen = true;
                contact =
                    normalize_contact(args.get(index + 1).ok_or(command)?).map_err(|()| command)?;
                index += 2;
            }
            "--operation-id" if operation_id.is_none() => {
                operation_id = Some(
                    parse_operation_id(args.get(index + 1).ok_or(command)?)
                        .map_err(|()| command)?,
                );
                index += 2;
            }
            "--plan-digest" if plan_digest.is_none() => {
                plan_digest = Some(parse_digest(args.get(index + 1).ok_or(command)?)?);
                index += 2;
            }
            _ => return Err(command),
        }
    }
    if !json_requested {
        return Err(command);
    }
    let fields = FeedbackFields {
        feedback_type: feedback_type.ok_or(command)?,
        content: content.ok_or(command)?,
        contact,
        include_diagnostics,
    };
    match action {
        Some("preflight") if operation_id.is_none() && plan_digest.is_none() => {
            Ok(FeedbackCommand::SubmitPreflight(fields))
        }
        Some("apply") => Ok(FeedbackCommand::SubmitApply {
            fields,
            operation_id: operation_id.ok_or(command)?,
            plan_digest: plan_digest.ok_or(command)?,
        }),
        _ => Err(command),
    }
}

fn parse_status(args: &[String]) -> Result<FeedbackCommand, &'static str> {
    let mut operation_id = None;
    let mut json_requested = false;
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--json" if !json_requested => {
                json_requested = true;
                index += 1;
            }
            "--operation-id" if operation_id.is_none() => {
                operation_id = Some(
                    parse_operation_id(args.get(index + 1).ok_or(STATUS_COMMAND)?)
                        .map_err(|()| STATUS_COMMAND)?,
                );
                index += 2;
            }
            _ => return Err(STATUS_COMMAND),
        }
    }
    if !json_requested {
        return Err(STATUS_COMMAND);
    }
    Ok(FeedbackCommand::Status {
        operation_id: operation_id.ok_or(STATUS_COMMAND)?,
    })
}

fn normalize_content(value: &str) -> Result<String, ()> {
    let value = value.trim();
    if value.is_empty()
        || value.encode_utf16().count() > MAX_CONTENT_CHARS
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(());
    }
    Ok(value.to_string())
}

fn normalize_contact(value: &str) -> Result<Option<String>, ()> {
    let value = value.trim();
    if value.encode_utf16().count() > MAX_CONTACT_CHARS || value.chars().any(char::is_control) {
        return Err(());
    }
    Ok((!value.is_empty()).then(|| value.to_string()))
}

fn parse_operation_id(value: &str) -> Result<String, ()> {
    let id = uuid::Uuid::parse_str(value).map_err(|_| ())?;
    if id.get_version_num() != 4 {
        return Err(());
    }
    Ok(id.to_string())
}

fn parse_digest(value: &str) -> Result<String, &'static str> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(SUBMIT_APPLY_COMMAND);
    }
    Ok(value.to_ascii_lowercase())
}

fn usage_failure(command: &'static str) -> CliCommandOutput {
    CliCommandOutput::failure(
        command,
        CliAccount::state(CliAccountState::Unknown),
        CliErrorCode::ValidationFailed,
        FEEDBACK_USAGE,
        EXIT_USAGE,
        Vec::new(),
    )
}

fn capture_guard(command: &'static str) -> Result<CliAuthGuard, CliCommandOutput> {
    CliAuthGuard::capture().map_err(|error| auth_guard_failure(command, error))
}

fn guard_is_authenticated(
    command: &'static str,
    guard: &CliAuthGuard,
) -> Result<bool, CliCommandOutput> {
    match guard.token_for_request() {
        Ok(_) => Ok(true),
        Err(CliAuthGuardError::AuthRequired) => Ok(false),
        Err(error) => Err(auth_guard_failure(command, error)),
    }
}

fn local_account(guard: &CliAuthGuard, authenticated: bool) -> CliAccount {
    if authenticated {
        CliAccount::local(CliAccountState::Unverified, guard.user_id())
    } else {
        CliAccount::state(CliAccountState::Guest)
    }
}

fn feedback_request<'a>(
    fields: &'a FeedbackFields,
    operation_id: &'a str,
    diagnostics: Option<&'a FeedbackDiagnostics>,
) -> FeedbackRequest<'a> {
    FeedbackRequest {
        client_operation_id: operation_id,
        feedback_type: fields.feedback_type,
        content: &fields.content,
        contact: fields.contact.as_deref(),
        diagnostics,
    }
}

fn payload_digest(
    fields: &FeedbackFields,
    operation_id: &str,
    diagnostics: Option<&FeedbackDiagnostics>,
) -> Result<String, ()> {
    let bytes =
        serde_json::to_vec(&feedback_request(fields, operation_id, diagnostics)).map_err(|_| ())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn plan_digest(
    guard: &CliAuthGuard,
    authenticated: bool,
    operation_id: &str,
    payload_sha256: &str,
) -> Result<String, ()> {
    let plan = FeedbackPlan {
        schema_version: PLAN_SCHEMA_VERSION,
        operation: "feedback.submit",
        account_scope_id: guard.user_id(),
        authenticated,
        operation_id,
        payload_sha256,
    };
    serde_json::to_vec(&plan)
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
        .map_err(|_| ())
}

fn submit_preflight(fields: FeedbackFields) -> CliCommandOutput {
    let guard = match capture_guard(SUBMIT_PREFLIGHT_COMMAND) {
        Ok(guard) => guard,
        Err(output) => return output,
    };
    let authenticated = match guard_is_authenticated(SUBMIT_PREFLIGHT_COMMAND, &guard) {
        Ok(authenticated) => authenticated,
        Err(output) => return output,
    };
    if let Err(error) = guard.verify_current() {
        return auth_guard_failure(SUBMIT_PREFLIGHT_COMMAND, error);
    }
    let operation_id = uuid::Uuid::new_v4().to_string();
    let diagnostics = fields
        .include_diagnostics
        .then(FeedbackDiagnostics::current);
    let payload_sha256 = match payload_digest(&fields, &operation_id, diagnostics.as_ref()) {
        Ok(digest) => digest,
        Err(()) => {
            return CliCommandOutput::failure(
                SUBMIT_PREFLIGHT_COMMAND,
                local_account(&guard, authenticated),
                CliErrorCode::InternalError,
                "无法生成反馈确认摘要",
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let digest = match plan_digest(&guard, authenticated, &operation_id, &payload_sha256) {
        Ok(digest) => digest,
        Err(()) => {
            return CliCommandOutput::failure(
                SUBMIT_PREFLIGHT_COMMAND,
                local_account(&guard, authenticated),
                CliErrorCode::InternalError,
                "无法生成反馈确认计划",
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let content_chars = fields.content.chars().count();
    let diagnostic_scope = diagnostics.as_ref().map(|diagnostics| {
        json!({
            "schemaVersion": diagnostics.schema_version,
            "source": diagnostics.source,
            "appVersion": diagnostics.app_version,
            "platform": diagnostics.platform,
            "architecture": diagnostics.architecture,
        })
    });
    CliCommandOutput::success(
        SUBMIT_PREFLIGHT_COMMAND,
        local_account(&guard, authenticated),
        json!({
            "mode": "preflight",
            "operationId": operation_id,
            "planDigest": digest,
            "type": fields.feedback_type,
            "contentCharacters": content_chars,
            "contactProvided": fields.contact.is_some(),
            "diagnosticsIncluded": fields.include_diagnostics,
            "diagnosticScope": diagnostic_scope,
            "attachmentsSupported": false,
            "externalWrite": true,
            "rollbackAvailable": false,
            "requiresExplicitApply": true,
        }),
        vec![
            "apply 会把反馈正文、可选联系方式和列出的脱敏诊断发送到 SkillHub Server；提交后不能本地回滚".into(),
            "CLI 不支持反馈图片；图片请使用 SkillHub APP 的反馈窗口".into(),
        ],
        vec![
            "向用户展示提交范围并取得明确确认，再原样传入 operationId 与 planDigest 执行 apply".into(),
        ],
    )
}

fn feedback_client(guard: &CliAuthGuard) -> Result<Client, String> {
    crate::net::client_builder(&guard.origin()?)?
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(30))
        .user_agent("Yitan-SkillHub feedback-cli")
        .build()
        .map_err(|_| "无法初始化 SkillHub 反馈连接".to_string())
}

fn api_url(guard: &CliAuthGuard, path: &str) -> Result<Url, String> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains(['?', '#', '\\'])
        || path
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
        || path.chars().any(char::is_control)
    {
        return Err("SkillHub API 路径无效".into());
    }
    let mut url = guard.origin()?;
    let base = url.path().trim_end_matches('/');
    url.set_path(&format!("{base}/api/{path}"));
    Ok(url)
}

async fn read_response(
    mut response: reqwest::Response,
    expected_url: &Url,
) -> Result<HttpResponse, ResponseReadError> {
    if response.url() != expected_url {
        return Err(ResponseReadError::EndpointChanged);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(ResponseReadError::TooLarge);
    }
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ResponseReadError::Offline)?
    {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(ResponseReadError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(HttpResponse { status, body })
}

fn parse_receipt(body: &[u8]) -> Result<FeedbackReceipt, ()> {
    let receipt = serde_json::from_slice::<FeedbackReceipt>(body).map_err(|_| ())?;
    uuid::Uuid::parse_str(&receipt.id).map_err(|_| ())?;
    if !matches!(
        receipt.status.as_str(),
        "pending" | "reviewing" | "resolved"
    ) || receipt.created_at.is_empty()
        || receipt.created_at.len() > 64
        || receipt.created_at.chars().any(char::is_control)
    {
        return Err(());
    }
    Ok(receipt)
}

fn with_optional_auth(
    request: reqwest::RequestBuilder,
    guard: &CliAuthGuard,
    authenticated: bool,
    operation_id: &str,
) -> Result<reqwest::RequestBuilder, CliAuthGuardError> {
    if authenticated {
        Ok(request.bearer_auth(guard.token_for_request()?))
    } else {
        let scope = Sha256::digest(
            format!(
                "skillhub-feedback-guest-scope-v1\0{}\0{operation_id}",
                guard.user_id()
            )
            .as_bytes(),
        );
        Ok(request.header(GUEST_SCOPE_HEADER, format!("{scope:x}")))
    }
}

async fn lookup_operation(
    client: &Client,
    guard: &CliAuthGuard,
    authenticated: bool,
    operation_id: &str,
) -> Result<OperationLookup, ResponseReadError> {
    let url = api_url(guard, &format!("feedback/operations/{operation_id}"))
        .map_err(|_| ResponseReadError::EndpointChanged)?;
    let request = with_optional_auth(
        client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CACHE_CONTROL, "no-store"),
        guard,
        authenticated,
        operation_id,
    )
    .map_err(|_| ResponseReadError::EndpointChanged)?;
    let response = request
        .send()
        .await
        .map_err(|_| ResponseReadError::Offline)?;
    let response = read_response(response, &url).await?;
    Ok(match response.status {
        StatusCode::OK => parse_receipt(&response.body)
            .map(OperationLookup::Found)
            .unwrap_or(OperationLookup::Unavailable),
        StatusCode::NOT_FOUND => OperationLookup::NotFound,
        StatusCode::UNAUTHORIZED => OperationLookup::Unauthorized,
        StatusCode::FORBIDDEN => OperationLookup::Forbidden,
        _ => OperationLookup::Unavailable,
    })
}

fn receipt_data(
    receipt: FeedbackReceipt,
    operation_id: &str,
    replayed: bool,
    recovered_after_uncertain_submit: bool,
) -> serde_json::Value {
    json!({
        "operationId": operation_id,
        "feedbackId": receipt.id,
        "status": receipt.status,
        "createdAt": receipt.created_at,
        "replayed": replayed,
        "recoveredAfterUncertainSubmit": recovered_after_uncertain_submit,
        "idempotentRetrySafe": true,
    })
}

fn outcome_unknown(
    account: CliAccount,
    operation_id: &str,
    message: &'static str,
) -> CliCommandOutput {
    CliCommandOutput::failure(
        SUBMIT_APPLY_COMMAND,
        account,
        CliErrorCode::OperationOutcomeUnknown,
        message,
        EXIT_NETWORK,
        vec![
            format!(
                "先运行 skillhub feedback status --operation-id {operation_id} --json 查询真实结果"
            ),
            "只有确认 Server 支持反馈操作查询后，才可使用相同 operationId、相同正文和相同 planDigest 重试 apply；不要生成新 operationId".into(),
        ],
    )
}

async fn recover_uncertain_submit(
    client: &Client,
    guard: &CliAuthGuard,
    authenticated: bool,
    account: CliAccount,
    operation_id: &str,
    message: &'static str,
) -> CliCommandOutput {
    if let Ok(OperationLookup::Found(receipt)) =
        lookup_operation(client, guard, authenticated, operation_id).await
    {
        if guard.verify_current().is_ok() {
            return CliCommandOutput::success(
                SUBMIT_APPLY_COMMAND,
                account,
                receipt_data(receipt, operation_id, true, true),
                vec!["首次提交响应中断，但已通过 operationId 从 Server 确认同一反馈".into()],
                Vec::new(),
            );
        }
    }
    let account = if guard.verify_current().is_ok() {
        account
    } else {
        CliAccount::state(CliAccountState::Unknown)
    };
    outcome_unknown(account, operation_id, message)
}

async fn submit_apply(
    fields: FeedbackFields,
    operation_id: String,
    expected_digest: String,
) -> CliCommandOutput {
    let guard = match capture_guard(SUBMIT_APPLY_COMMAND) {
        Ok(guard) => guard,
        Err(output) => return output,
    };
    let authenticated = match guard_is_authenticated(SUBMIT_APPLY_COMMAND, &guard) {
        Ok(authenticated) => authenticated,
        Err(output) => return output,
    };
    let diagnostics = fields
        .include_diagnostics
        .then(FeedbackDiagnostics::current);
    let payload_sha256 = match payload_digest(&fields, &operation_id, diagnostics.as_ref()) {
        Ok(digest) => digest,
        Err(()) => {
            return CliCommandOutput::failure(
                SUBMIT_APPLY_COMMAND,
                local_account(&guard, authenticated),
                CliErrorCode::InternalError,
                "无法验证反馈确认摘要",
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let current_digest = match plan_digest(&guard, authenticated, &operation_id, &payload_sha256) {
        Ok(digest) => digest,
        Err(()) => {
            return CliCommandOutput::failure(
                SUBMIT_APPLY_COMMAND,
                local_account(&guard, authenticated),
                CliErrorCode::InternalError,
                "无法验证反馈确认计划",
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    if current_digest != expected_digest {
        return CliCommandOutput::failure(
            SUBMIT_APPLY_COMMAND,
            local_account(&guard, authenticated),
            CliErrorCode::PlanStale,
            "反馈内容、提交范围或账号状态在确认后发生变化",
            EXIT_CONFLICT,
            vec!["重新运行 feedback submit preflight，并确认新的提交计划".into()],
        );
    }
    let account = if authenticated {
        match verify_account_with_server(&guard).await {
            Ok(account) => account,
            Err(error) => return account_verification_failure(SUBMIT_APPLY_COMMAND, &guard, error),
        }
    } else {
        if let Err(error) = guard.verify_current() {
            return auth_guard_failure(SUBMIT_APPLY_COMMAND, error);
        }
        CliAccount::state(CliAccountState::Guest)
    };
    let client = match feedback_client(&guard) {
        Ok(client) => client,
        Err(message) => {
            return CliCommandOutput::failure(
                SUBMIT_APPLY_COMMAND,
                account,
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let url = match api_url(&guard, "feedback") {
        Ok(url) => url,
        Err(_) => {
            return CliCommandOutput::failure(
                SUBMIT_APPLY_COMMAND,
                account,
                CliErrorCode::InternalError,
                "SkillHub 服务地址配置无效",
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let request_body = feedback_request(&fields, &operation_id, diagnostics.as_ref());
    let request = match with_optional_auth(
        client
            .post(url.clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CACHE_CONTROL, "no-store")
            .json(&request_body),
        &guard,
        authenticated,
        &operation_id,
    ) {
        Ok(request) => request,
        Err(error) => return auth_guard_failure(SUBMIT_APPLY_COMMAND, error),
    };
    let response = match request.send().await {
        Ok(response) => match read_response(response, &url).await {
            Ok(response) => response,
            Err(_) => return recover_uncertain_submit(
                &client,
                &guard,
                authenticated,
                account,
                &operation_id,
                "反馈请求已发出但响应无法安全确认；请按 operationId 查询，禁止改用新的 operationId",
            )
            .await,
        },
        Err(_) => {
            return recover_uncertain_submit(
                &client,
                &guard,
                authenticated,
                account,
                &operation_id,
                "反馈请求已发出但网络响应中断；请按 operationId 查询，禁止改用新的 operationId",
            )
            .await
        }
    };
    if matches!(response.status, StatusCode::OK | StatusCode::CREATED) {
        let receipt = match parse_receipt(&response.body) {
            Ok(receipt) => receipt,
            Err(()) => {
                return recover_uncertain_submit(
                    &client,
                    &guard,
                    authenticated,
                    account,
                    &operation_id,
                    "Server 已响应，但反馈结果格式无法安全确认；请按 operationId 查询",
                )
                .await
            }
        };
        let replayed = response.status == StatusCode::OK;
        match lookup_operation(&client, &guard, authenticated, &operation_id).await {
            Ok(OperationLookup::Found(confirmed)) if confirmed == receipt => {
                if let Err(error) = guard.verify_current() {
                    return outcome_unknown(
                        CliAccount::state(CliAccountState::Unknown),
                        &operation_id,
                        match error {
                            CliAuthGuardError::AccountChanged => {
                                "Server 已确认反馈，但本机账号随后发生变化；请按 operationId 查询"
                            }
                            _ => "Server 已确认反馈，但本机会话无法安全复核；请按 operationId 查询",
                        },
                    );
                }
                return CliCommandOutput::success(
                    SUBMIT_APPLY_COMMAND,
                    account,
                    receipt_data(receipt, &operation_id, replayed, false),
                    Vec::new(),
                    Vec::new(),
                );
            }
            _ => {
                return outcome_unknown(
                    account,
                    &operation_id,
                    "Server 接收了反馈，但无法确认 operationId 查询契约；确认状态前不要再次提交",
                )
            }
        }
    }
    if response.status == StatusCode::UNAUTHORIZED {
        return auth_guard_failure(SUBMIT_APPLY_COMMAND, guard.invalidate_unauthorized());
    }
    if let Err(error) = guard.verify_current() {
        return auth_guard_failure(SUBMIT_APPLY_COMMAND, error);
    }
    match response.status {
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => CliCommandOutput::failure(
            SUBMIT_APPLY_COMMAND,
            account,
            CliErrorCode::ValidationFailed,
            "SkillHub Server 拒绝了反馈字段",
            EXIT_INTERNAL,
            vec!["重新运行 feedback submit preflight 并检查字段长度".into()],
        ),
        StatusCode::CONFLICT => CliCommandOutput::failure(
            SUBMIT_APPLY_COMMAND,
            account,
            CliErrorCode::Conflict,
            "operationId 已绑定到另一份反馈计划",
            EXIT_CONFLICT,
            vec!["不要复用这个 operationId；重新运行 preflight 并取得新的明确确认".into()],
        ),
        StatusCode::FORBIDDEN => CliCommandOutput::failure(
            SUBMIT_APPLY_COMMAND,
            account,
            CliErrorCode::PermissionDenied,
            "当前身份无权使用这个反馈 operationId",
            EXIT_AUTH,
            vec!["请恢复预检时使用的 APP 账号后再查询；不要生成替代 operationId".into()],
        ),
        StatusCode::TOO_MANY_REQUESTS => CliCommandOutput::failure(
            SUBMIT_APPLY_COMMAND,
            account,
            CliErrorCode::ValidationFailed,
            "反馈提交过于频繁",
            EXIT_NETWORK,
            vec!["保留同一 operationId，等待限流窗口后先查询状态".into()],
        ),
        StatusCode::NOT_FOUND => CliCommandOutput::failure(
            SUBMIT_APPLY_COMMAND,
            account,
            CliErrorCode::NotFound,
            "当前 SkillHub Server 尚未开放反馈提交契约",
            EXIT_INTERNAL,
            vec!["请先更新 SkillHub Server 或改用 APP 反馈窗口".into()],
        ),
        _ => {
            recover_uncertain_submit(
                &client,
                &guard,
                authenticated,
                account,
                &operation_id,
                "SkillHub Server 返回异常，反馈结果需要按 operationId 复核",
            )
            .await
        }
    }
}

async fn operation_status(operation_id: String) -> CliCommandOutput {
    let guard = match capture_guard(STATUS_COMMAND) {
        Ok(guard) => guard,
        Err(output) => return output,
    };
    let authenticated = match guard_is_authenticated(STATUS_COMMAND, &guard) {
        Ok(authenticated) => authenticated,
        Err(output) => return output,
    };
    let account = if authenticated {
        match verify_account_with_server(&guard).await {
            Ok(account) => account,
            Err(error) => return account_verification_failure(STATUS_COMMAND, &guard, error),
        }
    } else {
        if let Err(error) = guard.verify_current() {
            return auth_guard_failure(STATUS_COMMAND, error);
        }
        CliAccount::state(CliAccountState::Guest)
    };
    let client = match feedback_client(&guard) {
        Ok(client) => client,
        Err(message) => {
            return CliCommandOutput::failure(
                STATUS_COMMAND,
                account,
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    match lookup_operation(&client, &guard, authenticated, &operation_id).await {
        Ok(OperationLookup::Found(receipt)) => {
            if let Err(error) = guard.verify_current() {
                return auth_guard_failure(STATUS_COMMAND, error);
            }
            CliCommandOutput::success(
                STATUS_COMMAND,
                account,
                receipt_data(receipt, &operation_id, false, false),
                Vec::new(),
                Vec::new(),
            )
        }
        Ok(OperationLookup::NotFound) => CliCommandOutput::failure(
            STATUS_COMMAND,
            account,
            CliErrorCode::NotFound,
            "没有找到当前身份对应的反馈操作",
            EXIT_INTERNAL,
            vec!["确认 operationId、APP 账号和网络出口与提交时一致".into()],
        ),
        Ok(OperationLookup::Unauthorized) => {
            auth_guard_failure(STATUS_COMMAND, guard.invalidate_unauthorized())
        }
        Ok(OperationLookup::Forbidden) => CliCommandOutput::failure(
            STATUS_COMMAND,
            account,
            CliErrorCode::PermissionDenied,
            "当前身份无权查询这个反馈操作",
            EXIT_AUTH,
            Vec::new(),
        ),
        Ok(OperationLookup::Unavailable) => CliCommandOutput::failure(
            STATUS_COMMAND,
            account,
            CliErrorCode::InternalError,
            "SkillHub Server 无法返回有效的反馈操作状态",
            EXIT_INTERNAL,
            vec!["请稍后使用同一 operationId 重试查询".into()],
        ),
        Err(ResponseReadError::Offline) => CliCommandOutput::failure(
            STATUS_COMMAND,
            account,
            CliErrorCode::Offline,
            "暂时无法连接 SkillHub Server",
            EXIT_NETWORK,
            vec!["请检查网络后使用同一 operationId 重试查询".into()],
        ),
        Err(ResponseReadError::TooLarge | ResponseReadError::EndpointChanged) => {
            CliCommandOutput::failure(
                STATUS_COMMAND,
                account,
                CliErrorCode::InternalError,
                "反馈操作状态响应不符合安全契约",
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        parse_command, parse_receipt, payload_digest, FeedbackCommand, FeedbackDiagnostics,
        FeedbackFields, FeedbackType,
    };

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn parses_preflight_and_apply_without_echo_fields() {
        let preflight = parse_command(&strings(&[
            "feedback",
            "submit",
            "preflight",
            "--type",
            "bug",
            "--content",
            "界面异常",
            "--contact",
            "person@example.com",
            "--include-diagnostics",
            "--json",
        ]))
        .expect("parse preflight");
        assert!(matches!(
            preflight,
            FeedbackCommand::SubmitPreflight(FeedbackFields {
                feedback_type: FeedbackType::Bug,
                include_diagnostics: true,
                ..
            })
        ));

        let apply = parse_command(&strings(&[
            "feedback",
            "submit",
            "apply",
            "--type",
            "usage",
            "--content",
            "操作说明不清楚",
            "--operation-id",
            "11111111-1111-4111-8111-111111111111",
            "--plan-digest",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "--json",
        ]))
        .expect("parse apply");
        assert!(matches!(
            apply,
            FeedbackCommand::SubmitApply {
                plan_digest,
                ..
            } if plan_digest == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
    }

    #[test]
    fn rejects_missing_json_invalid_values_and_duplicate_flags() {
        assert!(parse_command(&strings(&[
            "feedback",
            "submit",
            "preflight",
            "--type",
            "bug",
            "--content",
            "正文"
        ]))
        .is_err());
        let oversized_unicode = "😀".repeat(1_001);
        assert!(parse_command(&[
            "feedback".into(),
            "submit".into(),
            "preflight".into(),
            "--type".into(),
            "bug".into(),
            "--content".into(),
            oversized_unicode,
            "--json".into(),
        ])
        .is_err());
        assert!(parse_command(&strings(&[
            "feedback",
            "submit",
            "preflight",
            "--type",
            "invalid",
            "--content",
            "正文",
            "--json"
        ]))
        .is_err());
        assert!(parse_command(&strings(&[
            "feedback",
            "status",
            "--operation-id",
            "00000000-0000-0000-0000-000000000000",
            "--json"
        ]))
        .is_err());
        assert!(parse_command(&strings(&[
            "feedback",
            "submit",
            "preflight",
            "--type",
            "bug",
            "--type",
            "usage",
            "--content",
            "正文",
            "--json"
        ]))
        .is_err());
    }

    #[test]
    fn payload_digest_binds_private_fields_and_diagnostics() {
        let base = FeedbackFields {
            feedback_type: FeedbackType::Bug,
            content: "私密正文".into(),
            contact: Some("person@example.com".into()),
            include_diagnostics: false,
        };
        let operation_id = "11111111-1111-4111-8111-111111111111";
        let digest = payload_digest(&base, operation_id, None).expect("digest");
        let mut changed = base.clone();
        changed.content.push('!');
        assert_ne!(
            digest,
            payload_digest(&changed, operation_id, None).expect("changed digest")
        );
        assert_ne!(
            digest,
            payload_digest(&base, operation_id, Some(&FeedbackDiagnostics::current()))
                .expect("diagnostic digest")
        );
    }

    #[test]
    fn receipt_parser_accepts_only_bounded_public_fields() {
        let parsed = parse_receipt(
            br#"{"id":"11111111-1111-4111-8111-111111111111","status":"pending","createdAt":"2026-09-09T12:00:00.000Z"}"#,
        )
        .expect("parse receipt");
        assert_eq!(parsed.status, "pending");
        assert!(parse_receipt(
            br#"{"id":"11111111-1111-4111-8111-111111111111","status":"pending","createdAt":"2026-09-09T12:00:00.000Z","content":"must not echo"}"#,
        )
        .is_err());
        assert!(parse_receipt(
            br#"{"id":"bad","status":"pending","createdAt":"2026-09-09T12:00:00.000Z"}"#,
        )
        .is_err());
    }
}
