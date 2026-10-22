//! Cross-process mutual exclusion for one managed Skill directory.
//!
//! Account sync, GUI edits and CLI writes take the same per-Skill lock before
//! they change a managed directory, so a download never replaces files that
//! another SkillHub writer is changing. External editors cannot take it; sync
//! therefore still re-verifies fingerprints under the lock before replacing.

#[cfg(windows)]
use crate::platform_fs::OpenOptionsExt as _;
use std::fs::{self, File, OpenOptions};
#[cfg(unix)]
use std::io;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as _;
#[cfg(unix)]
use std::os::unix::io::AsRawFd as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

const LOCK_ATTEMPTS: u32 = 400;
const LOCK_RETRY: Duration = Duration::from_millis(25);

/// Held while a managed Skill directory may be written. Dropping releases it.
#[derive(Debug)]
pub(crate) struct SkillDirLock {
    _file: File,
}

fn locks_dir_at(skillhub_root: &Path) -> PathBuf {
    skillhub_root.join("locks")
}

fn lock_path_at(skillhub_root: &Path, skill_id: &str) -> PathBuf {
    locks_dir_at(skillhub_root).join(format!("skill-{skill_id}.lock"))
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("无法创建 Skill 锁目录: {error}"))?;
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Skill 锁目录不是安全的真实目录".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Blocks (bounded, about ten seconds) until this process owns the Skill lock.
pub(crate) fn lock_skill_dir(skill_id: &str) -> Result<SkillDirLock, String> {
    lock_skill_dir_at(&crate::skillhub_dir(), skill_id)
}

pub(crate) fn lock_skill_dir_at(
    skillhub_root: &Path,
    skill_id: &str,
) -> Result<SkillDirLock, String> {
    acquire(skillhub_root, skill_id, false)?
        .ok_or_else(|| format!("Skill「{skill_id}」正被其他 SkillHub 操作修改，请稍后重试"))
}

/// Returns `None` immediately when another writer holds the lock.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn try_lock_skill_dir_at(
    skillhub_root: &Path,
    skill_id: &str,
) -> Result<Option<SkillDirLock>, String> {
    acquire(skillhub_root, skill_id, true)
}

fn acquire(
    skillhub_root: &Path,
    skill_id: &str,
    nonblocking: bool,
) -> Result<Option<SkillDirLock>, String> {
    crate::commands::validate_skill_id_for_lock(skill_id)?;
    ensure_private_directory(&locks_dir_at(skillhub_root))?;
    let path = lock_path_at(skillhub_root, skill_id);
    for attempt in 0..LOCK_ATTEMPTS {
        let opened = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(crate::platform_fs::NOFOLLOW_FLAG)
            .open(&path);
        // Windows: the private share mode makes a second open fail with a
        // sharing violation, which is the lock contention signal.
        #[cfg(windows)]
        let file = match opened {
            Ok(file) => file,
            Err(error) if matches!(error.raw_os_error(), Some(32 | 33)) => {
                if nonblocking {
                    return Ok(None);
                }
                if attempt + 1 == LOCK_ATTEMPTS {
                    return Ok(None);
                }
                std::thread::sleep(LOCK_RETRY);
                continue;
            }
            Err(error) => return Err(format!("无法打开 Skill 锁: {error}")),
        };
        #[cfg(unix)]
        let file = opened.map_err(|error| format!("无法打开 Skill 锁: {error}"))?;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err("Skill 锁不是普通文件".into());
        }
        #[cfg(unix)]
        {
            let operation = libc::LOCK_EX | libc::LOCK_NB;
            if unsafe { libc::flock(file.as_raw_fd(), operation) } != 0 {
                let error = io::Error::last_os_error();
                let contended = matches!(
                    error.raw_os_error(),
                    Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN
                );
                if !contended {
                    return Err(format!("无法锁定 Skill: {error}"));
                }
                if nonblocking || attempt + 1 == LOCK_ATTEMPTS {
                    return Ok(None);
                }
                drop(file);
                std::thread::sleep(LOCK_RETRY);
                continue;
            }
            // The lock file may have been replaced between open and flock.
            use std::os::unix::fs::MetadataExt as _;
            let current = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if current.file_type().is_symlink()
                || current.dev() != metadata.dev()
                || current.ino() != metadata.ino()
            {
                drop(file);
                continue;
            }
        }
        return Ok(Some(SkillDirLock { _file: file }));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("skillhub-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn second_writer_waits_for_the_first() {
        let root = root();
        let held = lock_skill_dir_at(&root, "demo").unwrap();
        assert!(try_lock_skill_dir_at(&root, "demo").unwrap().is_none());
        assert!(try_lock_skill_dir_at(&root, "other").unwrap().is_some());
        drop(held);
        assert!(try_lock_skill_dir_at(&root, "demo").unwrap().is_some());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_unsafe_skill_ids() {
        let root = root();
        assert!(lock_skill_dir_at(&root, "../escape").is_err());
        let _ = fs::remove_dir_all(root);
    }
}
