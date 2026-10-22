//! Private Skill organizer data (#323, EPIC #321): custom tags, sidebar quick
//! access and collapsed tag groups of one account on this device.
//!
//! Everything lives in one file per account, `~/.skillhub/organizer/<key>.json`,
//! where `<key>` is the signed-in SkillHub user UUID or the literal `guest`.
//! One file per account keeps account isolation structural (switching
//! accounts reads another file) and gives quick access (#325) and Server sync
//! dirty-tracking (#326) a single place to live. Tags are user-private: they
//! never enter a Skill folder, sidecar, package, team share or Marketplace.
//!
//! The TypeScript layer (`desktop/src/lib/skill-organizer.ts`) owns the tag
//! rules; Rust only checks the shape and size limits so a broken or hostile
//! file cannot grow without bound, and writes atomically (temp file + rename).

use crate::runtime_env::{validate_user_id, write_private_json};
use crate::skillhub_dir;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) const ORGANIZER_VERSION: u32 = 1;
pub(crate) const GUEST_ACCOUNT_KEY: &str = "guest";
/// Whole serialized state; far above 200 tags × thousands of Skills.
pub(crate) const MAX_ORGANIZER_BYTES: usize = 1024 * 1024;
const MAX_TAGGED_SKILLS: usize = 20_000;
const MAX_SKILL_KEY_CHARS: usize = 160;
/// Same limits as the Server (`server/src/lib/library-organizer.ts`); lengths in Unicode scalar values (code points).
const TAG_NAME_MAX_CHARS: usize = 32;
const TAGS_PER_SKILL_MAX: usize = 8;
const QUICK_ACCESS_ITEMS_MAX: usize = 100;
const COLLAPSED_TAGS_MAX: usize = 400;
const TAG_KEY_MAX_UNITS: usize = 64;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuickAccessState {
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub items: Vec<QuickAccessItem>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum QuickAccessKind {
    Tag,
    Skill,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct QuickAccessItem {
    pub kind: QuickAccessKind,
    #[serde(rename = "ref")]
    pub reference: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerState {
    pub version: u32,
    /// skillKey (`entry:<libraryEntryId>` or `local:<skillId>`) → tag names.
    #[serde(default)]
    pub tags: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub quick_access: QuickAccessState,
    /// Lower-cased tag keys whose group is collapsed on the 标签 page (#324).
    #[serde(default)]
    pub collapsed_tags: Vec<String>,
    /// Sync bookkeeping owned by the TypeScript layer (#326); kept opaque.
    #[serde(default = "default_sync")]
    pub sync: Value,
    /// Fields written by a newer build of the same version are kept on save.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn default_sync() -> Value {
    serde_json::json!({ "dirtyTagKeys": [], "quickAccessDirty": false, "lastSyncedAt": null })
}

impl Default for OrganizerState {
    fn default() -> Self {
        Self {
            version: ORGANIZER_VERSION,
            tags: BTreeMap::new(),
            quick_access: QuickAccessState::default(),
            collapsed_tags: Vec::new(),
            sync: default_sync(),
            extra: Map::new(),
        }
    }
}

/// `guest` or a SkillHub user UUID, returned in canonical lower-case form.
pub(crate) fn normalize_account_key(account_key: &str) -> Result<String, String> {
    if account_key == GUEST_ACCOUNT_KEY {
        return Ok(GUEST_ACCOUNT_KEY.to_string());
    }
    validate_user_id(account_key)?;
    uuid::Uuid::parse_str(account_key)
        .map(|id| id.hyphenated().to_string())
        .map_err(|_| "SkillHub 账号编号无效".to_string())
}

fn organizer_dir_at(root: &Path) -> PathBuf {
    root.join("organizer")
}

fn organizer_path_at(root: &Path, account_key: &str) -> PathBuf {
    organizer_dir_at(root).join(format!("{account_key}.json"))
}

fn char_len(value: &str) -> usize {
    value.chars().count()
}

fn has_invisible(value: &str) -> bool {
    value.chars().any(|character| {
        character.is_control()
            || matches!(character as u32, 0x200b..=0x200f | 0x2028..=0x202e | 0x2060..=0x206f | 0xfeff)
    })
}

fn validate_text(value: &str, max_units: usize, what: &str) -> Result<(), String> {
    if value.trim().is_empty() || char_len(value) > max_units || has_invisible(value) {
        return Err(format!("标签数据无效：{what}"));
    }
    Ok(())
}

pub(crate) fn validate_state(state: &OrganizerState) -> Result<(), String> {
    if state.version != ORGANIZER_VERSION {
        return Err("标签数据版本不受支持".into());
    }
    if state.tags.len() > MAX_TAGGED_SKILLS {
        return Err("标签数据无效：Skill 数量过多".into());
    }
    for (skill_key, names) in &state.tags {
        if skill_key.is_empty()
            || skill_key.chars().count() > MAX_SKILL_KEY_CHARS
            || has_invisible(skill_key)
        {
            return Err("标签数据无效：Skill 标识".into());
        }
        if names.len() > TAGS_PER_SKILL_MAX {
            return Err(format!("每个 Skill 最多 {TAGS_PER_SKILL_MAX} 个标签"));
        }
        for name in names {
            validate_text(name, TAG_NAME_MAX_CHARS, "标签名")?;
        }
    }
    if state.quick_access.items.len() > QUICK_ACCESS_ITEMS_MAX {
        return Err(format!("快捷访问最多 {QUICK_ACCESS_ITEMS_MAX} 项"));
    }
    for item in &state.quick_access.items {
        validate_text(&item.reference, MAX_SKILL_KEY_CHARS, "快捷访问条目")?;
    }
    if state.collapsed_tags.len() > COLLAPSED_TAGS_MAX {
        return Err("标签数据无效：折叠分组过多".into());
    }
    for key in &state.collapsed_tags {
        validate_text(key, TAG_KEY_MAX_UNITS, "折叠分组")?;
    }
    if !state.sync.is_object() {
        return Err("标签数据无效：同步状态".into());
    }
    let size = serde_json::to_vec(state)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_ORGANIZER_BYTES {
        return Err("标签数据过大".into());
    }
    Ok(())
}

fn unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

/// Move an unreadable file aside so the next save does not destroy it.
fn quarantine_corrupt(path: &Path) -> Result<(), String> {
    let backup = path.with_extension(format!("json.corrupt-{}", unix_millis()));
    fs::rename(path, &backup).map_err(|error| format!("无法备份损坏的标签数据：{error}"))
}

pub(crate) fn load_organizer_at(root: &Path, account_key: &str) -> Result<OrganizerState, String> {
    let account_key = normalize_account_key(account_key)?;
    let path = organizer_path_at(root, &account_key);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(OrganizerState::default())
        }
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("标签数据不是安全的普通文件".into());
    }
    if metadata.len() > MAX_ORGANIZER_BYTES as u64 {
        quarantine_corrupt(&path)?;
        return Ok(OrganizerState::default());
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let parsed = serde_json::from_slice::<Value>(&bytes).ok();
    // A newer APP may have written a newer format: refuse instead of discarding it.
    if let Some(version) = parsed
        .as_ref()
        .and_then(|value| value.get("version"))
        .and_then(Value::as_u64)
    {
        if version > u64::from(ORGANIZER_VERSION) {
            return Err("标签数据由更新版本的 SkillHub 写入，请升级 APP".into());
        }
    }
    let state = parsed.and_then(|value| serde_json::from_value::<OrganizerState>(value).ok());
    match state {
        Some(state) if validate_state(&state).is_ok() => Ok(state),
        _ => {
            quarantine_corrupt(&path)?;
            Ok(OrganizerState::default())
        }
    }
}

pub(crate) fn save_organizer_at(
    root: &Path,
    account_key: &str,
    state: &OrganizerState,
) -> Result<(), String> {
    let account_key = normalize_account_key(account_key)?;
    validate_state(state)?;
    write_private_json(&organizer_path_at(root, &account_key), state)
}

#[tauri::command]
pub async fn organizer_load(
    account_key: String,
    space: crate::server_request::SpaceHandle,
) -> Result<OrganizerState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_organizer(&account_key, &space, |root| {
            load_organizer_at(root, &account_key)
        })
    })
    .await
    .map_err(|error| format!("organizer_load异常结束: {error}"))?
}

