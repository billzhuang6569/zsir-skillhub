import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import { Children, isValidElement, type ReactNode, type ReactElement } from 'react'
import { serverFixture } from './helpers/server-ipc.ts'
import { AI_PROTOCOLS, aiForm, aiDraft, changeAiForm, canSaveAi, maskedAiKey, INSTANCE_ERRORS, instanceError, analysisConfirmation,
  isServerUnanalysed, lastAdministrator, instanceSummary } from '../src/lib/instance-settings.ts'
import type { InstanceAiSettings, InstanceMember, InstanceOverview } from '../src/lib/api.ts'
import { readLocalInferencePreference, saveLocalInferencePreference, localInferenceError, localInferenceStatus, canTestLocalInference, LOCAL_INFERENCE_ERRORS, acceptLocalWorkerStatus } from '../src/lib/local-inference.ts'
import type { LocalInferenceProbe } from '../src/lib/tauri.ts'
import { falForm, canSaveFal, falError, styleGallery, styleConfirmation, styleApplyInput, canManageAvatarStyle } from '../src/lib/avatar-settings.ts'
import type { AvatarStyle, AvatarStylePreview, AvatarStyleSelection } from '../src/lib/api.ts'

const space = { spaceId: 'selfhost-test', generation: 8 }
const saved: InstanceAiSettings = { source: 'setting', protocol: 'openai', baseUrl: 'https://ai.test/v1', model: 'model', keyLast4: '1234',
  limits: { instanceDaily: 200, perUserDaily: 50 }, allowedPrivateHosts: [], lastTest: null }
const member: InstanceMember = { id: 'member', displayName: '成员', email: 'member@example.test', role: 'member', createdAt: '2026-10-18' }
const admin: InstanceMember = { ...member, id: 'admin', role: 'admin' }
const overview: InstanceOverview = { memberCount: 1, registration: { mode: 'invite', source: 'setting', inviteCodeMask: '••••abcd' },
  addresses: { primary: { baseUrl: 'http://127.0.0.1:3001', https: false }, additional: [] },
  storage: { provider: 'builtin', media: { bytes: 10, complete: false }, cards: { bytes: 20, complete: true }, measuredAt: '' },
  aiUsage: { used: 3, limit: 200 }, version: { server: '0.31.0', buildId: 'fixture' }, minClientVersion: null }

test('AI draft changes invalidate test tokens, saved keys are masked and replacement is explicit', () => {
  const form = { ...aiForm(saved), draftToken: 'passed' }
  assert.equal(canSaveAi(form, false), true)
  assert.equal(canSaveAi(form, true), false)
  for (const change of [{ model: 'new' }, { baseUrl: 'https://other.test' }, { protocol: 'anthropic' as const }, { apiKey: 'replacement' },
    { limits: { instanceDaily: 1, perUserDaily: 1 } }, { allowedPrivateHosts: ['localhost:1234'] }, { replacingKey: true }]) {
    assert.equal(canSaveAi(changeAiForm(form, change), false), false)
  }
  assert.equal(aiDraft(form).apiKey, undefined)
  assert.equal(aiDraft(changeAiForm(form, { replacingKey: true, apiKey: 'replacement' })).apiKey, 'replacement')
  assert.equal(maskedAiKey('1234'), '•••• 1234（末 4 位）')
  assert.equal(maskedAiKey(null), '•••• 已保存')
  assert.deepEqual(AI_PROTOCOLS.map(item => item.value), ['openai', 'anthropic', 'openai-responses'])
})
test('all instance errors are Chinese and never echo raw supplier text', () => {
  for (const code of Object.keys(INSTANCE_ERRORS)) assert.match(instanceError({ code, message: 'secret provider payload' }), /[\u4e00-\u9fff]/)
  assert.doesNotMatch(instanceError(new Error('secret provider payload')), /secret|payload/)
  assert.match(instanceError({ code: 'SSRF_BLOCKED' }), /允许列表/)
  assert.match(instanceError({ code: 'LAST_ADMIN' }), /至少保留一名/)
})
test('server unanalysed is separate from local analysis and guarded by selfhost profile', () => {
  for (const profile of ['official', 'local', 'selfhost']) for (const status of ['unanalysed', 'completed', 'local', 'fallback', undefined]) {
    assert.equal(isServerUnanalysed(profile, status), profile === 'selfhost' && status === 'unanalysed')
  }
  assert.equal(lastAdministrator(admin, [admin, member]), true)
  assert.equal(lastAdministrator(admin, [admin, { ...admin, id: 'another' }]), false)
  assert.equal(lastAdministrator(member, [admin, member]), false)
})

// Exercise actual component handlers with deterministic hooks, without adding a DOM dependency.
type Element = ReactElement<Record<string, unknown>>
type Harness = { values: unknown[]; cursor: number; effects: Array<() => unknown>; cleanups: Array<() => void>; state: Record<string, unknown> }
let harness: Harness
const globals = globalThis as typeof globalThis & { instanceHarness?: Harness }
const componentNames = /\/(?:(AvatarSettings|InstanceAiSettings|LocalInferenceSettings|InstanceSettingsPage|ServiceSettings|SegmentedControl|Toast)\.tsx|media\.ts)$/
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'react' && componentNames.test(context.parentURL ?? '')) return { url: 'fixture:react', shortCircuit: true }
  if (specifier.endsWith('/store/index.js') && (componentNames.test(context.parentURL ?? '') || context.parentURL?.endsWith('/use-space-capabilities.ts'))) return { url: 'fixture:store', shortCircuit: true }
  if (context.parentURL?.includes('/desktop/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
    for (const ext of ['.ts', '.tsx']) { const url = new URL(specifier.replace(/\.js$/, ext), context.parentURL); if (existsSync(fileURLToPath(url))) return next(url.href, context) }
  }
  return next(specifier, context)
}, load(url, context, next) {
  if (url === 'fixture:react') return { format: 'module', shortCircuit: true, source: `
    export const Fragment = Symbol.for('react.fragment');
    const h = () => globalThis.instanceHarness;
    export function useState(initial) { const s=h(), i=s.cursor++; if (!(i in s.values)) s.values[i]=typeof initial==='function'?initial():initial; return [s.values[i], v=>{s.values[i]=typeof v==='function'?v(s.values[i]):v}]; }
    export function useRef(initial) { return useState({current:initial})[0]; }
    export function useEffect(effect,deps) { const s=h(), i=s.cursor++, old=s.values[i]; if(!old || deps.some((v,j)=>v!==old[j])) {s.values[i]=deps; s.effects.push(effect)} }
    export const useLayoutEffect = useEffect;
    export function useSyncExternalStore(subscribe,get) { return get(); }
    export function useCallback(fn,deps) { const s=h(), i=s.cursor++, old=s.values[i]; if(!old || deps.some((v,j)=>v!==old.deps[j])) s.values[i]={fn,deps}; return s.values[i].fn; }
  ` }
  if (url === 'fixture:store') return { format: 'module', shortCircuit: true, source: `
    export const useStore = selector=>selector(globalThis.instanceHarness.state);
    useStore.getState=()=>globalThis.instanceHarness.state;
    useStore.setState=fn=>Object.assign(globalThis.instanceHarness.state, typeof fn==='function'?fn(globalThis.instanceHarness.state):fn);
  ` }
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' }
  if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText }
  return next(url, context)
} })
const { default: AiSettingsComponent } = await import('../src/components/InstanceAiSettings.tsx')
const { default: AvatarSettings } = await import('../src/components/AvatarSettings.tsx')
const { default: ToastContainer } = await import('../src/components/Toast.tsx')
const { setMediaContext } = await import('../src/lib/media.ts')
const { default: LocalSettings } = await import('../src/components/LocalInferenceSettings.tsx')
const { default: InstancePage } = await import('../src/pages/InstanceSettingsPage.tsx')
const { default: ServiceSettings } = await import('../src/components/ServiceSettings.tsx')
const { SegmentedControl } = await import('../src/components/SegmentedControl.tsx')
const { default: DocHelp } = await import('../src/components/DocHelp.tsx')
const { PageHeading } = await import('../src/components/PageHeading.tsx')
const { mergeApiSkill } = await import('../src/lib/skills.ts')
const { withAnalyzedProfile } = await import('../src/lib/ai-analysis-job.ts')
const { reconcileLocalSkillRefresh } = await import('../src/lib/ui-helpers.ts')
const { startInstanceAnalysis, instanceAnalysisTask } = await import('../src/lib/instance-analysis-batch.ts')
hooks.deregister()

