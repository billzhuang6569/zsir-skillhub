import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDb = vi.hoisted(() => ({
  skill: { groupBy: vi.fn() },
  marketplaceListing: { count: vi.fn(), findMany: vi.fn() },
  marketplaceListingDailyMetric: { groupBy: vi.fn(), upsert: vi.fn() },
}))

vi.mock('../db.js', () => ({ db: mockDb }))

import {
  computeMarketplaceStats,
  growthPercent,
  rankRising,
  recordListingMetric,
  storeDay,
  storeDayKeys,
  storeDayStart,
  storeDayValue,
  trendCounts,
  weeklyBuckets,
} from './marketplace-trends.js'

const NOW = new Date('2026-10-12T04:00:00.000Z') // 12:00 in Asia/Shanghai

describe('marketplace trends', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports growth only when there is a previous period', () => {
    expect(growthPercent(30, 10)).toBe(200)
    expect(growthPercent(5, 10)).toBe(-50)
    expect(growthPercent(7, 0)).toBeNull()
    expect(growthPercent(0, 0)).toBeNull()
  })

  it('ranks by recent installs, then growth, then recency, with a stable id tie breaker', () => {
    const at = (iso: string): Date => new Date(iso)
    const rows = [
      { skillId: 'quiet-new', publishedAt: at('2026-10-10T00:00:00Z') },
      { skillId: 'busy', publishedAt: at('2026-01-01T00:00:00Z') },
      { skillId: 'busy-growing', publishedAt: at('2026-01-01T00:00:00Z') },
      { skillId: 'quiet-old-b', publishedAt: at('2026-01-01T00:00:00Z') },
      { skillId: 'quiet-old-a', publishedAt: at('2026-01-01T00:00:00Z') },
    ]
    const recent = new Map([['busy', 9], ['busy-growing', 9]])
    const previous = new Map([['busy', 9], ['busy-growing', 3]])
    expect(rankRising(rows, recent, previous).map((row) => row.skillId))
      .toEqual(['busy-growing', 'busy', 'quiet-new', 'quiet-old-a', 'quiet-old-b'])
  })

  it('compares adjacent store-day windows of downloads + installs from public listings', async () => {
    mockDb.marketplaceListingDailyMetric.groupBy
      .mockResolvedValueOnce([{ listingSkillId: 'a', _sum: { downloads: 1, installs: 0 } }])
      .mockResolvedValueOnce([{ listingSkillId: 'a', _sum: { downloads: 3, installs: 1 } }])
    const counts = await trendCounts('week', NOW)

    expect(counts.previous.get('a')).toBe(1)
    expect(counts.recent.get('a')).toBe(4)
    expect(mockDb.marketplaceListingDailyMetric.groupBy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      by: ['listingSkillId'],
      where: {
        day: { gte: storeDayValue('2026-09-29'), lte: storeDayValue('2026-10-05') },
        listing: { is: expect.objectContaining({ withdrawnAt: null, skill: { is: { deletedAt: null } } }) },
      },
    }))
    expect(mockDb.marketplaceListingDailyMetric.groupBy).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ day: { gte: storeDayValue('2026-10-06'), lte: storeDayValue('2026-10-12') } }),
    }))
  })

  it('compares today with yesterday for the day range', async () => {
    mockDb.marketplaceListingDailyMetric.groupBy.mockResolvedValue([])
    await trendCounts('day', NOW)
    expect(mockDb.marketplaceListingDailyMetric.groupBy.mock.calls.map((call) => call[0].where.day)).toEqual([
      { gte: storeDayValue('2026-10-11'), lte: storeDayValue('2026-10-11') },
      { gte: storeDayValue('2026-10-12'), lte: storeDayValue('2026-10-12') },
    ])
  })

  it('records a counted download or install on today\'s store-day row', async () => {
    const late = new Date('2026-10-11T16:30:00.000Z') // 00:30 on 2026-10-12 in Asia/Shanghai
    await recordListingMetric(mockDb, 'a', 'installs', late)
    expect(mockDb.marketplaceListingDailyMetric.upsert).toHaveBeenCalledWith({
      where: { listingSkillId_day: { listingSkillId: 'a', day: storeDayValue('2026-10-12') } },
      create: { listingSkillId: 'a', day: storeDayValue('2026-10-12'), installs: 1 },
      update: { installs: { increment: 1 } },
    })
  })

  it('uses Asia/Shanghai calendar days for daily figures', () => {
    expect(storeDay(new Date('2026-10-11T16:30:00.000Z'))).toBe('2026-10-12')
    expect(storeDayStart(new Date('2026-10-11T16:30:00.000Z'))).toEqual(new Date('2026-10-11T16:00:00.000Z'))
    expect(storeDayKeys(NOW, 3)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12'])
  })

  it('buckets publish times into rolling weeks and ignores future or old rows', () => {
    const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000)
    expect(weeklyBuckets([daysAgo(1), daysAgo(6), daysAgo(8), daysAgo(30), daysAgo(-1)], NOW, 3))
      .toEqual([0, 1, 2])
  })

  it('computes store statistics without user identifiers', async () => {
    mockDb.marketplaceListing.count.mockResolvedValueOnce(41).mockResolvedValueOnce(3)
    mockDb.skill.groupBy.mockResolvedValue([{ authorId: 'x' }, { authorId: 'y' }])
    mockDb.marketplaceListing.findMany.mockResolvedValue([
      { firstPublishedAt: new Date(NOW.getTime() - 86_400_000) },
      { firstPublishedAt: new Date(NOW.getTime() - 10 * 86_400_000) },
    ])
    mockDb.marketplaceListingDailyMetric.groupBy.mockResolvedValue([
      { day: storeDayValue('2026-10-12'), _sum: { downloads: 4, installs: 12 } },
      { day: storeDayValue('2026-10-08'), _sum: { downloads: null, installs: 5 } },
    ])

    const stats = await computeMarketplaceStats(NOW)

    expect(stats).toEqual({
      totalSkills: 41,
      newThisWeek: 3,
      installsToday: 12,
      downloadsToday: 4,
      activeAuthors: 2,
      dailyInstalls: [0, 0, 5, 0, 0, 0, 12],
      dailyDownloads: [0, 0, 0, 0, 0, 0, 4],
      weeklyNewSkills: [0, 0, 0, 0, 0, 0, 1, 1],
      generatedAt: NOW.toISOString(),
    })
    expect(mockDb.marketplaceListing.count).toHaveBeenNthCalledWith(2, {
      where: expect.objectContaining({ firstPublishedAt: { gte: new Date(NOW.getTime() - 7 * 86_400_000) } }),
    })
    expect(JSON.stringify(stats)).not.toMatch(/"x"|"y"/)
  })
})
