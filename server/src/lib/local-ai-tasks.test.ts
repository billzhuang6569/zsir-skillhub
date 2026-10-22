import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildLocalAiInput, localAiInputHash, truncateUtf8, localAiBackoffMs,
  LOCAL_AI_CONFIG_VERSION, LOCAL_AI_INPUT_LIMITS,
} from './local-ai-tasks.js'

const skill = { id: 'skill', name: '周报', description: '整理文档', sourceContent: '# Weekly report' }

describe('local AI task input', () => {
  it('truncates at UTF-8 boundaries for every possible partial character', () => {
    const text = 'a中😀é'
    for (let size = 0; size <= Buffer.byteLength(text) + 1; size += 1) {
      const truncated = truncateUtf8(text, size)
      expect(Buffer.byteLength(truncated)).toBeLessThanOrEqual(size)
      expect(text.startsWith(truncated)).toBe(true)
      expect(truncated).not.toContain('\uFFFD')
    }
    expect(truncateUtf8(text, 4)).toBe('a中')
    expect(truncateUtf8(text, 7)).toBe('a中')
    expect(truncateUtf8(text, 8)).toBe('a中😀')
  })
  it('bounds metadata and source by bytes and never reads additional files', () => {
    const long = '中😀'.repeat(30_000)
    const input = buildLocalAiInput({ ...skill, name: long, description: long, sourceContent: long })
    for (const field of ['name', 'description', 'skillMd'] as const) {
      expect(Buffer.byteLength(input[field])).toBeLessThanOrEqual(LOCAL_AI_INPUT_LIMITS[field])
      expect(input[field]).not.toContain('\uFFFD')
    }
    expect(input.files).toEqual([])
    expect(buildLocalAiInput({ ...skill, description: null, sourceContent: null })).toMatchObject({ description: '', skillMd: '' })
  })
  it('redacts before truncation, including secrets spanning the byte boundary', () => {
    const token = 'sk-12345678901234567890'
    const input = buildLocalAiInput({ ...skill, name: token, description: token,
      sourceContent: `${'a'.repeat(65_500)}\n-----BEGIN PRIVATE KEY-----\nsecret bytes\n-----END PRIVATE KEY-----` })
    expect(input.name).toBe('[REDACTED]')
    expect(input.description).toBe('[REDACTED]')
    expect(input.skillMd).toBe(`${'a'.repeat(65_500)}\n[REDACTED]`)
  })
  it('uses the exact versioned canonical tuple and reacts to every input field', () => {
    const input = buildLocalAiInput(skill)
    const hash = localAiInputHash(skill.id, input)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(hash).toBe(createHash('sha256').update(JSON.stringify([
      LOCAL_AI_CONFIG_VERSION, 'analyzeSkill', skill.id, input.name, input.description, input.skillMd, input.files,
    ])).digest('hex'))
    expect(localAiInputHash(skill.id, { ...input })).toBe(hash)
    for (const field of ['name', 'description', 'skillMd'] as const) {
      expect(localAiInputHash(skill.id, { ...input, [field]: 'changed' })).not.toBe(hash)
    }
    expect(localAiInputHash(skill.id, { ...input, files: ['SKILL.md'] })).not.toBe(hash)
    expect(localAiInputHash('other', input)).not.toBe(hash)
    expect(localAiInputHash(skill.id, input, 'draftAvatarPrompt')).not.toBe(hash)
    expect(localAiInputHash(skill.id, input, 'analyzeSkill', 'analyzeSkill.v2')).not.toBe(hash)
  })
  it('doubles failure backoff and caps it at 24 hours', () => {
    expect([1, 2, 3, 7, 8, 1000].map(localAiBackoffMs)).toEqual([15, 30, 60, 960, 1440, 1440].map(minutes => minutes * 60_000))
  })
})
