import { serverFixture } from './helpers/server-ipc.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, apiGetSkillAvatars } from '../src/lib/api.ts'
import { userMessage } from '../src/lib/user-message.ts'

async function failureFor(response: Response | Error): Promise<unknown> {
  const original = serverFixture.fetch
  serverFixture.fetch = (() => response instanceof Error ? Promise.reject(response) : Promise.resolve(response)) as typeof fetch
  try {
    await apiGetSkillAvatars(serverFixture.space, new AbortController().signal)
  } catch (error: unknown) {
    return error
  } finally { serverFixture.fetch = original }
  throw new Error('expected a failure')
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

test('the gateway rate limit reads as "too frequent" with its Retry-After, not as a network failure', async () => {
  const error = await failureFor(json(429, { error: '请求过于频繁，请稍后再试', code: 'GATEWAY_RATE_LIMITED' }, { 'Retry-After': '2' }))
  assert.ok(error instanceof ApiError)
  assert.equal(userMessage(error), '请求过于频繁，请 2 秒后再试')
})

test('the gateway connection limit reads as "busy"; plain 503/502/504 status lines are translated', async () => {
  assert.equal(userMessage(await failureFor(json(503, { error: '服务暂时繁忙，请稍后再试', code: 'GATEWAY_BUSY' }))), '服务暂时繁忙，请稍后再试')
  assert.equal(userMessage(await failureFor(new Response('<html>503</html>', { status: 503, statusText: 'Service Unavailable' }))), '服务暂时繁忙，请稍后再试')
  assert.equal(userMessage(await failureFor(new Response('', { status: 502, statusText: 'Bad Gateway' }))), '暂时无法连接服务，请稍后再试')
})

test('readable Server messages for 429/503 stay as written (e.g. avatar quota or disabled service)', async () => {
  assert.equal(userMessage(await failureFor(json(429, { error: '头像生成额度已达上限，请稍后重试', code: 'AVATAR_DAILY_QUOTA' }, { 'Retry-After': '3600' }))), '头像生成额度已达上限，请稍后重试')
  assert.equal(userMessage(await failureFor(json(503, { error: '头像生成暂未开启', code: 'AVATAR_GENERATION_DISABLED' }))), '头像生成暂未开启')
  // An English default without a code is still translated.
  assert.equal(userMessage(await failureFor(json(429, { error: 'Too many package downloads. Try again later.' }))), '请求过于频繁，请稍后再试')
})

test('real offline, an opaque WebView failure and timeouts keep their own wording; 401 stays a login problem', async () => {
  assert.equal(userMessage(await failureFor(new TypeError('Load failed'))), '连接失败，请检查网络后重试')
  assert.equal(userMessage(new ApiError('timeout', 'Request timed out')), '请求超时，请稍后重试')
  assert.equal(userMessage(new ApiError('http', 'Unauthorized', { status: 401 })), '登录已过期，请重新登录')
  assert.equal(userMessage(new Error('Load failed')), '连接失败，请检查网络后重试')
})
