// Pure logic for the desktop Skill store (Tan Skillhub Design System, #209).
// It mirrors the shipped web store contract (landing-page/src/marketplace/home-data.ts,
// shared/contracts.ts normalizeBadges / normalizeStats) so both surfaces show the
// same badges, the same dashboard numbers and the same fallbacks. No React here,
// so every rule is unit-testable under node:test.
import type {
  ApiMarketplaceItem,
  ApiMarketplaceStats,
  ApiMarketplaceTrend,
  ApiMarketplaceTrending,
  MarketplaceBadge,
} from './api.js'

/** Fixed render order of the four store badges. */
export const STORE_BADGES: readonly MarketplaceBadge[] = ['featured', 'original', 'hot', 'new']

export type StoreBadgeView = {
  label: string
  tone: 'brand' | 'outline' | 'warning' | 'success'
  icon: 'star' | 'badge-check' | 'flame' | 'sparkles'
}

export const STORE_BADGE_VIEW: Record<MarketplaceBadge, StoreBadgeView> = {
  featured: { label: '精选', tone: 'brand', icon: 'star' },
  original: { label: '原创', tone: 'outline', icon: 'badge-check' },
  hot: { label: '热门', tone: 'warning', icon: 'flame' },
  new: { label: '新上架', tone: 'success', icon: 'sparkles' },
}

/**
 * Badges exactly as the server decides them: unknown values ignored, each at most
 * once, in the fixed order 精选 / 原创 / 热门 / 新上架. An older server that only
 * sends the `featured` / `original` booleans gets those two back-filled once.
 * 热门 and 新上架 are never derived on the client.
 */
