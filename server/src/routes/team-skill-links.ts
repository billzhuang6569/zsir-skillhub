import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'

type Params = { teamId: string; skillId: string }
const paramsSchema = z.object({ teamId: z.string().uuid(), skillId: z.string().uuid() })
function links({ teamId, skillId }: Params): { deepLink: string; landingPageUrl: string } {
  const base = config.PUBLIC_BASE_URL.replace(/\/+$/, '')
  return { deepLink: `skillhub://team-skill/${teamId}/${skillId}?server=${encodeURIComponent(base)}`,
    landingPageUrl: `${base}/team-skill/${teamId}/${skillId}` }
}

export const teamSkillLinkRoutes: FastifyPluginAsync = async (app): Promise<void> => {
  app.get<{ Params: Params }>('/api/team-skill/:teamId/:skillId', { onRequest: authMiddleware }, async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply): Promise<FastifyReply> => {
    reply.header('Cache-Control', 'no-store')
    const parsed = paramsSchema.safeParse(request.params)
    if (!parsed.success) return reply.code(404).send({ error: 'Team skill unavailable' })
    const share = await db.skillTeamShare.findFirst({ where: {
      ...parsed.data, skill: { deletedAt: null },
      team: { dissolvedAt: null, members: { some: { userId: request.user.id } } },
    }, select: { skillId: true } })
    if (!share) return reply.code(404).send({ error: 'Team skill unavailable' })
    return reply.send(links(parsed.data))
  })
  app.get<{ Params: Params }>('/team-skill/:teamId/:skillId', async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply): Promise<FastifyReply> => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
      .header('X-Content-Type-Options', 'nosniff')
    const parsed = paramsSchema.safeParse(request.params)
    if (!parsed.success) return reply.code(404).send({ error: 'Team skill unavailable' })
    const href = links(parsed.data).deepLink.replaceAll('&', '&amp;').replaceAll("'", '&#39;').replaceAll('"', '&quot;')
    return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SkillHub 团队共享</title></head><body><main><h1>打开团队共享 Skill</h1><p>请在 SkillHub 中登录，只有团队成员可以查看。</p><a href="${href}">在 SkillHub 中打开</a><p>还没有安装？<a href="https://sk.woe.show">下载 SkillHub</a>，安装后重新打开此链接。</p></main></body></html>`)
  })
}
