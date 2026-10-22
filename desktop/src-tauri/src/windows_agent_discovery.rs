#![cfg_attr(not(windows), allow(dead_code))]
//! Windows Agent install discovery.
//!
//! Everything that decides *which* locations to look at (PATH merging,
//! `%VAR%` expansion, package-manager layouts, registration parsing, the
//! case-insensitive executable index) is platform independent so it is unit
//! tested on every host. Only the registry readers are `cfg(windows)`.
//!
//! Discovery is read-only: it never creates directories, writes the
//! registry, changes this process's environment, runs programs, or looks at
//! other users' profiles.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The evidence source a detection problem affected. An Agent only reports
/// issues from sources it actually relies on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DetectionIssueSource {
    /// Executable search: the registry PATH and environment values.
    CliSearch,
    /// Microsoft Store (MSIX) package registrations of the current user.
    StorePackages,
    /// Desktop install registrations (Uninstall and App Paths keys).
    InstalledApps,
}

/// A registry source an Agent relies on could not be (fully) read, so a
/// miss cannot be called "not installed". File-system probe failures are
/// never issues: an unreadable PATH entry simply holds nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DetectionIssue {
    pub source: DetectionIssueSource,
    pub message: String,
}

impl DetectionIssue {
    pub(crate) fn new(source: DetectionIssueSource, message: impl Into<String>) -> Self {
        Self {
            source,
            message: message.into(),
        }
    }
}

/// Executable suffixes accepted as a Windows CLI. A file without one is never
/// a Windows command, and PATHEXT script associations (`.js`, `.ps1`, ...)
/// are deliberately not treated as installs.
pub(crate) const WINDOWS_EXECUTABLE_EXTENSIONS: [&str; 3] = ["exe", "cmd", "bat"];

const MAX_EXPANSION_DEPTH: usize = 4;

// ── Environment ────────────────────────────────────────────────────────────

/// One value of `HKCU\Environment` or the machine environment key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RegistryEnvValue {
    pub value: String,
    /// `REG_EXPAND_SZ`: `%VAR%` references are expanded on read.
    pub expand: bool,
}

/// The environment a newly started process would see, assembled without
/// touching this process's own environment: the inherited process variables
/// first (they may carry deliberate overrides), then the current user's and
/// the machine's registry variables, which pick up tools installed after
/// SkillHub started.
#[derive(Debug, Clone, Default)]
pub(crate) struct WindowsEnvironment {
    process: HashMap<String, String>,
    user: HashMap<String, RegistryEnvValue>,
    system: HashMap<String, RegistryEnvValue>,
}

fn env_key(name: &str) -> String {
    name.to_uppercase()
}

impl WindowsEnvironment {
    pub(crate) fn new(
        process: impl IntoIterator<Item = (String, String)>,
        user: impl IntoIterator<Item = (String, RegistryEnvValue)>,
        system: impl IntoIterator<Item = (String, RegistryEnvValue)>,
    ) -> Self {
        Self {
            process: process
                .into_iter()
                .map(|(name, value)| (env_key(&name), value))
                .collect(),
            user: user
                .into_iter()
                .map(|(name, value)| (env_key(&name), value))
                .collect(),
            system: system
                .into_iter()
                .map(|(name, value)| (env_key(&name), value))
                .collect(),
        }
    }

    /// A variable by case-insensitive name; empty values count as unset.
    pub(crate) fn var(&self, name: &str) -> Option<String> {
        self.var_at_depth(name, 0)
    }

    fn var_at_depth(&self, name: &str, depth: usize) -> Option<String> {
        let key = env_key(name);
        if let Some(value) = self.process.get(&key) {
            return non_empty(value.clone());
        }
        let registry = self.user.get(&key).or_else(|| self.system.get(&key))?;
        if !registry.expand {
            return non_empty(registry.value.clone());
        }
        if depth >= MAX_EXPANSION_DEPTH {
            return None;
        }
        expand_environment_references(&registry.value, &|inner| {
            self.var_at_depth(inner, depth + 1)
        })
        .and_then(non_empty)
    }

    fn process_path(&self) -> Option<&str> {
        self.process.get("PATH").map(String::as_str)
    }

    /// Machine then user registry `Path` entries, each expanded. An entry
    /// whose variable cannot be resolved is dropped, never kept literally.
    pub(crate) fn registry_path_entries(&self) -> Vec<String> {
        let mut entries = Vec::new();
        for scope in [&self.system, &self.user] {
            let Some(path) = scope.get("PATH") else {
                continue;
            };
            for entry in split_path_list(&path.value) {
                let expanded = if path.expand {
                    match expand_environment_references(&entry, &|name| self.var(name)) {
                        Some(expanded) => expanded,
                        None => continue,
                    }
                } else {
                    entry
                };
                entries.extend(split_path_list(&expanded));
            }
        }
        entries
    }
}

fn non_empty(value: String) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

/// Expands `%NAME%` references like `ExpandEnvironmentStrings`: an empty
/// name (`%%`) emits one literal `%` and rescans from the second one, and an
/// unterminated `%` is kept literally. Unlike Windows, an unresolved
/// reference yields `None`, because such an entry cannot name a real
/// directory and is dropped instead of kept as a literal path.
pub(crate) fn expand_environment_references(
    input: &str,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Option<String> {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('%') {
        output.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            output.push_str(&rest[start..]);
            return Some(output);
        };
        let name = &after[..end];
        if name.is_empty() {
            output.push('%');
            rest = after;
            continue;
        }
        output.push_str(&lookup(name)?);
        rest = &after[end + 1..];
    }
    output.push_str(rest);
    Some(output)
}

// ── PATH entries ───────────────────────────────────────────────────────────

/// Splits a PATH value on `;`, except inside double quotes, as `cmd` does:
/// `"C:\a;b";C:\c` is two entries. Quotes are removed later.
pub(crate) fn split_path_list(value: &str) -> Vec<String> {
    let mut entries = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for character in value.chars() {
        match character {
            '"' => {
                quoted = !quoted;
                current.push(character);
            }
            ';' if !quoted => entries.push(std::mem::take(&mut current)),
            _ => current.push(character),
        }
    }
    entries.push(current);
    entries
}