#[tauri::command]
pub async fn organizer_save(
    account_key: String,
    space: crate::server_request::SpaceHandle,
    state: OrganizerState,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_organizer(&account_key, &space, |root| {
            save_organizer_at(root, &account_key, &state)
        })
    })
    .await
    .map_err(|error| format!("organizer_save异常结束: {error}"))?
}

fn with_organizer<T>(
    account_key: &str,
    space: &crate::server_request::SpaceHandle,
    operation: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let session = crate::runtime_env::runtime_session_snapshot()?;
    let account = if session.auth_token().is_some() {
        session.user_id()
    } else {
        "guest"
    };
    if session.is_sync_pending()
        || crate::server_request::SpaceRegistry::handle(Some(&session)) != *space
        || account != account_key
    {
        return Err(crate::spaces::STALE.into());
    }
    let _lease =
        crate::runtime_env::acquire_current_session_lease(&session)?.ok_or(crate::spaces::STALE)?;
    operation(&session.storage_root(&skillhub_dir()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const USER_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    fn fixture() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("skillhub-organizer-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create fixture");
        root
    }

    fn sample() -> OrganizerState {
        let mut state = OrganizerState::default();
        state
            .tags
            .insert("entry:e1".into(), vec!["写作".into(), "Daily".into()]);
        state.tags.insert("local:abc".into(), vec!["写作".into()]);
        state.quick_access = QuickAccessState {
            revision: 3,
            items: vec![
                QuickAccessItem {
                    kind: QuickAccessKind::Tag,
                    reference: "写作".into(),
                },
                QuickAccessItem {
                    kind: QuickAccessKind::Skill,
                    reference: "entry:e1".into(),
                },
            ],
        };
        state.collapsed_tags = vec!["daily".into()];
        state.sync = serde_json::json!({ "dirtyTagKeys": ["entry:e1"], "quickAccessDirty": true, "lastSyncedAt": null });
        state
    }

    #[test]
    fn account_keys_are_guest_or_canonical_uuids() {
        assert_eq!(normalize_account_key("guest").unwrap(), "guest");
        assert_eq!(normalize_account_key(USER_A).unwrap(), USER_A);
        assert_eq!(
            normalize_account_key(&USER_A.to_uppercase()).unwrap(),
            USER_A
        );
        for bad in ["", "Guest", "../guest", "guest/..", "not-a-uuid", "a/b"] {
            assert!(
                normalize_account_key(bad).is_err(),
                "{bad} must be rejected"
            );
        }
    }

    #[test]
    fn missing_file_loads_the_empty_default() {
        let root = fixture();
        let state = load_organizer_at(&root, USER_A).unwrap();
        assert_eq!(state, OrganizerState::default());
        assert_eq!(state.sync["quickAccessDirty"], false);
    }

    #[test]
    fn round_trips_per_account_without_leaking_between_accounts() {
        let root = fixture();
        save_organizer_at(&root, USER_A, &sample()).unwrap();
        assert_eq!(load_organizer_at(&root, USER_A).unwrap(), sample());
        assert_eq!(
            load_organizer_at(&root, USER_B).unwrap(),
            OrganizerState::default()
        );
        assert_eq!(
            load_organizer_at(&root, "guest").unwrap(),
            OrganizerState::default()
        );
        // No temporary files are left behind by the atomic write.
        let names = fs::read_dir(organizer_dir_at(&root))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, vec![format!("{USER_A}.json")]);
    }

    #[test]
    fn unknown_fields_survive_a_round_trip() {
        let root = fixture();
        let path = organizer_path_at(&root, USER_A);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"version":1,"tags":{},"quickAccess":{"revision":0,"items":[]},"collapsedTags":[],"sync":{"future":1},"later":true}"#,
        )
        .unwrap();
        let state = load_organizer_at(&root, USER_A).unwrap();
        assert_eq!(state.extra.get("later"), Some(&Value::Bool(true)));
        assert_eq!(state.sync["future"], 1);
    }

    #[test]
    fn corrupt_file_is_backed_up_and_replaced_by_default() {
        let root = fixture();
        let path = organizer_path_at(&root, USER_A);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for contents in [
            "{not json".to_string(),
            r#"{"version":1,"tags":{"entry:x":["a","b","c","d","e","f","g","h","i"]}}"#.to_string(),
            r#"{"version":1,"tags":{"entry:x":["ok\u0000"]}}"#.to_string(),
        ] {
            fs::write(&path, contents.as_bytes()).unwrap();
            assert_eq!(
                load_organizer_at(&root, USER_A).unwrap(),
                OrganizerState::default()
            );
            assert!(!path.exists());
        }
        let backups = fs::read_dir(organizer_dir_at(&root))
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
            .count();
        assert!(backups >= 1);
    }

    #[test]
    fn newer_format_is_refused_and_kept() {
        let root = fixture();
        let path = organizer_path_at(&root, USER_A);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"version":2}"#).unwrap();
        assert!(load_organizer_at(&root, USER_A).is_err());
        assert!(path.exists());
    }

    #[test]
    fn oversized_state_is_rejected_on_save_and_quarantined_on_load() {
        let root = fixture();
        let mut state = OrganizerState::default();
        for index in 0..12_000 {
            state.tags.insert(
                format!("local:{index:0>40}"),
                vec![
                    "一个有点长的标签名称一二三四五六七八".into(),
                    "another-tag-name".into(),
                ],
            );
        }
        assert_eq!(
            save_organizer_at(&root, USER_A, &state).unwrap_err(),
            "标签数据过大"
        );
        let path = organizer_path_at(&root, USER_A);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, vec![b' '; MAX_ORGANIZER_BYTES + 1]).unwrap();
        assert_eq!(
            load_organizer_at(&root, USER_A).unwrap(),
            OrganizerState::default()
        );
        assert!(!path.exists());
    }

    #[test]
    fn save_enforces_tag_and_quick_access_limits() {
        let root = fixture();
        let mut state = OrganizerState::default();
        state.tags.insert("entry:e".into(), vec!["x".repeat(33)]);
        assert!(save_organizer_at(&root, USER_A, &state).is_err());
        state.tags.insert("entry:e".into(), vec!["中".repeat(32)]);
        assert!(save_organizer_at(&root, USER_A, &state).is_ok());
        state
            .tags
            .insert("entry:e".into(), vec!["a\u{200b}b".into()]);
        assert!(save_organizer_at(&root, USER_A, &state).is_err());
        state.tags.clear();
        state.quick_access.items = (0..101)
            .map(|index| QuickAccessItem {
                kind: QuickAccessKind::Skill,
                reference: format!("entry:{index}"),
            })
            .collect();
        assert!(save_organizer_at(&root, USER_A, &state).is_err());
        state.quick_access.items.truncate(100);
        state.sync = Value::Null;
        assert!(save_organizer_at(&root, USER_A, &state).is_err());
        assert!(save_organizer_at(&root, "../escape", &OrganizerState::default()).is_err());
    }
}