function setup(): void {
  harness = { values: [], cursor: 0, effects: [], cleanups: [], state: { currentUser: { id: 'admin', marketplaceRole: 'admin' }, serverInfo: null, activeSpace: space } }
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) }, clear: () => storage.clear() } })
  globals.instanceHarness = harness
  setMediaContext(null)
  serverFixture.space = space; serverFixture.userId = 'admin'
  Object.assign(window, { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {}, setTimeout, clearTimeout })
}
function render(component: () => ReactNode): ReactNode {
  harness.cursor = 0
  const tree = component()
  for (const effect of harness.effects.splice(0)) { const cleanup = effect(); if (typeof cleanup === 'function') harness.cleanups.push(cleanup as () => void) }
  return tree
}
function elements(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap(child => isValidElement<Record<string, unknown>>(child) ? [child, ...elements(child.props.children as ReactNode)] : [])
}
function textOf(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<Record<string, unknown>>(child) ? textOf(child.props.children as ReactNode) : String(child)).join('')
}
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)) }
function button(tree: ReactNode, label: string): Element {
  const result = elements(tree).find(item => item.type === 'button' && textOf(item.props.children as ReactNode) === label)
  assert.ok(result, label); return result
}
function click(element: Element): void { (element.props.onClick as () => void)() }
function cleanup(): void { harness.cleanups.forEach(fn => fn()) }

const avatarStyles: AvatarStyle[] = Array.from({ length: 8 }, (_, i) => ({ styleId: `style-${i}`, styleVersion: 1, status: 'published',
  name: { zh: `风格 ${i}`, en: `Style ${i}` }, description: { zh: '简洁的说明', en: 'Description' }, preview: { url: null, license: 'CC0', attribution: 'SkillHub' } }))
const avatarSelection: AvatarStyleSelection = { accountStyleId: null, instanceStyleId: 'style-7', styleId: 'style-7', styleVersion: 1, scope: 'instance', canManage: true }
const avatarPreview: AvatarStylePreview = { scope: 'instance', currentStyleId: 'style-7', targetStyleId: 'style-0', targetStyleVersion: 1,
  total: 10, reusable: 2, needsGeneration: 5, customSkipped: 2, inFlight: 1, estimatedCostUsd: 0.4, perImageUsd: 0.08,
  quota: { limit: 10, used: 7, remaining: 3 }, coverable: 3 }
type AvatarCall = { path: string; method: string; body: Record<string, unknown> | null }
function setupAvatars(options: { configured?: boolean; env?: boolean; member?: boolean; legacy?: boolean; styles?: AvatarStyle[]; preview?: Partial<AvatarStylePreview> } = {}): AvatarCall[] {
  setup()
  harness.state.currentUser = { id: 'admin', marketplaceRole: options.member ? 'user' : 'admin' }
  harness.state.serverInfo = { features: { ai: false, avatars: options.configured ?? true } }
  const calls: AvatarCall[] = []
  serverFixture.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null })
    if (path.endsWith('/fal/test')) return Response.json({ ok: true, latencyMs: 1, draftToken: 'passed' })
    if (path.endsWith('/fal')) {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return Response.json({ configured: options.configured ?? true, source: options.env ? 'env' : options.configured === false ? 'none' : 'setting', masked: '••••1234', lastTest: { ok: true, at: '2026-10-18T00:00:00Z' } })
    }
    if (path.endsWith('/style')) return options.legacy ? new Response(null, { status: 404 }) : Response.json({ ...avatarSelection, canManage: !options.member })
    if (path.endsWith('/preview')) return Response.json({ ...avatarPreview, ...options.preview })
    if (path.endsWith('/apply')) return Response.json({ styleId: 'style-0', styleVersion: 1, reused: 2, queued: 3, skippedCustom: 2, deferredByQuota: 2, cancelledUnsubmitted: 1 })
    return Response.json(options.styles ?? avatarStyles)
  }
  return calls
}
const avatarComponent = (): ReactNode => AvatarSettings({ space, admin: true, selfhost: true })
function changeFal(tree: ReactNode, value: string): void {
  const input = elements(tree).find(item => item.props.id === 'instance-fal-key')!
  ;(input.props.onChange as (event: unknown) => void)({ target: { value } })
}

test('fal receipts cannot save untested, edited, expired, busy or env forms; errors never echo raw text', () => {
  const untested = falForm('fixture-key-123456')
  assert.equal(canSaveFal(untested, 'none', false, 0), false)
  const tested = { ...untested, draftToken: 'passed', expiresAt: 600_000 }
  assert.equal(canSaveFal(tested, 'setting', false, 599_999), true)
  assert.equal(canSaveFal(tested, 'setting', false, 600_000), false)
  assert.equal(canSaveFal(tested, 'setting', true, 1), false)
  assert.equal(canSaveFal(tested, 'env', false, 1), false)
  assert.equal(canSaveFal(falForm('changed-key'), 'setting', false, 1), false)
  for (const code of ['FAL_KEY_INVALID', 'FAL_UNREACHABLE', 'TEST_REQUIRED', 'ENV_OVERRIDE', 'UNKNOWN']) {
    const message = falError({ code, message: 'secret-fixture-key' })
    assert.match(message, /[\u4e00-\u9fff]/); assert.doesNotMatch(message, /secret-fixture/)
  }
  assert.equal(falError({ code: 'FAL_KEY_INVALID' }), 'Key 无效或已被撤销')
  assert.equal(falError({ code: 'FAL_UNREACHABLE' }), '无法连接 fal.ai，请检查服务器网络')
})

test('gallery preserves catalog order and only replaces the last collapsed slot for an off-row selection', () => {
  const gallery = styleGallery([...avatarStyles, { ...avatarStyles[0], styleId: 'draft', status: 'test' }], 'style-7', false)
  assert.deepEqual(gallery.visible.map(style => style.styleId), ['style-0', 'style-1', 'style-2', 'style-3', 'style-4', 'style-7'])
  assert.equal(gallery.total, 8); assert.equal(gallery.canExpand, true)
  assert.equal(styleGallery(avatarStyles.slice(0, 6), 'style-0', false).canExpand, false)
  for (const current of ['style-0', 'style-4', 'style-6', 'style-7', 'missing']) {
    assert.deepEqual(styleGallery(avatarStyles, current, true).visible, avatarStyles)
  }
  assert.deepEqual(styleGallery(avatarStyles, 'style-4', false).visible, avatarStyles.slice(0, 6))
  assert.deepEqual(styleGallery(avatarStyles.slice(0, 2), 'style-1', false).visible, avatarStyles.slice(0, 2))
  assert.deepEqual(styleGallery(avatarStyles, 'missing', false).visible, avatarStyles.slice(0, 6))
  assert.deepEqual(styleGallery([], 'missing', false).visible, [])
  const narrow = styleGallery(avatarStyles, 'style-7', false, 3)
  assert.deepEqual(narrow.visible.map(style => style.styleId), ['style-0', 'style-1', 'style-7'])
  assert.deepEqual(styleGallery(avatarStyles, 'style-7', false, 2).visible.map(style => style.styleId), ['style-0', 'style-7'])
  assert.deepEqual(styleConfirmation(avatarPreview), [
    { label: '可复用', value: '2 个' }, { label: '需生成', value: '5 个' },
    { label: '预计费用', value: '约 $0.40，以 fal.ai 实际计费为准' },
    { label: '跳过的自定义头像', value: '2 个' }, { label: '今日剩余额度', value: '3/10' },
    { label: '进行中', value: '1 个' },
  ])
  const unknown = styleConfirmation({ ...avatarPreview, estimatedCostUsd: null, scope: 'account', coverable: 5, inFlight: 0 })
  assert.equal(unknown.find(row => row.label === '预计费用')?.value, '以 fal.ai 实际计费为准')
  assert.ok(!unknown.some(row => row.label === '进行中'))
  assert.equal(styleApplyInput('x', 'applyExisting', true).includeCustom, true)
  assert.equal(styleApplyInput('x', 'newOnly', true).includeCustom, false)
  assert.equal(canManageAvatarStyle(avatarSelection, true, false), false)
  assert.equal(canManageAvatarStyle({ ...avatarSelection, canManage: false }, true, true), false)
  assert.equal(canManageAvatarStyle(avatarSelection, false, false), true)
})

