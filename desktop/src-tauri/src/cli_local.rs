use crate::cli::{
    CliAccount, CliAccountState, CliCommandOutput, CliErrorCode, CLI_PROTOCOL_VERSION,
    EXIT_INTERNAL, EXIT_USAGE,
};
use crate::{AcquisitionSource, AgentInfo, AgentSkillsStatus, SkillHubJson, SkillHubProfile};
use git2::{DiffFormat, DiffOptions, Oid, Repository};
use serde::Serialize;
use serde_json::json;
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Read as _;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use crate::platform_fs::OpenOptionsExt as _;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

const STATUS_COMMAND: &str = "status";
const DOCTOR_COMMAND: &str = "doctor";
const AGENT_LIST_COMMAND: &str = "agent list";
const SKILL_LIST_COMMAND: &str = "skill list";
const SKILL_SHOW_COMMAND: &str = "skill show";
const SKILL_DISCOVER_COMMAND: &str = "skill discover";
/// Same bound as the GUI scan for entries read inside one grouping folder.
const MAX_GROUPED_SKILLS_PER_FOLDER: usize = 200;
const SKILL_HISTORY_COMMAND: &str = "skill history";
const SKILL_DIFF_COMMAND: &str = "skill diff";

pub(crate) const SKILL_USAGE: &str = concat!(
    "用法：\n",
    "  skillhub skill list [--query <text>] --json\n",
    "  skillhub skill show --skill-id <id> --json\n",
    "  skillhub skill discover [--agent <key>] --json\n",
    "  skillhub skill import preflight --path <path> [--skill-id <id>] --json\n",
    "  skillhub skill import apply --path <path> [--skill-id <id>] --plan-digest <digest> [--replace-conflicts] --json\n",
    "  skillhub skill install preflight --skill-id <id> --agent <key> [--agent <key> ...] --json\n",
    "  skillhub skill install apply --skill-id <id> --agent <key> [--agent <key> ...] --plan-digest <digest> [--replace-conflicts] --json\n",
    "  skillhub skill enable preflight --skill-id <id> --agent <key> --json\n",
    "  skillhub skill enable apply --skill-id <id> --agent <key> --plan-digest <digest> [--replace-conflicts] --json\n",
    "  skillhub skill disable preflight --skill-id <id> --agent <key> --json\n",
    "  skillhub skill disable apply --skill-id <id> --agent <key> --plan-digest <digest> --json\n",
    "  skillhub skill uninstall preflight --skill-id <id> --json\n",
    "  skillhub skill uninstall apply --skill-id <id> --plan-digest <digest> --json\n",
    "  skillhub skill history --skill-id <id> --json\n",
    "  skillhub skill diff --skill-id <id> --working --json\n",
    "  skillhub skill diff --skill-id <id> --from <hash> --to <hash> --json\n",
    "  skillhub skill snapshot --skill-id <id> --message <text> [--version <0.1.1>] --json\n",
    "  skillhub skill restore-version preflight --skill-id <id> --hash <40hex> [--receipt-id <uuid>] --json\n",
    "  skillhub skill restore-version apply --skill-id <id> --hash <40hex> [--receipt-id <uuid>] --plan-digest <digest> --json\n",
    "  skillhub skill delete preflight --skill-id <id> --json\n",
    "  skillhub skill delete apply --skill-id <id> --plan-digest <digest> --json\n",
    "  skillhub skill trash list --json\n",
    "  skillhub skill trash restore preflight --trash-id <id> --json\n",
    "  skillhub skill trash restore apply --trash-id <id> --plan-digest <digest> --json\n",
    "  skillhub skill prepare-edit (--skill-id <id> | --skill-path <SKILL.md>) --json\n",
    "  skillhub skill finish-edit <session-id> --json"
);

const MAX_PROFILE_BYTES: u64 = 1024 * 1024;
const MAX_SKILL_MD_BYTES: u64 = 1024 * 1024;
const MAX_TREE_ENTRIES: usize = 2_000;
const MAX_TREE_DEPTH: usize = 10;
const MAX_DIFF_LINES: usize = 5_000;
const MAX_DIFF_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug)]
struct AgentRoot {
    key: String,
    name: String,
    relative: PathBuf,
}

struct LocalContext {
    home: PathBuf,
    agents: Vec<AgentInfo>,
    agent_roots: Vec<AgentRoot>,
}

#[derive(Debug, PartialEq, Eq)]
enum ParsedCommand {
    Status,
    Doctor,
    AgentList,
    SkillList { query: Option<String> },
    SkillShow { skill_id: String },
    SkillDiscover { agent: Option<String> },
    SkillHistory { skill_id: String },
    SkillDiff { skill_id: String, mode: DiffMode },
}

