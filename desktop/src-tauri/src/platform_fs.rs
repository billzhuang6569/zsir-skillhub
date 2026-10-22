//! Small compatibility layer for the filesystem guarantees used by SkillHub.
//!
//! The Unix implementation keeps the native APIs. Windows projects directory
//! trees through NTFS junctions (directories) and hard links (files), so users
//! do not need Developer Mode or administrator privileges.

#[cfg(windows)]
pub mod unix_fs {
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};

    fn absolute_target(source: &Path, link: &Path) -> io::Result<PathBuf> {
        let candidate = if source.is_absolute() {
            source.to_path_buf()
        } else {
            link.parent()
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "link has no parent"))?
                .join(source)
        };
        fs::canonicalize(candidate)
    }

    pub fn symlink<P: AsRef<Path>, Q: AsRef<Path>>(source: P, link: Q) -> io::Result<()> {
        let link = link.as_ref();
        let source = absolute_target(source.as_ref(), link)?;
        if fs::metadata(&source)?.is_dir() {
            junction::create(source, link)
        } else {
            fs::hard_link(source, link)
        }
    }
}

#[cfg(windows)]
pub trait MetadataExt {
    fn dev(&self) -> u64;
    fn ino(&self) -> u64;
    fn uid(&self) -> u32;
    fn nlink(&self) -> u64;
    fn mode(&self) -> u32;
}

#[cfg(windows)]
impl MetadataExt for std::fs::Metadata {
    fn dev(&self) -> u64 {
        use std::os::windows::fs::MetadataExt as _;
        self.file_attributes() as u64
    }

    fn ino(&self) -> u64 {
        use std::os::windows::fs::MetadataExt as _;
        self.creation_time()
            ^ self.last_write_time().rotate_left(17)
            ^ self.file_size().rotate_left(31)
    }

    fn uid(&self) -> u32 {
        0
    }

    fn nlink(&self) -> u64 {
        // Stable Rust does not currently expose BY_HANDLE_FILE_INFORMATION's
        // link count. SkillHub opens private files without delete sharing on
        // Windows, which supplies the equivalent race protection.
        1
    }

    fn mode(&self) -> u32 {
        if self.permissions().readonly() {
            0o500
        } else {
            0o700
        }
    }
}

#[cfg(windows)]
pub trait PermissionsExt {
    fn from_mode(mode: u32) -> Self;
    fn mode(&self) -> u32;
}

#[cfg(windows)]
impl PermissionsExt for std::fs::Permissions {
    fn from_mode(mode: u32) -> Self {
        let mut permissions = std::fs::metadata(std::env::temp_dir())
            .expect("Windows temporary directory metadata must be available")
            .permissions();
        permissions.set_readonly(mode & 0o200 == 0);
        permissions
    }

    fn mode(&self) -> u32 {
        if self.readonly() {
            0o500
        } else {
            0o700
        }
    }
}

#[cfg(windows)]
pub trait OpenOptionsExt {
    fn mode(&mut self, _mode: u32) -> &mut Self;
    fn custom_flags(&mut self, flags: i32) -> &mut Self;
}

#[cfg(windows)]
impl OpenOptionsExt for std::fs::OpenOptions {
    fn mode(&mut self, _mode: u32) -> &mut Self {
        self
    }

    fn custom_flags(&mut self, _flags: i32) -> &mut Self {
        use std::os::windows::fs::OpenOptionsExt as _;
        // Deny delete/write sharing while a checked private file is open.
        self.share_mode(0x00000001)
    }
}

#[cfg(windows)]
pub fn current_uid() -> u32 {
    0
}

#[cfg(unix)]
pub fn current_uid() -> u32 {
    unsafe { libc::geteuid() }
}

#[cfg(windows)]
pub const NOFOLLOW_FLAG: i32 = 0;

#[cfg(unix)]
pub const NOFOLLOW_FLAG: i32 = libc::O_NOFOLLOW;