test('style cost copy prioritizes no generation and preserves unknown or estimated costs otherwise', () => {
  for (const [needsGeneration, estimatedCostUsd, expected] of [
    [0, 0, '无需生成，不产生费用'],
    [0, null, '无需生成，不产生费用'],
    [2, null, '以 fal.ai 实际计费为准'],
    [2, 0.16, '约 $0.16，以 fal.ai 实际计费为准'],
    [2, 0, '约 $0.00，以 fal.ai 实际计费为准'],
  ] as const) {
    const rows = styleConfirmation({ ...avatarPreview, needsGeneration, estimatedCostUsd })
    assert.equal(rows.find(row => row.label === '预计费用')?.value, expected)
  }
})

test('fal component requires a current test, clears on edit and consumes receipt on failed save', async () => {
  const calls = setupAvatars()
  render(avatarComponent); await flush(); let tree = render(avatarComponent)
  assert.ok(calls.every(call => call.method === 'GET'))
  assert.match(textOf(tree), /••••1234.*最近测试/)
  click(button(tree, '更换')); tree = render(avatarComponent)
  assert.equal(button(tree, '保存').props.disabled, true)
  changeFal(tree, 'fixture-key-123456'); tree = render(avatarComponent)
  click(button(tree, '测试')); await flush(); tree = render(avatarComponent)
  assert.equal(button(tree, '保存').props.disabled, false)
  changeFal(tree, 'fixture-key-changed'); tree = render(avatarComponent)
  assert.equal(button(tree, '保存').props.disabled, true)
  click(button(tree, '测试')); await flush(); tree = render(avatarComponent)
  const responder = serverFixture.fetch
  serverFixture.fetch = async (input, init) => init?.method === 'PUT' ? Response.json({ code: 'TEST_REQUIRED' }, { status: 409 }) : responder(input, init)
  click(button(tree, '保存')); await flush(); tree = render(avatarComponent)
  assert.equal(button(tree, '保存').props.disabled, true); assert.match(textOf(tree), /请重新测试后保存/)
  cleanup()
})

test('member and env views are read only; legacy hides gallery; disabled official service makes no requests', async () => {
  for (const options of [{ member: true }, { env: true }, { legacy: true }]) {
    const calls = setupAvatars(options)
    const view = (): ReactNode => AvatarSettings({ space, admin: !('member' in options), selfhost: true })
    render(view); await flush(); const tree = render(view)
    if ('member' in options || 'env' in options) assert.ok(!elements(tree).some(item => item.type === 'input' || item.type === 'button' && ['更换', '删除', '测试', '保存'].includes(textOf(item.props.children as ReactNode))))
    if ('member' in options) {
      assert.ok(!calls.some(call => call.path.includes('/fal')))
      assert.doesNotMatch(textOf(tree), /使用此风格|••••/)
      assert.match(textOf(tree), /当前风格/)
    }
    if ('env' in options) assert.match(textOf(tree), /由服务器环境变量提供/)
    if ('legacy' in options) { assert.doesNotMatch(textOf(tree), /当前风格|使用此风格|显示全部/); assert.ok(!calls.some(call => call.path.endsWith('/avatar-styles'))) }
    cleanup()
  }
  const calls = setupAvatars({ configured: false })
  const official = (): ReactNode => AvatarSettings({ space, admin: false, selfhost: false })
  render(official); await flush()
  assert.match(textOf(render(official)), /官方头像服务未启用/); assert.equal(calls.length, 0)
  cleanup()
})

test('style selection previews only on click, cancel writes nothing, custom checkbox maps apply body and refreshes lists', async () => {
  const calls = setupAvatars()
  const events: string[] = []
  window.dispatchEvent = (event: Event): boolean => { events.push(event.type); return true }
  render(avatarComponent); await flush(); let tree = render(avatarComponent)
  assert.ok(button(tree, '显示全部 8 个风格'))
  click(button(tree, '使用此风格')); await flush(); tree = render(avatarComponent)
  assert.match(textOf(tree), /将头像切换到「风格 0」？/)
  click(button(tree, '取消')); tree = render(avatarComponent)
  assert.ok(!calls.some(call => call.path.endsWith('/apply')))
  click(button(tree, '使用此风格')); await flush(); tree = render(avatarComponent)
  const checkbox = elements(tree).find(item => item.props.type === 'checkbox')!
  ;(checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } })
  tree = render(avatarComponent); assert.match(textOf(tree), /估算不含自定义头像/)
  click(button(tree, '应用到现有')); await flush()
  assert.deepEqual(calls.find(call => call.path.endsWith('/apply'))?.body, { styleId: 'style-0', mode: 'applyExisting', includeCustom: true })
  assert.ok(events.includes('skillhub:library-entries-changed'))
  assert.equal(calls.filter(call => call.path.endsWith('/style')).length, 2)
  cleanup()
})

test('no fal still permits newOnly; official account can choose without local admin or fal requests', async () => {
  for (const selfhost of [true, false]) {
    const calls = setupAvatars({ configured: !selfhost })
    const view = (): ReactNode => AvatarSettings({ space, admin: selfhost, selfhost })
    render(view); await flush(); let tree = render(view)
    click(button(tree, '使用此风格')); await flush(); tree = render(view)
    assert.equal(button(tree, '应用到现有').props.disabled, selfhost)
    assert.equal(button(tree, '仅用于新头像').props.disabled, false)
    if (selfhost) assert.match(textOf(tree), /配置 fal.ai 后才能为现有 Skill 生成新头像/)
    else assert.ok(!calls.some(call => call.path.includes('/fal')))
    click(button(tree, '仅用于新头像')); await flush()
    assert.deepEqual(calls.find(call => call.path.endsWith('/apply'))?.body, { styleId: 'style-0', mode: 'newOnly', includeCustom: false })
    cleanup()
  }
})

test('fal heading aligns its badge with the title and explains missing, saved and environment keys', async () => {
  for (const options of [{ configured: false }, { configured: true }, { env: true }]) {
    setupAvatars(options)
    render(avatarComponent); await flush(); const tree = render(avatarComponent)
    const title = elements(tree).find(item => item.type === 'b' && textOf(item).startsWith('fal.ai API Key'))!
    assert.ok(elements(title).some(item => String(item.props.className).startsWith('inline-status')))
    if ('env' in options) {
      assert.match(textOf(tree), /由服务器环境变量提供，在此不可修改/)
      assert.ok(!elements(tree).some(item => item.props.id === 'instance-fal-key'))
    } else if (options.configured) assert.match(textOf(tree), /••••1234 · 最近测试：/)
    else {
      assert.match(textOf(tree), /用于生成 Skill 头像。/)
      const input = elements(tree).find(item => item.props.id === 'instance-fal-key')!
      assert.equal(input.props.placeholder, '粘贴 fal.ai API Key')
      assert.equal(input.props['aria-label'], 'fal.ai API Key')
      assert.ok(!elements(tree).some(item => item.type === 'label' && item.props.htmlFor === 'instance-fal-key'))
    }
    cleanup()
  }
  const css = readFileSync(new URL('../src/components/InstanceSettings.css', import.meta.url), 'utf8')
  assert.match(css, /\.avatar-settings \.settings-row-info b \.inline-status\s*\{[^}]*align-self: center/)
})

