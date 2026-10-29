/**
 * Collapses overlapping refresh requests for one data set into at most one
 * running read plus one follow-up. Mount, window focus, library events and
 * directory-fingerprint changes all ask for the same list; while a read is in
 * flight, any number of further asks are remembered as a single pending run,
 * which starts when the current one finishes. Nothing is dropped (a real
 * change during a read is still picked up once) and nothing is duplicated.
 *
 * `request()` resolves when the caller's refresh has actually happened, i.e.
 * after the pending run when one was queued. A loud (non-silent) ask queued
 * behind a silent run keeps its loudness so the loading state is shown once.
 */
export type RefreshCoalescer = {
  request(silent?: boolean): Promise<void>
  /** Drops a queued follow-up (e.g. on unmount or account switch). */
  cancel(): void
  invalidate(): void
  readonly running: boolean
  readonly queued: boolean
}

// Only timestamps survive a page remount; display/permissions live in the identity-scoped store.
const lastRefreshByScope = new Map<string, number>()

export function createRefreshCoalescer(run: (silent: boolean) => Promise<void>, minimumInterval = 0, scope?: string): RefreshCoalescer {
  let chain: Promise<void> | null = null
  let pending: boolean | null = null
  let lastStarted = Number.NEGATIVE_INFINITY

  const loop = async (first: boolean): Promise<void> => {
    let next: boolean | null = first
    while (next !== null) {
      const silent = next
      next = null
      pending = null
      lastStarted = Date.now()
      if (scope) lastRefreshByScope.set(scope, lastStarted)
      try {
        await run(silent)
      } catch {
        // The run reports its own errors to the UI; the coalescer only sequences.
      }
      if (pending !== null) next = pending
    }
    chain = null
  }

  return {
    request(silent = false): Promise<void> {
      if (silent && Date.now() - (scope ? lastRefreshByScope.get(scope) ?? lastStarted : lastStarted) < minimumInterval) return chain ?? Promise.resolve()
      if (chain) {
        pending = pending === null ? silent : pending && silent
        return chain
      }
      chain = loop(silent)
      return chain
    },
    cancel(): void {
      pending = null
    },
    invalidate(): void { lastStarted = Number.NEGATIVE_INFINITY; if (scope) lastRefreshByScope.delete(scope) },
    get running(): boolean {
      return chain !== null
    },
    get queued(): boolean {
      return pending !== null
    },
  }
}
