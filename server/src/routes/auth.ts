import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { config } from '../config.js'
import { getSettingSecret } from '../lib/server-settings.js'
import { registrationView } from '../lib/instance-overview.js'
import { db } from '../db.js'
import { authorizeMediaUrl, isRetiredMedia, publicImageUrl } from '../lib/media.js'
import { AttemptLimiter } from '../lib/attempt-limiter.js'
import { hashPassword, verifyPassword } from '../lib/password.js'
import { lockExternalIdentityMutation, lockUserMutation } from '../lib/mutation-lock.js'
import {
  verifyYitanBackchannelLogout,
  verifyYitanTestBackchannelLogout,
  verifyYitanTokenPair,
  type VerifiedYitanBackchannelLogout,
  type VerifiedYitanIdentity,
} from '../lib/yitan-oidc.js'
import { authMiddleware, type AuthUser } from '../middleware/auth.js'
import { catalogAuthMiddleware } from '../middleware/catalog-auth.js'

const EmailSchema = z.string().trim().toLowerCase().email().max(254)
const PasswordSchema = z.string().min(6).max(128)

export const RegisterBody = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  displayName: z.string().trim().min(1).max(50),
  inviteCode: z.unknown().optional(),
})

const LoginBody = z.object({
  email: EmailSchema,
  password: PasswordSchema,
})

const AvatarUrlSchema = z.string().trim().max(2048).refine((value) => {
  try {
    if (config.SKILLHUB_PROFILE === 'selfhost') return publicImageUrl(value) === value
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
})

const UpdateProfileBody = z.object({
  displayName: z.string().trim().min(1).max(50).optional(),
  avatarUrl: AvatarUrlSchema.nullable().optional(),
}).refine((value) => value.displayName !== undefined || value.avatarUrl !== undefined)

const ChangePasswordBody = z.object({
  currentPassword: PasswordSchema,
  newPassword: PasswordSchema,
}).refine((value) => value.currentPassword !== value.newPassword)

const YitanTokenPairBody = z.object({
  accessToken: z.string().min(1).max(16_384),
  idToken: z.string().min(1).max(16_384),
  nonce: z.string().min(16).max(512),
}).strict()

const YitanLinkBody = YitanTokenPairBody.extend({
  expectedLocalUserId: z.string().uuid(),
}).strict()

const YitanExchangeBody = YitanTokenPairBody.extend({ purpose: z.enum(['product', 'catalog']).default('product') }).strict()

function exchangeResponse(fastify: Parameters<FastifyPluginAsync>[0], user: PublicUserSource & { tokenVersion: number; catalogTokenVersion: number }, purpose: 'product' | 'catalog'): unknown {
  if (purpose === 'product') return authResponse(fastify, user, user.tokenVersion)
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + config.CATALOG_TOKEN_TTL_DAYS * 86400
  return {
    token: fastify.jwt.sign({ sub: user.id, purpose: 'catalog', cver: user.catalogTokenVersion, iat, exp }),
    expiresAt: new Date(exp * 1000).toISOString(),
    user: { id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl },
  }
}

type PublicUser = AuthUser & { avatarUrl: string | null; yitanAccountLinked: boolean }
type PublicUserSource = {
  id: string
  email: string
  displayName: string
  avatarUrl: string | null
  marketplaceRole: string
  externalIdentities?: Array<{ id: string }>
}

type AuthResponse = {
  token: string
  tokenType: 'Bearer'
  expiresIn: number
  user: PublicUser
}

export const publicUserSelect = {
  id: true,
  email: true,
  displayName: true,
  avatarUrl: true,
  marketplaceRole: true,
  externalIdentities: {
    where: { issuer: config.YITAN_OIDC_ISSUER },
    select: { id: true },
    take: 1,
  },
} as const

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

async function inviteCodeMatches(candidate: unknown): Promise<boolean> {
  const expected = config.SKILLHUB_PROFILE === 'selfhost' ? await getSettingSecret('registration') ?? '' : config.REGISTRATION_INVITE_CODE ?? ''
  const normalizedCandidate = typeof candidate === 'string' ? candidate.trim() : ''
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  const candidateDigest = createHash('sha256').update(normalizedCandidate, 'utf8').digest()
  const matches = timingSafeEqual(expectedDigest, candidateDigest)
  return expected.length > 0 && normalizedCandidate.length <= 512 && matches
}

function inviteCodeFromBody(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || !('inviteCode' in body)) return undefined
  return (body as Record<string, unknown>).inviteCode
}