/// `C:\...`, `C:/...` or a UNC share. Host-absolute paths are also accepted
/// so the same logic runs against fixture directories on every platform.
pub(crate) fn is_absolute_path_entry(entry: &str) -> bool {
    let bytes = entry.as_bytes();
    let drive_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    let unc = entry.starts_with(r"\\") && entry.len() > 2;
    drive_absolute || unc || Path::new(entry).is_absolute()
}

/// Windows compares paths case-insensitively and accepts either separator.
fn path_identity(entry: &str) -> String {
    let normalized = entry.replace('/', "\\").to_lowercase();
    let trimmed = normalized.trim_end_matches('\\');
    if trimmed.len() == 2 && trimmed.ends_with(':') {
        format!("{trimmed}\\")
    } else if trimmed.is_empty() {
        normalized
    } else {
        trimmed.to_string()
    }
}

/// Whether two absolute paths name the same location under Windows rules
/// (case-insensitive, either separator, trailing separators ignored).
pub(crate) fn same_path_entry(left: &str, right: &str) -> bool {
    let left = clean_path_entry(left);
    let right = clean_path_entry(right);
    is_absolute_path_entry(left)
        && is_absolute_path_entry(right)
        && path_identity(left) == path_identity(right)
}

fn clean_path_entry(entry: &str) -> &str {
    let trimmed = entry.trim();
    trimmed
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or(trimmed)
        .trim()
}

/// Keeps the first occurrence of every absolute directory, in order. Empty,
/// relative and duplicate (case-insensitive, either separator) entries are
/// dropped.
pub(crate) fn dedupe_search_dirs(candidates: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter_map(|candidate| {
            let text = candidate.to_string_lossy().into_owned();
            let cleaned = clean_path_entry(&text);
            if cleaned.is_empty() || !is_absolute_path_entry(cleaned) {
                return None;
            }
            seen.insert(path_identity(cleaned))
                .then(|| PathBuf::from(cleaned))
        })
        .collect()
}

/// Package-manager and installer bin directories that may hold an Agent
/// CLI even when PATH is stale. Overrides take precedence over defaults;
/// relative or empty overrides are ignored. Nothing here is a recursive scan.
pub(crate) fn windows_tool_dirs(home: &Path, env: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    let absolute = |name: &str| -> Option<PathBuf> {
        env(name)
            .map(|value| clean_path_entry(&value).to_string())
            .filter(|value| is_absolute_path_entry(value))
            .map(PathBuf::from)
    };
    let local_app_data = absolute("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData/Local"));
    let app_data = absolute("APPDATA").unwrap_or_else(|| home.join("AppData/Roaming"));
    let mut directories = Vec::new();

    // Claude Code's native installer and other user-level installers.
    directories.push(home.join(".local/bin"));
    // npm: a custom prefix holds the shims directly on Windows.
    if let Some(prefix) = absolute("NPM_CONFIG_PREFIX") {
        directories.push(prefix);
    }
    directories.push(app_data.join("npm"));
    // Bun global installs.
    directories.push(
        absolute("BUN_INSTALL")
            .unwrap_or_else(|| home.join(".bun"))
            .join("bin"),
    );
    // Volta shims.
    directories.push(
        absolute("VOLTA_HOME")
            .unwrap_or_else(|| local_app_data.join("Volta"))
            .join("bin"),
    );
    // pnpm global bin.
    directories.push(absolute("PNPM_HOME").unwrap_or_else(|| local_app_data.join("pnpm")));
    // mise shims.
    directories.push(
        absolute("MISE_DATA_DIR")
            .unwrap_or_else(|| local_app_data.join("mise"))
            .join("shims"),
    );
    // Scoop user and global shims.
    directories.push(
        absolute("SCOOP")
            .unwrap_or_else(|| home.join("scoop"))
            .join("shims"),
    );
    if let Some(global) = absolute("SCOOP_GLOBAL")
        .or_else(|| absolute("ProgramData").map(|program_data| program_data.join("scoop")))
    {
        directories.push(global.join("shims"));
    }
    // WinGet portable command links (user and machine scope).
    directories.push(local_app_data.join("Microsoft/WinGet/Links"));
    if let Some(program_files) = absolute("ProgramFiles") {
        directories.push(program_files.join("WinGet/Links"));
    }
    // nvm-windows: the active version link holds global npm shims; installed
    // versions under NVM_HOME are one level deep.
    if let Some(symlink) = absolute("NVM_SYMLINK") {
        directories.push(symlink);
    }
    if let Some(nvm_home) = absolute("NVM_HOME") {
        if let Ok(versions) = fs::read_dir(nvm_home) {
            let mut versions = versions
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().starts_with('v'))
                .map(|entry| entry.path())
                .collect::<Vec<_>>();
            versions.sort();
            directories.extend(versions);
        }
    }
    // fnm's per-shell directory only exists inside an fnm shell, so only the
    // path that shell exported is used; other shells' links are never scanned.
    if let Some(multishell) = absolute("FNM_MULTISHELL_PATH") {
        directories.push(multishell);
    }
    directories
}

/// Process PATH first (it keeps any deliberate override), then the registry
/// PATH a new process would get, then package-manager locations.
pub(crate) fn windows_executable_search_dirs(
    home: &Path,
    environment: &WindowsEnvironment,
    installer_dirs: Vec<PathBuf>,
) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = environment
        .process_path()
        .map(|path| {
            split_path_list(path)
                .into_iter()
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default();
    candidates.extend(
        environment
            .registry_path_entries()
            .into_iter()
            .map(PathBuf::from),
    );
    candidates.extend(windows_tool_dirs(home, &|name| environment.var(name)));
    candidates.extend(installer_dirs);
    dedupe_search_dirs(candidates)
}

// ── Executable lookup ──────────────────────────────────────────────────────

/// Whether a probe error means "nothing can be here" rather than "could not
/// look". Missing paths, a PATH entry that is a file, and names that cannot
/// exist are absences. On Windows a drive that is not ready (21), an invalid
/// name (123) and an unreachable or missing network share (53, 67, 1231) are
/// directory-level unavailability of a stale PATH entry, also absences.
/// Access denied and every other error is a real read failure.
pub(crate) fn probe_error_means_absent(error: &io::Error) -> bool {
    if matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory | io::ErrorKind::InvalidInput
    ) {
        return true;
    }
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(21 | 53 | 67 | 123 | 1231)) {
        return true;
    }
    false
}

