import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, scryptSync } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { decodeCredentialKekKeyring, decryptInstanceSecret, destroyCredentialKekKeyring, verifyCredentialDek, type CredentialKekKeyring } from '../lib/credential-crypto.js'
import { createFilesystemObjectStorage } from '../providers/filesystem-object-storage.js'
import { createStorageRegistry } from '../providers/storage-registry.js'

export const BLOCK_SIZE = 1024 * 1024
const HEADER = Buffer.from([0x53, 0x4b, 0x42, 0x31, 1])
const UUID = z.string().uuid()
const PART = z.enum(['db', 'media', 'cards', 'caddy', 'objects'])
const Recovery = z.object({ manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), dataKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/), env: z.string().max(1024 * 1024) }).strict()
const RecoveryHeader = z.object({
  format: z.literal('SKR1'), N: z.literal(131072), r: z.literal(8), p: z.literal(1),
  salt: z.string().regex(/^[a-f0-9]{32}$/), backupId: UUID,
}).strict()
const RECOVERY_ERROR = '恢复口令错误或恢复文件已损坏'

export function takeSecret(name: string): string {
  const value = process.env[name]
  delete process.env[name]
  if (!value) throw new Error('缺少加密材料')
  return value
}

// Exact reads retain at most one input chunk plus one bounded frame.
async function* frames(input: AsyncIterable<Buffer>, size: number): AsyncGenerator<Buffer> {
  let block = Buffer.alloc(size)
  let used = 0
  for await (const chunk of input) {
    let offset = 0
    while (offset < chunk.length) {
      const count = Math.min(size - used, chunk.length - offset)
      chunk.copy(block, used, offset, offset + count)
      used += count; offset += count
      if (used === size) { yield block; block = Buffer.alloc(size); used = 0 }
    }
  }
  if (used) yield block.subarray(0, used)
}

function partKey(dataKey: Buffer, name: string, backupId: string): Buffer {
  PART.parse(name); UUID.parse(backupId)
  if (dataKey.length !== 32) throw new Error('无效数据密钥')
  return Buffer.from(hkdfSync('sha256', dataKey, backupId, `skillhub-backup-part:${name}`, 32))
}

function nonce(index: bigint): Buffer {
  const result = Buffer.alloc(12)
  result.writeBigUInt64BE(index, 4)
  return result
}

function aad(name: string, index: bigint, last: boolean): Buffer {
  return Buffer.from(JSON.stringify(['SKB1', 1, name, index.toString(), last]))
}

export async function* encryptPart(input: AsyncIterable<Buffer>, dataKey: Buffer, name: string, backupId: string): AsyncGenerator<Buffer> {
  const key = partKey(dataKey, name, backupId)
  let index = 0n
  try {
    yield HEADER
    // A separate authenticated empty terminal frame makes exact-block and empty inputs unambiguous.
    for await (const block of frames(input, BLOCK_SIZE)) {
      const cipher = createCipheriv('aes-256-gcm', key, nonce(index))
      cipher.setAAD(aad(name, index++, false))
      const length = Buffer.alloc(5); length.writeUInt32BE(block.length)
      yield Buffer.concat([length, cipher.update(block), cipher.final(), cipher.getAuthTag()])
      block.fill(0)
    }
    const cipher = createCipheriv('aes-256-gcm', key, nonce(index))
    cipher.setAAD(aad(name, index, true)); cipher.final()
    yield Buffer.concat([Buffer.from([0, 0, 0, 0, 1]), cipher.getAuthTag()])
  } finally { key.fill(0) }
}

export async function* decryptPart(input: AsyncIterable<Buffer>, dataKey: Buffer, name: string, backupId: string): AsyncGenerator<Buffer> {
  const key = partKey(dataKey, name, backupId)
  const iterator = input[Symbol.asyncIterator]()
  let pending: Buffer = Buffer.alloc(0)
  async function read(size: number): Promise<Buffer> {
    const result = Buffer.alloc(size)
    let used = 0
    while (used < size) {
      if (!pending.length) {
        const next = await iterator.next()
        if (next.done) throw new Error('备份分片截断')
        pending = next.value
      }
      const count = Math.min(size - used, pending.length)
      pending.copy(result, used, 0, count)
      pending = pending.subarray(count); used += count
    }
    return result
  }
  try {
    if (!(await read(5)).equals(HEADER)) throw new Error('无效备份格式')
    let index = 0n
    for (;;) {
      const frame = await read(5)
      const size = frame.readUInt32BE()
      const last = frame[4] === 1
      if (frame[4] > 1 || size > BLOCK_SIZE || (last ? size !== 0 : size === 0)) throw new Error('无效备份块')
      const ciphertext = await read(size)
      const decipher = createDecipheriv('aes-256-gcm', key, nonce(index++))
      decipher.setAAD(aad(name, index - 1n, last))
      decipher.setAuthTag(await read(16))
      const plaintext = decipher.update(ciphertext)
      try {
        decipher.final()
        if (last) {
          if (pending.length || !(await iterator.next()).done) throw new Error('末块后存在数据')
          return
        }
        // The consumer may retain the yielded buffer until a slow write completes.
        yield Buffer.from(plaintext)
      } finally { plaintext.fill(0) }
    }
  } finally { key.fill(0); await iterator.return?.() }
}

