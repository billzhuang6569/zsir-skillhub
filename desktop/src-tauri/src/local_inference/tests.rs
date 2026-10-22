use super::*;
use process::{environment, Scratch};
use std::{ffi::OsString, time::Duration};

async fn execute(
    launch: &Launch,
    args: &[String],
    prompt: &[u8],
    cancel: &mut watch::Receiver<bool>,
    timeout: Duration,
) -> Result<Vec<u8>, Error> {
    process::execute_with_source(launch, args, prompt, cancel, timeout, vec![]).await
}

const NPM: &str = "@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\nIF EXIST \"%dp0%\\node.exe\" (\n  SET \"_prog=%dp0%\\node.exe\"\n) ELSE (\n  SET \"_prog=node\"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\n";
const NPM_NATIVE: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n";

#[test]
fn native_npm_shim_accepts_only_the_observed_template() {
    for shim in [NPM_NATIVE.to_owned(), NPM_NATIVE.replace("\r\n", "\n")] {
        assert_eq!(
            npm_script(&shim).unwrap(),
            "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"
        );
        for bad in [
            format!("{shim}echo injected"),
            shim.replace("node_modules", "..\\node_modules"),
            shim.replace("@anthropic-ai", "@other"),
            shim.replace("claude-code", "other-package"),
            shim.replace("%*", "%* & evil"),
        ] {
            assert_eq!(npm_script(&bad), Err(Error::ShimUnsupported));
        }
    }
}

fn executable_fixture(path: &std::path::Path, text: &str) {
    std::fs::write(path, text).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
}

#[test]
fn native_npm_launch_needs_no_node_and_requires_a_contained_existing_binary() {
    let dir = Scratch::new().unwrap();
    let binary = dir
        .0
        .join("node_modules/@anthropic-ai/claude-code/bin/claude.exe");
    std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
    executable_fixture(&dir.0.join("claude.cmd"), NPM_NATIVE);
    assert!(matches!(
        locate_in(&["claude"], std::slice::from_ref(&dir.0), true),
        Err(Error::ShimUnsupported)
    ));
    executable_fixture(&binary, "fixture");
    let launch = locate_in(&["claude"], std::slice::from_ref(&dir.0), true).unwrap();
    let expected = binary.canonicalize().unwrap();
    #[cfg(windows)]
    let expected = crate::commands::strip_windows_verbatim_prefix(&expected);
    assert_eq!(launch.program, expected);
    assert!(launch.prefix.is_empty());
    assert!(launch.node_dir.is_none());
    #[cfg(unix)]
    {
        let outside = Scratch::new().unwrap();
        let target = outside.0.join("claude.exe");
        executable_fixture(&target, "fixture");
        std::fs::remove_file(&binary).unwrap();
        std::os::unix::fs::symlink(target, binary).unwrap();
        assert!(matches!(
            locate_in(&["claude"], std::slice::from_ref(&dir.0), true),
            Err(Error::ShimUnsupported)
        ));
    }
}

#[test]
fn standard_npm_shim_is_parsed_never_executed() {
    assert_eq!(
        npm_script(&NPM.replace('\n', "\r\n")).unwrap(),
        "node_modules\\@anthropic-ai\\claude-code\\cli.js"
    );
    for bad in [
        NPM.replace("cli.js", "cli.js & evil"),
        NPM.replace("node_modules", "..\\node_modules"),
        format!("{NPM}echo injected"),
        NPM.replace("SETLOCAL", "call malicious"),
        NPM.replace("%*", "%1"),
    ] {
        assert_eq!(npm_script(&bad), Err(Error::ShimUnsupported));
    }
}

#[test]
fn environment_allowlist_excludes_runtime_keys_and_user_configuration() {
    let launch = Launch {
        program: std::env::current_exe().unwrap(),
        prefix: vec![],
        node_dir: None,
    };
    let source = [
        "HOME",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "SHELL",
        "LANG",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "https_proxy",
        "http_proxy",
        "all_proxy",
        "no_proxy",
        "PATH",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "ANTHROPIC_API_KEY",
        "NODE_OPTIONS",
        "SKILLHUB_AUTH_TOKEN",
        "TEAM_SECRET",
        "ENV",
        "BASH_ENV",
    ];
    let scratch = Scratch::new().unwrap();
    let env = environment(
        &launch,
        &scratch,
        source
            .iter()
            .map(|key| (OsString::from(key), OsString::from("fixture-value"))),
    )
    .unwrap();
    for key in &source[..14] {
        assert!(env.contains(&(OsString::from(key), OsString::from("fixture-value"))));
    }
    for key in &source[15..] {
        assert!(!env.iter().any(|(name, _)| name == key));
    }
    let path = &env.iter().find(|(key, _)| key == "PATH").unwrap().1;
    for (key, value) in [
        ("ENABLE_CLAUDEAI_MCP_SERVERS", "0"),
        ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"),
        ("DISABLE_AUTOUPDATER", "1"),
    ] {
        assert!(env.contains(&(key.into(), value.into())));
    }
    assert_ne!(path, "fixture-value");
    assert_eq!(
        std::env::split_paths(path).next().unwrap(),
        launch.program.parent().unwrap()
    );
}