#[derive(Debug, PartialEq, Eq)]
enum DiffMode {
    Working,
    Commits { from: String, to: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadOnlyEnvDependency {
    key: String,
    description: Option<String>,
    required: bool,
    share_policy: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ReadOnlyAgentProjectionState {
    Installed,
    NotInstalled,
    Conflict,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadOnlySkill {
    version_status: String,
    version_problem: Option<String>,
    has_working_copy: bool,
    version_receipt_id: Option<String>,
    formal_version_id: Option<String>,
    formal_label: Option<String>,
    version_high_water: i32,
    next_version: Option<String>,
    id: String,
    name: String,
    display_name: String,
    description: Option<String>,
    category: Option<String>,
    labels: Vec<String>,
    version: String,
    is_system: bool,
    system_version: Option<String>,
    acquisition_source: AcquisitionSource,
    server_id: Option<String>,
    server_owner_id: Option<String>,
    team_shared_from: Option<String>,
    compatible_agents: Vec<String>,
    installed_agents: Vec<String>,
    agent_states: BTreeMap<String, ReadOnlyAgentProjectionState>,
    env_dependencies: Vec<ReadOnlyEnvDependency>,
    local_path: String,
    profile_status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillTreeEntry {
    path: String,
    name: String,
    kind: String,
    depth: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveredSource {
    agent_key: String,
    agent_name: String,
    entry_name: String,
    /// Grouping folder for `<agent skills>/<group>/<entry_name>/SKILL.md`.
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveredSkill {
    id: String,
    display_name: String,
    description: Option<String>,
    version: String,
    sources: Vec<DiscoveredSource>,
    local_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEntry {
    label: Option<String>,
    original_label: Option<String>,
    receipt_id: Option<String>,
    formal_version_id: Option<String>,
    formal_label: Option<String>,
    version_status: String,
    hash: String,
    summary: String,
    message: String,
    committed_at_unix: i64,
    is_current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadOnlyDiffLine {
    path: Option<String>,
    kind: String,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagerIntegrity {
    installed: bool,
    valid: bool,
    expected_version: &'static str,
    installed_version: Option<String>,
    problems: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorCheck {
    id: &'static str,
    ok: bool,
    message: String,
}

fn unknown_account() -> CliAccount {
    CliAccount::state(CliAccountState::Unknown)
}

fn local_context() -> Result<LocalContext, String> {
    let home = crate::user_home_dir().ok_or_else(|| "无法确定当前用户目录".to_string())?;
    let agent_roots = crate::known_agents()
        .into_iter()
        .map(|(key, name, relative)| AgentRoot {
            key: key.to_string(),
            name: name.to_string(),
            relative: PathBuf::from(relative),
        })
        .collect();
    Ok(LocalContext {
        home,
        agents: crate::detect_agents(),
        agent_roots,
    })
}

fn is_local_command(args: &[String]) -> bool {
    match args.first().map(String::as_str) {
        Some("status" | "doctor" | "agent") => true,
        Some("skill") => !matches!(
            args.get(1).map(String::as_str),
            Some("prepare-edit" | "finish-edit")
        ),
        _ => false,
    }
}

pub(crate) fn execute_local_cli(args: &[String]) -> Option<CliCommandOutput> {
    if !is_local_command(args) {
        return None;
    }
    let context = match local_context() {
        Ok(context) => context,
        Err(message) => {
            return Some(CliCommandOutput::failure(
                command_hint(args),
                unknown_account(),
                CliErrorCode::InternalError,
                message,
                EXIT_INTERNAL,
                Vec::new(),
            ));
        }
    };
    execute_local_cli_at(args, &context)
}

fn execute_local_cli_at(args: &[String], context: &LocalContext) -> Option<CliCommandOutput> {
    if !is_local_command(args) {
        return None;
    }
    let parsed = match parse_command(args, context) {
        Ok(parsed) => parsed,
        Err((command, usage)) => {
            return Some(CliCommandOutput::failure(
                command,
                unknown_account(),
                CliErrorCode::ValidationFailed,
                usage,
                EXIT_USAGE,
                Vec::new(),
            ));
        }
    };
    Some(match parsed {
        ParsedCommand::Status => status(context),
        ParsedCommand::Doctor => doctor(context),
        ParsedCommand::AgentList => agent_list(context),
        ParsedCommand::SkillList { query } => skill_list(context, query.as_deref()),
        ParsedCommand::SkillShow { skill_id } => skill_show(context, &skill_id),
        ParsedCommand::SkillDiscover { agent } => skill_discover(context, agent.as_deref()),
        ParsedCommand::SkillHistory { skill_id } => skill_history(context, &skill_id),
        ParsedCommand::SkillDiff { skill_id, mode } => skill_diff(context, &skill_id, mode),
    })
}

fn command_hint(args: &[String]) -> &'static str {
    match (
        args.first().map(String::as_str),
        args.get(1).map(String::as_str),
    ) {
        (Some("status"), _) => STATUS_COMMAND,
        (Some("doctor"), _) => DOCTOR_COMMAND,
        (Some("agent"), _) => AGENT_LIST_COMMAND,
        (Some("skill"), Some("show")) => SKILL_SHOW_COMMAND,
        (Some("skill"), Some("discover")) => SKILL_DISCOVER_COMMAND,
        (Some("skill"), Some("history")) => SKILL_HISTORY_COMMAND,
        (Some("skill"), Some("diff")) => SKILL_DIFF_COMMAND,
        (Some("skill"), _) => SKILL_LIST_COMMAND,
        _ => STATUS_COMMAND,
    }
}

fn parse_command(
    args: &[String],
    context: &LocalContext,
) -> Result<ParsedCommand, (&'static str, &'static str)> {
    match args.first().map(String::as_str) {
        Some("status") => {
            require_exact_json(args, STATUS_COMMAND, "用法：skillhub status --json")?;
            Ok(ParsedCommand::Status)
        }
        Some("doctor") => {
            require_exact_json(args, DOCTOR_COMMAND, "用法：skillhub doctor --json")?;
            Ok(ParsedCommand::Doctor)
        }
        Some("agent") => {
            if args.get(1).map(String::as_str) != Some("list") {
                return Err((AGENT_LIST_COMMAND, "用法：skillhub agent list --json"));
            }
            require_exact_json(args, AGENT_LIST_COMMAND, "用法：skillhub agent list --json")?;
            Ok(ParsedCommand::AgentList)
        }
        Some("skill") => parse_skill_command(args, context),
        _ => Err((STATUS_COMMAND, "用法：skillhub status --json")),
    }
}

fn require_exact_json(
    args: &[String],
    command: &'static str,
    usage: &'static str,
) -> Result<(), (&'static str, &'static str)> {
    let expected_len = if command == AGENT_LIST_COMMAND { 3 } else { 2 };
    if args.len() == expected_len && args.last().map(String::as_str) == Some("--json") {
        Ok(())
    } else {
        Err((command, usage))
    }
}

fn parse_skill_command(
    args: &[String],
    context: &LocalContext,
) -> Result<ParsedCommand, (&'static str, &'static str)> {
    match args.get(1).map(String::as_str) {
        Some("list") => parse_skill_list(args),
        Some("show") => parse_skill_id_only(
            args,
            SKILL_SHOW_COMMAND,
            "用法：skillhub skill show --skill-id <id> --json",
        )
        .map(|skill_id| ParsedCommand::SkillShow { skill_id }),
        Some("discover") => parse_skill_discover(args, context),
        Some("history") => parse_skill_id_only(
            args,
            SKILL_HISTORY_COMMAND,
            "用法：skillhub skill history --skill-id <id> --json",
        )
        .map(|skill_id| ParsedCommand::SkillHistory { skill_id }),
        Some("diff") => parse_skill_diff(args),
        _ => Err((
            SKILL_LIST_COMMAND,
            "用法：skillhub skill <list|show|discover|history|diff> ... --json",
        )),
    }
}

fn parse_skill_list(args: &[String]) -> Result<ParsedCommand, (&'static str, &'static str)> {
    const USAGE: &str = "用法：skillhub skill list [--query <text>] --json";
    let mut query = None;
    let mut json_seen = false;
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--json" if !json_seen => {
                json_seen = true;
                index += 1;
            }
            "--query" if query.is_none() => {
                let Some(value) = args.get(index + 1) else {
                    return Err((SKILL_LIST_COMMAND, USAGE));
                };
                let value = value.trim();
                if value.is_empty() || value.chars().count() > 120 {
                    return Err((SKILL_LIST_COMMAND, USAGE));
                }
                query = Some(value.to_string());
                index += 2;
            }
            _ => return Err((SKILL_LIST_COMMAND, USAGE)),
        }
    }
    if !json_seen {
        return Err((SKILL_LIST_COMMAND, USAGE));
    }
    Ok(ParsedCommand::SkillList { query })
}

fn parse_skill_id_only(
    args: &[String],
    command: &'static str,
    usage: &'static str,
) -> Result<String, (&'static str, &'static str)> {
    let mut skill_id = None;
    let mut json_seen = false;
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--json" if !json_seen => {
                json_seen = true;
                index += 1;
            }
            "--skill-id" if skill_id.is_none() => {
                let Some(value) = args.get(index + 1) else {
                    return Err((command, usage));
                };
                if !valid_skill_id(value) {
                    return Err((command, usage));
                }
                skill_id = Some(value.clone());
                index += 2;
            }
            _ => return Err((command, usage)),
        }
    }
    match (skill_id, json_seen) {
        (Some(skill_id), true) => Ok(skill_id),
        _ => Err((command, usage)),
    }
}

fn parse_skill_discover(
    args: &[String],
    context: &LocalContext,
) -> Result<ParsedCommand, (&'static str, &'static str)> {
    const USAGE: &str = "用法：skillhub skill discover [--agent <key>] --json";
    let mut agent = None;
    let mut json_seen = false;
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--json" if !json_seen => {
                json_seen = true;
                index += 1;
            }
            "--agent" if agent.is_none() => {
                let Some(value) = args.get(index + 1) else {
                    return Err((SKILL_DISCOVER_COMMAND, USAGE));
                };
                if !context.agent_roots.iter().any(|root| root.key == *value) {
                    return Err((SKILL_DISCOVER_COMMAND, USAGE));
                }
                agent = Some(value.clone());
                index += 2;
            }
            _ => return Err((SKILL_DISCOVER_COMMAND, USAGE)),
        }
    }
    if !json_seen {
        return Err((SKILL_DISCOVER_COMMAND, USAGE));
    }
    Ok(ParsedCommand::SkillDiscover { agent })
}

fn parse_skill_diff(args: &[String]) -> Result<ParsedCommand, (&'static str, &'static str)> {
    const USAGE: &str = concat!(
        "用法：skillhub skill diff --skill-id <id> --working --json\n",
        "或：skillhub skill diff --skill-id <id> --from <hash> --to <hash> --json"
    );
    let mut skill_id = None;
    let mut working = false;
    let mut from = None;
    let mut to = None;
    let mut json_seen = false;
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--json" if !json_seen => {
                json_seen = true;
                index += 1;
            }
            "--working" if !working => {
                working = true;
                index += 1;
            }
            "--skill-id" if skill_id.is_none() => {
                let Some(value) = args.get(index + 1) else {
                    return Err((SKILL_DIFF_COMMAND, USAGE));
                };
                if !valid_skill_id(value) {
                    return Err((SKILL_DIFF_COMMAND, USAGE));
                }
                skill_id = Some(value.clone());
                index += 2;
            }
            "--from" if from.is_none() => {
                let Some(value) = args.get(index + 1) else {
                    return Err((SKILL_DIFF_COMMAND, USAGE));
                };
                if !valid_oid(value) {
                    return Err((SKILL_DIFF_COMMAND, USAGE));
                }
                from = Some(value.clone());
                index += 2;
            }
            "--to" if to.is_none() => {
                let Some(value) = args.get(index + 1) else {
                    return Err((SKILL_DIFF_COMMAND, USAGE));
                };
                if !valid_oid(value) {
                    return Err((SKILL_DIFF_COMMAND, USAGE));
                }
                to = Some(value.clone());
                index += 2;
            }
            _ => return Err((SKILL_DIFF_COMMAND, USAGE)),
        }
    }
    let Some(skill_id) = skill_id else {
        return Err((SKILL_DIFF_COMMAND, USAGE));
    };
    if !json_seen {
        return Err((SKILL_DIFF_COMMAND, USAGE));
    }
    let mode = match (working, from, to) {
        (true, None, None) => DiffMode::Working,
        (false, Some(from), Some(to)) => DiffMode::Commits { from, to },
        _ => return Err((SKILL_DIFF_COMMAND, USAGE)),
    };
    Ok(ParsedCommand::SkillDiff { skill_id, mode })
}