export function sealRecovery(input: unknown, password: string, backupId: string): Buffer {
  const body = Recovery.parse(input)
  if (Array.from(password).length < 12) throw new Error('恢复口令至少 12 字符')
  const header = Buffer.from(JSON.stringify(RecoveryHeader.parse({ format: 'SKR1', N: 131072, r: 8, p: 1, salt: randomBytes(16).toString('hex'), backupId })))
  const key = scryptSync(password, Buffer.from(JSON.parse(header.toString()).salt as string, 'hex'), 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 })
  const plaintext = Buffer.from(JSON.stringify(body))
  try {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(header)
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length)
    return Buffer.concat([length, header, iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  } finally { key.fill(0); plaintext.fill(0) }
}

export function openRecovery(input: Buffer, password: string): z.infer<typeof Recovery> & { backupId: string } {
  try {
    const length = input.readUInt32BE()
    if (length > 1024 || input.length < 4 + length + 28) throw new Error()
    const headerBytes = input.subarray(4, 4 + length)
    const header = RecoveryHeader.parse(JSON.parse(headerBytes.toString()))
    const key = scryptSync(password, Buffer.from(header.salt, 'hex'), 32, { N: header.N, r: header.r, p: header.p, maxmem: 256 * 1024 * 1024 })
    let plaintext: Buffer | undefined
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, input.subarray(4 + length, 16 + length))
      decipher.setAAD(headerBytes); decipher.setAuthTag(input.subarray(-16))
      plaintext = decipher.update(input.subarray(16 + length, -16))
      decipher.final()
      return { ...Recovery.parse(JSON.parse(plaintext.toString())), backupId: header.backupId }
    } finally { key.fill(0); plaintext?.fill(0) }
  } catch { throw new Error(RECOVERY_ERROR) }
}

type VerifyDb = Pick<PrismaClient, 'instanceIdentity' | 'serverSetting' | 'teamCredentialVersion' | 'mediaAsset' | 'skillCard'>
export async function verifyRestore(db: VerifyDb, keyring: CredentialKekKeyring, expected: string, mediaRoot: string, cardsRoot: string,
  registry?: ReturnType<typeof createStorageRegistry>): Promise<Record<string, number>> {
  const counts = { identity: 0, settings: 0, credentials: 0, media: 0, cards: 0, missing: 0, failed: 0, unavailable: 0 }
  try {
    const identity = await db.instanceIdentity.findUnique({ where: { id: 1 } })
    if (!identity || identity.instanceId !== expected) throw new Error()
    const der = decryptInstanceSecret(identity, { name: 'instance-identity-key' }, keyring)
    try {
      const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
      if (key.asymmetricKeyType !== 'ed25519' || createPublicKey(key).export({ format: 'jwk' }).x !== identity.publicKey) throw new Error()
      counts.identity++
    } finally { der.fill(0) }
  } catch { counts.failed++ }
  for (const row of await db.serverSetting.findMany()) {
    const fields = [row.secretCiphertext, row.secretIv, row.secretTag, row.secretWrappedDek, row.secretWrapIv, row.secretWrapTag, row.secretKekVersion, row.secretAadVersion]
    if (fields.every(value => value === null)) continue
    try {
      if (!row.secretCiphertext || !row.secretIv || !row.secretTag || !row.secretWrappedDek || !row.secretWrapIv || !row.secretWrapTag || row.secretKekVersion === null || row.secretAadVersion === null) throw new Error()
      decryptInstanceSecret({
        ciphertext: row.secretCiphertext, iv: row.secretIv, tag: row.secretTag, wrappedDek: row.secretWrappedDek,
        wrapIv: row.secretWrapIv, wrapTag: row.secretWrapTag, kekVersion: row.secretKekVersion, aadVersion: row.secretAadVersion,
      }, { name: `server-setting:${row.key}` }, keyring).fill(0)
      counts.settings++
    } catch { counts.failed++ }
  }
  for (const row of await db.teamCredentialVersion.findMany({ include: { credential: true } })) {
    try {
      verifyCredentialDek(row, { credentialId: row.credentialId, teamId: row.credential.teamId, envKey: row.credential.envKey, revision: row.revision }, keyring)
      counts.credentials++
    } catch { counts.failed++ }
  }
  for (const [kind, root, rows] of [
    ['media', mediaRoot, await db.mediaAsset.findMany({ where: { storageProvider: { in: ['filesystem', 's3'] }, status: { not: 'deleted' } } })],
    ['cards', cardsRoot, await db.skillCard.findMany({ where: { storageProvider: { in: ['filesystem', 's3'] } } })],
  ] as const) {
    for (const row of rows) {
      if (registry ? !registry.available(row) : row.storageProvider !== 'filesystem' || row.storageNamespace != null) {
        counts.unavailable++
        continue
      }
      try {
        const storage = registry ? registry.read(kind, row) : createFilesystemObjectStorage(root)
        if (!row.storageKey || !await storage.head(row.storageKey)) counts.missing++
        else counts[kind]++
      } catch { counts.failed++ }
    }
  }
  return counts
}

