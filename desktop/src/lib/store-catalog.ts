// 全部技能 (#209 phase 2): criteria, capability degradation and the lazy-loading
// feed state machine. It mirrors the shipped web store (landing-page/src/marketplace/
// list-state.ts, capabilities.ts, feed.ts) so both surfaces page, degrade and reset
// the same way. No React here, so every rule is unit-testable under node:test.
import type { ApiMarketplaceItem, MarketplaceCatalogQuery } from './api.js'
import { needsApiKey } from './store-home.ts'

export type CatalogSort = 'popular' | 'rising' | 'downloads' | 'users' | 'latest'
export type ApiKeyFilter = '' | 'none' | 'required'
export type CatalogView = 'card' | 'list'

/** Sort tabs in display order. Without a choice the catalog is 「最近上新」, like the server default. */
export const CATALOG_SORTS: ReadonlyArray<{ id: CatalogSort; label: string }> = [
  { id: 'popular', label: '推荐' },
  { id: 'rising', label: '近期飙升' },
  { id: 'downloads', label: '下载量' },
  { id: 'users', label: '最多在用' },
  { id: 'latest', label: '最近上新' },
]
export const DEFAULT_CATALOG_SORT: CatalogSort = 'latest'

/** Same page size as the web store (CATALOG_PAGE_SIZE) and the server default. */
export const CATALOG_PAGE_SIZE = 24
/** The public catalog accepts at most this many pages (MARKETPLACE_ABUSE_LIMITS.maxCatalogPage). */
export const CATALOG_MAX_PAGE = 200
/** Pages fetched automatically before 「加载更多」 takes over, so the end of the page stays reachable. */
export const CATALOG_AUTO_PAGES = 5
/** The sentinel prefetches the next page this far before it scrolls into view. */
export const CATALOG_PREFETCH_MARGIN = 600
export const CATALOG_SEARCH_DEBOUNCE_MS = 250

/**
 * Server contract (`apiKey` on GET /marketplace, #251): required = some env dependency
 * is required, none = no required one; the same rule as the row tag 「需配置 API Key」,
 * so the filter uses the same words as the web store.
 */
export const API_KEY_OPTIONS: ReadonlyArray<{ value: ApiKeyFilter; label: string }> = [
  { value: '', label: '不限 API Key' },
  { value: 'none', label: '无需 API Key' },
  { value: 'required', label: '需配置 API Key' },
]

export type CatalogCriteria = {
  featured: boolean
  query: string
  category: string
  agent: string
  apiKey: ApiKeyFilter
  sort: CatalogSort
}

export const DEFAULT_CATALOG_CRITERIA: CatalogCriteria = {
  featured: false, query: '', category: '', agent: '', apiKey: '', sort: DEFAULT_CATALOG_SORT,
}

/** Capabilities older servers lack; once rejected they stay hidden for this session. */
export type StoreCapabilities = { rising: boolean; apiKey: boolean }
export const FULL_CAPABILITIES: StoreCapabilities = { rising: true, apiKey: true }
export type StoreFeature = keyof StoreCapabilities

/** Drops unsupported options: rising falls back to the default sort, apiKey to 不限. */
export function applyCapabilities(criteria: CatalogCriteria, capabilities: StoreCapabilities): CatalogCriteria {
  return {
    ...criteria,
    sort: !capabilities.rising && criteria.sort === 'rising' ? DEFAULT_CATALOG_SORT : criteria.sort,
    apiKey: capabilities.apiKey ? criteria.apiKey : '',
  }
}

export function visibleSorts(capabilities: StoreCapabilities): Array<{ id: CatalogSort; label: string }> {
  return CATALOG_SORTS.filter((sort) => sort.id !== 'rising' || capabilities.rising)
}

/** The key that clears the list: sort, filters and query only (switching the view does not refetch). */
export function catalogResetKey(criteria: CatalogCriteria): string {
  return JSON.stringify([criteria.featured, criteria.query.trim(), criteria.category, criteria.agent, criteria.apiKey, criteria.sort])
}

