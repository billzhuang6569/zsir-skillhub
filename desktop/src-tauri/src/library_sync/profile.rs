//! The synced part of a Skill's sidecar ("资料"), normalized exactly the way
//! the server's `LibraryProfileSchema` accepts it, plus three-way merging.

use crate::{EnvDepRaw, SkillHubProfile};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

const COMPATIBLE_AGENTS: &[&str] = &[
    "claude",
    "codex",
    "agent-skills",
    "workbuddy",
    "workbuddy-ai",
    "doubao",
    "opencode",
    "openclaw",
    "gemini",
    "trae",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncEnvDependency {
    pub(crate) key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(default = "default_required")]
    pub(crate) required: bool,
}

fn default_required() -> bool {
    true
}

/// Display data synced with a library entry. Never holds configuration values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncProfile {
    pub(crate) display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    /// 「来源」 URL (#329/#330). Entries from older servers and baselines saved
    /// before #330 have none. On the wire it is omitted when `None`; the HTTP
    /// client turns that into an explicit `null` only for servers that
    /// advertise [`SOURCE_URL_CAPABILITY`], since omission means "keep".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) category: Option<String>,
    #[serde(default)]
    pub(crate) labels: Vec<String>,
    #[serde(default)]
    pub(crate) trigger_scenarios: Vec<String>,
    #[serde(default)]
    pub(crate) compatible_agents: Vec<String>,
    #[serde(default)]
    pub(crate) env_dependencies: Vec<SyncEnvDependency>,
}

/// Server capability that accepts and returns `profile.sourceUrl` (#329).
pub(crate) const SOURCE_URL_CAPABILITY: &str = "skills.source-url.v1";

/// JavaScript string length (UTF-16 code units), which zod limits measure.
fn js_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn truncate_js(value: &str, limit: usize) -> String {
    let mut used = 0;
    let mut output = String::new();
    for character in value.chars() {
        used += character.len_utf16();
        if used > limit {
            break;
        }
        output.push(character);
    }
    output
}

fn trimmed(value: Option<&str>, limit: usize) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_js(value, limit).trim().to_string())
        .filter(|value| !value.is_empty())
}

fn bounded_list(values: &[String], max_items: usize, item_limit: usize) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .iter()
        .filter_map(|value| trimmed(Some(value), item_limit))
        .filter(|value| seen.insert(value.clone()))
        .take(max_items)
        .collect()
}

fn env_key_is_valid(key: &str) -> bool {
    let mut characters = key.chars();
    matches!(characters.next(), Some('A'..='Z'))
        && key.len() <= 100
        && characters.all(|character| matches!(character, 'A'..='Z' | '0'..='9' | '_'))
}

impl SyncProfile {
    /// Brings any profile into the exact shape the server stores, so equal
    /// content always compares equal regardless of which device wrote it.
    pub(crate) fn normalized(&self) -> Self {
        let display_name = trimmed(Some(&self.display_name), 80).unwrap_or_else(|| "Skill".into());
        let description = self
            .description
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| truncate_js(value, 500));
        let mut seen_agents = BTreeSet::new();
        let compatible_agents = self
            .compatible_agents
            .iter()
            .map(|agent| agent.trim().to_string())
            .filter(|agent| COMPATIBLE_AGENTS.contains(&agent.as_str()))
            .filter(|agent| seen_agents.insert(agent.clone()))
            .collect();
        let mut seen_keys = BTreeSet::new();
        let env_dependencies = self
            .env_dependencies
            .iter()
            .filter(|dependency| env_key_is_valid(&dependency.key))
            .filter(|dependency| seen_keys.insert(dependency.key.clone()))
            .take(100)
            .map(|dependency| SyncEnvDependency {
                key: dependency.key.clone(),
                description: trimmed(dependency.description.as_deref(), 200),
                required: dependency.required,
            })
            .collect();
        Self {
            display_name,
            description,
            source_url: crate::sanitize_source_url(self.source_url.as_deref()),
            category: trimmed(self.category.as_deref(), 40),
            labels: bounded_list(&self.labels, 8, 40),
            trigger_scenarios: bounded_list(&self.trigger_scenarios, 8, 100),
            compatible_agents,
            env_dependencies,
        }
    }

    pub(crate) fn from_sidecar(profile: &SkillHubProfile, fallback_name: &str) -> Self {
        Self {
            display_name: profile
                .display_name
                .clone()
                .or_else(|| profile.name.clone())
                .unwrap_or_else(|| fallback_name.to_string()),
            description: profile.description.clone(),
            source_url: profile.source_url.clone(),
            category: profile.category.clone(),
            labels: profile.labels.clone(),
            trigger_scenarios: profile.trigger_scenarios.clone(),
            compatible_agents: profile.compatible_agents.clone(),
            env_dependencies: profile
                .env_dependencies
                .iter()
                .map(|dependency| SyncEnvDependency {
                    key: dependency.key.clone(),
                    description: dependency.description.clone(),
                    required: dependency.required,
                })
                .collect(),
        }
        .normalized()
    }

    /// Writes the synced fields into a sidecar, keeping each local-only env
    /// setting (share policy, shared teams, runtime-request origin/pending)
    /// for keys that still exist.
    /// With `source_url_synced` false (a server without
    /// [`SOURCE_URL_CAPABILITY`]) the sidecar's own source is kept, because
    /// such a server can neither store nor return it.
    pub(crate) fn apply_to_sidecar(&self, profile: &mut SkillHubProfile, source_url_synced: bool) {
        profile.display_name = Some(self.display_name.clone());
        profile.description = self.description.clone();
        if source_url_synced {
            profile.source_url = self.source_url.clone();
        }
        profile.category = self.category.clone();
        profile.labels = self.labels.clone();
        profile.trigger_scenarios = self.trigger_scenarios.clone();
        profile.compatible_agents = self.compatible_agents.clone();
        let previous = std::mem::take(&mut profile.env_dependencies);
        profile.env_dependencies = self
            .env_dependencies
            .iter()
            .map(|dependency| {
                let local = previous.iter().find(|item| item.key == dependency.key);
                EnvDepRaw {
                    key: dependency.key.clone(),
                    description: dependency.description.clone(),
                    required: dependency.required,
                    share_policy: local
                        .map(|item| item.share_policy.clone())
                        .unwrap_or_default(),
                    shared_teams: local
                        .map(|item| item.shared_teams.clone())
                        .unwrap_or_default(),
                    origin: local.and_then(|item| item.origin.clone()),
                    confidence: local.and_then(|item| item.confidence.clone()),
                    obtain: local.and_then(|item| item.obtain.clone()),
                    pending: local.and_then(|item| item.pending),
                }
            })
            .collect();
    }

    /// Display name of a conflict copy: the original plus "（副本）".
    pub(crate) fn as_copy(&self) -> Self {
        let suffix = "（副本）";
        let mut copy = self.clone();
        let base = truncate_js(&self.display_name, 80 - js_len(suffix));
        copy.display_name = format!("{}{suffix}", base.trim_end());
        copy
    }
}

