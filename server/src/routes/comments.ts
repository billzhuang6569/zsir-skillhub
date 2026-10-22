import type { FastifyPluginAsync } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { lockSkillMutation } from '../lib/mutation-lock.js'

const PostCommentBody = z.object({
  skillId: z.string().uuid(),
  teamId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().optional(),
  content: z.string().trim().min(1).max(2000),
  mentionUserIds: z.array(z.string().uuid()).max(20).optional().default([]),
})

const GetCommentsQuery = z.object({
  skillId: z.string().uuid(),
  teamId: z.string().uuid().optional(),
})

const MentionCandidatesQuery = z.object({
  skillId: z.string().uuid(),
  teamId: z.string().uuid(),
})

const UpdateCommentBody = z.object({
  content: z.string().trim().min(1).max(2000),
  mentionUserIds: z.array(z.string().uuid()).max(20).optional(),
})

type CommentSkillAccess = {
  authorId: string
  teamShares: { teamId: string }[]
}

type MentionedUser = {
  id: string
  displayName: string
  avatarUrl: string | null
}

type CommentResponseSource = {
  id: string
  skillId: string
  teamId: string | null
  userId: string
  parentId: string | null
  content: string
  createdAt: Date
  updatedAt: Date
  user: MentionedUser
  mentions?: Array<{ mentionedUser: MentionedUser }>
  replies?: CommentResponseSource[]
}

type SerializedComment = Omit<CommentResponseSource, 'mentions' | 'replies'> & {
  mentions: MentionedUser[]
  replies: SerializedComment[]
}

function serializeComment(comment: CommentResponseSource): SerializedComment {
  return {
    id: comment.id,
    skillId: comment.skillId,
    teamId: comment.teamId,
    userId: comment.userId,
    parentId: comment.parentId,
    content: comment.content,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    user: comment.user,
    mentions: (comment.mentions ?? []).map(({ mentionedUser }) => mentionedUser),
    replies: (comment.replies ?? []).map(serializeComment),
  }
}

function uniqueMentionIds(ids: readonly string[], actorId: string): string[] {
  return [...new Set(ids)].filter((id) => id !== actorId)
}

async function validateMentionTargets(
  transaction: Prisma.TransactionClient,
  teamId: string | null,
  mentionUserIds: readonly string[],
): Promise<boolean> {
  if (mentionUserIds.length === 0) return true
  if (!teamId) return false
  const members = await transaction.teamMember.findMany({
    where: {
      teamId,
      userId: { in: [...mentionUserIds] },
      team: { dissolvedAt: null },
    },
    select: { userId: true },
  })
  return members.length === mentionUserIds.length
}

async function hasCommentAccess(
  skill: CommentSkillAccess,
  userId: string,
  teamId: string | null
): Promise<boolean> {
  if (teamId === null) return skill.authorId === userId
  if (!skill.teamShares.some((share) => share.teamId === teamId)) return false
  const memberships = await db.teamMember.count({
    where: {
      userId,
      teamId,
      team: { dissolvedAt: null },
    },
  })
  return memberships > 0
}

