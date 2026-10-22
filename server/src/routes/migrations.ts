import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '../db.js'
import { config } from '../config.js'
import { authMiddleware } from '../middleware/auth.js'
import { AttemptLimiter } from '../lib/attempt-limiter.js'
import { CatalogAuthorshipError } from '../lib/skill-cards.js'
import { MigrationBody, ItemPlan, ImportBody, AvatarUploadBody, MigrationError, ownedMigration, precheckMigration, importMigrationItem, uploadMigrationAvatar, migrationLimits } from '../lib/skill-migrations.js'

const Params = z.object({ migrationId: z.string().uuid() })
type MigrationParams = z.infer<typeof Params>
const PrecheckBody = z.object({ items: z.array(ItemPlan).max(1000) }).strict()

export const migrationRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.addHook('onRequest', authMiddleware)
  const writes = new AttemptLimiter()
  fastify.addHook('preHandler', async (request, reply): Promise<void> => {
    if (request.method !== 'POST') return
    const retry = writes.consume(request.user.id, config.MIGRATION_WRITES_PER_HOUR, 60 * 60 * 1000)
    if (retry !== null) return reply.header('Retry-After', retry).code(429).send({ code: 'MIGRATION_RATE_LIMIT', error: 'Too many migration requests' })
  })
  fastify.setErrorHandler((error, request, reply): void => {
    if (error instanceof CatalogAuthorshipError) { void reply.code(error.statusCode).send({ code: error.code, error: error.message }); return }
    if (error instanceof MigrationError) { void reply.code(error.statusCode).send({ code: error.code, error: error.code, ...(error.existingSkillId ? { existingSkillId: error.existingSkillId } : {}) }); return }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const codes: Record<string, string> = { P2002: 'MIGRATION_UNIQUE_CONFLICT', P2003: 'MIGRATION_REFERENCE_CONFLICT',
        P2004: 'MIGRATION_CONSTRAINT_CONFLICT', P2011: 'MIGRATION_CONSTRAINT_CONFLICT', P2014: 'MIGRATION_RELATION_CONFLICT', P2025: 'MIGRATION_TARGET_CONFLICT', P2034: 'MIGRATION_WRITE_CONFLICT' }
      if (codes[error.code]) { void reply.code(409).send({ code: codes[error.code] }); return }
    }
    // Prisma/provider errors can embed content or metadata. Never serialize the original error.
    const receivedStatus = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 503
    const statusCode = receivedStatus >= 400 && receivedStatus < 500 ? receivedStatus : 503
    if (statusCode === 503) request.log.warn({ code: 'MIGRATION_UNAVAILABLE' }, 'Migration request failed')
    void reply.code(statusCode).send({ code: statusCode === 413 ? 'MIGRATION_BODY_TOO_LARGE' : statusCode === 400 ? 'MIGRATION_INVALID_REQUEST' : 'MIGRATION_UNAVAILABLE' })
  })
  fastify.post<{ Body: unknown }>('/', async (request, reply: FastifyReply): Promise<FastifyReply> => {
    const parsed = MigrationBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ code: 'MIGRATION_INVALID_REQUEST' })
    const { source, protocolVersion } = parsed.data
    const migration = await db.skillMigration.create({ data: { targetUserId: request.user.id, sourceProfile: source.profile, sourceOrigin: source.origin, sourceUserId: source.userId, protocolVersion } })
    return reply.code(201).send({ ...migration, limits: migrationLimits() })
  })
  fastify.get<{ Params: MigrationParams }>('/:migrationId', async (request, reply: FastifyReply): Promise<FastifyReply> => {
    if (!Params.safeParse(request.params).success) return reply.code(400).send({ code: 'MIGRATION_INVALID_REQUEST' })
    const migration = await ownedMigration(request.user.id, request.params.migrationId)
    const items = await db.skillMigrationItem.findMany({ where: { migrationId: migration.id }, select: { operationKey: true, result: true, statusCode: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const avatars = await db.skillMigrationAvatar.findMany({ where: { migrationId: migration.id }, select: { operationKey: true, avatarId: true, code: true }, orderBy: [{ operationKey: 'asc' }, { avatarId: 'asc' }] })
    return reply.send({ ...migration, items, avatarUploads: avatars.map(avatar => ({ ...avatar, status: avatar.code ? 'skipped' : 'uploaded' })) })
  })
  fastify.post<{ Params: MigrationParams; Body: unknown }>('/:migrationId/precheck', async (request, reply: FastifyReply): Promise<FastifyReply> => {
    if (!Params.safeParse(request.params).success) return reply.code(400).send({ code: 'MIGRATION_INVALID_REQUEST' })
    const migration = await ownedMigration(request.user.id, request.params.migrationId)
    const parsed = PrecheckBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ code: 'MIGRATION_INVALID_REQUEST' })
    return reply.send(await precheckMigration(request.user.id, migration, parsed.data.items))
  })
  fastify.post<{ Params: MigrationParams; Body: unknown }>('/:migrationId/items', { bodyLimit: 30 * 1024 * 1024 }, async (request, reply: FastifyReply): Promise<FastifyReply> => {
    if (!Params.safeParse(request.params).success) return reply.code(400).send({ code: 'MIGRATION_INVALID_REQUEST' })
    await ownedMigration(request.user.id, request.params.migrationId)
    const parsed = ImportBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ code: 'MIGRATION_INVALID_REQUEST' })
    if (!request.verifiedAuthToken) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    const outcome = await importMigrationItem(request.user.id, request.params.migrationId, parsed.data, request.verifiedAuthToken.ver)
    return reply.code(outcome.statusCode).send(outcome.result)
  })
  fastify.post<{ Params: MigrationParams; Body: unknown }>('/:migrationId/avatars', { bodyLimit: 8 * 1024 * 1024 }, async (request, reply: FastifyReply): Promise<FastifyReply> => {
    if (!Params.safeParse(request.params).success) return reply.code(400).send({ code: 'MIGRATION_INVALID_REQUEST' })
    await ownedMigration(request.user.id, request.params.migrationId)
    const parsed = AvatarUploadBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ code: 'MIGRATION_INVALID_REQUEST' })
    if (!request.verifiedAuthToken) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    return reply.send(await uploadMigrationAvatar(request.user.id, request.params.migrationId, parsed.data, request.verifiedAuthToken.ver))
  })
}
