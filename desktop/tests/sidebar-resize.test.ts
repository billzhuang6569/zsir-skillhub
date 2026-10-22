/** Sidebar drag-to-resize (#182, #260): clamp, keyboard, persistence and drag lifecycle. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const memory = new Map<string, string>()
const storage = {
  getItem: (key: string): string | null => memory.get(key) ?? null,
  setItem: (key: string, value: string): void => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const resolveTs = (): ReturnType<typeof registerHooks> => registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/desktop/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
  }
  return nextResolve(specifier, context)
} })

const hooks = resolveTs()
const sidebar = await import('../src/lib/sidebar-width.ts')
hooks.deregister()

test('bounds are 220–320 and shrink with the window so the workspace keeps its reserve', () => {
  assert.deepEqual(sidebar.sidebarBounds(), { min: 220, max: 320 })
  assert.deepEqual(sidebar.sidebarBounds(1440), { min: 220, max: 320 })
  // The 1000px minimum window keeps 720px for the directory and detail pane.
  assert.deepEqual(sidebar.sidebarBounds(1000), { min: 220, max: 280 })
  assert.equal(sidebar.sidebarBounds(1000).max + sidebar.SIDEBAR_CONTENT_RESERVE, 1000)
  // A window narrower than min + reserve never inverts the bounds.
  assert.deepEqual(sidebar.sidebarBounds(800), { min: 220, max: 220 })
  assert.deepEqual(sidebar.sidebarBounds(Number.NaN), { min: 220, max: 320 })
})

test('clamp keeps widths inside the window bounds', () => {
  assert.equal(sidebar.clampSidebarWidth(100), 220)
  assert.equal(sidebar.clampSidebarWidth(999), 320)
  assert.equal(sidebar.clampSidebarWidth(260.4), 260)
  assert.equal(sidebar.clampSidebarWidth(320, 1000), 280)
  assert.equal(sidebar.clampSidebarWidth(250, 1000), 250)
  assert.equal(sidebar.clampSidebarWidth(320, 1600), 320)
  assert.equal(sidebar.clampSidebarWidth(Number.NaN), 250)
  assert.equal(sidebar.clampSidebarWidth(Number.NaN, 800), 220)
})

test('arrow keys step by 8px within the bounds; Home and End jump to them', () => {
  const bounds = { min: 220, max: 280 }
  assert.equal(sidebar.sidebarWidthForKey('ArrowRight', 250, bounds), 258)
  assert.equal(sidebar.sidebarWidthForKey('ArrowLeft', 250, bounds), 242)
  assert.equal(sidebar.sidebarWidthForKey('ArrowRight', 276, bounds), 280)
  assert.equal(sidebar.sidebarWidthForKey('ArrowLeft', 224, bounds), 220)
  assert.equal(sidebar.sidebarWidthForKey('Home', 250, bounds), 220)
  assert.equal(sidebar.sidebarWidthForKey('End', 250, bounds), 280)
  assert.equal(sidebar.sidebarWidthForKey('ArrowUp', 250, bounds), null)
  assert.equal(sidebar.sidebarWidthForKey('Enter', 250, bounds), null)
})

test('stored values outside 220–320 or not a plain integer fall back to 250', () => {
  for (const value of [null, undefined, '', 'abc', '219', '321', '1e3', '250.5', '-250', ' ', '0250', 9999, {}]) {
    assert.equal(sidebar.parseSidebarWidth(value), 250, String(value))
  }
  assert.equal(sidebar.parseSidebarWidth('220'), 220)
  assert.equal(sidebar.parseSidebarWidth('320'), 320)
  assert.equal(sidebar.parseSidebarWidth(' 288 '), 288)
  assert.equal(sidebar.parseSidebarWidth(264), 264)
})

type FakeTarget = {
  captured: Set<number>
  setPointerCapture: (id: number) => void
  releasePointerCapture: (id: number) => void
  hasPointerCapture: (id: number) => boolean
}

function fakeTarget(): FakeTarget {
  const captured = new Set<number>()
  return {
    captured,
    setPointerCapture: (id) => { captured.add(id) },
    releasePointerCapture: (id) => { captured.delete(id) },
    hasPointerCapture: (id) => captured.has(id),
  }
}

function harness(start = 250, bounds = { min: 220, max: 320 }) {
  const previews: number[] = []
  const commits: number[] = []
  const active: boolean[] = []
  const controller = sidebar.createSidebarResizeController({
    getWidth: () => start,
    getBounds: () => bounds,
    preview: (width) => previews.push(width),
    commit: (width) => commits.push(width),
    onActiveChange: (value) => active.push(value),
  })
  const target = fakeTarget()
  let prevented = 0
  const down = (clientX: number, extra: Partial<{ pointerId: number; button: number; isPrimary: boolean }> = {}): void => {
    controller.pointerDown({ pointerId: 1, button: 0, isPrimary: true, clientX, currentTarget: target, preventDefault: () => { prevented += 1 }, ...extra })
  }
  return { controller, target, previews, commits, active, down, prevented: () => prevented }
}

test('a drag captures the pointer, previews clamped widths and commits once on pointerup', () => {
  const h = harness()
  h.down(250)
  assert.equal(h.controller.isDragging(), true)
  assert.equal(h.prevented(), 1, 'press must not select text or reach the native drag script')
  assert.equal(h.target.hasPointerCapture(1), true)
  assert.deepEqual(h.active, [true])
  h.controller.pointerMove({ pointerId: 1, clientX: 290 })
  h.controller.pointerMove({ pointerId: 1, clientX: 600 })
  h.controller.pointerMove({ pointerId: 1, clientX: 700 }) // still at max: no duplicate preview
  // Coming back from beyond the bound follows the pointer without a jump.
  h.controller.pointerMove({ pointerId: 1, clientX: 300 })
  h.controller.pointerMove({ pointerId: 1, clientX: -500 })
  assert.deepEqual(h.previews, [290, 320, 300, 220])
  assert.deepEqual(h.commits, [])
  h.controller.pointerEnd({ pointerId: 1 })
  assert.deepEqual(h.commits, [220])
  assert.equal(h.target.hasPointerCapture(1), false)
  assert.deepEqual(h.active, [true, false])
  assert.equal(h.controller.isDragging(), false)
  // Late events after release are ignored.
  h.controller.pointerMove({ pointerId: 1, clientX: 400 })
  h.controller.pointerEnd({ pointerId: 1 })
  assert.deepEqual(h.commits, [220])
})

test('pointercancel, lost capture and window blur all release the drag exactly once', () => {
  for (const end of ['cancel-event', 'blur'] as const) {
    const h = harness()
    h.down(100)
    h.controller.pointerMove({ pointerId: 1, clientX: 130 })
    if (end === 'blur') h.controller.cancel()
    else h.controller.pointerEnd({ pointerId: 1 })
    h.controller.cancel()
    assert.deepEqual(h.commits, [280], end)
    assert.deepEqual(h.active, [true, false], end)
    assert.equal(h.target.captured.size, 0, end)
  }
})

test('secondary buttons, other pointers and a second press do not start or hijack a drag', () => {
  const h = harness()
  h.down(250, { button: 2 })
  h.down(250, { isPrimary: false })
  assert.equal(h.controller.isDragging(), false)
  assert.equal(h.prevented(), 0, 'right-click and secondary pointers keep their default behaviour')
  h.down(250)
  h.down(400, { pointerId: 2 })
  h.controller.pointerMove({ pointerId: 2, clientX: 400 })
  h.controller.pointerEnd({ pointerId: 2 })
  assert.equal(h.controller.isDragging(), true)
  assert.deepEqual(h.previews, [])
  h.controller.pointerEnd({ pointerId: 1 })
  assert.deepEqual(h.commits, [250])
})

test('a narrow window lowers the drag maximum', () => {
  const h = harness(250, sidebar.sidebarBounds(1000))
  h.down(0)
  h.controller.pointerMove({ pointerId: 1, clientX: 200 })
  h.controller.pointerEnd({ pointerId: 1 })
  assert.deepEqual(h.commits, [280])
})

test('the store persists the width and a fresh store reads it back; bad values fall back', async () => {
  memory.set(sidebar.SIDEBAR_WIDTH_KEY, '288')
  const storeHooks = resolveTs()
  const { useStore } = await import('../src/store/index.ts')
  storeHooks.deregister()
  assert.equal(useStore.getState().sidebarWidth, 288)

  useStore.getState().setSidebarWidth(264)
  assert.equal(useStore.getState().sidebarWidth, 264)
  assert.equal(memory.get(sidebar.SIDEBAR_WIDTH_KEY), '264')
  useStore.getState().setSidebarWidth(9000)
  assert.equal(memory.get(sidebar.SIDEBAR_WIDTH_KEY), '320')
  useStore.getState().setSidebarWidth(Number.NaN)
  assert.equal(memory.get(sidebar.SIDEBAR_WIDTH_KEY), '250')

  memory.set(sidebar.SIDEBAR_WIDTH_KEY, '9000')
  assert.equal(sidebar.parseSidebarWidth(memory.get(sidebar.SIDEBAR_WIDTH_KEY)), 250)
})

test('the separator exposes separator semantics and the single --sidebar-width variable drives layout', () => {
  const resizer = readFileSync(resolve(desktopRoot, 'src/components/SidebarResizer.tsx'), 'utf8')
  assert.match(resizer, /role="separator"/)
  assert.match(resizer, /tabIndex=\{0\}/)
  assert.match(resizer, /aria-orientation="vertical"/)
  for (const attr of ['aria-valuenow={width}', 'aria-valuemin={bounds.min}', 'aria-valuemax={bounds.max}']) assert.ok(resizer.includes(attr), attr)
  for (const handler of ['onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel', 'onLostPointerCapture', 'onKeyDown']) {
    assert.match(resizer, new RegExp(`${handler}=`), handler)
  }
  assert.match(resizer, /window\.addEventListener\('blur', release\)/)
  const view = readFileSync(resolve(desktopRoot, 'src/components/Sidebar.tsx'), 'utf8')
  assert.match(view, /style=\{\{ '--sidebar-width': `\$\{renderedWidth\}px` \} as CSSProperties\}/)
  assert.match(view, /clampSidebarWidth\(sidebarWidth, currentWindowWidth\)/)
  const css = readFileSync(resolve(desktopRoot, 'src/styles/app.css'), 'utf8')
  assert.match(css, /\.sidebar \{[^}]*width: var\(--sidebar-width\);[^}]*flex: 0 0 var\(--sidebar-width\);/)
  assert.match(css, /\.sidebar-resizer \{[^}]*cursor: col-resize;[^}]*touch-action: none;/)
  assert.match(css, /\.sidebar-resizer::after \{[^}]*background: var\(--color-brand\);/)
  assert.match(css, /:root\.sidebar-resizing, :root\.sidebar-resizing \* \{ cursor: col-resize !important;[^}]*user-select: none !important; \}/)
})
