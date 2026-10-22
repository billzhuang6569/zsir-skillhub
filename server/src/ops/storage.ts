import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { PrismaClient } from '@prisma/client'
import { createStorageRegistry, type StorageKind, type StorageLocation } from '../providers/storage-registry.js'

type StorageDb = Pick<PrismaClient, 'skillCard' | 'mediaAsset' | '$transaction'>
type CopyRow = StorageLocation & { id: string; storageKey: string }
type Registry = ReturnType<typeof createStorageRegistry>
export type StorageOperation = { command: 'status' | 'copy'; to?: 'filesystem' | 's3'; dryRun: boolean; repoint: boolean }

export function parseStorageOperation(args: string[]): StorageOperation {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    to: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, repoint: { type: 'boolean', default: false },
  } })
  const command = positionals[0]
  if (positionals.length !== 1 || (command !== 'status' && command !== 'copy')
    || (command === 'status' && (values.to || values['dry-run'] || values.repoint))
    || (command === 'copy' && values.to !== 'filesystem' && values.to !== 's3')) throw new Error('Invalid storage operation')
  return { command, to: values.to as StorageOperation['to'], dryRun: values['dry-run'], repoint: values.repoint }
}

export async function repointStorageRow(db: StorageDb, kind: StorageKind, row: CopyRow, target: StorageLocation): Promise<boolean> {
  if (!target.storageProvider) throw new Error('Invalid target storage')
  const where = { storageProvider: row.storageProvider, storageNamespace: row.storageNamespace, storageKey: row.storageKey }
  const result = await db.$transaction(async tx => kind === 'cards'
    ? tx.skillCard.updateMany({ where: { ...where, storageProvider: row.storageProvider ?? '', sha256: row.id }, data: { ...target, storageProvider: target.storageProvider! } })
    : tx.mediaAsset.updateMany({ where: { ...where, id: row.id, status: 'ready' }, data: target }))
  return result.count === 1
}

export async function copyStorageRow(registry: Registry, kind: StorageKind, row: CopyRow, operation: StorageOperation,
  repoint: (target: StorageLocation) => Promise<boolean>): Promise<'copied' | 'repointed' | 'skipped' | 'planned'> {
  const target = registry.target(kind, operation.to)
  const source = registry.read(kind, row)
  if (target.storageProvider === row.storageProvider && target.storageNamespace === row.storageNamespace) return 'skipped'
  if (operation.dryRun) return 'planned'
  const bytes = await source.get(row.storageKey)
  const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
  if (kind === 'cards' && digest(bytes) !== row.id) throw new Error('Source integrity failure')
  await target.storage.put(row.storageKey, bytes)
  const readback = await target.storage.get(row.storageKey)
  if (readback.length !== bytes.length || digest(readback) !== digest(bytes)) throw new Error('Copy integrity failure')
  if (!operation.repoint) return 'copied'
  if (!await repoint({ storageProvider: target.storageProvider, storageNamespace: target.storageNamespace })) throw new Error('Storage row changed')
  return 'repointed'
}

export async function runStorage(db: StorageDb, registry: Registry, operation: StorageOperation): Promise<unknown> {
  if (operation.command === 'status') {
    const [cards, media] = await Promise.all([
      db.skillCard.groupBy({ by: ['storageProvider', 'storageNamespace'], _count: true }),
      db.mediaAsset.groupBy({ by: ['storageProvider', 'storageNamespace'], _count: true }),
    ])
    return { cards, media }
  }
  const counts = { copied: 0, repointed: 0, skipped: 0, planned: 0, failed: [] as string[] }
  for (const kind of ['cards', 'media'] as const) {
    let cursor: string | undefined
    for (;;) {
      const rows: CopyRow[] = kind === 'cards'
        ? (await db.skillCard.findMany({ where: cursor ? { sha256: { gt: cursor } } : {}, orderBy: { sha256: 'asc' }, take: 100 }))
          .map(row => ({ ...row, id: row.sha256 }))
        : (await db.mediaAsset.findMany({ where: { status: 'ready', storageKey: { not: null }, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' }, take: 100 })).map(row => ({ ...row, storageKey: row.storageKey! }))
      if (!rows.length) break
      for (const row of rows) {
        try { counts[await copyStorageRow(registry, kind, row, operation, target => repointStorageRow(db, kind, row, target))]++ }
        catch { counts.failed.push(row.id) }
      }
      cursor = rows.at(-1)!.id
    }
  }
  return counts
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const operation = parseStorageOperation(process.argv.slice(2))
    const { configSchema } = await import('../config-schema.js')
    const config = configSchema.parse(process.env)
    process.env.SKILLHUB_BACKUP_QUIET_DB = '1'
    const { db } = await import('../db.js')
    try {
      const result = await runStorage(db, createStorageRegistry(config), operation)
      process.stdout.write(JSON.stringify(result) + '\n')
      if (typeof result === 'object' && result !== null && 'failed' in result && Array.isArray(result.failed) && result.failed.length) process.exitCode = 1
    } finally { await db.$disconnect() }
  } catch { process.stderr.write('Storage operation failed\n'); process.exitCode = 1 }
}
