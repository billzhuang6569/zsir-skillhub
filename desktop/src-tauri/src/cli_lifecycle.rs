use crate::cli::{
    CliAccount, CliAccountState, CliCommandOutput, CliErrorCode, EXIT_CONFLICT, EXIT_INTERNAL,
    EXIT_USAGE,
};
#[cfg(windows)]
use crate::platform_fs::{MetadataExt as _, OpenOptionsExt as _};
use crate::{SkillHubJson, TrashItem};
use git2::{ObjectType, Repository, StatusOptions, Tree};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Read as _;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const DELETE_PREFLIGHT_COMMAND: &str = "skill delete preflight";
const DELETE_APPLY_COMMAND: &str = "skill delete apply";
const TRASH_LIST_COMMAND: &str = "skill trash list";
const TRASH_RESTORE_PREFLIGHT_COMMAND: &str = "skill trash restore preflight";
const TRASH_RESTORE_APPLY_COMMAND: &str = "skill trash restore apply";
const ENABLE_PREFLIGHT_COMMAND: &str = "skill enable preflight";
const ENABLE_APPLY_COMMAND: &str = "skill enable apply";
const DISABLE_PREFLIGHT_COMMAND: &str = "skill disable preflight";
const DISABLE_APPLY_COMMAND: &str = "skill disable apply";
const UNINSTALL_PREFLIGHT_COMMAND: &str = "skill uninstall preflight";
const UNINSTALL_APPLY_COMMAND: &str = "skill uninstall apply";
const RESTORE_VERSION_PREFLIGHT_COMMAND: &str = "skill restore-version preflight";
const RESTORE_VERSION_APPLY_COMMAND: &str = "skill restore-version apply";

const MAX_TREE_DEPTH: usize = 10;
const MAX_TREE_ENTRIES: usize = 4_000;
const MAX_TREE_FILES: usize = 2_000;
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TREE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PROFILE_BYTES: u64 = 1024 * 1024;
const MAX_ENV_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_RECOVERY_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_RECOVERY_ENV_FILES: usize = 512;
const PROJECTION_MARKER_NAME: &str = ".skillhub-projection.json";
const MAX_PROJECTION_MARKER_BYTES: u64 = 16 * 1024;
// 投影 marker / 头版本只有 `commands.rs` 一份事实源（#312：此处曾自带一份 3，
// #252 把头升到 4 后所有投影都被判「marker 与托管内容不一致」）。
const LEGACY_PROJECTION_MARKER_VERSION: u8 = crate::commands::LEGACY_PROJECTION_MARKER_VERSION;
const PROJECTION_MARKER_VERSION: u8 = crate::commands::PROJECTION_MARKER_VERSION;
const LEGACY_PROJECTION_HEADER_VERSION: u8 = crate::commands::LEGACY_PROJECTION_HEADER_VERSION;
const SHELL_EXPORT_PROJECTION_HEADER_VERSION: u8 =
    crate::commands::SHELL_EXPORT_PROJECTION_HEADER_VERSION;
const ENV_ONLY_PROJECTION_HEADER_VERSION: u8 = crate::commands::ENV_ONLY_PROJECTION_HEADER_VERSION;
const PROJECTION_HEADER_VERSION: u8 = crate::commands::PROJECTION_HEADER_VERSION;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectionMarkerSummary {
    version: u8,
    skill_id: String,
    source_root: String,
    generation: String,
    canonical_skill_md_sha256: String,
    rendered_skill_md_sha256: String,
    header_version: u8,
    header_token: String,
    header_injected: bool,
    #[serde(default)]
    header_separator_injected: bool,
    #[serde(default)]
    env_keys: Vec<String>,
    resource_names: Vec<String>,
}

pub(crate) const LIFECYCLE_USAGE: &str = concat!(
    "用法：\n",
    "  skillhub skill delete preflight --skill-id <id> --json\n",
    "  skillhub skill delete apply --skill-id <id> --plan-digest <64hex> --json\n",
    "  skillhub skill trash list --json\n",
    "  skillhub skill trash restore preflight --trash-id <uuid> --json\n",
    "  skillhub skill trash restore apply --trash-id <uuid> --plan-digest <64hex> --json\n",
    "  skillhub skill enable preflight --skill-id <id> --agent <key> --json\n",
    "  skillhub skill enable apply --skill-id <id> --agent <key> --plan-digest <64hex> [--replace-conflicts] --json\n",
    "  skillhub skill disable preflight --skill-id <id> --agent <key> --json\n",
    "  skillhub skill disable apply --skill-id <id> --agent <key> --plan-digest <64hex> --json\n",
    "  skillhub skill uninstall preflight --skill-id <id> --json\n",
    "  skillhub skill uninstall apply --skill-id <id> --plan-digest <64hex> --json\n",
    "  skillhub skill restore-version preflight --skill-id <id> --hash <40hex> [--receipt-id <uuid>] --json\n",
    "  skillhub skill restore-version apply --skill-id <id> --hash <40hex> [--receipt-id <uuid>] --plan-digest <64hex> --json"
);

#[derive(Debug, PartialEq, Eq)]
enum LifecycleCommand {
    DeletePreflight {
        skill_id: String,
    },
    DeleteApply {
        skill_id: String,
        plan_digest: String,
    },
    TrashList,
    TrashRestorePreflight {
        trash_id: String,
    },
    TrashRestoreApply {
        trash_id: String,
        plan_digest: String,
    },
    EnablePreflight {
        skill_id: String,
        agent: String,
    },
    EnableApply {
        skill_id: String,
        agent: String,
        plan_digest: String,
        replace_conflicts: bool,
    },
    DisablePreflight {
        skill_id: String,
        agent: String,
    },
    DisableApply {
        skill_id: String,
        agent: String,
        plan_digest: String,
    },
    UninstallPreflight {
        skill_id: String,
    },
    UninstallApply {
        skill_id: String,
        plan_digest: String,
    },
    RestoreVersionPreflight {
        skill_id: String,
        hash: String,
        receipt_id: Option<String>,
    },
    RestoreVersionApply {
        skill_id: String,
        hash: String,
        receipt_id: Option<String>,
        plan_digest: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FailureKind {
    NotFound,
    PermissionDenied,
    Conflict,
    PlanStale,
    Validation,
    OutcomeUnknown,
    Internal,
}

#[derive(Debug, PartialEq, Eq)]
struct LifecycleFailure {
    kind: FailureKind,
    message: &'static str,
}

impl LifecycleFailure {
    fn not_found(message: &'static str) -> Self {
        Self {
            kind: FailureKind::NotFound,
            message,
        }
    }

    fn permission(message: &'static str) -> Self {
        Self {
            kind: FailureKind::PermissionDenied,
            message,
        }
    }

    fn validation(message: &'static str) -> Self {
        Self {
            kind: FailureKind::Validation,
            message,
        }
    }

    fn conflict(message: &'static str) -> Self {
        Self {
            kind: FailureKind::Conflict,
            message,
        }
    }

    fn plan_stale(message: &'static str) -> Self {
        Self {
            kind: FailureKind::PlanStale,
            message,
        }
    }

    fn internal(message: &'static str) -> Self {
        Self {
            kind: FailureKind::Internal,
            message,
        }
    }

    fn outcome_unknown(message: &'static str) -> Self {
        Self {
            kind: FailureKind::OutcomeUnknown,
            message,
        }
    }
}

#[derive(Debug)]
struct TreeSummary {
    file_count: usize,
    directory_count: usize,
    total_bytes: u64,
    latest_modified_at_unix: u64,
    fingerprint: String,
}

#[derive(Debug)]
struct ProfileSummary {
    display_name: String,
    version: String,
    projection_name: String,
    is_system: bool,
}

struct WorkingCopySummary {
    has_changes: bool,
    change_count: u32,
    fingerprint: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteImpact {
    file_count: usize,
    directory_count: usize,
    total_bytes: u64,
    latest_modified_at_unix: u64,
    installed_agents: Vec<String>,
    foreign_same_name_count: usize,
    has_internal_projection: bool,
    has_working_changes: bool,
    working_change_count: u32,
    environment_file_count: usize,
    moves_to_trash: bool,
    permanently_deletes: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeletePlanData {
    skill_id: String,
    display_name: String,
    version: String,
    is_system: bool,
    /// In the signed-in account's synced library: only an account delete in
    /// the APP removes it (a device-only delete would be downloaded again).
    account_synced: bool,
    can_apply: bool,
    requires_explicit_apply: bool,
    plan_digest: String,
    impact: DeleteImpact,
}

#[derive(Debug)]
struct DeletePlan {
    data: DeletePlanData,
    digest: String,
    has_pending_projection_edits: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicTrashItem {
    trash_id: String,
    kind: String,
    skill_id: String,
    display_name: String,
    created_at: u64,
    status: String,
    reason: Option<String>,
    source_count: usize,
    restorable_via_cli: bool,
    requires_app: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreImpact {
    file_count: usize,
    directory_count: usize,
    total_bytes: u64,
    latest_modified_at_unix: u64,
    target_occupied: bool,
    target_count: usize,
    occupied_target_count: usize,
    environment_file_count: usize,
    restores_projection: bool,
    restores_managed_skill: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestorePlanData {
    trash_id: String,
    kind: String,
    skill_id: String,
    display_name: String,
    status: String,
    can_apply: bool,
    requires_explicit_apply: bool,
    plan_digest: String,
    impact: RestoreImpact,
}

#[derive(Debug)]
struct RestorePlan {
    raw_id: String,
    manifest: serde_json::Value,
    data: RestorePlanData,
    digest: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionActionPlanData {
    operation: &'static str,
    skill_id: String,
    display_name: String,
    agent: Option<String>,
    installed_agents: Vec<String>,
    already_in_requested_state: bool,
    has_conflicts: bool,
    replace_conflicts_required: bool,
    keeps_managed_source: bool,
    can_apply: bool,
    requires_explicit_apply: bool,
    plan_digest: String,
}

struct ProjectionActionPlan {
    data: ProjectionActionPlanData,
    digest: String,
    install_digest: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionRestorePlanData {
    skill_id: String,
    display_name: String,
    current_hash: String,
    target_hash: String,
    receipt_id: Option<String>,
    target_summary: String,
    target_committed_at_unix: i64,
    has_working_changes: bool,
    working_change_count: u32,
    has_pending_projection_edits: bool,
    requires_clean_working_copy: bool,
    creates_restore_snapshot: bool,
    can_apply: bool,
    requires_explicit_apply: bool,
    plan_digest: String,
}

struct VersionRestorePlan {
    data: VersionRestorePlanData,
    digest: String,
}

struct RestoreTreeValidation {
    entry_count: usize,
    file_count: usize,
    total_bytes: u64,
    portable_paths: HashSet<String>,
    has_skill_md: bool,
}

struct RecoveryInspection {
    skill_source: PathBuf,
    manifest: serde_json::Value,
    fingerprint: Vec<u8>,
    target_count: usize,
    occupied_target_count: usize,
    environment_file_count: usize,
    restores_projection: bool,
}

fn local_account() -> CliAccount {
    CliAccount::state(CliAccountState::Unknown)
}

pub(crate) fn is_lifecycle_command(args: &[String]) -> bool {
    args.first().map(String::as_str) == Some("skill")
        && matches!(
            args.get(1).map(String::as_str),
            Some("delete" | "trash" | "enable" | "disable" | "uninstall" | "restore-version")
        )
}

pub(crate) async fn execute_lifecycle_cli(args: &[String]) -> Option<CliCommandOutput> {
    if !is_lifecycle_command(args) {
        return None;
    }
    let command = match parse_command(args) {
        Ok(command) => command,
        Err(command) => return Some(usage_failure(command)),
    };
    Some(match command {
        LifecycleCommand::DeletePreflight { skill_id } => delete_preflight(skill_id).await,
        LifecycleCommand::DeleteApply {
            skill_id,
            plan_digest,
        } => delete_apply(skill_id, plan_digest).await,
        LifecycleCommand::TrashList => trash_list().await,
        LifecycleCommand::TrashRestorePreflight { trash_id } => {
            trash_restore_preflight(trash_id).await
        }
        LifecycleCommand::TrashRestoreApply {
            trash_id,
            plan_digest,
        } => trash_restore_apply(trash_id, plan_digest).await,
        LifecycleCommand::EnablePreflight { skill_id, agent } => {
            projection_enable_preflight(skill_id, agent).await
        }
        LifecycleCommand::EnableApply {
            skill_id,
            agent,
            plan_digest,
            replace_conflicts,
        } => projection_enable_apply(skill_id, agent, plan_digest, replace_conflicts).await,
        LifecycleCommand::DisablePreflight { skill_id, agent } => {
            projection_disable_preflight(skill_id, agent).await
        }
        LifecycleCommand::DisableApply {
            skill_id,
            agent,
            plan_digest,
        } => projection_disable_apply(skill_id, agent, plan_digest).await,
        LifecycleCommand::UninstallPreflight { skill_id } => {
            projection_uninstall_preflight(skill_id).await
        }
        LifecycleCommand::UninstallApply {
            skill_id,
            plan_digest,
        } => projection_uninstall_apply(skill_id, plan_digest).await,
        LifecycleCommand::RestoreVersionPreflight {
            skill_id,
            hash,
            receipt_id,
        } => restore_version_preflight(skill_id, hash, receipt_id).await,
        LifecycleCommand::RestoreVersionApply {
            skill_id,
            hash,
            receipt_id,
            plan_digest,
        } => restore_version_apply(skill_id, hash, receipt_id, plan_digest).await,
    })
}

fn parse_command(args: &[String]) -> Result<LifecycleCommand, &'static str> {
    match args.get(1).map(String::as_str) {
        Some("delete") => parse_delete(args),
        Some("trash") => parse_trash(args),
        Some("enable") => parse_projection_action(args, true),
        Some("disable") => parse_projection_action(args, false),
        Some("uninstall") => parse_uninstall(args),
        Some("restore-version") => parse_restore_version(args),
        _ => Err(DELETE_PREFLIGHT_COMMAND),
    }
}

fn parse_delete(args: &[String]) -> Result<LifecycleCommand, &'static str> {
    let action = args.get(2).map(String::as_str);
    let command = match action {
        Some("preflight") => DELETE_PREFLIGHT_COMMAND,
        Some("apply") => DELETE_APPLY_COMMAND,
        _ => return Err(DELETE_PREFLIGHT_COMMAND),
    };
    let (skill_id, plan_digest) = parse_plan_args(args, 3, "--skill-id", command)?;
    match action {
        Some("preflight") if plan_digest.is_none() => {
            Ok(LifecycleCommand::DeletePreflight { skill_id })
        }
        Some("apply") => Ok(LifecycleCommand::DeleteApply {
            skill_id,
            plan_digest: plan_digest.ok_or(command)?,
        }),
        _ => Err(command),
    }
}

fn parse_trash(args: &[String]) -> Result<LifecycleCommand, &'static str> {
    match args.get(2).map(String::as_str) {
        Some("list") if args.len() == 4 && args.get(3).map(String::as_str) == Some("--json") => {
            Ok(LifecycleCommand::TrashList)
        }
        Some("restore") => {
            let action = args.get(3).map(String::as_str);
            let command = match action {
                Some("preflight") => TRASH_RESTORE_PREFLIGHT_COMMAND,
                Some("apply") => TRASH_RESTORE_APPLY_COMMAND,
                _ => return Err(TRASH_RESTORE_PREFLIGHT_COMMAND),
            };
            let (trash_id, plan_digest) = parse_plan_args(args, 4, "--trash-id", command)?;
            match action {
                Some("preflight") if plan_digest.is_none() => {
                    Ok(LifecycleCommand::TrashRestorePreflight { trash_id })
                }
                Some("apply") => Ok(LifecycleCommand::TrashRestoreApply {
                    trash_id,
                    plan_digest: plan_digest.ok_or(command)?,
                }),
                _ => Err(command),
            }
        }
        _ => Err(TRASH_LIST_COMMAND),
    }
}

fn parse_projection_action(
    args: &[String],
    enable: bool,
) -> Result<LifecycleCommand, &'static str> {
    let action = args.get(2).map(String::as_str);
    let command = match (enable, action) {
        (true, Some("preflight")) => ENABLE_PREFLIGHT_COMMAND,
        (true, Some("apply")) => ENABLE_APPLY_COMMAND,
        (false, Some("preflight")) => DISABLE_PREFLIGHT_COMMAND,
        (false, Some("apply")) => DISABLE_APPLY_COMMAND,
        (true, _) => return Err(ENABLE_PREFLIGHT_COMMAND),
        (false, _) => return Err(DISABLE_PREFLIGHT_COMMAND),
    };
    let mut skill_id = None;
    let mut agent = None;
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
            "--skill-id" if skill_id.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                skill_id = valid_skill_id(value).then(|| value.clone());
                if skill_id.is_none() {
                    return Err(command);
                }
                index += 2;
            }
            "--agent" if agent.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                agent = valid_agent_key(value).then(|| value.clone());
                if agent.is_none() {
                    return Err(command);
                }
                index += 2;
            }
            "--plan-digest" if plan_digest.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                plan_digest = Some(parse_plan_digest(value).ok_or(command)?);
                index += 2;
            }
            "--replace-conflicts" if enable && !replace_conflicts => {
                replace_conflicts = true;
                index += 1;
            }
            _ => return Err(command),
        }
    }
    let skill_id = skill_id.ok_or(command)?;
    let agent = agent.ok_or(command)?;
    if !json_seen {
        return Err(command);
    }
    match (enable, action, plan_digest, replace_conflicts) {
        (true, Some("preflight"), None, false) => {
            Ok(LifecycleCommand::EnablePreflight { skill_id, agent })
        }
        (true, Some("apply"), Some(plan_digest), replace_conflicts) => {
            Ok(LifecycleCommand::EnableApply {
                skill_id,
                agent,
                plan_digest,
                replace_conflicts,
            })
        }
        (false, Some("preflight"), None, false) => {
            Ok(LifecycleCommand::DisablePreflight { skill_id, agent })
        }
        (false, Some("apply"), Some(plan_digest), false) => Ok(LifecycleCommand::DisableApply {
            skill_id,
            agent,
            plan_digest,
        }),
        _ => Err(command),
    }
}

fn parse_uninstall(args: &[String]) -> Result<LifecycleCommand, &'static str> {
    let action = args.get(2).map(String::as_str);
    let command = match action {
        Some("preflight") => UNINSTALL_PREFLIGHT_COMMAND,
        Some("apply") => UNINSTALL_APPLY_COMMAND,
        _ => return Err(UNINSTALL_PREFLIGHT_COMMAND),
    };
    let (skill_id, plan_digest) = parse_plan_args(args, 3, "--skill-id", command)?;
    match (action, plan_digest) {
        (Some("preflight"), None) => Ok(LifecycleCommand::UninstallPreflight { skill_id }),
        (Some("apply"), Some(plan_digest)) => Ok(LifecycleCommand::UninstallApply {
            skill_id,
            plan_digest,
        }),
        _ => Err(command),
    }
}

