import { serverFixture } from './helpers/server-ipc.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test, { mock } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ApiError, apiGetSkillAvatars, parseRetryAfter } from '../src/lib/api.ts'
import {
  avatarAttemptAt, avatarBackoffMs, avatarSignature, createAvatarRetryState, deferAvatar, needsAvatarWork, recordAvatarFailure,
  recordAvatarListFailure, recordAvatarSuccess,
} from '../src/lib/avatar-retry.ts'
import { envReadinessSignature, needsEnvReadinessCheck } from '../src/lib/env-readiness.ts'
import { userMessage } from '../src/lib/user-message.ts'
import type { LocalSkill } from '../src/store/index.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')
const middle = (): number => 0.5
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0)

async function rejection(response: Response | Error, signal = new AbortController().signal): Promise<ApiError> {
  const original = serverFixture.fetch
  serverFixture.fetch = (() => response instanceof Error ? Promise.reject(response) : Promise.resolve(response)) as typeof fetch
  try {
    await apiGetSkillAvatars(serverFixture.space, signal)
  } catch (error: unknown) {
    assert.ok(error instanceof ApiError)
    return error
  } finally { serverFixture.fetch = original }
  throw new Error('expected the request to fail')
}

test('HTTP failures keep status, business code and Retry-After instead of a bare message', async () => {
  const quota = await rejection(new Response(JSON.stringify({ error: '头像生成额度已达上限，请稍后重试', code: 'AVATAR_DAILY_QUOTA' }), {
    status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '3600' },
  }))
  assert.equal(quota.kind, 'http')
  assert.equal(quota.status, 429)
  assert.equal(quota.code, 'AVATAR_DAILY_QUOTA')
  assert.equal(quota.retryAfterSeconds, 3600)
  assert.equal(quota.message, '头像生成额度已达上限，请稍后重试')

  // A gateway rejection is HTML, not JSON: the status must survive anyway.
  const gateway = await rejection(new Response('<html>503</html>', { status: 503, statusText: 'Service Unavailable' }))
  assert.equal(gateway.status, 503)
  assert.equal(gateway.code, null)
  assert.equal(gateway.message, '503 Service Unavailable')
})

test('transport failures are told apart: network, caller abort and timeout', async () => {
  const network = await rejection(new TypeError('Load failed'))
  assert.equal(network.kind, 'network')
  assert.equal(userMessage(network), '连接失败，请检查网络后重试')

  const controller = new AbortController()
  const original = serverFixture.fetch
  serverFixture.fetch = ((_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('aborted')))
  })) as typeof fetch
  try {
    const aborted = apiGetSkillAvatars(serverFixture.space, controller.signal)
    controller.abort()
    await assert.rejects(aborted, (error: unknown) => error instanceof ApiError && error.kind === 'aborted')

    mock.timers.enable({ apis: ['setTimeout'] })
    const timedOut = apiGetSkillAvatars(serverFixture.space, new AbortController().signal)
    mock.timers.tick(15_000)
    await assert.rejects(timedOut, (error: unknown) => error instanceof ApiError && error.kind === 'timeout'
      && userMessage(error) === '请求超时，请稍后重试')
  } finally {
    mock.timers.reset()
    serverFixture.fetch = original
  }
})

test('Retry-After accepts delta seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('120'), 120)
  assert.equal(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW), 90)
  assert.equal(parseRetryAfter(null), null)
  assert.equal(parseRetryAfter('soon'), null)
})

const httpError = (status: number, code: string | null, retryAfterSeconds: number | null, message = 'failed'): ApiError =>
  new ApiError('http', message, { status, code, retryAfterSeconds })

test('a daily quota pauses every new generation until it resets, without per-Skill retries', () => {
  const state = createAvatarRetryState()
  recordAvatarFailure(state, 'skill-a', httpError(429, 'AVATAR_DAILY_QUOTA', 7200), NOW, middle)
  assert.equal(avatarAttemptAt(state, 'skill-b', true), NOW + 7_200_000)
  assert.equal(state.skills.size, 0)
  // Reading back a running task is not generation and stays allowed.
  assert.equal(avatarAttemptAt(state, 'skill-b', false), 0)

  // A Skill parked behind the pause is skipped by every pass until it ends.
  deferAvatar(state, 'skill-b', avatarAttemptAt(state, 'skill-b', true))
  assert.equal(avatarAttemptAt(state, 'skill-b', false), NOW + 7_200_000)
  recordAvatarSuccess(state, 'skill-b')
  assert.equal(state.skills.size, 0)

  const legacy = createAvatarRetryState()
  recordAvatarFailure(legacy, 'skill-a', httpError(429, 'AVATAR_DAILY_QUOTA', null), NOW, middle)
  assert.equal(avatarAttemptAt(legacy, 'skill-a', true), Date.UTC(2026, 9, 5))
})

test('per-user rate limits honour Retry-After and fall back to a bounded back-off on old Servers', () => {
  const state = createAvatarRetryState()
  recordAvatarFailure(state, 'skill-a', httpError(429, 'AVATAR_RATE_LIMITED', 600), NOW, middle)
  assert.equal(avatarAttemptAt(state, 'skill-z', true), NOW + 600_000)

  const legacy = createAvatarRetryState()
  recordAvatarFailure(legacy, 'skill-a', httpError(429, null, null), NOW, middle)
  const first = avatarAttemptAt(legacy, 'skill-a', true) - NOW
  recordAvatarFailure(legacy, 'skill-a', httpError(429, null, null), NOW, middle)
  assert.ok(avatarAttemptAt(legacy, 'skill-a', true) - NOW > first)
  for (let attempt = 0; attempt < 20; attempt += 1) recordAvatarFailure(legacy, 'skill-a', httpError(429, null, null), NOW, () => 1)
  assert.ok(avatarAttemptAt(legacy, 'skill-a', true) - NOW <= 36 * 60_000)
})

