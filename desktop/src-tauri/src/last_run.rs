//! Last-run records (#292).
//!
//! Every `skillhub run` outcome is written to
//! `~/.skillhub/runtime/last-run/<runtimeUserId>/<skill>.json` (directory
//! 0700, file 0600) so the APP can show 「上次运行失败 · 缺少钥匙 X」.
//! Records hold key names, codes and a short message only, never values.
//! A failure record is cleared when the user fills the missing key, grants
//! it or picks its source; a later successful run overwrites it.

use crate::key_vault::{MISSING_KEY_CODE, NEEDS_CHOICE_CODE, NEEDS_CONSENT_CODE};
use crate::runtime_env::{
    ensure_private_directory, read_private_json, validate_skill_id, validate_user_id,
    write_private_json,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const LAST_RUN_VERSION: u8 = 1;
const MAX_MESSAGE_CHARS: usize = 200;
const MAX_RECORD_KEYS: usize = 100;
const SPAWN_FAILED_PREFIX: &str = "无法启动目标进程";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RunOutcome {
    Ok,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RunFailureCode {
    MissingKey,
    NeedsChoice,
    NeedsConsent,
    SpawnFailed,
    ExitCode,
    Other,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LastRunRecord {
    pub(crate) version: u8,
    pub(crate) skill_id: String,
    pub(crate) at: u64,
    pub(crate) outcome: RunOutcome,
    pub(crate) reason_code: Option<RunFailureCode>,
    #[serde(default)]
    pub(crate) keys: Vec<String>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) agent: Option<String>,
    #[serde(default)]
    pub(crate) message: Option<String>,
}

/// What `execute_cli` observed for one run.
pub(crate) enum RunObservation<'a> {
    /// The child ran and exited with this code.
    Exited(i32),
    /// Resolution failed before the child was started.
    ResolveFailed(&'a str),
    /// Starting or waiting for the child failed.
    ChildFailed(&'a str),
}

fn last_run_root_at(root: &Path) -> PathBuf {
    root.join("runtime").join("last-run")
}

fn user_dir_at(root: &Path, user_id: &str) -> PathBuf {
    last_run_root_at(root).join(user_id)
}

fn record_path_at(root: &Path, user_id: &str, skill_id: &str) -> PathBuf {
    user_dir_at(root, user_id).join(format!("{skill_id}.json"))
}

/// Classifies a resolution error by its machine-readable prefix and extracts
/// the key names from our own message formats; anything else is `other`.
pub(crate) fn classify_run_failure(message: &str) -> (RunFailureCode, Vec<String>) {
    let prefixed = |code: &str| {
        message
            .strip_prefix(code)
            .and_then(|rest| rest.strip_prefix(": "))
    };
    if let Some(rest) = prefixed(MISSING_KEY_CODE) {
        let key = match rest.strip_prefix("缺少必需环境变量 ") {
            Some(tail) => tail.split_whitespace().next(),
            None => rest.split_whitespace().next(),
        };
        return (RunFailureCode::MissingKey, valid_keys(key));
    }
    if let Some(rest) = prefixed(NEEDS_CHOICE_CODE) {
        return (
            RunFailureCode::NeedsChoice,
            valid_keys(rest.split_whitespace().next()),
        );
    }
    if let Some(rest) = prefixed(NEEDS_CONSENT_CODE) {
        let keys = rest
            .rsplit_once("」想使用你的钥匙 ")
            .map(|(_, tail)| tail.split('；').next().unwrap_or_default())
            .unwrap_or_default()
            .split('、')
            // A labelled value reads `FAL_KEY · 公司` (#306): record the name.
            .map(|key| key.split(" · ").next().unwrap_or_default().trim())
            .filter(|key| crate::runtime_env::valid_env_key(key))
            .take(MAX_RECORD_KEYS)
            .map(str::to_string)
            .collect();
        return (RunFailureCode::NeedsConsent, keys);
    }
    (RunFailureCode::Other, Vec::new())
}

fn valid_keys(key: Option<&str>) -> Vec<String> {
    key.filter(|key| crate::runtime_env::valid_env_key(key))
        .map(|key| vec![key.to_string()])
        .unwrap_or_default()
}

/// Maps the calling Agent's environment to an `AGENT_DEFINITIONS` key.
/// Only variable names are looked at, never their values.
pub(crate) fn detect_agent_from_names<I, S>(names: I) -> Option<&'static str>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let names = names
        .into_iter()
        .map(|name| name.as_ref().to_string())
        .collect::<BTreeSet<_>>();
    if names.contains("CLAUDECODE") || names.contains("CLAUDE_CODE_ENTRYPOINT") {
        return Some("claude");
    }
    if names.iter().any(|name| name.starts_with("CODEX_")) {
        return Some("codex");
    }
    if names.contains("GEMINI_CLI") {
        return Some("gemini");
    }
    None
}

pub(crate) fn detect_agent() -> Option<&'static str> {
    detect_agent_from_names(
        std::env::vars_os().filter_map(|(name, _value)| name.into_string().ok()),
    )
}

fn truncate_message(message: &str) -> String {
    message.chars().take(MAX_MESSAGE_CHARS).collect()
}

pub(crate) fn build_record(
    skill_id: &str,
    observation: &RunObservation<'_>,
    agent: Option<&str>,
    at: u64,
) -> LastRunRecord {
    let (outcome, reason_code, keys, exit_code, message) = match observation {
        RunObservation::Exited(0) => (RunOutcome::Ok, None, Vec::new(), Some(0), None),
        RunObservation::Exited(code) => (
            RunOutcome::Failed,
            Some(RunFailureCode::ExitCode),
            Vec::new(),
            Some(*code),
            Some(format!("程序退出码 {code}")),
        ),
        RunObservation::ResolveFailed(error) => {
            let (code, keys) = classify_run_failure(error);
            (
                RunOutcome::Failed,
                Some(code),
                keys,
                None,
                Some(truncate_message(error)),
            )
        }
        RunObservation::ChildFailed(error) => (
            RunOutcome::Failed,
            Some(if error.starts_with(SPAWN_FAILED_PREFIX) {
                RunFailureCode::SpawnFailed
            } else {
                RunFailureCode::Other
            }),
            Vec::new(),
            None,
            Some(truncate_message(error)),
        ),
    };
    LastRunRecord {
        version: LAST_RUN_VERSION,
        skill_id: skill_id.to_string(),
        at,
        outcome,
        reason_code,
        keys,
        exit_code,
        agent: agent.map(str::to_string),
        message,
    }
}

pub(crate) fn write_last_run_at(
    root: &Path,
    user_id: &str,
    record: &LastRunRecord,
) -> Result<(), String> {
    validate_user_id(user_id)?;
    validate_skill_id(&record.skill_id)?;
    ensure_private_directory(&last_run_root_at(root))?;
    write_private_json(&record_path_at(root, user_id, &record.skill_id), record)
}

pub(crate) fn read_last_run_at(
    root: &Path,
    user_id: &str,
    skill_id: &str,
) -> Option<LastRunRecord> {
    if validate_user_id(user_id).is_err() || validate_skill_id(skill_id).is_err() {
        return None;
    }
    let path = record_path_at(root, user_id, skill_id);
    if !path.exists() {
        return None;
    }
    read_private_json::<LastRunRecord>(&path)
        .ok()
        .filter(|record| record.version == LAST_RUN_VERSION && record.skill_id == skill_id)
}

/// Failure records of one runtime identity, newest first.
pub(crate) fn list_last_run_failures_at(
    root: &Path,
    user_id: &str,
) -> Result<Vec<LastRunRecord>, String> {
    validate_user_id(user_id)?;
    let Ok(entries) = fs::read_dir(user_dir_at(root, user_id)) else {
        return Ok(Vec::new());
    };
    let mut records = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let skill_id = name.strip_suffix(".json")?;
            read_last_run_at(root, user_id, skill_id)
        })
        .filter(|record| record.outcome == RunOutcome::Failed)
        .collect::<Vec<_>>();
    records.sort_by(|left, right| {
        right
            .at
            .cmp(&left.at)
            .then_with(|| left.skill_id.cmp(&right.skill_id))
    });
    Ok(records)
}

