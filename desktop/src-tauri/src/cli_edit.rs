use crate::cli::{
    CliAccount, CliAccountState, CliCommandOutput, CliErrorCode, EXIT_CONFLICT, EXIT_INTERNAL,
    EXIT_USAGE,
};
use serde::{Deserialize, Serialize};

const PREPARE_COMMAND: &str = "skill prepare-edit";
const FINISH_COMMAND: &str = "skill finish-edit";
const MAX_LEGACY_OUTPUT_BYTES: usize = 32 * 1024;
const MAX_PATH_BYTES: usize = 4_096;

pub(crate) const EDIT_USAGE: &str = concat!(
    "用法：\n",
    "  skillhub skill prepare-edit (--skill-id <id> | --skill-path <SKILL.md>) --json\n",
    "  skillhub skill finish-edit <session-id> --json"
);

#[derive(Debug, PartialEq, Eq)]
enum EditCommand {
    Prepare { target: EditTarget },
    Finish { session_id: String },
}

#[derive(Debug, PartialEq, Eq)]
enum EditTarget {
    SkillId(String),
    SkillPath(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyPrepareOutput {
    session_id: String,
    skill_id: String,
    working_copy_path: String,
    #[serde(rename = "projectionPath")]
    _projection_path: String,
    finish_command: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicPrepareOutput {
    session_id: String,
    skill_id: String,
    working_copy_path: String,
    finish_command: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyFinishOutput {
    session_id: String,
    skill_id: String,
    changed: bool,
    promoted_to_personal: bool,
    version: String,
    #[serde(rename = "workingCopyPath")]
    _working_copy_path: String,
    #[serde(rename = "projectionPath")]
    _projection_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicFinishOutput {
    session_id: String,
    skill_id: String,
    changed: bool,
    promoted_to_personal: bool,
    version: String,
}

fn local_account() -> CliAccount {
    CliAccount::state(CliAccountState::Unknown)
}

pub(crate) fn is_edit_command(args: &[String]) -> bool {
    args.first().map(String::as_str) == Some("skill")
        && matches!(
            args.get(1).map(String::as_str),
            Some("prepare-edit" | "finish-edit")
        )
}

pub(crate) fn execute_edit_cli(args: &[String]) -> Option<CliCommandOutput> {
    if !is_edit_command(args) {
        return None;
    }
    let parsed = match parse_edit_command(args) {
        Ok(parsed) => parsed,
        Err(command) => return Some(usage_failure(command)),
    };
    let command_name = parsed.command_name();
    let canonical_args = parsed.canonical_args();
    let legacy_result = match crate::commands::execute_skill_management_cli(&canonical_args) {
        Some(result) => result,
        None => {
            return Some(internal_failure(
                command_name,
                "Skill 编辑命令未能进入本地编辑服务",
                Vec::new(),
            ))
        }
    };

    Some(match (parsed, legacy_result) {
        (EditCommand::Prepare { .. }, Ok(raw)) => match parse_prepare_output(&raw) {
            Ok(output) => CliCommandOutput::success(
                PREPARE_COMMAND,
                local_account(),
                serde_json::to_value(output).unwrap_or_default(),
                Vec::new(),
                vec!["只编辑 workingCopyPath；完成后执行 finishCommand".into()],
            ),
            Err(()) => outcome_unknown(
                PREPARE_COMMAND,
                "编辑会话可能已建立，但本机返回了不兼容的结果；不要开始编辑",
                vec!["请打开 SkillHub APP 检查本地 Skill 状态后重新开始编辑".into()],
            ),
        },
        (EditCommand::Prepare { .. }, Err(error)) => prepare_failure(&error),
        (EditCommand::Finish { session_id }, Ok(raw)) => {
            match parse_finish_output(&raw, &session_id) {
                Ok(output) => {
                    let skill_id = output.skill_id.clone();
                    CliCommandOutput::success(
                        FINISH_COMMAND,
                        local_account(),
                        serde_json::to_value(output).unwrap_or_default(),
                        Vec::new(),
                        vec![format!(
                            "使用 skillhub skill history --skill-id {skill_id} --json 复核版本历史"
                        )],
                    )
                }
                Err(()) => finish_outcome_unknown(None),
            }
        }
        (EditCommand::Finish { session_id }, Err(error)) => finish_failure(&error, &session_id),
    })
}

impl EditCommand {
    fn command_name(&self) -> &'static str {
        match self {
            Self::Prepare { .. } => PREPARE_COMMAND,
            Self::Finish { .. } => FINISH_COMMAND,
        }
    }

    fn canonical_args(&self) -> Vec<String> {
        match self {
            Self::Prepare {
                target: EditTarget::SkillId(skill_id),
            } => vec![
                "skill".into(),
                "prepare-edit".into(),
                "--skill-id".into(),
                skill_id.clone(),
                "--json".into(),
            ],
            Self::Prepare {
                target: EditTarget::SkillPath(skill_path),
            } => vec![
                "skill".into(),
                "prepare-edit".into(),
                "--skill-path".into(),
                skill_path.clone(),
                "--json".into(),
            ],
            Self::Finish { session_id } => vec![
                "skill".into(),
                "finish-edit".into(),
                session_id.clone(),
                "--json".into(),
            ],
        }
    }
}

fn parse_edit_command(args: &[String]) -> Result<EditCommand, &'static str> {
    match args.get(1).map(String::as_str) {
        Some("prepare-edit") => parse_prepare(args),
        Some("finish-edit") => parse_finish(args),
        _ => Err(PREPARE_COMMAND),
    }
}

fn parse_prepare(args: &[String]) -> Result<EditCommand, &'static str> {
    let mut skill_id = None;
    let mut skill_path = None;
    let mut json_seen = false;
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--json" if !json_seen => {
                json_seen = true;
                index += 1;
            }
            "--skill-id" if skill_id.is_none() => {
                let value = args.get(index + 1).ok_or(PREPARE_COMMAND)?;
                if !valid_skill_id(value) {
                    return Err(PREPARE_COMMAND);
                }
                skill_id = Some(value.clone());
                index += 2;
            }
            "--skill-path" if skill_path.is_none() => {
                let value = args.get(index + 1).ok_or(PREPARE_COMMAND)?;
                skill_path = Some(parse_skill_path(value).ok_or(PREPARE_COMMAND)?);
                index += 2;
            }
            _ => return Err(PREPARE_COMMAND),
        }
    }
    if !json_seen || skill_id.is_some() == skill_path.is_some() {
        return Err(PREPARE_COMMAND);
    }
    Ok(EditCommand::Prepare {
        target: match (skill_id, skill_path) {
            (Some(skill_id), None) => EditTarget::SkillId(skill_id),
            (None, Some(skill_path)) => EditTarget::SkillPath(skill_path),
            _ => return Err(PREPARE_COMMAND),
        },
    })
}

