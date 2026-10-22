use crate::cli::{
    CliAccount, CliAccountState, CliCommandOutput, CliErrorCode, EXIT_CONFLICT, EXIT_INTERNAL,
    EXIT_USAGE,
};
use crate::ImportSkillPreflight;
use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;

const IMPORT_PREFLIGHT_COMMAND: &str = "skill import preflight";
const IMPORT_APPLY_COMMAND: &str = "skill import apply";
const INSTALL_PREFLIGHT_COMMAND: &str = "skill install preflight";
const INSTALL_APPLY_COMMAND: &str = "skill install apply";
const SNAPSHOT_COMMAND: &str = "skill snapshot";

pub(crate) const MUTATION_USAGE: &str = concat!(
    "用法：\n",
    "  skillhub skill import preflight --path <path> [--skill-id <id>] --json\n",
    "  skillhub skill import apply --path <path> [--skill-id <id>] --plan-digest <digest> [--replace-conflicts] --json\n",
    "  skillhub skill install preflight --skill-id <id> --agent <key> [--agent <key> ...] --json\n",
    "  skillhub skill install apply --skill-id <id> --agent <key> [--agent <key> ...] --plan-digest <digest> [--replace-conflicts] --json\n",
    "  skillhub skill snapshot --skill-id <id> --message <text> [--version <0.1.1>] --json"
);

