import { describe, expect, it, vi } from 'vitest'

vi.mock('../db.js', () => ({ db: { skillCard: { findUnique: vi.fn() } } }))
vi.mock('./skill-package.js', () => ({
  describeSkillPackage: () => ({ contentHash: 'content-hash', executablePaths: [], skillMd: '# Skill' }),
}))
vi.mock('./card-store.js', () => ({
  storeCardBytes: vi.fn(async (): Promise<string> => 'stored/key.zip'),
  cardStorageProvider: vi.fn(() => 'filesystem'),
  cardStorageNamespace: vi.fn(() => null),
  readCardBytes: vi.fn(),
  CardIntegrityError: class CardIntegrityError extends Error {},
}))

import { cardStorageProvider, cardStorageNamespace, readCardBytes, storeCardBytes, CardIntegrityError } from './card-store.js'
import { prepareCard, registerCard, loadVersionPackage } from './skill-cards.js'
import { db } from '../db.js'
import { ObjectMissingError } from '../providers/object-storage.js'

describe('card storage attribution', () => {
  it('passes the stored provider and key into the first-upload SQL without replacing existing rows', async () => {
    const bytes = Buffer.from('package fixture')
    const card = await prepareCard(bytes)
    expect(storeCardBytes).toHaveBeenCalledWith(bytes, card.sha256)
    expect(cardStorageProvider).toHaveBeenCalledOnce()
    expect(card).toMatchObject({ storageProvider: 'filesystem', storageKey: 'stored/key.zip' })
    const execute = vi.fn().mockResolvedValue(1)
    await registerCard({ $executeRaw: execute }, card, 'creator')
    const [sql, ...values] = execute.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    expect(sql.join('?')).toContain('"storageKey", "storageProvider", "storageNamespace", "createdById"')
    expect(sql.join('?')).toContain('ON CONFLICT ("sha256") DO NOTHING')
    expect(values).toEqual([card.sha256, 'content-hash', '[]', bytes.length, 'stored/key.zip', 'filesystem', null, 'creator'])
  })
  it('records the configured namespace on new S3 writes', async () => {
    vi.mocked(cardStorageProvider).mockReturnValueOnce('s3')
    vi.mocked(cardStorageNamespace).mockReturnValueOnce('s3:fixture')
    expect(await prepareCard(Buffer.from('package'))).toMatchObject({ storageProvider: 's3', storageNamespace: 's3:fixture' })
  })
  it('routes version reads by row and only falls back on missing or corrupt content', async () => {
    const row = { storageKey: 'key', storageProvider: 's3', storageNamespace: 's3:fixture' }
    vi.mocked(db.skillCard.findUnique).mockResolvedValue(row as Awaited<ReturnType<typeof db.skillCard.findUnique>>)
    vi.mocked(readCardBytes).mockResolvedValueOnce(Buffer.from('stored'))
    expect(await loadVersionPackage({ cardSha256: 'sha', packageData: null })).toEqual(Buffer.from('stored'))
    expect(readCardBytes).toHaveBeenLastCalledWith('key', 'sha', row)
    for (const error of [Object.assign(new Error('S3 unavailable'), { statusCode: 503 }), new Error('EACCES')]) {
      vi.mocked(readCardBytes).mockRejectedValueOnce(error)
      await expect(loadVersionPackage({ cardSha256: 'sha', packageData: null })).rejects.toBe(error)
    }
    for (const error of [new ObjectMissingError(), new CardIntegrityError('corrupt')]) {
      vi.mocked(readCardBytes).mockRejectedValueOnce(error)
      expect(await loadVersionPackage({ cardSha256: 'sha', packageData: Buffer.from('legacy') })).toEqual(Buffer.from('legacy'))
    }
  })
})
