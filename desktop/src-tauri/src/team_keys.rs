//! Team key vault (#254): one value per `(team, KEY)` on the Server.
//!
//! The WebView manages team keys only through these commands. Listings,
//! usage and write receipts are deserialized into fixed structs, so a field
//! the Server might add (never a value) cannot reach React. Putting a key
//! reads the value natively from the account vault (or, for a Skill, its
//! override → vault) and sends it straight to the Server; it is never
//! returned to the WebView.

use crate::runtime_env::{
    authorized_runtime_session, parse_response, valid_env_key, validate_user_id,
    AuthorizedRuntimeSession, RuntimeApi,
};
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use zeroize::Zeroize;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamKeyPerson {
    pub id: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamKeySkill {
    pub id: String,
    pub name: String,
    /// The name this Skill declares: the key itself or one of its aliases
    /// (#288). Absent in usage rows and from older Servers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamKeyExclusionEntry {
    pub skill_id: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamKey {
    pub key: String,
    /// Other variable names this team key answers to (#288).
    #[serde(default)]
    pub aliases: Vec<String>,
    pub holder: TeamKeyPerson,
    pub revision: u32,
    pub created_at: String,
    pub updated_at: String,
    pub can_manage: bool,
    pub in_scope_skills: Vec<TeamKeySkill>,
    pub exclusions: Vec<TeamKeyExclusionEntry>,
    pub last_used_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamKeyList {
    pub team_id: String,
    pub team_name: String,
    pub is_team_owner: bool,
    pub credentials: Vec<TeamKey>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamKeyWrite {
    pub key: String,
    pub team_id: String,
    pub revision: u32,
    pub holder_id: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamKeyExclusion {
    pub key: String,
    pub skill_id: String,
    pub excluded: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamKeyUsageRow {
    pub actor: Option<TeamKeyPerson>,
    pub skill: Option<TeamKeySkill>,
    pub count: u64,
    pub last_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamKeyUsage {
    pub key: String,
    pub team_id: String,
    pub days: u32,
    pub usage: Vec<TeamKeyUsageRow>,
}

#[derive(Serialize)]
struct TeamKeyValueBody<'a> {
    value: &'a str,
}

#[derive(Serialize)]
struct TeamKeyAliasesBody<'a> {
    aliases: &'a [String],
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamKeyAliases {
    pub key: String,
    #[serde(default)]
    pub aliases: Vec<String>,
}

/// Why setting a team key's aliases failed: `Conflict` is the Server's 409
/// (a name already belongs to another key of the team).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TeamAliasError {
    Conflict(String),
    Other(String),
}

impl TeamAliasError {
    fn message(self) -> String {
        match self {
            Self::Conflict(message) | Self::Other(message) => message,
        }
    }
}

/// `/api/teams/<team>/credentials[/<KEY>[/<suffix>…]]`; ids are UUIDs and
/// keys match the env-key grammar, so no segment needs escaping.
pub(crate) fn team_key_path(
    team_id: &str,
    key: Option<&str>,
    suffix: &[&str],
) -> Result<String, String> {
    validate_user_id(team_id).map_err(|_| "团队编号无效".to_string())?;
    let mut path = format!("/api/teams/{team_id}/credentials");
    if let Some(key) = key {
        if !valid_env_key(key) {
            return Err("钥匙名无效".into());
        }
        path.push('/');
        path.push_str(key);
    }
    for segment in suffix {
        if segment.is_empty()
            || !segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("团队钥匙请求路径无效".into());
        }
        path.push('/');
        path.push_str(segment);
    }
    Ok(path)
}

/// Shown when the Server answers a team-key route with its generic 404: the
/// Server predates team keys (v0.30), so the route does not exist yet.
pub(crate) const TEAM_KEYS_UNAVAILABLE: &str =
    "当前 SkillHub 服务器还没有团队钥匙功能，请等服务器更新后再试";

/// A 404 body from a credentials route. The route's own 404s carry a specific
/// `error` (「Team key not found」, 「Skill not found」) and pass through; the
/// framework's route-miss (`{"error":"Not Found","message":"Route … not found"}`)
/// or a non-JSON proxy page means the Server has no team keys yet.
fn team_key_not_found_message(body: &[u8]) -> String {
    let payload = serde_json::from_slice::<serde_json::Value>(body).ok();
    let field = |name: &str| {
        payload
            .as_ref()
            .and_then(|value| value.get(name))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    field("error")
        .filter(|error| error != "Not Found")
        .or_else(|| field("message").filter(|message| !message.starts_with("Route ")))
        .unwrap_or_else(|| TEAM_KEYS_UNAVAILABLE.to_string())
}

/// `parse_response`, except a 404 maps through `team_key_not_found_message`.
async fn parse_team_response<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, String> {
    if response.status() == StatusCode::NOT_FOUND {
        let body = response.bytes().await.unwrap_or_default();
        return Err(team_key_not_found_message(&body));
    }
    parse_response(response).await
}

async fn send<T: serde::de::DeserializeOwned>(
    api: &RuntimeApi,
    method: Method,
    url: Url,
    token: &str,
    body: Option<&TeamKeyValueBody<'_>>,
) -> Result<T, String> {
    let mut request = api
        .client
        .request(method, url)
        .bearer_auth(token)
        .header(reqwest::header::CACHE_CONTROL, "no-store");
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "无法连接 SkillHub 团队钥匙服务，请检查网络后重试".to_string())?;
    parse_team_response(response).await
}

async fn send_no_content(
    api: &RuntimeApi,
    method: Method,
    url: Url,
    token: &str,
) -> Result<(), String> {
    let response = api
        .client
        .request(method, url)
        .bearer_auth(token)
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .send()
        .await
        .map_err(|_| "无法连接 SkillHub 团队钥匙服务，请检查网络后重试".to_string())?;
    if response.status() == StatusCode::NO_CONTENT {
        return Ok(());
    }
    let _: serde_json::Value = parse_team_response(response).await?;
    Ok(())
}

/// Sends one value to `(team, KEY)`. The caller zeroizes `value`.
pub(crate) async fn put_team_key_value(
    session: &AuthorizedRuntimeSession,
    team_id: &str,
    key: &str,
    value: &str,
) -> Result<TeamKeyWrite, String> {
    let api = RuntimeApi::for_session(&session.session).await?;
    let url = api.url(&team_key_path(team_id, Some(key), &[])?)?;
    send(
        &api,
        Method::PUT,
        url,
        &session.token,
        Some(&TeamKeyValueBody { value }),
    )
    .await
}

/// `PUT /api/teams/<team>/credentials/<KEY>/aliases` with `{"aliases": [...]}`.
pub(crate) async fn put_team_key_aliases(
    session: &AuthorizedRuntimeSession,
    team_id: &str,
    key: &str,
    aliases: &[String],
) -> Result<TeamKeyAliases, TeamAliasError> {
    if aliases.iter().any(|alias| !valid_env_key(alias)) {
        return Err(TeamAliasError::Other(
            "变量名必须为大写字母、数字和下划线".into(),
        ));
    }
    let api = RuntimeApi::for_session(&session.session)
        .await
        .map_err(TeamAliasError::Other)?;
    let url = api
        .url(&team_key_path(team_id, Some(key), &["aliases"]).map_err(TeamAliasError::Other)?)
        .map_err(TeamAliasError::Other)?;
    let response = api
        .client
        .request(Method::PUT, url)
        .bearer_auth(&session.token)
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .json(&TeamKeyAliasesBody { aliases })
        .send()
        .await
        .map_err(|_| {
            TeamAliasError::Other("无法连接 SkillHub 团队钥匙服务，请检查网络后重试".into())
        })?;
    let conflict = response.status() == StatusCode::CONFLICT;
    parse_team_response(response).await.map_err(|message| {
        if conflict {
            TeamAliasError::Conflict(message)
        } else {
            TeamAliasError::Other(message)
        }
    })
}

/// The aliases the account vault lists for `key` (empty when none).
fn account_vault_aliases_at(root: &std::path::Path, user_id: &str, key: &str) -> Vec<String> {
    crate::key_vault::read_meta_at(root, user_id)
        .ok()
        .and_then(|mut meta| meta.keys.remove(key))
        .map(|entry| entry.aliases)
        .unwrap_or_default()
}

/// The account vault value for `key`, or an error naming the next step.
/// Team keys stay one per name (#306): `variant` picks which labelled value
/// to share, `None` the name's default value.
pub(crate) fn account_vault_value_at(
    root: &std::path::Path,
    user_id: &str,
    key: &str,
    variant: Option<&str>,
) -> Result<String, String> {
    if !valid_env_key(key) || crate::key_vault::is_reserved_variant_name(key) {
        return Err("钥匙名无效".into());
    }
    let entries = crate::key_vault::vault_entry_names_at(root, user_id)?;
    let meta = crate::key_vault::read_meta_at(root, user_id)?;
    let identity = match variant {
        Some(variant) => {
            crate::key_vault::validate_variant_id(variant)?;
            let identity = crate::key_vault::variant_entry_name(key, variant);
            if meta.identity_variant(&identity).is_none() || !entries.contains(&identity) {
                return Err(format!("{key} 没有这把带标签的钥匙"));
            }
            identity
        }
        None => meta
            .choose_identity(key, None, |identity| entries.contains(identity))
            .unwrap_or_else(|| key.to_string()),
    };
    let allowed = BTreeSet::from([identity.clone()]);
    let mut values = crate::key_vault::read_vault_values_at(root, user_id, Some(&allowed))?;
    let value = values.remove(&identity);
    crate::key_vault::zeroize_map(&mut values);
    let mut value =
        value.ok_or_else(|| format!("你的钥匙库里还没有 {key}，请先在「我的钥匙」填写"))?;
    if !crate::runtime_env::valid_personal_value(&value) {
        value.zeroize();
        return Err("你的钥匙不可用，请重新填写".into());
    }
    Ok(value)
}

#[tauri::command]
pub async fn list_team_keys(
    space: crate::server_request::SpaceHandle,
    team_id: String,
    account_user_id: String,
) -> Result<TeamKeyList, String> {
    let session = authorized_runtime_session(&account_user_id)?;
    crate::spaces::require_handle(&session.session, &space)?;
    let api = RuntimeApi::for_session(&session.session).await?;
    let url = api.url(&team_key_path(&team_id, None, &[])?)?;
    send(&api, Method::GET, url, &session.token, None).await
}

/// Puts the account vault's `key` into the team (create or rotate): its
/// default value, or with `variant` that labelled value (#306).
#[tauri::command]
pub async fn put_team_key(
    space: crate::server_request::SpaceHandle,
    team_id: String,
    key: String,
    variant: Option<String>,
    account_user_id: String,
) -> Result<TeamKeyWrite, String> {
    let session = authorized_runtime_session(&account_user_id)?;
    crate::spaces::require_handle(&session.session, &space)?;
    validate_user_id(&team_id).map_err(|_| "团队编号无效".to_string())?;
    let mut value = account_vault_value_at(
        &session.data_root,
        &session.user_id,
        &key,
        variant.as_deref(),
    )?;
    let result = put_team_key_value(&session, &team_id, &key, &value).await;
    value.zeroize();
    let written = result?;
    // The key's other names come along (#288); the value is already stored.
    let aliases = account_vault_aliases_at(&session.data_root, &session.user_id, &key);
    if !aliases.is_empty() {
        match put_team_key_aliases(&session, &team_id, &key, &aliases).await {
            Ok(_) => {}
            Err(TeamAliasError::Conflict(_)) => {
                return Err(alias_conflict_after_put(&aliases));
            }
            Err(TeamAliasError::Other(message)) => {
                return Err(format!("钥匙已放入团队，但变量名未关联：{message}"));
            }
        }
    }
    Ok(written)
}

fn alias_conflict_after_put(aliases: &[String]) -> String {
    format!(
        "钥匙已放入团队，但变量名 {} 与团队里另一把钥匙冲突，未关联",
        aliases.join("、")
    )
}

/// Replaces the other variable names of a team key; a 409 (the name already
/// belongs to another team key) returns the Server's message.
#[tauri::command]
pub async fn set_team_key_aliases(
    space: crate::server_request::SpaceHandle,
    team_id: String,
    key: String,
    aliases: Vec<String>,
    account_user_id: String,
) -> Result<TeamKeyAliases, String> {
    let session = authorized_runtime_session(&account_user_id)?;
    crate::spaces::require_handle(&session.session, &space)?;
    put_team_key_aliases(&session, &team_id, &key, &aliases)
        .await
        .map_err(TeamAliasError::message)
}

#[tauri::command]
pub async fn delete_team_key(
    space: crate::server_request::SpaceHandle,
    team_id: String,
    key: String,
    account_user_id: String,
) -> Result<(), String> {
    let session = authorized_runtime_session(&account_user_id)?;
    crate::spaces::require_handle(&session.session, &space)?;
    let api = RuntimeApi::for_session(&session.session).await?;
    let url = api.url(&team_key_path(&team_id, Some(&key), &[])?)?;
    send_no_content(&api, Method::DELETE, url, &session.token).await
}

#[tauri::command]
pub async fn set_team_key_exclusion(
    space: crate::server_request::SpaceHandle,
    team_id: String,
    key: String,
    skill_id: String,
    excluded: bool,
    account_user_id: String,
) -> Result<TeamKeyExclusion, String> {
    validate_user_id(&skill_id).map_err(|_| "Skill 编号无效".to_string())?;
    let session = authorized_runtime_session(&account_user_id)?;
    crate::spaces::require_handle(&session.session, &space)?;
    let api = RuntimeApi::for_session(&session.session).await?;
    let url = api.url(&team_key_path(
        &team_id,
        Some(&key),
        &["exclusions", &skill_id],
    )?)?;
    let method = if excluded {
        Method::PUT
    } else {
        Method::DELETE
    };
    send(&api, method, url, &session.token, None).await
}

#[tauri::command]
pub async fn team_key_usage(
    space: crate::server_request::SpaceHandle,
    team_id: String,
    key: String,
    account_user_id: String,
) -> Result<TeamKeyUsage, String> {
    let session = authorized_runtime_session(&account_user_id)?;
    crate::spaces::require_handle(&session.session, &space)?;
    let api = RuntimeApi::for_session(&session.session).await?;
    let mut url = api.url(&team_key_path(&team_id, Some(&key), &["usage"])?)?;
    url.query_pairs_mut().append_pair("days", "30");
    send(&api, Method::GET, url, &session.token, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEAM: &str = "22222222-2222-4222-8222-222222222222";
    const SKILL: &str = "11111111-1111-4111-8111-111111111111";
    const USER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    #[test]
    fn builds_only_well_formed_team_key_paths() {
        assert_eq!(
            team_key_path(TEAM, None, &[]).expect("list path"),
            format!("/api/teams/{TEAM}/credentials")
        );
        assert_eq!(
            team_key_path(TEAM, Some("FAL_KEY"), &["exclusions", SKILL]).expect("exclusion path"),
            format!("/api/teams/{TEAM}/credentials/FAL_KEY/exclusions/{SKILL}")
        );
        assert!(team_key_path("not-a-team", Some("FAL_KEY"), &[]).is_err());
        assert!(team_key_path(TEAM, Some("fal_key"), &[]).is_err());
        assert!(team_key_path(TEAM, Some("FAL_KEY/../x"), &[]).is_err());
        assert!(team_key_path(TEAM, Some("FAL_KEY"), &["../usage"]).is_err());
    }

    #[test]
    fn listings_never_carry_a_value_into_the_webview() {
        let body = serde_json::json!({
            "teamId": TEAM,
            "teamName": "产品组",
            "isTeamOwner": false,
            "credentials": [{
                "key": "FAL_KEY",
                "holder": { "id": USER, "displayName": "A" },
                "revision": 2,
                "createdAt": "2026-10-01T00:00:00.000Z",
                "updatedAt": "2026-10-02T00:00:00.000Z",
                "canManage": true,
                "inScopeSkills": [{ "id": SKILL, "name": "生图" }],
                "exclusions": [],
                "lastUsedAt": null,
                "value": "must-not-pass-through",
                "ciphertext": "must-not-pass-through"
            }]
        });
        let parsed: TeamKeyList = serde_json::from_value(body).expect("parse listing");
        let forwarded = serde_json::to_string(&parsed).expect("serialize for WebView");
        assert!(!forwarded.contains("must-not-pass-through"));
        assert!(!forwarded.contains("\"value\""));
        assert!(forwarded.contains("\"inScopeSkills\""));
        assert_eq!(parsed.credentials[0].in_scope_skills[0].name, "生图");
    }

    #[test]
    fn a_route_miss_404_means_the_server_has_no_team_keys_yet() {
        let route_miss = br#"{"message":"Route PUT:/api/teams/x/credentials/FAL_KEY not found","error":"Not Found","statusCode":404}"#;
        assert_eq!(
            team_key_not_found_message(route_miss),
            TEAM_KEYS_UNAVAILABLE
        );
        assert_eq!(
            team_key_not_found_message(br#"{"error":"Not Found"}"#),
            TEAM_KEYS_UNAVAILABLE
        );
        assert_eq!(
            team_key_not_found_message(b"<html>404 Not Found</html>"),
            TEAM_KEYS_UNAVAILABLE
        );
        assert_eq!(team_key_not_found_message(b""), TEAM_KEYS_UNAVAILABLE);
        // The routes' own 404s keep their meaning.
        assert_eq!(
            team_key_not_found_message(br#"{"error":"Team key not found"}"#),
            "Team key not found"
        );
        assert_eq!(
            team_key_not_found_message(br#"{"error":"Skill not found"}"#),
            "Skill not found"
        );
    }

    #[test]
    fn write_receipts_and_usage_drop_unknown_fields() {
        let write: TeamKeyWrite = serde_json::from_value(serde_json::json!({
            "key": "FAL_KEY", "teamId": TEAM, "revision": 1, "holderId": USER,
            "updatedAt": "2026-10-02T00:00:00.000Z", "value": "must-not-pass-through"
        }))
        .expect("parse write receipt");
        assert!(!serde_json::to_string(&write)
            .expect("serialize")
            .contains("must-not-pass-through"));
        let usage: TeamKeyUsage = serde_json::from_value(serde_json::json!({
            "key": "FAL_KEY", "teamId": TEAM, "days": 30,
            "usage": [{ "actor": null, "skill": { "id": SKILL, "name": "生图" }, "count": 3, "lastAt": "2026-10-05T00:00:00.000Z" }]
        }))
        .expect("parse usage");
        assert_eq!(usage.usage[0].count, 3);
        assert!(usage.usage[0].actor.is_none());
    }

    #[test]
    fn team_key_aliases_parse_and_default_to_empty() {
        let body = serde_json::json!({
            "teamId": TEAM,
            "teamName": "产品组",
            "isTeamOwner": true,
            "credentials": [{
                "key": "FAL_KEY",
                "aliases": ["FAL_API_KEY"],
                "holder": { "id": USER, "displayName": "A" },
                "revision": 1,
                "createdAt": "2026-10-01T00:00:00.000Z",
                "updatedAt": "2026-10-02T00:00:00.000Z",
                "canManage": true,
                "inScopeSkills": [{ "id": SKILL, "name": "生图", "declaredKey": "FAL_API_KEY" }],
                "exclusions": [],
                "lastUsedAt": null
            }, {
                "key": "OPENAI_API_KEY",
                "holder": { "id": USER, "displayName": "A" },
                "revision": 1,
                "createdAt": "2026-10-01T00:00:00.000Z",
                "updatedAt": "2026-10-02T00:00:00.000Z",
                "canManage": true,
                "inScopeSkills": [{ "id": SKILL, "name": "写作" }],
                "exclusions": [],
                "lastUsedAt": null
            }]
        });
        let parsed: TeamKeyList = serde_json::from_value(body).expect("parse listing");
        assert_eq!(parsed.credentials[0].aliases, vec!["FAL_API_KEY"]);
        assert_eq!(
            parsed.credentials[0].in_scope_skills[0]
                .declared_key
                .as_deref(),
            Some("FAL_API_KEY")
        );
        assert!(parsed.credentials[1].aliases.is_empty());
        assert!(parsed.credentials[1].in_scope_skills[0]
            .declared_key
            .is_none());
        let forwarded = serde_json::to_value(&parsed).expect("serialize");
        assert_eq!(forwarded["credentials"][0]["aliases"][0], "FAL_API_KEY");
        assert_eq!(
            forwarded["credentials"][0]["inScopeSkills"][0]["declaredKey"],
            "FAL_API_KEY"
        );
        assert_eq!(
            team_key_path(TEAM, Some("FAL_KEY"), &["aliases"]).expect("aliases path"),
            format!("/api/teams/{TEAM}/credentials/FAL_KEY/aliases")
        );
        assert_eq!(
            serde_json::to_value(TeamKeyAliasesBody {
                aliases: &["FAL_API_KEY".to_string()]
            })
            .expect("body"),
            serde_json::json!({ "aliases": ["FAL_API_KEY"] })
        );
        assert_eq!(
            alias_conflict_after_put(&["FAL_API_KEY".into(), "FAL_AI_KEY".into()]),
            "钥匙已放入团队，但变量名 FAL_API_KEY、FAL_AI_KEY 与团队里另一把钥匙冲突，未关联"
        );
    }

    #[test]
    fn team_put_carries_the_account_vault_aliases() {
        let root =
            std::env::temp_dir().join(format!("skillhub-team-aliases-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("fixture root");
        assert!(account_vault_aliases_at(&root, USER, "FAL_KEY").is_empty());
        crate::key_vault::set_vault_key_at(&root, USER, "FAL_KEY", "vault-test-value", None, 1)
            .expect("set vault key");
        crate::key_vault::set_vault_key_aliases_at(
            &root,
            USER,
            "FAL_KEY",
            vec!["FAL_API_KEY".into()],
            2,
        )
        .expect("aliases");
        assert_eq!(
            account_vault_aliases_at(&root, USER, "FAL_KEY"),
            vec!["FAL_API_KEY"]
        );
        std::fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn team_put_reads_only_the_account_vault_value() {
        let root =
            std::env::temp_dir().join(format!("skillhub-team-keys-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("fixture root");
        assert!(account_vault_value_at(&root, USER, "FAL_KEY", None)
            .expect_err("missing vault key")
            .contains("FAL_KEY"));
        crate::key_vault::set_vault_key_at(&root, USER, "FAL_KEY", "vault-test-value", None, 1)
            .expect("set vault key");
        assert_eq!(
            account_vault_value_at(&root, USER, "FAL_KEY", None).expect("vault value"),
            "vault-test-value"
        );
        assert!(account_vault_value_at(&root, USER, "bad key", None).is_err());
        // One team key per name (#306): the default value, or a chosen one.
        let work = crate::key_vault::create_vault_key_variant_at(
            &root,
            USER,
            "FAL_KEY",
            "公司",
            "vault-work-value",
            None,
            2,
        )
        .expect("variant");
        assert_eq!(
            account_vault_value_at(&root, USER, "FAL_KEY", Some(&work)).expect("variant value"),
            "vault-work-value"
        );
        assert!(account_vault_value_at(&root, USER, "FAL_KEY", Some("V9")).is_err());
        assert!(account_vault_value_at(&root, USER, "FAL_KEY__V1", None).is_err());
        crate::key_vault::set_vault_default_variant_at(&root, USER, "FAL_KEY", Some(&work))
            .expect("default");
        assert_eq!(
            account_vault_value_at(&root, USER, "FAL_KEY", None).expect("default value"),
            "vault-work-value"
        );
        std::fs::remove_dir_all(root).expect("remove fixture");
    }
}