/// Field-wise three-way merge. `None` means one field was changed to
/// different values on both sides, which the caller resolves with a copy.
pub(crate) fn merge3(
    base: &SyncProfile,
    local: &SyncProfile,
    remote: &SyncProfile,
) -> Option<SyncProfile> {
    fn pick<T: Clone + PartialEq>(base: &T, local: &T, remote: &T) -> Option<T> {
        if local == base || local == remote {
            Some(remote.clone())
        } else if remote == base {
            Some(local.clone())
        } else {
            None
        }
    }
    Some(SyncProfile {
        display_name: pick(
            &base.display_name,
            &local.display_name,
            &remote.display_name,
        )?,
        description: pick(&base.description, &local.description, &remote.description)?,
        source_url: pick(&base.source_url, &local.source_url, &remote.source_url)?,
        category: pick(&base.category, &local.category, &remote.category)?,
        labels: pick(&base.labels, &local.labels, &remote.labels)?,
        trigger_scenarios: pick(
            &base.trigger_scenarios,
            &local.trigger_scenarios,
            &remote.trigger_scenarios,
        )?,
        compatible_agents: pick(
            &base.compatible_agents,
            &local.compatible_agents,
            &remote.compatible_agents,
        )?,
        env_dependencies: pick(
            &base.env_dependencies,
            &local.env_dependencies,
            &remote.env_dependencies,
        )?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(name: &str) -> SyncProfile {
        SyncProfile {
            display_name: name.into(),
            ..SyncProfile::default()
        }
    }

    #[test]
    fn normalization_matches_server_limits() {
        let raw = SyncProfile {
            display_name: "  Demo  ".into(),
            description: Some("   ".into()),
            category: Some(" Tools ".into()),
            labels: (0..12)
                .map(|index| format!(" l{index} "))
                .chain(["l1".into()])
                .collect(),
            compatible_agents: vec!["claude".into(), "unknown".into(), "claude".into()],
            env_dependencies: vec![
                SyncEnvDependency {
                    key: "API_KEY".into(),
                    description: Some(" k ".into()),
                    required: true,
                },
                SyncEnvDependency {
                    key: "bad-key".into(),
                    description: None,
                    required: false,
                },
                SyncEnvDependency {
                    key: "API_KEY".into(),
                    description: None,
                    required: false,
                },
            ],
            ..SyncProfile::default()
        };
        let normalized = raw.normalized();
        assert_eq!(normalized.display_name, "Demo");
        assert_eq!(normalized.description, None);
        assert_eq!(normalized.category.as_deref(), Some("Tools"));
        assert_eq!(normalized.labels.len(), 8);
        assert_eq!(normalized.compatible_agents, vec!["claude".to_string()]);
        assert_eq!(normalized.env_dependencies.len(), 1);
        assert_eq!(
            normalized.env_dependencies[0].description.as_deref(),
            Some("k")
        );
        assert_eq!(normalized.normalized(), normalized);
    }

    #[test]
    fn normalization_keeps_both_workbuddy_targets() {
        let profile = SyncProfile {
            compatible_agents: vec!["workbuddy".into(), "workbuddy-ai".into()],
            ..Default::default()
        };
        assert_eq!(
            profile.normalized().compatible_agents,
            profile.compatible_agents
        );
    }

    #[test]
    fn merges_different_fields_and_detects_same_field_conflicts() {
        let base = profile("A");
        let mut local = base.clone();
        local.labels = vec!["mine".into()];
        let mut remote = base.clone();
        remote.display_name = "B".into();
        let merged = merge3(&base, &local, &remote).unwrap();
        assert_eq!(merged.display_name, "B");
        assert_eq!(merged.labels, vec!["mine".to_string()]);

        let mut conflicting = base.clone();
        conflicting.display_name = "C".into();
        assert!(merge3(&base, &conflicting, &remote).is_none());
        // Both sides making the same change is not a conflict.
        assert_eq!(merge3(&base, &remote, &remote).unwrap(), remote);
    }

    #[test]
    fn source_url_is_validated_merged_and_applied() {
        let raw = SyncProfile {
            display_name: "Demo".into(),
            source_url: Some("  https://github.com/acme/demo  ".into()),
            ..SyncProfile::default()
        };
        assert_eq!(
            raw.normalized().source_url.as_deref(),
            Some("https://github.com/acme/demo")
        );
        for invalid in [
            "javascript:alert(1)",
            "ftp://example.com/x",
            "https://user:pass@example.com/",
            "https://example.com/a b",
            "   ",
        ] {
            let profile = SyncProfile {
                source_url: Some(invalid.into()),
                ..raw.clone()
            };
            assert_eq!(profile.normalized().source_url, None, "{invalid}");
        }
        let long = format!("https://example.com/{}", "a".repeat(2048));
        assert_eq!(
            SyncProfile {
                source_url: Some(long),
                ..raw.clone()
            }
            .normalized()
            .source_url,
            None
        );

        // A profile without the field (old server / old baseline) reads as None.
        let old: SyncProfile = serde_json::from_str(r#"{"displayName":"Demo"}"#).unwrap();
        assert_eq!(old.source_url, None);
        // `None` is omitted on the wire so an old strict server accepts it.
        assert!(!serde_json::to_string(&old).unwrap().contains("sourceUrl"));

        // Three-way: a remote-only value is pulled, a local clear wins over an
        // unchanged remote, and different edits on both sides conflict.
        let base = profile("A");
        let mut remote = base.clone();
        remote.source_url = Some("https://x.com/acme".into());
        assert_eq!(merge3(&base, &base, &remote).unwrap(), remote);
        let cleared = base.clone();
        assert_eq!(merge3(&remote, &cleared, &remote).unwrap().source_url, None);
        let mut other = base.clone();
        other.source_url = Some("https://skills.sh/acme/demo".into());
        assert!(merge3(&base, &other, &remote).is_none());

        let mut sidecar = SkillHubProfile {
            source_url: Some("https://kept.example/".into()),
            ..SkillHubProfile::default()
        };
        base.apply_to_sidecar(&mut sidecar, false);
        assert_eq!(sidecar.source_url.as_deref(), Some("https://kept.example/"));
        base.apply_to_sidecar(&mut sidecar, true);
        assert_eq!(sidecar.source_url, None);
        remote.apply_to_sidecar(&mut sidecar, true);
        assert_eq!(sidecar.source_url.as_deref(), Some("https://x.com/acme"));
    }

    #[test]
    fn copy_name_stays_within_the_display_limit() {
        let long = profile(&"名".repeat(80));
        let copy = long.as_copy();
        assert!(copy.display_name.ends_with("（副本）"));
        assert!(js_len(&copy.display_name) <= 80);
    }

    #[test]
    fn applying_keeps_local_env_sharing_settings() {
        let mut sidecar = SkillHubProfile {
            env_dependencies: vec![EnvDepRaw {
                key: "API_KEY".into(),
                description: None,
                required: true,
                share_policy: "team".into(),
                shared_teams: vec!["t1".into()],
                origin: None,
                confidence: None,
                obtain: None,
                pending: None,
            }],
            ..SkillHubProfile::default()
        };
        let mut synced = SyncProfile::from_sidecar(&sidecar, "demo");
        synced.env_dependencies[0].description = Some("token".into());
        synced.apply_to_sidecar(&mut sidecar, true);
        assert_eq!(sidecar.env_dependencies[0].share_policy, "team");
        assert_eq!(
            sidecar.env_dependencies[0].description.as_deref(),
            Some("token")
        );
    }
}
