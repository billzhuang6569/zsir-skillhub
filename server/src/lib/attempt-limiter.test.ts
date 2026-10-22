import { describe, expect, it } from 'vitest'
import { AttemptLimiter } from './attempt-limiter.js'

describe('AttemptLimiter', () => {
  it('enforces a hard key capacity and admits new keys after expiry cleanup', () => {
    let now = 1
    const limiter = new AttemptLimiter({ maxKeys: 2, cleanupIntervalMs: 100, now: () => now })

    expect(limiter.consume('first', 3, 1_000)).toBeNull()
    expect(limiter.consume('second', 3, 1_000)).toBeNull()
    expect(limiter.entryCount).toBe(2)
    expect(limiter.consume('third', 3, 1_000)).toBe(60)
    expect(limiter.entryCount).toBe(2)

    now = 1_002
    expect(limiter.consume('third', 3, 1_000)).toBeNull()
    expect(limiter.entryCount).toBe(1)
  })

  it('clears a successful account key without clearing unrelated protection', () => {
    const limiter = new AttemptLimiter({ now: () => 1 })
    expect(limiter.consume('account', 1, 1_000)).toBeNull()
    expect(limiter.consume('ip', 10, 1_000)).toBeNull()

    limiter.clear('account')

    expect(limiter.consume('account', 1, 1_000)).toBeNull()
    expect(limiter.entryCount).toBe(2)
  })
})
