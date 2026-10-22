import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CATALOG_AUTO_PAGES, CATALOG_PAGE_SIZE, CATALOG_PREFETCH_MARGIN, CATALOG_SEARCH_DEBOUNCE_MS, DEFAULT_CATALOG_CRITERIA,
  FULL_CAPABILITIES, FeedController, applyCapabilities, catalogQuery, catalogResetKey, disableFeatures, feedAutoLoads,
  guardApiKeyFilter, pageHasMore, rankingPresetSort, readCapabilities, rejectedFeatures, visibleSorts,
  type FeedPage, type FeedSnapshot,
} from '../src/lib/store-catalog.ts'
import { ApiError } from '../src/lib/api.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')
const page = read('src/pages/MarketplacePage.tsx')
const feed = read('src/components/store/StoreFeed.tsx')
const css = read('src/components/store/StoreUI.css')

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined
  let rejectPromise: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((resolveFn, rejectFn) => { resolvePromise = resolveFn; rejectPromise = rejectFn })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}
const flush = (): Promise<void> => new Promise((resolveFn) => setImmediate(resolveFn))

function harness() {
  const snapshots: FeedSnapshot<string>[] = []
  const controller = new FeedController<string>((item) => item, (next) => snapshots.push(next))
  const last = (): FeedSnapshot<string> => snapshots[snapshots.length - 1]!
  return { controller, last }
}

test('a changed sort, filter or query resets the feed and drops responses still in flight', async () => {
  const { controller, last } = harness()
  const oldPage = deferred<FeedPage<string>>()
  controller.reset(() => oldPage.promise)
  assert.equal(last().status, 'loading')
  const newPage = deferred<FeedPage<string>>()
  controller.reset(() => newPage.promise)
  assert.deepEqual(last().items, [])
  newPage.resolve({ items: ['new-1'], hasMore: false, total: 1 })
  await flush()
  oldPage.resolve({ items: ['stale'], hasMore: true, total: 99 })
  await flush()
  assert.deepEqual(last().items, ['new-1'])
  assert.equal(last().total, 1)
  assert.equal(last().status, 'done')
  // The reset key covers sort, filters and query, not the view.
  assert.notEqual(catalogResetKey(DEFAULT_CATALOG_CRITERIA), catalogResetKey({ ...DEFAULT_CATALOG_CRITERIA, sort: 'popular' }))
  assert.notEqual(catalogResetKey(DEFAULT_CATALOG_CRITERIA), catalogResetKey({ ...DEFAULT_CATALOG_CRITERIA, agent: 'claude' }))
  assert.equal(catalogResetKey(DEFAULT_CATALOG_CRITERIA), catalogResetKey({ ...DEFAULT_CATALOG_CRITERIA, query: '  ' }))
  assert.match(page, /<StoreFeed<LocalSkill> key=\{`\$\{catalogKey\}:\$\{catalogRefresh\}`\} resetKey=/)
})

