use super::*;
use crate::library_sync::{content, engine::LocalSkill};
use reqwest::Method;

/// A source has a scoped local inventory and optionally a read-only server handle.
struct SourceContext<'a> {
    session: &'a RuntimeSession,
    managed: PathBuf,
    locals: Vec<LocalSkill>,
}

impl SourceContext<'_> {
    fn displayed_avatar(&self, entry: &str, local: Option<&LocalSkill>) -> Option<String> {
        let root = self.session.storage_root(self.managed.parent()?);
        for id in
            std::iter::once(entry).chain(local.and_then(|l| l.sidecar.avatar_local_id.as_deref()))
        {
            if uuid::Uuid::parse_str(id).is_err() {
                continue;
            }
            let cache = root
                .join("avatars")
                .join(self.session.user_id())
                .join(format!("{id}.json"));
            if let Ok(value) = crate::runtime_env::read_private_json::<Value>(&cache) {
                if value["avatarStatus"] == "ready" {
                    if let Some(url) = value["avatarUrl"].as_str() {
                        return Some(url.into());
                    }
                }
            }
        }
        None
    }

    fn local_for(&self, skill: &str, entry: Option<&str>) -> Option<&LocalSkill> {
        self.locals.iter().find(|l| {
            l.sidecar.server_id.as_deref() == Some(skill)
                || entry.is_some_and(|id| l.sidecar.library_entry_id.as_deref() == Some(id))
        })
    }
}

pub(super) async fn json_request<T: Transport>(
    api: &T,
    side: Side,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    loop {
        api.check()?;
        let reply = api
            .request(side, method.clone(), path, body.clone())
            .await?;
        if reply.status == 429 {
            api.wait(reply.retry_after).await?;
            continue;
        }
        return reply.json();
    }
}

async fn get<T: Transport>(api: &T, side: Side, path: &str) -> Result<transport::Reply, String> {
    loop {
        api.check()?;
        let reply = api.request(side, Method::GET, path, None).await?;
        if reply.status == 429 {
            api.wait(reply.retry_after).await?;
            continue;
        }
        return Ok(reply);
    }
}

async fn held_version<T: Transport>(
    api: &T,
    entry: &Value,
    local: Option<&LocalSkill>,
) -> Result<String, String> {
    let kind = entry["sourceKind"].as_str().unwrap_or("local");
    let direct = if kind == "catalog" {
        entry["sourceVersionId"].as_str()
    } else {
        entry["version"]["formalLabel"]
            .as_str()
            .or_else(|| entry["version"]["label"].as_str())
    };
    if let Some(version) =
        direct.or_else(|| local.and_then(|l| l.sidecar.acquisition_version.as_deref()))
    {
        return Ok(version.into());
    }
    if let (Some(skill), Some(version_id)) = (
        entry["sourceSkillId"].as_str(),
        entry["sourceVersionId"].as_str(),
    ) {
        let versions = json_request(
            api,
            Side::Source,
            Method::GET,
            &format!("api/skills/{skill}/versions"),
            None,
        )
        .await?;
        if let Some(version) = versions
            .as_array()
            .and_then(|a| a.iter().find(|v| v["id"] == version_id))
            .and_then(|v| v["version"].as_str())
        {
            return Ok(version.into());
        }
    }
    Err("SOURCE_VERSION_UNAVAILABLE".into())
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .ok_or_else(|| "MIGRATION_INVALID_RESPONSE".into())
}
fn profile(v: &Value) -> Result<SyncProfile, String> {
    serde_json::from_value::<SyncProfile>(v.clone())
        .map(|p| p.normalized())
        .map_err(|_| "MIGRATION_INVALID_PROFILE".into())
}
fn new_record(id: &str, name: &str, category: &str) -> Record {
    Record {
        id: uuid::Uuid::new_v4().to_string(),
        source_skill_id: id.into(),
        name: name.into(),
        display_name: None,
        category: category.into(),
        item: None,
        choice: Choice::Copy { target_name: None },
        source_entry_id: None,
        source_local_id: None,
        source_entry_aliases: Vec::new(),
        source_local_aliases: Vec::new(),
        target_entry_id: uuid::Uuid::new_v4().to_string(),
        target_local_id: None,
        state: "pending".into(),
        reason: String::new(),
        warnings: Vec::new(),
        pending_delta: false,
        result: None,
        precheck: None,
        library_done: false,
        organizer_done: false,
    }
}

