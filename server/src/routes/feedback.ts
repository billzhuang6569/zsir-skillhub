import { createHash, randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import { AttemptLimiter } from '../lib/attempt-limiter.js'
import {
  MAX_FEEDBACK_ATTACHMENTS,
  MAX_FEEDBACK_REQUEST_BYTES,
  parseStoredFeedbackAttachments,
  readFeedbackAttachment,
  removeFeedbackAttachments,
  storeFeedbackAttachments,
} from '../lib/feedback-attachments.js'
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js'
import { MediaError } from '../lib/media.js'

const FeedbackType = z.enum(['bug', 'usage', 'feature', 'other'])
const FeedbackStatus = z.enum(['pending', 'reviewing', 'resolved'])
const FeedbackAttachment = z.object({
  fileName: z.string().trim().min(1).max(160),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  dataBase64: z.string().min(4).max(7_000_000),
})
const FeedbackDiagnostics = z.object({
  schemaVersion: z.literal(1),
  source: z.literal('skillhub-cli'),
  appVersion: z.string().trim().min(1).max(64),
  platform: z.enum(['darwin', 'windows']),
  architecture: z.enum(['aarch64', 'x86_64']),
}).strict()

const CreateFeedbackBody = z.object({
  type: FeedbackType,
  content: z.string().trim().min(1).max(2_000),
  contact: z.string().trim().max(200).optional().transform((value) => value || undefined),
  attachments: z.array(FeedbackAttachment).max(MAX_FEEDBACK_ATTACHMENTS).optional().default([]),
  diagnostics: FeedbackDiagnostics.optional(),
  clientOperationId: z.string().uuid().optional(),
})

const UpdateFeedbackBody = z.object({ status: FeedbackStatus })
const FeedbackQuery = z.object({ status: FeedbackStatus.optional() })
const FeedbackParams = z.object({ id: z.string().uuid() })
const FeedbackAttachmentParams = z.object({
  id: z.string().uuid(),
  attachmentId: z.string().uuid(),
})
const FeedbackOperationParams = z.object({ clientOperationId: z.string().uuid() })
const FeedbackGuestScope = z.string().regex(/^[a-f0-9]{64}$/)

type CreateFeedback = z.infer<typeof CreateFeedbackBody>
type FeedbackOperation = {
  id: string
  status: string
  createdAt: Date
  requestDigest: string | null
}

const operationResultSelect = {
  id: true,
  status: true,
  createdAt: true,
  requestDigest: true,
} as const
const adminFeedbackSelect = {
  id: true,
  userId: true,
  type: true,
  content: true,
  contact: true,
  attachments: true,
  diagnostics: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, displayName: true, email: true } },
} as const

const publicFeedbackResult = (feedback: FeedbackOperation): {
  id: string
  status: string
  createdAt: Date
} => ({
  id: feedback.id,
  status: feedback.status,
  createdAt: feedback.createdAt,
})

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function feedbackOperationScopeHash(request: FastifyRequest): string {
  if (request.verifiedAuthToken && request.user) return sha256(`user\0${request.user.id}`)
  const clientScope = request.headers['x-skillhub-feedback-guest-scope']
  if (typeof clientScope === 'string' && FeedbackGuestScope.safeParse(clientScope).success) {
    return sha256(`guest-client\0${clientScope}`)
  }
  return sha256(`guest\0${request.ip}\0${request.headers['user-agent'] ?? ''}`)
}

function feedbackRequestDigest(body: CreateFeedback): string {
  return sha256(JSON.stringify({
    type: body.type,
    content: body.content,
    contact: body.contact ?? null,
    diagnostics: body.diagnostics ?? {},
    attachments: body.attachments.map((attachment) => ({
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      contentSha256: sha256(Buffer.from(attachment.dataBase64, 'base64')),
    })),
  }))
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'P2002'
}

