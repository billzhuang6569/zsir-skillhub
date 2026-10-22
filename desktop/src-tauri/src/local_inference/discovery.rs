//! Login-shell output is discovery data only, never an environment to inherit wholesale.
use super::Error;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

type Environment = Vec<(OsString, OsString)>;
const PROXIES: &[&str] = &[
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
    "no_proxy",
];

fn managed_path(program_files: Option<OsString>, windows: bool) -> Option<PathBuf> {
    if windows {
        program_files
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .map(|path| path.join("ClaudeCode/managed-mcp.json"))
    } else {
        Some(PathBuf::from(
            "/Library/Application Support/ClaudeCode/managed-mcp.json",
        ))
    }
}

fn check_managed(
    path: Option<PathBuf>,
    exists: impl FnOnce(&Path) -> std::io::Result<bool>,
) -> Result<(), Error> {
    match path {
        Some(path) => match exists(&path) {
            Ok(false) => Ok(()),
            // Unreadable policy must not silently weaken isolation either.
            Ok(true) | Err(_) => Err(Error::ManagedMcp),
        },
        None => Err(Error::ManagedMcp),
    }
}

pub(super) fn check_managed_mcp() -> Result<(), Error> {
    check_managed(
        managed_path(std::env::var_os("ProgramFiles"), cfg!(windows)),
        |path| match std::fs::symlink_metadata(path) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        },
    )
}

fn check_proxies(values: &Environment) -> Result<(), Error> {
    if values.iter().any(|(key, value)| {
        let key = key.to_string_lossy();
        PROXIES.contains(&key.as_ref()) && !key.eq_ignore_ascii_case("NO_PROXY") && {
            let value = value.to_string_lossy().trim().to_ascii_lowercase();
            value.starts_with("socks5://") || value.starts_with("socks5h://")
        }
    }) {
        Err(Error::SocksProxy)
    } else {
        Ok(())
    }
}

pub(super) fn paths() -> Vec<PathBuf> {
    cached()
        .iter()
        .filter(|(key, _)| key == "PATH")
        .flat_map(|(_, value)| std::env::split_paths(value))
        .filter(|path| path.is_absolute())
        .collect()
}

pub(super) fn merge_proxies(values: &mut Environment) -> Result<(), Error> {
    merge_discovered(values, cached())
}

fn merge_discovered(values: &mut Environment, discovered: Environment) -> Result<(), Error> {
    for (key, value) in discovered {
        // The discovery script prints unset variables as empty; they must not mask app values.
        if !value.is_empty() && key.to_str().is_some_and(|key| PROXIES.contains(&key)) {
            values.retain(|(existing, _)| existing != &key);
            values.push((key, value));
        }
    }
    check_proxies(values)
}

fn cached() -> Environment {
    #[cfg(target_os = "macos")]
    if let Some(receiver) = shell::CACHE.0.get() {
        if let Some(Ok(values)) = &*receiver.borrow() {
            return values.clone();
        }
    }
    Vec::new()
}

pub(super) async fn prepare() -> Result<(), Error> {
    #[cfg(target_os = "macos")]
    shell::CACHE.get(shell::discover).await?;
    Ok(())
}

#[cfg(any(target_os = "macos", all(test, unix)))]
mod shell {
    use super::*;
    use std::{future::Future, sync::OnceLock, time::Duration};
    use tokio::sync::watch;

    type Snapshot = Option<Result<Environment, Error>>;
    #[derive(Default)]
    pub(super) struct Cache(pub OnceLock<watch::Receiver<Snapshot>>);
    impl Cache {
        pub async fn get<F, Fut>(&self, discover: F) -> Result<Environment, Error>
        where
            F: FnOnce() -> Fut,
            Fut: Future<Output = Result<Environment, Error>> + Send + 'static,
        {
            let mut receiver = self
                .0
                .get_or_init(|| {
                    let (sender, receiver) = watch::channel(None);
                    let future = discover();
                    // The owner task outlives cancelled UI requests: never launch a second shell.
                    tokio::spawn(async move {
                        let _ = sender.send(Some(future.await));
                    });
                    receiver
                })
                .clone();
            loop {
                if let Some(result) = receiver.borrow().clone() {
                    return result;
                }
                receiver.changed().await.map_err(|_| Error::Io)?;
            }
        }
    }
    #[cfg(target_os = "macos")]
    pub(super) static CACHE: Cache = Cache(OnceLock::new());

