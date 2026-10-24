#[cfg(windows)]
use crate::platform_fs::PermissionsExt;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub const SYSTEM_MANAGER_ID: &str = "yitan-skillhub-manager";
pub const SYSTEM_MANAGER_DISPLAY_NAME: &str = "SkillHub Manager";
pub const SYSTEM_MANAGER_VERSION: &str = concat!("v", env!("CARGO_PKG_VERSION"));

const LEGACY_REFERENCE_FILES: [&str; 4] = [
    "editing.md",
    "operations.md",
    "credentials.md",
    "sharing.md",
];

pub fn files() -> [(&'static str, &'static str); 13] {
    [
        (
            "SKILL.md",
            include_str!("../system-skills/yitan-skillhub-manager/SKILL.md"),
        ),
        (
            "references/auth-and-account.md",
            include_str!("../system-skills/yitan-skillhub-manager/references/auth-and-account.md"),
        ),
        (
            "references/status-and-updates.md",
            include_str!(
                "../system-skills/yitan-skillhub-manager/references/status-and-updates.md"
            ),
        ),
        (
            "references/app-control.md",
            include_str!("../system-skills/yitan-skillhub-manager/references/app-control.md"),
        ),
        (
            "references/local-skills.md",
            include_str!("../system-skills/yitan-skillhub-manager/references/local-skills.md"),
        ),
        (
            "references/installation-conflicts.md",
            include_str!(
                "../system-skills/yitan-skillhub-manager/references/installation-conflicts.md"
            ),
        ),
        (
            "references/editing-and-versions.md",
            include_str!(
                "../system-skills/yitan-skillhub-manager/references/editing-and-versions.md"
            ),
        ),
        (
            "references/marketplace.md",
            include_str!("../system-skills/yitan-skillhub-manager/references/marketplace.md"),
        ),
        (
            "references/team-skills.md",
            include_str!("../system-skills/yitan-skillhub-manager/references/team-skills.md"),
        ),
        (
            "references/analysis.md",
            include_str!("../system-skills/yitan-skillhub-manager/references/analysis.md"),
        ),
        (
            "references/credentials-runtime.md",
            include_str!(
                "../system-skills/yitan-skillhub-manager/references/credentials-runtime.md"
            ),
        ),
        (
            "references/support-troubleshooting.md",
            include_str!(
                "../system-skills/yitan-skillhub-manager/references/support-troubleshooting.md"
            ),
        ),
        (
            "references/cli-contract-security.md",
            include_str!(
                "../system-skills/yitan-skillhub-manager/references/cli-contract-security.md"
            ),
        ),
    ]
}

