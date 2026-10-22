//! Capture installation evidence before startup creates a session or system Skill.
use std::path::Path;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    has_session: bool,
    has_managed_skills: bool,
}

pub struct StartupEvidence(pub Result<Evidence, String>);

pub fn capture(root: &Path) -> Result<Evidence, String> {
    let has_session = root
        .join("runtime/session.json")
        .try_exists()
        .map_err(|e| e.to_string())?;
    let skills = root.join("skills");
    let mut has_managed_skills = false;
    if skills.try_exists().map_err(|e| e.to_string())? {
        for entry in std::fs::read_dir(skills).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name() != "yitan-skillhub-manager" {
                has_managed_skills = true;
                break;
            }
        }
    }
    Ok(Evidence {
        has_session,
        has_managed_skills,
    })
}

#[tauri::command]
pub fn onboarding_evidence(state: tauri::State<'_, StartupEvidence>) -> Result<Evidence, String> {
    state.0.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captures_before_startup_and_excludes_bundled_skill() {
        let root = std::env::temp_dir().join(format!("onboarding-{}", uuid::Uuid::new_v4()));
        let empty = capture(&root).unwrap();
        assert!(!empty.has_session && !empty.has_managed_skills);
        std::fs::create_dir_all(root.join("skills/yitan-skillhub-manager")).unwrap();
        assert!(!capture(&root).unwrap().has_managed_skills);
        std::fs::create_dir_all(root.join("skills/example")).unwrap();
        assert!(capture(&root).unwrap().has_managed_skills);
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        std::fs::write(root.join("runtime/session.json"), "{}").unwrap();
        assert!(capture(&root).unwrap().has_session);
        assert!(!empty.has_session);
        std::fs::remove_dir_all(root).unwrap();
    }
}
