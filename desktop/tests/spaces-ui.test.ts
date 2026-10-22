import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import test, { beforeEach, afterEach } from 'node:test'
import ts from 'typescript'
import { createElement, isValidElement, Children } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerRequest, SpaceHandle } from '../src/lib/tauri.ts'

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/desktop/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
    for (const extension of ['.ts', '.tsx']) {
      const url = new URL(specifier.replace(/\.js$/, extension), context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
  }
  return next(specifier, context)
}, load(url, context, next) {
  if (url.endsWith('/FocusTrapDialog.tsx')) return { format: 'module', source: 'export default function Dialog({children}) { return children }', shortCircuit: true }
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText }
  return next(url, context)
} })
const { authenticateSelfhost, connectionChecks, CONNECTION_ITEMS, displayServerAddress, rebindOutcome, selectedServiceProfile, setupErrorMessage, switchSpace, verifyReboundLogin, SELF_HOST_DOCS, SETUP_CODE_DOCS } = await import('../src/lib/spaces.ts')
const { ApiError, apiCandidate, onApiUnauthorized } = await import('../src/lib/api.ts')
const { retryNativeAuthRestore, nextRestoreDelay, isRetryableRestoreError, restoreNativeAuth } = await import('../src/lib/auth-restore.ts')
const { spaceCapabilities, spaceProfile } = await import('../src/lib/space-capabilities.ts')
const { useStore } = await import('../src/store/index.ts')
const { ConnectionChecklist, ConnectionStatus, default: ConnectServerDialog } = await import('../src/components/ConnectServerDialog.tsx')
const { default: NotificationCenter } = await import('../src/components/NotificationCenter.tsx')
const { MigrationPrecheck } = await import('../src/components/MigrationDialog.tsx')
const { OtherServerInviteDialog } = await import('../src/components/TeamInviteDialog.tsx')
hooks.deregister()

test('migration precheck renders counts, conflict defaults and unchecked personal keys', () => {
  const markup = renderToStaticMarkup(createElement(MigrationPrecheck, {
    status: { localMigrationId: 'm', state: 'ready', snapshotAt: 1, limits: { skills: 50, skillRecords: 1000, packageStorageBytes: 104857600 },
      keys: [], keysDone: false, keyResults: [], items: [{
        id: 'a', sourceSkillId: 'source', name: 'sample', category: 'own_skill', state: 'pending',
        reason: '', pendingDelta: true, warnings: [], avatars: [], avatarCount: 3, storeState: null,
        targetSkillId: null, targetEntryId: null,
        precheck: { operationKey: 'key', status: 'conflict', reason: 'name_exists', existingSkillId: null },
      }] },
    switching: true, onCancel: () => {}, onConfirm: async () => {},
  }))
  assert.match(markup, /可迁 0 · 跳过 0 · 冲突 1 · 超额 0 · 待处理增量 1/)
  assert.match(markup, /头像 3/)
  assert.match(markup, /目标账号已有同名 Skill/)
  assert.match(markup, /type="radio" name="choice-a" checked=""/)
  assert.match(markup, /type="radio" name="choice-a" disabled=""/)
  assert.doesNotMatch(markup, /type="checkbox"[^>]*checked/)
  assert.match(markup, /不迁移，只切换/)
  assert.match(markup, /未删除的 Skill 最多 50 个（含回收站在内总记录最多 1000 条）/)
  assert.match(markup, /账号内容包总存储上限 100 MiB/)
})

test('other-server invitation has the standard header; close, cancel and Escape do not connect', () => {
  const actions: string[] = []
  const props = { server: 'https://target.test/base', busy: false, onCancel: () => { actions.push('cancel') }, onContinue: () => { actions.push('connect') } }
  const dialog = OtherServerInviteDialog(props)
  type ButtonProps = { onClick: () => void; disabled: boolean; children?: ReactNode; 'aria-label'?: string; className?: string }
  const buttons = (node: ReactNode): Array<ReactElement<ButtonProps>> => {
    if (!isValidElement<ButtonProps>(node)) return []
    if (node.type === 'button') return [node]
    return Children.toArray(node.props.children).flatMap(buttons)
  }
  const choices = buttons(dialog)
  assert.equal(choices.length, 3)
  const markup = renderToStaticMarkup(dialog)
  assert.match(markup, /<span class="eyebrow">团队邀请<\/span><h2>加入其他服务器上的团队<\/h2>/)
  assert.match(markup, /这个邀请来自 https:\/\/target.test\/base/)
  assert.equal(choices[0].props['aria-label'], '关闭团队邀请')
  assert.equal(choices[0].props.className, 'ico-btn')
  assert.equal(choices[1].props.children, '暂不加入')
  assert.equal(choices[2].props.children, '切换并继续')
  choices[0].props.onClick()
  choices[1].props.onClick()
  dialog.props.onEscape()
  assert.deepEqual(actions, ['cancel', 'cancel', 'cancel'])
  choices[2].props.onClick()
  assert.deepEqual(actions, ['cancel', 'cancel', 'cancel', 'connect'])
  const waiting = OtherServerInviteDialog({ ...props, busy: true })
  assert.equal(waiting.props.escapeDisabled, true)
  assert.ok(buttons(waiting).every(button => button.props.disabled))
})

const source = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
const user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'admin', displayName: 'Admin' }
const original: SpaceHandle = { spaceId: 'official', generation: 1 }
const candidate: SpaceHandle = { spaceId: 'selfhost-test', generation: 2 }
let active: SpaceHandle
let nativeUserId: string | null
let nativePending: boolean
let calls: string[]
let requests: ServerRequest[]
let response: (request: ServerRequest) => Promise<{ status: number; value: unknown; retry?: string }>
let oldWindow: PropertyDescriptor | undefined