test('preview controls require a trusted image; modal is Chinese-first and a failed image loses its control', async () => {
  for (const url of [null, '', 'https://blocked.test/example.png', 'https://allowed.test/example.png']) {
    const style = { ...avatarStyles[0], preview: { url, license: 'CC0', attribution: 'SkillHub' } }
    setupAvatars({ styles: [style] })
    Object.assign(window.__TAURI_INTERNALS__, { convertFileSrc: (path: string) => `asset://localhost/${path}` })
    setMediaContext({ spaceId: space.spaceId, serverBase: 'https://fixture.invalid', allowedImageHosts: ['allowed.test'] })
    const view = (): ReactNode => {
      const tree = avatarComponent()
      const child = elements(tree).find(item => typeof item.type === 'function' && item.props.onPreview)
      const enlarged = elements(tree).find(item => typeof item.type === 'function' && item.props.onUnavailable)
      return [tree, child ? (child.type as (props: Record<string, unknown>) => ReactNode)(child.props) : null,
        enlarged ? (enlarged.type as (props: Record<string, unknown>) => ReactNode)(enlarged.props) : null]
    }
    // Mount child hooks only once the gallery has loaded.
    render(view); await flush(); let tree = render(view)
    const control = elements(tree).find(item => item.type === 'button' && item.props['aria-label'] === '预览「风格 0」')
    if (url?.includes('allowed.test')) {
      assert.ok(control); click(control); tree = render(view)
      const modal = elements(tree).find(item => item.props.className === 'modal-card avatar-style-preview')!
      assert.match(textOf(modal), /风格 0.*Style 0.*简洁的说明.*授权：CC0.*署名：SkillHub/)
      assert.doesNotMatch(textOf(modal), /Description/)
      assert.ok(elements(modal).some(item => item.props.className === 'connection-caption' && textOf(item) === 'Style 0'))
      const enlargedImage = elements(tree).filter(item => item.type === 'img').at(-1)!
      ;(enlargedImage.props.onError as () => void)()
      tree = render(view)
      assert.ok(!elements(tree).some(item => item.props.className === 'modal-card avatar-style-preview'))
      const img = elements(tree).find(item => item.type === 'img')!
      ;(img.props.onError as () => void)()
      tree = render(view)
      assert.ok(!elements(tree).some(item => item.type === 'button' && item.props['aria-label'] === '预览「风格 0」'))
    } else {
      assert.equal(control, undefined)
      assert.ok(elements(tree).some(item => item.props['aria-label'] === '暂无示例图'))
      assert.ok(!elements(tree).some(item => String(item.props.className).includes('modal-layer')))
      assert.doesNotMatch(textOf(tree), /授权：|署名：|No preview image supplied/)
    }
    cleanup()
  }
})

test('confirmation uses compact statistics, conditional custom/in-flight rows, and warnings above ordered actions', async () => {
  for (const scope of ['instance', 'account'] as const) {
    setupAvatars({ configured: scope !== 'instance', preview: { scope, customSkipped: 0, inFlight: 0,
      estimatedCostUsd: scope === 'instance' ? 0.16 : null, quota: { remaining: 198, used: 2, limit: 200 }, coverable: 5 } })
    render(avatarComponent); await flush(); let tree = render(avatarComponent)
    click(button(tree, '使用此风格')); await flush(); tree = render(avatarComponent)
    const modal = elements(tree).find(item => item.props.className === 'modal-card compact avatar-style-confirmation')!
    assert.ok(elements(modal).some(item => item.props.className === 'eyebrow' && textOf(item) === 'Skill 头像'))
    assert.match(textOf(modal), scope === 'instance' ? /按整台服务器统计/ : /只影响你自己的 Skill/)
    const stats = elements(modal).find(item => item.props.className === 'selection-box compact')!
    assert.deepEqual(elements(stats).filter(item => item.type === 'b').map(textOf), ['可复用', '需生成', '预计费用', '跳过的自定义头像', '今日剩余额度'])
    assert.match(textOf(stats), /198\/200/)
    assert.ok(!elements(modal).some(item => item.props.type === 'checkbox'))
    assert.doesNotMatch(textOf(modal), /进行中|超出额度/)
    const actions = elements(modal).find(item => item.props.className === 'modal-actions')!
    assert.deepEqual(elements(actions).filter(item => item.type === 'button').map(textOf), ['取消', '仅用于新头像', '应用到现有'])
    assert.equal(button(actions, '取消').props.className, 'btn btn-ghost')
    assert.equal(button(actions, '仅用于新头像').props.className, 'btn btn-ghost')
    assert.equal(button(actions, '应用到现有').props.className, 'btn btn-primary')
    assert.equal(button(actions, '应用到现有').props.disabled, scope === 'instance')
    if (scope === 'instance') assert.equal(elements(actions)[1].props.className, 'banner banner-warn')
    cleanup()
  }
  setupAvatars()
  render(avatarComponent); await flush(); let tree = render(avatarComponent)
  click(button(tree, '使用此风格')); await flush(); tree = render(avatarComponent)
  const actions = elements(tree).find(item => item.props.className === 'modal-actions')!
  assert.equal(textOf(elements(actions)[1]), '超出额度的部分不会排队')
  assert.equal(elements(actions)[1].props.className, 'banner banner-warn')
  assert.equal(button(actions, '应用到现有').props.disabled, false)
  cleanup()
})

test('both style apply modes render a success toast through the real ToastContainer', async () => {
  for (const mode of ['newOnly', 'applyExisting'] as const) {
    const calls = setupAvatars({ configured: mode !== 'newOnly' })
    const view = (): ReactNode => [avatarComponent(), ToastContainer()]
    render(view); await flush(); let tree = render(view)
    click(button(tree, '使用此风格')); await flush(); tree = render(view)
    click(button(tree, mode === 'newOnly' ? '仅用于新头像' : '应用到现有')); await flush(); tree = render(view)
    assert.equal(calls.find(call => call.path.endsWith('/apply'))?.body?.mode, mode)
    const message = elements(tree).find(item => item.props.className === 'toast-message')!
    assert.ok(message)
    assert.match(textOf(message), mode === 'newOnly' ? /^已切换为「风格 0」，现有头像保持不变$/ : /风格已切换：复用 2，新建 3，跳过 2，因额度未排队 2/)
    assert.ok(elements(tree).some(item => item.props.role === 'status' && String(item.props.className).startsWith('toast ')))
    assert.ok(!elements(tree).some(item => item.props.className === 'modal-card compact avatar-style-confirmation'))
    cleanup()
  }
})

test('official gallery loads when avatar capability arrives after initial render', async () => {
  const calls = setupAvatars()
  harness.state.serverInfo = null
  const view = (): ReactNode => AvatarSettings({ space, admin: false, selfhost: false })
  render(view); await flush(); assert.equal(calls.length, 0)
  harness.state.serverInfo = { features: { avatars: true } }
  render(view); await flush()
  assert.match(textOf(render(view)), /当前风格/)
  assert.equal(calls.filter(call => call.path.endsWith('/style')).length, 1)
  cleanup()
})

test('fal save carries receipt, clears plaintext and updates capability; deletion waits for confirmation', async () => {
  const calls = setupAvatars({ configured: false })
  const responder = serverFixture.fetch
  let saved = false
  serverFixture.fetch = async (input, init) => {
    const result = await responder(input, init)
    if (String(input).endsWith('/fal')) {
      if (init?.method === 'PUT') { saved = true; return Response.json({ source: 'setting', configured: true, masked: '••••1234' }) }
      if (init?.method === 'GET' && saved) return Response.json({ source: 'setting', configured: true, masked: '••••1234' })
      if (init?.method === 'DELETE') saved = false
    }
    return result
  }
  render(avatarComponent); await flush(); let tree = render(avatarComponent)
  changeFal(tree, 'fixture-key-123456'); tree = render(avatarComponent)
  click(button(tree, '测试')); await flush(); tree = render(avatarComponent)
  click(button(tree, '保存')); await flush(); tree = render(avatarComponent)
  assert.deepEqual(calls.find(call => call.method === 'PUT')?.body, { apiKey: 'fixture-key-123456', draftToken: 'passed' })
  assert.equal((harness.state.serverInfo as { features: { avatars: boolean } }).features.avatars, true)
  assert.ok(!elements(tree).some(item => item.props.type === 'password'))
  click(button(tree, '删除')); tree = render(avatarComponent)
  const confirmation = elements(tree).find(item => item.props.title === '删除 fal.ai 配置？')!
  assert.equal(confirmation.props.description, '删除后不再生成新头像，已有头像保留')
  assert.ok(!calls.some(call => call.method === 'DELETE'))
  ;(confirmation.props.onConfirm as () => void)(); await flush(); tree = render(avatarComponent)
  assert.equal((harness.state.serverInfo as { features: { avatars: boolean } }).features.avatars, false)
  assert.equal(elements(tree).find(item => item.props.type === 'password')?.props.value, '')
  cleanup()
})

