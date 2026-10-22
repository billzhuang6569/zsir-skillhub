import { describe, expect, it } from 'vitest'
import { AiRequestGuardError, createAiRequestGuard } from './ai-request-guard.js'

describe('AI request guard', () => {
  it('enforces the per-key minute limit', async () => {
    const guard = createAiRequestGuard({
      perMinute: 1,
      globalDaily: 10,
      maxConcurrent: 2,
      now: () => 1_000,
    })

    await expect(guard.run('user:ip', async () => 'ok')).resolves.toBe('ok')
    await expect(guard.run('user:ip', async () => 'blocked')).rejects.toBeInstanceOf(
      AiRequestGuardError
    )
  })

  it('releases the concurrency slot after a request fails', async () => {
    const guard = createAiRequestGuard({
      perMinute: 10,
      globalDaily: 10,
      maxConcurrent: 1,
      now: () => 1_000,
    })
    const failure = new Error('provider failed')

    await expect(guard.run('first', async () => Promise.reject(failure))).rejects.toBe(failure)
    await expect(guard.run('second', async () => 'ok')).resolves.toBe('ok')
  })

  it('blocks concurrent work above the configured ceiling', async () => {
    const guard = createAiRequestGuard({
      perMinute: 10,
      globalDaily: 10,
      maxConcurrent: 1,
      now: () => 1_000,
    })
    let release: (() => void) | undefined
    const pending = guard.run(
      'first',
      () => new Promise<void>((resolve) => { release = resolve })
    )

    await expect(guard.run('second', async () => 'blocked')).rejects.toBeInstanceOf(
      AiRequestGuardError
    )
    expect(release).toBeTypeOf('function')
    release?.()
    await pending
  })
})