fn parse_restore_version(args: &[String]) -> Result<LifecycleCommand, &'static str> {
    let action = args.get(2).map(String::as_str);
    let command = match action {
        Some("preflight") => RESTORE_VERSION_PREFLIGHT_COMMAND,
        Some("apply") => RESTORE_VERSION_APPLY_COMMAND,
        _ => return Err(RESTORE_VERSION_PREFLIGHT_COMMAND),
    };
    let mut skill_id = None;
    let mut hash = None;
    let mut receipt_id = None;
    let mut plan_digest = None;
    let mut json_seen = false;
    let mut index = 3;
    while index < args.len() {
        match args[index].as_str() {
            "--json" if !json_seen => {
                json_seen = true;
                index += 1;
            }
            "--skill-id" if skill_id.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                skill_id = valid_skill_id(value).then(|| value.clone());
                if skill_id.is_none() {
                    return Err(command);
                }
                index += 2;
            }
            "--hash" if hash.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                hash = parse_git_hash(value);
                if hash.is_none() {
                    return Err(command);
                }
                index += 2;
            }
            "--receipt-id" if receipt_id.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                uuid::Uuid::parse_str(value).map_err(|_| command)?;
                receipt_id = Some(value.clone());
                index += 2;
            }
            "--plan-digest" if plan_digest.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                plan_digest = Some(parse_plan_digest(value).ok_or(command)?);
                index += 2;
            }
            _ => return Err(command),
        }
    }
    let skill_id = skill_id.ok_or(command)?;
    let hash = hash.ok_or(command)?;
    if !json_seen {
        return Err(command);
    }
    match (action, plan_digest) {
        (Some("preflight"), None) => Ok(LifecycleCommand::RestoreVersionPreflight {
            skill_id,
            hash,
            receipt_id,
        }),
        (Some("apply"), Some(plan_digest)) => Ok(LifecycleCommand::RestoreVersionApply {
            skill_id,
            hash,
            receipt_id,
            plan_digest,
        }),
        _ => Err(command),
    }
}

fn parse_plan_args(
    args: &[String],
    start: usize,
    id_flag: &str,
    command: &'static str,
) -> Result<(String, Option<String>), &'static str> {
    let mut id = None;
    let mut plan_digest = None;
    let mut json_seen = false;
    let mut index = start;
    while index < args.len() {
        match args[index].as_str() {
            "--json" if !json_seen => {
                json_seen = true;
                index += 1;
            }
            flag if flag == id_flag && id.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                let parsed = if id_flag == "--skill-id" {
                    valid_skill_id(value).then(|| value.clone())
                } else {
                    parse_public_trash_id(value)
                };
                id = Some(parsed.ok_or(command)?);
                index += 2;
            }
            "--plan-digest" if plan_digest.is_none() => {
                let value = args.get(index + 1).ok_or(command)?;
                plan_digest = Some(parse_plan_digest(value).ok_or(command)?);
                index += 2;
            }
            _ => return Err(command),
        }
    }
    if !json_seen {
        return Err(command);
    }
    Ok((id.ok_or(command)?, plan_digest))
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
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'-' | b'_'))
        })
}

fn parse_git_hash(value: &str) -> Option<String> {
    (value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

fn parse_plan_digest(value: &str) -> Option<String> {
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

fn parse_public_trash_id(value: &str) -> Option<String> {
    uuid::Uuid::parse_str(value)
        .ok()
        .map(|value| value.to_string())
}

fn known_agent(agent: &str) -> bool {
    crate::known_agents()
        .iter()
        .any(|(key, _, _)| *key == agent)
}

fn derived_plan_digest(schema: &[u8], fields: &[&[u8]]) -> String {
    let mut digest = Sha256::new();
    digest_field(&mut digest, schema);
    for field in fields {
        digest_field(&mut digest, field);
    }
    format!("{:x}", digest.finalize())
}

fn is_local_env_value_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == ".env"
        || name == ".envrc"
        || (name.starts_with(".env.")
            && !matches!(
                name.as_str(),
                ".env.example" | ".env.sample" | ".env.template"
            ))
}

fn is_windows_reserved_device_name(name: &str) -> bool {
    let basename = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    matches!(basename.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (basename.len() == 4
            && (basename.starts_with("COM") || basename.starts_with("LPT"))
            && matches!(basename.as_bytes()[3], b'1'..=b'9'))
}

fn validate_portable_restore_component(name: &str) -> Result<(), LifecycleFailure> {
    if name.chars().any(|character| {
        character.is_control() || matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
    }) {
        return Err(LifecycleFailure::validation(
            "目标版本包含 Windows 不兼容的路径字符",
        ));
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return Err(LifecycleFailure::validation(
            "目标版本路径分量不能以空格或点结尾",
        ));
    }
    if is_windows_reserved_device_name(name) {
        return Err(LifecycleFailure::validation(
            "目标版本包含 Windows 保留设备名",
        ));
    }
    Ok(())
}

fn validate_restore_tree_entries(
    repository: &Repository,
    tree: &Tree<'_>,
    parent: &str,
    depth: usize,
    validation: &mut RestoreTreeValidation,
) -> Result<(), LifecycleFailure> {
    for entry in tree.iter() {
        let entry_depth = depth.saturating_add(1);
        if entry_depth > MAX_TREE_DEPTH {
            return Err(LifecycleFailure::validation(
                "目标版本文件树层级超过安全上限",
            ));
        }
        validation.entry_count = validation.entry_count.saturating_add(1);
        if validation.entry_count > MAX_TREE_ENTRIES {
            return Err(LifecycleFailure::validation(
                "目标版本文件树条目超过安全上限",
            ));
        }

        let name = std::str::from_utf8(entry.name_bytes())
            .map_err(|_| LifecycleFailure::validation("目标版本包含非 UTF-8 文件名"))?;
        if name.is_empty()
            || matches!(name, "." | "..")
            || name.contains('/')
            || name.contains('\\')
        {
            return Err(LifecycleFailure::validation("目标版本包含不安全文件路径"));
        }
        validate_portable_restore_component(name)?;
        if name.eq_ignore_ascii_case(".git") {
            return Err(LifecycleFailure::validation("目标版本包含保留的 Git 路径"));
        }
        if is_local_env_value_name(name) {
            return Err(LifecycleFailure::validation("目标版本包含本机环境变量文件"));
        }
        let relative = if parent.is_empty() {
            name.to_string()
        } else {
            format!("{parent}/{name}")
        };
        // Bind path identity case-insensitively so a history entry created on
        // Linux cannot collapse two objects onto one Windows/macOS path.
        if !validation.portable_paths.insert(relative.to_lowercase()) {
            return Err(LifecycleFailure::validation(
                "目标版本包含大小写冲突的文件路径",
            ));
        }

        match (entry.kind(), entry.filemode_raw()) {
            (Some(ObjectType::Tree), 0o040000) => {
                let child = repository
                    .find_tree(entry.id())
                    .map_err(|_| LifecycleFailure::validation("目标版本目录对象无法安全读取"))?;
                validate_restore_tree_entries(
                    repository,
                    &child,
                    &relative,
                    entry_depth,
                    validation,
                )?;
            }
            (Some(ObjectType::Blob), 0o100644 | 0o100755) => {
                validation.file_count = validation.file_count.saturating_add(1);
                if validation.file_count > MAX_TREE_FILES {
                    return Err(LifecycleFailure::validation("目标版本文件数量超过安全上限"));
                }
                let (size, kind) = repository
                    .odb()
                    .and_then(|odb| odb.read_header(entry.id()))
                    .map_err(|_| LifecycleFailure::validation("目标版本文件对象无法安全读取"))?;
                if kind != ObjectType::Blob || size as u64 > MAX_FILE_BYTES {
                    return Err(LifecycleFailure::validation("目标版本文件大小超过安全上限"));
                }
                validation.total_bytes = validation
                    .total_bytes
                    .checked_add(size as u64)
                    .filter(|total| *total <= MAX_TREE_BYTES)
                    .ok_or_else(|| {
                        LifecycleFailure::validation("目标版本内容总大小超过安全上限")
                    })?;
                if relative == "SKILL.md" {
                    validation.has_skill_md = true;
                }
            }
            (Some(ObjectType::Blob), 0o120000) => {
                return Err(LifecycleFailure::validation(
                    "目标版本包含符号链接或目录联接",
                ));
            }
            _ => {
                return Err(LifecycleFailure::validation(
                    "目标版本包含不支持的 Git 对象或文件模式",
                ));
            }
        }
    }
    Ok(())
}

fn validate_restore_target_tree(
    repository: &Repository,
    tree: &Tree<'_>,
) -> Result<(), LifecycleFailure> {
    let mut validation = RestoreTreeValidation {
        entry_count: 0,
        file_count: 0,
        total_bytes: 0,
        portable_paths: HashSet::new(),
        has_skill_md: false,
    };
    validate_restore_tree_entries(repository, tree, "", 0, &mut validation)?;
    if !validation.has_skill_md {
        return Err(LifecycleFailure::validation("目标版本缺少根目录 SKILL.md"));
    }
    Ok(())
}

pub(crate) fn validate_restore_target_tree_for_checkout(
    repository: &Repository,
    tree: &Tree<'_>,
) -> Result<(), String> {
    validate_restore_target_tree(repository, tree).map_err(|error| error.message.to_string())
}

async fn build_enable_plan(
    skill_id: String,
    agent: String,
) -> Result<ProjectionActionPlan, LifecycleFailure> {
    if !known_agent(&agent) {
        return Err(LifecycleFailure::validation(
            "目标 Agent 在当前平台不受支持",
        ));
    }
    let home = crate::user_home_dir()
        .ok_or_else(|| LifecycleFailure::internal("无法确定当前用户目录，投影预检没有执行"))?;
    let delete_skill_id = skill_id.clone();
    let base =
        tauri::async_runtime::spawn_blocking(move || build_delete_plan_at(&home, &delete_skill_id))
            .await
            .map_err(|_| LifecycleFailure::internal("本地投影预检任务异常结束"))??;
    let installed = base.data.impact.installed_agents.contains(&agent);
    if base.data.is_system {
        let digest = derived_plan_digest(
            b"skillhub-enable-plan-v1",
            &[base.digest.as_bytes(), agent.as_bytes()],
        );
        return Ok(ProjectionActionPlan {
            data: ProjectionActionPlanData {
                operation: "enable",
                skill_id,
                display_name: base.data.display_name,
                agent: Some(agent),
                installed_agents: base.data.impact.installed_agents,
                already_in_requested_state: installed,
                has_conflicts: false,
                replace_conflicts_required: false,
                keeps_managed_source: true,
                can_apply: false,
                requires_explicit_apply: true,
                plan_digest: digest.clone(),
            },
            digest,
            install_digest: None,
        });
    }
    let install = crate::commands::preflight_install_skill(skill_id.clone(), vec![agent.clone()])
        .await
        .map_err(|_| LifecycleFailure::validation("目标 Agent 未检测到、不可用或同名位置不安全"))?;
    let digest = derived_plan_digest(
        b"skillhub-enable-plan-v1",
        &[
            base.digest.as_bytes(),
            install.plan_digest.as_bytes(),
            agent.as_bytes(),
        ],
    );
    Ok(ProjectionActionPlan {
        data: ProjectionActionPlanData {
            operation: "enable",
            skill_id,
            display_name: base.data.display_name,
            agent: Some(agent),
            installed_agents: base.data.impact.installed_agents,
            already_in_requested_state: installed,
            has_conflicts: install.has_conflicts,
            replace_conflicts_required: install.has_conflicts,
            keeps_managed_source: true,
            can_apply: !installed,
            requires_explicit_apply: true,
            plan_digest: digest.clone(),
        },
        digest,
        install_digest: Some(install.plan_digest),
    })
}

fn build_projection_removal_plan(
    home: &Path,
    skill_id: &str,
    agent: Option<&str>,
) -> Result<ProjectionActionPlan, LifecycleFailure> {
    if agent.is_some_and(|value| !known_agent(value)) {
        return Err(LifecycleFailure::validation(
            "目标 Agent 在当前平台不受支持",
        ));
    }
    let base = build_delete_plan_at(home, skill_id)?;
    let operation = if agent.is_some() {
        "disable"
    } else {
        "uninstall"
    };
    let requested_installed = agent
        .map(|value| {
            base.data
                .impact
                .installed_agents
                .iter()
                .any(|key| key == value)
        })
        .unwrap_or_else(|| !base.data.impact.installed_agents.is_empty());
    let schema = if agent.is_some() {
        b"skillhub-disable-plan-v1".as_slice()
    } else {
        b"skillhub-uninstall-plan-v1".as_slice()
    };
    let agent_field = agent.unwrap_or("");
    let digest = derived_plan_digest(schema, &[base.digest.as_bytes(), agent_field.as_bytes()]);
    Ok(ProjectionActionPlan {
        data: ProjectionActionPlanData {
            operation,
            skill_id: skill_id.to_string(),
            display_name: base.data.display_name,
            agent: agent.map(str::to_string),
            installed_agents: base.data.impact.installed_agents,
            already_in_requested_state: !requested_installed,
            has_conflicts: false,
            replace_conflicts_required: false,
            keeps_managed_source: true,
            can_apply: !base.data.is_system && requested_installed,
            requires_explicit_apply: true,
            plan_digest: digest.clone(),
        },
        digest,
        install_digest: None,
    })
}

#[cfg(test)]
fn build_version_restore_plan_at(
    home: &Path,
    skill_id: &str,
    hash: &str,
) -> Result<VersionRestorePlan, LifecycleFailure> {
    build_version_restore_identity_plan_at(home, skill_id, hash, None)
}

fn build_version_restore_identity_plan_at(
    home: &Path,
    skill_id: &str,
    hash: &str,
    receipt_id: Option<&str>,
) -> Result<VersionRestorePlan, LifecycleFailure> {
    let base = build_delete_plan_at(home, skill_id)?;
    let root = home
        .join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        })
        .join("skills")
        .join(skill_id);
    let mut profile = if root.join(".skillhub.json").exists() {
        crate::commands::library_read_profile_readonly(&root)
            .map_err(|_| LifecycleFailure::validation("无法安全读取当前版本身份"))?
    } else {
        crate::SkillHubProfile::default()
    };
    crate::version_policy::normalize_history(&root, &mut profile.version_metadata)
        .map_err(|_| LifecycleFailure::validation("无法规范化完整版本历史"))?;
    let mappings = crate::version_policy::history_for_hash(&profile.version_metadata, hash);
    if let Some(receipt_id) = receipt_id {
        if profile.version_metadata.account_id != profile.library_account_id
            || profile.version_metadata.entry_id != profile.library_entry_id
            || !mappings.iter().any(|m| {
                m.receipt
                    .as_ref()
                    .is_some_and(|r| r.receipt_id == receipt_id)
            })
        {
            return Err(LifecycleFailure::validation(
                "版本收据不属于当前账号条目和所选完整 hash",
            ));
        }
    } else if mappings.len() > 1 {
        return Err(LifecycleFailure::validation(
            "同一内容有多个版本身份，请用 --receipt-id 精确选择",
        ));
    }
    let repository = Repository::open(
        home.join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        })
        .join("skills")
        .join(skill_id),
    )
    .map_err(|_| LifecycleFailure::validation("目标 Skill 没有可恢复的版本历史"))?;
    let current = repository
        .head()
        .and_then(|head| head.peel_to_commit())
        .map_err(|_| LifecycleFailure::validation("目标 Skill 没有当前版本提交"))?;
    let target_id =
        git2::Oid::from_str(hash).map_err(|_| LifecycleFailure::validation("目标版本哈希无效"))?;
    let target = repository
        .find_commit(target_id)
        .map_err(|_| LifecycleFailure::not_found("版本历史中不存在目标提交"))?;
    if target.id() != current.id()
        && !repository
            .graph_descendant_of(current.id(), target.id())
            .map_err(|_| LifecycleFailure::validation("无法验证目标版本的历史归属"))?
    {
        return Err(LifecycleFailure::validation(
            "目标提交不属于当前 Skill 的可恢复历史",
        ));
    }
    let target_tree_object = target
        .tree()
        .map_err(|_| LifecycleFailure::validation("目标版本文件树无法安全读取"))?;
    validate_restore_target_tree(&repository, &target_tree_object)?;
    let target_tree = target_tree_object.id().to_string();
    let current_hash = current.id().to_string();
    let target_hash = target.id().to_string();
    let target_summary = target
        .summary()
        .ok()
        .flatten()
        .unwrap_or("未命名版本")
        .chars()
        .filter(|character| !character.is_control())
        .take(500)
        .collect::<String>();
    let digest = derived_plan_digest(
        b"skillhub-restore-version-plan-v1",
        &[
            base.digest.as_bytes(),
            current_hash.as_bytes(),
            target_hash.as_bytes(),
            target_tree.as_bytes(),
            receipt_id.unwrap_or_default().as_bytes(),
        ],
    );
    Ok(VersionRestorePlan {
        data: VersionRestorePlanData {
            skill_id: skill_id.to_string(),
            display_name: base.data.display_name,
            current_hash,
            target_hash,
            receipt_id: receipt_id.map(str::to_string),
            target_summary,
            target_committed_at_unix: target.time().seconds(),
            has_working_changes: base.data.impact.has_working_changes,
            working_change_count: base.data.impact.working_change_count,
            has_pending_projection_edits: base.has_pending_projection_edits,
            requires_clean_working_copy: true,
            creates_restore_snapshot: true,
            can_apply: !base.data.is_system
                && (target.id() != current.id()
                    || receipt_id.is_some_and(|id| {
                        profile
                            .version_metadata
                            .current_receipt
                            .as_ref()
                            .is_none_or(|r| r.receipt_id != id)
                    }))
                && !base.data.impact.has_working_changes
                && !base.has_pending_projection_edits,
            requires_explicit_apply: true,
            plan_digest: digest.clone(),
        },
        digest,
    })
}

fn projection_plan_success(command: &'static str, plan: ProjectionActionPlan) -> CliCommandOutput {
    let mut warnings = Vec::new();
    if plan.data.has_conflicts {
        warnings.push("目标 Agent 存在内容不同的同名 Skill；替换前会保留可恢复备份".into());
    }
    if plan.data.already_in_requested_state {
        warnings.push("目标已经处于请求状态，本次没有必要执行 apply".into());
    }
    let mut next_actions = Vec::new();
    if plan.data.can_apply {
        next_actions.push("向用户展示影响并取得明确确认，再原样传入 planDigest 执行 apply".into());
    }
    CliCommandOutput::success(
        command,
        local_account(),
        json!(plan.data),
        warnings,
        next_actions,
    )
}

async fn projection_enable_preflight(skill_id: String, agent: String) -> CliCommandOutput {
    match build_enable_plan(skill_id, agent).await {
        Ok(plan) => projection_plan_success(ENABLE_PREFLIGHT_COMMAND, plan),
        Err(error) => failure_output(ENABLE_PREFLIGHT_COMMAND, error, Vec::new()),
    }
}

