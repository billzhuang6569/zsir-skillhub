import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db.js'

const SLOW_REQUEST_MS = 2_000
const MAX_QUEUE = 1_000
const FLUSH_BATCH = 50
const RETENTION_DAYS = 7
const CLEANUP_BATCH = 1_000
const MAX_STORED_ROWS = 100_000
const ROUTE_PATTERN = /^[/][a-zA-Z0-9_/:.*-]{1,160}$/
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

type EventInput = {
  id: string
  createdAt: Date
  requestId: string
  method: string
  route: string
  statusCode: number
  durationMs: number
  eventCode: string
  fingerprint: string
}

const startedAt = new Date()
let dropped = 0
let writeFailures = 0
let lastWriteFailureAt: Date | null = null
let queued = 0

export function diagnosticCaptureStatus(): Record<string, unknown> {
  return {
    startedAt: startedAt.toISOString(),
    queued,
    dropped,
    writeFailures,
    lastWriteFailureAt: lastWriteFailureAt?.toISOString() ?? null,
    coverage: '仅记录状态码不小于 400、超过 2 秒或抛出异常的请求；进程重启后计数重新开始',
  }
}

export function safeDiagnosticRoute(route: string | undefined): string {
  return route && ROUTE_PATTERN.test(route) ? route : 'unknown'
}

export function diagnosticEvent(
  request: FastifyRequest,
  reply: FastifyReply,
  durationMs: number,
  failedWithException: boolean,
): EventInput | null {
  const statusCode = reply.statusCode
  if (statusCode < 400 && durationMs < SLOW_REQUEST_MS && !failedWithException) return null
  const route = safeDiagnosticRoute(request.routeOptions.url)
  const method = METHODS.has(request.method) ? request.method : 'OTHER'
  const eventCode = failedWithException ? 'UNHANDLED_EXCEPTION' : statusCode >= 400 ? 'HTTP_' + statusCode : 'SLOW_REQUEST'
  const fingerprint = createHash('sha256').update([method, route, statusCode, eventCode].join('|')).digest('hex').slice(0, 24)
  return {
    id: randomUUID(),
    createdAt: new Date(),
    requestId: /^[0-9a-f]{32}$/.test(request.id) ? request.id : 'unknown',
    method,
    route,
    statusCode,
    durationMs: Math.min(Math.max(0, Math.round(durationMs)), 2_147_483_647),
    eventCode,
    fingerprint,
  }
}

export function registerDiagnosticCapture(server: FastifyInstance): () => Promise<void> {
  const started = new WeakMap<FastifyRequest, number>()
  const exceptions = new WeakSet<FastifyRequest>()
  const queue: EventInput[] = []
  let flushing: Promise<void> | null = null
  let cleaning = false

  async function flush(): Promise<void> {
    if (flushing) return flushing
    if (queue.length === 0) return
    const batch = queue.splice(0, FLUSH_BATCH)
    queued = queue.length
    flushing = (async () => {
      try {
        await db.adminDiagnosticEvent.createMany({ data: batch })
      } catch {
        writeFailures += 1
        dropped += batch.length
        lastWriteFailureAt = new Date()
        server.log.warn('Admin diagnostic event batch could not be stored')
      } finally {
        flushing = null
      }
    })()
    await flushing
  }

  async function cleanup(): Promise<void> {
    if (cleaning) return
    cleaning = true
    try {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60_000)
      await db.$executeRaw`
        DELETE FROM "admin_diagnostic_events" WHERE "id" IN (
          SELECT "id" FROM "admin_diagnostic_events"
          WHERE "createdAt" < ${cutoff}
          ORDER BY "createdAt", "id" LIMIT ${CLEANUP_BATCH}
        )
      `
      await db.$executeRaw`
        DELETE FROM "admin_diagnostic_events" WHERE "id" IN (
          SELECT "id" FROM "admin_diagnostic_events"
          ORDER BY "createdAt" DESC, "id" DESC
          OFFSET ${MAX_STORED_ROWS} LIMIT ${CLEANUP_BATCH}
        )
      `
    } catch {
      server.log.warn('Admin diagnostic event cleanup could not run')
    } finally {
      cleaning = false
    }
  }

  server.addHook('onRequest', async (request): Promise<void> => {
    started.set(request, performance.now())
  })
  server.addHook('onError', async (request): Promise<void> => {
    exceptions.add(request)
  })
  server.addHook('onResponse', async (request, reply): Promise<void> => {
    const begin = started.get(request)
    const event = diagnosticEvent(request, reply, begin === undefined ? 0 : performance.now() - begin, exceptions.has(request))
    if (!event) return
    if (queue.length >= MAX_QUEUE) {
      dropped += 1
      return
    }
    queue.push(event)
    queued = queue.length
  })

  const flushTimer = setInterval(() => { void flush() }, 500)
  const cleanupTimer = setInterval(() => { void cleanup() }, 60_000)
  flushTimer.unref()
  cleanupTimer.unref()
  void cleanup()
  return async () => {
    clearInterval(flushTimer)
    clearInterval(cleanupTimer)
    while (queue.length > 0 || flushing) await flush()
  }
}
