import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import catalog from '../avatar-styles/catalog.json' with { type: 'json' }
import locks from '../avatar-styles/published.lock.json' with { type: 'json' }
import { avatarStyleCatalog, avatarStyleSchema, canonicalJson, classicAvatarStyle, contentSha256 } from './avatar-style-catalog.js'
import { SKILL_ART_FIXED_STYLE, SKILL_ART_SYSTEM, SKILL_AVATAR_CANVAS, SKILL_AVATAR_PROMPT_VERSION, SKILL_AVATAR_SYSTEM } from './skill-avatar-prompt.js'
import { FAL_AVATAR_MODEL, falAvatarPayload } from './fal.js'

function checkLocks(entries: typeof avatarStyleCatalog): void {
  for (const [key, hash] of Object.entries(locks)) {
    const style = entries.find(entry => `${entry.styleId}@${entry.styleVersion}` === key)
    if (!style || contentSha256(canonicalJson(style)) !== hash) throw new Error(`Locked version changed: ${key}`)
  }
}

describe('avatar style catalog', () => {
  it('ships only published classic v1 with official names and plain descriptions', () => {
    expect(avatarStyleCatalog).toEqual(catalog)
    expect(new Set(catalog.map(style => `${style.styleId}@${style.styleVersion}`)).size).toBe(catalog.length)
    expect(catalog).toHaveLength(1)
    expect(classicAvatarStyle).toMatchObject({ styleId: 'classic', styleVersion: 1, name: { zh: '经典', en: 'Classic' } })
    for (const style of catalog) {
      expect(avatarStyleSchema.safeParse(style).success).toBe(true)
      expect(style.status).toBe('published')
      expect(style.description.zh).not.toMatch(/测试|暂定|待.*确认/)
      expect(style.description.en).not.toMatch(/test|provisional|pending/i)
      expect(style.directPrompt).toContain('{{name}}')
      expect(style.directPrompt).toContain('{{description}}')
    }
  })

  it('requires both non-blank prompts and bounded, known input fields', () => {
    for (const field of ['metaPrompt', 'directPrompt']) {
      for (const value of [undefined, '', ' \n\t ', null]) {
        expect(avatarStyleSchema.safeParse({ ...classicAvatarStyle, [field]: value }).success).toBe(false)
      }
    }
    for (const inputTemplate of [
      { name: { maxLength: 129 }, description: { maxLength: 500 } },
      { name: { maxLength: 128 }, description: { maxLength: 501 } },
      { ...classicAvatarStyle.inputTemplate, skillContent: { maxLength: 100 } },
      { ...classicAvatarStyle.inputTemplate, scenarios: { maxItems: 9, maxLength: 100 } },
    ]) expect(avatarStyleSchema.safeParse({ ...classicAvatarStyle, inputTemplate }).success).toBe(false)
    expect(avatarStyleSchema.safeParse({ ...classicAvatarStyle, styleVersion: 1.5 }).success).toBe(false)
    expect(avatarStyleSchema.safeParse({ ...classicAvatarStyle, status: 'draft' }).success).toBe(false)
  })

  it('locks every version and detects modification or removal while allowing a new version', () => {
    expect(Object.keys(locks).sort()).toEqual(catalog.map(style => `${style.styleId}@${style.styleVersion}`).sort())
    expect(() => checkLocks(avatarStyleCatalog)).not.toThrow()
    const changed = avatarStyleCatalog.map(style => style.styleId === 'classic' ? { ...style, directPrompt: 'changed' } : style)
    expect(() => checkLocks(changed)).toThrow('Locked version changed: classic@1')
    expect(() => checkLocks(avatarStyleCatalog.slice(1))).toThrow('Locked version changed: classic@1')
    expect(() => checkLocks([...avatarStyleCatalog, { ...classicAvatarStyle, styleVersion: 2, directPrompt: 'new' }])).not.toThrow()
  })

  it('canonicalizes nested object key order but preserves array order and prompt whitespace', () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: ' x\n' })).toBe('{"a":" x\\n","z":[{"a":1,"b":2}]}')
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })

  it('embeds the canonical classic v1 content and hash in both backfill insert and conflict check', () => {
    const sql = readFileSync(new URL('../../prisma/migrations/20261018140000_avatar_model_backfill/migration.sql', import.meta.url), 'utf8')
    const content = canonicalJson(classicAvatarStyle)
    const literal = `'${content.replaceAll("'", "''")}'`
    const hash = contentSha256(content)
    expect(sql).toContain(`VALUES ('classic',1,${literal},'${hash}','repository')`)
    expect(sql).toContain(`AND content=${literal} AND "contentSha256"='${hash}')`)
  })

  it('preserves pre-migration prompt bytes, promptVersion and fal model/parameters exactly', () => {
    // Captured from the original module before extraction, independently of the catalog lock.
    expect(contentSha256(SKILL_AVATAR_SYSTEM)).toBe('e8281fe3725a63420e7392edc44846e9b78ba46b4e0be85d8a2d042de893092d')
    expect(contentSha256(SKILL_ART_FIXED_STYLE)).toBe('5f2857b15176879531642d654f8b007eac4cf34909f59bb11aeacf89db39ff77')
    expect(contentSha256(SKILL_ART_SYSTEM)).toBe('062a4610f01ad057cd74fed1dbd38c66a0e0cbe7ccc5ed0851eb952035ffe143')
    expect(contentSha256(SKILL_AVATAR_CANVAS)).toBe('cf8b52ebe68a47a5d86e97c64f52e290e234cf99554f556c12c90ea19d473851')
    expect(SKILL_AVATAR_PROMPT_VERSION).toBe('skill-art-v1-square')
    expect(classicAvatarStyle.metaPrompt).toBe(SKILL_AVATAR_SYSTEM)
    expect(contentSha256(classicAvatarStyle.directPrompt)).toBe('e416375e663aa065a9ea7d7491f676b9850a2a072109810a65a6001aa2cd4d49')
    expect(classicAvatarStyle.directPrompt).toContain(SKILL_ART_FIXED_STYLE)
    expect(classicAvatarStyle.directPrompt).toContain(SKILL_AVATAR_CANVAS)
    expect(FAL_AVATAR_MODEL).toBe('fal-ai/nano-banana-2')
    expect(falAvatarPayload('drawing')).toEqual({ prompt: 'drawing', num_images: 1, aspect_ratio: '1:1',
      output_format: 'jpeg', safety_tolerance: '6', resolution: '0.5K', limit_generations: true, thinking_level: 'high' })
  })
})