async fn projection_enable_apply(
    skill_id: String,
    agent: String,
    expected_digest: String,
    replace_conflicts: bool,
) -> CliCommandOutput {
    let plan = match build_enable_plan(skill_id.clone(), agent.clone()).await {
        Ok(plan) => plan,
        Err(error) => return failure_output(ENABLE_APPLY_COMMAND, error, Vec::new()),
    };
    if plan.digest != expected_digest {
        return failure_output(
            ENABLE_APPLY_COMMAND,
            LifecycleFailure::plan_stale("Agent 投影状态在确认后发生变化"),
            vec!["重新运行 enable preflight 并确认新计划".into()],
        );
    }
    if !plan.data.can_apply {
        return failure_output(
            ENABLE_APPLY_COMMAND,
            LifecycleFailure::conflict("系统 Skill 不可修改，或目标已经启用"),
            Vec::new(),
        );
    }
    if plan.data.has_conflicts && !replace_conflicts {
        return failure_output(
            ENABLE_APPLY_COMMAND,
            LifecycleFailure::conflict("同名 Skill 冲突尚未取得替换确认"),
            Vec::new(),
        );
    }
    let Some(install_digest) = plan.install_digest else {
        return internal_failure(ENABLE_APPLY_COMMAND, "启用计划缺少内部确认摘要", Vec::new());
    };
    match crate::commands::install_skill(
        skill_id.clone(),
        vec![agent.clone()],
        Some(replace_conflicts),
        Some(install_digest),
    )
    .await
    {
        Ok(()) => CliCommandOutput::success(
            ENABLE_APPLY_COMMAND,
            local_account(),
            json!({ "applied": true, "skillId": skill_id, "agent": agent, "enabled": true }),
            Vec::new(),
            vec!["使用 skillhub skill show --skill-id <id> --json 复核 Agent 状态".into()],
        ),
        Err(_) => failure_output(
            ENABLE_APPLY_COMMAND,
            LifecycleFailure::conflict("启用未完成；Agent 状态或同名内容可能已经变化"),
            vec!["重新运行 enable preflight；不要自动放宽替换范围".into()],
        ),
    }
}

async fn projection_disable_preflight(skill_id: String, agent: String) -> CliCommandOutput {
    let Some(home) = crate::user_home_dir() else {
        return internal_failure(
            DISABLE_PREFLIGHT_COMMAND,
            "无法确定当前用户目录",
            Vec::new(),
        );
    };
    match tauri::async_runtime::spawn_blocking(move || {
        build_projection_removal_plan(&home, &skill_id, Some(&agent))
    })
    .await
    {
        Ok(Ok(plan)) => projection_plan_success(DISABLE_PREFLIGHT_COMMAND, plan),
        Ok(Err(error)) => failure_output(DISABLE_PREFLIGHT_COMMAND, error, Vec::new()),
        Err(_) => internal_failure(
            DISABLE_PREFLIGHT_COMMAND,
            "投影停用预检任务异常结束",
            Vec::new(),
        ),
    }
}

async fn projection_disable_apply(
    skill_id: String,
    agent: String,
    expected_digest: String,
) -> CliCommandOutput {
    let Some(home) = crate::user_home_dir() else {
        return internal_failure(DISABLE_APPLY_COMMAND, "无法确定当前用户目录", Vec::new());
    };
    let response_skill_id = skill_id.clone();
    let response_agent = agent.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let plan = build_projection_removal_plan(&home, &skill_id, Some(&agent))?;
        if plan.digest != expected_digest {
            return Err(LifecycleFailure::plan_stale(
                "Agent 投影状态在确认后发生变化",
            ));
        }
        if !plan.data.can_apply {
            return Err(LifecycleFailure::conflict(
                "系统 Skill 不可修改，或目标已经停用",
            ));
        }
        crate::commands::disable_skill(skill_id, agent)
            .map_err(|_| LifecycleFailure::outcome_unknown("停用结果需要复核"))
    })
    .await;
    match result {
        Ok(Ok(())) => CliCommandOutput::success(
            DISABLE_APPLY_COMMAND,
            local_account(),
            json!({ "applied": true, "skillId": response_skill_id, "agent": response_agent, "enabled": false }),
            Vec::new(),
            vec!["使用 skillhub skill show --skill-id <id> --json 复核 Agent 状态".into()],
        ),
        Ok(Err(error)) => failure_output(
            DISABLE_APPLY_COMMAND,
            error,
            vec!["先复核 Agent 投影状态；不要盲目重复 apply".into()],
        ),
        Err(_) => outcome_unknown_failure(
            DISABLE_APPLY_COMMAND,
            "停用任务异常结束，结果需要复核",
            vec!["使用 skillhub skill show --skill-id <id> --json 复核 Agent 状态".into()],
        ),
    }
}

async fn projection_uninstall_preflight(skill_id: String) -> CliCommandOutput {
    let Some(home) = crate::user_home_dir() else {
        return internal_failure(
            UNINSTALL_PREFLIGHT_COMMAND,
            "无法确定当前用户目录",
            Vec::new(),
        );
    };
    match tauri::async_runtime::spawn_blocking(move || {
        build_projection_removal_plan(&home, &skill_id, None)
    })
    .await
    {
        Ok(Ok(plan)) => projection_plan_success(UNINSTALL_PREFLIGHT_COMMAND, plan),
        Ok(Err(error)) => failure_output(UNINSTALL_PREFLIGHT_COMMAND, error, Vec::new()),
        Err(_) => internal_failure(
            UNINSTALL_PREFLIGHT_COMMAND,
            "投影卸载预检任务异常结束",
            Vec::new(),
        ),
    }
}

async fn projection_uninstall_apply(skill_id: String, expected_digest: String) -> CliCommandOutput {
    let Some(home) = crate::user_home_dir() else {
        return internal_failure(UNINSTALL_APPLY_COMMAND, "无法确定当前用户目录", Vec::new());
    };
    let response_skill_id = skill_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let plan = build_projection_removal_plan(&home, &skill_id, None)?;
        if plan.digest != expected_digest {
            return Err(LifecycleFailure::plan_stale(
                "Agent 投影状态在确认后发生变化",
            ));
        }
        if !plan.data.can_apply {
            return Err(LifecycleFailure::conflict(
                "系统 Skill 不可修改，或当前没有已启用投影",
            ));
        }
        crate::commands::uninstall_skill(skill_id)
            .map_err(|_| LifecycleFailure::outcome_unknown("卸载结果需要复核"))
    })
    .await;
    match result {
        Ok(Ok(())) => CliCommandOutput::success(
            UNINSTALL_APPLY_COMMAND,
            local_account(),
            json!({ "applied": true, "skillId": response_skill_id, "allAgentProjectionsRemoved": true, "managedSourceKept": true }),
            Vec::new(),
            vec!["使用 skillhub skill show --skill-id <id> --json 复核 Agent 状态".into()],
        ),
        Ok(Err(error)) => failure_output(
            UNINSTALL_APPLY_COMMAND,
            error,
            vec!["先复核所有 Agent 投影；不要盲目重复 apply".into()],
        ),
        Err(_) => outcome_unknown_failure(
            UNINSTALL_APPLY_COMMAND,
            "卸载任务异常结束，结果需要复核",
            vec!["使用 skillhub skill show --skill-id <id> --json 复核 Agent 状态".into()],
        ),
    }
}

async fn restore_version_preflight(
    skill_id: String,
    hash: String,
    receipt_id: Option<String>,
) -> CliCommandOutput {
    let Some(home) = crate::user_home_dir() else {
        return internal_failure(
            RESTORE_VERSION_PREFLIGHT_COMMAND,
            "无法确定当前用户目录",
            Vec::new(),
        );
    };
    match tauri::async_runtime::spawn_blocking(move || {
        build_version_restore_identity_plan_at(&home, &skill_id, &hash, receipt_id.as_deref())
    })
    .await
    {
        Ok(Ok(plan)) => {
            let mut warnings = Vec::new();
            if plan.data.has_working_changes {
                warnings.push(
                    "检测到未保存的 Skill 工作内容；CLI 不会执行恢复，请先创建快照或完成安全编辑"
                        .into(),
                );
            }
            if plan.data.has_pending_projection_edits {
                warnings.push(
                    "检测到尚未回写的 Agent 投影编辑；CLI 不会执行恢复，请先让 SkillHub 完成安全同步并创建快照"
                        .into(),
                );
            }
            let next_actions = if plan.data.can_apply {
                vec![
                    "向用户展示目标提交和本地改动影响，确认后原样传入 planDigest 执行 apply".into(),
                ]
            } else {
                Vec::new()
            };
            CliCommandOutput::success(
                RESTORE_VERSION_PREFLIGHT_COMMAND,
                local_account(),
                json!(plan.data),
                warnings,
                next_actions,
            )
        }
        Ok(Err(error)) => failure_output(RESTORE_VERSION_PREFLIGHT_COMMAND, error, Vec::new()),
        Err(_) => internal_failure(
            RESTORE_VERSION_PREFLIGHT_COMMAND,
            "版本恢复预检任务异常结束",
            Vec::new(),
        ),
    }
}

async fn restore_version_apply(
    skill_id: String,
    hash: String,
    receipt_id: Option<String>,
    expected_digest: String,
) -> CliCommandOutput {
    let Some(home) = crate::user_home_dir() else {
        return internal_failure(
            RESTORE_VERSION_APPLY_COMMAND,
            "无法确定当前用户目录",
            Vec::new(),
        );
    };
    let response_skill_id = skill_id.clone();
    let response_hash = hash.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let plan =
            build_version_restore_identity_plan_at(&home, &skill_id, &hash, receipt_id.as_deref())?;
        if plan.digest != expected_digest {
            return Err(LifecycleFailure::plan_stale(
                "Skill 内容或版本历史在确认后发生变化",
            ));
        }
        if !plan.data.can_apply {
            return Err(LifecycleFailure::conflict(
                "系统 Skill 不可恢复，或目标已是当前版本",
            ));
        }
        crate::commands::restore_skill_version(skill_id, hash, receipt_id)
            .map_err(|_| LifecycleFailure::outcome_unknown("版本恢复结果需要复核"))
    })
    .await;
    match result {
        Ok(Ok(())) => CliCommandOutput::success(
            RESTORE_VERSION_APPLY_COMMAND,
            local_account(),
            json!({ "applied": true, "skillId": response_skill_id, "restoredFromHash": response_hash, "restoreSnapshotCreated": true }),
            Vec::new(),
            vec!["使用 skillhub skill history --skill-id <id> --json 复核恢复快照".into()],
        ),
        Ok(Err(error)) => failure_output(
            RESTORE_VERSION_APPLY_COMMAND,
            error,
            vec!["先查询 history 与 working diff；不要盲目重复 apply".into()],
        ),
        Err(_) => outcome_unknown_failure(
            RESTORE_VERSION_APPLY_COMMAND,
            "版本恢复任务异常结束，结果需要复核",
            vec!["使用 history 与 working diff 复核真实状态".into()],
        ),
    }
}

async fn delete_preflight(skill_id: String) -> CliCommandOutput {
    let Some(home) = crate::user_home_dir() else {
        return internal_failure(
            DELETE_PREFLIGHT_COMMAND,
            "无法确定当前用户目录，删除预检没有执行",
            Vec::new(),
        );
    };
    match tauri::async_runtime::spawn_blocking(move || build_delete_plan_at(&home, &skill_id)).await
    {
        Ok(Ok(plan)) => delete_plan_success(plan),
        Ok(Err(error)) => failure_output(DELETE_PREFLIGHT_COMMAND, error, Vec::new()),
        Err(_) => internal_failure(
            DELETE_PREFLIGHT_COMMAND,
            "删除预检任务异常结束，没有执行删除",
            vec!["检查本机 Skill 状态后重新运行 preflight".into()],
        ),
    }
}

async fn delete_apply(skill_id: String, expected_digest: String) -> CliCommandOutput {
    let Some(home) = crate::user_home_dir() else {
        return internal_failure(
            DELETE_APPLY_COMMAND,
            "无法确定当前用户目录，删除没有执行",
            Vec::new(),
        );
    };
    let task_skill_id = skill_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let plan = build_delete_plan_at(&home, &task_skill_id).map_err(|error| {
            if error.kind == FailureKind::NotFound {
                LifecycleFailure::plan_stale("Skill 状态在确认后发生变化；删除没有执行，请重新预检")
            } else {
                error
            }
        })?;
        if plan.data.is_system {
            return Err(LifecycleFailure::permission(
                "系统 Skill 受保护，不能移入回收站",
            ));
        }
        if plan.digest != expected_digest {
            return Err(LifecycleFailure::plan_stale(
                "Skill 状态在确认后发生变化；删除没有执行，请重新预检",
            ));
        }
        if plan.data.account_synced {
            return Err(LifecycleFailure::permission(
                crate::library_sync::SYNCED_DEVICE_DELETE_REFUSED,
            ));
        }
        let transaction =
            crate::commands::delete_managed_skill(task_skill_id.clone()).map_err(|_| {
                LifecycleFailure::outcome_unknown("删除执行阶段失败，结果需要复核，不能自动重试")
            })?;
        let trash_id = public_id_from_delete_result(&home, &transaction)?;
        Ok(trash_id)
    })
    .await;
    match outcome {
        Ok(Ok(trash_id)) => CliCommandOutput::success(
            DELETE_APPLY_COMMAND,
            local_account(),
            json!({
                "deleted": true,
                "skillId": skill_id,
                "destination": "trash",
                "trashId": trash_id,
                "permanentlyDeleted": false,
            }),
            Vec::new(),
            vec!["使用 skillhub skill trash list --json 复核回收站记录".into()],
        ),
        Ok(Err(error)) => failure_output(
            DELETE_APPLY_COMMAND,
            error,
            vec![
                "先运行 skillhub skill list --json 与 skillhub skill trash list --json 复核真实状态；不要直接重试 apply".into(),
                "需要重试时重新运行 delete preflight 并使用新的 planDigest".into(),
            ],
        ),
        Err(_) => outcome_unknown_failure(
            DELETE_APPLY_COMMAND,
            "删除任务异常结束，结果需要复核，不能自动重试",
            vec![
                "先运行 skillhub skill list --json 与 skillhub skill trash list --json 复核真实状态".into(),
            ],
        ),
    }
}

async fn trash_list() -> CliCommandOutput {
    let Some(home) = crate::user_home_dir() else {
        return internal_failure(
            TRASH_LIST_COMMAND,
            "无法确定当前用户目录，不能读取回收站",
            Vec::new(),
        );
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        validate_trash_listing_roots(&home)?;
        crate::commands::list_trash_items()
            .map_err(|_| LifecycleFailure::internal("无法安全读取回收站"))
    })
    .await;
    match result {
        Ok(Ok(items)) => {
            let items = items.iter().map(public_trash_item).collect::<Vec<_>>();
            CliCommandOutput::success(
                TRASH_LIST_COMMAND,
                local_account(),
                json!({ "items": items, "count": items.len() }),
                Vec::new(),
                Vec::new(),
            )
        }
        Ok(Err(error)) => failure_output(
            TRASH_LIST_COMMAND,
            error,
            vec!["请在 SkillHub APP 中检查回收站".into()],
        ),
        Err(_) => internal_failure(
            TRASH_LIST_COMMAND,
            "回收站查询任务异常结束",
            vec!["请在 SkillHub APP 中检查回收站".into()],
        ),
    }
}

fn validate_trash_listing_roots(home: &Path) -> Result<(), LifecycleFailure> {
    let root = home.join(if crate::official_channel::CHANNEL == "dev" {
        ".skillhub-dev"
    } else {
        ".skillhub"
    });
    match fs::symlink_metadata(&root) {
        Ok(metadata) if !is_link_like(&root, &metadata) && metadata.is_dir() => {}
        Ok(_) => {
            return Err(LifecycleFailure::validation(
                "SkillHub 私有目录不是安全的真实目录",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(LifecycleFailure::internal("无法检查 SkillHub 私有目录")),
    }
    require_optional_real_directory(&root.join("trash"), "回收站目录不是安全的真实目录")?;
    require_optional_real_directory(
        &root.join("adoption-backups"),
        "收编备份目录不是安全的真实目录",
    )
}

async fn trash_restore_preflight(trash_id: String) -> CliCommandOutput {
    let Some(home) = crate::user_home_dir() else {
        return internal_failure(
            TRASH_RESTORE_PREFLIGHT_COMMAND,
            "无法确定当前用户目录，恢复预检没有执行",
            Vec::new(),
        );
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        validate_trash_listing_roots(&home)?;
        let items = crate::commands::list_trash_items()
            .map_err(|_| LifecycleFailure::internal("无法安全读取回收站"))?;
        let item = resolve_public_trash_item(&items, &trash_id)?;
        build_restore_plan_at(&home, item)
    })
    .await;
    match result {
        Ok(Ok(plan)) => restore_plan_success(plan),
        Ok(Err(error)) => failure_output(TRASH_RESTORE_PREFLIGHT_COMMAND, error, Vec::new()),
        Err(_) => internal_failure(
            TRASH_RESTORE_PREFLIGHT_COMMAND,
            "恢复预检任务异常结束，没有执行恢复",
            vec!["检查回收站后重新运行 preflight".into()],
        ),
    }
}

async fn trash_restore_apply(trash_id: String, expected_digest: String) -> CliCommandOutput {
    let Some(home) = crate::user_home_dir() else {
        return internal_failure(
            TRASH_RESTORE_APPLY_COMMAND,
            "无法确定当前用户目录，恢复没有执行",
            Vec::new(),
        );
    };
    let response_trash_id = trash_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        validate_trash_listing_roots(&home)?;
        let items = crate::commands::list_trash_items()
            .map_err(|_| LifecycleFailure::internal("无法安全读取回收站"))?;
        let item = resolve_public_trash_item(&items, &trash_id).map_err(|error| {
            if error.kind == FailureKind::NotFound {
                LifecycleFailure::plan_stale("回收站项目在确认后发生变化；恢复没有执行，请重新预检")
            } else {
                error
            }
        })?;
        let plan = build_restore_plan_at(&home, item)?;
        if plan.data.impact.target_occupied {
            return Err(LifecycleFailure::conflict(
                "恢复目标已被占用；恢复没有执行，请处理冲突后重新预检",
            ));
        }
        if !plan.data.can_apply || plan.digest != expected_digest {
            return Err(LifecycleFailure::plan_stale(
                "恢复目标或回收站项目在确认后发生变化；恢复没有执行，请重新预检",
            ));
        }
        crate::commands::restore_managed_trash_item_from_snapshot(plan.raw_id, plan.manifest)
            .map_err(|_| {
                LifecycleFailure::outcome_unknown("恢复执行阶段失败，结果需要复核，不能自动重试")
            })?;
        Ok(plan.data.skill_id)
    })
    .await;
    match result {
        Ok(Ok(skill_id)) => CliCommandOutput::success(
            TRASH_RESTORE_APPLY_COMMAND,
            local_account(),
            json!({ "restored": true, "trashId": response_trash_id, "skillId": skill_id }),
            Vec::new(),
            vec![format!(
                "使用 skillhub skill show --skill-id {skill_id} --json 复核恢复结果"
            )],
        ),
        Ok(Err(error)) => failure_output(
            TRASH_RESTORE_APPLY_COMMAND,
            error,
            vec![
                "先运行 skillhub skill trash list --json 与 skillhub skill list --json 复核真实状态；不要直接重试 apply".into(),
                "需要重试时重新运行 restore preflight 并使用新的 planDigest".into(),
            ],
        ),
        Err(_) => outcome_unknown_failure(
            TRASH_RESTORE_APPLY_COMMAND,
            "恢复任务异常结束，结果需要复核，不能自动重试",
            vec![
                "先运行 skillhub skill trash list --json 与 skillhub skill list --json 复核真实状态".into(),
            ],
        ),
    }
}

