import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startStartupRetry } from './startup-retry.js'

describe('background startup retry', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('fails twice, retries with exponential backoff, and stops after success', async (): Promise<void> => {
    const load = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(undefined)
    const logger = { warn: vi.fn() }
    const stop = startStartupRetry('server-settings', load, logger)
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(3)
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(logger.warn.mock.calls.map(([metadata]) => metadata.retryInMs)).toEqual([1_000, 2_000])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(load).toHaveBeenCalledTimes(3)
    stop()
  })

  it.each(['server-settings', 'instance-identity', 'setup-code'] as const)('%s caps retries at 60 seconds and logs every failure safely', async (task): Promise<void> => {
    const secret = 'private-api-key-do-not-log'
    const failure = Object.assign(new Error(secret), { secret })
    const logger = { warn: vi.fn() }
    const load = vi.fn<() => Promise<void>>().mockRejectedValue(failure)
    const stop = startStartupRetry(task, load, logger)
    await vi.advanceTimersByTimeAsync(0)
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(delay)
    }
    expect(logger.warn.mock.calls).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000].map(retryInMs => [
      { task, retryInMs }, 'Instance initialization unavailable; retrying in background',
    ]))
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secret)
    load.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(vi.getTimerCount()).toBe(0)
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a scheduled retry when the server closes', async (): Promise<void> => {
    const app = Fastify()
    const load = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('unavailable'))
    const stop = startStartupRetry('setup-code', load, { warn: vi.fn() })
    app.addHook('onClose', async (): Promise<void> => { stop() })
    await app.ready()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    await app.close()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not schedule or log a late failure after close', async (): Promise<void> => {
    let rejectLoad!: (error: Error) => void
    const load = vi.fn((): Promise<void> => new Promise((_resolve, reject) => { rejectLoad = reject }))
    const logger = { warn: vi.fn() }
    const app = Fastify()
    const stop = startStartupRetry('server-settings', load, logger)
    app.addHook('onClose', async (): Promise<void> => { stop() })
    await app.ready()
    await app.close()
    rejectLoad(new Error('late private failure'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(load).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
