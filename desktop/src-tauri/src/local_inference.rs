//! #404: isolated text inference shared by settings and the native lease worker.
//! 2026-10-18 macOS evidence: Claude Code 2.1.300 passed all five checks with
//! zero instruction documents and only StructuredOutput. Never add --bare: it
//! disables subscription Keychain auth. Codex 0.162.1 still loads global rules
//! and account MCP connectors; neither exec nor experimental app-server is enabled.
use crate::server_request::{SpaceHandle, SpaceRegistry};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Mutex, time::Instant};
use tokio::sync::watch;

mod discovery;
mod process;
mod protocol;
pub(crate) mod worker;
use process::{execute, TIMEOUT};
use protocol::{arguments, parse_result, prompt, schema, Input, TaskKind};

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum Error {
    NotInstalled,
    Executable,
    ShimUnsupported,
    VersionUnsupported,
    IsolationUnsupported,
    NotLoggedIn,
    Spawn,
    Io,
    Timeout,
    Cancelled,
    TerminationFailed,
    OutputLimit,
    Exit,
    InvalidJson,
    #[serde(rename = "MODEL_ERROR")]
    Model,
    InvalidResult,
    InvalidInput,
    Busy,
    StaleSpace,
    Unavailable,
    ModelsUnsupported,
    #[serde(rename = "LOCAL_AGENT_MANAGED_MCP")]
    ManagedMcp,
    #[serde(rename = "LOCAL_AGENT_SOCKS_PROXY")]
    SocksProxy,
}

#[derive(Debug)]
struct Launch {
    program: PathBuf,
    prefix: Vec<String>,
    node_dir: Option<PathBuf>,
}

// npm's standard cmd-shim template only. Never evaluate batch syntax or pass
// schema JSON through cmd.exe. Unknown/custom wrappers fail closed.
fn npm_script(shim: &str) -> Result<String, Error> {
    let lines: Vec<_> = shim
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let prefix = [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
    ];
    const NATIVE: &str =
        "\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*";
    if lines.len() == prefix.len() + 1
        && lines[..prefix.len()] == prefix
        && lines[prefix.len()] == NATIVE
    {
        return Ok("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe".into());
    }
    let node_prefix = [
        "IF EXIST \"%dp0%\\node.exe\" (",
        "SET \"_prog=%dp0%\\node.exe\"",
        ") ELSE (",
        "SET \"_prog=node\"",
        "SET PATHEXT=%PATHEXT:;.JS;=;%",
        ")",
    ];
    if lines.len() != prefix.len() + node_prefix.len() + 1
        || lines[..prefix.len()] != prefix
        || lines[prefix.len()..lines.len() - 1] != node_prefix
    {
        return Err(Error::ShimUnsupported);
    }
    let last = lines.last().ok_or(Error::ShimUnsupported)?;
    let script = last
        .strip_prefix(
            "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\",
        )
        .and_then(|line| line.strip_suffix("\" %*"))
        .ok_or(Error::ShimUnsupported)?;
    if !matches!(
        script,
        "node_modules\\@anthropic-ai\\claude-code\\cli.js"
            | "node_modules\\@openai\\codex\\bin\\codex.js"
    ) {
        return Err(Error::ShimUnsupported);
    }
    Ok(script.into())
}

async fn locate(agent: &str) -> Result<Launch, Error> {
    if agent == "claude" {
        discovery::check_managed_mcp()?;
    }
    discovery::prepare().await?;
    let definition = crate::AGENT_DEFINITIONS
        .iter()
        .find(|item| item.key == agent)
        .ok_or(Error::Unavailable)?;
    let home = dirs::home_dir().ok_or(Error::Executable)?;
    let mut sources = crate::discover_agent_sources(&home);
    sources.executable_dirs.splice(0..0, discovery::paths());
    let located = locate_in(
        definition.executables,
        &sources.executable_dirs,
        cfg!(windows),
    );
    if matches!(located, Err(Error::NotInstalled))
        && sources
            .issues
            .iter()
            .any(|issue| issue.source == crate::DetectionIssueSource::CliSearch)
    {
        return Err(Error::Executable);
    }
    located
}

#[cfg(windows)]
fn shim_launch_path(path: &std::path::Path) -> Result<PathBuf, Error> {
    // The shared helper strips verbatim prefixes, but does not convert UNC.
    // Reject that relative result instead of handing it to CreateProcess/Node.
    path.to_str().ok_or(Error::ShimUnsupported)?;
    let path = crate::commands::strip_windows_verbatim_prefix(path);
    if !path.is_absolute() {
        return Err(Error::ShimUnsupported);
    }
    Ok(path)
}

