import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { Prisma, type AdminAgentKey } from '@prisma/client'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { isAdminOrigin } from '../middleware/api-guard.js'
import { AGENT_API_OPERATIONS, AGENT_API_VERSION, ADMIN_KEY_OPERATIONS, EXISTING_ADMIN_OPERATIONS } from '../lib/admin-agent-catalog.js'
import { AGENT_SCOPES, createAgentKey } from '../lib/admin-agent-key.js'

const CreateBody = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(AGENT_SCOPES)).min(1).max(AGENT_SCOPES.length)
    .refine((value) => new Set(value).size === value.length && (!value.includes('ops:logs:read') || value.includes('ops:read'))),
  clientOperationId: z.string().uuid(),
}).strict()

const KeyParams = z.object({ id: z.string().uuid() })
const ListQuery = z.object({ cursor: z.string().uuid().optional() }).strict()

function sessionCookie(request: FastifyRequest): string | null {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1 || part.slice(0, separator).trim() !== 'skillhub_admin_session') continue
    try { return decodeURIComponent(part.slice(separator + 1).trim()) } catch { return null }
  }
  return null
}

function csrfToken(request: FastifyRequest): string | null {
  const session = sessionCookie(request)
  if (!session) return null
  return createHmac('sha256', config.JWT_SECRET).update('admin-agent-key-csrf:').update(session).digest('base64url')
}

function isAllowedOrigin(origin: string | undefined): boolean {
  return Boolean(origin && isAdminOrigin(origin, config))
}

function validCsrf(request: FastifyRequest): boolean {
  const actual = request.headers['x-skillhub-csrf']
  const expected = csrfToken(request)
  const fetchSite = request.headers['sec-fetch-site']
  if (!expected || typeof actual !== 'string' || !isAllowedOrigin(request.headers.origin)) return false
  if (fetchSite && fetchSite !== 'same-origin') return false
  const a = Buffer.from(actual, 'ascii')
  const b = Buffer.from(expected, 'ascii')
  return a.length === b.length && timingSafeEqual(a, b)
}

async function humanAdminOnly(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.headers.authorization || request.verifiedAuthToken?.purpose !== 'web-admin'
    || request.user.marketplaceRole !== 'admin') {
    return reply.code(403).send({ error: 'Web administrator session required' })
  }
}

async function recentAdminSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const issuedAt = request.verifiedAuthToken?.iat
  const now = Math.floor(Date.now() / 1000)
  if (typeof issuedAt !== 'number' || issuedAt > now + 60 || now - issuedAt > 10 * 60) {
    return reply.code(403).send({ error: 'REAUTH_REQUIRED' })
  }
}

function keyDto(key: AdminAgentKey): Record<string, unknown> {
  return {
    id: key.id,
    name: key.name,
    scopes: key.scopes,
    issuerAdminId: key.issuerAdminId,
    createdAt: key.createdAt.toISOString(),
    revokedAt: key.revokedAt?.toISOString() ?? null,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    expiresAt: null,
    status: key.revokedAt ? 'revoked' : 'active',
  }
}

function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store')
}

