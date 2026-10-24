import type { AiBudget, AiReservation } from '../lib/ai-budget.js'

type AiRequestGuardOptions = {
  perMinute: number
  globalDaily: number
  maxConcurrent: number
  /** Share of `globalDaily` background work may use (default 0.5); the rest is kept for user requests. */
  backgroundDailyShare?: number
  now?: () => number
  budget?: () => AiBudget | undefined
}

type UsageWindow = {
  startedAt: number
  count: number
}

/** Which limit refused the request: the per-key minute window, the shared 24 h quota, or the process-wide concurrency cap. */
export type AiRequestGuardReason = 'per_minute' | 'daily' | 'user_daily' | 'concurrency'

/**
 * Who is asking (#238). `user`: a person is waiting (Skill import analysis, topic AI
 * drafting) and may use every slot. `background`: work that can wait (avatar drawing
 * prompts) and must always leave room for users.
 */
export type AiRequestPriority = 'user' | 'background'

export class AiRequestGuardError extends Error {
  get code(): string {
    return this.reason === 'daily' ? 'AI_INSTANCE_DAILY_LIMIT' : this.reason === 'user_daily' ? 'AI_USER_DAILY_LIMIT'
      : this.reason === 'concurrency' ? 'AI_BUSY' : 'AI_RATE_LIMIT'
  }
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
    readonly reason: AiRequestGuardReason = 'per_minute'
  ) {
    super(message)
    this.name = 'AiRequestGuardError'
  }
}

/** Default share of the daily quota background work may use. */
export const AI_BACKGROUND_DAILY_SHARE = 0.5

/**
 * One guard for every AI caller, so the total never exceeds `maxConcurrent` / `globalDaily`.
 * Background requests are admitted only while at least one slot stays free after them
 * (`active < maxConcurrent - 1`); with `maxConcurrent = 1` background work never runs, so a
 * user can always get the only slot. Background work may also use at most
 * `backgroundDailyShare` of the daily quota; users can use all of it. A refusal is an
 * `AiRequestGuardError` with a Retry-After, for users exactly as before.
 */
export function createAiRequestGuard(options: AiRequestGuardOptions) {
  const minuteMs = 60_000
  const dayMs = 86_400_000
  const usageByKey = new Map<string, UsageWindow>()
  const now = options.now ?? Date.now
  const backgroundDaily = Math.floor(options.globalDaily * (options.backgroundDailyShare ?? AI_BACKGROUND_DAILY_SHARE))
  let dailyUsage: UsageWindow = { startedAt: now(), count: 0 }
  let backgroundUsage = 0
  let activeRequests = 0

  function currentWindow(
    existing: UsageWindow | undefined,
    timestamp: number,
    durationMs: number
  ): UsageWindow {
    if (!existing || timestamp - existing.startedAt >= durationMs) {
      return { startedAt: timestamp, count: 0 }
    }
    return existing
  }

  async function run<T>(key: string, task: () => Promise<T>, priority: AiRequestPriority = 'user', reservation?: AiReservation): Promise<T> {
    const timestamp = now()
    const usage = currentWindow(usageByKey.get(key), timestamp, minuteMs)
    const day = currentWindow(dailyUsage, timestamp, dayMs)
    if (day !== dailyUsage) { dailyUsage = day; backgroundUsage = 0 }
    const background = priority === 'background'

    if (usage.count >= options.perMinute) {
      const remainingMs = Math.max(1_000, minuteMs - (timestamp - usage.startedAt))
      throw new AiRequestGuardError(
        'AI analysis rate limit exceeded',
        Math.ceil(remainingMs / 1_000),
        'per_minute'
      )
    }
    const budget = options.budget?.()
    if (!budget && (dailyUsage.count >= options.globalDaily || (background && backgroundUsage >= backgroundDaily))) {
      const remainingMs = Math.max(1_000, dayMs - (timestamp - dailyUsage.startedAt))
      throw new AiRequestGuardError(
        'AI analysis daily quota exhausted',
        Math.ceil(remainingMs / 1_000),
        'daily'
      )
    }
    if (activeRequests >= (background ? options.maxConcurrent - 1 : options.maxConcurrent)) {
      throw new AiRequestGuardError('AI analysis is busy', 5, 'concurrency')
    }

    usage.count += 1
    dailyUsage.count += 1
    if (background) backgroundUsage += 1
    usageByKey.set(key, usage)
    activeRequests += 1

    try {
      if (budget) {
        const userId = key.startsWith('avatar:') || key.startsWith('topic:') ? key.split(':')[1] : key.split(':')[0]
        const day = new Date(timestamp).toISOString().slice(0, 10)
        if (reservation && !background) {
          if (reservation.day !== day || reservation.userId !== userId || reservation.remaining < 1) {
            throw new AiRequestGuardError('AI reservation expired', 1, 'daily')
          }
          reservation.remaining -= 1
        } else {
          const allocated = await budget.reserve(userId, 1, priority)
          if (!allocated.remaining) {
            const available = background ? { instance: 0 } : await budget.available(userId)
            throw new AiRequestGuardError('AI daily quota exhausted', Math.ceil((Date.parse(`${day}T00:00:00Z`) + dayMs - timestamp) / 1000), available.instance === 0 ? 'daily' : 'user_daily')
          }
        }
      }
      return await task()
    } finally {
      activeRequests -= 1
    }
  }

  return { run }
}