fn valid_skill_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 || value == "." || value == ".." {
        return false;
    }
    bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_oid(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn status(context: &LocalContext) -> CliCommandOutput {
    let manager = manager_integrity(context);
    let warnings = manager.problems.clone();
    CliCommandOutput::success(
        STATUS_COMMAND,
        unknown_account(),
        json!({
            "appVersion": env!("CARGO_PKG_VERSION"),
            "cliVersion": env!("CARGO_PKG_VERSION"),
            "cliProtocolVersion": CLI_PROTOCOL_VERSION,
            "platform": release_platform(),
            "arch": std::env::consts::ARCH,
            "managerSkill": manager,
            "serverValidated": false,
        }),
        warnings,
        Vec::new(),
    )
}

fn doctor(context: &LocalContext) -> CliCommandOutput {
    let skillhub_root = context
        .home
        .join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
    let managed_root = skillhub_root.join("skills");
    let runtime_session = skillhub_root.join("runtime/session.json");
    let cli_entry = cli_entry_path(&context.home);
    let manager = manager_integrity(context);
    let mut checks = vec![
        directory_check("home", "当前用户目录", &context.home, false),
        directory_check("skillhubRoot", "SkillHub 私有目录", &skillhub_root, true),
        directory_check(
            "managedSkills",
            "SkillHub 托管 Skill 目录",
            &managed_root,
            true,
        ),
        regular_file_check(
            "runtimeSession",
            "SkillHub Runtime Session",
            &runtime_session,
            false,
        ),
        executable_check("cliEntry", "公开 skillhub CLI 入口", &cli_entry),
        DoctorCheck {
            id: "managerSkill",
            ok: manager.valid,
            message: if manager.valid {
                format!(
                    "SkillHub Manager {} 完整",
                    crate::system_skill::SYSTEM_MANAGER_VERSION
                )
            } else {
                manager.problems.join("；")
            },
        },
    ];
    let detected_count = context.agents.iter().filter(|agent| agent.detected).count();
    let ready_count = context
        .agents
        .iter()
        .filter(|agent| agent.detected && agent.skills_status == AgentSkillsStatus::Ready)
        .count();
    checks.push(DoctorCheck {
        id: "agents",
        ok: detected_count > 0,
        message: format!("检测到 {detected_count} 个 Agent，其中 {ready_count} 个 Skill 目录可用"),
    });
    // Read-only count of pre-#165 `.skillhub-remove-link-*` and pre-#272
    // `.skillhub-old-link-*` (`oldLinks`) leftovers. The APP removes the owned
    // ones on its next projection refresh.
    let legacy_remove_links = crate::commands::sweep_legacy_remove_links_in(&context.home, false);
    let healthy = checks.iter().all(|check| check.ok);
    let warnings = checks
        .iter()
        .filter(|check| !check.ok)
        .map(|check| check.message.clone())
        .collect::<Vec<_>>();
    CliCommandOutput::success(
        DOCTOR_COMMAND,
        unknown_account(),
        json!({
            "healthy": healthy,
            "checks": checks,
            "detectedAgentCount": detected_count,
            "readyDetectedAgentCount": ready_count,
            "repairAttempted": false,
            "legacyRemoveLinks": legacy_remove_links,
        }),
        warnings,
        if healthy {
            Vec::new()
        } else {
            vec!["请打开 SkillHub APP，在设置中检查或修复 CLI 与 Agent 安装".into()]
        },
    )
}

fn agent_list(context: &LocalContext) -> CliCommandOutput {
    let detected_count = context.agents.iter().filter(|agent| agent.detected).count();
    CliCommandOutput::success(
        AGENT_LIST_COMMAND,
        unknown_account(),
        json!({
            "agents": context.agents,
            "detectedCount": detected_count,
            "platform": release_platform(),
        }),
        Vec::new(),
        Vec::new(),
    )
}

fn skill_list(context: &LocalContext, query: Option<&str>) -> CliCommandOutput {
    let (mut skills, warnings) = match scan_managed_skills(context) {
        Ok(result) => result,
        Err(message) => return internal_failure(SKILL_LIST_COMMAND, message),
    };
    if let Some(query) = query {
        let query = query.to_lowercase();
        skills.retain(|skill| skill_matches(skill, &query));
    }
    CliCommandOutput::success(
        SKILL_LIST_COMMAND,
        unknown_account(),
        json!({ "skills": skills, "count": skills.len(), "query": query }),
        warnings,
        Vec::new(),
    )
}

fn skill_show(context: &LocalContext, skill_id: &str) -> CliCommandOutput {
    let root = context
        .home
        .join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        })
        .join("skills")
        .join(skill_id);
    match safe_real_directory(&root) {
        Ok(true) => {}
        Ok(false) => return skill_not_found(SKILL_SHOW_COMMAND, skill_id),
        Err(message) => return internal_failure(SKILL_SHOW_COMMAND, message),
    }
    let mut warnings = Vec::new();
    let skill = match read_skill(context, &root, skill_id, &mut warnings) {
        Ok(skill) => skill,
        Err(message) => return internal_failure(SKILL_SHOW_COMMAND, message),
    };
    let (tree, tree_truncated) = match collect_tree(&root, &mut warnings) {
        Ok(result) => result,
        Err(message) => return internal_failure(SKILL_SHOW_COMMAND, message),
    };
    CliCommandOutput::success(
        SKILL_SHOW_COMMAND,
        unknown_account(),
        json!({ "skill": skill, "tree": tree, "treeTruncated": tree_truncated }),
        warnings,
        Vec::new(),
    )
}

fn skill_discover(context: &LocalContext, selected_agent: Option<&str>) -> CliCommandOutput {
    let managed_root = context
        .home
        .join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        })
        .join("skills");
    let managed_canonical = fs::canonicalize(&managed_root).ok();
    let detected = context
        .agents
        .iter()
        .filter(|agent| crate::admits_skill_writes(agent))
        .map(|agent| agent.key.as_str())
        .collect::<HashSet<_>>();
    let mut discovered = BTreeMap::<String, DiscoveredSkill>::new();
    let mut warnings = Vec::new();

    for agent_root in context.agent_roots.iter().filter(|root| {
        selected_agent.is_none_or(|selected| selected == root.key)
            && detected.contains(root.key.as_str())
    }) {
        let root = context.home.join(&agent_root.relative);
        match safe_real_directory(&root) {
            Ok(true) => {}
            Ok(false) => continue,
            Err(message) => {
                warnings.push(format!("{}: {message}", agent_root.name));
                continue;
            }
        }
        let entries = match sorted_directory_entries(&root) {
            Ok(entries) => entries,
            Err(message) => {
                warnings.push(format!("{}: {message}", agent_root.name));
                continue;
            }
        };
        let mut candidates: Vec<(String, PathBuf, Option<String>)> = Vec::new();
        for entry in entries {
            let entry_path = entry.path();
            let Some(entry_name) = entry.file_name().to_str().map(str::to_string) else {
                warnings.push(format!(
                    "{} 包含非 UTF-8 的 Skill 名称，已跳过",
                    agent_root.name
                ));
                continue;
            };
            if !valid_skill_id(&entry_name) {
                warnings.push(format!(
                    "{} 的 Skill {entry_name} 名称不安全，已跳过",
                    agent_root.name
                ));
                continue;
            }
            match safe_real_directory(&entry_path) {
                Ok(true) => {}
                Ok(false) => continue,
                Err(message) => {
                    warnings.push(format!("{} / {entry_name}: {message}", agent_root.name));
                    continue;
                }
            }
            if fs::symlink_metadata(entry_path.join("SKILL.md")).is_ok() {
                candidates.push((entry_name, entry_path, None));
                continue;
            }
            // A folder without SKILL.md may group Skills one level deeper.
            // Only real directories named like Skills are considered there;
            // anything else in the group is ignored without a warning.
            let Ok(children) = sorted_directory_entries(&entry_path) else {
                continue;
            };
            for child in children.into_iter().take(MAX_GROUPED_SKILLS_PER_FOLDER) {
                let child_path = child.path();
                let Some(child_name) = child.file_name().to_str().map(str::to_string) else {
                    continue;
                };
                if !valid_skill_id(&child_name)
                    || !matches!(safe_real_directory(&child_path), Ok(true))
                    || fs::symlink_metadata(child_path.join("SKILL.md")).is_err()
                {
                    continue;
                }
                candidates.push((child_name, child_path, Some(entry_name.clone())));
            }
        }
        for (entry_name, entry_path, group) in candidates {
            let location = match group.as_deref() {
                Some(group) => format!("{group}/{entry_name}"),
                None => entry_name.clone(),
            };
            let canonical = match fs::canonicalize(&entry_path) {
                Ok(canonical) => canonical,
                Err(error) => {
                    warnings.push(format!(
                        "无法解析 {} / {location}: {error}",
                        agent_root.name
                    ));
                    continue;
                }
            };
            if managed_canonical
                .as_ref()
                .is_some_and(|managed| canonical.starts_with(managed))
            {
                continue;
            }
            match read_bounded_regular(&entry_path.join("SKILL.md"), MAX_SKILL_MD_BYTES) {
                Ok(Some(contents)) => {
                    let hints = parse_skill_document_hints(&entry_name, &contents);
                    let key = canonical.to_string_lossy().to_string();
                    let source = DiscoveredSource {
                        agent_key: agent_root.key.clone(),
                        agent_name: agent_root.name.clone(),
                        entry_name: entry_name.clone(),
                        group,
                    };
                    match discovered.get_mut(&key) {
                        Some(skill) => skill.sources.push(source),
                        None => {
                            discovered.insert(
                                key.clone(),
                                DiscoveredSkill {
                                    id: entry_name,
                                    display_name: hints.display_name,
                                    description: hints.description,
                                    version: hints.version,
                                    sources: vec![source],
                                    local_path: key,
                                },
                            );
                        }
                    }
                }
                Ok(None) => {}
                Err(message) => warnings.push(format!(
                    "{} / {location} 的 SKILL.md 无法安全读取: {message}",
                    agent_root.name
                )),
            }
        }
    }

    let skills = discovered.into_values().collect::<Vec<_>>();
    CliCommandOutput::success(
        SKILL_DISCOVER_COMMAND,
        unknown_account(),
        json!({
            "skills": skills,
            "count": skills.len(),
            "agent": selected_agent,
            "readOnly": true,
        }),
        warnings,
        Vec::new(),
    )
}