fn package_identity(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_PACKAGE {
        return Err("MIGRATION_PACKAGE_TOO_LARGE".into());
    }
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| "MIGRATION_INVALID_PACKAGE")?;
    if archive.len() > 2000 {
        return Err("MIGRATION_INVALID_PACKAGE".into());
    }
    let mut files = Vec::new();
    let mut names = BTreeSet::new();
    let mut total = 0;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|_| "MIGRATION_INVALID_PACKAGE")?;
        if file.enclosed_name().is_none()
            || file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
            || file.name().contains('\\')
        {
            return Err("MIGRATION_INVALID_PACKAGE".into());
        }
        if file.is_dir() {
            continue;
        }
        let name = content::nfc(file.name());
        if !names.insert(name.clone()) || file.size() > MAX_PACKAGE as u64 {
            return Err("MIGRATION_INVALID_PACKAGE".into());
        }
        let mut data = Vec::new();
        (&mut file)
            .take(MAX_PACKAGE as u64 + 1)
            .read_to_end(&mut data)
            .map_err(|_| "MIGRATION_INVALID_PACKAGE")?;
        total += data.len();
        if data.len() > MAX_PACKAGE || total > 100 * 1024 * 1024 {
            return Err("MIGRATION_INVALID_PACKAGE".into());
        }
        files.push((name, data));
    }
    if !names.contains("SKILL.md") {
        return Err("MIGRATION_INVALID_PACKAGE".into());
    }
    Ok(content::content_hash(&files))
}

fn make_item(
    source: &Identity,
    record: &Record,
    version: &str,
    p: SyncProfile,
    bytes: &[u8],
) -> Result<Item, String> {
    if !resource(&record.source_skill_id) {
        return Err("MIGRATION_SOURCE_ID_INVALID".into());
    }
    Ok(Item {
        source_origin: source.origin.clone(),
        source_user_id: source.user_id.clone(),
        source_skill_id: record.source_skill_id.clone(),
        content_hash: package_identity(bytes)?,
        kind: if record.category == "store_copy" {
            "store_copy"
        } else {
            "own_skill"
        }
        .into(),
        version: version.into(),
        name: record.name.clone(),
        profile: p,
        package_size: bytes.len(),
        package_sha256: sha(bytes),
        avatars: Vec::new(),
        selected_avatar_id: None,
        store_copy: None,
        target_name: None,
        map_to_skill_id: None,
    })
}

async fn source_package<T: Transport>(
    api: &T,
    skill: &str,
    hash: Option<&str>,
) -> Result<Vec<u8>, String> {
    if let Some(hash) = hash.filter(|s| hash_valid(s)) {
        let response = get(api, Side::Source, &format!("api/cards/{hash}")).await?;
        if response.status == 200 {
            if sha(&response.bytes) != hash {
                return Err("MIGRATION_HASH_MISMATCH".into());
            }
            let meta = json_request(
                api,
                Side::Source,
                Method::GET,
                &format!("api/cards/{hash}/meta"),
                None,
            )
            .await?;
            if package_identity(&response.bytes)? != text(&meta, "contentHash")? {
                return Err("MIGRATION_HASH_MISMATCH".into());
            }
            return Ok(response.bytes);
        }
        if !matches!(response.status, 404 | 410) {
            return Err(format!("HTTP_{}", response.status));
        }
    }
    // Legacy source fallback is deliberately last; it consumes install/download quota.
    let response = get(api, Side::Source, &format!("api/skills/{skill}/package")).await?;
    if matches!(response.status, 403 | 404 | 409 | 410) {
        return Err("SOURCE_PACKAGE_UNAVAILABLE".into());
    }
    if response.status != 200 {
        return Err(format!("HTTP_{}", response.status));
    }
    if hash.is_some_and(|h| sha(&response.bytes) != h) {
        return Err("MIGRATION_HASH_MISMATCH".into());
    }
    Ok(response.bytes)
}

pub(super) fn classify_store(
    held: &str,
    sha: &str,
    listing: Option<&Value>,
    delisted: bool,
) -> (&'static str, &'static str) {
    if let Some(listing) = listing {
        if listing["currentVersion"] == held && listing["version"]["packageSha256"] == sha {
            return ("reacquire", "current");
        }
        return ("store_copy", "outdated");
    }
    ("store_copy", if delisted { "delisted" } else { "current" })
}

