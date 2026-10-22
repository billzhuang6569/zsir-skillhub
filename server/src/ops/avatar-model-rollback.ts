import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { db } from '../db.js'

export const AVATAR_BACKFILL_MIGRATION = '20261018140000_avatar_model_backfill'

export function avatarWriterCanRestart(previousMarker: unknown, backfill: unknown): boolean {
  if (typeof previousMarker !== 'string' || !/^\d{14}_[a-z0-9_]+$/.test(previousMarker)) return false
  if (backfill === undefined) return true
  if (!backfill || typeof backfill !== 'object' || !('migration' in backfill) || backfill.migration !== AVATAR_BACKFILL_MIGRATION) return false
  return previousMarker >= AVATAR_BACKFILL_MIGRATION
}

/** The backfill marker commits with the data, including if Prisma dies before recording success. */
export async function canRestartPreviousAvatarWriter(metadataPath: string): Promise<boolean> {
  const metadata: unknown = JSON.parse(await readFile(metadataPath, 'utf8'))
  if (!metadata || typeof metadata !== 'object' || !('migrationMarker' in metadata)) return false
  const marker = await db.serverSetting.findUnique({ where: { key: 'avatar.model.backfilled' }, select: { value: true } })
  return avatarWriterCanRestart(metadata.migrationMarker, marker?.value)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = process.argv[2] && await canRestartPreviousAvatarWriter(process.argv[2]) ? 0 : 1
  } catch { process.exitCode = 1 }
  finally { await db.$disconnect() }
}