fn skill_history(context: &LocalContext, skill_id: &str) -> CliCommandOutput {
    let root = context
        .home
        .join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        })
        .join("skills")
        .join(skill_id);
    match safe_real_directory(&root) {
        Ok(true) => {}
        Ok(false) => return skill_not_found(SKILL_HISTORY_COMMAND, skill_id),
        Err(message) => return internal_failure(SKILL_HISTORY_COMMAND, message),
    }
    let repo = match Repository::open(&root) {
        Ok(repo) => repo,
        Err(_) => {
            return CliCommandOutput::success(
                SKILL_HISTORY_COMMAND,
                unknown_account(),
                json!({ "skillId": skill_id, "versioned": false, "versions": [] }),
                vec!["此 Skill 尚无本地 Git 版本历史".into()],
                Vec::new(),
            )
        }
    };
    let mut revwalk = match repo.revwalk() {
        Ok(revwalk) => revwalk,
        Err(error) => return internal_failure(SKILL_HISTORY_COMMAND, error.to_string()),
    };
    if revwalk.push_head().is_err() {
        return CliCommandOutput::success(
            SKILL_HISTORY_COMMAND,
            unknown_account(),
            json!({ "skillId": skill_id, "versioned": true, "versions": [] }),
            vec!["此 Skill 的 Git 仓库尚无 HEAD 版本".into()],
            Vec::new(),
        );
    }
    let mut metadata = crate::commands::library_read_profile_readonly(&root)
        .map(|p| {
            let home = crate::spaces::channel_root(&context.home, crate::official_channel::CHANNEL);
            if crate::spaces::require_profile_at(&home, &p).is_ok() {
                p.version_metadata
            } else {
                Default::default()
            }
        })
        .unwrap_or_default();
    if let Err(error) = crate::version_policy::normalize_history(&root, &mut metadata) {
        return internal_failure(SKILL_HISTORY_COMMAND, error);
    }
    let mut versions = Vec::new();
    let current_hash = crate::version_policy::head(&root);
    let current_mapping = crate::version_policy::current(&root, &metadata);
    let scoped =
        metadata.account_id.as_deref() == crate::runtime_env::active_runtime_user_id().as_deref();
    for oid in revwalk {
        let Ok(oid) = oid else { continue };
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        let message = bounded_text(&String::from_utf8_lossy(commit.message_bytes()), 2_000);
        let summary = message.lines().next().unwrap_or_default().to_string();
        let mappings = crate::version_policy::history_for_hash(&metadata, &oid.to_string());
        let mappings: Vec<Option<&crate::version_policy::CommitVersion>> = if mappings.is_empty() {
            vec![None]
        } else {
            mappings.iter().map(Some).collect()
        };
        for mapped in mappings {
            let receipt = mapped.and_then(|m| m.receipt.as_ref()).filter(|_| scoped);
            let is_current = current_hash.as_deref() == Some(&oid.to_string())
                && mapped.is_some_and(|m| current_mapping.as_ref() == Some(m));
            versions.push(HistoryEntry {
                label: mapped.map(|m| m.label.clone()),
                original_label: mapped.map(|m| m.original_label.clone()),
                receipt_id: receipt.map(|r| r.receipt_id.clone()),
                formal_version_id: mapped
                    .and_then(|m| m.formal_version_id.clone())
                    .filter(|_| scoped),
                formal_label: receipt.and_then(|r| r.formal_label.clone()),
                version_status: mapped
                    .map(|m| {
                        if receipt.is_some() {
                            "confirmed"
                        } else if scoped && is_current && m.pending.is_some() {
                            "pending"
                        } else {
                            "local"
                        }
                    })
                    .unwrap_or("unversioned")
                    .into(),
                hash: oid.to_string(),
                summary: summary.clone(),
                message: message.clone(),
                committed_at_unix: commit.time().seconds(),
                is_current,
            });
        }
    }
    CliCommandOutput::success(
        SKILL_HISTORY_COMMAND,
        unknown_account(),
        json!({ "skillId": skill_id, "versioned": true, "versions": versions }),
        Vec::new(),
        Vec::new(),
    )
}

fn skill_diff(context: &LocalContext, skill_id: &str, mode: DiffMode) -> CliCommandOutput {
    let root = context
        .home
        .join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        })
        .join("skills")
        .join(skill_id);
    match safe_real_directory(&root) {
        Ok(true) => {}
        Ok(false) => return skill_not_found(SKILL_DIFF_COMMAND, skill_id),
        Err(message) => return internal_failure(SKILL_DIFF_COMMAND, message),
    }
    let repo = match Repository::open(&root) {
        Ok(repo) => repo,
        Err(_) => {
            return CliCommandOutput::failure(
                SKILL_DIFF_COMMAND,
                unknown_account(),
                CliErrorCode::ValidationFailed,
                "此 Skill 尚无本地 Git 版本历史",
                EXIT_USAGE,
                vec!["请先在 SkillHub APP 中创建版本".into()],
            )
        }
    };
    let result = match &mode {
        DiffMode::Working => working_diff(&repo),
        DiffMode::Commits { from, to } => commit_diff(&repo, from, to),
    };
    let (lines, truncated) = match result {
        Ok(result) => result,
        Err(message) => {
            return CliCommandOutput::failure(
                SKILL_DIFF_COMMAND,
                unknown_account(),
                CliErrorCode::ValidationFailed,
                message,
                EXIT_USAGE,
                vec![format!(
                    "使用 skillhub skill history --skill-id {skill_id} --json 查看有效版本"
                )],
            )
        }
    };
    let mode_name = match mode {
        DiffMode::Working => "working",
        DiffMode::Commits { .. } => "commits",
    };
    CliCommandOutput::success(
        SKILL_DIFF_COMMAND,
        unknown_account(),
        json!({
            "skillId": skill_id,
            "mode": mode_name,
            "lines": lines,
            "lineCount": lines.len(),
            "truncated": truncated,
        }),
        if truncated {
            vec!["Diff 超过安全输出上限，结果已截断".into()]
        } else {
            Vec::new()
        },
        Vec::new(),
    )
}

fn scan_managed_skills(
    context: &LocalContext,
) -> Result<(Vec<ReadOnlySkill>, Vec<String>), String> {
    let skillhub_root = context
        .home
        .join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
    if !safe_real_directory(&skillhub_root)? {
        return Ok((Vec::new(), Vec::new()));
    }
    let root = skillhub_root.join("skills");
    if !safe_real_directory(&root)? {
        return Ok((Vec::new(), Vec::new()));
    }
    let mut skills = Vec::new();
    let mut warnings = Vec::new();
    for entry in sorted_directory_entries(&root)? {
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            warnings.push("本地 Skills 包含非 UTF-8 名称，已跳过".into());
            continue;
        };
        if id.starts_with('.') || !valid_skill_id(&id) {
            warnings.push(format!("本地 Skill {id} 名称不安全，已跳过"));
            continue;
        }
        match safe_real_directory(&entry.path()) {
            Ok(true) => match read_skill(context, &entry.path(), &id, &mut warnings) {
                Ok(skill) => skills.push(skill),
                Err(message) => warnings.push(format!("{id}: {message}")),
            },
            Ok(false) => {}
            Err(message) => warnings.push(format!("{id}: {message}")),
        }
    }
    skills.sort_by(|left, right| left.id.cmp(&right.id));
    Ok((skills, warnings))
}

fn read_skill(
    context: &LocalContext,
    root: &Path,
    id: &str,
    warnings: &mut Vec<String>,
) -> Result<ReadOnlySkill, String> {
    let sidecar_path = root.join(".skillhub.json");
    let (profile, profile_status) = match read_bounded_regular(&sidecar_path, MAX_PROFILE_BYTES) {
        Ok(Some(contents)) => match serde_json::from_slice::<SkillHubJson>(&contents) {
            Ok(sidecar) => match sidecar.skillhub {
                Some(profile) => {
                    let profile =
                        if crate::spaces::current_profile_matches(&profile).unwrap_or(false) {
                            profile
                        } else {
                            crate::spaces::local_view(profile)
                        };
                    (Some(profile), "valid".to_string())
                }
                None => {
                    warnings.push(format!("{id}: .skillhub.json 缺少 skillhub Profile"));
                    (None, "invalid".to_string())
                }
            },
            Err(_) => {
                warnings.push(format!("{id}: .skillhub.json 不是有效 JSON"));
                (None, "invalid".to_string())
            }
        },
        Ok(None) => (None, "missing".to_string()),
        Err(message) => {
            warnings.push(format!("{id}: .skillhub.json 无法安全读取: {message}"));
            (None, "unsafe".to_string())
        }
    };

    let markdown = match read_bounded_regular(&root.join("SKILL.md"), MAX_SKILL_MD_BYTES) {
        Ok(Some(contents)) => String::from_utf8_lossy(&contents).into_owned(),
        Ok(None) => String::new(),
        Err(message) => {
            warnings.push(format!("{id}: SKILL.md 无法安全读取: {message}"));
            String::new()
        }
    };
    let hints = parse_skill_document_hints(id, markdown.as_bytes());
    let mut skill = skill_from_profile(root, id, profile.as_ref(), &hints, profile_status);
    let (installed_agents, agent_states) =
        read_agent_projection_states(context, id, &skill.name, warnings);
    skill.installed_agents = installed_agents;
    skill.agent_states = agent_states;
    Ok(skill)
}

fn read_agent_projection_states(
    context: &LocalContext,
    skill_id: &str,
    projection_name: &str,
    warnings: &mut Vec<String>,
) -> (Vec<String>, BTreeMap<String, ReadOnlyAgentProjectionState>) {
    let mut installed_agents = Vec::new();
    let mut states = BTreeMap::new();
    if !valid_skill_id(projection_name) {
        warnings.push(format!(
            "{skill_id}: Skill Profile 中的 Agent 投影名无效，未读取投影状态"
        ));
        for agent in &context.agent_roots {
            states.insert(agent.key.clone(), ReadOnlyAgentProjectionState::Unknown);
        }
        return (installed_agents, states);
    }

    let skillhub_root = context
        .home
        .join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
    let managed_root = skillhub_root.join("skills");
    for agent in &context.agent_roots {
        let link = context.home.join(&agent.relative).join(projection_name);
        let state = match crate::commands::managed_skill_agent_projection_state_at(
            &link,
            &skillhub_root,
            &managed_root,
            skill_id,
        ) {
            Ok(crate::commands::ManagedSkillAgentProjectionState::Installed) => {
                installed_agents.push(agent.key.clone());
                ReadOnlyAgentProjectionState::Installed
            }
            Ok(crate::commands::ManagedSkillAgentProjectionState::Missing) => {
                ReadOnlyAgentProjectionState::NotInstalled
            }
            Ok(crate::commands::ManagedSkillAgentProjectionState::Occupied) => {
                ReadOnlyAgentProjectionState::Conflict
            }
            Err(error) => {
                warnings.push(format!(
                    "{skill_id}: 无法安全检查 {} 投影状态: {error}",
                    agent.name
                ));
                ReadOnlyAgentProjectionState::Unknown
            }
        };
        states.insert(agent.key.clone(), state);
    }
    installed_agents.sort();
    (installed_agents, states)
}