export const adminAgentKeyRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [authMiddleware, humanAdminOnly]
  fastify.addHook('onRequest', async (_request, reply): Promise<void> => { reply.header('Cache-Control', 'no-store') })

  fastify.get('/admin/agent-keys', { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply)
    const query = ListQuery.safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: 'Invalid Key cursor' })
    try {
      const keys = await db.adminAgentKey.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 101,
        ...(query.data.cursor ? { cursor: { id: query.data.cursor }, skip: 1 } : {}),
      })
      const page = keys.slice(0, 100)
      return reply.send({ keys: page.map(keyDto), truncated: keys.length > 100, nextCursor: keys.length > 100 ? page.at(-1)?.id : null, csrfToken: csrfToken(request), availableScopes: AGENT_SCOPES })
    } catch {
      return reply.code(503).send({ error: 'Key store unavailable' })
    }
  })

  fastify.post('/admin/agent-keys', { preHandler: [...preHandler, recentAdminSession] }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply)
    if (!validCsrf(request)) return reply.code(403).send({ error: 'CSRF check failed' })
    const parsed = CreateBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid Key request' })
    const issuerAdminId = request.user.id
    const existingWhere = { issuerAdminId_clientOperationId: { issuerAdminId, clientOperationId: parsed.data.clientOperationId } }
    try {
      const existing = await db.adminAgentKey.findUnique({ where: existingWhere })
      if (existing) return reply.send({ key: keyDto(existing), created: false, secretAvailable: false })
      const id = randomUUID()
      const generated = createAgentKey(id)
      const created = await db.$transaction(async (tx) => {
        const key = await tx.adminAgentKey.create({ data: {
          id,
          name: parsed.data.name,
          scopes: parsed.data.scopes,
          secretHash: generated.hash,
          issuerAdminId,
          clientOperationId: parsed.data.clientOperationId,
        } })
        await tx.adminAgentAuditEvent.create({ data: { keyId: id, actorAdminId: issuerAdminId, operationId: 'admin.agentKeys.create', outcome: 'created' } })
        return key
      })
      return reply.code(201).send({ key: keyDto(created), created: true, secretAvailable: true, secret: generated.token })
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        try {
          const existing = await db.adminAgentKey.findUnique({ where: existingWhere })
          if (existing) return reply.send({ key: keyDto(existing), created: false, secretAvailable: false })
        } catch { /* fail closed below */ }
      }
      request.log.error({ errorCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'KEY_STORE_ERROR' }, 'Admin Agent Key creation failed')
      return reply.code(503).send({ error: 'Key store unavailable' })
    }
  })

  fastify.post('/admin/agent-keys/:id/revoke', { preHandler: [...preHandler, recentAdminSession] }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply)
    if (!validCsrf(request)) return reply.code(403).send({ error: 'CSRF check failed' })
    const params = KeyParams.safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: 'Invalid Key ID' })
    try {
      const result = await db.$transaction(async (tx) => {
        const existing = await tx.adminAgentKey.findUnique({ where: { id: params.data.id } })
        if (!existing) return null
        if (existing.revokedAt) return existing
        const changed = await tx.adminAgentKey.updateMany({ where: { id: existing.id, revokedAt: null }, data: { revokedAt: new Date() } })
        if (changed.count === 1) {
          await tx.adminAgentAuditEvent.create({ data: { keyId: existing.id, actorAdminId: request.user.id, operationId: 'admin.agentKeys.revoke', outcome: 'revoked' } })
        }
        return tx.adminAgentKey.findUnique({ where: { id: existing.id } })
      })
      if (!result) return reply.code(404).send({ error: 'Key not found' })
      return reply.send({ key: keyDto(result) })
    } catch {
      request.log.error('Admin Agent Key revocation failed')
      return reply.code(503).send({ error: 'Key store unavailable' })
    }
  })

  fastify.get('/admin/agent-api-docs', { preHandler }, async (_request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply)
    return reply.send({
      apiVersion: AGENT_API_VERSION,
      baseUrl: config.PUBLIC_BASE_URL,
      agentOperations: AGENT_API_OPERATIONS,
      adminOperations: ADMIN_KEY_OPERATIONS,
      existingAdminOperations: EXISTING_ADMIN_OPERATIONS,
      publicOperations: [
        { method: 'GET', path: '/health', description: '公开进程状态；不代表数据库就绪' },
        { method: 'GET', path: '/ready', description: '公开数据库迁移就绪状态' },
      ],
      authentication: { agent: 'Authorization: Bearer ${SKILLHUB_AGENT_KEY}', admin: '现有 Admin Cookie 会话；Key 创建/撤销另需新鲜会话、X-SkillHub-CSRF 和同源 Origin' },
      expiresAt: null,
      errors: { 400: '参数错误', 401: 'Key 无效或已撤销', 403: '权限不足或需重新登录 Admin', 404: '对象不存在或不属于当前签发者', 409: '业务身份、版本、状态或保存冲突，先读回', 413: '包、封面或账号存储超限', 428: '缺少保存前提', 429: '请求过多', 503: '依赖暂不可用' },
    })
  })
}