fn delete_plan_success(plan: DeletePlan) -> CliCommandOutput {
    let mut warnings = Vec::new();
    let mut next_actions = Vec::new();
    if plan.data.is_system {
        warnings.push("这是受保护的系统 Skill，不能删除".into());
        next_actions.push("保留系统 Skill；如检测异常请使用 SkillHub APP 修复".into());
    } else if plan.data.account_synced {
        warnings.push(crate::library_sync::SYNCED_DEVICE_DELETE_REFUSED.into());
        next_actions.push(
            "请用户在 SkillHub APP 中打开该 Skill，选择「删除…」→「从我的账号删除」；所有设备都会移入回收站，可在账号回收站恢复".into(),
        );
    } else {
        warnings.push("执行后 Skill、受管投影和关联本机环境配置将移入回收站".into());
        next_actions.push("向用户展示影响；确认后执行 delete apply，并原样传入 planDigest".into());
    }
    let data = serde_json::to_value(plan.data).unwrap_or_else(|_| json!({}));
    CliCommandOutput::success(
        DELETE_PREFLIGHT_COMMAND,
        local_account(),
        data,
        warnings,
        next_actions,
    )
}

fn restore_plan_success(plan: RestorePlan) -> CliCommandOutput {
    let mut warnings = Vec::new();
    let mut next_actions = Vec::new();
    if plan.data.impact.target_occupied {
        warnings.push("恢复目标已被占用，当前计划不可执行".into());
        next_actions.push("先在 SkillHub APP 中处理同名目标，再重新预检".into());
    } else if !plan.data.can_apply {
        warnings.push("此回收站项目当前不能由 CLI 安全恢复".into());
        next_actions.push("请在 SkillHub APP 中查看该回收站项目".into());
    } else {
        next_actions.push("向用户展示影响；确认后执行 restore apply，并原样传入 planDigest".into());
    }
    let data = serde_json::to_value(plan.data).unwrap_or_else(|_| json!({}));
    CliCommandOutput::success(
        TRASH_RESTORE_PREFLIGHT_COMMAND,
        local_account(),
        data,
        warnings,
        next_actions,
    )
}

fn build_delete_plan_at(home: &Path, skill_id: &str) -> Result<DeletePlan, LifecycleFailure> {
    if !valid_skill_id(skill_id) {
        return Err(LifecycleFailure::validation("Skill id 无效"));
    }
    let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
        ".skillhub-dev"
    } else {
        ".skillhub"
    });
    let managed_root = skillhub_root.join("skills");
    require_real_directory(&skillhub_root, "SkillHub 私有目录不可安全读取")?;
    require_real_directory(&managed_root, "SkillHub 托管目录不可安全读取")?;
    let skill_root = managed_root.join(skill_id);
    match fs::symlink_metadata(&skill_root) {
        Ok(metadata) if !is_link_like(&skill_root, &metadata) && metadata.is_dir() => {}
        Ok(_) => {
            return Err(LifecycleFailure::validation(
                "目标 Skill 不是安全的真实目录",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(LifecycleFailure::not_found("本机不存在目标 Skill"))
        }
        Err(_) => return Err(LifecycleFailure::internal("无法检查目标 Skill")),
    }

    let tree = summarize_tree(&skill_root)?;
    if skill_root.join(".skillhub.json").exists() {
        let scoped = crate::commands::library_read_profile_readonly(&skill_root)
            .map_err(|_| LifecycleFailure::validation("无法安全读取 Skill 归属"))?;
        crate::spaces::require_profile_at(&skillhub_root, &scoped)
            .map_err(|_| LifecycleFailure::validation("此 Skill 属于其他空间或账号"))?;
    }
    let profile = read_profile_summary(&skill_root, skill_id)?;
    let working = working_copy_summary(&skill_root)?;
    let projection = projection_summary(home, &skillhub_root, &managed_root, skill_id, &profile)?;
    let environment = environment_summary(&skillhub_root, skill_id)?;
    let is_system = skill_id == crate::system_skill::SYSTEM_MANAGER_ID || profile.is_system;

    let mut digest = Sha256::new();
    digest_field(&mut digest, b"skillhub-delete-plan-v1");
    digest_field(&mut digest, skill_id.as_bytes());
    digest_field(&mut digest, profile.display_name.as_bytes());
    digest_field(&mut digest, profile.version.as_bytes());
    digest_field(&mut digest, profile.projection_name.as_bytes());
    digest_field(&mut digest, tree.fingerprint.as_bytes());
    digest_field(&mut digest, &[u8::from(is_system)]);
    digest_field(&mut digest, &[u8::from(working.has_changes)]);
    digest_field(&mut digest, &working.change_count.to_le_bytes());
    digest_field(&mut digest, &working.fingerprint);
    digest_field(
        &mut digest,
        projection.installed_agents.join("\0").as_bytes(),
    );
    digest_field(
        &mut digest,
        &projection.foreign_same_name_count.to_le_bytes(),
    );
    digest_field(&mut digest, &[u8::from(projection.has_internal_projection)]);
    digest_field(&mut digest, &[u8::from(projection.has_pending_edits)]);
    digest_field(&mut digest, &projection.fingerprint);
    digest_field(&mut digest, &environment.fingerprint);
    let plan_digest = format!("{:x}", digest.finalize());
    let account_synced = crate::library_sync::folder_synced_to_signed_in_account(&skill_root);
    let data = DeletePlanData {
        skill_id: skill_id.to_string(),
        display_name: profile.display_name,
        version: profile.version,
        is_system,
        account_synced,
        can_apply: !is_system && !account_synced,
        requires_explicit_apply: true,
        plan_digest: plan_digest.clone(),
        impact: DeleteImpact {
            file_count: tree.file_count,
            directory_count: tree.directory_count,
            total_bytes: tree.total_bytes,
            latest_modified_at_unix: tree.latest_modified_at_unix,
            installed_agents: projection.installed_agents,
            foreign_same_name_count: projection.foreign_same_name_count,
            has_internal_projection: projection.has_internal_projection,
            has_working_changes: working.has_changes,
            working_change_count: working.change_count,
            environment_file_count: environment.file_count,
            moves_to_trash: true,
            permanently_deletes: false,
        },
    };
    Ok(DeletePlan {
        data,
        digest: plan_digest,
        has_pending_projection_edits: projection.has_pending_edits,
    })
}

fn build_restore_plan_at(home: &Path, item: &TrashItem) -> Result<RestorePlan, LifecycleFailure> {
    let public_id = public_trash_id(&item.id);
    if item.kind != "managed_asset" || !item.id.starts_with("managed:") {
        return Err(LifecycleFailure::permission(
            "此类回收站项目需要在 SkillHub APP 中恢复",
        ));
    }
    if !valid_skill_id(&item.skill_id) || item.skill_id == crate::system_skill::SYSTEM_MANAGER_ID {
        return Err(LifecycleFailure::validation("回收站项目的 Skill 身份无效"));
    }
    let segment = item
        .id
        .strip_prefix("managed:")
        .filter(|segment| valid_recovery_segment(segment))
        .ok_or_else(|| LifecycleFailure::validation("回收站项目身份无效"))?;
    let skillhub_root = home.join(if crate::official_channel::CHANNEL == "dev" {
        ".skillhub-dev"
    } else {
        ".skillhub"
    });
    let trash_root = skillhub_root.join("trash");
    require_real_directory(&skillhub_root, "SkillHub 私有目录不可安全读取")?;
    require_real_directory(&trash_root, "回收站目录不可安全读取")?;
    let transaction = PathBuf::from(&item.location);
    if transaction.parent() != Some(trash_root.as_path())
        || transaction.file_name().and_then(|value| value.to_str()) != Some(segment)
    {
        return Err(LifecycleFailure::validation("回收站项目不在允许的位置"));
    }
    require_real_directory(&transaction, "回收站项目不是安全目录")?;
    let recovery = inspect_managed_recovery(&skillhub_root, &transaction, item)?;
    let tree = summarize_tree(&recovery.skill_source)?;
    let recovered_working_copy = working_copy_summary(&recovery.skill_source)?;
    let target_occupied = recovery.occupied_target_count > 0;
    let can_apply = item.restorable && item.status == "trashed" && !target_occupied;

    let mut digest = Sha256::new();
    digest_field(&mut digest, b"skillhub-trash-restore-plan-v1");
    digest_field(&mut digest, item.id.as_bytes());
    digest_field(&mut digest, item.skill_id.as_bytes());
    digest_field(&mut digest, item.status.as_bytes());
    digest_field(&mut digest, &[u8::from(item.restorable)]);
    digest_field(&mut digest, &[u8::from(target_occupied)]);
    digest_field(&mut digest, &recovery.fingerprint);
    digest_field(&mut digest, tree.fingerprint.as_bytes());
    digest_field(&mut digest, &recovered_working_copy.fingerprint);
    let plan_digest = format!("{:x}", digest.finalize());
    let data = RestorePlanData {
        trash_id: public_id,
        kind: "managed_asset".into(),
        skill_id: item.skill_id.clone(),
        display_name: safe_display_name(&item.display_name, &item.skill_id),
        status: safe_identifier(&item.status).unwrap_or_else(|| "unknown".into()),
        can_apply,
        requires_explicit_apply: true,
        plan_digest: plan_digest.clone(),
        impact: RestoreImpact {
            file_count: tree.file_count,
            directory_count: tree.directory_count,
            total_bytes: tree.total_bytes,
            latest_modified_at_unix: tree.latest_modified_at_unix,
            target_occupied,
            target_count: recovery.target_count,
            occupied_target_count: recovery.occupied_target_count,
            environment_file_count: recovery.environment_file_count,
            restores_projection: recovery.restores_projection,
            restores_managed_skill: true,
        },
    };
    Ok(RestorePlan {
        raw_id: item.id.clone(),
        manifest: recovery.manifest,
        data,
        digest: plan_digest,
    })
}

fn inspect_managed_recovery(
    skillhub_root: &Path,
    transaction: &Path,
    item: &TrashItem,
) -> Result<RecoveryInspection, LifecycleFailure> {
    let (manifest, manifest_fingerprint) =
        read_recovery_manifest_summary(&transaction.join("recovery-manifest.json"))?;
    if manifest.get("version").and_then(serde_json::Value::as_u64) != Some(2)
        || manifest.get("kind").and_then(serde_json::Value::as_str) != Some("managed_asset")
        || manifest.get("status").and_then(serde_json::Value::as_str) != Some(item.status.as_str())
        || manifest.get("skillId").and_then(serde_json::Value::as_str)
            != Some(item.skill_id.as_str())
    {
        return Err(LifecycleFailure::validation(
            "回收站清单与项目身份或状态不一致",
        ));
    }
    if manifest
        .get("skillRecoveryPath")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("skill")
        != "skill"
    {
        return Err(LifecycleFailure::validation(
            "回收站清单包含不受支持的 Skill 恢复路径",
        ));
    }

    let skills_root = skillhub_root.join("skills");
    require_real_directory(&skills_root, "SkillHub 托管目录不可安全读取")?;
    let mut destinations = HashSet::new();
    let mut occupied_target_count = 0usize;
    let skill_target = skills_root.join(&item.skill_id);
    let skill_occupied =
        inspect_restore_destination(&skill_target, &mut destinations, &mut occupied_target_count)?;

    let mut digest = Sha256::new();
    digest_field(&mut digest, b"skillhub-managed-recovery-v1");
    digest_field(&mut digest, &manifest_fingerprint);
    digest_field(&mut digest, b"target:skill");
    digest_field(&mut digest, &[u8::from(skill_occupied)]);

    let projection_value = manifest.get("projectionRecoveryPath");
    let restores_projection = match projection_value {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::String(value)) if value == "projection" => true,
        _ => {
            return Err(LifecycleFailure::validation(
                "回收站清单包含不受支持的投影恢复路径",
            ))
        }
    };
    if restores_projection {
        let recovered_projection = transaction.join("projection");
        let projections_root = skillhub_root.join("projections");
        require_optional_real_directory(&projections_root, "Skill 投影目录不可安全写入")?;
        let projection_target = projections_root.join(&item.skill_id);
        let projection_fingerprint = summarize_projection_recovery(
            &recovered_projection,
            &projection_target,
            &skill_target,
            &transaction.join("skill"),
        )?;
        digest_field(&mut digest, b"source:projection");
        digest_field(&mut digest, projection_fingerprint.as_bytes());

        let projection_occupied = inspect_restore_destination(
            &projection_target,
            &mut destinations,
            &mut occupied_target_count,
        )?;
        digest_field(&mut digest, b"target:projection");
        digest_field(&mut digest, &[u8::from(projection_occupied)]);
    }

    let env_values = match manifest.get("envFiles") {
        None => &[][..],
        Some(serde_json::Value::Array(values)) if values.len() <= MAX_RECOVERY_ENV_FILES => values,
        Some(serde_json::Value::Array(_)) => {
            return Err(LifecycleFailure::validation(
                "回收站环境配置数量超过安全上限",
            ))
        }
        _ => return Err(LifecycleFailure::validation("回收站环境配置清单无效")),
    };
    let envs_root = skillhub_root.join("envs");
    if !env_values.is_empty() {
        require_optional_real_directory(&envs_root, "环境配置目录不可安全写入")?;
        require_real_directory(
            &transaction.join("env"),
            "回收站环境配置目录不是安全的真实目录",
        )?;
    }
    let mut recovery_sources = HashSet::new();
    for (index, value) in env_values.iter().enumerate() {
        let recovery_path = value
            .get("recoveryPath")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| LifecycleFailure::validation("回收站环境配置恢复路径无效"))?;
        let expected_recovery_path = format!("env/{index}.env");
        if recovery_path != expected_recovery_path || !recovery_sources.insert(recovery_path) {
            return Err(LifecycleFailure::validation(
                "回收站环境配置恢复路径不安全或重复",
            ));
        }
        let original = value
            .get("originalRelativePath")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| allowed_environment_destination(skillhub_root, &item.skill_id, value))
            .ok_or_else(|| LifecycleFailure::validation("回收站环境配置目标路径无效"))?;
        if let Some(parent) = original.parent() {
            require_optional_real_directory(parent, "账号环境配置目录不可安全写入")?;
        }
        let environment_occupied =
            inspect_restore_destination(&original, &mut destinations, &mut occupied_target_count)?;
        let recovered = transaction.join(recovery_path);
        let metadata = require_real_file(&recovered, "回收站环境配置不是安全的普通文件")?;
        if metadata.len() > MAX_ENV_FILE_BYTES {
            return Err(LifecycleFailure::validation("回收站环境配置超过安全上限"));
        }
        digest_field(&mut digest, b"source:environment");
        digest_field(&mut digest, recovery_path.as_bytes());
        digest_field(
            &mut digest,
            original_relative_key(skillhub_root, &original)?.as_bytes(),
        );
        digest_field(&mut digest, &metadata.len().to_le_bytes());
        digest_field(&mut digest, &modified_key(&metadata));
        hash_regular_file(&recovered, &metadata, &mut digest)?;
        digest_field(&mut digest, b"target:environment");
        digest_field(&mut digest, &[u8::from(environment_occupied)]);
    }

    let environment_file_count = env_values.len();
    Ok(RecoveryInspection {
        skill_source: transaction.join("skill"),
        manifest,
        fingerprint: digest.finalize().to_vec(),
        target_count: destinations.len(),
        occupied_target_count,
        environment_file_count,
        restores_projection,
    })
}

fn inspect_restore_destination(
    path: &Path,
    destinations: &mut HashSet<PathBuf>,
    occupied_count: &mut usize,
) -> Result<bool, LifecycleFailure> {
    if !destinations.insert(path.to_path_buf()) {
        return Err(LifecycleFailure::validation("回收站清单包含重复的恢复目标"));
    }
    let occupied = path_exists_safely(path)?;
    if occupied {
        *occupied_count = occupied_count.saturating_add(1);
    }
    Ok(occupied)
}

fn path_exists_safely(path: &Path) -> Result<bool, LifecycleFailure> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(LifecycleFailure::internal("无法检查恢复目标")),
    }
}

fn require_optional_real_directory(
    path: &Path,
    message: &'static str,
) -> Result<(), LifecycleFailure> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !is_link_like(path, &metadata) && metadata.is_dir() => Ok(()),
        Ok(_) => Err(LifecycleFailure::validation(message)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(LifecycleFailure::internal(message)),
    }
}

fn require_real_file(path: &Path, message: &'static str) -> Result<fs::Metadata, LifecycleFailure> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !is_link_like(path, &metadata) && metadata.is_file() => Ok(metadata),
        Ok(_) => Err(LifecycleFailure::validation(message)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(LifecycleFailure::validation(message))
        }
        Err(_) => Err(LifecycleFailure::internal(message)),
    }
}