async fn remote_records<T: Transport>(
    api: &T,
    store: &Store,
    ctx: &SourceContext<'_>,
    m: &mut Manifest,
) -> Result<Vec<Record>, String> {
    let own = json_request(api, Side::Source, Method::GET, "api/skills", None).await?;
    let own = own.as_array().ok_or("MIGRATION_INVALID_RESPONSE")?;
    let library = json_request(api, Side::Source, Method::GET, "api/library", None).await?;
    let entries = library["entries"]
        .as_array()
        .ok_or("MIGRATION_INVALID_RESPONSE")?;
    let mut records = Vec::new();
    let mut owned = BTreeSet::new();
    for skill in own {
        api.check()?;
        let id = text(skill, "id")?;
        if !resource(id) {
            return Err("MIGRATION_SOURCE_ID_INVALID".into());
        }
        owned.insert(id.to_string());
        let mut r = new_record(id, text(skill, "name")?, "own_skill");
        r.source_entry_id = entries
            .iter()
            .find(|e| e["authorSkillId"] == id && e["deletedAt"].is_null())
            .and_then(|e| e["id"].as_str())
            .map(str::to_owned);
        let outcome = async {
            let version = text(skill, "currentVersion")?;
            let versions = json_request(
                api,
                Side::Source,
                Method::GET,
                &format!("api/skills/{id}/versions"),
                None,
            )
            .await?;
            let versions = versions.as_array().ok_or("MIGRATION_INVALID_RESPONSE")?;
            let current = versions
                .iter()
                .find(|v| v["version"] == version)
                .ok_or("SOURCE_VERSION_UNAVAILABLE")?;
            let bytes = source_package(api, id, current["packageSha256"].as_str()).await?;
            let p = r
                .source_entry_id
                .as_ref()
                .and_then(|id| entries.iter().find(|e| e["id"] == *id))
                .map(|e| &e["profile"])
                .unwrap_or(skill);
            let p = if p == skill {
                serde_json::from_value::<crate::library_sync::api::OwnSkill>(skill.clone())
                    .map_err(|_| "MIGRATION_INVALID_PROFILE")?
                    .profile()
            } else {
                profile(p)?
            };
            let mut item = make_item(&m.source, &r, version, p, &bytes)?;
            if skill["storeCopy"].is_object() {
                item.kind = "store_copy".into();
                item.store_copy = Some(StoreCopy {
                    listing_id: text(&skill["storeCopy"], "listingId")?.into(),
                    version: text(&skill["storeCopy"], "version")?.into(),
                    state: text(&skill["storeCopy"], "state")?.into(),
                });
            }
            store.stage("pkg", &bytes)?;
            export_avatars(
                api,
                store,
                &mut item,
                &mut r.warnings,
                skill["avatarUrl"]
                    .as_str()
                    .map(|url| (url, skill["avatarSource"].as_str() != Some("custom"))),
                false,
            )
            .await?;
            Ok::<_, String>(item)
        }
        .await;
        complete_record(ctx, &mut r, outcome)?;
        for entry in entries
            .iter()
            .filter(|e| e["authorSkillId"] == id && e["deletedAt"].is_null())
        {
            let entry_id = text(entry, "id")?;
            if r.source_entry_id.as_deref() != Some(entry_id) {
                r.source_entry_aliases.push(entry_id.into());
            }
            for local in ctx
                .locals
                .iter()
                .filter(|l| l.sidecar.library_entry_id.as_deref() == Some(entry_id))
            {
                if r.source_local_id.as_deref() != Some(&local.skill_id) {
                    r.source_local_aliases.push(local.skill_id.clone());
                    if let Some(item) = &r.item {
                        r.pending_delta |=
                            content::local_identity(&ctx.managed.join(&local.skill_id), None)
                                .map(|(identity, _)| identity.content_hash != item.content_hash)
                                .unwrap_or(true);
                    }
                }
            }
        }
        records.push(r);
    }
    for entry in entries.iter().filter(|e| e["deletedAt"].is_null()) {
        let entry_id = text(entry, "id")?;
        if entry["authorSkillId"]
            .as_str()
            .is_some_and(|s| owned.contains(s))
        {
            continue;
        }
        let source_kind = entry["sourceKind"].as_str().unwrap_or("local");
        let source_id = entry["sourceSkillId"].as_str().unwrap_or(entry_id);
        let mut r = new_record(source_id, text(entry, "name")?, source_kind);
        if matches!(source_kind, "marketplace" | "catalog") {
            r.display_name = Some(
                entry["profile"]["displayName"]
                    .as_str()
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or("商店 Skill")
                    .into(),
            );
        }
        r.source_entry_id = Some(entry_id.into());
        if source_kind == "team" {
            skip(&mut r, "TEAM_SHARED_NOT_COPYABLE");
            records.push(r);
            continue;
        }
        let outcome = async {
            let hash = text(&entry["card"], "sha256")?;
            let local = ctx.local_for(source_id, Some(entry_id));
            let version = held_version(api, entry, local).await?;
            let version = version.as_str();
            let mut state = "current";
            let mut store_listing = None;
            if matches!(source_kind, "marketplace" | "catalog") {
                let listing = api
                    .request(
                        Side::Catalog,
                        Method::GET,
                        &format!("api/marketplace/{source_id}"),
                        None,
                    )
                    .await;
                let delisted = listing.as_ref().is_ok_and(|r| r.status == 404);
                let listing = catalog_listing(listing)?;
                let (category, store_state) =
                    classify_store(version, hash, listing.as_ref(), delisted);
                r.category = category.into();
                state = store_state;
                if category == "reacquire" {
                    let listing = listing.ok_or("CATALOG_UNAVAILABLE")?;
                    let bytes = if entry["profile"]["displayName"]
                        .as_str()
                        .is_none_or(|name| name.trim().is_empty())
                    {
                        source_package(api, source_id, Some(hash)).await.ok()
                    } else {
                        None
                    };
                    r.display_name = Some(store_display_name(
                        entry["profile"]["displayName"].as_str(),
                        bytes.as_deref(),
                        Some(&listing),
                    ));
                    let mut item = Item {
                        source_origin: m.source.origin.clone(),
                        source_user_id: m.source.user_id.clone(),
                        source_skill_id: source_id.into(),
                        content_hash: text(&entry["card"], "contentHash")?.into(),
                        kind: "store_copy".into(),
                        version: version.into(),
                        name: r.name.clone(),
                        profile: profile(&entry["profile"])?,
                        package_size: entry["card"]["size"].as_u64().unwrap_or(0) as usize,
                        package_sha256: hash.into(),
                        avatars: Vec::new(),
                        selected_avatar_id: None,
                        store_copy: None,
                        target_name: None,
                        map_to_skill_id: None,
                    };
                    item.store_copy = Some(StoreCopy {
                        listing_id: text(&listing, "id")?.into(),
                        version: version.into(),
                        state: "current".into(),
                    });
                    return Ok(item);
                }
                store_listing = listing;
            } else {
                r.category = "own_skill".into();
            }
            let bytes = source_package(api, source_id, Some(hash)).await?;
            let mut item = make_item(&m.source, &r, version, profile(&entry["profile"])?, &bytes)?;
            if r.category == "store_copy" {
                r.display_name = Some(store_display_name(
                    entry["profile"]["displayName"].as_str(),
                    Some(&bytes),
                    store_listing.as_ref(),
                ));
                item.store_copy = Some(StoreCopy {
                    listing_id: source_id.into(),
                    version: version.into(),
                    state: state.into(),
                });
            }
            store.stage("pkg", &bytes)?;
            // Bound library avatars use entry IDs; device identities are legacy aliases.
            let original = item.source_skill_id.clone();
            item.source_skill_id = entry_id.into();
            let displayed = ctx.displayed_avatar(entry_id, local);
            export_avatars(
                api,
                store,
                &mut item,
                &mut r.warnings,
                displayed.as_deref().map(|url| (url, false)),
                true,
            )
            .await?;
            if item.avatars.is_empty() {
                if let Some(id) = local.and_then(|l| l.sidecar.avatar_local_id.as_ref()) {
                    item.source_skill_id = id.clone();
                    export_avatars(api, store, &mut item, &mut r.warnings, None, true).await?;
                }
            }
            item.source_skill_id = original;
            Ok::<_, String>(item)
        }
        .await;
        complete_record(ctx, &mut r, outcome)?;
        records.push(r);
    }
    // Unsynced folders still belong to the explicit source scope.
    for local in &ctx.locals {
        if records.iter().any(|r| {
            r.source_local_id.as_deref() == Some(&local.skill_id)
                || r.source_local_aliases.contains(&local.skill_id)
        }) {
            continue;
        }
        let p = &local.sidecar;
        if p.library_account_id
            .as_deref()
            .is_some_and(|u| u != ctx.session.user_id())
        {
            continue;
        }
        records.push(local_snapshot(api, store, ctx, &m.source, local).await?);
    }
    Ok(records)
}

