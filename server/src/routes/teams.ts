import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { Prisma } from '@prisma/client'
import { notifyRemovedTeamShares } from '../lib/team-skill-version.js'
import { z } from 'zod'
import { db } from '../db.js'
import { config } from '../config.js'
import {
  revokeTeamCredentialsForTeam,
  writeCredentialLifecycleAudit,
} from '../lib/credential-lifecycle.js'
import { lockTeamMutation } from '../lib/mutation-lock.js'
import { authMiddleware } from '../middleware/auth.js'
import { authorizeMediaUrl, publicImageUrl } from '../lib/media.js'
import { recordTeamActivity } from '../lib/team-activity.js'

const TeamAvatarUrlSchema = z.string().trim().max(2048).refine((value) => {
  try {
    if (config.SKILLHUB_PROFILE === 'selfhost') return publicImageUrl(value) === value
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}).nullable()

export const CreateTeamBody = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#7c5cf0'),
  avatarUrl: TeamAvatarUrlSchema.optional(),
})

const UpdateTeamBody = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().max(200).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  avatarUrl: TeamAvatarUrlSchema.optional(),
})

type TeamSummarySource = {
  id: string
  ownerId: string
  name: string
  description: string | null
  color: string
  avatarUrl: string | null
  dissolvedAt: Date | null
  _count: {
    members: number
    skillShares: number
    // Absent on a just-created team, which cannot hold keys yet.
    credentials?: number
  }
}

// A team key counts once it holds a value (#293): active and revision > 0.
const ACTIVE_TEAM_CREDENTIAL_COUNT = {
  where: { status: 'active', currentRevision: { gt: 0 } },
} as const

const ActivityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime({ offset: true }).optional(),
})

type LockedActiveTeam = {
  id: string
  ownerId: string
  name: string
  dissolvedAt: Date | null
}

async function lockActiveTeam(
  transaction: Prisma.TransactionClient,
  teamId: string
): Promise<LockedActiveTeam | null> {
  await lockTeamMutation(transaction, teamId)
  const team = await transaction.team.findUnique({
    where: { id: teamId },
    select: { id: true, ownerId: true, name: true, dissolvedAt: true },
  })
  return team && !team.dissolvedAt ? team : null
}

async function hasActiveTeamMembership(teamId: string, userId: string): Promise<boolean> {
  const membership = await db.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    include: { team: { select: { dissolvedAt: true } } },
  })
  return Boolean(membership && !membership.team.dissolvedAt)
}

async function revokeAuthoredTeamAssets(
  transaction: Prisma.TransactionClient,
  teamId: string,
  authorId: string,
  actorId: string
): Promise<void> {
  // Team keys the member put stay with the team (holder id is kept); only
  // the Skills they authored stop being shared, which removes those Skills
  // from every key's scope.
  await notifyRemovedTeamShares(transaction, teamId, actorId, authorId)
  await transaction.skillTeamShare.deleteMany({ where: { teamId, skill: { authorId } } })
}

function toTeamSummary(team: TeamSummarySource, role: 'owner' | 'member') {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    color: team.color,
    avatarUrl: team.avatarUrl,
    role,
    memberCount: team._count.members,
    sharedCount: team._count.skillShares,
    credentialCount: team._count.credentials ?? 0,
    dissolvedAt: team.dissolvedAt,
  }
}

