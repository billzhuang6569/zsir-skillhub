import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const postgresUrl = process.env['SKILLHUB_PG_TEST_URL']
const describePostgres = postgresUrl ? describe : describe.skip

describePostgres('Admin Agent API with real PostgreSQL', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  const adminId = randomUUID()
  let cookie: string
  let csrf: string
  let agentKey: string
  let keyId: string

  beforeAll(async (): Promise<void> => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    const [{ adminAgentKeyRoutes }, { adminAgentApiRoutes }] = await Promise.all([
      import('./admin-agent-keys.js'), import('./admin-agent-api.js'),
    ])
    await prisma.user.create({ data: { id: adminId, email: `${adminId}@example.test`, displayName: 'Test Admin', marketplaceRole: 'admin' } })
    app = Fastify()
    await app.register(jwt, { secret: 'skillhub-agent-pg-test-secret-only' })
    await app.register(adminAgentKeyRoutes, { prefix: '/api/marketplace' })
    await app.register(adminAgentApiRoutes, { prefix: '/api/admin/v1' })
    await app.ready()
    cookie = `skillhub_admin_session=${app.jwt.sign({ sub: adminId, ver: 0, purpose: 'web-admin', webAdmin: true })}`
    const list = await app.inject({ url: '/api/marketplace/admin/agent-keys', headers: { cookie } })
    expect(list.statusCode).toBe(200)
    csrf = list.json().csrfToken as string
  })

  afterAll(async (): Promise<void> => {
    await app?.close()
    if (prisma) {
      if (keyId) {
        await prisma.adminAgentAuditEvent.deleteMany({ where: { keyId } })
        await prisma.adminAgentKey.delete({ where: { id: keyId } })
      }
      await prisma.user.deleteMany({ where: { id: adminId } })
      await prisma.$disconnect()
    }
  })

  it('creates once, reads all six interfaces, rejects downgrade and revoke', async () => {
    const adminHeaders = { cookie, origin: 'https://sk.woe.show', 'sec-fetch-site': 'same-origin', 'x-skillhub-csrf': csrf }
    const payload = { name: 'PG integration', scopes: ['ops:read'], clientOperationId: randomUUID() }
    const created = await app.inject({ method: 'POST', url: '/api/marketplace/admin/agent-keys', headers: adminHeaders, payload })
    expect(created.statusCode).toBe(201)
    agentKey = created.json().secret as string
    keyId = created.json().key.id as string
    const replay = await app.inject({ method: 'POST', url: '/api/marketplace/admin/agent-keys', headers: adminHeaders, payload })
    expect(replay.json()).not.toHaveProperty('secret')
    const headers = { authorization: `Bearer ${agentKey}` }
    for (const name of ['capabilities', 'overview', 'releases', 'migrations', 'jobs', 'storage']) {
      const result = await app.inject({ url: `/api/admin/v1/${name}`, headers })
      expect(result.statusCode, name).toBe(200)
      expect(result.json().requestId).toEqual(expect.any(String))
    }
    await prisma.user.update({ where: { id: adminId }, data: { marketplaceRole: 'user' } })
    expect((await app.inject({ url: '/api/admin/v1/capabilities', headers })).statusCode).toBe(401)
    await prisma.user.update({ where: { id: adminId }, data: { marketplaceRole: 'admin' } })
    const revoked = await app.inject({ method: 'POST', url: `/api/marketplace/admin/agent-keys/${keyId}/revoke`, headers: adminHeaders, payload: {} })
    expect(revoked.statusCode).toBe(200)
    expect((await app.inject({ url: '/api/admin/v1/capabilities', headers })).statusCode).toBe(401)
    expect(await prisma.adminAgentAuditEvent.count({ where: { keyId } })).toBe(8)
  })
})
