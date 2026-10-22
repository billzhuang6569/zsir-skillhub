//! Bounded pipes and process-tree ownership, including while stdin is blocked.
use super::{Error, Launch};
use std::{ffi::OsString, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::watch,
};

pub(super) const TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(unix)]
pub(super) const GRACE: Duration = Duration::from_secs(2);
pub(super) const STDOUT_LIMIT: usize = 1024 * 1024;
const STDERR_LIMIT: usize = 64 * 1024;

pub(super) struct Scratch(pub PathBuf);
impl Scratch {
    pub fn new() -> Result<Self, Error> {
        let path =
            std::env::temp_dir().join(format!("skillhub-inference-{}", uuid::Uuid::new_v4()));
        let builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        builder.create(&path).map_err(|_| Error::Io)?;
        Ok(Self(path))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        // Never clean a parent or a caller-supplied directory.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn environment(
    launch: &Launch,
    scratch: &Scratch,
    source: impl IntoIterator<Item = (OsString, OsString)>,
) -> Result<Vec<(OsString, OsString)>, Error> {
    const ALLOWED: &[&str] = &[
        "HOME",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "SHELL",
        "LANG",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "https_proxy",
        "http_proxy",
        "all_proxy",
        "no_proxy",
    ];
    let mut values: Vec<_> = source
        .into_iter()
        .filter(|(key, _)| key.to_str().is_some_and(|key| ALLOWED.contains(&key)))
        .collect();
    let mut paths = vec![launch
        .program
        .parent()
        .ok_or(Error::Executable)?
        .to_path_buf()];
    paths.extend(launch.node_dir.iter().cloned());
    paths.extend(super::discovery::paths());
    // Used only for TEMP/TMP on Windows; do not widen the Unix allowlist.
    let _ = scratch;
    #[cfg(unix)]
    paths.extend(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from));
    #[cfg(windows)]
    {
        // Windows needs its OS directory to load system DLLs; never inherit arbitrary PATH.
        let root = std::env::var_os("SystemRoot").ok_or(Error::Executable)?;
        paths.push(PathBuf::from(&root).join("System32"));
        paths.push(PathBuf::from(&root));
        values.push(("SystemRoot".into(), root));
        for key in ["TEMP", "TMP"] {
            values.push((key.into(), scratch.0.as_os_str().to_owned()));
        }
    }
    values.push((
        "PATH".into(),
        std::env::join_paths(paths).map_err(|_| Error::Executable)?,
    ));
    super::discovery::merge_proxies(&mut values)?;
    values.extend([
        ("ENABLE_CLAUDEAI_MCP_SERVERS".into(), "0".into()),
        ("CLAUDE_CODE_DISABLE_AUTO_MEMORY".into(), "1".into()),
        ("DISABLE_AUTOUPDATER".into(), "1".into()),
    ]);
    Ok(values)
}

async fn bounded(mut reader: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let length = reader.read(&mut chunk).await.map_err(|_| Error::Io)?;
        if length == 0 {
            return Ok(bytes);
        }
        if bytes.len() + length > limit {
            return Err(Error::OutputLimit);
        }
        bytes.extend_from_slice(&chunk[..length]);
    }
}

#[cfg(unix)]
struct Tree(u32);
#[cfg(unix)]
impl Tree {
    fn signal(&self, signal: i32, child: &mut tokio::process::Child) -> Result<(), Error> {
        // The child is group leader; a negative PID addresses only its group.
        let result = unsafe { libc::kill(-(self.0 as i32), signal) };
        if result == 0 {
            Ok(())
        } else {
            signal_error(std::io::Error::last_os_error(), || {
                // Tokio caches the reaped status for the subsequent child.wait().
                matches!(child.try_wait(), Ok(Some(_)))
            })
        }
    }
    async fn terminate(&self, child: &mut tokio::process::Child) -> Result<(), Error> {
        terminate_group(|signal| self.signal(signal, child)).await
    }
    fn finish(&self, child: &mut tokio::process::Child) -> Result<(), Error> {
        self.signal(libc::SIGKILL, child)
    }
}
#[cfg(unix)]
fn signal_error(error: std::io::Error, leader_exited: impl FnOnce() -> bool) -> Result<(), Error> {
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(()),
        // Darwin returns EPERM for zombie-only groups; Linux returns ESRCH.
        Some(libc::EPERM) if leader_exited() => Ok(()),
        _ => Err(Error::TerminationFailed),
    }
}
#[cfg(unix)]
pub(super) async fn terminate_group(
    mut signal: impl FnMut(i32) -> Result<(), Error>,
) -> Result<(), Error> {
    let term = signal(libc::SIGTERM);
    tokio::time::sleep(GRACE).await;
    let kill = signal(libc::SIGKILL);
    term.and(kill)
}
#[cfg(unix)]
impl Drop for Tree {
    fn drop(&mut self) {
        // Best-effort fallback also runs if execute's future is dropped.
        let _ = unsafe { libc::kill(-(self.0 as i32), libc::SIGKILL) };
    }
}

#[cfg(windows)]
#[path = "windows_job.rs"]
mod windows_job;
#[cfg(windows)]
use windows_job::Tree;

pub(super) async fn execute(
    launch: &Launch,
    args: &[String],
    prompt: &[u8],
    cancel: &mut watch::Receiver<bool>,
    timeout: Duration,
) -> Result<Vec<u8>, Error> {
    execute_with_source(
        launch,
        args,
        prompt,
        cancel,
        timeout,
        std::env::vars_os().collect(),
    )
    .await
}