function toPublicUser(user: PublicUserSource): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    marketplaceRole: user.marketplaceRole === 'admin' ? 'admin' : 'user',
    yitanAccountLinked: (user.externalIdentities?.length ?? 0) > 0,
  }
}

export function authResponse(
  fastify: Parameters<FastifyPluginAsync>[0],
  user: PublicUserSource,
  tokenVersion: number,
  expiresIn: number = config.JWT_EXPIRES_IN_SECONDS
): AuthResponse {
  const publicUser = toPublicUser(user)
  return {
    token: fastify.jwt.sign(
      { sub: publicUser.id, ver: tokenVersion, purpose: 'product' },
      { expiresIn }
    ),
    tokenType: 'Bearer',
    expiresIn,
    user: publicUser,
  }
}

function migrationAllowlistIncludes(user: { id: string }): boolean {
  const allowlist = new Set(config.AUTH_LEGACY_MIGRATION_ALLOWLIST)
  return allowlist.has(user.id.toLowerCase())
}

function yitanAuthEnabled(): boolean {
  return config.AUTH_MODE === 'dual' || config.AUTH_MODE === 'yitan'
}

function oidcError(reply: FastifyReply, statusCode: number, code: string, message: string): FastifyReply {
  return reply.code(statusCode).send({ error: code, message })
}

function safeDisplayName(identity: VerifiedYitanIdentity, email: string): string {
  const candidate = identity.displayName?.trim() || email.split('@')[0] || '一探用户'
  return candidate.slice(0, 50)
}

function linkAuthenticationIsFresh(identity: VerifiedYitanIdentity, now = Date.now()): boolean {
  if (
    !identity.emailVerified
    || !EmailSchema.safeParse(identity.email).success
    || identity.authTime === null
  ) return false
  const nowSeconds = Math.floor(now / 1_000)
  return identity.authTime <= nowSeconds + config.YITAN_OIDC_CLOCK_TOLERANCE_SECONDS
    && nowSeconds - identity.authTime <= (
      config.YITAN_OIDC_LINK_MAX_AUTH_AGE_SECONDS
      + config.YITAN_OIDC_CLOCK_TOLERANCE_SECONDS
    )
}

function tokenPredatesLastLogout(
  identity: Pick<VerifiedYitanIdentity, 'issuedAt'>,
  lastLogoutAt: Date | null
): boolean {
  return lastLogoutAt !== null && identity.issuedAt <= Math.floor(lastLogoutAt.getTime() / 1_000)
}

function laterLogoutAt(left: Date | null, right: Date | null): Date | null {
  if (!left) return right
  if (!right) return left
  return left.getTime() >= right.getTime() ? left : right
}

