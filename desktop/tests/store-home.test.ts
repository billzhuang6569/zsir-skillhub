import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  RANKING_LIMIT, carouselEdges, editorialLabelsBesideBadges, formatStoreCount, loadRanking, loadStoreStats,
  needsApiKey, normalizeStoreBadges, runInstallClick, searchSuggestions, statTiles, storeInstallState, storeTabs, topicTone,
} from '../src/lib/store-home.ts'
import { mergeMarketplaceSkill } from '../src/lib/skills.ts'
import type { ApiMarketplaceItem, ApiMarketplaceStats } from '../src/lib/api.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')
const page = read('src/pages/MarketplacePage.tsx')
const storeUi = read('src/components/store/StoreUI.tsx')
const storeCss = read('src/components/store/StoreUI.css')
const designTokens = read('src/styles/design-tokens.css')
const api = read('src/lib/api.ts')

const item = (overrides: Partial<ApiMarketplaceItem> = {}): ApiMarketplaceItem => ({
  id: 'skill-1', name: 'code-review', displayName: '代码审查官', description: 'desc', labels: [], triggerScenarios: [],
  compatibleAgents: [], envDependencies: [], currentVersion: '1.0.0',
  author: { id: 'u1', displayName: 'Bill' } as ApiMarketplaceItem['author'],
  version: { id: 'v1', version: '1.0.0', createdAt: '2026-10-01T00:00:00Z' }, downloadCount: 3, installCount: 12, publishedAt: '2026-10-01T00:00:00Z',
  ...overrides,
})

const stats: ApiMarketplaceStats = {
  totalSkills: 191243, newThisWeek: 40, installsToday: 2318, activeAuthors: 87,
  dailyInstalls: [10, 20, 30], weeklyNewSkills: [10, 20, 40],
}

test('tabs are 首页 / 全部技能 / 我的, with 审核队列 only for store admins', () => {
  assert.deepEqual(storeTabs({ signedIn: false, admin: false }).map((tab) => tab.label), ['首页', '全部技能'])
  assert.deepEqual(storeTabs({ signedIn: true, admin: false }).map((tab) => tab.label), ['首页', '全部技能', '我的'])
  assert.deepEqual(storeTabs({ signedIn: true, admin: true }).map((tab) => [tab.id, tab.label]), [['home', '首页'], ['catalog', '全部技能'], ['mine', '我的'], ['review', '审核队列']])
  // 「我的」 renders exactly the former 我的提交 panel.
  assert.match(page, /mode === 'mine' && privilegedStateIsCurrent && currentUser && <section className="marketplace-account-panel"/)
})

test('badges render in the fixed server order, ignore unknown values and back-fill old boolean flags once', () => {
  assert.deepEqual(normalizeStoreBadges(['new', 'hot', 'original', 'featured', 'new', 'vip']), ['featured', 'original', 'hot', 'new'])
  assert.deepEqual(normalizeStoreBadges(['new'], { featured: true, original: true }), ['featured', 'original', 'new'])
  assert.deepEqual(normalizeStoreBadges(['featured'], { featured: true }), ['featured'])
  assert.deepEqual(normalizeStoreBadges(undefined, { featured: false }), [])
  // 热门 / 新上架 are never derived on the client, even for a brand-new, heavily installed listing.
  assert.deepEqual(normalizeStoreBadges(undefined, {}), [])
  const merged = mergeMarketplaceSkill(item({ badges: ['hot'], featured: true, original: true, userCount: 4, managedUserCount: 9, firstPublishedAt: '2026-09-01T00:00:00Z' }), undefined)
  assert.deepEqual(merged.marketplaceBadges, ['featured', 'original', 'hot'])
  assert.equal(merged.marketplaceOriginal, true)
  assert.equal(merged.marketplaceUserCount, 9)
  assert.equal(merged.marketplaceFirstPublishedAt, '2026-09-01T00:00:00Z')
  assert.equal(mergeMarketplaceSkill(item({ userCount: 4 }), undefined).marketplaceUserCount, 4)
})

