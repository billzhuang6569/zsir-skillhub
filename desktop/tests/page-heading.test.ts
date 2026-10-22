import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')
const rule = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`)
  assert.ok(start >= 0, `${selector} rule exists`)
  return css.slice(start, css.indexOf('}', start) + 1)
}

test('all six pages share one PageHeading: h1 + optional subtitle + trailing actions (acceptance round 1)', () => {
  const heading = source('src/components/PageHeading.tsx')
  assert.match(heading, /<div className="page-heading">\s*<h1>\{title\}<\/h1>\s*\{subtitle && <span className="page-subtitle">\{subtitle\}<\/span>\}\s*<\/div>\s*\{actions\}/)
  const pages: Record<string, RegExp> = {
    SkillsPage: /<PageHeading\s+title="我的 Skills"\s+subtitle="在左侧选择 Skill，在右侧持续查看和管理"/,
    TeamSharedPage: /<PageHeading\s+title="团队共享"\s+subtitle="从团队目录选择 Skill，在右侧查看和安装"/,
    TeamsPage: /<PageHeading title="My Team" subtitle="管理团队、成员与共享 Skill" actions=/,
    MarketplacePage: /<PageHeading\s+title="Skill 商店"\s+subtitle="发现并安装公开发布的 Agent Skill"[\s\S]*?headRef=\{pageHeadRef\}/,
    KeysPage: /<PageHeading\s+title=\{KEYS_PAGE_COPY\.title\}\s+subtitle=\{scope === 'team' \? KEYS_PAGE_COPY\.teamSubtitle : KEYS_PAGE_COPY\.personalSubtitle\}/,
    SettingsPage: /<PageHeading title="设置" subtitle="偏好与账号" \/>/,
  }
  for (const [page, pattern] of Object.entries(pages)) {
    const text = source(`src/pages/${page}.tsx`)
    assert.match(text, pattern, page)
    assert.doesNotMatch(text, /className="subtitle"|-heading"><h1>/, page)
  }
  // The old per-page heading classes are gone.
  const css = ['src/styles/app.css', 'src/pages/KeysPage.css', 'src/pages/MarketplacePage.css', 'src/pages/TeamSharedPage.css'].map(source).join('\n')
  assert.doesNotMatch(css, /\.(skills|teams|keys|marketplace|team-shared)-heading\b|\.page-title-row \.subtitle|\.page-title-row h1/)
})

test('PageHeading uses the 我的 Skills title font everywhere and a 13.5px muted subtitle that wraps under it', () => {
  const app = source('src/styles/app.css')
  const h1 = rule(app, '.page-heading h1')
  assert.match(h1, /font-size: 30px;/)
  assert.match(h1, /font-weight: 700;/)
  assert.match(h1, /line-height: 38px;/)
  assert.match(rule(app, '.page-heading'), /flex-wrap: wrap;[^}]*align-items: baseline;/)
  const subtitle = rule(app, '.page-subtitle')
  assert.match(subtitle, /color: var\(--color-muted\);/)
  assert.match(subtitle, /font-size: 13\.5px;/)
  assert.match(app, /@media \(max-width: 720px\) \{[^]*?\.page-heading \{ align-items: flex-start; flex-direction: column; gap: 3px; \}/)
})

test('My Team 已加入 empty state offers a 使用团队 ID 加入 button that opens the join dialog', () => {
  const teams = source('src/pages/TeamsPage.tsx')
  assert.match(teams, /<button type="button" className="btn btn-ghost btn-sm" onClick=\{\(\) => openDialog\('join'\)\}><Icon name="user-plus" size=\{13\} \/>使用团队 ID 加入<\/button>/)
  assert.doesNotMatch(teams, /className="link-button"[^>]*>使用团队 ID 加入/)
})

test('every APP page title is the one PageHeading h1 at 30px/700/38px with the same head spacing (#317)', () => {
  const pages = ['SkillsPage', 'TeamSharedPage', 'TeamsPage', 'MarketplacePage', 'KeysPage', 'SettingsPage']
  for (const page of pages) {
    const text = source(`src/pages/${page}.tsx`)
    assert.equal(text.match(/<PageHeading\b/g)?.length, 1, `${page} renders one PageHeading`)
    assert.doesNotMatch(text, /<h1\b/, `${page} renders no h1 of its own`)
  }
  assert.match(source('src/pages/KeyVaultPage.tsx'), /return <KeysPage/)
  // No page stylesheet restyles the page title.
  const css = ['src/styles/app.css', ...['KeysPage', 'MarketplacePage', 'TeamSharedPage', 'TeamsPage', 'SettingsPage'].map((page) => `src/pages/${page}.css`)].map(source).join('\n')
  assert.equal(css.match(/\.page-heading h1\b/g)?.length, 1, 'only the shared .page-heading h1 rule sets the title font')
  const app = source('src/styles/app.css')
  assert.match(rule(app, '.page-head-inner'), /padding: 22px 32px 0;/)
  // The full-bleed Skill browser keeps the same title top; only the side gutter narrows.
  assert.match(app, /\.app-workspace\.skill-browser-open \.page-head-inner \{ padding: 22px 16px 0; \}/)
  // Compact the marketplace action before it can wrap away from refresh/import.
  assert.match(rule(app, '.page-head-inner'), /container: page-head \/ inline-size;/)
  assert.match(app, /\.skills-title-row \{ flex-wrap: nowrap; \}/)
  assert.match(app, /@container page-head \(max-width: 940px\) \{[^}]+\.marketplace-shortcut \{ width: 36px; padding: 0; gap: 0; \}/)
  assert.match(app, /\.skills-title-row \.marketplace-shortcut-label \{ display: none; \}/)
})

test('我的 Skills refresh button keeps its size: busy is an icon spin + aria-busy, stays clickable, no hint text (#317)', () => {
  const page = source('src/pages/SkillsPage.tsx')
  assert.match(page, /className=\{`ico-btn header-refresh\$\{skillsRefreshing \? ' refreshing' : ''\}`\}/)
  assert.match(page, /onClick=\{\(\) => void loadSkills\(\)\}\s*aria-busy=\{skillsRefreshing\}/)
  assert.doesNotMatch(page, /disabled=\{skillsRefreshing\}/)
  assert.match(page, /title=\{skillsRefreshing \? '正在刷新…' : '刷新'\}\s*aria-label=\{skillsRefreshing \? '正在刷新…' : '刷新'\}\s*><Icon name="refresh" size=\{15\} \/><\/button>/)
  assert.doesNotMatch(page, /skills-cloud-loading|同步云端资料|刷新真实数据/)
  const app = source('src/styles/app.css')
  assert.doesNotMatch(app, /\.skills-cloud-loading/)
  assert.match(app, /@supports not \(container-type: inline-size\) \{\s*@media \(max-width: 1280px\)/)
  assert.match(app, /\.header-refresh\.refreshing > svg \{ color: var\(--color-brand\); animation: spin \.9s linear infinite; \}/)
  assert.match(app, /@media \(prefers-reduced-motion: reduce\) \{\s*\.header-refresh\.refreshing > svg \{ animation: none; color: var\(--color-muted\); opacity: \.45; \}/)
})