function logoutTokenFromForm(body: unknown): string | null {
  if (typeof body !== 'string' || body.length === 0 || body.length > 20_000) return null
  const values = new URLSearchParams(body).getAll('logout_token')
  if (values.length !== 1) return null
  const token = values[0]?.trim()
  return token && token.length <= 16_384 ? token : null
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  const attempts = new AttemptLimiter()

  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 20_000 },
    (_request, body, done) => done(null, body)
  )

  async function handleBackchannelLogout(
    request: FastifyRequest,
    reply: FastifyReply,
    verifyLogout: (logoutToken: string) => Promise<VerifiedYitanBackchannelLogout>
  ): Promise<FastifyReply> {
    reply.header('Cache-Control', 'no-store')
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    const logoutToken = contentType === 'application/x-www-form-urlencoded'
      ? logoutTokenFromForm(request.body)
      : null
    if (!logoutToken) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'A single form-encoded logout_token is required',
      })
    }

    let logout: VerifiedYitanBackchannelLogout
    try {
      logout = await verifyLogout(logoutToken)
    } catch {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'Logout token validation failed',
      })
    }

    const result = await db.$transaction(async (transaction) => {
      await lockExternalIdentityMutation(transaction, logout.issuer, logout.subject)
      const existingWatermark = await transaction.oidcLogoutWatermark.findUnique({
        where: {
          issuer_subject: { issuer: logout.issuer, subject: logout.subject },
        },
        select: { latestLogoutAt: true },
      })
      if (
        existingWatermark
        && logout.issuedAt <= Math.floor(existingWatermark.latestLogoutAt.getTime() / 1_000)
      ) {
        return 'replayed' as const
      }
      const latestLogoutAt = new Date(logout.issuedAt * 1_000)
      await transaction.oidcLogoutWatermark.upsert({
        where: {
          issuer_subject: { issuer: logout.issuer, subject: logout.subject },
        },
        create: {
          issuer: logout.issuer,
          subject: logout.subject,
          latestLogoutAt,
        },
        update: { latestLogoutAt },
      })
      const identity = await transaction.externalIdentity.findUnique({
        where: {
          issuer_subject: { issuer: logout.issuer, subject: logout.subject },
        },
        select: { id: true, userId: true },
      })
      if (!identity) return 'not_mapped' as const
      await lockUserMutation(transaction, identity.userId)
      await transaction.user.update({
        where: { id: identity.userId },
        data: { tokenVersion: { increment: 1 }, catalogTokenVersion: { increment: 1 } },
      })
      await transaction.externalIdentity.update({
        where: { id: identity.id },
        data: { lastLogoutAt: latestLogoutAt },
      })
      return 'revoked' as const
    })

    request.log.info(
      { issuer: logout.issuer, outcome: result },
      'Processed Yitan back-channel logout without logging subject or token identifiers'
    )
    return reply.code(200).send()
  }

  fastify.post('/yitan/backchannel-logout', async (request, reply) => {
    const retryAfter = attempts.consume(
      `yitan-backchannel:${request.ip}`,
      config.AUTH_YITAN_BACKCHANNEL_ATTEMPTS_PER_MINUTE,
      60 * 1_000
    )
    if (retryAfter !== null) return rejectRateLimited(reply, retryAfter)
    return handleBackchannelLogout(request, reply, verifyYitanBackchannelLogout)
  })

  if (config.YITAN_TEST_BACKCHANNEL_ENABLED) {
    fastify.post('/yitan-test/backchannel-logout', async (request, reply) => {
      const retryAfter = attempts.consume(
        `yitan-test-backchannel:${request.ip}`,
        config.AUTH_YITAN_BACKCHANNEL_ATTEMPTS_PER_MINUTE,
        60 * 1_000
      )
      if (retryAfter !== null) return rejectRateLimited(reply, retryAfter)
      return handleBackchannelLogout(request, reply, verifyYitanTestBackchannelLogout)
    })
  }

  function loginAttemptKey(ip: string, email: string): string {
    const accountDigest = createHash('sha256').update(email, 'utf8').digest('base64url')
    return `login:${ip}:${accountDigest}`
  }

  function rejectRateLimited(reply: FastifyReply, retryAfter: number): FastifyReply {
    reply.header('Retry-After', String(retryAfter))
    return reply.code(429).send({ error: 'Too many attempts. Try again later.' })
  }

  fastify.post('/register', async (request, reply) => {
    if (!config.LOCAL_REGISTRATION_ENABLED) {
      return oidcError(reply, 410, 'AUTH_PORTAL_REQUIRED', 'New accounts must be created in the Yitan account portal')
    }
    const retryAfter = attempts.consume(
      `register:${request.ip}`,
      config.AUTH_REGISTER_ATTEMPTS_PER_HOUR,
      60 * 60 * 1000
    )
    if (retryAfter !== null) return rejectRateLimited(reply, retryAfter)

    const mode = config.SKILLHUB_PROFILE === 'selfhost' ? registrationView().mode : config.REGISTRATION_MODE
    if (mode === 'closed') return reply.code(403).send({ code: 'REGISTRATION_CLOSED', error: 'Registration is closed' })
    if (mode === 'invite' && !await inviteCodeMatches(inviteCodeFromBody(request.body))) {
      return reply.code(403).send({ error: 'Invalid invitation code' })
    }
    const body = RegisterBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'Invalid registration data' })

    const credentials = await hashPassword(body.data.password)
    try {
      const user = await db.user.create({
        data: {
          email: body.data.email,
          displayName: body.data.displayName,
          ...credentials,
        },
        select: { ...publicUserSelect, tokenVersion: true },
      })
      const { tokenVersion, ...publicUser } = user
      return reply.code(201).send(authResponse(fastify, publicUser, tokenVersion))
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        return reply.code(409).send({ error: 'Email already registered' })
      }
      throw error
    }
  })

  fastify.post('/login', async (request, reply) => {
    const body = LoginBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'Invalid login data' })

    const attemptKey = loginAttemptKey(request.ip, body.data.email)
    const ipRetryAfter = attempts.consume(
      `login-ip:${request.ip}`,
      config.AUTH_LOGIN_IP_ATTEMPTS_PER_15_MIN,
      15 * 60 * 1000
    )
    if (ipRetryAfter !== null) return rejectRateLimited(reply, ipRetryAfter)

    const retryAfter = attempts.consume(
      attemptKey,
      config.AUTH_LOGIN_ATTEMPTS_PER_15_MIN,
      15 * 60 * 1000
    )
    if (retryAfter !== null) return rejectRateLimited(reply, retryAfter)

    const user = await db.user.findUnique({
      where: { email: body.data.email },
      select: {
        ...publicUserSelect,
        passwordHash: true,
        passwordSalt: true,
        tokenVersion: true,
      },
    })
    const valid = await verifyPassword(body.data.password, user?.passwordHash, user?.passwordSalt)
    if (!user || !valid) {
      return reply.code(401).send({ error: 'Invalid email or password' })
    }
    if (
      config.AUTH_MODE === 'yitan'
      && (
        !migrationAllowlistIncludes(user)
        || (user.externalIdentities?.length ?? 0) > 0
      )
    ) {
      return oidcError(
        reply,
        403,
        'LEGACY_LOGIN_MIGRATION_ONLY',
        'Legacy login is limited to approved account migration'
      )
    }

    const { passwordHash: _passwordHash, passwordSalt: _passwordSalt, tokenVersion, ...publicUser } = user
    // A successful login forgives failures for this account on this IP, while
    // the broader IP budget remains to stop random-email key rotation abuse.
    attempts.clear(attemptKey)
    const expiresIn = config.AUTH_MODE === 'yitan'
      ? config.AUTH_LEGACY_MIGRATION_SESSION_SECONDS
      : config.JWT_EXPIRES_IN_SECONDS
    return reply.send(authResponse(fastify, publicUser, tokenVersion, expiresIn))
  })

  if (config.SKILLHUB_PROFILE === 'yitan-official') fastify.post<{ Body: unknown }>('/yitan/exchange', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    if (!yitanAuthEnabled()) {
      return oidcError(reply, 404, 'YITAN_AUTH_DISABLED', 'Yitan authentication is disabled')
    }
    const retryAfter = attempts.consume(
      `yitan-exchange:${request.ip}`,
      config.AUTH_YITAN_EXCHANGE_ATTEMPTS_PER_15_MIN,
      15 * 60 * 1_000
    )
    if (retryAfter !== null) return rejectRateLimited(reply, retryAfter)

    const body = YitanExchangeBody.safeParse(request.body)
    if (!body.success) {
      return oidcError(reply, 400, 'INVALID_YITAN_TOKEN_REQUEST', 'Invalid Yitan token request')
    }

    let identity: VerifiedYitanIdentity
    try {
      identity = await verifyYitanTokenPair(body.data)
    } catch {
      return oidcError(reply, 401, 'YITAN_TOKEN_INVALID', 'Yitan token verification failed')
    }

    const emailResult = identity.emailVerified
      ? EmailSchema.safeParse(identity.email)
      : { success: false as const }
    try {
      const result = await db.$transaction(async (transaction) => {
        await lockExternalIdentityMutation(transaction, identity.issuer, identity.subject)
        const logoutWatermark = await transaction.oidcLogoutWatermark.findUnique({
          where: {
            issuer_subject: { issuer: identity.issuer, subject: identity.subject },
          },
          select: { latestLogoutAt: true },
        })
        const existingIdentity = await transaction.externalIdentity.findUnique({
          where: {
            issuer_subject: { issuer: identity.issuer, subject: identity.subject },
          },
          include: {
            user: { select: { ...publicUserSelect, tokenVersion: true, catalogTokenVersion: true } },
          },
        })
        const latestLogoutAt = laterLogoutAt(
          logoutWatermark?.latestLogoutAt ?? null,
          existingIdentity?.lastLogoutAt ?? null
        )
        if (
          latestLogoutAt
          && latestLogoutAt.getTime() > (logoutWatermark?.latestLogoutAt.getTime() ?? -1)
        ) {
          await transaction.oidcLogoutWatermark.upsert({
            where: {
              issuer_subject: { issuer: identity.issuer, subject: identity.subject },
            },
            create: {
              issuer: identity.issuer,
              subject: identity.subject,
              latestLogoutAt,
            },
            update: { latestLogoutAt },
          })
        }
        if (tokenPredatesLastLogout(identity, latestLogoutAt)) {
          return { kind: 'revoked_token' } as const
        }
        if (existingIdentity) {
          await transaction.externalIdentity.update({
            where: { id: existingIdentity.id },
            data: { lastLoginAt: new Date() },
          })
          return { kind: 'authenticated', user: existingIdentity.user } as const
        }
        if (!emailResult.success) return { kind: 'verified_email_required' } as const

        const existingLocalUser = await transaction.user.findFirst({
          where: { email: { equals: emailResult.data, mode: 'insensitive' } },
          select: { id: true },
        })
        if (existingLocalUser) return { kind: 'link_required' } as const

        const user = await transaction.user.create({
          data: {
            email: emailResult.data,
            displayName: safeDisplayName(identity, emailResult.data),
            avatarUrl: isRetiredMedia(identity.avatarUrl) ? null : identity.avatarUrl,
            externalIdentities: {
              create: {
                issuer: identity.issuer,
                subject: identity.subject,
                linkMethod: 'oidc_provisioned',
                ...(latestLogoutAt ? { lastLogoutAt: latestLogoutAt } : {}),
              },
            },
          },
          select: { ...publicUserSelect, tokenVersion: true, catalogTokenVersion: true },
        })
        return { kind: 'authenticated', user } as const
      })

      if (result.kind === 'verified_email_required') {
        return oidcError(
          reply,
          403,
          'YITAN_VERIFIED_EMAIL_REQUIRED',
          'A verified Yitan email is required'
        )
      }
      if (result.kind === 'link_required') {
        return oidcError(
          reply,
          409,
          'YITAN_ACCOUNT_LINK_REQUIRED',
          'An existing SkillHub account must be linked explicitly'
        )
      }
      if (result.kind === 'revoked_token') {
        return oidcError(reply, 401, 'YITAN_TOKEN_REVOKED', 'This Yitan token predates logout')
      }
      reply.header('Cache-Control', 'no-store')
      return reply.send(exchangeResponse(fastify, result.user, body.data.purpose))
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) throw error
      const racedResult = await db.$transaction(async (transaction) => {
        await lockExternalIdentityMutation(transaction, identity.issuer, identity.subject)
        const logoutWatermark = await transaction.oidcLogoutWatermark.findUnique({
          where: {
            issuer_subject: { issuer: identity.issuer, subject: identity.subject },
          },
          select: { latestLogoutAt: true },
        })
        const racedIdentity = await transaction.externalIdentity.findUnique({
          where: {
            issuer_subject: { issuer: identity.issuer, subject: identity.subject },
          },
          include: {
            user: { select: { ...publicUserSelect, tokenVersion: true, catalogTokenVersion: true } },
          },
        })
        const latestLogoutAt = laterLogoutAt(
          logoutWatermark?.latestLogoutAt ?? null,
          racedIdentity?.lastLogoutAt ?? null
        )
        if (tokenPredatesLastLogout(identity, latestLogoutAt)) {
          return { kind: 'revoked_token' } as const
        }
        if (!racedIdentity) return { kind: 'link_required' } as const
        await transaction.externalIdentity.update({
          where: { id: racedIdentity.id },
          data: { lastLoginAt: new Date() },
        })
        return { kind: 'authenticated', user: racedIdentity.user } as const
      })
      if (racedResult.kind === 'revoked_token') {
        return oidcError(reply, 401, 'YITAN_TOKEN_REVOKED', 'This Yitan token predates logout')
      }
      if (racedResult.kind === 'authenticated') {
        reply.header('Cache-Control', 'no-store')
        return reply.send(exchangeResponse(fastify, racedResult.user, body.data.purpose))
      }
      return oidcError(
        reply,
        409,
        'YITAN_ACCOUNT_LINK_REQUIRED',
        'An existing SkillHub account must be linked explicitly'
      )
    }
  })

  if (config.SKILLHUB_PROFILE === 'yitan-official') fastify.post('/yitan/link', { preHandler: authMiddleware }, async (request, reply) => {
    if (!yitanAuthEnabled()) {
      return oidcError(reply, 404, 'YITAN_AUTH_DISABLED', 'Yitan authentication is disabled')
    }
    if (!migrationAllowlistIncludes(request.user)) {
      return oidcError(
        reply,
        403,
        'LEGACY_MIGRATION_NOT_ALLOWED',
        'This SkillHub account is not approved for migration yet'
      )
    }
    const body = YitanLinkBody.safeParse(request.body)
    if (!body.success) {
      return oidcError(reply, 400, 'INVALID_YITAN_TOKEN_REQUEST', 'Invalid Yitan token request')
    }
    if (body.data.expectedLocalUserId !== request.user.id) {
      return oidcError(
        reply,
        409,
        'YITAN_LOCAL_USER_MISMATCH',
        'The local account changed before Yitan linking completed'
      )
    }
    const retryAfter = attempts.consume(
      `yitan-link:${request.ip}`,
      config.AUTH_YITAN_EXCHANGE_ATTEMPTS_PER_15_MIN,
      15 * 60 * 1_000
    )
    if (retryAfter !== null) return rejectRateLimited(reply, retryAfter)
    let identity: VerifiedYitanIdentity
    try {
      identity = await verifyYitanTokenPair(body.data)
    } catch {
      return oidcError(reply, 401, 'YITAN_TOKEN_INVALID', 'Yitan token verification failed')
    }
    if (!linkAuthenticationIsFresh(identity)) {
      return oidcError(
        reply,
        401,
        'YITAN_REAUTH_REQUIRED',
        'Linking requires a verified email and a recent Yitan sign-in'
      )
    }

    const result = await db.$transaction(async (transaction) => {
      await lockExternalIdentityMutation(transaction, identity.issuer, identity.subject)
      await lockUserMutation(transaction, request.user.id)

      const logoutWatermark = await transaction.oidcLogoutWatermark.findUnique({
        where: {
          issuer_subject: { issuer: identity.issuer, subject: identity.subject },
        },
        select: { latestLogoutAt: true },
      })
      if (tokenPredatesLastLogout(identity, logoutWatermark?.latestLogoutAt ?? null)) {
        return { kind: 'revoked_token' } as const
      }

      const user = await transaction.user.findUnique({
        where: { id: request.user.id },
        select: { ...publicUserSelect, tokenVersion: true },
      })
      if (
        !user
        || user.tokenVersion !== request.verifiedAuthToken?.ver
      ) return { kind: 'unauthorized' } as const

      const localIdentity = await transaction.externalIdentity.findUnique({
        where: {
          userId_issuer: { userId: user.id, issuer: identity.issuer },
        },
      })
      if (localIdentity && localIdentity.subject !== identity.subject) {
        return { kind: 'local_already_linked' } as const
      }

      const subjectIdentity = await transaction.externalIdentity.findUnique({
        where: {
          issuer_subject: { issuer: identity.issuer, subject: identity.subject },
        },
      })
      if (subjectIdentity && subjectIdentity.userId !== user.id) {
        return { kind: 'identity_already_linked' } as const
      }
      const latestLogoutAt = laterLogoutAt(
        logoutWatermark?.latestLogoutAt ?? null,
        subjectIdentity?.lastLogoutAt ?? localIdentity?.lastLogoutAt ?? null
      )
      if (
        latestLogoutAt
        && latestLogoutAt.getTime() > (logoutWatermark?.latestLogoutAt.getTime() ?? -1)
      ) {
        await transaction.oidcLogoutWatermark.upsert({
          where: {
            issuer_subject: { issuer: identity.issuer, subject: identity.subject },
          },
          create: {
            issuer: identity.issuer,
            subject: identity.subject,
            latestLogoutAt,
          },
          update: { latestLogoutAt },
        })
      }
      if (tokenPredatesLastLogout(identity, latestLogoutAt)) {
        return { kind: 'revoked_token' } as const
      }
      if (localIdentity) {
        await transaction.externalIdentity.update({
          where: { id: localIdentity.id },
          data: { lastLoginAt: new Date() },
        })
        return { kind: 'linked', user } as const
      }

      await transaction.externalIdentity.create({
        data: {
          userId: user.id,
          issuer: identity.issuer,
          subject: identity.subject,
          linkMethod: 'legacy_session',
          ...(latestLogoutAt ? { lastLogoutAt: latestLogoutAt } : {}),
        },
      })
      const linkedUser = await transaction.user.update({
        where: { id: user.id },
        data: { tokenVersion: { increment: 1 } },
        select: { ...publicUserSelect, tokenVersion: true },
      })
      return { kind: 'linked', user: linkedUser } as const
    })

    if (result.kind === 'unauthorized') {
      return oidcError(reply, 401, 'UNAUTHORIZED', 'Unauthorized')
    }
    if (result.kind === 'local_already_linked') {
      return oidcError(
        reply,
        409,
        'YITAN_LOCAL_ACCOUNT_ALREADY_LINKED',
        'This SkillHub account is already linked to another Yitan account'
      )
    }
    if (result.kind === 'identity_already_linked') {
      return oidcError(
        reply,
        409,
        'YITAN_IDENTITY_ALREADY_LINKED',
        'This Yitan account is already linked to another SkillHub account'
      )
    }
    if (result.kind === 'revoked_token') {
      return oidcError(reply, 401, 'YITAN_TOKEN_REVOKED', 'This Yitan token predates logout')
    }
    const { tokenVersion, ...publicUser } = result.user
    return reply.send(authResponse(fastify, publicUser, tokenVersion))
  })

  fastify.post<{ Body: unknown }>('/renew', { preHandler: authMiddleware }, async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    reply.header('Cache-Control', 'no-store')
    const retryAfter = attempts.consume(`renew:${request.user.id}`, 20, 60 * 60 * 1_000)
    if (retryAfter !== null) return rejectRateLimited(reply, retryAfter)
    const user = await db.user.findUnique({ where: { id: request.user.id }, select: { ...publicUserSelect, tokenVersion: true } })
    // Never upgrade a token revoked between middleware validation and this read.
    if (!user || user.tokenVersion !== request.verifiedAuthToken?.ver) return reply.code(401).send({ error: 'Unauthorized' })
    return reply.send(authResponse(fastify, user, user.tokenVersion))
  })

  fastify.get('/me', { preHandler: authMiddleware }, async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const yitanIdentity = await db.externalIdentity.findUnique({
      where: {
        userId_issuer: {
          userId: request.user.id,
          issuer: config.YITAN_OIDC_ISSUER,
        },
      },
      select: { id: true },
    })
    reply.header('Cache-Control', 'no-store')
    const payload = request.verifiedAuthToken
    return reply.send({
      tokenIssuedAt: payload?.iat === undefined ? undefined : new Date(payload.iat * 1000).toISOString(),
      tokenExpiresAt: payload?.exp === undefined ? undefined : new Date(payload.exp * 1000).toISOString(),
      user: {
        id: request.user.id,
        email: request.user.email,
        displayName: request.user.displayName,
        avatarUrl: request.user.avatarUrl ?? null,
        marketplaceRole: request.user.marketplaceRole,
        yitanAccountLinked: yitanIdentity !== null,
      },
    })
  })

  // Stateless JWTs remain usable after a client-only logout. Incrementing the
  // server-side token version makes logout a durable revocation across every
  // API process and rejects reuse of any token issued before this point.
  fastify.post('/logout', { preHandler: authMiddleware }, async (request, reply) => {
    await db.$transaction(async (transaction) => {
      await lockUserMutation(transaction, request.user.id)
      await transaction.user.update({
        where: { id: request.user.id },
        data: { tokenVersion: { increment: 1 } },
      })
    })
    return reply.code(204).send()
  })

  fastify.post<{ Body: unknown }>('/logout-all', { preHandler: authMiddleware }, async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    await db.$transaction(async (tx) => {
      await lockUserMutation(tx, request.user.id)
      await tx.user.update({ where: { id: request.user.id }, data: { tokenVersion: { increment: 1 }, catalogTokenVersion: { increment: 1 } } })
    })
    return reply.code(204).send()
  })

  if (config.SKILLHUB_PROFILE === 'yitan-official') {
    fastify.get('/catalog/me', { preHandler: catalogAuthMiddleware }, async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const payload = request.verifiedCatalogToken ?? await request.jwtVerify<{ exp: number }>()
      reply.header('Cache-Control', 'no-store')
      return reply.send({ user: { id: request.user.id, displayName: request.user.displayName, avatarUrl: request.user.avatarUrl ?? null }, expiresAt: new Date(payload.exp * 1000).toISOString() })
    })
    fastify.post<{ Body: unknown }>('/catalog/logout', { preHandler: catalogAuthMiddleware }, async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
      if (!request.verifiedCatalogToken) return reply.code(401).send({ error: 'Catalog token required' })
      await db.$transaction(async (tx) => {
        await lockUserMutation(tx, request.user.id)
        await tx.user.update({ where: { id: request.user.id }, data: { catalogTokenVersion: { increment: 1 } } })
      })
      return reply.code(204).send()
    })
  }

  fastify.patch('/profile', { preHandler: authMiddleware }, async (request, reply) => {
    const body = UpdateProfileBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'Invalid profile data' })
    await authorizeMediaUrl(body.data.avatarUrl, request.user.id, request.user.avatarUrl)

    const user = await db.user.update({
      where: { id: request.user.id },
      data: body.data,
      select: publicUserSelect,
    })
    request.user = toPublicUser(user)
    return { user: request.user }
  })

  fastify.post('/change-password', { preHandler: authMiddleware }, async (request, reply) => {
    const body = ChangePasswordBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'Invalid password data' })

    const result = await db.$transaction(async (transaction) => {
      await lockUserMutation(transaction, request.user.id)
      const user = await transaction.user.findUnique({
        where: { id: request.user.id },
        select: {
          ...publicUserSelect,
          passwordHash: true,
          passwordSalt: true,
          tokenVersion: true,
        },
      })
      if (!user) return { ok: false, error: 'Unauthorized' } as const
      const valid = await verifyPassword(body.data.currentPassword, user.passwordHash, user.passwordSalt)
      if (!valid) return { ok: false, error: 'Current password is incorrect' } as const

      const credentials = await hashPassword(body.data.newPassword)
      const updated = await transaction.user.update({
        where: { id: user.id },
        data: {
          ...credentials,
          tokenVersion: { increment: 1 },
        },
        select: { ...publicUserSelect, tokenVersion: true },
      })
      return { ok: true, updated } as const
    })
    if (!result.ok) return reply.code(401).send({ error: result.error })
    const { tokenVersion, ...publicUser } = result.updated
    return authResponse(fastify, publicUser, tokenVersion)
  })
}