export function catalogQuery(criteria: CatalogCriteria, page: number): MarketplaceCatalogQuery {
  return {
    featured: criteria.featured ? true : undefined,
    query: criteria.query.trim() || undefined,
    category: criteria.category || undefined,
    agent: criteria.agent || undefined,
    apiKey: criteria.apiKey || undefined,
    sort: criteria.sort,
    page,
    pageSize: CATALOG_PAGE_SIZE,
  }
}

const CAPABILITIES_KEY = 'skillhub:store-capabilities'
type SessionStore = Pick<Storage, 'getItem' | 'setItem'>

function sessionStore(): SessionStore | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage } catch { return null }
}

/** Capabilities remembered for this app session, so a rejected parameter is not retried on every visit. */
export function readCapabilities(store: SessionStore | null = sessionStore()): StoreCapabilities {
  try {
    const raw: unknown = JSON.parse(store?.getItem(CAPABILITIES_KEY) ?? 'null')
    if (typeof raw !== 'object' || raw === null) return FULL_CAPABILITIES
    const record = raw as Record<string, unknown>
    return { rising: record.rising !== false, apiKey: record.apiKey !== false }
  } catch { return FULL_CAPABILITIES }
}

export function disableFeatures(current: StoreCapabilities, features: readonly StoreFeature[], store: SessionStore | null = sessionStore()): StoreCapabilities {
  if (!features.length) return current
  const next = { ...current }
  for (const feature of features) next[feature] = false
  try { store?.setItem(CAPABILITIES_KEY, JSON.stringify(next)) } catch { /* only this page remembers it */ }
  return next
}

type RejectionLike = { status?: number | null; message?: string }

/**
 * Which new parameters a rejected list request was refused for. Only a 400 / 422
 * validation answer counts (a 404 or a network error says nothing about parameters).
 * When the message names sort / apiKey only that one is blamed; otherwise every new
 * parameter in the request is treated as unsupported, so the list falls back to the
 * old behaviour instead of failing forever.
 */
export function rejectedFeatures(error: unknown, query: Pick<MarketplaceCatalogQuery, 'sort' | 'apiKey'>): StoreFeature[] {
  if (typeof error !== 'object' || error === null) return []
  const { status, message = '' } = error as RejectionLike
  if (status !== 400 && status !== 422) return []
  const usesRising = query.sort === 'rising'
  const usesApiKey = Boolean(query.apiKey)
  const mentionsSort = /\bsort\b/.test(message)
  const mentionsApiKey = /apiKey/i.test(message)
  const features: StoreFeature[] = []
  if (usesRising && (mentionsSort || !mentionsApiKey)) features.push('rising')
  if (usesApiKey && (mentionsApiKey || !mentionsSort)) features.push('apiKey')
  return features
}

/**
 * Older servers silently ignore `apiKey`: rows that contradict the filter prove it.
 * The caller then hides the filter; only matching rows are shown meanwhile.
 */
export function guardApiKeyFilter<T extends Pick<ApiMarketplaceItem, 'envDependencies'>>(items: T[], filter: ApiKeyFilter): { items: T[]; ignoredByServer: boolean } {
  if (!filter) return { items, ignoredByServer: false }
  // Same rule as the 「需配置 API Key」 badge and the server filter (#251): some key is required.
  const kept = items.filter((item) => filter === 'none' ? !needsApiKey(item.envDependencies) : needsApiKey(item.envDependencies))
  return { items: kept, ignoredByServer: kept.length !== items.length }
}

/** Server page-number paging: whether anything follows this page, within the public page cap. */
export function pageHasMore(page: number, total: number, receivedCount: number, pageSize = CATALOG_PAGE_SIZE, maxPage = CATALOG_MAX_PAGE): boolean {
  return receivedCount > 0 && page * pageSize < total && page < maxPage
}