fn allowed_environment_destination(
    skillhub_root: &Path,
    skill_id: &str,
    value: &str,
) -> Option<PathBuf> {
    let path = Path::new(value);
    if path.is_absolute() {
        return None;
    }
    let components = path
        .components()
        .map(|component| match component {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    let expected_file = format!("{skill_id}.env");
    let valid = match components.as_slice() {
        ["envs", file] => *file == expected_file,
        ["envs", user_id, file] => {
            uuid::Uuid::parse_str(user_id).is_ok_and(|parsed| parsed.to_string() == *user_id)
                && *file == expected_file
        }
        _ => false,
    };
    valid.then(|| skillhub_root.join(path))
}

fn original_relative_key(root: &Path, path: &Path) -> Result<String, LifecycleFailure> {
    normalized_relative(
        path.strip_prefix(root)
            .map_err(|_| LifecycleFailure::validation("回收站环境配置目标路径无效"))?,
    )
}

struct ProjectionSummary {
    installed_agents: Vec<String>,
    foreign_same_name_count: usize,
    has_internal_projection: bool,
    has_pending_edits: bool,
    fingerprint: Vec<u8>,
}

struct ProjectionDirectorySummary {
    fingerprint: String,
    has_pending_edits: bool,
}

struct ProjectionGenerationSummary {
    fingerprint: String,
    has_pending_edits: bool,
}

fn projection_summary(
    home: &Path,
    skillhub_root: &Path,
    managed_root: &Path,
    skill_id: &str,
    profile: &ProfileSummary,
) -> Result<ProjectionSummary, LifecycleFailure> {
    if !valid_skill_id(&profile.projection_name) {
        return Err(LifecycleFailure::validation(
            "Skill 的 Agent 投影名称不安全",
        ));
    }
    let canonical = managed_root.join(skill_id);
    let generated = skillhub_root
        .join("projections")
        .join(skill_id)
        .join("current");
    let projection_root = skillhub_root.join("projections").join(skill_id);
    let (has_internal_projection, internal_projection_fingerprint, has_pending_edits) =
        match fs::symlink_metadata(&projection_root) {
            Ok(metadata) if !is_link_like(&projection_root, &metadata) && metadata.is_dir() => {
                let summary = summarize_projection_directory(
                    &projection_root,
                    &projection_root,
                    &canonical,
                    &canonical,
                    true,
                    false,
                )?;
                (true, summary.fingerprint, summary.has_pending_edits)
            }
            Ok(_) => return Err(LifecycleFailure::validation("Skill 的内部投影不是安全目录")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (false, String::new(), false)
            }
            Err(_) => return Err(LifecycleFailure::internal("无法检查 Skill 投影")),
        };
    let mut installed_agents = Vec::new();
    let mut foreign_same_name_count = 0;
    for (key, _, relative) in crate::known_agents() {
        let target = home.join(relative).join(&profile.projection_name);
        if crate::platform_fs::projection_resource_matches(&target, &canonical)
            || crate::platform_fs::projection_resource_matches(&target, &generated)
        {
            installed_agents.push(key.to_string());
        } else {
            match fs::symlink_metadata(&target) {
                Ok(_) => foreign_same_name_count += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(LifecycleFailure::internal("无法检查 Agent 投影")),
            }
        }
    }
    installed_agents.sort();
    installed_agents.dedup();
    let mut digest = Sha256::new();
    digest_field(&mut digest, b"skillhub-delete-projection-summary-v1");
    digest_field(&mut digest, &[u8::from(has_internal_projection)]);
    digest_field(&mut digest, internal_projection_fingerprint.as_bytes());
    Ok(ProjectionSummary {
        installed_agents,
        foreign_same_name_count,
        has_internal_projection,
        has_pending_edits,
        fingerprint: digest.finalize().to_vec(),
    })
}

struct EnvironmentSummary {
    file_count: usize,
    fingerprint: Vec<u8>,
}

fn environment_summary(
    skillhub_root: &Path,
    skill_id: &str,
) -> Result<EnvironmentSummary, LifecycleFailure> {
    let root = if skillhub_root.join("runtime/session.json").exists() {
        let session = crate::runtime_env::runtime_session_snapshot_at(skillhub_root)
            .map_err(|_| LifecycleFailure::validation("无法安全读取活动空间"))?;
        if session.is_sync_pending() {
            return Err(LifecycleFailure::validation(crate::spaces::STALE));
        }
        session
            .storage_root(skillhub_root)
            .join("envs")
            .join(session.user_id())
    } else {
        skillhub_root.join("envs")
    };
    let mut digest = Sha256::new();
    digest_field(&mut digest, b"skillhub-delete-env-summary-v1");
    let metadata = match fs::symlink_metadata(&root) {
        Ok(metadata) if !is_link_like(&root, &metadata) && metadata.is_dir() => metadata,
        Ok(_) => {
            return Err(LifecycleFailure::validation(
                "环境配置目录不是安全的真实目录",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(EnvironmentSummary {
                file_count: 0,
                fingerprint: digest.finalize().to_vec(),
            })
        }
        Err(_) => return Err(LifecycleFailure::internal("无法检查环境配置目录")),
    };
    let _ = metadata;
    let candidates = [root.join(format!("{skill_id}.env"))];
    let mut file_count = 0;
    for path in candidates {
        match fs::symlink_metadata(&path) {
            Ok(metadata) if !is_link_like(&path, &metadata) && metadata.is_file() => {
                if metadata.len() > MAX_ENV_FILE_BYTES {
                    return Err(LifecycleFailure::validation("环境配置项超过安全大小上限"));
                }
                file_count += 1;
                let relative = original_relative_key(skillhub_root, &path)?;
                digest_field(&mut digest, relative.as_bytes());
                digest_field(&mut digest, &metadata.len().to_le_bytes());
                digest_field(&mut digest, &modified_key(&metadata));
                hash_regular_file(&path, &metadata, &mut digest)?;
            }
            Ok(_) => return Err(LifecycleFailure::validation("环境配置项不是安全的普通文件")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(LifecycleFailure::internal("无法检查环境配置项")),
        }
    }
    Ok(EnvironmentSummary {
        file_count,
        fingerprint: digest.finalize().to_vec(),
    })
}

fn read_profile_summary(
    skill_root: &Path,
    skill_id: &str,
) -> Result<ProfileSummary, LifecycleFailure> {
    let contents = read_bounded_regular(&skill_root.join(".skillhub.json"), MAX_PROFILE_BYTES)?;
    let Some(contents) = contents else {
        return Ok(ProfileSummary {
            display_name: skill_id.to_string(),
            version: "unknown".into(),
            projection_name: skill_id.to_string(),
            is_system: false,
        });
    };
    let sidecar: SkillHubJson = serde_json::from_slice(&contents)
        .map_err(|_| LifecycleFailure::validation("Skill Profile 不是有效 JSON"))?;
    let Some(profile) = sidecar.skillhub else {
        return Err(LifecycleFailure::validation(
            "Skill Profile 缺少 skillhub 数据",
        ));
    };
    Ok(ProfileSummary {
        display_name: safe_display_name(
            profile.display_name.as_deref().unwrap_or(skill_id),
            skill_id,
        ),
        version: safe_version(&profile.version),
        projection_name: profile.name.unwrap_or_else(|| skill_id.to_string()),
        is_system: profile.is_system,
    })
}

fn working_copy_summary(skill_root: &Path) -> Result<WorkingCopySummary, LifecycleFailure> {
    let Ok(repo) = Repository::open(skill_root) else {
        let mut digest = Sha256::new();
        digest_field(&mut digest, b"skillhub-working-copy-none-v1");
        return Ok(WorkingCopySummary {
            has_changes: false,
            change_count: 0,
            fingerprint: digest.finalize().to_vec(),
        });
    };
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|_| LifecycleFailure::internal("无法读取 Skill 工作区状态"))?;
    let mut changes = statuses
        .iter()
        .filter(|entry| entry.path() != Ok(".skillhub.json"))
        .map(|entry| {
            (
                entry.path().unwrap_or("<unknown>").to_string(),
                entry.status().bits(),
            )
        })
        .collect::<Vec<_>>();
    changes.sort();
    let mut digest = Sha256::new();
    digest_field(&mut digest, b"skillhub-working-copy-v1");
    if let Ok(head) = repo.head() {
        if let Some(target) = head.target() {
            digest_field(&mut digest, target.to_string().as_bytes());
        }
    }
    for (path, status) in &changes {
        digest_field(&mut digest, path.as_bytes());
        digest_field(&mut digest, &status.to_le_bytes());
    }
    Ok(WorkingCopySummary {
        has_changes: !changes.is_empty(),
        change_count: changes.len().min(u32::MAX as usize) as u32,
        fingerprint: digest.finalize().to_vec(),
    })
}

fn summarize_tree(root: &Path) -> Result<TreeSummary, LifecycleFailure> {
    summarize_tree_with_git_policy(root, true)
}

fn summarize_projection_recovery(
    root: &Path,
    expected_live_root: &Path,
    expected_source_root: &Path,
    recovered_source_root: &Path,
) -> Result<String, LifecycleFailure> {
    summarize_projection_directory(
        root,
        expected_live_root,
        expected_source_root,
        recovered_source_root,
        false,
        true,
    )
    .map(|summary| summary.fingerprint)
}

fn summarize_projection_directory(
    root: &Path,
    expected_live_root: &Path,
    expected_source_root: &Path,
    actual_source_root: &Path,
    allow_conflict_record: bool,
    source_was_moved: bool,
) -> Result<ProjectionDirectorySummary, LifecycleFailure> {
    require_real_directory(root, "回收站投影不是安全的真实目录")?;
    let entries =
        fs::read_dir(root).map_err(|_| LifecycleFailure::internal("无法读取回收站投影"))?;
    let mut entries = entries
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| LifecycleFailure::internal("无法读取回收站投影"))?;
    if entries.len() > MAX_TREE_ENTRIES {
        return Err(LifecycleFailure::validation("回收站投影条目超过安全上限"));
    }
    entries.sort_by_key(|entry| entry.file_name());
    let mut digest = Sha256::new();
    digest_field(&mut digest, b"skillhub-recovery-projection-v1");
    let mut generations = HashSet::new();
    let mut current_target = None;
    let mut recovery_link_targets = Vec::new();
    let mut has_pending_edits = false;
    for entry in entries {
        let name = entry
            .file_name()
            .to_str()
            .map(str::to_string)
            .ok_or_else(|| LifecycleFailure::validation("回收站投影名称不是有效 UTF-8"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| LifecycleFailure::validation("回收站投影在读取时发生变化"))?;
        if name == "current" || valid_projection_recovery_link(&name) {
            if !is_link_like(&path, &metadata) {
                return Err(LifecycleFailure::validation("回收站投影选择项不是安全链接"));
            }
            let target = read_projection_link_target(&path)?;
            let target_name = projection_generation_target(&target, expected_live_root)
                .ok_or_else(|| LifecycleFailure::validation("回收站投影链接目标无效"))?;
            let final_metadata = fs::symlink_metadata(&path)
                .map_err(|_| LifecycleFailure::validation("回收站投影链接在读取时发生变化"))?;
            if !is_link_like(&path, &final_metadata)
                || final_metadata.dev() != metadata.dev()
                || final_metadata.ino() != metadata.ino()
                || modified_key(&final_metadata) != modified_key(&metadata)
            {
                return Err(LifecycleFailure::validation(
                    "回收站投影链接在读取时发生变化",
                ));
            }
            digest_field(
                &mut digest,
                if name == "current" {
                    b"current"
                } else {
                    b"recovery-link"
                },
            );
            digest_field(&mut digest, name.as_bytes());
            digest_field(&mut digest, target_name.as_bytes());
            if name == "current" {
                current_target = Some(target_name);
            } else {
                recovery_link_targets.push(target_name);
            }
            continue;
        }
        if allow_conflict_record && name == "conflict.json" {
            if is_link_like(&path, &metadata)
                || !metadata.is_file()
                || metadata.len() > MAX_PROFILE_BYTES
            {
                return Err(LifecycleFailure::validation(
                    "Skill 投影冲突记录不是安全的普通文件",
                ));
            }
            digest_field(&mut digest, b"conflict");
            digest_field(&mut digest, &metadata.len().to_le_bytes());
            digest_field(&mut digest, &modified_key(&metadata));
            hash_regular_file(&path, &metadata, &mut digest)?;
            continue;
        }
        if name == "recovery" {
            if is_link_like(&path, &metadata) || !metadata.is_dir() {
                return Err(LifecycleFailure::validation(
                    "Skill 投影恢复目录不是安全的真实目录",
                ));
            }
            let summary = summarize_tree_with_git_policy(&path, false)?;
            digest_field(&mut digest, b"recovery-directory");
            digest_field(&mut digest, summary.fingerprint.as_bytes());
            continue;
        }
        if !valid_projection_generation(&name)
            || is_link_like(&path, &metadata)
            || !metadata.is_dir()
        {
            return Err(LifecycleFailure::validation("回收站投影包含不受支持的项目"));
        }
        let summary = summarize_projection_generation(
            &path,
            &name,
            expected_source_root,
            actual_source_root,
            source_was_moved,
        )?;
        has_pending_edits |= summary.has_pending_edits;
        digest_field(&mut digest, b"generation");
        digest_field(&mut digest, name.as_bytes());
        digest_field(&mut digest, summary.fingerprint.as_bytes());
        generations.insert(name);
    }
    let current_target = current_target
        .filter(|target| generations.contains(target))
        .ok_or_else(|| LifecycleFailure::validation("回收站投影缺少有效 current 目标"))?;
    digest_field(&mut digest, b"selected");
    digest_field(&mut digest, current_target.as_bytes());
    if recovery_link_targets
        .iter()
        .any(|target| !generations.contains(target))
    {
        return Err(LifecycleFailure::validation("回收站投影恢复链接目标无效"));
    }
    Ok(ProjectionDirectorySummary {
        fingerprint: format!("{:x}", digest.finalize()),
        has_pending_edits,
    })
}

fn summarize_projection_generation(
    generation: &Path,
    generation_name: &str,
    expected_source_root: &Path,
    actual_source_root: &Path,
    source_was_moved: bool,
) -> Result<ProjectionGenerationSummary, LifecycleFailure> {
    require_real_directory(actual_source_root, "Skill 投影对应的托管内容不是安全目录")?;
    let expected_source_root = canonical_path_allowing_missing_leaf(expected_source_root)?;
    let marker_path = generation.join(PROJECTION_MARKER_NAME);
    let marker_bytes = read_bounded_regular(&marker_path, MAX_PROJECTION_MARKER_BYTES)?
        .ok_or_else(|| LifecycleFailure::validation("Skill 投影缺少安全 marker"))?;
    let marker: ProjectionMarkerSummary = serde_json::from_slice(&marker_bytes)
        .map_err(|_| LifecycleFailure::validation("Skill 投影 marker 不是有效 JSON"))?;
    let expected_skill_id = expected_source_root
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| LifecycleFailure::validation("Skill 投影来源标识无效"))?;
    if !projection_marker_is_structurally_valid(&marker)
        || marker.skill_id != expected_skill_id
        || marker.generation != generation_name
        || !declared_path_matches(Path::new(&marker.source_root), &expected_source_root)
    {
        return Err(LifecycleFailure::validation(
            "Skill 投影 marker 与托管内容不一致",
        ));
    }

    let expected_resources = marker
        .resource_names
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    if expected_resources.len() != marker.resource_names.len() {
        return Err(LifecycleFailure::validation(
            "Skill 投影资源清单包含重复项目",
        ));
    }
    let mut entries = fs::read_dir(generation)
        .map_err(|_| LifecycleFailure::internal("无法读取 Skill 投影 generation"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| LifecycleFailure::internal("无法读取 Skill 投影 generation"))?;
    if entries.len() > MAX_TREE_ENTRIES {
        return Err(LifecycleFailure::validation(
            "Skill 投影 generation 条目超过安全上限",
        ));
    }
    entries.sort_by_key(|entry| entry.file_name());
    let actual_names = entries
        .iter()
        .map(|entry| {
            entry
                .file_name()
                .to_str()
                .map(str::to_string)
                .ok_or_else(|| LifecycleFailure::validation("Skill 投影名称不是有效 UTF-8"))
        })
        .collect::<Result<HashSet<_>, _>>()?;
    if actual_names.len() != entries.len()
        || !actual_names.contains("SKILL.md")
        || !actual_names.contains(PROJECTION_MARKER_NAME)
        || actual_names.len() != marker.resource_names.len() + 2
        || !marker
            .resource_names
            .iter()
            .all(|name| actual_names.contains(name))
    {
        return Err(LifecycleFailure::validation(
            "Skill 投影 generation 根目录结构无效",
        ));
    }

    let projected_skill = read_bounded_regular(&generation.join("SKILL.md"), MAX_FILE_BYTES)?
        .ok_or_else(|| LifecycleFailure::validation("Skill 投影缺少安全 SKILL.md"))?;
    let has_pending_edits =
        format!("{:x}", Sha256::digest(&projected_skill)) != marker.rendered_skill_md_sha256;
    let mut digest = Sha256::new();
    digest_field(&mut digest, b"skillhub-projection-generation-v2");
    digest_field(&mut digest, marker_bytes.as_slice());
    digest_field(&mut digest, projected_skill.as_slice());
    for name in &marker.resource_names {
        let projected = generation.join(name);
        let source = actual_source_root.join(name);
        let source_metadata = fs::symlink_metadata(&source)
            .map_err(|_| LifecycleFailure::validation("Skill 投影资源来源不存在"))?;
        if is_link_like(&source, &source_metadata)
            || (!source_metadata.is_file() && !source_metadata.is_dir())
        {
            return Err(LifecycleFailure::validation(
                "Skill 投影资源来源不是安全文件或目录",
            ));
        }
        let initial = fs::symlink_metadata(&projected)
            .map_err(|_| LifecycleFailure::validation("Skill 投影资源不存在"))?;
        let linked = is_link_like(&projected, &initial);
        let resource_matches = if linked {
            let target = read_projection_link_target(&projected)?;
            let expected_target = expected_source_root.join(name);
            declared_path_matches(&target, &expected_target)
                && (source_was_moved
                    || crate::platform_fs::projection_resource_matches(&projected, &source))
        } else {
            #[cfg(windows)]
            {
                source_metadata.is_file()
                    && crate::platform_fs::projection_resource_matches(&projected, &source)
            }
            #[cfg(not(windows))]
            {
                false
            }
        };
        if !resource_matches {
            return Err(LifecycleFailure::validation("Skill 投影资源链接目标无效"));
        }
        let final_metadata = fs::symlink_metadata(&projected)
            .map_err(|_| LifecycleFailure::validation("Skill 投影资源在读取时发生变化"))?;
        if is_link_like(&projected, &final_metadata) != linked
            || final_metadata.dev() != initial.dev()
            || final_metadata.ino() != initial.ino()
            || modified_key(&final_metadata) != modified_key(&initial)
        {
            return Err(LifecycleFailure::validation(
                "Skill 投影资源在读取时发生变化",
            ));
        }
        digest_field(&mut digest, b"resource");
        digest_field(&mut digest, name.as_bytes());
        digest_field(&mut digest, &[u8::from(source_metadata.is_dir())]);
        if linked {
            let target = read_projection_link_target(&projected)?;
            digest_field(&mut digest, target.to_string_lossy().as_bytes());
        } else {
            digest_field(&mut digest, b"hard-link");
        }
    }
    Ok(ProjectionGenerationSummary {
        fingerprint: format!("{:x}", digest.finalize()),
        has_pending_edits,
    })
}

fn canonical_path_allowing_missing_leaf(path: &Path) -> Result<PathBuf, LifecycleFailure> {
    match fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| LifecycleFailure::validation("Skill 投影来源路径无效"))?;
            let name = path
                .file_name()
                .ok_or_else(|| LifecycleFailure::validation("Skill 投影来源路径无效"))?;
            fs::canonicalize(parent)
                .map(|parent| parent.join(name))
                .map_err(|_| LifecycleFailure::validation("Skill 投影来源目录无效"))
        }
        Err(_) => Err(LifecycleFailure::validation("Skill 投影来源路径无效")),
    }
}

fn declared_path_matches(candidate: &Path, expected: &Path) -> bool {
    if !candidate.is_absolute()
        || candidate.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return false;
    }
    #[cfg(windows)]
    {
        windows_path_key(candidate) == windows_path_key(expected)
    }
    #[cfg(not(windows))]
    {
        candidate == expected
    }
}