#[cfg(windows)]
#[test]
fn windows_temp_and_tmp_are_per_run_not_inherited() {
    let launch = Launch {
        program: std::env::current_exe().unwrap(),
        prefix: vec![],
        node_dir: None,
    };
    let first = Scratch::new().unwrap();
    let second = Scratch::new().unwrap();
    assert_ne!(first.0, second.0);
    for scratch in [&first, &second] {
        let env = environment(
            &launch,
            scratch,
            [
                ("TEMP".into(), "inherited-temp".into()),
                ("TMP".into(), "inherited-tmp".into()),
                ("USERPROFILE".into(), "not-allowed".into()),
            ],
        )
        .unwrap();
        for name in ["TEMP", "TMP"] {
            let values: Vec<_> = env.iter().filter(|(key, _)| key == name).collect();
            assert_eq!(values.len(), 1);
            assert_eq!(values[0].1, scratch.0.as_os_str());
        }
        assert!(!env.iter().any(|(key, _)| key == "USERPROFILE"));
    }
}

#[test]
fn claude_version_policy_accepts_only_2_1_with_patch_at_least_300() {
    for (number, supported) in [
        ("2.1.299", false),
        ("2.1.300", true),
        ("2.1.301", true),
        ("2.1.999", true),
        ("2.2.0", false),
        ("2.0.999", false),
        ("1.1.300", false),
        ("3.1.300", false),
    ] {
        for text in [number.to_owned(), format!("{number} (Claude Code)\n")] {
            let parsed = version(text.as_bytes(), "claude").unwrap();
            assert_eq!(parsed, number);
            assert_eq!(supported_claude_version(&parsed), supported);
        }
    }
    for text in [
        "",
        "2.1",
        "2.1.x",
        "2.1.301-beta",
        "2.1.301 extra",
        "2.1.301.0",
    ] {
        assert_eq!(
            version(text.as_bytes(), "claude"),
            Err(Error::VersionUnsupported)
        );
        assert!(!supported_claude_version(text));
    }
}

#[test]
fn scratch_removes_only_its_own_directory() {
    let neighbor = Scratch::new().unwrap();
    std::fs::write(neighbor.0.join("keep"), "keep").unwrap();
    let scratch = Scratch::new().unwrap();
    let path = scratch.0.clone();
    std::fs::write(path.join("child"), "remove").unwrap();
    drop(scratch);
    assert!(!path.exists());
    assert!(neighbor.0.join("keep").exists());
}

#[test]
fn cancellation_is_bound_to_space_and_run_id_and_released() {
    let runner = TextInferenceRunner::default();
    let space = SpaceHandle {
        space_id: "fixture".into(),
        generation: 2,
    };
    let id = uuid::Uuid::new_v4().to_string();
    let (lease, cancel) = runner.begin(&id, &space).unwrap();
    assert!(!runner.cancel(
        &id,
        &SpaceHandle {
            generation: 3,
            ..space.clone()
        }
    ));
    assert!(matches!(
        runner.begin(&uuid::Uuid::new_v4().to_string(), &space),
        Err(Error::Busy)
    ));
    assert!(!*cancel.borrow());
    assert!(runner.cancel(&id, &space));
    assert!(*cancel.borrow());
    drop(lease);
    assert!(runner.active.lock().unwrap().is_empty());
    assert_eq!(runner.list_models(), Err(Error::ModelsUnsupported));
}