test('精选 is never repeated among editorial short labels', () => {
  assert.deepEqual(editorialLabelsBesideBadges(['精选', '效率工具', '热门', '效率工具 '], ['featured', 'hot']), ['效率工具'])
  assert.deepEqual(editorialLabelsBesideBadges(['精选', '写作'], []), ['写作'])
  assert.match(page, /<EditorialLabels labels=\{editorialLabelsBesideBadges\(/)
  assert.doesNotMatch(page + read('src/components/SkillCard.tsx') + read('src/components/SkillDetailSheet.tsx'), /<EditorialLabels featured=/)
})

test('StoreBadges show icon and word for each badge and wrap instead of folding into +N', () => {
  assert.match(storeUi, /badges\.map\(\(badge\) => <StoreTag key=\{badge\} tone=\{STORE_BADGE_VIEW\[badge\]\.tone\} icon=\{STORE_BADGE_VIEW\[badge\]\.icon\}>\{STORE_BADGE_VIEW\[badge\]\.label\}/)
  assert.match(storeCss, /\.tsh-badges \{[^}]*flex-wrap: wrap;/)
  assert.match(read('src/components/SkillCard.tsx'), /return <StoreBadges badges=\{badges\} \/>/)
})

test('stat tiles use real counts with the web math; missing stats hide the panel instead of showing zeros', async () => {
  const tiles = statTiles(stats)
  assert.deepEqual(tiles.map((tile) => [tile.label, tile.value]), [['Skill 总数', '19.1 万'], ['本周新增', '40'], ['今日安装', '2,318'], ['活跃作者', '87']])
  assert.deepEqual(tiles[0]?.trend, [191183, 191203, 191243])
  assert.equal(tiles[1]?.delta, '+100%')
  assert.equal(tiles[3]?.trend, undefined)
  assert.equal(formatStoreCount(273000), '27.3 万')
  assert.equal(await loadStoreStats(async () => { throw new Error('404 Not Found') }), null)
  assert.equal(await loadStoreStats(async () => ({ totalSkills: 3 })), null)
  assert.deepEqual(await loadStoreStats(async () => stats), { ...stats, generatedAt: undefined })
  assert.match(page, /\{storeStats && <aside className="tsh-panel" data-store-section="stats" aria-label="商店动态">/)
})

test('飙升榜 falls back to the popular ranking when trending is unavailable, and fails only if both fail', async () => {
  const calls: string[] = []
  const toSkill = (value: ApiMarketplaceItem): string => value.id
  const trending = await loadRanking({
    trending: async (range, limit) => { calls.push(`trending:${range}:${limit}`); return { range, items: [{ ...item({ id: 'a' }), trend: { recentInstalls: 12000, previousInstalls: 4000, growthPercent: 200 } }, { ...item({ id: 'b' }), trend: null }] } },
    popular: async () => { calls.push('popular'); return [] },
    toSkill,
  }, 'week', true)
  assert.equal(trending.mode, 'trending')
  assert.deepEqual(trending.items, [{ skill: 'a', growth: '+200%', metric: '1.2 万 次下载+安装' }, { skill: 'b', growth: null, metric: undefined }])
  assert.deepEqual(calls, [`trending:week:${RANKING_LIMIT}`])

  const fallback = await loadRanking({
    trending: async () => { throw new Error('404') },
    popular: async (limit) => { assert.equal(limit, RANKING_LIMIT); return [item({ id: 'p', installCount: 2318 })] },
    toSkill,
  }, 'day', true)
  assert.deepEqual(fallback, { mode: 'popular', items: [{ skill: 'p', growth: null, metric: '2,318 次安装' }] })

  let trendingCalled = false
  await loadRanking({ trending: async () => { trendingCalled = true; return { range: 'day', items: [] } }, popular: async () => [], toSkill }, 'day', false)
  assert.equal(trendingCalled, false)

  await assert.rejects(loadRanking({ trending: async () => { throw new Error('404') }, popular: async () => { throw new Error('down') }, toSkill }, 'day', true))
  // The page remembers that trending is unavailable and hides the panel when both sources fail.
  assert.match(page, /if \(value\.mode === 'popular'\) trendingAvailable\.current = false/)
  assert.match(page, /\{!rankingFailed && <div data-store-section="ranking">/)
})

test('「大家在搜」 uses the first five distinct editorial labels of popular + latest, never a badge word', () => {
  assert.deepEqual(searchSuggestions([
    { editorialLabels: ['精选', '周报'], badges: ['featured'] },
    { editorialLabels: ['周报', '写作', '热门'], badges: ['hot'] },
    { editorialLabels: ['调研', '翻译', '剪辑', '设计'] },
  ]), ['周报', '写作', '调研', '翻译', '剪辑'])
  assert.deepEqual(searchSuggestions([{ editorialLabels: [] }]), [])
  assert.match(page, /searchSuggestions\(\[\.\.\.home\.popular, \.\.\.home\.latest\]\)/)
  assert.match(storeUi, /if \(event\.key !== '\/'/)
  assert.match(page, /onSubmit=\{\(value\) => openCatalog\(\{ query: value \}\)\}/)
})

test('首页 sections appear in the design-system order without a download-client banner', () => {
  const order = ['search', 'stats', 'topics', 'featured', 'ranking', 'categories', 'latest']
    .map((section) => page.indexOf(`data-store-section="${section}"`))
  assert.ok(order.every((index) => index > 0), String(order))
  assert.deepEqual([...order].sort((left, right) => left - right), order)
  assert.doesNotMatch(page, /下载客户端/)
  assert.match(page, /apiGetMarketplace\(\{ featured: true, sort: 'popular', page: 1, pageSize: FEATURED_HOME_SIZE \}\)/)
  assert.match(page, /const FEATURED_HOME_SIZE = 6/)
  assert.match(page, /homeResult\.value\.latest\.slice\(0, LATEST_HOME_SIZE\)/)
  assert.match(page, /openCatalog\(\{ category: category\.name \}\)/)
  assert.match(page, /openCatalog\(\{ sort: 'latest' \}\)/)
})

test('the store 安装 button joins through the existing flow and never opens the detail sheet', () => {
  const events: string[] = []
  const event = { preventDefault: () => events.push('prevent'), stopPropagation: () => events.push('stop') }
  runInstallClick(event, () => events.push('install'))
  assert.deepEqual(events, ['prevent', 'stop', 'install'])
  assert.deepEqual(storeInstallState({ joined: false, update: false }), { label: '安装', disabled: false, kind: 'install' })
  assert.deepEqual(storeInstallState({ joined: true, update: true }), { label: '更新', disabled: false, kind: 'update' })
  assert.deepEqual(storeInstallState({ joined: true, update: false }), { label: '已加入', disabled: true, kind: 'joined' })
  assert.equal(storeInstallState({ joined: false, update: false }, true).disabled, true)
  assert.match(storeUi, /onClick=\{\(event\) => runInstallClick\(event, onInstall\)\}/)
  assert.match(storeUi, /storeInstallState\(marketplaceAction\(skill\), busy\)/)
  // Both store items carry the button; the page wires it to joinMySkills (update confirmation, intents, guards).
  assert.equal(storeUi.match(/<StoreInstallButton skill=\{skill\}/g)?.length, 2)
  assert.match(page, /const installStoreSkill = \(skill: LocalSkill\): void => \{ void joinMySkills\(skill\) \}/)
  // The open target is a sibling overlay; card content above it lets clicks through, the button stays clickable.
  assert.match(storeCss, /\.tsh-card > :not\(\.tsh-open\), \.tsh-row > :not\(\.tsh-open\) \{[^}]*pointer-events: none;/)
  assert.match(storeCss, /\.tsh-card \.tsh-install, \.tsh-row \.tsh-install \{ pointer-events: auto; \}/)
  assert.equal(needsApiKey([{ required: false }, { required: true }]), true)
  assert.equal(needsApiKey([{ required: false }]), false)
})

test('store cards follow the design-system SkillCard and respect reduced motion', () => {
  assert.match(storeCss, /\.tsh-card \{[^}]*border: 1px solid var\(--color-line\);[^}]*border-radius: var\(--radius-lg\);/)
  assert.match(storeCss, /\.tsh-card:not\(\.tsh-skel-card\):hover \{ box-shadow: var\(--shadow-card\); transform: translateY\(-2px\); \}/)
  assert.match(storeCss, /transition: box-shadow var\(--motion-base\) var\(--ease-standard\), transform var\(--motion-base\) var\(--ease-standard\);/)
  assert.match(storeCss, /@media \(prefers-reduced-motion: reduce\) \{[^@]*transform: none;/)
  assert.equal(topicTone(0), 'night')
  assert.deepEqual([1, 2, 3, 4].map(topicTone), ['mint', 'blush', 'lilac', 'mint'])
  assert.deepEqual(carouselEdges(0, 300, 300), { overflow: false, atStart: true, atEnd: true })
  assert.deepEqual(carouselEdges(0, 900, 300), { overflow: true, atStart: true, atEnd: false })
  assert.deepEqual(carouselEdges(600, 900, 300), { overflow: true, atStart: false, atEnd: true })
})

test('the store renders from the global design tokens; store-tokens.css and --tsh-* are gone (#263)', () => {
  assert.equal(existsSync(resolve(desktopRoot, 'src/styles/store-tokens.css')), false)
  assert.doesNotMatch(storeCss, /--tsh-|\.tsh-tokens/)
  assert.doesNotMatch(storeUi, /store-tokens|tsh-tokens/)
  assert.match(designTokens, /--color-brand: #1859e6;/)
  assert.match(designTokens, /--radius-lg: 18px;/)
  assert.doesNotMatch(designTokens, /--tsh-/)
  assert.match(page, /className="page-body marketplace-page-body marketplace-page"/)
})

test('desktop API exposes the store stats, trending and categories contract', () => {
  assert.match(api, /badges\?: Array<MarketplaceBadge>/)
  assert.match(api, /export type MarketplaceBadge = 'featured' \| 'original' \| 'hot' \| 'new'/)
  assert.match(api, /original\?: boolean/)
  assert.match(api, /firstPublishedAt\?: string \| null/)
  assert.match(api, /managedUserCount\?: number/)
  assert.match(api, /popularKind: 'hot' \| 'latest' \| 'recommended'/)
  assert.match(api, /apiFetch\('\/marketplace\/stats'/)
  assert.match(api, /\/marketplace\/trending\?\$\{new URLSearchParams\(\{ range, limit: String\(limit\) \}\)/)
  assert.match(api, /apiFetch\('\/marketplace\/categories'/)
})