    fn allowed(shell: &Path, shells: &str) -> bool {
        shell.is_absolute()
            && shells.lines().any(|line| {
                let entry = line.split('#').next().unwrap_or("").trim();
                !entry.is_empty() && Path::new(entry) == shell
            })
    }

    fn parse(bytes: &[u8], marker: &str) -> Result<Environment, Error> {
        let start = format!("{marker}:BEGIN");
        let end = format!("{marker}:END");
        let mut records = bytes.split(|byte| *byte == 0);
        records
            .find(|record| *record == start.as_bytes())
            .ok_or(Error::InvalidResult)?;
        let mut values = Vec::new();
        for record in records {
            if record == end.as_bytes() {
                return Ok(values);
            }
            let record = std::str::from_utf8(record).map_err(|_| Error::InvalidResult)?;
            let (key, value) = record.split_once('=').ok_or(Error::InvalidResult)?;
            if (key != "PATH" && !PROXIES.contains(&key))
                || values.iter().any(|(existing, _)| existing == key)
            {
                return Err(Error::InvalidResult);
            }
            values.push((OsString::from(key), OsString::from(value)));
        }
        Err(Error::InvalidResult)
    }

    #[cfg(target_os = "macos")]
    pub(super) async fn discover() -> Result<Environment, Error> {
        let Some(shell) = std::env::var_os("SHELL").map(PathBuf::from) else {
            return Ok(vec![]);
        };
        let shells = tokio::fs::read_to_string("/etc/shells")
            .await
            .unwrap_or_default();
        if !allowed(&shell, &shells) {
            return Ok(vec![]);
        }
        discover_in(&shell).await
    }