#[cfg(windows)]
pub fn set_private_acl(path: &std::path::Path) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt as _;
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x00000400;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("无法检查 Windows 私有路径: {error}"))?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("拒绝修改 Windows 重解析点的 ACL".into());
    }
    let user = std::env::var("USERNAME").map_err(|_| "无法确定当前 Windows 用户".to_string())?;
    let (user_grant, system_grant) = if metadata.is_dir() {
        (format!("{user}:(OI)(CI)F"), "SYSTEM:(OI)(CI)F")
    } else {
        (format!("{user}:F"), "SYSTEM:F")
    };
    let status = std::process::Command::new("icacls.exe")
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(user_grant)
        .args(["/grant:r", system_grant])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|error| format!("无法设置 Windows 私有 ACL: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Windows 私有 ACL 设置失败: {status}"))
    }
}

#[cfg(unix)]
pub fn set_private_acl(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
pub fn remove_link(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::fs::FileTypeExt as _;
    if junction::exists(path).unwrap_or(false) {
        return junction::delete(path);
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink_dir() {
        std::fs::remove_dir(path)
    } else {
        std::fs::remove_file(path)
    }
}

#[cfg(windows)]
fn file_identity(path: &std::path::Path) -> std::io::Result<(u32, u64, u32)> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let file = std::fs::File::open(path)?;
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &mut information) };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let index = ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64;
    Ok((
        information.dwVolumeSerialNumber,
        index,
        information.nNumberOfLinks,
    ))
}

/// Validate one projection resource against its canonical source. Windows
/// uses a junction for directories and a hard link for files because regular
/// users cannot reliably create symbolic links without Developer Mode.
#[cfg(windows)]
pub fn projection_resource_matches(link: &std::path::Path, expected: &std::path::Path) -> bool {
    let Ok(expected_metadata) = std::fs::metadata(expected) else {
        return false;
    };
    if expected_metadata.is_dir() {
        return junction::exists(link).unwrap_or(false)
            && std::fs::canonicalize(link).ok() == std::fs::canonicalize(expected).ok();
    }
    let Ok(link_metadata) = std::fs::symlink_metadata(link) else {
        return false;
    };
    if !link_metadata.is_file() || link_metadata.file_type().is_symlink() {
        return false;
    }
    matches!(
        (file_identity(link), file_identity(expected)),
        (Ok((left_volume, left_index, left_links)), Ok((right_volume, right_index, right_links)))
            if left_volume == right_volume
                && left_index == right_index
                && left_links >= 2
                && right_links >= 2
    )
}

#[cfg(unix)]
pub fn projection_resource_matches(link: &std::path::Path, expected: &std::path::Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(link) else {
        return false;
    };
    if !metadata.file_type().is_symlink() {
        return false;
    }
    let Ok(target) = std::fs::read_link(link) else {
        return false;
    };
    let target = if target.is_absolute() {
        target
    } else {
        let Some(parent) = link.parent() else {
            return false;
        };
        parent.join(target)
    };
    std::fs::canonicalize(target).ok() == std::fs::canonicalize(expected).ok()
}

#[cfg(unix)]
pub fn remove_link(path: &std::path::Path) -> std::io::Result<()> {
    std::fs::remove_file(path)
}

#[cfg(all(test, windows))]
mod tests {
    use super::{projection_resource_matches, remove_link, unix_fs};
    use std::fs;

    #[test]
    fn windows_projection_resources_use_verified_junctions_and_hard_links() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-windows-projection-{}",
            uuid::Uuid::new_v4()
        ));
        let source_dir = root.join("source-dir");
        let source_file = root.join("source.txt");
        let directory_link = root.join("directory-link");
        let file_link = root.join("file-link.txt");
        fs::create_dir_all(&source_dir).expect("create source directory");
        fs::write(&source_file, "source").expect("write source file");

        unix_fs::symlink(&source_dir, &directory_link).expect("create directory junction");
        unix_fs::symlink(&source_file, &file_link).expect("create file hard link");
        assert!(projection_resource_matches(&directory_link, &source_dir));
        assert!(projection_resource_matches(&file_link, &source_file));
        assert!(!projection_resource_matches(
            &file_link,
            &root.join("other.txt")
        ));

        remove_link(&directory_link).expect("remove directory junction");
        remove_link(&file_link).expect("remove file hard link");
        fs::remove_dir_all(root).expect("remove projection fixture");
    }
}
