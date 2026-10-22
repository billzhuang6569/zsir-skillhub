import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { BLOCK_SIZE, decryptPart, encryptPart, openRecovery, sealRecovery, takeSecret, verifyRestore } from './instance-backup.js'
import { encryptCredentialValue, encryptInstanceSecret } from '../lib/credential-crypto.js'

const id = randomUUID()
const key = randomBytes(32)
const password = 'long-test-passphrase'
async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const bytes of source) chunks.push(Buffer.from(bytes))
  return Buffer.concat(chunks)
}
const encrypt = (input: Buffer): Promise<Buffer> => collect(encryptPart(Readable.from([input]), key, 'db', id))
const decrypt = (input: Buffer, part = 'db', secret = key, backupId = id): Promise<Buffer> =>
  collect(decryptPart(Readable.from([input]), secret, part, backupId))

describe('SKB1 authenticated streaming', () => {
  it.each([0, BLOCK_SIZE, BLOCK_SIZE + 17, BLOCK_SIZE * 4])('round trips %i bytes', async size => {
    const input = randomBytes(size)
    const output = await decrypt(await encrypt(input))
    // toEqual compares Buffers element by element (about 1 s per MiB); compare bytes directly.
    expect(output.length).toBe(size)
    expect(output.equals(input)).toBe(true)
  })
  it('handles fragmented ciphertext and slow consumers on a large bounded stream', async () => {
    const expected = createHash('sha256')
    async function* input(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 64; i++) { const bytes = Buffer.alloc(BLOCK_SIZE, i); expected.update(bytes); yield bytes }
    }
    const actual = createHash('sha256')
    await pipeline(Readable.from(decryptPart(encryptPart(input(), key, 'db', id), key, 'db', id)),
      new Writable({ highWaterMark: 1024, write(chunk: Buffer, _encoding, done): void {
        setTimeout(() => { actual.update(chunk); done() }, 1)
      } }))
    expect(actual.digest('hex')).toBe(expected.digest('hex'))
    const encrypted = await encrypt(Buffer.from('fragmented'))
    async function* fragments(): AsyncGenerator<Buffer> { for (const byte of encrypted) yield Buffer.from([byte]) }
    expect((await collect(decryptPart(fragments(), key, 'db', id))).toString()).toBe('fragmented')
  })
  it('rejects corruption, truncation, reordered blocks, trailing bytes and substitutions', async () => {
    const encrypted = await encrypt(randomBytes(BLOCK_SIZE * 2))
    const tampered = Buffer.from(encrypted); tampered[20] ^= 1
    const frameSize = 5 + BLOCK_SIZE + 16
    const reordered = Buffer.concat([encrypted.subarray(0, 5), encrypted.subarray(5 + frameSize, 5 + frameSize * 2), encrypted.subarray(5, 5 + frameSize), encrypted.subarray(5 + frameSize * 2)])
    for (const invalid of [tampered, encrypted.subarray(0, -1), encrypted.subarray(0, -21), reordered, Buffer.concat([encrypted, Buffer.from([0])])]) {
      await expect(decrypt(invalid)).rejects.toThrow()
    }
    await expect(decrypt(encrypted, 'media')).rejects.toThrow()
    await expect(decrypt(encrypted, 'db', randomBytes(32))).rejects.toThrow()
    await expect(decrypt(encrypted, 'db', key, randomUUID())).rejects.toThrow()
  })
})

describe('recovery envelope', () => {
  const body = { manifestSha256: 'a'.repeat(64), dataKey: key.toString('base64'), env: 'SECRET=do-not-print\n' }
  it('round trips and authenticates the complete header', () => {
    const encrypted = sealRecovery(body, password, id)
    expect(openRecovery(encrypted, password)).toEqual({ ...body, backupId: id })
    expect(() => openRecovery(encrypted, 'wrong-password')).toThrow('恢复口令错误或恢复文件已损坏')
    const length = encrypted.readUInt32BE()
    const header = JSON.parse(encrypted.subarray(4, 4 + length).toString()) as Record<string, unknown>
    for (const override of [{ N: 1073741824 }, { r: 1024 }, { p: 1024 }, { backupId: randomUUID() }]) {
      const modified = Buffer.from(JSON.stringify({ ...header, ...override }))
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(modified.length)
      expect(() => openRecovery(Buffer.concat([prefix, modified, encrypted.subarray(4 + length)]), password)).toThrow('恢复口令错误或恢复文件已损坏')
    }
  })
  it('consumes secret environment variables immediately', () => {
    process.env.SKILLHUB_BACKUP_DATA_KEY = body.dataKey
    expect(takeSecret('SKILLHUB_BACKUP_DATA_KEY')).toBe(body.dataKey)
    expect(process.env.SKILLHUB_BACKUP_DATA_KEY).toBeUndefined()
    process.env.SKILLHUB_BACKUP_PASSPHRASE = password
    expect(takeSecret('SKILLHUB_BACKUP_PASSPHRASE')).toBe(password)
    expect(process.env.SKILLHUB_BACKUP_PASSPHRASE).toBeUndefined()
  })
  it('CLI failure is fixed and contains no input, key, password or database URL', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/ops/instance-backup.ts', 'open-recovery', '--field', 'env'], {
      input: 'SECRET=do-not-print', encoding: 'utf8',
      env: { ...process.env, SKILLHUB_BACKUP_PASSPHRASE: password, DATABASE_URL: 'postgresql://private:private@invalid/db' },
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('恢复口令错误或恢复文件已损坏\n')
  })
})

