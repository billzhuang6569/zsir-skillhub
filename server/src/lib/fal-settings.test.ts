import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ write: vi.fn(), source: vi.fn().mockReturnValue('none') }))
vi.mock('../config.js', () => ({ config: {} }))
vi.mock('../db.js', () => ({ db: {} }))
vi.mock('./avatar-jobs.js', () => ({ resolveAccountAvatarStyle: async (): Promise<object> => ({ style: { fal: { meta: { model: 'fal-ai/nano-banana-2' } } } }) }))
vi.mock('./server-settings.js', () => ({ writeServerSetting: mock.write, effectiveSource: mock.source }))
import { saveFalDraft, testFalDraft } from './fal-settings.js'

const key = 'mock-fal-secret-123456789'
beforeEach(() => { vi.clearAllMocks(); mock.source.mockReturnValue('none') })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it.each([401, 403, 404, 200, 302, 429, 500])('maps status %s without reading provider details into errors', async status => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('sensitive upstream detail', { status })))
  if (status === 404) expect(await testFalDraft(key, 'admin')).toMatchObject({ ok: true, draftToken: expect.any(String), latencyMs: expect.any(Number) })
  else await expect(testFalDraft(key, 'admin')).rejects.toMatchObject({ code: [401, 403].includes(status) ? 'FAL_KEY_INVALID' : 'FAL_UNREACHABLE', statusCode: [401, 403].includes(status) ? 400 : 502 })
  expect(mock.write).not.toHaveBeenCalled()
})

it('enforces a ten-second abort and rejects redirect/network failures', async () => {
  vi.useFakeTimers()
  const signal = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    setTimeout(() => signal.abort(), ms)
    return signal.signal
  })
  vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(new Error('secret timeout detail')), { once: true })
  })))
  const rejected = expect(testFalDraft(key, 'admin')).rejects.toMatchObject({ code: 'FAL_UNREACHABLE', statusCode: 502 })
  await vi.advanceTimersByTimeAsync(10_000)
  await rejected
  expect(timeout).toHaveBeenCalledWith(10_000)
  timeout.mockRestore()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('redirect or network with secret')))
  await expect(testFalDraft(key, 'admin')).rejects.toThrow('FAL_UNREACHABLE')
})

it('bounds streamed responses to 64 KiB and cancels the reader', async () => {
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({ start(controller): void {
    controller.enqueue(new Uint8Array(65536)); controller.enqueue(new Uint8Array(1))
  }, cancel })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 404 })))
  await expect(testFalDraft(key, 'admin')).rejects.toMatchObject({ code: 'FAL_UNREACHABLE' })
  expect(cancel).toHaveBeenCalledOnce()
})

it('binds receipts to key and admin, expires them, and consumes before concurrent saves', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (): Promise<Response> => new Response('', { status: 404 })))
  const { draftToken } = await testFalDraft(key, 'admin')
  await expect(saveFalDraft(`${key}changed`, draftToken, 'admin')).rejects.toMatchObject({ code: 'TEST_REQUIRED' })
  await expect(saveFalDraft(key, draftToken, 'other')).rejects.toMatchObject({ code: 'TEST_REQUIRED' })
  const saves = await Promise.allSettled([saveFalDraft(key, draftToken, 'admin'), saveFalDraft(key, draftToken, 'admin')])
  expect(saves.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  expect(mock.write).toHaveBeenCalledOnce()
  const expired = await testFalDraft(key, 'admin')
  await vi.advanceTimersByTimeAsync(600_000)
  await expect(saveFalDraft(key, expired.draftToken, 'admin')).rejects.toMatchObject({ code: 'TEST_REQUIRED' })
  const failed = await testFalDraft(key, 'admin')
  mock.write.mockRejectedValueOnce(new Error('db failure'))
  await expect(saveFalDraft(key, failed.draftToken, 'admin')).rejects.toThrow('db failure')
  await expect(saveFalDraft(key, failed.draftToken, 'admin')).rejects.toMatchObject({ code: 'TEST_REQUIRED' })
})
