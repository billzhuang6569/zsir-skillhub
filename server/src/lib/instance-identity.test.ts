import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import type { InstanceIdentity } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptInstanceSecret } from './credential-crypto.js'

const mockDb = vi.hoisted(() => ({ instanceIdentity: { findUnique: vi.fn(), createMany: vi.fn() } }))
const mockConfig = vi.hoisted(() => ({
  CREDENTIAL_KEK_BASE64: undefined as string | undefined,
  CREDENTIAL_KEK_VERSION: 2,
  CREDENTIAL_KEK_KEYRING_JSON: {} as Record<string, string>,
}))
vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../config.js', () => ({ config: mockConfig }))

const kek = Buffer.alloc(32, 0x42)
const logger = { warn: vi.fn() }

function storedIdentity(key: Buffer = kek, version = 2): InstanceIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' })
  try {
    return {
      id: 1, instanceId: randomUUID(), publicKey: publicKey.export({ format: 'jwk' }).x!, createdAt: new Date(),
      ...encryptInstanceSecret(der, { name: 'instance-identity-key' }, key, version),
    }
  } finally {
    der.fill(0)
  }
}

describe('instance identity lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.resetModules()
    mockConfig.CREDENTIAL_KEK_BASE64 = kek.toString('base64')
    mockConfig.CREDENTIAL_KEK_VERSION = 2
    mockConfig.CREDENTIAL_KEK_KEYRING_JSON = {}
  })

  it('reuses the stored identity, including a historical KEK, without inserting', async (): Promise<void> => {
    const oldKek = Buffer.alloc(32, 0x43)
    const stored = storedIdentity(oldKek, 1)
    mockConfig.CREDENTIAL_KEK_KEYRING_JSON = { '1': oldKek.toString('base64') }
    mockDb.instanceIdentity.findUnique.mockResolvedValue(stored)
    const { loadInstanceIdentity, getInstanceIdentity } = await import('./instance-identity.js')
    expect(getInstanceIdentity()).toBeUndefined()
    const identity = await loadInstanceIdentity(logger)
    expect(identity).toMatchObject({ id: stored.instanceId, publicKey: stored.publicKey })
    expect(identity.privateKey.type).toBe('private')
    expect(identity.privateKey.asymmetricKeyType).toBe('ed25519')
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: stored.publicKey }, format: 'jwk' })
    const bytes = Buffer.from('lifecycle-test')
    expect(verify(null, bytes, publicKey, sign(null, bytes, identity.privateKey))).toBe(true)
    expect(await loadInstanceIdentity(logger)).toBe(identity)
    expect(getInstanceIdentity()).toBe(identity)
    expect(mockDb.instanceIdentity.findUnique).toHaveBeenCalledTimes(1)
    expect(mockDb.instanceIdentity.createMany).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('generates and persists one encrypted identity across concurrent loads', async (): Promise<void> => {
    let stored: InstanceIdentity | null = null
    mockDb.instanceIdentity.findUnique.mockImplementation(async (): Promise<InstanceIdentity | null> => stored)
    mockDb.instanceIdentity.createMany.mockImplementation(async ({ data }: { data: Omit<InstanceIdentity, 'createdAt'>[] }): Promise<{ count: number }> => {
      stored = { ...data[0], createdAt: new Date() }
      return { count: 1 }
    })
    const { loadInstanceIdentity } = await import('./instance-identity.js')
    const [first, second] = await Promise.all([loadInstanceIdentity(logger), loadInstanceIdentity(logger)])
    expect(second).toBe(first)
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(mockDb.instanceIdentity.createMany).toHaveBeenCalledTimes(1)
    expect(mockDb.instanceIdentity.findUnique).toHaveBeenCalledTimes(2)
    const args = mockDb.instanceIdentity.createMany.mock.calls[0][0]
    expect(args.skipDuplicates).toBe(true)
    expect(Object.keys(args.data[0]).sort()).toEqual([
      'id', 'instanceId', 'publicKey', 'ciphertext', 'iv', 'tag', 'wrappedDek', 'wrapIv', 'wrapTag', 'kekVersion', 'aadVersion',
    ].sort())
    const der = first.privateKey.export({ format: 'der', type: 'pkcs8' })
    expect(args.data[0].ciphertext).not.toEqual(der)
    der.fill(0)
    vi.resetModules()
    const restarted = await import('./instance-identity.js')
    expect(await restarted.loadInstanceIdentity(logger)).toMatchObject({ id: first.id, publicKey: first.publicKey })
    expect(mockDb.instanceIdentity.createMany).toHaveBeenCalledTimes(1)
  })

  it('retries a failed database load and publishes identity only after recovery', async (): Promise<void> => {
    const stored = storedIdentity()
    mockDb.instanceIdentity.findUnique.mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue(stored)
    const { loadInstanceIdentity, getInstanceIdentity } = await import('./instance-identity.js')
    await expect(loadInstanceIdentity(logger)).rejects.toThrow('database unavailable')
    expect(getInstanceIdentity()).toBeUndefined()
    const [first, second] = await Promise.all([loadInstanceIdentity(logger), loadInstanceIdentity(logger)])
    expect(first).toBe(second)
    expect(getInstanceIdentity()).toMatchObject({ id: stored.instanceId, publicKey: stored.publicKey })
    expect(mockDb.instanceIdentity.findUnique).toHaveBeenCalledTimes(2)
  })

  it('re-reads and uses the winning identity when another process inserts first', async (): Promise<void> => {
    const winner = storedIdentity()
    mockDb.instanceIdentity.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner)
    mockDb.instanceIdentity.createMany.mockResolvedValue({ count: 0 })
    const { loadInstanceIdentity } = await import('./instance-identity.js')
    expect(await loadInstanceIdentity(logger)).toMatchObject({ id: winner.instanceId, publicKey: winner.publicKey })
    const args = mockDb.instanceIdentity.createMany.mock.calls[0][0]
    expect(args.skipDuplicates).toBe(true)
    expect(args.data[0].instanceId).not.toBe(winner.instanceId)
    expect(mockDb.instanceIdentity.findUnique).toHaveBeenCalledTimes(2)
  })

  it('keeps a no-KEK identity in memory, warns once and never accesses the database', async (): Promise<void> => {
    mockConfig.CREDENTIAL_KEK_BASE64 = undefined
    const { loadInstanceIdentity } = await import('./instance-identity.js')
    const [first, second] = await Promise.all([loadInstanceIdentity(logger), loadInstanceIdentity(logger)])
    expect(second).toBe(first)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('address proofs are unstable'))
    expect(first.privateKey.asymmetricKeyType).toBe('ed25519')
    expect(mockDb.instanceIdentity.findUnique).not.toHaveBeenCalled()
    expect(mockDb.instanceIdentity.createMany).not.toHaveBeenCalled()
    vi.resetModules()
    const restarted = await import('./instance-identity.js')
    expect((await restarted.loadInstanceIdentity(logger)).id).not.toBe(first.id)
  })

  it.each(['wrong-kek', 'mismatched-public-key', 'missing-after-insert'] as const)(
    'fails closed for %s instead of replacing the identity', async (failure): Promise<void> => {
      const stored = storedIdentity()
      if (failure === 'wrong-kek') mockConfig.CREDENTIAL_KEK_BASE64 = Buffer.alloc(32, 0x44).toString('base64')
      if (failure === 'mismatched-public-key') stored.publicKey = storedIdentity().publicKey
      mockDb.instanceIdentity.findUnique.mockResolvedValue(failure === 'missing-after-insert' ? null : stored)
      mockDb.instanceIdentity.createMany.mockResolvedValue({ count: 0 })
      const { loadInstanceIdentity, getInstanceIdentity } = await import('./instance-identity.js')
      await expect(loadInstanceIdentity(logger)).rejects.toThrow()
      expect(getInstanceIdentity()).toBeUndefined()
      if (failure !== 'missing-after-insert') expect(mockDb.instanceIdentity.createMany).not.toHaveBeenCalled()
      expect(logger.warn).not.toHaveBeenCalled()
    },
  )
})
