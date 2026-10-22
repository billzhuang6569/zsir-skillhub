import Fastify, { type FastifyInstance } from 'fastify'
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>()
  return { ...crypto, sign: vi.fn(crypto.sign) }
})
vi.mock('../db.js', () => ({ db: {} }))
vi.mock('../config.js', () => ({ config: {
  PUBLIC_BASE_URL: 'https://skills.example.test/instance',
  INSTANCE_ADDITIONAL_BASE_URLS: ['https://new.example.test/SkillHub', 'http://127.0.0.1:3001'],
  SKILLHUB_PROFILE: 'selfhost',
  TOPIC_IMAGE_HOSTS: ['picem-media.whatonearth.work'],
} }))
vi.mock('../lib/instance-identity.js', () => ({ getInstanceIdentity: vi.fn() }))

import { getInstanceIdentity } from '../lib/instance-identity.js'
import { publicServiceInfo } from '../server-info.js'
import { instanceRoutes } from './instance.js'

describe('instance address proof', () => {
  let app: FastifyInstance
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const identity = { id: randomUUID(), publicKey: publicKey.export({ format: 'jwk' }).x!, privateKey }
  const nonce = randomBytes(32).toString('base64url')
  const url = '/api/instance/address-proof'

  beforeEach(async (): Promise<void> => {
    vi.clearAllMocks()
    vi.mocked(getInstanceIdentity).mockReturnValue(identity)
    app = Fastify()
    await app.register(instanceRoutes, { prefix: '/api/instance' })
  })
  afterEach(async (): Promise<void> => { await app.close() })

  it('signs exact ordered payload bytes verifiable with the published raw public key', async (): Promise<void> => {
    const response = await app.inject({ method: 'POST', url, payload: { nonce } })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const proof = response.json<{ payload: string; signature: string }>()
    expect(Object.keys(proof)).toEqual(['payload', 'signature'])
    const bytes = Buffer.from(proof.payload, 'base64url')
    const payload = { purpose: 'skillhub-instance-address-proof-v1', instanceId: identity.id, origin: 'https://skills.example.test/instance', nonce }
    expect(bytes.toString('utf8')).toBe(JSON.stringify(payload))
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(payload)
    const published = publicServiceInfo('ready').instance!
    expect(published.id).toBe(identity.id)
    expect(Buffer.from(published.publicKey, 'base64url')).toHaveLength(32)
    const verifier = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: published.publicKey } })
    const signature = Buffer.from(proof.signature, 'base64url')
    expect(signature).toHaveLength(64)
    expect(verify(null, bytes, verifier, signature)).toBe(true)
    expect(verify(null, Buffer.from(JSON.stringify({ ...payload, origin: 'https://evil.example' })), verifier, signature)).toBe(false)
  })

  it.each([
    [undefined, 'https://skills.example.test/instance'],
    ['https://SKILLS.example.test:443/instance///', 'https://skills.example.test/instance'],
    ['https://NEW.example.test:443/SkillHub/', 'https://new.example.test/SkillHub'],
    ['http://127.0.0.1:3001/', 'http://127.0.0.1:3001'],
  ])('signs only the configured URL for %s, ignoring spoofed headers', async (expectedBaseUrl, origin): Promise<void> => {
    const response = await app.inject({
      method: 'POST', url, payload: { nonce, expectedBaseUrl, origin: 'https://evil.example' },
      headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', forwarded: 'host=evil.example;proto=http' },
    })
    expect(response.statusCode).toBe(200)
    const proof = response.json<{ payload: string; signature: string }>()
    const bytes = Buffer.from(proof.payload, 'base64url')
    expect(JSON.parse(bytes.toString('utf8')).origin).toBe(origin)
    expect(verify(null, bytes, publicKey, Buffer.from(proof.signature, 'base64url'))).toBe(true)
  })

  it.each([
    'https://evil.example', 'https://skills.example.test/other', 'https://new.example.test/skillhub',
    'http://skills.example.test/instance', 'https://user@skills.example.test/instance',
    'https://skills.example.test/instance?', 'https://skills.example.test/instance#', 'not-a-url', '',
  ])('rejects unconfigured or unsafe expected URL %s without signing', async (expectedBaseUrl): Promise<void> => {
    const response = await app.inject({ method: 'POST', url, payload: { nonce, expectedBaseUrl } })
    expect(response.statusCode).toBe(400)
    expect(response.json()).not.toHaveProperty('signature')
    expect(sign).not.toHaveBeenCalled()
  })

  it.each([
    '', 'A'.repeat(42), 'A'.repeat(44), '+'.repeat(43), '/'.repeat(43),
    `${'A'.repeat(42)}=`, `${'A'.repeat(42)}B`, `${'A'.repeat(42)} `,
    '中'.repeat(43), 123, null, undefined,
  ])('rejects malformed nonce %s without signing', async (invalidNonce): Promise<void> => {
    const response = await app.inject({ method: 'POST', url, payload: { nonce: invalidNonce } })
    expect(response.statusCode).toBe(400)
    expect(sign).not.toHaveBeenCalled()
  })

  it('returns 503 without signing if identity has not loaded', async (): Promise<void> => {
    vi.mocked(getInstanceIdentity).mockReturnValue(undefined)
    expect((await app.inject({ method: 'POST', url, payload: { nonce } })).statusCode).toBe(503)
    expect(sign).not.toHaveBeenCalled()
  })

  it('limits all proof attempts by IP, including invalid input', async (): Promise<void> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await app.inject({ method: 'POST', url, payload: {}, remoteAddress: '192.0.2.1' })).statusCode).toBe(400)
    }
    const blocked = await app.inject({ method: 'POST', url, payload: { nonce }, remoteAddress: '192.0.2.1' })
    expect(blocked.statusCode).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    expect(sign).not.toHaveBeenCalled()
    expect((await app.inject({ method: 'POST', url, payload: { nonce }, remoteAddress: '192.0.2.2' })).statusCode).toBe(200)
  })
})