fn locate_in(names: &[&str], directories: &[PathBuf], windows: bool) -> Result<Launch, Error> {
    let mut unreadable = false;
    // Prefer a native executable across all directories, not merely in each directory.
    for suffix in if windows {
        vec![".exe", ".cmd"]
    } else {
        vec![""]
    } {
        for directory in directories
            .iter()
            .filter(|directory| directory.is_absolute())
        {
            for name in names {
                let candidate = directory.join(format!("{name}{suffix}"));
                match crate::probe_launchable_file(&candidate) {
                    Ok(true) => {}
                    Ok(false) => continue,
                    Err(error) => {
                        unreadable |=
                            !crate::windows_agent_discovery::probe_error_means_absent(&error);
                        continue;
                    }
                }
                if suffix != ".cmd" {
                    let node_dir = if !windows {
                        use std::io::Read;
                        let mut header = [0; 2];
                        let mut file =
                            std::fs::File::open(&candidate).map_err(|_| Error::Executable)?;
                        let count = file.read(&mut header).map_err(|_| Error::Executable)?;
                        if count == 2 && header == *b"#!" {
                            Some(
                                directories
                                    .iter()
                                    .filter(|dir| dir.is_absolute())
                                    .find(|dir| crate::is_launchable_file(&dir.join("node")))
                                    .ok_or(Error::Executable)?
                                    .clone(),
                            )
                        } else {
                            None
                        }
                    } else {
                        None
                    };
                    return Ok(Launch {
                        program: candidate,
                        prefix: vec![],
                        node_dir,
                    });
                }
                use std::io::Read;
                let mut text = Vec::new();
                std::fs::File::open(&candidate)
                    .map_err(|_| Error::ShimUnsupported)?
                    .take(8193)
                    .read_to_end(&mut text)
                    .map_err(|_| Error::ShimUnsupported)?;
                if text.len() > 8192 {
                    return Err(Error::ShimUnsupported);
                }
                let script =
                    npm_script(std::str::from_utf8(&text).map_err(|_| Error::ShimUnsupported)?)?;
                let native = script.ends_with("\\claude.exe");
                let script = directory
                    .join(script.replace('\\', "/"))
                    .canonicalize()
                    .map_err(|_| Error::ShimUnsupported)?;
                let root = directory
                    .canonicalize()
                    .map_err(|_| Error::ShimUnsupported)?;
                if !script.starts_with(&root) || !script.is_file() {
                    return Err(Error::ShimUnsupported);
                }
                #[cfg(windows)]
                let script = shim_launch_path(&script)?;
                if native {
                    if !crate::is_launchable_file(&script) {
                        return Err(Error::ShimUnsupported);
                    }
                    return Ok(Launch {
                        program: script,
                        prefix: vec![],
                        node_dir: None,
                    });
                }
                let node = std::iter::once(directory)
                    .chain(directories.iter())
                    .filter(|dir| dir.is_absolute())
                    .map(|dir| dir.join("node.exe"))
                    .find(|path| crate::is_launchable_file(path))
                    .ok_or(Error::ShimUnsupported)?;
                #[cfg(windows)]
                let node = shim_launch_path(&node)?;
                return Ok(Launch {
                    program: node,
                    prefix: vec![script.to_str().ok_or(Error::ShimUnsupported)?.into()],
                    node_dir: None,
                });
            }
        }
    }
    Err(if unreadable {
        Error::Executable
    } else {
        Error::NotInstalled
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Check {
    name: &'static str,
    status: &'static str,
    reason: Option<Error>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Probe {
    agent: &'static str,
    version: Option<String>,
    available: bool,
    checks: Vec<Check>,
    reason: Option<Error>,
    models_supported: bool,
}
impl Probe {
    fn new(agent: &'static str) -> Self {
        Self {
            agent,
            version: None,
            available: false,
            reason: None,
            models_supported: false,
            checks: ["executable", "version", "login", "minimalCall", "isolation"]
                .into_iter()
                .map(|name| Check {
                    name,
                    status: "skipped",
                    reason: Some(Error::Unavailable),
                })
                .collect(),
        }
    }
    fn check(&mut self, index: usize, result: Result<(), Error>) -> Result<bool, Error> {
        // A potentially surviving process must not be hidden inside a successful probe.
        if result == Err(Error::TerminationFailed) {
            return Err(Error::TerminationFailed);
        }
        self.checks[index].status = if result.is_ok() { "passed" } else { "failed" };
        self.checks[index].reason = result.err();
        if let Some(error) = result.err() {
            self.reason = Some(error);
        }
        Ok(result.is_ok())
    }
}

fn version(bytes: &[u8], agent: &str) -> Result<String, Error> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| Error::VersionUnsupported)?
        .trim();
    let number = if agent == "claude" {
        Some(text.strip_suffix(" (Claude Code)").unwrap_or(text))
    } else {
        text.strip_prefix("codex-cli ")
    }
    .ok_or(Error::VersionUnsupported)?;
    if number.len() > 32
        || number.split('.').count() != 3
        || !number
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(Error::VersionUnsupported);
    }
    Ok(number.into())
}

fn supported_claude_version(number: &str) -> bool {
    let parts: Vec<_> = number.split('.').collect();
    parts.len() == 3
        && parts[0] == "2"
        && parts[1] == "1"
        && !parts[2].is_empty()
        && parts[2].bytes().all(|byte| byte.is_ascii_digit())
        && parts[2].parse::<u64>().is_ok_and(|patch| patch >= 300)
}

async fn read_version(
    launch: &Launch,
    agent: &str,
    cancel: &mut watch::Receiver<bool>,
) -> Result<String, Error> {
    version(
        &execute(launch, &["--version".into()], b"", cancel, TIMEOUT).await?,
        agent,
    )
}
async fn login(launch: &Launch, cancel: &mut watch::Receiver<bool>) -> Result<(), Error> {
    // Deserialize only the boolean. Serde ignores email/org and we never log auth output.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Auth {
        logged_in: bool,
    }
    let bytes = execute(
        launch,
        &["auth".into(), "status".into(), "--json".into()],
        b"",
        cancel,
        TIMEOUT,
    )
    .await
    .map_err(|error| {
        if error == Error::Exit {
            Error::NotLoggedIn
        } else {
            error
        }
    })?;
    let auth: Auth = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidJson)?;
    if auth.logged_in {
        Ok(())
    } else {
        Err(Error::NotLoggedIn)
    }
}

