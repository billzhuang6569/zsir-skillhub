use super::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::Method;
use snapshot::json_request;

fn migration_path(m: &Manifest) -> Result<String, String> {
    let id = m
        .migration_id
        .as_deref()
        .ok_or("MIGRATION_SNAPSHOT_INCOMPLETE")?;
    uuid::Uuid::parse_str(id).map_err(|_| "MIGRATION_INVALID_ID")?;
    Ok(format!("api/migrations/{id}"))
}

pub(super) async fn precheck<T: Transport>(
    api: &T,
    store: &Store,
    m: &Manifest,
) -> Result<(), String> {
    let path = format!("{}/precheck", migration_path(m)?);
    let mut batch = Vec::new();
    let mut size = 32;
    for id in &m.records {
        let r = store.record(id)?;
        if r.choice == Choice::Skip || r.category == "reacquire" || r.result.is_some() {
            continue;
        }
        let Some(item) = r.item else { continue };
        let bytes = serde_json::to_vec(&item)
            .map_err(|_| "MIGRATION_SERIALIZE")?
            .len();
        if bytes > 900_000 {
            return Err("MIGRATION_PRECHECK_ITEM_TOO_LARGE".into());
        }
        if batch.len() == 1000 || size + bytes > 900_000 {
            precheck_batch(api, store, &path, &batch).await?;
            batch.clear();
            size = 32;
        }
        size += bytes + 1;
        batch.push((r.id, item));
    }
    if !batch.is_empty() {
        precheck_batch(api, store, &path, &batch).await?;
    }
    Ok(())
}
async fn precheck_batch<T: Transport>(
    api: &T,
    store: &Store,
    path: &str,
    batch: &[(String, Item)],
) -> Result<(), String> {
    let result = json_request(
        api,
        Side::Target,
        Method::POST,
        path,
        Some(json!({"items":batch.iter().map(|(_, item)| item).collect::<Vec<_>>()})),
    )
    .await?;
    let checks: Vec<Precheck> = serde_json::from_value(result["items"].clone())
        .map_err(|_| "MIGRATION_INVALID_PRECHECK")?;
    for (id, item) in batch {
        let check = checks
            .iter()
            .find(|c| c.operation_key == item.operation_key())
            .ok_or("MIGRATION_INVALID_PRECHECK")?;
        let mut r = store.record(id)?;
        r.precheck = Some(check.clone());
        store.put(&r)?;
    }
    Ok(())
}

async fn reconcile<T: Transport>(
    api: &T,
    store: &Store,
    m: &Manifest,
    r: &mut Record,
) -> Result<bool, String> {
    let status = json_request(api, Side::Target, Method::GET, &migration_path(m)?, None).await?;
    let key = r
        .item
        .as_ref()
        .ok_or("MIGRATION_ITEM_UNAVAILABLE")?
        .operation_key();
    let records = status["items"]
        .as_array()
        .ok_or("MIGRATION_INVALID_RESPONSE")?;
    if let Some(record) = records.iter().find(|record| record["operationKey"] == key) {
        let result: ItemResult = serde_json::from_value(record["result"].clone())
            .map_err(|_| "MIGRATION_INVALID_RESPONSE")?;
        if result.operation_key != key
            || !matches!(result.status.as_str(), "imported" | "mapped" | "failed")
        {
            return Err("MIGRATION_INVALID_RESPONSE".into());
        }
        r.state = result.status.clone();
        r.reason = result.errors.join(",");
        r.result = Some(result);
        store.put(r)?;
        return Ok(true);
    }
    Ok(false)
}