/// Removes one Skill's failure record (an `ok` record is kept).
pub(crate) fn clear_last_run_failure_at(
    root: &Path,
    user_id: &str,
    skill_id: &str,
) -> Result<(), String> {
    validate_user_id(user_id)?;
    validate_skill_id(skill_id)?;
    if read_last_run_at(root, user_id, skill_id)
        .is_some_and(|record| record.outcome == RunOutcome::Failed)
    {
        let _ = fs::remove_file(record_path_at(root, user_id, skill_id));
    }
    Ok(())
}

/// A key was filled, granted or given a source: failure records naming any
/// of `keys` are removed (optionally only for one Skill). Best effort.
pub(crate) fn clear_failures_for_keys_at(
    root: &Path,
    user_id: &str,
    keys: &[&str],
    only_skill: Option<&str>,
) {
    let Ok(records) = list_last_run_failures_at(root, user_id) else {
        return;
    };
    // A labelled value `NAME__V<n>` (#306) counts as its name.
    let keys = keys
        .iter()
        .map(|key| crate::key_vault::identity_main(key))
        .collect::<BTreeSet<_>>();
    for record in records {
        if only_skill.is_some_and(|skill| skill != record.skill_id) {
            continue;
        }
        if record
            .keys
            .iter()
            .any(|key| keys.contains(crate::key_vault::identity_main(key)))
        {
            let _ = fs::remove_file(record_path_at(root, user_id, &record.skill_id));
        }
    }
}

