import { db } from '../db.js'
import { activityBetween, publicMetricListing, storeDayKeys } from './marketplace-trends.js'

// Store Skill badges (#197, design: docs/plans/active/STORE_SKILL_BADGES.md).
// The server is the only place that decides them; clients render `badges` in order.

export type MarketplaceBadge = 'featured' | 'original' | 'hot' | 'new'

/** Fixed render order of the `badges` array. */
export const MARKETPLACE_BADGE_ORDER: readonly MarketplaceBadge[] = ['featured', 'original', 'hot', 'new']

export const MARKETPLACE_NEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000
export const MARKETPLACE_HOT_WINDOW_DAYS = 7
export const MARKETPLACE_HOT_MIN_SCORE = 10
export const MARKETPLACE_HOT_SHARE = 0.05
export const MARKETPLACE_HOT_MIN_SLOTS = 3
export const MARKETPLACE_HOT_MAX_SLOTS = 20
export const MARKETPLACE_HOT_CACHE_MS = 60_000

type BadgeRow = {
  skillId: string
  featured: boolean
  original: boolean
  firstPublishedAt: Date
}

/** How many listings may be 热门 at once: 5% of public listings, at least 3, at most 20. */
export function marketplaceHotSlots(publicListings: number): number {
  return Math.min(MARKETPLACE_HOT_MAX_SLOTS, Math.max(MARKETPLACE_HOT_MIN_SLOTS, Math.ceil(publicListings * MARKETPLACE_HOT_SHARE)))
}

type HotCandidate = { skillId: string; firstPublishedAt: Date }

/**
 * 热门 = downloads + installs over the last 7 store days at or above the minimum
 * score AND ranked within the slots; ties go to the newer listing, then the id.
 */
export function selectHotSkillIds(
  candidates: readonly HotCandidate[],
  scores: ReadonlyMap<string, number>,
): Set<string> {
  const slots = marketplaceHotSlots(candidates.length)
  return new Set(candidates
    .filter((row) => (scores.get(row.skillId) ?? 0) >= MARKETPLACE_HOT_MIN_SCORE)
    .sort((left, right) => (
      (scores.get(right.skillId) ?? 0) - (scores.get(left.skillId) ?? 0)
      || right.firstPublishedAt.getTime() - left.firstPublishedAt.getTime()
      || left.skillId.localeCompare(right.skillId)
    ))
    .slice(0, slots)
    .map((row) => row.skillId))
}

export function marketplaceBadges(row: BadgeRow, hotSkillIds: ReadonlySet<string>, now = Date.now()): MarketplaceBadge[] {
  const sinceFirstPublished = now - row.firstPublishedAt.getTime()
  const present: Record<MarketplaceBadge, boolean> = {
    featured: row.featured,
    original: row.original,
    hot: hotSkillIds.has(row.skillId),
    new: sinceFirstPublished >= 0 && sinceFirstPublished <= MARKETPLACE_NEW_WINDOW_MS,
  }
  return MARKETPLACE_BADGE_ORDER.filter((badge) => present[badge])
}

let hotCache: { ids: ReadonlySet<string>; expiresAt: number } | null = null
let hotLoad: Promise<ReadonlySet<string>> | null = null

/** The current 热门 set, shared by every DTO and recomputed at most once a minute per process. */
export async function loadHotSkillIds(now = new Date()): Promise<ReadonlySet<string>> {
  if (hotCache && hotCache.expiresAt > now.getTime()) return hotCache.ids
  if (hotLoad) return hotLoad
  hotLoad = (async (): Promise<ReadonlySet<string>> => {
    const days = storeDayKeys(now, MARKETPLACE_HOT_WINDOW_DAYS)
    const [candidates, scores] = await Promise.all([
      db.marketplaceListing.findMany({ where: publicMetricListing, select: { skillId: true, firstPublishedAt: true } }),
      activityBetween(days[0], days[days.length - 1]),
    ])
    const ids = selectHotSkillIds(candidates, scores)
    hotCache = { ids, expiresAt: now.getTime() + MARKETPLACE_HOT_CACHE_MS }
    return ids
  })()
  try {
    return await hotLoad
  } finally {
    hotLoad = null
  }
}

/** Test hook: forget the cached 热门 set. */
export function resetMarketplaceHotCache(): void {
  hotCache = null
  hotLoad = null
}