#[derive(Debug, PartialEq, Eq)]
enum MutationCommand {
    ImportPreflight {
        path: String,
        skill_id: Option<String>,
    },
    ImportApply {
        path: String,
        skill_id: Option<String>,
        plan_digest: String,
        replace_conflicts: bool,
    },
    InstallPreflight {
        skill_id: String,
        agents: Vec<String>,
    },
    InstallApply {
        skill_id: String,
        agents: Vec<String>,
        plan_digest: String,
        replace_conflicts: bool,
    },
    Snapshot {
        skill_id: String,
        message: String,
        version: Option<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SafePlanTarget<'a> {
    agent_key: &'a str,
    agent_name: &'a str,
    entry_name: &'a str,
    matches_selected: bool,
    selected: bool,
}

fn local_account() -> CliAccount {
    CliAccount::state(CliAccountState::Unknown)
}

pub(crate) fn is_mutation_command(args: &[String]) -> bool {
    args.first().map(String::as_str) == Some("skill")
        && matches!(
            args.get(1).map(String::as_str),
            Some("import" | "install" | "snapshot")
        )
}

pub(crate) async fn execute_mutation_cli(args: &[String]) -> Option<CliCommandOutput> {
    if !is_mutation_command(args) {
        return None;
    }
    let parsed = match parse_command(args) {
        Ok(parsed) => parsed,
        Err(command) => return Some(usage_failure(command)),
    };
    Some(match parsed {
        MutationCommand::ImportPreflight { path, skill_id } => {
            match crate::commands::preflight_import_skill(path, skill_id).await {
                Ok(plan) => preflight_success(IMPORT_PREFLIGHT_COMMAND, &plan, None),
                Err(error) => safe_command_failure(IMPORT_PREFLIGHT_COMMAND, &error),
            }
        }
        MutationCommand::ImportApply {
            path,
            skill_id,
            plan_digest,
            replace_conflicts,
        } => match crate::commands::import_skill(
            path,
            skill_id,
            Some(replace_conflicts),
            Some(plan_digest),
        )
        .await
        {
            Ok(skill) => CliCommandOutput::success(
                IMPORT_APPLY_COMMAND,
                local_account(),
                json!({
                    "applied": true,
                    "skill": {
                        "id": skill.id,
                        "name": skill.name,
                        "displayName": skill.display_name,
                        "version": skill.version,
                        "isOwn": skill.is_own,
                        "acquisitionSource": skill.acquisition_source,
                    },
                    "conflictsReplaced": replace_conflicts,
                }),
                Vec::new(),
                vec!["使用 skillhub skill show --skill-id <id> --json 复核导入结果".into()],
            ),
            Err(error) => safe_command_failure(IMPORT_APPLY_COMMAND, &error),
        },
        MutationCommand::InstallPreflight { skill_id, agents } => {
            match crate::commands::preflight_install_skill(skill_id, agents.clone()).await {
                Ok(plan) => preflight_success(INSTALL_PREFLIGHT_COMMAND, &plan, Some(&agents)),
                Err(error) => safe_command_failure(INSTALL_PREFLIGHT_COMMAND, &error),
            }
        }
        MutationCommand::InstallApply {
            skill_id,
            agents,
            plan_digest,
            replace_conflicts,
        } => match crate::commands::install_skill(
            skill_id.clone(),
            agents.clone(),
            Some(replace_conflicts),
            Some(plan_digest),
        )
        .await
        {
            Ok(()) => CliCommandOutput::success(
                INSTALL_APPLY_COMMAND,
                local_account(),
                json!({
                    "applied": true,
                    "skillId": skill_id,
                    "agents": agents,
                    "conflictsReplaced": replace_conflicts,
                }),
                Vec::new(),
                vec!["请在目标 Agent 中复核 Skill 是否可用".into()],
            ),
            Err(error) => safe_command_failure(INSTALL_APPLY_COMMAND, &error),
        },
        MutationCommand::Snapshot {
            skill_id,
            message,
            version,
        } => {
            let result = tauri::async_runtime::spawn_blocking({
                let skill_id = skill_id.clone();
                move || {
                    crate::commands::create_skill_snapshot_with_version(
                        skill_id, message, version, None,
                    )
                }
            })
            .await;
            match result {
                Ok(Ok(())) => CliCommandOutput::success(
                    SNAPSHOT_COMMAND,
                    local_account(),
                    json!({ "created": true, "skillId": skill_id }),
                    Vec::new(),
                    vec![format!(
                        "使用 skillhub skill history --skill-id {skill_id} --json 复核新版本"
                    )],
                ),
                Ok(Err(error)) => safe_command_failure(SNAPSHOT_COMMAND, &error),
                Err(_) => CliCommandOutput::failure(
                    SNAPSHOT_COMMAND,
                    local_account(),
                    CliErrorCode::OperationOutcomeUnknown,
                    "本地版本任务异常结束，结果需要复核，不能自动重试",
                    EXIT_INTERNAL,
                    vec![format!(
                        "先使用 skillhub skill history --skill-id {skill_id} --json 检查是否已创建版本"
                    )],
                ),
            }
        }
    })
}

fn parse_command(args: &[String]) -> Result<MutationCommand, &'static str> {
    match args.get(1).map(String::as_str) {
        Some("import") => parse_import(args),
        Some("install") => parse_install(args),
        Some("snapshot") => parse_snapshot(args),
        _ => Err(IMPORT_PREFLIGHT_COMMAND),
    }
}

fn parse_import(args: &[String]) -> Result<MutationCommand, &'static str> {
    let action = args.get(2).map(String::as_str);
    let command = match action {
        Some("preflight") => IMPORT_PREFLIGHT_COMMAND,
        Some("apply") => IMPORT_APPLY_COMMAND,
        _ => return Err(IMPORT_PREFLIGHT_COMMAND),
    };
    let mut path = None;
    let mut skill_id = None;
    let mut plan_digest = None;
    let mut replace_conflicts = false;
    let mut json_seen = false;
    let mut index = 3;
    while index < args.len() {
        match args[index].as_str() {
            "--json" if !json_seen => {
                json_seen = true;
                index += 1;
            }
            "--replace-conflicts" if action == Some("apply") && !replace_conflicts => {
                replace_conflicts = true;
                index += 1;
            }
            "--path" if path.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                path = Some(parse_path(value).ok_or(command)?);
                index += 2;
            }
            "--skill-id" if skill_id.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                if !valid_skill_id(value) {
                    return Err(command);
                }
                skill_id = Some(value.clone());
                index += 2;
            }
            "--plan-digest" if action == Some("apply") && plan_digest.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                plan_digest = Some(parse_plan_digest(value).ok_or(command)?);
                index += 2;
            }
            _ => return Err(command),
        }
    }
    let path = path.ok_or(command)?;
    if !json_seen {
        return Err(command);
    }
    match action {
        Some("preflight") if plan_digest.is_none() && !replace_conflicts => {
            Ok(MutationCommand::ImportPreflight { path, skill_id })
        }
        Some("apply") => Ok(MutationCommand::ImportApply {
            path,
            skill_id,
            plan_digest: plan_digest.ok_or(command)?,
            replace_conflicts,
        }),
        _ => Err(command),
    }
}