pub(super) async fn execute_with_source(
    launch: &Launch,
    args: &[String],
    prompt: &[u8],
    cancel: &mut watch::Receiver<bool>,
    timeout: Duration,
    source: Vec<(OsString, OsString)>,
) -> Result<Vec<u8>, Error> {
    if *cancel.borrow() {
        return Err(Error::Cancelled);
    }
    let scratch = Scratch::new()?;
    let mut command = Command::new(&launch.program);
    command
        .args(&launch.prefix)
        .args(args)
        .current_dir(&scratch.0)
        .env_clear()
        .envs(environment(launch, &scratch, source)?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        command.creation_flags(
            windows_sys::Win32::System::Threading::CREATE_SUSPENDED
                | windows_sys::Win32::System::Threading::CREATE_NO_WINDOW,
        );
    }
    let mut child = command.spawn().map_err(|_| Error::Spawn)?;
    #[cfg(unix)]
    let tree = Tree(child.id().ok_or(Error::Spawn)?);
    #[cfg(windows)]
    let tree = match Tree::attach_and_resume(&child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill().await;
            return Err(error);
        }
    };
    let mut stdin = child.stdin.take().ok_or(Error::Io)?;
    let stdout = child.stdout.take().ok_or(Error::Io)?;
    let stderr = child.stderr.take().ok_or(Error::Io)?;
    let mut result = {
        let exchange = async {
            let ((), output, _, status) = tokio::try_join!(
                async {
                    stdin.write_all(prompt).await.map_err(|_| Error::Io)?;
                    stdin.shutdown().await.map_err(|_| Error::Io)?;
                    drop(stdin);
                    Ok(())
                },
                bounded(stdout, STDOUT_LIMIT),
                bounded(stderr, STDERR_LIMIT),
                async { child.wait().await.map_err(|_| Error::Io) }
            )?;
            if !status.success() {
                return Err(if status.code() == Some(127) {
                    Error::Executable
                } else {
                    Error::Exit
                });
            }
            Ok(output)
        };
        tokio::select! {
            biased;
            _ = cancel.changed() => Err(Error::Cancelled),
            _ = tokio::time::sleep(timeout) => Err(Error::Timeout),
            result = exchange => result,
        }
    };
    #[cfg(unix)]
    let terminated = if result.is_err() {
        tree.terminate(&mut child).await
    } else {
        tree.finish(&mut child)
    };
    #[cfg(windows)]
    let terminated = if result.is_err() {
        tree.terminate().await
    } else {
        tree.finish()
    };
    if let Err(error) = terminated {
        // A denied group kill must not look like a completed cancellation.
        let _ = child.start_kill();
        result = Err(error);
    }
    drop(tree); // Kill descendants even if the CLI exited successfully.
    if !matches!(
        tokio::time::timeout(Duration::from_secs(2), child.wait()).await,
        Ok(Ok(_))
    ) {
        result = Err(Error::TerminationFailed);
    }
    drop(scratch);
    result
}

#[cfg(any(target_os = "macos", all(test, unix)))]
pub(super) async fn discover_shell(
    shell: &std::path::Path,
    mode: &str,
    script: &str,
    timeout: Duration,
) -> Result<Vec<u8>, Error> {
    let scratch = Scratch::new()?;
    let mut command = Command::new(shell);
    command
        .args([mode, script])
        .current_dir(&scratch.0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| Error::Spawn)?;
    let tree = Tree(child.id().ok_or(Error::Spawn)?);
    let stdout = child.stdout.take().ok_or(Error::Io)?;
    let stderr = child.stderr.take().ok_or(Error::Io)?;
    let exchange = async {
        let (output, _, status) = tokio::try_join!(
            bounded(stdout, STDERR_LIMIT),
            bounded(stderr, STDERR_LIMIT),
            async { child.wait().await.map_err(|_| Error::Io) }
        )?;
        if status.success() {
            Ok(output)
        } else {
            Err(Error::Exit)
        }
    };
    let result = tokio::time::timeout(timeout, exchange)
        .await
        .unwrap_or(Err(Error::Timeout));
    // Discovery has a hard five-second budget, including descendants holding pipes open.
    let terminated = tree.finish(&mut child);
    if terminated.is_err() {
        let _ = child.start_kill();
    }
    drop(tree);
    let reaped = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    terminated?;
    if !matches!(reaped, Ok(Ok(_))) {
        return Err(Error::TerminationFailed);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn signal_eperm_requires_exited_group_leader() {
        for (exited, expected) in [(true, Ok(())), (false, Err(Error::TerminationFailed))] {
            assert_eq!(
                signal_error(std::io::Error::from_raw_os_error(libc::EPERM), || exited),
                expected
            );
        }
        assert_eq!(
            signal_error(std::io::Error::from_raw_os_error(libc::ESRCH), || {
                panic!("ESRCH does not require checking the leader")
            }),
            Ok(())
        );
        assert_eq!(
            signal_error(std::io::Error::from_raw_os_error(libc::EINVAL), || true),
            Err(Error::TerminationFailed)
        );
    }

    #[tokio::test]
    async fn pipe_limits_accept_boundary_and_reject_next_byte() {
        assert_eq!(TIMEOUT, Duration::from_secs(60));
        #[cfg(unix)]
        assert_eq!(GRACE, Duration::from_secs(2));
        for limit in [STDOUT_LIMIT, STDERR_LIMIT] {
            let bytes = vec![b'x'; limit + 1];
            assert_eq!(bounded(&bytes[..limit], limit).await.unwrap().len(), limit);
            assert_eq!(
                bounded(bytes.as_slice(), limit).await,
                Err(Error::OutputLimit)
            );
        }
    }
}
