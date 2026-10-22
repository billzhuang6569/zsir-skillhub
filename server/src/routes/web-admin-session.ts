import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import { AttemptLimiter } from '../lib/attempt-limiter.js'
import { lockExternalIdentityMutation } from '../lib/mutation-lock.js'
import { verifyPassword } from '../lib/password.js'
import { verifyYitanTokenPair } from '../lib/yitan-oidc.js'

const SESSION_COOKIE_NAME = 'skillhub_admin_session'
const OIDC_TRANSACTION_COOKIE_NAME = 'skillhub_admin_oidc'
const SESSION_SECONDS = 8 * 60 * 60
const TOKEN_RESPONSE_MAX_BYTES = 256 * 1024

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(6).max(128),
})

const CallbackQuery = z.object({
  code: z.string().min(1).max(8_192),
  state: z.string().min(32).max(512),
}).passthrough()

const TokenResponse = z.object({
  access_token: z.string().min(1).max(16_384),
  id_token: z.string().min(1).max(16_384),
}).passthrough()

type OidcTransaction = {
  sub: 'web-admin-oidc-transaction'
  ver: 0
  kind: 'skillhub-web-admin-oidc'
  state: string
  nonce: string
  codeVerifier: string
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

function cookie(
  name: string,
  value: string,
  maxAge: number,
  sameSite: 'Lax' | 'Strict',
  path: string
): string {
  const secure = config.NODE_ENV === 'production' ? '; Secure' : ''
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=${sameSite}; Path=${path}; Max-Age=${maxAge}${secure}`
}

function sessionCookie(token: string, maxAge: number): string {
  return cookie(SESSION_COOKIE_NAME, token, maxAge, 'Strict', '/api')
}

function oidcTransactionCookie(token: string, maxAge: number): string {
  return cookie(OIDC_TRANSACTION_COOKIE_NAME, token, maxAge, 'Lax', '/')
}

function constantTimeMatches(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function yitanWebAuthEnabled(): boolean {
  return config.AUTH_MODE === 'dual' || config.AUTH_MODE === 'yitan'
}

function authorizationEndpoint(): string {
  return `${config.YITAN_OIDC_ISSUER}/protocol/openid-connect/auth`
}

function tokenEndpoint(): string {
  return `${config.YITAN_OIDC_ISSUER}/protocol/openid-connect/token`
}

function logoutEndpoint(): string {
  return `${config.YITAN_OIDC_ISSUER}/protocol/openid-connect/logout`
}

function callbackFailureUrl(code: string): string {
  const target = new URL(config.YITAN_WEB_SUCCESS_URL)
  target.searchParams.set('authError', code)
  return target.toString()
}

function clearOidcTransaction(reply: FastifyReply): void {
  reply.header('Set-Cookie', oidcTransactionCookie('', 0))
}

function failOidcCallback(
  request: FastifyRequest,
  reply: FastifyReply,
  code: string
): FastifyReply {
  request.log.warn({ code }, 'Yitan web admin callback rejected')
  clearOidcTransaction(reply)
  return reply.code(302).redirect(callbackFailureUrl(code))
}

async function readBoundedJsonResponse(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length')
  if (
    contentLength !== null
    && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > TOKEN_RESPONSE_MAX_BYTES)
  ) {
    throw new Error('Yitan token response exceeds the size limit')
  }
  if (!response.body) throw new Error('Yitan token response is empty')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > TOKEN_RESPONSE_MAX_BYTES) {
        await reader.cancel()
        throw new Error('Yitan token response exceeds the size limit')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8')) as unknown
}

async function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string
): Promise<{ accessToken: string; idToken: string }> {
  if (!config.YITAN_WEB_CLIENT_SECRET) throw new Error('Yitan web client is not configured')
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.YITAN_WEB_REDIRECT_URI,
    client_id: config.YITAN_WEB_CLIENT_ID,
    client_secret: config.YITAN_WEB_CLIENT_SECRET,
    code_verifier: codeVerifier,
  })
  const response = await fetch(tokenEndpoint(), {
    method: 'POST',
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(config.YITAN_WEB_OIDC_TOKEN_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error('Yitan authorization code exchange failed')
  const parsed = TokenResponse.safeParse(await readBoundedJsonResponse(response))
  if (!parsed.success) throw new Error('Yitan token response is invalid')
  return {
    accessToken: parsed.data.access_token,
    idToken: parsed.data.id_token,
  }
}

export const webAdminSessionRoutes: FastifyPluginAsync = async (fastify) => {
  const attempts = new AttemptLimiter()

  fastify.post('/session', async (request, reply) => {
    if (yitanWebAuthEnabled() && !config.WEB_ADMIN_EMERGENCY_PASSWORD_LOGIN_ENABLED) {
      return reply.code(410).send({
        error: 'AUTH_PORTAL_REQUIRED',
        message: 'Web administrator sign-in must use the Yitan account portal',
      })
    }
    const body = LoginBody.safeParse(request.body)
    if (!body.success) return reply.badRequest(body.error.message)
    const retryAfter = attempts.consume(`web-admin-login:${request.ip}`, 12, 60 * 60 * 1_000)
    if (retryAfter !== null) {
      reply.header('Retry-After', String(retryAfter))
      return reply.tooManyRequests('登录尝试过多，请稍后再试')
    }
    const user = await db.user.findUnique({
      where: { email: body.data.email },
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        marketplaceRole: true,
        tokenVersion: true,
        passwordHash: true,
        passwordSalt: true,
      },
    })
    const validPassword = await verifyPassword(body.data.password, user?.passwordHash, user?.passwordSalt)
    if (!user || !validPassword) return reply.unauthorized('邮箱或密码不正确')
    if (user.marketplaceRole !== 'admin') return reply.forbidden('当前账号没有商店管理权限')
    const token = fastify.jwt.sign(
      { sub: user.id, ver: user.tokenVersion, purpose: 'web-admin', webAdmin: true },
      { expiresIn: SESSION_SECONDS },
    )
    reply.header('Set-Cookie', sessionCookie(token, SESSION_SECONDS))
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        marketplaceRole: 'admin',
      },
    }
  })

  fastify.get('/yitan/start', async (request, reply) => {
    if (!yitanWebAuthEnabled()) return reply.notFound('Yitan web authentication is disabled')
    if (!config.YITAN_WEB_CLIENT_SECRET) return reply.serviceUnavailable('Yitan web authentication is not configured')
    const retryAfter = attempts.consume(`web-admin-yitan:${request.ip}`, 30, 15 * 60 * 1_000)
    if (retryAfter !== null) {
      reply.header('Retry-After', String(retryAfter))
      return reply.tooManyRequests('登录尝试过多，请稍后再试')
    }

    const state = randomBytes(32).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const codeVerifier = randomBytes(48).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url')
    const transaction: OidcTransaction = {
      sub: 'web-admin-oidc-transaction',
      ver: 0,
      kind: 'skillhub-web-admin-oidc',
      state,
      nonce,
      codeVerifier,
    }
    const transactionToken = fastify.jwt.sign(
      transaction,
      { expiresIn: config.YITAN_WEB_OIDC_TRANSACTION_SECONDS }
    )
    const authorizationUrl = new URL(authorizationEndpoint())
    authorizationUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.YITAN_WEB_CLIENT_ID,
      redirect_uri: config.YITAN_WEB_REDIRECT_URI,
      scope: 'openid profile email yitan_identity',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString()

    reply.header('Cache-Control', 'no-store')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Set-Cookie', oidcTransactionCookie(transactionToken, config.YITAN_WEB_OIDC_TRANSACTION_SECONDS))
    return reply.code(302).redirect(authorizationUrl.toString())
  })

  fastify.get('/yitan/callback', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    reply.header('Referrer-Policy', 'no-referrer')
    if (!yitanWebAuthEnabled() || !config.YITAN_WEB_CLIENT_SECRET) {
      return failOidcCallback(request, reply, 'not_configured')
    }
    const query = CallbackQuery.safeParse(request.query)
    const transactionCookie = cookieValue(request.headers.cookie, OIDC_TRANSACTION_COOKIE_NAME)
    if (!query.success || !transactionCookie) return failOidcCallback(request, reply, 'invalid_request')

    let transaction: OidcTransaction
    try {
      transaction = fastify.jwt.verify<OidcTransaction>(transactionCookie)
    } catch {
      return failOidcCallback(request, reply, 'invalid_transaction')
    }
    if (
      transaction.kind !== 'skillhub-web-admin-oidc'
      || transaction.sub !== 'web-admin-oidc-transaction'
      || transaction.ver !== 0
      || !constantTimeMatches(query.data.state, transaction.state)
      || transaction.nonce.length < 16
      || transaction.codeVerifier.length < 43
    ) {
      return failOidcCallback(request, reply, 'invalid_transaction')
    }

    try {
      const tokens = await exchangeAuthorizationCode(query.data.code, transaction.codeVerifier)
      const identity = await verifyYitanTokenPair({ ...tokens, nonce: transaction.nonce })
      if (identity.authorizedParty !== config.YITAN_WEB_CLIENT_ID) {
        return failOidcCallback(request, reply, 'invalid_client')
      }
      const authentication = await db.$transaction(async (transaction) => {
        await lockExternalIdentityMutation(transaction, identity.issuer, identity.subject)
        const logoutWatermark = await transaction.oidcLogoutWatermark.findUnique({
          where: {
            issuer_subject: { issuer: identity.issuer, subject: identity.subject },
          },
          select: { latestLogoutAt: true },
        })
        if (
          logoutWatermark
          && identity.issuedAt <= Math.floor(logoutWatermark.latestLogoutAt.getTime() / 1_000)
        ) {
          return { kind: 'token_revoked' } as const
        }
        const externalIdentity = await transaction.externalIdentity.findUnique({
          where: {
            issuer_subject: { issuer: identity.issuer, subject: identity.subject },
          },
          include: {
            user: {
              select: {
                id: true,
                marketplaceRole: true,
                tokenVersion: true,
              },
            },
          },
        })
        if (!externalIdentity) return { kind: 'account_link_required' } as const
        if (externalIdentity.user.marketplaceRole !== 'admin') {
          return { kind: 'admin_access_required' } as const
        }
        await transaction.externalIdentity.update({
          where: { id: externalIdentity.id },
          data: { lastLoginAt: new Date() },
        })
        return { kind: 'authenticated', user: externalIdentity.user } as const
      })
      if (authentication.kind !== 'authenticated') {
        return failOidcCallback(request, reply, authentication.kind)
      }
      const sessionToken = fastify.jwt.sign(
        {
          sub: authentication.user.id,
          ver: authentication.user.tokenVersion,
          purpose: 'web-admin',
          webAdmin: true,
        },
        { expiresIn: SESSION_SECONDS }
      )
      reply.header('Set-Cookie', [
        oidcTransactionCookie('', 0),
        sessionCookie(sessionToken, SESSION_SECONDS),
      ])
      return reply.code(302).redirect(config.YITAN_WEB_SUCCESS_URL)
    } catch {
      return failOidcCallback(request, reply, 'authentication_failed')
    }
  })

  fastify.get('/yitan/logout', async (_request, reply) => {
    reply.header('Set-Cookie', [
      oidcTransactionCookie('', 0),
      sessionCookie('', 0),
    ])
    reply.header('Cache-Control', 'no-store')
    if (!yitanWebAuthEnabled()) return reply.code(302).redirect(config.YITAN_WEB_SUCCESS_URL)
    const target = new URL(logoutEndpoint())
    target.search = new URLSearchParams({
      client_id: config.YITAN_WEB_CLIENT_ID,
      post_logout_redirect_uri: config.YITAN_WEB_POST_LOGOUT_REDIRECT_URI,
    }).toString()
    return reply.code(302).redirect(target.toString())
  })

  fastify.get('/session', async (request, reply) => {
    const token = cookieValue(request.headers.cookie, SESSION_COOKIE_NAME)
    if (!token) return reply.unauthorized()
    try {
      const payload = fastify.jwt.verify<{
        sub: string
        ver: number
        purpose?: 'product' | 'web-admin'
        webAdmin?: boolean
      }>(token)
      if (
        !payload.webAdmin
        || (payload.purpose !== undefined && payload.purpose !== 'web-admin')
        || !payload.sub
        || !Number.isInteger(payload.ver)
      ) return reply.unauthorized()
      const user = await db.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          email: true,
          displayName: true,
          avatarUrl: true,
          marketplaceRole: true,
          tokenVersion: true,
        },
      })
      if (!user || user.tokenVersion !== payload.ver || user.marketplaceRole !== 'admin') {
        return reply.unauthorized()
      }
      return { user: { ...user, marketplaceRole: 'admin' } }
    } catch {
      return reply.unauthorized()
    }
  })

  fastify.delete('/session', async (_request, reply) => {
    reply.header('Set-Cookie', sessionCookie('', 0))
    return reply.code(204).send()
  })
}