async function stdin(limit = 2 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length
    if (size > limit) throw new Error('输入过大')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

async function treeStats(root: string): Promise<{ files: number; bytes: number }> {
  const result = { files: 0, bytes: 0 }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) { const child = await treeStats(path); result.files += child.files; result.bytes += child.bytes }
    else if (entry.isFile()) { result.files++; result.bytes += (await stat(path)).size }
    else throw new Error('存储目录包含非普通文件')
  }
  return result
}

export async function runBackup(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    name: { type: 'string' }, 'backup-id': { type: 'string' }, field: { type: 'string' }, 'expect-instance': { type: 'string' },
  } })
  const command = positionals[0]
  if (positionals.length !== 1) throw new Error('无效命令')
  if (command === 'encrypt-part' || command === 'decrypt-part') {
    const encoded = takeSecret('SKILLHUB_BACKUP_DATA_KEY')
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('无效数据密钥')
    const key = Buffer.from(encoded, 'base64')
    try {
      const operation = command === 'encrypt-part' ? encryptPart : decryptPart
      await pipeline(Readable.from(operation(process.stdin, key, PART.parse(values.name), UUID.parse(values['backup-id']))), process.stdout)
    } finally { key.fill(0) }
  } else if (command === 'seal-recovery' || command === 'open-recovery') {
    const password = takeSecret('SKILLHUB_BACKUP_PASSPHRASE')
    const input = await stdin()
    try {
      if (command === 'seal-recovery') process.stdout.write(sealRecovery(JSON.parse(input.toString()), password, UUID.parse(values['backup-id'])))
      else {
        const body = openRecovery(input, password)
        const field = z.enum(['data-key', 'manifest-sha256', 'env', 'backup-id']).parse(values.field)
        process.stdout.write(field === 'data-key' ? body.dataKey : field === 'manifest-sha256' ? body.manifestSha256 : field === 'backup-id' ? body.backupId : body.env)
      }
    } finally { input.fill(0) }
  } else if (command === 'sha256') {
    const hash = createHash('sha256')
    for await (const chunk of process.stdin) hash.update(chunk)
    process.stdout.write(hash.digest('hex'))
  } else if (command === 'metadata' || command === 'verify-restore') {
    // Validate without config.ts's diagnostic printing; Prisma error events stay off stdout.
    const { configSchema } = await import('../config-schema.js')
    const config = configSchema.parse(process.env)
    process.env.SKILLHUB_BACKUP_QUIET_DB = '1'
    const { db } = await import('../db.js')
    try {
      if (command === 'metadata') {
        const identity = await db.instanceIdentity.findUniqueOrThrow({ where: { id: 1 }, select: { instanceId: true, publicKey: true } })
        const migrations = await db.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1`
        const version = await db.$queryRaw<Array<{ server_version: string }>>`SHOW server_version`
        const release = JSON.parse(await readFile(new URL('../release-metadata.json', import.meta.url), 'utf8')) as { buildId: string }
        const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
        process.stdout.write(JSON.stringify({ ...identity, serverVersion: pkg.version, buildId: release.buildId,
          migration: migrations[0]?.migration_name, postgresMajor: Number(version[0].server_version.split('.')[0]),
          media: await treeStats(config.MEDIA_STORAGE_DIR), cards: await treeStats(config.SKILL_CARD_STORAGE_DIR) }))
      } else {
        const ring = decodeCredentialKekKeyring(config.CREDENTIAL_KEK_BASE64, config.CREDENTIAL_KEK_VERSION, config.CREDENTIAL_KEK_KEYRING_JSON)
        try {
          const counts = await verifyRestore(db, ring, UUID.parse(values['expect-instance']), config.MEDIA_STORAGE_DIR, config.SKILL_CARD_STORAGE_DIR, createStorageRegistry(config))
          process.stdout.write(JSON.stringify(counts) + '\n')
          if (counts.failed || counts.missing || counts.unavailable) process.exitCode = 1
        } finally { destroyCredentialKekKeyring(ring) }
      }
    } finally { await db.$disconnect() }
  } else throw new Error('无效命令')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runBackup(process.argv.slice(2)) }
  catch {
    process.stderr.write(process.argv[2] === 'open-recovery' ? RECOVERY_ERROR + '\n' : '备份操作失败；请检查输入、配置及数据库状态。\n')
    process.exitCode = 1
  }
}
