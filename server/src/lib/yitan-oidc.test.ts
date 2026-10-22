import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTPayload,
} from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

vi.mock('../config.js', () => ({
  config: {
    YITAN_OIDC_ISSUER: 'https://unused.example.test/realms/yitan',
    YITAN_OIDC_JWKS_URL: 'https://unused.example.test/jwks',
    YITAN_OIDC_AUDIENCE: 'skillhub-api',
    YITAN_OIDC_ALLOWED_AZP: ['skillhub-desktop', 'skillhub-web'],
    YITAN_OIDC_CLOCK_TOLERANCE_SECONDS: 0,
    YITAN_OIDC_MAX_TOKEN_AGE_SECONDS: 600,
    YITAN_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE: ['skillhub-desktop', 'skillhub-web'],
    YITAN_OIDC_LOGOUT_MAX_TOKEN_AGE_SECONDS: 120,
  },
}))

import {
  createYitanBackchannelLogoutVerifier,
  createYitanOidcVerifier,
  YitanOidcVerificationError,
} from './yitan-oidc.js'

const ISSUER = 'https://account.example.test/realms/yitan'
const AUDIENCE = 'skillhub-api'
const CLIENT_ID = 'skillhub-desktop'
const KID = 'test-rsa-key'

let privateKey: CryptoKey
let verify: ReturnType<typeof createYitanOidcVerifier>
let verifyLogout: ReturnType<typeof createYitanBackchannelLogoutVerifier>

beforeAll(async () => {
  const keyPair = await generateKeyPair('RS256')
  privateKey = keyPair.privateKey
  const publicJwk = await exportJWK(keyPair.publicKey)
  const localKeys = createLocalJWKSet({ keys: [{ ...publicJwk, alg: 'RS256', use: 'sig', kid: KID }] })
  verify = createYitanOidcVerifier({
    issuer: ISSUER,
    jwksUrl: 'https://unused.example.test/jwks',
    audience: AUDIENCE,
    allowedAuthorizedParties: [CLIENT_ID, 'skillhub-web'],
    clockToleranceSeconds: 0,
    maxTokenAgeSeconds: 600,
  }, localKeys)
  verifyLogout = createYitanBackchannelLogoutVerifier({
    issuer: ISSUER,
    jwksUrl: 'https://unused.example.test/jwks',
    audiences: [CLIENT_ID, 'skillhub-web'],
    clockToleranceSeconds: 0,
    maxTokenAgeSeconds: 120,
  }, localKeys)
})

async function token(payload: JWTPayload, kid: string | undefined = KID): Promise<string> {
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', ...(kid ? { kid } : {}) })
  return jwt.sign(privateKey)
}

async function pair(input: {
  access?: Partial<JWTPayload>
  id?: Partial<JWTPayload>
  nonce?: string
  accessKid?: string | undefined
  idKid?: string | undefined
} = {}): Promise<{ accessToken: string; idToken: string; nonce: string }> {
  const now = Math.floor(Date.now() / 1_000)
  const nonce = input.nonce ?? 'nonce-that-is-long-enough'
  return {
    accessToken: await token({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: 'central-user-001',
      azp: CLIENT_ID,
      iat: now,
      exp: now + 300,
      ...input.access,
    }, input.accessKid === undefined ? KID : input.accessKid),
    idToken: await token({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'central-user-001',
      nonce,
      email: 'USER@Example.COM',
      email_verified: true,
      name: '一探用户',
      picture: 'https://cdn.example.com/avatar.png',
      auth_time: now - 30,
      iat: now,
      exp: now + 300,
      ...input.id,
    }, input.idKid === undefined ? KID : input.idKid),
    nonce,
  }
}

