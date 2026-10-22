import { describe, expect, it } from 'vitest'
import { SkillSourceUrlSchema } from './skill-source.js'

describe('optional Skill original source', () => {
  it('preserves omission, normalizes empty values, and preserves complete URLs', () => {
    expect(SkillSourceUrlSchema.parse(undefined)).toBeUndefined()
    for (const value of [null, '', '   ']) expect(SkillSourceUrlSchema.parse(value)).toBeNull()
    for (const value of ['https://x.com/user/status/123', 'https://github.com/org/repo/tree/main/skill', 'https://skills.sh/a/b', 'https://example.test/a?q=one#section']) {
      expect(SkillSourceUrlSchema.parse(' ' + value + ' ')).toBe(value)
    }
  })
  it('rejects unsafe protocols, credentials, malformed or oversized URLs', () => {
    for (const value of ['javascript:alert(1)', 'file:///tmp/skill', 'https://user:pass@example.test', 'https://', '//example.test', 'https://a.test/with space', 'https://a.test/' + 'x'.repeat(2048)]) {
      expect(SkillSourceUrlSchema.safeParse(value).success, value).toBe(false)
    }
  })
})