test('late fal test is discarded after a key edit and expiry clears save eligibility', async () => {
  setupAvatars({ configured: false })
  render(avatarComponent); await flush(); let tree = render(avatarComponent)
  changeFal(tree, 'fixture-key-123456'); tree = render(avatarComponent)
  let finish: ((response: Response) => void) | undefined
  const responder = serverFixture.fetch
  serverFixture.fetch = async (input, init) => String(input).endsWith('/test') ? new Promise<Response>(resolve => { finish = resolve }) : responder(input, init)
  click(button(tree, '测试')); await flush()
  changeFal(render(avatarComponent), 'fixture-key-changed')
  finish!(Response.json({ ok: true, draftToken: 'old-key-token' })); await flush(); tree = render(avatarComponent)
  assert.equal(button(tree, '保存').props.disabled, true)
  serverFixture.fetch = responder
  let expire: (() => void) | undefined
  window.setTimeout = ((fn: () => void) => { expire = fn; return 1 }) as typeof window.setTimeout
  click(button(tree, '测试')); await flush(); tree = render(avatarComponent)
  assert.equal(button(tree, '保存').props.disabled, false)
  expire!(); tree = render(avatarComponent)
  assert.equal(button(tree, '保存').props.disabled, true); assert.match(textOf(tree), /测试已过期/)
  cleanup()
})

test('late fal test and style preview cannot update a switched account or generation', async () => {
  for (const change of ['account', 'space', 'unmount'] as const) {
    setupAvatars()
    render(avatarComponent); await flush(); let tree = render(avatarComponent)
    let finish: ((response: Response) => void) | undefined
    const responder = serverFixture.fetch
    serverFixture.fetch = async (input, init) => String(input).endsWith('/preview') ? new Promise<Response>(resolve => { finish = resolve }) : responder(input, init)
    click(button(tree, '使用此风格')); await flush()
    if (change === 'account') harness.state.currentUser = { id: 'other', marketplaceRole: 'admin' }
    else if (change === 'space') { serverFixture.space = { ...space, generation: 9 }; harness.state.activeSpace = serverFixture.space }
    else cleanup()
    finish!(Response.json(avatarPreview)); await flush()
    tree = render(avatarComponent)
    assert.doesNotMatch(textOf(tree), /将头像切换到/)
    cleanup()
  }
})

test('admin AI form tests before save; edits clear token; member/env expose no editable inputs', async () => {
  setup()
  const calls: string[] = []
  serverFixture.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname; calls.push(`${init?.method} ${path}`)
    return Response.json(path.endsWith('/test') ? { ok: true, latencyMs: 250, draftToken: 'tested' } : path.endsWith('/status') ? { configured: true, source: 'env' } : saved)
  }
  const component = (): ReactNode => AiSettingsComponent({ space, admin: true })
  render(component); await flush(); let tree = render(component)
  assert.equal(button(tree, '保存').props.disabled, true)
  assert.ok(elements(tree).some(item => item.props.className === 'instance-field-label' && textOf(item.props.children as ReactNode) === '协议'))
  assert.ok(textOf(tree).includes('点「测试」时会先保存每日上限和内网允许列表，并立即生效。'))
  assert.match(textOf(tree), /•••• 1234（末 4 位）/)
  assert.ok(!elements(tree).some(item => item.props.type === 'password'))
  click(button(tree, '更换')); tree = render(component)
  assert.ok(elements(tree).some(item => item.props.type === 'password'))
  click(button(tree, '测试')); await flush(); tree = render(component)
  assert.equal(button(tree, '保存').props.disabled, false)
  assert.deepEqual(calls.slice(-2), ['PUT /api/instance/settings/ai/policy', 'POST /api/instance/settings/ai/test'])
  const model = elements(tree).find(item => item.props.id === 'instance-ai-model')!
  ;(model.props.onChange as (event: unknown) => void)({ target: { value: 'changed' } })
  tree = render(component); assert.equal(button(tree, '保存').props.disabled, true)
  cleanup()
  for (const isAdmin of [false, true]) {
    setup(); serverFixture.fetch = async () => Response.json(isAdmin ? { ...saved, source: 'env' } : { configured: true, source: 'env' })
    const view = (): ReactNode => AiSettingsComponent({ space, admin: isAdmin })
    render(view); await flush(); const readonly = render(view)
    assert.ok(!elements(readonly).some(item => item.type === 'input'))
    assert.match(textOf(readonly), isAdmin ? /由服务器环境变量配置/ : /由实例管理员配置/)
    cleanup()
  }
})

test('empty keys are omitted for models, test and save; only the server decides whether a saved key can be reused', async () => {
  for (const scenario of ['new', 'saved', 'changed-address'] as const) {
    setup()
    const settings = scenario === 'new' ? { ...saved, source: 'none' as const, keyLast4: null } : saved
    const requests: Array<{ path: string; method?: string; body: Record<string, unknown> }> = []
    serverFixture.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname
      if (init?.method === 'GET') return Response.json(settings)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ path, method: init?.method, body })
      if (path.endsWith('/policy')) return Response.json(settings)
      assert.equal(Object.hasOwn(body, 'apiKey'), false)
      if (scenario !== 'saved') return Response.json({ code: 'API_KEY_REQUIRED' }, { status: 400 })
      if (path.endsWith('/models')) return Response.json({ models: ['model'] })
      if (path.endsWith('/test')) return Response.json({ ok: true, latencyMs: 1, draftToken: 'passed' })
      return Response.json(saved)
    }
    const component = (): ReactNode => AiSettingsComponent({ space, admin: true })
    render(component); await flush(); let tree = render(component)
    if (scenario === 'new') {
      const modes = elements(tree).find(item => item.props['aria-label'] === 'AI 方式')!
      ;(modes.props.onChange as (value: string) => void)('api')
    } else {
      click(button(tree, '更换'))
    }
    tree = render(component)
    if (scenario === 'changed-address') {
      const url = elements(tree).find(item => item.type === 'input' && item.props.value === saved.baseUrl)!
      ;(url.props.onChange as (event: unknown) => void)({ target: { value: 'https://changed.test' } })
      tree = render(component)
    }
    for (const label of ['获取模型列表', '测试']) {
      click(button(tree, label)); await flush(); tree = render(component)
      const alert = elements(tree).find(item => item.props.role === 'alert')
      if (scenario === 'saved') assert.equal(alert, undefined)
      else assert.equal(textOf(alert?.props.children as ReactNode), '请填写 API Key')
    }
    if (scenario === 'saved') {
      assert.equal(button(tree, '保存').props.disabled, false)
      click(button(tree, '保存')); await flush()
      assert.ok(requests.some(item => item.path.endsWith('/ai') && item.method === 'PUT'))
    } else assert.equal(button(tree, '保存').props.disabled, true)
    assert.ok(requests.some(item => item.path.endsWith('/models')))
    assert.ok(requests.some(item => item.path.endsWith('/test')))
    assert.equal(Object.hasOwn(aiDraft(aiForm(settings)), 'apiKey'), false)
    cleanup()
  }
})

