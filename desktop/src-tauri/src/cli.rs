use serde::Serialize;
use serde_json::Value;
use std::io::{self, Write as _};

pub(crate) const CLI_PROTOCOL_VERSION: u8 = 1;

pub(crate) const EXIT_INTERNAL: i32 = 1;
pub(crate) const EXIT_USAGE: i32 = 2;
pub(crate) const EXIT_AUTH: i32 = 3;
pub(crate) const EXIT_CONFLICT: i32 = 4;
pub(crate) const EXIT_NETWORK: i32 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CliAccountState {
    Unknown,
    Guest,
    Unverified,
    Authenticated,
    Offline,
    Expired,
    SyncPending,
    Invalid,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CliAccount {
    state: CliAccountState,
    verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    marketplace_role: Option<String>,
}

impl CliAccount {
    pub(crate) fn state(state: CliAccountState) -> Self {
        Self {
            state,
            verified: false,
            id: None,
            email: None,
            display_name: None,
            avatar_url: None,
            marketplace_role: None,
        }
    }

    pub(crate) fn local(state: CliAccountState, id: &str) -> Self {
        Self {
            id: Some(id.to_string()),
            ..Self::state(state)
        }
    }

    pub(crate) fn verified(
        id: String,
        email: String,
        display_name: String,
        avatar_url: Option<String>,
        marketplace_role: String,
    ) -> Self {
        Self {
            state: CliAccountState::Authenticated,
            verified: true,
            id: Some(id),
            email: Some(email),
            display_name: Some(display_name),
            avatar_url,
            marketplace_role: Some(marketplace_role),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CliErrorCode {
    AuthRequired,
    AuthExpired,
    AuthSyncPending,
    AuthIdentityMismatch,
    AuthSessionUnsafe,
    AccountChanged,
    Offline,
    PermissionDenied,
    NotFound,
    Conflict,
    PlanStale,
    ValidationFailed,
    OperationOutcomeUnknown,
    InternalError,
}

impl CliErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::AuthRequired => "AUTH_REQUIRED",
            Self::AuthExpired => "AUTH_EXPIRED",
            Self::AuthSyncPending => "AUTH_SYNC_PENDING",
            Self::AuthIdentityMismatch => "AUTH_IDENTITY_MISMATCH",
            Self::AuthSessionUnsafe => "AUTH_SESSION_UNSAFE",
            Self::AccountChanged => "ACCOUNT_CHANGED",
            Self::Offline => "OFFLINE",
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::NotFound => "NOT_FOUND",
            Self::Conflict => "CONFLICT",
            Self::PlanStale => "PLAN_STALE",
            Self::ValidationFailed => "VALIDATION_FAILED",
            Self::OperationOutcomeUnknown => "OPERATION_OUTCOME_UNKNOWN",
            Self::InternalError => "INTERNAL_ERROR",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliError {
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliEnvelope {
    schema_version: u8,
    ok: bool,
    command: &'static str,
    account: CliAccount,
    data: Value,
    warnings: Vec<String>,
    next_actions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<CliError>,
}

pub(crate) struct CliCommandOutput {
    json: String,
    exit_code: i32,
}

impl CliCommandOutput {
    pub(crate) fn success(
        command: &'static str,
        account: CliAccount,
        data: Value,
        warnings: Vec<String>,
        next_actions: Vec<String>,
    ) -> Self {
        Self::from_envelope(
            CliEnvelope {
                schema_version: CLI_PROTOCOL_VERSION,
                ok: true,
                command,
                account,
                data,
                warnings,
                next_actions,
                error: None,
            },
            0,
        )
    }

    pub(crate) fn failure(
        command: &'static str,
        account: CliAccount,
        code: CliErrorCode,
        message: impl Into<String>,
        exit_code: i32,
        next_actions: Vec<String>,
    ) -> Self {
        Self::from_envelope(
            CliEnvelope {
                schema_version: CLI_PROTOCOL_VERSION,
                ok: false,
                command,
                account,
                data: Value::Object(Default::default()),
                warnings: Vec::new(),
                next_actions,
                error: Some(CliError {
                    code: code.as_str(),
                    message: message.into(),
                }),
            },
            exit_code,
        )
    }

    fn from_envelope(envelope: CliEnvelope, exit_code: i32) -> Self {
        let json = serde_json::to_string(&envelope).unwrap_or_else(|_| {
            r#"{"schemaVersion":1,"ok":false,"command":"unknown","account":{"state":"unknown","verified":false},"data":{},"warnings":[],"nextActions":[],"error":{"code":"INTERNAL_ERROR","message":"无法序列化 CLI 响应"}}"#.to_string()
        });
        Self { json, exit_code }
    }

    pub(crate) fn write_to_stdout(self) -> i32 {
        let mut stdout = io::stdout().lock();
        if writeln!(stdout, "{}", self.json)
            .and_then(|_| stdout.flush())
            .is_err()
        {
            return EXIT_INTERNAL;
        }
        self.exit_code
    }

    #[cfg(test)]
    pub(crate) fn json(&self) -> &str {
        &self.json
    }

    #[cfg(test)]
    pub(crate) fn exit_code(&self) -> i32 {
        self.exit_code
    }
}

#[cfg(test)]
mod tests {
    use super::{CliAccount, CliAccountState, CliCommandOutput, CliErrorCode, EXIT_AUTH};
    use serde_json::json;

    #[test]
    fn envelope_uses_stable_machine_fields() {
        let output = CliCommandOutput::failure(
            "auth status",
            CliAccount::state(CliAccountState::Expired),
            CliErrorCode::AuthExpired,
            "登录已失效",
            EXIT_AUTH,
            vec!["请打开 SkillHub APP 重新登录".into()],
        );
        let value: serde_json::Value =
            serde_json::from_str(output.json()).expect("parse JSON envelope");
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "AUTH_EXPIRED");
        assert_eq!(output.exit_code(), EXIT_AUTH);
    }

    #[test]
    fn account_output_has_no_place_for_an_auth_token() {
        let output = CliCommandOutput::success(
            "auth status",
            CliAccount::verified(
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
                "person@example.com".into(),
                "Person".into(),
                None,
                "user".into(),
            ),
            json!({ "refreshRequested": true, "serverValidated": true }),
            Vec::new(),
            Vec::new(),
        );
        assert!(!output.json().contains("authToken"));
        assert!(!output.json().contains("token"));
    }
}
