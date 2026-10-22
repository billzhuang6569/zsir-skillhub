import { describe, expect, it } from 'vitest'
import { AiRequestGuardError, createAiRequestGuard } from './ai-request-guard.js'

describe('AI request guard names the limit that refused', () => {
  it('distinguishes the per-key minute window, the shared daily quota and the concurrency cap', async () => {
    let clock = 1_000_000
    const guard = createAiRequestGuard({ perMinute: 1, globalDaily: 2, maxConcurrent: 1, now: () => clock })
    await guard.run('a', async () => 'ok')
    await expect(guard.run('a', async () => 'ok')).rejects.toMatchObject({ reason: 'per_minute', retryAfterSeconds: 60 })
    clock += 30_000
    await expect(guard.run('a', async () => 'ok')).rejects.toMatchObject({ reason: 'per_minute', retryAfterSeconds: 30 })
    // A different key has its own minute window but shares the daily quota.
    await guard.run('b', async () => 'ok')
    const daily = await guard.run('c', async () => 'ok').catch((error: unknown) => error)
    expect(daily).toBeInstanceOf(AiRequestGuardError)
    expect(daily).toMatchObject({ reason: 'daily' })
    expect((daily as AiRequestGuardError).retryAfterSeconds).toBeGreaterThan(86_000)
    // Concurrency: hold one request and refuse the next with its own reason.
    const relaxed = createAiRequestGuard({ perMinute: 10, globalDaily: 10, maxConcurrent: 1, now: () => clock })
    let release!: () => void
    const held = relaxed.run('x', () => new Promise<void>(resolve => { release = resolve }))
    await expect(relaxed.run('y', async () => 'ok')).rejects.toMatchObject({ reason: 'concurrency', retryAfterSeconds: 5 })
    release(); await held
    await expect(relaxed.run('y', async () => 'ok')).resolves.toBe('ok')
  })
})
