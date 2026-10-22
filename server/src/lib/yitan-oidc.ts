import { timingSafeEqual } from 'node:crypto'
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose'
import { config } from '../config.js'

type YitanOidcVerifierConfig = {
  issuer: string
  jwksUrl: string
  audience: string
  allowedAuthorizedParties: readonly string[]
  clockToleranceSeconds: number
  maxTokenAgeSeconds: number
}

type YitanBackchannelLogoutVerifierConfig = {
  issuer: string
  jwksUrl: string
  audiences: readonly string[]
  clockToleranceSeconds: number
  maxTokenAgeSeconds: number
}

const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout'

export type YitanTokenPair = {
  accessToken: string
  idToken: string
  nonce: string
}

export type VerifiedYitanIdentity = {
  issuer: string
  subject: string
  authorizedParty: string
  email: string | null
  emailVerified: boolean
  displayName: string | null
  avatarUrl: string | null
  authTime: number | null
  issuedAt: number
}

export type VerifiedYitanBackchannelLogout = {
  issuer: string
  subject: string
  issuedAt: number
  tokenId: string
}

export class YitanOidcVerificationError extends Error {
  constructor() {
    super('Yitan OIDC token verification failed')
    this.name = 'YitanOidcVerificationError'
  }
}

function nonEmptyClaim(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null
}

function audienceContains(audience: JWTPayload['aud'], expected: string): boolean {
  return typeof audience === 'string'
    ? audience === expected
    : Array.isArray(audience) && audience.includes(expected)
}

function integerTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null
}

function nonceMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function httpsAvatar(value: unknown): string | null {
  const candidate = nonEmptyClaim(value, 2048)
  if (!candidate) return null
  try {
    return new URL(candidate).protocol === 'https:' ? candidate : null
  } catch {
    return null
  }
}

export function createYitanOidcVerifier(
  verifierConfig: YitanOidcVerifierConfig,
  keyResolver: JWTVerifyGetKey = createRemoteJWKSet(new URL(verifierConfig.jwksUrl), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60 * 1_000,
  })
): (tokens: YitanTokenPair) => Promise<VerifiedYitanIdentity> {
  const allowedAuthorizedParties = new Set(verifierConfig.allowedAuthorizedParties)

  return async (tokens: YitanTokenPair): Promise<VerifiedYitanIdentity> => {
    try {
      const accessResult = await jwtVerify(tokens.accessToken, keyResolver, {
        algorithms: ['RS256'],
        issuer: verifierConfig.issuer,
        audience: verifierConfig.audience,
        clockTolerance: verifierConfig.clockToleranceSeconds,
        maxTokenAge: verifierConfig.maxTokenAgeSeconds,
        requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat', 'azp'],
      })
      if (accessResult.protectedHeader.alg !== 'RS256' || !nonEmptyClaim(accessResult.protectedHeader.kid, 255)) {
        throw new YitanOidcVerificationError()
      }

      const accessSubject = nonEmptyClaim(accessResult.payload.sub, 255)
      const authorizedParty = nonEmptyClaim(accessResult.payload.azp, 255)
      if (!accessSubject || !authorizedParty || !allowedAuthorizedParties.has(authorizedParty)) {
        throw new YitanOidcVerificationError()
      }

      const idResult = await jwtVerify(tokens.idToken, keyResolver, {
        algorithms: ['RS256'],
        issuer: verifierConfig.issuer,
        audience: [...allowedAuthorizedParties],
        clockTolerance: verifierConfig.clockToleranceSeconds,
        maxTokenAge: verifierConfig.maxTokenAgeSeconds,
        requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat', 'nonce'],
      })
      if (idResult.protectedHeader.alg !== 'RS256' || !nonEmptyClaim(idResult.protectedHeader.kid, 255)) {
        throw new YitanOidcVerificationError()
      }

      const idSubject = nonEmptyClaim(idResult.payload.sub, 255)
      const accessIssuedAt = integerTimestamp(accessResult.payload.iat)
      const idIssuedAt = integerTimestamp(idResult.payload.iat)
      if (
        idSubject !== accessSubject
        || accessIssuedAt === null
        || idIssuedAt === null
        || !audienceContains(idResult.payload.aud, authorizedParty)
        || !nonceMatches(idResult.payload.nonce, tokens.nonce)
      ) {
        throw new YitanOidcVerificationError()
      }

      const email = nonEmptyClaim(idResult.payload.email, 254)?.toLowerCase() ?? null
      const displayName = nonEmptyClaim(idResult.payload.name, 100)
        ?? nonEmptyClaim(idResult.payload.preferred_username, 100)
      const authTime = integerTimestamp(idResult.payload.auth_time)

      return {
        issuer: verifierConfig.issuer,
        subject: accessSubject,
        authorizedParty,
        email,
        emailVerified: idResult.payload.email_verified === true,
        displayName,
        avatarUrl: httpsAvatar(idResult.payload.picture),
        authTime,
        issuedAt: Math.min(accessIssuedAt, idIssuedAt),
      }
    } catch (error: unknown) {
      if (error instanceof YitanOidcVerificationError) throw error
      throw new YitanOidcVerificationError()
    }
  }
}

