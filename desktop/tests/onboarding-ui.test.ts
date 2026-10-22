import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { completionKey, GUIDE_PROGRESS_KEY } from '../src/lib/onboarding.ts'

type Harness = {
  values: unknown[]; cursor: number; effects: Array<() => void | (() => void)>; cleanups: Array<() => void>
  preferences: Map<string, string>; state: Record<string, unknown>; calls: string[]
  evidence: { hasSession: boolean; hasManagedSkills: boolean }
  legacySession?: boolean
  pendingProbe?: Promise<{ probes: Array<{ agent: string; available: boolean }> }>
}
let harness: Harness
const global = globalThis as typeof globalThis & { onboardingHarness: Harness }
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/Onboarding.tsx') || context.parentURL?.endsWith('/FeatureTour.tsx')) {
      if (specifier === 'react/jsx-runtime') return next(specifier, context)
      if (specifier === 'react') return { url: 'fixture:react', shortCircuit: true }
      if (specifier.endsWith('/onboarding.js')) return next(specifier.replace('.js', '.ts'), context)
      if (specifier.endsWith('.css')) return { url: 'fixture:css', shortCircuit: true }
      return { url: `fixture:${specifier}`, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'fixture:react') return { format: 'module', shortCircuit: true, source: `
      const h=()=>globalThis.onboardingHarness;
      export function useState(initial) { const s=h(),i=s.cursor++; if(!(i in s.values)) s.values[i]=typeof initial==='function'?initial():initial; return [s.values[i],v=>{s.values[i]=typeof v==='function'?v(s.values[i]):v}]; }
      export function useRef(initial) { return useState({current:initial})[0]; }
      export function useEffect(fn,deps) { const s=h(),i=s.cursor++,old=s.values[i]; if(!old || deps.some((v,j)=>v!==old.deps[j])) {const record={deps};s.values[i]=record;s.effects.push(()=>{old?.cleanup?.();if(old)old.cleanup=undefined;record.cleanup=fn();return ()=>{record.cleanup?.();record.cleanup=undefined}})} }
      export const useLayoutEffect=useEffect;
      export const useId=()=>':tour-test:';
    ` }
    if (url === 'fixture:../store/index.js') return { format: 'module', shortCircuit: true, source: `
      const h=()=>globalThis.onboardingHarness;
      export const useStore=fn=>fn(h().state); useStore.getState=()=>h().state;
      export const readPreference=k=>h().preferences.get(k)??null;
      export const writePreference=(k,v)=>h().preferences.set(k,v);
    ` }
    if (url === 'fixture:../lib/tauri.js') return { format: 'module', shortCircuit: true, source: `
      export async function onboardingEvidence(){return globalThis.onboardingHarness.evidence}
      export async function getUnmanagedAgentSkills(){return []}
      export async function localInferenceProbe(){globalThis.onboardingHarness.calls.push('probe');return globalThis.onboardingHarness.pendingProbe??{probes:[]}}
      export async function localInferenceCancel(){globalThis.onboardingHarness.calls.push('cancel')}
    ` }
    if (url === 'fixture:../lib/agent-detection.js') return { format: 'module', shortCircuit: true, source: 'export async function refreshAgentCapabilities(){}' }
    if (url === 'fixture:../lib/auth.js') return { format: 'module', shortCircuit: true, source: 'export const hadLegacySession=()=>Boolean(globalThis.onboardingHarness.legacySession)' }
    if (url === 'fixture:../lib/local-inference.js') return { format: 'module', shortCircuit: true, source: 'export const localInferenceError=()=>"不可用"' }
    if (url === 'fixture:../lib/use-space-capabilities.js') return { format: 'module', shortCircuit: true, source: `export function useSpaceCapabilities(){const id=globalThis.onboardingHarness.state.activeSpace.spaceId;return {profile:id==='official'?'official':id==='local'?'local':'selfhost',teams:id!=='local'}}` }
    if (url.startsWith('fixture:')) return { format: 'module', shortCircuit: true, source: url === 'fixture:css' ? '' : `export default function ${url.split('/').pop()!.replace('.js', '')}(){return null}` }
    if (url.endsWith('/Onboarding.tsx') || url.endsWith('/FeatureTour.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText }
    return next(url, context)
  },
})
const { default: Onboarding } = await import('../src/components/Onboarding.tsx')
const { default: FeatureTour } = await import('../src/components/FeatureTour.tsx')
hook.deregister()