async fn import_item<T: Transport>(
    api: &T,
    store: &Store,
    m: &Manifest,
    r: &mut Record,
) -> Result<(), String> {
    if r.result.is_some() || reconcile(api, store, m, r).await? {
        return Ok(());
    }
    let item = r.item.clone().ok_or("MIGRATION_ITEM_UNAVAILABLE")?;
    if let Some(check) = &r.precheck {
        if matches!(check.status.as_str(), "conflict" | "over_quota") {
            r.state = "awaitingChoice".into();
            r.reason = check.reason.clone();
            store.put(r)?;
            return Ok(());
        }
    }
    let path = migration_path(m)?;
    if item.map_to_skill_id.is_none() {
        for avatar in &item.avatars {
            let bytes = store.blob("avatar", &avatar.sha256)?;
            let body = json!({
                "operation": {"sourceOrigin":item.source_origin,"sourceUserId":item.source_user_id,
                    "sourceSkillId":item.source_skill_id,"contentHash":item.content_hash},
                "avatar":avatar, "dataBase64":BASE64.encode(bytes)
            });
            let mut attempts = 0;
            loop {
                let reply = api
                    .request(
                        Side::Target,
                        Method::POST,
                        &format!("{path}/avatars"),
                        Some(body.clone()),
                    )
                    .await;
                match reply {
                    Ok(reply) if reply.status == 429 => {
                        api.wait(reply.retry_after).await?;
                    }
                    Ok(reply) if reply.status < 500 => {
                        reply.json::<Value>()?;
                        break;
                    }
                    _ => {
                        let state =
                            json_request(api, Side::Target, Method::GET, &path, None).await?;
                        if state["avatarUploads"].as_array().is_some_and(|a| {
                            a.iter().any(|u| {
                                u["operationKey"] == item.operation_key()
                                    && u["avatarId"] == avatar.id
                            })
                        }) {
                            break;
                        }
                        attempts += 1;
                        if attempts >= 3 {
                            return Err("MIGRATION_AVATAR_RETRY_REQUIRED".into());
                        }
                        api.wait(attempts).await?;
                    }
                }
            }
        }
    }
    let mut body = json!({"item":item});
    if item.map_to_skill_id.is_none() {
        body["packageBase64"] =
            Value::String(BASE64.encode(store.blob("pkg", &item.package_sha256)?));
    }
    // Freeze choices before the first possible server commit, including a lost response.
    r.state = "submitting".into();
    store.put(r)?;
    let mut attempts = 0;
    loop {
        api.check()?;
        let reply = api
            .request(
                Side::Target,
                Method::POST,
                &format!("{path}/items"),
                Some(body.clone()),
            )
            .await;
        match reply {
            Ok(reply) if reply.status == 429 => {
                api.wait(reply.retry_after).await?;
            }
            Ok(reply) if reply.status < 500 => {
                if reconcile(api, store, m, r).await? {
                    return Ok(());
                }
                if reply.status == 409 || reply.status == 404 {
                    r.state = "awaitingChoice".into();
                    // Fixed codes only; never persist raw server errors.
                    r.reason = if reply.status == 409 {
                        "MIGRATION_CONFLICT"
                    } else {
                        "MIGRATION_TARGET_NOT_FOUND"
                    }
                    .into();
                    store.put(r)?;
                    return Ok(());
                }
                return Err(format!("MIGRATION_ITEM_HTTP_{}", reply.status));
            }
            _ => {
                if reconcile(api, store, m, r).await? {
                    return Ok(());
                }
                attempts += 1;
                if attempts >= 3 {
                    return Err("MIGRATION_RETRY_REQUIRED".into());
                }
                api.wait(attempts).await?;
            }
        }
    }
}

