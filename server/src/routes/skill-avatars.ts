import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { AttemptLimiter } from '../lib/attempt-limiter.js'
import {
  AVATAR_CUSTOM_ACTIVE, AvatarError, avatarAliasesByAvatar, avatarDto, ensureSkillAvatar, resolveAvatarKey,
  restoreGeneratedAvatar, retryFailedAvatar, uploadCustomAvatar,
} from '../lib/skill-avatars.js'
import { AvatarInput, LocalAvatarId } from '../lib/skill-avatar-input.js'
import { config } from '../config.js'
import { variantsMode, selectionDisplaySelect } from '../lib/avatar-selection.js'
import { resolveAccountAvatarStyle } from '../lib/avatar-jobs.js'
import { latestAvatarStyle } from '../lib/avatar-styles.js'
import { avatarStyleIdSchema } from '../lib/avatar-style-catalog.js'
import { lockUserMutation } from '../lib/mutation-lock.js'
import { applyAvatarStyle, avatarStyleScope, previewAvatarStyle } from '../lib/avatar-style-switch.js'

const LocalBody = AvatarInput.extend({ localSkillId: LocalAvatarId, aliasLocalIds: z.array(LocalAvatarId).max(4).optional(), skillId: z.string().uuid().optional() }).strict()
const LocalParams = z.object({ id: LocalAvatarId })
const CloudParams = z.object({ id: z.string().uuid() })
/** A cropped square image; the size and dimensions are checked from the bytes. */
const CustomImage = z.object({ mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']), dataBase64: z.string().min(1).max(2_800_000) }).strict()
const LocalCustomBody = LocalBody.extend({ image: CustomImage }).strict()
const CloudCustomBody = z.object({ image: CustomImage }).strict()
/** Room for a 2 MB image in base64 plus the identity and introduction. */
const CUSTOM_BODY_LIMIT = 4 * 1024 * 1024
const CUSTOM_PER_HOUR = 20
const ExportQuery = z.object({
  skillIds: z.string().transform(value => value.split(',')).pipe(z.array(z.string().uuid()).min(1).max(100)).optional(),
  localSkillIds: z.string().transform(value => value.split(',')).pipe(z.array(LocalAvatarId).min(1).max(100)).optional(),
}).strict().refine(value => (value.skillIds !== undefined) !== (value.localSkillIds !== undefined))

export const skillAvatarRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.addHook('preHandler', authMiddleware)
  fastify.addHook('onRequest', async (_request, reply): Promise<void> => { reply.header('Cache-Control', 'no-store, private') })
  const limiter = new AttemptLimiter()
  fastify.get('/export', async (request: FastifyRequest<{ Querystring: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const query = ExportQuery.safeParse(request.query)
    if (!query.success) return reply.badRequest('请指定一种 Skill ID，每次 1–100 个')
    const retryAfter = limiter.consume(`export:${request.user.id}`, 60, 60_000)
    if (retryAfter !== null) return reply.header('Retry-After', retryAfter).code(429).send({ error: '头像导出过于频繁', code: 'AVATAR_EXPORT_RATE_LIMITED' })
    const full = variantsMode()
    const avatars = await db.skillAvatar.findMany({
      where: { ownerId: request.user.id, status: { not: 'superseded' },
        ...(query.data.skillIds
          ? { skillId: { in: query.data.skillIds }, skill: { is: { authorId: request.user.id, deletedAt: null } } }
          : { localSkillId: { in: query.data.localSkillIds } }) },
      select: {
        id: true, skillId: true, localSkillId: true, source: true, status: true, url: true,
        imageSha256: true, updatedAt: true, customUrl: true, customUpdatedAt: true,
        currentJob: { select: { styleId: true, styleVersion: true, variant: { select: { id: true } } } },
        selection: { select: { source: true, variantId: true, customUrl: true, customUpdatedAt: true } },
        variants: { where: { job: { status: 'ready' } }, orderBy: [{ createdAt: 'desc' }, { generationRevision: 'desc' }],
          select: { id: true, styleId: true, styleVersion: true, url: true, imageSha256: true, createdAt: true } },
      },
      orderBy: { id: 'asc' },
    })
    const items = avatars.map(avatar => {
      const identity = { ...(avatar.skillId ? { skillId: avatar.skillId } : {}),
        ...(avatar.localSkillId ? { localSkillId: avatar.localSkillId } : {}), anchorId: avatar.id }
      const selection = full ? avatar.selection : avatar
      const custom = selection?.customUrl ? { url: selection.customUrl, updatedAt: selection.customUpdatedAt } : null
      const variants = avatar.variants.map(variant => ({ variantId: variant.id, styleId: variant.styleId,
        styleVersion: variant.styleVersion, url: variant.url, sha256: variant.imageSha256, createdAt: variant.createdAt }))
      if (!full) {
        const display = avatarDto({ source: avatar.source, status: avatar.status, url: avatar.url, customUrl: avatar.customUrl })
        if (display.avatarSource === 'custom') return { ...identity, selected: { kind: 'custom' }, variants: [], custom }
        if (!display.avatarUrl) return { ...identity, selected: null, variants: [], custom: null }
        // Pre-model legacy rows have only one classic image and no variant identity.
        const variant = variants.find(value => value.variantId === avatar.currentJob?.variant?.id && value.url === display.avatarUrl)
          ?? variants.find(value => value.url === display.avatarUrl && (!avatar.currentJob
            || (value.styleId === avatar.currentJob.styleId && value.styleVersion === avatar.currentJob.styleVersion))) ?? {
          variantId: avatar.id, styleId: avatar.currentJob?.styleId ?? 'classic', styleVersion: avatar.currentJob?.styleVersion ?? 1,
          url: display.avatarUrl, sha256: avatar.imageSha256, createdAt: avatar.updatedAt,
        }
        return { ...identity, selected: { kind: 'generated', variantId: variant.variantId }, variants: [variant], custom: null }
      }
      // Match selectionAvatar's latest-history fallback when no variant is explicitly selected.
      const selectedVariant = avatar.selection ? variants.find(value => value.variantId === avatar.selection?.variantId) ?? variants[0] : undefined
      const selected = selection?.source === 'custom' && custom ? { kind: 'custom' }
        : selectedVariant ? { kind: 'generated', variantId: selectedVariant.variantId } : null
      return { ...identity, selected, variants, custom }
    })
    return reply.send({ items, ...(!full ? { partial: true } : {}) })
  })
  const StyleBody = z.object({ styleId: avatarStyleIdSchema.nullable() }).strict()
  fastify.get('/style', async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (!variantsMode()) return reply.notFound()
    const { accountStyleId, instanceStyleId, style } = await resolveAccountAvatarStyle(db, request.user.id)
    return reply.send({ accountStyleId, instanceStyleId, styleId: style.styleId, styleVersion: style.styleVersion,
      scope: avatarStyleScope(), canManage: avatarStyleScope() === 'account' || request.user.marketplaceRole === 'admin' })
  })
  fastify.post('/style/preview', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    if (!variantsMode()) return reply.notFound()
    if (avatarStyleScope() === 'instance' && request.user.marketplaceRole !== 'admin') return reply.forbidden('头像风格由实例管理员设置')
    const body = StyleBody.safeParse(request.body)
    if (!body.success) return reply.badRequest('头像风格无效')
    return reply.send(await previewAvatarStyle(request.user.id, body.data.styleId))
  })
  fastify.post('/style/apply', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    if (!variantsMode()) return reply.notFound()
    if (avatarStyleScope() === 'instance' && request.user.marketplaceRole !== 'admin') return reply.forbidden('头像风格由实例管理员设置')
    const body = StyleBody.extend({ mode: z.enum(['newOnly', 'applyExisting']), includeCustom: z.boolean().optional() }).safeParse(request.body)
    if (!body.success) return reply.badRequest('头像风格无效')
    return reply.send(await applyAvatarStyle(request.user.id, body.data))
  })
  fastify.put('/style', async (request: FastifyRequest<{ Body: z.infer<typeof StyleBody> }>, reply: FastifyReply): Promise<FastifyReply> => {
    if (!variantsMode()) return reply.notFound()
    if (config.SKILLHUB_PROFILE === 'selfhost') return reply.forbidden('头像风格由实例管理员设置')
    const body = StyleBody.safeParse(request.body)
    if (!body.success) return reply.badRequest('头像风格无效')
    const resolved = await db.$transaction(async tx => {
      await lockUserMutation(tx, request.user.id)
      if (body.data.styleId && !await latestAvatarStyle(body.data.styleId, tx)) throw new AvatarError(400, '头像风格不可用', 'AVATAR_STYLE_UNAVAILABLE')
      await tx.user.update({ where: { id: request.user.id }, data: { avatarStyleId: body.data.styleId } })
      return resolveAccountAvatarStyle(tx, request.user.id)
    })
    return reply.send({ accountStyleId: resolved.accountStyleId, instanceStyleId: resolved.instanceStyleId, styleId: resolved.style.styleId, styleVersion: resolved.style.styleVersion })
  })
  fastify.setErrorHandler((error, request, reply): void => {
    if (error instanceof AvatarError) {
      if (error.retryAfterSeconds !== undefined) void reply.header('Retry-After', String(error.retryAfterSeconds))
      void reply.code(error.statusCode).send({ error: error.message, ...(error.code ? { code: error.code } : {}) })
      return
    }
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
      && error.statusCode >= 400 && error.statusCode < 500) {
      void reply.code(error.statusCode).send({ error: '头像请求无效' }); return
    }
    request.log.warn('Skill avatar request failed')
    void reply.code(503).send({ error: '头像服务暂时不可用，请稍后重试' })
  })
  fastify.get('/local', async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    // Local tasks, plus the owner's tasks for their own live cloud Skills that have no
    // local key: a cloud-only Skill reads its display source (custom / generated) here
    // in every session and on every device, without an ensure that could queue paid work.
    const avatars = await db.skillAvatar.findMany({
      where: { ownerId: request.user.id, status: { not: 'superseded' },
        OR: [{ localSkillId: { not: null } }, { skillId: { not: null }, skill: { is: { authorId: request.user.id, deletedAt: null } } }] },
      select: { id: true, localSkillId: true, skillId: true, url: true, status: true, source: true, customUrl: true,
        selection: { select: selectionDisplaySelect } },
    })
    // `aliases` lets a parked client verify canonical + alias relations from
    // the server instead of guessing from the absence of conflicting rows.
    const aliases = await avatarAliasesByAvatar(request.user.id, avatars.map(avatar => avatar.id))
    return reply.send({ items: avatars.map(avatar => ({
      localSkillId: avatar.localSkillId, skillId: avatar.skillId, aliases: aliases.get(avatar.id) ?? [], ...avatarDto(avatar),
    })) })
  })
  fastify.post('/local', async (request: FastifyRequest<{ Body: z.infer<typeof LocalBody> }>, reply: FastifyReply): Promise<FastifyReply> => {
    const body = LocalBody.safeParse(request.body)
    if (!body.success) return reply.badRequest('Skill 介绍或本地身份无效')
    const retryAfter = limiter.consume(request.user.id, 60, 60 * 60 * 1_000)
    if (retryAfter !== null) return reply.header('Retry-After', retryAfter).code(429).send({ error: '头像请求过于频繁', code: 'AVATAR_RATE_LIMITED' })
    const { localSkillId, aliasLocalIds, skillId, ...input } = body.data
    const avatar = await ensureSkillAvatar({ ownerId: request.user.id, localSkillId, aliasLocalIds, skillId, input })
    return reply.send({ localSkillId: avatar.localSkillId ?? localSkillId, skillId: avatar.skillId, ...avatarDto(avatar) })
  })
  fastify.post('/skills/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    const params = CloudParams.safeParse(request.params)
    if (!params.success) return reply.badRequest('Skill 身份无效')
    const avatar = await ensureSkillAvatar({ ownerId: request.user.id, skillId: params.data.id })
    return reply.send(avatarDto(avatar))
  })
  fastify.post('/local/:id/retry', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    const params = LocalParams.safeParse(request.params)
    if (!params.success) return reply.badRequest('本地 Skill 身份无效')
    const retryAfter = limiter.consume(`retry:${request.user.id}`, 10, 60 * 60 * 1_000)
    if (retryAfter !== null) return reply.header('Retry-After', retryAfter).code(429).send({ error: '头像恢复请求过于频繁', code: 'AVATAR_RETRY_RATE_LIMITED' })
    // Same account-scoped resolution as ensure: a canonical id or an old
    // alias of it reaches the one task; another account's keys never do.
    const avatar = await resolveAvatarKey(db, request.user.id, params.data.id)
    if (!avatar) return reply.notFound('头像不存在')
    if (avatar.source === 'custom') return reply.code(409).send({ error: '当前使用自定义头像，恢复自动生成后才能重试', code: AVATAR_CUSTOM_ACTIVE })
    if (avatar.status === 'needs_review') return reply.conflict('提交结果待核对，暂不能重新生成')
    if (avatar.status !== 'failed') return reply.send(avatarDto(avatar))
    // Retry an existing provider request or transfer (free); never redraw an accepted request.
    // Only a redraw spends daily quota, and only the request that moves the task out of `failed`.
    const result = await retryFailedAvatar(request.user.id, avatar.id)
    return reply.send(result.transitioned && !variantsMode() ? { avatarUrl: null, avatarStatus: 'pending', avatarSource: 'generated' } : avatarDto(result.avatar))
  })

  // Custom avatars (#214): upload and 恢复自动生成 share one per-account hourly budget.
  const customRateLimited = (request: FastifyRequest, reply: FastifyReply): FastifyReply | null => {
    const retryAfter = limiter.consume(`custom:${request.user.id}`, CUSTOM_PER_HOUR, 60 * 60 * 1_000)
    return retryAfter === null ? null : reply.header('Retry-After', retryAfter).code(429).send({ error: '上传过于频繁', code: 'AVATAR_CUSTOM_RATE_LIMITED' })
  }
  fastify.post('/local/custom', { bodyLimit: CUSTOM_BODY_LIMIT }, async (request: FastifyRequest<{ Body: z.infer<typeof LocalCustomBody> }>, reply: FastifyReply): Promise<FastifyReply> => {
    const body = LocalCustomBody.safeParse(request.body)
    if (!body.success) return reply.badRequest('头像图片、Skill 介绍或本地身份无效')
    const limited = customRateLimited(request, reply)
    if (limited) return limited
    const { localSkillId, aliasLocalIds, skillId, image, ...input } = body.data
    const avatar = await uploadCustomAvatar({ ownerId: request.user.id, localSkillId, aliasLocalIds, skillId, input, image })
    return reply.send({ localSkillId: avatar.localSkillId ?? localSkillId, skillId: avatar.skillId, ...avatarDto(avatar) })
  })
  fastify.post('/skills/:id/custom', { bodyLimit: CUSTOM_BODY_LIMIT }, async (request: FastifyRequest<{ Params: { id: string }; Body: z.infer<typeof CloudCustomBody> }>, reply: FastifyReply): Promise<FastifyReply> => {
    const params = CloudParams.safeParse(request.params)
    const body = CloudCustomBody.safeParse(request.body)
    if (!params.success || !body.success) return reply.badRequest('头像图片或 Skill 身份无效')
    const limited = customRateLimited(request, reply)
    if (limited) return limited
    const avatar = await uploadCustomAvatar({ ownerId: request.user.id, skillId: params.data.id, image: body.data.image })
    return reply.send(avatarDto(avatar))
  })
  fastify.delete('/local/:id/custom', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    const params = LocalParams.safeParse(request.params)
    if (!params.success) return reply.badRequest('本地 Skill 身份无效')
    const limited = customRateLimited(request, reply)
    if (limited) return limited
    const avatar = await restoreGeneratedAvatar(request.user.id, { localSkillId: params.data.id })
    return reply.send({ localSkillId: avatar.localSkillId, skillId: avatar.skillId, ...avatarDto(avatar) })
  })
  fastify.delete('/skills/:id/custom', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    const params = CloudParams.safeParse(request.params)
    if (!params.success) return reply.badRequest('Skill 身份无效')
    const limited = customRateLimited(request, reply)
    if (limited) return limited
    const avatar = await restoreGeneratedAvatar(request.user.id, { skillId: params.data.id })
    return reply.send(avatarDto(avatar))
  })
}
