/** #262 (V5 of #256): Teams, Settings, account dialogs, the 「钥匙」 skeleton and generic dialogs on the design system. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { LEGACY_TOKEN_NAMES, LEGACY_TOKEN_PATTERN } from './legacy-token-names.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string): string | null => memory.get(key) ?? null,
    setItem: (key: string, value: string): void => { memory.set(key, String(value)) },
    removeItem: (key: string): void => { memory.delete(key) },
  },
  configurable: true,
})

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/desktop/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
  }
  return nextResolve(specifier, context)
} })
const theme = await import('../src/lib/theme.ts')
const keys = await import('../src/lib/keys.ts')
const { useStore } = await import('../src/store/index.ts')
hooks.deregister()

test('外观 is a three-way segmented control bound to the persisted theme preference', () => {
  const settings = source('src/pages/SettingsPage.tsx')
  assert.doesNotMatch(settings, /<select aria-label="外观"/)
  assert.match(settings, /const theme = useTheme\(\)/)
  assert.match(settings, /import \{ THEME_PREFERENCES, THEME_PREFERENCE_LABELS, type ThemePreference \} from '\.\.\/lib\/theme\.js'/)
  assert.match(settings, /<SegmentedControl mode="radiogroup" size="sm" aria-label="外观" options=\{THEME_OPTIONS\} value=\{theme\.preference\} onChange=\{theme\.setPreference\} \/>/)
  assert.match(settings, /THEME_PREFERENCES\.map\(\(value\) => \(\{ value, label: THEME_PREFERENCE_LABELS\[value\], icon: THEME_ICONS\[value\] \}\)\)/)
  assert.match(settings, /const THEME_ICONS = \{ system: 'monitor', light: 'sun', dark: 'moon' \} as const/)
  assert.deepEqual([...theme.THEME_PREFERENCES], ['system', 'light', 'dark'])
  assert.deepEqual(theme.THEME_PREFERENCES.map((value) => theme.THEME_PREFERENCE_LABELS[value]), ['跟随系统', '浅色', '深色'])

  for (const value of theme.THEME_PREFERENCES) {
    useStore.getState().setThemePreference(value)
    assert.equal(useStore.getState().themePreference, value)
    assert.equal(theme.parseThemePreference(memory.get(theme.THEME_PREFERENCE_KEY)), value)
  }

  // The page-local `.settings-segmented` is replaced by the shared SegmentedControl (#289).
  assert.doesNotMatch(source('src/pages/SettingsPage.css'), /\.settings-segmented/)
  assert.doesNotMatch(settings, /settings-segmented/)
})

test('Settings groups are surface cards with a hairline and the 帮助与关于 version row stays free for #186', () => {
  const app = source('src/styles/app.css')
  assert.match(app, /\.settings-group\{background:var\(--color-surface\);border:1px solid var\(--color-line\);border-radius:var\(--radius-lg\);/)
  const settings = source('src/pages/SettingsPage.tsx')
  // Legal buttons stay beside the version in its own row.
  assert.match(settings, /<div className="settings-row settings-about-row"><div className="settings-row-info"><b>一探 SkillHub<\/b><span>v\{appVersion\} · 内部正式版<\/span><\/div>/)
  assert.match(app, /\.settings-row-info\{flex:1;min-width:0\}/)
})

test('「钥匙」 switches 个人 / 团队 with a segmented control and shows one card per key (#294)', () => {
  assert.equal(keys.KEYS_EMPTY_COPY, '还没有钥匙。安装需要钥匙的 Skill 后，在它的详情里填写，这里就会出现。')
  assert.deepEqual(keys.KEY_TABS.map((tab) => [tab.scope, tab.label, tab.icon]), [['personal', '个人', 'user-round'], ['team', '团队', 'users-round']])

  const now = Date.parse('2026-10-13T12:00:00Z')
  assert.equal(keys.formatKeyLastUsed(null, now), '从未使用')
  assert.equal(keys.formatKeyLastUsed('not a date', now), '从未使用')
  assert.equal(keys.formatKeyLastUsed('2026-10-13T11:59:30Z', now), '刚刚')
  assert.equal(keys.formatKeyLastUsed('2026-10-13T11:15:00Z', now), '45 分钟前')
  assert.equal(keys.formatKeyLastUsed('2026-10-13T09:00:00Z', now), '3 小时前')
  assert.equal(keys.formatKeyLastUsed(Date.parse('2026-10-10T12:00:00Z'), now), '3 天前')

  const page = source('src/pages/KeysPage.tsx')
  assert.match(page, /export default function KeysPage\(\{ keys, autoAllow, reload, notice, busy = false, loading = false \}: KeysPageProps\)/)
  assert.match(page, /const \[scope, setScope\] = useState<KeyScope>\(\(\) => keysPageIntent\?\.tab \?\? 'personal'\)/)
  assert.match(page, /<SegmentedControl\n\s+aria-label=\{KEYS_PAGE_COPY\.tabsLabel\}/)
  assert.match(page, /options=\{KEY_TABS\.filter\(tab => tab.scope === 'personal' \|\| capabilities.teamKeys\)\.map\(\(tab\) => \(\{ value: tab\.scope, label: tab\.label, icon: tab\.icon, count: counts\[tab\.scope\] \}\)\)\}/)
  assert.match(page, /scope === 'team' \? KEYS_PAGE_COPY\.teamSubtitle : KEYS_PAGE_COPY\.personalSubtitle/)
  assert.match(page, /keys\.length === 0\n\s+\? <div className="keys-empty">[^]*<p>\{KEYS_EMPTY_COPY\}<\/p>/)
  assert.match(page, /<KeyCard\n\s+key=\{identity\}\n\s+id=\{domId\}/)
  assert.match(page, /const identity = vaultKeyIdentity\(key\)\n\s+const domId = cardDomId\(identity\)/)
  assert.equal(keys.KEYS_PAGE_COPY.personalSubtitle, '个人钥匙以明文保存在这台电脑上，不会自动上传')
  assert.equal(keys.KEYS_PAGE_COPY.teamSubtitle, '团队钥匙加密保存在一探 SkillHub，团队成员运行 Skill 时会用到')
  for (const path of ['src/components/KeyCard.tsx', 'src/lib/keys.ts']) {
    assert.doesNotMatch(source(path), /invoke\(|lib\/tauri\.js|lib\/api/, `${path} stays presentational`)
  }
})

test('KeyCard: the header toggles the Skill list (aria-expanded); names use the code font', () => {
  const card = source('src/components/KeyCard.tsx')
  assert.match(card, /className="key-card-head" aria-expanded=\{open\} aria-controls=\{bodyId\} onClick=\{onToggle\}/)
  assert.match(card, /<code className="key-card-name" title=\{name\}>\{name\}<\/code>/)
  const styles = source('src/components/KeyCard.css')
  assert.match(styles, /\.key-card-name \{[^}]*var\(--font-code\)/s)
  assert.match(styles, /\.key-skill-list \{[^}]*flex-wrap: wrap;/s)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/)
})

test('the sidebar reaches 「钥匙」 without sign-in and the App routes it', () => {
  const sidebar = source('src/components/Sidebar.tsx')
  assert.match(sidebar, /\{ view: 'keys',\s+icon: 'key-round', label: '钥匙' \}/)
  assert.ok(sidebar.indexOf("view: 'keys'") < sidebar.indexOf("view: 'settings'"))
  assert.match(source('src/store/index.ts'), /export type View = [^\n]*'keys'/)
  assert.match(source('src/App.tsx'), /\{view === 'keys'\s+&& <KeyVaultPage key=\{`keys:\$\{spaceKey\}`\} \/>\}/)
  // #253 binds the personal vault to the page shell; the Settings placeholder list is gone.
  assert.match(source('src/pages/KeyVaultPage.tsx'), /<KeysPage\n\s+keys=\{keyVault\.keys\}\n\s+autoAllow=\{keyVault\.autoAllow\}/)
  assert.doesNotMatch(source('src/pages/SettingsPage.tsx'), /KeyVaultList|我的钥匙/)
})

test('dialog focus trap, Escape, outside click and double-submit guards do not regress', () => {
  const trap = source('src/components/FocusTrapDialog.tsx')
  assert.match(trap, /if \(event\.key === 'Escape' && !event\.isComposing && event\.keyCode !== 229\) \{\n\s+event\.preventDefault\(\)\n\s+event\.stopImmediatePropagation\(\)\n\s+if \(!escapeDisabledRef\.current\) onEscapeRef\.current\(\)/)
  assert.match(trap, /if \(closeOnBackdrop && event\.target === event\.currentTarget && !escapeDisabledRef\.current\)/)
  assert.match(trap, /aria-modal="true"/)
  assert.match(trap, /return createPortal\(dialog, document\.body\)/)

  const confirm = source('src/components/ConfirmModal.tsx')
  assert.match(confirm, /onEscape=\{onCancel\} escapeDisabled=\{busy\}/)
  assert.match(confirm, /<button className="btn btn-ghost" onClick=\{onCancel\} disabled=\{busy\}>取消<\/button>/)
  assert.match(confirm, /className=\{`btn \$\{destructive \? 'btn-danger' : 'btn-primary'\}`\} onClick=\{onConfirm\} disabled=\{busy\}>\{busy \? '处理中…' : confirmLabel\}/)

  assert.match(source('src/components/FeedbackDialog.tsx'), /onEscape=\{\(\) => !busy && onClose\(\)\} escapeDisabled=\{busy\} closeOnBackdrop/)
  assert.match(source('src/components/AppUpdateDialog.tsx'), /onEscape=\{dismissAppUpdate\} escapeDisabled=\{busy\}/)
  assert.match(source('src/components/AvatarCropDialog.tsx'), /onEscape=\{onCancel\} escapeDisabled=\{working\}/)
  assert.match(source('src/components/TeamInviteDialog.tsx'), /onEscape=\{onCancel\} escapeDisabled=\{busy\}/)
  assert.match(source('src/components/AuthDialog.tsx'), /className="btn btn-primary auth-dialog-submit" type="submit" disabled=\{submitting\}/)
})

test('dialogs use radius-lg cards, a token scrim inside the rounded window and a 2px brand focus ring', () => {
  const app = source('src/styles/app.css')
  assert.match(app, /\.modal-layer, \.scrim \{ border-radius: var\(--window-radius\); overflow: hidden; \}/)
  assert.match(app, /\.modal-layer\{[^}]*background:var\(--color-overlay\)/)
  assert.match(app, /\.modal-card\{[^}]*border:1px solid var\(--color-line\);background:var\(--color-surface\);[^}]*border-radius:var\(--radius-lg\);[^}]*box-shadow:var\(--shadow-card\)\}/)
  assert.match(app, /\.btn:focus-visible \{ outline: 2px solid var\(--color-brand\); outline-offset: 2px; \}/)
  assert.match(app, /\.btn-primary \{\n\s+background: var\(--color-brand\);\n\s+color: var\(--color-on-brand\);/)
  assert.match(app, /\.btn-ghost \{\n\s+background: var\(--color-surface\);\n\s+border-color: var\(--color-line\);/)
  assert.match(app, /\.btn-danger \{ background: var\(--color-danger\); color: var\(--color-on-brand\);/)
  const toast = source('src/components/Toast.css')
  assert.match(toast, /\.toast \{[^}]*border-radius: var\(--radius-lg\);[^}]*background: var\(--color-surface\);/s)
  assert.doesNotMatch(source('src/components/Toast.tsx'), /style=\{\{ color: '#/)
})

test('team cards and member rows use surface cards, hairline rings and 44px+ targets', () => {
  const app = source('src/styles/app.css')
  // #295 board 8: My Team lists teams as rows grouped 我创建的 / 已加入的.
  const teamsCss = source('src/pages/TeamsPage.css')
  assert.match(teamsCss, /\.team-list-row \{[^}]*min-height: 64px;[^}]*border-radius: var\(--radius-md\);/s)
  assert.match(teamsCss, /\.team-list-row\.active \{ background: var\(--color-surface\); border-color: var\(--color-brand-line\);/)
  assert.match(source('src/pages/TeamsPage.tsx'), /我创建的 · \{myTeams\.length\}[^]*已加入的 · \{joinedTeams\.length\}/)
  assert.match(app, /\.team-avatar\{[^}]*box-shadow:0 0 0 1px var\(--color-line\);/)
  assert.match(app, /\.member-row\{[^}]*min-height:56px;/)
  assert.match(app, /\.member-avatar\{[^}]*box-shadow:0 0 0 1px var\(--color-line\)\}/)
  const sheet = source('src/components/TeamDetailSheet.css')
  assert.match(sheet, /\.team-member-row,\n\.team-request-row \{[^}]*min-height: 56px;/)
  assert.match(sheet, /\.team-person-avatar \{[^}]*box-shadow: 0 0 0 1px var\(--color-line\);/s)
  assert.match(sheet, /\.team-tab\.on \{ border-bottom-color: var\(--color-brand\); color: var\(--color-brand\);/)
})

const legacyNames = LEGACY_TOKEN_NAMES
const legacyPattern = LEGACY_TOKEN_PATTERN

test('files owned by #262 use only canonical design tokens (no --accent, --ink2, --line2, --tsh- …)', () => {
  assert.ok(legacyNames.includes('accent') && legacyNames.includes('ink2') && legacyNames.includes('line2'))
  const owned = [
    'src/pages/TeamsPage.tsx', 'src/pages/TeamSharedPage.tsx', 'src/pages/TeamSharedPage.css',
    'src/pages/SettingsPage.tsx', 'src/pages/SettingsPage.css', 'src/pages/KeysPage.tsx', 'src/pages/KeysPage.css',
    'src/components/KeyCard.tsx', 'src/components/KeyCard.css', 'src/components/TeamKeyList.tsx',
    'src/components/ShareKeyDialog.tsx', 'src/components/KeyAliasEditor.tsx',
    'src/components/TeamDetailSheet.tsx', 'src/components/TeamDetailSheet.css',
    'src/components/TeamInviteDialog.tsx', 'src/components/TeamInviteDialog.css',
    'src/components/TeamInviteCreatorDialog.tsx', 'src/components/TeamInviteCreatorDialog.css',
    'src/components/AccountSettings.tsx', 'src/components/AccountSettings.css',
    'src/components/AuthDialog.tsx', 'src/components/AuthDialog.css',
    'src/components/AvatarUploader.tsx', 'src/components/AvatarUploader.css',
    'src/components/AvatarCropDialog.tsx', 'src/components/AvatarCropDialog.css',
    'src/components/ConfirmModal.tsx', 'src/components/FocusTrapDialog.tsx',
    'src/components/FeedbackDialog.tsx', 'src/components/FeedbackDialog.css',
    'src/components/AppUpdateDialog.tsx', 'src/components/AppUpdateDialog.css',
    'src/components/Toast.tsx', 'src/components/Toast.css',
  ]
  for (const path of owned) assert.doesNotMatch(source(path), legacyPattern, `${path} still uses a deprecated token alias`)

  // Shared app.css blocks restyled here: buttons, dialogs, forms, teams, members, settings.
  const app = source('src/styles/app.css')
  const buttons = app.slice(app.indexOf('/* ---- Buttons ----'), app.indexOf('.skill-manage-menu {'))
  assert.ok(buttons.length > 0)
  assert.doesNotMatch(buttons, legacyPattern)
  for (const start of ['.empty-actions,.modal-actions{', '.modal-layer{', '.form-stack{', '.teams-page-body{', '.member-list{', '.settings-page{', '.team-card,.joined-team-row{']) {
    const line = app.split('\n').find((candidate) => candidate.startsWith(start))
    assert.ok(line, `${start} block exists`)
    assert.doesNotMatch(line, legacyPattern, `${start} block still uses a deprecated token alias`)
  }
})
