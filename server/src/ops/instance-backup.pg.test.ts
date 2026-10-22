import { PrismaClient } from '@prisma/client'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encryptCredentialValue, encryptInstanceSecret } from '../lib/credential-crypto.js'
import { verifyRestore } from './instance-backup.js'

describe.skipIf(!process.env.SKILLHUB_PG_TEST_URL)('PostgreSQL backup verification', () => {
  it('reads persisted identity, settings and historical team DEKs, and rejects the wrong KEK', async () => {
    const db = new PrismaClient({ datasources: { db: { url: process.env.SKILLHUB_PG_TEST_URL } }, log: [] })
    const root = await mkdtemp(join(tmpdir(), 'backup-pg-'))
    const rollback = new Error('rollback test fixture')
    try {
      await expect(db.$transaction(async transaction => {
        // All fixture changes, including singleton replacement, roll back together.
        await transaction.instanceIdentity.deleteMany()
        await transaction.serverSetting.deleteMany()
        await transaction.teamCredentialVersion.deleteMany()
        await transaction.mediaAsset.deleteMany()
        await transaction.skillCard.updateMany({ data: { storageProvider: 'test-external' } })
        const kek = randomBytes(32)
        const pair = generateKeyPairSync('ed25519')
        const instanceId = randomUUID()
        await transaction.instanceIdentity.create({ data: {
          id: 1, instanceId, publicKey: pair.publicKey.export({ format: 'jwk' }).x!,
          ...encryptInstanceSecret(pair.privateKey.export({ format: 'der', type: 'pkcs8' }), { name: 'instance-identity-key' }, kek, 1),
        } })
        const user = await transaction.user.create({ data: { email: `${randomUUID()}@test.invalid`, displayName: 'Backup Test' } })
        const team = await transaction.team.create({ data: { name: 'Backup Test', ownerId: user.id } })
        const credential = await transaction.teamCredential.create({ data: { teamId: team.id, envKey: 'API_KEY', createdById: user.id, currentRevision: 2 } })
        for (const revision of [1, 2]) {
          await transaction.teamCredentialVersion.create({ data: { credentialId: credential.id, revision, createdById: user.id,
            ...encryptCredentialValue('test-secret', { credentialId: credential.id, teamId: team.id, envKey: 'API_KEY', revision }, kek, 1) } })
        }
        const secret = encryptInstanceSecret(Buffer.from('test-setting'), { name: 'server-setting:ai' }, kek, 1)
        await transaction.serverSetting.create({ data: { key: 'ai', value: {}, secretCiphertext: secret.ciphertext,
          secretIv: secret.iv, secretTag: secret.tag, secretWrappedDek: secret.wrappedDek, secretWrapIv: secret.wrapIv,
          secretWrapTag: secret.wrapTag, secretKekVersion: 1, secretAadVersion: 1 } })
        await transaction.mediaAsset.create({ data: { id: randomUUID(), ownerRef: user.id, purpose: 'feedback', visibility: 'private',
          status: 'deleted', storageProvider: 'filesystem', storageKey: 'deleted.png' } })
        const result = await verifyRestore(transaction, new Map([[1, kek]]), instanceId, root, root)
        expect(result).toMatchObject({ identity: 1, settings: 1, credentials: 2, failed: 0, missing: 0 })
        expect((await verifyRestore(transaction, new Map([[1, randomBytes(32)]]), instanceId, root, root)).failed).toBe(4)
        throw rollback
      }, { timeout: 30_000 })).rejects.toBe(rollback)
    } finally { await db.$disconnect(); await rm(root, { recursive: true, force: true }) }
  })
})