#[test]
fn version_and_envelope_errors_never_echo_provider_text() {
    assert_eq!(
        version(b"2.1.300 (Claude Code)\n", "claude").unwrap(),
        "2.1.300"
    );
    assert_eq!(version(b"codex-cli 0.162.1", "codex").unwrap(), "0.162.1");
    assert_eq!(version(b"secret", "claude"), Err(Error::VersionUnsupported));
    assert_eq!(
        parse_result(b"private invalid data", &schema(TaskKind::AnalyzeSkill)),
        Err(Error::InvalidJson)
    );
    assert_eq!(
        parse_result(
            br#"{"is_error":true,"result":"private provider data"}"#,
            &schema(TaskKind::AnalyzeSkill)
        ),
        Err(Error::Model)
    );
    assert_eq!(
        serde_json::to_string(&Error::Model).unwrap(),
        "\"MODEL_ERROR\""
    );
}

#[tokio::test]
async fn probe_termination_failure_survives_cancellation_and_space_transition() {
    use crate::spaces::rebind_tests::{deployment, Home};
    for switch_space in [false, true] {
        let home = Home::new();
        let session = home.signed_in(deployment("https://fixture.test"));
        let registry = SpaceRegistry::new(
            reqwest::Url::parse("https://official.test").unwrap(),
            home.0.clone(),
        )
        .unwrap();
        let space = SpaceRegistry::handle(Some(&session));
        let id = uuid::Uuid::new_v4().to_string();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let work = scoped(&registry, &space, &id, async |mut cancel| {
            entered_tx.send(()).expect("notify work entry");
            cancel.changed().await.expect("receive cancellation");
            Probe::new("claude").check(3, Err(Error::TerminationFailed))
        });
        let cancel = async {
            entered_rx
                .await
                .expect("work must start before cancellation");
            if switch_space {
                crate::runtime_env::test_sessions::begin_switch(&home.0);
            } else {
                assert!(registry.inference.cancel(&id, &space));
            }
        };
        let (result, ()) = tokio::join!(work, cancel);
        assert_eq!(result, Err(Error::TerminationFailed));
        assert!(registry.inference.active.lock().unwrap().is_empty());
    }
}

#[test]
fn probe_preserves_fatal_errors_and_reports_all_five_checks() {
    let mut probe = Probe::new("claude");
    assert_eq!(probe.checks.len(), 5);
    for index in 0..5 {
        assert_eq!(
            probe.check(index, Err(Error::TerminationFailed)),
            Err(Error::TerminationFailed)
        );
        assert_eq!(probe.check(index, Err(Error::Unavailable)), Ok(false));
        assert_eq!(probe.checks[index].reason, Some(Error::Unavailable));
        assert_eq!(probe.check(index, Ok(())), Ok(true));
        assert_eq!(probe.checks[index].status, "passed");
    }
}

#[tokio::test]
async fn space_transition_cancels_and_late_result_is_discarded() {
    use crate::spaces::rebind_tests::{deployment, Home};
    let home = Home::new();
    let session = home.signed_in(deployment("https://fixture.test"));
    let registry = SpaceRegistry::new(
        reqwest::Url::parse("https://official.test").unwrap(),
        home.0.clone(),
    )
    .unwrap();
    let space = SpaceRegistry::handle(Some(&session));
    let id = uuid::Uuid::new_v4().to_string();
    let work = scoped(&registry, &space, &id, async |_cancel| {
        tokio::time::sleep(Duration::from_millis(300)).await;
        Ok("late")
    });
    let switch = async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        crate::runtime_env::test_sessions::begin_switch(&home.0);
    };
    let (result, ()) = tokio::join!(work, switch);
    assert_eq!(result, Err(Error::StaleSpace));
    assert!(registry.inference.active.lock().unwrap().is_empty());
}

#[cfg(unix)]
mod unix {
    use super::*;
    use process::GRACE;
    use std::os::unix::fs::PermissionsExt;

    // macOS may spend hundreds of milliseconds checking a newly executable script.
    const FIXTURE_TIMEOUT: Duration = Duration::from_secs(3);