export function normalizeStoreBadges(value: unknown, flags: { featured?: unknown; original?: unknown } = {}): MarketplaceBadge[] {
  const present = new Set<string>(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  if (flags.featured === true) present.add('featured')
  if (flags.original === true) present.add('original')
  return STORE_BADGES.filter((badge) => present.has(badge))
}

/** Editorial short labels without any word already shown as a store badge (no second 「精选」). */
export function editorialLabelsBesideBadges(labels: readonly string[] | undefined, badges: readonly MarketplaceBadge[] | undefined): string[] {
  const shown = new Set<string>(['精选', ...(badges ?? []).map((badge) => STORE_BADGE_VIEW[badge].label)])
  const seen = new Set<string>()
  const result: string[] = []
  for (const label of labels ?? []) {
    const text = label.trim()
    if (!text || shown.has(text) || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

/** 万 / 亿 above ten thousand (191243 → "19.1 万"), thousands separators below. */
export function formatStoreCount(value: number | undefined | null): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
  if (n >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/, '')} 亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, '')} 万`
  return Math.round(n).toLocaleString('en-US')
}

/** "+214%" style growth; null when there is no comparable previous period. */
export function formatGrowth(percent: number | null | undefined): string | null {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null
  const rounded = Math.round(percent)
  return `${rounded >= 0 ? '+' : ''}${rounded.toLocaleString('en-US')}%`
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const countSeries = (value: unknown): number[] | null => Array.isArray(value) && value.every(isCount) ? value as number[] : null

/** Store stats, or null when any required figure is missing (the panel is then hidden, never zero-filled). */
export function normalizeStoreStats(value: unknown): ApiMarketplaceStats | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const dailyInstalls = countSeries(raw.dailyInstalls)
  const weeklyNewSkills = countSeries(raw.weeklyNewSkills)
  if (!isCount(raw.totalSkills) || !isCount(raw.newThisWeek) || !isCount(raw.installsToday) || !isCount(raw.activeAuthors) || !dailyInstalls || !weeklyNewSkills) return null
  return {
    totalSkills: raw.totalSkills,
    newThisWeek: raw.newThisWeek,
    installsToday: raw.installsToday,
    activeAuthors: raw.activeAuthors,
    dailyInstalls,
    weeklyNewSkills,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : undefined,
  }
}

export type StatTileData = { label: string; value: string; trend?: number[]; delta?: string | null }

/** The four 商店动态 tiles; same math as the web store. Skill 总数 trend is rebuilt from weekly additions. */
export function statTiles(stats: ApiMarketplaceStats): StatTileData[] {
  const weekly = stats.weeklyNewSkills
  const totals = weekly.map((_, index) => stats.totalSkills - weekly.slice(index + 1).reduce((sum, value) => sum + value, 0))
  const last = weekly.length > 0 ? weekly[weekly.length - 1] : undefined
  const previous = weekly.length > 1 ? weekly[weekly.length - 2] : undefined
  const weekDelta = last !== undefined && previous !== undefined && previous > 0 && last > previous
    ? formatGrowth((last - previous) / previous * 100)
    : null
  return [
    { label: 'Skill 总数', value: formatStoreCount(stats.totalSkills), trend: totals.length > 1 ? totals : undefined },
    { label: '本周新增', value: formatStoreCount(stats.newThisWeek), trend: weekly.length > 1 ? weekly : undefined, delta: weekDelta },
    { label: '今日安装', value: formatStoreCount(stats.installsToday), trend: stats.dailyInstalls.length > 1 ? stats.dailyInstalls : undefined },
    { label: '活跃作者', value: formatStoreCount(stats.activeAuthors) },
  ]
}

/** Stats or null; any failure (404 on an older server, a bad payload) hides the panel. */
export async function loadStoreStats(fetchStats: () => Promise<unknown>): Promise<ApiMarketplaceStats | null> {
  try { return normalizeStoreStats(await fetchStats()) } catch { return null }
}

/** 「大家在搜」: first distinct editorial labels of popular + latest Skills; never a badge word. */
export function searchSuggestions(skills: ReadonlyArray<Pick<ApiMarketplaceItem, 'editorialLabels' | 'badges'>>, limit = 5): string[] {
  const seen: string[] = []
  for (const skill of skills) {
    for (const label of editorialLabelsBesideBadges(skill.editorialLabels, skill.badges)) {
      if (!seen.includes(label)) seen.push(label)
      if (seen.length >= limit) return seen
    }
  }
  return seen
}

export const RANKING_LIMIT = 8
export type RankingRange = 'day' | 'week'
export type RankedItem<T> = { skill: T; growth: string | null; metric?: string }
export type Ranking<T> = { mode: 'trending' | 'popular'; items: RankedItem<T>[] }

export type RankingApi<T> = {
  trending: (range: RankingRange, limit: number) => Promise<ApiMarketplaceTrending>
  popular: (limit: number) => Promise<ApiMarketplaceItem[]>
  toSkill: (item: ApiMarketplaceItem) => T
}

function trendOf(value: unknown): ApiMarketplaceTrend | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (!isCount(raw.recentInstalls) || !isCount(raw.previousInstalls)) return null
  const growth = typeof raw.growthPercent === 'number' && Number.isFinite(raw.growthPercent) ? raw.growthPercent : null
  return { recentInstalls: raw.recentInstalls, previousInstalls: raw.previousInstalls, growthPercent: growth }
}

/**
 * 飙升榜; when trending is unavailable (older server 404 or any failure) it falls back
 * to the popular ranking without growth figures. If the fallback fails too, this
 * rejects and the page hides the panel.
 */
export async function loadRanking<T>(api: RankingApi<T>, range: RankingRange, trendingAvailable: boolean): Promise<Ranking<T>> {
  if (trendingAvailable) {
    try {
      const response = await api.trending(range, RANKING_LIMIT)
      if (!Array.isArray(response?.items)) throw new Error('飙升榜数据不完整')
      return {
        mode: 'trending',
        items: response.items.slice(0, RANKING_LIMIT).map((item) => {
          const trend = trendOf(item.trend)
          return {
            skill: api.toSkill(item),
            growth: trend ? formatGrowth(trend.growthPercent) : null,
            // The server keeps the field name, but counts downloads + installs.
            metric: trend ? `${formatStoreCount(trend.recentInstalls)} 次下载+安装` : undefined,
          }
        }),
      }
    } catch { /* fall back to the popular ranking */ }
  }
  const popular = await api.popular(RANKING_LIMIT)
  return {
    mode: 'popular',
    items: popular.slice(0, RANKING_LIMIT).map((item) => ({
      skill: api.toSkill(item),
      growth: null,
      metric: `${formatStoreCount(item.installCount ?? item.downloadCount)} 次安装`,
    })),
  }
}

export type StoreTab = 'home' | 'catalog' | 'mine' | 'review'

/** Top tabs: 首页 / 全部技能 / 我的 (signed in) / 审核队列 (store admins). */
export function storeTabs({ signedIn, admin }: { signedIn: boolean; admin: boolean }): Array<{ id: StoreTab; label: string }> {
  const tabs: Array<{ id: StoreTab; label: string }> = [
    { id: 'home', label: '首页' },
    { id: 'catalog', label: '全部技能' },
  ]
  if (signedIn) tabs.push({ id: 'mine', label: '我的' })
  if (signedIn && admin) tabs.push({ id: 'review', label: '审核队列' })
  return tabs
}

export type TopicTone = 'night' | 'mint' | 'blush' | 'lilac'
const PASTEL_TONES: readonly TopicTone[] = ['mint', 'blush', 'lilac']

/** Logo-palette tone per carousel position; the first card is always night. */
export function topicTone(index: number): TopicTone {
  return index === 0 ? 'night' : PASTEL_TONES[(index - 1) % PASTEL_TONES.length] ?? 'mint'
}

export type CarouselEdges = { overflow: boolean; atStart: boolean; atEnd: boolean }

/** Arrows only when the row overflows; each disables at its end (1px tolerance for subpixel scroll). */
export function carouselEdges(scrollLeft: number, scrollWidth: number, clientWidth: number): CarouselEdges {
  const overflow = scrollWidth - clientWidth > 1
  return {
    overflow,
    atStart: !overflow || scrollLeft <= 1,
    atEnd: !overflow || scrollLeft + clientWidth >= scrollWidth - 1,
  }
}

export type StoreInstallState = { label: '安装' | '更新' | '已加入'; disabled: boolean; kind: 'install' | 'update' | 'joined' }

/** The store card / row primary button, derived from the existing marketplaceAction state. */
export function storeInstallState(action: { joined: boolean; update: boolean }, busy = false): StoreInstallState {
  if (action.update) return { label: '更新', disabled: busy, kind: 'update' }
  if (action.joined) return { label: '已加入', disabled: true, kind: 'joined' }
  return { label: '安装', disabled: busy, kind: 'install' }
}

type StoppableEvent = { stopPropagation: () => void; preventDefault: () => void }

/** The 安装 button runs the install flow only; the click never reaches the card's open-details handler. */
export function runInstallClick(event: StoppableEvent, install: () => void): void {
  event.preventDefault()
  event.stopPropagation()
  install()
}

/** Any required env dependency means 「需配置 API Key」. */
export function needsApiKey(envDependencies: ReadonlyArray<{ required: boolean }> | undefined): boolean {
  return (envDependencies ?? []).some((dependency) => dependency.required)
}

/** Local calendar date `YYYY-MM-DD`; empty for a missing or invalid timestamp. */
export function formatStoreDate(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

type StoreDetailSource = {
  installCount?: number | null
  marketplaceUserCount?: number | null
  marketplaceDownloadCount?: number | null
  marketplaceFirstPublishedAt?: string | null
  marketplacePublishedAt?: string | null
}

const isCountValue = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * The store detail stats strip (design-system SkillDetailPage): 安装次数 / 在用用户 /
 * ZIP 下载 / 上架时间. A value the Server did not report is left out, never shown as 0.
 */
/** Design-system icon for each stat (download / users-round / package / calendar). */
export type StoreDetailStat = { key: 'installs' | 'users' | 'downloads' | 'listed'; label: string; value: string; icon: 'download' | 'users-round' | 'package' | 'calendar' }

export function storeDetailStats(skill: StoreDetailSource): StoreDetailStat[] {
  const stats: StoreDetailStat[] = []
  if (isCountValue(skill.installCount)) stats.push({ key: 'installs', label: '安装次数', value: formatStoreCount(skill.installCount), icon: 'download' })
  if (isCountValue(skill.marketplaceUserCount)) stats.push({ key: 'users', label: '在用用户', value: formatStoreCount(skill.marketplaceUserCount), icon: 'users-round' })
  if (isCountValue(skill.marketplaceDownloadCount)) stats.push({ key: 'downloads', label: 'ZIP 下载', value: formatStoreCount(skill.marketplaceDownloadCount), icon: 'package' })
  const listed = formatStoreDate(skill.marketplaceFirstPublishedAt ?? skill.marketplacePublishedAt)
  if (listed) stats.push({ key: 'listed', label: '上架时间', value: listed, icon: 'calendar' })
  return stats
}

export type StoreDetailBylinePair = { key: 'uploader' | 'version' | 'updated'; label: string; value: string; icon: 'user-round' | 'tag' | 'calendar' }

/**
 * Uploader byline as label + value pairs: 「Skill 上传者」, 「版本」, 「更新于」. Pairs
 * without a value are omitted. The store says 上传者, never 作者.
 */
export function storeDetailByline(skill: { authorName?: string | null; version?: string | null; marketplacePublishedAt?: string | null }): StoreDetailBylinePair[] {
  const pairs: StoreDetailBylinePair[] = []
  const uploader = skill.authorName?.trim()
  if (uploader) pairs.push({ key: 'uploader', label: 'Skill 上传者', value: uploader, icon: 'user-round' })
  const version = skill.version?.trim()
  if (version) pairs.push({ key: 'version', label: '版本', value: version, icon: 'tag' })
  const updated = formatStoreDate(skill.marketplacePublishedAt)
  if (updated) pairs.push({ key: 'updated', label: '更新于', value: updated, icon: 'calendar' })
  return pairs
}