async fn bind_library<T: Transport>(api: &T, store: &Store, r: &mut Record) -> Result<(), String> {
    if r.library_done {
        return Ok(());
    }
    let item = r.item.as_ref().ok_or("MIGRATION_ITEM_UNAVAILABLE")?;
    let result = r.result.as_ref();
    let reacquire = r.category == "reacquire";
    if !reacquire && !result.is_some_and(|r| matches!(r.status.as_str(), "imported" | "mapped")) {
        return Ok(());
    }
    let target_id = if reacquire {
        &item.source_skill_id
    } else {
        result
            .and_then(|r| r.target_skill_id.as_ref())
            .ok_or("MIGRATION_TARGET_MISSING")?
    };
    uuid::Uuid::parse_str(target_id).map_err(|_| "MIGRATION_INVALID_TARGET")?;
    let library = json_request(api, Side::Target, Method::GET, "api/library", None).await?;
    if reacquire
        && library["entries"]
            .as_array()
            .ok_or("MIGRATION_INVALID_RESPONSE")?
            .iter()
            .any(|e| {
                e["deletedAt"].is_null()
                    && matches!(e["sourceKind"].as_str(), Some("catalog" | "marketplace"))
                    && e["sourceSkillId"] == *target_id
                    && e["card"]["sha256"] != item.package_sha256
            })
    {
        r.state = "awaitingChoice".into();
        r.reason = "TARGET_CATALOG_VERSION_CONFLICT".into();
        return store.put(r);
    }
    let existing = library["entries"]
        .as_array()
        .ok_or("MIGRATION_INVALID_RESPONSE")?
        .iter()
        .find(|e| {
            e["deletedAt"].is_null()
                && if reacquire {
                    matches!(e["sourceKind"].as_str(), Some("catalog" | "marketplace"))
                        && e["sourceSkillId"] == *target_id
                        && e["card"]["sha256"] == item.package_sha256
                } else {
                    e["authorSkillId"] == *target_id
                }
        });
    if let Some(entry) = existing {
        r.target_entry_id = entry["id"]
            .as_str()
            .ok_or("MIGRATION_INVALID_RESPONSE")?
            .into();
    } else {
        let m = store.manifest()?;
        let (source, migration_key) = if reacquire {
            // Recheck the listing at import time; never silently replace a held version.
            let listing = json_request(
                api,
                Side::Catalog,
                Method::GET,
                &format!("api/marketplace/{target_id}"),
                None,
            )
            .await?;
            if snapshot::classify_store(&item.version, &item.package_sha256, Some(&listing), false)
                .0
                != "reacquire"
            {
                return Err("CATALOG_VERSION_CHANGED".into());
            }
            if m.target.profile == "selfhost" {
                let bytes = api.catalog_package(target_id, &item.package_sha256).await?;
                let card = json_request(api, Side::Target, Method::POST, "api/cards",
                    Some(json!({"packageBase64":BASE64.encode(bytes),"packageSha256":item.package_sha256}))).await?;
                if card["sha256"] != item.package_sha256 {
                    return Err("MIGRATION_HASH_MISMATCH".into());
                }
                (
                    json!({"kind":"catalog","skillId":target_id,"version":item.version,"packageSha256":item.package_sha256}),
                    None,
                )
            } else {
                (
                    json!({"kind":"marketplace","skillId":target_id}),
                    Some(format!("marketplace:{target_id}")),
                )
            }
        } else {
            (
                json!({"kind":"authored","skillId":target_id}),
                Some(format!("authored:{target_id}")),
            )
        };
        let mut name = item
            .target_name
            .as_deref()
            .unwrap_or(&item.name)
            .to_string();
        let mut profile = item.profile.clone();
        if result.is_some_and(|r| r.status == "mapped") {
            let skills = json_request(api, Side::Target, Method::GET, "api/skills", None).await?;
            let skill = skills
                .as_array()
                .and_then(|a| a.iter().find(|s| s["id"] == *target_id))
                .ok_or("MIGRATION_TARGET_MISSING")?;
            name = skill["name"]
                .as_str()
                .ok_or("MIGRATION_INVALID_RESPONSE")?
                .into();
            profile = serde_json::from_value::<SyncProfile>(skill.clone())
                .map_err(|_| "MIGRATION_INVALID_PROFILE")?
                .normalized();
        }
        let mut body = json!({
            "id":r.target_entry_id,"name":name,"profile":profile,"source":source,
            "device":crate::library_sync::api::device_label()
        });
        if let Some(key) = migration_key {
            body["migrationKey"] = Value::String(key);
        }
        let entry =
            json_request(api, Side::Target, Method::POST, "api/library", Some(body)).await?;
        if !entry["deletedAt"].is_null()
            || if reacquire {
                entry["sourceSkillId"] != *target_id
                    || !matches!(
                        entry["sourceKind"].as_str(),
                        Some("catalog" | "marketplace")
                    )
                    || entry["card"]["sha256"] != item.package_sha256
            } else {
                entry["authorSkillId"] != *target_id
            }
        {
            r.state = "awaitingChoice".into();
            r.reason = "TARGET_LIBRARY_CONFLICT".into();
            return store.put(r);
        }
        r.target_entry_id = entry["id"]
            .as_str()
            .ok_or("MIGRATION_INVALID_RESPONSE")?
            .into();
    }
    uuid::Uuid::parse_str(&r.target_entry_id).map_err(|_| "MIGRATION_INVALID_RESPONSE")?;
    r.library_done = true;
    if reacquire {
        r.state = if existing.is_some() {
            "mapped"
        } else {
            "imported"
        }
        .into();
        r.reason.clear();
    }
    store.put(r)
}

async fn organize<T: Transport>(
    api: &T,
    store: &Store,
    m: &Manifest,
    r: &mut Record,
) -> Result<(), String> {
    if !r.library_done || r.organizer_done {
        return Ok(());
    }
    let mut tags = BTreeSet::new();
    for key in source_keys(r) {
        if let Some(names) = m.organizer.tags.get(&key) {
            tags.extend(names.iter().cloned());
        }
    }
    if !tags.is_empty() {
        json_request(
            api,
            Side::Target,
            Method::PATCH,
            &format!("api/library/tags/{}", r.target_entry_id),
            Some(json!({"add":tags,"remove":[]})),
        )
        .await?;
    }
    r.organizer_done = true;
    store.put(r)
}
fn source_keys(r: &Record) -> Vec<String> {
    r.source_entry_id
        .iter()
        .map(|s| format!("entry:{s}"))
        .chain(r.source_entry_aliases.iter().map(|s| format!("entry:{s}")))
        .chain(r.source_local_id.iter().map(|s| format!("local:{s}")))
        .chain(r.source_local_aliases.iter().map(|s| format!("local:{s}")))
        .collect()
}

