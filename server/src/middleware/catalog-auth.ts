import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { config } from '../config.js'
import { db } from '../db.js'
import { authMiddleware } from './auth.js'

export const CATALOG_ROUTES = [
  'GET /api/auth/catalog/me',
  'POST /api/auth/catalog/logout',
  'POST /api/marketplace/catalog-submissions',
  'POST /api/marketplace/skills/:skillId/submissions',
  'POST /api/marketplace/submissions/:id/withdraw',
  'DELETE /api/marketplace/skills/:skillId',
  'GET /api/marketplace/mine',
  'GET /api/marketplace/mine/:id',
  'POST /api/marketplace/:skillId/comments',
  'DELETE /api/marketplace/comments/:id',
] as const

export type CatalogTokenPayload = { sub: string; purpose: 'catalog'; cver: number; iat: number; exp: number }
declare module 'fastify' {
  interface FastifyRequest { verifiedCatalogToken?: Readonly<CatalogTokenPayload> }
}

export function catalogRouteAllowed(method: string, url: string): boolean {
  return (CATALOG_ROUTES as readonly string[]).includes(`${method} ${url}`)
}

// Inspect only to deny: decoding never grants access or substitutes for verification.
export async function catalogBoundary(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!bearer) return
  try {
    const payload = request.server.jwt.decode<{ purpose?: string }>(bearer)
    if (payload?.purpose === 'catalog' && (config.SKILLHUB_PROFILE !== 'yitan-official'
      || !catalogRouteAllowed(request.method, request.routeOptions.url ?? ''))) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
  } catch { /* Malformed bearer is handled by the route's authentication. */ }
}

export async function catalogTokenCurrent(client: Pick<Prisma.TransactionClient, 'user' | 'externalIdentity' | 'oidcLogoutWatermark'>, payload: CatalogTokenPayload): Promise<boolean> {
  if (!payload.sub || !Number.isInteger(payload.cver) || !Number.isInteger(payload.iat)
    || !Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return false
  const user = await client.user.findUnique({ where: { id: payload.sub } })
  if (!user || user.catalogTokenVersion !== payload.cver) return false
  const identity = await client.externalIdentity.findUnique({ where: { userId_issuer: { userId: payload.sub, issuer: config.YITAN_OIDC_ISSUER } } })
  if (!identity) return false
  const watermark = await client.oidcLogoutWatermark.findUnique({ where: { issuer_subject: { issuer: identity.issuer, subject: identity.subject } } })
  return [identity.lastLogoutAt, watermark?.latestLogoutAt].every(date => !date || payload.iat > Math.floor(date.getTime() / 1000))
}

export async function catalogAuthMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  let purpose: string | undefined
  try { purpose = bearer ? request.server.jwt.decode<{ purpose?: string }>(bearer)?.purpose : undefined } catch { /* Delegate malformed tokens to product authentication. */ }
  if (purpose !== 'catalog') return authMiddleware(request, reply)
  let payload: CatalogTokenPayload & { webAdmin?: boolean }
  try { payload = await request.jwtVerify<typeof payload>() } catch { return reply.code(401).send({ error: 'Unauthorized' }) }
  if (payload.purpose !== 'catalog') return authMiddleware(request, reply)
  if (config.SKILLHUB_PROFILE !== 'yitan-official' || payload.webAdmin
    || !catalogRouteAllowed(request.method, request.routeOptions.url ?? '')
    || !await catalogTokenCurrent(db, payload)) return reply.code(401).send({ error: 'Unauthorized' })
  const user = await db.user.findUnique({ where: { id: payload.sub } })
  if (!user) return reply.code(401).send({ error: 'Unauthorized' })
  request.verifiedCatalogToken = payload
  request.user = { id: user.id, email: user.email, displayName: user.displayName, avatarUrl: user.avatarUrl, marketplaceRole: 'user' }
}
