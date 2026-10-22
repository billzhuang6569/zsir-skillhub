use crate::{cli, runtime_env, spaces};

pub(crate) fn run(args: &[String]) -> i32 {
    let home = crate::skillhub_dir();
    run_at(&home, args)
}

fn run_at(home: &std::path::Path, args: &[String]) -> i32 {
    if args.get(1).map(String::as_str) == Some("show")
        && (args.len() == 2 || (args.len() == 3 && args[2] == "--json"))
    {
        let snapshot = match std::fs::symlink_metadata(home.join("runtime/session.json")) {
            Ok(_) => runtime_env::runtime_session_snapshot_at(home).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        };
        return match snapshot {
            Ok(Some(session)) => match session.deployment().base() {
                Ok(base) => {
                    if args.len() == 3 {
                        println!(
                            "{}",
                            serde_json::json!({"profile":session.deployment().profile(), "origin":base.as_ref().map(spaces::canonical_base), "spaceId":session.space_id(), "generation":session.generation(), "signedIn":session.auth_token().is_some(), "pending":session.is_sync_pending(), "serverValidated":false})
                        );
                    } else {
                        println!(
                            "{}",
                            base.as_ref()
                                .map(spaces::canonical_base)
                                .unwrap_or_else(|| "仅本机".into())
                        );
                    }
                    0
                }
                Err(message) => {
                    eprintln!("{message}");
                    cli::EXIT_INTERNAL
                }
            },
            Ok(None) => {
                if args.len() == 3 {
                    println!(
                        "{}",
                        serde_json::json!({"profile":"official","origin":crate::official_channel::COMPILED.server_origin,"spaceId":"official","generation":0,"signedIn":false,"pending":false,"serverValidated":false})
                    );
                } else {
                    println!("{}", crate::official_channel::COMPILED.server_origin);
                }
                0
            }
            Err(message) => {
                eprintln!("{message}");
                cli::EXIT_INTERNAL
            }
        };
    }
    if args.len() != 3 || args[1] != "use" {
        eprintln!("用法：skillhub server show [--json] | skillhub server use <url|official|local>");
        return cli::EXIT_USAGE;
    }
    let mut transaction = match spaces::SwitchTransaction::begin(home, true) {
        Ok(transaction) => transaction,
        Err(message) => {
            eprintln!("{message}");
            return cli::EXIT_CONFLICT;
        }
    };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("{error}");
            return cli::EXIT_INTERNAL;
        }
    };
    let report = runtime.block_on(spaces::inspect_connection(home, &args[2]));
    let Some(deployment) = report.deployment else {
        eprintln!(
            "{}",
            serde_json::to_string(&report).unwrap_or_else(|_| "测试连接失败".into())
        );
        if let Err(error) = transaction.cancel() {
            eprintln!("恢复源会话失败：{error}");
        }
        return cli::EXIT_NETWORK;
    };
    if spaces::known_instance(home, &deployment).is_some() {
        eprintln!("这是已知实例的新地址，请在 APP 设置页改用新地址");
    }
    match transaction.commit(deployment, None) {
        Ok(session) => {
            println!(
                "{}",
                if session.deployment().profile() == "local" {
                    "已切换到仅本机，原数据保留，无需登录"
                } else {
                    "已切换，原数据保留；请打开 APP 登录或完成实例初始化"
                }
            );
            0
        }
        Err(error) => {
            eprintln!("{error}");
            if let Err(error) = transaction.cancel() {
                eprintln!("恢复源会话失败：{error}");
            }
            cli::EXIT_INTERNAL
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
        assert!(String::from_utf8_lossy(&output.stderr)
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
    fn cli_busy_does_not_mutate_and_local_switch_is_signed_out() {
        let home =
            std::env::temp_dir().join(format!("skillhub-server-cli-{}", uuid::Uuid::new_v4()));
        let app = spaces::start_app(&home).unwrap();
        let before = runtime_env::read_session_at(&home).unwrap();
        let args = ["server", "use", "local"].map(str::to_owned);
        assert_eq!(run_at(&home, &args), cli::EXIT_CONFLICT);
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
