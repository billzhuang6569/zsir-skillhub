// #263 (V6 of #256): app-wide empty / error / loading states, motion tokens, reduced
// motion, the removal of every legacy token alias, and the a11y pass.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CLEAR_FILTERS_LABEL, EMPTY_COPY, LOADING_COPY, LOAD_FAILED_TITLE, RETRY_LABEL, loadFailedMessage } from '../src/lib/state-copy.ts'
import { KEYS_EMPTY_COPY } from '../src/lib/keys.ts'
import { colorValue, contrastRatio, readTokens } from '../scripts/generate-design-tokens.mjs'
import { LEGACY_TOKEN_PATTERN } from './legacy-token-names.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : [path]
})
const sourceFiles = walk(resolve(desktopRoot, 'src')).filter((path) => /\.(css|tsx?|json)$/.test(path))

test('no legacy token, --tsh- alias, Manrope or old blue anywhere under desktop/src', () => {
  // The issue's acceptance grep: rg -- "--tsh-|Manrope|#3574f0|--accent\b|--ink2|--line2" desktop/src
  const acceptance = /--tsh-|Manrope|#3574f0|--accent\b|--ink2|--line2/i
  for (const path of sourceFiles) {
    const source = readFileSync(path, 'utf8')
    const where = relative(desktopRoot, path)
    assert.doesNotMatch(source, acceptance, where)
    assert.doesNotMatch(source, LEGACY_TOKEN_PATTERN, `${where} uses a deprecated var(--…) alias`)
    assert.doesNotMatch(source, /tsh-tokens|store-tokens/, where)
  }
  assert.equal(existsSync(resolve(desktopRoot, 'src/styles/store-tokens.css')), false)
  const tokensCss = read('src/styles/design-tokens.css')
  assert.doesNotMatch(tokensCss, /Legacy names|var\(--/)
  assert.equal((JSON.parse(read('design-tokens.json')) as { legacy?: unknown }).legacy, undefined)
})

test('state copy: every empty state says what happened and what to do next; errors say 加载失败 and offer 重试', () => {
  assert.equal(RETRY_LABEL, '重试')
  assert.equal(CLEAR_FILTERS_LABEL, '清除筛选')
  assert.equal(LOAD_FAILED_TITLE, '加载失败')
  assert.equal(loadFailedMessage('团队数据', ' 网络超时 '), '团队数据加载失败：网络超时')
  assert.equal(loadFailedMessage('钥匙库'), '钥匙库加载失败')
  assert.equal(loadFailedMessage('', null), '加载失败')
  for (const [name, copy] of Object.entries(EMPTY_COPY)) {
    assert.ok(copy.title.length > 0 && !/[。.]$/.test(copy.title), `${name} title is a short statement`)
    assert.match(copy.hint, /。$/, `${name} hint is a full sentence`)
    assert.notEqual(copy.title, copy.hint, name)
  }
  assert.deepEqual(EMPTY_COPY.storeNoResults, { title: '没有找到相关技能', hint: '换个关键词，或清除筛选条件再试试。' })
  assert.equal(KEYS_EMPTY_COPY, `${EMPTY_COPY.keysNone.title}。${EMPTY_COPY.keysNone.hint}`)
  for (const label of Object.values(LOADING_COPY)) assert.match(label, /^正在.+…$/)
})

// Every page or component in the #263 scope that has an empty, error or loading state.
const STATEFUL = [
  'src/pages/SkillsPage.tsx', 'src/pages/TeamsPage.tsx', 'src/pages/TeamSharedPage.tsx', 'src/pages/MarketplacePage.tsx',
  'src/pages/KeysPage.tsx', 'src/pages/KeyVaultPage.tsx', 'src/components/SkillDetailSheet.tsx', 'src/components/TeamDetailSheet.tsx',
  'src/components/NotificationCenter.tsx', 'src/components/store/StoreFeed.tsx',
]

test('pages with empty / error / loading states use the shared copy helper, not inline sentences or spinners', () => {
  for (const path of STATEFUL) {
    const source = read(path)
    assert.match(source, /from '(?:\.\.\/)+lib\/state-copy\.js'/, `${path} imports lib/state-copy`)
    assert.doesNotMatch(source, /加载失败|读取失败[：:]/, `${path} spells out 加载失败 inline`)
    assert.doesNotMatch(source, />重试</, `${path} spells out 重试 inline`)
    assert.doesNotMatch(source, />清除筛选</, `${path} spells out 清除筛选 inline`)
    assert.doesNotMatch(source, /className="loading-block/, `${path} still renders a spinner loading block`)
    assert.doesNotMatch(source, /暂无通知|没有找到相关技能|还没有创建团队|这个团队还没有共享 Skill/, `${path} inlines empty copy`)
  }
  // The key policy error inside 需要的钥匙 keeps #255's markup, with the shared copy.
  assert.match(read('src/components/SkillDetailSheet.tsx'), /policy\.error && <div className="banner banner-error key-policy-error" role="alert">/)
})

test('the shared views render the copy: EmptyState (title + hint + next step), LoadError (alert + 重试), SkeletonBlock (status)', () => {
  const views = read('src/components/StateViews.tsx')
  assert.match(views, /<h3>\{copy\.title\}<\/h3>\s*<p>\{copy\.hint\}<\/p>\s*\{children\}/)
  assert.match(views, /role="alert"[^]*\{message\}[^]*onClick=\{onRetry\}>\{RETRY_LABEL\}<\/button>/)
  assert.match(views, /role="status" aria-live="polite" data-skeleton=\{layout\}>\s*<span className="sr-only">\{label\}<\/span>/)
  assert.doesNotMatch(views, /spin-icon/)
  for (const [path, pattern] of [
    ['src/pages/SkillsPage.tsx', /<SkeletonBlock layout="rows" label=\{LOADING_COPY\.skills\} \/>/],
    ['src/pages/TeamsPage.tsx', /<SkeletonBlock layout="cards" label=\{LOADING_COPY\.teams\} \/>/],
    ['src/pages/TeamSharedPage.tsx', /<SkeletonBlock layout="rows" label=\{LOADING_COPY\.teamSharedSkills\} \/>/],
    ['src/pages/MarketplacePage.tsx', /<SkeletonBlock layout="rows" count=\{3\} label=\{LOADING_COPY\.storeMine\} \/>/],
    ['src/pages/KeysPage.tsx', /<SkeletonBlock layout="rows" count=\{3\} label=\{LOADING_COPY\.keys\} \/>/],
    ['src/components/SkillDetailSheet.tsx', /<SkeletonBlock layout="text" label=\{LOADING_COPY\.sheetSource\} \/>/],
    ['src/components/TeamDetailSheet.tsx', /<SkeletonBlock layout="detail" label=\{LOADING_COPY\.teamDetail\} \/>/],
  ] as const) assert.match(read(path), pattern, path)
  // The store skeletons are the same primitive.
  const storeUi = read('src/components/store/StoreUI.tsx')
  assert.match(storeUi, /import \{ Skeleton \} from '\.\.\/StateViews\.js'/)
  assert.doesNotMatch(storeUi + read('src/components/store/StoreUI.css'), /tsh-skel[^-]|tsh-pulse/)
  // 重试 on a document load error re-reads SKILL.md, the tree and the selected file.
  const sheet = read('src/components/SkillDetailSheet.tsx')
  assert.equal(sheet.match(/documentReload\]\)/g)?.length, 3)
})

