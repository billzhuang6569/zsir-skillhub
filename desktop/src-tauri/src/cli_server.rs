use crate::{cli, runtime_env, spaces};
use cli::{CliAccount, CliAccountState, CliCommandOutput, CliErrorCode};

pub(crate) fn run(args: &[String]) -> i32 {
    run_at(&crate::skillhub_dir(), args)
}

fn run_at(home: &std::path::Path, args: &[String]) -> i32 {
    execute_at(home, args).write_to_stdout()
}

fn failure(
    command: &'static str,
    code: CliErrorCode,
    message: impl Into<String>,
    exit: i32,
) -> CliCommandOutput {
    let message = message.into();
    CliCommandOutput::failure(
        command,
        CliAccount::state(CliAccountState::Unknown),
        code,
        message.clone(),
        exit,
        vec![message],
    )
}

fn execute_at(home: &std::path::Path, args: &[String]) -> CliCommandOutput {
    let args = args.strip_suffix(&["--json".to_string()]).unwrap_or(args);
    if args == ["server", "show"] {
        let snapshot = match std::fs::symlink_metadata(home.join("runtime/session.json")) {
            Ok(_) => runtime_env::runtime_session_snapshot_at(home).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        };
        let data = match snapshot {
            Ok(Some(session)) => match session.deployment().base() {
                Ok(base) => {
                    serde_json::json!({"profile":session.deployment().profile(), "origin":base.as_ref().map(spaces::canonical_base), "spaceId":session.space_id(), "generation":session.generation(), "signedIn":session.auth_token().is_some(), "pending":session.is_sync_pending(), "serverValidated":false})
                }
                Err(message) => {
                    return failure(
                        "server show",
                        CliErrorCode::InternalError,
                        message,
                        cli::EXIT_INTERNAL,
                    )
                }
            },
            Ok(None) => {
                serde_json::json!({"profile":"official","origin":crate::official_channel::COMPILED.server_origin,"spaceId":"official","generation":0,"signedIn":false,"pending":false,"serverValidated":false})
            }
            Err(message) => {
                return failure(
                    "server show",
                    CliErrorCode::InternalError,
                    message,
                    cli::EXIT_INTERNAL,
                )
            }
        };
        return CliCommandOutput::success(
            "server show",
            CliAccount::state(CliAccountState::Unknown),
            data,
            Vec::new(),
            Vec::new(),
        );
    }
    if args.len() != 3 || args[1] != "use" {
        return failure("server", CliErrorCode::ValidationFailed,
            "用法：skillhub server show [--json] | skillhub server use <url|official|local> [--json]", cli::EXIT_USAGE);
    }
    let mut transaction = match spaces::SwitchTransaction::begin(home, true) {
        Ok(transaction) => transaction,
        Err(message) => {
            return failure(
                "server use",
                CliErrorCode::Conflict,
                message,
                cli::EXIT_CONFLICT,
            )
        }
    };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            return failure(
                "server use",
                CliErrorCode::InternalError,
                error.to_string(),
                cli::EXIT_INTERNAL,
            )
        }
    };
    let report = runtime.block_on(spaces::inspect_connection(home, &args[2]));
    let Some(deployment) = report.deployment else {
        let mut actions: Vec<String> = report
            .checks
            .into_iter()
            .map(|check| check.message)
            .collect();
        if let Err(error) = transaction.cancel() {
            actions.push(format!("恢复源会话失败：{error}"));
        }
        return CliCommandOutput::failure(
            "server use",
            CliAccount::state(CliAccountState::Unknown),
            CliErrorCode::Offline,
            "测试连接失败",
            cli::EXIT_NETWORK,
            actions,
        );
    };
    let mut actions = Vec::new();
    if spaces::known_instance(home, &deployment).is_some() {
        actions.push("这是已知实例的新地址，请在 APP 设置页改用新地址".into());
    }
    match transaction.commit(deployment, None) {
        Ok(session) => {
            let base = match session.deployment().base() {
                Ok(base) => base,
                Err(error) => {
                    return failure(
                        "server use",
                        CliErrorCode::InternalError,
                        error,
                        cli::EXIT_INTERNAL,
                    )
                }
            };
            actions.push(
                if session.deployment().profile() == "local" {
                    "已切换到仅本机，原数据保留，无需登录"
                } else {
                    "已切换，原数据保留；请打开 APP 登录或完成实例初始化"
                }
                .into(),
            );
            CliCommandOutput::success(
                "server use",
                CliAccount::state(CliAccountState::Guest),
                serde_json::json!({"profile":session.deployment().profile(), "origin":base.as_ref().map(spaces::canonical_base), "spaceId":session.space_id()}),
                Vec::new(),
                actions,
            )
        }
        Err(error) => {
            if let Err(error) = transaction.cancel() {
                actions.push(format!("恢复源会话失败：{error}"));
            }
            CliCommandOutput::failure(
                "server use",
                CliAccount::state(CliAccountState::Unknown),
                CliErrorCode::InternalError,
                error,
                cli::EXIT_INTERNAL,
                actions,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_cli_known_instance_new_address_is_guest_without_proof() {
        use spaces::rebind_tests::{deployment, Home, HttpFixture};
        if let Ok(home) = std::env::var("SKILLHUB_TEST_REBIND_CLI_HOME") {
            assert_eq!(
                run_at(
                    std::path::Path::new(&home),
                    &[
                        "server".into(),
                        "use".into(),
                        std::env::var("SKILLHUB_TEST_REBIND_CLI_ORIGIN").unwrap()
                    ]
                ),
                0
            );
            return;
        }
        let home = Home::new();
        let old = home.signed_in(deployment("https://old.test/prefix"));
        let server = HttpFixture::start("ok");
        let report = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(spaces::inspect_connection(&home.0, &server.origin));
        assert!(spaces::known_instance(&home.0, report.deployment.as_ref().unwrap()).is_some());
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "cli_server::tests::socket_cli_known_instance_new_address_is_guest_without_proof",
                "--nocapture",
            ])
            .env("SKILLHUB_TEST_REBIND_CLI_HOME", &home.0)
            .env("SKILLHUB_TEST_REBIND_CLI_ORIGIN", &server.origin)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout)
            .contains("这是已知实例的新地址，请在 APP 设置页改用新地址"));
        let session = runtime_env::read_session_at(&home.0).unwrap();
        assert_ne!(session.space_id(), old.space_id());
        assert!(session.auth_token().is_none());
        let requests = server.requests.lock().unwrap();
        assert!(requests
            .iter()
            .all(|r| !r.contains("address-proof")
                && !r.to_ascii_lowercase().contains("authorization:")));
    }

    #[test]
    fn invalid_connection_returns_an_envelope_and_restores_the_source() {
        let home =
            std::env::temp_dir().join(format!("skillhub-server-invalid-{}", uuid::Uuid::new_v4()));
        let args = ["server", "use", "local", "--json"].map(str::to_owned);
        assert_eq!(execute_at(&home, &args).exit_code(), 0);
        let before = runtime_env::read_session_at(&home).unwrap();
        let output = execute_at(&home, &["server", "use", "not a URL"].map(str::to_owned));
        assert_eq!(output.exit_code(), cli::EXIT_NETWORK);
        let envelope: serde_json::Value = serde_json::from_str(output.json()).unwrap();
        assert_eq!(envelope["command"], "server use");
        assert_eq!(envelope["ok"], false);
        assert_eq!(envelope["error"]["code"], "OFFLINE");
        assert!(!envelope["nextActions"].as_array().unwrap().is_empty());
        let restored = runtime_env::read_session_at(&home).unwrap();
        assert_eq!(before.user_id(), restored.user_id());
        assert_eq!(before.space_id(), restored.space_id());
        assert_eq!(before.deployment(), restored.deployment());
        assert_eq!(before.auth_token(), restored.auth_token());
        assert!(!restored.is_sync_pending());
        assert!(restored.generation() > before.generation());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn cli_busy_does_not_mutate_and_local_switch_is_signed_out() {
        let home =
            std::env::temp_dir().join(format!("skillhub-server-cli-{}", uuid::Uuid::new_v4()));
        let app = spaces::start_app(&home).unwrap();
        let before = runtime_env::read_session_at(&home).unwrap();
        let args = ["server", "use", "local"].map(str::to_owned);
        let busy = execute_at(&home, &args);
        assert_eq!(busy.exit_code(), cli::EXIT_CONFLICT);
        let envelope: serde_json::Value = serde_json::from_str(busy.json()).unwrap();
        assert_eq!(envelope["error"]["code"], "CONFLICT");
        assert_eq!(envelope["command"], "server use");
        assert_eq!(before, runtime_env::read_session_at(&home).unwrap());
        drop(app);
        assert_eq!(run_at(&home, &args), 0);
        let session = runtime_env::read_session_at(&home).unwrap();
        assert_eq!(session.space_id(), "local");
        assert!(session.auth_token().is_none());
        let bytes = std::fs::read(home.join("runtime/session.json")).unwrap();
        assert_eq!(
            run_at(&home, &["server".into(), "show".into(), "--json".into()]),
            0
        );
        assert_eq!(
            bytes,
            std::fs::read(home.join("runtime/session.json")).unwrap()
        );
        std::fs::remove_dir_all(home).unwrap();
    }
}