export function createYitanBackchannelLogoutVerifier(
  verifierConfig: YitanBackchannelLogoutVerifierConfig,
  keyResolver: JWTVerifyGetKey = createRemoteJWKSet(new URL(verifierConfig.jwksUrl), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60 * 1_000,
  })
): (logoutToken: string) => Promise<VerifiedYitanBackchannelLogout> {
  return async (logoutToken: string): Promise<VerifiedYitanBackchannelLogout> => {
    try {
      const result = await jwtVerify(logoutToken, keyResolver, {
        algorithms: ['RS256'],
        issuer: verifierConfig.issuer,
        audience: [...verifierConfig.audiences],
        clockTolerance: verifierConfig.clockToleranceSeconds,
        maxTokenAge: verifierConfig.maxTokenAgeSeconds,
        requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat', 'jti', 'events'],
      })
      if (
        result.protectedHeader.alg !== 'RS256'
        || result.protectedHeader.typ !== 'logout+jwt'
        || !nonEmptyClaim(result.protectedHeader.kid, 255)
      ) {
        throw new YitanOidcVerificationError()
      }

      const subject = nonEmptyClaim(result.payload.sub, 255)
      const tokenId = nonEmptyClaim(result.payload.jti, 512)
      const issuedAt = integerTimestamp(result.payload.iat)
      const events = result.payload.events
      const event = events && typeof events === 'object' && !Array.isArray(events)
        ? (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT]
        : undefined
      if (
        !subject
        || !tokenId
        || issuedAt === null
        || !event
        || typeof event !== 'object'
        || Array.isArray(event)
        || Object.hasOwn(result.payload, 'nonce')
      ) {
        throw new YitanOidcVerificationError()
      }

      return {
        issuer: verifierConfig.issuer,
        subject,
        issuedAt,
        tokenId,
      }
    } catch (error: unknown) {
      if (error instanceof YitanOidcVerificationError) throw error
      throw new YitanOidcVerificationError()
    }
  }
}

let verifyConfiguredYitanTokenPair:
  | ((tokens: YitanTokenPair) => Promise<VerifiedYitanIdentity>)
  | undefined

export async function verifyYitanTokenPair(
  tokens: YitanTokenPair
): Promise<VerifiedYitanIdentity> {
  verifyConfiguredYitanTokenPair ??= createYitanOidcVerifier({
    issuer: config.YITAN_OIDC_ISSUER,
    jwksUrl: config.YITAN_OIDC_JWKS_URL,
    audience: config.YITAN_OIDC_AUDIENCE,
    allowedAuthorizedParties: config.YITAN_OIDC_ALLOWED_AZP,
    clockToleranceSeconds: config.YITAN_OIDC_CLOCK_TOLERANCE_SECONDS,
    maxTokenAgeSeconds: config.YITAN_OIDC_MAX_TOKEN_AGE_SECONDS,
  })
  return verifyConfiguredYitanTokenPair(tokens)
}

let verifyConfiguredYitanBackchannelLogout:
  | ((logoutToken: string) => Promise<VerifiedYitanBackchannelLogout>)
  | undefined

export async function verifyYitanBackchannelLogout(
  logoutToken: string
): Promise<VerifiedYitanBackchannelLogout> {
  verifyConfiguredYitanBackchannelLogout ??= createYitanBackchannelLogoutVerifier({
    issuer: config.YITAN_OIDC_ISSUER,
    jwksUrl: config.YITAN_OIDC_JWKS_URL,
    audiences: config.YITAN_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE,
    clockToleranceSeconds: config.YITAN_OIDC_CLOCK_TOLERANCE_SECONDS,
    maxTokenAgeSeconds: config.YITAN_OIDC_LOGOUT_MAX_TOKEN_AGE_SECONDS,
  })
  return verifyConfiguredYitanBackchannelLogout(logoutToken)
}

let verifyConfiguredYitanTestBackchannelLogout:
  | ((logoutToken: string) => Promise<VerifiedYitanBackchannelLogout>)
  | undefined

export async function verifyYitanTestBackchannelLogout(
  logoutToken: string
): Promise<VerifiedYitanBackchannelLogout> {
  verifyConfiguredYitanTestBackchannelLogout ??= createYitanBackchannelLogoutVerifier({
    issuer: config.YITAN_TEST_OIDC_ISSUER,
    jwksUrl: config.YITAN_TEST_OIDC_JWKS_URL,
    audiences: config.YITAN_TEST_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE,
    clockToleranceSeconds: config.YITAN_OIDC_CLOCK_TOLERANCE_SECONDS,
    maxTokenAgeSeconds: config.YITAN_OIDC_LOGOUT_MAX_TOKEN_AGE_SECONDS,
  })
  return verifyConfiguredYitanTestBackchannelLogout(logoutToken)
}
