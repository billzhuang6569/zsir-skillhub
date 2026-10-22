//! Native-only, sequential local AI leases. No input or model output is emitted.
use super::{
    protocol, Error, Input, Presence, Probe, SessionContinuity, SpaceHandle, SpaceRegistry,
    TaskKind,
};
use crate::server_request::{ResponseBody, ServerResponse};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, future::Future, sync::Mutex, time::Duration};
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum State {
    Off,
    Idle,
    Running,
    Paused,
    Unavailable,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub revision: u64,
    pub space: SpaceHandle,
    pub user_id: String,
    pub state: State,
    pub completed: u64,
    pub analyzed: u64,
    pub drafted: u64,
    pub failed: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<Error>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_job_id: Option<String>,
}
impl Status {
    fn new(space: SpaceHandle, user_id: String) -> Self {
        Self {
            revision: 0,
            space,
            user_id,
            state: State::Off,
            completed: 0,
            analyzed: 0,
            drafted: 0,
            failed: 0,
            last_error: None,
            paused_reason: None,
            skill_id: None,
            avatar_job_id: None,
        }
    }
    fn set(&mut self, state: State, error: Option<Error>, reason: Option<&'static str>) {
        self.state = state;
        self.last_error = error;
        self.paused_reason = reason;
        self.skill_id = None;
        self.avatar_job_id = None;
    }
}

