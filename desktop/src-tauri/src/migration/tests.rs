use super::*;
use reqwest::Method;
use std::cell::RefCell;

struct Fixture(Store);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("migration-engine-{}", uuid::Uuid::new_v4()));
        crate::runtime_env::ensure_private_directory(&root).unwrap();
        Self(Store { root })
    }
    fn seed(&self) -> Record {
        let hash = self.0.stage("pkg", b"zip-fixture").unwrap();
        let avatar_hash = self.0.stage("avatar", b"avatar-fixture").unwrap();
        let source = Identity {
            profile: "selfhost".into(),
            origin: "http://127.0.0.1:3001".into(),
            user_id: uuid::Uuid::new_v4().to_string(),
        };
        let r = Record {
            id: uuid::Uuid::new_v4().to_string(),
            source_skill_id: uuid::Uuid::new_v4().to_string(),
            name: "sample".into(),
            display_name: None,
            category: "own_skill".into(),
            item: None,
            choice: Choice::Copy { target_name: None },
            source_entry_id: Some(uuid::Uuid::new_v4().to_string()),
            source_local_id: Some("source-folder".into()),
            source_entry_aliases: Vec::new(),
            source_local_aliases: Vec::new(),
            target_entry_id: uuid::Uuid::new_v4().to_string(),
            target_local_id: None,
            state: "pending".into(),
            reason: String::new(),
            warnings: Vec::new(),
            pending_delta: true,
            result: None,
            precheck: None,
            library_done: false,
            organizer_done: false,
        };
        let mut r = r;
        r.item = Some(Item {
            source_origin: source.origin.clone(),
            source_user_id: source.user_id.clone(),
            source_skill_id: r.source_skill_id.clone(),
            content_hash: sha(b"content"),
            kind: "own_skill".into(),
            version: "0.1.0".into(),
            name: r.name.clone(),
            profile: SyncProfile {
                display_name: "Sample".into(),
                ..Default::default()
            },
            package_size: 11,
            package_sha256: hash,
            avatars: vec![Avatar {
                id: "custom".into(),
                kind: "custom".into(),
                style_id: None,
                style_version: None,
                mime_type: "image/png".into(),
                size: 14,
                sha256: avatar_hash,
            }],
            selected_avatar_id: Some("custom".into()),
            store_copy: None,
            target_name: None,
            map_to_skill_id: None,
        });
        let mut organizer = crate::library_organizer::OrganizerState::default();
        organizer.tags.insert(
            format!("entry:{}", r.source_entry_id.as_ref().unwrap()),
            vec!["Tag".into()],
        );
        organizer
            .quick_access
            .items
            .push(crate::library_organizer::QuickAccessItem {
                kind: crate::library_organizer::QuickAccessKind::Skill,
                reference: format!("entry:{}", r.source_entry_id.as_ref().unwrap()),
            });
        self.0
            .save(&Manifest {
                version: 1,
                local_migration_id: uuid::Uuid::new_v4().to_string(),
                source,
                target: Identity {
                    profile: "selfhost".into(),
                    origin: "http://127.0.0.1:3003".into(),
                    user_id: uuid::Uuid::new_v4().to_string(),
                },
                source_deployment: Deployment::Local,
                target_deployment: Deployment::Official,
                migration_id: Some(uuid::Uuid::new_v4().to_string()),
                records: vec![r.id.clone()],
                snapshot_at: 1,
                state: "ready".into(),
                last_error: None,
                limits: Limits::default(),
                organizer,
                keys: Vec::new(),
                keys_done: false,
                key_results: Vec::new(),
            })
            .unwrap();
        self.0.put(&r).unwrap();
        r
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0.root);
    }
}

#[test]
fn migration_key_name_dto_has_only_names_counts_and_conflicts() {
    let fixture = Fixture::new();
    fixture.seed();
    let manifest = fixture.0.manifest().unwrap();
    let home = &fixture.0.root;
    let source = manifest.source_deployment.root(home);
    let target = manifest.target_deployment.root(home);
    crate::commands::write_private_file(
        &crate::key_vault::vault_env_path_at(&source, &manifest.source.user_id),
        "A_KEY=private-fixture-value\nA_KEY__V1=private-variant\nB_KEY=private-second\n",
    )
    .unwrap();
    crate::commands::write_private_file(
        &crate::key_vault::vault_env_path_at(&target, &manifest.target.user_id),
        "A_KEY=target-fixture-value\n",
    )
    .unwrap();
    let mut meta = crate::key_vault::VaultMeta::default();
    meta.keys.entry("A_KEY".into()).or_default().allowed_skills =
        vec!["skill-one".into(), "skill-two".into()];
    write_private_json(
        &crate::key_vault::vault_dir_at(&source, &manifest.source.user_id).join("vault.meta.json"),
        &meta,
    )
    .unwrap();
    let rows = serde_json::to_value(key_names(home, &manifest).unwrap()).unwrap();
    assert_eq!(
        rows,
        json!([
            {"name":"A_KEY","authorizedSkillCount":2,"conflict":true},
            {"name":"B_KEY","authorizedSkillCount":0,"conflict":false}
        ])
    );
    assert!(!rows.to_string().contains("private"));
    assert!(!rows.to_string().contains("skill-one"));
}

#[test]
fn migration_restart_distinguishes_live_worker_from_interrupted_manifest() {
    let fixture = Fixture::new();
    fixture.seed();
    let jobs = Jobs::default();
    let mut manifest = fixture.0.manifest().unwrap();
    manifest.state = "running".into();
    fixture.0.save(&manifest).unwrap();
    assert_eq!(live_report(&fixture.0, &jobs).unwrap().state, "paused");
    let job = jobs.start(&manifest.local_migration_id).unwrap();
    assert_eq!(live_report(&fixture.0, &jobs).unwrap().state, "running");
    drop(job);
    manifest.state = "imported".into();
    fixture.0.save(&manifest).unwrap();
    assert_eq!(live_report(&fixture.0, &jobs).unwrap().state, "paused");
    manifest.state = "snapshotting".into();
    fixture.0.save(&manifest).unwrap();
    assert_eq!(
        live_report(&fixture.0, &jobs).unwrap().state,
        "snapshotFailed"
    );
    manifest.state = "cancelled".into();
    fixture.0.save(&manifest).unwrap();
    assert_eq!(live_report(&fixture.0, &jobs).unwrap().state, "cancelled");
}