/// The first launchable `<name>.exe|.cmd|.bat` in search order, found by
/// probing those exact paths (NTFS matches names case-insensitively), never
/// by listing whole directories such as System32. `probe` returns whether a
/// path is a launchable file. An absence (see [`probe_error_means_absent`])
/// is skipped; any other error, such as access denied on the candidate, is
/// returned as a CLI-search issue so a miss is not reported as "not
/// installed". One issue per directory is enough; its other suffixes are
/// skipped.
pub(crate) fn find_windows_executable(
    directories: &[PathBuf],
    name: &str,
    probe: &dyn Fn(&Path) -> io::Result<bool>,
) -> (Option<PathBuf>, Vec<DetectionIssue>) {
    let mut issues = Vec::new();
    for directory in directories {
        for extension in WINDOWS_EXECUTABLE_EXTENSIONS {
            let candidate = directory.join(format!("{name}.{extension}"));
            match probe(&candidate) {
                Ok(true) => return (Some(candidate), issues),
                Ok(false) => {}
                Err(error) if probe_error_means_absent(&error) => {}
                Err(error) => {
                    issues.push(DetectionIssue::new(
                        DetectionIssueSource::CliSearch,
                        format!("无法检查命令 {}：{error}", candidate.display()),
                    ));
                    break;
                }
            }
        }
    }
    (None, issues)
}

// ── Desktop install registrations ──────────────────────────────────────────

/// The executable a `DisplayIcon` value points at: surrounding quotes and a
/// trailing `,<icon index>` are removed. Only `.exe` targets are useful.
pub(crate) fn display_icon_executable(value: &str) -> Option<String> {
    let cleaned = clean_path_entry(value);
    let without_index = match cleaned.rsplit_once(',') {
        Some((path, index)) if index.trim().trim_start_matches('-').parse::<i64>().is_ok() => {
            clean_path_entry(path)
        }
        _ => cleaned,
    };
    (!without_index.is_empty() && without_index.to_lowercase().ends_with(".exe"))
        .then(|| without_index.to_string())
}

/// The last path component, for either separator.
pub(crate) fn path_file_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

/// Whether an Uninstall entry names one of the products whose executables
/// are listed, judged by its key name or DisplayName (case-insensitive).
/// This only narrows which entries are read further; it is never evidence.
pub(crate) fn uninstall_entry_names_product(
    key_name: &str,
    display_name: Option<&str>,
    executable_names: &[&str],
) -> bool {
    let key_name = key_name.to_lowercase();
    let display_name = display_name.map(str::to_lowercase).unwrap_or_default();
    executable_names.iter().any(|name| {
        let lower = name.to_lowercase();
        let product = lower.strip_suffix(".exe").unwrap_or(&lower);
        !product.is_empty() && (key_name.contains(product) || display_name.contains(product))
    })
}

/// Candidate executables from one Uninstall entry, restricted to the
/// executable names an Agent definition names. A DisplayName never becomes
/// evidence: the caller still requires the candidate to exist.
pub(crate) fn uninstall_entry_candidates(
    install_location: Option<&str>,
    display_icon: Option<&str>,
    executable_names: &[&str],
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(location) = install_location.map(clean_path_entry) {
        if is_absolute_path_entry(location) {
            for name in executable_names {
                candidates.push(PathBuf::from(location).join(name));
            }
        }
    }
    if let Some(icon) = display_icon.and_then(display_icon_executable) {
        if is_absolute_path_entry(&icon)
            && executable_names
                .iter()
                .any(|name| path_file_name(&icon).eq_ignore_ascii_case(name))
        {
            candidates.push(PathBuf::from(icon));
        }
    }
    candidates
}

/// The default value of `App Paths\<name>` when it names that executable.
pub(crate) fn app_path_candidate(default_value: &str, executable_name: &str) -> Option<PathBuf> {
    let cleaned = clean_path_entry(default_value);
    (is_absolute_path_entry(cleaned)
        && path_file_name(cleaned).eq_ignore_ascii_case(executable_name))
    .then(|| PathBuf::from(cleaned))
}

// ── Install registration adapter ───────────────────────────────────────────

/// One registry key that holds install registrations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RegistryLocation {
    pub hive: &'static str,
    pub path: &'static str,
}

const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
const UNINSTALL_WOW64: &str = r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";
const APP_PATHS: &str = r"Software\Microsoft\Windows\CurrentVersion\App Paths";
const APP_PATHS_WOW64: &str = r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths";

/// Current-user and machine (64- and 32-bit view) Uninstall roots.
pub(crate) const UNINSTALL_LOCATIONS: [RegistryLocation; 3] = [
    RegistryLocation {
        hive: "HKCU",
        path: UNINSTALL,
    },
    RegistryLocation {
        hive: "HKLM",
        path: UNINSTALL,
    },
    RegistryLocation {
        hive: "HKLM",
        path: UNINSTALL_WOW64,
    },
];

/// Current-user and machine (64- and 32-bit view) App Paths roots.
pub(crate) const APP_PATHS_LOCATIONS: [RegistryLocation; 3] = [
    RegistryLocation {
        hive: "HKCU",
        path: APP_PATHS,
    },
    RegistryLocation {
        hive: "HKLM",
        path: APP_PATHS,
    },
    RegistryLocation {
        hive: "HKLM",
        path: APP_PATHS_WOW64,
    },
];

/// Read access to install registrations. The Windows implementation wraps
/// the registry; tests inject absent keys and read failures through it.
pub(crate) trait InstallRegistry {
    /// Subkey names of `location`. `Err(NotFound)` means the root is absent;
    /// an `Err` item is one subkey name that could not be enumerated.
    fn subkey_names(&self, location: RegistryLocation) -> io::Result<Vec<io::Result<String>>>;

    /// A string value of `location\subkey`, expanded when `REG_EXPAND_SZ`.
    /// `Ok(None)` when the key or the value does not exist; `name` `""` is
    /// the default value.
    fn string_value(
        &self,
        location: RegistryLocation,
        subkey: &str,
        name: &str,
    ) -> io::Result<Option<String>>;
}

fn registry_issue(location: RegistryLocation, subkey: &str, error: &io::Error) -> DetectionIssue {
    let path = if subkey.is_empty() {
        location.path.to_string()
    } else {
        format!("{}\\{subkey}", location.path)
    };
    DetectionIssue::new(
        DetectionIssueSource::InstalledApps,
        format!("无法读取注册表 {}\\{path}：{error}", location.hive),
    )
}