test('AI mode cards expose radio semantics, complete copy and arrow-key selection with focus', async () => {
  setup()
  serverFixture.fetch = async () => Response.json({ ...saved, source: 'none', keyLast4: null })
  const component = (): ReactNode => AiSettingsComponent({ space, admin: true })
  render(component); await flush()
  const cards = (): ReactNode => {
    const group = elements(render(component)).find(item => item.props['aria-label'] === 'AI 方式')!
    return SegmentedControl(group.props as Parameters<typeof SegmentedControl>[0])
  }
  let tree = cards()
  assert.ok(elements(tree).some(item => item.props.role === 'radiogroup' && item.props.className === 'ui-seg instance-ai-modes'))
  assert.equal(elements(tree).filter(item => item.props.role === 'radio').length, 3)
  for (const copy of ['不配置', 'Skill 显示“未分析”，保留 SKILL.md 原有信息和你的手动编辑。', '默认', '接入 AI 接口', '由你的服务器调用 AI，所有成员共用。', '管理员配置']) assert.ok(textOf(tree).includes(copy))
  assert.match(textOf(tree), /使用本机 Agent/)
  for (const [key, index] of [['ArrowDown', 0], ['ArrowUp', 1], ['ArrowRight', 0], ['ArrowLeft', 1]] as const) {
    const radios = elements(tree).filter(item => item.props.role === 'radio')
    assert.equal(radios[index].props['aria-checked'], true)
    assert.equal(radios[index].props.tabIndex, 0)
    assert.equal(radios[1 - index].props.tabIndex, -1)
    let focused = false, prevented = false
    ;(radios[1 - index].ref as (value: unknown) => void)({ focus: () => { focused = true } })
    ;(radios[index].props.onKeyDown as (event: unknown) => void)({ key, preventDefault: () => { prevented = true } })
    tree = cards()
    assert.equal(focused, true); assert.equal(prevented, true)
    assert.equal(elements(tree).filter(item => item.props.role === 'radio')[1 - index].props['aria-checked'], true)
  }
  cleanup()
})

test('instance summary formats overview fields for local and remote deployments', () => {
  assert.equal(instanceSummary(overview), '1 位成员 · 本机部署（http://127.0.0.1:3001） · 本地目录存储 · Server 0.31.0')
  for (const baseUrl of ['http://localhost:3001', 'http://[::1]:3001', 'http://127.2.3.4:3001']) {
    assert.ok(instanceSummary({ ...overview, addresses: { primary: { baseUrl, https: false }, additional: [] } }).includes(`本机部署（${baseUrl}）`))
  }
  assert.equal(instanceSummary({ ...overview, memberCount: 8, addresses: { primary: { baseUrl: 'https://skills.example.test', https: true }, additional: [] }, storage: { ...overview.storage, provider: 'picem' } }),
    '8 位成员 · 服务器部署（https://skills.example.test） · picem 存储 · Server 0.31.0')
})

test('local Agent visibility matrix: selfhost only, API priority, admin and member device choice', async () => {
  for (const profile of ['official', 'local', 'selfhost']) for (const configured of [false, true]) for (const isAdmin of [false, true]) {
    setup()
    const target = { ...space, spaceId: profile === 'selfhost' ? space.spaceId : profile }
    harness.state.activeSpace = target; serverFixture.space = target
    harness.state.currentUser = { id: isAdmin ? 'admin' : 'member', marketplaceRole: isAdmin ? 'admin' : 'member' }
    serverFixture.fetch = async input => Response.json(new URL(String(input)).pathname.endsWith('/status') ? { configured, source: configured ? 'setting' : 'none' } : { ...saved, source: configured ? 'setting' : 'none' })
    const page = readFileSync('src/pages/SettingsPage.tsx', 'utf8')
    assert.match(page, /capabilities.profile === 'official' \?[^]*: space && currentUser && <InstanceAiSettings/)
    assert.match(page, /capabilities.profile !== 'local' && <>/)
    if (profile !== 'selfhost') { cleanup(); continue }
    harness.values = []; harness.cleanups = []; harness.effects = []
    const component = (): ReactNode => AiSettingsComponent({ space: target, admin: isAdmin })
    render(component); await flush()
    let tree = render(component)
    const group = elements(tree).find(item => item.props['aria-label'] === 'AI 方式')!
    const options = group.props.options as Array<{ value: string; disabled: boolean; label: ReactNode }>
    const local = options.find(item => item.value === 'local')!
    assert.equal(local.disabled, configured)
    assert.match(textOf(local.label), /使用本机 Agent.*用这台电脑上已登录的 Claude Code 分析。.*仅对你生效/)
    if (configured) assert.match(textOf(tree), /实例已配置 AI 接口，由服务器分析/)
    else {
      ;(group.props.onChange as (value: string) => void)('local')
      tree = render(component)
      assert.ok(elements(tree).some(item => item.type === LocalSettings))
      assert.equal(readLocalInferencePreference(target, isAdmin ? 'admin' : 'member').enabled, true)
      assert.match(textOf(tree), /会消耗你自己的 Claude 订阅额度，并访问供应商云端/)
    }
    cleanup()
  }
})

test('local preference is isolated by space and user, survives generation, and fails closed on corruption', () => {
  setup()
  saveLocalInferencePreference(space, 'alice', { enabled: true, agent: 'claude', autoAnalyze: true })
  assert.equal(readLocalInferencePreference({ ...space, generation: 99 }, 'alice').enabled, true)
  assert.equal(readLocalInferencePreference(space, 'bob').enabled, false)
  assert.equal(readLocalInferencePreference({ ...space, spaceId: 'other' }, 'alice').enabled, false)
  localStorage.clear()
  assert.equal(readLocalInferencePreference(space, 'alice').enabled, false)
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => '{invalid' } })
  assert.equal(readLocalInferencePreference(space, 'alice').enabled, false)
})

const usable: LocalInferenceProbe = { agent: 'claude', version: '2.1.300', available: true, reason: null, modelsSupported: false, checks: [] }
const codex: LocalInferenceProbe = { ...usable, agent: 'codex', version: '0.162.1', available: false, reason: 'ISOLATION_UNSUPPORTED' }
test('local CLI statuses, test button availability and errors never expose provider messages', () => {
  for (const [reason, status] of [['NOT_INSTALLED', '未安装'], ['NOT_LOGGED_IN', '未登录'], ['VERSION_UNSUPPORTED', '版本不支持'], ['ISOLATION_UNSUPPORTED', '不能关闭用户设置'], ['SHIM_UNSUPPORTED', '不可用']]) {
    assert.equal(localInferenceStatus({ ...codex, reason }), status)
  }
  assert.equal(localInferenceStatus(usable), '可用')
  assert.equal(canTestLocalInference([usable, codex], 'claude', false), true)
  assert.equal(canTestLocalInference([usable, codex], 'claude', true), false)
  assert.equal(canTestLocalInference([usable, codex], 'codex', false), false)
  assert.equal(canTestLocalInference([], 'claude', false), false)
  for (const code of Object.keys(LOCAL_INFERENCE_ERRORS)) {
    assert.match(localInferenceError({ code, message: 'raw-secret-provider-text' }), /[\u4e00-\u9fff]/)
    assert.doesNotMatch(localInferenceError({ code, message: 'raw-secret-provider-text' }), /raw-secret/)
  }
  assert.doesNotMatch(localInferenceError('unknown-private-message'), /unknown-private/)
})

test('local settings test is explicit, shows result and time, cancels on unmount and discards late replies', async () => {
  setup()
  const calls: Array<{ command: string; args: Record<string, unknown> }> = []
  let finish: (value: unknown) => void = () => {}
  window.__TAURI_INTERNALS__.invoke = async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args })
    if (command === 'local_inference_probe') return { space, probes: [usable, codex] }
    if (command === 'local_inference_run') return new Promise(resolve => { finish = resolve })
    if (command === 'local_inference_cancel') return true
    throw new Error(command)
  }
  const component = (): ReactNode => LocalSettings({ space, agent: 'claude', onAgent: () => {} })
  let tree = render(component)
  assert.equal(calls.length, 0)
  assert.equal(button(tree, '测试').props.disabled, true)
  assert.match(textOf(tree), /自动分析会消耗你自己的 Claude 订阅额度/)
  assert.match(textOf(tree), /头像由实例使用 fal\.ai 生成，费用由实例承担；本机只编写提示词/)
  assert.match(textOf(tree), /本次已分析 0 个 Skill，编写 0 个头像提示词，失败 0 个/)
  click(button(tree, '重新检测')); tree = render(component)
  assert.equal(button(tree, '检测中…').props.disabled, true)
  await flush(); tree = render(component)
  assert.match(textOf(tree), /Claude Code · 2.1.300/)
  assert.match(textOf(tree), /Codex · 0.162.1.*当前版本的 Codex 无法关闭用户指令和 MCP 连接器/)
  assert.equal(button(tree, '测试').props.disabled, false)
  click(button(tree, '测试')); tree = render(component)
  assert.equal(button(tree, '测试中…').props.disabled, true)
  const profile = { displayName: '周报', description: '整理本周工作', category: '协作与办公', labels: ['文档处理', '办公效率'], triggerScenarios: [] }
  finish({ space, result: profile, elapsedMs: 1234 }); await flush()
  assert.match(textOf(render(component)), /测试成功 · 用时 1.23 秒 · 周报.*整理本周工作/)
  click(button(render(component), '测试')); cleanup()
  assert.equal(calls.at(-1)?.command, 'local_inference_cancel')
  const cancelled = calls.at(-1)!.args
  assert.equal(cancelled.runId, calls.at(-2)!.args.runId)
  harness.state.activeSpace = { ...space, generation: space.generation + 1 }
  finish({ space, result: { ...profile, displayName: '迟到结果' }, elapsedMs: 99 }); await flush()
  assert.doesNotMatch(textOf(render(component)), /迟到结果|测试成功/)
  for (const call of calls) assert.deepEqual(call.args.space, space)
  assert.ok(calls.every(call => !('input' in call.args) && !('schema' in call.args)))
})