async fn quick_access<T: Transport>(api: &T, store: &Store, m: &Manifest) -> Result<(), String> {
    let mut mapping = BTreeMap::new();
    for id in &m.records {
        let r = store.record(id)?;
        if r.library_done {
            for key in source_keys(&r) {
                mapping.insert(key, r.target_entry_id.clone());
            }
        }
    }
    for _ in 0..3 {
        let current = json_request(
            api,
            Side::Target,
            Method::GET,
            "api/library/quick-access",
            None,
        )
        .await?;
        let mut items = current["items"]
            .as_array()
            .ok_or("MIGRATION_INVALID_RESPONSE")?
            .clone();
        for q in &m.organizer.quick_access.items {
            let reference = match q.kind {
                crate::library_organizer::QuickAccessKind::Skill => {
                    let Some(id) = mapping.get(&q.reference) else {
                        continue;
                    };
                    id.clone()
                }
                crate::library_organizer::QuickAccessKind::Tag => q.reference.clone(),
            };
            let value = json!({"kind":q.kind,"ref":reference});
            if !items.contains(&value) {
                items.push(value);
            }
        }
        if current["items"] == json!(items) {
            return Ok(());
        }
        let reply = api
            .request(
                Side::Target,
                Method::PUT,
                "api/library/quick-access",
                Some(json!({"baseRevision":current["revision"],"items":items})),
            )
            .await?;
        if reply.status == 409 {
            continue;
        }
        if reply.status == 429 {
            api.wait(reply.retry_after).await?;
            continue;
        }
        reply.json::<Value>()?;
        return Ok(());
    }
    Err("MIGRATION_ORGANIZER_RETRY".into())
}

pub(super) async fn import<T: Transport>(
    api: &T,
    store: &Store,
    emit: impl Fn(MigrationStatus),
) -> Result<(), String> {
    let mut m = store.manifest()?;
    migration_path(&m)?;
    m.state = "running".into();
    m.last_error = None;
    store.save(&m)?;
    emit(report(store)?);
    let result = async {
        precheck(api, store, &m).await?;
        for id in &m.records {
            api.check()?;
            let mut r = store.record(id)?;
            if r.choice == Choice::Skip {
                r.state = "skipped".into();
                if r.reason.is_empty() {
                    r.reason = "USER_SKIPPED".into();
                }
                store.put(&r)?;
                emit(report(store)?);
                continue;
            }
            if r.category != "reacquire" {
                import_item(api, store, &m, &mut r).await?;
            }
            bind_library(api, store, &mut r).await?;
            organize(api, store, &m, &mut r).await?;
            emit(report(store)?);
        }
        quick_access(api, store, &m).await
    }
    .await;
    m.state = if result.is_ok() { "imported" } else { "paused" }.into();
    m.last_error = result.as_ref().err().map(|error| safe_error(error));
    store.save(&m)?;
    result
}

pub(super) async fn sync_library<T: Transport>(api: &T) -> Result<(), String> {
    loop {
        api.check()?;
        match api.sync_library().await {
            Ok(()) => return Ok(()),
            Err(crate::library_sync::SyncError::Busy) => api.wait(1).await?,
            Err(crate::library_sync::SyncError::AccountChanged) => {
                return Err("MIGRATION_SESSION_CHANGED".into())
            }
            Err(_) => return Err("MIGRATION_LIBRARY_SYNC_REQUIRED".into()),
        }
    }
}

