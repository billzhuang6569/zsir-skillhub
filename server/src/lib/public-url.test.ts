import { describe, expect, it, vi } from 'vitest'

vi.mock('../config.js', () => ({ config: { PUBLIC_BASE_URL: 'https://skills.example.com/instance' } }))
import { publicUrl } from './public-url.js'

describe('publicUrl', () => {
  it('preserves the instance prefix when joining absolute paths', () => {
    expect(publicUrl('/api/admin/v1/capabilities')).toBe('https://skills.example.com/instance/api/admin/v1/capabilities')
    expect(publicUrl('/')).toBe('https://skills.example.com/instance/')
  })
  it.each(['api/skills', 'https://other.example.com', '//other.example.com'])('rejects non-path input %s', (path) => {
    expect(() => publicUrl(path)).toThrow('absolute path')
  })
})