test('pages load one at a time, de-duplicate rows, and stop auto-loading after five pages', async () => {
  const { controller, last } = harness()
  const requested: number[] = []
  controller.reset(async (pageNumber) => {
    requested.push(pageNumber)
    return { items: [`a${pageNumber}`, `b${pageNumber}`, 'dup'], hasMore: true, total: 1000 }
  })
  controller.loadNext() // ignored while page 1 is in flight
  await flush()
  for (let index = 1; index < CATALOG_AUTO_PAGES; index += 1) {
    assert.equal(feedAutoLoads(last()), true)
    controller.loadNext()
    await flush()
  }
  assert.deepEqual(requested, [1, 2, 3, 4, 5])
  assert.equal(last().pagesLoaded, CATALOG_AUTO_PAGES)
  assert.equal(last().items.filter((item) => item === 'dup').length, 1)
  // After the cap the sentinel stops; 「加载更多」 continues explicitly.
  assert.equal(feedAutoLoads(last()), false)
  controller.loadNext()
  await flush()
  assert.deepEqual(requested, [1, 2, 3, 4, 5, 6])
  assert.match(feed, /\{snapshot\.status === 'idle' && !auto && <div className="tsh-feed-end tsh-feed-more"><button[\s\S]*?>加载更多<\/button>/)
})

test('a failed page keeps the loaded rows and 重试 fetches the same page again', async () => {
  const { controller, last } = harness()
  const pages: number[] = []
  let fail = true
  controller.reset(async (pageNumber) => {
    pages.push(pageNumber)
    if (pageNumber === 2 && fail) throw new Error('network')
    return { items: [`row${pageNumber}`], hasMore: true, total: 3 }
  })
  await flush()
  controller.loadNext()
  await flush()
  assert.equal(last().status, 'error')
  assert.deepEqual(last().items, ['row1'])
  fail = false
  controller.loadNext()
  await flush()
  assert.deepEqual(pages, [1, 2, 2])
  assert.deepEqual(last().items, ['row1', 'row2'])
  assert.match(feed, /\{snapshot\.status === 'error' && <div className="tsh-feed-error" role="alert">\{LOAD_FAILED_TITLE\}<button/)
})

test('the end of the list says how many results were shown; disposing drops late responses', async () => {
  const { controller, last } = harness()
  controller.reset(async () => ({ items: ['only'], hasMore: false, total: 1 }))
  await flush()
  assert.equal(last().status, 'done')
  controller.loadNext()
  await flush()
  assert.equal(last().pagesLoaded, 1)
  assert.match(feed, /已显示全部 <span className="tsh-num">\{formatStoreCount\(snapshot\.items\.length\)\}<\/span> 个结果/)

  const late = deferred<FeedPage<string>>()
  const second = harness()
  second.controller.reset(() => late.promise)
  second.controller.dispose()
  late.resolve({ items: ['late'], hasMore: false })
  await flush()
  assert.deepEqual(second.last().items, [])

  assert.equal(pageHasMore(1, 48, 24), true)
  assert.equal(pageHasMore(2, 48, 24), false)
  assert.equal(pageHasMore(1, 48, 0), false)
  assert.equal(pageHasMore(200, 99999, 24), false)
})

test('rejected rising / apiKey parameters are hidden for the session and the criteria fall back', () => {
  const rising = { ...DEFAULT_CATALOG_CRITERIA, sort: 'rising' as const, apiKey: 'required' as const }
  const badRequest = (message: string): ApiError => new ApiError('http', message, { status: 400 })
  assert.deepEqual(rejectedFeatures(badRequest('Invalid enum value at sort'), catalogQuery(rising, 1)), ['rising'])
  assert.deepEqual(rejectedFeatures(badRequest('Unrecognized key: apiKey'), catalogQuery(rising, 1)), ['apiKey'])
  assert.deepEqual(rejectedFeatures(badRequest('Bad Request'), catalogQuery(rising, 1)), ['rising', 'apiKey'])
  // A 404, 500 or network failure says nothing about parameters: the page just shows 加载失败.
  assert.deepEqual(rejectedFeatures(new ApiError('http', 'Not Found', { status: 404 }), catalogQuery(rising, 1)), [])
  assert.deepEqual(rejectedFeatures(new ApiError('network', 'offline'), catalogQuery(rising, 1)), [])
  assert.deepEqual(rejectedFeatures(badRequest('sort'), catalogQuery(DEFAULT_CATALOG_CRITERIA, 1)), [])

  const memory = new Map<string, string>()
  const store = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value) } }
  assert.deepEqual(readCapabilities(store), FULL_CAPABILITIES)
  const reduced = disableFeatures(FULL_CAPABILITIES, ['rising'], store)
  assert.deepEqual(readCapabilities(store), { rising: false, apiKey: true })
  assert.deepEqual(visibleSorts(reduced).map((sort) => sort.label), ['推荐', '下载量', '最多在用', '最近上新'])
  assert.deepEqual(applyCapabilities(rising, { rising: false, apiKey: false }), { ...rising, sort: 'latest', apiKey: '' })
  assert.deepEqual(visibleSorts(FULL_CAPABILITIES).map((sort) => sort.label), ['推荐', '近期飙升', '下载量', '最多在用', '最近上新'])

  // An older server that silently ignores apiKey is caught by contradicting rows.
  // 「需配置 API Key」 = some required key (#251): optional-only rows count as「无需」.
  const rows = [{ envDependencies: [] }, { envDependencies: [{ key: 'K', required: false }] }, { envDependencies: [{ key: 'R', required: true }] }]
  assert.deepEqual(guardApiKeyFilter(rows, 'required'), { items: [rows[2]], ignoredByServer: true })
  assert.deepEqual(guardApiKeyFilter([rows[2]!], 'required'), { items: [rows[2]], ignoredByServer: false })
  assert.deepEqual(guardApiKeyFilter(rows.slice(0, 2), 'none'), { items: rows.slice(0, 2), ignoredByServer: false })
  assert.deepEqual(guardApiKeyFilter(rows, 'none'), { items: rows.slice(0, 2), ignoredByServer: true })
  assert.deepEqual(guardApiKeyFilter(rows, ''), { items: rows, ignoredByServer: false })

  assert.match(page, /if \(rejected\.length\) setCapabilities\(\(current\) => disableFeatures\(current, rejected\)\)/)
  assert.match(page, /if \(guarded\.ignoredByServer\) setCapabilities\(\(current\) => disableFeatures\(current, \['apiKey'\]\)\)/)
  assert.match(page, /if \(capabilities\.apiKey\) filters\.push\(\{ id: 'apiKey'/)
})

test('catalog requests use 24 per page and every filter maps to the server query', () => {
  assert.equal(CATALOG_PAGE_SIZE, 24)
  assert.deepEqual(catalogQuery({ featured: true, query: ' 周报 ', category: '协作与办公', agent: 'claude', apiKey: 'none', sort: 'users' }, 3), {
    featured: true, query: '周报', category: '协作与办公', agent: 'claude', apiKey: 'none', sort: 'users', page: 3, pageSize: 24,
  })
  assert.deepEqual(catalogQuery(DEFAULT_CATALOG_CRITERIA, 1), {
    featured: undefined, query: undefined, category: undefined, agent: undefined, apiKey: undefined, sort: 'latest', page: 1, pageSize: 24,
  })
  assert.match(read('src/lib/api.ts'), /if \(query\.apiKey\) params\.set\('apiKey', query\.apiKey\)/)
})

test('「查看全部」 presets land on the matching 全部技能 criteria', () => {
  assert.equal(rankingPresetSort('trending', FULL_CAPABILITIES), 'rising')
  assert.equal(rankingPresetSort('popular', FULL_CAPABILITIES), 'popular')
  assert.equal(rankingPresetSort('trending', { rising: false, apiKey: true }), 'popular')
  assert.match(page, /openCatalog\(\{ sort: rankingPresetSort\(ranking\?\.mode, capabilities\) \}\)/)
  assert.match(page, /openCatalog\(\{ featured: true, sort: 'popular' \}\)/)
  assert.match(page, /openCatalog\(\{ category: category\.name \}\)/)
  assert.match(page, /const next: CatalogCriteria = \{ \.\.\.DEFAULT_CATALOG_CRITERIA, \.\.\.preset, query: preset\.query\?\.trim\(\) \?\? '' \}/)
  // 仅看精选 and every other active filter shows as a removable chip.
  assert.match(page, /catalog\.featured && \{ key: 'featured', text: '仅看精选', clear: \(\) => updateCatalog\(\{ featured: false \}\) \}/)
  assert.match(page, /aria-label=\{`清除筛选：\$\{chip\.text\}`\}/)
})

test('全部技能 layout: titled count, sticky FilterBar, debounced search, accessible lazy feed', () => {
  assert.match(page, /<h2>\{catalogHeading\}<\/h2>/)
  assert.match(page, /<nav className="tsh-sticky" aria-label="Skill 商店目录" style=\{\{ top: pageHeadHeight \}\}>/)
  assert.equal(CATALOG_SEARCH_DEBOUNCE_MS, 250)
  assert.match(page, /\}, CATALOG_SEARCH_DEBOUNCE_MS\)/)
  for (const label of ['所有场景分类', '所有 Agent']) assert.match(page, new RegExp(label))
  assert.match(read('src/lib/store-catalog.ts'), /\{ value: '', label: '不限 API Key' \}/)
  assert.equal(CATALOG_PREFETCH_MARGIN, 600)
  assert.match(feed, /rootMargin: `\$\{CATALOG_PREFETCH_MARGIN\}px 0px`/)
  assert.match(feed, /role="feed" aria-busy=\{loading\}/)
  assert.match(feed, /<StoreSkeleton key=\{`skeleton-\$\{index\}`\}/)
  assert.doesNotMatch(feed, /spin-icon/)
  assert.match(feed, /onClearFilters && <div className="tsh-empty-actions"><button[^>]*>\{CLEAR_FILTERS_LABEL\}<\/button>/)
  assert.match(css, /\.tsh-row \{[^}]*content-visibility: auto;/)
  assert.match(css, /\.tsh-sticky \{ position: sticky;/)
  // Rows and cards keep the 安装 button wired to joinMySkills.
  assert.match(page, /renderItem=\{\(skill, view\) => view === 'card' \? <StoreSkillCard \{\.\.\.storeItemProps\(skill\)\} \/> : <StoreSkillRow \{\.\.\.storeItemProps\(skill\)\} \/>\}/)
})
