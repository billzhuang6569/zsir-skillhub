use reqwest::Url;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_deep_link::DeepLinkExt;

pub(crate) use crate::official_channel::APP_OPEN_LINK;
use crate::official_channel::{DEEP_LINK_SCHEME, INVITE_PREFIX};
use crate::spaces::{canonical_base, normalize_base};
const MAX_LINK_LENGTH: usize = 4096;
const MAX_CLIPBOARD_LENGTH: usize = 64 * 1024;
/// The invite poll waits at most this long; a slower read keeps running in the background and
/// its result is handed to a later poll.
const CLIPBOARD_READ_TIMEOUT: Duration = Duration::from_secs(3);
/// After a failed read the same clipboard sequence waits before it is read again: 2 s, then
/// doubling up to 60 s. A broken clipboard owner therefore cannot keep a background thread
/// blocked back to back, yet the sequence is never given up — once the owner recovers, the
/// next retry delivers it (#224 review).
const CLIPBOARD_RETRY_BASE: Duration = Duration::from_secs(2);
const CLIPBOARD_RETRY_MAX: Duration = Duration::from_secs(60);

/// Backoff before retrying a sequence whose read failed `failures` times in a row.
fn clipboard_retry_delay(failures: u32) -> Duration {
    let doublings = failures.saturating_sub(1).min(16);
    CLIPBOARD_RETRY_BASE
        .saturating_mul(1u32 << doublings)
        .min(CLIPBOARD_RETRY_MAX)
}

/// State of the team-invite clipboard poll (#223).
///
/// Windows can block a clipboard read for up to 30 s when the owner uses delayed rendering and
/// stops answering WM_RENDERFORMAT (seen with the Parallels clipboard agent). Reads therefore run
/// on a worker, at most one at a time, and a clipboard sequence is only marked as handled once
/// its text has actually been delivered to the page.
struct ClipboardPoll {
    /// Sequence whose text was delivered. Only a successful delivery moves it.
    handled: Option<u32>,
    /// The latest failed sequence, how many reads of it failed in a row, and when it may be
    /// read again.
    failures: Option<Failure>,
    /// A finished read nobody has consumed yet, e.g. one that outlived the caller's timeout.
    pending: Option<(u32, Result<String, String>)>,
}

#[derive(Clone, Copy)]
struct Failure {
    sequence: u32,
    count: u32,
    retry_at: Instant,
}

impl ClipboardPoll {
    const fn new() -> Self {
        Self {
            handled: None,
            failures: None,
            pending: None,
        }
    }

    /// Records the outcome of a finished read and returns what the page should receive.
    /// Sequence 0 means the platform cannot tell clipboard changes apart; nothing is recorded.
    fn settle(
        &mut self,
        sequence: u32,
        result: Result<String, String>,
        now: Instant,
    ) -> Result<String, String> {
        if sequence == 0 {
            return result;
        }
        match &result {
            Ok(_) => {
                self.handled = Some(sequence);
                self.failures = None;
            }
            Err(_) => {
                let count = match self.failures {
                    Some(failure) if failure.sequence == sequence => {
                        failure.count.saturating_add(1)
                    }
                    _ => 1,
                };
                self.failures = Some(Failure {
                    sequence,
                    count,
                    retry_at: now + clipboard_retry_delay(count),
                });
            }
        }
        result
    }

    /// Whether `sequence` is still cooling down after a failed read at `now`.
    fn cooling(&self, sequence: u32, now: Instant) -> bool {
        matches!(self.failures, Some(failure) if failure.sequence == sequence && now < failure.retry_at)
    }
}

static CLIPBOARD_POLL: Mutex<ClipboardPoll> = Mutex::new(ClipboardPoll::new());
/// Set while a worker is reading; cleared only when that worker really finishes.
static CLIPBOARD_READING: AtomicBool = AtomicBool::new(false);
#[derive(Default)]
pub struct PendingDeepLinks(Mutex<Vec<String>>);

