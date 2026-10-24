import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { formatStoreDate, storeDetailByline, storeDetailStats } from '../src/lib/store-home.ts'
import { mergeMarketplaceSkill } from '../src/lib/skills.ts'
import type { ApiMarketplaceItem } from '../src/lib/api.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')
const sheet = read('src/components/SkillDetailSheet.tsx')
const sheetCss = read('src/components/SkillDetailSheet.css')
// Comments explain the old stack in words; only the rules themselves are checked.
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')
const pageCss = withoutComments(read('src/pages/MarketplacePage.css'))
const storeCss = withoutComments(read('src/components/store/StoreUI.css'))

test('store detail hero: 64px avatar, name title with badges, displayName subtitle, by the title preference', () => {
  assert.match(sheet, /<SkillAvatarIcon className="sh-cat-icon sh-store-avatar" avatarUrl=\{skill\.avatarUrl\} status=\{skill\.avatarStatus\} size=\{64\} \/>/)
  assert.match(sheet, /const title = skillListText\(skill, preference\)/)
  // Badges stay with the text; copy, quick access and problems share a separate row.
  assert.match(sheet, /<h2 className="sh-store-title"><span[^>]*>\{title\.primary\}<\/span><MarketplaceBadges badges=\{skill\.marketplaceBadges\} \/>\{version && <span className="sh-title-version mono">\{version\}<\/span>\}<\/h2>/)
  assert.match(sheet, /className=\{`sh-store-subtitle\$\{title\.secondary/)
  assert.match(sheet, /\{title\.secondary \|\| UNANALYSED_SKILL_NAME\}/)
  assert.match(sheetCss, /\.sh-store-subtitle\.placeholder \{ color: var\(--color-muted\);/)
  assert.match(sheetCss, /\.sh-store-avatar \{ border-radius: var\(--radius-md\); \}/)
  assert.match(sheetCss, /\.sh-store-subtitle \{[^}]*color: var\(--color-ink\); font-size: 13px; font-weight: 600;/)
  // #261: local and team details share the same header — name title + copy button, displayName subtitle, 64px avatar.
  assert.match(sheet, /\{\.\.\.blankDragRegion\(\)\}><SkillDetailTitle skill=\{skill\} onCopyName=\{copySkillName\} problem=\{/)
  assert.doesNotMatch(sheet, /StoreDetailTitle|<h2>\{skill\.displayName\}<button className="rawname mono"/)
  assert.match(sheet, /<SkillAvatarIcon className="sh-cat-icon" avatarUrl=\{skill\.avatarUrl\} status=\{skill\.avatarStatus\} size=\{64\} \/>/)
  assert.match(sheet, /\{isMarketplaceCatalogSource\(skill\) && <StoreDetailFacts skill=\{skill\} \/>\}/)
  assert.match(sheet, /<div className="sh-id" \{\.\.\.blankDragRegion\(\)\}>/)
})

test('detail title wraps independently of its first-line action group (#527)', () => {
  assert.match(sheet, /<\/h2>\s*<div className="sh-title-actions">\s*<TeamSkillUpdateButton skill=\{skill\} \/>\s*<button type="button" className="rawname sh-store-copy"[^>]*onClick=\{onCopyName\}><Icon name="doc" size=\{16\} \/><\/button>\s*\{pinnable && <SkillQuickAccessButton skill=\{skill\} \/>\}\s*\{problemButton\}/)
  assert.match(sheetCss, /\.sh-title-row \{[^}]*align-items: flex-start;[^}]*min-width: 0;/)
  assert.match(sheetCss, /\.sh-title-row > h2 \{[^}]*min-width: 0;[^}]*flex: 0 1 auto;[^}]*font-size: 20px;[^}]*line-height: 28px;/)
  assert.match(sheetCss, /\.sh-store-title > span:first-child \{[^}]*overflow-wrap: anywhere;/)
  assert.match(sheetCss, /\.sh-title-actions \{[^}]*display: flex;[^}]*flex: none;[^}]*flex-wrap: nowrap;[^}]*gap: var\(--space-2\);/)
  assert.match(sheetCss, /\.sh-store-copy \{[^}]*flex: none;[^}]*width: 28px; height: 28px; padding: 0;/)
  assert.match(sheetCss, /\.rawname:focus-visible \{[^}]*outline:/)
  const quickAccess = read('src/components/SkillTagPopover.tsx')
  assert.match(quickAccess, /disabled=\{!organizerReady\}/)
  assert.match(quickAccess, /aria-pressed=\{pinned\}/)
  assert.match(quickAccess, /<Icon name="star" size=\{16\} \/>/)
  assert.match(sheet, /title=\{`复制 Skill 名称：\$\{skill.name\}`\} aria-label=\{`复制 Skill 名称 \$\{skill.name\}`\}/)
})

const item = (fields: Partial<ApiMarketplaceItem> = {}): ApiMarketplaceItem => ({
  id: '7a2c5c1e-9d4e-4f0a-a4a0-0d2a5a4a9c11', name: 'zsir-weekly', displayName: '周报助手', description: 'd', labels: [], triggerScenarios: [],
  compatibleAgents: [], envDependencies: [], currentVersion: '1.2.0', author: { id: 'u1', displayName: 'Bill' } as ApiMarketplaceItem['author'],
  version: { id: 'v1', version: '1.2.0', createdAt: '2026-10-01T00:00:00Z' }, downloadCount: 318, installCount: 27_300,
  publishedAt: '2026-10-09T08:00:00Z', firstPublishedAt: '2026-09-01T08:00:00Z', userCount: 42, skillMd: '# x', ...fields,
})

test('uploader byline helper stays labelled (上传者, never 作者); the sheet shows it in the origin line (#289)', () => {
  const skill = mergeMarketplaceSkill(item(), undefined)
  assert.deepEqual(storeDetailByline(skill), [
    { key: 'uploader', label: 'Skill 上传者', value: 'Bill', icon: 'user-round' },
    { key: 'version', label: '版本', value: '1.2.0', icon: 'tag' },
    { key: 'updated', label: '更新于', value: formatStoreDate('2026-10-09T08:00:00Z'), icon: 'calendar' },
  ])
  assert.deepEqual(storeDetailByline({ authorName: '', version: '1.0.0', marketplacePublishedAt: null }).map((pair) => pair.key), ['version'])
  const helper = read('src/lib/store-home.ts').slice(read('src/lib/store-home.ts').indexOf('export function storeDetailByline'))
  assert.doesNotMatch(helper, /作者|join\(' · '\)/)
  // #289 board 1: the duplicated uploader / version / 更新于 pairs left the stats block;
  // every Skill now gets one 「来源 · 上传者/作者 <UserChip> · 更新于」 line instead.
  assert.doesNotMatch(sheet, /sh-store-byline|sh-store-pair/)
  assert.match(sheet, /<\/div><SkillOriginLineView skill=\{skill\} \/>\{isMarketplaceCatalogSource\(skill\) && <StoreDetailFacts skill=\{skill\} \/>\}/)
  assert.match(sheet, /\{line\.author\.label\}<UserChip name=\{line\.author\.name\} me=\{line\.author\.me\} \/>/)
})

test('four-up stats: 安装次数 / 在用用户 / ZIP 下载 / 上架时间, tabular, and a missing value hides its cell', () => {
  const skill = mergeMarketplaceSkill(item(), undefined)
  assert.deepEqual(storeDetailStats(skill), [
    { key: 'installs', label: '安装次数', value: '2.7 万', icon: 'download' },
    { key: 'users', label: '在用用户', value: '42', icon: 'users-round' },
    { key: 'downloads', label: 'ZIP 下载', value: '318', icon: 'package' },
    { key: 'listed', label: '上架时间', value: formatStoreDate('2026-09-01T08:00:00Z'), icon: 'calendar' },
  ])
  // Every cell carries its design-system line icon (16px, stroke 1.75) in a tinted chip beside the label.
  assert.match(sheet, /<dt><span className="sh-store-stat-icon" aria-hidden="true"><Icon name=\{stat\.icon\} size=\{16\} strokeWidth=\{1\.75\} \/><\/span>\{stat\.label\}<\/dt>/)
  assert.match(sheetCss, /\.sh-store-stat-icon \{[^}]*background: var\(--color-brand-tint\); color: var\(--color-brand\);/)
  const icon = read('src/components/Icon.tsx')
  for (const name of ['download', 'users-round', 'package', 'calendar', 'user-round', 'tag']) assert.match(icon, new RegExp(`\\n  '?${name}'?: [A-Z]\\w+,`), name)
  assert.match(icon, /strokeLinecap="round"/)
  // An older Server without user counts or first-listing time: the cell is hidden, never 0.
  const older = mergeMarketplaceSkill(item({ userCount: undefined, managedUserCount: undefined, firstPublishedAt: undefined }), undefined)
  assert.deepEqual(storeDetailStats(older).map((stat) => stat.label), ['安装次数', 'ZIP 下载', '上架时间'])
  assert.equal(storeDetailStats(older).at(-1)?.value, formatStoreDate('2026-10-09T08:00:00Z'))
  assert.deepEqual(storeDetailStats({}), [])
  assert.match(sheetCss, /\.sh-store-stat dd \{[^}]*font-variant-numeric: tabular-nums;/)
  assert.match(sheet, /\{stats\.length > 0 && <dl className="sh-store-stats" aria-label="Skill 数据">/)
})

test('topic surfaces avoid the ex-#183 layer stack and respect reduced motion', () => {
  const topicRules = [...pageCss.matchAll(/([^{}]*marketplace-topic[^{}]*)\{([^}]*)\}/g)].map((match) => match[0])
  assert.ok(topicRules.length > 0)
  for (const rule of topicRules) {
    assert.doesNotMatch(rule, /backdrop-filter|mask-image|z-index:\s*-/, rule)
  }
  assert.doesNotMatch(pageCss, /\.marketplace-topic-card|\.marketplace-topic-hero::after/)
  const topicCardRules = [...storeCss.matchAll(/([^{}]*\.tsh-topic[^{}]*)\{([^}]*)\}/g)].map((match) => match[0])
  for (const rule of topicCardRules) assert.doesNotMatch(rule, /backdrop-filter|mask-image|z-index:\s*-|::after|::before/, rule)
  assert.match(storeCss, /\.tsh-topic:hover \{ transform: translateY\(-2px\); box-shadow: [^}]+\}/)
  assert.match(storeCss, /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.tsh-topic:hover \{ transform: none; \}/)
  // The scrolling track leaves room for the lift and shadow so neither is clipped into a hard edge.
  assert.match(storeCss, /\.tsh-carousel-track \{[^}]*padding: 6px 8px 16px; margin: -6px -8px -16px;/)
})
