export type LibrarySyncProblem = { skillId?: string; entryId?: string; message: string }

export type LibrarySyncReport = {
  uploaded: number
  downloaded: number
  profilesUpdated: number
  copiesCreated: number
  trashed: number
  bound: number
  /** Managed Skills that stay on this device and are not in the account. */
  keptLocal: number
  problems: LibrarySyncProblem[]
}

/**
 * A managed Skill on this device that is not in the account and is never
 * uploaded on its own: it was here before this account's first sync and
 * cannot be proven to be the account's, or the account deleted it.
 */
export type KeptLocalSkill = {
  skillId: string
  localId: string
  displayName: string
  reason: string
  /** "加入账号同步" was requested and is still being retried. */
  joining: boolean
}

export type LibrarySyncStatus = {
  userId: string
  keptLocal: KeptLocalSkill[]
  blocked: { entryId: string; skillId?: string; message: string }[]
  pendingCopies: number
  lastRun: { finishedAt: string; report?: LibrarySyncReport; error?: string } | null
}

export const LIBRARY_SYNC_CAPABILITY = 'skills.library-sync.v1'
export const LIBRARY_SYNC_FOREGROUND_MS = 30_000
export const LIBRARY_SYNC_BACKGROUND_MS = 5 * 60_000
/** Window event other screens dispatch to request a pass (install, import…). */
export const LIBRARY_SYNC_REQUEST_EVENT = 'skillhub:library-sync'

/** Window event after an account entry was deleted, restored or downloaded here. */
export const LIBRARY_ENTRIES_CHANGED_EVENT = 'skillhub:library-entries-changed'

/** Asks the running scheduler for a pass soon, e.g. right after an install. */
export function requestLibrarySync(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(LIBRARY_SYNC_REQUEST_EVENT))
}

export type LibrarySyncSchedulerOptions = {
  run: () => Promise<LibrarySyncReport>
  /** A pass begins (after any queued pass, too). */
  onStart?: () => void
  /** `followUp` is true when another pass starts right after this one. */
  onResult: (result: { report?: LibrarySyncReport; error?: string; followUp: boolean }) => void | Promise<void>
  isVisible: () => boolean
  foregroundMs?: number
  backgroundMs?: number
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export type LibrarySyncScheduler = {
  /** Runs a pass now, or right after the one in flight finishes. */
  trigger: () => void
  stop: () => void
}

/**
 * Runs account sync passes one at a time: immediately, on `trigger()`
 * (login, focus, network back, installs) and on a timer that slows down
 * while the window is hidden. A trigger during a pass queues one more pass.
 */
export function startLibrarySync({
  run,
  onStart,
  onResult,
  isVisible,
  foregroundMs = LIBRARY_SYNC_FOREGROUND_MS,
  backgroundMs = LIBRARY_SYNC_BACKGROUND_MS,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer),
}: LibrarySyncSchedulerOptions): LibrarySyncScheduler {
  let stopped = false
  let running = false
  let queued = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const schedule = (): void => {
    if (stopped) return
    if (timer !== undefined) clearTimer(timer)
    timer = setTimer(() => { void pass() }, isVisible() ? foregroundMs : backgroundMs)
  }

  const pass = async (): Promise<void> => {
    if (stopped) return
    if (running) {
      queued = true
      return
    }
    running = true
    if (timer !== undefined) {
      clearTimer(timer)
      timer = undefined
    }
    onStart?.()
    try {
      const report = await run()
      if (!stopped) await onResult({ report, followUp: queued })
    } catch (error: unknown) {
      if (!stopped) await onResult({ error: error instanceof Error ? error.message : String(error), followUp: queued })
    } finally {
      running = false
    }
    if (stopped) return
    if (queued) {
      queued = false
      void pass()
      return
    }
    schedule()
  }

  void pass()
  return {
    trigger: () => { void pass() },
    stop: () => {
      stopped = true
      if (timer !== undefined) clearTimer(timer)
    },
  }
}

/** A routine pass shorter than this keeps the previous indicator, so idle checks never blink. */
export const LIBRARY_SYNC_SLOW_MS = 300

/** What the title indicator knows; owned by the root scheduler for the signed-in account. */
export type LibrarySyncState = {
  enabled: boolean
  running: boolean
  /** The running pass passed LIBRARY_SYNC_SLOW_MS. */
  slow: boolean
  /** Local files changed after the last pass settled. */
  dirty: boolean
  /** Library fingerprint read right after the last pass; SkillHub's own writes match it. */
  baseline: string | null
  last:
    | null
    | { ok: true; problems: number }
    | { ok: false; offline: boolean }
  /** Local status read after the last pass; null when it failed or belonged to another account. */
  status: { blocked: number; pendingCopies: number } | null
}