export const teamsRoutes: FastifyPluginAsync = async (fastify) => {
  // Auth on all routes
  fastify.addHook('onRequest', authMiddleware)

  // GET /api/teams — my teams (joined + owned)
  fastify.get('/', async (req) => {
    const userId = req.user.id
    const memberships = await db.teamMember.findMany({
      where: { userId, team: { dissolvedAt: null } },
      orderBy: { joinedAt: 'desc' },
      include: {
        team: {
          include: {
            _count: {
              select: { members: true, skillShares: true, credentials: ACTIVE_TEAM_CREDENTIAL_COUNT },
            },
          },
        },
      },
    })
    return memberships.map((membership) =>
      toTeamSummary(membership.team, membership.team.ownerId === userId ? 'owner' : 'member')
    )
  })

  // POST /api/teams — create team
  fastify.post('/', async (req, reply) => {
    const body = CreateTeamBody.safeParse(req.body)
    if (!body.success) return reply.badRequest(body.error.message)
    const userId = req.user.id

    const team = await db.$transaction(async (transaction) => {
      await authorizeMediaUrl(body.data.avatarUrl, userId)
      const created = await transaction.team.create({
        data: {
          name: body.data.name,
          description: body.data.description,
          color: body.data.color,
          avatarUrl: body.data.avatarUrl,
          ownerId: userId,
          members: { create: { userId, role: 'owner' } },
        },
        include: {
          _count: { select: { members: true, skillShares: true } },
        },
      })
      await transaction.notification.create({
        data: {
          userId,
          type: 'team_created',
          payload: { teamId: created.id, teamName: created.name },
        },
      })
      return created
    })
    return reply.code(201).send(toTeamSummary(team, 'owner'))
  })

  // GET /api/teams/:id
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const activeMember = await hasActiveTeamMembership(req.params.id, req.user.id)
    if (!activeMember) return reply.forbidden('Active team membership required')
    const team = await db.team.findUnique({
      where: { id: req.params.id },
      include: {
        owner: { select: { id: true, displayName: true, avatarUrl: true, email: true } },
        members: {
          include: {
            user: { select: { id: true, displayName: true, avatarUrl: true, email: true } },
          },
        },
        _count: { select: { skillShares: true, credentials: ACTIVE_TEAM_CREDENTIAL_COUNT } },
      },
    })
    if (!team || team.dissolvedAt) return reply.notFound('Active team not found')
    return reply.send({ ...team, credentialCount: team._count.credentials })
  })

  // GET /api/teams/:id/activity — team activity feed, newest first (active members only)
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>(
    '/:id/activity',
    async (req, reply: FastifyReply) => {
      const query = ActivityQuery.safeParse(req.query)
      if (!query.success) return reply.badRequest(query.error.message)
      const team = await db.team.findUnique({
        where: { id: req.params.id },
        select: { id: true, dissolvedAt: true },
      })
      if (!team) return reply.notFound('Team not found')
      if (team.dissolvedAt) return reply.gone('Team has been dissolved')
      const membership = await db.teamMember.findUnique({
        where: { teamId_userId: { teamId: team.id, userId: req.user.id } },
        select: { userId: true },
      })
      if (!membership) return reply.forbidden('Active team membership required')
      const activities = await db.teamActivity.findMany({
        where: {
          teamId: team.id,
          ...(query.data.before ? { createdAt: { lt: new Date(query.data.before) } } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.data.limit,
        include: { actor: { select: { id: true, displayName: true, avatarUrl: true } } },
      })
      const items = activities.map((activity) => ({
        id: activity.id,
        type: activity.type,
        actor: activity.actor
          ? { id: activity.actor.id, displayName: activity.actor.displayName, avatarUrl: activity.actor.avatarUrl }
          : null,
        payload: activity.payload,
        createdAt: activity.createdAt.toISOString(),
      }))
      const last = items.at(-1)
      return reply.send({
        items,
        nextBefore: items.length === query.data.limit && last ? last.createdAt : null,
      })
    }
  )

  // GET /api/teams/:id/notifications — current member's notifications for this active team
  fastify.get<{ Params: { id: string } }>('/:id/notifications', async (req, reply) => {
    const activeMember = await hasActiveTeamMembership(req.params.id, req.user.id)
    if (!activeMember) return reply.forbidden('Active team membership required')
    return db.notification.findMany({
      where: {
        userId: req.user.id,
        payload: { path: ['teamId'], equals: req.params.id },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  })

  // PATCH /api/teams/:id — update (owner only)
  fastify.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const body = UpdateTeamBody.safeParse(req.body)
    if (!body.success) return reply.badRequest(body.error.message)
    const result = await db.$transaction(async (transaction) => {
      const team = await lockActiveTeam(transaction, req.params.id)
      if (!team) return { kind: 'inactive' } as const
      if (team.ownerId !== req.user.id) return { kind: 'forbidden' } as const
      const current = body.data.avatarUrl ? await transaction.team.findUnique({ where: { id: req.params.id }, select: { avatarUrl: true } }) : null
      await authorizeMediaUrl(body.data.avatarUrl, req.user.id, current?.avatarUrl)
      const updated = await transaction.team.update({
        where: { id: req.params.id },
        data: body.data,
      })
      return { kind: 'updated', updated } as const
    })
    if (result.kind === 'inactive') return reply.notFound('Active team not found')
    if (result.kind === 'forbidden') return reply.forbidden()
    return result.updated
  })

  // DELETE /api/teams/:id — dissolve (owner only)
  fastify.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const result = await db.$transaction(async (transaction) => {
      const team = await lockActiveTeam(transaction, req.params.id)
      if (!team) return { kind: 'inactive' } as const
      if (team.ownerId !== req.user.id) return { kind: 'forbidden' } as const
      const now = new Date()
      const members = await transaction.teamMember.findMany({
        where: { teamId: req.params.id, userId: { not: req.user.id } },
        select: { userId: true },
      })
      const credentialCounts = await revokeTeamCredentialsForTeam(transaction, req.params.id, now)
      await notifyRemovedTeamShares(transaction, req.params.id, req.user.id)
      await transaction.skillTeamShare.deleteMany({ where: { teamId: req.params.id } })
      await transaction.team.update({
        where: { id: req.params.id },
        data: { dissolvedAt: now },
      })
      if (members.length > 0) {
        await transaction.notification.createMany({
          data: members.map((member) => ({
            userId: member.userId,
            type: 'team_dissolved',
            payload: { teamId: team.id, teamName: team.name },
          })),
        })
      }
      await writeCredentialLifecycleAudit(transaction, {
        requestId: String(req.id),
        actorId: req.user.id,
        teamId: req.params.id,
        action: 'credential_lifecycle_team_dissolve',
        reason: 'team_dissolved',
        counts: credentialCounts,
      })
      return { kind: 'dissolved' } as const
    })
    if (result.kind === 'inactive') return reply.notFound('Active team not found')
    if (result.kind === 'forbidden') return reply.forbidden()
    return reply.code(204).send()
  })

  // POST /api/teams/:id/leave
  fastify.post<{ Params: { id: string } }>('/:id/leave', async (req, reply) => {
    const { id } = req.params
    const userId = req.user.id
    const result = await db.$transaction(async (transaction) => {
      const team = await lockActiveTeam(transaction, id)
      if (!team) return { kind: 'inactive' } as const
      if (team.ownerId === userId) return { kind: 'owner' } as const
      const removed = await transaction.teamMember.deleteMany({
        where: { teamId: id, userId },
      })
      if (removed.count === 0) return { kind: 'not-member' } as const
      await revokeAuthoredTeamAssets(transaction, id, userId, req.user.id)
      await recordTeamActivity(transaction, {
        teamId: id,
        actorId: userId,
        type: 'member_left',
        payload: { userId, displayName: req.user.displayName },
      })
      await transaction.notification.create({
        data: {
          userId: team.ownerId,
          type: 'team_member_left',
          payload: { teamId: team.id, teamName: team.name, userId },
        },
      })
      return { kind: 'left' } as const
    })
    if (result.kind === 'inactive') return reply.notFound('Active team not found')
    if (result.kind === 'owner') {
      return reply.badRequest('Owner cannot leave — dissolve the team instead')
    }
    if (result.kind === 'not-member') return reply.notFound('Active team membership not found')
    return reply.code(204).send()
  })

  // GET /api/teams/:id/members
  fastify.get<{ Params: { id: string } }>('/:id/members', async (req, reply) => {
    const activeMember = await hasActiveTeamMembership(req.params.id, req.user.id)
    if (!activeMember) return reply.forbidden('Active team membership required')
    const members = await db.teamMember.findMany({
      where: { teamId: req.params.id },
      include: { user: { select: { id: true, displayName: true, avatarUrl: true, email: true } } },
    })
    return members
  })

  // DELETE /api/teams/:id/members/:uid — kick (owner only)
  fastify.delete<{ Params: { id: string; uid: string } }>('/:id/members/:uid', async (req, reply) => {
    const result = await db.$transaction(async (transaction) => {
      const team = await lockActiveTeam(transaction, req.params.id)
      if (!team) return { kind: 'inactive' } as const
      if (team.ownerId !== req.user.id) return { kind: 'forbidden' } as const
      if (req.params.uid === team.ownerId) return { kind: 'owner' } as const
      const membership = await transaction.teamMember.deleteMany({
        where: { teamId: req.params.id, userId: req.params.uid },
      })
      if (membership.count === 0) return { kind: 'not-member' } as const
      await revokeAuthoredTeamAssets(transaction, req.params.id, req.params.uid, req.user.id)
      const removedUser = await transaction.user.findUnique({
        where: { id: req.params.uid },
        select: { displayName: true },
      })
      await recordTeamActivity(transaction, {
        teamId: team.id,
        actorId: req.user.id,
        type: 'member_removed',
        payload: { userId: req.params.uid, displayName: removedUser?.displayName ?? null },
      })
      await transaction.notification.create({
        data: {
          userId: req.params.uid,
          type: 'team_member_removed',
          payload: { teamId: team.id, teamName: team.name },
        },
      })
      return { kind: 'removed' } as const
    })
    if (result.kind === 'inactive') return reply.notFound('Active team not found')
    if (result.kind === 'forbidden') return reply.forbidden()
    if (result.kind === 'owner') return reply.badRequest('Team owner cannot be removed')
    if (result.kind === 'not-member') return reply.notFound('Active team member not found')
    return reply.code(204).send()
  })

  // POST /api/teams/:id/requests — request to join a team
  fastify.post<{ Params: { id: string } }>(
    '/:id/requests',
    async (req, reply) => {
      const userId = req.user.id
      const { id } = req.params
      const result = await db.$transaction(async (transaction) => {
        const team = await lockActiveTeam(transaction, id)
        if (!team) return { kind: 'inactive' } as const

        const membership = await transaction.teamMember.findUnique({
          where: { teamId_userId: { teamId: id, userId } },
        })
        if (membership) return { kind: 'member' } as const

        const existing = await transaction.teamJoinRequest.findUnique({
          where: { teamId_applicantId: { teamId: id, applicantId: userId } },
        })
        if (existing?.status === 'pending') {
          return { kind: 'request', request: existing, created: false } as const
        }

        const createNotification = async (requestId: string): Promise<void> => {
          await transaction.notification.create({
            data: {
              userId: team.ownerId,
              type: 'join_request',
              payload: {
                teamId: id,
                teamName: team.name,
                requestId,
                applicantId: userId,
                applicantName: req.user.displayName,
              },
            },
          })
        }

        if (existing) {
          const result = await transaction.teamJoinRequest.updateMany({
            where: { id: existing.id, status: existing.status },
            data: { invitedBy: null, status: 'pending', createdAt: new Date() },
          })
          const request = await transaction.teamJoinRequest.findUniqueOrThrow({
            where: { teamId_applicantId: { teamId: id, applicantId: userId } },
          })
          if (result.count === 1) await createNotification(request.id)
          return { kind: 'request', request, created: result.count === 1 } as const
        }

        const request = await transaction.teamJoinRequest.create({
          data: {
            teamId: id,
            applicantId: userId,
            invitedBy: null,
            status: 'pending',
          },
        })
        await createNotification(request.id)
        return { kind: 'request', request, created: true } as const
      })
      if (result.kind === 'inactive') return reply.notFound('Active team not found')
      if (result.kind === 'member') return reply.conflict('Already a team member')
      return reply.code(result.created ? 201 : 200).send(result.request)
    }
  )

  // GET /api/teams/:id/requests — pending requests (owner only)
  fastify.get<{ Params: { id: string } }>('/:id/requests', async (req, reply) => {
    const team = await db.team.findUnique({ where: { id: req.params.id } })
    if (!team || team.dissolvedAt) return reply.notFound('Active team not found')
    if (team.ownerId !== req.user.id) return reply.forbidden()

    return db.teamJoinRequest.findMany({
      where: { teamId: req.params.id, status: 'pending' },
      include: {
        applicant: {
          select: { id: true, displayName: true, avatarUrl: true, email: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    })
  })

  // POST /api/teams/:id/requests/:rid/approve
  fastify.post<{ Params: { id: string; rid: string } }>(
    '/:id/requests/:rid/approve',
    async (req, reply) => {
      const result = await db.$transaction(async (transaction) => {
        const team = await lockActiveTeam(transaction, req.params.id)
        if (!team) return { kind: 'inactive' } as const
        if (team.ownerId !== req.user.id) return { kind: 'forbidden' } as const
        const request = await transaction.teamJoinRequest.findUnique({
          where: { id: req.params.rid },
        })
        if (!request || request.status !== 'pending') return { kind: 'not-pending' } as const
        if (request.teamId !== req.params.id) return { kind: 'wrong-team' } as const
        const transitioned = await transaction.teamJoinRequest.updateMany({
          where: { id: req.params.rid, teamId: req.params.id, status: 'pending' },
          data: { status: 'approved' },
        })
        if (transitioned.count === 0) return { kind: 'resolved' } as const
        await transaction.teamMember.upsert({
          where: { teamId_userId: { teamId: req.params.id, userId: request.applicantId } },
          update: {},
          create: { teamId: req.params.id, userId: request.applicantId, role: 'member' },
        })
        const applicant = await transaction.user.findUnique({
          where: { id: request.applicantId },
          select: { displayName: true },
        })
        await recordTeamActivity(transaction, {
          teamId: team.id,
          actorId: request.applicantId,
          type: 'member_joined',
          payload: {
            userId: request.applicantId,
            displayName: applicant?.displayName ?? null,
            via: 'request',
            approvedById: req.user.id,
          },
        })
        await transaction.notification.create({
          data: {
            userId: request.applicantId,
            type: 'join_approved',
            payload: { teamId: team.id, teamName: team.name },
          },
        })
        await transaction.notification.updateMany({
          where: {
            userId: req.user.id,
            type: 'join_request',
            read: false,
            payload: { path: ['requestId'], equals: request.id },
          },
          data: { read: true },
        })
        return { kind: 'approved' } as const
      })
      if (result.kind === 'inactive') return reply.notFound('Active team not found')
      if (result.kind === 'forbidden') return reply.forbidden()
      if (result.kind === 'not-pending') return reply.badRequest('Request not pending')
      if (result.kind === 'wrong-team') return reply.badRequest('Request belongs to another team')
      if (result.kind === 'resolved') return reply.conflict('Request already resolved')
      return reply.code(204).send()
    }
  )

  // POST /api/teams/:id/requests/:rid/reject
  fastify.post<{ Params: { id: string; rid: string } }>(
    '/:id/requests/:rid/reject',
    async (req, reply) => {
      const result = await db.$transaction(async (transaction) => {
        const team = await lockActiveTeam(transaction, req.params.id)
        if (!team) return { kind: 'inactive' } as const
        if (team.ownerId !== req.user.id) return { kind: 'forbidden' } as const
        const request = await transaction.teamJoinRequest.findUnique({
          where: { id: req.params.rid },
        })
        if (!request || request.status !== 'pending') return { kind: 'not-pending' } as const
        if (request.teamId !== req.params.id) return { kind: 'wrong-team' } as const

        const transitioned = await transaction.teamJoinRequest.updateMany({
          where: { id: req.params.rid, teamId: req.params.id, status: 'pending' },
          data: { status: 'rejected' },
        })
        if (transitioned.count === 0) return { kind: 'resolved' } as const
        await transaction.notification.create({
          data: {
            userId: request.applicantId,
            type: 'join_rejected',
            payload: { teamId: team.id, teamName: team.name },
          },
        })
        await transaction.notification.updateMany({
          where: {
            userId: req.user.id,
            type: 'join_request',
            read: false,
            payload: { path: ['requestId'], equals: request.id },
          },
          data: { read: true },
        })
        return { kind: 'rejected' } as const
      })
      if (result.kind === 'inactive') return reply.notFound('Active team not found')
      if (result.kind === 'forbidden') return reply.forbidden()
      if (result.kind === 'not-pending') return reply.badRequest('Request not pending')
      if (result.kind === 'wrong-team') return reply.badRequest('Request belongs to another team')
      if (result.kind === 'resolved') return reply.conflict('Request already resolved')
      return reply.code(204).send()
    }
  )
}
