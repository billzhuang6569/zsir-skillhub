use crate::cli::{
    CliAccount, CliAccountState, CliCommandOutput, CliErrorCode, EXIT_AUTH, EXIT_INTERNAL,
    EXIT_NETWORK, EXIT_USAGE,
};
use crate::cli_auth::{
    account_verification_failure, auth_guard_failure, verify_account_with_server, CliAuthGuard,
};
fn catalog_origin() -> Result<Url, String> {
    crate::spaces::normalize_base(&crate::official_channel::COMPILED.catalog_origin)
}
use reqwest::{Client, Response, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::time::Duration;

pub(crate) const MARKETPLACE_USAGE: &str = "用法：\n  skillhub marketplace search [--query <text>] [--category <category>] [--label <label>] [--agent <agent>] [--sort latest|downloads] [--page <n>] [--page-size <n>] --json\n  skillhub marketplace show <skill-id> --json";
pub(crate) const TEAM_USAGE: &str = "用法：\n  skillhub team list --json\n  skillhub team skills <team-id> --json\n  skillhub team show <skill-id> --json";

const MARKETPLACE_SEARCH_COMMAND: &str = "marketplace search";
const MARKETPLACE_SHOW_COMMAND: &str = "marketplace show";
const TEAM_LIST_COMMAND: &str = "team list";
const TEAM_SKILLS_COMMAND: &str = "team skills";
const TEAM_SHOW_COMMAND: &str = "team show";
const TEAM_SHARE_COMMAND: &str = "team share";
const TEAM_COMMAND: &str = "team";
const MAX_CLOUD_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_MARKETPLACE_PAGE: u16 = 200;
const MARKETPLACE_AGENTS: &[&str] = &[
    "claude",
    "codex",
    "agent-skills",
    "workbuddy",
    "doubao",
    "opencode",
    "openclaw",
    "gemini",
    "trae",
];

#[derive(Debug, Default, PartialEq, Eq)]
struct MarketplaceSearchArgs {
    query: Option<String>,
    category: Option<String>,
    label: Option<String>,
    agent: Option<String>,
    sort: Option<String>,
    page: Option<u16>,
    page_size: Option<u8>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicUser {
    id: String,
    display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvDependency {
    key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    required: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketplaceVersion {
    id: String,
    version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    changelog: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    package_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    package_size: Option<u64>,
    created_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketplaceItem {
    id: String,
    name: String,
    display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    labels: Vec<String>,
    trigger_scenarios: Vec<String>,
    compatible_agents: Vec<String>,
    env_dependencies: Vec<EnvDependency>,
    current_version: String,
    author: PublicUser,
    version: MarketplaceVersion,
    download_count: u64,
    published_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    skill_md: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketplaceCatalog {
    items: Vec<MarketplaceItem>,
    total: u64,
    page: u16,
    page_size: u8,
    categories: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamSummary {
    id: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    avatar_url: Option<String>,
    role: String,
    member_count: u64,
    shared_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dissolved_at: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamShare {
    team_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillVersion {
    id: String,
    version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    changelog: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    git_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    package_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    package_size: Option<u64>,
    created_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamSkill {
    id: String,
    name: String,
    display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    labels: Vec<String>,
    trigger_scenarios: Vec<String>,
    compatible_agents: Vec<String>,
    env_dependencies: Vec<EnvDependency>,
    author_id: String,
    current_version: String,
    install_count: u64,
    visibility: String,
    marketplace_status: String,
    created_at: String,
    updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    author: Option<PublicUser>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    versions: Option<Vec<SkillVersion>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    team_shares: Option<Vec<TeamShare>>,
}

enum ResponseReadError {
    Offline,
    TooLarge,
}

fn cloud_client(origin: &Url) -> Result<Client, String> {
    crate::net::client_builder(origin)?
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(30))
        .user_agent(concat!(
            "Yitan-SkillHub/",
            env!("CARGO_PKG_VERSION"),
            " cli-cloud"
        ))
        .build()
        .map_err(|_| "无法初始化 SkillHub Server 连接".to_string())
}

fn api_url(path: &str) -> Result<Url, String> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains(['?', '#', '\\'])
        || path
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
        || path.chars().any(char::is_control)
    {
        return Err("SkillHub API 路径无效".into());
    }
    let mut url = catalog_origin()?;
    let base = url.path().trim_end_matches('/');
    url.set_path(&format!("{base}/api/{path}"));
    Ok(url)
}

fn public_account() -> CliAccount {
    match CliAuthGuard::capture() {
        Ok(guard) if guard.token_for_request().is_ok() => {
            CliAccount::local(CliAccountState::Unverified, guard.user_id())
        }
        Ok(_) => CliAccount::state(CliAccountState::Guest),
        Err(_) => CliAccount::state(CliAccountState::Unknown),
    }
}

fn usage_failure(command: &'static str, usage: &'static str) -> CliCommandOutput {
    CliCommandOutput::failure(
        command,
        public_account(),
        CliErrorCode::ValidationFailed,
        usage,
        EXIT_USAGE,
        Vec::new(),
    )
}

fn parse_bounded_text(value: &str, max_chars: usize) -> Result<String, ()> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > max_chars
        || trimmed.chars().any(char::is_control)
    {
        return Err(());
    }
    Ok(trimmed.to_string())
}

fn parse_positive<T>(value: &str, max: T) -> Result<T, ()>
where
    T: std::str::FromStr + Ord + Copy + From<u8>,
{
    let parsed = value.parse::<T>().map_err(|_| ())?;
    if parsed < T::from(1) || parsed > max {
        return Err(());
    }
    Ok(parsed)
}

fn parse_marketplace_search(args: &[String]) -> Result<MarketplaceSearchArgs, ()> {
    if args.first().map(String::as_str) != Some("marketplace")
        || args.get(1).map(String::as_str) != Some("search")
    {
        return Err(());
    }
    let mut parsed = MarketplaceSearchArgs::default();
    let mut seen = BTreeSet::<String>::new();
    let mut json_requested = false;
    let mut index = 2;
    while index < args.len() {
        let flag = args[index].as_str();
        if flag == "--json" {
            if json_requested {
                return Err(());
            }
            json_requested = true;
            index += 1;
            continue;
        }
        if !matches!(
            flag,
            "--query" | "--category" | "--label" | "--agent" | "--sort" | "--page" | "--page-size"
        ) || !seen.insert(flag.to_string())
        {
            return Err(());
        }
        let value = args.get(index + 1).ok_or(())?;
        match flag {
            "--query" => parsed.query = Some(parse_bounded_text(value, 120)?),
            "--category" => parsed.category = Some(parse_bounded_text(value, 80)?),
            "--label" => parsed.label = Some(parse_bounded_text(value, 80)?),
            "--agent" if MARKETPLACE_AGENTS.contains(&value.as_str()) => {
                parsed.agent = Some(value.clone())
            }
            "--agent" => return Err(()),
            "--sort" if matches!(value.as_str(), "latest" | "downloads") => {
                parsed.sort = Some(value.clone())
            }
            "--sort" => return Err(()),
            "--page" => parsed.page = Some(parse_positive(value, MAX_MARKETPLACE_PAGE)?),
            "--page-size" => parsed.page_size = Some(parse_positive(value, 50_u8)?),
            _ => return Err(()),
        }
        index += 2;
    }
    if !json_requested {
        return Err(());
    }
    Ok(parsed)
}

fn marketplace_search_url(parsed: &MarketplaceSearchArgs) -> Result<Url, String> {
    let mut url = api_url("marketplace")?;
    {
        let mut query = url.query_pairs_mut();
        if let Some(value) = parsed.query.as_deref() {
            query.append_pair("query", value);
        }
        if let Some(value) = parsed.category.as_deref() {
            query.append_pair("category", value);
        }
        if let Some(value) = parsed.label.as_deref() {
            query.append_pair("label", value);
        }
        if let Some(value) = parsed.agent.as_deref() {
            query.append_pair("agent", value);
        }
        if let Some(value) = parsed.sort.as_deref() {
            query.append_pair("sort", value);
        }
        if let Some(value) = parsed.page {
            query.append_pair("page", &value.to_string());
        }
        if let Some(value) = parsed.page_size {
            query.append_pair("pageSize", &value.to_string());
        }
    }
    Ok(url)
}

fn parse_uuid(value: &str) -> Result<String, ()> {
    uuid::Uuid::parse_str(value)
        .map(|parsed| parsed.to_string())
        .map_err(|_| ())
}

fn team_usage_command(args: &[String]) -> &'static str {
    match args.get(1).map(String::as_str) {
        Some("list") => TEAM_LIST_COMMAND,
        Some("skills") => TEAM_SKILLS_COMMAND,
        Some("show") => TEAM_SHOW_COMMAND,
        Some("share") => TEAM_SHARE_COMMAND,
        _ => TEAM_COMMAND,
    }
}

fn marketplace_usage_command(args: &[String]) -> &'static str {
    match args.get(1).map(String::as_str) {
        Some("show") => MARKETPLACE_SHOW_COMMAND,
        _ => MARKETPLACE_SEARCH_COMMAND,
    }
}

async fn read_response(mut response: Response) -> Result<(StatusCode, Vec<u8>), ResponseReadError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CLOUD_RESPONSE_BYTES as u64)
    {
        return Err(ResponseReadError::TooLarge);
    }
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ResponseReadError::Offline)?
    {
        if body.len().saturating_add(chunk.len()) > MAX_CLOUD_RESPONSE_BYTES {
            return Err(ResponseReadError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok((status, body))
}

fn valid_text(value: &str, max_chars: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.trim().is_empty())
        && value.chars().count() <= max_chars
        && !value.chars().any(char::is_control)
}

fn valid_multiline_text(value: &str, max_chars: usize) -> bool {
    value.chars().count() <= max_chars
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

fn valid_optional_text(value: Option<&str>, max_chars: usize) -> bool {
    value.is_none_or(|text| valid_multiline_text(text, max_chars))
}

fn valid_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

fn valid_sha256(value: Option<&str>) -> bool {
    value.is_none_or(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn valid_text_list(values: &[String], max_items: usize, max_chars: usize) -> bool {
    values.len() <= max_items
        && values
            .iter()
            .all(|value| valid_text(value, max_chars, false))
}

fn valid_public_user(user: &PublicUser) -> bool {
    valid_uuid(&user.id)
        && valid_text(&user.display_name, 256, false)
        && user
            .avatar_url
            .as_deref()
            .is_none_or(|url| valid_text(url, 2_048, false))
}

fn valid_env_dependencies(dependencies: &[EnvDependency]) -> bool {
    dependencies.len() <= 128
        && dependencies.iter().all(|dependency| {
            valid_text(&dependency.key, 256, false)
                && valid_optional_text(dependency.description.as_deref(), 2_000)
        })
}

fn valid_marketplace_version(version: &MarketplaceVersion) -> bool {
    valid_uuid(&version.id)
        && valid_text(&version.version, 80, false)
        && valid_optional_text(version.changelog.as_deref(), 20_000)
        && valid_sha256(version.package_sha256.as_deref())
        && valid_text(&version.created_at, 80, false)
}

fn valid_marketplace_item(item: &MarketplaceItem, source_required: bool) -> bool {
    valid_uuid(&item.id)
        && valid_text(&item.name, 128, false)
        && valid_text(&item.display_name, 256, false)
        && valid_optional_text(item.description.as_deref(), 20_000)
        && valid_optional_text(item.category.as_deref(), 256)
        && valid_text_list(&item.labels, 64, 256)
        && valid_text_list(&item.trigger_scenarios, 128, 2_000)
        && valid_text_list(&item.compatible_agents, 32, 128)
        && valid_env_dependencies(&item.env_dependencies)
        && valid_text(&item.current_version, 80, false)
        && item.current_version == item.version.version
        && valid_public_user(&item.author)
        && valid_marketplace_version(&item.version)
        && valid_text(&item.published_at, 80, false)
        && match item.skill_md.as_deref() {
            Some(source) => valid_multiline_text(source, MAX_CLOUD_RESPONSE_BYTES),
            None => !source_required,
        }
}

fn valid_team_summary(team: &TeamSummary) -> bool {
    valid_uuid(&team.id)
        && valid_text(&team.name, 256, false)
        && valid_optional_text(team.description.as_deref(), 20_000)
        && valid_text(&team.color, 32, false)
        && team
            .avatar_url
            .as_deref()
            .is_none_or(|url| valid_text(url, 2_048, false))
        && matches!(team.role.as_str(), "owner" | "member")
        && team.dissolved_at.is_none()
}

fn valid_skill_version(version: &SkillVersion) -> bool {
    valid_uuid(&version.id)
        && valid_text(&version.version, 80, false)
        && valid_optional_text(version.changelog.as_deref(), 20_000)
        && version
            .git_hash
            .as_deref()
            .is_none_or(|hash| valid_text(hash, 256, false))
        && valid_sha256(version.package_sha256.as_deref())
        && valid_text(&version.created_at, 80, false)
}

fn valid_team_skill(skill: &TeamSkill, detail_required: bool) -> bool {
    let versions = skill.versions.as_deref().unwrap_or_default();
    let team_shares = skill.team_shares.as_deref().unwrap_or_default();
    valid_uuid(&skill.id)
        && valid_text(&skill.name, 128, false)
        && valid_text(&skill.display_name, 256, false)
        && valid_optional_text(skill.description.as_deref(), 20_000)
        && valid_optional_text(skill.category.as_deref(), 256)
        && valid_text_list(&skill.labels, 64, 256)
        && valid_text_list(&skill.trigger_scenarios, 128, 2_000)
        && valid_text_list(&skill.compatible_agents, 32, 128)
        && valid_env_dependencies(&skill.env_dependencies)
        && valid_uuid(&skill.author_id)
        && valid_text(&skill.current_version, 80, false)
        && valid_text(&skill.visibility, 32, false)
        && valid_text(&skill.marketplace_status, 32, false)
        && valid_text(&skill.created_at, 80, false)
        && valid_text(&skill.updated_at, 80, false)
        && skill.author.as_ref().is_some_and(valid_public_user)
        && versions.len() <= 1_000
        && versions.iter().all(valid_skill_version)
        && team_shares.len() <= 1_000
        && team_shares.iter().all(|share| valid_uuid(&share.team_id))
        && (!detail_required || (skill.versions.is_some() && skill.team_shares.is_some()))
}

/// Parse the exact public CLI contract instead of returning the Server object
/// verbatim. Unknown fields are deliberately dropped, so future private Server
/// fields (including credentials or tokens) cannot silently enter CLI output.
fn parse_cloud_body(command: &'static str, body: &[u8]) -> Result<Value, ()> {
    let value = match command {
        MARKETPLACE_SEARCH_COMMAND => {
            let mut catalog = serde_json::from_slice::<MarketplaceCatalog>(body).map_err(|_| ())?;
            if catalog.items.len() > 50
                || catalog.page == 0
                || catalog.page > MAX_MARKETPLACE_PAGE
                || catalog.page_size == 0
                || catalog.page_size > 50
                || catalog.items.len() > usize::from(catalog.page_size)
                || catalog.categories.len() > 1_000
                || !valid_text_list(&catalog.categories, 1_000, 256)
                || !catalog
                    .items
                    .iter()
                    .all(|item| valid_marketplace_item(item, false))
            {
                return Err(());
            }
            for item in &mut catalog.items {
                item.skill_md = None;
            }
            serde_json::to_value(catalog).map_err(|_| ())?
        }
        MARKETPLACE_SHOW_COMMAND => {
            let item = serde_json::from_slice::<MarketplaceItem>(body).map_err(|_| ())?;
            if !valid_marketplace_item(&item, true) {
                return Err(());
            }
            serde_json::to_value(item).map_err(|_| ())?
        }
        TEAM_LIST_COMMAND => {
            let teams = serde_json::from_slice::<Vec<TeamSummary>>(body).map_err(|_| ())?;
            if teams.len() > 1_000 || !teams.iter().all(valid_team_summary) {
                return Err(());
            }
            serde_json::to_value(teams).map_err(|_| ())?
        }
        TEAM_SKILLS_COMMAND => {
            let mut skills = serde_json::from_slice::<Vec<TeamSkill>>(body).map_err(|_| ())?;
            if skills.len() > 5_000 || !skills.iter().all(|skill| valid_team_skill(skill, false)) {
                return Err(());
            }
            for skill in &mut skills {
                skill.versions = None;
                skill.team_shares = None;
            }
            serde_json::to_value(skills).map_err(|_| ())?
        }
        TEAM_SHOW_COMMAND => {
            let skill = serde_json::from_slice::<TeamSkill>(body).map_err(|_| ())?;
            if !valid_team_skill(&skill, true) {
                return Err(());
            }
            serde_json::to_value(skill).map_err(|_| ())?
        }
        _ => return Err(()),
    };
    Ok(value)
}

fn public_http_failure(command: &'static str, status: StatusCode) -> CliCommandOutput {
    let (code, message) = if status == StatusCode::NOT_FOUND {
        (CliErrorCode::NotFound, "没有找到对应的公开 Skill")
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        (
            CliErrorCode::Offline,
            "Marketplace 请求过于频繁，请稍后重试",
        )
    } else {
        (
            CliErrorCode::InternalError,
            "SkillHub Server 暂时无法完成 Marketplace 查询",
        )
    };
    CliCommandOutput::failure(
        command,
        public_account(),
        code,
        message,
        if status == StatusCode::TOO_MANY_REQUESTS {
            EXIT_NETWORK
        } else {
            EXIT_INTERNAL
        },
        vec!["请稍后重试".into()],
    )
}

async fn public_get(command: &'static str, url: Url) -> CliCommandOutput {
    let client = match catalog_origin().and_then(|origin| cloud_client(&origin)) {
        Ok(client) => client,
        Err(message) => {
            return CliCommandOutput::failure(
                command,
                public_account(),
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    let response = match client.get(url).send().await {
        Ok(response) => response,
        Err(_) => {
            return CliCommandOutput::failure(
                command,
                public_account(),
                CliErrorCode::Offline,
                "暂时无法连接 SkillHub Server",
                EXIT_NETWORK,
                vec!["请检查网络后重试".into()],
            )
        }
    };
    let (status, body) = match read_response(response).await {
        Ok(result) => result,
        Err(ResponseReadError::Offline) => {
            return CliCommandOutput::failure(
                command,
                public_account(),
                CliErrorCode::Offline,
                "读取 SkillHub Server 响应失败",
                EXIT_NETWORK,
                vec!["请检查网络后重试".into()],
            )
        }
        Err(ResponseReadError::TooLarge) => {
            return CliCommandOutput::failure(
                command,
                public_account(),
                CliErrorCode::InternalError,
                "SkillHub Server 返回的数据过大",
                EXIT_INTERNAL,
                Vec::new(),
            )
        }
    };
    if !status.is_success() {
        return public_http_failure(command, status);
    }
    match parse_cloud_body(command, &body) {
        Ok(data) => {
            CliCommandOutput::success(command, public_account(), data, Vec::new(), Vec::new())
        }
        Err(()) => CliCommandOutput::failure(
            command,
            public_account(),
            CliErrorCode::InternalError,
            "SkillHub Server 返回了无效的数据合同",
            EXIT_INTERNAL,
            Vec::new(),
        ),
    }
}

fn authenticated_http_failure(
    command: &'static str,
    guard: &CliAuthGuard,
    account: CliAccount,
    status: StatusCode,
) -> CliCommandOutput {
    if status == StatusCode::UNAUTHORIZED {
        return auth_guard_failure(command, guard.invalidate_unauthorized());
    }
    if let Err(error) = guard.verify_current() {
        return auth_guard_failure(command, error);
    }
    let (code, message, exit_code, next_actions) = if status == StatusCode::FORBIDDEN {
        (
            CliErrorCode::PermissionDenied,
            "当前账号没有访问该团队资源的权限",
            EXIT_AUTH,
            Vec::new(),
        )
    } else if matches!(status, StatusCode::NOT_FOUND | StatusCode::GONE) {
        (
            CliErrorCode::NotFound,
            "没有找到对应的团队资源",
            EXIT_INTERNAL,
            Vec::new(),
        )
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        (
            CliErrorCode::Offline,
            "团队查询请求过于频繁，请稍后重试",
            EXIT_NETWORK,
            vec!["请稍后重试".into()],
        )
    } else {
        (
            CliErrorCode::InternalError,
            "SkillHub Server 暂时无法完成团队查询",
            EXIT_INTERNAL,
            Vec::new(),
        )
    };
    CliCommandOutput::failure(command, account, code, message, exit_code, next_actions)
}

async fn authenticated_get(command: &'static str, url: Url) -> CliCommandOutput {
    let guard = match CliAuthGuard::capture() {
        Ok(guard) => guard,
        Err(error) => return auth_guard_failure(command, error),
    };
    let account = match verify_account_with_server(&guard).await {
        Ok(account) => account,
        Err(error) => return account_verification_failure(command, &guard, error),
    };
    let url = match guard.bind_catalog_template(&url) {
        Ok(url) => url,
        Err(_) => {
            return auth_guard_failure(command, crate::cli_auth::CliAuthGuardError::SessionUnsafe)
        }
    };
    let client = match guard.origin().and_then(|origin| cloud_client(&origin)) {
        Ok(client) => client,
        Err(message) => {
            if let Err(error) = guard.verify_current() {
                return auth_guard_failure(command, error);
            }
            return CliCommandOutput::failure(
                command,
                account,
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            );
        }
    };
    let token = match guard.token_for_request() {
        Ok(token) => token,
        Err(error) => return auth_guard_failure(command, error),
    };
    let response = match client.get(url).bearer_auth(token).send().await {
        Ok(response) => response,
        Err(_) => {
            if let Err(error) = guard.verify_current() {
                return auth_guard_failure(command, error);
            }
            return CliCommandOutput::failure(
                command,
                account,
                CliErrorCode::Offline,
                "暂时无法连接 SkillHub Server；本机会话已保留",
                EXIT_NETWORK,
                vec!["请检查网络后重试".into()],
            );
        }
    };
    let (status, body) = match read_response(response).await {
        Ok(result) => result,
        Err(ResponseReadError::Offline) => {
            if let Err(error) = guard.verify_current() {
                return auth_guard_failure(command, error);
            }
            return CliCommandOutput::failure(
                command,
                account,
                CliErrorCode::Offline,
                "读取 SkillHub Server 响应失败；本机会话已保留",
                EXIT_NETWORK,
                vec!["请检查网络后重试".into()],
            );
        }
        Err(ResponseReadError::TooLarge) => {
            if let Err(error) = guard.verify_current() {
                return auth_guard_failure(command, error);
            }
            return CliCommandOutput::failure(
                command,
                account,
                CliErrorCode::InternalError,
                "SkillHub Server 返回的数据过大",
                EXIT_INTERNAL,
                Vec::new(),
            );
        }
    };
    if !status.is_success() {
        return authenticated_http_failure(command, &guard, account, status);
    }
    let data = match parse_cloud_body(command, &body) {
        Ok(data) => data,
        Err(()) => {
            if let Err(error) = guard.verify_current() {
                return auth_guard_failure(command, error);
            }
            return CliCommandOutput::failure(
                command,
                account,
                CliErrorCode::InternalError,
                "SkillHub Server 返回了无效的数据合同",
                EXIT_INTERNAL,
                Vec::new(),
            );
        }
    };
    if let Err(error) = guard.verify_current() {
        return auth_guard_failure(command, error);
    }
    CliCommandOutput::success(command, account, data, Vec::new(), Vec::new())
}

pub(crate) async fn execute_cloud_cli(args: &[String]) -> Option<CliCommandOutput> {
    match args.first().map(String::as_str) {
        Some("marketplace") => {
            if args.get(1).map(String::as_str) == Some("search") {
                let parsed = match parse_marketplace_search(args) {
                    Ok(parsed) => parsed,
                    Err(()) => {
                        return Some(usage_failure(MARKETPLACE_SEARCH_COMMAND, MARKETPLACE_USAGE))
                    }
                };
                let url = match marketplace_search_url(&parsed) {
                    Ok(url) => url,
                    Err(message) => {
                        return Some(CliCommandOutput::failure(
                            MARKETPLACE_SEARCH_COMMAND,
                            public_account(),
                            CliErrorCode::InternalError,
                            message,
                            EXIT_INTERNAL,
                            Vec::new(),
                        ))
                    }
                };
                return Some(public_get(MARKETPLACE_SEARCH_COMMAND, url).await);
            }
            if args.get(1).map(String::as_str) == Some("show")
                && args.len() == 4
                && args[3] == "--json"
            {
                let skill_id = match parse_uuid(&args[2]) {
                    Ok(skill_id) => skill_id,
                    Err(()) => {
                        return Some(usage_failure(MARKETPLACE_SHOW_COMMAND, MARKETPLACE_USAGE))
                    }
                };
                let url = match api_url(&format!("marketplace/{skill_id}")) {
                    Ok(url) => url,
                    Err(message) => {
                        return Some(CliCommandOutput::failure(
                            MARKETPLACE_SHOW_COMMAND,
                            public_account(),
                            CliErrorCode::InternalError,
                            message,
                            EXIT_INTERNAL,
                            Vec::new(),
                        ))
                    }
                };
                return Some(public_get(MARKETPLACE_SHOW_COMMAND, url).await);
            }
            Some(usage_failure(
                marketplace_usage_command(args),
                MARKETPLACE_USAGE,
            ))
        }
        Some("team") => {
            if args == ["team", "list", "--json"] {
                let url = match api_url("teams") {
                    Ok(url) => url,
                    Err(message) => {
                        return Some(CliCommandOutput::failure(
                            TEAM_LIST_COMMAND,
                            public_account(),
                            CliErrorCode::InternalError,
                            message,
                            EXIT_INTERNAL,
                            Vec::new(),
                        ))
                    }
                };
                return Some(authenticated_get(TEAM_LIST_COMMAND, url).await);
            }
            if args.len() == 4 && args[1] == "skills" && args[3] == "--json" {
                let team_id = match parse_uuid(&args[2]) {
                    Ok(team_id) => team_id,
                    Err(()) => return Some(usage_failure(TEAM_SKILLS_COMMAND, TEAM_USAGE)),
                };
                let mut url = match api_url("skills") {
                    Ok(url) => url,
                    Err(message) => {
                        return Some(CliCommandOutput::failure(
                            TEAM_SKILLS_COMMAND,
                            public_account(),
                            CliErrorCode::InternalError,
                            message,
                            EXIT_INTERNAL,
                            Vec::new(),
                        ))
                    }
                };
                url.query_pairs_mut()
                    .append_pair("scope", "team")
                    .append_pair("teamId", &team_id);
                return Some(authenticated_get(TEAM_SKILLS_COMMAND, url).await);
            }
            if args.len() == 4 && args[1] == "show" && args[3] == "--json" {
                let skill_id = match parse_uuid(&args[2]) {
                    Ok(skill_id) => skill_id,
                    Err(()) => return Some(usage_failure(TEAM_SHOW_COMMAND, TEAM_USAGE)),
                };
                let url = match api_url(&format!("skills/{skill_id}")) {
                    Ok(url) => url,
                    Err(message) => {
                        return Some(CliCommandOutput::failure(
                            TEAM_SHOW_COMMAND,
                            public_account(),
                            CliErrorCode::InternalError,
                            message,
                            EXIT_INTERNAL,
                            Vec::new(),
                        ))
                    }
                };
                return Some(authenticated_get(TEAM_SHOW_COMMAND, url).await);
            }
            Some(usage_failure(team_usage_command(args), TEAM_USAGE))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        api_url, execute_cloud_cli, marketplace_search_url, parse_cloud_body,
        parse_marketplace_search, MarketplaceSearchArgs, MARKETPLACE_SEARCH_COMMAND,
        MARKETPLACE_SHOW_COMMAND, TEAM_LIST_COMMAND, TEAM_SHARE_COMMAND, TEAM_SHOW_COMMAND,
        TEAM_SKILLS_COMMAND,
    };
    use crate::cli::EXIT_USAGE;
    use serde_json::{json, Value};

    const SKILL_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const VERSION_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const USER_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const TEAM_ID: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[tokio::test]
    async fn malformed_marketplace_show_keeps_the_show_command_identity() {
        let output = execute_cloud_cli(&strings(&["marketplace", "show", "--help"]))
            .await
            .expect("recognized Marketplace command");
        let value: Value = serde_json::from_str(output.json()).expect("valid CLI envelope");
        assert_eq!(output.exit_code(), EXIT_USAGE);
        assert_eq!(value["command"], MARKETPLACE_SHOW_COMMAND);
        assert_eq!(value["error"]["code"], "VALIDATION_FAILED");
    }

    fn marketplace_item() -> Value {
        json!({
            "id": SKILL_ID,
            "name": "writer",
            "displayName": "Writer",
            "description": "description",
            "category": "writing",
            "labels": ["writing"],
            "triggerScenarios": ["draft a script"],
            "compatibleAgents": ["codex"],
            "envDependencies": [{"key": "EXAMPLE_API_KEY", "required": true}],
            "currentVersion": "v1.2.0",
            "author": {"id": USER_ID, "displayName": "Author", "authToken": "never-output"},
            "version": {
                "id": VERSION_ID,
                "version": "v1.2.0",
                "changelog": null,
                "packageSha256": null,
                "packageSize": 10,
                "createdAt": "2026-09-09T00:00:00Z",
                "packageData": "never-output"
            },
            "downloadCount": 3,
            "publishedAt": "2026-09-09T00:00:00Z",
            "skillMd": "# Writer\n",
            "signature": "never-output"
        })
    }

    fn team_skill(detail: bool) -> Value {
        let mut skill = json!({
            "id": SKILL_ID,
            "name": "writer",
            "displayName": "Writer",
            "description": null,
            "category": null,
            "labels": [],
            "triggerScenarios": [],
            "compatibleAgents": ["codex"],
            "envDependencies": [],
            "authorId": USER_ID,
            "currentVersion": "v1.2.0",
            "installCount": 3,
            "visibility": "team",
            "marketplaceStatus": "none",
            "createdAt": "2026-09-09T00:00:00Z",
            "updatedAt": "2026-09-09T00:00:00Z",
            "author": {"id": USER_ID, "displayName": "Author", "email": "private@example.com"},
            "sourceContent": "never-output",
            "ossPackageKey": "never-output"
        });
        if detail {
            skill["versions"] = json!([{
                "id": VERSION_ID,
                "version": "v1.2.0",
                "changelog": null,
                "gitHash": null,
                "packageSha256": null,
                "packageSize": null,
                "createdAt": "2026-09-09T00:00:00Z",
                "ossPackageKey": "never-output"
            }]);
            skill["teamShares"] = json!([{
                "teamId": TEAM_ID,
                "credential": "never-output"
            }]);
        }
        skill
    }

    #[test]
    fn marketplace_search_parser_is_bounded_and_requires_json() {
        assert_eq!(
            parse_marketplace_search(&strings(&[
                "marketplace",
                "search",
                "--query",
                "writer",
                "--sort",
                "downloads",
                "--page-size",
                "20",
                "--json",
            ])),
            Ok(MarketplaceSearchArgs {
                query: Some("writer".into()),
                sort: Some("downloads".into()),
                page_size: Some(20),
                ..MarketplaceSearchArgs::default()
            })
        );
        assert!(parse_marketplace_search(&strings(&[
            "marketplace",
            "search",
            "--query",
            "writer"
        ]))
        .is_err());
        assert!(parse_marketplace_search(&strings(&[
            "marketplace",
            "search",
            "--agent",
            "unknown",
            "--json"
        ]))
        .is_err());
        assert!(parse_marketplace_search(&strings(&[
            "marketplace",
            "search",
            "--page",
            "201",
            "--json"
        ]))
        .is_err());
        assert!(parse_marketplace_search(&strings(&[
            "marketplace",
            "search",
            "--agent",
            "workbuddy",
            "--page",
            "200",
            "--json"
        ]))
        .is_ok());
        assert!(parse_marketplace_search(&strings(&[
            "marketplace",
            "search",
            "--sort",
            "random",
            "--json"
        ]))
        .is_err());
    }

    #[tokio::test]
    async fn unsupported_team_share_keeps_its_request_family_in_the_envelope() {
        let output = execute_cloud_cli(&strings(&["team", "share", "--json"]))
            .await
            .expect("team command is claimed");
        assert_eq!(output.exit_code(), EXIT_USAGE);
        let envelope: Value = serde_json::from_str(output.json()).expect("parse usage envelope");
        assert_eq!(envelope["command"], TEAM_SHARE_COMMAND);
        assert_eq!(envelope["error"]["code"], "VALIDATION_FAILED");
    }

    #[test]
    fn marketplace_query_is_url_encoded() {
        let url = marketplace_search_url(&MarketplaceSearchArgs {
            query: Some("a & b".into()),
            page: Some(2),
            ..MarketplaceSearchArgs::default()
        })
        .expect("marketplace URL");
        assert_eq!(url.query(), Some("query=a+%26+b&page=2"));
    }

    #[test]
    fn api_paths_cannot_override_the_trusted_origin() {
        for invalid in [
            "/skills",
            "../skills",
            "skills/../teams",
            "skills//id",
            "skills?scope=team",
            "skills#fragment",
            "skills\\id",
            "https://attacker.invalid/path",
        ] {
            assert!(api_url(invalid).is_err(), "accepted unsafe path: {invalid}");
        }
        let url = api_url("marketplace").expect("trusted marketplace URL");
        assert_eq!(url.scheme(), "https");
        assert!(url.path().ends_with("/api/marketplace"));
    }

    #[test]
    fn marketplace_contract_is_typed_and_drops_unknown_private_fields() {
        let item = marketplace_item();
        let catalog = json!({
            "items": [item.clone()],
            "total": 1,
            "page": 1,
            "pageSize": 24,
            "categories": ["writing"],
            "token": "never-output"
        });
        let catalog_output = parse_cloud_body(
            MARKETPLACE_SEARCH_COMMAND,
            &serde_json::to_vec(&catalog).expect("catalog JSON"),
        )
        .expect("valid catalog");
        let encoded = serde_json::to_string(&catalog_output).expect("catalog output");
        assert!(!encoded.contains("never-output"));
        assert!(catalog_output["items"][0].get("skillMd").is_none());

        let detail_output = parse_cloud_body(
            MARKETPLACE_SHOW_COMMAND,
            &serde_json::to_vec(&item).expect("detail JSON"),
        )
        .expect("valid detail");
        assert_eq!(detail_output["skillMd"], "# Writer\n");
        assert!(detail_output.get("signature").is_none());
    }

    #[test]
    fn marketplace_contract_rejects_identity_and_pagination_mismatches() {
        let mut item = marketplace_item();
        item["author"]["id"] = json!("not-a-uuid");
        assert!(parse_cloud_body(
            MARKETPLACE_SHOW_COMMAND,
            &serde_json::to_vec(&item).expect("detail JSON")
        )
        .is_err());

        let catalog = json!({
            "items": [marketplace_item()],
            "total": 1,
            "page": 1,
            "pageSize": 0,
            "categories": []
        });
        assert!(parse_cloud_body(
            MARKETPLACE_SEARCH_COMMAND,
            &serde_json::to_vec(&catalog).expect("catalog JSON")
        )
        .is_err());
    }

    #[test]
    fn team_contract_whitelists_only_public_query_fields() {
        let teams = json!([{
            "id": TEAM_ID,
            "name": "Team",
            "description": null,
            "color": "#334455",
            "avatarUrl": null,
            "role": "member",
            "memberCount": 2,
            "sharedCount": 1,
            "dissolvedAt": null,
            "token": "never-output"
        }]);
        let teams_output = parse_cloud_body(
            TEAM_LIST_COMMAND,
            &serde_json::to_vec(&teams).expect("teams JSON"),
        )
        .expect("valid teams");
        assert!(!serde_json::to_string(&teams_output)
            .expect("teams output")
            .contains("never-output"));

        let list_output = parse_cloud_body(
            TEAM_SKILLS_COMMAND,
            &serde_json::to_vec(&json!([team_skill(false)])).expect("skills JSON"),
        )
        .expect("valid team skills");
        let list_encoded = serde_json::to_string(&list_output).expect("skills output");
        assert!(!list_encoded.contains("private@example.com"));
        assert!(!list_encoded.contains("never-output"));

        let detail_output = parse_cloud_body(
            TEAM_SHOW_COMMAND,
            &serde_json::to_vec(&team_skill(true)).expect("skill JSON"),
        )
        .expect("valid team skill");
        let detail_encoded = serde_json::to_string(&detail_output).expect("skill output");
        assert!(!detail_encoded.contains("never-output"));
        assert_eq!(detail_output["teamShares"][0]["teamId"], TEAM_ID);
    }
}
