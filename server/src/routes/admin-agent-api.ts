import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '../db.js'
import { config } from '../config.js'
import { AttemptLimiter } from '../lib/attempt-limiter.js'
import { AGENT_API_VERSION, permittedAgentOperations } from '../lib/admin-agent-catalog.js'
import { createAdminAgentAccess, recordAgentAudit, type AdminAgentAccess } from '../middleware/admin-agent.js'
import { readAppReleaseManifest } from '../lib/app-release-manifest.js'
import { readAdminAgentReleaseSummary } from '../lib/admin-agent-release-summary.js'
import { SERVER_BUILD_ID, SERVER_MIGRATION_MARKER, SERVER_VERSION } from '../server-info.js'
import { diagnosticCaptureStatus } from '../lib/admin-diagnostic-events.js'
import { decodeDiagnosticCursor, encodeDiagnosticCursor } from '../lib/admin-diagnostic-cursor.js'
import { readGatewayEvents } from '../lib/admin-gateway-log.js'

const WindowQuery = z.object({
  from: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  status: z.coerce.number().int().min(400).max(599).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict()
const LogQuery = WindowQuery.extend({ cursor: z.string().max(900).optional() })
const RequestParams = z.object({ requestId: z.string().regex(/^[0-9a-f]{32}$/) })
type Window = { from: Date; until: Date; status: number | null; limit: number }

function parseWindow(query: unknown): Window | null {
  const parsed = WindowQuery.safeParse(query)
  if (!parsed.success) return null
  const now = Date.now()
  const until = parsed.data.until ? new Date(parsed.data.until) : new Date(now)
  const from = parsed.data.from ? new Date(parsed.data.from) : new Date(until.getTime() - 15 * 60_000)
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(until.getTime())
    || from.getTime() > until.getTime() || until.getTime() > now + 60_000
    || until.getTime() - from.getTime() > 24 * 60 * 60_000) return null
  return { from, until, status: parsed.data.status ?? null, limit: parsed.data.limit ?? 100 }
}

function eventDto(event: {
  id: string; createdAt: Date; requestId: string; method: string; route: string;
  statusCode: number; durationMs: number; eventCode: string; fingerprint: string
}): Record<string, unknown> {
  return {
    eventId: event.id, time: event.createdAt.toISOString(), requestId: event.requestId,
    method: event.method, route: event.route, status: event.statusCode,
    durationMs: event.durationMs, eventCode: event.eventCode, fingerprint: event.fingerprint,
  }
}


function errorResponse(request: FastifyRequest, code: string, retryable: boolean): Record<string, unknown> {
  return { code, message: code, requestId: request.id, retryable }
}

function response(request: FastifyRequest, data: unknown, meta: Record<string, unknown> = {}): Record<string, unknown> {
  return { apiVersion: AGENT_API_VERSION, requestId: request.id, generatedAt: new Date().toISOString(), data, meta }
}

async function audit(request: FastifyRequest, operationId: string): Promise<boolean> {
  const key = request.verifiedAgentKey
  if (!key) return false
  try {
    await db.$transaction(tx => recordAgentAudit(tx, request, operationId, 'read'))
    return true
  } catch {
    return false
  }
}

async function sendAudited(
  request: FastifyRequest,
  reply: FastifyReply,
  operationId: string,
  data: unknown,
  meta: Record<string, unknown> = {},
): Promise<FastifyReply> {
  if (!await audit(request, operationId)) {
    return reply.code(503).send(errorResponse(request, 'AUDIT_UNAVAILABLE', true))
  }
  return reply.send(response(request, data, meta))
}

export const adminAgentApiRoutes: FastifyPluginAsync<{ access?: AdminAgentAccess }> = async (fastify, options) => {
  const access = options.access ?? createAdminAgentAccess()
  const agentAuth = access.authenticate
  const limiter = new AttemptLimiter()
  fastify.addHook('onRequest', async (_request, reply): Promise<void> => { reply.header('Cache-Control', 'no-store') })
  fastify.addHook('onResponse', access.releaseSlot)

  async function opsRead(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.verifiedAgentKey?.scopes.includes('ops:read')) {
      return reply.code(403).send(errorResponse(request, 'SCOPE_DENIED', false))
    }
  }

  async function logsRead(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const key = request.verifiedAgentKey
    if (!key?.scopes.includes('ops:logs:read')) {
      return reply.code(403).send(errorResponse(request, 'SCOPE_DENIED', false))
    }
    const retryAfter = limiter.consume('agent:logs:' + key.id, 10, 60_000)
    if (retryAfter !== null) {
      reply.header('Retry-After', String(retryAfter))
      return reply.code(429).send(errorResponse(request, 'RATE_LIMITED', true))
    }
  }

  fastify.get('/capabilities', { preHandler: agentAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const scopes = request.verifiedAgentKey?.scopes ?? []
    return sendAudited(request, reply, 'agent.capabilities', {
      apiVersion: AGENT_API_VERSION,
      scopes,
      expiresAt: null,
      operations: permittedAgentOperations(scopes),
      limits: { requestsPerMinute: 60, diagnosticRequestsPerMinute: 10, migrationRows: 50, diagnosticRows: 500 },
      coverage: '仅当前进程与数据库可用时可查询；Server 或数据库停机时本接口不可用',
    }, { source: 'server-route-catalog', collectedAt: new Date().toISOString(), status: 'ok' })
  })

  fastify.get('/overview', { preHandler: [agentAuth, opsRead] }, async (request: FastifyRequest, reply: FastifyReply) => {
    let database: Record<string, unknown>
    try {
      const rows = await db.$queryRaw<Array<{ applied: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" = ${SERVER_MIGRATION_MARKER}
          AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL) AS "applied"
      `
      database = { status: rows[0]?.applied === true ? 'ready' : 'unavailable', expectedMigration: SERVER_MIGRATION_MARKER }
    } catch {
      database = { status: 'unknown', expectedMigration: SERVER_MIGRATION_MARKER, reasonCode: 'MIGRATION_QUERY_FAILED' }
    }
    return sendAudited(request, reply, 'agent.overview', {
      server: { status: 'running', version: SERVER_VERSION, buildId: SERVER_BUILD_ID, uptimeSeconds: Math.floor(process.uptime()) },
      database,
    }, { source: 'running-process-and-prisma-migrations', collectedAt: new Date().toISOString(), status: database.status === 'ready' ? 'ok' : 'partial' })
  })

  fastify.get('/releases', { preHandler: [agentAuth, opsRead] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const [manifest, summary] = await Promise.all([
      readAppReleaseManifest(config.APP_UPDATE_MANIFEST_PATH),
      readAdminAgentReleaseSummary(SERVER_BUILD_ID, SERVER_MIGRATION_MARKER),
    ])
    const app = manifest.status === 'ok'
      ? { status: 'declared', releases: manifest.manifest.releases.map((item) => ({ target: item.target, arch: item.arch, version: item.version, pubDate: item.pubDate, installerSize: item.installer.size })) }
      : { status: 'unknown', reasonCode: manifest.status === 'missing' ? 'MANIFEST_MISSING' : 'MANIFEST_INVALID' }
    return sendAudited(request, reply, 'agent.releases', {
      server: { version: SERVER_VERSION, buildId: SERVER_BUILD_ID, expectedMigration: SERVER_MIGRATION_MARKER, evidenceLevel: 'declared' },
      app,
      deploymentEvidence: summary.status === 'verified'
        ? { status: 'verified', verifiedAt: summary.summary.verifiedAt, server: summary.summary.server, app: summary.summary.app, verificationScope: summary.summary.verificationScope }
        : { status: summary.status, reasonCode: summary.reasonCode },
    }, { source: 'bundled-release-metadata-and-app-manifest', collectedAt: new Date().toISOString(), status: app.status === 'declared' ? 'partial' : 'unknown' })
  })

  fastify.get('/migrations', { preHandler: [agentAuth, opsRead] }, async (request: FastifyRequest, reply: FastifyReply) => {
    let data: Record<string, unknown>
    try {
      const rows = await db.$queryRaw<Array<{ migration_name: string; started_at: Date; finished_at: Date | null; rolled_back_at: Date | null }>>`
        SELECT "migration_name", "started_at", "finished_at", "rolled_back_at"
        FROM "_prisma_migrations" ORDER BY "started_at" DESC LIMIT 51
      `
      data = { expected: SERVER_MIGRATION_MARKER, recent: rows.slice(0, 50).map((row) => ({
        name: row.migration_name,
        startedAt: row.started_at.toISOString(),
        finishedAt: row.finished_at?.toISOString() ?? null,
        state: row.rolled_back_at ? 'rolled_back' : row.finished_at ? 'applied' : 'incomplete',
      })), truncated: rows.length > 50 }
    } catch {
      data = { expected: SERVER_MIGRATION_MARKER, recent: null, status: 'unknown', reasonCode: 'MIGRATION_QUERY_FAILED' }
    }
    return sendAudited(request, reply, 'agent.migrations', data, { source: 'prisma-migration-table', collectedAt: new Date().toISOString(), status: data.status ?? 'ok' })
  })

  fastify.get('/jobs', { preHandler: [agentAuth, opsRead] }, async (request: FastifyRequest, reply: FastifyReply) => {
    let avatars: Record<string, unknown>
    try {
      const [groups, oldest] = await Promise.all([
        config.SKILL_AVATAR_MODEL_READS === 'variants' ? db.avatarGenerationJob.groupBy({ by: ['status'], _count: { _all: true } }) : db.skillAvatar.groupBy({ by: ['status'], _count: { _all: true } }),
        config.SKILL_AVATAR_MODEL_READS === 'variants' ? db.avatarGenerationJob.aggregate({ where: { status: 'queued' }, _min: { createdAt: true } }) : db.skillAvatar.aggregate({ where: { status: 'queued' }, _min: { createdAt: true } }),
      ])
      avatars = { status: 'ok', counts: Object.fromEntries(groups.map((item) => [item.status, item._count._all])), oldestQueuedAt: oldest._min.createdAt?.toISOString() ?? null }
    } catch {
      avatars = { status: 'unknown', reasonCode: 'AVATAR_QUERY_FAILED' }
    }
    return sendAudited(request, reply, 'agent.jobs', { avatars, workerHeartbeat: { status: 'unknown', reasonCode: 'NO_HEARTBEAT_EVIDENCE' } }, { source: config.SKILL_AVATAR_MODEL_READS === 'variants' ? 'avatar-generation-jobs-table' : 'skill-avatars-table', collectedAt: new Date().toISOString(), status: avatars.status === 'ok' ? 'partial' : 'unknown' })
  })

  fastify.get('/storage', { preHandler: [agentAuth, opsRead] }, async (request: FastifyRequest, reply: FastifyReply) => {
    let counts: Record<string, unknown>
    try {
      const [skills, versions, cards, libraryEntries] = await Promise.all([
        db.skill.count({ where: { deletedAt: null } }),
        db.skillVersion.count(),
        db.skillCard.count(),
        db.libraryEntry.count({ where: { deletedAt: null } }),
      ])
      counts = { status: 'ok', skills, versions, cards, libraryEntries }
    } catch {
      counts = { status: 'unknown', reasonCode: 'STORAGE_COUNT_FAILED' }
    }
    const summary = await readAdminAgentReleaseSummary(SERVER_BUILD_ID, SERVER_MIGRATION_MARKER)
    return sendAudited(request, reply, 'agent.storage', {
      counts,
      disk: { status: 'unknown', capacityBytes: null, freeBytes: null, reasonCode: 'NO_DISK_EVIDENCE' },
      integrityEvidence: summary.status === 'verified'
        ? { status: 'verified', verifiedAt: summary.summary.verifiedAt, evidenceLevel: summary.summary.cardIntegrity.evidenceLevel }
        : { status: summary.status, reasonCode: summary.reasonCode },
    }, { source: 'fixed-database-aggregates', collectedAt: new Date().toISOString(), status: counts.status === 'ok' ? 'partial' : 'unknown' })
  })

  fastify.get('/errors', { preHandler: [agentAuth, logsRead] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const window = parseWindow(request.query)
    if (!window) return reply.code(400).send(errorResponse(request, 'INVALID_QUERY', false))
    const cutoff = Date.now() - 7 * 24 * 60 * 60_000
    if (window.from.getTime() < cutoff) return reply.code(410).send(errorResponse(request, 'EVENTS_EXPIRED', false))
    try {
      const events = await db.adminDiagnosticEvent.findMany({
        where: { createdAt: { gte: window.from, lte: window.until }, ...(window.status === null ? {} : { statusCode: window.status }) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: Math.min(window.limit, 500) + 1,
      })
      const groups = new Map<string, { fingerprint: string; eventCode: string; route: string; status: number; count: number; latestAt: string; sampleRequestId: string }>()
      for (const event of events.slice(0, window.limit)) {
        const group = groups.get(event.fingerprint)
        if (group) group.count += 1
        else groups.set(event.fingerprint, {
          fingerprint: event.fingerprint, eventCode: event.eventCode, route: event.route,
          status: event.statusCode, count: 1, latestAt: event.createdAt.toISOString(), sampleRequestId: event.requestId,
        })
      }
      return sendAudited(request, reply, 'agent.errors', {
        groups: [...groups.values()], truncated: events.length > window.limit,
        window: { from: window.from.toISOString(), until: window.until.toISOString() },
        capture: diagnosticCaptureStatus(),
      }, { source: 'admin-diagnostic-events', collectedAt: new Date().toISOString(), status: 'partial' })
    } catch {
      return reply.code(503).send(errorResponse(request, 'DIAGNOSTIC_STORE_UNAVAILABLE', true))
    }
  })

  fastify.get('/logs', { preHandler: [agentAuth, logsRead] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = LogQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send(errorResponse(request, 'INVALID_QUERY', false))
    const { cursor, ...query } = parsed.data
    const keyId = request.verifiedAgentKey?.id
    if (!keyId) return reply.code(401).send(errorResponse(request, 'UNAUTHORIZED', false))
    let window: Window | null
    let position: ReturnType<typeof decodeDiagnosticCursor> = null
    if (cursor) {
      if (Object.keys(query).length > 0) return reply.code(400).send(errorResponse(request, 'INVALID_QUERY', false))
      position = decodeDiagnosticCursor(cursor, keyId, config.JWT_SECRET)
      if (!position) return reply.code(400).send(errorResponse(request, 'INVALID_CURSOR', false))
      window = { from: new Date(position.from), until: new Date(position.until), status: position.status, limit: position.limit }
    } else {
      window = parseWindow(query)
    }
    if (!window) return reply.code(400).send(errorResponse(request, 'INVALID_QUERY', false))
    if (window.from.getTime() < Date.now() - 7 * 24 * 60 * 60_000) {
      return reply.code(410).send(errorResponse(request, 'EVENTS_EXPIRED', false))
    }
    const where: Prisma.AdminDiagnosticEventWhereInput = {
      createdAt: { gte: window.from, lte: window.until },
      ...(window.status === null ? {} : { statusCode: window.status }),
      ...(position ? { OR: [
        { createdAt: { lt: new Date(position.createdAt) } },
        { createdAt: new Date(position.createdAt), id: { lt: position.id } },
      ] } : {}),
    }
    try {
      const events = await db.adminDiagnosticEvent.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: window.limit + 1,
      })
      const page = events.slice(0, window.limit)
      const last = page.at(-1)
      const nextCursor = events.length > window.limit && last
        ? encodeDiagnosticCursor({
          keyId, from: window.from.toISOString(), until: window.until.toISOString(),
          status: window.status, limit: window.limit, createdAt: last.createdAt.toISOString(), id: last.id,
        }, config.JWT_SECRET) : null
      return sendAudited(request, reply, 'agent.logs', {
        events: page.map(eventDto), nextCursor,
        window: { from: window.from.toISOString(), until: window.until.toISOString() },
        capture: diagnosticCaptureStatus(),
      }, { source: 'admin-diagnostic-events', collectedAt: new Date().toISOString(), status: 'partial' })
    } catch {
      return reply.code(503).send(errorResponse(request, 'DIAGNOSTIC_STORE_UNAVAILABLE', true))
    }
  })

  fastify.get('/requests/:requestId', { preHandler: [agentAuth, logsRead] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const params = RequestParams.safeParse(request.params)
    if (!params.success) return reply.code(400).send(errorResponse(request, 'INVALID_REQUEST_ID', false))
    let application: Record<string, unknown>
    try {
      const events = await db.adminDiagnosticEvent.findMany({
        where: { requestId: params.data.requestId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
      })
      application = { status: 'partial', events: events.map(eventDto), coverage: '只记录错误、慢请求和异常；成功请求可能没有事件' }
    } catch {
      application = { status: 'unknown', events: [], reasonCode: 'DIAGNOSTIC_STORE_UNAVAILABLE' }
    }
    const gateway = await readGatewayEvents(config.ADMIN_GATEWAY_LOG_PATH, {
      from: new Date(Date.now() - 24 * 60 * 60_000), until: new Date(), requestId: params.data.requestId, limit: 20,
    })
    return sendAudited(request, reply, 'agent.request', {
      requestId: params.data.requestId, application, gateway,
      coverage: '网关仅扫描当前及一份轮转日志；未找到记录不证明请求不存在',
    }, { source: 'diagnostic-events-and-gateway-json', collectedAt: new Date().toISOString(), status: 'partial' })
  })

  fastify.get('/gateway', { preHandler: [agentAuth, logsRead] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const window = parseWindow(request.query)
    if (!window) return reply.code(400).send(errorResponse(request, 'INVALID_QUERY', false))
    const result = await readGatewayEvents(config.ADMIN_GATEWAY_LOG_PATH, {
      from: window.from, until: window.until, status: window.status ?? undefined, limit: window.limit,
    })
    return sendAudited(request, reply, 'agent.gateway', {
      ...result, window: { from: window.from.toISOString(), until: window.until.toISOString() },
      coverage: '仅当前及一份未压缩轮转日志，最多扫描 4 MiB；无记录不证明没有网关请求',
    }, { source: 'bounded-gateway-json', collectedAt: new Date().toISOString(), status: result.status === 'ok' ? 'partial' : 'unknown' })
  })
}