test('skeleton: 1.4s pulse, static under reduced motion', () => {
  const css = read('src/components/StateViews.css')
  assert.match(css, /\.skeleton \{[^}]*background: var\(--color-surface-sunken\);[^}]*animation: skeleton-pulse 1\.4s ease-in-out infinite;/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.skeleton \{ animation: none; \}/)
})

test('motion tokens time hover lift, sheets and Toast; reduced motion stops everything app-wide', () => {
  const tokens = read('src/styles/design-tokens.css')
  assert.match(tokens, /--motion-fast: 140ms;/)
  assert.match(tokens, /--motion-base: 200ms;/)
  assert.match(tokens, /--ease-standard: cubic-bezier\(\.32, \.72, \.24, 1\);/)

  const base = 'var\\(--motion-base\\) var\\(--ease-standard\\)'
  const global = read('src/styles/global.css')
  assert.match(global, new RegExp(`\\.pop-in \\{ animation: pop ${base}; \\}`))
  assert.match(global, new RegExp(`\\.pop-out \\{ animation: pop-out ${base} forwards; \\}`))
  assert.match(read('src/components/SkillDetailSheet.css'), new RegExp(`\\.detail-sheet \\{[^}]*transition: transform ${base}, opacity ${base};`))
  assert.match(read('src/styles/app.css'), new RegExp(`\\.scrim \\{[^}]*transition: opacity ${base};`))
  for (const path of ['src/components/SkillCard.css', 'src/components/store/StoreUI.css', 'src/components/store/TopicArticle.css']) {
    assert.match(read(path), new RegExp(`transition: box-shadow ${base}, transform ${base};`), path)
  }
  assert.match(read('src/components/SkillLibraryList.css'), /transition-duration: var\(--motion-base\);\n\s*transition-timing-function: var\(--ease-standard\);/)
  const toast = read('src/components/Toast.tsx')
  assert.match(toast, /export const TOAST_EXIT_MS = 200/)
  assert.match(toast, /\$\{t\.leaving \? 'pop-out' : 'pop-in'\}/)

  // One global rule, plus the spot checks the issue names.
  assert.match(global, /@media \(prefers-reduced-motion: reduce\) \{\n\s*\*, \*::before, \*::after \{[^}]*animation-duration: \.01ms !important;[^}]*animation-iteration-count: 1 !important;[^}]*transition-duration: \.01ms !important;/)
  assert.match(global, /\.spin-icon \{ animation: none !important;/)
  assert.match(read('src/components/SkillLibraryList.css'), /@media \(prefers-reduced-motion: reduce\) \{\n\s*\.skill-library-avatar-wrap\.team-shared::before \{ animation: none;/)
  assert.match(read('src/styles/app.css'), /@media \(prefers-reduced-motion: reduce\) \{ \.sidebar-resizer::after \{ transition: none; \} \}/)
  // No hard-coded sheet curve or pop timing left.
  for (const path of sourceFiles.filter((file) => file.endsWith('.css') && !file.endsWith('design-tokens.css'))) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /cubic-bezier\(/, relative(desktopRoot, path))
  }
})

test('focus: every interactive element gets the 2px brand ring; a skip link reaches the main content; dialogs trap focus', () => {
  const global = read('src/styles/global.css')
  assert.match(global, /:where\(a\[href\], button, input, select, textarea, summary, \[tabindex\]:not\(\[tabindex="-1"\]\),[^)]*\[role="tab"\][^)]*\):focus-visible \{\n\s*outline: 2px solid var\(--color-brand\);\n\s*outline-offset: 2px;/)
  assert.match(global, /\.skip-link:focus \{ top: var\(--space-3\); \}/)
  const app = read('src/App.tsx')
  assert.match(app, /<a className="skip-link" href="#main-content"[^\n]*>跳到主要内容<\/a>\n\s*<Sidebar/)
  assert.match(app, /<main className="app-main" id="main-content" tabIndex=\{-1\}>/)
  for (const path of sourceFiles.filter((file) => file.endsWith('.tsx') && !file.endsWith('FocusTrapDialog.tsx'))) {
    // Non-modal popovers (#289 header problem popover) say so with aria-modal="false"; modal dialogs use FocusTrapDialog.
    const modal = (readFileSync(path, 'utf8').match(/<[a-z]+\b[^>]*\brole="dialog"[^>]*>/g) ?? []).filter((tag) => !tag.includes('aria-modal="false"'))
    assert.deepEqual(modal, [], `${relative(desktopRoot, path)} hand-rolls a dialog without the focus trap`)
  }
})

