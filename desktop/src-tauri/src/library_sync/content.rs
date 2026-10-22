//! Platform-independent content identity of a managed Skill.
//!
//! ZIP bytes differ between platforms, so "same content" is decided by the
//! server-defined `skillhub-content-v1` hash plus the executable path set.

use crate::commands::{library_tree_files, LibraryTreeFile};
use icu_normalizer::ComposingNormalizerBorrowed;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::Path;

/// Read only bounded metadata; package landing still performs full archive validation.
pub(crate) fn package_skill_name(bytes: &[u8]) -> Option<String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let file = zip.by_name("SKILL.md").ok()?;
    let limit = crate::skill_document::RECOMMENDED_SKILL_MD_BYTES;
    let mut text = String::new();
    file.take(limit as u64 + 1).read_to_string(&mut text).ok()?;
    if text.len() > limit {
        return None;
    }
    let document = crate::skill_document::parse_skill_document(&text);
    let name = document.text("name")?;
    if document.unterminated
        || name.len() > crate::skill_document::SPEC_NAME_MAX_CHARS
        || !crate::skill_document::valid_spec_name(name)
    {
        return None;
    }
    Some(name.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContentIdentity {
    pub(crate) content_hash: String,
    /// Sorted bytewise (UTF-8), NFC-normalized relative paths.
    pub(crate) executable_paths: Vec<String>,
}

/// NFC form of a package path, as the server normalizes ZIP entry names.
pub(crate) fn nfc(path: &str) -> String {
    ComposingNormalizerBorrowed::new_nfc()
        .normalize(path)
        .into_owned()
}

/// `skillhub-content-v1`: files sorted by NFC path bytes, each framed as
/// `path\nlen\n` + bytes + `\n`, after the `skillhub-content-v1\n` header.
pub(crate) fn content_hash<P: AsRef<str>, D: AsRef<[u8]>>(files: &[(P, D)]) -> String {
    let mut ordered = files
        .iter()
        .map(|(path, data)| (nfc(path.as_ref()), data.as_ref()))
        .collect::<Vec<_>>();
    ordered.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    let mut hash = Sha256::new();
    hash.update(b"skillhub-content-v1\n");
    for (path, data) in ordered {
        hash.update(format!("{path}\n{}\n", data.len()).as_bytes());
        hash.update(data);
        hash.update(b"\n");
    }
    format!("{:x}", hash.finalize())
}

fn sorted_paths(paths: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut paths = paths.into_iter().collect::<Vec<_>>();
    paths.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    paths.dedup();
    paths
}

/// Executable paths of the local tree. Where the file system records no
/// executable bit (Windows), the synced baseline is authoritative.
pub(crate) fn executable_paths(
    files: &[LibraryTreeFile],
    baseline: Option<&[String]>,
) -> Vec<String> {
    if cfg!(windows) {
        let baseline = baseline
            .unwrap_or_default()
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        sorted_paths(
            files
                .iter()
                .map(|file| nfc(&file.path))
                .filter(|path| baseline.contains(path)),
        )
    } else {
        sorted_paths(
            files
                .iter()
                .filter(|file| file.executable)
                .map(|file| nfc(&file.path)),
        )
    }
}

/// Package-path executable override for Windows packaging; `None` on Unix,
/// where the packager reads the real executable bit.
pub(crate) fn package_executables(
    files: &[LibraryTreeFile],
    identity: &ContentIdentity,
) -> Option<BTreeSet<String>> {
    if !cfg!(windows) {
        return None;
    }
    let executable = identity
        .executable_paths
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    Some(
        files
            .iter()
            .filter(|file| executable.contains(&nfc(&file.path)))
            .map(|file| file.path.clone())
            .collect(),
    )
}

/// Content identity of a managed Skill directory (sidecar excluded).
pub(crate) fn local_identity(
    root: &Path,
    baseline_executables: Option<&[String]>,
) -> Result<(ContentIdentity, Vec<LibraryTreeFile>), String> {
    let files = library_tree_files(root)?;
    let mut contents = Vec::with_capacity(files.len());
    for file in &files {
        contents.push((
            file.path.clone(),
            fs::read(&file.absolute).map_err(|error| error.to_string())?,
        ));
    }
    let identity = ContentIdentity {
        content_hash: content_hash(&contents),
        executable_paths: executable_paths(&files, baseline_executables),
    };
    Ok((identity, files))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_server_content_hash_vector() {
        // server/src/lib/skill-package.test.ts "skillContentHash" vector.
        let files = [
            ("scripts/run.sh", "echo ok\n"),
            ("SKILL.md", "# Exec\n"),
            ("资料/说明.md", "中文\n"),
        ];
        assert_eq!(
            content_hash(&files),
            "2c30294abac1d915b8e9d5427c14547d16acb323f4cfcc4857e19bc75a9e0143"
        );
    }

    #[test]
    fn hash_ignores_input_order_and_normalization_form() {
        let composed = [("SKILL.md", "a"), ("caf\u{e9}.md", "b")];
        let decomposed = [("cafe\u{301}.md", "b"), ("SKILL.md", "a")];
        assert_eq!(content_hash(&composed), content_hash(&decomposed));
        assert_ne!(content_hash(&composed), content_hash(&[("SKILL.md", "a")]));
    }

    #[cfg(unix)]
    #[test]
    fn local_identity_tracks_the_executable_bit() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = std::env::temp_dir().join(format!("skillhub-content-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("scripts")).unwrap();
        fs::write(root.join("SKILL.md"), "# Exec\n").unwrap();
        fs::write(root.join("scripts/run.sh"), "echo ok\n").unwrap();
        fs::write(root.join(".skillhub.json"), "{}").unwrap();
        let (before, _) = local_identity(&root, None).unwrap();
        assert!(before.executable_paths.is_empty());
        fs::set_permissions(
            root.join("scripts/run.sh"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let (after, _) = local_identity(&root, None).unwrap();
        assert_eq!(after.content_hash, before.content_hash);
        assert_eq!(after.executable_paths, vec!["scripts/run.sh".to_string()]);
        let _ = fs::remove_dir_all(root);
    }
}
