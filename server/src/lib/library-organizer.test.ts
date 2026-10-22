import { describe, expect, it } from 'vitest'
import { dedupeTagNames, normalizeQuickAccessItems, tagKey, TagNameSchema } from './library-organizer.js'

describe('library organizer helpers', () => {
  it('normalizes tag names and rejects empty, oversized and invisible names', () => {
    expect(TagNameSchema.parse('  写作   工具 ')).toBe('写作 工具')
    expect(TagNameSchema.safeParse('   ').success).toBe(false)
    expect(TagNameSchema.safeParse('x'.repeat(33)).success).toBe(false)
    expect(TagNameSchema.safeParse('x'.repeat(32)).success).toBe(true)
    expect(TagNameSchema.safeParse(String.fromCodePoint(0x1f600).repeat(32)).success).toBe(true)
    expect(TagNameSchema.safeParse(String.fromCodePoint(0x1f600).repeat(33)).success).toBe(false)
    expect(TagNameSchema.safeParse(`a${String.fromCharCode(0x200b)}b`).success).toBe(false)
    expect(TagNameSchema.safeParse(`a${String.fromCharCode(0x202e)}b`).success).toBe(false)
  })

  it('treats tag names case-insensitively and keeps the first spelling', () => {
    expect(tagKey('Writing')).toBe(tagKey('writing'))
    expect(dedupeTagNames(['Writing', 'writing', 'Code', 'WRITING'])).toEqual(['Writing', 'Code'])
  })

  it('drops quick-access items for deleted Skills, emptied tags, duplicates and malformed rows', () => {
    const items = normalizeQuickAccessItems(
      [
        { kind: 'skill', ref: 'entry-1' },
        { kind: 'skill', ref: 'entry-deleted' },
        { kind: 'tag', ref: 'writing' },
        { kind: 'tag', ref: 'WRITING' },
        { kind: 'tag', ref: 'gone' },
        { kind: 'skill', ref: 'entry-1' },
        { kind: 'folder', ref: 'x' },
        'garbage',
      ],
      new Set(['entry-1']),
      new Map([['writing', 'Writing']]),
    )
    expect(items).toEqual([{ kind: 'skill', ref: 'entry-1' }, { kind: 'tag', ref: 'Writing' }])
  })
})