test('first local selection keeps the mounted probe through parent preference and serverInfo updates', async () => {
  setup()
  harness.state.serverInfo = { features: { ai: false, avatars: false, marketplace: false } }
  serverFixture.fetch = async () => Response.json({ ...saved, source: 'none' })
  const parent = harness
  const parentComponent = (): ReactNode => AiSettingsComponent({ space: { ...space }, admin: true })
  render(parentComponent); await flush()
  const mode = elements(render(parentComponent)).find(item => item.props['aria-label'] === 'AI 方式')!
  ;(mode.props.onChange as (value: string) => void)('local')
  const first = elements(render(parentComponent)).find(item => item.type === LocalSettings)!
  assert.match(first.key ?? '', /selfhost-test.*8.*admin/)
  // The runner is a direct keyed row child, independent of the loading fragment.
  const section = elements(render(parentComponent)).find(item => item.props.className === 'settings-row settings-row-stack instance-ai')!
  assert.ok(Children.toArray(section.props.children as ReactNode).some(item => isValidElement(item) && item.type === LocalSettings))

  const calls: string[] = []
  let finish: (value: unknown) => void = () => {}
  window.__TAURI_INTERNALS__.invoke = async (command: string) => {
    calls.push(command)
    if (command === 'local_inference_probe') return new Promise(resolve => { finish = resolve })
    if (command === 'local_inference_cancel') return true
    throw new Error(command)
  }
  const child: Harness = { values: [], cursor: 0, effects: [], cleanups: [], state: parent.state }
  const select = (target: Harness): void => { harness = target; globals.instanceHarness = target }
  let props = first.props as Parameters<typeof LocalSettings>[0]
  select(child)
  click(button(render(() => LocalSettings(props)), '重新检测'))
  await flush()
  select(parent)
  ;(first.props.onAgent as (agent: string) => void)('claude')
  parent.state.serverInfo = { features: { ai: false, avatars: false, marketplace: false } }
  const next = elements(render(parentComponent)).find(item => item.type === LocalSettings)!
  assert.equal(next.type, first.type); assert.equal(next.key, first.key)
  props = next.props as Parameters<typeof LocalSettings>[0]
  select(child)
  assert.match(textOf(render(() => LocalSettings(props))), /检测中/)
  assert.equal(calls.includes('local_inference_cancel'), false)
  finish({ space, probes: [usable, codex] }); await flush()
  assert.match(textOf(render(() => LocalSettings(props))), /Claude Code · 2.1.300/)
  assert.equal(button(render(() => LocalSettings(props)), '测试').props.disabled, false)
  // A real departure still cancels the second in-flight probe and drops its reply.
  click(button(render(() => LocalSettings(props)), '重新检测')); await flush()
  cleanup()
  assert.equal(calls.filter(call => call === 'local_inference_cancel').length, 1)
  finish({ space, probes: [usable] }); await flush()
  assert.doesNotMatch(textOf(render(() => LocalSettings(props))), /Claude Code · 2.1.300/)
  select(parent); cleanup()
})

test('configuration loading to unconfigured preserves the local panel identity', async () => {
  setup()
  saveLocalInferencePreference(space, 'admin', { enabled: true, agent: 'claude', autoAnalyze: true })
  let finish: (value: Response) => void = () => {}
  serverFixture.fetch = async () => new Promise<Response>(resolve => { finish = resolve })
  const component = (): ReactNode => AiSettingsComponent({ space, admin: true })
  const before = elements(render(component)).find(item => item.type === LocalSettings)!
  assert.ok(before)
  await flush()
  finish(Response.json({ ...saved, source: 'none' })); await flush()
  const after = elements(render(component)).find(item => item.type === LocalSettings)!
  assert.equal(after.key, before.key); assert.equal(after.type, before.type)
  cleanup()
})

test('interrupted automatic analysis offers Continue even when preference is already enabled', () => {
  setup()
  acceptLocalWorkerStatus({ space, userId: 'admin', revision: 900, state: 'paused', pausedReason: 'INTERRUPTED', completed: 0, failed: 0 }, space, 'admin')
  const changes: boolean[] = []
  const component = (): ReactNode => LocalSettings({ space, agent: 'claude', autoAnalyze: true, onAgent: () => {}, onAutoAnalyze: value => { changes.push(value) } })
  click(button(render(component), '继续'))
  assert.deepEqual(changes, [true])
  cleanup()
})

test('settings summary uses overview and keeps fallback while loading or on failure', async () => {
  const fallback = '查看成员、注册与邀请、地址与证书、存储和用量。'
  for (const failed of [false, true]) {
    setup(); harness.state.activeSpace = space
    let finish: (value: Response) => void = () => {}
    let overviewCalls = 0
    serverFixture.fetch = async input => {
      if (new URL(String(input)).pathname.endsWith('/overview')) {
        overviewCalls += 1
        return new Promise<Response>(resolve => { finish = resolve })
      }
      return Response.json({})
    }
    const component = (): ReactNode => ServiceSettings({ onOpenInstance: () => {} })
    render(component); await flush(); render(component); await flush()
    assert.equal(overviewCalls, 1)
    assert.ok(textOf(render(component)).includes(fallback))
    finish(failed ? Response.json({}, { status: 500 }) : Response.json(overview))
    await flush()
    assert.ok(textOf(render(component)).includes(failed ? fallback : instanceSummary(overview)))
    cleanup()
  }
})

test('batch reanalysis is preview → confirmation → paid submission, and continues after leaving settings', async () => {
  setup()
  const calls: string[] = []
  let submitted = 0
  serverFixture.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname; calls.push(path)
    if (path === '/api/skills') return Response.json(Array.from({ length: 201 }, (_, i) => ({ id: `skill-${i}` })))
    if (path.endsWith('/preview')) {
      const count = (JSON.parse(String(init?.body)) as { skillIds: string[] }).skillIds.length
      return Response.json({ total: count, eligible: count, coverable: count, remaining: { instance: 500, user: 500 } })
    }
    if (path.endsWith('/batches')) {
      const body = JSON.parse(String(init?.body)) as { skillIds: string[]; confirm: boolean; aiAnalysisConsent: boolean }
      assert.equal(body.confirm, true); assert.equal(body.aiAnalysisConsent, true)
      submitted += 1
      return Response.json({ batchId: 'batch', state: submitted === 1 ? 'running' : 'completed', queued: body.skillIds.length, skipped: 0, completed: submitted === 1 ? 0 : body.skillIds.length, failed: 0 })
    }
    if (path.endsWith('/batches/batch')) return Response.json({ batchId: 'batch', state: 'completed', queued: 200, skipped: 0, completed: 200, failed: 0 })
    return Response.json(saved)
  }
  const component = (): ReactNode => AiSettingsComponent({ space, admin: true })
  render(component); await flush(); click(button(render(component), '重新分析我的 Skill')); await flush()
  const tree = render(component)
  const confirmation = elements(tree).find(item => item.props.title === '重新分析我的 Skill')!
  assert.ok(confirmation); assert.match(String(confirmation.props.description), /共 201 个.*可能产生费用/)
  assert.equal(calls.filter(path => path.endsWith('/batches')).length, 0)
  ;(confirmation.props.onConfirm as () => void)()
  cleanup(); await flush()
  assert.equal(instanceAnalysisTask(space)?.running, true)
  await new Promise<void>(resolve => setTimeout(resolve, 1300))
  assert.equal(calls.filter(path => path.endsWith('/batches')).length, 2)
  assert.ok(calls.includes('/api/skills/analysis/batches/batch'))
  assert.equal(instanceAnalysisTask(space)?.completed, 201)
  assert.match(analysisConfirmation({ total: 9, eligible: 8, coverable: 2, remaining: { instance: 2, user: 3 } }), /可覆盖 2.*实例 2.*你 3.*不会覆盖你手动修改/)
  serverFixture.space = { ...space, generation: 9 }
  const before = calls.length
  await startInstanceAnalysis([['old']], space, () => {})
  assert.equal(calls.length, before)
})

