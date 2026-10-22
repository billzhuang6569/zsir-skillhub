import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { config } from '../config.js'
import { db } from '../db.js'
import {
  decodeCredentialKekKeyring,
  decryptInstanceSecret,
  destroyCredentialKekKeyring,
  encryptInstanceSecret,
} from './credential-crypto.js'

type InstanceIdentity = { id: string; publicKey: string; privateKey: KeyObject }
const scope = { name: 'instance-identity-key' }
let identity: InstanceIdentity | undefined
let loading: Promise<InstanceIdentity> | undefined

function publicKeyFromPrivateKey(privateKey: KeyObject): string {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Instance identity key must be Ed25519')
  const { x } = createPublicKey(privateKey).export({ format: 'jwk' })
  if (!x || Buffer.from(x, 'base64url').length !== 32) throw new Error('Invalid instance public key')
  return x
}

function generateIdentity(): InstanceIdentity {
  const { privateKey } = generateKeyPairSync('ed25519')
  return { id: randomUUID(), publicKey: publicKeyFromPrivateKey(privateKey), privateKey }
}

async function loadIdentity(logger: Pick<FastifyBaseLogger, 'warn'>): Promise<InstanceIdentity> {
  if (!config.CREDENTIAL_KEK_BASE64) {
    logger.warn('Instance identity is in memory only; address proofs are unstable across restarts until CREDENTIAL_KEK_BASE64 is configured')
    return generateIdentity()
  }

  const keyring = decodeCredentialKekKeyring(
    config.CREDENTIAL_KEK_BASE64,
    config.CREDENTIAL_KEK_VERSION,
    config.CREDENTIAL_KEK_KEYRING_JSON,
  )
  try {
    let stored = await db.instanceIdentity.findUnique({ where: { id: 1 } })
    if (!stored) {
      const generated = generateIdentity()
      const der = generated.privateKey.export({ format: 'der', type: 'pkcs8' })
      try {
        const kek = keyring.get(config.CREDENTIAL_KEK_VERSION)
        if (!kek) throw new Error('Instance identity KEK is unavailable')
        // PostgreSQL ON CONFLICT DO NOTHING: concurrent starts must use the winning row.
        await db.instanceIdentity.createMany({
          data: [{
            id: 1,
            instanceId: generated.id,
            publicKey: generated.publicKey,
            ...encryptInstanceSecret(der, scope, kek, config.CREDENTIAL_KEK_VERSION),
          }],
          skipDuplicates: true,
        })
      } finally {
        der.fill(0)
      }
      stored = await db.instanceIdentity.findUnique({ where: { id: 1 } })
    }
    if (!stored) throw new Error('Instance identity is missing after initialization')
    const der = decryptInstanceSecret(stored, scope, keyring)
    try {
      const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
      if (publicKeyFromPrivateKey(privateKey) !== stored.publicKey) {
        throw new Error('Instance identity public key does not match its private key')
      }
      return { id: stored.instanceId, publicKey: stored.publicKey, privateKey }
    } finally {
      der.fill(0)
    }
  } finally {
    destroyCredentialKekKeyring(keyring)
  }
}

export async function loadInstanceIdentity(logger: Pick<FastifyBaseLogger, 'warn'>): Promise<InstanceIdentity> {
  loading ??= loadIdentity(logger).catch((error: unknown) => {
    loading = undefined
    throw error
  })
  identity = await loading
  return identity
}

export function getInstanceIdentity(): InstanceIdentity | undefined {
  return identity
}
