import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = vi.hoisted(() => ({ SKILL_CARD_STORAGE_DIR: '' }))
const location = { storageProvider: 'filesystem', storageNamespace: null }
vi.mock('../config.js', () => ({ config: mockConfig }))

const {
  CardIntegrityError,
  cardStorageKey,
  readCardBytes,
  storeCardBytes,
  verifyStoredCard,
} = await import('./card-store.js')

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

describe('card store', () => {
  beforeEach(() => {
    mockConfig.SKILL_CARD_STORAGE_DIR = mkdtempSync(join(tmpdir(), 'skillhub-card-store-'))
  })

  it('stores immutable bytes under a hash-derived key without leaving temporary files', async () => {
    const data = Buffer.from('card bytes')
    const key = await storeCardBytes(data, sha256(data))
    expect(key).toBe(`${sha256(data).slice(0, 2)}/${sha256(data)}.zip`)
    expect(readFileSync(join(mockConfig.SKILL_CARD_STORAGE_DIR, key))).toEqual(data)
    expect(readdirSync(join(mockConfig.SKILL_CARD_STORAGE_DIR, sha256(data).slice(0, 2)))).toEqual([`${sha256(data)}.zip`])
    expect(await storeCardBytes(data, sha256(data))).toBe(key)
    expect(await readCardBytes(key, sha256(data), location)).toEqual(data)
  })

  it('rejects bytes that do not match the claimed hash', async () => {
    await expect(storeCardBytes(Buffer.from('a'), sha256(Buffer.from('b')))).rejects.toBeInstanceOf(CardIntegrityError)
  })

  it('refuses to serve a damaged file and repairs it on the next store', async () => {
    const data = Buffer.from('original')
    const key = await storeCardBytes(data, sha256(data))
    writeFileSync(join(mockConfig.SKILL_CARD_STORAGE_DIR, key), 'tampered')
    await expect(readCardBytes(key, sha256(data), location)).rejects.toBeInstanceOf(CardIntegrityError)
    expect(await verifyStoredCard(key, sha256(data), location)).toBe(false)
    await storeCardBytes(data, sha256(data))
    expect(await verifyStoredCard(key, sha256(data), location)).toBe(true)
  })

  it('never builds a storage path from anything but a SHA-256 hash', async () => {
    expect(() => cardStorageKey('../etc/passwd')).toThrow(CardIntegrityError)
    await expect(readCardBytes('../../etc/passwd', '0'.repeat(64), location)).rejects.toBeInstanceOf(CardIntegrityError)
    expect(await verifyStoredCard(`aa/${'a'.repeat(64)}.zip`, 'a'.repeat(64), location)).toBe(false)
  })
})