/// Writes the record for one `execute_cli` outcome; never fails the run.
pub(crate) fn record_run_outcome_at(
    root: &Path,
    user_id: Option<&str>,
    skill_id: &str,
    observation: &RunObservation<'_>,
    agent: Option<&str>,
) {
    let Some(user_id) = user_id else {
        return;
    };
    let record = build_record(skill_id, observation, agent, crate::key_vault::now_ms());
    let _ = write_last_run_at(root, user_id, &record);
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const USER_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("skillhub-last-run-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create fixture");
        root
    }

    #[test]
    fn classifier_extracts_key_names_from_our_own_formats() {
        assert_eq!(
            classify_run_failure(
                "MISSING_KEY: REPLICATE_API_TOKEN 需要填写：请在 SkillHub APP 的 Skill 详情「需要的钥匙」中填写"
            ),
            (RunFailureCode::MissingKey, vec!["REPLICATE_API_TOKEN".into()])
        );
        assert_eq!(
            classify_run_failure("MISSING_KEY: 缺少必需环境变量 FAL_KEY"),
            (RunFailureCode::MissingKey, vec!["FAL_KEY".into()])
        );
        assert_eq!(
            classify_run_failure(
                "NEEDS_CHOICE: API_KEY 有多个来源可选，请在 SkillHub APP 中选择用哪把钥匙"
            ),
            (RunFailureCode::NeedsChoice, vec!["API_KEY".into()])
        );
        assert_eq!(
            classify_run_failure(
                "NEEDS_CONSENT: 「Skill 想使用你的钥匙 X」想使用你的钥匙 K1、K2；APP 会弹出授权窗，请用户确认后重试"
            ),
            (RunFailureCode::NeedsConsent, vec!["K1".into(), "K2".into()])
        );
        assert_eq!(
            classify_run_failure(
                "NEEDS_CONSENT: 「Demo」想使用你的钥匙 K1、K2；APP 会弹出授权窗，请用户确认后重试"
            ),
            (RunFailureCode::NeedsConsent, vec!["K1".into(), "K2".into()])
        );
        assert_eq!(
            classify_run_failure("当前 SkillHub 登录已失效，请打开 APP 重新登录"),
            (RunFailureCode::Other, Vec::new())
        );
        assert_eq!(
            classify_run_failure("MISSING_KEY: not-a-key 需要填写"),
            (RunFailureCode::MissingKey, Vec::new())
        );
    }

    #[test]
    fn agent_detection_reads_names_only() {
        assert_eq!(
            detect_agent_from_names(["PATH", "CLAUDECODE"]),
            Some("claude")
        );
        assert_eq!(
            detect_agent_from_names(["CLAUDE_CODE_ENTRYPOINT"]),
            Some("claude")
        );
        assert_eq!(detect_agent_from_names(["CODEX_SANDBOX"]), Some("codex"));
        assert_eq!(detect_agent_from_names(["CODEX_THREAD_ID"]), Some("codex"));
        assert_eq!(detect_agent_from_names(["GEMINI_CLI"]), Some("gemini"));
        assert_eq!(detect_agent_from_names(["CURSOR_TRACE_ID"]), None);
        assert_eq!(detect_agent_from_names(["HOME", "CODEX"]), None);
        assert_eq!(detect_agent_from_names(Vec::<String>::new()), None);
    }

    #[test]
    fn records_are_private_isolated_and_cleared_on_fill() {
        let root = fixture();
        let missing =
            "MISSING_KEY: FAL_KEY 需要填写：请在 SkillHub APP 的 Skill 详情「需要的钥匙」中填写";
        record_run_outcome_at(
            &root,
            Some(USER_A),
            "alpha",
            &RunObservation::ResolveFailed(missing),
            Some("claude"),
        );
        record_run_outcome_at(
            &root,
            Some(USER_A),
            "beta",
            &RunObservation::Exited(7),
            None,
        );
        record_run_outcome_at(&root, None, "gamma", &RunObservation::Exited(1), None);

        let failures = list_last_run_failures_at(&root, USER_A).expect("list A");
        assert_eq!(failures.len(), 2);
        let alpha = failures
            .iter()
            .find(|record| record.skill_id == "alpha")
            .expect("alpha");
        assert_eq!(alpha.reason_code, Some(RunFailureCode::MissingKey));
        assert_eq!(alpha.keys, vec!["FAL_KEY".to_string()]);
        assert_eq!(alpha.agent.as_deref(), Some("claude"));
        let beta = failures
            .iter()
            .find(|record| record.skill_id == "beta")
            .expect("beta");
        assert_eq!(beta.reason_code, Some(RunFailureCode::ExitCode));
        assert_eq!(beta.exit_code, Some(7));
        assert!(list_last_run_failures_at(&root, USER_B)
            .expect("list B")
            .is_empty());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode =
                |path: &Path| fs::metadata(path).expect("metadata").permissions().mode() & 0o777;
            assert_eq!(mode(&user_dir_at(&root, USER_A)), 0o700);
            assert_eq!(mode(&last_run_root_at(&root)), 0o700);
            assert_eq!(mode(&record_path_at(&root, USER_A, "alpha")), 0o600);
        }
        let json = fs::read_to_string(record_path_at(&root, USER_A, "alpha")).expect("json");
        let value: serde_json::Value = serde_json::from_str(&json).expect("parse");
        assert_eq!(value["outcome"], "failed");
        assert_eq!(value["reasonCode"], "missing_key");
        assert_eq!(value["keys"], serde_json::json!(["FAL_KEY"]));
        assert_eq!(value["exitCode"], serde_json::Value::Null);
        assert_eq!(value["version"], 1);

        // Filling a key in another Skill only does not clear alpha.
        clear_failures_for_keys_at(&root, USER_A, &["FAL_KEY"], Some("beta"));
        assert!(read_last_run_at(&root, USER_A, "alpha").is_some());
        clear_failures_for_keys_at(&root, USER_A, &["OTHER_KEY"], None);
        assert!(read_last_run_at(&root, USER_A, "alpha").is_some());
        // A labelled value `FAL_KEY__V1` (#306) counts as its name.
        clear_failures_for_keys_at(&root, USER_A, &["FAL_KEY__V1"], None);
        assert!(read_last_run_at(&root, USER_A, "alpha").is_none());
        let consent = "NEEDS_CONSENT: 「A」想使用你的钥匙 FAL_KEY · 公司、OPENAI_API_KEY；APP 会弹出授权窗，请用户确认后重试";
        assert_eq!(
            classify_run_failure(consent),
            (
                RunFailureCode::NeedsConsent,
                vec!["FAL_KEY".to_string(), "OPENAI_API_KEY".to_string()]
            )
        );

        // Success overwrites; clearing keeps an ok record.
        record_run_outcome_at(
            &root,
            Some(USER_A),
            "beta",
            &RunObservation::Exited(0),
            None,
        );
        let ok = read_last_run_at(&root, USER_A, "beta").expect("ok record");
        assert_eq!(ok.outcome, RunOutcome::Ok);
        assert_eq!(ok.message, None);
        clear_last_run_failure_at(&root, USER_A, "beta").expect("clear");
        assert!(read_last_run_at(&root, USER_A, "beta").is_some());
        assert!(list_last_run_failures_at(&root, USER_A)
            .expect("list")
            .is_empty());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn spawn_failures_and_long_messages_are_bounded() {
        let record = build_record(
            "alpha",
            &RunObservation::ChildFailed("无法启动目标进程: No such file or directory"),
            None,
            1,
        );
        assert_eq!(record.reason_code, Some(RunFailureCode::SpawnFailed));
        let long = "x".repeat(500);
        let record = build_record("alpha", &RunObservation::ResolveFailed(&long), None, 1);
        assert_eq!(record.reason_code, Some(RunFailureCode::Other));
        assert_eq!(
            record.message.as_deref().map(|m| m.chars().count()),
            Some(200)
        );
    }
}