    #[tokio::test]
    async fn socks_proxy_rejects_before_starting_fake_cli() {
        let evidence = Scratch::new().unwrap();
        let marker = evidence.0.join("started");
        let (_dir, launch) = fixture(&format!("touch '{}'", marker.display()));
        let (_sender, mut cancel) = watch::channel(false);
        assert_eq!(
            process::execute_with_source(
                &launch,
                &[],
                b"",
                &mut cancel,
                TIMEOUT,
                vec![("https_proxy".into(), "socks5h://localhost:1080".into())]
            )
            .await,
            Err(Error::SocksProxy)
        );
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn discovery_shell_timeout_kills_group_with_null_stdin() {
        let evidence = Scratch::new().unwrap();
        let path = evidence.0.display();
        let (_dir, launch) = fixture(&format!(
            "if read value; then exit 9; fi\n(sleep 30) &\necho $! > '{path}/child'\necho $$ > '{path}/parent'\nwait"
        ));
        let result =
            process::discover_shell(&launch.program, "-ilc", "unused", FIXTURE_TIMEOUT).await;
        assert_eq!(result, Err(Error::Timeout));
        for file in ["parent", "child"] {
            let pid = std::fs::read_to_string(evidence.0.join(file)).expect("fake shell started");
            let output = std::process::Command::new("/bin/ps")
                .args(["-o", "stat=", "-p", pid.trim()])
                .output()
                .unwrap();
            let status = String::from_utf8_lossy(&output.stdout);
            assert!(status.trim().is_empty() || status.trim().starts_with('Z'));
        }
    }

    async fn wait_ready(evidence: &Scratch) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !evidence.0.join("ready").exists() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("fixture did not start: ready marker missing after 5 seconds");
    }