test('a disabled avatar service stops automatic generation instead of retrying every pass', () => {
  for (const error of [
    httpError(503, 'AVATAR_GENERATION_DISABLED', null),
    httpError(503, null, null, '头像生成暂未开启'),
  ]) {
    const state = createAvatarRetryState()
    recordAvatarFailure(state, 'skill-a', error, NOW, middle)
    assert.equal(avatarAttemptAt(state, 'skill-b', true), NOW + 6 * 60 * 60_000)
  }
})

test('temporary failures back off only that Skill, with growth, a cap and a reset on success', () => {
  const state = createAvatarRetryState()
  recordAvatarFailure(state, 'skill-a', httpError(503, null, null, '头像服务暂时不可用，请稍后重试'), NOW, middle)
  assert.equal(avatarAttemptAt(state, 'skill-a', true), NOW + 30_000)
  assert.equal(avatarAttemptAt(state, 'skill-b', true), 0)
  recordAvatarFailure(state, 'skill-a', new ApiError('network', 'Load failed'), NOW, middle)
  assert.equal(avatarAttemptAt(state, 'skill-a', false), NOW + 60_000)
  assert.equal(avatarBackoffMs(50, middle), 30 * 60_000)
  recordAvatarSuccess(state, 'skill-a')
  assert.equal(avatarAttemptAt(state, 'skill-a', true), 0)

  recordAvatarFailure(state, 'skill-a', new ApiError('aborted', 'Request aborted'), NOW, middle)
  assert.equal(state.skills.size, 0)
  recordAvatarListFailure(state, httpError(429, null, 900), NOW, middle)
  assert.equal(state.listNextAttemptAt, NOW + 900_000)
})

const skill = (overrides: Partial<LocalSkill> = {}): LocalSkill => ({
  id: 'managed-id', name: 'research', displayName: 'Research', localPath: '/managed/id', isOwn: true,
  acquisitionSource: 'local', avatarLocalId: 'avatar-id', avatarUrl: 'https://picem-media.whatonearth.work/a.jpg',
  avatarStatus: 'ready', avatarAccountUserId: 'owner', labels: [], version: '1', latestVersion: '1', installCount: 0,
  sources: [], agents: {}, installed: true, sharedTo: {}, versions: [], compatibleAgents: [],
  envDeps: [{ key: 'API_TOKEN', required: true, configured: false, sharePolicy: 'none' }],
  ...overrides,
} as LocalSkill)

test('a settled avatar costs no request until its inputs change; a running task keeps polling', () => {
  const settled = new Map([[skill().id, avatarSignature(skill())]])
  assert.equal(needsAvatarWork(skill(), 'owner', settled), false)
  assert.equal(needsAvatarWork(skill(), 'owner', new Map()), true)
  assert.equal(needsAvatarWork(skill({ avatarStatus: 'pending', avatarUrl: null }), 'owner', settled), true)
  assert.equal(needsAvatarWork(skill({ serverId: 'rebound' }), 'owner', settled), true)
  // Not the user's own asset and nothing cached: no avatar work at all.
  assert.equal(needsAvatarWork(skill({ isOwn: false, acquisitionSource: 'team', teamSharedFrom: 'team', avatarUrl: null }), 'owner', new Map()), false)
})

test('environment readiness ignores avatar refreshes and follows real configuration changes', () => {
  const base = envReadinessSignature(skill())
  assert.equal(envReadinessSignature(skill({ avatarStatus: 'pending', avatarUrl: null, displayName: 'Renamed' })), base)
  assert.notEqual(envReadinessSignature(skill({ envDeps: [{ key: 'API_TOKEN', required: true, configured: true, sharePolicy: 'none' }] })), base)
  assert.notEqual(envReadinessSignature(skill({ serverId: 'cloud-id' })), base)
  assert.equal(needsEnvReadinessCheck(skill()), true)
  assert.equal(needsEnvReadinessCheck(skill({ envDeps: [{ key: 'OPTIONAL', required: false, configured: false, sharePolicy: 'none' }] })), false)
  assert.equal(needsEnvReadinessCheck(skill({ localPath: '' })), false)
})

test('avatar and environment loops are wired to back-off and signatures, not array identity or a fixed interval', () => {
  const app = source('src/App.tsx')
  assert.doesNotMatch(app, /setInterval\(sync, 15_000\)/)
  assert.match(app, /syncSkillAvatars\(currentUser\.id, space, controller\.signal\)\s*\.then\(\(\{ wakeAt \}\)/)
  const page = source('src/pages/SkillsPage.tsx')
  assert.doesNotMatch(page, /\}, \[authStatus, currentUser, managedSkills\]\)/)
  assert.match(page, /\[authStatus, envAccountUserId, capabilities.teamKeys, envCandidatesSignature, envInvalidation, publishEnvResults\]/)
  assert.match(page, /mapSettledWithConcurrency\(stale, ENV_READINESS_CONCURRENCY/)
  const avatars = source('src/lib/skill-avatars.ts')
  assert.match(avatars, /Writing an unchanged result would hand every list consumer a new array/)
})
