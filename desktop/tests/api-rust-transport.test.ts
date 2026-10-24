import assert from 'node:assert/strict'
import test, { beforeEach, afterEach } from 'node:test'
import {
  ApiError, apiGetMe, apiLogout, apiHealth, apiGetSkill, apiGetTeams, apiGetMarketplace,
  apiDeleteSkill, apiDownloadSkillPackage, apiDownloadMarketplacePackage, apiLogin, apiChangePassword,
  apiGetSkillAvatars, onApiUnauthorized, apiAnalyzeSkill, apiGetInstanceBaseUrls,
} from '../src/lib/api.ts'
import { readFileSync } from 'node:fs'
import type { ServerRequest, ServerResponse } from '../src/lib/tauri.ts'

let originalWindow: PropertyDescriptor | undefined
let generation = 1
let signedIn = true
let clears = 0
const space = { spaceId: 'official', generation: 1 }
let calls: ServerRequest[] = []
let cancelled: unknown[] = []
let respond: (request: ServerRequest) => Promise<ServerResponse>
const json = (status: number, value: unknown, headers = {}): ServerResponse => ({ status, headers, body: { kind: 'json', value } })
const errorKind = (kind: string) => (error: unknown): boolean => error instanceof ApiError && error.kind === kind

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  generation = 1
  calls = []
  cancelled = []
  respond = async () => json(200, { ok: true })
  signedIn = true
  clears = 0
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown>): Promise<unknown> => {
      if (command === 'current_space') return { spaceId: 'official', generation }
      if (command === 'current_media_space') return { space: { spaceId: 'official', generation }, serverBase: 'https://fixture.invalid', mediaKey: `official_fixture_${generation}` }
      if (command === 'clear_auth_session') {
        if ((args.space as { generation: number }).generation !== generation) return null
        clears++; signedIn = false; generation++
        return { spaceId: 'official', generation }
      }
      if (command === 'cancel_server_request') { cancelled.push(args); return true }
      assert.equal(command, 'server_request')
      const request = args.request as ServerRequest
      calls.push(request)
      return respond(request)
    } },
  } })
})
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

test('JSON, 204, health and explicit space use the fixed IPC contract', async () => {
  assert.deepEqual(await apiGetSkill('../a /?#', space), { ok: true })
  assert.equal(calls[0].route, 'skills.get')
  assert.deepEqual(calls[0].params, { skillId: '../a /?#' })
  assert.equal('bearer' in calls[0], false)
  assert.equal(calls[0].timeoutMs, 0)
  assert.deepEqual(calls[0].space, { spaceId: 'official', generation: 1 })
  assert.equal('url' in calls[0], false)
  assert.equal('path' in calls[0], false)
  await apiHealth()
  assert.equal(calls.at(-1)?.route, 'health')
  assert.equal('bearer' in calls.at(-1)!, false)
  respond = async () => ({ status: 204, headers: {}, body: { kind: 'empty' } })
  assert.equal(await apiLogout(), undefined)
  await apiAnalyzeSkill('skill', '# Skill')
  assert.equal(calls.at(-1)?.timeoutMs, 150_000)
})

test('instance bases use the authenticated route in the explicit current space', async () => {
  const result = { baseUrls: ['https://fixture.invalid'] }
  respond = async () => json(200, result)
  assert.deepEqual(await apiGetInstanceBaseUrls(space), result)
  assert.equal(calls[0].route, 'instance.base-urls')
  assert.deepEqual(calls[0].space, space)
  const routes = JSON.parse(readFileSync(new URL('../src/lib/server-routes.json', import.meta.url), 'utf8'))
  assert.equal(routes['instance.base-urls'].auth, true)
})

test('structured HTTP errors retain Retry-After; delete 404 is idempotent', async () => {
  respond = async () => json(429, { message: 'Slow down', code: 'BUSY' }, { 'retry-after': '7' })
  await assert.rejects(apiGetMe(), (error: unknown) => error instanceof ApiError
    && error.kind === 'http' && error.status === 429 && error.code === 'BUSY'
    && error.retryAfterSeconds === 7 && error.message === 'Slow down')
  respond = async () => json(404, { error: 'missing' })
  assert.equal(await apiDeleteSkill('gone'), undefined)
  await assert.rejects(apiGetSkill('gone'), (error: unknown) => error instanceof ApiError && error.status === 404)
})

