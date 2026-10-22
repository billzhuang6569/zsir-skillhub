use super::*;
use std::{
    collections::VecDeque,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

type Call = (String, Option<String>, Option<Value>);
struct Fake {
    active: AtomicBool,
    ready: AtomicBool,
    replies: Mutex<VecDeque<Result<Reply, Error>>>,
    calls: Mutex<Vec<Call>>,
    cached: Mutex<Option<Result<(), Error>>>,
    result: Mutex<Result<Value, Error>>,
    runs: AtomicUsize,
    probes: AtomicUsize,
    probe_result: Mutex<Result<(), Error>>,
    resume: AtomicUsize,
    depart_in_run: bool,
    events: Mutex<Vec<Status>>,
}
fn reply(status: u16, body: Value) -> Result<Reply, Error> {
    Ok(Reply {
        status,
        body,
        retry_after: None,
    })
}
fn lease() -> Value {
    json!({"leaseId":"lease", "type":"analyzeSkill", "inputHash":"hash", "configVersion":"v1", "instanceId":"instance", "skillId":"skill", "input":Input::example()})
}
impl Fake {
    fn new(replies: Vec<Result<Reply, Error>>) -> Self {
        Self {
            active: AtomicBool::new(true),
            ready: AtomicBool::new(true),
            replies: Mutex::new(replies.into()),
            calls: Mutex::new(vec![]),
            cached: Mutex::new(Some(Ok(()))),
            result: Mutex::new(Ok(json!({"profile":"fixture"}))),
            runs: AtomicUsize::new(0),
            probes: AtomicUsize::new(0),
            probe_result: Mutex::new(Ok(())),
            resume: AtomicUsize::new(0),
            depart_in_run: false,
            events: Mutex::new(vec![]),
        }
    }
    fn routes(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|call| call.0.clone())
            .collect()
    }
}
impl LeaseClient for Fake {
    async fn current(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
    async fn ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst) && self.current().await
    }
    async fn request(
        &self,
        route: &str,
        id: Option<&str>,
        body: Option<Value>,
    ) -> Result<Reply, Error> {
        self.calls
            .lock()
            .unwrap()
            .push((route.into(), id.map(str::to_owned), body));
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| reply(204, Value::Null))
    }
}
impl Runner for Fake {
    fn resume_revision(&self) -> u64 {
        self.resume.load(Ordering::SeqCst) as u64
    }
    fn cached_probe(&self) -> Option<Result<(), Error>> {
        *self.cached.lock().unwrap()
    }
    fn remember_probe(&self, result: Result<(), Error>) {
        *self.cached.lock().unwrap() = Some(result);
    }
    async fn probe(&self) -> Result<(), Error> {
        self.probes.fetch_add(1, Ordering::SeqCst);
        *self.probe_result.lock().unwrap()
    }
    async fn run(&self, _: &TaskInput) -> Result<Value, Error> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        if self.depart_in_run {
            self.active.store(false, Ordering::SeqCst);
        }
        self.result.lock().unwrap().clone()
    }
    fn publish(&self, status: &Status) {
        self.events.lock().unwrap().push(status.clone());
    }
}
fn engine() -> Engine {
    let mut engine = Engine::new(
        SpaceHandle {
            space_id: "selfhost".into(),
            generation: 1,
        },
        "user".into(),
    );
    engine.capability_checked = true;
    engine
}

fn draft_lease() -> Value {
    json!({"leaseId":"draft-lease", "type":"draftAvatarPrompt", "inputHash":"draft-hash",
        "configVersion":"draftAvatarPrompt.v1", "instanceId":"instance", "avatarJobId":"job",
        "input":{"name":"weekly", "description":"reports", "scenarios":["weekly review"],
            "brief":"Use geometric shapes.", "constraints":{"minLength":300,"maxLength":12000,"language":"en","mustInclude":null}}})
}

#[tokio::test]
async fn avatar_capability_requires_boolean_true_and_controls_claim_types() {
    for flag in [Value::Null, json!(false), json!("true"), json!(true)] {
        let fake = Fake::new(vec![reply(
            200,
            json!({"features":{"localAiLeases":true,"localAiAvatarDrafts":flag}}),
        )]);
        let mut engine = engine();
        engine.capability_checked = false;
        engine.step(&fake, &fake, "instance").await;
        let expected = if flag == true {
            json!(["draftAvatarPrompt", "analyzeSkill"])
        } else {
            json!(["analyzeSkill"])
        };
        assert_eq!(
            fake.calls.lock().unwrap()[1].2,
            Some(json!({"types":expected}))
        );
    }
}