struct Active {
    space: SpaceHandle,
    cancel: watch::Sender<bool>,
}
#[derive(Default)]
pub(crate) struct TextInferenceRunner {
    active: Mutex<HashMap<String, Active>>,
}
struct RunLease<'a> {
    runner: &'a TextInferenceRunner,
    id: String,
}
impl Drop for RunLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.runner.active.lock() {
            active.remove(&self.id);
        }
    }
}
impl TextInferenceRunner {
    fn begin(
        &self,
        id: &str,
        space: &SpaceHandle,
    ) -> Result<(RunLease<'_>, watch::Receiver<bool>), Error> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err(Error::InvalidInput);
        }
        let mut active = self.active.lock().map_err(|_| Error::Busy)?;
        if !active.is_empty() {
            return Err(Error::Busy);
        }
        let (cancel, receiver) = watch::channel(false);
        active.insert(
            id.into(),
            Active {
                space: space.clone(),
                cancel,
            },
        );
        Ok((
            RunLease {
                runner: self,
                id: id.into(),
            },
            receiver,
        ))
    }
    pub(crate) fn cancel(&self, run_id: &str, space: &SpaceHandle) -> bool {
        self.active
            .lock()
            .ok()
            .and_then(|active| {
                active
                    .get(run_id)
                    .filter(|run| run.space == *space)
                    .map(|run| run.cancel.send(true).is_ok())
            })
            .unwrap_or(false)
    }
    pub(crate) fn cancel_space(&self, space: Option<&SpaceHandle>) {
        if let Ok(active) = self.active.lock() {
            for run in active
                .values()
                .filter(|run| space.is_none_or(|space| run.space == *space))
            {
                let _ = run.cancel.send(true);
            }
        }
    }
    fn list_models(&self) -> Result<Vec<String>, Error> {
        Err(Error::ModelsUnsupported)
    }

    async fn probe(&self, cancel: &mut watch::Receiver<bool>) -> Result<Vec<Probe>, Error> {
        let mut probes = Vec::new();
        for agent in ["claude", "codex"] {
            let mut probe = Probe::new(agent);
            probe.models_supported = self.list_models().is_ok();
            let launch = locate(agent).await;
            if !probe.check(0, launch.as_ref().map(|_| ()).map_err(|error| *error))? {
                probes.push(probe);
                continue;
            }
            let launch = launch.expect("checked above");
            match read_version(&launch, agent, cancel).await {
                Ok(value) => probe.version = Some(value),
                Err(error) => {
                    probe.check(1, Err(error))?;
                    probes.push(probe);
                    continue;
                }
            }
            if agent == "codex" {
                probe.check(
                    1,
                    if probe.version.as_deref() == Some("0.162.1") {
                        Ok(())
                    } else {
                        Err(Error::VersionUnsupported)
                    },
                )?;
                probe.check(4, Err(Error::IsolationUnsupported))?;
                // Do not invoke inference/login on a CLI whose isolation is unsupported.
                probes.push(probe);
                continue;
            }
            if !probe.check(
                1,
                if probe
                    .version
                    .as_deref()
                    .is_some_and(supported_claude_version)
                {
                    Ok(())
                } else {
                    Err(Error::VersionUnsupported)
                },
            )? {
                probes.push(probe);
                continue;
            }
            probe.check(4, Ok(()))?;
            if !probe.check(2, login(&launch, cancel).await)? {
                probes.push(probe);
                continue;
            }
            let result = self
                .infer(
                    &launch,
                    TaskKind::AnalyzeSkill,
                    &Input::example(),
                    &schema(TaskKind::AnalyzeSkill),
                    cancel,
                )
                .await;
            probe.available = probe.check(3, result.map(|_| ()))?;
            probes.push(probe);
        }
        Ok(probes)
    }

    async fn infer(
        &self,
        launch: &Launch,
        kind: TaskKind,
        input: &Input,
        supplied_schema: &Value,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<Value, Error> {
        if *supplied_schema != schema(kind) {
            return Err(Error::InvalidInput);
        }
        let prompt = prompt(kind, input)?;
        let bytes = execute(
            launch,
            &arguments(supplied_schema),
            prompt.as_bytes(),
            cancel,
            TIMEOUT,
        )
        .await?;
        parse_result(&bytes, supplied_schema)
    }

    async fn run_structured(
        &self,
        agent: &str,
        kind: TaskKind,
        input: &Input,
        supplied_schema: &Value,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<Value, Error> {
        if agent != "claude" {
            return Err(Error::IsolationUnsupported);
        }
        let launch = locate(agent).await?;
        if !supported_claude_version(&read_version(&launch, agent, cancel).await?) {
            return Err(Error::VersionUnsupported);
        }
        login(&launch, cancel).await?;
        self.infer(&launch, kind, input, supplied_schema, cancel)
            .await
    }

    async fn run_avatar_draft(
        &self,
        input: &protocol::AvatarDraftInput,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<Value, Error> {
        let prompt = protocol::avatar_prompt(input)?;
        let launch = locate("claude").await?;
        if !supported_claude_version(&read_version(&launch, "claude", cancel).await?) {
            return Err(Error::VersionUnsupported);
        }
        login(&launch, cancel).await?;
        let schema = schema(TaskKind::DraftAvatarPrompt);
        let bytes = execute(
            &launch,
            &arguments(&schema),
            prompt.as_bytes(),
            cancel,
            TIMEOUT,
        )
        .await?;
        protocol::parse_avatar_result(&bytes, input)
    }
}

async fn check_space(registry: &SpaceRegistry, space: &SpaceHandle) -> Result<(), Error> {
    let session = registry
        .snapshot(false)
        .await
        .map_err(|_| Error::StaleSpace)?;
    if SpaceRegistry::handle(session.as_ref()) != *space {
        return Err(Error::StaleSpace);
    }
    if !session.is_some_and(|session| {
        session.deployment().profile() == "selfhost" && session.auth_token().is_some()
    }) {
        return Err(Error::Unavailable);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Presence {
    Current,
    Unknown,
    Departed,
}

struct SessionContinuity {
    expected: crate::runtime_env::RuntimeSession,
    unknown_since: Option<tokio::time::Instant>,
}
impl SessionContinuity {
    fn new(expected: crate::runtime_env::RuntimeSession) -> Self {
        Self {
            expected,
            unknown_since: None,
        }
    }
    fn observe(
        &mut self,
        snapshot: Result<Option<crate::runtime_env::RuntimeSession>, String>,
        now: tokio::time::Instant,
    ) -> Presence {
        match snapshot {
            Ok(session) => {
                self.unknown_since = None;
                if session.as_ref() == Some(&self.expected) {
                    Presence::Current
                } else {
                    Presence::Departed
                }
            }
            Err(_) => {
                let since = *self.unknown_since.get_or_insert(now);
                if now.duration_since(since) >= std::time::Duration::from_secs(2) {
                    Presence::Departed
                } else {
                    Presence::Unknown
                }
            }
        }
    }
}

// Registers before checking the session; the monitor also covers CLI-driven
// account changes. Await cancellation cleanup before dropping the run lease.
async fn scoped<T>(
    registry: &SpaceRegistry,
    space: &SpaceHandle,
    id: &str,
    operation: impl AsyncFnOnce(watch::Receiver<bool>) -> Result<T, Error>,
) -> Result<T, Error> {
    let (_lease, cancel) = registry.inference.begin(id, space)?;
    if registry.worker.is_quitting() {
        return Err(Error::Cancelled);
    }
    check_space(registry, space).await?;
    let initial = registry
        .snapshot(true)
        .await
        .map_err(|_| Error::StaleSpace)?
        .ok_or(Error::StaleSpace)?;
    if SpaceRegistry::handle(Some(&initial)) != *space {
        return Err(Error::StaleSpace);
    }
    let mut continuity = SessionContinuity::new(initial);
    let mut cancelled = cancel.clone();
    let work = operation(cancel);
    tokio::pin!(work);
    let monitor = async {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if continuity.observe(registry.snapshot(true).await, tokio::time::Instant::now())
                == Presence::Departed
            {
                return Err(Error::StaleSpace);
            }
        }
        #[allow(unreachable_code)]
        Ok::<(), Error>(())
    };
    let result = tokio::select! {
        biased;
        changed = monitor => {
            registry.inference.cancel(id, space);
            if matches!(work.await, Err(Error::TerminationFailed)) { return Err(Error::TerminationFailed); }
            Err(changed.err().unwrap_or(Error::StaleSpace))
        },
        result = &mut work => result,
    };
    if matches!(result, Err(Error::TerminationFailed)) {
        return result;
    }
    // Never accept a result on an unknown identity. A short read failure can
    // recover without cancelling the CLI or discarding an otherwise valid reply.
    loop {
        match continuity.observe(registry.snapshot(true).await, tokio::time::Instant::now()) {
            Presence::Current => break,
            Presence::Departed => return Err(Error::StaleSpace),
            Presence::Unknown => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
        }
    }
    if *cancelled.borrow_and_update() {
        return Err(Error::Cancelled);
    }
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeResponse {
    space: SpaceHandle,
    probes: Vec<Probe>,
}
#[tauri::command]
pub(crate) async fn local_inference_probe(
    state: tauri::State<'_, SpaceRegistry>,
    space: SpaceHandle,
    run_id: String,
) -> Result<ProbeResponse, Error> {
    let response = scoped(&state, &space, &run_id, async |mut cancel| {
        Ok(ProbeResponse {
            space: space.clone(),
            probes: state.inference.probe(&mut cancel).await?,
        })
    })
    .await?;
    let session = state
        .snapshot(false)
        .await
        .map_err(|_| Error::StaleSpace)?
        .ok_or(Error::Unavailable)?;
    if SpaceRegistry::handle(Some(&session)) != space {
        return Err(Error::StaleSpace);
    }
    state
        .worker
        .record_probe(&space, session.user_id(), &response.probes);
    Ok(response)
}

#[tauri::command]
pub(crate) async fn local_inference_run(
    state: tauri::State<'_, SpaceRegistry>,
    space: SpaceHandle,
    run_id: String,
    agent: String,
) -> Result<Value, Error> {
    // IPC accepts no arbitrary input/schema: only this fixed sample.
    let outcome = scoped(&state, &space, &run_id, async |mut cancel| {
        let started = Instant::now();
        let result = state
            .inference
            .run_structured(
                &agent,
                TaskKind::AnalyzeSkill,
                &Input::example(),
                &schema(TaskKind::AnalyzeSkill),
                &mut cancel,
            )
            .await?;
        Ok(json!({"space": space, "result": result, "elapsedMs": started.elapsed().as_millis()}))
    })
    .await;
    if let Err(error) = &outcome {
        if let Ok(Some(session)) = state.snapshot(false).await {
            if SpaceRegistry::handle(Some(&session)) == space {
                state
                    .worker
                    .record_runtime_error(&space, session.user_id(), *error);
            }
        }
    }
    outcome
}

#[tauri::command]
pub(crate) fn local_inference_cancel(
    state: tauri::State<'_, SpaceRegistry>,
    space: SpaceHandle,
    run_id: String,
) -> bool {
    state.inference.cancel(&run_id, &space)
}

#[cfg(test)]
mod tests;