function setup(existing = false, spaceId = 'official'): void {
  harness = { values: [], cursor: 0, effects: [], cleanups: [], preferences: new Map(), calls: [], evidence: { hasSession: existing, hasManagedSkills: false },
    state: { activeSpace: { spaceId, generation: 1 }, spacePending: false, authStatus: 'guest', currentUser: null, agentCapabilities: [], setView: () => {}, setSkillTab: () => {} } }
  global.onboardingHarness = harness
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
}
function render(): ReactNode { harness.cursor = 0; return Onboarding() }
async function settle(): Promise<void> {
  for (const effect of harness.effects.splice(0)) { const cleanup = effect(); if (cleanup) harness.cleanups.push(cleanup) }
  await new Promise(resolve => setImmediate(resolve))
}
function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  return Children.toArray(node).flatMap(child => isValidElement<Record<string, unknown>>(child) ? [child, ...elements(child.props.children as ReactNode)] : [])
}
function text(node: ReactNode): string { return Children.toArray(node).map(child => isValidElement<Record<string, unknown>>(child) ? text(child.props.children as ReactNode) : String(child)).join('') }
function click(tree: ReactNode, label: string): void {
  const button = elements(tree).find(element => element.type === 'button' && text(element.props.children as ReactNode) === label)
  assert.ok(button, label)
  ;(button.props.onClick as () => void)()
}
function cleanup(): void { for (const fn of harness.cleanups) fn() }

