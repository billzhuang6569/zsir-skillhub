import Fastify, { type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { teamSkillLinkRoutes } from './team-skill-links.js'
import { config } from '../config.js'

const findFirst = vi.hoisted(() => vi.fn())
vi.mock('../db.js', () => ({ db: { skillTeamShare: { findFirst } } }))
vi.mock('../config.js', () => ({ config: { SKILLHUB_PROFILE: 'selfhost', PUBLIC_BASE_URL: 'https://instance.example/base' } }))
vi.mock('../middleware/auth.js', () => ({ authMiddleware: async (request: FastifyRequest): Promise<void> => {
  Object.assign(request, { user: { id: 'member' } })
} }))
const team = '11111111-1111-4111-8111-111111111111'
const skill = '22222222-2222-4222-8222-222222222222'

describe.each(['selfhost', 'yitan-official'] as const)('%s team Skill links', profile => {
  let app = Fastify()
  beforeEach(async () => {
    vi.clearAllMocks(); config.SKILLHUB_PROFILE = profile
    app = Fastify(); await app.register(teamSkillLinkRoutes); await app.ready()
  })
  afterEach(async () => { findFirst.mockReset(); await app.close() })
  it('renders a generic landing page without any database access', async () => {
    const response = await app.inject(`/team-skill/${team}/${skill}`)
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('在 SkillHub 中打开')
    expect(response.body).toContain('<a href="https://sk.woe.show">下载 SkillHub</a>')
    expect(response.body).toContain(`skillhub://team-skill/${team}/${skill}?server=https%3A%2F%2Finstance.example%2Fbase`)
    expect(response.body).not.toMatch(/token|<script|Skill 名|团队名/)
    expect(findFirst).not.toHaveBeenCalled()
    expect(response.headers['cache-control']).toBe('no-store')
  })
  it('returns canonical links only for a live share visible to a current member', async () => {
    findFirst.mockResolvedValue({ skillId: skill })
    const response = await app.inject(`/api/team-skill/${team}/${skill}`)
    expect(response.statusCode).toBe(200)
    expect(response.json().landingPageUrl).toBe(`https://instance.example/base/team-skill/${team}/${skill}`)
    expect(findFirst).toHaveBeenCalledWith({ where: { teamId: team, skillId: skill, skill: { deletedAt: null },
      team: { dissolvedAt: null, members: { some: { userId: 'member' } } } }, select: { skillId: true } })
  })
  it.each(['non-member', 'missing', 'unshared', 'deleted', 'dissolved'])('hides %s with the identical response', async () => {
    findFirst.mockResolvedValue(null)
    const response = await app.inject(`/api/team-skill/${team}/${skill}`)
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'Team skill unavailable' })
  })
  it('rejects non UUID paths without querying data', async () => {
    for (const prefix of ['', '/api']) {
      const response = await app.inject(`${prefix}/team-skill/not-a-uuid/${skill}`)
      expect(response.statusCode).toBe(404)
    }
    expect(findFirst).not.toHaveBeenCalled()
  })
})