    async fn discover_in(shell: &Path) -> Result<Environment, Error> {
        let marker = format!("SKILLHUB_{}", uuid::Uuid::new_v4().simple());
        let mut script = format!("printf '\\0{marker}:BEGIN\\0'; ");
        for key in std::iter::once(&"PATH").chain(PROXIES.iter()) {
            script.push_str(&format!("printf '%s\\0' \"{key}=${{{key}-}}\"; "));
        }
        script.push_str(&format!("printf '{marker}:END\\0'"));
        // fish/tcsh also appear in /etc/shells; let sh expand only exported values.
        let script = format!("/bin/sh -c '{}'", script.replace('\'', "'\"'\"'"));
        for mode in ["-ilc", "-lc"] {
            match super::super::process::discover_shell(
                shell,
                mode,
                &script,
                Duration::from_secs(5),
            )
            .await
            {
                Ok(bytes) => {
                    if let Ok(values) = parse(&bytes, &marker) {
                        return Ok(values);
                    }
                }
                Err(Error::TerminationFailed) => return Err(Error::TerminationFailed),
                Err(_) => {}
            }
        }
        Ok(vec![])
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[tokio::test]
        async fn fake_login_shell_falls_back_and_exports_only_discovery_values() {
            use std::os::unix::fs::PermissionsExt;
            let dir = super::super::super::process::Scratch::new().unwrap();
            let shell = dir.0.join("fake-shell");
            let count = dir.0.join("calls");
            std::fs::write(&shell, format!("#!/bin/sh\necho \"$1\" >> '{}'\n[ \"$1\" = -ilc ] && exit 1\nexport PATH='/custom/bin:/bin'\nexport https_proxy='http://localhost:7897'\nexport SECRET='must-not-propagate'\nprintf 'startup noise\\n'\n/bin/sh -c \"$2\"\nprintf 'trailing noise\\n'\n", count.display())).unwrap();
            std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
            let values = discover_in(&shell).await.unwrap();
            assert!(values.contains(&("PATH".into(), "/custom/bin:/bin".into())));
            assert!(values.contains(&("https_proxy".into(), "http://localhost:7897".into())));
            assert!(!values.iter().any(|(key, _)| key == "SECRET"));
            assert_eq!(std::fs::read_to_string(count).unwrap(), "-ilc\n-lc\n");
        }
        #[test]
        fn markers_ignore_noise_preserve_multiline_and_require_end() {
            let bytes = b"startup\nnoise\0m:BEGIN\0PATH=/bin:/custom\npath\0https_proxy=http://localhost:80\0m:END\0trailing";
            let result = parse(bytes, "m").unwrap();
            assert_eq!(result[0].1, "/bin:/custom\npath");
            assert_eq!(result.len(), 2);
            for bytes in [
                &b"m:BEGIN\0PATH=/bin\0"[..],
                &b"noise"[..],
                &b"m:BEGIN\0SECRET=x\0m:END\0"[..],
            ] {
                assert_eq!(parse(bytes, "m"), Err(Error::InvalidResult));
            }
        }
        #[test]
        fn only_absolute_listed_shells_are_allowed() {
            let list = "# shells\n/bin/zsh\n /bin/bash # comment\n";
            assert!(allowed(Path::new("/bin/zsh"), list));
            assert!(allowed(Path::new("/bin/bash"), list));
            for path in ["zsh", "/tmp/zsh", "/bin/sh", "/bin/zsh-extra"] {
                assert!(!allowed(Path::new(path), list));
            }
        }
        #[tokio::test]
        async fn cache_runs_once_even_after_caller_cancellation_or_failure() {
            let cache = Cache::default();
            let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let count = calls.clone();
            let result = tokio::time::timeout(
                Duration::from_millis(10),
                cache.get(|| async move {
                    count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    Err(Error::Io)
                }),
            )
            .await;
            assert!(result.is_err());
            for _ in 0..2 {
                assert_eq!(
                    cache.get(|| async { panic!("second shell") }).await,
                    Err(Error::Io)
                );
            }
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn managed_policy_detection_is_injected_and_fails_closed() {
        let path = managed_path(None, false).unwrap();
        assert_eq!(
            path,
            Path::new("/Library/Application Support/ClaudeCode/managed-mcp.json")
        );
        assert_eq!(
            check_managed(Some(path.clone()), |_| Ok(true)),
            Err(Error::ManagedMcp)
        );
        assert_eq!(check_managed(Some(path.clone()), |_| Ok(false)), Ok(()));
        assert_eq!(
            check_managed(Some(path), |_| Err(
                std::io::ErrorKind::PermissionDenied.into()
            )),
            Err(Error::ManagedMcp)
        );
        assert!(managed_path(None, true).is_none());
        let root = std::env::temp_dir();
        assert_eq!(
            managed_path(Some(root.as_os_str().into()), true),
            Some(root.join("ClaudeCode/managed-mcp.json"))
        );
    }
    #[test]
    fn empty_discovered_proxies_do_not_mask_existing_values() {
        let mut values = vec![("HTTPS_PROXY".into(), "http://localhost:80".into())];
        merge_discovered(
            &mut values,
            vec![
                ("HTTPS_PROXY".into(), "".into()),
                ("http_proxy".into(), "http://localhost:81".into()),
                ("PATH".into(), "/ignored".into()),
            ],
        )
        .unwrap();
        assert_eq!(
            values,
            vec![
                ("HTTPS_PROXY".into(), "http://localhost:80".into()),
                ("http_proxy".into(), "http://localhost:81".into()),
            ]
        );
    }
    #[test]
    fn socks_detection_checks_both_cases_but_not_no_proxy() {
        for key in ["HTTPS_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
            for value in ["socks5://localhost:1080", " SOCKS5H://localhost:1080 "] {
                assert_eq!(
                    check_proxies(&vec![(key.into(), value.into())]),
                    Err(Error::SocksProxy)
                );
            }
        }
        assert_eq!(
            check_proxies(&vec![
                ("HTTP_PROXY".into(), "http://localhost:80".into()),
                ("NO_PROXY".into(), "socks5://ignored".into())
            ]),
            Ok(())
        );
    }
}