export const INITIAL_LIBRARY_SYNC_STATE: LibrarySyncState = {
  enabled: false, running: false, slow: false, dirty: false, baseline: null, last: null, status: null,
}

export type LibrarySyncEvent =
  | { type: 'enabled' }
  | { type: 'disabled' }
  | { type: 'start' }
  | { type: 'slow' }
  | {
    type: 'result'
    report?: LibrarySyncReport
    error?: string
    offline: boolean
    followUp: boolean
    status: LibrarySyncStatus | null
    baseline: string | null
  }
  | { type: 'local-change'; fingerprint: string }

export function reduceLibrarySync(state: LibrarySyncState, event: LibrarySyncEvent): LibrarySyncState {
  switch (event.type) {
    case 'enabled':
      return state.enabled ? state : { ...INITIAL_LIBRARY_SYNC_STATE, enabled: true }
    case 'disabled':
      return INITIAL_LIBRARY_SYNC_STATE
    case 'start':
      // The pass reads the library as it is now, so earlier edits are covered.
      return state.enabled ? { ...state, running: true, slow: state.running && state.slow, dirty: false } : state
    case 'slow':
      return state.enabled && state.running ? { ...state, slow: true } : state
    case 'result': {
      if (!state.enabled) return state
      const last: LibrarySyncState['last'] = event.report
        ? { ok: true, problems: event.report.problems.length }
        : { ok: false, offline: event.offline }
      const status = event.status
        ? { blocked: event.status.blocked.length, pendingCopies: event.status.pendingCopies }
        : null
      // A queued pass starts at once: stay "running" so ✅ never flashes in between.
      return { ...state, running: event.followUp, slow: event.followUp && state.slow, last, status, baseline: event.baseline }
    }
    case 'local-change':
      if (!state.enabled || state.running || event.fingerprint === state.baseline) return state
      return { ...state, dirty: true }
  }
}

export type LibrarySyncIndicator =
  | { kind: 'hidden' }
  | { kind: 'checking' }
  | { kind: 'syncing' }
  | { kind: 'synced' }
  | { kind: 'pending' }
  | { kind: 'offline' }
  | { kind: 'attention'; count: number }

/**
 * ✅ only for a successful pass of this account with nothing pending or
 * blocked. Skills kept on this device are a settled state, not a problem.
 */
export function librarySyncIndicator(state: LibrarySyncState): LibrarySyncIndicator {
  if (!state.enabled) return { kind: 'hidden' }
  if (state.running && state.slow) return { kind: 'syncing' }
  if (state.dirty) return { kind: 'pending' }
  const { last, status } = state
  if (!last) return { kind: 'checking' }
  if (!last.ok) return last.offline ? { kind: 'offline' } : { kind: 'attention', count: 0 }
  if (!status) return { kind: 'checking' }
  const count = last.problems + status.blocked + status.pendingCopies
  return count > 0 ? { kind: 'attention', count } : { kind: 'synced' }
}

/** One account entry with this device's view of it (`library_list_entries`). */
export type LibraryEntrySummary = {
  versionPolicy?: number
  version?: { receiptId: string; label: string; cardSha256: string; formalVersionId: string | null; formalLabel: string | null } | null
  entryId: string
  name: string
  displayName: string
  revision: number
  deleted: boolean
  /** Managed folder on this device bound to the entry; null until it is downloaded. */
  localSkillId: string | null
  /** `sourceUrl` (#330) is absent when the entry has none or the Server predates it. */
  profile?: { displayName: string; description?: string; sourceUrl?: string | null; category?: string; labels: string[]; compatibleAgents: string[] }
  sourceKind?: 'local' | 'marketplace' | 'team'
  serverSkillId?: string | null
}

export type LibraryEntryList = { space?: { spaceId: string; generation: number }; userId: string; entries: LibraryEntrySummary[] }

export type LibraryTransfer = {
  space?: { spaceId: string; generation: number }
  userId: string
  entryId: string
  revision: number
  received: number
  total: number | null
  phase: 'downloading' | 'landing' | 'ready' | 'error'
  error: string | null
}

/** 100% means verified files have landed, rather than merely arriving over HTTP. */
export function libraryTransferFraction(transfer?: LibraryTransfer): number | null {
  if (transfer?.phase === 'ready') return 1
  if (transfer?.phase === 'landing') return 0.95
  if (!transfer?.total || transfer.total <= 0) return null
  return Math.max(0, Math.min(0.9, transfer.received / transfer.total * 0.9))
}

