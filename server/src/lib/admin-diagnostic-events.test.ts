import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { diagnosticEvent, registerDiagnosticCapture, safeDiagnosticRoute } from './admin-diagnostic-events.js'

const mockDb = vi.hoisted(() => ({
  adminDiagnosticEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  $executeRaw: vi.fn().mockResolvedValue(0),
}))
vi.mock('../db.js', () => ({ db: mockDb }))

function request(route: string, method = 'GET'): FastifyRequest {
  return {
    id: 'a'.repeat(32),
    method,
    url: '/skills/secret?token=private',
    headers: { authorization: 'Bearer private' },
    routeOptions: { url: route },
  } as unknown as FastifyRequest
}

function reply(statusCode: number): FastifyReply {
  return { statusCode } as FastifyReply
}

describe('safe diagnostic capture', () => {
  it('keeps only route templates and fixed fields', () => {
    const event = diagnosticEvent(request('/skills/:id'), reply(503), 73.8, false)
    expect(event).toMatchObject({
      requestId: 'a'.repeat(32), method: 'GET', route: '/skills/:id',
      statusCode: 503, durationMs: 74, eventCode: 'HTTP_503',
    })
    expect(event?.fingerprint).toMatch(/^[0-9a-f]{24}$/)
    expect(JSON.stringify(event)).not.toMatch(/secret|private|authorization|token/)
    expect(safeDiagnosticRoute('/skills/secret?token=private')).toBe('unknown')
    expect(diagnosticEvent(request('/ready', 'SECRET'), reply(400), 10, false)?.method).toBe('OTHER')
  })

  it('skips fast success but records slow or exceptional responses', () => {
    expect(diagnosticEvent(request('/ready'), reply(200), 50, false)).toBeNull()
    expect(diagnosticEvent(request('/ready'), reply(200), 2_100, false)?.eventCode).toBe('SLOW_REQUEST')
    expect(diagnosticEvent(request('/ready'), reply(500), 50, true)?.eventCode).toBe('UNHANDLED_EXCEPTION')
  })

  it('persists only selected Fastify responses through the bounded hook', async () => {
    vi.clearAllMocks()
    const server = Fastify()
    const stop = registerDiagnosticCapture(server)
    server.get('/ok', async () => ({ message: 'ok' }))
    server.get('/failure/:id', async (_request, reply) => reply.code(503).send({ secret: 'private' }))
    await server.ready()
    expect((await server.inject('/ok')).statusCode).toBe(200)
    expect((await server.inject('/failure/secret')).statusCode).toBe(503)
    await stop()
    expect(mockDb.adminDiagnosticEvent.createMany).toHaveBeenCalledTimes(1)
    const events = mockDb.adminDiagnosticEvent.createMany.mock.calls[0][0].data
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ route: '/failure/:id', statusCode: 503, eventCode: 'HTTP_503' })
    expect(JSON.stringify(events)).not.toContain('private')
    expect(JSON.stringify(events)).not.toContain('/failure/secret')
    await server.close()
  })
})