#[tokio::test]
async fn draft_success_submits_prompt_and_counts_only_acknowledged_drafts() {
    let fake = Fake::new(vec![
        reply(200, draft_lease()),
        reply(200, json!({"avatarJobId":"job","accepted":true})),
        reply(200, lease()),
        reply(200, json!({"skillId":"skill","analysisStatus":"completed"})),
    ]);
    let prompt = "A quiet geometric composition. ".repeat(20);
    *fake.result.lock().unwrap() = Ok(json!({"prompt":prompt}));
    let mut engine = engine();
    engine.avatar_drafts = true;
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(
        (
            engine.status.completed,
            engine.status.analyzed,
            engine.status.drafted,
            engine.status.failed
        ),
        (0, 0, 1, 0)
    );
    assert_eq!(engine.status.avatar_job_id.as_deref(), Some("job"));
    assert!(engine.status.skill_id.is_none());
    assert_eq!(
        fake.calls.lock().unwrap()[1],
        (
            "localAi.result".into(),
            Some("draft-lease".into()),
            Some(
                json!({"inputHash":"draft-hash","configVersion":"draftAvatarPrompt.v1","prompt":prompt.trim()})
            )
        )
    );
    *fake.result.lock().unwrap() = Ok(json!({"profile":"fixture"}));
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(
        (
            engine.status.completed,
            engine.status.analyzed,
            engine.status.drafted
        ),
        (1, 1, 1)
    );
    assert!(engine.status.avatar_job_id.is_none());
    assert_eq!(engine.status.skill_id.as_deref(), Some("skill"));
}