export const commentsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', authMiddleware)

  // GET /api/comments/mention-candidates?skillId=xxx&teamId=xxx
  fastify.get<{ Querystring: { skillId: string; teamId: string } }>(
    '/mention-candidates',
    async (req, reply) => {
      const query = MentionCandidatesQuery.safeParse(req.query)
      if (!query.success) return reply.badRequest(query.error.message)
      const { skillId, teamId } = query.data
      const skill = await db.skill.findUnique({
        where: { id: skillId },
        include: { teamShares: { select: { teamId: true } } },
      })
      if (!skill || skill.deletedAt) return reply.notFound('Skill not found')
      if (!(await hasCommentAccess(skill, req.user.id, teamId))) return reply.forbidden()

      const memberships = await db.teamMember.findMany({
        where: {
          team: {
            dissolvedAt: null,
            members: { some: { userId: req.user.id } },
          },
        },
        select: {
          teamId: true,
          userId: true,
          team: { select: { id: true, name: true } },
          user: { select: { id: true, displayName: true, avatarUrl: true } },
        },
        orderBy: { joinedAt: 'asc' },
      })

      const candidates = new Map<string, {
        user: MentionedUser
        teams: Array<{ id: string; name: string }>
        canMention: boolean
        reason: string | null
      }>()
      for (const membership of memberships) {
        const existing = candidates.get(membership.userId) ?? {
          user: membership.user,
          teams: [],
          canMention: false,
          reason: null,
        }
        if (!existing.teams.some((team) => team.id === membership.team.id)) {
          existing.teams.push(membership.team)
        }
        if (membership.teamId === teamId && membership.userId !== req.user.id) {
          existing.canMention = true
        }
        candidates.set(membership.userId, existing)
      }

      return reply.send([...candidates.values()].map((candidate) => ({
        ...candidate.user,
        teams: candidate.teams,
        canMention: candidate.canMention,
        reason: candidate.canMention
          ? null
          : candidate.user.id === req.user.id
            ? '不能通知自己'
            : '不在当前讨论团队',
      })))
    },
  )

  // GET /api/comments?skillId=xxx
  fastify.get<{ Querystring: { skillId: string; teamId?: string } }>('/', async (req, reply) => {
    const query = GetCommentsQuery.safeParse(req.query)
    if (!query.success) return reply.badRequest(query.error.message)
    const { skillId } = query.data
    const teamId = query.data.teamId ?? null
    const skill = await db.skill.findUnique({
      where: { id: skillId },
      include: { teamShares: { select: { teamId: true } } },
    })
    if (!skill || skill.deletedAt) return reply.notFound('Skill not found')
    if (!(await hasCommentAccess(skill, req.user.id, teamId))) return reply.forbidden()
    const comments = await db.comment.findMany({
      where: { skillId, teamId, parentId: null },
      include: {
        user: { select: { id: true, displayName: true, avatarUrl: true } },
        mentions: {
          include: { mentionedUser: { select: { id: true, displayName: true, avatarUrl: true } } },
        },
        replies: {
          where: { skillId, teamId },
          include: {
            user: { select: { id: true, displayName: true, avatarUrl: true } },
            mentions: {
              include: { mentionedUser: { select: { id: true, displayName: true, avatarUrl: true } } },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    return reply.send(comments.map((comment) => serializeComment(comment)))
  })

  // POST /api/comments
  fastify.post('/', async (req, reply) => {
    const body = PostCommentBody.safeParse(req.body)
    if (!body.success) return reply.badRequest(body.error.message)
    const teamId = body.data.teamId ?? null
    const mentionUserIds = uniqueMentionIds(body.data.mentionUserIds, req.user.id)
    const result = await db.$transaction(async (transaction) => {
      await lockSkillMutation(transaction, body.data.skillId)
      const skill = await transaction.skill.findUnique({
        where: { id: body.data.skillId },
        include: { teamShares: { select: { teamId: true } } },
      })
      if (!skill || skill.deletedAt) return { outcome: 'not_found' } as const
      const allowed = teamId === null
        ? skill.authorId === req.user.id
        : skill.teamShares.some((share) => share.teamId === teamId)
          && await transaction.teamMember.count({
            where: { userId: req.user.id, teamId, team: { dissolvedAt: null } },
          }) > 0
      if (!allowed) return { outcome: 'forbidden' } as const
      if (body.data.parentId) {
        const parent = await transaction.comment.findUnique({ where: { id: body.data.parentId } })
        if (
          !parent
          || parent.skillId !== body.data.skillId
          || parent.teamId !== teamId
          || parent.parentId !== null
        ) return { outcome: 'invalid_parent' } as const
      }
      if (!(await validateMentionTargets(transaction, teamId, mentionUserIds))) {
        return { outcome: 'invalid_mentions' } as const
      }
      const comment = await transaction.comment.create({
        data: {
          skillId: body.data.skillId,
          teamId,
          parentId: body.data.parentId,
          userId: req.user.id,
          content: body.data.content,
          ...(mentionUserIds.length > 0 ? {
            mentions: {
              createMany: { data: mentionUserIds.map((mentionedUserId) => ({ mentionedUserId })) },
            },
          } : {}),
        },
        include: {
          user: { select: { id: true, displayName: true, avatarUrl: true } },
          mentions: {
            include: { mentionedUser: { select: { id: true, displayName: true, avatarUrl: true } } },
          },
        },
      })
      if (mentionUserIds.length > 0 && teamId) {
        const team = await transaction.team.findUnique({
          where: { id: teamId },
          select: { name: true },
        })
        await transaction.notification.createMany({
          data: mentionUserIds.map((userId) => ({
            userId,
            type: 'comment_mention',
            payload: {
              actorId: req.user.id,
              actorName: req.user.displayName,
              skillId: skill.id,
              skillName: skill.displayName,
              teamId,
              teamName: team?.name ?? '团队',
              commentId: comment.id,
            },
          })),
        })
      }
      return { outcome: 'created', comment } as const
    })
    if (result.outcome === 'not_found') return reply.notFound('Skill not found')
    if (result.outcome === 'forbidden') return reply.forbidden()
    if (result.outcome === 'invalid_parent') {
      return reply.badRequest('Replies must target a root comment in the same discussion scope')
    }
    if (result.outcome === 'invalid_mentions') {
      return reply.badRequest('Mentioned users must be active members of this discussion team')
    }
    return reply.code(201).send(serializeComment({ ...result.comment, replies: [] }))
  })

  // PATCH /api/comments/:id
  fastify.patch<{ Params: { id: string }; Body: { content: string } }>(
    '/:id',
    async (req, reply) => {
      const body = UpdateCommentBody.safeParse(req.body)
      if (!body.success) return reply.badRequest(body.error.message)
      const candidate = await db.comment.findUnique({ where: { id: req.params.id } })
      if (!candidate) return reply.notFound()
      const result = await db.$transaction(async (transaction) => {
        await lockSkillMutation(transaction, candidate.skillId)
        const comment = await transaction.comment.findUnique({
          where: { id: req.params.id },
          include: { mentions: { select: { mentionedUserId: true } } },
        })
        if (!comment) return { outcome: 'not_found' } as const
        if (comment.userId !== req.user.id) return { outcome: 'forbidden' } as const
        const skill = await transaction.skill.findUnique({
          where: { id: comment.skillId },
          include: { teamShares: { select: { teamId: true } } },
        })
        if (!skill || skill.deletedAt) return { outcome: 'skill_not_found' } as const
        const allowed = comment.teamId === null
          ? skill.authorId === req.user.id
          : skill.teamShares.some((share) => share.teamId === comment.teamId)
            && await transaction.teamMember.count({
              where: { userId: req.user.id, teamId: comment.teamId, team: { dissolvedAt: null } },
            }) > 0
        if (!allowed) return { outcome: 'forbidden' } as const
        const nextMentionUserIds = body.data.mentionUserIds === undefined
          ? null
          : uniqueMentionIds(body.data.mentionUserIds, req.user.id)
        if (nextMentionUserIds && !(await validateMentionTargets(
          transaction,
          comment.teamId,
          nextMentionUserIds,
        ))) return { outcome: 'invalid_mentions' } as const
        const previousMentionUserIds = new Set(
          (comment.mentions ?? []).map((mention) => mention.mentionedUserId),
        )
        const addedMentionUserIds = (nextMentionUserIds ?? [])
          .filter((userId) => !previousMentionUserIds.has(userId))
        const updated = await transaction.comment.update({
          where: { id: req.params.id },
          data: {
            content: body.data.content,
            ...(nextMentionUserIds ? {
              mentions: {
                deleteMany: nextMentionUserIds.length > 0
                  ? { mentionedUserId: { notIn: nextMentionUserIds } }
                  : {},
                createMany: {
                  data: addedMentionUserIds.map((mentionedUserId) => ({ mentionedUserId })),
                  skipDuplicates: true,
                },
              },
            } : {}),
          },
          include: {
            user: { select: { id: true, displayName: true, avatarUrl: true } },
            mentions: {
              include: { mentionedUser: { select: { id: true, displayName: true, avatarUrl: true } } },
            },
          },
        })
        if (addedMentionUserIds.length > 0 && comment.teamId) {
          const team = await transaction.team.findUnique({
            where: { id: comment.teamId },
            select: { name: true },
          })
          await transaction.notification.createMany({
            data: addedMentionUserIds.map((userId) => ({
              userId,
              type: 'comment_mention',
              payload: {
                actorId: req.user.id,
                actorName: req.user.displayName,
                skillId: skill.id,
                skillName: skill.displayName,
                teamId: comment.teamId,
                teamName: team?.name ?? '团队',
                commentId: comment.id,
              },
            })),
          })
        }
        return { outcome: 'updated', comment: updated } as const
      })
      if (result.outcome === 'not_found') return reply.notFound()
      if (result.outcome === 'skill_not_found') return reply.notFound('Skill not found')
      if (result.outcome === 'forbidden') return reply.forbidden()
      if (result.outcome === 'invalid_mentions') {
        return reply.badRequest('Mentioned users must be active members of this discussion team')
      }
      return reply.send(serializeComment({ ...result.comment, replies: [] }))
    }
  )

  // DELETE /api/comments/:id
  fastify.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const candidate = await db.comment.findUnique({ where: { id: req.params.id } })
    if (!candidate) return reply.notFound()
    const result = await db.$transaction(async (transaction) => {
      await lockSkillMutation(transaction, candidate.skillId)
      const comment = await transaction.comment.findUnique({ where: { id: req.params.id } })
      if (!comment) return { outcome: 'not_found' } as const
      if (comment.userId !== req.user.id) return { outcome: 'forbidden' } as const
      const skill = await transaction.skill.findUnique({
        where: { id: comment.skillId },
        include: { teamShares: { select: { teamId: true } } },
      })
      if (!skill || skill.deletedAt) return { outcome: 'skill_not_found' } as const
      const allowed = comment.teamId === null
        ? skill.authorId === req.user.id
        : skill.teamShares.some((share) => share.teamId === comment.teamId)
          && await transaction.teamMember.count({
            where: { userId: req.user.id, teamId: comment.teamId, team: { dissolvedAt: null } },
          }) > 0
      if (!allowed) return { outcome: 'forbidden' } as const
      await transaction.comment.delete({ where: { id: req.params.id } })
      return { outcome: 'deleted' } as const
    })
    if (result.outcome === 'not_found') return reply.notFound()
    if (result.outcome === 'skill_not_found') return reply.notFound('Skill not found')
    if (result.outcome === 'forbidden') return reply.forbidden()
    return reply.code(204).send()
  })
}
