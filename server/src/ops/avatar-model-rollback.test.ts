import { describe, expect, it, vi } from 'vitest'
vi.mock('../db.js', () => ({ db: {} }))
import { AVATAR_BACKFILL_MIGRATION, avatarWriterCanRestart } from './avatar-model-rollback.js'

describe('migration failure restart boundary', () => {
  const old = '20261018090000_avatar_style_versions'
  it('allows the previous writer after a rolled-back backfill', () => {
    expect(avatarWriterCanRestart(old, undefined)).toBe(true)
  })
  it('blocks an old writer after a committed backfill, including a later activation attempt', () => {
    expect(avatarWriterCanRestart(old, { migration: AVATAR_BACKFILL_MIGRATION })).toBe(false)
    expect(avatarWriterCanRestart(AVATAR_BACKFILL_MIGRATION, { migration: AVATAR_BACKFILL_MIGRATION })).toBe(true)
  })
  it('fails closed on unknown metadata or marker contents', () => {
    expect(avatarWriterCanRestart(undefined, undefined)).toBe(false)
    expect(avatarWriterCanRestart(old, null)).toBe(false)
    expect(avatarWriterCanRestart(old, {})).toBe(false)
  })
})