fn skip(record: &mut Record, reason: &str) {
    record.choice = Choice::Skip;
    record.state = "skipped".into();
    record.reason = reason.into();
}

// Used only inside an item boundary; inventory, target and persistence errors propagate.
fn item_level(reason: &str) -> bool {
    reason.strip_prefix("HTTP_").is_some_and(|status| {
        status
            .parse::<u16>()
            .is_ok_and(|status| (100..600).contains(&status))
    }) || matches!(
        reason,
        "SOURCE_PACKAGE_UNAVAILABLE"
            | "SOURCE_VERSION_UNAVAILABLE"
            | "CATALOG_UNAVAILABLE"
            | "CATALOG_PACKAGE_UNAVAILABLE"
            | "MIGRATION_NETWORK"
            | "MIGRATION_HASH_MISMATCH"
            | "MIGRATION_INVALID_RESPONSE"
            | "MIGRATION_INVALID_PROFILE"
            | "MIGRATION_INVALID_PACKAGE"
            | "MIGRATION_PACKAGE_TOO_LARGE"
            | "MIGRATION_RESPONSE_TOO_LARGE"
            | "MIGRATION_SOURCE_ID_INVALID"
            | "MIGRATION_SOURCE_CHANGED"
            | "MIGRATION_LOCAL_PACKAGE_FAILED"
    )
}