fn projection_marker_is_structurally_valid(marker: &ProjectionMarkerSummary) -> bool {
    let digest_is_valid = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    };
    let env_keys_are_valid = marker.env_keys.iter().all(|key| {
        let mut chars = key.chars();
        !key.is_empty()
            && key.len() <= 100
            && chars
                .next()
                .is_some_and(|character| character.is_ascii_uppercase())
            && chars.all(|character| {
                character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
            })
    }) && marker
        .env_keys
        .windows(2)
        .all(|pair| pair[0].as_str() < pair[1].as_str());
    let resources_are_valid = marker
        .resource_names
        .iter()
        .all(|name| valid_projection_resource_name(name))
        && marker
            .resource_names
            .windows(2)
            .all(|pair| pair[0].as_str() < pair[1].as_str());
    matches!(
        marker.version,
        LEGACY_PROJECTION_MARKER_VERSION | PROJECTION_MARKER_VERSION
    ) && (marker.version != LEGACY_PROJECTION_MARKER_VERSION
        || marker.header_version == LEGACY_PROJECTION_HEADER_VERSION)
        && matches!(
            marker.header_version,
            LEGACY_PROJECTION_HEADER_VERSION
                | SHELL_EXPORT_PROJECTION_HEADER_VERSION
                | ENV_ONLY_PROJECTION_HEADER_VERSION
                | PROJECTION_HEADER_VERSION
        )
        && (marker.header_version != LEGACY_PROJECTION_HEADER_VERSION
            || (marker.env_keys.is_empty() && !marker.header_separator_injected))
        && env_keys_are_valid
        && resources_are_valid
        && valid_projection_generation(&marker.generation)
        && valid_skill_id(&marker.skill_id)
        && uuid::Uuid::parse_str(&marker.header_token).is_ok()
        && digest_is_valid(&marker.canonical_skill_md_sha256)
        && digest_is_valid(&marker.rendered_skill_md_sha256)
        && (!marker.header_separator_injected || marker.header_injected)
}

fn valid_projection_resource_name(name: &str) -> bool {
    if matches!(
        name,
        "SKILL.md" | PROJECTION_MARKER_NAME | ".skillhub.json" | ".git" | ".DS_Store"
    ) {
        return false;
    }
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none()
}

fn valid_projection_recovery_link(name: &str) -> bool {
    name.strip_prefix(".skillhub-old-link-")
        .and_then(|value| uuid::Uuid::parse_str(value).ok())
        .is_some()
}

fn read_projection_link_target(path: &Path) -> Result<PathBuf, LifecycleFailure> {
    #[cfg(windows)]
    {
        match junction::get_target(path) {
            Ok(target) => Ok(target),
            Err(_) => fs::read_link(path)
                .map_err(|_| LifecycleFailure::validation("无法安全读取回收站投影链接")),
        }
    }
    #[cfg(not(windows))]
    {
        fs::read_link(path).map_err(|_| LifecycleFailure::validation("无法安全读取回收站投影链接"))
    }
}

fn projection_generation_target(target: &Path, expected_live_root: &Path) -> Option<String> {
    if !target.is_absolute() {
        let mut components = target.components();
        return match (components.next(), components.next()) {
            (Some(std::path::Component::Normal(value)), None) => value
                .to_str()
                .filter(|value| valid_projection_generation(value))
                .map(str::to_string),
            _ => None,
        };
    }

    #[cfg(windows)]
    {
        if target.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        }) {
            return None;
        }
        let target_name = target
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| valid_projection_generation(value))?;
        let parent = target.parent()?;
        let expected_live_root = canonical_path_allowing_missing_leaf(expected_live_root).ok()?;
        windows_path_key(parent)
            .eq(&windows_path_key(&expected_live_root))
            .then(|| target_name.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = expected_live_root;
        None
    }
}

#[cfg(windows)]
fn windows_path_key(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('/', "\\");
    if value.starts_with(r"\\?\UNC\") {
        value.replace_range(..8, r"\\");
    } else if value.starts_with(r"\\?\") {
        value.replace_range(..4, "");
    }
    value.trim_end_matches('\\').to_lowercase()
}

fn valid_projection_generation(value: &str) -> bool {
    value
        .strip_prefix("generation-")
        .and_then(|value| uuid::Uuid::parse_str(value).ok())
        .is_some()
}

fn summarize_tree_with_git_policy(
    root: &Path,
    exclude_root_git: bool,
) -> Result<TreeSummary, LifecycleFailure> {
    require_real_directory(root, "目标内容不是安全的真实目录")?;
    if exclude_root_git {
        let git_path = root.join(".git");
        match fs::symlink_metadata(&git_path) {
            Ok(metadata) if !is_link_like(&git_path, &metadata) && metadata.is_dir() => {}
            Ok(_) => {
                return Err(LifecycleFailure::validation(
                    "Skill 的版本目录不是安全的真实目录",
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(LifecycleFailure::internal("无法检查 Skill 版本目录")),
        }
    }
    let mut digest = Sha256::new();
    digest_field(&mut digest, b"skillhub-tree-summary-v1");
    let mut file_count = 0usize;
    let mut directory_count = 0usize;
    let mut entry_count = 0usize;
    let mut total_bytes = 0u64;
    let mut latest_modified_at_unix = 0u64;
    let walker = WalkDir::new(root)
        .follow_links(false)
        .max_depth(MAX_TREE_DEPTH + 1)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            !(exclude_root_git && entry.depth() == 1 && entry.file_name() == ".git")
        });
    for entry in walker {
        let entry = entry.map_err(|_| LifecycleFailure::validation("Skill 文件树无法安全读取"))?;
        if entry.depth() == 0 {
            continue;
        }
        if entry.depth() > MAX_TREE_DEPTH {
            return Err(LifecycleFailure::validation("Skill 文件树层级超过安全上限"));
        }
        entry_count += 1;
        if entry_count > MAX_TREE_ENTRIES {
            return Err(LifecycleFailure::validation("Skill 文件树条目超过安全上限"));
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(path)
            .map_err(|_| LifecycleFailure::validation("Skill 文件树在读取时发生变化"))?;
        if is_link_like(path, &metadata) {
            return Err(LifecycleFailure::validation(
                "Skill 文件树包含符号链接或目录联接",
            ));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| LifecycleFailure::validation("Skill 文件路径不安全"))?;
        let relative = normalized_relative(relative)?;
        let modified = modified_key(&metadata);
        latest_modified_at_unix = latest_modified_at_unix.max(modified_seconds(&metadata));
        if metadata.is_dir() {
            directory_count += 1;
            digest_field(&mut digest, b"directory");
            digest_field(&mut digest, relative.as_bytes());
            digest_field(&mut digest, &modified);
            continue;
        }
        if !metadata.is_file() {
            return Err(LifecycleFailure::validation(
                "Skill 文件树包含不支持的文件类型",
            ));
        }
        file_count += 1;
        if file_count > MAX_TREE_FILES || metadata.len() > MAX_FILE_BYTES {
            return Err(LifecycleFailure::validation(
                "Skill 文件数量或大小超过安全上限",
            ));
        }
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .filter(|total| *total <= MAX_TREE_BYTES)
            .ok_or_else(|| LifecycleFailure::validation("Skill 内容总大小超过安全上限"))?;
        digest_field(&mut digest, b"file");
        digest_field(&mut digest, relative.as_bytes());
        digest_field(&mut digest, &metadata.len().to_le_bytes());
        digest_field(&mut digest, &modified);
        hash_regular_file(path, &metadata, &mut digest)?;
    }
    Ok(TreeSummary {
        file_count,
        directory_count,
        total_bytes,
        latest_modified_at_unix,
        fingerprint: format!("{:x}", digest.finalize()),
    })
}

fn hash_regular_file(
    path: &Path,
    initial: &fs::Metadata,
    digest: &mut Sha256,
) -> Result<(), LifecycleFailure> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(any(unix, windows))]
    options.custom_flags(crate::platform_fs::NOFOLLOW_FLAG);
    let mut file = options
        .open(path)
        .map_err(|_| LifecycleFailure::validation("Skill 文件无法安全读取"))?;
    let opened = file
        .metadata()
        .map_err(|_| LifecycleFailure::validation("Skill 文件无法安全检查"))?;
    if !opened.is_file()
        || opened.len() != initial.len()
        || opened.dev() != initial.dev()
        || opened.ino() != initial.ino()
    {
        return Err(LifecycleFailure::validation("Skill 文件在读取前发生变化"));
    }
    let mut remaining = initial.len();
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let requested = remaining.min(buffer.len() as u64) as usize;
        let read = file
            .read(&mut buffer[..requested])
            .map_err(|_| LifecycleFailure::validation("Skill 文件读取失败"))?;
        if read == 0 {
            return Err(LifecycleFailure::validation("Skill 文件在读取时被截断"));
        }
        digest.update(&buffer[..read]);
        remaining -= read as u64;
    }
    let mut extra = [0u8; 1];
    if file
        .read(&mut extra)
        .map_err(|_| LifecycleFailure::validation("Skill 文件读取失败"))?
        != 0
    {
        return Err(LifecycleFailure::validation("Skill 文件在读取时发生变化"));
    }
    let final_metadata = fs::symlink_metadata(path)
        .map_err(|_| LifecycleFailure::validation("Skill 文件在读取后发生变化"))?;
    if is_link_like(path, &final_metadata)
        || !final_metadata.is_file()
        || final_metadata.len() != opened.len()
        || final_metadata.dev() != opened.dev()
        || final_metadata.ino() != opened.ino()
        || modified_key(&final_metadata) != modified_key(&opened)
    {
        return Err(LifecycleFailure::validation("Skill 文件在读取期间发生变化"));
    }
    Ok(())
}

fn read_recovery_manifest_summary(
    path: &Path,
) -> Result<(serde_json::Value, Vec<u8>), LifecycleFailure> {
    let initial = require_real_file(path, "回收站清单不是安全的普通文件")?;
    if initial.len() > MAX_RECOVERY_MANIFEST_BYTES {
        return Err(LifecycleFailure::validation("回收站清单超过安全上限"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(any(unix, windows))]
    options.custom_flags(crate::platform_fs::NOFOLLOW_FLAG);
    let mut file = options
        .open(path)
        .map_err(|_| LifecycleFailure::validation("回收站清单无法安全读取"))?;
    let opened = file
        .metadata()
        .map_err(|_| LifecycleFailure::validation("回收站清单无法安全检查"))?;
    if !opened.is_file()
        || opened.len() != initial.len()
        || opened.dev() != initial.dev()
        || opened.ino() != initial.ino()
    {
        return Err(LifecycleFailure::validation("回收站清单在读取前发生变化"));
    }
    let mut contents = Vec::with_capacity(opened.len() as usize);
    std::io::Read::by_ref(&mut file)
        .take(MAX_RECOVERY_MANIFEST_BYTES + 1)
        .read_to_end(&mut contents)
        .map_err(|_| LifecycleFailure::validation("回收站清单读取失败"))?;
    if contents.len() as u64 != opened.len() || contents.len() as u64 > MAX_RECOVERY_MANIFEST_BYTES
    {
        return Err(LifecycleFailure::validation("回收站清单在读取时发生变化"));
    }
    let final_metadata = fs::symlink_metadata(path)
        .map_err(|_| LifecycleFailure::validation("回收站清单在读取后发生变化"))?;
    if is_link_like(path, &final_metadata)
        || !final_metadata.is_file()
        || final_metadata.len() != opened.len()
        || final_metadata.dev() != opened.dev()
        || final_metadata.ino() != opened.ino()
        || modified_key(&final_metadata) != modified_key(&opened)
    {
        return Err(LifecycleFailure::validation("回收站清单在读取期间发生变化"));
    }
    let manifest = serde_json::from_slice(&contents)
        .map_err(|_| LifecycleFailure::validation("回收站清单不是有效 JSON"))?;
    let mut digest = Sha256::new();
    digest_field(&mut digest, b"skillhub-recovery-manifest-v1");
    digest_field(&mut digest, &contents);
    Ok((manifest, digest.finalize().to_vec()))
}

fn read_bounded_regular(path: &Path, max_bytes: u64) -> Result<Option<Vec<u8>>, LifecycleFailure> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(LifecycleFailure::internal("无法检查 Skill Profile")),
    };
    if is_link_like(path, &metadata) || !metadata.is_file() || metadata.len() > max_bytes {
        return Err(LifecycleFailure::validation(
            "Skill Profile 不是安全的普通文件",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(any(unix, windows))]
    options.custom_flags(crate::platform_fs::NOFOLLOW_FLAG);
    let mut file = options
        .open(path)
        .map_err(|_| LifecycleFailure::validation("Skill Profile 无法安全读取"))?;
    let opened = file
        .metadata()
        .map_err(|_| LifecycleFailure::validation("Skill Profile 无法安全检查"))?;
    if !opened.is_file()
        || opened.len() > max_bytes
        || opened.dev() != metadata.dev()
        || opened.ino() != metadata.ino()
    {
        return Err(LifecycleFailure::validation(
            "Skill Profile 在读取前发生变化",
        ));
    }
    let mut contents = Vec::with_capacity(opened.len() as usize);
    std::io::Read::by_ref(&mut file)
        .take(max_bytes + 1)
        .read_to_end(&mut contents)
        .map_err(|_| LifecycleFailure::validation("Skill Profile 读取失败"))?;
    if contents.len() as u64 > max_bytes {
        return Err(LifecycleFailure::validation("Skill Profile 超过安全上限"));
    }
    if contents.len() as u64 != opened.len() {
        return Err(LifecycleFailure::validation(
            "Skill Profile 在读取时发生变化",
        ));
    }
    let final_metadata = fs::symlink_metadata(path)
        .map_err(|_| LifecycleFailure::validation("Skill Profile 在读取后发生变化"))?;
    if is_link_like(path, &final_metadata)
        || !final_metadata.is_file()
        || final_metadata.len() != opened.len()
        || final_metadata.dev() != opened.dev()
        || final_metadata.ino() != opened.ino()
        || modified_key(&final_metadata) != modified_key(&opened)
    {
        return Err(LifecycleFailure::validation(
            "Skill Profile 在读取期间发生变化",
        ));
    }
    Ok(Some(contents))
}

fn require_real_directory(path: &Path, message: &'static str) -> Result<(), LifecycleFailure> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !is_link_like(path, &metadata) && metadata.is_dir() => Ok(()),
        Ok(_) => Err(LifecycleFailure::validation(message)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(LifecycleFailure::not_found(message))
        }
        Err(_) => Err(LifecycleFailure::internal(message)),
    }
}

#[cfg(windows)]
fn is_link_like(_path: &Path, metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    metadata.file_type().is_symlink()
        || metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
}

#[cfg(not(windows))]
fn is_link_like(_path: &Path, metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn normalized_relative(path: &Path) -> Result<String, LifecycleFailure> {
    let mut parts = Vec::new();
    for component in path.components() {
        let std::path::Component::Normal(value) = component else {
            return Err(LifecycleFailure::validation("Skill 文件路径不安全"));
        };
        let value = value
            .to_str()
            .ok_or_else(|| LifecycleFailure::validation("Skill 文件名不是有效 UTF-8"))?;
        parts.push(value);
    }
    Ok(parts.join("/"))
}

fn modified_seconds(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(windows)]
fn modified_key(metadata: &fs::Metadata) -> [u8; 12] {
    use std::os::windows::fs::MetadataExt as _;

    let mut value = [0u8; 12];
    value[..8].copy_from_slice(&metadata.last_write_time().to_le_bytes());
    value[8..].copy_from_slice(&metadata.file_attributes().to_le_bytes());
    value
}

#[cfg(not(windows))]
fn modified_key(metadata: &fs::Metadata) -> [u8; 12] {
    let duration = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .unwrap_or_default();
    let mut value = [0u8; 12];
    value[..8].copy_from_slice(&duration.as_secs().to_le_bytes());
    value[8..].copy_from_slice(&duration.subsec_nanos().to_le_bytes());
    value
}

fn digest_field(digest: &mut Sha256, value: &[u8]) {
    digest.update((value.len() as u64).to_le_bytes());
    digest.update(value);
}

fn public_trash_id(raw_id: &str) -> String {
    let mut digest = Sha256::new();
    digest_field(&mut digest, b"skillhub-public-trash-id-v1");
    digest_field(&mut digest, raw_id.as_bytes());
    let bytes = digest.finalize();
    let mut uuid_bytes = [0u8; 16];
    uuid_bytes.copy_from_slice(&bytes[..16]);
    uuid_bytes[6] = (uuid_bytes[6] & 0x0f) | 0x50;
    uuid_bytes[8] = (uuid_bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(uuid_bytes).to_string()
}

fn resolve_public_trash_item<'a>(
    items: &'a [TrashItem],
    public_id: &str,
) -> Result<&'a TrashItem, LifecycleFailure> {
    let public_id = parse_public_trash_id(public_id)
        .ok_or_else(|| LifecycleFailure::validation("回收站项目 id 无效"))?;
    let mut matches = items
        .iter()
        .filter(|item| public_trash_id(&item.id) == public_id);
    let item = matches
        .next()
        .ok_or_else(|| LifecycleFailure::not_found("没有找到对应的回收站项目"))?;
    if matches.next().is_some() {
        return Err(LifecycleFailure::internal("回收站项目身份发生冲突"));
    }
    Ok(item)
}

fn public_trash_item(item: &TrashItem) -> PublicTrashItem {
    let managed = item.kind == "managed_asset";
    let safely_restorable = managed
        && item.id.starts_with("managed:")
        && item.status == "trashed"
        && item.restorable
        && valid_skill_id(&item.skill_id)
        && item.skill_id != crate::system_skill::SYSTEM_MANAGER_ID;
    PublicTrashItem {
        trash_id: public_trash_id(&item.id),
        kind: safe_identifier(&item.kind).unwrap_or_else(|| "unknown".into()),
        skill_id: if valid_skill_id(&item.skill_id) {
            item.skill_id.clone()
        } else {
            "unknown".into()
        },
        display_name: safe_display_name(&item.display_name, &item.skill_id),
        created_at: item.created_at,
        status: safe_identifier(&item.status).unwrap_or_else(|| "unknown".into()),
        reason: item.reason.as_deref().and_then(safe_identifier),
        source_count: item.source_count,
        restorable_via_cli: safely_restorable,
        requires_app: !managed,
    }
}

fn valid_recovery_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn safe_identifier(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')))
    .then(|| value.to_string())
}

fn safe_text(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect()
}

fn safe_version(value: &str) -> String {
    if !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'+'))
    {
        value.to_string()
    } else {
        "unknown".into()
    }
}

fn safe_display_name(value: &str, fallback: &str) -> String {
    let value = safe_text(value, 200);
    let bytes = value.as_bytes();
    let windows_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    if value.is_empty()
        || Path::new(&value).is_absolute()
        || windows_absolute
        || value.starts_with("\\\\")
    {
        fallback.to_string()
    } else {
        value
    }
}

fn public_id_from_delete_result(
    home: &Path,
    transaction: &str,
) -> Result<String, LifecycleFailure> {
    let transaction = PathBuf::from(transaction);
    let expected_parent = home
        .join(if crate::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        })
        .join("trash");
    if transaction.parent() != Some(expected_parent.as_path()) {
        return Err(LifecycleFailure::outcome_unknown(
            "删除已执行但回收站记录需要复核",
        ));
    }
    let segment = transaction
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| valid_recovery_segment(value))
        .ok_or_else(|| LifecycleFailure::outcome_unknown("删除已执行但回收站记录需要复核"))?;
    require_real_directory(&transaction, "删除已执行但回收站记录需要复核")
        .map_err(|_| LifecycleFailure::outcome_unknown("删除已执行但回收站记录需要复核"))?;
    Ok(public_trash_id(&format!("managed:{segment}")))
}

