export type LibraryWatchOptions = {
  readFingerprint: () => Promise<string>
  onChange: () => Promise<void>
  isVisible: () => boolean
  intervalMs?: number
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export const LIBRARY_WATCH_INTERVAL_MS = 2_500

/**
 * Polls the native Skill-library fingerprint while the window is visible and
 * reloads only when it changes. The baseline is re-read after each reload, so
 * files SkillHub itself writes while reconciling never trigger a second
 * reload. Returns a stop function.
 */
export function startLibraryWatch({
  readFingerprint,
  onChange,
  isVisible,
  intervalMs = LIBRARY_WATCH_INTERVAL_MS,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer),
}: LibraryWatchOptions): () => void {
  let baseline: string | null = null
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async (): Promise<void> => {
    try {
      if (isVisible()) {
        const next = await readFingerprint()
        if (stopped) return
        if (baseline !== null && next !== baseline) {
          await onChange()
          if (stopped) return
          baseline = await readFingerprint()
        } else {
          baseline = next
        }
      }
    } catch {
      // A failed check waits for the next tick; focus refresh still applies.
    }
    if (!stopped) timer = setTimer(() => { void tick() }, intervalMs)
  }

  void tick()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimer(timer)
  }
}