pub(crate) fn cleanup_legacy_files(system_manager_root: &Path) -> Result<(), String> {
    let references = system_manager_root.join("references");
    let references_metadata = match fs::symlink_metadata(&references) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("无法检查 SkillHub Manager 旧引用目录: {error}")),
    };
    if references_metadata.file_type().is_symlink() || !references_metadata.is_dir() {
        return Err("SkillHub Manager 旧引用目录不是安全的普通目录，已阻止清理".into());
    }
    #[cfg(unix)]
    fs::set_permissions(&references, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("无法解锁 SkillHub Manager 旧引用目录: {error}"))?;
    #[cfg(windows)]
    {
        fs::set_permissions(&references, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("无法解锁 SkillHub Manager 旧引用目录: {error}"))?;
    }

    let mut legacy_paths = Vec::<PathBuf>::new();
    for filename in LEGACY_REFERENCE_FILES {
        let path = references.join(filename);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "SkillHub Manager 旧引用 {filename} 是符号链接，已阻止清理"
                ));
            }
            Ok(metadata) if metadata.is_file() => legacy_paths.push(path),
            Ok(_) => {
                return Err(format!(
                    "SkillHub Manager 旧引用 {filename} 不是普通文件，已阻止清理"
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "无法检查 SkillHub Manager 旧引用 {filename}: {error}"
                ));
            }
        }
    }

    for path in legacy_paths {
        let filename = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("未知文件");
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(format!(
                    "SkillHub Manager 旧引用 {filename} 在清理前发生变化，已停止"
                ));
            }
            Ok(_metadata) => {
                #[cfg(windows)]
                {
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(
                        |error| format!("无法解锁 SkillHub Manager 旧引用 {filename}: {error}"),
                    )?;
                }
                fs::remove_file(&path).map_err(|error| {
                    format!("无法清理 SkillHub Manager 旧引用 {filename}: {error}")
                })?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "无法再次检查 SkillHub Manager 旧引用 {filename}: {error}"
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{cleanup_legacy_files, files, LEGACY_REFERENCE_FILES, SYSTEM_MANAGER_VERSION};
    use std::fs;

    #[test]
    fn system_manager_version_matches_package_version() {
        assert_eq!(
            SYSTEM_MANAGER_VERSION,
            format!("v{}", env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn bundled_skill_frontmatter_has_no_version() {
        let index = files()[0].1;
        let mut lines = index.lines();
        assert_eq!(lines.next(), Some("---"));
        let frontmatter: Vec<_> = lines.by_ref().take_while(|line| *line != "---").collect();
        assert!(index.lines().skip(1).any(|line| line == "---"));
        assert!(!frontmatter
            .iter()
            .any(|line| line.trim_start().starts_with("version:")));
    }

    fn fixture_root(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "skillhub-system-skill-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn bundled_guidance_matches_the_public_cli_surface() {
        let bundled_files = files();
        let index = bundled_files
            .iter()
            .find_map(|(name, contents)| (*name == "SKILL.md").then_some(*contents))
            .expect("bundled Manager index");
        let guidance = bundled_files
            .into_iter()
            .map(|(_, contents)| contents)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(index.contains("控制面命令默认输出 JSON 信封，`--json` 可省略"));
        assert!(guidance.contains("用法错误的 `nextActions` 提供对应的 `--help` 命令"));
        let cli_usage = [
            crate::CLI_USAGE,
            crate::cli_local::SKILL_USAGE,
            crate::cli_cloud::MARKETPLACE_USAGE,
            crate::cli_cloud::TEAM_USAGE,
            crate::cli_acquire::MARKETPLACE_ACQUIRE_USAGE,
            crate::cli_acquire::TEAM_ACQUIRE_USAGE,
            crate::cli_team::TEAM_MUTATION_USAGE,
            crate::cli_operations::ANALYZE_USAGE,
            crate::cli_operations::ENV_USAGE,
            crate::cli_feedback::FEEDBACK_USAGE,
            crate::runtime_env::RUN_USAGE,
        ]
        .join("\n");
        assert!(!cli_usage.contains(" --json"));
        assert!(guidance.contains("skillhub auth status [--refresh] [--json]"));
        let required_commands = [
            "skillhub server show",
            "skillhub server use",
            "skillhub status",
            "skillhub doctor",
            "skillhub auth status [--refresh]",
            "skillhub app open",
            "skillhub update check",
            "skillhub agent list",
            "skillhub marketplace search",
            "skillhub marketplace show",
            "skillhub team list",
            "skillhub team skills",
            "skillhub team show",
            "skillhub skill analyze",
            "skillhub skill enable preflight",
            "skillhub skill disable preflight",
            "skillhub skill uninstall preflight",
            "skillhub skill restore-version preflight",
            "skillhub marketplace updates",
            "skillhub team updates",
            "skillhub team share preflight",
            "skillhub team share status",
            "skillhub team unshare preflight",
            "skillhub feedback submit preflight",
            "skillhub feedback status",
            "skillhub run <skill-id> -- <program>",
            "skillhub env status",
            "skillhub env request --skill-id",
        ];
        for command in required_commands {
            assert!(
                cli_usage.contains(command),
                "public CLI usage is missing {command}"
            );
            assert!(
                guidance.contains(command),
                "bundled Skill guidance is missing {command}"
            );
        }

        for obsolete_claim in [
            "本版 CLI 没有 `feedback submit`",
            "本版 CLI 没有 `restore-version`",
            "本版 CLI 没有独立的 enable",
            "本版 CLI 没有 Marketplace `updates`",
            "本版 CLI 没有 `share`",
            "skillhub run <skill-id> -- env",
            "CLI 本版没有环境变量写入命令",
        ] {
            assert!(
                !guidance.contains(obsolete_claim),
                "bundled Skill still contains obsolete guidance: {obsolete_claim}"
            );
        }

        for projection_contract in [
            "`installedAgents`",
            "`agentStates`",
            "`installed`",
            "`notInstalled`",
            "`conflict`",
            "`unknown`",
        ] {
            assert!(
                guidance.contains(projection_contract),
                "bundled Skill is missing projection contract: {projection_contract}"
            );
        }

        assert!(index.contains("CLI 或 Agent 投影故障"));
        assert!(index.contains("空间与服务器"));
        assert!(!index.contains("本 Skill 的前提不成立"));
        let support = bundled_files
            .iter()
            .find_map(|(name, contents)| {
                (*name == "references/support-troubleshooting.md").then_some(*contents)
            })
            .expect("bundled troubleshooting reference");
        assert!(support.contains("找不到 skillhub 命令"));
        for reference in [
            "references/support-troubleshooting.md",
            "references/local-skills.md",
            "references/credentials-runtime.md",
        ] {
            assert!(
                index.contains(reference),
                "Manager troubleshooting route is missing {reference}"
            );
        }
    }

    #[test]
    fn legacy_cleanup_removes_only_allowlisted_regular_files() {
        let root = fixture_root("legacy-cleanup");
        let references = root.join("references");
        fs::create_dir_all(&references).expect("create references fixture");
        for filename in LEGACY_REFERENCE_FILES {
            fs::write(references.join(filename), "legacy\n").expect("write legacy reference");
        }
        fs::write(references.join("keep.md"), "keep\n").expect("write unknown reference");

        cleanup_legacy_files(&root).expect("clean legacy references");

        for filename in LEGACY_REFERENCE_FILES {
            assert!(!references.join(filename).exists());
        }
        assert_eq!(
            fs::read_to_string(references.join("keep.md")).expect("read unknown reference"),
            "keep\n"
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn legacy_cleanup_rejects_non_file_without_partial_deletion() {
        let root = fixture_root("legacy-directory");
        let references = root.join("references");
        fs::create_dir_all(references.join("operations.md")).expect("create directory collision");
        fs::write(references.join("editing.md"), "legacy\n").expect("write legacy reference");

        let error = cleanup_legacy_files(&root).expect_err("reject legacy directory");

        assert!(error.contains("operations.md"));
        assert!(references.join("editing.md").is_file());
        assert!(references.join("operations.md").is_dir());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[cfg(unix)]
    #[test]
    fn legacy_cleanup_rejects_symlink_without_touching_target() {
        use std::os::unix::fs::symlink;

        let root = fixture_root("legacy-symlink");
        let references = root.join("references");
        fs::create_dir_all(&references).expect("create references fixture");
        let target = root.join("outside.md");
        fs::write(&target, "outside\n").expect("write symlink target");
        symlink(&target, references.join("editing.md")).expect("create legacy symlink");

        let error = cleanup_legacy_files(&root).expect_err("reject legacy symlink");

        assert!(error.contains("editing.md"));
        assert_eq!(
            fs::read_to_string(&target).expect("read symlink target"),
            "outside\n"
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }
}
