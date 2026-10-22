import { Prisma } from '@prisma/client'
import { db } from '../db.js'

// Store trend and statistics helpers for the public web store (#193, #197). Every
// figure is derived from public listings and the per-day listing counters
// (`MarketplaceListingDailyMetric`: ZIP downloads + install intents per store
// calendar day); nothing here returns a user or client identifier.

export type TrendRange = 'day' | 'week'

/** Store calendar days per window: `day` compares today with yesterday, `week` the last 7 days with the 7 before. */
export const TREND_WINDOW_DAYS: Record<TrendRange, number> = { day: 1, week: 7 }

export type ListingTrend = {
  recentInstalls: number
  previousInstalls: number
  growthPercent: number | null
}

/** Relative change in percent; null when there is no previous period to compare with. */
export function growthPercent(recent: number, previous: number): number | null {
  if (previous <= 0) return null
  return Math.round(((recent - previous) / previous) * 100)
}

/**
 * The trend of one listing. `recentInstalls` / `previousInstalls` keep their #193
 * names for compatibility and count downloads + installs since #197.
 */
export function listingTrend(recent: number, previous: number): ListingTrend {
  return { recentInstalls: recent, previousInstalls: previous, growthPercent: growthPercent(recent, previous) }
}

type RankableListing = { skillId: string; publishedAt: Date }

/**
 * Orders listings for `sort=rising`: most activity in the recent window first,
 * then the larger growth, then the newer listing, with the id as a stable tie breaker.
 */
export function rankRising<T extends RankableListing>(
  listings: readonly T[],
  recent: ReadonlyMap<string, number>,
  previous: ReadonlyMap<string, number> = new Map(),
): T[] {
  const growth = (skillId: string): number => growthPercent(recent.get(skillId) ?? 0, previous.get(skillId) ?? 0) ?? -Infinity
  return [...listings].sort((left, right) => (
    (recent.get(right.skillId) ?? 0) - (recent.get(left.skillId) ?? 0)
    || compareDescending(growth(left.skillId), growth(right.skillId))
    || right.publishedAt.getTime() - left.publishedAt.getTime()
    || left.skillId.localeCompare(right.skillId)
  ))
}

function compareDescending(left: number, right: number): number {
  if (left === right) return 0
  return left < right ? 1 : -1
}

// ── Store calendar days ─────────────────────────────────────────────────────

const STORE_TIME_ZONE = 'Asia/Shanghai'
const DAY_MS = 24 * 60 * 60 * 1_000
const WEEK_MS = 7 * DAY_MS

