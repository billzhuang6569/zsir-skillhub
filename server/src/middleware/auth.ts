import type { FastifyRequest, FastifyReply } from 'fastify'
import { db } from '../db.js'
import type { CatalogTokenPayload } from './catalog-auth.js'

export type AuthUser = {
  id: string
  email: string
  displayName: string
  avatarUrl?: string | null
  marketplaceRole: 'user' | 'admin'
  yitanAccountLinked?: boolean
}

export type AuthTokenPayload = {
  sub: string
  ver: number
  iat?: number
  exp?: number
  purpose?: 'product' | 'web-admin'
  webAdmin?: true
}
type WebAdminTokenPayload = AuthTokenPayload & { purpose?: 'web-admin'; webAdmin: true }

declare module 'fastify' {
  interface FastifyRequest {
    // The exact payload that passed signature, expiry, subject, and
    // token-version validation in this request's auth middleware.
    verifiedAuthToken?: Readonly<AuthTokenPayload>
  }
}

// Override @fastify/jwt's user type so req.user is AuthUser everywhere
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthTokenPayload | CatalogTokenPayload
    user: AuthUser
  }
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  let payload: AuthTokenPayload
  try {
    if (request.headers.authorization) {
      payload = await request.jwtVerify<AuthTokenPayload>()
      if (
        payload.webAdmin === true
        || (payload.purpose !== undefined && payload.purpose !== 'product')
      ) {
        throw new Error('Administrative sessions cannot be used as product bearer tokens')
      }
    } else if (request.routeOptions.url?.startsWith('/api/marketplace/admin')) {
      const cookies = Object.fromEntries((request.headers.cookie ?? '').split(';').flatMap((part) => {
        const separator = part.indexOf('=')
        if (separator < 1) return []
        return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]]
      }))
      const adminToken = cookies.skillhub_admin_session
      if (!adminToken) throw new Error('Missing admin session')
      const verified = request.server.jwt.verify<WebAdminTokenPayload>(adminToken)
      if (
        verified.webAdmin !== true
        || (verified.purpose !== undefined && verified.purpose !== 'web-admin')
      ) throw new Error('Invalid admin session')
      payload = verified
    } else {
      throw new Error('Missing authorization')
    }
  } catch {
    return reply.code(401).send({ error: 'Unauthorized' })
  }
  if (!payload.sub || !Number.isInteger(payload.ver)) return reply.code(401).send({ error: 'Unauthorized' })

  const user = await db.user.findUnique({ where: { id: payload.sub } })
  if (!user || user.tokenVersion !== payload.ver) return reply.code(401).send({ error: 'Unauthorized' })
  request.verifiedAuthToken = {
    sub: payload.sub,
    ver: payload.ver,
    ...(Number.isInteger(payload.iat) ? { iat: payload.iat } : {}),
    ...(Number.isInteger(payload.exp) ? { exp: payload.exp } : {}),
    ...(payload.purpose ? { purpose: payload.purpose } : {}),
  }
  request.user = {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    marketplaceRole: user.marketplaceRole === 'admin' ? 'admin' : 'user',
  }
}

export async function optionalAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!request.headers.authorization) return
  await authMiddleware(request, reply)
}