/// Candidate executables named by Uninstall and App Paths registrations for
/// `executable_names`. Absent keys are normal; every other read failure —
/// a root, an enumerated name, an entry or one of its values — is reported,
/// because the unreadable entry may be the Agent's own registration.
pub(crate) fn collect_installed_app_candidates(
    registry: &dyn InstallRegistry,
    executable_names: &[&str],
) -> (Vec<PathBuf>, Vec<DetectionIssue>) {
    let mut candidates = Vec::new();
    let mut issues = Vec::new();
    if executable_names.is_empty() {
        return (candidates, issues);
    }
    let mut report = |location: RegistryLocation, subkey: &str, error: io::Error| {
        if error.kind() != io::ErrorKind::NotFound {
            issues.push(registry_issue(location, subkey, &error));
        }
    };
    for location in UNINSTALL_LOCATIONS {
        let names = match registry.subkey_names(location) {
            Ok(names) => names,
            Err(error) => {
                report(location, "", error);
                continue;
            }
        };
        for name in names {
            let name = match name {
                Ok(name) => name,
                Err(error) => {
                    report(location, "", error);
                    continue;
                }
            };
            let display_name = match registry.string_value(location, &name, "DisplayName") {
                Ok(display_name) => display_name,
                Err(error) => {
                    report(location, &name, error);
                    continue;
                }
            };
            if !uninstall_entry_names_product(&name, display_name.as_deref(), executable_names) {
                continue;
            }
            let mut value =
                |value_name: &str| match registry.string_value(location, &name, value_name) {
                    Ok(value) => value,
                    Err(error) => {
                        report(location, &name, error);
                        None
                    }
                };
            let install_location = value("InstallLocation");
            let display_icon = value("DisplayIcon");
            candidates.extend(uninstall_entry_candidates(
                install_location.as_deref(),
                display_icon.as_deref(),
                executable_names,
            ));
        }
    }
    for location in APP_PATHS_LOCATIONS {
        for executable in executable_names {
            match registry.string_value(location, executable, "") {
                Ok(Some(value)) => candidates.extend(app_path_candidate(&value, executable)),
                Ok(None) => {}
                Err(error) => report(location, executable, error),
            }
        }
    }
    let mut seen = HashSet::new();
    issues.retain(|issue| seen.insert(issue.message.clone()));
    (candidates, issues)
}

// ── Registry readers (Windows only) ────────────────────────────────────────

#[cfg(windows)]
mod registry {
    use super::{
        collect_installed_app_candidates, expand_environment_references, DetectionIssue,
        DetectionIssueSource, InstallRegistry, RegistryEnvValue, RegistryLocation,
        WindowsEnvironment,
    };
    use std::io;
    use std::path::PathBuf;
    use winreg::enums::{RegType, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::types::FromRegValue as _;
    use winreg::{RegKey, HKEY};

    const USER_ENVIRONMENT: &str = "Environment";
    const SYSTEM_ENVIRONMENT: &str =
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

    fn read_environment_key(
        hive: HKEY,
        label: &str,
        path: &str,
        issues: &mut Vec<DetectionIssue>,
    ) -> Vec<(String, RegistryEnvValue)> {
        let key = match RegKey::predef(hive).open_subkey(path) {
            Ok(key) => key,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Vec::new(),
            Err(error) => {
                issues.push(DetectionIssue::new(
                    DetectionIssueSource::CliSearch,
                    format!("无法读取注册表 {label}\\{path}：{error}"),
                ));
                return Vec::new();
            }
        };
        key.enum_values()
            .flatten()
            .filter_map(|(name, value)| {
                let expand = match value.vtype {
                    RegType::REG_SZ => false,
                    RegType::REG_EXPAND_SZ => true,
                    _ => return None,
                };
                let value = String::from_reg_value(&value).ok()?;
                Some((name, RegistryEnvValue { value, expand }))
            })
            .collect()
    }

    /// Process variables plus the user and machine registry environment.
    pub(crate) fn read_windows_environment() -> (WindowsEnvironment, Vec<DetectionIssue>) {
        let mut issues = Vec::new();
        let process = std::env::vars_os()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
            .collect::<Vec<_>>();
        let user = read_environment_key(HKEY_CURRENT_USER, "HKCU", USER_ENVIRONMENT, &mut issues);
        let system =
            read_environment_key(HKEY_LOCAL_MACHINE, "HKLM", SYSTEM_ENVIRONMENT, &mut issues);
        (WindowsEnvironment::new(process, user, system), issues)
    }

    fn hive(label: &str) -> HKEY {
        if label == "HKCU" {
            HKEY_CURRENT_USER
        } else {
            HKEY_LOCAL_MACHINE
        }
    }

    /// The registry behind [`InstallRegistry`]; `REG_EXPAND_SZ` values are
    /// expanded against the same environment the CLI search uses.
    pub(crate) struct WindowsInstallRegistry<'a> {
        pub environment: &'a WindowsEnvironment,
    }

    impl InstallRegistry for WindowsInstallRegistry<'_> {
        fn subkey_names(&self, location: RegistryLocation) -> io::Result<Vec<io::Result<String>>> {
            let key = RegKey::predef(hive(location.hive)).open_subkey(location.path)?;
            Ok(key.enum_keys().collect())
        }

        fn string_value(
            &self,
            location: RegistryLocation,
            subkey: &str,
            name: &str,
        ) -> io::Result<Option<String>> {
            let path = format!("{}\\{subkey}", location.path);
            let key = match RegKey::predef(hive(location.hive)).open_subkey(&path) {
                Ok(key) => key,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error),
            };
            let raw = match key.get_raw_value(name) {
                Ok(raw) => raw,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error),
            };
            if !matches!(raw.vtype, RegType::REG_SZ | RegType::REG_EXPAND_SZ) {
                return Ok(None);
            }
            let value = String::from_reg_value(&raw)?;
            if raw.vtype == RegType::REG_EXPAND_SZ {
                Ok(expand_environment_references(&value, &|inner| {
                    self.environment.var(inner)
                }))
            } else {
                Ok(Some(value))
            }
        }
    }

    /// Install registrations of the current user and the machine.
    pub(crate) fn read_installed_app_candidates(
        executable_names: &[&str],
        environment: &WindowsEnvironment,
    ) -> (Vec<PathBuf>, Vec<DetectionIssue>) {
        collect_installed_app_candidates(&WindowsInstallRegistry { environment }, executable_names)
    }
}