describe('Yitan OIDC token verification', () => {
  it('verifies the signed token pair and returns only normalized identity claims', async () => {
    await expect(verify(await pair())).resolves.toEqual({
      issuer: ISSUER,
      subject: 'central-user-001',
      authorizedParty: CLIENT_ID,
      email: 'user@example.com',
      emailVerified: true,
      displayName: '一探用户',
      avatarUrl: 'https://cdn.example.com/avatar.png',
      authTime: expect.any(Number),
      issuedAt: expect.any(Number),
    })
  })

  it.each([
    ['wrong issuer', { access: { iss: 'https://evil.example.test' } }],
    ['wrong API audience', { access: { aud: 'other-api' } }],
    ['unapproved authorized party', { access: { azp: 'unapproved-client' } }],
    ['different subjects', { id: { sub: 'central-user-002' } }],
    ['ID token for another client', { id: { aud: 'unapproved-client' } }],
    ['wrong nonce', { id: { nonce: 'different-nonce-value' } }],
    ['missing subject', { access: { sub: undefined } }],
    ['future not-before', { access: { nbf: Math.floor(Date.now() / 1_000) + 120 } }],
    ['expired access token', { access: { exp: Math.floor(Date.now() / 1_000) - 10 } }],
    ['stale issued-at', {
      access: {
        iat: Math.floor(Date.now() / 1_000) - 700,
        exp: Math.floor(Date.now() / 1_000) + 60,
      },
    }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(verify(await pair(overrides))).rejects.toBeInstanceOf(YitanOidcVerificationError)
  })

  it('requires an explicit signing key id on both JWTs', async () => {
    const now = Math.floor(Date.now() / 1_000)
    const nonce = 'nonce-that-is-long-enough'
    const accessToken = await new SignJWT({
      iss: ISSUER, aud: AUDIENCE, sub: 'central-user-001', azp: CLIENT_ID, iat: now, exp: now + 300,
    }).setProtectedHeader({ alg: 'RS256' }).sign(privateKey)
    const idToken = await token({
      iss: ISSUER, aud: CLIENT_ID, sub: 'central-user-001', nonce, iat: now, exp: now + 300,
    })

    await expect(verify({ accessToken, idToken, nonce })).rejects.toBeInstanceOf(YitanOidcVerificationError)
  })
})

describe('Yitan back-channel logout verification', () => {
  async function logoutToken(
    overrides: Partial<JWTPayload> = {},
    header: { kid?: string; typ?: string } = { kid: KID, typ: 'logout+jwt' }
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1_000)
    return new SignJWT({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'central-user-001',
      iat: now,
      exp: now + 60,
      jti: 'logout-event-001',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      ...overrides,
    }).setProtectedHeader({
      alg: 'RS256',
      ...(header.kid ? { kid: header.kid } : {}),
      ...(header.typ ? { typ: header.typ } : {}),
    }).sign(privateKey)
  }

  it('accepts a short-lived, explicitly typed logout token', async () => {
    const now = Math.floor(Date.now() / 1_000)
    await expect(verifyLogout(await logoutToken({ iat: now }))).resolves.toEqual({
      issuer: ISSUER,
      subject: 'central-user-001',
      issuedAt: now,
      tokenId: 'logout-event-001',
    })
  })

  it.each([
    [[CLIENT_ID, 'skillhub-web']],
    [['skillhub-web', CLIENT_ID]],
  ])('accepts an audience array in either order: %j', async (audience) => {
    await expect(verifyLogout(await logoutToken({ aud: audience }))).resolves.toMatchObject({
      issuer: ISSUER,
      subject: 'central-user-001',
    })
  })

  it.each([
    ['wrong issuer', { iss: 'https://evil.example.test/realms/yitan' }],
    ['wrong audience', { aud: 'unapproved-client' }],
    ['missing subject', { sub: undefined }],
    ['missing token id', { jti: undefined }],
    ['missing events', { events: undefined }],
    ['wrong event type', { events: { 'http://schemas.openid.net/event/backchannel-logout': [] } }],
    ['prohibited nonce', { nonce: 'must-not-be-present' }],
    ['expired token', { exp: Math.floor(Date.now() / 1_000) - 1 }],
    ['stale issued-at', {
      iat: Math.floor(Date.now() / 1_000) - 180,
      exp: Math.floor(Date.now() / 1_000) + 30,
    }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(verifyLogout(await logoutToken(overrides))).rejects.toBeInstanceOf(YitanOidcVerificationError)
  })

  it('rejects missing or non-logout JWT headers', async () => {
    await expect(verifyLogout(await logoutToken({}, { typ: 'logout+jwt' })))
      .rejects.toBeInstanceOf(YitanOidcVerificationError)
    await expect(verifyLogout(await logoutToken({}, { kid: KID, typ: 'JWT' })))
      .rejects.toBeInstanceOf(YitanOidcVerificationError)
    await expect(verifyLogout(await logoutToken({}, { kid: KID })))
      .rejects.toBeInstanceOf(YitanOidcVerificationError)
  })
})
