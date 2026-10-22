import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import { createTeamInviteToken, verifyTeamInviteToken, type InviteBinding } from '../lib/team-invite-token.js'
import { lockTeamMutation } from '../lib/mutation-lock.js'
import { recordTeamActivity } from '../lib/team-activity.js'
import { authMiddleware } from '../middleware/auth.js'
import { getInstanceIdentity } from '../lib/instance-identity.js'
import { AttemptLimiter } from '../lib/attempt-limiter.js'

const InviteLifetimeMs = 7 * 24 * 60 * 60 * 1000
const CreateInviteBody = z.object({ teamId: z.string().uuid() })
const InviteTokenParams = z.object({ token: z.string().min(1).max(2048) })

type InviteTeam = {
  id: string
  ownerId: string
  name: string
  color: string
  avatarUrl: string | null
  dissolvedAt: Date | null
}

function publicTeam(team: InviteTeam) {
  return {
    id: team.id,
    name: team.name,
    color: team.color,
    avatarUrl: team.avatarUrl,
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function invalidInvite(reply: FastifyReply) {
  return reply.code(404).send({ error: 'Team invite is invalid or expired' })
}

function inviteBinding() {
  const identity = getInstanceIdentity()
  return identity ? { instanceId: identity.id, publicBaseUrl: config.PUBLIC_BASE_URL } : null
}

function inviteLinks(token: string): { deepLink: string; landingPageUrl: string } {
  return {
    deepLink: `skillhub://join-team/${encodeURIComponent(token)}?server=${encodeURIComponent(config.PUBLIC_BASE_URL)}`,
    landingPageUrl: `${config.PUBLIC_BASE_URL}/invite/${encodeURIComponent(token)}`,
  }
}

async function resolveInvite(token: string, binding: InviteBinding): Promise<{ claims: NonNullable<ReturnType<typeof verifyTeamInviteToken>>; team: InviteTeam } | null> {
  const claims = verifyTeamInviteToken(token, config.JWT_SECRET, binding, config.SKILLHUB_PROFILE)
  if (!claims) return null
  const team = await db.team.findUnique({
    where: { id: claims.teamId },
    select: { id: true, ownerId: true, name: true, color: true, avatarUrl: true, dissolvedAt: true },
  })
  if (!team || team.dissolvedAt || team.ownerId !== claims.invitedBy) return null
  return { claims, team }
}

export const teamInviteRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  const landingAttempts = new AttemptLimiter()
  fastify.post<{ Body: unknown }>('/api/team-invites', { onRequest: authMiddleware }, async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const body = CreateInviteBody.safeParse(request.body)
    if (!body.success) return reply.badRequest(body.error.message)
    const team = await db.team.findUnique({
      where: { id: body.data.teamId },
      select: { id: true, ownerId: true, name: true, color: true, avatarUrl: true, dissolvedAt: true },
    })
    if (!team || team.dissolvedAt) return reply.notFound('Active team not found')
    if (team.ownerId !== request.user.id) return reply.forbidden('Only the team owner can create invitations')
    const expiresAt = Date.now() + InviteLifetimeMs
    const binding = inviteBinding()
    if (!binding) return reply.code(503).send({ error: 'Instance identity is unavailable' })
    const token = createTeamInviteToken({ teamId: team.id, invitedBy: request.user.id, expiresAt, secret: config.JWT_SECRET, binding })
    return reply.code(201).send({
      token,
      ...inviteLinks(token),
      expiresAt: new Date(expiresAt).toISOString(),
      team: publicTeam(team),
    })
  })

  fastify.get<{ Params: { token: string } }>('/api/team-invites/:token', async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    const params = InviteTokenParams.safeParse(request.params)
    if (!params.success) return invalidInvite(reply)
    const binding = inviteBinding()
    if (!binding) return reply.code(503).send({ error: 'Instance identity is unavailable' })
    const invite = await resolveInvite(params.data.token, binding)
    if (!invite) return invalidInvite(reply)
    reply.header('Cache-Control', 'no-store, private')
    return reply.send({ expiresAt: new Date(invite.claims.expiresAt).toISOString(), team: publicTeam(invite.team) })
  })

  fastify.post<{ Params: { token: string } }>('/api/team-invites/:token/accept', { onRequest: authMiddleware }, async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    const params = InviteTokenParams.safeParse(request.params)
    if (!params.success) return invalidInvite(reply)
    const binding = inviteBinding()
    if (!binding) return reply.code(503).send({ error: 'Instance identity is unavailable' })
    const claims = verifyTeamInviteToken(params.data.token, config.JWT_SECRET, binding, config.SKILLHUB_PROFILE)
    if (!claims) return invalidInvite(reply)

    const result = await db.$transaction(async (transaction) => {
      await lockTeamMutation(transaction, claims.teamId)
      const team = await transaction.team.findUnique({
        where: { id: claims.teamId },
        select: { id: true, ownerId: true, name: true, color: true, avatarUrl: true, dissolvedAt: true },
      })
      if (!team || team.dissolvedAt || team.ownerId !== claims.invitedBy) return { kind: 'invalid' } as const
      const existingMember = await transaction.teamMember.findUnique({
        where: { teamId_userId: { teamId: team.id, userId: request.user.id } },
      })
      if (existingMember) return { kind: 'member', team } as const

      await transaction.teamMember.create({
        data: { teamId: team.id, userId: request.user.id, role: 'member' },
      })
      const existingRequest = await transaction.teamJoinRequest.findUnique({
        where: { teamId_applicantId: { teamId: team.id, applicantId: request.user.id } },
      })
      if (existingRequest) {
        await transaction.teamJoinRequest.update({
          where: { id: existingRequest.id },
          data: { status: 'approved', invitedBy: claims.invitedBy },
        })
      } else {
        await transaction.teamJoinRequest.create({
          data: {
            teamId: team.id,
            applicantId: request.user.id,
            invitedBy: claims.invitedBy,
            status: 'approved',
          },
        })
      }
      await recordTeamActivity(transaction, {
        teamId: team.id,
        actorId: request.user.id,
        type: 'member_joined',
        payload: {
          userId: request.user.id,
          displayName: request.user.displayName,
          via: 'invite',
          invitedById: claims.invitedBy,
        },
      })
      await transaction.notification.createMany({
        data: [
          {
            userId: request.user.id,
            type: 'join_approved',
            payload: { teamId: team.id, teamName: team.name, via: 'owner_invite' },
          },
          {
            userId: team.ownerId,
            type: 'team_member_joined',
            payload: {
              teamId: team.id,
              teamName: team.name,
              userId: request.user.id,
              displayName: request.user.displayName,
            },
          },
        ],
      })
      return { kind: 'joined', team } as const
    })

    if (result.kind === 'invalid') return invalidInvite(reply)
    return reply.send({
      joined: result.kind === 'joined',
      alreadyMember: result.kind === 'member',
      team: publicTeam(result.team),
    })
  })

  fastify.get<{ Params: { token: string } }>('/invite/:token', async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      .header('X-Frame-Options', 'DENY')
      .header('X-Content-Type-Options', 'nosniff')
    const retryAfter = landingAttempts.consume(request.ip, 30, 60_000)
    if (retryAfter !== null) return reply.header('Retry-After', String(retryAfter)).code(429).send({ error: 'Too many attempts' })
    const params = InviteTokenParams.safeParse(request.params)
    if (!params.success) return reply.code(404).type('text/plain; charset=utf-8').send('邀请无效或已过期')
    const { deepLink } = inviteLinks(params.data.token)
    const safeDeepLink = escapeHtml(deepLink)
    return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SkillHub 团队邀请</title><style>body{max-width:32rem;margin:12vh auto;padding:24px;font:16px/1.8 sans-serif}a{display:inline-block;margin:12px 0}</style></head><body><main><h1>你收到了一个 SkillHub 团队邀请</h1><p>请在 SkillHub 中登录并确认加入团队。</p><a href="${safeDeepLink}">用 SkillHub 打开</a><p>还没有安装？<a href="https://sk.woe.show">下载 SkillHub</a>，安装后重新打开此链接。</p></main></body></html>`)
  })
}