fn skill_from_profile(
    root: &Path,
    id: &str,
    profile: Option<&SkillHubProfile>,
    hints: &DocumentHints,
    profile_status: String,
) -> ReadOnlySkill {
    let name = profile
        .and_then(|profile| profile.name.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| id.to_string());
    let display_name = profile
        .and_then(|profile| profile.display_name.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| hints.display_name.clone());
    let description = profile
        .and_then(|profile| profile.description.clone())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| hints.description.clone());
    let category = profile
        .and_then(|profile| profile.category.clone())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| hints.category.clone());
    let labels = profile
        .filter(|profile| !profile.labels.is_empty())
        .map(|profile| profile.labels.clone())
        .unwrap_or_else(|| hints.labels.clone());
    let original_version = profile
        .map(|profile| profile.version.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| hints.version.clone());
    let mut version_metadata = profile
        .map(|p| p.version_metadata.clone())
        .unwrap_or_default();
    let normalized = crate::version_policy::normalize_history(root, &mut version_metadata).is_ok();
    let current = normalized
        .then(|| crate::version_policy::current(root, &version_metadata))
        .flatten();
    let saved = normalized
        .then(|| crate::version_policy::saved_current(root, &version_metadata))
        .flatten();
    let version = if profile.is_some_and(|p| p.is_system) {
        original_version
    } else {
        saved.as_ref().map(|m| m.label.clone()).unwrap_or_default()
    };
    let receipt = current
        .as_ref()
        .and_then(|m| m.receipt.as_ref())
        .filter(|_| {
            profile.is_some_and(|p| {
                p.library_account_id == version_metadata.account_id
                    && p.library_entry_id == version_metadata.entry_id
            })
        });
    let acquisition_source = profile
        .and_then(|profile| profile.acquisition_source)
        .or_else(|| {
            profile.and_then(|profile| profile.upstream.as_ref().map(|upstream| upstream.source))
        })
        .unwrap_or(AcquisitionSource::Local);
    let server_id = profile
        .and_then(|profile| profile.server_id.clone())
        .or_else(|| {
            profile.and_then(|profile| {
                profile
                    .upstream
                    .as_ref()
                    .and_then(|upstream| upstream.server_skill_id.clone())
            })
        });
    let server_owner_id = profile
        .and_then(|profile| profile.server_owner_id.clone())
        .or_else(|| {
            profile.and_then(|profile| {
                profile
                    .upstream
                    .as_ref()
                    .and_then(|upstream| upstream.server_owner_id.clone())
            })
        });
    let env_dependencies = profile
        .map(|profile| {
            profile
                .env_dependencies
                .iter()
                .map(|dependency| ReadOnlyEnvDependency {
                    key: dependency.key.clone(),
                    description: dependency.description.clone(),
                    required: dependency.required,
                    share_policy: dependency.share_policy.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    ReadOnlySkill {
        has_working_copy: saved.is_some() && current.is_none(),
        version_problem: if !profile.is_some_and(|p| p.is_system) && saved.is_none() {
            crate::version_policy::head(root)
                .and_then(|hash| version_metadata.history_reviews.get(&hash).cloned())
                .or_else(|| {
                    Some("已保存内容尚未初始化本机版本，请通过 SkillHub 维护或保存版本".into())
                })
        } else {
            None
        },
        version_status: if profile.is_some_and(|p| p.is_system) {
            "local"
        } else if receipt.is_some() {
            "confirmed"
        } else if profile.is_some_and(|p| p.library_account_id.is_some())
            && current.as_ref().is_some_and(|m| m.pending.is_some())
        {
            "pending"
        } else if saved.is_some() {
            "local"
        } else {
            "unversioned"
        }
        .into(),
        version_receipt_id: receipt.map(|r| r.receipt_id.clone()),
        formal_version_id: receipt.and_then(|r| r.formal_version_id.clone()),
        formal_label: receipt.and_then(|r| r.formal_label.clone()),
        version_high_water: version_metadata.high_water,
        next_version: crate::version_policy::allocate(version_metadata.high_water, None).ok(),
        id: id.to_string(),
        name,
        display_name,
        description,
        category,
        labels,
        version,
        is_system: profile.is_some_and(|profile| profile.is_system),
        system_version: profile.and_then(|profile| profile.system_version.clone()),
        acquisition_source,
        server_id,
        server_owner_id,
        team_shared_from: profile.and_then(|profile| profile.team_shared_from.clone()),
        compatible_agents: profile
            .map(|profile| profile.compatible_agents.clone())
            .unwrap_or_default(),
        installed_agents: Vec::new(),
        agent_states: BTreeMap::new(),
        env_dependencies,
        local_path: root.to_string_lossy().to_string(),
        profile_status,
    }
}

#[derive(Debug)]
struct DocumentHints {
    display_name: String,
    description: Option<String>,
    category: Option<String>,
    labels: Vec<String>,
    version: String,
}

fn parse_skill_document_hints(skill_id: &str, bytes: &[u8]) -> DocumentHints {
    let text = String::from_utf8_lossy(bytes);
    let document = crate::skill_document::parse_skill_document(&text);
    let display_name = document
        .display_name()
        .or_else(|| crate::skill_document::first_heading(document.body))
        .map(|value| bounded_text(value, 160));
    let description = document
        .text("description")
        .or_else(|| crate::skill_document::first_paragraph_line(document.body))
        .map(|value| bounded_text(value, 240));
    let labels = document
        .list("labels")
        .or_else(|| document.list("tags"))
        .unwrap_or_default()
        .iter()
        .take(16)
        .map(|label| bounded_text(label, 80))
        .collect();
    DocumentHints {
        display_name: display_name.unwrap_or_else(|| skill_id.to_string()),
        description,
        category: document
            .text("category")
            .map(|value| bounded_text(value, 80)),
        labels,
        version: document
            .text("version")
            .map(|value| bounded_text(value, 80))
            .unwrap_or_else(|| "v0.1.0".into()),
    }
}

fn collect_tree(
    root: &Path,
    warnings: &mut Vec<String>,
) -> Result<(Vec<SkillTreeEntry>, bool), String> {
    let mut entries = Vec::new();
    let mut truncated = false;
    collect_tree_level(root, root, 0, &mut entries, &mut truncated, warnings)?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok((entries, truncated))
}

fn collect_tree_level(
    root: &Path,
    directory: &Path,
    depth: usize,
    output: &mut Vec<SkillTreeEntry>,
    truncated: &mut bool,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    if *truncated {
        return Ok(());
    }
    for entry in sorted_directory_entries(directory)? {
        if output.len() >= MAX_TREE_ENTRIES {
            *truncated = true;
            return Ok(());
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "Skill 文件路径越过根目录".to_string())?;
        if should_hide_path(relative) {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            warnings.push("Skill 包含非 UTF-8 文件名，已跳过".into());
            continue;
        };
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        let link_like = is_link_like(&path, &metadata);
        let kind = if link_like {
            "symlink"
        } else if metadata.is_dir() {
            "directory"
        } else if metadata.is_file() {
            "file"
        } else {
            "other"
        };
        output.push(SkillTreeEntry {
            path: normalized_relative(relative)?,
            name,
            kind: kind.into(),
            depth,
        });
        if metadata.is_dir() && !link_like {
            if depth + 1 >= MAX_TREE_DEPTH {
                *truncated = true;
                warnings.push(format!(
                    "Skill 文件树超过 {MAX_TREE_DEPTH} 层，深层内容已省略"
                ));
            } else {
                collect_tree_level(root, &path, depth + 1, output, truncated, warnings)?;
            }
        }
    }
    Ok(())
}

fn working_diff(repo: &Repository) -> Result<(Vec<ReadOnlyDiffLine>, bool), String> {
    let head_tree = repo
        .head()
        .map_err(|_| "此 Skill 的 Git 仓库尚无 HEAD 版本".to_string())?
        .peel_to_tree()
        .map_err(|_| "无法读取此 Skill 的当前版本".to_string())?;
    let mut options = DiffOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    let diff = repo
        .diff_tree_to_workdir_with_index(Some(&head_tree), Some(&mut options))
        .map_err(|error| error.to_string())?;
    collect_diff(&diff)
}

fn commit_diff(
    repo: &Repository,
    from: &str,
    to: &str,
) -> Result<(Vec<ReadOnlyDiffLine>, bool), String> {
    let from_oid = Oid::from_str(from).map_err(|_| "--from 不是有效 Git hash".to_string())?;
    let to_oid = Oid::from_str(to).map_err(|_| "--to 不是有效 Git hash".to_string())?;
    let from_commit = repo
        .find_commit(from_oid)
        .map_err(|_| "找不到 --from 指定的本地版本".to_string())?;
    let to_commit = repo
        .find_commit(to_oid)
        .map_err(|_| "找不到 --to 指定的本地版本".to_string())?;
    let from_tree = from_commit
        .tree()
        .map_err(|_| "无法读取 --from 指定的本地版本".to_string())?;
    let to_tree = to_commit
        .tree()
        .map_err(|_| "无法读取 --to 指定的本地版本".to_string())?;
    let diff = repo
        .diff_tree_to_tree(Some(&from_tree), Some(&to_tree), None)
        .map_err(|error| error.to_string())?;
    collect_diff(&diff)
}

fn collect_diff(diff: &git2::Diff<'_>) -> Result<(Vec<ReadOnlyDiffLine>, bool), String> {
    let mut lines = Vec::new();
    let mut total_bytes = 0_usize;
    let mut truncated = false;
    diff.print(DiffFormat::Patch, |delta, _hunk, line| {
        let relative = delta.new_file().path().or_else(|| delta.old_file().path());
        if relative.is_some_and(should_hide_path) {
            return true;
        }
        if lines.len() >= MAX_DIFF_LINES || total_bytes >= MAX_DIFF_BYTES {
            truncated = true;
            return true;
        }
        let content = String::from_utf8_lossy(line.content()).into_owned();
        if total_bytes.saturating_add(content.len()) > MAX_DIFF_BYTES {
            truncated = true;
            return true;
        }
        total_bytes = total_bytes.saturating_add(content.len());
        let kind = match line.origin() {
            '+' => "add",
            '-' => "del",
            _ => "ctx",
        };
        lines.push(ReadOnlyDiffLine {
            path: relative.map(|path| path.to_string_lossy().replace('\\', "/")),
            kind: kind.into(),
            content,
        });
        true
    })
    .map_err(|error| error.to_string())?;
    Ok((lines, truncated))
}

fn manager_integrity(context: &LocalContext) -> ManagerIntegrity {
    let root = context
        .home
        .join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        })
        .join("skills")
        .join(crate::system_skill::SYSTEM_MANAGER_ID);
    let mut problems = Vec::new();
    let installed = match safe_real_directory(&root) {
        Ok(installed) => installed,
        Err(message) => {
            problems.push(message);
            false
        }
    };
    if !installed {
        if problems.is_empty() {
            problems.push("尚未安装 SkillHub Manager".into());
        }
        return ManagerIntegrity {
            installed: false,
            valid: false,
            expected_version: crate::system_skill::SYSTEM_MANAGER_VERSION,
            installed_version: None,
            problems,
        };
    }

    for (relative, expected) in crate::system_skill::files() {
        match read_bounded_regular(
            &root.join(relative),
            (expected.len() as u64).saturating_add(1),
        ) {
            Ok(Some(actual)) if actual == expected.as_bytes() => {}
            Ok(Some(_)) => problems.push(format!("{relative} 与当前内置版本不一致")),
            Ok(None) => problems.push(format!("缺少 {relative}")),
            Err(message) => problems.push(format!("{relative}: {message}")),
        }
    }

    let installed_version =
        match read_bounded_regular(&root.join(".skillhub.json"), MAX_PROFILE_BYTES) {
            Ok(Some(contents)) => serde_json::from_slice::<SkillHubJson>(&contents)
                .ok()
                .and_then(|sidecar| sidecar.skillhub)
                .and_then(|profile| {
                    if !profile.is_system {
                        problems.push(".skillhub.json 未标记为系统 Skill".into());
                    }
                    profile.system_version.or(Some(profile.version))
                }),
            Ok(None) => {
                problems.push("缺少 .skillhub.json".into());
                None
            }
            Err(message) => {
                problems.push(format!(".skillhub.json: {message}"));
                None
            }
        };
    if installed_version.as_deref() != Some(crate::system_skill::SYSTEM_MANAGER_VERSION) {
        problems.push(format!(
            "SkillHub Manager 版本应为 {}",
            crate::system_skill::SYSTEM_MANAGER_VERSION
        ));
    }
    ManagerIntegrity {
        installed: true,
        valid: problems.is_empty(),
        expected_version: crate::system_skill::SYSTEM_MANAGER_VERSION,
        installed_version,
        problems,
    }
}

fn directory_check(
    id: &'static str,
    label: &'static str,
    path: &Path,
    optional: bool,
) -> DoctorCheck {
    match safe_real_directory(path) {
        Ok(true) => DoctorCheck {
            id,
            ok: true,
            message: format!("{label}可读取"),
        },
        Ok(false) if optional => DoctorCheck {
            id,
            ok: false,
            message: format!("{label}尚不存在"),
        },
        Ok(false) => DoctorCheck {
            id,
            ok: false,
            message: format!("{label}不存在"),
        },
        Err(_) => DoctorCheck {
            id,
            ok: false,
            message: format!("{label}不是可安全读取的真实目录"),
        },
    }
}

fn regular_file_check(
    id: &'static str,
    label: &'static str,
    path: &Path,
    optional: bool,
) -> DoctorCheck {
    match fs::symlink_metadata(path) {
        Ok(metadata) if is_link_like(path, &metadata) => DoctorCheck {
            id,
            ok: false,
            message: format!("{label}是链接，已拒绝信任"),
        },
        Ok(metadata) if metadata.is_file() => DoctorCheck {
            id,
            ok: true,
            message: format!("{label}是普通文件"),
        },
        Ok(_) => DoctorCheck {
            id,
            ok: false,
            message: format!("{label}不是普通文件"),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && optional => DoctorCheck {
            id,
            ok: false,
            message: format!("{label}尚不存在"),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => DoctorCheck {
            id,
            ok: false,
            message: format!("{label}不存在"),
        },
        Err(_) => DoctorCheck {
            id,
            ok: false,
            message: format!("无法安全检查{label}"),
        },
    }
}

fn executable_check(id: &'static str, label: &'static str, path: &Path) -> DoctorCheck {
    let check = regular_file_check(id, label, path, false);
    #[cfg(unix)]
    {
        let mut check = check;
        if check.ok {
            match fs::metadata(path) {
                Ok(metadata) if metadata.permissions().mode() & 0o111 != 0 => {}
                Ok(_) => {
                    check.ok = false;
                    check.message = format!("{label}没有执行权限");
                }
                Err(_) => {
                    check.ok = false;
                    check.message = format!("无法安全检查{label}的执行权限");
                }
            }
        }
        check
    }
    #[cfg(not(unix))]
    {
        check
    }
}

fn safe_real_directory(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if is_link_like(path, &metadata) => {
            Err(format!("{} 是链接，已拒绝遍历", path.display()))
        }
        Ok(metadata) if metadata.is_dir() => Ok(true),
        Ok(_) => Err(format!("{} 不是普通目录", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法检查 {}: {error}", path.display())),
    }
}

fn read_bounded_regular(path: &Path, max_bytes: u64) -> Result<Option<Vec<u8>>, String> {
    let initial = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if is_link_like(path, &initial) || !initial.is_file() {
        return Err("不是安全的普通文件".into());
    }
    if initial.len() > max_bytes {
        return Err(format!("文件超过 {max_bytes} 字节读取上限"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(any(unix, windows))]
    options.custom_flags(crate::platform_fs::NOFOLLOW_FLAG);
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    let opened = file.metadata().map_err(|error| error.to_string())?;
    if !opened.is_file() || opened.len() > max_bytes {
        return Err("文件在读取前发生变化或超过读取上限".into());
    }
    let mut contents = Vec::with_capacity(opened.len().min(max_bytes) as usize);
    std::io::Read::by_ref(&mut file)
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut contents)
        .map_err(|error| error.to_string())?;
    if contents.len() as u64 > max_bytes {
        return Err(format!("文件超过 {max_bytes} 字节读取上限"));
    }
    Ok(Some(contents))
}

fn sorted_directory_entries(path: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let mut entries = fs::read_dir(path)
        .map_err(|error| format!("无法读取 {}: {error}", path.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法读取 {}: {error}", path.display()))?;
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries)
}

fn normalized_relative(path: &Path) -> Result<String, String> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| "Skill 文件名不是有效 UTF-8".to_string())?;
                components.push(value);
            }
            _ => return Err("Skill 文件路径不安全".into()),
        }
    }
    Ok(components.join("/"))
}

fn should_hide_path(path: &Path) -> bool {
    let generated = [
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        "__pycache__",
    ];
    if path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|value| generated.contains(&value))
    }) {
        return true;
    }
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return true;
    };
    if matches!(name, ".skillhub.json" | ".DS_Store") {
        return true;
    }
    if name == ".env" || name == ".envrc" {
        return true;
    }
    if let Some(suffix) = name.strip_prefix(".env.") {
        return !matches!(suffix, "example" | "sample" | "template");
    }
    false
}

