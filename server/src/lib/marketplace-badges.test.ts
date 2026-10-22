import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDb = vi.hoisted(() => ({
  marketplaceListing: { findMany: vi.fn() },
  marketplaceListingDailyMetric: { groupBy: vi.fn() },
}))

vi.mock('../db.js', () => ({ db: mockDb }))

import {
  MARKETPLACE_HOT_CACHE_MS,
  MARKETPLACE_HOT_MIN_SCORE,
  loadHotSkillIds,
  marketplaceBadges,
  marketplaceHotSlots,
  resetMarketplaceHotCache,
  selectHotSkillIds,
} from './marketplace-badges.js'

const NOW = new Date('2026-10-12T04:00:00.000Z')
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000)

function row(overrides: Partial<{ skillId: string; featured: boolean; original: boolean; firstPublishedAt: Date }> = {}) {
  return { skillId: 'a', featured: false, original: false, firstPublishedAt: daysAgo(100), ...overrides }
}

describe('store badges', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMarketplaceHotCache()
  })

  it('marks 新上架 for 14 days after the first publication only', () => {
    expect(marketplaceBadges(row({ firstPublishedAt: daysAgo(14) }), new Set(), NOW.getTime())).toEqual(['new'])
    expect(marketplaceBadges(row({ firstPublishedAt: daysAgo(14.01) }), new Set(), NOW.getTime())).toEqual([])
    // A clock skew into the future never counts as new.
    expect(marketplaceBadges(row({ firstPublishedAt: daysAgo(-1) }), new Set(), NOW.getTime())).toEqual([])
  })

  it('returns every applicable badge in the fixed order 精选、原创、热门、新上架', () => {
    expect(marketplaceBadges(row({ featured: true, original: true, firstPublishedAt: daysAgo(1) }), new Set(['a']), NOW.getTime()))
      .toEqual(['featured', 'original', 'hot', 'new'])
    expect(marketplaceBadges(row({ original: true }), new Set(['a']), NOW.getTime())).toEqual(['original', 'hot'])
  })

  it('sizes the 热门 slots at 5% of public listings, between 3 and 20', () => {
    expect(marketplaceHotSlots(0)).toBe(3)
    expect(marketplaceHotSlots(41)).toBe(3)
    expect(marketplaceHotSlots(100)).toBe(5)
    expect(marketplaceHotSlots(191_243)).toBe(20)
  })

  it('needs both the minimum score and a slot, preferring the newer listing on ties', () => {
    const candidates = ['a', 'b', 'c', 'd', 'e'].map((skillId, index) => ({ skillId, firstPublishedAt: daysAgo(10 - index) }))
    const scores = new Map([['a', 40], ['b', 12], ['c', 12], ['d', MARKETPLACE_HOT_MIN_SCORE], ['e', MARKETPLACE_HOT_MIN_SCORE - 1]])
    // 5 listings → 3 slots: a (40), then c and b tie at 12 and c is newer; d qualifies but has no slot; e is below the minimum.
    expect([...selectHotSkillIds(candidates, scores)]).toEqual(['a', 'c', 'b'])
    expect(selectHotSkillIds(candidates, new Map([['e', 9]])).size).toBe(0)
  })

  it('computes the 热门 set from the last 7 store days and caches it for a minute', async () => {
    mockDb.marketplaceListing.findMany.mockResolvedValue([{ skillId: 'a', firstPublishedAt: daysAgo(30) }])
    mockDb.marketplaceListingDailyMetric.groupBy.mockResolvedValue([{ listingSkillId: 'a', _sum: { downloads: 4, installs: 6 } }])

    expect([...await loadHotSkillIds(NOW)]).toEqual(['a'])
    expect(mockDb.marketplaceListingDailyMetric.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        day: { gte: new Date('2026-10-06T00:00:00.000Z'), lte: new Date('2026-10-12T00:00:00.000Z') },
      }),
    }))
    await loadHotSkillIds(new Date(NOW.getTime() + MARKETPLACE_HOT_CACHE_MS - 1))
    expect(mockDb.marketplaceListing.findMany).toHaveBeenCalledTimes(1)
    await loadHotSkillIds(new Date(NOW.getTime() + MARKETPLACE_HOT_CACHE_MS))
    expect(mockDb.marketplaceListing.findMany).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight computation between concurrent requests', async () => {
    mockDb.marketplaceListing.findMany.mockResolvedValue([])
    mockDb.marketplaceListingDailyMetric.groupBy.mockResolvedValue([])
    await Promise.all([loadHotSkillIds(NOW), loadHotSkillIds(NOW), loadHotSkillIds(NOW)])
    expect(mockDb.marketplaceListing.findMany).toHaveBeenCalledTimes(1)
  })
})