fn usage_failure(command: &'static str) -> CliCommandOutput {
    CliCommandOutput::failure(
        command,
        local_account(),
        CliErrorCode::ValidationFailed,
        LIFECYCLE_USAGE,
        EXIT_USAGE,
        Vec::new(),
    )
}

fn failure_output(
    command: &'static str,
    error: LifecycleFailure,
    next_actions: Vec<String>,
) -> CliCommandOutput {
    let (code, exit_code) = failure_contract(error.kind);
    CliCommandOutput::failure(
        command,
        local_account(),
        code,
        error.message,
        exit_code,
        next_actions,
    )
}

fn failure_contract(kind: FailureKind) -> (CliErrorCode, i32) {
    match kind {
        FailureKind::NotFound => (CliErrorCode::NotFound, EXIT_USAGE),
        FailureKind::PermissionDenied => (CliErrorCode::PermissionDenied, EXIT_INTERNAL),
        FailureKind::Conflict => (CliErrorCode::Conflict, EXIT_CONFLICT),
        FailureKind::PlanStale => (CliErrorCode::PlanStale, EXIT_CONFLICT),
        FailureKind::Validation => (CliErrorCode::ValidationFailed, EXIT_USAGE),
        FailureKind::OutcomeUnknown => (CliErrorCode::OperationOutcomeUnknown, EXIT_INTERNAL),
        FailureKind::Internal => (CliErrorCode::InternalError, EXIT_INTERNAL),
    }
}

fn internal_failure(
    command: &'static str,
    message: &'static str,
    next_actions: Vec<String>,
) -> CliCommandOutput {
    failure_output(command, LifecycleFailure::internal(message), next_actions)
}

