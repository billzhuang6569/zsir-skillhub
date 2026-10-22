import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { AiDraft, aiModels, aiPolicy, aiSettingsView, aiStatus, resolveAiDraft, saveAiDraft, testAiDraft } from '../lib/ai-settings.js'
import { utcDay } from '../lib/ai-budget.js'
import { AiServiceError, normalizeAllowedHost } from '../lib/ai-http.js'
import { deleteServerSetting, effectiveSource, getSettingSecret, SERVER_SETTING_DEFINITIONS, writeServerSetting } from '../lib/server-settings.js'
import { registrationView, storageUsage } from '../lib/instance-overview.js'
import { SERVER_BUILD_ID, SERVER_VERSION } from '../server-info.js'

export const instanceAiStatusRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.addHook('onSend', async (_request, reply, payload): Promise<typeof payload> => { reply.header('Cache-Control', 'no-store'); return payload })
  fastify.get('/ai/status', { preHandler: authMiddleware }, async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return reply.header('Cache-Control', 'no-store').send(aiStatus())
  })
}

function editable(key: 'ai' | 'registration'): void {
  if (effectiveSource(key) === 'env' || (key === 'registration' && !config.LOCAL_REGISTRATION_ENABLED)) throw new AiServiceError('ENV_OVERRIDE', 409)
}

/** Registered inside instance-settings: inherits administrator auth and no-store. */
export async function registerInstanceAi(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler((error, _request, reply) => {
    const known = error instanceof AiServiceError
    const code = known ? error.code : error instanceof z.ZodError || (error instanceof Error && 'statusCode' in error && error.statusCode === 400) ? 'INVALID_REQUEST' : 'INSTANCE_SETTINGS_UNAVAILABLE'
    return reply.code(known ? error.statusCode : code === 'INVALID_REQUEST' ? 400 : 503).send({ error: code, code })
  })
  fastify.get('/ai', async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => reply.send(aiSettingsView()))
  fastify.post('/ai/models', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const body = AiDraft.omit({ model: true }).parse(request.body)
    const draft = await resolveAiDraft({ ...body, model: 'models' })
    return reply.send({ models: await aiModels(draft) })
  })
  fastify.post('/ai/test', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const draft = await resolveAiDraft(AiDraft.parse(request.body))
    return reply.send(await testAiDraft(draft, request.user.id))
  })
  fastify.put('/ai', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    editable('ai')
    const { draftToken, ...body } = AiDraft.extend({ draftToken: z.string().max(128).optional() }).parse(request.body)
    if (!draftToken) throw new AiServiceError('TEST_REQUIRED', 409)
    const draft = await resolveAiDraft(body).catch(() => { throw new AiServiceError('TEST_REQUIRED', 409) })
    await saveAiDraft(draft, draftToken, request.user.id)
    return reply.send(aiSettingsView())
  })
  fastify.delete('/ai', async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    editable('ai')
    await deleteServerSetting('ai')
    return reply.code(204).send()
  })
  fastify.put('/ai/policy', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    editable('ai')
    const value = SERVER_SETTING_DEFINITIONS['ai.policy'].value.parse(request.body)
    value.allowedPrivateHosts = [...new Set(value.allowedPrivateHosts.map(normalizeAllowedHost))].sort()
    await writeServerSetting('ai.policy', { value }, request.user.id)
    return reply.send(aiSettingsView())
  })
  fastify.get('/registration', async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => reply.send(registrationView()))
  fastify.put('/registration', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    editable('registration')
    const body = z.object({ mode: z.enum(['open', 'invite', 'closed']), inviteCode: z.string().trim().min(16).max(512).optional() }).strict().parse(request.body)
    if (body.mode === 'invite' && !body.inviteCode && !await getSettingSecret('registration')) throw new AiServiceError('INVITE_CODE_REQUIRED')
    await writeServerSetting('registration', { value: { mode: body.mode }, ...(body.inviteCode ? { secret: body.inviteCode } : {}) }, request.user.id)
    return reply.send(registrationView())
  })
  fastify.post('/registration/regenerate', async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    editable('registration')
    const inviteCode = randomBytes(24).toString('base64url')
    await writeServerSetting('registration', { value: { mode: 'invite' }, secret: inviteCode }, request.user.id)
    return reply.send({ ...registrationView(), inviteCode })
  })
  fastify.get('/members', async (request: FastifyRequest<{ Querystring: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const query = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query)
    const [total, members] = await Promise.all([db.user.count(), db.user.findMany({ skip: query.offset, take: query.limit,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, email: true, displayName: true, marketplaceRole: true, createdAt: true } })])
    return reply.send({ total, members: members.map(({ marketplaceRole, ...member }) => ({ ...member, role: marketplaceRole === 'admin' ? 'admin' : 'member' })) })
  })
  fastify.put('/members/:id/role', async (request: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const id = z.string().uuid().parse(request.params.id)
    const { role } = z.object({ role: z.enum(['admin', 'member']) }).strict().parse(request.body)
    const member = await db.$transaction(async transaction => {
      // Serialize role changes and user deletion before counting administrators.
      await transaction.$executeRaw`LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE`
      const actor = await transaction.user.findUnique({ where: { id: request.user.id } })
      if (actor?.marketplaceRole !== 'admin') throw new AiServiceError('ADMIN_REQUIRED', 403)
      const target = await transaction.user.findUnique({ where: { id } })
      if (!target) throw new AiServiceError('MEMBER_NOT_FOUND', 404)
      if (target.marketplaceRole === 'admin' && role === 'member'
        && await transaction.user.count({ where: { marketplaceRole: 'admin' } }) <= 1) throw new AiServiceError('LAST_ADMIN', 409)
      const updated = await transaction.user.update({ where: { id }, data: { marketplaceRole: role === 'admin' ? 'admin' : 'user' },
        select: { id: true, email: true, displayName: true, createdAt: true } })
      return { ...updated, role }
    })
    request.log.info({ event: 'instance_member_role_changed', role }, 'Instance member role changed')
    return reply.send(member)
  })
  fastify.get('/overview', async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const [memberCount, storage, usage] = await Promise.all([db.user.count(), storageUsage(),
      db.aiDailyUsage.findUnique({ where: { day_userId: { day: utcDay(), userId: '*' } } })])
    const address = (baseUrl: string): object => ({ baseUrl, https: new URL(baseUrl).protocol === 'https:',
      certificate: new URL(baseUrl).protocol === 'https:' ? 'reverse_proxy' : 'not_applicable' })
    return reply.send({ memberCount, registration: registrationView(), addresses: {
      primary: address(config.PUBLIC_BASE_URL), additional: config.INSTANCE_ADDITIONAL_BASE_URLS.map(address),
    }, storage, aiUsage: { used: usage?.count ?? 0, limit: aiPolicy().limits.instanceDaily },
    minClientVersion: config.MIN_CLIENT_VERSION ?? null, version: { server: SERVER_VERSION, buildId: SERVER_BUILD_ID } })
  })
}
