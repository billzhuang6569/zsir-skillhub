import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockDb = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  skill: { findUnique: vi.fn() },
  teamMember: { count: vi.fn(), findMany: vi.fn() },
  team: { findUnique: vi.fn() },
  notification: { createMany: vi.fn() },
  comment: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (request: FastifyRequest): Promise<void> => {
    request.user = {
      id: 'user-001',
      email: 'user@example.com',
      displayName: '测试用户',
    }
  },
}))

import { commentsRoutes } from './comments.js'

const SKILL_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_SKILL_ID = '11111111-1111-4111-8111-222222222222'
const TEAM_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_TEAM_ID = '22222222-2222-4222-8222-333333333333'
const COMMENT_ID = '33333333-3333-4333-8333-333333333333'
const MENTIONED_USER_ID = '44444444-4444-4444-8444-444444444444'

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(sensible)
  await app.register(commentsRoutes, { prefix: '/api/comments' })
  await app.ready()
  return app
}

describe('comment discussion scopes', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof mockDb) => Promise<unknown>): Promise<unknown> => callback(mockDb)
    )
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('reads only the requested active team scope', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: 'owner-001',
      teamShares: [{ teamId: TEAM_ID }, { teamId: OTHER_TEAM_ID }],
    })
    mockDb.teamMember.count.mockResolvedValue(1)
    mockDb.comment.findMany.mockResolvedValue([])
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: `/api/comments?skillId=${SKILL_ID}&teamId=${TEAM_ID}`,
    })

    expect(response.statusCode).toBe(200)
    expect(mockDb.teamMember.count).toHaveBeenCalledWith({
      where: {
        userId: 'user-001',
        teamId: TEAM_ID,
        team: { dissolvedAt: null },
      },
    })
    expect(mockDb.comment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { skillId: SKILL_ID, teamId: TEAM_ID, parentId: null },
      include: expect.objectContaining({
        replies: expect.objectContaining({
          where: { skillId: SKILL_ID, teamId: TEAM_ID },
        }),
      }),
    }))
  })

  it('denies a team scope when the Skill is shared only to another team', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: 'owner-001',
      teamShares: [{ teamId: OTHER_TEAM_ID }],
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: `/api/comments?skillId=${SKILL_ID}&teamId=${TEAM_ID}`,
    })

    expect(response.statusCode).toBe(403)
    expect(mockDb.teamMember.count).not.toHaveBeenCalled()
    expect(mockDb.comment.findMany).not.toHaveBeenCalled()
  })

  it('denies a team scope when membership is absent or the team is dissolved', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: 'owner-001',
      teamShares: [{ teamId: TEAM_ID }],
    })
    mockDb.teamMember.count.mockResolvedValue(0)
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: `/api/comments?skillId=${SKILL_ID}&teamId=${TEAM_ID}`,
    })

    expect(response.statusCode).toBe(403)
    expect(mockDb.comment.findMany).not.toHaveBeenCalled()
  })

  it('does not reuse membership from another team sharing the same Skill', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: 'owner-001',
      teamShares: [{ teamId: TEAM_ID }, { teamId: OTHER_TEAM_ID }],
    })
    mockDb.teamMember.count.mockResolvedValue(0)
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: `/api/comments?skillId=${SKILL_ID}&teamId=${OTHER_TEAM_ID}`,
    })

    expect(response.statusCode).toBe(403)
    expect(mockDb.teamMember.count).toHaveBeenCalledWith({
      where: {
        userId: 'user-001',
        teamId: OTHER_TEAM_ID,
        team: { dissolvedAt: null },
      },
    })
    expect(mockDb.comment.findMany).not.toHaveBeenCalled()
  })

  it('lets the Skill author read only the personal scope', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: 'user-001',
      teamShares: [{ teamId: TEAM_ID }],
    })
    mockDb.comment.findMany.mockResolvedValue([])
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: `/api/comments?skillId=${SKILL_ID}`,
    })

    expect(response.statusCode).toBe(200)
    expect(mockDb.teamMember.count).not.toHaveBeenCalled()
    expect(mockDb.comment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { skillId: SKILL_ID, teamId: null, parentId: null },
    }))
  })

  it('does not expose legacy personal comments to a team member', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: 'owner-001',
      teamShares: [{ teamId: TEAM_ID }],
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: `/api/comments?skillId=${SKILL_ID}`,
    })

    expect(response.statusCode).toBe(403)
    expect(mockDb.teamMember.count).not.toHaveBeenCalled()
    expect(mockDb.comment.findMany).not.toHaveBeenCalled()
  })

  it('writes the exact teamId into a team comment', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: 'owner-001',
      teamShares: [{ teamId: TEAM_ID }],
    })
    mockDb.teamMember.count.mockResolvedValue(1)
    mockDb.comment.create.mockResolvedValue({
      id: COMMENT_ID,
      skillId: SKILL_ID,
      teamId: TEAM_ID,
      userId: 'user-001',
      content: '团队讨论',
      user: { id: 'user-001', displayName: '测试用户', avatarUrl: null },
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/comments',
      payload: { skillId: SKILL_ID, teamId: TEAM_ID, content: '团队讨论' },
    })

    expect(response.statusCode).toBe(201)
    expect(mockDb.comment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ skillId: SKILL_ID, teamId: TEAM_ID }),
    }))
    expect(mockDb.$queryRaw).toHaveBeenCalledOnce()
  })

  it('lists all shared-team members but only enables members of the active discussion team', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: 'owner-001',
      teamShares: [{ teamId: TEAM_ID }],
    })
    mockDb.teamMember.count.mockResolvedValue(1)
    mockDb.teamMember.findMany.mockResolvedValue([
      {
        teamId: TEAM_ID,
        userId: MENTIONED_USER_ID,
        team: { id: TEAM_ID, name: '当前团队' },
        user: { id: MENTIONED_USER_ID, displayName: '可提醒成员', avatarUrl: null },
      },
      {
        teamId: OTHER_TEAM_ID,
        userId: '55555555-5555-4555-8555-555555555555',
        team: { id: OTHER_TEAM_ID, name: '其他团队' },
        user: { id: '55555555-5555-4555-8555-555555555555', displayName: '其他成员', avatarUrl: null },
      },
    ])
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: `/api/comments/mention-candidates?skillId=${SKILL_ID}&teamId=${TEAM_ID}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: MENTIONED_USER_ID, canMention: true, reason: null }),
      expect.objectContaining({ displayName: '其他成员', canMention: false, reason: '不在当前讨论团队' }),
    ]))
  })

  it('creates a mention notification in the same transaction as the team comment', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      displayName: '测试 Skill',
      authorId: 'owner-001',
      teamShares: [{ teamId: TEAM_ID }],
    })
    mockDb.teamMember.count.mockResolvedValue(1)
    mockDb.teamMember.findMany.mockResolvedValue([{ userId: MENTIONED_USER_ID }])
    mockDb.team.findUnique.mockResolvedValue({ name: '研发团队' })
    mockDb.comment.create.mockResolvedValue({
      id: COMMENT_ID,
      skillId: SKILL_ID,
      teamId: TEAM_ID,
      userId: 'user-001',
      content: '@成员 请看',
      user: { id: 'user-001', displayName: '测试用户', avatarUrl: null },
      mentions: [{ mentionedUser: { id: MENTIONED_USER_ID, displayName: '成员', avatarUrl: null } }],
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/comments',
      payload: {
        skillId: SKILL_ID,
        teamId: TEAM_ID,
        content: '@成员 请看',
        mentionUserIds: [MENTIONED_USER_ID],
      },
    })

    expect(response.statusCode).toBe(201)
    expect(mockDb.comment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        mentions: { createMany: { data: [{ mentionedUserId: MENTIONED_USER_ID }] } },
      }),
    }))
    expect(mockDb.notification.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        userId: MENTIONED_USER_ID,
        type: 'comment_mention',
        payload: expect.objectContaining({ commentId: COMMENT_ID, teamId: TEAM_ID, skillId: SKILL_ID }),
      })],
    })
  })

  it('refuses to create a comment when the locked Skill is already tombstoned', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: 'user-001',
      deletedAt: new Date('2026-08-04T03:00:00.000Z'),
      teamShares: [],
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/comments',
      payload: { skillId: SKILL_ID, content: '不应写入' },
    })

    expect(response.statusCode).toBe(404)
    expect(mockDb.$queryRaw).toHaveBeenCalledOnce()
    expect(mockDb.comment.create).not.toHaveBeenCalled()
  })

  it('rejects a reply whose parent belongs to another team scope', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: 'owner-001',
      teamShares: [{ teamId: TEAM_ID }],
    })
    mockDb.teamMember.count.mockResolvedValue(1)
    mockDb.comment.findUnique.mockResolvedValue({
      id: COMMENT_ID,
      skillId: SKILL_ID,
      teamId: OTHER_TEAM_ID,
      userId: 'other-user',
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/comments',
      payload: {
        skillId: SKILL_ID,
        teamId: TEAM_ID,
        parentId: COMMENT_ID,
        content: '错误作用域回复',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(mockDb.comment.create).not.toHaveBeenCalled()
  })

  it('rejects a reply whose parent belongs to another Skill in the same team', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: 'owner-001',
      teamShares: [{ teamId: TEAM_ID }],
    })
    mockDb.teamMember.count.mockResolvedValue(1)
    mockDb.comment.findUnique.mockResolvedValue({
      id: COMMENT_ID,
      skillId: OTHER_SKILL_ID,
      teamId: TEAM_ID,
      userId: 'other-user',
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/comments',
      payload: {
        skillId: SKILL_ID,
        teamId: TEAM_ID,
        parentId: COMMENT_ID,
        content: '错误 Skill 回复',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(mockDb.comment.create).not.toHaveBeenCalled()
  })

  it('denies updating an owned team comment after exact scope access is lost', async () => {
    mockDb.comment.findUnique.mockResolvedValue({
      id: COMMENT_ID,
      skillId: SKILL_ID,
      teamId: TEAM_ID,
      userId: 'user-001',
      content: '旧内容',
    })
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: 'owner-001',
      teamShares: [{ teamId: OTHER_TEAM_ID }],
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/comments/${COMMENT_ID}`,
      payload: { content: '新内容' },
    })

    expect(response.statusCode).toBe(403)
    expect(mockDb.teamMember.count).not.toHaveBeenCalled()
    expect(mockDb.comment.update).not.toHaveBeenCalled()
  })

  it('denies deleting an owned team comment after membership is lost', async () => {
    mockDb.comment.findUnique.mockResolvedValue({
      id: COMMENT_ID,
      skillId: SKILL_ID,
      teamId: TEAM_ID,
      userId: 'user-001',
      content: '旧内容',
    })
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: 'owner-001',
      teamShares: [{ teamId: TEAM_ID }],
    })
    mockDb.teamMember.count.mockResolvedValue(0)
    app = await buildApp()

    const response = await app.inject({ method: 'DELETE', url: `/api/comments/${COMMENT_ID}` })

    expect(response.statusCode).toBe(403)
    expect(mockDb.comment.delete).not.toHaveBeenCalled()
  })

  it('preserves personal comment editing for the Skill author', async () => {
    mockDb.comment.findUnique.mockResolvedValue({
      id: COMMENT_ID,
      skillId: SKILL_ID,
      teamId: null,
      userId: 'user-001',
      content: '旧内容',
    })
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: 'user-001',
      teamShares: [],
    })
    mockDb.comment.update.mockResolvedValue({
      id: COMMENT_ID,
      skillId: SKILL_ID,
      teamId: null,
      userId: 'user-001',
      content: '新内容',
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/comments/${COMMENT_ID}`,
      payload: { content: '新内容' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: COMMENT_ID, teamId: null, content: '新内容' })
    expect(mockDb.teamMember.count).not.toHaveBeenCalled()
  })

  it('denies editing a legacy personal comment when its commenter is not the Skill author', async () => {
    mockDb.comment.findUnique.mockResolvedValue({
      id: COMMENT_ID,
      skillId: SKILL_ID,
      teamId: null,
      userId: 'user-001',
      content: '旧内容',
    })
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: 'owner-001',
      teamShares: [{ teamId: TEAM_ID }],
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/comments/${COMMENT_ID}`,
      payload: { content: '新内容' },
    })

    expect(response.statusCode).toBe(403)
    expect(mockDb.teamMember.count).not.toHaveBeenCalled()
    expect(mockDb.comment.update).not.toHaveBeenCalled()
  })
})