it('read-only verification checks identity, encrypted settings, all credential versions and missing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-verify-'))
  const kek = randomBytes(32)
  const pair = generateKeyPairSync('ed25519')
  const identity = { instanceId: id, publicKey: pair.publicKey.export({ format: 'jwk' }).x,
    ...encryptInstanceSecret(pair.privateKey.export({ format: 'der', type: 'pkcs8' }), { name: 'instance-identity-key' }, kek, 1) }
  const secret = encryptInstanceSecret(Buffer.from('secret'), { name: 'server-setting:ai' }, kek, 1)
  const row = { key: 'ai', secretCiphertext: secret.ciphertext, secretIv: secret.iv, secretTag: secret.tag,
    secretWrappedDek: secret.wrappedDek, secretWrapIv: secret.wrapIv, secretWrapTag: secret.wrapTag,
    secretKekVersion: 1, secretAadVersion: 1 }
  const scope = { credentialId: randomUUID(), teamId: randomUUID(), envKey: 'API_KEY', revision: 2 }
  const db = {
    instanceIdentity: { findUnique: vi.fn().mockResolvedValue(identity) },
    serverSetting: { findMany: vi.fn().mockResolvedValue([row]) },
    teamCredentialVersion: { findMany: vi.fn().mockResolvedValue([{ ...scope, ...encryptCredentialValue('private-value', scope, kek, 1), credential: scope }]) },
    mediaAsset: { findMany: vi.fn().mockResolvedValue([{ storageKey: 'image.png', storageProvider: 'filesystem', storageNamespace: null }]) },
    skillCard: { findMany: vi.fn().mockResolvedValue([{ storageKey: 'card.zip', storageProvider: 'filesystem', storageNamespace: null }]) },
  } as unknown as Parameters<typeof verifyRestore>[0]
  try {
    await writeFile(join(root, 'image.png'), 'image'); await writeFile(join(root, 'card.zip'), 'zip')
    expect(await verifyRestore(db, new Map([[1, kek]]), id, root, root)).toEqual({ identity: 1, settings: 1, credentials: 1, media: 1, cards: 1, missing: 0, failed: 0, unavailable: 0 })
    expect((await verifyRestore(db, new Map([[1, randomBytes(32)]]), id, root, root)).failed).toBe(3)
    expect((await verifyRestore(db, new Map([[1, kek]]), randomUUID(), root, root)).failed).toBe(1)
    await rm(join(root, 'image.png'))
    expect((await verifyRestore(db, new Map([[1, kek]]), id, root, root)).missing).toBe(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('restore verifies reachable S3 namespaces with HEAD and counts unreachable namespaces separately', async () => {
  const location = { storageProvider: 's3', storageNamespace: 's3:configured' }
  const db = {
    instanceIdentity: { findUnique: vi.fn().mockResolvedValue(null) },
    serverSetting: { findMany: vi.fn().mockResolvedValue([]) },
    teamCredentialVersion: { findMany: vi.fn().mockResolvedValue([]) },
    mediaAsset: { findMany: vi.fn().mockResolvedValue([{ ...location, storageKey: 'image.png' }]) },
    skillCard: { findMany: vi.fn().mockResolvedValue([{ ...location, storageNamespace: 's3:old', storageKey: 'card.zip' }]) },
  } as unknown as Parameters<typeof verifyRestore>[0]
  const head = vi.fn(async () => ({ size: 8 }))
  const registry = {
    available: (row: { storageNamespace: string | null }) => row.storageNamespace === location.storageNamespace,
    read: vi.fn(() => ({ provider: 's3' as const, head, get: vi.fn(), put: vi.fn(), delete: vi.fn() })),
    target: vi.fn(),
  }
  const counts = await verifyRestore(db, new Map(), id, '/unused', '/unused', registry)
  expect(counts).toMatchObject({ media: 1, cards: 0, unavailable: 1, missing: 0 })
  expect(head).toHaveBeenCalledExactlyOnceWith('image.png')
})