pub(super) async fn run(
    api: &Native<'_>,
    store: &Store,
    emit: impl Fn(MigrationStatus),
) -> Result<(), String> {
    import(api, store, &emit).await?;
    api.check()?;
    // Reuse verified landing, sidecar scope and index binding; this path has no AI jobs.
    sync_library(api).await?;
    api.check()?;
    let home = api.registry.migration_root();
    let mut m = store.manifest()?;
    let locals = crate::library_sync::engine::scan_managed(
        &home.join("skills"),
        crate::commands::library_read_profile_readonly,
    )?;
    let mut mapping = BTreeMap::new();
    let mut complete = true;
    for id in &m.records {
        let mut r = store.record(id)?;
        if r.library_done {
            r.target_local_id = locals
                .iter()
                .find(|l| {
                    crate::spaces::profile_matches(&l.sidecar, &api.target)
                        && l.sidecar.library_entry_id.as_deref() == Some(&r.target_entry_id)
                })
                .map(|l| l.skill_id.clone());
            if let (Some(source), Some(target)) = (&r.source_local_id, &r.target_local_id) {
                mapping.insert(source.clone(), target.clone());
            }
            if let Some(target) = &r.target_local_id {
                for source in &r.source_local_aliases {
                    mapping.insert(source.clone(), target.clone());
                }
            }
        }
        complete &= matches!(
            r.state.as_str(),
            "imported" | "mapped" | "skipped" | "failed"
        );
        store.put(&r)?;
    }
    if complete && !m.keys_done && !m.keys.is_empty() {
        // Do not silently discard authorization mappings while a target folder is still pending.
        if m.records.iter().any(|id| {
            store.record(id).is_ok_and(|r| {
                r.library_done
                    && (r.source_local_id.is_some() || !r.source_local_aliases.is_empty())
                    && r.target_local_id.is_none()
            })
        }) {
            return Err("MIGRATION_LIBRARY_SYNC_REQUIRED".into());
        }
        api.check()?;
        crate::key_vault::with_current_identity_at(
            home,
            &home.join("envs"),
            Some(api.target.user_id()),
            Some(&SpaceRegistry::handle(Some(&api.target))),
            |target_root, _, user| {
                crate::key_vault::apply_migration_key_journal(target_root, user)?;
                let receipt = sha(&serde_json::to_vec(&(&m.local_migration_id, &m.keys))
                    .map_err(|_| "MIGRATION_SERIALIZE")?);
                let receipt_path =
                    crate::key_vault::migration_key_receipt(target_root, user, &receipt)?;
                // Persist the outcome plan before copying; a completed receipt reuses it after a crash.
                if !receipt_path.exists() {
                    let names = crate::key_vault::vault_key_names_at(target_root, user)?;
                    let meta = crate::key_vault::read_meta_at(target_root, user)?;
                    m.key_results = m
                        .keys
                        .iter()
                        .map(|key| {
                            let target_name = match &key.conflict {
                                crate::key_vault::MigrationKeyConflict::Rename { name } => {
                                    name.clone()
                                }
                                _ => key.name.clone(),
                            };
                            let exists = names.contains(&target_name)
                                || meta.keys.contains_key(&target_name);
                            KeyResult {
                                name: key.name.clone(),
                                target_name,
                                status: if exists
                                    && matches!(
                                        key.conflict,
                                        crate::key_vault::MigrationKeyConflict::Skip
                                    ) {
                                    "skipped"
                                } else {
                                    "copied"
                                }
                                .into(),
                            }
                        })
                        .collect();
                    store.save(&m)?;
                }
                crate::key_vault::copy_migration_keys_at(
                    &m.source_deployment.root(home),
                    &m.source.user_id,
                    target_root,
                    user,
                    &m.keys,
                    &mapping,
                    &receipt,
                )
            },
        )?;
        m.keys_done = true;
    }
    // Preserve local grouping/collapse settings alongside the server organizer.
    let _lease = crate::runtime_env::acquire_current_session_lease_at(home, &api.target)?
        .ok_or(crate::spaces::STALE)?;
    let root = api.target.storage_root(home);
    let mut organizer = crate::library_organizer::load_organizer_at(&root, api.target.user_id())?;
    for id in &m.records {
        let r = store.record(id)?;
        if !r.library_done {
            continue;
        }
        for key in source_keys(&r) {
            if let Some(tags) = m.organizer.tags.get(&key) {
                let dest = organizer
                    .tags
                    .entry(format!("entry:{}", r.target_entry_id))
                    .or_default();
                for tag in tags {
                    if !dest.contains(tag) {
                        dest.push(tag.clone());
                    }
                }
            }
        }
    }
    for tag in &m.organizer.collapsed_tags {
        if !organizer.collapsed_tags.contains(tag) {
            organizer.collapsed_tags.push(tag.clone());
        }
    }
    crate::library_organizer::save_organizer_at(&root, api.target.user_id(), &organizer)?;
    m.state = if complete {
        "completed"
    } else {
        "awaitingChoice"
    }
    .into();
    store.save(&m)?;
    emit(report(store)?);
    Ok(())
}