test('icon-only buttons carry an aria-label', () => {
  const iconOnly = /<button\b((?:[^>]|=>)*?)>\s*<(?:Icon|StoreIcon)\b[^>]*\/>\s*<\/button>/g
  for (const path of sourceFiles.filter((file) => file.endsWith('.tsx'))) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(iconOnly)) {
      assert.match(match[1] ?? '', /aria-label(?:ledby)?=/, `${relative(desktopRoot, path)}: ${match[0].slice(0, 120)}`)
    }
  }
})

test('state borders on controls reach 3:1 against the surface in dark mode; the focus ring reaches 3:1 in both themes', () => {
  const tokens = readTokens()
  const hex = (value: string): number[] => [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16))
  const mix = (color: string, over: string, percent: number): string => '#' + hex(color)
    .map((channel, index) => Math.round(channel * percent / 100 + (hex(over)[index] ?? 0) * (1 - percent / 100)).toString(16).padStart(2, '0')).join('')
  const borders: Array<[string, string, string, number]> = [
    ['src/components/SkillCard.css', '.card-agent-button.installed', 'success', 60],
    ['src/components/SkillCard.css', '.card-agent-button.broken', 'danger', 70],
    ['src/components/SkillDetailSheet.css', '.profile-agent-button.installed', 'success', 60],
    ['src/components/SkillDetailSheet.css', '.profile-agent-button.broken', 'danger', 70],
    ['src/pages/TeamSharedPage.css', '.team-shared-selector-trigger[aria-expanded="true"]', 'brand', 60],
  ]
  const surface = colorValue(tokens, 'surface', 'dark')
  for (const [path, selector, color, percent] of borders) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(read(path), new RegExp(`${escaped} \\{[^}]*border-color: color-mix\\(in srgb, var\\(--color-${color}\\) ${percent}%, transparent\\);`), selector)
    const ratio = contrastRatio(mix(colorValue(tokens, color, 'dark'), surface, percent), surface)
    assert.ok(ratio >= 3, `${selector} border is ${ratio.toFixed(2)}:1 on the dark surface`)
  }
  for (const theme of ['light', 'dark'] as const) {
    for (const background of ['surface', 'bg', 'surface-sunken']) {
      const ratio = contrastRatio(colorValue(tokens, 'brand', theme), colorValue(tokens, background, theme))
      assert.ok(ratio >= 3, `focus ring on ${background} (${theme}) is ${ratio.toFixed(2)}:1`)
    }
  }
})