/** 「查看全部」 from the ranking: 近期飙升 when the server supports it and the board is trending, else 推荐. */
export function rankingPresetSort(mode: 'trending' | 'popular' | undefined, capabilities: StoreCapabilities): CatalogSort {
  return mode !== 'popular' && capabilities.rising ? 'rising' : 'popular'
}

// ---- Lazy-loading feed --------------------------------------------------------

export type FeedStatus = 'idle' | 'loading' | 'error' | 'done'
export type FeedPage<T> = { items: T[]; hasMore: boolean; total?: number }
export type FetchFeedPage<T> = (page: number) => Promise<FeedPage<T>>
export type FeedSnapshot<T> = {
  items: T[]
  status: FeedStatus
  /** Pages loaded since the last reset; drives the auto-load cap. */
  pagesLoaded: number
  total: number | null
}

/**
 * The 全部技能 feed:
 * - reset clears the pages and invalidates responses still in flight (generation counter),
 *   so a slow old query never overwrites a new one;
 * - loadNext keeps one request at a time; a failed page keeps the loaded rows and turns
 *   the status to error, ready to retry the same page;
 * - rows are de-duplicated by key when listings move between pages while paging.
 */
export class FeedController<T> {
  private generation = 0
  private busy = false
  private fetchPage: FetchFeedPage<T> | null = null
  private nextPage = 1
  private state: FeedSnapshot<T> = { items: [], status: 'idle', pagesLoaded: 0, total: null }
  private readonly keyOf: (item: T) => string
  private readonly onChange: (snapshot: FeedSnapshot<T>) => void

  constructor(keyOf: (item: T) => string, onChange: (snapshot: FeedSnapshot<T>) => void) {
    this.keyOf = keyOf
    this.onChange = onChange
  }

  snapshot(): FeedSnapshot<T> { return this.state }

  reset(fetchPage: FetchFeedPage<T>): void {
    this.generation += 1
    this.busy = false
    this.fetchPage = fetchPage
    this.nextPage = 1
    this.emit({ items: [], status: 'idle', pagesLoaded: 0, total: null })
    this.loadNext()
  }

  loadNext(): void {
    const fetchPage = this.fetchPage
    if (!fetchPage || this.busy || this.state.status === 'done') return
    this.busy = true
    const generation = this.generation
    const page = this.nextPage
    this.emit({ ...this.state, status: 'loading' })
    let request: Promise<FeedPage<T>>
    try { request = fetchPage(page) } catch (caught: unknown) { request = Promise.reject(caught) }
    request.then((result) => {
      if (generation !== this.generation) return
      this.busy = false
      this.nextPage = page + 1
      this.emit({ items: this.dedupe(this.state.items, result.items), status: result.hasMore ? 'idle' : 'done', pagesLoaded: this.state.pagesLoaded + 1, total: result.total ?? this.state.total })
    }, () => {
      if (generation !== this.generation) return
      this.busy = false
      this.emit({ ...this.state, status: 'error' })
    })
  }

  /** On unmount: every later response is dropped. */
  dispose(): void {
    this.generation += 1
    this.busy = false
    this.fetchPage = null
  }

  private dedupe(current: T[], incoming: T[]): T[] {
    const seen = new Set(current.map(this.keyOf))
    const next = [...current]
    for (const item of incoming) {
      const key = this.keyOf(item)
      if (seen.has(key)) continue
      seen.add(key)
      next.push(item)
    }
    return next
  }

  private emit(state: FeedSnapshot<T>): void {
    this.state = state
    this.onChange(state)
  }
}

/** Whether the sentinel still auto-loads: idle and below the auto-page cap; then 「加载更多」. */
export function feedAutoLoads(snapshot: Pick<FeedSnapshot<unknown>, 'status' | 'pagesLoaded'>, autoPages = CATALOG_AUTO_PAGES): boolean {
  return snapshot.status === 'idle' && snapshot.pagesLoaded < autoPages
}
