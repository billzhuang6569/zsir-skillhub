/** Theme preference (#258): data-theme per preference, matchMedia follow, persistence round-trip. */
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

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/desktop/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
  }
  return nextResolve(specifier, context)
} })
const theme = await import('../src/lib/theme.ts')
hooks.deregister()

type Root = { dataset: Record<string, string | undefined> }

test('each preference sets or clears data-theme on the root', () => {
  const root: Root = { dataset: {} }
  theme.applyThemePreference(root, 'dark')
  assert.equal(root.dataset.theme, 'dark')
  theme.applyThemePreference(root, 'light')
  assert.equal(root.dataset.theme, 'light')
  theme.applyThemePreference(root, 'system')
  assert.equal('theme' in root.dataset, false)
})

test('system follows the OS; a forced theme overrides it', () => {
  assert.equal(theme.resolveTheme('system', true), 'dark')
  assert.equal(theme.resolveTheme('system', false), 'light')
  assert.equal(theme.resolveTheme('light', true), 'light')
  assert.equal(theme.resolveTheme('dark', false), 'dark')
})

test('unknown stored values fall back to system', () => {
  for (const value of [null, undefined, '', 'Dark', 'auto', 1]) assert.equal(theme.parseThemePreference(value), 'system')
  assert.equal(theme.parseThemePreference('light'), 'light')
  assert.equal(theme.parseThemePreference('dark'), 'dark')
})

test('system dark changes reach the listener until unsubscribed', () => {
  const listeners = new Set<(event: { matches: boolean }) => void>()
  const query = {
    matches: false,
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => { listeners.add(listener) },
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => { listeners.delete(listener) },
  } as unknown as Parameters<typeof theme.watchSystemDarkScheme>[0]
  const seen: boolean[] = []
  const stop = theme.watchSystemDarkScheme(query, (dark) => seen.push(dark))
  for (const listener of listeners) listener({ matches: true })
  stop()
  assert.equal(listeners.size, 0)
  assert.deepEqual(seen, [true])
  assert.doesNotThrow(() => theme.watchSystemDarkScheme(null, () => undefined)())
})

test('the store persists the preference and a fresh store reads it back', async () => {
  memory.set(theme.THEME_PREFERENCE_KEY, 'dark')
  const firstHooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/desktop/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
    }
    return nextResolve(specifier, context)
  } })
  const { useStore } = await import('../src/store/index.ts')
  firstHooks.deregister()
  assert.equal(useStore.getState().themePreference, 'dark')

  useStore.getState().setThemePreference('light')
  assert.equal(useStore.getState().themePreference, 'light')
  assert.equal(memory.get(theme.THEME_PREFERENCE_KEY), 'light')

  useStore.getState().setThemePreference('system')
  assert.equal(memory.get(theme.THEME_PREFERENCE_KEY), 'system')
  assert.equal(theme.parseThemePreference(memory.get(theme.THEME_PREFERENCE_KEY)), 'system')
})

test('App applies the preference to <html> before paint and Settings offers the three choices', () => {
  const app = readFileSync(resolve(desktopRoot, 'src/App.tsx'), 'utf8')
  assert.match(app, /useLayoutEffect\(\(\) => \{\n\s+applyThemePreference\(document\.documentElement, theme\.preference\)\n\s+\}, \[theme\.preference\]\)/)
  const settings = readFileSync(resolve(desktopRoot, 'src/pages/SettingsPage.tsx'), 'utf8')
  assert.match(settings, /<SegmentedControl mode="radiogroup" size="sm" aria-label="外观" options=\{THEME_OPTIONS\} value=\{theme\.preference\} onChange=\{theme\.setPreference\} \/>/)
  assert.match(settings, /<SegmentedControl mode="radiogroup" size="sm" aria-label="列表主要显示" options=\{TITLE_OPTIONS\} value=\{skillTitlePreference\} onChange=\{setSkillTitlePreference\} \/>/)
  assert.match(settings, /\{ value: 'skill-name', label: 'Skill 名', icon: 'code' \}/)
  assert.match(settings, /\{ value: 'ai-title', label: '友好名', icon: 'type' \}/)
  assert.doesNotMatch(settings, /AI 分析标题/)
  assert.match(settings, /label: THEME_PREFERENCE_LABELS\[value\], icon: THEME_ICONS\[value\]/)
  assert.deepEqual(theme.THEME_PREFERENCES.map((value) => theme.THEME_PREFERENCE_LABELS[value]), ['跟随系统', '浅色', '深色'])
  const hook = readFileSync(resolve(desktopRoot, 'src/lib/use-theme.ts'), 'utf8')
  assert.match(hook, /useSyncExternalStore\(subscribeSystemDark, systemPrefersDark/)
})

test('the window shell paints the theme background while the window itself stays transparent', () => {
  const css = readFileSync(resolve(desktopRoot, 'src/styles/app.css'), 'utf8')
  assert.match(css, /html, body, #root \{ background: transparent; \}/)
  assert.match(css, /\.app-shell \{ background: var\(--color-bg\);[^}]*border: 1px solid var\(--color-window-border\);/)
  assert.match(css, /\.modal-layer\{[^}]*background:var\(--color-overlay\)/)
  assert.match(css, /\.scrim \{[^}]*background: var\(--color-scrim\);/)
  assert.doesNotMatch(css, /rgba\(88, ?99, ?120/)
})