beforeEach(() => {
  active = { ...original }; calls = []; requests = []
  nativeUserId = user.id; nativePending = false
  response = async request => ({ status: request.route === 'setup.admin' ? 201 : 200, value: request.route === 'setup.status' ? { initialized: true } : { user } })
  useStore.setState({ organizerAccount: null, organizerLoaded: false })
  oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: () => true, __TAURI_INTERNALS__: {
    invoke: async (command: string, args: { space?: SpaceHandle; request?: ServerRequest } = {}): Promise<unknown> => {
      calls.push(command)
      if (command === 'current_space') return active
      if (command === 'auth_state') return { ...active, userId: nativeUserId, pending: nativePending }
      if (command === 'clear_auth_session') {
        assert.deepEqual(args.space, active)
        active = { ...active, generation: active.generation + 1 }
        nativeUserId = null
        return active
      }
      if (command === 'begin_space_switch') { active = { ...original, generation: 2 }; return candidate }
      if (command === 'cancel_space_switch') { active = { ...original, generation: 3 }; return }
      if (command === 'commit_space_switch') { active = { ...candidate, generation: 3 }; return active }
      assert.equal(command, 'server_request')
      const request = args.request!
      requests.push(request)
      assert.deepEqual(request.space, candidate)
      const result = await response(request)
      // Native IPC returns bytes, not a JSON object, on desktop.
      return { status: result.status, statusText: '', space: candidate,
        headers: result.retry ? { 'Retry-After': result.retry } : {},
        body: { kind: 'bytes', value: new TextEncoder().encode(JSON.stringify(result.value)) } }
    },
  } } })
})
afterEach(() => {
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

test('service cards retain approved order, tags, official default and tutorial destinations', () => {
  const ui = source('components/ServiceSettings.tsx')
  assert.ok(ui.indexOf("title: '一探官方'") < ui.indexOf("title: '仅本机'"))
  assert.ok(ui.indexOf("title: '仅本机'") < ui.indexOf("title: '自部署服务器'"))
  assert.match(ui, /tags: \['省心', '推荐'\]/)
  assert.match(ui, /tags: \['高级'\]/)
  assert.equal(spaceProfile(null), 'official')
  assert.match(source('pages/SettingsPage.tsx'), /AI 与头像/)
  assert.match(source('pages/SettingsPage.tsx'), /serverInfo \? capabilities\.ai/)
  assert.match(source('App.tsx'), /restoreRequested\.current = false; void restorePersistedSession\(false, false\)/)
  assert.equal(SELF_HOST_DOCS, 'https://sk.woe.show/docs/self-host/connect-app/')
  assert.equal(SETUP_CODE_DOCS, 'https://sk.woe.show/docs/self-host/create-admin/')
  assert.match(source('components/ConnectServerDialog.tsx'), /openUrl\(setup \? SETUP_CODE_DOCS : SELF_HOST_DOCS\)/)
})

test('untested checklist is hidden; testing shows progress and reports show all six checks', () => {
  assert.deepEqual(CONNECTION_ITEMS.map(item => item[1]), ['连接安全', '版本兼容', '实例状态', '登录方式', 'AI 服务', 'Skill 头像'])
  assert.equal(connectionChecks(null).length, 6)
  assert.equal(renderToStaticMarkup(createElement(ConnectionChecklist, { report: null })), '')
  const progress = renderToStaticMarkup(createElement(ConnectionChecklist, { report: null, testing: true }))
  assert.match(progress, /role="status"/)
  assert.doesNotMatch(progress, /尚未检查|<li /)
  for (const state of ['pass', 'actionRequired', 'blocked', 'unavailable'] as const) {
    const report = { origin: null, checks: [{ item: 'security', state, message: state }], error: null, info: null, deployment: null }
    const checks = connectionChecks(report)
    assert.equal(checks[0].state, state)
    assert.equal(checks[5].state, 'unavailable')
    const markup = renderToStaticMarkup(createElement(ConnectionChecklist, { report }))
    assert.equal((markup.match(/<li /g) ?? []).length, 6)
    assert.ok(markup.includes(`data-state="${state}"`))
    for (const [, label] of CONNECTION_ITEMS) assert.ok(markup.includes(label))
  }
  const dialog = source('components/ConnectServerDialog.tsx')
  assert.match(dialog, /FocusTrapDialog/)
  assert.match(dialog, /role="alert"/)
  assert.match(dialog, /onSubmit=/)
  assert.doesNotMatch(dialog, /忽略证书/)
})

test('connection dialog shows a neutral caption above login only for a team invitation', () => {
  const report = { origin: 'https://target.test', checks: [], error: null, info: null, deployment: { profile: 'selfhost' as const } }
  for (const teamInvite of [undefined, false, true]) {
    const markup = renderToStaticMarkup(createElement(ConnectServerDialog, {
      target: report.origin, initialReport: report, teamInvite, onClose: () => {},
    }))
    if (teamInvite) {
      assert.match(markup, /<p class="connection-caption">登录后将继续加入团队。<\/p>/)
      assert.ok(markup.indexOf('登录后将继续加入团队。') < markup.indexOf('type="email"'))
    } else {
      assert.doesNotMatch(markup, /登录后将继续加入团队/)
    }
  }
  assert.match(source('components/ConnectServerDialog.css'), /\.connection-caption \{ color: var\(--color-muted\)/)
})

test('migration source login hides registration even when the instance allows it', () => {
  const report = { origin: 'https://target.test', checks: [], error: null,
    info: { status: 'ok', auth: { password: true, yitanOidc: false, registration: 'open' as const } },
    deployment: { profile: 'selfhost' as const } }
  for (const migrationSource of [true, false]) {
    const markup = renderToStaticMarkup(createElement(ConnectServerDialog, {
      target: report.origin, initialReport: report, migrationSource, onClose: () => {},
    }))
    assert.equal(markup.includes('注册账号'), !migrationSource)
  }
  assert.match(source('components/ConnectServerDialog.tsx'), /if \(selfhost && target\.trim\(\) && !initialReport\) void test\(\)/)
})

test('rebind confirmation has approved copy, hides credentials and distinguishes inactive data', () => {
  for (const active of [true, false]) {
    const report = { origin: 'https://new.test/prefix', checks: [], error: null, info: null, deployment: { profile: 'selfhost' as const }, rebind: { previousOrigin: 'https://old.test/prefix', active } }
    const markup = renderToStaticMarkup(createElement(ConnectServerDialog, { target: report.origin, initialReport: report, onClose: () => {} }))
    assert.match(markup, /这是你之前的实例/)
    assert.match(markup, /作为新实例/)
    assert.match(markup, /改用新地址/)
    assert.match(markup, active ? /数据和登录状态保持不变/ : /需要重新登录/)
    assert.doesNotMatch(markup, /type="password"|type="email"/)
  }
  const report = { origin: 'https://new.test', checks: [], error: null, info: null, deployment: { profile: 'selfhost' as const }, rebind: null }
  assert.match(renderToStaticMarkup(createElement(ConnectServerDialog, { target: report.origin, initialReport: report, onClose: () => {} })), /type="password"/)
})

test('confirmed rebind skips candidate login; cancel never commits and as-new retains authentication', async () => {
  let authenticated = 0
  const authenticate = async (): Promise<void> => { authenticated++ }
  await switchSpace(original, 'https://new.test', authenticate, async () => '只切换', true)
  assert.equal(authenticated, 0)
  assert.equal(calls.includes('commit_space_switch'), true)
  calls = []
  await switchSpace(original, 'https://new.test', authenticate, async () => '取消', true)
  assert.equal(authenticated, 0)
  assert.equal(calls.includes('commit_space_switch'), false)
  assert.equal(calls.includes('cancel_space_switch'), true)
  await switchSpace(original, 'https://new.test', authenticate, async () => '只切换', false)
  assert.equal(authenticated, 1)
})

test('rebind outcomes distinguish retained login, guest, expired login, inactive space and unavailable verification', () => {
  const origin = 'http://127.0.0.1:3003'
  const input = { active: true, beforeUserId: user.id, afterUserId: user.id, origin }
  const cases = [
    { input: { ...input, verification: 'verified' as const }, action: 'close', message: `已改用新地址 ${origin}，数据和登录状态已保留` },
    { input: { ...input, beforeUserId: null, afterUserId: null }, action: 'close', message: `已改用新地址 ${origin}，数据已保留` },
    { input: { ...input, afterUserId: null }, action: 'login', message: '已改用新地址，数据已保留。原登录已失效，请重新登录。' },
    { input: { ...input, afterUserId: 'different-user' }, action: 'login', message: '已改用新地址，数据已保留。原登录已失效，请重新登录。' },
    { input: { ...input, verification: 'invalid' as const }, action: 'login', message: '已改用新地址，数据已保留。原登录已失效，请重新登录。' },
    { input: { ...input, active: false, afterUserId: null }, action: 'login', message: '已改用新地址，数据已保留。请登录此实例。' },
    { input: { ...input, active: false, beforeUserId: null, afterUserId: null }, action: 'login', message: '已改用新地址，数据已保留。请登录此实例。' },
    { input: { ...input, verification: 'unavailable' as const }, action: 'close', message: `已改用新地址 ${origin}，数据已保留。暂时无法验证登录状态，稍后会自动重试。` },
  ]
  for (const { input, action, message } of cases) {
    const outcome = rebindOutcome(input)
    assert.deepEqual(outcome, { action, message })
    const markup = renderToStaticMarkup(createElement(ConnectionStatus, { children: outcome.message }))
    assert.match(markup, /role="status"/)
    assert.match(markup, /connection-status/)
    assert.doesNotMatch(markup, /role="alert"|auth-dialog-alert|danger|success/)
  }
  assert.equal(rebindOutcome(input).message, cases.at(-1)!.message, 'a retained userId alone does not prove verification')
  const dialog = source('components/ConnectServerDialog.tsx')
  assert.match(dialog, /rebindMessage && <ConnectionStatus>\{rebindMessage\}<\/ConnectionStatus>/)
  assert.match(dialog, /toast\(outcome.message\)\s+closed.current = true/)
  assert.doesNotMatch(dialog, /setError\(['"`]已改用新地址/)
  const css = source('components/ConnectServerDialog.css').match(/\.connection-status \{[^}]+\}/)?.[0]
  assert.ok(css)
  assert.doesNotMatch(css, /danger/)
})

test('rebind verification uses the committed space and one auth.me request', async () => {
  active = { ...candidate }
  assert.equal(await verifyReboundLogin(active, user.id), 'verified')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].route, 'auth.me')
  assert.deepEqual(requests[0].space, candidate)
  assert.equal(calls.includes('clear_auth_session'), false)
})

for (const scenario of ['401', 'mismatched-user'] as const) {
  test(`rebind verification ${scenario} uses the existing unauthorized handler`, async () => {
    active = { ...candidate }
    response = async () => scenario === '401'
      ? { status: 401, value: { message: 'Unauthorized' } }
      : { status: 200, value: { user: { ...user, id: 'different-user' } } }
    let notified = 0
    const stop = onApiUnauthorized((space, cleared) => {
      assert.deepEqual(space, candidate)
      assert.deepEqual(cleared, active)
      notified++
    })
    try {
      assert.equal(await verifyReboundLogin(candidate, user.id), 'invalid')
      assert.equal(requests.length, 1)
      assert.equal(calls.filter(command => command === 'clear_auth_session').length, 1)
      assert.equal(notified, 1)
    } finally { stop() }
  })
}

for (const scenario of ['network', 'timeout', '503'] as const) {
  test(`rebind verification ${scenario} remains neutral and preserves the native session`, async () => {
    active = { ...candidate }
    response = async () => {
      if (scenario === '503') return { status: 503, value: { message: 'Service unavailable' } }
      throw new Error(scenario === 'timeout' ? 'SkillHub 请求超时，请重试' : 'Connection refused')
    }
    assert.equal(await verifyReboundLogin(candidate, user.id), 'unavailable')
    assert.equal(requests.length, 1)
    assert.equal(calls.includes('clear_auth_session'), false)
    assert.deepEqual(active, candidate)
  })
}

test('stale rebind verification is not reported as successful or allowed to clear another session', async () => {
  active = { ...candidate }
  response = async () => {
    active = { ...candidate, generation: candidate.generation + 1 }
    return { status: 401, value: {} }
  }
  await assert.rejects(verifyReboundLogin(candidate, user.id), (error: unknown) => error instanceof ApiError && error.kind === 'aborted')
  assert.equal(calls.includes('clear_auth_session'), false)
})

test('a concurrent restore handling 401 first still maps rebind verification to neutral login', async () => {
  active = { ...candidate }
  response = async () => {
    active = { ...candidate, generation: candidate.generation + 1 }
    nativeUserId = null
    return { status: 401, value: {} }
  }
  assert.equal(await verifyReboundLogin(candidate, user.id), 'invalid')
  assert.equal(calls.includes('clear_auth_session'), false, 'the other request already cleared the session')
})

for (const scenario of ['same-session', 'different-space', 'different-generation', 'different-user', 'guest', 'pending', 'cancelled'] as const) {
  test(`native session restore retry is scoped and cancellable: ${scenario}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    active = { ...candidate }
    let restored = 0
    const retry = retryNativeAuthRestore({ random: () => 0.5, events: new EventTarget() })
    retry.schedule(candidate, user.id, async (): Promise<void> => { restored++ })
    const cancel = retry.cancel
    if (scenario === 'different-space') active = { ...original }
    if (scenario === 'different-generation') active = { ...candidate, generation: candidate.generation + 1 }
    if (scenario === 'different-user') nativeUserId = 'another-user'
    if (scenario === 'guest') nativeUserId = null
    if (scenario === 'pending') nativePending = true
    if (scenario === 'cancelled') cancel()
    t.mock.timers.tick(4_999)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(restored, 0)
    t.mock.timers.tick(1)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(restored, scenario === 'same-session' ? 1 : 0)
    assert.equal(calls.includes('clear_auth_session'), false)
    cancel()
  })
}

test('restore delays double from five seconds, jitter by ±20%, and never exceed five minutes', () => {
  assert.deepEqual(Array.from({ length: 9 }, (_, attempt) => nextRestoreDelay(attempt, () => 0.5)),
    [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000])
  for (const attempt of [0, 1, 2, 5, 6, 100, 10_000]) {
    const base = Math.min(300_000, 5_000 * 2 ** attempt)
    for (const random of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = nextRestoreDelay(attempt, () => random)
      assert.ok(delay >= base * 0.8 && delay <= Math.min(300_000, base * 1.2))
    }
  }
})

function restoreRetryFixture() {
  const events = new EventTarget()
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const timers: { run: () => void; delay: number; cancelled: boolean }[] = []
  const retry = retryNativeAuthRestore({ events, visibility, random: () => 0.5,
    timer: (run, delay) => {
      const entry = { run, delay, cancelled: false }
      timers.push(entry)
      return () => { entry.cancelled = true }
    },
  })
  return { events, visibility, timers, retry }
}

for (const event of ['focus', 'online', 'visibilitychange']) {
  test(`${event} retries immediately, coalesces wake events, and resets backoff`, async () => {
    active = { ...candidate }
    const { events, visibility, timers, retry } = restoreRetryFixture()
    let restored = 0
    const restore = async (): Promise<void> => {
      restored++
      retry.schedule(candidate, user.id, restore)
    }
    retry.schedule(candidate, user.id, restore)
    timers[0].run()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(timers[1].delay, 10_000)
    visibility.visibilityState = 'hidden'
    visibility.dispatchEvent(new Event('visibilitychange'))
    assert.equal(timers[1].cancelled, false)
    visibility.visibilityState = 'visible'
    ;(event === 'visibilitychange' ? visibility : events).dispatchEvent(new Event(event))
    events.dispatchEvent(new Event('focus'))
    events.dispatchEvent(new Event('online'))
    visibility.dispatchEvent(new Event('visibilitychange'))
    timers[1].run() // Even an already-queued timer cannot race the wake event.
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(restored, 2)
    assert.equal(timers[1].cancelled, true)
    assert.equal(timers[2].delay, 5_000)
    retry.cancel()
  })
}

test('cancel invalidates pending state reads and removes timers and event listeners', async t => {
  active = { ...candidate }
  const { events, visibility, timers, retry } = restoreRetryFixture()
  const removeWindow = t.mock.method(events, 'removeEventListener')
  const removeDocument = t.mock.method(visibility, 'removeEventListener')
  let restored = 0
  retry.schedule(candidate, user.id, async (): Promise<void> => { restored++ })
  const current = retry.checkpoint()
  events.dispatchEvent(new Event('focus'))
  retry.cancel() // Cancel while authState is still resolving.
  timers[0].run()
  events.dispatchEvent(new Event('online'))
  visibility.dispatchEvent(new Event('visibilitychange'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(restored, 0)
  assert.equal(current(), false)
  assert.ok(timers.every(timer => timer.cancelled))
  assert.ok(removeWindow.mock.calls.some(call => call.arguments[0] === 'focus'))
  assert.ok(removeWindow.mock.calls.some(call => call.arguments[0] === 'online'))
  assert.ok(removeDocument.mock.calls.some(call => call.arguments[0] === 'visibilitychange'))
  retry.schedule(candidate, user.id, async (): Promise<void> => { restored++ })
  assert.equal(timers[1].delay, 5_000)
  retry.cancel()
})

test('restore retry cancellation is wired to manual retry, success, space/session changes and unmount', () => {
  const app = source('App.tsx')
  assert.match(app, /if \(!automatic\) restoreRetry.cancel\(\)/)
  assert.match(app, /onRetryRestore=\{\(\) => void restorePersistedSession\(\)\}/)
  assert.match(app, /restoreRetry.cancel\(\)\s+if \(session\) setAuthSession/)
  assert.match(app, /state.spacePending === payload.pending\) return\s+restoreRetry.cancel\(\)/)
  assert.match(app, /state.authStatus !== previous.authStatus/)
  assert.match(app, /return \(\) => \{ unsubscribe\(\); restored.current = false; restoreRequested.current = false; restoreRetry.cancel\(\) \}/)
  assert.match(app, /if \(!isCurrent\(\)\) return\s+if \(retrySpace && retryUserId && isRetryableRestoreError/)
})

test('App queued space-change restore revalidates without renewing again', async () => {
  const app = source('App.tsx')
  const start = app.indexOf('  const restorePersistedSession = useCallback')
  const restoreCode = app.slice(start, app.indexOf('\n  useEffect(', start))
  const compiled = ts.transpileModule(`
    const restoreInFlight = { current: false }, restoreRequested = { current: false };
    let renewals = 0, validations = 0, accepted = null;
    const useCallback = fn => fn;
    const useStore = { setState() {}, getState() { return { authStatus: 'restoring' } } };
    const native = { spaceId: 'test', generation: 1, pending: false, userId: 'user' };
    const authState = async () => native, currentSpace = async () => native;
    const restoreNativeAuth = async ({ allowRenew }) => {
      validations++;
      if (allowRenew) {
        renewals++; native.generation++;
        await restorePersistedSession();
      }
      return { user: { id: native.userId }, space: { ...native } };
    };
    const sameSpace = (a, b) => a.spaceId === b.spaceId && a.generation === b.generation;
    const setRestoreError = () => {}, setAuthSession = (user, space) => { accepted = space }, setAuthGuest = () => {};
    const clearAuthSession = () => {}, promptForAuth = () => {}, setView = () => {};
    const sessionStorage = { getItem() { return null } }, SPACE_SWITCH_VIEW_KEY = 'view';
    ${restoreCode}
    return { run: restorePersistedSession, result: () => ({ renewals, validations, accepted }) };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText
  const makeRestore = new Function('restoreRetry', compiled) as
    (retry: ReturnType<typeof retryNativeAuthRestore>) => { run: () => Promise<void>; result: () => { renewals: number; validations: number; accepted: { generation: number } } }
  const restore = makeRestore(retryNativeAuthRestore())
  await restore.run()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(restore.result().renewals, 1)
  assert.equal(restore.result().validations, 2)
  assert.equal(restore.result().accepted.generation, 2)
})

test('App restore survives StrictMode setup-cleanup-setup and ignores a final unmount', async () => {
  const app = source('App.tsx')
  const restoreStart = app.indexOf('  const restorePersistedSession = useCallback')
  const restoreCode = app.slice(restoreStart, app.indexOf('\n  useEffect(', restoreStart))
  const lifecycleCode = app.slice(app.indexOf('  // Restore a persisted JWT'), app.indexOf('  // Initialize: load teams'))
  // Execute the actual App callback and effects with only their external dependencies stubbed.
  const compiled = ts.transpileModule(`
    const restored = { current: false }, restoreInFlight = { current: false }, restoreRequested = { current: false };
    const effects = [];
    let guests = 0;
    const useCallback = fn => fn, useEffect = fn => effects.push(fn);
    const useStore = { setState() {}, subscribe() { return () => {} } };
    const native = { spaceId: 'test', generation: 1, pending: false, userId: null };
    const authState = async () => native, currentSpace = async () => native;
    const restoreNativeAuth = async () => null;
    const sameSpace = (a, b) => a.spaceId === b.spaceId && a.generation === b.generation;
    const setRestoreError = () => {}, setAuthSession = () => {}, setAuthGuest = () => { guests++ };
    const clearAuthSession = () => {}, promptForAuth = () => {}, setView = () => {};
    const sessionStorage = { getItem() { return null } }, SPACE_SWITCH_VIEW_KEY = 'view';
    ${restoreCode}
    ${lifecycleCode}
    return { mount: () => {
      const cleanups = effects.map(effect => effect());
      return () => cleanups.forEach(cleanup => cleanup?.());
    }, guests: () => guests };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText
  const makeLifecycle = new Function('restoreRetry', compiled) as
    (retry: ReturnType<typeof retryNativeAuthRestore>) => { mount: () => () => void; guests: () => number }
  const replay = makeLifecycle(retryNativeAuthRestore())
  replay.mount()()
  const unmount = replay.mount()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(replay.guests(), 1)
  unmount()
  const disposed = makeLifecycle(retryNativeAuthRestore())
  disposed.mount()()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed.guests(), 0)
})

test('only network, timeout and 5xx restore errors retry; 401 retains native clearing', async () => {
  for (const error of [new ApiError('network', 'offline'), new ApiError('timeout', 'timeout'), new ApiError('http', 'unavailable', { status: 503 })]) {
    assert.equal(isRetryableRestoreError(error), true)
  }
  for (const error of [new Error('other'), new ApiError('aborted', 'aborted'), new ApiError('http', 'invalid', { status: 401 }), new ApiError('http', 'forbidden', { status: 403 })]) {
    assert.equal(isRetryableRestoreError(error), false)
  }
  active = { ...candidate }
  response = async () => ({ status: 401, value: {} })
  assert.equal(await restoreNativeAuth(), null)
  assert.ok(calls.includes('clear_auth_session'))
})

test('notification multi-step action stops on same-user generation change and pins every request', async () => {
  active = { ...candidate }
  useStore.getState().setAuthSession(user, active)
  useStore.setState({ spacePending: false })
  const { serverEntry } = await import('../src/lib/notification-center.ts')
  const entry = serverEntry({ id: 'request-1', type: 'join_request', payload: { teamId: 'team-1', requestId: 'join-1', displayName: 'Member', teamName: 'Team' }, read: false, createdAt: new Date().toISOString() })
  let click: (() => void) | undefined
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (!node || typeof node !== 'object' || !('props' in node)) return
    const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>
    if (element.type === 'button' && element.props.children === '通过') click = element.props.onClick
    visit(element.props.children)
  }
  function Capture(): null { visit(NotificationCenter({ entries: [entry], onClose: () => {} })); return null }
  renderToStaticMarkup(createElement(Capture))
  assert.ok(click)
  response = async () => {
    active = { ...candidate, generation: candidate.generation + 1 }
    useStore.getState().setAuthSession(user, active)
    return { status: 200, value: {} }
  }
  click()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].space, candidate)
  assert.equal(useStore.getState().currentUser?.id, user.id)
})

test('App shell siblings have distinct keys and Sidebar survives space changes', () => {
  const file = ts.createSourceFile('App.tsx', source('App.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let shell: ts.JsxElement | undefined
  const find = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attr =>
      ts.isJsxAttribute(attr) && attr.name.getText(file) === 'className'
      && attr.initializer && ts.isStringLiteral(attr.initializer) && attr.initializer.text === 'app-shell')) shell = node
    ts.forEachChild(node, find)
  }
  find(file)
  assert.ok(shell)
  const keys: string[] = []
  let sidebarFound = false
  const directChild = (node: ts.Node): void => {
    const element = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null
    if (element) {
      const key = element.attributes.properties.find(attr => ts.isJsxAttribute(attr) && attr.name.getText(file) === 'key')
      if (element.tagName.getText(file) === 'Sidebar') {
        sidebarFound = true
        assert.equal(key, undefined, 'Sidebar must not remount by space')
      }
      if (key && ts.isJsxAttribute(key)) keys.push(key.initializer!.getText(file))
      return
    }
    ts.forEachChild(node, directChild)
  }
  shell.children.forEach(directChild)
  assert.ok(sidebarFound)
  assert.equal(new Set(keys).size, keys.length)
  assert.doesNotMatch(source('App.tsx'), /key=\{spaceKey\}/)
})

test('closing a connection resets selection to the active profile, including a changed generation', () => {
  for (const space of [original, candidate, { spaceId: 'local', generation: 3 }]) {
    assert.equal(selectedServiceProfile(space, 'official'), 'official')
    assert.equal(selectedServiceProfile(space, 'selfhost'), 'selfhost')
    assert.equal(selectedServiceProfile({ ...space, generation: 8 }), spaceProfile(space))
  }
  assert.match(source('components/ServiceSettings.tsx'), /addEventListener\('skillhub-connect-closed', resetSelection\)/)
  assert.match(source('App.tsx'), /dispatchEvent\(new Event\('skillhub-connect-closed'\)\)/)
  assert.equal(displayServerAddress(' http://127.0.0.1:3001/ '), 'http://127.0.0.1:3001')
})

test('unconfigured AI and avatars are warnings, never passing or blocking checks', () => {
  for (const enabled of [false, true]) {
    const report = {
      origin: 'https://selfhost.test',
      checks: ['ai', 'avatars'].map(item => ({ item, state: 'pass' as const, message: enabled ? '已配置' : '未配置' })),
      error: null,
      info: { status: 'ok', features: { ai: enabled, avatars: enabled } },
      deployment: { profile: 'selfhost' as const },
    }
    const checks = connectionChecks(report).filter(check => check.item === 'ai' || check.item === 'avatars')
    assert.ok(checks.every(check => check.state === (enabled ? 'pass' : 'actionRequired')))
    assert.equal(report.error, null)
    const markup = renderToStaticMarkup(createElement(ConnectionChecklist, { report }))
    assert.match(markup, enabled ? /data-state="pass"/ : /data-state="actionRequired"/)
  }
})

test('checks skipped after a blocker stay neutral, including absent report rows', () => {
  for (const includeSkippedRows of [false, true]) {
    const report = {
      origin: null,
      checks: [
        { item: 'security', state: 'blocked' as const, message: '连接安全被阻止' },
        ...(includeSkippedRows ? CONNECTION_ITEMS.slice(1).map(([item]) => ({ item, state: 'unavailable' as const, message: '尚未验证' })) : []),
      ],
      error: { code: 'insecure_origin', message: '连接安全被阻止' },
      info: null,
      deployment: null,
    }
    assert.deepEqual(connectionChecks(report).map(check => check.state), ['blocked', ...Array(5).fill('unavailable')])
    const markup = renderToStaticMarkup(createElement(ConnectionChecklist, { report }))
    const skippedRows = markup.match(/<li[^>]*data-state="unavailable"[^>]*>[^]*?<\/li>/g) ?? []
    assert.equal(skippedRows.length, 5)
    for (const row of skippedRows) {
      assert.match(row, /aria-label="尚未验证"/)
      assert.match(row, /lucide-info/)
      assert.doesNotMatch(row, /需要处理|circle-alert/)
    }
  }
  const css = source('components/ConnectServerDialog.css')
  assert.match(css, /\.connection-check-icon \{[^}]*color: var\(--color-muted\);[^}]*background: var\(--color-surface-sunken\);/)
  assert.match(css, /\[data-state='actionRequired'\] \.connection-check-icon \{[^}]*color: var\(--color-warning\);/)
})

test('connection actions keep one primary, align right and explain setup and sign-out', () => {
  const dialog = source('components/ConnectServerDialog.tsx')
  const service = source('components/ServiceSettings.tsx')
  assert.match(dialog, /className="btn btn-ghost"[^>]*onClick=\{\(\) => void test\(\)\}/)
  assert.match(source('components/ConnectServerDialog.css'), /\.connection-address \.btn \{[^}]*height: 40px;/)
  assert.match(service, /const showConnectButton = !currentServer && Boolean\(report\?\.deployment\) && !report\?\.error/)
  assert.match(service, /className=\{`btn \$\{showConnectButton \? 'btn-ghost' : 'btn-primary'\}`\}/)
  assert.match(service, /\{showConnectButton && \(\s*<div className="settings-row-actions">\s*<button[^\n]*>连接到这台服务器<\/button>/)
  assert.match(source('pages/SettingsPage.css'), /\.settings-row-actions \{[^}]*display: flex;[^}]*justify-content: flex-end;/)
  assert.match(dialog, /<p className="connection-caption">初始化码显示在启动服务器的终端里，30 分钟内有效。重启服务器会换一个新码。<\/p>\s*<DeploymentHelp setup \/>/)
  assert.match(source('components/AccountSettings.tsx'), /onClick=\{\(\) => void signOut\(\)\}>\{signingOut \? '正在退出所有设备…' : '退出所有设备'\}/)
})

test('one complete confirmation answers the migration hook and returns to settings once', () => {
  const dialog = source('components/ConnectServerDialog.tsx')
  assert.match(dialog, /if \(closed.current\) return '取消'/)
  assert.match(dialog, /if \(rebind\) return '只切换'/)
  assert.match(dialog, /return migration.begin\(from, candidate, migrationSource\)/)
  assert.match(dialog, /className="modal-head"/)
  assert.match(dialog, /className="modal-copy"/)
  assert.match(dialog, /切换到仅本机？/)
  assert.match(dialog, /sessionStorage.setItem\(SPACE_SWITCH_VIEW_KEY, 'settings'\)/)
  const app = source('App.tsx')
  assert.match(app, /sessionStorage.removeItem\(SPACE_SWITCH_VIEW_KEY\)\s*setView\('settings'\)/)
})

test('connection layout overrides the later shared card rules and keeps only its body scrollable', () => {
  const css = source('components/ConnectServerDialog.css')
  assert.match(css, /\.modal-card\.connect-server-dialog\s*\{[^}]*overflow: hidden;/)
  assert.match(css, /\.connection-form\s*\{[^}]*min-height: 0;/)
  assert.match(css, /\.connection-dialog-body\s*\{[^}]*overflow-y: auto;[^}]*min-height: 0;/)
  assert.match(css, /\.connection-dialog-body\s*>\s*\*\s*\{[^}]*flex-shrink:\s*0;/)
  assert.match(css, /\.connect-server-dialog \.modal-actions\s*\{[^}]*flex: none;/)
  assert.match(css, /\.service-settings > \.service-cards \{ padding: var\(--space-4\); \}/)
  assert.match(source('components/AccountSettings.css'), /\.account-settings:not\(:last-child\) \{ border-bottom: 1px solid var\(--color-line\); \}/)
  assert.match(source('components/AuthDialog.css'), /\.auth-dialog-form input, \.form-input\s*\{[^}]*height: 40px;/)
  assert.doesNotMatch(css, /font(?:-size)?:[^;\n]*\dpx/)
})

test('setup 201 is verified by status and me before committing; no token reaches the result', async () => {
  const result = await authenticateSelfhost(candidate, 'setup', { email: 'a@example.test', password: 'password', displayName: 'A', code: 'setup' })
  assert.deepEqual(requests.map(request => request.route), ['setup.admin', 'setup.status', 'auth.me'])
  assert.deepEqual(result, { user, initialized: true })
  assert.equal(calls.includes('commit_space_switch'), false)
})

for (const status of [401, 410, 429]) test(`setup ${status} keeps source and displays actionable error without another create`, async () => {
  response = async () => ({ status, value: { message: 'rejected' }, retry: '30' })
  await assert.rejects(authenticateSelfhost(candidate, 'setup', { email: 'a@b.test', password: 'password', code: 'code' }), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, status)
    assert.match(setupErrorMessage(error), status === 401 ? /初始化码不正确/ : status === 410 ? /重启/ : /30 秒/)
    return true
  })
  assert.deepEqual(active, original)
  assert.equal(requests.length, 1)
})

test('setup 409 reads status and returns to login without automatically authenticating', async () => {
  response = async request => request.route === 'setup.admin' ? { status: 409, value: {} } : { status: 200, value: { initialized: true } }
  await assert.rejects(authenticateSelfhost(candidate, 'setup', { email: 'a@b.test', password: 'password' }), /已初始化/)
  assert.deepEqual(requests.map(request => request.route), ['setup.admin', 'setup.status'])
})

test('lost setup response reconciles status and logs in once, never creates twice', async () => {
  response = async request => {
    if (request.route === 'setup.admin') throw new Error('connection lost')
    return { status: 200, value: request.route === 'setup.status' ? { initialized: true } : { user } }
  }
  assert.equal((await authenticateSelfhost(candidate, 'setup', { email: 'a@b.test', password: 'password' })).initialized, true)
  assert.deepEqual(requests.map(request => request.route), ['setup.admin', 'setup.status', 'auth.login', 'setup.status', 'auth.me'])
})

test('created administrator is reported even if the subsequent verification fails', async () => {
  let initialized = false
  response = async request => {
    if (request.route === 'setup.status') throw new Error('offline after create')
    return { status: 201, value: { user } }
  }
  await assert.rejects(authenticateSelfhost(candidate, 'setup', { email: 'a@b.test', password: 'password' }, () => { initialized = true }), /offline after create/)
  assert.equal(initialized, true)
  assert.equal(requests.filter(request => request.route === 'setup.admin').length, 1)
})

test('native security errors have no bypass and HTTP explains the loopback exception', () => {
  const checks = connectionChecks({ origin: null, checks: [{ item: 'security', state: 'blocked', message: '非本机回环地址必须使用 HTTPS，请检查服务器地址' }], error: null, info: null, deployment: null })
  assert.match(checks[0].message, /需要 HTTPS.*localhost.*127\/8.*::1/)
  for (const message of ['证书不受信任', '证书已过期', '域名不匹配']) {
    const report = { origin: null, checks: [{ item: 'security', state: 'blocked' as const, message }], error: { code: 'certificate_error', message }, info: null, deployment: null }
    assert.ok(renderToStaticMarkup(createElement(ConnectionChecklist, { report })).includes(message))
  }
})

test('sign-in succeeds only after me; failures never clear source auth', async () => {
  assert.deepEqual(await authenticateSelfhost(candidate, 'login', { email: 'a@b.test', password: 'password' }), { user, initialized: false })
  response = async () => ({ status: 401, value: { message: 'wrong password' } })
  await assert.rejects(authenticateSelfhost(candidate, 'login', { email: 'a@b.test', password: 'wrong' }), /wrong password/)
  assert.deepEqual(active, original)
  assert.equal(calls.includes('clear_auth_session'), false)
})

test('open/invite offer registration, closed hides it; invite code is distinct from setup code', async () => {
  const ui = source('components/ConnectServerDialog.tsx')
  assert.match(ui, /registration !== 'closed'/)
  assert.match(ui, /register && registration === 'invite'/)
  await authenticateSelfhost(candidate, 'register', { email: 'a@b.test', displayName: 'A', password: 'password', inviteCode: 'invite' })
  assert.equal(requests[0].route, 'auth.register')
  assert.deepEqual(requests[0].body, { kind: 'json', value: { email: 'a@b.test', displayName: 'A', password: 'password', inviteCode: 'invite' } })
})

test('cancel restores source through phase A and never commits, including local', async () => {
  for (const target of ['local', 'https://selfhost.test']) {
    calls = []
    assert.equal(await switchSpace(original, target, async () => {}, async () => '取消'), null)
    assert.equal(active.spaceId, original.spaceId)
    assert.equal(calls.includes('cancel_space_switch'), true)
    assert.equal(calls.includes('commit_space_switch'), false)
  }
})

test('successful switch waits for auth and the explicit hook; auth failure cancels', async () => {
  let authenticated = false
  const result = await switchSpace(original, 'https://selfhost.test', async () => { authenticated = true }, async () => { assert.equal(authenticated, true); return '只切换' })
  assert.equal(result?.spaceId, candidate.spaceId)
  assert.equal(calls.includes('cancel_space_switch'), false)
  calls = []
  await assert.rejects(switchSpace(original, 'https://selfhost.test', async () => { throw new Error('bad login') }, async () => '只切换'), /bad login/)
  assert.equal(calls.includes('commit_space_switch'), false)
  assert.equal(active.spaceId, original.spaceId)
})

for (const choice of ['迁移并切换', '只切换', '取消'] as const) test(`beforeCommit ${choice} maps to the correct transaction action`, async () => {
  const result = await switchSpace(original, 'https://selfhost.test', async () => {}, async () => choice)
  assert.equal(calls.includes('commit_space_switch'), choice !== '取消')
  assert.equal(calls.includes('cancel_space_switch'), choice === '取消')
  assert.equal(result === null, choice === '取消')
})

test('candidate response arriving after a generation change is dropped', async () => {
  response = async () => { active = { ...original, generation: 8 }; return { status: 200, value: { user } } }
  await assert.rejects(apiCandidate(candidate, '/auth/me'), /空间已切换/)
})

test('capability matrix fails closed, honors explicit official features and separates upload from generation', () => {
  const info = { status: 'ok', capabilities: ['skills.library-sync.v1', 'skills.library-organizer.v1', 'teams.management.v1', 'runtime.env.v1', 'media.picem.v1', 'skills.avatars.v1', 'skills.packages.v1'], features: { ai: false, avatars: false, marketplace: false } }
  for (const space of [null, { spaceId: 'local', generation: 1 }]) {
    const caps = spaceCapabilities(space, info)
    for (const [name, value] of Object.entries(caps)) if (name !== 'profile') assert.equal(value, false, name)
  }
  const hosted = spaceCapabilities(candidate, info)
  assert.equal(hosted.teams, true); assert.equal(hosted.library, true); assert.equal(hosted.organizer, true); assert.equal(hosted.teamKeys, true)
  assert.equal(hosted.ai, false); assert.equal(hosted.avatars, false); assert.equal(hosted.avatarUpload, true); assert.equal(hosted.marketplace, false)
  assert.equal(spaceCapabilities(candidate, null).teams, false)
  assert.equal(spaceCapabilities(candidate, { status: 'ok' }).teamKeys, false)
  assert.equal(spaceCapabilities(original, { status: 'ok' }).ai, true)
  assert.equal(spaceCapabilities(original, info).ai, false)
  assert.equal(spaceCapabilities(original, info, true).account, false)
})

test('same UUID in another space resets account state and generation events require the full handle', () => {
  useStore.getState().setAuthSession(user, original)
  useStore.setState({ notifications: [{ id: 'old', type: 'test', payload: {}, read: false, createdAt: '' }], aiAnalysisJobs: {}, activeTeamId: 'old-team' })
  useStore.getState().setAuthSession(user, candidate)
  assert.deepEqual(useStore.getState().notifications, [])
  assert.deepEqual(useStore.getState().skills, [])
  assert.equal(useStore.getState().activeTeamId, null)
  useStore.getState().resetSpace({ ...original, generation: 4 }, true)
  assert.equal(useStore.getState().currentUser, null)
  assert.equal(useStore.getState().serverInfo, null)
  assert.deepEqual(useStore.getState().marketplaceSkills, [])
  const app = source('App.tsx')
  assert.match(app, /sameSpace\(current, payload.space\)/)
  assert.match(app, /sameSpace\(payload.space, useStore.getState\(\).authSpace\)/)
  assert.match(app, /checkForAppUpdate\(\{ silent: true \}\)/)
  assert.match(app, /!activeSpace \|\| spacePending \|\| \(capabilities.profile !== 'local' && !serverInfo\)/)
  assert.match(app, /KeyConsentDialog key=\{`consent:\$\{spaceKey\}`\}/)
  assert.match(source('components/KeyConsentDialog.tsx'), /grantKeyAccess\(skillId, key, once, account, variant, space\)/)
  const native = readFileSync(new URL('../src-tauri/src/runtime_env.rs', import.meta.url), 'utf8')
  assert.match(native, /if let \(true, Some\(server_skill_id\), Some\(current_auth_token\)\) = \(\s+include_team_sources.unwrap_or\(true\)/)
})