fn parse_install(args: &[String]) -> Result<MutationCommand, &'static str> {
    let action = args.get(2).map(String::as_str);
    let command = match action {
        Some("preflight") => INSTALL_PREFLIGHT_COMMAND,
        Some("apply") => INSTALL_APPLY_COMMAND,
        _ => return Err(INSTALL_PREFLIGHT_COMMAND),
    };
    let mut skill_id = None;
    let mut agents = Vec::new();
    let mut seen_agents = HashSet::new();
    let mut plan_digest = None;
    let mut replace_conflicts = false;
    let mut json_seen = false;
    let mut index = 3;
    while index < args.len() {
        match args[index].as_str() {
            "--json" if !json_seen => {
                json_seen = true;
                index += 1;
            }
            "--replace-conflicts" if action == Some("apply") && !replace_conflicts => {
                replace_conflicts = true;
                index += 1;
            }
            "--skill-id" if skill_id.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                if !valid_skill_id(value) {
                    return Err(command);
                }
                skill_id = Some(value.clone());
                index += 2;
            }
            "--agent" => {
                let value = args.get(index + 1).ok_or(command)?;
                if !valid_agent_key(value) || !seen_agents.insert(value.clone()) {
                    return Err(command);
                }
                agents.push(value.clone());
                index += 2;
            }
            "--plan-digest" if action == Some("apply") && plan_digest.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                plan_digest = Some(parse_plan_digest(value).ok_or(command)?);
                index += 2;
            }
            _ => return Err(command),
        }
    }
    let skill_id = skill_id.ok_or(command)?;
    if agents.is_empty() || !json_seen {
        return Err(command);
    }
    match action {
        Some("preflight") if plan_digest.is_none() && !replace_conflicts => {
            Ok(MutationCommand::InstallPreflight { skill_id, agents })
        }
        Some("apply") => Ok(MutationCommand::InstallApply {
            skill_id,
            agents,
            plan_digest: plan_digest.ok_or(command)?,
            replace_conflicts,
        }),
        _ => Err(command),
    }
}

fn parse_snapshot(args: &[String]) -> Result<MutationCommand, &'static str> {
    let mut skill_id = None;
    let mut message = None;
    let mut version = None;
    let mut json_seen = false;
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--json" if !json_seen => {
                json_seen = true;
                index += 1;
            }
            "--skill-id" if skill_id.is_none() => {
                let value = args.get(index + 1).ok_or(SNAPSHOT_COMMAND)?;
                if !valid_skill_id(value) {
                    return Err(SNAPSHOT_COMMAND);
                }
                skill_id = Some(value.clone());
                index += 2;
            }
            "--message" if message.is_none() => {
                let value = args.get(index + 1).ok_or(SNAPSHOT_COMMAND)?;
                message = Some(parse_snapshot_message(value).ok_or(SNAPSHOT_COMMAND)?);
                index += 2;
            }
            "--version" if version.is_none() => {
                let value = args.get(index + 1).ok_or(SNAPSHOT_COMMAND)?;
                if crate::version_policy::ordinal(value).is_none() {
                    return Err(SNAPSHOT_COMMAND);
                }
                version = Some(value.clone());
                index += 2;
            }
            _ => return Err(SNAPSHOT_COMMAND),
        }
    }
    match (skill_id, message, json_seen) {
        (Some(skill_id), Some(message), true) => Ok(MutationCommand::Snapshot {
            skill_id,
            message,
            version,
        }),
        _ => Err(SNAPSHOT_COMMAND),
    }
}