fn catalog_listing(reply: Result<transport::Reply, String>) -> Result<Option<Value>, String> {
    match reply {
        Ok(reply) => Ok(reply.json().ok()),
        Err(reason) if item_level(&reason) => Ok(None),
        Err(reason) => Err(reason),
    }
}
fn complete_record(
    ctx: &SourceContext<'_>,
    r: &mut Record,
    outcome: Result<Item, String>,
) -> Result<(), String> {
    if let Some(local) = ctx.local_for(&r.source_skill_id, r.source_entry_id.as_deref()) {
        r.source_local_id = Some(local.skill_id.clone());
        if let Ok(item) = &outcome {
            r.pending_delta = content::local_identity(&ctx.managed.join(&local.skill_id), None)
                .map(|(identity, _)| identity.content_hash != item.content_hash)
                .unwrap_or(true);
        }
    }
    match outcome {
        Ok(item) => r.item = Some(item),
        Err(reason) if item_level(&reason) => skip(r, &reason),
        Err(reason) => return Err(reason),
    }
    Ok(())
}
fn local_record(
    store: &Store,
    ctx: &SourceContext<'_>,
    source: &Identity,
    local: &LocalSkill,
) -> Result<Record, String> {
    let p = &local.sidecar;
    let id = p.id.as_deref().unwrap_or(&local.skill_id);
    let mut r = new_record(
        id,
        p.name.as_deref().unwrap_or(&local.skill_id),
        "own_skill",
    );
    r.source_local_id = Some(local.skill_id.clone());
    if crate::commands::library_acquisition_source(p) == crate::AcquisitionSource::Team {
        skip(&mut r, "TEAM_SHARED_NOT_COPYABLE");
        return Ok(r);
    }
    // A remote-backed folder must never export uncommitted local edits.
    if ctx.session.deployment() != &Deployment::Local
        && (p.server_id.is_some() || p.library_entry_id.is_some())
    {
        skip(&mut r, "SOURCE_COMMITTED_PACKAGE_UNAVAILABLE");
        r.pending_delta = true;
        return Ok(r);
    }
    let path = ctx.managed.join(&local.skill_id);
    let _lock = crate::skill_lock::lock_skill_dir_at(
        ctx.managed.parent().ok_or("MIGRATION_SOURCE_ROOT")?,
        &local.skill_id,
    )?;
    let (before, files) =
        content::local_identity(&path, None).map_err(|_| "MIGRATION_LOCAL_PACKAGE_FAILED")?;
    let bytes = crate::commands::library_package_bytes(
        &path,
        content::package_executables(&files, &before).as_ref(),
    )
    .map_err(|_| "MIGRATION_LOCAL_PACKAGE_FAILED")?;
    if before.content_hash != package_identity(&bytes)?
        || content::local_identity(&path, None)
            .map_err(|_| "MIGRATION_LOCAL_PACKAGE_FAILED")?
            .0
            != before
    {
        return Err("MIGRATION_SOURCE_CHANGED".into());
    }
    store.stage("pkg", &bytes)?;
    r.item = Some(make_item(
        source,
        &r,
        &p.version,
        SyncProfile::from_sidecar(p, &r.name),
        &bytes,
    )?);
    Ok(r)
}