    fn fixture(body: &str) -> (Scratch, Launch) {
        let dir = Scratch::new().unwrap();
        let file = dir.0.join("fake-cli");
        std::fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).unwrap();
        (
            dir,
            Launch {
                program: file,
                prefix: vec![],
                node_dir: None,
            },
        )
    }
    async fn run(body: &str, prompt: &[u8], timeout: Duration) -> Result<Vec<u8>, Error> {
        let (_dir, launch) = fixture(body);
        let (_tx, mut rx) = watch::channel(false);
        execute(&launch, &[], prompt, &mut rx, timeout).await
    }
    #[tokio::test]
    async fn stdin_is_closed_and_cwd_is_empty_then_removed() {
        let bytes = run("pwd; /bin/ls -A; /bin/cat", b"fixture stdin", TIMEOUT)
            .await
            .unwrap();
        let text = String::from_utf8(bytes).unwrap();
        let (path, body) = text.split_once('\n').unwrap();
        assert_eq!(body, "fixture stdin");
        assert!(!std::path::Path::new(path).exists());
    }
    #[tokio::test]
    async fn nonzero_invalid_json_model_error_and_output_limits() {
        assert_eq!(run("exit 7", b"", TIMEOUT).await, Err(Error::Exit));
        assert_eq!(run("exit 127", b"", TIMEOUT).await, Err(Error::Executable));
        let invalid = run("printf not-json", b"", TIMEOUT).await.unwrap();
        assert_eq!(
            parse_result(&invalid, &schema(TaskKind::AnalyzeSkill)),
            Err(Error::InvalidJson)
        );
        let model = run("printf '%s' '{\"is_error\":true}'", b"", TIMEOUT)
            .await
            .unwrap();
        assert_eq!(
            parse_result(&model, &schema(TaskKind::AnalyzeSkill)),
            Err(Error::Model)
        );
        for script in ["head -c 1048577 /dev/zero", "head -c 65537 /dev/zero >&2"] {
            assert_eq!(run(script, b"", TIMEOUT).await, Err(Error::OutputLimit));
        }
    }
    #[tokio::test]
    async fn timeout_sends_term_then_kill_after_two_seconds_even_to_grandchildren() {
        let evidence = Scratch::new().unwrap();
        let path = evidence.0.to_str().unwrap();
        let body = format!("trap 'echo term >> \"{path}/events\"' TERM\n(trap '' TERM; sleep 30) &\nchild=$!\necho $child > \"{path}/grandchild\"\necho $$ > \"{path}/parent\"\necho ready > \"{path}/ready\"\nwhile kill -0 $child 2>/dev/null; do wait $child; done");
        let (_dir, launch) = fixture(&body);
        let (_tx, mut rx) = watch::channel(false);
        let started = Instant::now();
        let run = execute(&launch, &[], b"", &mut rx, FIXTURE_TIMEOUT);
        tokio::pin!(run);
        tokio::select! { _ = wait_ready(&evidence) => {}, result = &mut run => panic!("fixture did not start before execution ended: {result:?}") }
        let wait_term = async {
            for _ in 0..100 {
                if std::fs::read_to_string(evidence.0.join("events"))
                    .is_ok_and(|events| events.contains("term"))
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("TERM was not observed");
        };
        tokio::select! { _ = wait_term => {}, result = &mut run => panic!("tree termination unavailable or killed before grace: {result:?}") }
        assert!(std::fs::read_to_string(evidence.0.join("events"))
            .unwrap()
            .contains("term"));
        let pid: i32 = std::fs::read_to_string(evidence.0.join("parent"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
        assert_eq!(run.await, Err(Error::Timeout));
        assert!(started.elapsed() >= FIXTURE_TIMEOUT + GRACE);
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        let grandchild: i32 = std::fs::read_to_string(evidence.0.join("grandchild"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // A dead orphan may briefly remain a zombie; it cannot execute or retain pipes.
        let status = std::process::Command::new("/bin/ps")
            .args(["-o", "stat=", "-p", &grandchild.to_string()])
            .output()
            .unwrap();
        let status = String::from_utf8_lossy(&status.stdout);
        assert!(status.trim().is_empty() || status.trim().starts_with('Z'));
    }
    #[tokio::test]
    async fn termination_order_and_grace_are_preserved_even_if_term_fails() {
        for term_fails in [false, true] {
            let mut signals = Vec::new();
            let result = process::terminate_group(|signal| {
                signals.push((signal, Instant::now()));
                if term_fails && signal == libc::SIGTERM {
                    Err(Error::TerminationFailed)
                } else {
                    Ok(())
                }
            })
            .await;
            assert_eq!(
                signals
                    .iter()
                    .map(|(signal, _)| *signal)
                    .collect::<Vec<_>>(),
                [libc::SIGTERM, libc::SIGKILL]
            );
            assert!(signals[1].1.duration_since(signals[0].1) >= GRACE);
            assert_eq!(result.is_err(), term_fails);
        }
    }
    #[tokio::test]
    async fn cancellation_and_timeout_cover_blocked_stdin() {
        let data = vec![b'x'; 256 * 1024];
        for cancel in [true, false] {
            let evidence = Scratch::new().unwrap();
            let path = evidence.0.to_str().unwrap();
            let (_dir, launch) = fixture(&format!(
                "trap '' TERM; echo ready > \"{path}/ready\"; sleep 30"
            ));
            let (tx, mut rx) = watch::channel(false);
            let timeout = if cancel { TIMEOUT } else { FIXTURE_TIMEOUT };
            let operation = execute(&launch, &[], &data, &mut rx, timeout);
            tokio::pin!(operation);
            tokio::select! { _ = wait_ready(&evidence) => {}, result = &mut operation => panic!("fixture did not start before execution ended: {result:?}") }
            if cancel {
                tx.send(true).unwrap();
            }
            assert_eq!(
                operation.await,
                Err(if cancel {
                    Error::Cancelled
                } else {
                    Error::Timeout
                })
            );
        }
    }
    #[tokio::test]
    async fn late_output_after_term_is_not_a_success() {
        let evidence = Scratch::new().unwrap();
        let path = evidence.0.to_str().unwrap();
        let (_dir, launch) = fixture(&format!(
            "trap 'echo late; exit 0' TERM; echo ready > \"{path}/ready\"; sleep 30"
        ));
        let (_tx, mut rx) = watch::channel(false);
        let operation = execute(&launch, &[], b"", &mut rx, FIXTURE_TIMEOUT);
        tokio::pin!(operation);
        tokio::select! { _ = wait_ready(&evidence) => {}, result = &mut operation => panic!("fixture did not start before execution ended: {result:?}") }
        assert_eq!(operation.await, Err(Error::Timeout));
    }
    #[test]
    fn path_discovery_requires_executable_and_prefers_native() {
        let (dir, _) = fixture("exit 0");
        executable_fixture(&dir.0.join("node"), "fixture");
        assert!(locate_in(&["fake-cli"], std::slice::from_ref(&dir.0), false).is_ok());
        std::fs::set_permissions(
            dir.0.join("fake-cli"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert!(matches!(
            locate_in(&["fake-cli"], std::slice::from_ref(&dir.0), false),
            Err(Error::NotInstalled)
        ));
    }

    #[tokio::test]
    async fn script_cli_uses_discovered_node_directory_in_rebuilt_path() {
        let dir = Scratch::new().unwrap();
        let cli_dir = dir.0.join("custom-npm/bin");
        let node_dir = dir.0.join("homebrew/bin");
        std::fs::create_dir_all(&cli_dir).unwrap();
        std::fs::create_dir_all(&node_dir).unwrap();
        executable_fixture(
            &cli_dir.join("claude"),
            "#!/usr/bin/env node\nfixture payload\n",
        );
        assert!(matches!(
            locate_in(&["claude"], std::slice::from_ref(&cli_dir), false),
            Err(Error::Executable)
        ));
        executable_fixture(&node_dir.join("node"), "#!/bin/sh\nprintf node-found\n");
        let launch = locate_in(&["claude"], &[cli_dir.clone(), node_dir.clone()], false).unwrap();
        assert_eq!(launch.node_dir, Some(node_dir.clone()));
        let env = environment(&launch, &dir, []).unwrap();
        let path = &env.iter().find(|(key, _)| key == "PATH").unwrap().1;
        assert_eq!(
            std::env::split_paths(path).take(2).collect::<Vec<_>>(),
            [cli_dir, node_dir]
        );
        let (_tx, mut rx) = watch::channel(false);
        assert_eq!(
            execute(&launch, &[], b"", &mut rx, TIMEOUT).await.unwrap(),
            b"node-found"
        );
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    #[test]
    fn shim_launch_paths_are_plain_after_canonical_containment_checks() {
        let dir = Scratch::new().unwrap();
        std::fs::create_dir_all(dir.0.join("node_modules/@anthropic-ai/claude-code/bin")).unwrap();
        for file in [
            "node.exe",
            "node_modules/@anthropic-ai/claude-code/cli.js",
            "node_modules/@anthropic-ai/claude-code/bin/claude.exe",
        ] {
            std::fs::write(dir.0.join(file), "fixture").unwrap();
        }
        let canonical_dir = dir.0.canonicalize().unwrap();
        assert!(canonical_dir.to_str().unwrap().starts_with(r"\\?\"));
        for shim in [NPM, NPM_NATIVE] {
            std::fs::write(dir.0.join("claude.cmd"), shim).unwrap();
            let launch =
                locate_in(&["claude"], std::slice::from_ref(&canonical_dir), true).unwrap();
            assert!(!launch.program.to_str().unwrap().starts_with(r"\\?\"));
            assert!(launch.program.is_absolute());
            assert!(launch.program.is_file());
            assert_eq!(launch.prefix.len(), usize::from(shim == NPM));
            for argument in &launch.prefix {
                assert!(!argument.starts_with(r"\\?\"));
                assert!(std::path::Path::new(argument).is_absolute());
                assert!(std::path::Path::new(argument).is_file());
            }
        }
        assert_eq!(
            shim_launch_path(std::path::Path::new(r"\\?\UNC\server\share\cli.js")),
            Err(Error::ShimUnsupported)
        );
    }

    #[test]
    fn windows_prefers_exe_and_resolves_npm_to_node_without_cmd() {
        let dir = Scratch::new().unwrap();
        std::fs::create_dir_all(dir.0.join("node_modules/@anthropic-ai/claude-code")).unwrap();
        for file in ["node.exe", "node_modules/@anthropic-ai/claude-code/cli.js"] {
            std::fs::write(dir.0.join(file), "fixture").unwrap();
        }
        std::fs::write(dir.0.join("claude.cmd"), NPM).unwrap();
        let launch = locate_in(&["claude"], std::slice::from_ref(&dir.0), true).unwrap();
        assert_eq!(launch.program, dir.0.join("node.exe"));
        assert_eq!(launch.prefix.len(), 1);
        std::fs::write(dir.0.join("claude.exe"), "fixture").unwrap();
        assert_eq!(
            locate_in(&["claude"], std::slice::from_ref(&dir.0), true)
                .unwrap()
                .program,
            dir.0.join("claude.exe")
        );
    }
    #[tokio::test]
    async fn job_object_kills_the_process_tree() {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
        };
        let evidence = Scratch::new().unwrap();
        let marker = evidence.0.join("pid");
        let root = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
        let program = root.join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let script = format!("$child = Start-Process -FilePath '{0}' -ArgumentList '-n 30 127.0.0.1' -PassThru -WindowStyle Hidden; [IO.File]::WriteAllText('{1}', [string]$child.Id); Start-Sleep 30", root.join("System32/ping.exe").display(), marker.display());
        let launch = Launch {
            program,
            prefix: vec![],
            node_dir: None,
        };
        let (_tx, mut rx) = watch::channel(false);
        let args = [
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            script,
        ];
        let result = execute(&launch, &args, b"", &mut rx, Duration::from_secs(3)).await;
        assert_eq!(result, Err(Error::Timeout));
        let pid = std::fs::read_to_string(marker)
            .expect("grandchild started")
            .parse::<u32>()
            .unwrap();
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if !handle.is_null() {
                assert_eq!(WaitForSingleObject(handle, 2000), 0);
                CloseHandle(handle);
            }
        }
    }
}
