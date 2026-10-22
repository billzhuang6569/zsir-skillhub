import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { copyStorageRow, parseStorageOperation, repointStorageRow } from './storage.js'
import type { createStorageRegistry } from '../providers/storage-registry.js'

const bytes = Buffer.from('source')
const id = createHash('sha256').update(bytes).digest('hex')
const row = { id, storageProvider: 'filesystem', storageNamespace: null, storageKey: `${id.slice(0, 2)}/${id}.zip` }
function fixture() {
  const source = { provider: 'filesystem' as const, get: vi.fn(async () => bytes), head: vi.fn(), put: vi.fn(), delete: vi.fn() }
  const target = { provider: 's3' as const, get: vi.fn(async () => bytes), head: vi.fn(), put: vi.fn(), delete: vi.fn() }
  const location = { storageProvider: 's3', storageNamespace: 's3:fixture' }
  const registry: ReturnType<typeof createStorageRegistry> = {
    read: () => source, target: () => ({ ...location, storage: target }), available: () => true,
  }
  return { source, target, registry, location, repoint: vi.fn(async () => true) }
}
describe('copy storage', () => {
  it('validates CLI arguments', () => {
    expect(parseStorageOperation(['copy', '--to', 's3', '--dry-run', '--repoint'])).toMatchObject({ dryRun: true, repoint: true })
    for (const args of [[], ['copy'], ['copy', '--to', 'unknown'], ['status', '--repoint'], ['copy', '--delete']]) {
      expect(() => parseStorageOperation(args)).toThrow()
    }
  })
  it('dry-run never reads, writes or repoints', async () => {
    const f = fixture()
    expect(await copyStorageRow(f.registry, 'cards', row, parseStorageOperation(['copy', '--to', 's3', '--dry-run', '--repoint']), f.repoint)).toBe('planned')
    for (const fn of [f.source.get, f.target.put, f.target.get, f.repoint]) expect(fn).not.toHaveBeenCalled()
  })
  it('verifies bytes before repoint and is idempotent when run again', async () => {
    const f = fixture()
    const operation = parseStorageOperation(['copy', '--to', 's3', '--repoint'])
    expect(await copyStorageRow(f.registry, 'cards', row, operation, f.repoint)).toBe('repointed')
    expect(f.target.get.mock.invocationCallOrder[0]).toBeLessThan(f.repoint.mock.invocationCallOrder[0])
    expect(await copyStorageRow(f.registry, 'cards', { ...row, ...f.location }, operation, f.repoint)).toBe('skipped')
    expect(f.target.put).toHaveBeenCalledOnce()
    expect(f.source.delete).not.toHaveBeenCalled()
  })
  it('never repoints mismatched size or digest; reports concurrent row change', async () => {
    for (const wrong of [Buffer.from('wrong!'), Buffer.from('x')]) {
      const f = fixture()
      f.target.get.mockResolvedValue(wrong)
      await expect(copyStorageRow(f.registry, 'cards', row, parseStorageOperation(['copy', '--to', 's3', '--repoint']), f.repoint)).rejects.toThrow('integrity')
      expect(f.repoint).not.toHaveBeenCalled()
    }
    const f = fixture(); f.repoint.mockResolvedValue(false)
    await expect(copyStorageRow(f.registry, 'cards', row, parseStorageOperation(['copy', '--to', 's3', '--repoint']), f.repoint)).rejects.toThrow('row changed')
  })
  it('conditions the transactional update on original provider, namespace and key', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }))
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ skillCard: { updateMany } }))
    const db = { $transaction: transaction } as unknown as Parameters<typeof repointStorageRow>[0]
    expect(await repointStorageRow(db, 'cards', row, { storageProvider: 's3', storageNamespace: 's3:new' })).toBe(false)
    expect(updateMany).toHaveBeenCalledWith({
      where: { sha256: id, storageProvider: 'filesystem', storageNamespace: null, storageKey: row.storageKey },
      data: { storageProvider: 's3', storageNamespace: 's3:new' },
    })
  })
})