async fn local_snapshot<T: Transport>(
    api: &T,
    store: &Store,
    ctx: &SourceContext<'_>,
    source: &Identity,
    local: &LocalSkill,
) -> Result<Record, String> {
    api.check()?;
    match local_snapshot_inner(api, store, ctx, source, local).await {
        Ok(record) => Ok(record),
        Err(reason) if item_level(&reason) => {
            let p = &local.sidecar;
            let mut record = new_record(
                p.server_id
                    .as_deref()
                    .or(p.id.as_deref())
                    .unwrap_or(&local.skill_id),
                p.name.as_deref().unwrap_or(&local.skill_id),
                if crate::commands::library_acquisition_source(p)
                    == crate::AcquisitionSource::Marketplace
                {
                    "store_copy"
                } else {
                    "own_skill"
                },
            );
            record.source_local_id = Some(local.skill_id.clone());
            if record.category == "store_copy" {
                record.display_name =
                    Some(store_display_name(p.display_name.as_deref(), None, None));
            }
            skip(&mut record, &reason);
            Ok(record)
        }
        Err(reason) => Err(reason),
    }
}

async fn local_snapshot_inner<T: Transport>(
    api: &T,
    store: &Store,
    ctx: &SourceContext<'_>,
    source: &Identity,
    local: &LocalSkill,
) -> Result<Record, String> {
    let p = &local.sidecar;
    if crate::commands::library_acquisition_source(p) != crate::AcquisitionSource::Marketplace {
        return local_record(store, ctx, source, local);
    }
    let mut r = new_record(
        p.server_id.as_deref().unwrap_or(&local.skill_id),
        p.name.as_deref().unwrap_or(&local.skill_id),
        "store_copy",
    );
    r.source_local_id = Some(local.skill_id.clone());
    r.display_name = Some(store_display_name(p.display_name.as_deref(), None, None));
    let Some(id) = p.server_id.as_deref() else {
        skip(&mut r, "SOURCE_STORE_ID_MISSING");
        return Ok(r);
    };
    let Some(version) = p
        .acquisition_version
        .as_deref()
        .or_else(|| p.upstream.as_ref().map(|u| u.version.as_str()))
    else {
        skip(&mut r, "SOURCE_VERSION_UNAVAILABLE");
        return Ok(r);
    };
    let Some(hash) = p.acquisition_package_sha256.as_deref().or_else(|| {
        p.upstream
            .as_ref()
            .and_then(|u| u.package_sha256.as_deref())
    }) else {
        skip(&mut r, "SOURCE_PACKAGE_UNAVAILABLE");
        return Ok(r);
    };
    let listing = api
        .request(
            Side::Catalog,
            Method::GET,
            &format!("api/marketplace/{id}"),
            None,
        )
        .await;
    let delisted = listing.as_ref().is_ok_and(|r| r.status == 404);
    let listing = catalog_listing(listing)?;
    let (category, state) = classify_store(version, hash, listing.as_ref(), delisted);
    r.category = category.into();
    let bytes = if ctx.session.deployment() == &Deployment::Local {
        api.catalog_package(id, hash).await
    } else {
        source_package(api, id, Some(hash)).await
    };
    let bytes = bytes?;
    r.display_name = Some(store_display_name(
        p.display_name.as_deref(),
        Some(&bytes),
        listing.as_ref(),
    ));
    let mut item = make_item(
        source,
        &r,
        version,
        SyncProfile::from_sidecar(p, &r.name),
        &bytes,
    )?;
    item.store_copy = Some(StoreCopy {
        listing_id: id.into(),
        version: version.into(),
        state: state.into(),
    });
    if category == "store_copy" {
        store.stage("pkg", &bytes)?;
    }
    r.pending_delta = content::local_identity(&ctx.managed.join(&local.skill_id), None)
        .map_err(|_| "MIGRATION_LOCAL_PACKAGE_FAILED")?
        .0
        .content_hash
        != item.content_hash;
    r.item = Some(item);
    Ok(r)
}