fn normalized_invite_link(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.len() > MAX_LINK_LENGTH || !trimmed.starts_with(INVITE_PREFIX) {
        return None;
    }
    let url = Url::parse(trimmed).ok()?;
    if url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.host_str() != Some("join-team")
    {
        return None;
    }
    let raw_token = trimmed.strip_prefix(INVITE_PREFIX)?.split('?').next()?;
    if raw_token.contains(['&', '=', '+', '#']) {
        return None;
    }
    let mut token_url = url.clone();
    token_url.set_query(Some(raw_token));
    let token = token_url.query_pairs().next()?.0.into_owned();
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3
        || parts[0] != "shti1"
        || parts[1].len() != 54
        || parts[2].len() != 27
        || !parts[1..].iter().all(|part| {
            part.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
    {
        return None;
    }
    let queries: Vec<_> = url.query_pairs().collect();
    if queries.is_empty() {
        return Some(format!("{INVITE_PREFIX}{token}"));
    }
    if queries.len() != 1 || queries[0].0 != "server" {
        return None;
    }
    let server = normalize_invite_server(queries[0].1.to_string()).ok()?;
    let mut normalized = Url::parse(&format!("{INVITE_PREFIX}{token}")).ok()?;
    normalized.query_pairs_mut().append_pair("server", &server);
    Some(normalized.to_string())
}

#[tauri::command]
pub fn normalize_invite_server(value: String) -> Result<String, String> {
    normalize_base(&value).map(|base| canonical_base(&base))
}

fn is_app_open_link(value: &str) -> bool {
    value.trim() == APP_OPEN_LINK || value.trim().strip_suffix('/') == Some(APP_OPEN_LINK)
}

fn normalized_team_skill_link(value: &str) -> Option<String> {
    if value.len() > MAX_LINK_LENGTH
        || !value.starts_with(&format!("{DEEP_LINK_SCHEME}://team-skill/"))
    {
        return None;
    }
    let url = Url::parse(value).ok()?;
    if value.split('?').next()? != format!("{DEEP_LINK_SCHEME}://team-skill{}", url.path()) {
        return None;
    }
    if url.host_str() != Some("team-skill")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let parts: Vec<_> = url.path().split('/').collect();
    if parts.len() != 3
        || !parts[1..].iter().all(|part| {
            part.len() == 36
                && uuid::Uuid::parse_str(part).is_ok()
                && matches!(part.as_bytes()[14], b'1'..=b'8')
                && matches!(part.as_bytes()[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
        })
    {
        return None;
    }
    let query = url.query()?;
    if !query.starts_with("server=") || query.contains('&') {
        return None;
    }
    let params: Vec<_> = url.query_pairs().collect();
    if params.len() != 1 || params[0].0 != "server" {
        return None;
    }
    let server = normalize_invite_server(params[0].1.to_string()).ok()?;
    let mut normalized = url.clone();
    normalized.set_query(None);
    normalized.query_pairs_mut().append_pair("server", &server);
    Some(normalized.to_string())
}

fn unique_invite_links<I>(values: I) -> Vec<String>
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter_map(|value| normalized_invite_link(value.as_ref()))
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn enqueue_deep_links<I>(app: &AppHandle, values: I)
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    let values = values
        .into_iter()
        .map(|value| value.as_ref().trim().to_string())
        .collect::<Vec<_>>();
    let open_requested = values.iter().any(|value| is_app_open_link(value));
    let mut links = unique_invite_links(&values);
    for link in values
        .iter()
        .filter_map(|value| normalized_team_skill_link(value))
    {
        if !links.contains(&link) {
            links.push(link);
        }
    }
    if links.is_empty() && !open_requested {
        return;
    }
    if !links.is_empty() {
        if let Some(state) = app.try_state::<PendingDeepLinks>() {
            if let Ok(mut pending) = state.0.lock() {
                for link in &links {
                    if !pending.contains(link) {
                        pending.push(link.clone());
                    }
                }
            }
        }
        let _ = app.emit("skillhub-deep-link", links);
    }
    focus_main_window(app);
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(urls) = app.deep_link().get_current()? {
        enqueue_deep_links(app.handle(), urls.iter().map(ToString::to_string));
    }
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        enqueue_deep_links(&handle, event.urls().iter().map(ToString::to_string));
    });
    Ok(())
}

#[tauri::command]
pub fn take_pending_deep_links(state: State<'_, PendingDeepLinks>) -> Vec<String> {
    match state.0.lock() {
        Ok(mut pending) => std::mem::take(&mut *pending),
        Err(_) => Vec::new(),
    }
}

#[cfg(windows)]
fn clipboard_sequence() -> u32 {
    // SAFETY: GetClipboardSequenceNumber takes no arguments and only reads a counter.
    unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

#[cfg(not(windows))]
fn clipboard_sequence() -> u32 {
    0
}

fn lock_poll(state: &Mutex<ClipboardPoll>) -> std::sync::MutexGuard<'_, ClipboardPoll> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Clears the in-flight flag when the worker finishes, after its result has been parked.
struct ReadingGuard(&'static AtomicBool);

impl Drop for ReadingGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// One poll of the clipboard for clipboard sequence `sequence`.
///
/// - A result parked by an earlier, slower read is delivered first.
/// - A sequence that was already delivered is not read again; one whose read failed waits
///   for its backoff and is then read again.
/// - While another read is in flight nothing is recorded, so a sequence that changes meanwhile
///   is read once that worker finishes.
/// - Otherwise `read` runs on a blocking worker; the caller waits at most `timeout`, and a later
///   result is parked for the next poll instead of being dropped.
///
/// `None` means there is nothing to deliver this time.
async fn poll_clipboard<R>(
    state: &'static Mutex<ClipboardPoll>,
    reading: &'static AtomicBool,
    sequence: u32,
    now: Instant,
    timeout: Duration,
    read: R,
) -> Option<Result<String, String>>
where
    R: FnOnce() -> Result<String, String> + Send + 'static,
{
    {
        let mut poll = lock_poll(state);
        if let Some((parked, result)) = poll.pending.take() {
            return Some(poll.settle(parked, result, now));
        }
        if sequence != 0 && (poll.handled == Some(sequence) || poll.cooling(sequence, now)) {
            return None;
        }
    }
    if reading.swap(true, Ordering::SeqCst) {
        return None;
    }
    let (done, finished) = tokio::sync::oneshot::channel::<()>();
    let worker = tauri::async_runtime::spawn_blocking(move || {
        let guard = ReadingGuard(reading);
        let result = read();
        lock_poll(state).pending = Some((sequence, result));
        // Clear the in-flight flag before waking the caller: a poll that starts right after
        // `done` must be able to read again instead of seeing a finished worker as busy (#376).
        drop(guard);
        let _ = done.send(());
    });
    drop(worker);
    let _ = tokio::time::timeout(timeout, finished).await;
    let mut poll = lock_poll(state);
    let (parked, result) = poll.pending.take()?;
    Some(poll.settle(parked, result, now))
}

/// Reads clipboard text for the team-invite poll without ever blocking the main thread.
/// Async commands run on the async runtime instead of the Windows UI thread (#223).
/// Returns `None` when there is nothing new to deliver: the clipboard was already handled,
/// a read is still in flight, or the read is slower than [`CLIPBOARD_READ_TIMEOUT`] (its
/// result is then delivered by a later poll).
#[tauri::command]
pub async fn read_clipboard_text(app: AppHandle) -> Result<Option<String>, String> {
    let read = move || {
        app.clipboard()
            .read_text()
            .map_err(|error| error.to_string())
    };
    match poll_clipboard(
        &CLIPBOARD_POLL,
        &CLIPBOARD_READING,
        clipboard_sequence(),
        Instant::now(),
        CLIPBOARD_READ_TIMEOUT,
        read,
    )
    .await
    {
        None => Ok(None),
        Some(Err(error)) => Err(error),
        Some(Ok(value)) if value.len() > MAX_CLIPBOARD_LENGTH => Ok(Some(String::new())),
        Some(Ok(value)) => Ok(Some(value)),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn team_skill_links_validate_identity_and_server() {
        let base = format!("{}://team-skill/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", super::DEEP_LINK_SCHEME);
        let valid = format!("{base}?server=https%3A%2F%2Fexample.test%2Fbase");
        assert_eq!(
            super::normalized_team_skill_link(&valid),
            Some(valid.clone())
        );
        for invalid in [
            base.to_string(),
            format!("{valid}&extra=1"),
            format!("{valid}&"),
            valid.replace("?server=", "?&server="),
            format!("{valid}&server=https://other.test"),
            format!("{valid}#fragment"),
            format!("{base}/?server=https://example.test"),
            valid.replace("team-skill/", "other/"),
            valid.replace("team-skill/", "user@team-skill/"),
            valid.replace("team-skill/", "team-skill:99/"),
            valid.replace("11111111-1111-4111-8111-111111111111", "bad"),
            format!("{base}?server=http://evil.test"),
            format!("{valid}{}", "a".repeat(4096)),
        ] {
            assert!(
                super::normalized_team_skill_link(&invalid).is_none(),
                "{invalid}"
            );
        }
    }

    use super::{
        clipboard_retry_delay, is_app_open_link, poll_clipboard, unique_invite_links,
        ClipboardPoll, APP_OPEN_LINK, CLIPBOARD_RETRY_BASE, CLIPBOARD_RETRY_MAX,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Mutex};
    use std::time::{Duration, Instant};

    type Poll = &'static Mutex<ClipboardPoll>;
    type Flag = &'static AtomicBool;

    fn fresh() -> (Poll, Flag) {
        (
            Box::leak(Box::new(Mutex::new(ClipboardPoll::new()))),
            Box::leak(Box::new(AtomicBool::new(false))),
        )
    }

    const FAST: Duration = Duration::from_secs(1);
    const SHORT: Duration = Duration::from_millis(50);

    /// A fixed poll time; backoff tests add explicit offsets to it.
    fn t0() -> Instant {
        use std::sync::OnceLock;
        static T0: OnceLock<Instant> = OnceLock::new();
        *T0.get_or_init(Instant::now)
    }

    fn text(value: &str) -> Option<Result<String, String>> {
        Some(Ok(value.to_string()))
    }

    async fn wait_until_idle(reading: Flag) {
        for _ in 0..200 {
            if !reading.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("the worker never finished");
    }

    /// Starts a read of `sequence` that blocks until the returned sender fires.
    async fn blocked_read(
        poll: Poll,
        reading: Flag,
        sequence: u32,
        value: &'static str,
    ) -> mpsc::Sender<()> {
        let (release, wait) = mpsc::channel::<()>();
        let first = poll_clipboard(poll, reading, sequence, t0(), SHORT, move || {
            let _ = wait.recv();
            Ok(value.to_string())
        })
        .await;
        assert_eq!(first, None, "the caller stops waiting after the timeout");
        assert!(
            reading.load(Ordering::SeqCst),
            "the worker still holds the slot"
        );
        release
    }

    #[tokio::test]
    async fn a_delivered_sequence_is_not_read_again() {
        let (poll, reading) = fresh();
        assert_eq!(
            poll_clipboard(poll, reading, 33, t0(), FAST, || Ok("a".into())).await,
            text("a")
        );
        let reread =
            poll_clipboard(poll, reading, 33, t0(), FAST, || panic!("must not read")).await;
        assert_eq!(reread, None);
        assert_eq!(
            poll_clipboard(poll, reading, 34, t0(), FAST, || Ok("b".into())).await,
            text("b")
        );
    }

    #[tokio::test]
    async fn without_a_sequence_every_poll_reads() {
        let (poll, reading) = fresh();
        assert_eq!(
            poll_clipboard(poll, reading, 0, t0(), FAST, || Ok("a".into())).await,
            text("a")
        );
        assert_eq!(
            poll_clipboard(poll, reading, 0, t0(), FAST, || Ok("a".into())).await,
            text("a")
        );
    }

    #[tokio::test]
    async fn a_slow_read_is_delivered_by_a_later_poll() {
        let (poll, reading) = fresh();
        let release = blocked_read(poll, reading, 33, "invite").await;
        release.send(()).expect("release the slow read");
        wait_until_idle(reading).await;

        let late = poll_clipboard(poll, reading, 33, t0(), FAST, || panic!("must not read")).await;
        assert_eq!(late, text("invite"), "the late result is not dropped");
        let again = poll_clipboard(poll, reading, 33, t0(), FAST, || panic!("must not read")).await;
        assert_eq!(again, None, "and it is delivered once");
    }

    #[tokio::test]
    async fn a_new_copy_during_a_blocked_read_is_read_afterwards() {
        let (poll, reading) = fresh();
        let release = blocked_read(poll, reading, 33, "old").await;

        // The user copies an invite (sequence 34) while sequence 33 is still blocked.
        let busy =
            poll_clipboard(poll, reading, 34, t0(), FAST, || panic!("must not overlap")).await;
        assert_eq!(busy, None, "a busy poll skips without recording anything");

        release.send(()).expect("release the blocked read");
        wait_until_idle(reading).await;
        let parked = poll_clipboard(poll, reading, 34, t0(), FAST, || panic!("parked first")).await;
        assert_eq!(parked, text("old"), "the parked result of 33 comes first");

        let fresh_copy =
            poll_clipboard(poll, reading, 34, t0(), FAST, || Ok("invite".into())).await;
        assert_eq!(fresh_copy, text("invite"), "sequence 34 is still read");
    }

    #[tokio::test]
    async fn a_failed_read_is_retried_for_the_same_sequence() {
        let (poll, reading) = fresh();
        let failed = poll_clipboard(poll, reading, 33, t0(), FAST, || Err("busy".into())).await;
        assert_eq!(failed, Some(Err("busy".to_string())));
        let cooling =
            poll_clipboard(poll, reading, 33, t0(), FAST, || panic!("still cooling")).await;
        assert_eq!(cooling, None, "the same sequence waits for its backoff");
        let retried = poll_clipboard(poll, reading, 33, t0() + CLIPBOARD_RETRY_BASE, FAST, || {
            Ok("invite".into())
        })
        .await;
        assert_eq!(
            retried,
            text("invite"),
            "a temporary error does not consume the sequence"
        );
    }

    #[tokio::test]
    async fn the_same_sequence_succeeds_after_repeated_failures_and_cooldown() {
        let (poll, reading) = fresh();
        let mut now = t0();
        // Four failures in a row: 2 s, 4 s, 8 s, 16 s of backoff.
        for attempt in 1..=4u32 {
            let failed = poll_clipboard(poll, reading, 33, now, FAST, || Err("busy".into())).await;
            assert_eq!(failed, Some(Err("busy".to_string())), "attempt {attempt}");
            let delay = clipboard_retry_delay(attempt);
            let early = poll_clipboard(
                poll,
                reading,
                33,
                now + delay - Duration::from_millis(1),
                FAST,
                || panic!("read during backoff"),
            )
            .await;
            assert_eq!(early, None, "no read before the backoff ends");
            now += delay;
        }
        // The owner has recovered: the very same sequence is still read and delivered.
        let delivered = poll_clipboard(poll, reading, 33, now, FAST, || Ok("invite".into())).await;
        assert_eq!(delivered, text("invite"));
        let again = poll_clipboard(poll, reading, 33, now, FAST, || panic!("delivered")).await;
        assert_eq!(again, None, "only a successful delivery marks it handled");
        // A new copy is not slowed down by the old sequence's backoff.
        let next = poll_clipboard(poll, reading, 34, now, FAST, || Ok("next".into())).await;
        assert_eq!(next, text("next"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_delivered_read_has_already_released_the_in_flight_flag() {
        // #376: the worker used to wake the caller before clearing the flag, so a poll that
        // started right away could see the finished worker as busy and return nothing.
        let (poll, reading) = fresh();
        for sequence in 1..=200u32 {
            let delivered = poll_clipboard(poll, reading, sequence, t0(), FAST, move || {
                Ok(format!("v{sequence}"))
            })
            .await;
            assert_eq!(delivered, text(&format!("v{sequence}")));
            assert!(
                !reading.load(Ordering::SeqCst),
                "flag still set after delivery {sequence}"
            );
        }
    }

    #[test]
    fn retry_backoff_doubles_and_is_capped() {
        assert_eq!(clipboard_retry_delay(1), CLIPBOARD_RETRY_BASE);
        assert_eq!(clipboard_retry_delay(2), CLIPBOARD_RETRY_BASE * 2);
        assert_eq!(clipboard_retry_delay(3), CLIPBOARD_RETRY_BASE * 4);
        assert_eq!(clipboard_retry_delay(6), CLIPBOARD_RETRY_MAX);
        assert_eq!(clipboard_retry_delay(u32::MAX), CLIPBOARD_RETRY_MAX);
    }

    #[test]
    fn invitation_servers_use_the_space_normalizer() {
        let token = format!("shti1.{}.{}", "a".repeat(54), "b".repeat(27));
        let prefix = crate::official_channel::INVITE_PREFIX;
        let legacy = format!("{prefix}{token}");
        assert_eq!(super::normalized_invite_link(&legacy), Some(legacy.clone()));
        let encoded_token = legacy.replace("shti1.", "shti1%2E");
        assert_eq!(super::normalized_invite_link(&encoded_token), Some(legacy));
        let link = format!("{prefix}{token}?server=https%3A%2F%2FEXAMPLE.test%3A443%2Fbase%2F");
        let normalized = super::normalized_invite_link(&link).unwrap();
        let url = reqwest::Url::parse(&normalized).unwrap();
        assert_eq!(
            url.query_pairs().next().unwrap().1,
            "https://example.test/base"
        );
        for base in [
            "http://evil.test",
            "https://u:p@example.test",
            "https://example.test/a/../b",
            "https://example.test/%61",
            "https://example.test?q=1",
            "https://example.test#fragment",
        ] {
            let mut url = reqwest::Url::parse(&format!("{prefix}{token}")).unwrap();
            url.query_pairs_mut().append_pair("server", base);
            assert!(super::normalized_invite_link(url.as_str()).is_none());
        }
        for query in [
            "server=",
            "server=https://one.test&server=https://two.test",
            "other=https://example.test",
        ] {
            assert!(super::normalized_invite_link(&format!("{prefix}{token}?{query}")).is_none());
        }
        assert!(super::normalized_invite_link(&format!("{prefix}bad-token")).is_none());
        assert!(super::normalized_invite_link(&format!("{prefix}x/../{token}")).is_none());
        assert!(super::normalize_invite_server("http://127.0.0.1:3001/".into()).is_ok());
    }

    #[test]
    fn only_skillhub_invites_are_forwarded_once() {
        let invite = format!(
            "{}shti1.{}.{}",
            crate::official_channel::INVITE_PREFIX,
            "a".repeat(54),
            "b".repeat(27)
        );
        assert_eq!(
            unique_invite_links([invite.as_str(), "https://example.com", invite.as_str()]),
            vec![invite.to_string()]
        );
    }

    #[test]
    fn fixed_open_link_is_not_forwarded_as_an_invite() {
        assert!(unique_invite_links([APP_OPEN_LINK]).is_empty());
        assert!(is_app_open_link(APP_OPEN_LINK));
        assert!(is_app_open_link(&format!("{APP_OPEN_LINK}/")));
        assert!(!is_app_open_link(&format!("{APP_OPEN_LINK}/anything")));
        assert!(!is_app_open_link(&format!("{APP_OPEN_LINK}//")));
        let other = if crate::official_channel::CHANNEL == "dev" {
            "skillhub"
        } else {
            "skillhub-dev"
        };
        assert!(!is_app_open_link(&format!("{other}://open")));
        assert!(
            unique_invite_links([format!("{other}://join-team/shti1.payload.signature")])
                .is_empty()
        );
    }
}
