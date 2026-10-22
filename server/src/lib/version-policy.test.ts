import { describe, expect, it } from 'vitest'
import { allocateVersion, versionOrdinal } from './version-policy.js'

describe('numeric Skill version policy', () => {
  it('preserves the complete 1000-label domain, carry and manual jumps', () => {
    expect(allocateVersion(-1)).toBe('0.1.0')
    expect(allocateVersion(-1, '0.0.0', 'manual')).toBe('0.0.0')
    for (let n = 0; n < 999; n += 1) {
      const next = allocateVersion(n, '0.0.0')
      expect(versionOrdinal(next)).toBe(n + 1)
    }
    expect(allocateVersion(12, '9.9.9', 'manual')).toBe('9.9.9')
    expect(() => allocateVersion(999)).toThrow('exhausted')
    expect(() => allocateVersion(120, '1.0.0', 'manual')).toThrow('above')
  })
  it('does not normalize malformed new labels', () => {
    for (const label of ['v0.1.0', '0.1.0-personal.1', '1.56.1', '01.1.0', ' 0.1.0', '0.1.0 ', '0.1', '0.1.0.1']) {
      expect(versionOrdinal(label)).toBeNull()
      expect(() => allocateVersion(-1, label)).toThrow('upgrade')
    }
  })
})