pub(super) fn store_name(bytes: Option<&[u8]>, listing: Option<&Value>) -> String {
    bytes
        .and_then(content::package_skill_name)
        .or_else(|| {
            listing
                .and_then(|v| v["name"].as_str())
                .filter(|name| !name.trim().is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "商店 Skill".into())
}

pub(super) fn store_display_name(
    profile: Option<&str>,
    bytes: Option<&[u8]>,
    listing: Option<&Value>,
) -> String {
    profile
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| store_name(bytes, listing))
}

async fn export_avatars<T: Transport>(
    api: &T,
    store: &Store,
    item: &mut Item,
    warnings: &mut Vec<String>,
    fallback: Option<(&str, bool)>,
    local: bool,
) -> Result<(), String> {
    let key = if local { "localSkillIds" } else { "skillIds" };
    let data = async {
        let reply = get(
            api,
            Side::Source,
            &format!("api/skill-avatars/export?{key}={}", item.source_skill_id),
        )
        .await?;
        let data: Value = if matches!(reply.status, 404 | 405) {
            match fallback {
                Some((url, true)) => json!({"items":[{"variants":[{"variantId":"legacy-current",
                "styleId":"classic","styleVersion":1,"url":url}],
                "selected":{"kind":"generated","variantId":"legacy-current"}}]}),
                Some((url, false)) => {
                    json!({"items":[{"custom":{"url":url},"selected":{"kind":"custom"}}]})
                }
                None => json!({"items":[]}),
            }
        } else {
            reply.json()?
        };
        Ok::<_, String>(data)
    }
    .await;
    let data = match data {
        Ok(data) => data,
        Err(reason) if item_level(&reason) => {
            warnings.push("AVATAR_SKIPPED".into());
            return Ok(());
        }
        Err(reason) => return Err(reason),
    };
    let Some(exports) = data["items"].as_array() else {
        warnings.push("AVATAR_SKIPPED".into());
        return Ok(());
    };
    let Some(export) = exports.first() else {
        return Ok(());
    };
    if let Some(variants) = export["variants"].as_array() {
        for variant in variants {
            let avatar = async {
                let id = text(variant, "variantId")?;
                download_avatar(
                    api,
                    store,
                    item,
                    variant,
                    id,
                    Some((
                        text(variant, "styleId")?,
                        variant["styleVersion"]
                            .as_u64()
                            .ok_or("MIGRATION_AVATAR_INVALID")?,
                    )),
                )
                .await
            }
            .await;
            collect_avatar(item, warnings, avatar)?;
        }
    }
    if export["custom"].is_object() {
        let avatar = download_avatar(api, store, item, &export["custom"], "custom", None).await;
        collect_avatar(item, warnings, avatar)?;
    }
    let selected = &export["selected"];
    item.selected_avatar_id = match selected["kind"].as_str() {
        Some("generated") => selected["variantId"]
            .as_str()
            .filter(|id| item.avatars.iter().any(|a| a.id == *id))
            .map(str::to_owned),
        Some("custom") if item.avatars.iter().any(|a| a.id == "custom") => Some("custom".into()),
        _ => None,
    };
    Ok(())
}

fn collect_avatar(
    item: &mut Item,
    warnings: &mut Vec<String>,
    avatar: Result<Avatar, String>,
) -> Result<(), String> {
    match avatar {
        Ok(avatar) => item.avatars.push(avatar),
        Err(reason)
            if item_level(&reason)
                || matches!(
                    reason.as_str(),
                    "MIGRATION_MEDIA_URL"
                        | "MIGRATION_AVATAR_INVALID"
                        | "MIGRATION_AVATAR_UNAVAILABLE"
                        | "MIGRATION_AVATAR_TOO_LARGE"
                ) =>
        {
            warnings.push("AVATAR_SKIPPED".into());
        }
        Err(reason) => return Err(reason),
    }
    Ok(())
}
async fn download_avatar<T: Transport>(
    api: &T,
    store: &Store,
    item: &Item,
    data: &Value,
    id: &str,
    style: Option<(&str, u64)>,
) -> Result<Avatar, String> {
    if !resource(id) {
        return Err("MIGRATION_AVATAR_INVALID".into());
    }
    let raw = text(data, "url")?;
    let url = if raw.starts_with('/') {
        format!("{}{}", item.source_origin.trim_end_matches('/'), raw)
    } else {
        raw.into()
    };
    let reply = get(api, Side::Media, &url).await?;
    if reply.status != 200 {
        return Err("MIGRATION_AVATAR_UNAVAILABLE".into());
    }
    let bytes = reply.bytes;
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err("MIGRATION_AVATAR_INVALID".into());
    };
    if bytes.len()
        > if style.is_some() {
            5 * 1024 * 1024
        } else {
            2 * 1024 * 1024
        }
    {
        return Err("MIGRATION_AVATAR_TOO_LARGE".into());
    }
    let hash = sha(&bytes);
    if data["sha256"].as_str().is_some_and(|s| s != hash) {
        return Err("MIGRATION_HASH_MISMATCH".into());
    }
    store.stage("avatar", &bytes)?;
    Ok(Avatar {
        id: id.into(),
        kind: if style.is_some() {
            "generated"
        } else {
            "custom"
        }
        .into(),
        style_id: style.map(|s| s.0.into()),
        style_version: style.map(|s| s.1),
        mime_type: mime.into(),
        size: bytes.len(),
        sha256: hash,
    })
}