type Owner = (String, String);
#[derive(Clone, PartialEq, Eq)]
struct Configuration {
    session: crate::runtime_env::RuntimeSession,
    space: SpaceHandle,
    user: String,
    instance: String,
    enabled: bool,
    agent: String,
    revision: u64,
}
impl Configuration {
    fn owner(&self) -> Owner {
        (self.space.space_id.clone(), self.user.clone())
    }
}
#[derive(Default)]
struct Control {
    config: Option<Configuration>,
    started: bool,
    quitting: bool,
    revision: u64,
    status_revision: u64,
    status: HashMap<Owner, Status>,
    probes: HashMap<Owner, Result<(), Error>>,
    resumes: HashMap<Owner, u64>,
    run: Option<(SpaceHandle, String)>,
}
#[derive(Default)]
pub(crate) struct Worker {
    control: Mutex<Control>,
    exit: ExitCleanup,
}
impl Worker {
    pub(super) fn is_quitting(&self) -> bool {
        self.control.lock().map_or(true, |control| control.quitting)
    }
    pub(super) fn record_runtime_error(&self, space: &SpaceHandle, user: &str, error: Error) {
        if invalidates_probe(error) || error == Error::TerminationFailed {
            if let Ok(mut control) = self.control.lock() {
                control
                    .probes
                    .insert((space.space_id.clone(), user.into()), Err(error));
            }
        }
    }
    pub(super) fn record_probe(&self, space: &SpaceHandle, user: &str, probes: &[Probe]) {
        if let Some(probe) = probes.iter().find(|probe| probe.agent == "claude") {
            if let Ok(mut control) = self.control.lock() {
                control.probes.insert(
                    (space.space_id.clone(), user.into()),
                    if probe.available {
                        Ok(())
                    } else {
                        Err(probe.reason.unwrap_or(Error::Unavailable))
                    },
                );
                if probe.available {
                    *control
                        .resumes
                        .entry((space.space_id.clone(), user.into()))
                        .or_default() += 1;
                }
            }
        }
    }
    fn current(&self, config: &Configuration) -> bool {
        self.control
            .lock()
            .is_ok_and(|c| c.config.as_ref() == Some(config))
    }
    pub(crate) fn stop(&self, registry: &SpaceRegistry) {
        if let Ok(mut control) = self.control.lock() {
            control.revision += 1;
            control.config = None;
            if let Some((space, id)) = &control.run {
                registry.inference.cancel(id, space);
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lease {
    lease_id: String,
    #[serde(rename = "type")]
    kind: String,
    input_hash: String,
    config_version: String,
    instance_id: String,
    skill_id: Option<String>,
    avatar_job_id: Option<String>,
    // Deserialize input separately, so malformed/oversized input can be reported.
    input: Value,
}

enum TaskInput {
    Analysis(Input),
    Avatar(protocol::AvatarDraftInput),
}
impl Lease {
    fn task_input(&self, avatar_drafts: bool) -> Result<TaskInput, Error> {
        match self.kind.as_str() {
            "analyzeSkill" if self.skill_id.as_ref().is_some_and(|id| !id.is_empty()) => {
                let input = serde_json::from_value::<Input>(self.input.clone())
                    .map_err(|_| Error::InvalidInput)?;
                protocol::prompt(TaskKind::AnalyzeSkill, &input)?;
                Ok(TaskInput::Analysis(input))
            }
            "draftAvatarPrompt"
                if avatar_drafts
                    && self.config_version == protocol::AVATAR_DRAFT_CONFIG_VERSION
                    && self.avatar_job_id.as_ref().is_some_and(|id| !id.is_empty()) =>
            {
                let input =
                    serde_json::from_value::<protocol::AvatarDraftInput>(self.input.clone())
                        .map_err(|_| Error::InvalidInput)?;
                protocol::avatar_prompt(&input)?;
                Ok(TaskInput::Avatar(input))
            }
            _ => Err(Error::InvalidInput),
        }
    }
    fn accepted(&self, reply: &Reply) -> bool {
        reply.status == 200
            && if self.kind == "draftAvatarPrompt" {
                reply.body["avatarJobId"].as_str() == self.avatar_job_id.as_deref()
                    && reply.body["accepted"] == true
            } else {
                reply.body["skillId"].as_str() == self.skill_id.as_deref()
                    && reply.body["analysisStatus"] == "completed"
            }
    }
}

struct Reply {
    status: u16,
    body: Value,
    retry_after: Option<String>,
}
impl From<ServerResponse> for Reply {
    fn from(value: ServerResponse) -> Self {
        Self {
            status: value.status,
            body: match value.body {
                ResponseBody::Json(body) => body,
                _ => Value::Null,
            },
            retry_after: value.headers.get("retry-after").cloned(),
        }
    }
}
trait LeaseClient {
    fn current(&self) -> impl Future<Output = bool> + Send;
    fn ready(&self) -> impl Future<Output = bool> + Send {
        self.current()
    }
    fn user_cancelled(&self) -> impl Future<Output = bool> + Send {
        let current = self.current();
        async move { !current.await }
    }
    fn request(
        &self,
        route: &str,
        id: Option<&str>,
        body: Option<Value>,
    ) -> impl Future<Output = Result<Reply, Error>> + Send;
}
trait Runner {
    fn resume_revision(&self) -> u64;
    fn cached_probe(&self) -> Option<Result<(), Error>>;
    fn remember_probe(&self, result: Result<(), Error>);
    fn probe(&self) -> impl Future<Output = Result<(), Error>> + Send;
    fn run(&self, input: &TaskInput) -> impl Future<Output = Result<Value, Error>> + Send;
    fn publish(&self, status: &Status);
}

// Do not drop a running future: let the process-tree cancellation finish first.
async fn cancel_on_departure<T>(
    client: &impl LeaseClient,
    work: impl Future<Output = Result<T, Error>>,
    cancel: impl Fn(),
) -> Result<T, Error> {
    tokio::pin!(work);
    let monitor = async {
        loop {
            if !client.current().await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    tokio::select! {
        biased;
        _ = monitor => {
            cancel();
            match work.await { Err(Error::TerminationFailed) => Err(Error::TerminationFailed), _ => Err(Error::Cancelled) }
        }
        result = &mut work => result,
    }
}

fn invalidates_probe(error: Error) -> bool {
    matches!(
        error,
        Error::NotLoggedIn
            | Error::VersionUnsupported
            | Error::Executable
            | Error::NotInstalled
            | Error::ShimUnsupported
            | Error::ManagedMcp
            | Error::SocksProxy
    )
}
fn is_interruption(error: Error) -> bool {
    matches!(
        error,
        Error::Cancelled
            | Error::StaleSpace
            | Error::Exit
            | Error::Timeout
            | Error::Io
            | Error::Spawn
            | Error::OutputLimit
            | Error::TerminationFailed
    )
}
fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(30u64.saturating_mul(1u64 << attempt.min(5)).min(900))
}
fn retry_after(value: Option<&str>, fallback: Duration) -> Duration {
    // Server contract specifies delta-seconds. Invalid values use normal backoff.
    value
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(|seconds| Duration::from_secs(seconds.max(2)))
        .unwrap_or(fallback)
}

struct Engine {
    status: Status,
    capability_checked: bool,
    avatar_drafts: bool,
    stopped: bool,
    retries: u32,
    not_before: tokio::time::Instant,
    paid_not_before: tokio::time::Instant,
    interruptions: u8,
    resume_revision: u64,
}
impl Engine {
    fn resume(&mut self, runner: &impl Runner) {
        let revision = runner.resume_revision();
        if self.resume_revision != revision {
            self.resume_revision = revision;
            self.interruptions = 0;
            if self.status.paused_reason == Some("INTERRUPTED") {
                self.status.set(State::Idle, None, None);
                self.not_before = self.paid_not_before;
            }
        }
    }
    fn interrupted(&mut self, error: Error) -> Duration {
        self.interruptions = self.interruptions.saturating_add(1);
        // Count conservatively even if cancellation happened before the paid
        // subprocess started. Never retry sooner than 30s after interruption.
        self.paid_not_before = tokio::time::Instant::now() + Duration::from_secs(30);
        self.status.set(
            State::Paused,
            Some(error),
            Some(if self.interruptions >= 2 {
                "INTERRUPTED"
            } else {
                "INTERRUPTION_BACKOFF"
            }),
        );
        Duration::from_secs(30)
    }
    fn bind(&mut self, space: &SpaceHandle) {
        if self.status.space != *space && self.status.paused_reason == Some("SIGN_IN_REQUIRED") {
            self.stopped = false;
            self.status.set(State::Off, None, None);
            self.not_before = tokio::time::Instant::now();
        }
        self.status.space = space.clone();
    }
    fn new(space: SpaceHandle, user: String) -> Self {
        Self {
            status: Status::new(space, user),
            capability_checked: false,
            avatar_drafts: false,
            stopped: false,
            retries: 0,
            not_before: tokio::time::Instant::now(),
            paid_not_before: tokio::time::Instant::now(),
            interruptions: 0,
            resume_revision: 0,
        }
    }
    fn unavailable(&mut self, reason: &'static str) -> Duration {
        self.stopped = true;
        self.status
            .set(State::Unavailable, Some(Error::Unavailable), Some(reason));
        Duration::from_secs(60)
    }
    fn http(&mut self, reply: Result<Reply, Error>, claiming: bool) -> Duration {
        match reply {
            Ok(reply) if claiming && reply.status == 404 => self.unavailable("CAPABILITY_MISSING"),
            Ok(reply) if reply.status == 409 && reply.body["code"] == "INSTANCE_AI_CONFIGURED" => {
                self.status
                    .set(State::Unavailable, None, Some("INSTANCE_AI_CONFIGURED"));
                Duration::from_secs(600)
            }
            Ok(reply) if reply.status == 401 => {
                self.status.set(
                    State::Paused,
                    Some(Error::Unavailable),
                    Some("SIGN_IN_REQUIRED"),
                );
                self.stopped = true;
                Duration::from_secs(60)
            }
            Ok(reply) if !claiming && matches!(reply.status, 404 | 409 | 410) => {
                self.status.set(State::Idle, None, None);
                Duration::from_secs(2)
            }
            reply => {
                let fallback = backoff(self.retries);
                self.retries = self.retries.saturating_add(1);
                self.status
                    .set(State::Error, Some(Error::Io), Some("NETWORK"));
                match reply {
                    Ok(reply) if reply.status == 429 => {
                        retry_after(reply.retry_after.as_deref(), fallback)
                    }
                    _ => fallback,
                }
            }
        }
    }
    async fn step(
        &mut self,
        client: &impl LeaseClient,
        runner: &impl Runner,
        instance: &str,
    ) -> Duration {
        let delay = self.cycle(client, runner, instance).await;
        if !client.user_cancelled().await {
            runner.publish(&self.status);
        }
        delay
    }
    async fn cycle(
        &mut self,
        client: &impl LeaseClient,
        runner: &impl Runner,
        instance: &str,
    ) -> Duration {
        self.resume(runner);
        if self.stopped || !client.current().await {
            return Duration::from_secs(60);
        }
        if self.interruptions >= 2 {
            return Duration::from_secs(60);
        }
        let remaining = self
            .paid_not_before
            .saturating_duration_since(tokio::time::Instant::now());
        if !remaining.is_zero() {
            return remaining;
        }
        // Unknown identity may keep an existing subprocess alive, but may not
        // authorize another paid call or a new lease.
        if !client.ready().await {
            return Duration::from_millis(100);
        }
        if !self.capability_checked {
            self.capability_checked = true;
            match client.request("health", None, None).await {
                Ok(reply)
                    if reply.status == 200 && reply.body["features"]["localAiLeases"] == true =>
                {
                    self.avatar_drafts = reply.body["features"]["localAiAvatarDrafts"] == true;
                }
                _ => return self.unavailable("CAPABILITY_MISSING"),
            }
        }
        if !client.current().await {
            return Duration::from_secs(2);
        }
        let probe = match runner.cached_probe() {
            Some(result) => result,
            None => {
                self.status.set(State::Paused, None, Some("CHECKING"));
                runner.publish(&self.status);
                let result = runner.probe().await;
                if let Err(error) = result {
                    if is_interruption(error) && !client.user_cancelled().await {
                        let delay = self.interrupted(error);
                        if error == Error::TerminationFailed {
                            runner.remember_probe(Err(error));
                            self.status
                                .set(State::Paused, Some(error), Some("PROBE_REQUIRED"));
                        }
                        return delay;
                    }
                } else {
                    self.interruptions = 0;
                }
                if !matches!(
                    result,
                    Err(Error::Busy | Error::Cancelled | Error::StaleSpace)
                ) {
                    runner.remember_probe(result);
                }
                result
            }
        };
        if let Err(error) = probe {
            self.status.set(
                State::Paused,
                Some(error),
                Some(if error == Error::Busy {
                    "BUSY"
                } else {
                    "PROBE_REQUIRED"
                }),
            );
            return Duration::from_secs(2);
        }
        if !client.current().await {
            return Duration::from_secs(2);
        }
        let reply = client
            .request(
                "localAi.claim",
                None,
                Some(json!({"types": if self.avatar_drafts {
                    vec!["draftAvatarPrompt", "analyzeSkill"]
                } else { vec!["analyzeSkill"] }})),
            )
            .await;
        let reply = match reply {
            Ok(reply) if reply.status == 204 => {
                self.retries = 0;
                self.status.set(State::Idle, None, None);
                return Duration::from_secs(60);
            }
            Ok(reply) if reply.status == 200 => reply,
            other => return self.http(other, true),
        };
        let lease: Lease = match serde_json::from_value(reply.body) {
            Ok(lease) => lease,
            Err(_) => {
                let _ = client.request("localAi.releaseAll", None, None).await;
                return self.unavailable("INVALID_LEASE");
            }
        };
        if lease.instance_id.is_empty() || lease.instance_id != instance {
            let _ = client
                .request("localAi.release", Some(&lease.lease_id), None)
                .await;
            return self.unavailable("INSTANCE_MISMATCH");
        }
        if !client.current().await {
            let _ = client
                .request("localAi.release", Some(&lease.lease_id), None)
                .await;
            return Duration::from_secs(2);
        }
        let input = lease.task_input(self.avatar_drafts);
        self.status.set(State::Running, None, None);
        runner.publish(&self.status);
        let result = match input {
            Ok(input) => runner.run(&input).await.and_then(|value| match &input {
                TaskInput::Avatar(input) => protocol::validate_avatar_result(value, input),
                TaskInput::Analysis(_) => Ok(value),
            }),
            Err(error) => Err(error),
        };
        let interruption = result
            .as_ref()
            .err()
            .copied()
            .filter(|error| is_interruption(*error));
        let unexpected = interruption.is_some() && !client.user_cancelled().await;
        if !client.current().await
            || matches!(
                result,
                Err(Error::Cancelled | Error::StaleSpace | Error::Busy)
            )
        {
            let _ = client
                .request("localAi.release", Some(&lease.lease_id), None)
                .await;
            if unexpected {
                return self.interrupted(interruption.unwrap());
            }
            self.status.set(State::Paused, result.err(), Some("BUSY"));
            return Duration::from_secs(2);
        }
        match result {
            Ok(value) => {
                self.interruptions = 0;
                let mut body =
                    json!({"inputHash": lease.input_hash, "configVersion": lease.config_version});
                if lease.kind == "draftAvatarPrompt" {
                    body["prompt"] = value["prompt"].clone();
                } else {
                    body["profile"] = value;
                }
                let reply = client
                    .request("localAi.result", Some(&lease.lease_id), Some(body))
                    .await;
                match reply {
                    Ok(reply) if lease.accepted(&reply) => {
                        self.retries = 0;
                        self.status.set(State::Idle, None, None);
                        if lease.kind == "draftAvatarPrompt" {
                            self.status.drafted += 1;
                            self.status.avatar_job_id = lease.avatar_job_id;
                        } else {
                            // completed retains its pre-#407 meaning: analyzed Skills.
                            self.status.completed += 1;
                            self.status.analyzed += 1;
                            self.status.skill_id = lease.skill_id;
                        }
                        Duration::from_secs(2)
                    }
                    other => self.http(other, false),
                }
            }
            Err(error) => {
                if invalidates_probe(error) || error == Error::TerminationFailed {
                    runner.remember_probe(Err(error));
                }
                // Local configuration errors are not Server task-failure codes.
                if matches!(error, Error::ManagedMcp | Error::SocksProxy) {
                    let _ = client
                        .request("localAi.release", Some(&lease.lease_id), None)
                        .await;
                    self.status
                        .set(State::Paused, Some(error), Some("PROBE_REQUIRED"));
                    return Duration::from_secs(30);
                }
                let reply = client
                    .request(
                        "localAi.failure",
                        Some(&lease.lease_id),
                        Some(json!({"code": error})),
                    )
                    .await;
                if reply
                    .as_ref()
                    .is_ok_and(|reply| reply.status == 409 && reply.body["code"] == "LEASE_STALE")
                {
                    // The server may already have selected its direct fallback.
                    self.status.set(State::Idle, None, None);
                    if unexpected {
                        // Keep the paid-call safety budget even for stale work.
                        self.interrupted(error);
                        self.status.last_error = None;
                        return Duration::from_secs(30);
                    }
                    return Duration::from_secs(2);
                }
                self.status.failed += 1;
                let delay = match reply {
                    Ok(reply) if reply.status == 204 => Duration::from_secs(2),
                    other => self.http(other, false),
                };
                if unexpected && !self.stopped {
                    return delay.max(self.interrupted(error));
                }
                if self.stopped || self.status.state == State::Unavailable {
                    return delay;
                }
                self.status.set(
                    if invalidates_probe(error) || error == Error::TerminationFailed {
                        State::Paused
                    } else {
                        State::Error
                    },
                    Some(error),
                    if invalidates_probe(error) || error == Error::TerminationFailed {
                        Some("PROBE_REQUIRED")
                    } else {
                        None
                    },
                );
                delay
            }
        }
    }
}

struct Native<'a> {
    registry: &'a SpaceRegistry,
    app: &'a tauri::AppHandle,
    config: &'a Configuration,
    continuity: &'a Mutex<SessionContinuity>,
}
impl Native<'_> {
    async fn presence(&self) -> Presence {
        if !self.registry.worker.current(self.config) {
            return Presence::Departed;
        }
        let snapshot = self.registry.snapshot(true).await;
        self.continuity
            .lock()
            .map_or(Presence::Departed, |mut state| {
                state.observe(snapshot, tokio::time::Instant::now())
            })
    }
}
impl LeaseClient for Native<'_> {
    async fn current(&self) -> bool {
        self.presence().await != Presence::Departed
    }
    async fn ready(&self) -> bool {
        self.presence().await == Presence::Current
    }
    async fn user_cancelled(&self) -> bool {
        if !self.registry.worker.current(self.config) {
            return true;
        }
        self.registry
            .snapshot(true)
            .await
            .is_ok_and(|session| session.as_ref() != Some(&self.config.session))
    }
    async fn request(
        &self,
        route: &str,
        id: Option<&str>,
        body: Option<Value>,
    ) -> Result<Reply, Error> {
        if !matches!(route, "localAi.release" | "localAi.releaseAll") && !self.ready().await {
            return Err(Error::StaleSpace);
        }
        self.registry
            .local_ai_request(&self.config.space, route, id, body)
            .await
            .map(Reply::from)
            .map_err(|_| Error::Io)
    }
}
impl Native<'_> {
    async fn operation(&self, input: Option<&TaskInput>) -> Result<Value, Error> {
        if !self.ready().await {
            return Err(Error::StaleSpace);
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.registry
            .worker
            .control
            .lock()
            .map_err(|_| Error::Unavailable)?
            .run = Some((self.config.space.clone(), id.clone()));
        let work = super::scoped(
            self.registry,
            &self.config.space,
            &id,
            async |mut cancel| {
                // scoped registers cancellation before this check. In particular, a
                // stop before the first poll must never start a paid CLI invocation.
                if !self.ready().await {
                    return Err(Error::Cancelled);
                }
                if let Some(input) = input {
                    match input {
                        TaskInput::Avatar(input) => {
                            self.registry
                                .inference
                                .run_avatar_draft(input, &mut cancel)
                                .await
                        }
                        TaskInput::Analysis(input) => {
                            self.registry
                                .inference
                                .run_structured(
                                    "claude",
                                    TaskKind::AnalyzeSkill,
                                    input,
                                    &protocol::schema(TaskKind::AnalyzeSkill),
                                    &mut cancel,
                                )
                                .await
                        }
                    }
                } else {
                    let probes = self.registry.inference.probe(&mut cancel).await?;
                    let probe = probes
                        .iter()
                        .find(|probe| probe.agent == "claude")
                        .ok_or(Error::Unavailable)?;
                    if probe.available {
                        Ok(Value::Null)
                    } else {
                        Err(probe.reason.unwrap_or(Error::Unavailable))
                    }
                }
            },
        );
        let result = cancel_on_departure(self, work, || {
            self.registry.inference.cancel(&id, &self.config.space);
        })
        .await;
        self.registry
            .worker
            .control
            .lock()
            .map_err(|_| Error::Unavailable)?
            .run = None;
        result
    }
}
impl Runner for Native<'_> {
    fn resume_revision(&self) -> u64 {
        self.registry
            .worker
            .control
            .lock()
            .ok()
            .and_then(|c| c.resumes.get(&self.config.owner()).copied())
            .unwrap_or(0)
    }
    fn cached_probe(&self) -> Option<Result<(), Error>> {
        self.registry
            .worker
            .control
            .lock()
            .ok()?
            .probes
            .get(&self.config.owner())
            .copied()
    }
    fn remember_probe(&self, result: Result<(), Error>) {
        if let Ok(mut control) = self.registry.worker.control.lock() {
            control.probes.insert(self.config.owner(), result);
        }
    }
    async fn probe(&self) -> Result<(), Error> {
        self.operation(None).await.map(|_| ())
    }
    async fn run(&self, input: &TaskInput) -> Result<Value, Error> {
        self.operation(Some(input)).await
    }
    fn publish(&self, status: &Status) {
        if let Ok(mut control) = self.registry.worker.control.lock() {
            if control.config.as_ref() != Some(self.config) {
                return;
            }
            let mut saved = status.clone();
            saved.skill_id = None;
            saved.avatar_job_id = None;
            saved.revision = control
                .status
                .get(&self.config.owner())
                .map_or(0, |old| old.revision);
            if status.skill_id.is_none()
                && status.avatar_job_id.is_none()
                && control.status.get(&self.config.owner()) == Some(&saved)
            {
                return;
            }
            control.status_revision += 1;
            saved.revision = control.status_revision;
            control.status.insert(self.config.owner(), saved.clone());
            saved.skill_id = status.skill_id.clone();
            saved.avatar_job_id = status.avatar_job_id.clone();
            let _ = self.app.emit("local-inference-worker", saved);
        }
    }
}

async fn drive(app: tauri::AppHandle) {
    let registry = app.state::<SpaceRegistry>();
    let mut engines: HashMap<Owner, Engine> = HashMap::new();
    let mut observation: Option<(Configuration, Mutex<SessionContinuity>)> = None;
    loop {
        let config = registry
            .worker
            .control
            .lock()
            .ok()
            .and_then(|c| c.config.clone());
        let Some(config) = config else {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        if observation
            .as_ref()
            .is_none_or(|(previous, _)| previous != &config)
        {
            observation = Some((
                config.clone(),
                Mutex::new(SessionContinuity::new(config.session.clone())),
            ));
        }
        let native = Native {
            registry: &registry,
            app: &app,
            config: &config,
            continuity: &observation.as_ref().unwrap().1,
        };
        let engine = engines
            .entry(config.owner())
            .or_insert_with(|| Engine::new(config.space.clone(), config.user.clone()));
        engine.bind(&config.space);
        engine.resume(&native);
        if !native.current().await {
            if native.user_cancelled().await {
                let _ = native.request("localAi.releaseAll", None, None).await;
                if let Ok(mut control) = registry.worker.control.lock() {
                    if control.config.as_ref() == Some(&config) {
                        control.config = None;
                    }
                }
            }
            // A prolonged unreadable session cancels work, but retains the
            // desired configuration and breaker. Only positive departure can
            // remove it; recovery cannot reset the paid-call cooldown.
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        // Keep server backoff across pause/resume and preference notifications.
        // Configuration changes cancel work, but do not reset a retry budget.
        if config.enabled && config.agent == "claude" {
            while native.current().await && tokio::time::Instant::now() < engine.not_before {
                engine.resume(&native);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            if !native.current().await {
                let _ = native.request("localAi.releaseAll", None, None).await;
                continue;
            }
        }
        let delay = if !config.enabled || config.agent != "claude" {
            let mut off = engine.status.clone();
            off.set(State::Off, None, None);
            native.publish(&off);
            Duration::from_secs(60)
        } else {
            engine.step(&native, &native, &config.instance).await
        };
        let now = tokio::time::Instant::now();
        let deadline = now
            .checked_add(delay)
            .unwrap_or(now + Duration::from_secs(900));
        if config.enabled && config.agent == "claude" {
            engine.not_before = deadline;
        }
        while native.current().await && tokio::time::Instant::now() < deadline {
            if native.resume_revision() != engine.resume_revision {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if !native.current().await {
            // Same old handle only; if it has expired the native transport refuses it.
            let _ = native.request("localAi.releaseAll", None, None).await;
        }
    }
}

#[tauri::command]
pub(crate) async fn local_inference_worker_configure(
    app: tauri::AppHandle,
    state: tauri::State<'_, SpaceRegistry>,
    space: SpaceHandle,
    enabled: bool,
    agent: String,
) -> Result<(), Error> {
    super::check_space(&state, &space).await?;
    if !matches!(agent.as_str(), "claude" | "codex") {
        return Err(Error::InvalidInput);
    }
    let session = state
        .snapshot(false)
        .await
        .map_err(|_| Error::StaleSpace)?
        .ok_or(Error::Unavailable)?;
    if SpaceRegistry::handle(Some(&session)) != space {
        return Err(Error::StaleSpace);
    }
    let crate::spaces::Deployment::Selfhost { instance, .. } = session.deployment() else {
        return Err(Error::Unavailable);
    };
    let mut control = state
        .worker
        .control
        .lock()
        .map_err(|_| Error::Unavailable)?;
    if control.quitting {
        return Err(Error::Unavailable);
    }
    let mut config = Configuration {
        session: session.clone(),
        space,
        user: session.user_id().into(),
        instance: instance.id.clone(),
        enabled,
        agent,
        revision: control.revision,
    };
    *control.resumes.entry(config.owner()).or_default() += 1;
    if control.config.as_ref() == Some(&config) {
        return Ok(());
    }
    control.revision += 1;
    config.revision = control.revision;
    if let Some((space, id)) = &control.run {
        state.inference.cancel(id, space);
    }
    control.config = Some(config);
    if !control.started {
        control.started = true;
        tauri::async_runtime::spawn(drive(app));
    }
    Ok(())
}

trait ExitRuntime {
    /// Stop new work and cancel all registered inference before waiting.
    fn stop(&self) -> Option<SpaceHandle>;
    fn running(&self) -> bool;
    fn release(&self, space: &SpaceHandle) -> impl Future<Output = ()> + Send;
}

const EXIT_PROCESS_LIMIT: Duration = Duration::from_secs(3);
const EXIT_RELEASE_LIMIT: Duration = Duration::from_secs(2);

#[derive(Default)]
struct ExitCleanup {
    done: tokio::sync::OnceCell<()>,
}
impl ExitCleanup {
    async fn run(
        &self,
        runtime: &impl ExitRuntime,
        process_limit: Duration,
        release_limit: Duration,
    ) {
        self.done
            .get_or_init(|| async {
                let space = runtime.stop();
                // Cancellation uses the existing TERM -> 2s grace -> KILL / Job
                // implementation. Never drop that process future just to exit early.
                let _ = tokio::time::timeout(process_limit, async {
                    while runtime.running() {
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                })
                .await;
                if let Some(space) = space {
                    let _ = tokio::time::timeout(release_limit, runtime.release(&space)).await;
                }
            })
            .await;
    }
}

impl ExitRuntime for SpaceRegistry {
    fn stop(&self) -> Option<SpaceHandle> {
        let space = self.worker.control.lock().ok().and_then(|mut control| {
            control.quitting = true;
            control.config.as_ref().map(|config| config.space.clone())
        });
        self.worker.stop(self);
        self.inference.cancel_space(None);
        space
    }
    fn running(&self) -> bool {
        !self
            .inference
            .active
            .lock()
            .is_ok_and(|active| active.is_empty())
    }
    async fn release(&self, space: &SpaceHandle) {
        // Use the captured session handle, never a new account's credentials.
        let _ = self
            .local_ai_request(space, "localAi.releaseAll", None, None)
            .await;
    }
}

/// Both exit events wait here; Exit may be the only event on macOS NSApp terminate.
pub(crate) fn cleanup_exit(app: &tauri::AppHandle) {
    let registry = app.state::<SpaceRegistry>();
    if registry.worker.exit.done.get().is_some() {
        return;
    }
    // GUI run() is synchronous (no tokio::main / async_runtime::set). In locked
    // tao 0.35.3, macOS EventLoop::run_return requires MainThreadMarker and
    // applicationWillTerminate -> AppState::exit dispatches LoopDestroyed inline.
    // tauri-runtime-wry maps that to Exit, and Tauri 2.11.5 invokes this callback
    // before cleanup/restart. This is the OS event-loop thread, NOT a Tokio worker:
    // block_on can wait while Tauri's separate multithread runtime reaps children
    // and performs HTTP. Do not move this wrapper into an async runtime task.
    debug_assert!(tokio::runtime::Handle::try_current().is_err());
    tauri::async_runtime::block_on(registry.worker.exit.run(
        &*registry,
        EXIT_PROCESS_LIMIT,
        EXIT_RELEASE_LIMIT,
    ));
}

#[tauri::command]
pub(crate) async fn local_inference_worker_status(
    state: tauri::State<'_, SpaceRegistry>,
    space: SpaceHandle,
) -> Result<Status, Error> {
    super::check_space(&state, &space).await?;
    let session = state
        .snapshot(false)
        .await
        .map_err(|_| Error::StaleSpace)?
        .ok_or(Error::Unavailable)?;
    if SpaceRegistry::handle(Some(&session)) != space {
        return Err(Error::StaleSpace);
    }
    let user = session.user_id().to_string();
    let control = state
        .worker
        .control
        .lock()
        .map_err(|_| Error::Unavailable)?;
    Ok(control
        .status
        .get(&(space.space_id.clone(), user.clone()))
        .filter(|status| status.space == space)
        .cloned()
        .unwrap_or_else(|| Status::new(space, user)))
}

#[cfg(test)]
mod tests;