test('instance roles require confirmation, protect last admin, and invitation plaintext exists only after generation', async () => {
  setup()
  const calls: string[] = []
  const registration = { mode: 'invite', source: 'setting', inviteCodeMask: '••••abcd' }
  serverFixture.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname; calls.push(`${init?.method} ${path}`)
    if (path.endsWith('/overview')) return Response.json({ memberCount: 2, registration, addresses: { primary: { baseUrl: 'http://127.0.0.1:3001', https: false }, additional: [] },
      storage: { provider: 'builtin', media: { bytes: 10, complete: false }, cards: { bytes: 20, complete: true } }, aiUsage: { used: 3, limit: 200 }, version: { server: 'test' }, minClientVersion: null })
    if (path.endsWith('/members')) return Response.json({ total: 2, members: [admin, member] })
    if (path.endsWith('/role')) return Response.json({ ...member, role: 'admin' })
    return Response.json({ ...registration, inviteCode: 'new-once-only-code' })
  }
  let wentBack = false
  const component = (): ReactNode => InstancePage({ space, onBack: () => { wentBack = true } })
  render(component); await flush(); let tree = render(component)
  const heading = elements(tree).find(item => item.type === PageHeading)!
  const headingElements = elements(PageHeading(heading.props as Parameters<typeof PageHeading>[0]))
  const back = headingElements.find(item => item.type === 'a')!
  assert.equal(textOf(back.props.children as ReactNode), '返回设置')
  assert.ok(headingElements.indexOf(back) < headingElements.findIndex(item => item.type === 'h1'))
  let prevented = false
  ;(back.props.onClick as (event: unknown) => void)({ preventDefault: () => { prevented = true } })
  assert.equal(prevented, true); assert.equal(wentBack, true)
  assert.ok(elements(tree).some(item => item.type === 'code' && item.props.className === 'mono' && textOf(item.props.children as ReactNode).startsWith('npm run admin -- reset-password')))
  assert.equal(button(tree, '设为成员').props.disabled, true)
  assert.match(textOf(tree), /至少保留一名管理员/)
  assert.ok(!elements(tree).some(item => item.type === 'button' && textOf(item.props.children as ReactNode) === '复制'))
  click(button(tree, '设为管理员')); tree = render(component)
  const confirmation = elements(tree).find(item => item.props.title === '设为管理员？')!
  assert.ok(confirmation); assert.ok(!calls.some(path => path.startsWith('PUT')))
  ;(confirmation.props.onConfirm as () => void)(); await flush()
  assert.ok(calls.includes('PUT /api/instance/settings/members/member/role'))
  click(button(render(component), '换一个')); await flush(); tree = render(component)
  let inviteConfirmation = elements(tree).find(item => item.props.title === '换一个邀请码？')!
  assert.ok(inviteConfirmation)
  assert.equal(inviteConfirmation.props.description, '旧邀请码会立即失效，已经发出但还没用的邀请码将无法注册。')
  assert.equal(inviteConfirmation.props.confirmLabel, '换一个')
  assert.ok(!calls.some(path => path.endsWith('/regenerate')))
  ;(inviteConfirmation.props.onCancel as () => void)(); await flush(); tree = render(component)
  assert.ok(!elements(tree).some(item => item.props.title === '换一个邀请码？'))
  assert.ok(!calls.some(path => path.endsWith('/regenerate')))
  click(button(tree, '换一个')); tree = render(component)
  inviteConfirmation = elements(tree).find(item => item.props.title === '换一个邀请码？')!
  ;(inviteConfirmation.props.onConfirm as () => void)(); await flush(); tree = render(component)
  assert.equal(calls.filter(path => path.endsWith('/regenerate')).length, 1)
  assert.ok(!elements(tree).some(item => item.props.title === '换一个邀请码？'))
  assert.match(textOf(tree), /new-once-only-code/); assert.ok(button(tree, '复制'))
  cleanup(); setup(); render(component); await flush(); tree = render(component)
  assert.doesNotMatch(textOf(tree), /new-once-only-code/); assert.match(textOf(tree), /••••abcd/)
  cleanup()
})

test('unanalysed mapping keeps explicit metadata, removes local rule fallback, and AI completion updates server state', () => {
  const remote = { id: 's', name: 's', displayName: 's', description: 'SKILL.md 简介', labels: ['手动标签'], analysisStatus: 'unanalysed' as const,
    triggerScenarios: [], compatibleAgents: [], currentVersion: '1.0.0', installCount: 0, authorId: 'u', visibility: 'private', marketplaceStatus: 'none', createdAt: '', updatedAt: '' }
  const base = mergeApiSkill(remote, undefined, undefined, undefined, true)
  const local = { ...base, description: '规则摘要', labels: ['规则标签'], trigger: '规则触发', fitScenarios: ['规则场景'], unfitScenarios: ['规则不适用'] }
  const merged = mergeApiSkill(remote, local, undefined, undefined, true)
  assert.equal(merged.description, 'SKILL.md 简介'); assert.deepEqual(merged.labels, ['手动标签'])
  assert.equal(merged.trigger, ''); assert.deepEqual(merged.fitScenarios, []); assert.deepEqual(merged.unfitScenarios, [])
  assert.equal(mergeApiSkill(remote, local).trigger, '规则触发', 'official fallback stays unchanged')
  assert.equal(withAnalyzedProfile(merged, { displayName: 'AI', description: 'AI', category: '', labels: [], fitScenarios: [] }).serverAnalysisStatus, 'completed')
  assert.equal(reconcileLocalSkillRefresh(merged, { ...merged, serverAnalysisStatus: undefined }).serverAnalysisStatus, 'unanalysed')
  for (const file of ['SkillCard', 'CloudSkillPreview', 'SkillDetailSheet']) {
    const source = readFileSync(`src/components/${file}.tsx`, 'utf8')
    assert.match(source, /serverAnalysisStatus/)
    assert.match(source, /未分析/)
  }
})

test('selfhost section order and administrative entry stay out of official/local branches', () => {
  const source = readFileSync('src/components/ServiceSettings.tsx', 'utf8')
  assert.match(source, /showCurrent && caps.profile === 'selfhost' && admin && <div className="settings-row">/)
  assert.ok(source.indexOf('<AccountSettings />') < source.indexOf('<b>本实例</b>'))
  assert.doesNotMatch(source, /<InstanceAiSettings|<CatalogLogin|settings-label">实例管理/)
  const page = readFileSync('src/pages/SettingsPage.tsx', 'utf8')
  assert.match(page, /instanceOpen && capabilities.profile === 'selfhost' && space && currentUser\?\.marketplaceRole === 'admin'/)
})


test('DocHelp renders section and inline text links while retaining labelled buttons', () => {
  const section = DocHelp({ topic: 'keys', label: '钥匙是怎么用的', variant: 'section' })
  assert.equal(section.type, 'button')
  assert.equal(section.props.type, 'button')
  assert.equal(section.props.className, 'doc-link')
  assert.ok(elements(section).some(item => item.props.name === 'doc' && item.props.size === 13))
  const inline = DocHelp({ topic: 'fal', label: '了解更多', variant: 'inline' })
  assert.equal(inline.props.className, 'doc-link')
  assert.equal(textOf(inline), '了解更多')
  assert.ok(!elements(inline).some(item => item.props.name === 'doc'))
  const button = DocHelp({ topic: 'connectionError', label: '查看解决办法' })
  assert.equal(button.props.className, 'btn btn-ghost btn-sm')
  assert.equal(textOf(button), '查看解决办法')
})
