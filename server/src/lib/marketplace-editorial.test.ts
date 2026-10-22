import { describe, expect, it } from 'vitest'
import { EditorialLabelsSchema, MarketplaceEditorialBody } from './marketplace-editorial.js'

describe('marketplace editorial validation', () => {
  it('normalizes and deduplicates without truncating Unicode characters', () => {
    expect(EditorialLabelsSchema.parse([' AI工具 ', 'AI工具', 'e\u0301', 'é', '𠀀𠀁𠀂𠀃𠀄'])).toEqual(['AI工具', 'é', '𠀀𠀁𠀂𠀃𠀄'])
    expect(EditorialLabelsSchema.parse([])).toEqual([])
    for (const labels of [[''], ['六个汉字超限'], ['换\n行'], ['隐\u200b藏'], ['精选'], ['new'], ['HOT'], Array(9).fill('标签')]) {
      expect(EditorialLabelsSchema.safeParse(labels).success).toBe(false)
    }
  })
  it('requires explicit writes and an original label snapshot', () => {
    for (const body of [{}, { featured: 'false' }, { labels: [] }, { editorialLabels: [] }, { expectedEditorialLabels: [] }]) {
      expect(MarketplaceEditorialBody.safeParse(body).success).toBe(false)
    }
    expect(MarketplaceEditorialBody.parse({ featured: false })).toEqual({ featured: false })
    expect(MarketplaceEditorialBody.safeParse({ editorialLabels: [], expectedEditorialLabels: ['原标签'] }).success).toBe(true)
  })
})
