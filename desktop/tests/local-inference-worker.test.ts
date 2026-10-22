import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readLocalInferencePreference, saveLocalInferencePreference, setLocalAutoAnalyze, localWorkerText, localWorkerCounts, acceptLocalWorkerStatus, localWorkerSnapshot, canApplyLocalAnalysisRefresh, LOCAL_INFERENCE_PREFERENCE_EVENT } from '../src/lib/local-inference.ts'
import type { LocalInferenceWorkerStatus } from '../src/lib/tauri.ts'
import { localInferenceError } from '../src/lib/local-inference.ts'

test('local policy and SOCKS errors show actionable copy without echoing diagnostics', () => {
  for (const [code, text] of [
    ['LOCAL_AGENT_MANAGED_MCP', '组织策略下发了托管 MCP'],
    ['LOCAL_AGENT_SOCKS_PROXY', 'Claude Code 不支持 SOCKS 代理'],
  ]) {
    assert.ok(localInferenceError(code).includes(text))
    assert.equal(localInferenceError({ code, message: 'private diagnostic' }), localInferenceError(code))
    assert.ok(localWorkerText({ revision: 1, space: { spaceId: 'fixture', generation: 1 }, userId: 'user', state: 'paused', completed: 0, analyzed: 0, drafted: 0, failed: 0, pausedReason: 'PROBE_REQUIRED', lastError: code }, true).includes(text))
  }
})

const space = { spaceId: 'selfhost-fixture', generation: 2 }
const status: LocalInferenceWorkerStatus = { revision: 1, space, userId: 'user', state: 'idle', completed: 3, analyzed: 3, drafted: 2, failed: 1 }

test('worker counts distinguish Skill analyses and avatar drafts including the initial state', () => {
  assert.equal(localWorkerCounts(null), '本次已分析 0 个 Skill，编写 0 个头像提示词，失败 0 个')
  assert.equal(localWorkerCounts(status), '本次已分析 3 个 Skill，编写 2 个头像提示词，失败 1 个')
  assert.equal(localWorkerCounts({ ...status, completed: 99 }), localWorkerCounts(status))
})

test('avatar draft success updates status without requesting a Skill refresh', () => {
  const target = { spaceId: 'avatar-space', generation: 1 }
  const draft = { ...status, space: target, avatarJobId: 'job', drafted: 4 }
  assert.equal(acceptLocalWorkerStatus(draft, target, 'user'), false)
  assert.equal(localWorkerSnapshot(target, 'user'), draft)
  assert.equal(acceptLocalWorkerStatus({ ...draft, revision: 0, drafted: 1 }, target, 'user'), false)
  assert.equal(localWorkerSnapshot(target, 'user')?.drafted, 4)
})

test('old preferences default to autoAnalyze; pause/resume persist without changing the selected Agent', () => {
  const values = new Map<string, string>()
  const events: string[] = []
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: (event: Event) => { events.push(event.type); return true } } })
  assert.equal(readLocalInferencePreference(space, 'user').autoAnalyze, true)
  values.set(`skillhub.local-inference.v1:${JSON.stringify([space.spaceId, 'user'])}`, JSON.stringify({ enabled: true, agent: 'claude' }))
  assert.deepEqual(readLocalInferencePreference(space, 'user'), { enabled: true, agent: 'claude', autoAnalyze: true })
  for (const autoAnalyze of [false, true]) {
    assert.deepEqual(setLocalAutoAnalyze(space, 'user', autoAnalyze), { enabled: true, agent: 'claude', autoAnalyze })
    assert.equal(readLocalInferencePreference({ ...space, generation: 99 }, 'user').autoAnalyze, autoAnalyze)
  }
  saveLocalInferencePreference(space, 'user', { enabled: false, agent: 'claude', autoAnalyze: false })
  assert.deepEqual(readLocalInferencePreference(space, 'user'), { enabled: false, agent: 'claude', autoAnalyze: false })
  assert.equal(readLocalInferencePreference(space, 'other').enabled, false)
  assert.ok(events.every(event => event === LOCAL_INFERENCE_PREFERENCE_EVENT))
})