/**
 * Entries every device downloads automatically but this one has not yet
 * (pending or failed, with the reason from the last pass), and the account
 * recycle bin. Entries already here are listed by the page itself.
 */
export function groupLibraryEntries(entries: readonly LibraryEntrySummary[]): {
  notDownloaded: LibraryEntrySummary[]
  recycled: LibraryEntrySummary[]
} {
  return {
    notDownloaded: entries.filter((entry) => !entry.deleted && !entry.localSkillId),
    recycled: entries.filter((entry) => entry.deleted),
  }
}

/**
 * What "删除…" does for one managed Skill (#91). A Skill in the signed-in
 * account's library is only deleted from the account (every device, account
 * recycle bin): a device-only delete would be downloaded again. Any other
 * Skill goes to this computer's recycle bin.
 */
export type DeleteScopeDecision =
  | { kind: 'account'; available: true }
  | { kind: 'account'; available: false; reason: string }
  | { kind: 'device'; note: string }

/** The folder belongs to this signed-in account's synced library. */
export function syncedToAccount(
  skill: { libraryAccountId?: string | null; libraryEntryId?: string | null },
  signedInUserId: string | null | undefined,
): boolean {
  return Boolean(signedInUserId && skill.libraryEntryId && skill.libraryAccountId === signedInUserId)
}

export function deleteScopeFor(input: {
  signedInUserId: string | null | undefined
  syncEnabled: boolean
  online: boolean
  skill: { libraryAccountId?: string | null; libraryEntryId?: string | null }
}): DeleteScopeDecision {
  const { libraryAccountId, libraryEntryId } = input.skill
  const synced = Boolean(libraryAccountId && libraryEntryId)
  if (syncedToAccount(input.skill, input.signedInUserId)) {
    if (!input.syncEnabled) return { kind: 'account', available: false, reason: '当前服务暂未开启账号同步，暂时不能删除这个 Skill' }
    if (!input.online) return { kind: 'account', available: false, reason: '需要联网才能从账号删除' }
    return { kind: 'account', available: true }
  }
  if (synced) {
    return { kind: 'device', note: '移入本机回收站，可以恢复。它仍在所属账号的同步库中，该账号之后在这台电脑上同步时会重新下载。' }
  }
  return { kind: 'device', note: '移入本机回收站，可以恢复。这个 Skill 不在账号中，其他设备不受影响。' }
}

/**
 * Result of "从我的账号删除" (`library_delete_from_account`). The command
 * rejects only before the account was contacted, so a rejection says nothing
 * about an earlier attempt and never means "unchanged".
 */
export type AccountDeleteOutcome = {
  /**
   * `kept`: a read after the attempt shows the entry still in the account.
   * `unconfirmed`: the delete may have reached the Server (now or on an
   * earlier attempt) but no read could confirm either way.
   */
  account: 'deleted' | 'kept' | 'unconfirmed'
  accountMessage: string | null
  localCleaned: boolean
  localError: string | null
}

/**
 * What to tell the user after "从我的账号删除" resolved. Each side is stated
 * as it is: deleted, not yet confirmed, or done on the account but still
 * pending on this computer, with how it recovers.
 */
export function accountDeleteResult(displayName: string, outcome: AccountDeleteOutcome): {
  kind: 'done' | 'local-pending' | 'kept' | 'unconfirmed'
  message: string
} {
  if (outcome.account === 'kept') {
    const reason = outcome.accountMessage ? `：${outcome.accountMessage}` : ''
    return { kind: 'kept', message: `没有从账号删除，账号中仍保留「${displayName}」${reason}` }
  }
  if (outcome.account === 'unconfirmed') {
    const reason = outcome.accountMessage ? `（${outcome.accountMessage}）` : ''
    return {
      kind: 'unconfirmed',
      message: `「${displayName}」的账号删除结果暂无法确认${reason}。这台电脑上的副本和同步记录都已保留；联网后同步会自动确认，也可以稍后再次点「删除」`,
    }
  }
  if (outcome.localCleaned) {
    return { kind: 'done', message: `「${displayName}」已从账号删除，其他设备会移入回收站；可在账号回收站恢复` }
  }
  const reason = outcome.localError ? `（${outcome.localError}）` : ''
  return {
    kind: 'local-pending',
    message: `「${displayName}」已从账号删除，其他设备会移入回收站；这台电脑上的副本还没移入回收站${reason}。下次同步会自动处理，也可以再次点「删除」重试`,
  }
}