fn parse_finish(args: &[String]) -> Result<EditCommand, &'static str> {
    let mut session_id = None;
    let mut json_seen = false;
    for value in &args[2..] {
        if value == "--json" {
            if json_seen {
                return Err(FINISH_COMMAND);
            }
            json_seen = true;
            continue;
        }
        if session_id.is_some() || value.starts_with("--") {
            return Err(FINISH_COMMAND);
        }
        session_id = Some(
            uuid::Uuid::parse_str(value)
                .map_err(|_| FINISH_COMMAND)?
                .to_string(),
        );
    }
    match (session_id, json_seen) {
        (Some(session_id), true) => Ok(EditCommand::Finish { session_id }),
        _ => Err(FINISH_COMMAND),
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

fn parse_skill_path(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.starts_with("--")
        || value.chars().any(char::is_control)
    {
        None
    } else {
        Some(value.to_string())
    }
}

fn parse_prepare_output(raw: &str) -> Result<PublicPrepareOutput, ()> {
    if raw.len() > MAX_LEGACY_OUTPUT_BYTES {
        return Err(());
    }
    let legacy = serde_json::from_str::<LegacyPrepareOutput>(raw).map_err(|_| ())?;
    let session_id = uuid::Uuid::parse_str(&legacy.session_id)
        .map_err(|_| ())?
        .to_string();
    if !valid_skill_id(&legacy.skill_id)
        || !valid_output_path(&legacy.working_copy_path)
        || !valid_output_path(&legacy._projection_path)
    {
        return Err(());
    }
    let finish_command = format!("skillhub skill finish-edit {session_id} --json");
    if legacy.finish_command != finish_command {
        return Err(());
    }
    Ok(PublicPrepareOutput {
        session_id,
        skill_id: legacy.skill_id,
        working_copy_path: legacy.working_copy_path,
        finish_command,
    })
}

fn parse_finish_output(raw: &str, expected_session_id: &str) -> Result<PublicFinishOutput, ()> {
    if raw.len() > MAX_LEGACY_OUTPUT_BYTES {
        return Err(());
    }
    let legacy = serde_json::from_str::<LegacyFinishOutput>(raw).map_err(|_| ())?;
    let session_id = uuid::Uuid::parse_str(&legacy.session_id)
        .map_err(|_| ())?
        .to_string();
    if session_id != expected_session_id
        || !valid_skill_id(&legacy.skill_id)
        || !valid_output_path(&legacy._working_copy_path)
        || !valid_output_path(&legacy._projection_path)
        || legacy.version.trim().is_empty()
        || legacy.version.len() > 80
        || legacy.version.chars().any(char::is_control)
    {
        return Err(());
    }
    Ok(PublicFinishOutput {
        session_id,
        skill_id: legacy.skill_id,
        changed: legacy.changed,
        promoted_to_personal: legacy.promoted_to_personal,
        version: legacy.version,
    })
}

fn valid_output_path(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_PATH_BYTES && !value.chars().any(char::is_control)
}

fn usage_failure(command: &'static str) -> CliCommandOutput {
    CliCommandOutput::failure(
        command,
        local_account(),
        CliErrorCode::ValidationFailed,
        EDIT_USAGE,
        EXIT_USAGE,
        Vec::new(),
    )
}

fn prepare_failure(private_error: &str) -> CliCommandOutput {
    let lowercase = private_error.to_ascii_lowercase();
    let (code, message, exit_code) = if lowercase.contains("not found")
        || lowercase.contains("no such file")
        || private_error.contains("不存在")
    {
        (
            CliErrorCode::NotFound,
            "找不到指定的本地 Skill 或安全投影",
            EXIT_USAGE,
        )
    } else if private_error.contains("系统 Skill") || private_error.contains("不允许") {
        (
            CliErrorCode::PermissionDenied,
            "此 Skill 不允许建立编辑会话",
            EXIT_INTERNAL,
        )
    } else if private_error.contains("冲突") || private_error.contains("不是当前") {
        (
            CliErrorCode::Conflict,
            "Skill 投影状态存在冲突，未建立编辑会话",
            EXIT_CONFLICT,
        )
    } else if private_error.contains("路径")
        || private_error.contains("目录")
        || private_error.contains("用法")
        || private_error.contains("无效")
    {
        (
            CliErrorCode::ValidationFailed,
            "指定内容不是可由 SkillHub 安全编辑的 Skill",
            EXIT_USAGE,
        )
    } else {
        (
            CliErrorCode::InternalError,
            "无法安全建立 Skill 编辑会话",
            EXIT_INTERNAL,
        )
    };
    CliCommandOutput::failure(
        PREPARE_COMMAND,
        local_account(),
        code,
        message,
        exit_code,
        vec!["请在 SkillHub APP 中检查该 Skill 与 Agent 投影状态".into()],
    )
}

fn finish_failure(private_error: &str, session_id: &str) -> CliCommandOutput {
    if private_error.contains("已过期")
        || private_error.contains("已损坏")
        || private_error.contains("身份无效")
        || private_error.contains("版本或身份无效")
        || private_error.contains("工作副本已变化")
        || private_error.contains("工作副本已经不存在")
    {
        return CliCommandOutput::failure(
            FINISH_COMMAND,
            local_account(),
            CliErrorCode::PlanStale,
            "编辑会话已失效，未获得继续使用旧会话的授权",
            EXIT_CONFLICT,
            vec!["重新运行 prepare-edit；不要复用旧 session id".into()],
        );
    }
    if private_error.contains("系统 Skill") {
        return CliCommandOutput::failure(
            FINISH_COMMAND,
            local_account(),
            CliErrorCode::PermissionDenied,
            "系统 Skill 不允许完成此编辑会话",
            EXIT_INTERNAL,
            Vec::new(),
        );
    }
    finish_outcome_unknown(Some(session_id))
}

fn finish_outcome_unknown(session_id: Option<&str>) -> CliCommandOutput {
    let session_note = session_id
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .map(|value| format!("编辑会话 {value} 的完成结果无法确定"))
        .unwrap_or_else(|| "编辑会话的完成结果无法确定".into());
    outcome_unknown(
        FINISH_COMMAND,
        &session_note,
        vec![
            "先使用 skill history 与 skill show 复核内容和版本；不要自动重试 finish-edit".into(),
            "如状态仍不明确，请打开 SkillHub APP 检查该 Skill".into(),
        ],
    )
}

fn outcome_unknown(
    command: &'static str,
    message: &str,
    next_actions: Vec<String>,
) -> CliCommandOutput {
    CliCommandOutput::failure(
        command,
        local_account(),
        CliErrorCode::OperationOutcomeUnknown,
        message,
        EXIT_INTERNAL,
        next_actions,
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

#[cfg(test)]
mod tests {
    use super::{
        finish_failure, is_edit_command, parse_edit_command, parse_finish_output,
        parse_prepare_output, prepare_failure, EditCommand, EditTarget, FINISH_COMMAND,
        PREPARE_COMMAND,
    };
    use crate::cli::{CliAccount, CliAccountState, CliCommandOutput};

    const SESSION_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn prepare_requires_exactly_one_target_and_one_json_flag() {
        assert_eq!(
            parse_edit_command(&strings(&[
                "skill",
                "prepare-edit",
                "--json",
                "--skill-id",
                "sample",
            ])),
            Ok(EditCommand::Prepare {
                target: EditTarget::SkillId("sample".into())
            })
        );
        for args in [
            vec!["skill", "prepare-edit", "--skill-id", "sample"],
            vec![
                "skill",
                "prepare-edit",
                "--skill-id",
                "sample",
                "--skill-path",
                "/tmp/sample/SKILL.md",
                "--json",
            ],
            vec![
                "skill",
                "prepare-edit",
                "--skill-path",
                "/tmp/sample/SKILL.md",
                "--json",
                "--json",
            ],
            vec![
                "skill",
                "prepare-edit",
                "--skill-id",
                "sample",
                "--json",
                "unexpected",
            ],
        ] {
            assert!(parse_edit_command(&strings(&args)).is_err());
        }
    }

    #[test]
    fn finish_requires_one_uuid_and_one_json_flag() {
        assert_eq!(
            parse_edit_command(&strings(&["skill", "finish-edit", "--json", SESSION_ID,])),
            Ok(EditCommand::Finish {
                session_id: SESSION_ID.into()
            })
        );
        for args in [
            vec!["skill", "finish-edit", SESSION_ID],
            vec!["skill", "finish-edit", "not-a-uuid", "--json"],
            vec!["skill", "finish-edit", SESSION_ID, "--json", "--json"],
            vec!["skill", "finish-edit", SESSION_ID, "unexpected", "--json"],
        ] {
            assert!(parse_edit_command(&strings(&args)).is_err());
        }
    }

    #[test]
    fn only_edit_subcommands_are_claimed() {
        assert!(is_edit_command(&strings(&[
            "skill",
            "prepare-edit",
            "--json"
        ])));
        assert!(is_edit_command(&strings(&[
            "skill",
            "finish-edit",
            SESSION_ID,
            "--json"
        ])));
        assert!(!is_edit_command(&strings(&["skill", "list", "--json"])));
    }

    #[test]
    fn prepare_output_is_typed_and_omits_projection_and_unknown_secrets() {
        let raw = format!(
            r#"{{"sessionId":"{SESSION_ID}","skillId":"sample","workingCopyPath":"/private/managed/sample","projectionPath":"/private/projection/sample","finishCommand":"skillhub skill finish-edit {SESSION_ID} --json"}}"#
        );
        let public = parse_prepare_output(&raw).expect("parse legacy prepare output");
        let envelope = CliCommandOutput::success(
            PREPARE_COMMAND,
            CliAccount::state(CliAccountState::Unknown),
            serde_json::to_value(public).expect("serialize public prepare output"),
            Vec::new(),
            Vec::new(),
        );
        assert!(envelope.json().contains("workingCopyPath"));
        assert!(envelope.json().contains("finishCommand"));
        assert!(!envelope.json().contains("projectionPath"));
        assert!(!envelope.json().contains("/private/projection"));

        let with_token = raw.replacen("{", "{\"token\":\"secret-token\",", 1);
        assert!(parse_prepare_output(&with_token).is_err());
    }

    #[test]
    fn finish_output_allows_only_the_public_result_fields() {
        let raw = format!(
            r#"{{"sessionId":"{SESSION_ID}","skillId":"sample","changed":true,"promotedToPersonal":true,"version":"v1.1.0-personal.1","workingCopyPath":"/private/managed/sample","projectionPath":"/private/projection/sample"}}"#
        );
        let public = parse_finish_output(&raw, SESSION_ID).expect("parse legacy finish output");
        let rendered = serde_json::to_string(&public).expect("serialize public finish output");
        assert!(rendered.contains("promotedToPersonal"));
        assert!(!rendered.contains("workingCopyPath"));
        assert!(!rendered.contains("projectionPath"));
        assert!(!rendered.contains("/private/"));

        let with_token = raw.replacen("{", "{\"authToken\":\"secret-token\",", 1);
        assert!(parse_finish_output(&with_token, SESSION_ID).is_err());
    }

    #[test]
    fn ambiguous_finish_error_is_redacted_and_not_retryable() {
        for private_error in [
            "无法写入 /Users/person/.skillhub/private; token=secret-token",
            "No such file or directory: /Users/person/private/session.json",
        ] {
            let output = finish_failure(private_error, SESSION_ID);
            assert!(output.json().contains("OPERATION_OUTCOME_UNKNOWN"));
            assert!(output.json().contains("不要自动重试"));
            assert!(!output.json().contains("/Users/person"));
            assert!(!output.json().contains("secret-token"));
            assert_eq!(output.exit_code(), 1);
        }
    }

    #[test]
    fn stale_finish_errors_use_a_safe_machine_code() {
        let output = finish_failure("Skill 编辑会话已过期，请重新 prepare-edit", SESSION_ID);
        assert!(output.json().contains("PLAN_STALE"));
        assert!(!output.json().contains(SESSION_ID));
        assert_eq!(output.exit_code(), 4);
    }

    #[test]
    fn prepare_conflicts_use_the_shared_conflict_exit_code() {
        let output = prepare_failure("Agent Skill 投影存在冲突: /private/path");
        assert!(output.json().contains("CONFLICT"));
        assert!(!output.json().contains("/private/path"));
        assert_eq!(output.exit_code(), 4);
    }

    #[test]
    fn command_constants_match_envelope_contract() {
        assert_eq!(PREPARE_COMMAND, "skill prepare-edit");
        assert_eq!(FINISH_COMMAND, "skill finish-edit");
    }
}