#[cfg(windows)]
fn is_link_like(path: &Path, metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink() || junction::exists(path).unwrap_or(false)
}

#[cfg(not(windows))]
fn is_link_like(_path: &Path, metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn skill_matches(skill: &ReadOnlySkill, query: &str) -> bool {
    skill.id.to_lowercase().contains(query)
        || skill.name.to_lowercase().contains(query)
        || skill.display_name.to_lowercase().contains(query)
        || skill
            .description
            .as_ref()
            .is_some_and(|description| description.to_lowercase().contains(query))
        || skill
            .labels
            .iter()
            .any(|label| label.to_lowercase().contains(query))
}

fn release_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        std::env::consts::OS
    }
}

#[cfg(windows)]
fn cli_entry_path(home: &Path) -> PathBuf {
    crate::runtime_env::windows_cli_entry_path_at(home)
}

#[cfg(not(windows))]
fn cli_entry_path(home: &Path) -> PathBuf {
    home.join(".local/bin/skillhub")
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn internal_failure(command: &'static str, message: String) -> CliCommandOutput {
    CliCommandOutput::failure(
        command,
        unknown_account(),
        CliErrorCode::InternalError,
        message,
        EXIT_INTERNAL,
        Vec::new(),
    )
}

fn skill_not_found(command: &'static str, skill_id: &str) -> CliCommandOutput {
    CliCommandOutput::failure(
        command,
        unknown_account(),
        CliErrorCode::ValidationFailed,
        format!("找不到本地 Skill: {skill_id}"),
        EXIT_USAGE,
        vec!["使用 skillhub skill list --json 查看本地 Skills".into()],
    )
}

#[cfg(test)]
mod tests {
    use super::{
        execute_local_cli_at, AgentRoot, LocalContext, AGENT_LIST_COMMAND, DOCTOR_COMMAND,
        SKILL_DIFF_COMMAND, SKILL_DISCOVER_COMMAND, SKILL_HISTORY_COMMAND, SKILL_LIST_COMMAND,
        SKILL_SHOW_COMMAND, STATUS_COMMAND,
    };
    use crate::{AgentDetectionSource, AgentInfo, AgentSkillsStatus};
    use git2::{IndexAddOption, Repository, Signature};
    use serde_json::Value;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    struct TestHome {
        path: PathBuf,
    }

    impl TestHome {
        fn new(label: &str, create: bool) -> Self {
            let path = std::env::temp_dir().join(format!(
                "skillhub-cli-local-{label}-{}",
                uuid::Uuid::new_v4()
            ));
            if create {
                fs::create_dir_all(&path).expect("create isolated test home");
            }
            Self { path }
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            if self.path.starts_with(std::env::temp_dir()) {
                let _ = fs::remove_dir_all(&self.path);
            }
        }
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    fn empty_context(home: &Path) -> LocalContext {
        LocalContext {
            home: home.to_path_buf(),
            agents: Vec::new(),
            agent_roots: Vec::new(),
        }
    }

    fn json_output(args: &[&str], context: &LocalContext) -> Value {
        let output =
            execute_local_cli_at(&strings(args), context).expect("recognized local command");
        serde_json::from_str(output.json()).expect("valid JSON envelope")
    }

    /// Sidecar identity written by import / account sync: a UUID, distinct
    /// from the managed directory name the CLI reports as `id`.
    const SAMPLE_SIDECAR_ID: &str = "7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a";

    fn sample_sidecar(id: &str) -> String {
        format!(
            r#"{{"version":"1","skillhub":{{"id":"{id}","name":"sample","displayName":"Sample Profile","description":"Safe metadata","labels":["fixture"],"version":"v1.2.3","envDependencies":[{{"key":"SAMPLE_API_KEY","required":true,"sharePolicy":"private","sharedTeams":[]}}]}}}}"#
        )
    }

    fn create_skill(home: &Path, id: &str) -> PathBuf {
        create_skill_with_sidecar(home, id, &sample_sidecar(SAMPLE_SIDECAR_ID))
    }

    fn create_skill_with_sidecar(home: &Path, id: &str, sidecar: &str) -> PathBuf {
        let root = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills")
            .join(id);
        fs::create_dir_all(&root).expect("create managed skill");
        fs::write(
            root.join("SKILL.md"),
            "---\nname: Sample Skill\ndescription: Local fixture\nversion: v1.2.3\n---\n# Sample\n",
        )
        .expect("write skill markdown");
        fs::write(root.join(".skillhub.json"), sidecar).expect("write skill profile");
        root
    }

    fn create_directory_link(source: &Path, link: &Path) {
        fs::create_dir_all(link.parent().expect("projection parent"))
            .expect("create projection parent");
        #[cfg(unix)]
        std::os::unix::fs::symlink(source, link).expect("create projection link");
        #[cfg(windows)]
        crate::platform_fs::unix_fs::symlink(source, link).expect("create projection junction");
    }

    fn snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
        fn visit(base: &Path, current: &Path, output: &mut BTreeMap<String, Vec<u8>>) {
            let Ok(mut entries) = fs::read_dir(current).map(|entries| {
                entries
                    .collect::<Result<Vec<_>, _>>()
                    .expect("read fixture directory")
            }) else {
                return;
            };
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                let path = entry.path();
                let relative = path
                    .strip_prefix(base)
                    .expect("fixture relative path")
                    .to_string_lossy()
                    .to_string();
                let metadata = fs::symlink_metadata(&path).expect("fixture metadata");
                if metadata.file_type().is_symlink() {
                    output.insert(
                        relative,
                        format!(
                            "link:{}",
                            fs::read_link(&path).expect("read fixture link").display()
                        )
                        .into_bytes(),
                    );
                } else if metadata.is_dir() {
                    output.insert(format!("{relative}/"), Vec::new());
                    visit(base, &path, output);
                } else if metadata.is_file() {
                    output.insert(relative, fs::read(path).expect("read fixture file"));
                }
            }
        }
        let mut output = BTreeMap::new();
        if root.is_dir() {
            visit(root, root, &mut output);
        }
        output
    }

    fn commit_all(root: &Path, message: &str) -> String {
        let repo = Repository::open(root).unwrap_or_else(|_| Repository::init(root).expect("init"));
        let mut index = repo.index().expect("index");
        index
            .add_all(["*"], IndexAddOption::DEFAULT, None)
            .expect("add files");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("tree");
        let signature = Signature::now("SkillHub Test", "skillhub-test@local").expect("signature");
        let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
        let parents = parent.iter().collect::<Vec<_>>();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parents,
        )
        .expect("commit")
        .to_string()
    }

    #[test]
    fn parsers_require_one_json_flag_and_preserve_legacy_edit_routing() {
        let home = TestHome::new("parser", false);
        let context = empty_context(&home.path);
        for (args, expected_command) in [
            (vec!["status"], STATUS_COMMAND),
            (vec!["doctor", "--json", "--json"], DOCTOR_COMMAND),
            (vec!["agent", "show", "--json"], AGENT_LIST_COMMAND),
            (vec!["skill", "list"], SKILL_LIST_COMMAND),
            (vec!["skill", "show", "--json"], SKILL_SHOW_COMMAND),
            (vec!["skill", "discover"], SKILL_DISCOVER_COMMAND),
            (vec!["skill", "history", "--json"], SKILL_HISTORY_COMMAND),
            (
                vec!["skill", "diff", "--skill-id", "sample", "--json"],
                SKILL_DIFF_COMMAND,
            ),
        ] {
            let value = json_output(&args, &context);
            assert_eq!(value["ok"], false);
            assert_eq!(value["command"], expected_command);
            assert_eq!(value["error"]["code"], "VALIDATION_FAILED");
        }
        assert!(
            execute_local_cli_at(&strings(&["skill", "prepare-edit", "--json"]), &context)
                .is_none()
        );
    }

    #[test]
    fn list_and_show_read_metadata_without_mutating_fixture() {
        let home = TestHome::new("list-show", true);
        let skill = create_skill(&home.path, "sample");
        fs::write(skill.join(".env"), "SECRET=do-not-print\n").expect("write private env fixture");
        fs::create_dir_all(skill.join("references")).expect("create references");
        fs::write(skill.join("references/guide.md"), "safe\n").expect("write guide");
        let context = empty_context(&home.path);
        let before = snapshot(&home.path);

        let list = json_output(&["skill", "list", "--query", "profile", "--json"], &context);
        assert_eq!(list["ok"], true);
        assert_eq!(list["data"]["count"], 1);
        assert_eq!(list["data"]["skills"][0]["displayName"], "Sample Profile");
        assert_eq!(
            list["data"]["skills"][0]["envDependencies"][0]["key"],
            "SAMPLE_API_KEY"
        );

        let show = json_output(
            &["skill", "show", "--skill-id", "sample", "--json"],
            &context,
        );
        assert_eq!(show["ok"], true);
        let rendered = serde_json::to_string(&show).expect("render show output");
        assert!(!rendered.contains("SECRET=do-not-print"));
        assert!(!show["data"]["tree"]
            .as_array()
            .expect("tree")
            .iter()
            .any(|entry| entry["path"] == ".env" || entry["path"] == ".skillhub.json"));
        assert_eq!(snapshot(&home.path), before);
    }

    #[test]
    fn list_and_show_report_only_owned_agent_projections_as_installed() {
        let home = TestHome::new("projection-state", true);
        let skill = create_skill(&home.path, "sample");
        let other = create_skill(&home.path, "other");
        let installed_link = home.path.join(".claude/skills/sample");
        let foreign_link = home.path.join(".codex/skills/sample");
        create_directory_link(&skill, &installed_link);
        create_directory_link(&other, &foreign_link);
        let context = LocalContext {
            home: home.path.clone(),
            agents: Vec::new(),
            agent_roots: vec![
                AgentRoot {
                    key: "workbuddy".into(),
                    name: "WorkBuddy".into(),
                    relative: PathBuf::from(".workbuddy-ai/skills"),
                },
                AgentRoot {
                    key: "codex".into(),
                    name: "ChatGPT".into(),
                    relative: PathBuf::from(".codex/skills"),
                },
                AgentRoot {
                    key: "claude".into(),
                    name: "Claude Code".into(),
                    relative: PathBuf::from(".claude/skills"),
                },
            ],
        };

        for output in [
            json_output(&["skill", "list", "--json"], &context),
            json_output(
                &["skill", "show", "--skill-id", "sample", "--json"],
                &context,
            ),
        ] {
            let skill = if output["command"] == SKILL_LIST_COMMAND {
                output["data"]["skills"]
                    .as_array()
                    .expect("Skill list")
                    .iter()
                    .find(|skill| skill["id"] == "sample")
                    .expect("sample Skill")
            } else {
                &output["data"]["skill"]
            };
            assert_eq!(skill["installedAgents"], serde_json::json!(["claude"]));
            assert_eq!(
                skill["agentStates"],
                serde_json::json!({
                    "claude": "installed",
                    "codex": "conflict",
                    "workbuddy": "notInstalled",
                })
            );
        }

        assert_eq!(
            fs::canonicalize(&installed_link).expect("resolve installed projection"),
            fs::canonicalize(&skill).expect("resolve managed Skill")
        );
        assert_eq!(
            fs::canonicalize(&foreign_link).expect("resolve foreign projection"),
            fs::canonicalize(&other).expect("resolve foreign Skill")
        );
    }

    /// `skill list` / `skill show` report the managed directory as `id` for
    /// both sidecar shapes; the UUID never leaks into the public identity.
    #[test]
    fn list_and_show_report_the_directory_id_for_uuid_and_legacy_sidecars() {
        let home = TestHome::new("directory-id-shapes", true);
        create_skill(&home.path, "uuid-skill");
        create_skill_with_sidecar(&home.path, "legacy-skill", &sample_sidecar("legacy-skill"));
        let context = LocalContext {
            home: home.path.clone(),
            agents: Vec::new(),
            agent_roots: Vec::new(),
        };
        let list = json_output(&["skill", "list", "--json"], &context);
        let ids = list["data"]["skills"]
            .as_array()
            .expect("Skill list")
            .iter()
            .map(|skill| skill["id"].as_str().expect("id").to_string())
            .collect::<std::collections::BTreeSet<_>>();
        assert!(
            ids.contains("uuid-skill") && ids.contains("legacy-skill"),
            "{ids:?}"
        );
        assert!(!list.to_string().contains(SAMPLE_SIDECAR_ID));
        for id in ["uuid-skill", "legacy-skill"] {
            let show = json_output(&["skill", "show", "--skill-id", id, "--json"], &context);
            assert_eq!(show["ok"], true, "{id}");
            assert_eq!(show["data"]["skill"]["id"], id);
            assert_eq!(show["data"]["skill"]["name"], "sample");
        }
    }

    #[test]
    fn unsafe_projection_name_reports_unknown_without_path_guessing() {
        let home = TestHome::new("unsafe-projection-name", true);
        let skill = create_skill(&home.path, "sample");
        fs::write(
            skill.join(".skillhub.json"),
            r#"{"version":"1","skillhub":{"id":"sample","name":"../outside","displayName":"Unsafe name","version":"v1.2.3"}}"#,
        )
        .expect("write unsafe projection name");
        fs::create_dir_all(home.path.join(".claude/outside"))
            .expect("create unrelated Agent directory");
        let context = LocalContext {
            home: home.path.clone(),
            agents: Vec::new(),
            agent_roots: vec![AgentRoot {
                key: "claude".into(),
                name: "Claude Code".into(),
                relative: PathBuf::from(".claude/skills"),
            }],
        };

        let output = json_output(
            &["skill", "show", "--skill-id", "sample", "--json"],
            &context,
        );
        assert_eq!(
            output["data"]["skill"]["installedAgents"],
            serde_json::json!([])
        );
        assert_eq!(output["data"]["skill"]["agentStates"]["claude"], "unknown");
        assert!(output["warnings"][0]
            .as_str()
            .expect("projection warning")
            .contains("投影名无效"));
    }

    #[test]
    fn discover_reads_only_detected_agent_roots_and_skips_managed_links() {
        let home = TestHome::new("discover", true);
        let _managed = create_skill(&home.path, "managed");
        let agent_root = home.path.join(".claude/skills");
        let native = agent_root.join("native");
        fs::create_dir_all(&native).expect("create native skill");
        fs::write(
            native.join("SKILL.md"),
            "---\nname: Native Skill\nversion: v0.4.0\n---\n",
        )
        .expect("write native skill");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&_managed, agent_root.join("managed"))
            .expect("link managed projection");
        let context = LocalContext {
            home: home.path.clone(),
            agents: vec![AgentInfo {
                key: "claude".into(),
                name: "Claude Code".into(),
                dir: "~/.claude/skills".into(),
                detected: true,
                detection_source: AgentDetectionSource::Cli,
                skills_status: AgentSkillsStatus::Ready,
                detection_state: crate::AgentDetectionState::Detected,
                detection_issues: Vec::new(),
            }],
            agent_roots: vec![AgentRoot {
                key: "claude".into(),
                name: "Claude Code".into(),
                relative: PathBuf::from(".claude/skills"),
            }],
        };
        let before = snapshot(&home.path);
        let output = json_output(
            &["skill", "discover", "--agent", "claude", "--json"],
            &context,
        );
        assert_eq!(output["ok"], true);
        assert_eq!(output["data"]["count"], 1);
        assert_eq!(output["data"]["skills"][0]["id"], "native");
        assert_eq!(snapshot(&home.path), before);
    }

    #[test]
    fn discover_reads_one_grouping_level_read_only() {
        let home = TestHome::new("discover-group", true);
        let agent_root = home.path.join(".claude/skills");
        for (relative, body) in [
            ("top/SKILL.md", "# Top\n"),
            (
                "writing/blog-post/SKILL.md",
                "---\nname: blog-post\ndescription: >\n  Drafts posts\n  quickly.\n---\n",
            ),
            ("writing/notes.txt", "not a skill\n"),
            ("writing/drafts/readme.md", "no SKILL.md here\n"),
            ("writing/deep/nested/SKILL.md", "# Too deep\n"),
        ] {
            let path = agent_root.join(relative);
            fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture");
            fs::write(path, body).expect("write fixture");
        }
        let context = LocalContext {
            home: home.path.clone(),
            agents: vec![AgentInfo {
                key: "claude".into(),
                name: "Claude Code".into(),
                dir: "~/.claude/skills".into(),
                detected: true,
                detection_source: AgentDetectionSource::Cli,
                skills_status: AgentSkillsStatus::Ready,
                detection_state: crate::AgentDetectionState::Detected,
                detection_issues: Vec::new(),
            }],
            agent_roots: vec![AgentRoot {
                key: "claude".into(),
                name: "Claude Code".into(),
                relative: PathBuf::from(".claude/skills"),
            }],
        };
        let before = snapshot(&home.path);
        let output = json_output(&["skill", "discover", "--json"], &context);
        assert_eq!(output["ok"], true);
        assert_eq!(output["data"]["count"], 2);
        let skills = output["data"]["skills"].as_array().expect("skills array");
        let grouped = skills
            .iter()
            .find(|skill| skill["id"] == "blog-post")
            .expect("grouped Skill");
        assert_eq!(grouped["description"], "Drafts posts quickly.");
        assert_eq!(grouped["sources"][0]["group"], "writing");
        assert_eq!(grouped["sources"][0]["entryName"], "blog-post");
        let top = skills
            .iter()
            .find(|skill| skill["id"] == "top")
            .expect("top-level Skill");
        assert!(top["sources"][0].get("group").is_none());
        assert_eq!(snapshot(&home.path), before);
    }

    #[test]
    fn offline_history_pending_status_matches_only_the_current_content_and_is_read_only() {
        let home = TestHome::new("offline-history", true);
        let skill = create_skill(&home.path, "sample");
        let _lock = crate::skill_lock::lock_skill_dir_at(
            &home
                .path
                .join(if crate::official_channel::CHANNEL == "dev" {
                    ".skillhub-dev"
                } else {
                    ".skillhub"
                }),
            "sample",
        )
        .unwrap();
        let mut profile = crate::commands::library_read_profile_readonly(&skill).unwrap();
        crate::commands::save_snapshot_with_version_at(
            &skill,
            &mut profile,
            "older",
            None,
            Some("auto"),
        )
        .unwrap();
        let old = crate::version_policy::head(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "# Newer content\n").unwrap();
        crate::commands::save_snapshot_with_version_at(
            &skill,
            &mut profile,
            "newer",
            None,
            Some("auto"),
        )
        .unwrap();
        let latest = crate::version_policy::head(&skill).unwrap();
        profile.version_metadata.account_id = crate::runtime_env::active_runtime_user_id();
        crate::commands::library_write_profile(&skill, &profile).unwrap();
        let context = empty_context(&home.path);
        let before = snapshot(&home.path);
        let history = json_output(
            &["skill", "history", "--skill-id", "sample", "--json"],
            &context,
        );
        let rows = history["data"]["versions"].as_array().unwrap();
        assert_eq!(
            rows.iter().find(|v| v["hash"] == old).unwrap()["versionStatus"],
            "local"
        );
        assert_eq!(
            rows.iter().find(|v| v["hash"] == latest).unwrap()["versionStatus"],
            "pending"
        );
        assert_eq!(snapshot(&home.path), before);
        fs::write(skill.join("SKILL.md"), "# Unsaved further edit\n").unwrap();
        let history = json_output(
            &["skill", "history", "--skill-id", "sample", "--json"],
            &context,
        );
        assert!(history["data"]["versions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["versionStatus"] == "local"));
        let before = snapshot(&home.path);
        let list = json_output(&["skill", "list", "--json"], &context);
        let listed = &list["data"]["skills"][0];
        assert_eq!(listed["version"], "0.1.1");
        assert_eq!(listed["versionStatus"], "local");
        assert_eq!(listed["hasWorkingCopy"], true);
        assert!(listed["versionReceiptId"].is_null());
        assert!(listed["versionProblem"].is_null());
        assert_eq!(snapshot(&home.path), before);
    }

    #[test]
    fn history_and_working_diff_are_bounded_read_only_and_hide_env_values() {
        let home = TestHome::new("git", true);
        let skill = create_skill(&home.path, "sample");
        let first_hash = commit_all(&skill, "v1.2.3\nInitial snapshot");
        fs::write(skill.join("SKILL.md"), "# Changed\nSafe content\n")
            .expect("modify working copy");
        fs::write(skill.join(".env"), "SECRET=never-render\n").expect("write secret fixture");
        let context = empty_context(&home.path);
        let before = snapshot(&home.path);

        let history = json_output(
            &["skill", "history", "--skill-id", "sample", "--json"],
            &context,
        );
        assert_eq!(history["ok"], true);
        assert_eq!(history["data"]["versions"][0]["hash"], first_hash);

        let diff = json_output(
            &[
                "skill",
                "diff",
                "--skill-id",
                "sample",
                "--working",
                "--json",
            ],
            &context,
        );
        assert_eq!(diff["ok"], true);
        let rendered = serde_json::to_string(&diff).expect("render diff");
        assert!(rendered.contains("Safe content"));
        assert!(!rendered.contains("never-render"));
        assert_eq!(snapshot(&home.path), before);
    }

    #[test]
    fn commit_diff_uses_full_hashes_without_changing_repository() {
        let home = TestHome::new("commit-diff", true);
        let skill = create_skill(&home.path, "sample");
        let first = commit_all(&skill, "v1");
        fs::write(skill.join("SKILL.md"), "# Second\n").expect("modify skill");
        let second = commit_all(&skill, "v2");
        let context = empty_context(&home.path);
        let before = snapshot(&home.path);
        let output = json_output(
            &[
                "skill",
                "diff",
                "--skill-id",
                "sample",
                "--from",
                &first,
                "--to",
                &second,
                "--json",
            ],
            &context,
        );
        assert_eq!(output["ok"], true);
        assert_eq!(output["data"]["mode"], "commits");
        assert!(output["data"]["lineCount"].as_u64().unwrap_or(0) > 0);
        assert_eq!(snapshot(&home.path), before);
    }

    #[test]
    fn doctor_does_not_create_a_missing_home() {
        let home = TestHome::new("doctor", false);
        let context = empty_context(&home.path);
        let output = json_output(&["doctor", "--json"], &context);
        assert_eq!(output["ok"], true);
        assert_eq!(output["data"]["healthy"], false);
        assert_eq!(output["data"]["repairAttempted"], false);
        assert!(!home.path.exists());
    }
}