for (const spaceId of ['local', 'selfhost-a']) test(`tour stays visible and tracks available targets in ${spaceId}`, async (t) => {
  setup(false, spaceId)
  const frames = new Map<number, FrameRequestCallback>()
  let serial = 0, done = 0
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const originalRaf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame')
  t.after(() => {
    cleanup()
    for (const [key, descriptor] of [['document', originalDocument], ['requestAnimationFrame', originalRaf], ['cancelAnimationFrame', originalCancel]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 })
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (fn: FrameRequestCallback): number => { frames.set(++serial, fn); return serial } })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number): void => { frames.delete(id) } })
  const targets = new Map<string, { getClientRects: () => number[]; getBoundingClientRect: () => object; scrollIntoView: () => void }>()
  const queries: string[] = []
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: (selector: string) => { queries.push(selector); return targets.get(selector) ?? null } } })
  const draw = (): ReactNode => { harness.cursor = 0; return FeatureTour({ onDone: () => { done++ } }) }
  const tick = (): void => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(0)) }
  const views: string[] = []
  harness.state.setView = (view: string): void => { views.push(view) }
  const tree = draw()
  const card = elements(tree).find(item => item.props.className === 'modal-card tour-card')!
  assert.deepEqual(card.props.style, { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' })
  assert.match(text(tree), /跳过导览上一步下一站/)
  let focused = 0, cardWidth = 440
  ;(card as ReactElement & { ref: { current: unknown } }).ref.current = {
    getBoundingClientRect: () => ({ width: cardWidth, height: 220 }),
    contains: () => false,
    querySelector: () => ({ focus: () => { focused++ } }),
  }
  await settle()
  for (const [i, id] of ['skills', 'install', 'marketplace', 'keys'].entries()) {
    tick()
    assert.equal(elements(draw()).filter(item => item.props.className === 'tour-highlight').length, 0)
    let left = 30 + i * 100
    targets.set(`[data-tour="${id}"]`, { getClientRects: () => [1], getBoundingClientRect: () => ({ left, top: 100, width: 80, height: 30, right: left + 80, bottom: 130 }), scrollIntoView: () => { throw new TypeError('WebView scroll failure') } })
    if (i === 0) {
      cardWidth = 0
      tick()
      const fallback = elements(draw()).find(item => item.props.className === 'modal-card tour-card')!
      assert.deepEqual(fallback.props.style, { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' })
      cardWidth = 440
    }
    tick()
    let highlight = elements(draw()).find(item => item.props.className === 'tour-highlight')!
    await settle()
    assert.equal(focused, i + 1)
    assert.equal((highlight.props.style as { left: number }).left, left)
    left += 10
    Object.assign(window, { innerWidth: 900 })
    tick()
    highlight = elements(draw()).find(item => item.props.className === 'tour-highlight')!
    assert.equal((highlight.props.style as { left: number }).left, left)
    if (id !== 'keys') { click(draw(), '下一站'); draw(); await settle() }
  }
  assert.deepEqual(views, ['skills', 'skills', 'marketplace', 'keys'])
  assert.ok(!queries.includes('[data-tour="cli"]'))
  assert.equal(queries.includes('[data-tour="teams"]'), spaceId !== 'local')
  click(draw(), '上一步'); draw(); await settle()
  targets.delete('[data-tour="marketplace"]')
  tick()
  t.mock.timers.tick(1499)
  assert.equal(views.at(-1), 'marketplace')
  t.mock.timers.tick(2); draw(); await settle()
  assert.equal(views.at(-1), 'skills')
  assert.equal(done, 0)
  targets.clear()
  // Even without another animation frame, each absent stop has a deadline.
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(1500); draw(); await settle() }
  assert.equal(done, 1)
  cleanup()
  assert.equal(frames.size, 0)
})

test('fresh install can skip everything without changing deployment or enabling inference', async () => {
  setup()
  const originalSpace = harness.state.activeSpace
  render(); await settle()
  click(render(), '跳过'); await settle()
  click(render(), '跳过'); await settle()
  const tour = render() as ReactElement<{ onDone: () => void }>
  assert.equal((tour.type as Function).name, 'FeatureTour')
  tour.props.onDone()
  click(render(), '跳过')
  assert.equal(render(), null)
  assert.equal(harness.state.activeSpace, originalSpace)
  assert.deepEqual(harness.calls, [])
  assert.equal(harness.preferences.get(completionKey('completed', 'official')), '1')
  assert.equal(harness.preferences.get(completionKey('tour', 'local')), '1')
  cleanup()
})
test('existing users only dismiss one upgrade card and retain their space and account', async () => {
  setup(true, 'selfhost-old')
  const user = { id: 'existing', marketplaceRole: 'admin' }
  harness.state.currentUser = user
  const originalSpace = harness.state.activeSpace
  render(); await settle()
  assert.match(text(render()), /开源与自部署/)
  assert.equal(elements(render()).find(item => item.type === 'button' && text(item.props.children as ReactNode) === '知道了')?.props.autoFocus, true)
  click(render(), '知道了')
  assert.equal(render(), null)
  assert.equal(harness.state.currentUser, user)
  assert.equal(harness.state.activeSpace, originalSpace)
  assert.equal(harness.preferences.get(completionKey('intro', 'official')), '1')
  cleanup()
})
test('each current space is marked and cannot be selected again', async () => {
  for (const spaceId of ['local', 'official', 'selfhost-a']) {
    setup(false, spaceId)
    render(); await settle()
    const tree = elements(render())
    const rows = tree.filter(item => item.props.className === 'settings-row')
    assert.deepEqual(rows.map(row => elements(row).find(item => item.type === 'b')?.props.children).map(children => Children.toArray(children as ReactNode)[0]), ['一探官方', '仅本机', '自部署'])
    assert.equal(tree.filter(item => item.props.className === 'chip chip-accent').length, 1)
    assert.ok(elements(rows[0]).some(item => item.props.className === 'chip chip-accent' && text(item.props.children as ReactNode) === '推荐'))
    assert.match(text(render()), /不选择将继续使用一探官方；三种方式都可主动浏览官方商店。/)
    assert.equal(tree.filter(item => item.props.className === 'chip' && text(item.props.children as ReactNode) === '当前').length, 1)
    assert.equal(tree.find(item => item.type === 'button' && text(item.props.children as ReactNode) === '当前')?.props.disabled, true)
    assert.equal(tree.filter(item => item.type === 'button' && text(item.props.children as ReactNode) === '选择').length, 2)
    const originalSpace = harness.state.activeSpace
    click(render(), '下一步'); await settle()
    assert.match(text(render()), /发现本机 Agent/)
    assert.equal(harness.state.activeSpace, originalSpace)
    assert.deepEqual(harness.calls, [])
    cleanup()
  }
})
test('every combination of installation evidence shows upgrade once or welcomes a fresh user', async () => {
  for (let flags = 0; flags < 16; flags++) {
    for (const dismissed of [null, 'completed', 'intro'] as const) {
      setup(Boolean(flags & 1))
      harness.legacySession = Boolean(flags & 2)
      harness.evidence.hasManagedSkills = Boolean(flags & 4)
      if (flags & 8) {
        harness.state.currentUser = { id: 'existing' }
        harness.state.authStatus = 'authenticated'
      }
      if (dismissed) harness.preferences.set(completionKey(dismissed, 'official'), '1')
      render(); await settle()
      if (dismissed) assert.equal(render(), null)
      else if (flags) {
        assert.match(text(render()), /开源与自部署/)
        assert.doesNotMatch(text(render()), /选择使用方式/)
        click(render(), '知道了')
        assert.equal(render(), null)
      } else assert.match(text(render()), /选择使用方式/)
      cleanup()
    }
  }
})
test('connection stays mounted while pending; committed destination owns mode completion and reload progress', async () => {
  setup()
  render(); await settle()
  const choose = elements(render()).filter(item => item.type === 'button' && text(item.props.children as ReactNode) === '选择')
  ;(choose[0].props.onClick as () => void)()
  harness.state.spacePending = true
  const connection = render() as ReactElement<{ target: string; onConnected: (space: { spaceId: string; generation: number }) => void }>
  assert.equal((connection.type as Function).name, 'ConnectServerDialog')
  assert.equal(connection.props.target, 'local')
  connection.props.onConnected({ spaceId: 'local', generation: 2 })
  assert.equal(harness.preferences.get(completionKey('mode', 'local')), '1')
  assert.equal(harness.preferences.get(completionKey('mode', 'official')), undefined)
  assert.deepEqual(JSON.parse(harness.preferences.get(GUIDE_PROGRESS_KEY)!), { step: 'agents', spaceId: 'local' })
  cleanup()
})
test('resumed admin can skip AI without enabling paid inference, then replay from settings', async () => {
  setup(true, 'selfhost-a')
  harness.state.currentUser = { id: 'admin', marketplaceRole: 'admin' }
  harness.preferences.set(GUIDE_PROGRESS_KEY, JSON.stringify({ step: 'ai', spaceId: 'selfhost-a' }))
  render(); await settle()
  click(render(), '暂不配置')
  assert.deepEqual(harness.calls, [])
  assert.equal(harness.preferences.get(completionKey('ai', 'selfhost-a')), '1')
  assert.equal(harness.preferences.get(completionKey('ai', 'official')), undefined)
  window.dispatchEvent(new Event('skillhub-show-onboarding'))
  assert.match(text(render()), /选择使用方式/)
  cleanup()
})
test('upgrade dismissal remains effective on the next launch', async () => {
  setup(true)
  harness.preferences.set(completionKey('intro', 'official'), '1')
  render(); await settle()
  assert.equal(render(), null)
  cleanup()
})
test('leaving AI or switching identity cancels a pending probe and discards its late result', async () => {
  for (const action of ['skip', 'switch']) {
    setup(true, 'selfhost-a')
    harness.state.currentUser = { id: 'admin', marketplaceRole: 'admin' }
    harness.state.agentCapabilities = [{ key: 'claude', detected: true }]
    harness.preferences.set(GUIDE_PROGRESS_KEY, JSON.stringify({ step: 'ai', spaceId: 'selfhost-a' }))
    let resolveProbe!: (result: { probes: Array<{ agent: string; available: boolean }> }) => void
    harness.pendingProbe = new Promise(resolve => { resolveProbe = resolve })
    render(); await settle(); render(); await settle()
    click(render(), '检测可用性')
    if (action === 'skip') click(render(), '暂不配置')
    else {
      harness.state.activeSpace = { spaceId: 'local', generation: 2 }
      harness.state.currentUser = null
    }
    render(); await settle()
    assert.deepEqual(harness.calls, ['probe', 'cancel'])
    resolveProbe({ probes: [{ agent: 'claude', available: true }] })
    await settle()
    assert.doesNotMatch(text(render()), /Claude Code 可用/)
    assert.equal(harness.preferences.get(completionKey('ai', 'local')), undefined)
    cleanup()
  }
})