pub(super) async fn snapshot<T: Transport>(
    api: &T,
    store: &Store,
    home: &Path,
    source: &RuntimeSession,
    target: &RuntimeSession,
    id: String,
    keys: Vec<crate::key_vault::MigrationKeyChoice>,
) -> Result<(), String> {
    api.check()?;
    crate::key_vault::validate_migration_choices(&keys)?;
    let managed = home.join("skills");
    let locals = crate::library_sync::engine::scan_managed(
        &managed,
        crate::commands::library_read_profile_readonly,
    )?
    .into_iter()
    .filter(|l| crate::spaces::profile_matches(&l.sidecar, source))
    .collect();
    let ctx = SourceContext {
        session: source,
        managed,
        locals,
    };
    let organizer_key = if source.auth_token().is_some() {
        source.user_id()
    } else {
        "guest"
    };
    let organizer_path = source.storage_root(home).join("organizer").join(format!(
        "{}.json",
        crate::library_organizer::normalize_account_key(organizer_key)?
    ));
    let organizer: crate::library_organizer::OrganizerState =
        if organizer_path.try_exists().map_err(|e| e.to_string())? {
            crate::runtime_env::read_private_json(&organizer_path)?
        } else {
            Default::default()
        };
    crate::library_organizer::validate_state(&organizer)?;
    let mut m = Manifest {
        version: 1,
        local_migration_id: id,
        source: Identity::from_session(source)?,
        target: Identity::from_session(target)?,
        source_deployment: source.deployment().clone(),
        target_deployment: target.deployment().clone(),
        migration_id: None,
        records: Vec::new(),
        snapshot_at: crate::key_vault::now_ms(),
        state: "snapshotting".into(),
        last_error: None,
        limits: Limits::default(),
        organizer,
        keys,
        keys_done: false,
        key_results: Vec::new(),
    };
    store.save(&m)?;
    let records = if source.deployment() == &Deployment::Local {
        let mut records = Vec::new();
        for local in &ctx.locals {
            api.check()?;
            records.push(local_snapshot(api, store, &ctx, &m.source, local).await?);
        }
        records
    } else {
        remote_records(api, store, &ctx, &mut m).await?
    };
    api.check()?;
    for r in records {
        m.records.push(r.id.clone());
        store.put(&r)?;
    }
    if source.deployment() != &Deployment::Local {
        let tags = json_request(api, Side::Source, Method::GET, "api/library/tags", None).await?;
        for tag in tags["tags"].as_array().ok_or("MIGRATION_INVALID_TAGS")? {
            let key = format!("entry:{}", text(tag, "entryId")?);
            let names: Vec<String> = serde_json::from_value(tag["names"].clone())
                .map_err(|_| "MIGRATION_INVALID_TAGS")?;
            m.organizer.tags.entry(key).or_insert(names);
        }
        let quick = json_request(
            api,
            Side::Source,
            Method::GET,
            "api/library/quick-access",
            None,
        )
        .await?;
        if !quick["revision"].is_u64() || !quick["items"].is_array() {
            return Err("MIGRATION_INVALID_QUICK_ACCESS".into());
        }
        let quick: crate::library_organizer::QuickAccessState =
            serde_json::from_value(quick).map_err(|_| "MIGRATION_INVALID_QUICK_ACCESS")?;
        for mut item in quick.items {
            if item.kind == crate::library_organizer::QuickAccessKind::Skill {
                item.reference = format!("entry:{}", item.reference);
            }
            if !m.organizer.quick_access.items.contains(&item) {
                m.organizer.quick_access.items.push(item);
            }
        }
    }
    store.save(&m)?;
    // Creating the target session is not idempotent. Never blindly retry a lost create response.
    let created = json_request(
        api,
        Side::Target,
        Method::POST,
        "api/migrations",
        Some(json!({"protocolVersion":1,"source":m.source})),
    )
    .await?;
    let migration_id = text(&created, "id")?.to_string();
    uuid::Uuid::parse_str(&migration_id).map_err(|_| "MIGRATION_INVALID_RESPONSE")?;
    if created["targetUserId"] != target.user_id() {
        return Err("MIGRATION_TARGET_CHANGED".into());
    }
    m.migration_id = Some(migration_id);
    m.limits = serde_json::from_value(created["limits"].clone())
        .map_err(|_| "MIGRATION_INVALID_LIMITS")?;
    store.save(&m)?;
    super::engine::precheck(api, store, &m).await?;
    m.state = "ready".into();
    store.save(&m)
}