/** `YYYY-MM-DD` of an instant in the store's time zone. */
export function storeDay(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

/** The instant at which the store-time-zone calendar day containing `now` began (UTC+8, no DST). */
export function storeDayStart(now: Date): Date {
  return new Date(`${storeDay(now)}T00:00:00.000+08:00`)
}

/** The last `days` store calendar days, oldest first, ending with today. */
export function storeDayKeys(now: Date, days: number): string[] {
  const todayStart = storeDayStart(now).getTime()
  return Array.from({ length: days }, (_, index) => storeDay(new Date(todayStart + (index - days + 1) * DAY_MS + 12 * 60 * 60 * 1_000)))
}

/** A store day key as the value of a `@db.Date` column. */
export function storeDayValue(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

/** Buckets publish times into `weeks` rolling 7-day windows that end at `now`, oldest first. */
export function weeklyBuckets(publishedAt: readonly Date[], now: Date, weeks: number): number[] {
  const buckets = new Array<number>(weeks).fill(0)
  for (const instant of publishedAt) {
    const age = now.getTime() - instant.getTime()
    if (age < 0) continue
    const index = weeks - 1 - Math.floor(age / WEEK_MS)
    if (index >= 0) buckets[index] += 1
  }
  return buckets
}

// ── Per-day counters ────────────────────────────────────────────────────────

export type ListingMetricKind = 'downloads' | 'installs'

type MetricWriter = Pick<Prisma.TransactionClient, 'marketplaceListingDailyMetric'>

/** Adds one counted download or install to today's row; call it in the same transaction as the running total. */
export async function recordListingMetric(
  client: MetricWriter,
  listingSkillId: string,
  kind: ListingMetricKind,
  now = new Date(),
): Promise<void> {
  const day = storeDayValue(storeDay(now))
  await client.marketplaceListingDailyMetric.upsert({
    where: { listingSkillId_day: { listingSkillId, day } },
    create: { listingSkillId, day, [kind]: 1 },
    update: { [kind]: { increment: 1 } },
  })
}

export const publicMetricListing: Prisma.MarketplaceListingWhereInput = {
  withdrawnAt: null,
  skill: { is: { deletedAt: null } },
  submission: { is: { status: 'approved' } },
}

/** downloads + installs per public listing over the inclusive store-day range. */
export async function activityBetween(fromDay: string, toDay: string): Promise<Map<string, number>> {
  const rows = await db.marketplaceListingDailyMetric.groupBy({
    by: ['listingSkillId'],
    where: {
      day: { gte: storeDayValue(fromDay), lte: storeDayValue(toDay) },
      listing: { is: publicMetricListing },
    },
    _sum: { downloads: true, installs: true },
  })
  return new Map(rows.map((row) => [row.listingSkillId, (row._sum.downloads ?? 0) + (row._sum.installs ?? 0)]))
}

/** Activity in the last `days` store days (ending today) and in the `days` before them. */
export async function trendCounts(range: TrendRange, now = new Date()): Promise<{
  recent: Map<string, number>
  previous: Map<string, number>
}> {
  const span = TREND_WINDOW_DAYS[range]
  const keys = storeDayKeys(now, span * 2)
  const [previous, recent] = await Promise.all([
    activityBetween(keys[0], keys[span - 1]),
    activityBetween(keys[span], keys[keys.length - 1]),
  ])
  return { recent, previous }
}

// ── Store statistics ────────────────────────────────────────────────────────

export type MarketplaceStats = {
  totalSkills: number
  newThisWeek: number
  installsToday: number
  downloadsToday: number
  activeAuthors: number
  /** Installs per store calendar day, oldest first, ending today. */
  dailyInstalls: number[]
  /** Counted ZIP downloads per store calendar day, oldest first, ending today (history starts with #197). */
  dailyDownloads: number[]
  /** Listings first published per rolling 7-day window, oldest first, ending now. */
  weeklyNewSkills: number[]
  generatedAt: string
}

export async function computeMarketplaceStats(now = new Date()): Promise<MarketplaceStats> {
  const dayKeys = storeDayKeys(now, 7)
  const weekAgo = new Date(now.getTime() - WEEK_MS)
  const eightWeeksAgo = new Date(now.getTime() - 8 * WEEK_MS)

  const [totalSkills, newThisWeek, authors, recentPublished, dailyRows] = await Promise.all([
    db.marketplaceListing.count({ where: publicMetricListing }),
    db.marketplaceListing.count({ where: { ...publicMetricListing, firstPublishedAt: { gte: weekAgo } } }),
    db.skill.groupBy({
      by: ['authorId'],
      where: { deletedAt: null, marketplaceListing: { is: publicMetricListing } },
    }),
    db.marketplaceListing.findMany({
      where: { ...publicMetricListing, firstPublishedAt: { gte: eightWeeksAgo } },
      select: { firstPublishedAt: true },
    }),
    db.marketplaceListingDailyMetric.groupBy({
      by: ['day'],
      where: {
        day: { gte: storeDayValue(dayKeys[0]), lte: storeDayValue(dayKeys[dayKeys.length - 1]) },
        listing: { is: publicMetricListing },
      },
      _sum: { downloads: true, installs: true },
    }),
  ])

  const perDay = new Map(dailyRows.map((row) => [row.day.toISOString().slice(0, 10), row._sum]))
  const dailyInstalls = dayKeys.map((day) => perDay.get(day)?.installs ?? 0)
  const dailyDownloads = dayKeys.map((day) => perDay.get(day)?.downloads ?? 0)
  return {
    totalSkills,
    newThisWeek,
    installsToday: dailyInstalls[dailyInstalls.length - 1] ?? 0,
    downloadsToday: dailyDownloads[dailyDownloads.length - 1] ?? 0,
    activeAuthors: authors.length,
    dailyInstalls,
    dailyDownloads,
    weeklyNewSkills: weeklyBuckets(recentPublished.map((row) => row.firstPublishedAt), now, 8),
    generatedAt: now.toISOString(),
  }
}