test('binary private/public downloads preserve every byte and both metadata headers', async () => {
  const bytes = new Uint8Array([0, 255, 128, 10, 13])
  respond = async () => ({ status: 200, headers: { 'x-checksum-sha256': 'hash', 'x-skill-version': '1.2.3' }, body: { kind: 'bytes', value: bytes } })
  for (const download of [apiDownloadSkillPackage, apiDownloadMarketplacePackage]) {
    const payload = await download('pkg')
    assert.deepEqual(Uint8Array.from(atob(payload.base64), value => value.charCodeAt(0)), bytes)
    assert.equal(payload.sha256, 'hash')
    assert.equal(payload.version, '1.2.3')
  }
  assert.equal('bearer' in calls[0], false)
  assert.equal('bearer' in calls[1], false)
})

test('401 preserves login, change-password and anonymous catalog; ordinary requests notify', async () => {
  respond = async () => json(401, { error: 'expired' })
  let notifications = 0
  const unsubscribe = onApiUnauthorized(() => { notifications++ })
  try {
    await assert.rejects(apiLogin({ email: 'test@example.com', password: 'fixture' }))
    await assert.rejects(apiChangePassword({ currentPassword: 'old', newPassword: 'new' }))
    await assert.rejects(apiGetMarketplace())
    assert.equal(notifications, 0)
    assert.equal(signedIn, true)
    assert.equal(clears, 0)
    await assert.rejects(apiGetTeams())
    assert.equal(notifications, 1)
    assert.equal(signedIn, false)
  } finally { unsubscribe() }
})

test('native timeout, cancellation, stale handle and network errors keep their kinds', async () => {
  for (const [message, kind] of [
    ['SkillHub 请求超时，请重试', 'timeout'], ['SkillHub 请求已取消', 'aborted'],
    ['SkillHub 空间或账号已切换，本次请求结果已丢弃', 'aborted'],
    ['SkillHub APP 正在同步账号，请稍后重试', 'aborted'], ['无法连接 SkillHub，请检查网络与 HTTPS 配置', 'network'],
  ]) {
    respond = async () => { throw message }
    await assert.rejects(apiGetMe(), errorKind(kind))
  }
})

test('stale success and stale 401 are discarded before session notification', async () => {
  for (const status of [200, 401]) {
    respond = async () => { generation++; return json(status, { error: 'expired' }) }
    await assert.rejects(apiGetMe(), errorKind('aborted'))
    assert.equal(signedIn, true)
  }
})

test('caller abort and timeout cancel the same native request; pre-abort never submits', async () => {
  respond = async () => new Promise<ServerResponse>(() => {})
  const controller = new AbortController()
  const request = apiGetSkillAvatars(space, controller.signal)
  await new Promise<void>(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(request, errorKind('aborted'))
  assert.deepEqual(cancelled[0], { space: calls[0].space, requestId: calls[0].requestId })
  await assert.rejects(apiGetMe({ timeoutMs: 5 }), errorKind('timeout'))
  assert.equal(cancelled.length, 2)
  const before = calls.length
  await assert.rejects(apiGetSkillAvatars(space, controller.signal), errorKind('aborted'))
  assert.equal(calls.length, before)
})

test('native error strings mapped by the frontend remain pinned', () => {
  const rust = readFileSync('src-tauri/src/server_request.rs', 'utf8')
  const frontend = readFileSync('src/lib/api.ts', 'utf8')
  for (const text of ['SkillHub 请求超时，请重试', 'SkillHub 请求已取消', 'SkillHub 空间或账号已切换，本次请求结果已丢弃', 'SkillHub APP 正在同步账号，请稍后重试', '请先在 SkillHub APP 登录']) {
    assert.ok(rust.includes(text), text)
    assert.ok(frontend.includes(text), text)
  }
})