fn parse_path(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > 4_096
        || value.chars().any(char::is_control)
        || value == "."
        || value == ".."
    {
        None
    } else {
        Some(value.to_string())
    }
}

fn valid_skill_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && value != "."
        && value != ".."
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_agent_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn parse_plan_digest(value: &str) -> Option<String> {
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

fn parse_snapshot_message(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 500 || value.contains('\0') {
        None
    } else {
        Some(value.to_string())
    }
}

fn preflight_success(
    command: &'static str,
    plan: &ImportSkillPreflight,
    requested_agents: Option<&[String]>,
) -> CliCommandOutput {
    let targets = plan
        .sources
        .iter()
        .map(|source| SafePlanTarget {
            agent_key: &source.agent_key,
            agent_name: &source.agent_name,
            entry_name: &source.entry_name,
            matches_selected: source.matches_selected,
            selected: source.selected,
        })
        .collect::<Vec<_>>();
    let mut warnings = Vec::new();
    if plan.has_conflicts {
        warnings.push("检测到内容不同的同名 Skill；只有明确同意替换时才能执行".into());
    } else if !plan.sources.is_empty() {
        warnings.push("检测到同名 Agent Skill；执行时会按现有安全收编流程处理".into());
    }
    CliCommandOutput::success(
        command,
        local_account(),
        json!({
            "skillId": plan.skill_id,
            "planDigest": plan.plan_digest,
            "hasConflicts": plan.has_conflicts,
            "replaceConflictsRequired": plan.has_conflicts,
            "requestedAgents": requested_agents.unwrap_or_default(),
            "targetCount": targets.len(),
            "targets": targets,
            "requiresExplicitApply": true,
        }),
        warnings,
        vec![if plan.has_conflicts {
            "向用户展示冲突；确认替换后执行 apply，并原样传入 planDigest 与 --replace-conflicts"
                .into()
        } else {
            "确认计划后执行 apply，并原样传入 planDigest".into()
        }],
    )
}

fn usage_failure(command: &'static str) -> CliCommandOutput {
    CliCommandOutput::failure(
        command,
        local_account(),
        CliErrorCode::ValidationFailed,
        MUTATION_USAGE,
        EXIT_USAGE,
        Vec::new(),
    )
}

fn safe_command_failure(command: &'static str, private_error: &str) -> CliCommandOutput {
    let lowercase = private_error.to_ascii_lowercase();
    if lowercase.contains("任务异常结束")
        || lowercase.contains("task") && lowercase.contains("join")
    {
        if matches!(
            command,
            IMPORT_APPLY_COMMAND | INSTALL_APPLY_COMMAND | SNAPSHOT_COMMAND
        ) {
            return CliCommandOutput::failure(
                command,
                local_account(),
                CliErrorCode::OperationOutcomeUnknown,
                "本地 Skill 任务异常结束，结果需要复核，不能自动重试",
                EXIT_INTERNAL,
                verification_actions(command),
            );
        }
        return internal_failure(
            command,
            "本地 Skill 预检任务异常结束，没有执行变更",
            verification_actions(command),
        );
    }
    let (code, message, exit_code) = if lowercase.contains("permission denied")
        || lowercase.contains("权限")
        || lowercase.contains("permission")
    {
        (
            CliErrorCode::PermissionDenied,
            "当前用户没有完成此本地 Skill 操作所需的文件权限",
            EXIT_INTERNAL,
        )
    } else if lowercase.contains("not found") || private_error.contains("不存在") {
        (
            CliErrorCode::NotFound,
            "目标 Skill、导入来源或 Agent 在执行时已不存在",
            EXIT_USAGE,
        )
    } else if private_error.starts_with("SKILL.md 中 metadata.skillhub.env 声明无效") {
        // Our own message: it names only validated keys and the violated rule.
        return CliCommandOutput::failure(
            command,
            local_account(),
            CliErrorCode::ValidationFailed,
            private_error,
            EXIT_USAGE,
            Vec::new(),
        );
    } else if private_error.contains("受保护的系统 Skill") {
        (
            CliErrorCode::ValidationFailed,
            "系统 SkillHub Manager 不能作为普通 Skill 再导入",
            EXIT_USAGE,
        )
    } else if private_error.contains("确认后发生变化")
        || private_error.contains("尚未确认")
        || private_error.contains("重新确认")
    {
        (
            CliErrorCode::PlanStale,
            "预检计划已失效或与当前状态不一致；本次没有获得继续执行的授权",
            EXIT_CONFLICT,
        )
    } else if private_error.contains("同名") || private_error.contains("冲突") {
        (
            CliErrorCode::Conflict,
            "检测到未经明确授权的同名 Skill 冲突；本次操作已停止",
            EXIT_CONFLICT,
        )
    } else {
        (
            CliErrorCode::ValidationFailed,
            match command {
                IMPORT_PREFLIGHT_COMMAND => {
                    "无法完成导入预检；请确认来源存在、包含安全的 SKILL.md 且格式受支持"
                }
                IMPORT_APPLY_COMMAND => {
                    "Skill 导入未完成；来源内容、冲突状态或 planDigest 可能已经变化"
                }
                INSTALL_PREFLIGHT_COMMAND => {
                    "无法完成安装预检；请确认本地 Skill 与所选 Agent 当前可用"
                }
                INSTALL_APPLY_COMMAND => {
                    "Skill 安装未完成；Agent 状态、冲突状态或 planDigest 可能已经变化"
                }
                SNAPSHOT_COMMAND => {
                    "无法创建本地版本；请确认 Skill 存在、不是系统 Skill，且版本说明有效"
                }
                _ => "本地 Skill 操作未完成",
            },
            EXIT_USAGE,
        )
    };
    CliCommandOutput::failure(
        command,
        local_account(),
        code,
        message,
        exit_code,
        verification_actions(command),
    )
}

fn internal_failure(
    command: &'static str,
    message: &'static str,
    next_actions: Vec<String>,
) -> CliCommandOutput {
    CliCommandOutput::failure(
        command,
        local_account(),
        CliErrorCode::InternalError,
        message,
        EXIT_INTERNAL,
        next_actions,
    )
}

fn verification_actions(command: &'static str) -> Vec<String> {
    match command {
        IMPORT_PREFLIGHT_COMMAND | INSTALL_PREFLIGHT_COMMAND => {
            vec!["检查输入后重新运行 preflight".into()]
        }
        IMPORT_APPLY_COMMAND => vec![
            "先使用 skillhub skill list --json 复核是否已导入；不要直接重试 apply".into(),
            "需要重试时重新运行 preflight 并使用新的 planDigest".into(),
        ],
        INSTALL_APPLY_COMMAND => vec![
            "先在目标 Agent 中复核安装状态；不要直接重试 apply".into(),
            "需要重试时重新运行 preflight 并使用新的 planDigest".into(),
        ],
        SNAPSHOT_COMMAND => vec![
            "先使用 skillhub skill history --skill-id <id> --json 复核是否已创建版本；不要直接重试"
                .into(),
        ],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        execute_mutation_cli, parse_command, preflight_success, safe_command_failure,
        ImportSkillPreflight, MutationCommand, IMPORT_APPLY_COMMAND, INSTALL_APPLY_COMMAND,
        INSTALL_PREFLIGHT_COMMAND,
    };
    use crate::ImportSkillSource;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    fn digest() -> &'static str {
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }

    #[test]
    fn import_apply_requires_json_and_plan_digest() {
        assert!(parse_command(&strings(&[
            "skill",
            "import",
            "apply",
            "--path",
            "/tmp/example",
            "--json",
        ]))
        .is_err());
        assert_eq!(
            parse_command(&strings(&[
                "skill",
                "import",
                "apply",
                "--path",
                "/tmp/example",
                "--skill-id",
                "example",
                "--plan-digest",
                digest(),
                "--replace-conflicts",
                "--json",
            ])),
            Ok(MutationCommand::ImportApply {
                path: "/tmp/example".into(),
                skill_id: Some("example".into()),
                plan_digest: digest().into(),
                replace_conflicts: true,
            })
        );
    }

    #[test]
    fn install_preflight_and_apply_require_agents_without_duplicates() {
        assert_eq!(
            parse_command(&strings(&[
                "skill",
                "install",
                "preflight",
                "--skill-id",
                "example",
                "--agent",
                "claude",
                "--agent",
                "codex",
                "--json",
            ])),
            Ok(MutationCommand::InstallPreflight {
                skill_id: "example".into(),
                agents: vec!["claude".into(), "codex".into()],
            })
        );
        assert!(parse_command(&strings(&[
            "skill",
            "install",
            "preflight",
            "--skill-id",
            "example",
            "--agent",
            "claude",
            "--agent",
            "claude",
            "--json",
        ]))
        .is_err());
        assert!(parse_command(&strings(&[
            "skill",
            "install",
            "apply",
            "--skill-id",
            "example",
            "--agent",
            "claude",
            "--json",
        ]))
        .is_err());
    }

    #[test]
    fn preflight_rejects_apply_only_flags() {
        assert!(parse_command(&strings(&[
            "skill",
            "install",
            "preflight",
            "--skill-id",
            "example",
            "--agent",
            "claude",
            "--replace-conflicts",
            "--json",
        ]))
        .is_err());
        assert!(parse_command(&strings(&[
            "skill",
            "import",
            "preflight",
            "--path",
            "/tmp/example",
            "--plan-digest",
            digest(),
            "--json",
        ]))
        .is_err());
    }

    #[test]
    fn snapshot_rejects_missing_or_oversized_messages() {
        assert!(parse_command(&strings(&[
            "skill",
            "snapshot",
            "--skill-id",
            "example",
            "--json",
        ]))
        .is_err());
        let oversized = "x".repeat(501);
        assert!(parse_command(&[
            "skill".into(),
            "snapshot".into(),
            "--skill-id".into(),
            "example".into(),
            "--message".into(),
            oversized,
            "--json".into(),
        ])
        .is_err());
    }

    #[test]
    fn safe_failures_never_echo_private_errors() {
        for (command, error) in [
            (
                IMPORT_APPLY_COMMAND,
                "Path not found: /Users/person/private/sk-secret-token",
            ),
            (
                INSTALL_APPLY_COMMAND,
                "无法检查 /Users/person/.claude/skills/private: permission denied",
            ),
        ] {
            let output = safe_command_failure(command, error);
            assert!(!output.json().contains("/Users/person"));
            assert!(!output.json().contains("sk-secret-token"));
        }
    }

    #[test]
    fn preflight_json_omits_private_paths_and_raw_fingerprints() {
        let plan = ImportSkillPreflight {
            skill_id: "example".into(),
            selected_path: "/Users/person/private/example".into(),
            selected_fingerprint: "private-selected-fingerprint".into(),
            sources: vec![ImportSkillSource {
                agent_key: "claude".into(),
                agent_name: "Claude Code".into(),
                entry_name: "example".into(),
                path: "/Users/person/.claude/skills/example".into(),
                canonical_path: "/Users/person/private/example".into(),
                fingerprint: "private-source-fingerprint".into(),
                matches_selected: false,
                selected: true,
            }],
            has_conflicts: true,
            plan_digest: digest().into(),
        };
        let output = preflight_success(
            INSTALL_PREFLIGHT_COMMAND,
            &plan,
            Some(&["claude".to_string()]),
        );
        assert!(output.json().contains(digest()));
        assert!(output.json().contains("requestedAgents"));
        assert!(output.json().contains("claude"));
        assert!(!output.json().contains("/Users/person"));
        assert!(!output.json().contains("private-selected-fingerprint"));
        assert!(!output.json().contains("private-source-fingerprint"));
    }

    #[tokio::test]
    async fn unrelated_skill_commands_are_not_claimed() {
        assert!(execute_mutation_cli(&strings(&["skill", "list", "--json"]))
            .await
            .is_none());
    }
}
