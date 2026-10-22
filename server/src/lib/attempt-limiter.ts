type Attempt = { count: number; resetAt: number }

type AttemptLimiterOptions = {
  maxKeys?: number
  cleanupIntervalMs?: number
  now?: () => number
}

export class AttemptLimiter {
  private readonly attempts = new Map<string, Attempt>()
  private readonly maxKeys: number
  private readonly cleanupIntervalMs: number
  private readonly now: () => number
  private lastCleanupAt = 0

  constructor(options: AttemptLimiterOptions = {}) {
    this.maxKeys = options.maxKeys ?? 10_000
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000
    this.now = options.now ?? Date.now
  }

  consume(key: string, limit: number, windowMs: number): number | null {
    const now = this.now()
    this.cleanupExpired(now, now - this.lastCleanupAt >= this.cleanupIntervalMs)
    const current = this.attempts.get(key)
    if (!current || current.resetAt <= now) {
      if (current) this.attempts.delete(key)
      if (this.attempts.size >= this.maxKeys) {
        this.cleanupExpired(now, true)
        if (this.attempts.size >= this.maxKeys) return 60
      }
      this.attempts.set(key, { count: 1, resetAt: now + windowMs })
      return null
    }
    if (current.count >= limit) return Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    current.count += 1
    return null
  }

  clear(key: string): void {
    this.attempts.delete(key)
  }

  get entryCount(): number {
    return this.attempts.size
  }

  private cleanupExpired(now: number, shouldRun: boolean): void {
    if (!shouldRun) return
    for (const [key, attempt] of this.attempts) {
      if (attempt.resetAt <= now) this.attempts.delete(key)
    }
    this.lastCleanupAt = now
  }
}