#[test]
fn migration_report_includes_precheck_avatar_count_and_private_key_outcomes_only() {
    let fixture = Fixture::new();
    let record = fixture.seed();
    let mut manifest = fixture.0.manifest().unwrap();
    manifest.key_results.push(KeyResult {
        name: "A_KEY".into(),
        target_name: "A_KEY_2".into(),
        status: "copied".into(),
    });
    manifest.keys_done = true;
    fixture.0.save(&manifest).unwrap();
    let value = serde_json::to_value(report(&fixture.0).unwrap()).unwrap();
    assert_eq!(
        value["items"][0]["avatarCount"],
        record.item.unwrap().avatars.len()
    );
    assert_eq!(value["keyResults"][0]["status"], "copied");
    assert_eq!(value["keysDone"], true);
    assert!(value["items"][0].get("packageBase64").is_none());
}

#[derive(Default)]
struct FakeState {
    result: Option<Value>,
    entry: Option<Value>,
    trace: Vec<String>,
    waits: Vec<u64>,
    rate_limited: bool,
    conflict: bool,
    lose_response: bool,
    interrupt_after_commit: bool,
    store_entries: Vec<Value>,
    quick_items: Vec<Value>,
    revision: u64,
    quick_conflicts: u8,
    sync_busy: u8,
    sync_failed: bool,
}
#[derive(Default)]
struct Fake(RefCell<FakeState>);
impl Transport for Fake {
    async fn sync_library(&self) -> Result<(), crate::library_sync::SyncError> {
        let mut state = self.0.borrow_mut();
        if state.sync_busy > 0 {
            state.sync_busy -= 1;
            Err(crate::library_sync::SyncError::Busy)
        } else if state.sync_failed {
            Err(crate::library_sync::SyncError::Fatal(
                "private URL or token".into(),
            ))
        } else {
            Ok(())
        }
    }
    fn check(&self) -> Result<(), String> {
        Ok(())
    }
    async fn wait(&self, seconds: u64) -> Result<(), String> {
        self.0.borrow_mut().waits.push(seconds);
        Ok(())
    }
    async fn request(
        &self,
        side: Side,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<transport::Reply, String> {
        assert!(matches!(side, Side::Target));
        let mut s = self.0.borrow_mut();
        s.trace.push(format!("{method} {path}"));
        let mut status = 200;
        let body = body.unwrap_or(Value::Null);
        let value = if path.ends_with("/precheck") {
            json!({"items":body["items"].as_array().unwrap().iter().map(|item| {
                let item: Item = serde_json::from_value(item.clone()).unwrap();
                json!({"operationKey":item.operation_key(),"status":"ok","reason":"READY"})
            }).collect::<Vec<_>>()})
        } else if path.ends_with("/avatars") {
            if !s.rate_limited {
                s.rate_limited = true;
                status = 429;
            }
            json!({"status":"uploaded"})
        } else if path.ends_with("/items") {
            let item: Item = serde_json::from_value(body["item"].clone()).unwrap();
            if s.conflict && item.target_name.is_none() {
                status = 409;
                json!({"code":"MIGRATION_NAME_CONFLICT"})
            } else {
                if item.map_to_skill_id.is_some() {
                    assert!(body.get("packageBase64").is_none());
                } else {
                    assert!(s.trace.iter().any(|t| t.ends_with("/avatars")));
                }
                let result = json!({"operationKey":item.operation_key(),
                    "status":if item.map_to_skill_id.is_some() {"mapped"} else {"imported"},
                    "targetSkillId":item.map_to_skill_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                    "version":"0.1.0","avatars":[],"errors":[]});
                assert!(
                    s.result.is_none(),
                    "must reconcile before repeating an imported item"
                );
                s.result = Some(result.clone());
                if s.lose_response {
                    return Err("MIGRATION_NETWORK".into());
                }
                result
            }
        } else if path.starts_with("api/migrations/") && method == Method::GET {
            if s.interrupt_after_commit && s.result.is_some() {
                return Err("MIGRATION_NETWORK".into());
            }
            json!({"items":s.result.iter().map(|r| json!({"operationKey":r["operationKey"],"result":r})).collect::<Vec<_>>()})
        } else if path == "api/library" && method == Method::GET {
            json!({"entries":s.entry.iter().chain(s.store_entries.iter()).collect::<Vec<_>>()})
        } else if path == "api/library" && method == Method::POST {
            assert!(body["migrationKey"]
                .as_str()
                .unwrap()
                .starts_with("authored:"));
            let entry =
                json!({"id":body["id"],"authorSkillId":body["source"]["skillId"],"deletedAt":null});
            s.entry = Some(entry.clone());
            entry
        } else if path == "api/skills" {
            json!([{"id":s.result.as_ref().unwrap()["targetSkillId"],"name":"existing","displayName":"Existing"}])
        } else if path.starts_with("api/library/tags/") {
            assert_eq!(body["add"], json!(["Tag"]));
            json!({})
        } else if path == "api/library/quick-access" && method == Method::GET {
            json!({"revision":s.revision,"items":s.quick_items})
        } else if path == "api/library/quick-access" && method == Method::PUT {
            assert_eq!(body["baseRevision"], s.revision);
            s.revision += 1;
            if s.quick_conflicts > 0 {
                s.quick_conflicts -= 1;
                s.quick_items.push(json!({"kind":"tag","ref":"Concurrent"}));
                status = 409;
            } else {
                s.quick_items = body["items"].as_array().unwrap().clone();
            }
            json!({"revision":s.revision,"items":s.quick_items})
        } else {
            panic!("unexpected route {path}")
        };
        Ok(transport::Reply {
            status,
            retry_after: 17,
            bytes: serde_json::to_vec(&value).unwrap(),
        })
    }
}

#[test]
fn import_lost_response_rate_limit_and_restart_reconcile_without_duplicate() {
    let f = Fixture::new();
    let r = f.seed();
    let api = Fake::default();
    api.0.borrow_mut().lose_response = true;
    api.0.borrow_mut().interrupt_after_commit = true;
    assert!(block_on(engine::import(&api, &f.0, |_| {})).is_err());
    assert_eq!(f.0.record(&r.id).unwrap().state, "submitting");
    api.0.borrow_mut().interrupt_after_commit = false;
    // New Store object models process restart: only disk manifest and server state survive.
    let restarted = Store {
        root: f.0.root.clone(),
    };
    block_on(engine::import(&api, &restarted, |_| {})).unwrap();
    let saved = restarted.record(&r.id).unwrap();
    assert!(saved.library_done && saved.organizer_done && saved.pending_delta);
    assert_eq!(saved.state, "imported");
    let s = api.0.borrow();
    assert_eq!(s.waits, [17]);
    assert_eq!(
        s.trace
            .iter()
            .filter(|t| t.starts_with("POST ") && t.ends_with("/items"))
            .count(),
        1
    );
    assert_eq!(
        s.trace.iter().filter(|t| *t == "POST api/library").count(),
        1
    );
    assert!(serde_json::to_string(&report(&restarted).unwrap())
        .unwrap()
        .find("packageBase64")
        .is_none());
}

#[test]
fn conflict_does_not_finalize_and_copy_choice_retries_same_operation() {
    let f = Fixture::new();
    let original = f.seed();
    let api = Fake::default();
    api.0.borrow_mut().conflict = true;
    block_on(engine::import(&api, &f.0, |_| {})).unwrap();
    let mut r = f.0.record(&original.id).unwrap();
    assert_eq!(r.state, "awaitingChoice");
    let key = r.item.as_ref().unwrap().operation_key();
    r.item.as_mut().unwrap().target_name = Some("copy".into());
    r.choice = Choice::Copy {
        target_name: Some("copy".into()),
    };
    f.0.put(&r).unwrap();
    block_on(engine::import(&api, &f.0, |_| {})).unwrap();
    let r = f.0.record(&r.id).unwrap();
    assert_eq!(r.result.unwrap().operation_key, key);
}

#[test]
fn manifest_is_sharded_and_bounded() {
    let f = Fixture::new();
    let r = f.seed();
    let mut m = f.0.manifest().unwrap();
    for _ in 0..100 {
        let mut record = r.clone();
        record.id = uuid::Uuid::new_v4().to_string();
        record.item.as_mut().unwrap().profile.description = Some("x".repeat(100_000));
        f.0.put(&record).unwrap();
        m.records.push(record.id);
    }
    f.0.save(&m).unwrap();
    assert!(fs::metadata(f.0.root.join("manifest.json")).unwrap().len() < 20_000);
    assert_eq!(f.0.manifest().unwrap().records.len(), 101);
    assert!(save(&f.0.root.join("too-large.json"), &"x".repeat(MAX_JSON)).is_err());
}

#[test]
fn export_and_preflight_have_separate_strict_allowlists() {
    for path in [
        "api/skills",
        "api/library",
        "api/library/tags",
        "api/library/quick-access",
        "api/skills/abc/versions",
        "api/skill-avatars/export?skillIds=a,b",
    ] {
        assert!(transport::export_route(&Method::GET, path));
        assert!(!transport::export_route(&Method::POST, path));
    }
    for path in [
        "api/skills/abc",
        "api/auth/me",
        "api/library/../auth",
        "api/skill-avatars/export?skillIds=a&token=b",
        "api/library?x=y",
    ] {
        assert!(!transport::export_route(&Method::GET, path));
    }
    let id = uuid::Uuid::new_v4();
    assert!(transport::preflight_route(&Method::POST, "api/migrations"));
    assert!(transport::preflight_route(
        &Method::POST,
        &format!("api/migrations/{id}/precheck")
    ));
    for route in ["items", "avatars"] {
        assert!(!transport::preflight_route(
            &Method::POST,
            &format!("api/migrations/{id}/{route}")
        ));
    }
}

#[test]
fn immutable_staging_checks_hash_and_permissions() {
    let root = std::env::temp_dir().join(format!("migration-test-{}", uuid::Uuid::new_v4()));
    crate::runtime_env::ensure_private_directory(&root).unwrap();
    let store = Store { root: root.clone() };
    let hash = store.stage("pkg", b"original").unwrap();
    assert_eq!(store.stage("pkg", b"original").unwrap(), hash);
    assert_eq!(store.blob("pkg", &hash).unwrap(), b"original");
    fs::write(store.blob_path("pkg", &hash).unwrap(), b"changed").unwrap();
    assert!(store.blob("pkg", &hash).is_err());
    assert!(store.blob("pkg", "../vault.env").is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn store_classification_never_replaces_an_old_version() {
    let listing = json!({"currentVersion":"0.2.0","version":{"packageSha256":"held"}});
    assert_eq!(
        snapshot::classify_store("0.2.0", "held", Some(&listing), false),
        ("reacquire", "current")
    );
    assert_eq!(
        snapshot::classify_store("0.1.0", "old", Some(&listing), false),
        ("store_copy", "outdated")
    );
    assert_eq!(
        snapshot::classify_store("0.2.0", "held", None, true),
        ("store_copy", "delisted")
    );
    assert_eq!(
        snapshot::classify_store("0.2.0", "held", None, false),
        ("store_copy", "current")
    );
}

fn deployment(port: u16) -> Deployment {
    Deployment::Selfhost {
        origin: format!("http://127.0.0.1:{port}/prefix"),
        initial_origin: format!("http://127.0.0.1:{port}/prefix"),
        instance: crate::spaces::InstanceIdentity {
            id: uuid::Uuid::new_v4().to_string(),
            public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
        },
    }
}

#[test]
fn pending_and_candidate_credentials_are_bound_to_their_own_instance() {
    let f = Fixture::new();
    let user = uuid::Uuid::new_v4().to_string();
    let mut pending = crate::runtime_env::new_space_session_at(
        &f.0.root,
        deployment(3001),
        Some(("source-token", &user)),
        4,
    )
    .unwrap();
    pending.begin_switch().unwrap();
    assert!(pending.server_origin().is_err());
    let candidate = crate::runtime_env::new_space_session_at(
        &f.0.root,
        deployment(3003),
        Some(("target-token", &user)),
        4,
    )
    .unwrap();
    let client = reqwest::Client::new();
    for (source, target) in [(&pending, &candidate), (&candidate, &pending)] {
        let url = reqwest::Url::parse(&format!(
            "{}/api/skills",
            source
                .deployment()
                .base()
                .unwrap()
                .unwrap()
                .as_str()
                .trim_end_matches('/')
        ))
        .unwrap();
        let request = transport::bound_request(&client, Method::GET, url.clone(), Some(source))
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            request.headers()["authorization"],
            format!("Bearer {}", source.auth_token().unwrap())
        );
        assert_eq!(request.url(), &url);
        assert!(transport::bound_request(&client, Method::GET, url.clone(), Some(target)).is_err());
        let anonymous = transport::bound_request(&client, Method::GET, url, None)
            .unwrap()
            .build()
            .unwrap();
        assert!(!anonymous.headers().contains_key("authorization"));
    }
}

struct SourceFake {
    package: Vec<u8>,
    own_id: String,
    entries: Vec<Value>,
    target_user: String,
    export_reads: RefCell<usize>,
    avatar_export_supported: bool,
}

struct FaultSource {
    source: SourceFake,
    replies: BTreeMap<String, Result<(u16, Vec<u8>), String>>,
}
impl FaultSource {
    fn reply(&mut self, path: &str, status: u16, value: Value) {
        self.replies.insert(
            path.into(),
            Ok((status, serde_json::to_vec(&value).unwrap())),
        );
    }
}
impl Transport for FaultSource {
    fn check(&self) -> Result<(), String> {
        Ok(())
    }
    async fn request(
        &self,
        side: Side,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<transport::Reply, String> {
        if let Some(reply) = self.replies.get(path).or_else(|| {
            path.ends_with("/precheck")
                .then(|| self.replies.get("precheck"))
                .flatten()
        }) {
            return reply.clone().map(|(status, bytes)| transport::Reply {
                status,
                bytes,
                retry_after: 0,
            });
        }
        self.source.request(side, method, path, body).await
    }
}

fn fault_fixture() -> (Fixture, RuntimeSession, RuntimeSession, FaultSource) {
    let f = Fixture::new();
    let source = crate::runtime_env::new_space_session_at(
        &f.0.root,
        deployment(3001),
        Some(("source-token", &uuid::Uuid::new_v4().to_string())),
        1,
    )
    .unwrap();
    let user = uuid::Uuid::new_v4().to_string();
    let target = crate::runtime_env::new_space_session_at(
        &f.0.root,
        deployment(3003),
        Some(("target-token", &user)),
        1,
    )
    .unwrap();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file("SKILL.md", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"# committed\n").unwrap();
    let mut api = FaultSource {
        source: SourceFake {
            package: zip.finish().unwrap().into_inner(),
            own_id: uuid::Uuid::new_v4().to_string(),
            entries: Vec::new(),
            target_user: user,
            export_reads: RefCell::new(0),
            avatar_export_supported: true,
        },
        replies: BTreeMap::new(),
    };
    api.reply(
        "api/skills",
        200,
        json!([
            {"id":api.source.own_id,"name":"own","displayName":null,"currentVersion":"0.2.0"},
            {"id":"broken","name":"broken","displayName":null,"currentVersion":"0.2.0"}
        ]),
    );
    (f, source, target, api)
}

fn run_snapshot<T: Transport>(
    f: &Fixture,
    source: &RuntimeSession,
    target: &RuntimeSession,
    api: &T,
) -> Result<(), String> {
    block_on(snapshot::snapshot(
        api,
        &f.0,
        &f.0.root,
        source,
        target,
        uuid::Uuid::new_v4().to_string(),
        Vec::new(),
    ))
}

#[test]
fn snapshot_item_failures_keep_other_records_and_complete_precheck() {
    for (path, status, value, reason) in [
        (
            "api/skills/broken/package",
            409,
            json!({}),
            "SOURCE_PACKAGE_UNAVAILABLE",
        ),
        ("api/skills/broken/versions", 500, json!({}), "HTTP_500"),
        (
            "api/skills/broken/versions",
            200,
            json!({"invalid":true}),
            "MIGRATION_INVALID_RESPONSE",
        ),
    ] {
        let (f, source, target, mut api) = fault_fixture();
        api.reply(
            "api/skills/broken/versions",
            200,
            json!([{"version":"0.2.0","packageSha256":null}]),
        );
        api.reply(path, status, value);
        run_snapshot(&f, &source, &target, &api).unwrap();
        let report = report(&f.0).unwrap();
        assert_eq!(report.state, "ready");
        assert_eq!(report.items.len(), 2);
        let broken = report.items.iter().find(|r| r.name == "broken").unwrap();
        assert_eq!(broken.state, "skipped");
        assert_eq!(broken.reason, reason);
        let own = report.items.iter().find(|r| r.name == "own").unwrap();
        assert_eq!(own.precheck.as_ref().unwrap().status, "ok");
    }
}

#[test]
fn snapshot_inventory_target_and_security_errors_remain_fatal() {
    for path in [
        "api/skills",
        "api/library",
        "api/library/tags",
        "api/library/quick-access",
        "api/migrations",
        "precheck",
    ] {
        for status in [200, 500] {
            let (f, source, target, mut api) = fault_fixture();
            api.reply(path, status, json!({}));
            assert!(
                run_snapshot(&f, &source, &target, &api).is_err(),
                "{path} {status}"
            );
        }
    }
    for path in [
        "api/skills/broken/versions",
        "api/skill-avatars/export?skillIds=broken",
        "https://media.example/custom",
    ] {
        for reason in [
            "MIGRATION_CANCELLED",
            "MIGRATION_SESSION_CHANGED",
            "MIGRATION_CREDENTIAL_DESTINATION",
            "MIGRATION_ROUTE_DENIED",
            "MIGRATION_CREDENTIAL_IN_RESPONSE",
            crate::spaces::STALE,
        ] {
            let (f, source, target, mut api) = fault_fixture();
            api.replies.insert(path.into(), Err(reason.into()));
            assert_eq!(
                run_snapshot(&f, &source, &target, &api).unwrap_err(),
                reason
            );
        }
    }
}

#[test]
fn snapshot_avatar_failures_warn_and_clear_unavailable_selection() {
    for failure in ["404", "hash", "url", "oversize", "export"] {
        let (f, source, target, mut api) = fault_fixture();
        match failure {
            "404" => api.reply("https://media.example/custom", 404, json!({})),
            "hash" => api.reply(
                "api/skill-avatars/export?skillIds=broken",
                200,
                json!({"items":[{
                    "variants":[{"variantId":"bad","styleId":"classic","styleVersion":1,
                        "url":"https://media.example/custom","sha256":"f".repeat(64)}],
                    "selected":{"kind":"generated","variantId":"bad"}
                }]}),
            ),
            "url" => {
                api.replies.insert(
                    "https://media.example/custom".into(),
                    Err("MIGRATION_MEDIA_URL".into()),
                );
            }
            "oversize" => {
                let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
                bytes.resize(3 * 1024 * 1024, 0);
                api.replies
                    .insert("https://media.example/custom".into(), Ok((200, bytes)));
            }
            _ => api.reply("api/skill-avatars/export?skillIds=broken", 500, json!({})),
        }
        run_snapshot(&f, &source, &target, &api).unwrap();
        let status = report(&f.0).unwrap();
        let broken = status.items.iter().find(|r| r.name == "broken").unwrap();
        assert_eq!(broken.precheck.as_ref().unwrap().status, "ok");
        assert_eq!(broken.warnings, ["AVATAR_SKIPPED"]);
        let item = f.0.record(&broken.id).unwrap().item.unwrap();
        assert!(item.selected_avatar_id.is_none(), "{failure}");
        assert_eq!(
            item.avatars.len(),
            if matches!(failure, "hash" | "export") {
                0
            } else {
                2
            }
        );
    }
}

#[test]
fn snapshot_local_packaging_failure_isolated_in_both_source_loops() {
    for local_source in [true, false] {
        let (f, remote_source, target, api) = fault_fixture();
        let source = if local_source {
            crate::runtime_env::new_space_session_at(&f.0.root, Deployment::Local, None, 0).unwrap()
        } else {
            remote_source
        };
        for name in ["good-local", "bad-local"] {
            let dir = f.0.root.join("skills").join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("SKILL.md"), "# local\n").unwrap();
            write_private_json(
                &dir.join(".skillhub.json"),
                &json!({"skillhub":{
                    "id":uuid::Uuid::new_v4(),"name":name,"version":"0.1.0",
                    "scope":crate::spaces::SidecarScope::for_session(&source)
                }}),
            )
            .unwrap();
            if name == "bad-local" {
                fs::write(dir.join("collision.txt"), "one").unwrap();
                // An unsafe source file fails the existing package validator.
                #[cfg(unix)]
                std::os::unix::fs::symlink("collision.txt", dir.join("unsafe-link")).unwrap();
                #[cfg(windows)]
                fs::write(dir.join("oversize.bin"), vec![0; MAX_PACKAGE + 1]).unwrap();
            }
        }
        run_snapshot(&f, &source, &target, &api).unwrap();
        let status = report(&f.0).unwrap();
        let bad = status.items.iter().find(|r| r.name == "bad-local").unwrap();
        assert_eq!(bad.state, "skipped");
        assert_eq!(bad.reason, "MIGRATION_LOCAL_PACKAGE_FAILED");
        let good = status
            .items
            .iter()
            .find(|r| r.name == "good-local")
            .unwrap();
        assert_eq!(good.precheck.as_ref().unwrap().status, "ok");
    }
}

#[test]
fn snapshot_staging_failure_is_fatal_even_for_avatar() {
    let (f, source, target, api) = fault_fixture();
    let bytes = b"\x89PNG\r\n\x1a\nfixture";
    let path = f.0.blob_path("avatar", &sha(bytes)).unwrap();
    crate::commands::write_private_file(&path, "corrupted").unwrap();
    assert_eq!(
        run_snapshot(&f, &source, &target, &api).unwrap_err(),
        "MIGRATION_STAGING_INVALID"
    );
}
impl SourceFake {
    fn hash(&self) -> String {
        sha(&self.package)
    }
    fn content_hash(&self) -> String {
        crate::library_sync::content::content_hash(&[("SKILL.md", b"# committed\n")])
    }
}
impl Transport for SourceFake {
    async fn catalog_package(&self, _id: &str, hash: &str) -> Result<Vec<u8>, String> {
        assert_eq!(hash, self.hash());
        Ok(self.package.clone())
    }
    fn check(&self) -> Result<(), String> {
        Ok(())
    }
    async fn request(
        &self,
        side: Side,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<transport::Reply, String> {
        let mut status = 200;
        let value = match side {
            Side::Source => {
                assert!(transport::export_route(&method, path));
                if path == "api/skills" {
                    json!([{"id":self.own_id,"name":"own","displayName":null,"currentVersion":"0.2.0"}])
                } else if path == "api/library" {
                    json!({"entries":self.entries})
                } else if path == "api/library/tags" {
                    json!({"tags":[]})
                } else if path == "api/library/quick-access" {
                    json!({"revision":0,"items":[]})
                } else if path.ends_with("/versions") {
                    json!([{"id":uuid::Uuid::new_v4(),"version":"0.2.0","packageSha256":self.hash()}])
                } else if path.starts_with("api/cards/") && path.ends_with("/meta") {
                    json!({"sha256":self.hash(),"contentHash":self.content_hash()})
                } else if path == format!("api/cards/{}", self.hash()) {
                    return Ok(transport::Reply {
                        status: 200,
                        retry_after: 0,
                        bytes: self.package.clone(),
                    });
                } else if path.starts_with("api/skill-avatars/export?") {
                    if let Some(id) = path.strip_prefix("api/skill-avatars/export?localSkillIds=") {
                        assert!(self.entries.iter().any(|e| e["id"] == id));
                    }
                    *self.export_reads.borrow_mut() += 1;
                    if !self.avatar_export_supported {
                        return Ok(transport::Reply {
                            status: 404,
                            retry_after: 0,
                            bytes: b"{}".to_vec(),
                        });
                    }
                    json!({"items":[{"variants":[
                        {"variantId":"v1","styleId":"classic","styleVersion":1,"url":"https://media.example/one"},
                        {"variantId":"v2","styleId":"classic","styleVersion":2,"url":"https://media.example/two"}],
                        "custom":{"url":"https://media.example/custom"},"selected":{"kind":"custom"}}]})
                } else {
                    status = 404;
                    json!({})
                }
            }
            Side::Catalog => {
                assert_eq!(method, Method::GET);
                let id = path.split('/').next_back().unwrap();
                let entry = self
                    .entries
                    .iter()
                    .find(|e| e["sourceSkillId"] == id)
                    .unwrap();
                if entry["name"] == "delisted" {
                    status = 404;
                    json!({})
                } else {
                    json!({"id":id,"currentVersion":"0.2.0","version":{"packageSha256":self.hash()}})
                }
            }
            Side::Target => {
                assert!(transport::preflight_route(&method, path));
                if path == "api/migrations" {
                    json!({"id":uuid::Uuid::new_v4(),"targetUserId":self.target_user,
                        "limits":{"skills":100,"package":{"maxArchiveBytes":MAX_PACKAGE},"unlimited":["avatarCount"],"avatarCount":null}})
                } else {
                    json!({"items":body.unwrap()["items"].as_array().unwrap().iter().map(|item| {
                        let item: Item = serde_json::from_value(item.clone()).unwrap();
                        json!({"operationKey":item.operation_key(),"status":"ok","reason":"READY"})
                    }).collect::<Vec<_>>()})
                }
            }
            Side::Media => {
                assert!(path.starts_with("https://media.example/"));
                return Ok(transport::Reply {
                    status: 200,
                    retry_after: 0,
                    bytes: b"\x89PNG\r\n\x1a\nfixture".to_vec(),
                });
            }
        };
        Ok(transport::Reply {
            status,
            retry_after: 0,
            bytes: serde_json::to_vec(&value).unwrap(),
        })
    }
}

#[test]
fn snapshot_uses_committed_bytes_and_classifies_every_source() {
    let f = Fixture::new();
    let source_user = uuid::Uuid::new_v4().to_string();
    let target_user = uuid::Uuid::new_v4().to_string();
    let mut source = crate::runtime_env::new_space_session_at(
        &f.0.root,
        deployment(3001),
        Some(("source-token", &source_user)),
        1,
    )
    .unwrap();
    source.begin_switch().unwrap();
    let target = crate::runtime_env::new_space_session_at(
        &f.0.root,
        deployment(3003),
        Some(("target-token", &target_user)),
        1,
    )
    .unwrap();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file("SKILL.md", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"# committed\n").unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    let own_id = uuid::Uuid::new_v4().to_string();
    let local = f.0.root.join("skills/own-folder");
    fs::create_dir_all(&local).unwrap();
    fs::write(local.join("SKILL.md"), "# uncommitted edit\n").unwrap();
    write_private_json(
        &local.join(".skillhub.json"),
        &json!({"skillhub":{
            "id":uuid::Uuid::new_v4(),"serverId":own_id,"serverOwnerId":source_user,"isOwn":true,
            "scope":crate::spaces::SidecarScope::for_session(&source)
        }}),
    )
    .unwrap();
    let hash = sha(&bytes);
    let content = crate::library_sync::content::content_hash(&[("SKILL.md", b"# committed\n")]);
    let mut entries: Vec<Value> = [
        ("current", "catalog", "0.2.0"), ("outdated", "catalog", "0.1.0"),
        ("delisted", "catalog", "0.1.0"), ("team", "team", "0.2.0"),
        ("missing", "local", "0.2.0"),
    ].into_iter().map(|(name,kind,version)| json!({
        "id":uuid::Uuid::new_v4(),"name":name,"sourceKind":kind,"sourceSkillId":uuid::Uuid::new_v4(),
        "sourceVersionId":version,"version":{"label":version},"deletedAt":null,
        "profile":{"displayName":name},
        "card":{"sha256":if name=="missing" {"f".repeat(64)} else {hash.clone()},
            "contentHash":content,"size":bytes.len()}
    })).collect();
    for _ in 0..2 {
        entries.push(json!({"id":uuid::Uuid::new_v4(),"authorSkillId":own_id,
            "name":"own","deletedAt":null,"profile":{"displayName":"own"}}));
    }
    let mut api = SourceFake {
        package: bytes,
        own_id,
        target_user,
        entries,
        export_reads: RefCell::new(0),
        avatar_export_supported: true,
    };
    block_on(snapshot::snapshot(
        &api,
        &f.0,
        &f.0.root,
        &source,
        &target,
        uuid::Uuid::new_v4().to_string(),
        Vec::new(),
    ))
    .unwrap();
    let records: Vec<Record> =
        f.0.manifest()
            .unwrap()
            .records
            .iter()
            .map(|id| f.0.record(id).unwrap())
            .collect();
    assert_eq!(records.len(), 6);
    let own = records.iter().find(|r| r.name == "own").unwrap();
    assert!(own.pending_delta);
    assert_eq!(own.source_entry_aliases.len(), 1);
    assert_eq!(own.item.as_ref().unwrap().content_hash, api.content_hash());
    assert_eq!(own.item.as_ref().unwrap().avatars.len(), 3);
    assert_eq!(
        own.item.as_ref().unwrap().selected_avatar_id.as_deref(),
        Some("custom")
    );
    assert_eq!(
        records
            .iter()
            .find(|r| r.name == "current")
            .unwrap()
            .category,
        "reacquire"
    );
    assert_eq!(
        records
            .iter()
            .find(|r| r.name == "outdated")
            .unwrap()
            .item
            .as_ref()
            .unwrap()
            .store_copy
            .as_ref()
            .unwrap()
            .state,
        "outdated"
    );
    assert_eq!(
        records
            .iter()
            .find(|r| r.name == "outdated")
            .unwrap()
            .item
            .as_ref()
            .unwrap()
            .avatars
            .len(),
        3
    );
    assert_eq!(
        records
            .iter()
            .find(|r| r.name == "delisted")
            .unwrap()
            .item
            .as_ref()
            .unwrap()
            .store_copy
            .as_ref()
            .unwrap()
            .state,
        "delisted"
    );
    assert_eq!(
        records.iter().find(|r| r.name == "team").unwrap().reason,
        "TEAM_SHARED_NOT_COPYABLE"
    );
    assert_eq!(
        records.iter().find(|r| r.name == "missing").unwrap().reason,
        "SOURCE_PACKAGE_UNAVAILABLE"
    );
    let serialized = serde_json::to_string(&f.0.manifest().unwrap()).unwrap();
    assert!(!serialized.contains("source-token") && !serialized.contains("target-token"));
    let entry = api
        .entries
        .iter()
        .find(|e| e["name"] == "outdated")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let cache_dir = source
        .storage_root(&f.0.root)
        .join("avatars")
        .join(source.user_id());
    fs::create_dir_all(&cache_dir).unwrap();
    write_private_json(
        &cache_dir.join(format!("{entry}.json")),
        &json!({"avatarStatus":"ready","avatarUrl":"https://media.example/current"}),
    )
    .unwrap();
    api.avatar_export_supported = false;
    block_on(snapshot::snapshot(
        &api,
        &f.0,
        &f.0.root,
        &source,
        &target,
        uuid::Uuid::new_v4().to_string(),
        Vec::new(),
    ))
    .unwrap();
    let old_server =
        f.0.manifest()
            .unwrap()
            .records
            .iter()
            .map(|id| f.0.record(id).unwrap())
            .find(|r| r.name == "outdated")
            .unwrap()
            .item
            .unwrap();
    assert_eq!(old_server.avatars.len(), 1);
    assert_eq!(old_server.selected_avatar_id.as_deref(), Some("custom"));
}

#[test]
fn choices_wire_contract_accepts_flattened_actions() {
    let choices: Choices = serde_json::from_value(json!({"items":[
        {"id":"x","action":"copy","targetName":"new-name"},
        {"id":"y","action":"map","mapToSkillId":uuid::Uuid::new_v4()},
        {"id":"z","action":"skip"}],"keys":[]}))
    .unwrap();
    assert_eq!(choices.items.len(), 3);
    assert!(serde_json::from_value::<Choices>(json!({"items":[
        {"id":"x","action":"copy","token":"forbidden"}]}))
    .is_err());
}

#[test]
fn mapping_never_uploads_avatars_or_package() {
    let f = Fixture::new();
    let mut r = f.seed();
    let target = uuid::Uuid::new_v4().to_string();
    r.item.as_mut().unwrap().map_to_skill_id = Some(target.clone());
    r.choice = Choice::Map {
        map_to_skill_id: target.clone(),
    };
    f.0.put(&r).unwrap();
    let api = Fake::default();
    block_on(engine::import(&api, &f.0, |_| {})).unwrap();
    assert_eq!(
        f.0.record(&r.id).unwrap().result.unwrap().target_skill_id,
        Some(target)
    );
    assert!(!api.0.borrow().trace.iter().any(|t| t.ends_with("/avatars")));
}

#[test]
fn completed_keys_freeze_skipped_choices_and_preserve_the_receipt_mapping() {
    let f = Fixture::new();
    let mut r = f.seed();
    r.choice = Choice::Skip;
    r.state = "skipped".into();
    f.0.put(&r).unwrap();
    let mut m = f.0.manifest().unwrap();
    m.keys_done = true;
    f.0.save(&m).unwrap();
    let choices = serde_json::from_value(json!({"items":[{"id":r.id,"action":"copy"}]})).unwrap();
    assert_eq!(
        set_choices(&f.0, choices).unwrap_err(),
        "MIGRATION_FINALIZED_START_NEW"
    );
    assert!(matches!(f.0.record(&r.id).unwrap().choice, Choice::Skip));
    assert!(f.0.manifest().unwrap().keys_done);
}

#[test]
fn local_snapshot_requires_no_source_login_and_does_not_modify_the_folder() {
    let f = Fixture::new();
    let source =
        crate::runtime_env::new_space_session_at(&f.0.root, Deployment::Local, None, 0).unwrap();
    let user = uuid::Uuid::new_v4().to_string();
    let target = crate::runtime_env::new_space_session_at(
        &f.0.root,
        deployment(3003),
        Some(("target-token", &user)),
        1,
    )
    .unwrap();
    let dir = f.0.root.join("skills/local-skill");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        "---\nname: local-skill\ndescription: Local fixture\n---\n# local\n",
    )
    .unwrap();
    write_private_json(
        &dir.join(".skillhub.json"),
        &json!({"skillhub":{
            "id":uuid::Uuid::new_v4(),"name":"local-skill","version":"0.1.0",
            "scope":crate::spaces::SidecarScope::for_session(&source)
        }}),
    )
    .unwrap();
    let before = fs::read(dir.join(".skillhub.json")).unwrap();
    let unavailable = f.0.root.join("skills/store-missing-metadata");
    fs::create_dir_all(&unavailable).unwrap();
    fs::write(
        unavailable.join("SKILL.md"),
        "# not an original store package",
    )
    .unwrap();
    write_private_json(
        &unavailable.join(".skillhub.json"),
        &json!({"skillhub":{"id":uuid::Uuid::new_v4(),"acquisitionSource":"marketplace",
            "scope":crate::spaces::SidecarScope::for_session(&source)}}),
    )
    .unwrap();
    let api = SourceFake {
        package: Vec::new(),
        own_id: String::new(),
        entries: Vec::new(),
        target_user: user,
        export_reads: RefCell::new(0),
        avatar_export_supported: true,
    };
    block_on(snapshot::snapshot(
        &api,
        &f.0,
        &f.0.root,
        &source,
        &target,
        uuid::Uuid::new_v4().to_string(),
        Vec::new(),
    ))
    .unwrap();
    let m = f.0.manifest().unwrap();
    assert_eq!(m.records.len(), 2);
    let records: Vec<_> = m.records.iter().map(|id| f.0.record(id).unwrap()).collect();
    let missing = records
        .iter()
        .find(|r| r.source_local_id.as_deref() == Some("store-missing-metadata"))
        .unwrap();
    assert_eq!(missing.reason, "SOURCE_STORE_ID_MISSING");
    assert_eq!(
        report(&f.0)
            .unwrap()
            .items
            .iter()
            .find(|item| item.id == missing.id)
            .unwrap()
            .name,
        "商店 Skill"
    );
    assert!(missing.item.is_none());
    let r = records
        .into_iter()
        .find(|r| r.category == "own_skill")
        .unwrap();
    assert_eq!(r.category, "own_skill");
    assert_eq!(
        r.item.unwrap().source_origin,
        "http://localhost/skillhub-local"
    );
    assert_eq!(*api.export_reads.borrow(), 0);
    assert_eq!(before, fs::read(dir.join(".skillhub.json")).unwrap());
}

#[test]
fn http_clients_are_selected_by_origin_not_full_request_url() {
    // Found in the real two-instance run: `?skillIds=` reached the server-base validator.
    let url = reqwest::Url::parse("http://127.0.0.1:3001/media/9f/a.png?v=1").unwrap();
    let base = transport::media_client_base(&url).unwrap();
    assert_eq!(base.as_str(), "http://127.0.0.1:3001/");
    crate::net::validate_base_url(&base).unwrap();
    assert!(crate::net::validate_base_url(&url).is_err());
    let https = reqwest::Url::parse("https://media.example.com/a/b.webp").unwrap();
    assert_eq!(
        transport::media_client_base(&https).unwrap().as_str(),
        "https://media.example.com/"
    );
}

#[test]
fn second_migration_maps_existing_store_entries_and_merges_current_quick_access() {
    let first = Fixture::new();
    let own = first.seed();
    let api = Fake::default();
    block_on(engine::import(&api, &first.0, |_| {})).unwrap();
    assert_eq!(api.0.borrow().revision, 1);
    // Keep target state from the first pass, including its two installed store entries.
    let second = Fixture::new();
    let mut skipped = second.seed();
    skipped.choice = Choice::Skip;
    second.0.put(&skipped).unwrap();
    let mut m = second.0.manifest().unwrap();
    for kind in ["catalog", "marketplace"] {
        let mut r = own.clone();
        r.id = uuid::Uuid::new_v4().to_string();
        r.category = "reacquire".into();
        r.source_entry_id = Some(uuid::Uuid::new_v4().to_string());
        let item = r.item.as_mut().unwrap();
        item.source_skill_id = uuid::Uuid::new_v4().to_string();
        let target = uuid::Uuid::new_v4().to_string();
        api.0.borrow_mut().store_entries.push(json!({"id":target,"deletedAt":null,
            "sourceKind":kind,"sourceSkillId":item.source_skill_id,"card":{"sha256":item.package_sha256}}));
        let key = format!("entry:{}", r.source_entry_id.as_ref().unwrap());
        m.organizer.tags.insert(key.clone(), vec!["Tag".into()]);
        m.organizer
            .quick_access
            .items
            .push(crate::library_organizer::QuickAccessItem {
                kind: crate::library_organizer::QuickAccessKind::Skill,
                reference: key,
            });
        m.records.push(r.id.clone());
        second.0.put(&r).unwrap();
    }
    second.0.save(&m).unwrap();
    api.0.borrow_mut().trace.clear();
    api.0.borrow_mut().quick_conflicts = 1;
    block_on(engine::import(&api, &second.0, |_| {})).unwrap();
    let report = report(&second.0).unwrap();
    assert_eq!(report.state, "imported");
    assert!(report.last_error.is_none());
    assert_eq!(
        report.items.iter().filter(|r| r.state == "mapped").count(),
        2
    );
    assert_eq!(
        report.items.iter().filter(|r| r.state == "skipped").count(),
        1
    );
    assert!(!api
        .0
        .borrow()
        .trace
        .iter()
        .any(|s| s == "POST api/library" || s.ends_with("/items") || s.ends_with("/precheck")));
    assert_eq!(api.0.borrow().quick_items.len(), 4); // own, concurrent tag, two store entries
    let revision = api.0.borrow().revision;
    block_on(engine::import(&api, &second.0, |_| {})).unwrap();
    assert_eq!(
        api.0.borrow().revision,
        revision,
        "unchanged pins do not rewrite revision"
    );
}

#[test]
fn migration_waits_for_background_sync_and_preserves_safe_failure_reason() {
    let api = Fake::default();
    api.0.borrow_mut().sync_busy = 2;
    block_on(engine::sync_library(&api)).unwrap();
    assert_eq!(api.0.borrow().waits, [1, 1]);
    api.0.borrow_mut().sync_failed = true;
    assert_eq!(
        block_on(engine::sync_library(&api)).unwrap_err(),
        "MIGRATION_LIBRARY_SYNC_REQUIRED"
    );
    let f = Fixture::new();
    f.seed();
    api.0.borrow_mut().interrupt_after_commit = true;
    assert!(block_on(engine::import(&api, &f.0, |_| {})).is_err());
    assert_eq!(
        report(&f.0).unwrap().last_error.as_deref(),
        Some("MIGRATION_NETWORK")
    );
    api.0.borrow_mut().interrupt_after_commit = false;
    block_on(engine::import(&api, &f.0, |_| {})).unwrap();
    assert!(report(&f.0).unwrap().last_error.is_none());
    assert_eq!(
        safe_error("https://private.example/?token=secret"),
        "MIGRATION_RETRY_REQUIRED"
    );
}

#[test]
fn store_labels_prefer_profile_then_package_then_listing_without_changing_machine_name() {
    let f = Fixture::new();
    let mut r = f.seed();
    r.category = "reacquire".into();
    r.name = "painted-animation--device-identity".into();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file("SKILL.md", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"---\nname: painted-animation\n---\n")
        .unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    let listing = json!({"name":"listing-name"});
    r.display_name = Some(snapshot::store_display_name(
        Some("Sample"),
        Some(&bytes),
        Some(&listing),
    ));
    f.0.put(&r).unwrap();
    assert_eq!(report(&f.0).unwrap().items[0].name, "Sample");
    r.item.as_mut().unwrap().profile.display_name.clear();
    r.display_name = Some(snapshot::store_display_name(
        None,
        Some(&bytes),
        Some(&listing),
    ));
    f.0.put(&r).unwrap();
    assert_eq!(report(&f.0).unwrap().items[0].name, "painted-animation");
    assert_eq!(
        f.0.record(&r.id).unwrap().name,
        "painted-animation--device-identity"
    );
    assert_eq!(snapshot::store_name(None, Some(&listing)), "listing-name");
    assert_eq!(snapshot::store_name(None, None), "商店 Skill");
}

#[test]
fn local_store_snapshot_does_not_display_the_protocol_profile_name_fallback() {
    let f = Fixture::new();
    let source =
        crate::runtime_env::new_space_session_at(&f.0.root, Deployment::Local, None, 0).unwrap();
    let user = uuid::Uuid::new_v4().to_string();
    let target = crate::runtime_env::new_space_session_at(
        &f.0.root,
        deployment(3003),
        Some(("target-token", &user)),
        1,
    )
    .unwrap();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let body = "---\nname: painted-animation\n---\n";
    zip.start_file("SKILL.md", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(body.as_bytes()).unwrap();
    let package = zip.finish().unwrap().into_inner();
    let id = uuid::Uuid::new_v4().to_string();
    let folder = "painted-animation--device-id";
    let dir = f.0.root.join("skills").join(folder);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("SKILL.md"), body).unwrap();
    write_private_json(
        &dir.join(".skillhub.json"),
        &json!({"skillhub":{
            "id":uuid::Uuid::new_v4(),"name":folder,"serverId":id,"acquisitionSource":"marketplace",
            "acquisitionVersion":"0.2.0","acquisitionPackageSha256":sha(&package),
            "scope":crate::spaces::SidecarScope::for_session(&source)
        }}),
    )
    .unwrap();
    let api = SourceFake {
        package,
        own_id: String::new(),
        target_user: user,
        entries: vec![json!({"sourceSkillId":id,"name":"listing-name"})],
        export_reads: RefCell::new(0),
        avatar_export_supported: true,
    };
    run_snapshot(&f, &source, &target, &api).unwrap();
    let report = report(&f.0).unwrap();
    assert_eq!(report.items[0].name, "painted-animation");
    let record = f.0.record(&report.items[0].id).unwrap();
    assert_eq!(record.item.unwrap().profile.display_name, folder);
    assert_eq!(record.source_local_id.as_deref(), Some(folder));
}