#[cfg(windows)]
pub(crate) use registry::{read_installed_app_candidates, read_windows_environment};

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.to_string())
        }
    }

    fn expandable(value: &str) -> RegistryEnvValue {
        RegistryEnvValue {
            value: value.to_string(),
            expand: true,
        }
    }

    fn literal(value: &str) -> RegistryEnvValue {
        RegistryEnvValue {
            value: value.to_string(),
            expand: false,
        }
    }

    fn fixture(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "skillhub-windows-discovery-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create fixture");
        root
    }

    #[test]
    fn expansion_resolves_case_insensitive_references_and_rejects_unknown_ones() {
        let env = env_of(&[("LOCALAPPDATA", r"D:\Users\张 三\AppData\Local")]);
        assert_eq!(
            expand_environment_references(r"%LocalAppData%\pnpm", &env).as_deref(),
            Some(r"D:\Users\张 三\AppData\Local\pnpm")
        );
        assert_eq!(expand_environment_references(r"%MISSING%\bin", &env), None);
        assert_eq!(
            expand_environment_references("100%% done", &env).as_deref(),
            Some("100%% done")
        );
        assert_eq!(
            expand_environment_references(r"C:\odd%name", &env).as_deref(),
            Some(r"C:\odd%name")
        );
        assert_eq!(
            expand_environment_references(r"C:\plain", &env).as_deref(),
            Some(r"C:\plain")
        );
    }

    #[test]
    fn registry_variables_expand_recursively_and_process_values_win() {
        let environment = WindowsEnvironment::new(
            [("LocalAppData".to_string(), r"E:\Local".to_string())],
            [
                ("PNPM_HOME".to_string(), expandable(r"%LOCALAPPDATA%\pnpm")),
                ("LOOP".to_string(), expandable("%LOOP%")),
                ("EMPTY".to_string(), literal("  ")),
            ],
            [("PNPM_HOME".to_string(), literal(r"C:\machine\pnpm"))],
        );
        assert_eq!(
            environment.var("pnpm_home").as_deref(),
            Some(r"E:\Local\pnpm")
        );
        assert_eq!(environment.var("LOOP"), None);
        assert_eq!(environment.var("EMPTY"), None);
        assert_eq!(environment.var("UNSET"), None);
    }

    #[test]
    fn registry_path_is_machine_then_user_and_expands_only_expand_sz() {
        let environment = WindowsEnvironment::new(
            [("USERPROFILE".to_string(), r"C:\Users\dev user".to_string())],
            [(
                "Path".to_string(),
                expandable(r"%USERPROFILE%\.local\bin;%NOPE%\bin;;relative\bin"),
            )],
            [(
                "Path".to_string(),
                literal(r"C:\Windows;%USERPROFILE%\literal"),
            )],
        );
        assert_eq!(
            environment.registry_path_entries(),
            vec![
                r"C:\Windows".to_string(),
                r"%USERPROFILE%\literal".to_string(),
                r"C:\Users\dev user\.local\bin".to_string(),
                String::new(),
                r"relative\bin".to_string(),
            ]
        );
    }

    #[test]
    fn absolute_entries_accept_drives_unc_and_reject_relative_ones() {
        for entry in [r"C:\Tools", "D:/tools", r"\\server\share\bin", r"Z:\"] {
            assert!(is_absolute_path_entry(entry), "{entry}");
        }
        for entry in ["", "bin", r"C:relative", r".\bin", r"%PATH%"] {
            assert!(!is_absolute_path_entry(entry), "{entry}");
        }
    }

    #[test]
    fn search_dirs_keep_first_occurrence_and_drop_empty_relative_and_duplicates() {
        let merged = dedupe_search_dirs(
            [
                r"C:\Users\Dev\AppData\Roaming\npm",
                "",
                "  ",
                r"relative\bin",
                r"c:/users/dev/appdata/roaming/NPM/",
                r#""D:\Program Files\nodejs""#,
                r"d:\program files\nodejs\",
                r"C:\",
                r"c:",
                r"C:\",
            ]
            .map(PathBuf::from),
        );
        assert_eq!(
            merged,
            vec![
                PathBuf::from(r"C:\Users\Dev\AppData\Roaming\npm"),
                PathBuf::from(r"D:\Program Files\nodejs"),
                PathBuf::from(r"C:\"),
            ]
        );
    }

    #[test]
    fn process_path_keeps_priority_over_registry_and_tool_dirs() {
        let home = PathBuf::from(r"C:\Users\Dev");
        let environment = WindowsEnvironment::new(
            [(
                "PATH".to_string(),
                r"C:\override\bin;C:\Windows\system32".to_string(),
            )],
            [(
                "Path".to_string(),
                literal(r"C:\Users\Dev\new-tool;C:\override\BIN"),
            )],
            [(
                "Path".to_string(),
                literal(r"C:\WINDOWS\System32;C:\machine"),
            )],
        );
        let dirs = windows_executable_search_dirs(&home, &environment, Vec::new());
        assert_eq!(
            &dirs[..4],
            &[
                PathBuf::from(r"C:\override\bin"),
                PathBuf::from(r"C:\Windows\system32"),
                PathBuf::from(r"C:\machine"),
                PathBuf::from(r"C:\Users\Dev\new-tool"),
            ]
        );
    }

    #[test]
    fn tool_dirs_cover_package_manager_defaults() {
        let home = PathBuf::from(r"D:\Users\张 三");
        let env = env_of(&[
            ("LOCALAPPDATA", r"D:\Users\张 三\AppData\Local"),
            ("APPDATA", r"D:\Users\张 三\AppData\Roaming"),
            ("ProgramFiles", r"C:\Program Files"),
        ]);
        let dirs = windows_tool_dirs(&home, &env);
        for expected in [
            home.join(".local/bin"),
            PathBuf::from(r"D:\Users\张 三\AppData\Roaming").join("npm"),
            home.join(".bun").join("bin"),
            PathBuf::from(r"D:\Users\张 三\AppData\Local")
                .join("Volta")
                .join("bin"),
            PathBuf::from(r"D:\Users\张 三\AppData\Local").join("pnpm"),
            PathBuf::from(r"D:\Users\张 三\AppData\Local")
                .join("mise")
                .join("shims"),
            home.join("scoop").join("shims"),
            PathBuf::from(r"D:\Users\张 三\AppData\Local").join("Microsoft/WinGet/Links"),
            PathBuf::from(r"C:\Program Files").join("WinGet/Links"),
        ] {
            assert!(dirs.contains(&expected), "missing {}", expected.display());
        }
    }

    #[test]
    fn tool_dirs_honor_absolute_overrides_and_ignore_relative_ones() {
        let home = PathBuf::from(r"C:\Users\dev");
        let env = env_of(&[
            ("LOCALAPPDATA", r"C:\Users\dev\AppData\Local"),
            ("NPM_CONFIG_PREFIX", r"E:\npm-global"),
            ("BUN_INSTALL", r"E:\bun"),
            ("VOLTA_HOME", r"E:\volta"),
            ("PNPM_HOME", r"E:\pnpm"),
            ("MISE_DATA_DIR", r"E:\mise"),
            ("SCOOP", r"E:\scoop"),
            ("SCOOP_GLOBAL", r"F:\scoop-global"),
            ("NVM_SYMLINK", r"E:\nodejs"),
            (
                "FNM_MULTISHELL_PATH",
                r"C:\Users\dev\AppData\Local\fnm_multishells\1_2",
            ),
        ]);
        let dirs = windows_tool_dirs(&home, &env);
        for expected in [
            PathBuf::from(r"E:\npm-global"),
            PathBuf::from(r"E:\bun").join("bin"),
            PathBuf::from(r"E:\volta").join("bin"),
            PathBuf::from(r"E:\pnpm"),
            PathBuf::from(r"E:\mise").join("shims"),
            PathBuf::from(r"E:\scoop").join("shims"),
            PathBuf::from(r"F:\scoop-global").join("shims"),
            PathBuf::from(r"E:\nodejs"),
            PathBuf::from(r"C:\Users\dev\AppData\Local\fnm_multishells\1_2"),
        ] {
            assert!(dirs.contains(&expected), "missing {}", expected.display());
        }
        assert!(!dirs.contains(&PathBuf::from(r"C:\Users\dev\AppData\Local").join("pnpm")));

        let relative = env_of(&[("PNPM_HOME", r"pnpm"), ("VOLTA_HOME", "")]);
        let dirs = windows_tool_dirs(&home, &relative);
        assert!(dirs.contains(&home.join("AppData/Local").join("pnpm")));
        assert!(dirs.contains(&home.join("AppData/Local").join("Volta").join("bin")));
        assert!(!dirs.contains(&PathBuf::from("pnpm")));
    }

    #[test]
    fn nvm_home_versions_are_listed_one_level_deep() {
        let root = fixture("nvm-home");
        fs::create_dir_all(root.join("v20.11.0/node_modules/deep")).expect("create version");
        fs::create_dir_all(root.join("v22.1.0")).expect("create version");
        fs::create_dir_all(root.join("settings-dir")).expect("create non-version dir");
        let nvm_home = root.to_string_lossy().into_owned();
        let pairs = [("NVM_HOME", nvm_home.as_str())];
        let env = env_of(&pairs);
        let dirs = windows_tool_dirs(&root, &env);
        assert!(dirs.contains(&root.join("v20.11.0")));
        assert!(dirs.contains(&root.join("v22.1.0")));
        assert!(!dirs.contains(&root.join("settings-dir")));
        assert!(!dirs.contains(&root.join("v20.11.0/node_modules/deep")));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn executable_probe_needs_a_windows_suffix() {
        let root = fixture("probe");
        let first = root.join("first");
        let second = root.join("second");
        fs::create_dir_all(&first).expect("create first");
        fs::create_dir_all(&second).expect("create second");
        fs::write(first.join("claude"), "unix shim").expect("write extensionless");
        fs::write(first.join("gemini.ps1"), "script").expect("write ps1");
        fs::write(first.join("gemini.js"), "script").expect("write js");
        fs::write(second.join("claude.cmd"), "cmd").expect("write cmd");
        fs::create_dir_all(second.join("codex.exe")).expect("directory named like an exe");
        let dirs = [first, second.clone(), root.join("missing")];
        let launchable = |path: &Path| fs::metadata(path).map(|metadata| metadata.is_file());
        assert_eq!(
            find_windows_executable(&dirs, "claude", &launchable),
            (Some(second.join("claude.cmd")), Vec::new())
        );
        assert_eq!(
            find_windows_executable(&dirs, "gemini", &launchable),
            (None, Vec::new())
        );
        assert_eq!(
            find_windows_executable(&dirs, "codex", &launchable),
            (None, Vec::new())
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn executable_probe_prefers_earlier_directories() {
        let root = fixture("probe-order");
        let early = root.join("early");
        let late = root.join("late");
        fs::create_dir_all(&early).expect("create early");
        fs::create_dir_all(&late).expect("create late");
        fs::write(early.join("opencode.cmd"), "cmd").expect("write early");
        fs::write(late.join("opencode.exe"), "exe").expect("write late");
        assert_eq!(
            find_windows_executable(&[early.clone(), late], "opencode", &|path: &Path| {
                fs::metadata(path).map(|metadata| metadata.is_file())
            })
            .0,
            Some(early.join("opencode.cmd"))
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn absent_path_entries_are_not_found_without_issues() {
        let root = fixture("unusable");
        let file_entry = root.join("not-a-directory");
        fs::write(&file_entry, "file").expect("write file entry");
        // Missing, a file and an invalid name all read as "not here".
        let dirs = [root.join("missing"), file_entry, root.join("bad\u{0}name")];
        assert_eq!(
            find_windows_executable(&dirs, "claude", &|path: &Path| {
                fs::metadata(path).map(|metadata| metadata.is_file())
            }),
            (None, Vec::new())
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn access_denied_on_a_candidate_is_reported_but_absence_is_not() {
        let denied = PathBuf::from("/denied");
        let found = PathBuf::from("/found");
        let probe = |path: &Path| -> io::Result<bool> {
            if path.starts_with(&denied) {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else if path == found.join("codex.cmd") {
                Ok(true)
            } else {
                Err(io::Error::from(io::ErrorKind::NotFound))
            }
        };
        let (hit, issues) = find_windows_executable(
            &[denied.clone(), PathBuf::from("/missing")],
            "codex",
            &probe,
        );
        assert_eq!(hit, None);
        assert_eq!(issues.len(), 1, "one issue per unreadable directory");
        assert_eq!(issues[0].source, DetectionIssueSource::CliSearch);
        assert!(
            issues[0].message.contains("codex.exe"),
            "{}",
            issues[0].message
        );

        // A hit elsewhere is still returned, with the failure kept alongside.
        let (hit, issues) =
            find_windows_executable(&[denied.clone(), found.clone()], "codex", &probe);
        assert_eq!(hit, Some(found.join("codex.cmd")));
        assert_eq!(issues.len(), 1);

        let (_, issues) = find_windows_executable(&[PathBuf::from("/missing")], "codex", &probe);
        assert!(issues.is_empty());
        for kind in [
            io::ErrorKind::NotFound,
            io::ErrorKind::NotADirectory,
            io::ErrorKind::InvalidInput,
        ] {
            assert!(probe_error_means_absent(&io::Error::from(kind)));
        }
        for kind in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::Other,
            io::ErrorKind::TimedOut,
        ] {
            assert!(!probe_error_means_absent(&io::Error::from(kind)));
        }
    }

    #[cfg(windows)]
    #[test]
    fn executable_probe_is_case_insensitive_on_windows() {
        let root = fixture("probe-case");
        fs::write(root.join("CLAUDE.EXE"), "exe").expect("write upper-case exe");
        assert!(
            find_windows_executable(std::slice::from_ref(&root), "claude", &|path: &Path| {
                fs::metadata(path).map(|metadata| metadata.is_file())
            })
            .0
            .is_some()
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn path_lists_split_outside_quotes_only() {
        assert_eq!(
            split_path_list(r#""C:\a;b";C:\c;;D:\d"#),
            vec![r#""C:\a;b""#, r"C:\c", "", r"D:\d"]
        );
        let merged = dedupe_search_dirs(
            split_path_list(r#""C:\Program Files;x\bin";C:\y"#)
                .into_iter()
                .map(PathBuf::from),
        );
        assert_eq!(
            merged,
            vec![
                PathBuf::from(r"C:\Program Files;x\bin"),
                PathBuf::from(r"C:\y")
            ]
        );
    }

    #[test]
    fn expansion_follows_windows_rules_for_percent_literals() {
        let env = env_of(&[("PATH_ROOT", r"C:\Tools")]);
        assert_eq!(
            expand_environment_references("%%PATH_ROOT%", &env).as_deref(),
            Some(r"%C:\Tools")
        );
        assert_eq!(
            expand_environment_references("50%", &env).as_deref(),
            Some("50%")
        );
        assert_eq!(
            expand_environment_references("%%", &env).as_deref(),
            Some("%%")
        );
        assert_eq!(
            expand_environment_references(r"%PATH_ROOT%\bin;100%", &env).as_deref(),
            Some(r"C:\Tools\bin;100%")
        );
    }

    #[test]
    fn uninstall_entries_are_prefiltered_by_product_name() {
        let names = ["WorkBuddy.exe"];
        assert!(uninstall_entry_names_product(
            "{GUID-123}",
            Some("WorkBuddy 5.4.7"),
            &names
        ));
        assert!(uninstall_entry_names_product("workbuddy_is1", None, &names));
        assert!(!uninstall_entry_names_product(
            "{GUID-456}",
            Some("Other App"),
            &names
        ));
        assert!(!uninstall_entry_names_product("{GUID-456}", None, &names));
        assert!(!uninstall_entry_names_product(
            "WorkBuddy",
            Some("WorkBuddy"),
            &[]
        ));
    }

    #[test]
    fn scoop_global_defaults_to_program_data() {
        let home = PathBuf::from(r"C:\Users\dev");
        let env = env_of(&[("ProgramData", r"C:\ProgramData")]);
        assert!(windows_tool_dirs(&home, &env)
            .contains(&PathBuf::from(r"C:\ProgramData").join("scoop").join("shims")));
        let env = env_of(&[
            ("ProgramData", r"C:\ProgramData"),
            ("SCOOP_GLOBAL", r"D:\scoop-global"),
        ]);
        let dirs = windows_tool_dirs(&home, &env);
        assert!(dirs.contains(&PathBuf::from(r"D:\scoop-global").join("shims")));
        assert!(!dirs.contains(&PathBuf::from(r"C:\ProgramData").join("scoop").join("shims")));
    }

    /// An in-memory registry: keys map to values, and any key or value can
    /// be made to fail with a chosen error kind.
    #[derive(Default)]
    struct FakeRegistry {
        roots: HashMap<&'static str, Vec<Result<String, io::ErrorKind>>>,
        failing_roots: HashMap<&'static str, io::ErrorKind>,
        values: HashMap<(String, String), String>,
        failing_values: HashMap<(String, String), io::ErrorKind>,
    }

    fn root_id(location: RegistryLocation) -> &'static str {
        match (
            location.hive,
            location.path.contains("WOW6432Node"),
            location.path.ends_with("Uninstall"),
        ) {
            ("HKCU", _, true) => "hkcu-uninstall",
            ("HKLM", false, true) => "hklm-uninstall",
            ("HKLM", true, true) => "hklm-uninstall-wow",
            ("HKCU", _, false) => "hkcu-app-paths",
            ("HKLM", false, false) => "hklm-app-paths",
            _ => "hklm-app-paths-wow",
        }
    }

    impl FakeRegistry {
        fn entry(mut self, root: &'static str, name: &str, values: &[(&str, &str)]) -> Self {
            self.roots
                .entry(root)
                .or_default()
                .push(Ok(name.to_string()));
            for (value, data) in values {
                self.values.insert(
                    (format!("{root}/{name}"), value.to_string()),
                    data.to_string(),
                );
            }
            self
        }
    }

    impl InstallRegistry for FakeRegistry {
        fn subkey_names(&self, location: RegistryLocation) -> io::Result<Vec<io::Result<String>>> {
            let root = root_id(location);
            if let Some(kind) = self.failing_roots.get(root) {
                return Err(io::Error::from(*kind));
            }
            let names = self
                .roots
                .get(root)
                .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
            Ok(names
                .iter()
                .map(|name| name.clone().map_err(io::Error::from))
                .collect())
        }

        fn string_value(
            &self,
            location: RegistryLocation,
            subkey: &str,
            name: &str,
        ) -> io::Result<Option<String>> {
            let key = (format!("{}/{subkey}", root_id(location)), name.to_string());
            if let Some(kind) = self.failing_values.get(&key) {
                return Err(io::Error::from(*kind));
            }
            Ok(self.values.get(&key).cloned())
        }
    }

    const WORKBUDDY: [&str; 1] = ["WorkBuddy.exe"];

    #[test]
    fn registrations_yield_candidates_only_for_named_products() {
        let registry = FakeRegistry::default()
            .entry(
                "hkcu-uninstall",
                "{11111111-guid}",
                &[
                    ("DisplayName", "WorkBuddy 5.4.7"),
                    ("InstallLocation", r"E:\Apps\WorkBuddy"),
                ],
            )
            .entry(
                "hklm-uninstall",
                "OtherApp",
                &[("DisplayName", "Other"), ("InstallLocation", r"C:\Other")],
            )
            .entry(
                "hklm-app-paths",
                "WorkBuddy.exe",
                &[("", r#""F:\WB\WorkBuddy.exe""#)],
            );
        let (candidates, issues) = collect_installed_app_candidates(&registry, &WORKBUDDY);
        assert!(issues.is_empty(), "absent roots are not issues: {issues:?}");
        assert_eq!(
            candidates,
            vec![
                PathBuf::from(r"E:\Apps\WorkBuddy").join("WorkBuddy.exe"),
                PathBuf::from(r"F:\WB\WorkBuddy.exe"),
            ]
        );
    }

    #[test]
    fn denied_roots_entries_and_values_are_reported_without_losing_other_hits() {
        let mut registry = FakeRegistry::default()
            .entry(
                "hkcu-uninstall",
                "WorkBuddy",
                &[("InstallLocation", r"E:\Apps\WorkBuddy")],
            )
            .entry("hkcu-uninstall", "{denied-entry}", &[]);
        registry
            .roots
            .get_mut("hkcu-uninstall")
            .expect("root")
            .push(Err(io::ErrorKind::PermissionDenied));
        registry.failing_values.insert(
            (
                "hkcu-uninstall/{denied-entry}".to_string(),
                "DisplayName".to_string(),
            ),
            io::ErrorKind::PermissionDenied,
        );
        registry
            .failing_roots
            .insert("hklm-uninstall", io::ErrorKind::PermissionDenied);
        registry.failing_values.insert(
            ("hklm-app-paths/WorkBuddy.exe".to_string(), String::new()),
            io::ErrorKind::PermissionDenied,
        );
        let (candidates, issues) = collect_installed_app_candidates(&registry, &WORKBUDDY);
        assert_eq!(
            candidates,
            vec![PathBuf::from(r"E:\Apps\WorkBuddy").join("WorkBuddy.exe")]
        );
        assert!(issues
            .iter()
            .all(|issue| issue.source == DetectionIssueSource::InstalledApps));
        let messages = issues
            .iter()
            .map(|issue| issue.message.as_str())
            .collect::<Vec<_>>();
        assert!(
            messages.iter().any(|m| m.contains("{denied-entry}")),
            "{messages:?}"
        );
        assert!(
            messages.iter().any(|m| m.starts_with(
                "无法读取注册表 HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall："
            )),
            "{messages:?}"
        );
        assert!(
            messages
                .iter()
                .any(|m| m.contains("App Paths\\WorkBuddy.exe")),
            "{messages:?}"
        );
        assert_eq!(issues.len(), 4, "{messages:?}");
    }

    #[test]
    fn no_registry_reads_without_named_executables() {
        let mut registry = FakeRegistry::default();
        registry
            .failing_roots
            .insert("hkcu-uninstall", io::ErrorKind::PermissionDenied);
        assert_eq!(
            collect_installed_app_candidates(&registry, &[]),
            (Vec::new(), Vec::new())
        );
    }

    #[test]
    fn same_path_entry_follows_windows_comparison_rules() {
        assert!(same_path_entry(
            r"C:\Users\Dev\.codex",
            r"c:/users/dev/.CODEX/"
        ));
        assert!(same_path_entry(r#""D:\a b""#, r"D:\a b"));
        assert!(!same_path_entry(r"D:\custom-codex", r"C:\Users\Dev\.codex"));
        assert!(
            !same_path_entry(r"~\.codex", r"~\.codex"),
            "relative overrides never match"
        );
    }

    #[test]
    fn display_icon_strips_quotes_and_icon_index() {
        assert_eq!(
            display_icon_executable(r#""D:\Apps\WorkBuddy\WorkBuddy.exe",0"#).as_deref(),
            Some(r"D:\Apps\WorkBuddy\WorkBuddy.exe")
        );
        assert_eq!(
            display_icon_executable(r"D:\Apps\WorkBuddy\WorkBuddy.exe,-101").as_deref(),
            Some(r"D:\Apps\WorkBuddy\WorkBuddy.exe")
        );
        assert_eq!(display_icon_executable(r"C:\Apps\Tool\uninstall.ico"), None);
        assert_eq!(display_icon_executable(""), None);
    }

    #[test]
    fn uninstall_candidates_only_name_the_requested_executables() {
        let names = ["WorkBuddy.exe"];
        assert_eq!(
            uninstall_entry_candidates(
                Some(r#""E:\工具\Work Buddy""#),
                Some(r"E:\工具\Work Buddy\workbuddy.EXE,0"),
                &names,
            ),
            vec![
                PathBuf::from(r"E:\工具\Work Buddy").join("WorkBuddy.exe"),
                PathBuf::from(r"E:\工具\Work Buddy\workbuddy.EXE"),
            ]
        );
        assert!(uninstall_entry_candidates(
            Some(r"relative\WorkBuddy"),
            Some(r"C:\Other\Other.exe,0"),
            &names,
        )
        .is_empty());
        assert!(uninstall_entry_candidates(Some(r"C:\Apps\X"), None, &[]).is_empty());
    }

    #[test]
    fn app_path_candidate_requires_the_matching_executable_name() {
        assert_eq!(
            app_path_candidate(r#""F:\Apps\WorkBuddy\WorkBuddy.exe""#, "WorkBuddy.exe"),
            Some(PathBuf::from(r"F:\Apps\WorkBuddy\WorkBuddy.exe"))
        );
        assert_eq!(
            app_path_candidate(r"F:\Apps\WorkBuddy\Launcher.exe", "WorkBuddy.exe"),
            None
        );
        assert_eq!(app_path_candidate(r"WorkBuddy.exe", "WorkBuddy.exe"), None);
    }
}
