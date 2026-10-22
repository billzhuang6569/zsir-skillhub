import { describe, expect, it } from 'vitest'
import { AiRequestGuardError, createAiRequestGuard } from './ai-request-guard.js'

/** #238: background AI work (avatar prompts) never takes the last slot or the users' share of the day. */
type Held = { done: Promise<string>; release: () => void }
function hold(guard: ReturnType<typeof createAiRequestGuard>, key: string, priority: 'user' | 'background'): Held {
  let release = (): void => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  return { done: guard.run(key, async () => { await gate; return key }, priority), release }
}
const busy = expect.objectContaining({ reason: 'concurrency', retryAfterSeconds: 5 })

describe('AI guard priorities', () => {
  it('maxConcurrent 2: one background request blocks a second background request but admits a user request', async () => {
    const guard = createAiRequestGuard({ perMinute: 100, globalDaily: 100, maxConcurrent: 2, now: () => 1_000 })
    const avatar = hold(guard, 'avatar:a', 'background')
    await expect(guard.run('avatar:b', async () => 'second', 'background')).rejects.toEqual(busy)
    await expect(guard.run('import:user', async () => 'analysis')).resolves.toBe('analysis')
    // While the user request runs too, the guard is full for everyone (total stays bounded).
    const user = hold(guard, 'import:held', 'user')
    await expect(guard.run('import:third', async () => 'x')).rejects.toBeInstanceOf(AiRequestGuardError)
    avatar.release(); user.release()
    await Promise.all([avatar.done, user.done])
  })

  it('a user request is admitted while background holds maxConcurrent - 1 slots, and background can never fill the rest', async () => {
    const guard = createAiRequestGuard({ perMinute: 100, globalDaily: 100, maxConcurrent: 4, now: () => 1_000 })
    const background = [hold(guard, 'avatar:1', 'background'), hold(guard, 'avatar:2', 'background'), hold(guard, 'avatar:3', 'background')]
    await expect(guard.run('avatar:4', async () => 'x', 'background')).rejects.toEqual(busy)
    const user = hold(guard, 'topic:u', 'user')
    await expect(guard.run('import:v', async () => 'x', 'user')).rejects.toEqual(busy)
    for (const held of [...background, user]) held.release()
    await Promise.all([...background, user].map(held => held.done))
  })

  it('maxConcurrent 1: background never runs, so the only slot is always free for a user', async () => {
    const guard = createAiRequestGuard({ perMinute: 100, globalDaily: 100, maxConcurrent: 1, now: () => 1_000 })
    await expect(guard.run('avatar:a', async () => 'x', 'background')).rejects.toEqual(busy)
    await expect(guard.run('import:user', async () => 'analysis', 'user')).resolves.toBe('analysis')
  })

  it('background uses at most half of the daily quota; users can still use the rest, and the day resets both', async () => {
    let clock = 1_000
    const guard = createAiRequestGuard({ perMinute: 100, globalDaily: 6, maxConcurrent: 4, now: () => clock })
    for (let index = 0; index < 3; index += 1) await guard.run(`avatar:${index}`, async () => 'x', 'background')
    await expect(guard.run('avatar:3', async () => 'x', 'background')).rejects.toEqual(expect.objectContaining({ reason: 'daily' }))
    for (let index = 0; index < 3; index += 1) await expect(guard.run(`import:${index}`, async () => 'ok', 'user')).resolves.toBe('ok')
    await expect(guard.run('import:over', async () => 'x', 'user')).rejects.toEqual(expect.objectContaining({ reason: 'daily' }))
    clock += 86_400_000
    await expect(guard.run('avatar:next-day', async () => 'x', 'background')).resolves.toBe('x')
  })

  it('callers that do not say otherwise are users, with the same 429 semantics as before', async () => {
    const guard = createAiRequestGuard({ perMinute: 100, globalDaily: 100, maxConcurrent: 1, now: () => 1_000 })
    const held = hold(guard, 'import:a', 'user')
    const refused = await guard.run('import:b', async () => 'x').catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(AiRequestGuardError)
    expect(refused).toMatchObject({ reason: 'concurrency', retryAfterSeconds: 5, message: 'AI analysis is busy' })
    held.release(); await held.done
  })
})
