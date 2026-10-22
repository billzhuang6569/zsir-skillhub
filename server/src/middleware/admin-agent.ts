import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { Prisma } from '@prisma/client'
import { db } from '../db.js'
import { config } from '../config.js'
import { AttemptLimiter } from '../lib/attempt-limiter.js'
import { equalHash, parseAgentKey, type AgentScope } from '../lib/admin-agent-key.js'
import { AGENT_API_VERSION } from '../lib/admin-agent-catalog.js'
import { CatalogAuthorshipError } from '../lib/skill-cards.js'

export type VerifiedAgentKey = { id: string; scopes: readonly string[]; lastUsedAt: Date | null; issuerAdminId: string | null }
export type AdminAgentAccess = ReturnType<typeof createAdminAgentAccess>

declare module 'fastify' {
  interface FastifyRequest {
    verifiedAgentKey?: VerifiedAgentKey
    agentSlotReserved?: boolean
  }
}

export function agentError(request: FastifyRequest, code: string, retryable: boolean): Record<string, unknown> {
  return { code, message: code, requestId: request.id, retryable }
}

export async function recordAgentAudit(tx: Prisma.TransactionClient, request: FastifyRequest, operationId: string, outcome: string): Promise<void> {
  const key = request.verifiedAgentKey!
  const now = new Date()
  await tx.adminAgentAuditEvent.create({ data: { keyId: key.id, channel: 'agent', ...(key.issuerAdminId ? { actorAdminId: key.issuerAdminId } : {}), operationId, outcome } })
  if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() >= 60 * 60_000) {
    await tx.adminAgentKey.updateMany({
      where: { id: key.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - 60 * 60_000) } }] },
      data: { lastUsedAt: now },
    })
  }
}

export function createAdminAgentAccess(): {
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  releaseSlot: (request: FastifyRequest) => Promise<void>
} {
  const limiter = new AttemptLimiter()
  const activeByKey = new Map<string, number>()
  async function releaseSlot(request: FastifyRequest): Promise<void> {
    if (!request.agentSlotReserved || !request.verifiedAgentKey) return
    const id = request.verifiedAgentKey.id
    const remaining = (activeByKey.get(id) ?? 1) - 1
    if (remaining > 0) activeByKey.set(id, remaining)
    else activeByKey.delete(id)
  }

  async function agentAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (config.NODE_ENV === 'production' && request.protocol !== 'https') {
      return reply.code(401).send(agentError(request, 'HTTPS_REQUIRED', false))
    }
    const authorization = request.headers.authorization
    if (request.headers.cookie || typeof authorization !== 'string' || !authorization.startsWith('Bearer ')
      || authorization.indexOf(' ', 7) !== -1) {
      return reply.code(401).send(agentError(request, 'UNAUTHORIZED', false))
    }
    const parsed = parseAgentKey(authorization.slice(7))
    if (!parsed) return reply.code(401).send(agentError(request, 'UNAUTHORIZED', false))
    try {
      const key = await db.adminAgentKey.findUnique({
        where: { id: parsed.id },
        include: { issuer: { select: { id: true, email: true, displayName: true, marketplaceRole: true } } },
      })
      if (!key || !equalHash(key.secretHash, parsed.hash) || key.revokedAt
        || key.issuer?.marketplaceRole !== 'admin') {
        return reply.code(401).send(agentError(request, 'UNAUTHORIZED', false))
      }
      const globalRetryAfter = limiter.consume('agent:global', 300, 60_000)
      const retryAfter = limiter.consume(`agent:${key.id}`, 60, 60_000)
      if (retryAfter !== null || globalRetryAfter !== null) {
        reply.header('Retry-After', String(Math.max(retryAfter ?? 0, globalRetryAfter ?? 0)))
        return reply.code(429).send(agentError(request, 'RATE_LIMITED', true))
      }
      if ((activeByKey.get(key.id) ?? 0) >= 2) {
        reply.header('Retry-After', '1')
        return reply.code(429).send(agentError(request, 'CONCURRENCY_LIMITED', true))
      }
      activeByKey.set(key.id, (activeByKey.get(key.id) ?? 0) + 1)
      request.verifiedAgentKey = { id: key.id, scopes: key.scopes, lastUsedAt: key.lastUsedAt, issuerAdminId: key.issuerAdminId }
      if (key.issuerAdminId && key.issuer) request.user = { ...key.issuer, marketplaceRole: 'admin' }
      request.agentSlotReserved = true
    } catch {
      return reply.code(503).send(agentError(request, 'KEY_STORE_UNAVAILABLE', true))
    }
  }

  return { authenticate: agentAuth, releaseSlot }
}