async function findFeedbackOperation(
  operationScopeHash: string,
  clientOperationId: string
): Promise<FeedbackOperation | null> {
  return db.feedback.findUnique({
    where: {
      operationScopeHash_clientOperationId: { operationScopeHash, clientOperationId },
    },
    select: operationResultSelect,
  })
}

function sendOperationReplay(
  reply: FastifyReply,
  feedback: FeedbackOperation,
  requestDigest: string
): FastifyReply {
  if (feedback.requestDigest !== requestDigest) {
    return reply.code(409).send({
      code: 'FEEDBACK_OPERATION_CONFLICT',
      error: 'Feedback operation conflict',
    })
  }
  return reply.code(200).send(publicFeedbackResult(feedback))
}

export const feedbackRoutes: FastifyPluginAsync = async (fastify) => {
  const attempts = new AttemptLimiter()

  fastify.post('/', {
    onRequest: optionalAuthMiddleware,
    bodyLimit: MAX_FEEDBACK_REQUEST_BYTES,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    const body = CreateFeedbackBody.safeParse(request.body)
    let operationScopeHash: string | undefined
    let requestDigest: string | undefined
    if (body.success && body.data.clientOperationId) {
      operationScopeHash = feedbackOperationScopeHash(request)
      requestDigest = feedbackRequestDigest(body.data)
      const existing = await findFeedbackOperation(operationScopeHash, body.data.clientOperationId)
      if (existing) return sendOperationReplay(reply, existing, requestDigest)
    }

    const retryAfter = attempts.consume(
      `feedback:${request.ip}`,
      config.FEEDBACK_ATTEMPTS_PER_HOUR,
      60 * 60 * 1_000
    )
    if (retryAfter !== null) {
      reply.header('Retry-After', String(retryAfter))
      return reply.code(429).send({ error: 'Too many feedback submissions. Try again later.' })
    }
    if (!body.success) return reply.code(400).send({ error: 'Invalid feedback data' })
    if (body.data.attachments.length && !request.verifiedAuthToken) return reply.code(401).send({ error: '请登录后上传反馈图片' })

    const digestId = operationScopeHash && body.data.clientOperationId
      ? sha256(`${operationScopeHash}\0${body.data.clientOperationId}`).slice(0, 32) : null
    const feedbackId = digestId
      ? `${digestId.slice(0, 8)}-${digestId.slice(8, 12)}-4${digestId.slice(13, 16)}-8${digestId.slice(17, 20)}-${digestId.slice(20)}`
      : randomUUID()
    const submit = async (): Promise<FastifyReply> => {
    if (operationScopeHash && body.data.clientOperationId && requestDigest) {
      const existing = await findFeedbackOperation(operationScopeHash, body.data.clientOperationId)
      if (existing) return sendOperationReplay(reply, existing, requestDigest)
    }
    let attachments
    try {
      attachments = await storeFeedbackAttachments(
        feedbackId,
        body.data.attachments
      )
    } catch (error: unknown) {
      request.log.warn({ errorType: error instanceof Error ? error.name : 'unknown', attachmentCount: body.data.attachments.length }, 'Feedback attachment rejected')
      if (error instanceof MediaError) return reply.code(error.statusCode).send({ error: error.message })
      return reply.code(400).send({ error: 'Invalid feedback attachment' })
    }
    try {
      const feedback = await db.feedback.create({
        data: {
          id: feedbackId,
          userId: request.verifiedAuthToken ? request.user.id : null,
          type: body.data.type,
          content: body.data.content,
          contact: body.data.contact,
          attachments,
          diagnostics: body.data.diagnostics ?? {},
          clientOperationId: body.data.clientOperationId,
          operationScopeHash,
          requestDigest,
        },
        select: operationResultSelect,
      })
      return reply.code(201).send(publicFeedbackResult(feedback))
    } catch (error: unknown) {
      if (body.data.clientOperationId && operationScopeHash && requestDigest) {
        const existing = await findFeedbackOperation(operationScopeHash, body.data.clientOperationId)
        if (existing) return sendOperationReplay(reply, existing, requestDigest)
      }
      try {
        await removeFeedbackAttachments(feedbackId)
      } catch (cleanupError: unknown) {
        request.log.error({ cleanupError, feedbackId }, 'Feedback attachment cleanup failed')
      }
      if (
        body.data.clientOperationId
        && operationScopeHash
        && requestDigest
        && isUniqueConstraintError(error)
      ) {
        const existing = await findFeedbackOperation(operationScopeHash, body.data.clientOperationId)
        if (existing) return sendOperationReplay(reply, existing, requestDigest)
      }
      throw error
    }
    }
    if (body.data.attachments.length && body.data.clientOperationId) {
      // ponytail: hold one operation lock during upload; move to a worker if upload throughput requires it.
      return db.$transaction(async transaction => {
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`feedback:${feedbackId}`}, 0))`
        return submit()
      }, { timeout: 600_000 })
    }
    return submit()
  })

  fastify.get<{ Params: { clientOperationId: string } }>(
    '/operations/:clientOperationId',
    { onRequest: optionalAuthMiddleware },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const params = FeedbackOperationParams.safeParse(request.params)
      if (!params.success) return reply.code(400).send({ error: 'Invalid feedback operation id' })
      const feedback = await findFeedbackOperation(
        feedbackOperationScopeHash(request),
        params.data.clientOperationId
      )
      if (!feedback) return reply.code(404).send({ error: 'Feedback operation not found' })
      return reply.send(publicFeedbackResult(feedback))
    }
  )

  fastify.get<{ Querystring: { status?: string } }>('/', { onRequest: authMiddleware }, async (request, reply) => {
    if (request.user.marketplaceRole !== 'admin') return reply.forbidden()
    const query = FeedbackQuery.safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: 'Invalid feedback query' })
    return db.feedback.findMany({
      where: query.data.status ? { status: query.data.status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: adminFeedbackSelect,
    })
  })

  fastify.patch<{ Params: { id: string } }>('/:id', { onRequest: authMiddleware }, async (request, reply) => {
    if (request.user.marketplaceRole !== 'admin') return reply.forbidden()
    const params = FeedbackParams.safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: 'Invalid feedback id' })
    const body = UpdateFeedbackBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'Invalid feedback status' })
    const existing = await db.feedback.findUnique({ where: { id: params.data.id }, select: { id: true } })
    if (!existing) return reply.notFound()
    return db.feedback.update({
      where: { id: params.data.id },
      data: { status: body.data.status },
      select: adminFeedbackSelect,
    })
  })

  fastify.get<{ Params: { id: string; attachmentId: string } }>(
    '/:id/attachments/:attachmentId',
    { onRequest: authMiddleware },
    async (request, reply) => {
      if (request.user.marketplaceRole !== 'admin') return reply.forbidden()
      const params = FeedbackAttachmentParams.safeParse(request.params)
      if (!params.success) return reply.code(400).send({ error: 'Invalid feedback attachment id' })
      const feedback = await db.feedback.findUnique({
        where: { id: params.data.id },
        select: { attachments: true },
      })
      if (!feedback) return reply.notFound()
      const attachment = parseStoredFeedbackAttachments(feedback.attachments)
        .find((item) => item.id === params.data.attachmentId)
      if (!attachment) return reply.notFound()
      try {
        const bytes = await readFeedbackAttachment(params.data.id, attachment)
        reply.header('Cache-Control', 'private, max-age=300')
        reply.header('Content-Disposition', 'inline')
        return reply.type(attachment.mimeType).send(bytes)
      } catch (error: unknown) {
        request.log.error({ errorType: error instanceof Error ? error.name : 'unknown', feedbackId: params.data.id, attachmentId: attachment.id }, 'Feedback attachment read failed')
        return reply.notFound()
      }
    }
  )
}