#[tokio::test]
async fn draft_invalid_leases_never_start_inference() {
    for (field, value) in [
        ("configVersion", json!("draftAvatarPrompt.v2")),
        ("avatarJobId", Value::Null),
        ("avatarJobId", json!("")),
        ("type", json!("unknown")),
    ] {
        let mut lease = draft_lease();
        lease[field] = value;
        let fake = Fake::new(vec![reply(200, lease)]);
        let mut engine = engine();
        engine.avatar_drafts = true;
        engine.step(&fake, &fake, "instance").await;
        assert_eq!(fake.runs.load(Ordering::SeqCst), 0);
        assert_eq!(
            fake.calls.lock().unwrap()[1].2,
            Some(json!({"code":"INVALID_INPUT"}))
        );
    }
    let fake = Fake::new(vec![reply(200, draft_lease())]);
    engine().step(&fake, &fake, "instance").await;
    assert_eq!(
        fake.runs.load(Ordering::SeqCst),
        0,
        "unadvertised type rejected"
    );
    let fake = Fake::new(vec![reply(200, draft_lease())]);
    let mut engine = engine();
    engine.avatar_drafts = true;
    engine.step(&fake, &fake, "other-instance").await;
    assert_eq!(fake.routes(), ["localAi.claim", "localAi.release"]);
    assert_eq!(fake.runs.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn local_configuration_errors_release_without_sending_unknown_server_codes() {
    for error in [Error::ManagedMcp, Error::SocksProxy] {
        let fake = Fake::new(vec![reply(200, lease())]);
        *fake.result.lock().unwrap() = Err(error);
        let mut engine = engine();
        engine.step(&fake, &fake, "instance").await;
        assert_eq!(fake.routes(), ["localAi.claim", "localAi.release"]);
        assert_eq!(engine.status.state, State::Paused);
        assert_eq!(engine.status.last_error, Some(error));
        assert_eq!(engine.status.failed, 0);
        assert_eq!(*fake.cached.lock().unwrap(), Some(Err(error)));
    }
}

#[tokio::test]
async fn draft_errors_report_failures_but_cancellation_and_departure_release() {
    for error in [
        Error::Model,
        Error::InvalidResult,
        Error::Cancelled,
        Error::StaleSpace,
        Error::Busy,
    ] {
        let fake = Fake::new(vec![reply(200, draft_lease())]);
        *fake.result.lock().unwrap() = Err(error);
        let mut engine = engine();
        engine.avatar_drafts = true;
        engine.step(&fake, &fake, "instance").await;
        let release = matches!(error, Error::Cancelled | Error::StaleSpace | Error::Busy);
        assert_eq!(
            fake.routes(),
            [
                "localAi.claim",
                if release {
                    "localAi.release"
                } else {
                    "localAi.failure"
                }
            ]
        );
        assert_eq!(engine.status.failed, u64::from(!release));
        if !release {
            assert_eq!(fake.calls.lock().unwrap()[1].2, Some(json!({"code":error})));
        }
    }
    let mut fake = Fake::new(vec![reply(200, draft_lease())]);
    fake.depart_in_run = true;
    *fake.result.lock().unwrap() = Ok(json!({"prompt":"a".repeat(300)}));
    let mut engine = engine();
    engine.avatar_drafts = true;
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(fake.routes(), ["localAi.claim", "localAi.release"]);
    assert_eq!(
        (
            engine.status.drafted,
            engine.status.failed,
            engine.interruptions
        ),
        (0, 0, 0)
    );
}

#[tokio::test]
async fn draft_stale_result_or_failure_is_normal_and_invalid_output_is_not_submitted() {
    for result in [Ok(json!({"prompt":"a".repeat(300)})), Err(Error::Model)] {
        let fake = Fake::new(vec![
            reply(200, draft_lease()),
            reply(409, json!({"code":"LEASE_STALE"})),
        ]);
        *fake.result.lock().unwrap() = result;
        let mut engine = engine();
        engine.avatar_drafts = true;
        assert_eq!(
            engine.step(&fake, &fake, "instance").await,
            Duration::from_secs(2)
        );
        assert_eq!(engine.status.state, State::Idle);
        assert_eq!((engine.status.drafted, engine.status.failed), (0, 0));
        assert_eq!(engine.status.last_error, None);
    }
    let fake = Fake::new(vec![reply(200, draft_lease())]);
    *fake.result.lock().unwrap() = Ok(json!({"prompt":"bad"}));
    let mut engine = engine();
    engine.avatar_drafts = true;
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(
        fake.calls.lock().unwrap()[1].2,
        Some(json!({"code":"INVALID_RESULT"}))
    );
}

#[tokio::test]
async fn drafts_reuse_probe_gate_and_paid_interruption_breaker() {
    let fake = Fake::new(vec![
        reply(200, draft_lease()),
        reply(204, Value::Null),
        reply(200, draft_lease()),
    ]);
    let mut engine = engine();
    engine.avatar_drafts = true;
    *fake.cached.lock().unwrap() = Some(Err(Error::NotLoggedIn));
    engine.step(&fake, &fake, "instance").await;
    assert!(fake.routes().is_empty());
    fake.remember_probe(Ok(()));
    *fake.result.lock().unwrap() = Err(Error::Timeout);
    assert_eq!(
        engine.step(&fake, &fake, "instance").await,
        Duration::from_secs(30)
    );
    assert!(engine.step(&fake, &fake, "instance").await > Duration::from_secs(29));
    assert_eq!(fake.runs.load(Ordering::SeqCst), 1);
    engine.paid_not_before = tokio::time::Instant::now();
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(engine.status.paused_reason, Some("INTERRUPTED"));
    engine.paid_not_before = tokio::time::Instant::now();
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(fake.runs.load(Ordering::SeqCst), 2);
    assert_eq!(engine.status.failed, 2);
}

#[tokio::test]
async fn draft_success_ack_must_match_job_and_missing_instance_releases_all() {
    for ack in [
        json!({"avatarJobId":"other","accepted":true}),
        json!({"avatarJobId":"job","accepted":false}),
    ] {
        let fake = Fake::new(vec![reply(200, draft_lease()), reply(200, ack)]);
        *fake.result.lock().unwrap() = Ok(json!({"prompt":"a".repeat(300)}));
        let mut engine = engine();
        engine.avatar_drafts = true;
        engine.step(&fake, &fake, "instance").await;
        assert_eq!(engine.status.drafted, 0);
        assert!(engine.status.avatar_job_id.is_none());
    }
    let mut lease = draft_lease();
    lease.as_object_mut().unwrap().remove("instanceId");
    let fake = Fake::new(vec![reply(200, lease)]);
    let mut engine = engine();
    engine.avatar_drafts = true;
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(fake.routes(), ["localAi.claim", "localAi.releaseAll"]);
    assert_eq!(fake.runs.load(Ordering::SeqCst), 0);
}

struct FakeExit {
    configured: bool,
    process_delay: Duration,
    release_delay: Duration,
    stopped_at: Mutex<Option<tokio::time::Instant>>,
    calls: Mutex<Vec<&'static str>>,
    released: AtomicBool,
}
impl FakeExit {
    fn new(configured: bool) -> Self {
        Self {
            configured,
            process_delay: Duration::ZERO,
            release_delay: Duration::ZERO,
            stopped_at: Mutex::new(None),
            calls: Mutex::new(vec![]),
            released: AtomicBool::new(false),
        }
    }
}
impl ExitRuntime for FakeExit {
    fn stop(&self) -> Option<SpaceHandle> {
        self.calls.lock().unwrap().push("stop-and-cancel");
        *self.stopped_at.lock().unwrap() = Some(tokio::time::Instant::now());
        self.configured.then(|| SpaceHandle {
            space_id: "captured-space".into(),
            generation: 7,
        })
    }
    fn running(&self) -> bool {
        self.stopped_at
            .lock()
            .unwrap()
            .expect("must stop before waiting")
            .elapsed()
            < self.process_delay
    }
    async fn release(&self, space: &SpaceHandle) {
        assert_eq!(space.space_id, "captured-space");
        assert_eq!(space.generation, 7);
        self.calls.lock().unwrap().push("release");
        tokio::time::sleep(self.release_delay).await;
        self.released.store(true, Ordering::SeqCst);
    }
}

#[test]
fn direct_exit_synchronously_waits_for_cleanup_once_on_non_runtime_thread() {
    assert!(tokio::runtime::Handle::try_current().is_err());
    let cleanup = ExitCleanup::default();
    let mut runtime = FakeExit::new(true);
    runtime.process_delay = Duration::from_millis(30);
    tauri::async_runtime::block_on(cleanup.run(&runtime, EXIT_PROCESS_LIMIT, EXIT_RELEASE_LIMIT));
    assert!(!runtime.running());
    assert!(runtime.released.load(Ordering::SeqCst));
    // A second Exit notification must not cancel or release again.
    tauri::async_runtime::block_on(cleanup.run(&runtime, EXIT_PROCESS_LIMIT, EXIT_RELEASE_LIMIT));
    assert_eq!(
        *runtime.calls.lock().unwrap(),
        ["stop-and-cancel", "release"]
    );
}

#[tokio::test]
async fn exit_requested_then_exit_share_one_cleanup_even_when_overlapping() {
    let cleanup = ExitCleanup::default();
    let mut runtime = FakeExit::new(true);
    runtime.release_delay = Duration::from_millis(20);
    let exit_requested = cleanup.run(&runtime, EXIT_PROCESS_LIMIT, EXIT_RELEASE_LIMIT);
    let exit = cleanup.run(&runtime, EXIT_PROCESS_LIMIT, EXIT_RELEASE_LIMIT);
    tokio::join!(exit_requested, exit);
    cleanup
        .run(&runtime, EXIT_PROCESS_LIMIT, EXIT_RELEASE_LIMIT)
        .await;
    assert_eq!(
        *runtime.calls.lock().unwrap(),
        ["stop-and-cancel", "release"]
    );
    assert!(cleanup.done.get().is_some());
}

#[tokio::test]
async fn shutdown_process_and_release_timeouts_are_bounded_and_not_retried() {
    assert_eq!(EXIT_PROCESS_LIMIT, Duration::from_secs(3));
    assert_eq!(EXIT_RELEASE_LIMIT, Duration::from_secs(2));
    let cleanup = ExitCleanup::default();
    let mut runtime = FakeExit::new(true);
    runtime.process_delay = Duration::from_secs(60);
    runtime.release_delay = Duration::from_secs(60);
    let started = std::time::Instant::now();
    cleanup
        .run(
            &runtime,
            Duration::from_millis(30),
            Duration::from_millis(20),
        )
        .await;
    assert!(started.elapsed() >= Duration::from_millis(50));
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "must not wait for the hanging process/release"
    );
    assert!(runtime.running());
    assert!(!runtime.released.load(Ordering::SeqCst));
    assert!(cleanup.done.get().is_some());
    cleanup
        .run(&runtime, EXIT_PROCESS_LIMIT, EXIT_RELEASE_LIMIT)
        .await;
    assert_eq!(
        *runtime.calls.lock().unwrap(),
        ["stop-and-cancel", "release"]
    );
}

#[tokio::test]
async fn shutdown_without_worker_configuration_still_cancels_manual_runs_but_sends_no_request() {
    let cleanup = ExitCleanup::default();
    let runtime = FakeExit::new(false);
    cleanup
        .run(&runtime, EXIT_PROCESS_LIMIT, EXIT_RELEASE_LIMIT)
        .await;
    assert_eq!(*runtime.calls.lock().unwrap(), ["stop-and-cancel"]);
    assert!(!runtime.released.load(Ordering::SeqCst));
}

#[tokio::test]
async fn unknown_session_keeps_current_configuration_but_starts_no_probe_or_claim() {
    let fake = Fake::new(vec![]);
    fake.ready.store(false, Ordering::SeqCst);
    *fake.cached.lock().unwrap() = None;
    let mut engine = engine();
    assert!(fake.current().await);
    assert_eq!(
        engine.step(&fake, &fake, "instance").await,
        Duration::from_millis(100)
    );
    assert!(fake.routes().is_empty());
    assert_eq!(fake.probes.load(Ordering::SeqCst), 0);
    assert_eq!(fake.runs.load(Ordering::SeqCst), 0);
    fake.ready.store(true, Ordering::SeqCst);
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(fake.probes.load(Ordering::SeqCst), 1);
    assert_eq!(fake.routes(), ["localAi.claim"]);
}

#[tokio::test]
async fn non_user_probe_interruptions_wait_thirty_seconds_then_trip_until_explicit_resume() {
    for error in [
        Error::Cancelled,
        Error::StaleSpace,
        Error::Exit,
        Error::Timeout,
    ] {
        let fake = Fake::new(vec![]);
        *fake.cached.lock().unwrap() = None;
        *fake.probe_result.lock().unwrap() = Err(error);
        let mut engine = engine();
        assert_eq!(
            engine.step(&fake, &fake, "instance").await,
            Duration::from_secs(30)
        );
        assert_eq!(engine.interruptions, 1);
        assert_eq!(fake.probes.load(Ordering::SeqCst), 1);
        assert!(engine.step(&fake, &fake, "instance").await > Duration::from_secs(29));
        assert_eq!(
            fake.probes.load(Ordering::SeqCst),
            1,
            "no paid retry during cooldown"
        );
        engine.paid_not_before = tokio::time::Instant::now(); // elapsed cooldown
        engine.step(&fake, &fake, "instance").await;
        assert_eq!(engine.status.paused_reason, Some("INTERRUPTED"));
        engine.paid_not_before = tokio::time::Instant::now();
        for _ in 0..3 {
            engine.step(&fake, &fake, "instance").await;
        }
        assert_eq!(
            fake.probes.load(Ordering::SeqCst),
            2,
            "breaker cannot auto retry"
        );
        fake.resume.fetch_add(1, Ordering::SeqCst);
        *fake.probe_result.lock().unwrap() = Ok(());
        engine.step(&fake, &fake, "instance").await;
        assert_eq!(fake.probes.load(Ordering::SeqCst), 3);
        assert_eq!(engine.interruptions, 0);
    }
}

#[tokio::test]
async fn resume_does_not_bypass_cooldown_and_successful_manual_probe_unlocks_breaker() {
    let fake = Fake::new(vec![]);
    let mut engine = engine();
    engine.interrupted(Error::Cancelled);
    engine.interrupted(Error::Cancelled);
    let deadline = engine.paid_not_before;
    fake.resume.fetch_add(1, Ordering::SeqCst);
    assert!(engine.step(&fake, &fake, "instance").await > Duration::from_secs(29));
    assert_eq!(engine.paid_not_before, deadline);
    assert_eq!(engine.interruptions, 0);
    assert!(fake.routes().is_empty());
    engine.paid_not_before = tokio::time::Instant::now();
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(fake.routes(), ["localAi.claim"]);
}

#[tokio::test]
async fn failed_process_tree_termination_never_automatically_restarts_probe() {
    let fake = Fake::new(vec![]);
    *fake.cached.lock().unwrap() = None;
    *fake.probe_result.lock().unwrap() = Err(Error::TerminationFailed);
    let mut engine = engine();
    engine.step(&fake, &fake, "instance").await;
    engine.paid_not_before = tokio::time::Instant::now();
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(fake.probes.load(Ordering::SeqCst), 1);
    assert_eq!(engine.status.paused_reason, Some("PROBE_REQUIRED"));
    assert_eq!(engine.status.last_error, Some(Error::TerminationFailed));
}

#[tokio::test]
async fn interrupted_analysis_releases_and_trips_but_user_departures_do_not_count() {
    let fake = Fake::new(vec![
        reply(200, lease()),
        reply(204, Value::Null),
        reply(200, lease()),
    ]);
    *fake.result.lock().unwrap() = Err(Error::Cancelled);
    let mut engine = engine();
    engine.step(&fake, &fake, "instance").await;
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(fake.runs.load(Ordering::SeqCst), 1);
    engine.paid_not_before = tokio::time::Instant::now();
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(engine.status.paused_reason, Some("INTERRUPTED"));
    engine.paid_not_before = tokio::time::Instant::now();
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(fake.runs.load(Ordering::SeqCst), 2);
    assert_eq!(
        fake.routes(),
        [
            "localAi.claim",
            "localAi.release",
            "localAi.claim",
            "localAi.release"
        ]
    );

    let mut departing = Fake::new(vec![reply(200, lease())]);
    departing.depart_in_run = true;
    *departing.result.lock().unwrap() = Err(Error::Cancelled);
    let mut fresh = Engine::new(engine.status.space.clone(), "user".into());
    fresh.capability_checked = true;
    fresh.step(&departing, &departing, "instance").await;
    assert_eq!(fresh.interruptions, 0);
}

#[test]
fn snapshot_errors_are_unknown_until_two_seconds_and_success_resets_the_deadline() {
    use crate::spaces::rebind_tests::{deployment, Home};
    let home = Home::new();
    let session = home.signed_in(deployment("https://fixture.test"));
    let mut continuity = SessionContinuity::new(session.clone());
    let now = tokio::time::Instant::now();
    for (field, value) in [
        ("authToken", json!("changed-fixture-token")),
        ("userId", json!("other-user")),
        ("generation", json!(999)),
        ("state", json!("sync_pending")),
    ] {
        let mut changed = serde_json::to_value(&session).unwrap();
        changed[field] = value;
        let changed = serde_json::from_value(changed).unwrap();
        assert_eq!(
            continuity.observe(Ok(Some(changed)), now),
            Presence::Departed,
            "{field}"
        );
    }
    assert_eq!(
        continuity.observe(Err("busy".into()), now),
        Presence::Unknown
    );
    assert_eq!(
        continuity.observe(Err("busy".into()), now + Duration::from_millis(1999)),
        Presence::Unknown
    );
    assert_eq!(
        continuity.observe(Ok(Some(session.clone())), now + Duration::from_secs(2)),
        Presence::Current
    );
    assert_eq!(
        continuity.observe(Err("busy".into()), now + Duration::from_secs(3)),
        Presence::Unknown
    );
    assert_eq!(
        continuity.observe(Err("busy".into()), now + Duration::from_secs(5)),
        Presence::Departed
    );
    assert_eq!(
        continuity.observe(Ok(None), now + Duration::from_secs(6)),
        Presence::Departed
    );
    let changed = home.signed_in(deployment("https://other.test"));
    assert_eq!(
        continuity.observe(Ok(Some(changed)), now + Duration::from_secs(7)),
        Presence::Departed
    );
}

#[tokio::test]
async fn transient_snapshot_errors_do_not_cancel_scoped_work() {
    use crate::spaces::rebind_tests::{deployment, Home};
    let home = Home::new();
    let session = home.signed_in(deployment("https://fixture.test"));
    let registry = SpaceRegistry::new(
        reqwest::Url::parse("https://official.test").unwrap(),
        home.0.clone(),
    )
    .unwrap();
    let space = SpaceRegistry::handle(Some(&session));
    let path = home.0.join("runtime/session.json");
    let original = std::fs::read(&path).unwrap();
    let result = super::super::scoped(
        &registry,
        &space,
        &uuid::Uuid::new_v4().to_string(),
        async |cancel| {
            std::fs::write(&path, b"temporarily unreadable").unwrap();
            tokio::time::sleep(Duration::from_millis(350)).await;
            let was_cancelled = *cancel.borrow();
            std::fs::write(&path, original).unwrap();
            assert!(!was_cancelled);
            Ok("accepted")
        },
    )
    .await;
    assert_eq!(result, Ok("accepted"));
}

#[tokio::test]
async fn empty_waits_sixty_seconds_and_success_submits_only_the_bound_profile() {
    let mut engine = engine();
    let fake = Fake::new(vec![
        reply(204, Value::Null),
        reply(200, lease()),
        reply(200, json!({"skillId":"skill","analysisStatus":"completed"})),
    ]);
    assert_eq!(
        engine.step(&fake, &fake, "instance").await,
        Duration::from_secs(60)
    );
    assert_eq!(engine.status.state, State::Idle);
    assert_eq!(
        engine.step(&fake, &fake, "instance").await,
        Duration::from_secs(2)
    );
    assert_eq!(engine.status.completed, 1);
    assert_eq!(engine.status.skill_id.as_deref(), Some("skill"));
    let calls = fake.calls.lock().unwrap();
    assert_eq!(calls[2].0, "localAi.result");
    assert_eq!(calls[2].1.as_deref(), Some("lease"));
    assert_eq!(
        calls[2].2,
        Some(json!({"inputHash":"hash", "configVersion":"v1", "profile":{"profile":"fixture"}}))
    );
    assert_eq!(fake.runs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn fixed_failures_report_but_cancelled_stale_and_busy_only_release() {
    for error in [
        Error::Model,
        Error::Cancelled,
        Error::StaleSpace,
        Error::Busy,
    ] {
        let mut engine = engine();
        let fake = Fake::new(vec![reply(200, lease())]);
        *fake.result.lock().unwrap() = Err(error);
        engine.step(&fake, &fake, "instance").await;
        let cancelled = matches!(error, Error::Cancelled | Error::StaleSpace | Error::Busy);
        assert_eq!(
            fake.routes(),
            [
                "localAi.claim",
                if cancelled {
                    "localAi.release"
                } else {
                    "localAi.failure"
                }
            ]
        );
        assert_eq!(engine.status.failed, u64::from(!cancelled));
        if !cancelled {
            assert_eq!(
                fake.calls.lock().unwrap()[1].2,
                Some(json!({"code":"MODEL_ERROR"}))
            );
        }
    }
}

#[tokio::test]
async fn instance_ai_waits_ten_minutes_but_missing_capability_stops_for_session() {
    let mut engine = engine();
    let fake = Fake::new(vec![
        reply(409, json!({"code":"INSTANCE_AI_CONFIGURED"})),
        reply(404, Value::Null),
    ]);
    assert_eq!(
        engine.step(&fake, &fake, "instance").await,
        Duration::from_secs(600)
    );
    assert_eq!(engine.status.state, State::Unavailable);
    assert!(!engine.stopped);
    engine.step(&fake, &fake, "instance").await;
    assert!(engine.stopped);
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(fake.routes().len(), 2);
    for response in [
        reply(200, json!({"features":{"localAiLeases":false}})),
        reply(200, json!({})),
        Err(Error::Io),
    ] {
        let mut engine = Engine::new(engine.status.space.clone(), "user".into());
        let fake = Fake::new(vec![response]);
        engine.step(&fake, &fake, "instance").await;
        engine.step(&fake, &fake, "instance").await;
        assert!(engine.stopped);
        assert_eq!(fake.routes(), ["health"]);
        assert_eq!(fake.probes.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn instance_mismatch_releases_and_stops_without_running() {
    let mut engine = engine();
    let fake = Fake::new(vec![reply(200, lease())]);
    engine.step(&fake, &fake, "different-instance").await;
    engine.step(&fake, &fake, "different-instance").await;
    assert!(engine.stopped);
    assert_eq!(fake.routes(), ["localAi.claim", "localAi.release"]);
    assert_eq!(fake.runs.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn oversized_or_invalid_input_reports_invalid_input_without_running() {
    for field in ["skillMd", "files", "unknown"] {
        let mut input = lease();
        input["input"][field] = match field {
            "files" => json!(vec!["x"; 201]),
            "skillMd" => json!("x".repeat(65537)),
            _ => json!("forbidden"),
        };
        let fake = Fake::new(vec![reply(200, input)]);
        engine().step(&fake, &fake, "instance").await;
        assert_eq!(fake.runs.load(Ordering::SeqCst), 0);
        assert_eq!(
            fake.calls.lock().unwrap()[1].2,
            Some(json!({"code":"INVALID_INPUT"}))
        );
    }
}

#[tokio::test]
async fn login_and_executable_errors_pause_until_explicit_successful_probe() {
    for error in [
        Error::NotLoggedIn,
        Error::VersionUnsupported,
        Error::Executable,
        Error::NotInstalled,
        Error::ShimUnsupported,
        Error::TerminationFailed,
    ] {
        let mut engine = engine();
        let fake = Fake::new(vec![reply(200, lease())]);
        *fake.result.lock().unwrap() = Err(error);
        engine.step(&fake, &fake, "instance").await;
        engine.step(&fake, &fake, "instance").await;
        assert_eq!(engine.status.state, State::Paused);
        assert_eq!(fake.routes(), ["localAi.claim", "localAi.failure"]);
        assert_eq!(fake.probes.load(Ordering::SeqCst), 0);
        fake.remember_probe(Ok(()));
        fake.resume.fetch_add(1, Ordering::SeqCst);
        engine.paid_not_before = tokio::time::Instant::now();
        engine.step(&fake, &fake, "instance").await;
        assert_eq!(engine.status.state, State::Idle);
    }
}

#[tokio::test]
async fn first_session_probes_once_and_reuses_success() {
    let fake = Fake::new(vec![]);
    *fake.cached.lock().unwrap() = None;
    let mut engine = engine();
    engine.step(&fake, &fake, "instance").await;
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(fake.probes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn departed_generation_discards_even_successful_late_result_and_releases() {
    let mut fake = Fake::new(vec![reply(200, lease())]);
    fake.depart_in_run = true;
    let mut engine = engine();
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(fake.routes(), ["localAi.claim", "localAi.release"]);
    assert_eq!(engine.status.completed, 0);
    assert_eq!(fake.events.lock().unwrap().len(), 1); // running only, no late completion
}

#[tokio::test]
async fn departure_cancels_running_work_and_awaits_cleanup_before_discarding_output() {
    let fake = Fake::new(vec![]);
    let cancelled = AtomicBool::new(false);
    let cleaned = AtomicBool::new(false);
    let work = async {
        fake.active.store(false, Ordering::SeqCst);
        while !cancelled.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        cleaned.store(true, Ordering::SeqCst);
        Ok("late")
    };
    assert_eq!(
        cancel_on_departure(&fake, work, || {
            cancelled.store(true, Ordering::SeqCst);
        })
        .await,
        Err(Error::Cancelled)
    );
    assert!(cleaned.load(Ordering::SeqCst));
}

#[test]
fn exponential_backoff_and_retry_after_are_bounded_and_never_spin() {
    assert_eq!(
        (0..7).map(|n| backoff(n).as_secs()).collect::<Vec<_>>(),
        [30, 60, 120, 240, 480, 900, 900]
    );
    assert_eq!(backoff(u32::MAX).as_secs(), 900);
    for (value, expected) in [
        (Some("120"), 120),
        (Some("0"), 2),
        (Some("no"), 30),
        (None, 30),
    ] {
        assert_eq!(retry_after(value, backoff(0)).as_secs(), expected);
    }
}

#[tokio::test]
async fn network_and_5xx_backoff_and_rate_limits_use_retry_after() {
    let mut rate = reply(429, Value::Null).unwrap();
    rate.retry_after = Some("75".into());
    let fake = Fake::new(vec![Err(Error::Io), reply(503, Value::Null), Ok(rate)]);
    let mut engine = engine();
    for seconds in [30, 60, 75] {
        assert_eq!(
            engine.step(&fake, &fake, "instance").await.as_secs(),
            seconds
        );
    }
    assert_eq!(engine.status.state, State::Error);
}

#[tokio::test]
async fn reauthentication_resumes_but_cannot_reenable_missing_capability() {
    let mut engine = engine();
    let fake = Fake::new(vec![reply(401, Value::Null)]);
    engine.step(&fake, &fake, "instance").await;
    assert!(engine.stopped);
    let mut next = engine.status.space.clone();
    next.generation += 1;
    engine.bind(&next);
    assert!(!engine.stopped);
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(engine.status.state, State::Idle);
    engine.unavailable("CAPABILITY_MISSING");
    next.generation += 1;
    engine.bind(&next);
    assert!(engine.stopped);
}

#[tokio::test]
async fn failure_report_401_keeps_auth_pause_and_recovers_on_new_generation() {
    let mut engine = engine();
    let fake = Fake::new(vec![reply(200, lease()), reply(401, Value::Null)]);
    *fake.result.lock().unwrap() = Err(Error::Model);
    engine.step(&fake, &fake, "instance").await;
    assert_eq!(engine.status.paused_reason, Some("SIGN_IN_REQUIRED"));
    let mut next = engine.status.space.clone();
    next.generation += 1;
    engine.bind(&next);
    engine.step(&fake, &fake, "instance").await;
    assert!(!engine.stopped);
    assert_eq!(engine.status.state, State::Idle);
}

#[tokio::test]
async fn quitting_rejects_new_manual_work_after_registration() {
    use crate::spaces::rebind_tests::{deployment, Home};
    let home = Home::new();
    let session = home.signed_in(deployment("https://fixture.test"));
    let registry = SpaceRegistry::new(
        reqwest::Url::parse("https://official.test").unwrap(),
        home.0.clone(),
    )
    .unwrap();
    let space = SpaceRegistry::handle(Some(&session));
    registry.worker.control.lock().unwrap().quitting = true;
    let result = super::super::scoped(
        &registry,
        &space,
        &uuid::Uuid::new_v4().to_string(),
        async |_cancel| -> Result<(), Error> { panic!("shutdown must not start a paid call") },
    )
    .await;
    assert_eq!(result, Err(Error::Cancelled));
    assert!(registry.inference.active.lock().unwrap().is_empty());
}

#[tokio::test]
async fn stopped_before_first_poll_does_not_start_scoped_inference() {
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
    let fake = Fake::new(vec![]);
    let invoked = AtomicBool::new(false);
    let work = super::super::scoped(&registry, &space, &id, async |_cancel| {
        if !fake.current().await {
            return Err(Error::Cancelled);
        }
        invoked.store(true, Ordering::SeqCst);
        Ok(())
    });
    fake.active.store(false, Ordering::SeqCst);
    let result = cancel_on_departure(&fake, work, || {
        registry.inference.cancel(&id, &space);
    })
    .await;
    assert_eq!(result, Err(Error::Cancelled));
    assert!(!invoked.load(Ordering::SeqCst));
    assert!(registry.inference.active.lock().unwrap().is_empty());
}