fn outcome_unknown_failure(
    command: &'static str,
    message: &'static str,
    next_actions: Vec<String>,
) -> CliCommandOutput {
    failure_output(
        command,
        LifecycleFailure::outcome_unknown(message),
        next_actions,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        build_delete_plan_at, build_restore_plan_at, build_version_restore_plan_at,
        failure_contract, parse_command, projection_marker_is_structurally_valid, public_trash_id,
        public_trash_item, summarize_projection_recovery, validate_restore_target_tree,
        FailureKind, LifecycleCommand, ProjectionMarkerSummary, MAX_FILE_BYTES, MAX_TREE_DEPTH,
        PROJECTION_HEADER_VERSION, PROJECTION_MARKER_VERSION,
    };
    #[cfg(unix)]
    use super::{build_projection_removal_plan, summarize_tree};
    use crate::cli::{CliErrorCode, EXIT_CONFLICT, EXIT_INTERNAL};
    use crate::{SkillHubJson, SkillHubProfile, TrashItem};
    use sha2::Digest as _;
    use std::fs;

    fn fixture_home(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "skillhub-cli-lifecycle-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    fn create_managed_skill(home: &std::path::Path, skill_id: &str) -> std::path::PathBuf {
        let root = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills")
            .join(skill_id);
        fs::create_dir_all(&root).expect("create managed skill");
        fs::create_dir_all(
            home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("envs"),
        )
        .expect("create env root");
        fs::write(root.join("SKILL.md"), "# Example\n").expect("write SKILL.md");
        let sidecar = SkillHubJson {
            version: "1.0".into(),
            skillhub: Some(SkillHubProfile {
                name: Some(skill_id.into()),
                display_name: Some("Example Skill".into()),
                version: "v1.2.3".into(),
                ..Default::default()
            }),
        };
        fs::write(
            root.join(".skillhub.json"),
            serde_json::to_vec(&sidecar).expect("serialize sidecar"),
        )
        .expect("write sidecar");
        root
    }

    fn write_projection_marker(
        generation: &std::path::Path,
        generation_name: &str,
        skill_id: &str,
        source_root: &std::path::Path,
        resource_names: &[&str],
    ) {
        fs::write(
            generation.join(".skillhub-projection.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": 2,
                "skillId": skill_id,
                "sourceRoot": source_root.to_string_lossy(),
                "generation": generation_name,
                "canonicalSkillMdSha256": "a".repeat(64),
                "renderedSkillMdSha256": "b".repeat(64),
                "headerVersion": 2,
                "headerToken": uuid::Uuid::new_v4().to_string(),
                "headerInjected": false,
                "headerSeparatorInjected": false,
                "envKeys": [],
                "resourceNames": resource_names,
            }))
            .expect("serialize projection marker"),
        )
        .expect("write projection marker");
    }

    #[test]
    fn projection_marker_accepts_header_v3_without_accepting_unknown_versions() {
        let mut marker = ProjectionMarkerSummary {
            version: PROJECTION_MARKER_VERSION,
            skill_id: "example".into(),
            source_root: "/managed/example".into(),
            generation: format!("generation-{}", uuid::Uuid::new_v4()),
            canonical_skill_md_sha256: "a".repeat(64),
            rendered_skill_md_sha256: "b".repeat(64),
            header_version: PROJECTION_HEADER_VERSION,
            header_token: uuid::Uuid::new_v4().to_string(),
            header_injected: true,
            header_separator_injected: true,
            env_keys: vec!["API_TOKEN".into()],
            resource_names: vec!["scripts".into()],
        };
        assert!(projection_marker_is_structurally_valid(&marker));

        // v3 (env-only) and v4 (current) are both valid; anything newer is unknown (#312).
        marker.header_version = super::ENV_ONLY_PROJECTION_HEADER_VERSION;
        assert!(projection_marker_is_structurally_valid(&marker));
        marker.header_version = PROJECTION_HEADER_VERSION + 1;
        assert!(!projection_marker_is_structurally_valid(&marker));

        marker.header_version = PROJECTION_HEADER_VERSION;
        marker.version = 3;
        assert!(!projection_marker_is_structurally_valid(&marker));
    }

    fn commit_all(root: &std::path::Path, message: &str) -> String {
        let repository = git2::Repository::init(root).expect("initialize fixture repository");
        let mut index = repository.index().expect("open fixture index");
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .expect("stage fixture files");
        index.write().expect("write fixture index");
        let tree_id = index.write_tree().expect("write fixture tree");
        let tree = repository.find_tree(tree_id).expect("load fixture tree");
        let signature =
            git2::Signature::now("SkillHub", "skillhub@local").expect("create fixture signature");
        let parent = repository
            .head()
            .ok()
            .and_then(|head| head.peel_to_commit().ok());
        let parents = parent.iter().collect::<Vec<_>>();
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                message,
                &tree,
                &parents,
            )
            .expect("commit fixture")
            .to_string()
    }

    fn git_tree_with_entries(
        repository: &git2::Repository,
        entries: &[(&str, &[u8], i32)],
    ) -> git2::Oid {
        let mut builder = repository.treebuilder(None).expect("create tree builder");
        for (name, contents, mode) in entries {
            let blob = repository.blob(contents).expect("write test blob");
            builder
                .insert(*name, blob, *mode)
                .expect("insert test tree entry");
        }
        builder.write().expect("write test tree")
    }

    fn deeply_nested_git_tree(repository: &git2::Repository, levels: usize) -> git2::Oid {
        let leaf = repository.blob(b"leaf\n").expect("write nested leaf");
        let mut builder = repository.treebuilder(None).expect("create leaf tree");
        builder
            .insert("leaf.txt", leaf, 0o100644)
            .expect("insert nested leaf");
        let mut current = builder.write().expect("write leaf tree");
        for level in (0..levels).rev() {
            let mut parent = repository.treebuilder(None).expect("create nested tree");
            parent
                .insert(format!("d{level}"), current, 0o040000)
                .expect("insert nested tree");
            current = parent.write().expect("write nested tree");
        }
        let tree = repository.find_tree(current).expect("find nested root");
        let mut root = repository
            .treebuilder(Some(&tree))
            .expect("open nested root");
        let skill = repository.blob(b"# Safe\n").expect("write root SKILL.md");
        root.insert("SKILL.md", skill, 0o100644)
            .expect("insert root SKILL.md");
        root.write().expect("write nested root")
    }

    fn validate_test_tree(
        repository: &git2::Repository,
        tree_id: git2::Oid,
    ) -> Result<(), super::LifecycleFailure> {
        let tree = repository.find_tree(tree_id).expect("find test tree");
        validate_restore_target_tree(repository, &tree)
    }

    #[test]
    fn parser_requires_json_and_a_64_hex_digest_for_apply() {
        let digest = "a".repeat(64);
        assert_eq!(
            parse_command(&[
                "skill".into(),
                "delete".into(),
                "apply".into(),
                "--skill-id".into(),
                "example".into(),
                "--plan-digest".into(),
                digest.clone(),
                "--json".into(),
            ]),
            Ok(LifecycleCommand::DeleteApply {
                skill_id: "example".into(),
                plan_digest: digest,
            })
        );
        assert!(parse_command(&[
            "skill".into(),
            "delete".into(),
            "apply".into(),
            "--skill-id".into(),
            "example".into(),
            "--plan-digest".into(),
            "short".into(),
            "--json".into(),
        ])
        .is_err());
        assert!(parse_command(&[
            "skill".into(),
            "trash".into(),
            "list".into(),
            "--json".into(),
            "extra".into(),
        ])
        .is_err());
    }

    #[test]
    fn parser_accepts_projection_and_version_lifecycle_commands() {
        let digest = "a".repeat(64);
        let hash = "b".repeat(40);
        assert_eq!(
            parse_command(&[
                "skill".into(),
                "enable".into(),
                "apply".into(),
                "--skill-id".into(),
                "example".into(),
                "--agent".into(),
                "claude".into(),
                "--plan-digest".into(),
                digest.clone(),
                "--replace-conflicts".into(),
                "--json".into(),
            ]),
            Ok(LifecycleCommand::EnableApply {
                skill_id: "example".into(),
                agent: "claude".into(),
                plan_digest: digest.clone(),
                replace_conflicts: true,
            })
        );
        assert_eq!(
            parse_command(&[
                "skill".into(),
                "disable".into(),
                "preflight".into(),
                "--skill-id".into(),
                "example".into(),
                "--agent".into(),
                "claude".into(),
                "--json".into(),
            ]),
            Ok(LifecycleCommand::DisablePreflight {
                skill_id: "example".into(),
                agent: "claude".into(),
            })
        );
        assert_eq!(
            parse_command(&[
                "skill".into(),
                "uninstall".into(),
                "apply".into(),
                "--skill-id".into(),
                "example".into(),
                "--plan-digest".into(),
                digest.clone(),
                "--json".into(),
            ]),
            Ok(LifecycleCommand::UninstallApply {
                skill_id: "example".into(),
                plan_digest: digest.clone(),
            })
        );
        assert_eq!(
            parse_command(&[
                "skill".into(),
                "restore-version".into(),
                "apply".into(),
                "--skill-id".into(),
                "example".into(),
                "--hash".into(),
                hash.clone(),
                "--plan-digest".into(),
                digest.clone(),
                "--json".into(),
            ]),
            Ok(LifecycleCommand::RestoreVersionApply {
                skill_id: "example".into(),
                hash,
                receipt_id: None,
                plan_digest: digest,
            })
        );
    }

    #[test]
    fn version_restore_rejects_unsafe_git_tree_shapes_before_checkout() {
        let home = fixture_home("restore-target-tree-validation");
        fs::create_dir_all(&home).expect("create validation fixture");
        let repository = git2::Repository::init(&home).expect("initialize validation repository");

        let safe = git_tree_with_entries(
            &repository,
            &[
                ("SKILL.md", b"# Safe\n", 0o100644),
                (".env.example", b"TOKEN=example\n", 0o100644),
            ],
        );
        assert!(validate_test_tree(&repository, safe).is_ok());

        let symlink = git_tree_with_entries(
            &repository,
            &[
                ("SKILL.md", b"# Unsafe\n", 0o100644),
                ("escape", b"../../outside", 0o120000),
            ],
        );
        assert!(validate_test_tree(&repository, symlink).is_err());

        let environment = git_tree_with_entries(
            &repository,
            &[
                ("SKILL.md", b"# Unsafe\n", 0o100644),
                (".env", b"TOKEN=secret\n", 0o100644),
            ],
        );
        assert!(validate_test_tree(&repository, environment).is_err());

        let oversized_contents = vec![b'x'; (MAX_FILE_BYTES + 1) as usize];
        let oversized = git_tree_with_entries(
            &repository,
            &[
                ("SKILL.md", b"# Unsafe\n", 0o100644),
                ("large.bin", oversized_contents.as_slice(), 0o100644),
            ],
        );
        assert!(validate_test_tree(&repository, oversized).is_err());

        let deep = deeply_nested_git_tree(&repository, MAX_TREE_DEPTH);
        assert!(validate_test_tree(&repository, deep).is_err());

        let case_collision = git_tree_with_entries(
            &repository,
            &[
                ("SKILL.md", b"# Unsafe\n", 0o100644),
                ("Readme.md", b"one\n", 0o100644),
                ("README.md", b"two\n", 0o100644),
            ],
        );
        assert!(validate_test_tree(&repository, case_collision).is_err());

        for reserved in [
            "CON", "con.txt", "PrN.md", "AUX.json", "nul.data", "COM1", "com9.txt", "LPT1",
            "lPt9.log",
        ] {
            let tree = git_tree_with_entries(
                &repository,
                &[
                    ("SKILL.md", b"# Unsafe\n", 0o100644),
                    (reserved, b"reserved\n", 0o100644),
                ],
            );
            let error = validate_test_tree(&repository, tree)
                .expect_err("Windows reserved device name must be rejected");
            assert!(
                error.message.contains("Windows 保留设备名"),
                "unexpected error for {reserved:?}: {}",
                error.message
            );
        }

        for forbidden in [
            "bad<name.md",
            "bad>name.md",
            "bad:name.md",
            "bad\"name.md",
            "bad|name.md",
            "bad?name.md",
            "bad*name.md",
            "bad\u{1f}name.md",
        ] {
            let tree = git_tree_with_entries(
                &repository,
                &[
                    ("SKILL.md", b"# Unsafe\n", 0o100644),
                    (forbidden, b"forbidden\n", 0o100644),
                ],
            );
            let error = validate_test_tree(&repository, tree)
                .expect_err("Windows forbidden path character must be rejected");
            assert!(
                error.message.contains("Windows 不兼容的路径字符"),
                "unexpected error for {forbidden:?}: {}",
                error.message
            );
        }

        for trailing in ["trailing-space ", "trailing-dot."] {
            let tree = git_tree_with_entries(
                &repository,
                &[
                    ("SKILL.md", b"# Unsafe\n", 0o100644),
                    (trailing, b"trailing\n", 0o100644),
                ],
            );
            let error = validate_test_tree(&repository, tree)
                .expect_err("Windows trailing space or dot must be rejected");
            assert!(
                error.message.contains("空格或点结尾"),
                "unexpected error for {trailing:?}: {}",
                error.message
            );
        }

        let preserved_guard = "bad\\path.md";
        let tree = git_tree_with_entries(
            &repository,
            &[
                ("SKILL.md", b"# Unsafe\n", 0o100644),
                (preserved_guard, b"unsafe\n", 0o100644),
            ],
        );
        assert!(
            validate_test_tree(&repository, tree).is_err(),
            "existing portable-path guard accepted {preserved_guard:?}"
        );

        for safe_name in ["COM0.txt", "COM10.txt", "LPT0.md", "LPT10.md"] {
            let tree = git_tree_with_entries(
                &repository,
                &[
                    ("SKILL.md", b"# Safe\n", 0o100644),
                    (safe_name, b"safe\n", 0o100644),
                ],
            );
            assert!(
                validate_test_tree(&repository, tree).is_ok(),
                "non-reserved name was rejected: {safe_name:?}"
            );
        }

        let nested_blob = repository
            .blob(b"nested\n")
            .expect("write nested fixture blob");
        let mut nested_builder = repository
            .treebuilder(None)
            .expect("create nested fixture tree");
        nested_builder
            .insert("file.txt", nested_blob, 0o100644)
            .expect("insert nested fixture file");
        let nested_tree = nested_builder.write().expect("write nested fixture tree");
        drop(nested_builder);
        let skill_blob = repository
            .blob(b"# Unsafe\n")
            .expect("write root Skill blob");
        let mut root_builder = repository
            .treebuilder(None)
            .expect("create root fixture tree");
        root_builder
            .insert("SKILL.md", skill_blob, 0o100644)
            .expect("insert root Skill");
        root_builder
            .insert("aux.docs", nested_tree, 0o040000)
            .expect("insert non-portable directory component");
        let root_tree = root_builder.write().expect("write root fixture tree");
        drop(root_builder);
        let error = validate_test_tree(&repository, root_tree)
            .expect_err("reserved directory component must be rejected");
        assert!(error.message.contains("Windows 保留设备名"));

        drop(repository);
        fs::remove_dir_all(home).expect("remove validation fixture");
    }

    #[test]
    fn version_restore_preflight_rejects_nonportable_tree_without_mutating_repository() {
        let home = fixture_home("restore-version-nonportable-preflight");
        let root = create_managed_skill(&home, "example");
        let repository = git2::Repository::init(&root).expect("initialize fixture repository");
        let target_tree_id = git_tree_with_entries(
            &repository,
            &[
                ("SKILL.md", b"# Historical\n", 0o100644),
                ("CON.txt", b"reserved\n", 0o100644),
            ],
        );
        let target_tree = repository
            .find_tree(target_tree_id)
            .expect("find historical target tree");
        let signature =
            git2::Signature::now("SkillHub", "skillhub@local").expect("create signature");
        let target_commit = repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "unsafe historical version",
                &target_tree,
                &[],
            )
            .expect("commit historical target");
        drop(target_tree);
        drop(repository);

        fs::write(root.join("SKILL.md"), "# Current safe version\n")
            .expect("write current safe version");
        let current_hash = commit_all(&root, "current safe version");
        let before_skill = fs::read(root.join("SKILL.md")).expect("read current Skill");
        let before_profile =
            fs::read(root.join(".skillhub.json")).expect("read current SkillHub profile");

        let error =
            match build_version_restore_plan_at(&home, "example", &target_commit.to_string()) {
                Ok(_) => panic!("preflight must reject a non-portable target tree"),
                Err(error) => error,
            };
        assert!(error.message.contains("Windows 保留设备名"));

        let repository = git2::Repository::open(&root).expect("reopen fixture repository");
        let after_head = repository
            .head()
            .expect("read HEAD")
            .peel_to_commit()
            .expect("read HEAD commit")
            .id()
            .to_string();
        assert_eq!(after_head, current_hash);
        assert_eq!(
            fs::read(root.join("SKILL.md")).expect("read preserved Skill"),
            before_skill
        );
        assert_eq!(
            fs::read(root.join(".skillhub.json")).expect("read preserved profile"),
            before_profile
        );
        assert!(!root.join("CON.txt").exists());
        let statuses = repository.statuses(None).expect("read final status");
        assert!(statuses.is_empty());
        drop(statuses);

        drop(repository);
        fs::remove_dir_all(home).expect("remove preflight fixture");
    }

    #[test]
    fn version_restore_requires_a_clean_working_copy_and_binds_the_plan() {
        let home = fixture_home("restore-version-plan");
        let root = create_managed_skill(&home, "example");
        let first_hash = commit_all(&root, "first version");
        fs::write(root.join("SKILL.md"), "# Second\n").expect("write second version");
        let second_hash = commit_all(&root, "second version");

        let clean = build_version_restore_plan_at(&home, "example", &first_hash)
            .expect("build clean version restore plan");
        assert_eq!(clean.data.current_hash, second_hash);
        assert_eq!(clean.data.target_hash, first_hash);
        assert!(clean.data.can_apply);
        assert!(clean.data.requires_clean_working_copy);

        fs::write(root.join("SKILL.md"), "# Uncommitted\n")
            .expect("write uncommitted fixture content");
        let dirty = build_version_restore_plan_at(&home, "example", &clean.data.target_hash)
            .expect("build dirty version restore plan");
        assert!(!dirty.data.can_apply);
        assert!(dirty.data.has_working_changes);
        assert_ne!(clean.digest, dirty.digest);
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn version_restore_blocks_pending_agent_projection_edits() {
        let home = fixture_home("restore-version-pending-projection");
        let root = create_managed_skill(&home, "example");
        let first_hash = commit_all(&root, "first version");
        fs::write(root.join("SKILL.md"), "# Second\n").expect("write second version");
        commit_all(&root, "second version");

        let projection_root = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("projections/example");
        let generation_name = format!("generation-{}", uuid::Uuid::new_v4());
        let generation = projection_root.join(&generation_name);
        fs::create_dir_all(&generation).expect("create projection generation");
        let rendered = b"# Second\n";
        fs::write(generation.join("SKILL.md"), rendered).expect("write projected SKILL.md");
        let rendered_sha256 = format!("{:x}", sha2::Sha256::digest(rendered));
        let canonical_source = fs::canonicalize(&root).expect("canonical managed source");
        fs::write(
            generation.join(".skillhub-projection.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": 2,
                "skillId": "example",
                "sourceRoot": canonical_source.to_string_lossy(),
                "generation": generation_name,
                "canonicalSkillMdSha256": rendered_sha256.clone(),
                "renderedSkillMdSha256": rendered_sha256,
                "headerVersion": 2,
                "headerToken": uuid::Uuid::new_v4().to_string(),
                "headerInjected": false,
                "headerSeparatorInjected": false,
                "envKeys": [],
                "resourceNames": [],
            }))
            .expect("serialize projection marker"),
        )
        .expect("write projection marker");
        let current = projection_root.join("current");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&generation_name, &current)
            .expect("select projection generation");
        #[cfg(windows)]
        crate::platform_fs::unix_fs::symlink(&generation_name, &current)
            .expect("select projection generation");
        fs::write(generation.join("SKILL.md"), "# Pending Agent edit\n")
            .expect("edit projected SKILL.md");

        let plan = build_version_restore_plan_at(&home, "example", &first_hash)
            .expect("build guarded restore plan");
        assert!(plan.data.has_pending_projection_edits);
        assert!(!plan.data.has_working_changes);
        assert!(!plan.data.can_apply);

        crate::platform_fs::remove_link(&current).expect("remove current projection link");
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[cfg(unix)]
    #[test]
    fn projection_removal_plan_only_targets_a_proven_skillhub_projection() {
        use std::os::unix::fs::symlink;

        let home = fixture_home("projection-removal-plan");
        let root = create_managed_skill(&home, "example");
        let (agent, _, relative) = crate::known_agents()
            .into_iter()
            .next()
            .expect("current platform has a supported Agent");
        let target = home.join(relative).join("example");
        fs::create_dir_all(target.parent().expect("projection parent"))
            .expect("create Agent Skill directory");
        symlink(&root, &target).expect("create managed projection");

        let enabled = build_projection_removal_plan(&home, "example", Some(agent))
            .expect("build enabled projection plan");
        assert!(enabled.data.can_apply);
        assert!(!enabled.data.already_in_requested_state);
        assert_eq!(enabled.data.installed_agents, vec![agent.to_string()]);

        fs::remove_file(&target).expect("remove managed projection");
        let disabled = build_projection_removal_plan(&home, "example", Some(agent))
            .expect("build disabled projection plan");
        assert!(!disabled.data.can_apply);
        assert!(disabled.data.already_in_requested_state);
        assert_ne!(enabled.digest, disabled.digest);
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn state_change_conflict_and_unknown_outcome_use_stable_exit_contracts() {
        assert_eq!(
            failure_contract(FailureKind::PlanStale),
            (CliErrorCode::PlanStale, EXIT_CONFLICT)
        );
        assert_eq!(
            failure_contract(FailureKind::Conflict),
            (CliErrorCode::Conflict, EXIT_CONFLICT)
        );
        assert_eq!(
            failure_contract(FailureKind::OutcomeUnknown),
            (CliErrorCode::OperationOutcomeUnknown, EXIT_INTERNAL)
        );
    }

    #[test]
    fn delete_digest_changes_with_managed_content_and_never_exposes_a_path() {
        let home = fixture_home("delete-plan");
        let root = create_managed_skill(&home, "example");
        let first = build_delete_plan_at(&home, "example").expect("first delete plan");
        assert_eq!(first.data.version, "v1.2.3");
        assert!(!first.data.is_system);
        assert!(first.data.can_apply);
        assert!(first.data.impact.moves_to_trash);
        assert!(!first.data.impact.permanently_deletes);
        let serialized = serde_json::to_string(&first.data).expect("serialize delete plan");
        assert!(!serialized.contains(home.to_string_lossy().as_ref()));

        fs::write(root.join("SKILL.md"), "# Changed\n").expect("change managed content");
        let second = build_delete_plan_at(&home, "example").expect("second delete plan");
        assert_ne!(first.digest, second.digest);
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[cfg(unix)]
    #[test]
    fn delete_digest_changes_with_internal_projection_content() {
        use std::os::unix::fs::symlink;

        let home = fixture_home("delete-projection-plan");
        let source = create_managed_skill(&home, "example");
        fs::create_dir_all(source.join("scripts")).expect("create canonical resources");
        fs::write(source.join("scripts/verify.sh"), "echo ok\n").expect("write canonical resource");
        let canonical_source = fs::canonicalize(&source).expect("canonical source");
        let projection_root = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("projections/example");
        let generation_name = format!("generation-{}", uuid::Uuid::new_v4());
        let generation = projection_root.join(&generation_name);
        fs::create_dir_all(&generation).expect("create projection generation");
        fs::write(generation.join("SKILL.md"), "# Projection\n").expect("write projected Skill");
        symlink(canonical_source.join("scripts"), generation.join("scripts"))
            .expect("create projected resource");
        write_projection_marker(
            &generation,
            &generation_name,
            "example",
            &canonical_source,
            &["scripts"],
        );
        symlink(&generation_name, projection_root.join("current"))
            .expect("create current projection link");
        symlink(
            &generation_name,
            projection_root.join(format!(".skillhub-old-link-{}", uuid::Uuid::new_v4())),
        )
        .expect("create retained projection claim");
        fs::create_dir(projection_root.join("recovery")).expect("create projection recovery");
        fs::write(
            projection_root
                .join("recovery")
                .join(format!("canonical-{}.md", uuid::Uuid::new_v4())),
            "# Prior canonical\n",
        )
        .expect("write projection recovery");

        let first = build_delete_plan_at(&home, "example").expect("first delete plan");
        fs::write(generation.join("SKILL.md"), "# Changed projection\n")
            .expect("change projected Skill");
        let second = build_delete_plan_at(&home, "example").expect("second delete plan");

        assert_ne!(first.digest, second.digest);

        fs::remove_file(generation.join("scripts")).expect("remove projected resource");
        let foreign = home.join("foreign");
        fs::create_dir(&foreign).expect("create foreign directory");
        symlink(&foreign, generation.join("scripts")).expect("retarget projected resource");
        assert!(build_delete_plan_at(&home, "example").is_err());
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn restore_digest_changes_when_the_target_becomes_occupied() {
        let home = fixture_home("restore-plan");
        fs::create_dir_all(
            home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills"),
        )
        .expect("create managed root");
        let transaction = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("trash/example-1-abc");
        let recovered = transaction.join("skill");
        fs::create_dir_all(&recovered).expect("create recovered skill");
        fs::write(recovered.join("SKILL.md"), "# Recovered\n").expect("write recovered skill");
        fs::write(
            transaction.join("recovery-manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": 2,
                "kind": "managed_asset",
                "status": "trashed",
                "skillId": "example",
                "skillRecoveryPath": "skill",
                "projectionRecoveryPath": null,
                "envFiles": [],
            }))
            .expect("serialize recovery manifest"),
        )
        .expect("write recovery manifest");
        let item = TrashItem {
            id: "managed:example-1-abc".into(),
            kind: "managed_asset".into(),
            skill_id: "example".into(),
            display_name: "Example".into(),
            created_at: 1,
            status: "trashed".into(),
            reason: None,
            source_count: 1,
            restorable: true,
            location: transaction.to_string_lossy().to_string(),
            server_id: None,
            server_owner_id: None,
        };
        let first = build_restore_plan_at(&home, &item).expect("available restore plan");
        assert!(first.data.can_apply);
        assert!(!first.data.impact.target_occupied);

        fs::create_dir(
            home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills/example"),
        )
        .expect("occupy restore target");
        let second = build_restore_plan_at(&home, &item).expect("occupied restore plan");
        assert!(!second.data.can_apply);
        assert!(second.data.impact.target_occupied);
        assert_ne!(first.digest, second.digest);
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn restore_plan_binds_environment_source_and_destination_without_exposing_values() {
        let home = fixture_home("restore-environment-plan");
        fs::create_dir_all(
            home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills"),
        )
        .expect("create managed root");
        let transaction = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("trash/example-2-def");
        fs::create_dir_all(transaction.join("skill")).expect("create recovered skill");
        fs::create_dir_all(transaction.join("env")).expect("create recovered env root");
        fs::write(transaction.join("skill/SKILL.md"), "# Recovered\n")
            .expect("write recovered skill");
        fs::write(transaction.join("env/0.env"), "API_KEY='private-value'\n")
            .expect("write recovered environment");
        fs::write(
            transaction.join("recovery-manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": 2,
                "kind": "managed_asset",
                "status": "trashed",
                "skillId": "example",
                "skillRecoveryPath": "skill",
                "projectionRecoveryPath": null,
                "envFiles": [{
                    "recoveryPath": "env/0.env",
                    "originalRelativePath": "envs/example.env",
                }],
            }))
            .expect("serialize recovery manifest"),
        )
        .expect("write recovery manifest");
        let item = TrashItem {
            id: "managed:example-2-def".into(),
            kind: "managed_asset".into(),
            skill_id: "example".into(),
            display_name: "Example".into(),
            created_at: 2,
            status: "trashed".into(),
            reason: None,
            source_count: 1,
            restorable: true,
            location: transaction.to_string_lossy().to_string(),
            server_id: None,
            server_owner_id: None,
        };
        let available = build_restore_plan_at(&home, &item).expect("available restore plan");
        assert!(available.data.can_apply);
        assert_eq!(available.data.impact.target_count, 2);
        assert_eq!(available.data.impact.environment_file_count, 1);
        assert_eq!(available.data.impact.occupied_target_count, 0);
        let serialized = serde_json::to_string(&available.data).expect("serialize restore plan");
        assert!(!serialized.contains("private-value"));
        assert!(!serialized.contains(home.to_string_lossy().as_ref()));

        fs::create_dir_all(
            home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("envs"),
        )
        .expect("create environment root");
        fs::write(
            home.join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("envs/example.env"),
            "NEW='value'\n",
        )
        .expect("occupy environment destination");
        let occupied = build_restore_plan_at(&home, &item).expect("occupied restore plan");
        assert!(!occupied.data.can_apply);
        assert!(occupied.data.impact.target_occupied);
        assert_eq!(occupied.data.impact.occupied_target_count, 1);
        assert_ne!(available.digest, occupied.digest);
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[cfg(windows)]
    #[test]
    fn restore_preflight_accepts_the_moved_absolute_projection_junction() {
        let home = fixture_home("windows-projection-junction");
        let live_source = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills/example");
        fs::create_dir_all(live_source.join("scripts")).expect("create live source");
        fs::write(live_source.join("SKILL.md"), "# Canonical\n").expect("write canonical Skill");
        fs::write(live_source.join("config.txt"), "config\n").expect("write canonical file");
        let canonical_source = fs::canonicalize(&live_source).expect("canonical source");
        let live_root = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("projections/example");
        let generation_name = format!("generation-{}", uuid::Uuid::new_v4());
        let generation = live_root.join(&generation_name);
        fs::create_dir_all(&generation).expect("create live projection generation");
        fs::write(generation.join("SKILL.md"), "# Projected\n").expect("write projected Skill");
        crate::platform_fs::unix_fs::symlink(
            canonical_source.join("scripts"),
            generation.join("scripts"),
        )
        .expect("create resource junction");
        crate::platform_fs::unix_fs::symlink(
            canonical_source.join("config.txt"),
            generation.join("config.txt"),
        )
        .expect("create resource hard link");
        write_projection_marker(
            &generation,
            &generation_name,
            "example",
            &canonical_source,
            &["config.txt", "scripts"],
        );
        let current = live_root.join("current");
        crate::platform_fs::unix_fs::symlink(&generation_name, &current)
            .expect("create absolute NTFS junction");
        let declared_target = junction::get_target(&current).expect("read live junction target");
        assert!(declared_target.is_absolute());

        let recovered_root = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("trash/item/projection");
        fs::create_dir_all(recovered_root.parent().expect("recovery parent"))
            .expect("create recovery parent");
        let recovered_source = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("trash/item/skill");
        fs::rename(&live_source, &recovered_source).expect("move canonical source to trash");
        fs::rename(&live_root, &recovered_root).expect("move projection to trash");

        summarize_projection_recovery(&recovered_root, &live_root, &live_source, &recovered_source)
            .expect("moved Windows projection remains safely restorable");
        crate::platform_fs::remove_link(&recovered_root.join("current"))
            .expect("remove current junction");
        crate::platform_fs::remove_link(&recovered_root.join(&generation_name).join("scripts"))
            .expect("remove resource junction");
        crate::platform_fs::remove_link(&recovered_root.join(&generation_name).join("config.txt"))
            .expect("remove resource hard link");
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[cfg(unix)]
    #[test]
    fn restore_preflight_rejects_an_absolute_projection_link_on_unix() {
        use std::os::unix::fs::symlink;

        let home = fixture_home("unix-absolute-projection-link");
        let live_root = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("projections/example");
        let recovered_root = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("trash/item/projection");
        let generation_name = format!("generation-{}", uuid::Uuid::new_v4());
        fs::create_dir_all(recovered_root.join(&generation_name))
            .expect("create recovered projection generation");
        symlink(
            live_root.join(&generation_name),
            recovered_root.join("current"),
        )
        .expect("create absolute projection link");

        let live_source = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("skills/example");
        let recovered_source = home
            .join(if crate::official_channel::CHANNEL == "dev" {
                ".skillhub-dev"
            } else {
                ".skillhub"
            })
            .join("trash/item/skill");
        assert!(summarize_projection_recovery(
            &recovered_root,
            &live_root,
            &live_source,
            &recovered_source,
        )
        .is_err());
        fs::remove_dir_all(home).expect("remove fixture");
    }

    #[test]
    fn public_trash_items_are_stable_uuids_and_omit_private_fields() {
        let home = fixture_home("public-trash");
        let item = TrashItem {
            id: "managed:example-1-abc".into(),
            kind: "managed_asset".into(),
            skill_id: "example".into(),
            display_name: home
                .join("private/display-name")
                .to_string_lossy()
                .to_string(),
            created_at: 1,
            status: "trashed".into(),
            reason: Some("user_deleted".into()),
            source_count: 1,
            restorable: true,
            location: home.join("private/location").to_string_lossy().to_string(),
            server_id: Some("server-secret-id".into()),
            server_owner_id: Some("owner-secret-id".into()),
        };
        let public = public_trash_item(&item);
        assert_eq!(public.trash_id, public_trash_id(&item.id));
        assert_eq!(public.display_name, "example");
        assert!(uuid::Uuid::parse_str(&public.trash_id).is_ok());
        let serialized = serde_json::to_string(&public).expect("serialize public trash item");
        assert!(!serialized.contains(home.to_string_lossy().as_ref()));
        assert!(!serialized.contains("server-secret-id"));
        assert!(!serialized.contains("owner-secret-id"));
    }

    #[cfg(unix)]
    #[test]
    fn tree_summary_rejects_symlinks() {
        use std::os::unix::fs::symlink;

        let home = fixture_home("tree-symlink");
        let root = create_managed_skill(&home, "example");
        let outside = home.join("outside.txt");
        fs::write(&outside, "outside\n").expect("write outside file");
        symlink(&outside, root.join("linked.txt")).expect("create symlink");

        assert!(summarize_tree(&root).is_err());
        assert_eq!(
            fs::read_to_string(outside).expect("read outside file"),
            "outside\n"
        );
        fs::remove_dir_all(home).expect("remove fixture");
    }
}

#[cfg(test)]
mod projection_marker_version_tests {
    use super::*;

    fn marker(version: u8, header_version: u8, env_keys: &[&str]) -> ProjectionMarkerSummary {
        ProjectionMarkerSummary {
            version,
            skill_id: "sample".into(),
            source_root: "/tmp/sample".into(),
            generation: "generation-1f99ab13-7e0b-4da9-9868-fdd3a7f539e8".into(),
            canonical_skill_md_sha256: "a".repeat(64),
            rendered_skill_md_sha256: "b".repeat(64),
            header_version,
            header_token: "4f3ac64a-1f99-4b13-8e0b-4da99868fdd3".into(),
            header_injected: true,
            header_separator_injected: false,
            env_keys: env_keys.iter().map(|key| key.to_string()).collect(),
            resource_names: vec!["scripts".into()],
        }
    }

    /// #312：生命周期校验必须认 `commands.rs` 当前写出的投影头版本，且常量不得再各留一份。
    #[test]
    fn lifecycle_accepts_the_projection_header_version_commands_writes() {
        assert_eq!(
            PROJECTION_HEADER_VERSION,
            crate::commands::PROJECTION_HEADER_VERSION
        );
        assert!(projection_marker_is_structurally_valid(&marker(
            PROJECTION_MARKER_VERSION,
            crate::commands::PROJECTION_HEADER_VERSION,
            &["FAL_KEY", "SKILLHUB_QA_TOKEN"],
        )));
        assert!(projection_marker_is_structurally_valid(&marker(
            PROJECTION_MARKER_VERSION,
            ENV_ONLY_PROJECTION_HEADER_VERSION,
            &["FAL_KEY"],
        )));
        assert!(!projection_marker_is_structurally_valid(&marker(
            PROJECTION_MARKER_VERSION,
            crate::commands::PROJECTION_HEADER_VERSION + 1,
            &[],
        )));
    }
}