export function requireAgentScope(scope: AgentScope): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply): Promise<void> => {
    if (!request.verifiedAgentKey?.scopes.includes(scope)) return reply.code(403).send(agentError(request, 'SCOPE_DENIED', false))
  }
}

export function configureAgentRoutes(fastify: FastifyInstance, access: AdminAgentAccess): void {
  fastify.setErrorHandler((error, request, reply): void => {
    if (error instanceof CatalogAuthorshipError) {
      void reply.code(409).send({ ...agentError(request, error.code, false), message: error.message })
      return
    }
    const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 503
    const message = error instanceof Error ? error.message : 'DEPENDENCY_UNAVAILABLE'
    const code = message === 'AUDIT_UNAVAILABLE' ? 'AUDIT_UNAVAILABLE' : status >= 500 ? 'DEPENDENCY_UNAVAILABLE' : status === 409 ? 'CONFLICT' : status === 428 ? 'PRECONDITION_REQUIRED' : status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'SCOPE_DENIED' : status === 404 ? 'NOT_FOUND' : 'INVALID_INPUT'
    if (status >= 500) request.log.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Admin Marketplace dependency unavailable')
    void reply.code(status).send({ ...agentError(request, code, status >= 500), message: status >= 500 ? code : message })
  })
  fastify.addHook('onRequest', async (request, reply): Promise<void> => {
    reply.header('Cache-Control', 'no-store')
    await access.authenticate(request, reply)
    if (!reply.sent && !request.verifiedAgentKey?.issuerAdminId) return reply.code(401).send(agentError(request, 'UNAUTHORIZED', false))
  })
  fastify.addHook('onResponse', access.releaseSlot)
  fastify.addHook('onSend', async (request, reply, payload): Promise<typeof payload> => {
    if (reply.statusCode >= 400 || typeof payload !== 'string') return payload
    if (request.method === 'GET') {
      try {
        await db.$transaction(tx => recordAgentAudit(tx, request, request.routeOptions.url ?? 'marketplace.read', 'read'))
      } catch {
        reply.code(503)
        return JSON.stringify(agentError(request, 'AUDIT_UNAVAILABLE', true))
      }
    }
    return JSON.stringify({ apiVersion: AGENT_API_VERSION, requestId: request.id, generatedAt: new Date().toISOString(), data: JSON.parse(payload) as unknown, meta: {} })
  })
}

export async function auditAgentMutation(tx: Prisma.TransactionClient, request: FastifyRequest, operationId: string, scope: AgentScope, targetId: string): Promise<void> {
  const key = request.verifiedAgentKey
  if (!key) return
  // Key usage updates and revocation share one row lock; issuer demotion waits for commit.
  const valid = await tx.$queryRaw<{ id: string }[]>`
    SELECT k.id FROM admin_agent_keys k JOIN users u ON u.id = k."issuerAdminId"
    WHERE k.id = ${key.id} AND k."revokedAt" IS NULL AND u."marketplaceRole" = 'admin'
      AND ${scope} = ANY(k.scopes) AND u.id = ${request.user.id}
    FOR UPDATE OF k FOR SHARE OF u
  `
  if (!valid.length) throw request.server.httpErrors.unauthorized('Agent permission changed')
  try {
    await recordAgentAudit(tx, request, operationId, `write:${targetId}`)
  } catch {
    throw request.server.httpErrors.serviceUnavailable('AUDIT_UNAVAILABLE')
  }
}

/**
 * Audits a content-governance write from either channel. Agent requests keep the
 * Key/scope/issuer checks of `auditAgentMutation`; a Web admin session is
 * re-checked as an admin inside the same transaction and recorded without a Key.
 * Either way a failed audit insert aborts the business transaction.
 */
export async function auditAdminMutation(tx: Prisma.TransactionClient, request: FastifyRequest, operationId: string, scope: AgentScope, targetId: string): Promise<void> {
  if (request.verifiedAgentKey) return auditAgentMutation(tx, request, operationId, scope, targetId)
  const admin = await tx.$queryRaw<{ id: string }[]>`
    SELECT u.id FROM users u WHERE u.id = ${request.user.id} AND u."marketplaceRole" = 'admin' FOR SHARE OF u
  `
  if (!admin.length) throw request.server.httpErrors.forbidden('Marketplace administrator access required')
  try {
    await tx.adminAgentAuditEvent.create({ data: { channel: 'web', actorAdminId: request.user.id, operationId, outcome: `write:${targetId}` } })
  } catch {
    throw request.server.httpErrors.serviceUnavailable('AUDIT_UNAVAILABLE')
  }
}