test('worker state text uses fixed Chinese reasons and never echoes server error text', () => {
  for (const [state, expected] of [['off', '自动分析已关闭'], ['idle', '空闲 · 没有待分析的 Skill'], ['running', '运行中'], ['paused', '已暂停'], ['unavailable', '不可用'], ['error', '暂时失败']] as const) {
    const text = localWorkerText({ ...status, state, pausedReason: 'raw-secret', lastError: 'raw-secret' }, true)
    assert.ok(text.startsWith(expected))
    assert.ok(!text.includes('raw-secret'))
  }
  assert.match(localWorkerText({ ...status, state: 'unavailable', pausedReason: 'INSTANCE_AI_CONFIGURED' }, true), /10 分钟/)
  assert.match(localWorkerText(status, false), /已暂停/)
})

test('probe required includes its fixed error and the circuit breaker explains how to resume', () => {
  assert.equal(localWorkerText({ ...status, state: 'paused', pausedReason: 'PROBE_REQUIRED', lastError: 'EXIT' }, true),
    '已暂停 · 请重新检测 Claude Code（CLI 异常退出，请检查终端登录状态）')
  assert.equal(localWorkerText({ ...status, state: 'paused', pausedReason: 'INTERRUPTED' }, true),
    '已暂停 · 自动分析多次被中断，已暂停；点击继续重试')
  assert.doesNotMatch(localWorkerText({ ...status, state: 'paused', pausedReason: 'PROBE_REQUIRED', lastError: 'secret-text' }, true), /secret-text/)
})

test('only completed events for the exact current space generation and user request refresh', () => {
  assert.equal(acceptLocalWorkerStatus(status, space, 'user'), false)
  const completed = { ...status, revision: 2, skillId: 'skill' }
  assert.equal(acceptLocalWorkerStatus(completed, space, 'user'), true)
  for (const [target, user] of [[{ ...space, generation: 3 }, 'user'], [{ ...space, spaceId: 'another' }, 'user'], [space, 'another'], [null, 'user']] as const) {
    assert.equal(acceptLocalWorkerStatus(completed, target, user), false)
  }
  assert.equal(localWorkerSnapshot(space, 'user'), completed)
  const snapshot = { ...status, revision: 4, completed: 4 }
  assert.equal(acceptLocalWorkerStatus(snapshot, space, 'user'), false)
  assert.equal(acceptLocalWorkerStatus({ ...snapshot, skillId: 'next-skill' }, space, 'user'), true)
  assert.equal(acceptLocalWorkerStatus({ ...snapshot, skillId: 'next-skill' }, space, 'user'), false)
  assert.equal(acceptLocalWorkerStatus({ ...status, revision: 3, skillId: 'earlier-skill' }, space, 'user'), true)
  assert.equal(localWorkerSnapshot(space, 'user'), snapshot)
  assert.equal(localWorkerSnapshot(space, 'another'), null)
  assert.equal(acceptLocalWorkerStatus(status, space, 'user'), false)
  assert.equal(acceptLocalWorkerStatus(completed, space, 'user'), false)
  assert.equal(localWorkerSnapshot(space, 'user'), snapshot)
})

test('a late Skill read cannot overwrite edits or a newer sync snapshot', () => {
  const captured = { updatedAt: '2026-10-18T10:00:00Z', description: 'before' }
  assert.equal(canApplyLocalAnalysisRefresh(captured, captured, '2026-10-18T10:01:00Z'), true)
  assert.equal(canApplyLocalAnalysisRefresh(captured, captured, '2026-10-18T09:59:00Z'), false)
  assert.equal(canApplyLocalAnalysisRefresh({ ...captured, description: 'edited' }, captured, '2026-10-18T10:01:00Z'), false)
  assert.equal(canApplyLocalAnalysisRefresh({ updatedAt: '2026-10-18T10:02:00Z' }, captured, '2026-10-18T10:01:00Z'), false)
  assert.equal(canApplyLocalAnalysisRefresh(captured, captured, 'invalid'), false)
})
