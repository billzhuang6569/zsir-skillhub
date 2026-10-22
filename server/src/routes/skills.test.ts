import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import cors from '@fastify/cors'
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { skillHubCorsOptions } from '../cors.js'

const zipCrcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function zipCrc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (zipCrcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function createStoredSkillZip(skillMd = '# Packaged Skill\n'): Buffer {
  const name = Buffer.from('SKILL.md', 'utf8')
  const data = Buffer.from(skillMd, 'utf8')
  const crc = zipCrc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(0x0314, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38)
  central.writeUInt32LE(0, 42)

  const centralOffset = local.length + name.length + data.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + name.length, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([local, name, data, central, name, eocd])
}

function packagedVersionFields(skillMd: string): {
  skillMd: string
  packageBase64: string
  packageSha256: string
} {
  const packageData = createStoredSkillZip(`${skillMd.trim()}\n`)
  return {
    skillMd,
    packageBase64: packageData.toString('base64'),
    packageSha256: createHash('sha256').update(packageData).digest('hex'),
  }
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
  cardGrant: { findUnique: vi.fn() },
  skillCard: {
    findUnique: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  teamActivity: {
    create: vi.fn(),
  },
  skill: {
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  team: {
    findUnique: vi.fn(),
  },
  skillVersion: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    create: vi.fn(),
  },
  teamMember: {
    count: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  skillTeamShare: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  teamCredential: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  credentialAuditEvent: {
    create: vi.fn(),
  },
  notification: {
    createMany: vi.fn(),
  },
  marketplaceSubmission: {
    updateMany: vi.fn(),
  },
  marketplaceListing: {
    updateMany: vi.fn(),
  },
}))

const mockAuth = vi.hoisted((): {
  verifiedAuthToken: { sub: string; ver: number } | undefined
} => ({
  verifiedAuthToken: { sub: 'user-001', ver: 7 },
}))

const mockConfig = vi.hoisted((): {
  AI_API_BASE_URL: string | undefined
  AI_API_KEY: string | undefined
  AI_MODEL: string
  AI_PROTOCOL: 'openai' | 'anthropic' | 'openai-responses'
  AI_RATE_LIMIT_PER_MINUTE: number
  AI_GLOBAL_DAILY_LIMIT: number
  AI_MAX_CONCURRENT: number
  AI_TIMEOUT_MS: number
  SKILL_MAX_PER_USER: number
  SKILL_MAX_VERSIONS_PER_SKILL: number
  SKILL_MAX_STORAGE_BYTES_PER_USER: number
  SKILL_VERSION_WRITES_PER_HOUR: number
  SKILL_CARD_STORAGE_DIR: string
} => ({
  AI_API_BASE_URL: undefined,
  AI_API_KEY: undefined,
  AI_MODEL: 'kimi-k3',
  AI_PROTOCOL: 'anthropic',
  AI_RATE_LIMIT_PER_MINUTE: 6,
  AI_GLOBAL_DAILY_LIMIT: 200,
  AI_MAX_CONCURRENT: 2,
  AI_TIMEOUT_MS: 30_000,
  SKILL_MAX_PER_USER: 50,
  SKILL_MAX_VERSIONS_PER_SKILL: 30,
  SKILL_MAX_STORAGE_BYTES_PER_USER: 250 * 1024 * 1024,
  SKILL_VERSION_WRITES_PER_HOUR: 30,
  SKILL_CARD_STORAGE_DIR: '',
}))
const mockMutationLocks = vi.hoisted(() => ({
  lockSkillMutation: vi.fn().mockResolvedValue(undefined),
  lockSkillTeamMutation: vi.fn().mockResolvedValue(undefined),
  lockUserMutation: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../config.js', () => ({ config: mockConfig }))
vi.mock('../lib/mutation-lock.js', () => mockMutationLocks)
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (request: FastifyRequest): Promise<void> => {
    request.user = {
      id: 'user-001',
      email: 'user@example.com',
      displayName: '测试用户',
      marketplaceRole: 'user',
    }
    request.verifiedAuthToken = mockAuth.verifiedAuthToken
  },
}))

import {
  fallbackProfile,
  inferFallbackSkillLabels,
  openAiCompatibleBaseUrl,
  redactSensitiveContent,
  SKILL_LABEL_CATALOG,
  SKILL_LABEL_TAXONOMY,
  SkillNameSchema,
  SkillProfileSchema,
  skillPackageContentDisposition,
  skillsRoutes,
  versionMutationDigest,
} from './skills.js'

function mutationDigestFor(payload: {
  version: string
  changelog?: string
  gitHash?: string
  envDependencies?: { key: string; description?: string; required: boolean }[]
  packageSha256: string
}): string {
  return versionMutationDigest(payload, payload.packageSha256)
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(cors, skillHubCorsOptions('http://localhost:1420,tauri://localhost'))
  await app.register(sensible)
  await app.register(skillsRoutes, { prefix: '/api/skills' })
  await app.ready()
  return app
}

describe('skills routes', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    mockConfig.AI_API_BASE_URL = undefined
    mockConfig.AI_API_KEY = undefined
    mockConfig.AI_PROTOCOL = 'anthropic'
    mockConfig.SKILL_MAX_PER_USER = 50
    mockConfig.SKILL_MAX_VERSIONS_PER_SKILL = 30
    mockConfig.SKILL_MAX_STORAGE_BYTES_PER_USER = 250 * 1024 * 1024
    mockConfig.SKILL_VERSION_WRITES_PER_HOUR = 30
    mockConfig.SKILL_CARD_STORAGE_DIR = mkdtempSync(join(tmpdir(), 'skillhub-cards-'))
    mockDb.$executeRaw.mockResolvedValue(1)
    mockAuth.verifiedAuthToken = { sub: 'user-001', ver: 7 }
    mockMutationLocks.lockSkillMutation.mockResolvedValue(undefined)
    mockMutationLocks.lockSkillTeamMutation.mockResolvedValue(undefined)
    mockMutationLocks.lockUserMutation.mockResolvedValue(undefined)
    mockDb.user.findUnique.mockResolvedValue({ tokenVersion: 7 })
    mockDb.skill.count.mockResolvedValue(0)
    mockDb.skill.findUniqueOrThrow.mockResolvedValue({ versionHighWater: -1, versions: [], libraryEntries: [] })
    mockDb.skillVersion.findMany.mockImplementation(async () => { const row = await mockDb.skillVersion.findUnique(); return row ? [{ ...row, aliases: [] }] : [] })
    mockDb.skillVersion.count.mockResolvedValue(0)
    mockDb.skillVersion.findUnique.mockResolvedValue(null)
    mockDb.skillVersion.aggregate.mockResolvedValue({ _sum: { packageSize: 0 } })
    mockDb.marketplaceSubmission.updateMany.mockResolvedValue({ count: 0 })
    mockDb.marketplaceListing.updateMany.mockResolvedValue({ count: 0 })
    mockDb.teamMember.findMany.mockResolvedValue([])
    mockDb.skillTeamShare.findMany.mockResolvedValue([])
    mockDb.user.findMany.mockResolvedValue([])
    mockDb.teamActivity.create.mockResolvedValue({})
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof mockDb) => Promise<unknown>): Promise<unknown> => callback(mockDb)
    )
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    vi.unstubAllGlobals()
  })

  it('reads a useful fallback profile from SKILL.md frontmatter', () => {
    const profile = fallbackProfile('release-verifier', [
      '---',
      'name: SkillHub 正式版验收',
      'description: 验证导入、投影与环境变量。',
      'category: 开发与工程',
      'labels: [验收, Mac, SkillHub]',
      '---',
      '# Fallback title',
    ].join('\n'))

    expect(profile).toEqual({
      displayName: 'SkillHub 正式版验收',
      description: '验证导入、投影与环境变量。',
      category: '开发与工程',
      labels: ['测试验证', 'Skill管理', '环境配置', '发布部署'],
      triggerScenarios: [],
    })
  })

  it('defines a unique and fully grouped controlled label catalog', () => {
    const groupedLabels = SKILL_LABEL_TAXONOMY.flatMap((group) => group.labels)

    expect(new Set(SKILL_LABEL_CATALOG).size).toBe(SKILL_LABEL_CATALOG.length)
    expect(new Set(groupedLabels)).toEqual(new Set(SKILL_LABEL_CATALOG))
  })

  it.each([
    {
      name: 'research-helper',
      content: '# Research Helper\n\nGather primary sources and citations.',
      expected: ['深度研究', '信息检索'],
    },
    {
      name: 'image-generator',
      content: '# Image Generator\n\nUse GPT to create images and visual assets.',
      expected: ['图像创作', 'AI生成'],
    },
    {
      name: 'api-workflow',
      content: '# API Workflow\n\nAutomate webhook integration pipelines.',
      expected: ['流程自动化', 'API集成'],
    },
  ])('infers deterministic catalog labels for $name', ({ name, content, expected }) => {
    const first = inferFallbackSkillLabels(name, content, '其他')
    const second = inferFallbackSkillLabels(name, content, '其他')

    expect(first).toEqual(second)
    expect(first).toEqual(expect.arrayContaining(expected))
    expect(first.length).toBeGreaterThanOrEqual(2)
    expect(first.length).toBeLessThanOrEqual(5)
    expect(first.every((label) => SKILL_LABEL_CATALOG.includes(label))).toBe(true)
  })

  it('rejects AI profiles with invented, duplicate, or insufficient labels', () => {
    const baseProfile = {
      displayName: '验收助手',
      description: '验证发布流程',
      category: '开发与工程',
      triggerScenarios: ['发布前检查'],
    }

    expect(SkillProfileSchema.safeParse({
      ...baseProfile,
      labels: ['测试验证', '发布部署'],
    }).success).toBe(true)
    expect(SkillProfileSchema.safeParse({ ...baseProfile, labels: ['验收', '发布部署'] }).success).toBe(false)
    expect(SkillProfileSchema.safeParse({ ...baseProfile, labels: ['测试验证'] }).success).toBe(false)
    expect(SkillProfileSchema.safeParse({
      ...baseProfile,
      labels: ['测试验证', '测试验证'],
    }).success).toBe(false)
  })

  it.each([
    ['https://provider.example', 'https://provider.example/v1'],
    ['https://provider.example/', 'https://provider.example/v1'],
    ['https://provider.example/v1', 'https://provider.example/v1'],
    ['https://provider.example/v1/', 'https://provider.example/v1'],
    ['https://provider.example/api/v1', 'https://provider.example/api/v1'],
  ])('normalizes OpenAI-compatible base URL %s to %s', (baseUrl, expected) => {
    expect(openAiCompatibleBaseUrl(baseUrl)).toBe(expected)
  })

  it('uses the same portable Skill folder-name boundary as the Rust client', () => {
    for (const valid of ['humanizer-zh', 'skill_creator.v2', `a${'b'.repeat(127)}`]) {
      expect(SkillNameSchema.safeParse(valid).success, valid).toBe(true)
    }
    for (const invalid of [
      '.', '..', '.hidden', '-leading', '_leading', 'folder/name', 'folder\\name',
      '../escape', '技能', `a${'b'.repeat(128)}`, 'line\nbreak',
    ]) {
      expect(SkillNameSchema.safeParse(invalid).success, invalid).toBe(false)
    }
  })

  it('rejects unsafe Skill folder names on create, import, and update before database access', async () => {
    app = await buildApp()

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/skills',
      payload: { name: 'folder/name', displayName: 'Unsafe' },
    })
    const importResponse = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: { name: '../escape', skillMd: '# Unsafe', aiAnalysisConsent: true },
    })
    const updateResponse = await app.inject({
      method: 'PATCH',
      url: '/api/skills/skill-001',
      payload: { name: 'folder\\name' },
    })

    expect(createResponse.statusCode).toBe(400)
    expect(importResponse.statusCode).toBe(400)
    expect(updateResponse.statusCode).toBe(400)
    expect(mockDb.skill.create).not.toHaveBeenCalled()
    expect(mockDb.skill.findFirst).not.toHaveBeenCalled()
    expect(mockDb.skill.findUnique).not.toHaveBeenCalled()
  })

  it('changes declared keys without writing team credentials (scope is computed at runtime)', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-001',
      authorId: 'user-001',
      envDependencies: [
        { key: 'KEEP_KEY', required: true },
        { key: 'REMOVE_KEY', required: true },
      ],
    })
    mockDb.skill.update.mockResolvedValue({
      id: 'skill-001',
      envDependencies: [{ key: 'KEEP_KEY', required: true }],
    })
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof mockDb) => Promise<unknown>): Promise<unknown> => callback(mockDb)
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/skills/skill-001',
      payload: { envDependencies: [{ key: 'KEEP_KEY', required: true }] },
    })

    expect(response.statusCode).toBe(200)
    expect(mockDb.skill.update).toHaveBeenCalledWith({
      where: { id: 'skill-001' },
      data: { envDependencies: [{ key: 'KEEP_KEY', required: true }] },
    })
    expect(mockDb.teamCredential.updateMany).not.toHaveBeenCalled()
    expect(mockDb.credentialAuditEvent.create).not.toHaveBeenCalled()
    expect(mockMutationLocks.lockSkillMutation).toHaveBeenCalledWith(mockDb, 'skill-001')
    expect(mockMutationLocks.lockSkillMutation.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.skill.findUnique.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    )
  })

  it('publishes a version that drops a declared key without writing team credentials', async () => {
    const createdAt = new Date('2026-08-03T00:00:00.000Z')
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-001',
      authorId: 'user-001',
      displayName: 'Credential Skill',
      envDependencies: [
        { key: 'KEEP_KEY', required: true },
        { key: 'REMOVE_KEY', required: true },
      ],
    })
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      cardGrant: mockDb.cardGrant,
      skillVersion: {
        findUnique: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
        aggregate: vi.fn().mockResolvedValue({ _sum: { packageSize: 0 } }),
        create: vi.fn().mockResolvedValue({
          id: 'version-002', skillId: 'skill-001', version: '2.0.0', changelog: 'remove key',
          gitHash: null, packageSha256: null, packageSize: null, createdAt,
        }),
      },
      skill: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'skill-001',
          authorId: 'user-001',
          displayName: 'Credential Skill',
          envDependencies: [
            { key: 'KEEP_KEY', required: true },
            { key: 'REMOVE_KEY', required: true },
          ],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      teamCredential: { updateMany: vi.fn() },
      credentialAuditEvent: { create: vi.fn().mockResolvedValue({ id: 'audit-001' }) },
      teamMember: { findMany: vi.fn().mockResolvedValue([]) },
      notification: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback({ ...mockDb, ...transaction, skill: { ...mockDb.skill, ...transaction.skill }, skillVersion: { ...mockDb.skillVersion, ...transaction.skillVersion } })
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/versions',
      payload: {
        version: '2.0.0',
        changelog: 'remove key',
        envDependencies: [{ key: 'KEEP_KEY', required: true }],
        ...packagedVersionFields('# Credential Skill v2'),
      },
    })

    expect(response.statusCode).toBe(201)
    expect(transaction.teamCredential.updateMany).not.toHaveBeenCalled()
    expect(transaction.credentialAuditEvent.create).not.toHaveBeenCalled()
    expect(mockMutationLocks.lockSkillMutation).toHaveBeenCalledWith(expect.objectContaining({ $executeRaw: transaction.$executeRaw }), 'skill-001')
    expect(mockMutationLocks.lockSkillMutation.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.skill.findUnique.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    )
  })

  it('uses an ASCII fallback and RFC 5987 encoding for package filenames', () => {
    const disposition = skillPackageContentDisposition("legacy/技能'\"\r\nX-Injected: yes")

    expect(disposition).toMatch(/^attachment; filename="skill-package\.zip"; filename\*=UTF-8''/)
    expect(disposition).toMatch(/^[\x20-\x7E]+$/)
    expect(disposition).toContain('%2F')
    expect(disposition).toContain('%27')
    expect(disposition).toContain('%22')
    expect(disposition).toContain('%0D%0A')
    expect(disposition).not.toContain('\r')
    expect(disposition).not.toContain('\n')
  })

  it.each([
    ['missing', undefined],
    ['different subject', { sub: 'other-user', ver: 7 }],
    ['non-integer version', { sub: 'user-001', ver: 7.5 }],
  ] as const)('fails closed when the verified import token is %s', async (_label, token) => {
    mockAuth.verifiedAuthToken = token
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: { name: 'research-helper', skillMd: '# Research Helper', aiAnalysisConsent: true },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'Unauthorized' })
    expect(mockDb.skill.findFirst).not.toHaveBeenCalled()
    expect(mockDb.$transaction).not.toHaveBeenCalled()
    expect(mockDb.skill.create).not.toHaveBeenCalled()
  })

  it('rejects an import when tokenVersion changes during the AI request', async () => {
    const aiStarted = deferred<void>()
    const aiResponse = deferred<Response>()
    let currentTokenVersion = 7
    mockConfig.AI_API_BASE_URL = 'https://provider.example'
    mockConfig.AI_API_KEY = 'test-api-key'
    mockDb.skill.findFirst.mockResolvedValue(null)
    mockDb.user.findUnique.mockImplementation(async () => ({ tokenVersion: currentTokenVersion }))
    vi.stubGlobal('fetch', vi.fn(async () => {
      aiStarted.resolve()
      return aiResponse.promise
    }))
    app = await buildApp()

    const pendingResponse = app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: { name: 'research-helper', skillMd: '# Research Helper', aiAnalysisConsent: true },
    })
    await aiStarted.promise
    currentTokenVersion += 1
    aiResponse.resolve(new Response(JSON.stringify({
      content: [{
        type: 'text',
        text: JSON.stringify({
          displayName: '研究助手',
          description: '汇总资料并生成结构化研究结果',
          category: '搜索与研究',
          labels: ['信息检索', '深度研究'],
          triggerScenarios: ['资料检索'],
        }),
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const response = await pendingResponse

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'Unauthorized' })
    expect(mockMutationLocks.lockUserMutation).toHaveBeenCalledWith(mockDb, 'user-001')
    expect(mockMutationLocks.lockUserMutation.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.user.findUnique.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    )
    expect(mockDb.skill.findFirst).toHaveBeenCalledTimes(1)
    expect(mockMutationLocks.lockSkillMutation).not.toHaveBeenCalled()
    expect(mockDb.skill.create).not.toHaveBeenCalled()
    expect(mockDb.skill.update).not.toHaveBeenCalled()
  })

  it('analyzes metadata and creates the initial version during import', async () => {
    const createdAt = new Date('2026-08-02T00:00:00.000Z')
    mockDb.skill.findFirst.mockResolvedValue(null)
    mockDb.skill.create.mockResolvedValue({
      id: 'skill-001',
      name: 'research-helper',
      displayName: 'research-helper',
      description: 'This skill gathers primary sources and returns a concise report.',
      category: '其他',
      labels: [],
      triggerScenarios: [],
      compatibleAgents: ['claude', 'codex'],
      authorId: 'user-001',
      currentVersion: '0.1.0',
      installCount: 0,
      visibility: 'private',
      marketplaceStatus: 'none',
      ossPackageKey: null,
      createdAt,
      updatedAt: createdAt,
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: {
        name: 'research-helper',
        skillMd: '# Research Helper\n\nThis skill gathers primary sources and returns a concise report.',
        compatibleAgents: ['claude', 'codex', 'workbuddy', 'doubao', 'opencode', 'openclaw', 'trae'],
        aiAnalysisConsent: true,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      skill: { id: 'skill-001' },
      analysis: { status: 'fallback', provider: null, redactedSecrets: 0 },
    })
    expect(mockDb.skill.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'research-helper',
        authorId: 'user-001',
        compatibleAgents: ['claude', 'codex', 'workbuddy', 'doubao', 'opencode', 'openclaw', 'trae'],
        currentVersion: '0.1.0',
        versions: {
          create: expect.objectContaining({
            version: '0.1.0',
            changelog: '首次导入',
            profileSnapshotVersion: 1,
            skillName: 'research-helper',
            displayName: 'Research Helper',
            description: 'This skill gathers primary sources and returns a concise report.',
            category: '其他',
            labels: expect.any(Array),
            triggerScenarios: [],
            compatibleAgents: ['claude', 'codex', 'workbuddy', 'doubao', 'opencode', 'openclaw', 'trae'],
            envDependencies: [],
            sourceContent: '# Research Helper\n\nThis skill gathers primary sources and returns a concise report.',
          }),
        },
      }),
    })
    expect(mockDb.$transaction).toHaveBeenCalledTimes(2)
    expect(mockMutationLocks.lockUserMutation).toHaveBeenCalledWith(mockDb, 'user-001')
    expect(mockMutationLocks.lockUserMutation.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.user.findUnique.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    )
    expect(mockDb.user.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.skill.findFirst.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER
    )
    expect(mockDb.skill.findFirst.mock.invocationCallOrder[1]).toBeLessThan(
      mockDb.skill.create.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    )
  })

  it('preserves exact import recovery when the duplicate appears during analysis', async () => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    const createdAt = new Date('2026-08-02T00:00:00.000Z')
    const existing = {
      id: 'skill-existing',
      name: 'packaged-skill',
      displayName: 'Packaged Skill',
      description: null,
      category: null,
      labels: [],
      triggerScenarios: [],
      compatibleAgents: ['codex'],
      envDependencies: [],
      sourceContent: '# Packaged Skill',
      authorId: 'user-001',
      currentVersion: '0.1.0',
      installCount: 0,
      visibility: 'private',
      marketplaceStatus: 'none',
      ossPackageKey: null,
      createdAt,
      updatedAt: createdAt,
      importVersionId: 'initial-version',
      versions: [{ id: 'initial-version', version: '0.1.0', aliases: [], packageSha256, compatibleAgents: ['codex'], envDependencies: [] }],
    }
    mockDb.skill.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing)
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: {
        name: 'packaged-skill',
        skillMd: '# Packaged Skill',
        currentVersion: '0.1.0',
        compatibleAgents: ['codex'],
        aiAnalysisConsent: true,
        packageBase64: packageData.toString('base64'),
        packageSha256,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      skill: { id: 'skill-existing' },
      analysis: { status: 'recovered' },
      recovered: true,
      idempotent: true,
    })
    expect(mockDb.$transaction).toHaveBeenCalledTimes(2)
    expect(mockMutationLocks.lockUserMutation).toHaveBeenCalledWith(mockDb, 'user-001')
    expect(mockDb.skill.create).not.toHaveBeenCalled()
  })

  it('stores a checksum-verified installable package during import', async () => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockDb.skill.findFirst.mockResolvedValue(null)
    mockDb.skill.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'skill-package', ...data, installCount: 0, visibility: 'private', marketplaceStatus: 'none',
      createdAt: new Date(), updatedAt: new Date(),
    }))
    app = await buildApp()

    const response = await app.inject({
      method: 'POST', url: '/api/skills/import', payload: {
        name: 'packaged-skill', skillMd: '# Packaged Skill', aiAnalysisConsent: true,
        packageBase64: packageData.toString('base64'), packageSha256,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(mockDb.skill.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        versions: { create: expect.objectContaining({ packageData, packageSha256, packageSize: packageData.length }) },
      }),
    })
  })

  it('rejects a package whose SKILL.md differs from the analyzed source', async () => {
    const packageData = createStoredSkillZip('# Different Skill\n')
    mockDb.skill.findFirst.mockResolvedValue(null)
    app = await buildApp()

    const response = await app.inject({
      method: 'POST', url: '/api/skills/import', payload: {
        name: 'mismatched-skill',
        skillMd: '# Expected Skill',
        aiAnalysisConsent: true,
        packageBase64: packageData.toString('base64'),
        packageSha256: createHash('sha256').update(packageData).digest('hex'),
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      message: 'SKILL.md does not match the uploaded package',
    })
    expect(mockDb.skill.create).not.toHaveBeenCalled()
  })

  it('rejects a Skill package when its checksum does not match', async () => {
    mockDb.skill.findFirst.mockResolvedValue(null)
    app = await buildApp()
    const response = await app.inject({
      method: 'POST', url: '/api/skills/import', payload: {
        name: 'tampered-skill', skillMd: '# Tampered', aiAnalysisConsent: true,
        packageBase64: Buffer.from('tampered').toString('base64'), packageSha256: 'a'.repeat(64),
      },
    })
    expect(response.statusCode).toBe(400)
    expect(mockDb.skill.create).not.toHaveBeenCalled()
  })

  it('stores the package declaration ∪ client list and the re-check result on import (#251)', async () => {
    const skillMd = [
      '---',
      'name: declared-skill',
      'metadata:',
      '  skillhub:',
      '    env:',
      '      - key: FAL_KEY',
      '        required: false',
      '        description: fal.ai API Key',
      '        obtain: https://fal.ai/dashboard/keys',
      '---',
      '# Declared Skill',
      '',
      '```js',
      'const token = process.env.REPLICATE_API_TOKEN',
      '```',
    ].join('\n')
    const packageData = createStoredSkillZip(`${skillMd}\n`)
    mockDb.skill.findFirst.mockResolvedValue(null)
    mockDb.skill.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'skill-declared', ...data, installCount: 0, visibility: 'private', marketplaceStatus: 'none',
      createdAt: new Date(), updatedAt: new Date(),
    }))
    app = await buildApp()

    const response = await app.inject({
      method: 'POST', url: '/api/skills/import', payload: {
        name: 'declared-skill', skillMd, aiAnalysisConsent: true,
        // An older client sends its own list; the declaration still wins for FAL_KEY.
        envDependencies: [{ key: 'FAL_KEY', required: true }, { key: 'OTHER_TOKEN', required: true }],
        packageBase64: packageData.toString('base64'),
        packageSha256: createHash('sha256').update(packageData).digest('hex'),
      },
    })

    expect(response.statusCode).toBe(201)
    const expectedDependencies = [
      { key: 'FAL_KEY', required: false, description: 'fal.ai API Key', obtain: 'https://fal.ai/dashboard/keys' },
      { key: 'OTHER_TOKEN', required: true },
    ]
    expect(mockDb.skill.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        envDependencies: expectedDependencies,
        versions: { create: expect.objectContaining({ envDependencies: expectedDependencies, detectedUndeclared: ['REPLICATE_API_TOKEN'] }) },
      }),
    })
    expect(response.json()).toMatchObject({ detectedUndeclared: ['REPLICATE_API_TOKEN'] })
  })

  it('keeps an old client import without a declaration unchanged and records detected keys (#251)', async () => {
    const skillMd = '# Legacy Skill\n\n```python\nimport os\nos.getenv("FAL_KEY")\n```'
    const packageData = createStoredSkillZip(`${skillMd}\n`)
    mockDb.skill.findFirst.mockResolvedValue(null)
    mockDb.skill.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'skill-legacy', ...data, installCount: 0, visibility: 'private', marketplaceStatus: 'none',
      createdAt: new Date(), updatedAt: new Date(),
    }))
    app = await buildApp()

    const response = await app.inject({
      method: 'POST', url: '/api/skills/import', payload: {
        name: 'legacy-skill', skillMd, aiAnalysisConsent: true,
        packageBase64: packageData.toString('base64'),
        packageSha256: createHash('sha256').update(packageData).digest('hex'),
      },
    })

    expect(response.statusCode).toBe(201)
    expect(mockDb.skill.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        envDependencies: [],
        versions: { create: expect.objectContaining({ envDependencies: [], detectedUndeclared: ['FAL_KEY'] }) },
      }),
    })
  })

  it('rejects an import whose SKILL.md declaration is invalid (#251)', async () => {
    const skillMd = '---\nname: bad\nmetadata:\n  skillhub:\n    env:\n      - key: fal_key\n---\n# Bad'
    mockDb.skill.findFirst.mockResolvedValue(null)
    app = await buildApp()

    const response = await app.inject({
      method: 'POST', url: '/api/skills/import', payload: { name: 'bad-declaration', skillMd, aiAnalysisConsent: true },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ message: 'SKILL.md metadata.skillhub.env is invalid: item 1 has an invalid key' })
    expect(mockDb.skill.create).not.toHaveBeenCalled()
  })

  it('merges a new version declaration into the preserved dependency list (#251)', async () => {
    const skillMd = '---\nname: research-helper\nmetadata:\n  skillhub:\n    env:\n      - key: FAL_KEY\n        obtain: https://fal.ai/dashboard/keys\n---\n# Version Two'
    const payload = { version: '2.0.0', changelog: '声明钥匙', ...packagedVersionFields(skillMd) }
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-001',
      name: 'research-helper',
      authorId: 'user-001',
      deletedAt: null,
      displayName: '研究助手',
      description: null,
      category: null,
      labels: [],
      triggerScenarios: [],
      compatibleAgents: [],
      envDependencies: [{ key: 'EXAMPLE_API_KEY', required: true }],
    })
    mockDb.skillVersion.create.mockResolvedValue({
      id: 'version-002', skillId: 'skill-001', version: payload.version, changelog: payload.changelog, gitHash: null,
      packageSha256: payload.packageSha256, packageSize: 256, mutationDigest: mutationDigestFor(payload),
      detectedUndeclared: [], createdAt: new Date(),
    })
    app = await buildApp()

    const response = await app.inject({ method: 'POST', url: '/api/skills/skill-001/versions', payload })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ detectedUndeclared: [] })
    const merged = [
      { key: 'EXAMPLE_API_KEY', required: true },
      { key: 'FAL_KEY', required: true, obtain: 'https://fal.ai/dashboard/keys' },
    ]
    expect(mockDb.skillVersion.create.mock.calls[0]?.[0].data).toMatchObject({ envDependencies: merged, detectedUndeclared: [] })
    expect(mockDb.skill.update).toHaveBeenCalledWith({
      where: { id: 'skill-001' },
      data: expect.objectContaining({ envDependencies: merged }),
    })
  })

  it('rejects imports after the account Skill limit is reached', async () => {
    mockConfig.SKILL_MAX_PER_USER = 1
    mockDb.skill.findFirst.mockResolvedValue(null)
    mockDb.skill.count.mockResolvedValue(1)
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: { name: 'over-limit', skillMd: '# Over limit', aiAnalysisConsent: true },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'Skill account limit reached' })
    expect(mockDb.skill.create).not.toHaveBeenCalled()
  })

  it('bounds retained recycle-bin metadata even when active Skill capacity remains', async () => {
    mockDb.skill.findFirst.mockResolvedValue(null)
    mockDb.skill.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1_000)
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: { name: 'over-trash-limit', skillMd: '# Over trash limit', aiAnalysisConsent: true },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'Skill recycle bin limit reached' })
    expect(mockDb.skill.create).not.toHaveBeenCalled()
  })

  it('serializes concurrent imports so they cannot race past the account limit', async () => {
    mockConfig.SKILL_MAX_PER_USER = 1
    mockDb.skill.findFirst.mockResolvedValue(null)
    let createdCount = 0
    mockDb.skill.count.mockImplementation(async () => createdCount)
    mockDb.skill.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      createdCount += 1
      const now = new Date('2026-08-03T00:00:00.000Z')
      return {
        id: `skill-${createdCount}`,
        ...data,
        installCount: 0,
        visibility: 'private',
        marketplaceStatus: 'none',
        ossPackageKey: null,
        createdAt: now,
        updatedAt: now,
      }
    })
    app = await buildApp()

    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/skills/import', payload: { name: 'concurrent-a', skillMd: '# A', aiAnalysisConsent: true } }),
      app.inject({ method: 'POST', url: '/api/skills/import', payload: { name: 'concurrent-b', skillMd: '# B', aiAnalysisConsent: true } }),
    ])

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409])
    expect(mockDb.skill.create).toHaveBeenCalledTimes(1)
  })

  it('rejects a package that would exceed the account storage quota', async () => {
    const packageData = createStoredSkillZip('# Quota Skill\n')
    mockConfig.SKILL_MAX_STORAGE_BYTES_PER_USER = packageData.length - 1
    mockDb.skill.findFirst.mockResolvedValue(null)
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: {
        name: 'quota-skill',
        skillMd: '# Quota Skill',
        aiAnalysisConsent: true,
        packageBase64: packageData.toString('base64'),
        packageSha256: createHash('sha256').update(packageData).digest('hex'),
      },
    })

    expect(response.statusCode).toBe(413)
    expect(response.json()).toEqual({ error: 'Skill storage quota exceeded' })
    expect(mockDb.skill.create).not.toHaveBeenCalled()
  })

  it('rejects a new version after the per-Skill history limit is reached', async () => {
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001' })
    mockDb.skillVersion.count.mockResolvedValue(30)
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/versions',
      payload: { version: '3.1.0', ...packagedVersionFields('# Version 31') },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'SKILL_VERSION_LIMIT_REACHED' })
    expect(mockDb.$transaction).toHaveBeenCalledOnce()
  })

  it('binds every new version to its own redacted SKILL.md snapshot', async () => {
    const skillMd = '# Version Two\nUses EXAMPLE_API_KEY from the environment.'
    const payload = { version: '2.0.0', changelog: '安全更新', ...packagedVersionFields(skillMd) }
    const createdAt = new Date('2026-08-03T00:00:00.000Z')
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-001',
      name: 'research-helper',
      authorId: 'user-001',
      deletedAt: null,
      displayName: '研究助手',
      description: '固定版本资料',
      category: '搜索与研究',
      labels: ['信息检索', '深度研究'],
      triggerScenarios: ['需要调研时'],
      compatibleAgents: ['codex'],
      envDependencies: [{ key: 'EXAMPLE_API_KEY', required: true }],
    })
    mockDb.skillVersion.create.mockResolvedValue({
      id: 'version-002',
      skillId: 'skill-001',
      version: payload.version,
      changelog: payload.changelog,
      gitHash: null,
      packageSha256: payload.packageSha256,
      packageSize: 256,
      mutationDigest: mutationDigestFor(payload),
      createdAt,
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/versions',
      payload,
    })

    expect(response.statusCode).toBe(201)
    const createData = mockDb.skillVersion.create.mock.calls[0]?.[0].data as {
      sourceContent: string
      profileSnapshotVersion: number
      skillName: string
      displayName: string
      description: string
      category: string
      labels: string[]
      triggerScenarios: string[]
      compatibleAgents: string[]
      envDependencies: Array<{ key: string; required: boolean }>
    }
    expect(createData.sourceContent).toBe(skillMd)
    expect(createData).toMatchObject({
      profileSnapshotVersion: 1,
      skillName: 'research-helper',
      displayName: '研究助手',
      description: '固定版本资料',
      category: '搜索与研究',
      labels: ['信息检索', '深度研究'],
      triggerScenarios: ['需要调研时'],
      compatibleAgents: ['codex'],
      envDependencies: [{ key: 'EXAMPLE_API_KEY', required: true }],
    })
    expect(mockDb.skill.update).toHaveBeenCalledWith({
      where: { id: 'skill-001' },
      data: {
        currentVersion: '2.0.0',
        versionHighWater: 200,
        sourceContent: createData.sourceContent,
      },
    })
  })

  it('returns the existing version for an exact retry after a lost response', async () => {
    const payload = { version: '2.0.0', changelog: '安全更新', ...packagedVersionFields('# Version Two') }
    const existing = {
      id: 'version-002',
      skillId: 'skill-001',
      version: payload.version,
      changelog: payload.changelog,
      gitHash: null,
      packageSha256: payload.packageSha256,
      packageSize: 128,
      mutationDigest: mutationDigestFor(payload),
      createdAt: new Date('2026-08-03T00:00:00.000Z'),
    }
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001' })
    mockDb.skillVersion.findUnique.mockResolvedValue(existing)
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/versions',
      payload,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: existing.id, packageSha256: payload.packageSha256 })
    expect(mockDb.$transaction).toHaveBeenCalled()
  })

  it('rejects a same-package retry when environment dependencies differ', async () => {
    const payload = {
      version: '2.0.0',
      changelog: '安全更新',
      envDependencies: [{ key: 'NEW_KEY', required: true }],
      ...packagedVersionFields('# Version Two'),
    }
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001' })
    mockDb.skillVersion.findUnique.mockResolvedValue({
      id: 'version-002',
      skillId: 'skill-001',
      version: payload.version,
      changelog: payload.changelog,
      gitHash: null,
      packageSha256: payload.packageSha256,
      packageSize: 128,
      mutationDigest: versionMutationDigest({
        ...payload,
        envDependencies: [{ key: 'OLD_KEY', required: true }],
      }, payload.packageSha256),
      createdAt: new Date('2026-08-03T00:00:00.000Z'),
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/versions',
      payload,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'VERSION_REQUEST_CONFLICT' })
    expect(mockDb.$transaction).toHaveBeenCalled()
  })

  it('rejects duplicate environment dependency keys before mutating a version', async () => {
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001' })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/versions',
      payload: {
        version: '2.0.0',
        envDependencies: [
          { key: 'DUPLICATE_KEY', required: true },
          { key: 'DUPLICATE_KEY', required: false },
        ],
        ...packagedVersionFields('# Version Two'),
      },
    })

    expect(response.statusCode).toBe(400)
    expect(mockDb.skillVersion.findUnique).not.toHaveBeenCalled()
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a same-number version retry when its package differs', async () => {
    const payload = { version: '2.0.0', changelog: '安全更新', ...packagedVersionFields('# Version Two') }
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001' })
    mockDb.skillVersion.findUnique.mockResolvedValue({
      id: 'version-002',
      skillId: 'skill-001',
      version: payload.version,
      changelog: payload.changelog,
      gitHash: null,
      packageSha256: 'f'.repeat(64),
      packageSize: 128,
      mutationDigest: 'f'.repeat(64),
      createdAt: new Date('2026-08-03T00:00:00.000Z'),
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/versions',
      payload,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'VERSION_REQUEST_CONFLICT' })
    expect(mockDb.$transaction).toHaveBeenCalled()
  })

  it('does not apply the version-write rate limit to an exact retry', async () => {
    const payload = { version: '2.0.0', changelog: '安全更新', ...packagedVersionFields('# Version Two') }
    const existing = {
      id: 'version-002',
      skillId: 'skill-001',
      version: payload.version,
      changelog: payload.changelog,
      gitHash: null,
      packageSha256: payload.packageSha256,
      packageSize: 128,
      mutationDigest: mutationDigestFor(payload),
      createdAt: new Date('2026-08-03T00:00:00.000Z'),
    }
    mockConfig.SKILL_VERSION_WRITES_PER_HOUR = 1
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001' })
    mockDb.skillVersion.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing)
    mockDb.skillVersion.count.mockResolvedValue(30)
    app = await buildApp()

    const quotaResponse = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/versions',
      payload: { version: '3.1.0', ...packagedVersionFields('# Version 31') },
    })
    const retryResponse = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/versions',
      payload,
    })

    expect(quotaResponse.statusCode).toBe(409)
    expect(retryResponse.statusCode).toBe(200)
    expect(retryResponse.json()).toMatchObject({ id: existing.id })
    expect(mockDb.$transaction).toHaveBeenCalled()
  })

  it('returns the raced exact version before the transactional quota recheck', async () => {
    const payload = { version: '2.0.0', changelog: '安全更新', ...packagedVersionFields('# Version Two') }
    const existing = {
      id: 'version-002',
      skillId: 'skill-001',
      version: payload.version,
      changelog: payload.changelog,
      gitHash: null,
      packageSha256: payload.packageSha256,
      packageSize: 128,
      mutationDigest: mutationDigestFor(payload),
      createdAt: new Date('2026-08-03T00:00:00.000Z'),
    }
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001' })
    mockDb.skillVersion.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing)
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/versions',
      payload,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: existing.id })
    expect(mockDb.$transaction).toHaveBeenCalledTimes(2)
    expect(mockDb.skillVersion.count).toHaveBeenCalledOnce()
    expect(mockDb.skillVersion.create).not.toHaveBeenCalled()
  })

  it('rejects a raced version whose changelog differs before the transactional quota recheck', async () => {
    const payload = { version: '2.0.0', changelog: '新说明', ...packagedVersionFields('# Version Two') }
    const racedVersion = {
      id: 'version-002',
      skillId: 'skill-001',
      version: payload.version,
      changelog: '旧说明',
      gitHash: null,
      packageSha256: payload.packageSha256,
      packageSize: 128,
      mutationDigest: versionMutationDigest({ ...payload, changelog: '旧说明' }, payload.packageSha256),
      createdAt: new Date('2026-08-03T00:00:00.000Z'),
    }
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001' })
    mockDb.skillVersion.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(racedVersion)
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/versions',
      payload,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'VERSION_REQUEST_CONFLICT' })
    expect(mockDb.$transaction).toHaveBeenCalledTimes(2)
    expect(mockDb.skillVersion.count).toHaveBeenCalledOnce()
    expect(mockDb.skillVersion.create).not.toHaveBeenCalled()
  })

  it('requires SKILL.md when a new version uploads a package', async () => {
    const packageData = createStoredSkillZip('# Version Two\n')
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001' })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/versions',
      payload: {
        version: '2.0.0',
        packageBase64: packageData.toString('base64'),
        packageSha256: createHash('sha256').update(packageData).digest('hex'),
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain('skillMd')
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a metadata-only version so currentVersion can never advance past its package', async () => {
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001' })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/versions',
      payload: { version: '2.0.0', skillMd: '# Version Two' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain('packageBase64')
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it('downloads the latest package for a team member as binary', async () => {
    const packageData = createStoredSkillZip('# Downloadable Skill\n')
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-shared', name: 'shared-skill', authorId: 'other-user', currentVersion: 'v1.0', teamShares: [{ teamId: 'team-001' }],
    })
    mockDb.teamMember.count.mockResolvedValue(1)
    mockDb.skillVersion.findFirst.mockResolvedValue({
      id: 'version-001', version: 'v1.0', packageData, packageSha256,
    })
    mockDb.skill.update.mockResolvedValue({})
    app = await buildApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/skills/skill-shared/package',
      headers: { origin: 'http://localhost:1420' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.rawPayload).toEqual(packageData)
    expect(response.headers['x-checksum-sha256']).toBe(packageSha256)
    expect(response.headers['x-skill-version']).toBe('v1.0')
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:1420')
    const exposedHeaders = String(response.headers['access-control-expose-headers'])
      .toLowerCase()
      .split(',')
      .map((header) => header.trim())
    expect(exposedHeaders).toEqual(expect.arrayContaining([
      'x-checksum-sha256',
      'x-skill-version',
      'retry-after',
    ]))
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="skill-package.zip"; filename*=UTF-8''shared-skill.zip`
    )
    expect(mockDb.skillVersion.findFirst).toHaveBeenCalledWith({
      where: { skillId: 'skill-shared', version: 'v1.0', OR: [{ packageData: { not: null } }, { cardSha256: { not: null } }] },
      select: { id: true, version: true, packageData: true, packageSha256: true, cardSha256: true },
    })
    expect(mockDb.skill.update).toHaveBeenCalledWith({
      where: { id: 'skill-shared' }, data: { installCount: { increment: 1 } },
    })
  })

  it('fails closed when a legacy stored package is not a safe Skill ZIP', async () => {
    const packageData = Buffer.from('legacy-unsafe-bytes')
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-shared', name: 'shared-skill', authorId: 'other-user', currentVersion: 'v0.3', teamShares: [{ teamId: 'team-001' }],
    })
    mockDb.teamMember.count.mockResolvedValue(1)
    mockDb.skillVersion.findFirst.mockResolvedValue({
      id: 'version-legacy',
      version: 'v0.3',
      packageData,
      packageSha256: createHash('sha256').update(packageData).digest('hex'),
    })
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/skills/skill-shared/package' })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({
      error: 'Stored Skill package failed safety validation; the owner must upload a new version',
    })
    expect(mockDb.skill.update).not.toHaveBeenCalled()
  })

  it('never falls back to an older package when the current version has none', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-shared',
      name: 'shared-skill',
      authorId: 'user-001',
      currentVersion: '2.0.0',
      teamShares: [],
    })
    mockDb.skillVersion.findFirst.mockResolvedValue(null)
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/skills/skill-shared/package' })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      statusCode: 409,
      message: 'The current Skill version has no installable package; the owner must upload it again',
    })
    expect(mockDb.skillVersion.findFirst).toHaveBeenCalledWith({
      where: { skillId: 'skill-shared', version: '2.0.0', OR: [{ packageData: { not: null } }, { cardSha256: { not: null } }] },
      select: { id: true, version: true, packageData: true, packageSha256: true, cardSha256: true },
    })
    expect(mockDb.skill.update).not.toHaveBeenCalled()
  })

  it('denies a package after the departed author share has been removed', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-departed',
      name: 'departed-skill',
      authorId: 'departed-user',
      teamShares: [],
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: '/api/skills/skill-departed/package',
    })

    expect(response.statusCode).toBe(403)
    expect(mockDb.teamMember.count).not.toHaveBeenCalled()
    expect(mockDb.skillVersion.findFirst).not.toHaveBeenCalled()
  })

  it('does not notify a former team after its authored Skill share was removed', async () => {
    const createdAt = new Date('2026-08-03T00:00:00.000Z')
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-001',
      authorId: 'user-001',
      displayName: '离队成员 Skill',
    })
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      cardGrant: mockDb.cardGrant,
      skillVersion: {
        findUnique: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
        aggregate: vi.fn().mockResolvedValue({ _sum: { packageSize: 0 } }),
        create: vi.fn().mockResolvedValue({
          id: 'version-002',
          skillId: 'skill-001',
          version: '2.0.0',
          changelog: '离队后更新',
          gitHash: null,
          packageSha256: null,
          packageSize: null,
          createdAt,
        }),
      },
      skill: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'skill-001',
          authorId: 'user-001',
          displayName: '离队成员 Skill',
          envDependencies: [],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      teamMember: { findMany: vi.fn().mockResolvedValue([]) },
      notification: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback({ ...mockDb, ...transaction, skill: { ...mockDb.skill, ...transaction.skill }, skillVersion: { ...mockDb.skillVersion, ...transaction.skillVersion } })
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/versions',
      payload: {
        version: '2.0.0',
        changelog: '离队后更新',
        ...packagedVersionFields('# Departed Skill v2'),
      },
    })

    expect(response.statusCode).toBe(201)
    expect(transaction.teamMember.findMany).toHaveBeenCalledWith({
      where: {
        userId: { not: 'user-001' },
        team: {
          dissolvedAt: null,
          skillShares: { some: { skillId: 'skill-001' } },
        },
      },
      distinct: ['userId'],
      select: { userId: true },
    })
    expect(transaction.notification.createMany).not.toHaveBeenCalled()
    expect(mockDb.teamActivity.create).not.toHaveBeenCalled()
  })

  it('records one version activity per active team the Skill is shared to', async () => {
    const createdAt = new Date('2026-10-14T00:00:00.000Z')
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      cardGrant: mockDb.cardGrant,
      skillVersion: {
        findUnique: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
        aggregate: vi.fn().mockResolvedValue({ _sum: { packageSize: 0 } }),
        create: vi.fn().mockResolvedValue({
          id: 'version-002', skillId: 'skill-001', version: '2.0.0', changelog: '新版',
          gitHash: null, packageSha256: null, packageSize: null, createdAt,
        }),
      },
      skill: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'skill-001', authorId: 'user-001', displayName: '周报助手', envDependencies: [],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      skillTeamShare: {
        findMany: vi.fn().mockResolvedValue([{ teamId: 'team-001' }, { teamId: 'team-002' }]),
      },
      teamActivity: { create: vi.fn().mockResolvedValue({}) },
      teamMember: { findMany: vi.fn().mockResolvedValue([]) },
      notification: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback({ ...mockDb, ...transaction, skill: { ...mockDb.skill, ...transaction.skill }, skillVersion: { ...mockDb.skillVersion, ...transaction.skillVersion } })
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/versions',
      payload: { version: '2.0.0', changelog: '新版', ...packagedVersionFields('# Weekly v2') },
    })

    expect(response.statusCode).toBe(201)
    expect(transaction.skillTeamShare.findMany).toHaveBeenCalledWith({
      where: { skillId: 'skill-001', team: { dissolvedAt: null } },
      select: { teamId: true },
    })
    expect(transaction.teamActivity.create).toHaveBeenCalledTimes(2)
    for (const teamId of ['team-001', 'team-002']) {
      expect(transaction.teamActivity.create).toHaveBeenCalledWith({
        data: {
          teamId,
          actorId: 'user-001',
          type: 'skill_version_published',
          payload: { skillId: 'skill-001', skillName: '周报助手', version: '2.0.0' },
        },
      })
    }
    expect(JSON.stringify(transaction.teamActivity.create.mock.calls)).not.toMatch(/"(value|ciphertext|email|token)"/)
  })

  it('requires active membership when listing team-scoped Skills', async () => {
    mockDb.teamMember.findUnique.mockResolvedValue(null)
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: '/api/skills?scope=team&teamId=team-001',
    })

    expect(response.statusCode).toBe(403)
    expect(mockDb.skillTeamShare.findMany).not.toHaveBeenCalled()
  })

  it('rejects team-scoped Skill reads after the team is dissolved', async () => {
    mockDb.teamMember.findUnique.mockResolvedValue({
      teamId: 'team-001',
      userId: 'user-001',
      team: { dissolvedAt: new Date('2026-08-03T00:00:00.000Z') },
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: '/api/skills?scope=team&teamId=team-001',
    })

    expect(response.statusCode).toBe(410)
    expect(mockDb.skillTeamShare.findMany).not.toHaveBeenCalled()
  })

  it('lists shared Skills for an active team member', async () => {
    mockDb.teamMember.findUnique.mockResolvedValue({
      teamId: 'team-001',
      userId: 'user-001',
      team: { dissolvedAt: null },
    })
    mockDb.skillTeamShare.findMany.mockResolvedValue([
      {
        sharedById: 'sharer-001',
        createdAt: new Date('2026-10-14T08:00:00.000Z'),
        skill: {
          id: 'skill-shared',
          name: 'shared-skill',
          sourceContent: '# private source',
          ossPackageKey: 'private/object.zip',
        },
      },
      {
        sharedById: 'deleted-user',
        createdAt: new Date('2026-10-13T08:00:00.000Z'),
        skill: { id: 'skill-orphan', name: 'orphan-skill' },
      },
    ])
    mockDb.user.findMany.mockResolvedValue([
      { id: 'sharer-001', displayName: '小王', avatarUrl: 'https://cdn.example.com/w.png' },
    ])
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: '/api/skills?scope=team&teamId=team-001',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([
      {
        id: 'skill-shared',
        sourceUrl: null,
        name: 'shared-skill',
        sharedBy: { id: 'sharer-001', displayName: '小王', avatarUrl: 'https://cdn.example.com/w.png' },
        sharedAt: '2026-10-14T08:00:00.000Z',
      },
      { id: 'skill-orphan', name: 'orphan-skill', sourceUrl: null, sharedBy: null, sharedAt: '2026-10-13T08:00:00.000Z' },
    ])
    expect(response.body).not.toContain('private source')
    expect(response.body).not.toContain('private/object.zip')
    expect(mockDb.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['sharer-001', 'deleted-user'] } },
      select: { id: true, displayName: true, avatarUrl: true },
    })
    expect(mockDb.skillTeamShare.findMany).toHaveBeenCalledWith({
      where: { teamId: 'team-001', skill: { deletedAt: null } },
      select: {
        sharedById: true,
        createdAt: true,
        skill: {
          select: expect.objectContaining({
            id: true,
            name: true,
            author: { select: { id: true, displayName: true } },
          }),
        },
      },
    })
  })

  it('hides other teams from a shared Skill detail response', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-shared',
      authorId: 'owner-001',
      sourceContent: '# private source',
      ossPackageKey: 'private/object.zip',
      versions: [],
      author: { id: 'owner-001', displayName: 'Owner', avatarUrl: null },
      teamShares: [
        { teamId: 'team-visible', team: { id: 'team-visible', name: 'Visible Team' } },
        { teamId: 'team-private', team: { id: 'team-private', name: 'Private Team' } },
      ],
    })
    mockDb.teamMember.findMany.mockResolvedValue([{ teamId: 'team-visible' }])
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/skills/skill-shared' })

    expect(response.statusCode).toBe(200)
    expect(response.json().teamShares).toEqual([
      { teamId: 'team-visible', team: { id: 'team-visible', name: 'Visible Team' } },
    ])
    expect(response.body).not.toContain('Private Team')
    expect(response.body).not.toContain('private source')
    expect(response.body).not.toContain('private/object.zip')
    expect(mockDb.teamMember.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-001',
        teamId: { in: ['team-visible', 'team-private'] },
        team: { dissolvedAt: null },
      },
      select: { teamId: true },
    })
  })

  it('does not fetch or expose Skill source bodies in the personal list', async () => {
    mockDb.skill.findMany.mockResolvedValue([{
      id: 'skill-owned',
      name: 'owned-skill',
      sourceContent: '# private source',
      ossPackageKey: 'private/object.zip',
      teamShares: [],
    }])
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/skills' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([{ id: 'skill-owned', name: 'owned-skill', teamShares: [] }])
    expect(mockDb.skill.findMany).toHaveBeenCalledWith({
      where: { authorId: 'user-001', deletedAt: null },
      select: expect.objectContaining({
        id: true,
        name: true,
        teamShares: { select: { teamId: true } },
      }),
      orderBy: { updatedAt: 'desc' },
    })
    expect(response.body).not.toContain('private source')
    expect(response.body).not.toContain('private/object.zip')
  })

  it('lists only the owner\'s deleted Skills in the recycle bin', async () => {
    const deletedAt = new Date('2026-08-04T02:00:00.000Z')
    mockDb.skill.findMany.mockResolvedValue([{
      id: 'skill-deleted',
      name: 'deleted-skill',
      displayName: '已删除 Skill',
      deletedAt,
    }])
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/skills/trash' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([{
      id: 'skill-deleted',
      name: 'deleted-skill',
      displayName: '已删除 Skill',
      deletedAt: deletedAt.toISOString(),
    }])
    expect(mockDb.skill.findMany).toHaveBeenCalledWith({
      where: { authorId: 'user-001', deletedAt: { not: null } },
      select: expect.objectContaining({ id: true, name: true, deletedAt: true }),
      orderBy: { deletedAt: 'desc' },
      take: 1_000,
    })
  })

  it('hides a deleted Skill from ordinary detail reads', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-deleted',
      authorId: 'user-001',
      deletedAt: new Date('2026-08-04T02:00:00.000Z'),
      teamShares: [],
    })
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/skills/skill-deleted' })

    expect(response.statusCode).toBe(404)
    expect(mockDb.teamMember.findMany).not.toHaveBeenCalled()
  })

  it('soft-deletes an owned Skill and removes every team share atomically', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-001',
      name: 'release-verifier',
      authorId: 'user-001',
      deletedAt: null,
    })
    mockDb.skillTeamShare.deleteMany.mockResolvedValue({ count: 1 })
    mockDb.marketplaceSubmission.updateMany.mockResolvedValue({ count: 1 })
    mockDb.marketplaceListing.updateMany.mockResolvedValue({ count: 1 })
    mockDb.skill.update.mockResolvedValue({})
    mockDb.credentialAuditEvent.create.mockResolvedValue({ id: 'audit-delete' })
    app = await buildApp()

    const response = await app.inject({ method: 'DELETE', url: '/api/skills/skill-001' })

    expect(response.statusCode).toBe(204)
    expect(mockMutationLocks.lockSkillMutation).toHaveBeenCalledWith(mockDb, 'skill-001')
    expect(mockDb.skill.update).toHaveBeenCalledWith({
      where: { id: 'skill-001' },
      data: {
        deletedAt: expect.any(Date),
        visibility: 'private',
        marketplaceStatus: 'none',
      },
    })
    expect(mockDb.teamCredential.updateMany).not.toHaveBeenCalled()
    expect(mockDb.skillTeamShare.deleteMany).toHaveBeenCalledWith({ where: { skillId: 'skill-001' } })
    expect(mockDb.marketplaceSubmission.updateMany).toHaveBeenCalledWith({
      where: {
        skillId: 'skill-001',
        status: { in: ['submitted', 'under_review'] },
      },
      data: { status: 'withdrawn', withdrawnAt: expect.any(Date) },
    })
    expect(mockDb.marketplaceListing.updateMany).toHaveBeenCalledWith({
      where: { skillId: 'skill-001', withdrawnAt: null },
      data: { withdrawnAt: expect.any(Date), withdrawnBy: 'author', withdrawnReason: null },
    })
    // An earlier admin unlisting is re-attributed to the author so it cannot be restored by an admin.
    expect(mockDb.marketplaceListing.updateMany).toHaveBeenCalledWith({
      where: { skillId: 'skill-001', withdrawnAt: { not: null }, withdrawnBy: 'admin' },
      data: { withdrawnBy: 'author', withdrawnReason: null },
    })
    expect(mockDb.credentialAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        skillId: 'skill-001',
        actorId: 'user-001',
        action: 'skill_soft_delete',
        outcome: 'success',
        bindingIds: [],
        metadata: {
          removedTeamShareCount: 1,
          withdrawnMarketplaceSubmissionCount: 1,
          unpublishedMarketplaceListingCount: 1,
        },
      }),
    })
  })

  it('does not let another user soft-delete an owned Skill', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-foreign',
      authorId: 'other-user',
      deletedAt: null,
    })
    app = await buildApp()

    const response = await app.inject({ method: 'DELETE', url: '/api/skills/skill-foreign' })

    expect(response.statusCode).toBe(403)
    expect(mockDb.skill.update).not.toHaveBeenCalled()
    expect(mockDb.skillTeamShare.deleteMany).not.toHaveBeenCalled()
  })

  it('restores an owned Skill without reviving old Team shares or visibility', async () => {
    const deletedAt = new Date('2026-08-04T02:00:00.000Z')
    const timestamp = new Date('2026-08-03T00:00:00.000Z')
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-deleted',
      name: 'release-verifier',
      authorId: 'user-001',
      deletedAt,
    })
    mockDb.skill.findFirst.mockResolvedValue(null)
    mockDb.skill.update.mockResolvedValue({
      id: 'skill-deleted',
      name: 'release-verifier',
      displayName: '发布验收',
      description: null,
      category: '开发与工程',
      labels: ['测试验证', '发布部署'],
      triggerScenarios: [],
      compatibleAgents: ['codex'],
      envDependencies: [],
      authorId: 'user-001',
      currentVersion: 'v1.0',
      installCount: 0,
      visibility: 'private',
      marketplaceStatus: 'none',
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-deleted/restore',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: 'skill-deleted',
      name: 'release-verifier',
      visibility: 'private',
      marketplaceStatus: 'none',
    })
    expect(mockDb.skill.findFirst).toHaveBeenCalledWith({
      where: {
        authorId: 'user-001',
        name: 'release-verifier',
        deletedAt: null,
        id: { not: 'skill-deleted' },
      },
      select: { id: true },
    })
    expect(mockDb.skill.update).toHaveBeenCalledWith({
      where: { id: 'skill-deleted' },
      data: { deletedAt: null, visibility: 'private', marketplaceStatus: 'none' },
    })
    expect(mockDb.skillTeamShare.upsert).not.toHaveBeenCalled()
  })

  it('returns 409 instead of overwriting an active same-name Skill during restore', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-deleted',
      name: 'release-verifier',
      authorId: 'user-001',
      deletedAt: new Date('2026-08-04T02:00:00.000Z'),
    })
    mockDb.skill.findFirst.mockResolvedValue({ id: 'skill-active' })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-deleted/restore',
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toBe('An active Skill with the same name already exists')
    expect(mockDb.skill.update).not.toHaveBeenCalled()
  })

  it('returns 409 when the partial unique index catches a concurrent restore conflict', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-deleted',
      name: 'release-verifier',
      authorId: 'user-001',
      deletedAt: new Date('2026-08-04T02:00:00.000Z'),
    })
    mockDb.skill.findFirst.mockResolvedValue(null)
    mockDb.skill.update.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: '5.22.0',
    }))
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-deleted/restore',
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toBe('An active Skill with the same name already exists')
  })

  it('requires an active team membership before sharing a Skill', async () => {
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001', currentVersion: 'v1.0' })
    mockDb.teamMember.findUnique.mockResolvedValue(null)
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/shares',
      payload: { teamId: 'team-001' },
    })

    expect(response.statusCode).toBe(403)
    expect(mockDb.skillVersion.findFirst).not.toHaveBeenCalled()
    expect(mockDb.skillTeamShare.upsert).not.toHaveBeenCalled()
  })

  it('rejects sharing a Skill into a dissolved team', async () => {
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001' })
    mockDb.teamMember.findUnique.mockResolvedValue({
      teamId: 'team-001',
      userId: 'user-001',
      team: { dissolvedAt: new Date('2026-08-03T00:00:00.000Z') },
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/shares',
      payload: { teamId: 'team-001' },
    })

    expect(response.statusCode).toBe(410)
    expect(mockDb.skillVersion.findFirst).not.toHaveBeenCalled()
    expect(mockDb.skillTeamShare.upsert).not.toHaveBeenCalled()
  })

  it('rejects sharing a Skill that has no installable package version', async () => {
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001', currentVersion: '2.0.0' })
    mockDb.teamMember.findUnique.mockResolvedValue({
      teamId: 'team-001',
      userId: 'user-001',
      team: { dissolvedAt: null },
    })
    mockDb.skillVersion.findFirst.mockResolvedValue(null)
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/shares',
      payload: { teamId: 'team-001' },
    })

    expect(response.statusCode).toBe(409)
    expect(mockDb.skillTeamShare.upsert).not.toHaveBeenCalled()
    expect(mockDb.skillVersion.findFirst).toHaveBeenCalledWith({
      where: { skillId: 'skill-001', version: '2.0.0', OR: [{ packageData: { not: null } }, { cardSha256: { not: null } }] },
      select: { id: true, version: true, cardSha256: true, packageSha256: true, packageData: true },
    })
  })

  it('denies sharing a preexisting asset whose package was acquired from catalog', async (): Promise<void> => {
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001', currentVersion: '0.1.0' })
    mockDb.teamMember.findUnique.mockResolvedValue({ team: { dissolvedAt: null } })
    mockDb.skillVersion.findFirst.mockResolvedValue({ id: 'version-001', version: '0.1.0', packageSha256: 'a'.repeat(64) })
    mockDb.cardGrant.findUnique.mockResolvedValue({ reason: 'catalog' })
    app = await buildApp()
    const response = await app.inject({ method: 'POST', url: '/api/skills/skill-001/shares', payload: { teamId: 'team-001' } })
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe('CATALOG_NOT_AUTHORED')
    expect(mockDb.skillTeamShare.upsert).not.toHaveBeenCalled()
    expect(mockMutationLocks.lockUserMutation.mock.invocationCallOrder[0]).toBeLessThan(mockMutationLocks.lockSkillTeamMutation.mock.invocationCallOrder[0]!)
  })

  it('returns a stable DTO when sharing an installable Skill', async () => {
    const createdAt = new Date('2026-08-03T00:00:00.000Z')
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001', currentVersion: 'v1.0' })
    mockDb.teamMember.findUnique.mockResolvedValue({
      teamId: 'team-001',
      userId: 'user-001',
      team: { dissolvedAt: null, name: '产品组' },
    })
    mockDb.skillVersion.findFirst.mockResolvedValue({ id: 'version-001', version: 'v1.0' })
    mockDb.skillTeamShare.findUnique.mockResolvedValue({ skillId: 'skill-001' })
    mockDb.skillTeamShare.upsert.mockResolvedValue({
      skillId: 'skill-001',
      teamId: 'team-001',
      sharedById: 'user-001',
      createdAt,
      ignoredRelation: { id: 'should-not-leak' },
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/shares',
      payload: { teamId: 'team-001' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({
      skillId: 'skill-001',
      teamId: 'team-001',
      sharedById: 'user-001',
      createdAt: createdAt.toISOString(),
    })
    expect(mockDb.skillVersion.findFirst).toHaveBeenCalledWith({
      where: { skillId: 'skill-001', version: 'v1.0', OR: [{ packageData: { not: null } }, { cardSha256: { not: null } }] },
      select: { id: true, version: true, cardSha256: true, packageSha256: true, packageData: true },
    })
    expect(mockDb.skillTeamShare.upsert).toHaveBeenCalledWith({
      where: { skillId_teamId: { skillId: 'skill-001', teamId: 'team-001' } },
      update: {},
      create: { skillId: 'skill-001', teamId: 'team-001', sharedById: 'user-001' },
      select: { skillId: true, teamId: true, sharedById: true, createdAt: true },
    })
    expect(mockMutationLocks.lockSkillTeamMutation).toHaveBeenCalledWith(
      mockDb,
      'skill-001',
      'team-001'
    )
    expect(mockMutationLocks.lockSkillTeamMutation.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.teamMember.findUnique.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    )
    // Re-sharing an already shared Skill sends no new key-scope notification.
    expect(mockDb.teamCredential.findMany).not.toHaveBeenCalled()
  })

  it('notifies team key holders when a newly shared Skill enters their key scope', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-001',
      authorId: 'user-001',
      displayName: '生图',
      currentVersion: 'v1.0',
      envDependencies: [{ key: 'FAL_KEY', required: true }],
    })
    mockDb.teamMember.findUnique.mockResolvedValue({ teamId: 'team-001', userId: 'user-001', team: { dissolvedAt: null, name: '产品组' } })
    mockDb.skillVersion.findFirst.mockResolvedValue({ id: 'version-001', version: 'v1.0' })
    mockDb.skillTeamShare.findUnique.mockResolvedValue(null)
    mockDb.skillTeamShare.upsert.mockResolvedValue({ skillId: 'skill-001', teamId: 'team-001', sharedById: 'user-001', createdAt: new Date() })
    mockDb.teamCredential.findMany.mockResolvedValue([{ envKey: 'FAL_KEY', createdById: 'holder-001' }])
    mockDb.notification.createMany.mockResolvedValue({ count: 1 })
    app = await buildApp()

    const response = await app.inject({ method: 'POST', url: '/api/skills/skill-001/shares', payload: { teamId: 'team-001' } })

    expect(response.statusCode).toBe(201)
    expect(mockDb.notification.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        userId: 'holder-001',
        type: 'team_key_scope_added',
        payload: expect.objectContaining({ teamId: 'team-001', skillId: 'skill-001', keys: ['FAL_KEY'] }),
      })],
    })
    expect(mockDb.teamActivity.create).toHaveBeenCalledWith({
      data: {
        teamId: 'team-001',
        actorId: 'user-001',
        type: 'skill_shared',
        payload: { skillId: 'skill-001', skillName: '生图' },
      },
    })
    expect(JSON.stringify(mockDb.teamActivity.create.mock.calls)).not.toMatch(/"(value|ciphertext|email|token)"/)
  })

  it('unshares without touching team keys or writing credential audit', async () => {
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001' })
    mockDb.skillTeamShare.deleteMany.mockResolvedValue({ count: 0 })
    app = await buildApp()

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/skills/skill-001/shares/team-001',
    })

    expect(response.statusCode).toBe(204)
    expect(mockDb.skillTeamShare.deleteMany).toHaveBeenCalledOnce()
    expect(mockDb.skillTeamShare.deleteMany).toHaveBeenCalledWith({
      where: { skillId: 'skill-001', teamId: 'team-001' },
    })
    expect(mockDb.teamCredential.updateMany).not.toHaveBeenCalled()
    expect(mockDb.credentialAuditEvent.create).not.toHaveBeenCalled()
    // Nothing was removed, so there is no activity to record.
    expect(mockDb.teamActivity.create).not.toHaveBeenCalled()
    expect(mockDb.$transaction).toHaveBeenCalledOnce()
    expect(mockMutationLocks.lockSkillTeamMutation).toHaveBeenCalledOnce()
  })

  it('serializes concurrent unshare requests under the Skill/Team lock', async () => {
    let teamShareExists = true
    let lockTail = Promise.resolve()
    const lockReleases: Array<() => void> = []
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'user-001' })
    mockDb.skillTeamShare.deleteMany.mockImplementation(async () => {
      const count = teamShareExists ? 1 : 0
      teamShareExists = false
      return { count }
    })
    mockMutationLocks.lockSkillTeamMutation.mockImplementation(async () => {
      const previous = lockTail
      let release = (): void => undefined
      lockTail = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      lockReleases.push(release)
    })
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof mockDb) => Promise<unknown>): Promise<unknown> => {
        try {
          return await callback(mockDb)
        } finally {
          lockReleases.shift()?.()
        }
      }
    )
    app = await buildApp()

    const [first, second] = await Promise.all([
      app.inject({ method: 'DELETE', url: '/api/skills/skill-001/shares/team-001' }),
      app.inject({ method: 'DELETE', url: '/api/skills/skill-001/shares/team-001' }),
    ])

    expect(first.statusCode).toBe(204)
    expect(second.statusCode).toBe(204)
    expect(mockMutationLocks.lockSkillTeamMutation).toHaveBeenCalledTimes(2)
    expect(mockDb.skillTeamShare.deleteMany).toHaveBeenCalledTimes(2)
    expect(mockMutationLocks.lockSkillTeamMutation.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.skillTeamShare.deleteMany.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    )
  })

  it('allows the Team owner to remove another author Skill share', async () => {
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'author-001', displayName: '别人的 Skill' })
    mockDb.team.findUnique.mockResolvedValue({ ownerId: 'user-001' })
    mockDb.skillTeamShare.deleteMany.mockResolvedValue({ count: 1 })
    app = await buildApp()

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/skills/skill-001/shares/team-001',
    })

    expect(response.statusCode).toBe(204)
    expect(mockDb.team.findUnique).toHaveBeenCalledWith({
      where: { id: 'team-001' },
      select: { ownerId: true },
    })
    expect(mockDb.teamActivity.create).toHaveBeenCalledWith({
      data: {
        teamId: 'team-001',
        actorId: 'user-001',
        type: 'skill_unshared',
        payload: { skillId: 'skill-001', skillName: '别人的 Skill' },
      },
    })
    expect(JSON.stringify(mockDb.teamActivity.create.mock.calls)).not.toMatch(/"(value|ciphertext|email|token)"/)
    expect(mockDb.$transaction).toHaveBeenCalledOnce()
  })

  it('denies an unrelated user from removing another author Skill share', async () => {
    mockDb.skill.findUnique.mockResolvedValue({ id: 'skill-001', authorId: 'author-001' })
    mockDb.team.findUnique.mockResolvedValue({ ownerId: 'other-owner' })
    app = await buildApp()

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/skills/skill-001/shares/team-001',
    })

    expect(response.statusCode).toBe(403)
    expect(mockDb.$transaction).toHaveBeenCalledOnce()
    expect(mockDb.skillTeamShare.deleteMany).not.toHaveBeenCalled()
  })

  it('uses Anthropic Messages when the configured model requires that protocol', async () => {
    mockConfig.AI_API_BASE_URL = 'https://provider.example'
    mockConfig.AI_API_KEY = 'test-api-key'
    mockDb.skill.findFirst.mockResolvedValue(null)
    mockDb.skill.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'skill-ai',
      ...data,
      installCount: 0,
      visibility: 'private',
      marketplaceStatus: 'none',
      ossPackageKey: null,
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
      updatedAt: new Date('2026-08-02T00:00:00.000Z'),
    }))
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      type: 'message',
      content: [{
        type: 'text',
        text: JSON.stringify({
          displayName: '研究助手',
          description: '汇总资料并生成结构化研究结果',
          category: '搜索与研究',
          labels: ['信息检索', '深度研究'],
          triggerScenarios: ['资料检索'],
        }),
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: {
        name: 'research-helper-ai',
        skillMd: '# Research Helper\n\nGather primary sources and generate a structured research result.',
        aiAnalysisConsent: true,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      skill: { id: 'skill-ai', displayName: '研究助手', category: '搜索与研究' },
      analysis: { status: 'completed', provider: 'provider.example' },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://provider.example/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'test-api-key',
          'anthropic-version': '2023-06-01',
        }),
      })
    )
  })

  it('uses OpenAI Responses when the configured model requires that protocol', async () => {
    mockConfig.AI_API_BASE_URL = 'https://provider.example'
    mockConfig.AI_API_KEY = 'test-api-key'
    mockConfig.AI_PROTOCOL = 'openai-responses'
    mockDb.skill.findFirst.mockResolvedValue(null)
    mockDb.skill.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'skill-responses', ...data, installCount: 0, visibility: 'private', marketplaceStatus: 'none',
      createdAt: new Date(), updatedAt: new Date(),
    }))
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'resp-1',
      output: [{ type: 'message', content: [{
        type: 'output_text',
        text: JSON.stringify({
          displayName: '研究助手', description: '汇总资料并生成结构化研究结果', category: '搜索与研究',
          labels: ['信息检索', '深度研究'], triggerScenarios: ['资料检索'],
        }),
      }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    app = await buildApp()

    const response = await app.inject({
      method: 'POST', url: '/api/skills/import', payload: {
        name: 'research-helper-responses',
        skillMd: '# Research Helper\n\nGather primary sources and generate a structured research result.',
        aiAnalysisConsent: true,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ analysis: { status: 'completed', provider: 'provider.example' } })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://provider.example/v1/responses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer test-api-key' }),
      })
    )
  })

  it('accepts a fenced AI profile response from an Anthropic-compatible provider', async () => {
    mockConfig.AI_API_BASE_URL = 'https://provider.example'
    mockConfig.AI_API_KEY = 'test-api-key'
    mockDb.skill.findFirst.mockResolvedValue(null)
    mockDb.skill.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'skill-fenced', ...data, installCount: 0, visibility: 'private', marketplaceStatus: 'none',
      createdAt: new Date(), updatedAt: new Date(),
    }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{
        type: 'text',
        text: '```json\n{"display_name":"验收助手","description":"验证发布流程","category":"开发与工程","tags":["测试验证","发布部署"],"trigger_scenarios":["发布前检查"]}\n```',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    app = await buildApp()

    const response = await app.inject({
      method: 'POST', url: '/api/skills/import', payload: {
        name: 'fenced-profile', skillMd: '# Fenced Profile', aiAnalysisConsent: true,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      skill: { displayName: '验收助手', category: '开发与工程', labels: ['测试验证', '发布部署'] },
      analysis: { status: 'completed' },
    })
  })

  it('falls back to deterministic catalog labels when AI invents labels', async () => {
    mockConfig.AI_API_BASE_URL = 'https://provider.example'
    mockConfig.AI_API_KEY = 'test-api-key'
    mockDb.skill.findFirst.mockResolvedValue(null)
    mockDb.skill.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'skill-invalid-labels', ...data, installCount: 0, visibility: 'private', marketplaceStatus: 'none',
      createdAt: new Date(), updatedAt: new Date(),
    }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{
        type: 'text',
        text: JSON.stringify({
          displayName: '验收助手',
          description: '验证发布流程',
          category: '开发与工程',
          labels: ['验收', 'Mac'],
          triggerScenarios: ['发布前检查'],
        }),
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    app = await buildApp()

    const response = await app.inject({
      method: 'POST', url: '/api/skills/import', payload: {
        name: 'release-verifier',
        skillMd: '# Release Verifier\n\nValidate a release before deployment.',
        aiAnalysisConsent: true,
      },
    })

    const body = response.json() as {
      skill: { labels: string[] }
      analysis: { status: string }
    }
    const catalog = new Set<string>(SKILL_LABEL_CATALOG)
    expect(response.statusCode).toBe(201)
    expect(body.analysis.status).toBe('fallback')
    expect(body.skill.labels).toEqual(expect.arrayContaining(['测试验证', '发布部署']))
    expect(body.skill.labels.length).toBeGreaterThanOrEqual(2)
    expect(body.skill.labels.length).toBeLessThanOrEqual(5)
    expect(body.skill.labels.every((label) => catalog.has(label))).toBe(true)
  })

  it('recovers an exact retry after the server already stored the same package and version', async () => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    const createdAt = new Date('2026-08-03T00:00:00.000Z')
    mockDb.skill.findFirst.mockResolvedValue({
      id: 'skill-existing',
      name: 'packaged-skill',
      displayName: 'Packaged Skill',
      description: null,
      category: null,
      labels: [],
      triggerScenarios: [],
      compatibleAgents: ['codex', 'claude', 'codex'],
      envDependencies: [
        { key: 'SECONDARY_KEY', description: ' Secondary value ', required: false },
        { key: 'API_KEY', description: 'Primary value', required: true },
      ],
      sourceContent: '# Packaged Skill',
      authorId: 'user-001',
      currentVersion: 'v0.1',
      installCount: 0,
      visibility: 'private',
      marketplaceStatus: 'none',
      ossPackageKey: null,
      createdAt,
      updatedAt: createdAt,
      importVersionId: 'initial-version',
      versions: [{ id: 'initial-version', version: 'v0.1', aliases: [], packageSha256, compatibleAgents: ['claude', 'codex'], envDependencies: [{ key: 'API_KEY', description: 'Primary value', required: true }, { key: 'SECONDARY_KEY', description: 'Secondary value', required: false }] }],
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: {
        name: 'packaged-skill',
        skillMd: '# Packaged Skill',
        currentVersion: 'v0.1',
        compatibleAgents: ['claude', 'codex'],
        envDependencies: [
          { key: 'API_KEY', description: 'Primary value', required: true },
          { key: 'SECONDARY_KEY', description: 'Secondary value', required: false },
        ],
        aiAnalysisConsent: true,
        packageBase64: packageData.toString('base64'),
        packageSha256,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      skill: { id: 'skill-existing', currentVersion: 'v0.1' },
      analysis: { status: 'recovered', provider: null, redactedSecrets: 0 },
      recovered: true,
      idempotent: true,
    })
    expect(mockDb.skill.findFirst).toHaveBeenCalledWith({
      where: { authorId: 'user-001', name: 'packaged-skill', deletedAt: null },
      include: {
        versions: {
          select: { id: true, version: true, sourceUrl: true, packageSha256: true, compatibleAgents: true, envDependencies: true, aliases: { select: { oldLabel: true } } },
        },
      },
    })
    expect(mockDb.skill.count).not.toHaveBeenCalled()
    expect(mockDb.skill.create).not.toHaveBeenCalled()
  })

  it('rejects an import retry when compatible Agent metadata differs', async () => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockDb.skill.findFirst.mockResolvedValue({
      id: 'skill-existing',
      currentVersion: 'v0.1',
      compatibleAgents: ['codex'],
      envDependencies: [],
      importVersionId: 'initial-version',
      versions: [{ id: 'initial-version', version: 'v0.1', aliases: [], packageSha256, compatibleAgents: ['codex'], envDependencies: [] }],
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: {
        name: 'packaged-skill',
        skillMd: '# Packaged Skill',
        currentVersion: 'v0.1',
        compatibleAgents: ['claude'],
        aiAnalysisConsent: true,
        packageBase64: packageData.toString('base64'),
        packageSha256,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      code: 'VERSION_REQUEST_CONFLICT',
    })
    expect(mockDb.skill.create).not.toHaveBeenCalled()
  })

  it('rejects an import retry when environment dependency metadata differs', async () => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockDb.skill.findFirst.mockResolvedValue({
      id: 'skill-existing',
      currentVersion: 'v0.1',
      compatibleAgents: ['codex'],
      envDependencies: [{ key: 'API_KEY', description: 'Old description', required: true }],
      importVersionId: 'initial-version',
      versions: [{ id: 'initial-version', version: 'v0.1', aliases: [], packageSha256, compatibleAgents: ['codex'], envDependencies: [] }],
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: {
        name: 'packaged-skill',
        skillMd: '# Packaged Skill',
        currentVersion: 'v0.1',
        compatibleAgents: ['codex'],
        envDependencies: [{ key: 'API_KEY', description: 'New description', required: true }],
        aiAnalysisConsent: true,
        packageBase64: packageData.toString('base64'),
        packageSha256,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      code: 'VERSION_REQUEST_CONFLICT',
    })
    expect(mockDb.skill.create).not.toHaveBeenCalled()
  })

  it('rejects an import retry when the stored package checksum differs', async () => {
    const packageData = createStoredSkillZip('# Changed Skill\n')
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockDb.skill.findFirst.mockResolvedValue({
      id: 'skill-existing',
      currentVersion: 'v0.1',
      versions: [{ packageSha256: 'a'.repeat(64) }],
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: {
        name: 'packaged-skill',
        skillMd: '# Changed Skill',
        currentVersion: 'v0.1',
        aiAnalysisConsent: true,
        packageBase64: packageData.toString('base64'),
        packageSha256,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(mockDb.skill.create).not.toHaveBeenCalled()
  })

  it('rejects an import retry when the current version differs', async () => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockDb.skill.findFirst.mockResolvedValue({
      id: 'skill-existing',
      currentVersion: 'v0.2',
      importVersionId: 'initial-version',
      versions: [{ id: 'initial-version', version: 'v0.1', aliases: [], packageSha256, compatibleAgents: ['codex'], envDependencies: [] }],
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: {
        name: 'packaged-skill',
        skillMd: '# Packaged Skill',
        currentVersion: 'v0.1',
        aiAnalysisConsent: true,
        packageBase64: packageData.toString('base64'),
        packageSha256,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(mockDb.skill.create).not.toHaveBeenCalled()
  })

  it('rejects an import that already exists for the current author', async () => {
    mockDb.skill.findFirst.mockResolvedValue({ id: 'skill-existing', versions: [] })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: {
        name: 'research-helper',
        skillMd: '# Research Helper',
        aiAnalysisConsent: true,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(mockDb.skill.create).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['different subject', { sub: 'other-user', ver: 7 }],
    ['non-integer version', { sub: 'user-001', ver: 7.5 }],
  ] as const)('fails closed when the verified analyze token is %s', async (_label, token) => {
    mockAuth.verifiedAuthToken = token
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/analyze',
      payload: { skillMd: '# Research Helper', aiAnalysisConsent: true },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'Unauthorized' })
    expect(mockDb.skill.findUnique).not.toHaveBeenCalled()
    expect(mockDb.$transaction).not.toHaveBeenCalled()
    expect(mockDb.skill.update).not.toHaveBeenCalled()
  })

  it('rejects an analyze result when tokenVersion changes during the AI request', async () => {
    const aiStarted = deferred<void>()
    const aiResponse = deferred<Response>()
    let currentTokenVersion = 7
    mockConfig.AI_API_BASE_URL = 'https://provider.example'
    mockConfig.AI_API_KEY = 'test-api-key'
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-001',
      name: 'research-helper',
      authorId: 'user-001',
      deletedAt: null,
    })
    mockDb.user.findUnique.mockImplementation(async () => ({ tokenVersion: currentTokenVersion }))
    vi.stubGlobal('fetch', vi.fn(async () => {
      aiStarted.resolve()
      return aiResponse.promise
    }))
    app = await buildApp()

    const pendingResponse = app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/analyze',
      payload: { skillMd: '# Research Helper', aiAnalysisConsent: true },
    })
    await aiStarted.promise
    currentTokenVersion += 1
    aiResponse.resolve(new Response(JSON.stringify({
      content: [{
        type: 'text',
        text: JSON.stringify({
          displayName: '研究助手',
          description: '汇总资料并生成结构化研究结果',
          category: '搜索与研究',
          labels: ['信息检索', '深度研究'],
          triggerScenarios: ['资料检索'],
        }),
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const response = await pendingResponse

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'Unauthorized' })
    expect(mockMutationLocks.lockUserMutation).toHaveBeenCalledWith(mockDb, 'user-001')
    expect(mockDb.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-001' },
      select: { tokenVersion: true },
    })
    expect(mockMutationLocks.lockSkillMutation).not.toHaveBeenCalled()
    expect(mockDb.skill.update).not.toHaveBeenCalled()
  })

  it('does not allow a user to re-analyze another author\'s skill', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-foreign',
      name: 'foreign-skill',
      authorId: 'other-user',
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-foreign/analyze',
      payload: { skillMd: '# Foreign Skill' },
    })

    expect(response.statusCode).toBe(403)
    expect(mockDb.skill.update).not.toHaveBeenCalled()
  })

  it('preserves the existing profile when AI analysis falls back', async () => {
    const timestamp = new Date('2026-08-02T00:00:00.000Z')
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-001',
      name: 'research-helper',
      displayName: '研究助手',
      description: '已有的高质量简介',
      category: '搜索与研究',
      labels: ['研究'],
      triggerScenarios: ['资料检索'],
      compatibleAgents: ['codex'],
      authorId: 'user-001',
      currentVersion: 'v1.0',
      installCount: 3,
      visibility: 'private',
      marketplaceStatus: 'none',
      ossPackageKey: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/analyze',
      payload: { skillMd: '# Research Helper', aiAnalysisConsent: true },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      skill: { displayName: '研究助手', description: '已有的高质量简介' },
      analysis: { status: 'fallback' },
    })
    expect(mockDb.skill.update).toHaveBeenCalledWith({
      where: { id: 'skill-001' },
      data: { sourceContent: '# Research Helper' },
    })
    expect(mockMutationLocks.lockUserMutation).toHaveBeenCalledWith(mockDb, 'user-001')
    expect(mockDb.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-001' },
      select: { tokenVersion: true },
    })
    expect(mockMutationLocks.lockUserMutation.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.user.findUnique.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    )
    expect(mockDb.user.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      mockMutationLocks.lockSkillMutation.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    )
    expect(mockMutationLocks.lockSkillMutation.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.skill.findUnique.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER
    )
    expect(mockDb.skill.findUnique.mock.invocationCallOrder[1]).toBeLessThan(
      mockDb.skill.update.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    )
  })

  it('rechecks the tombstone under the Skill lock before writing AI analysis', async () => {
    const active = {
      id: 'skill-001',
      name: 'research-helper',
      authorId: 'user-001',
      deletedAt: null,
    }
    mockDb.skill.findUnique
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce({ ...active, deletedAt: new Date('2026-08-04T03:00:00.000Z') })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/analyze',
      payload: { skillMd: '# Research Helper', aiAnalysisConsent: true },
    })

    expect(response.statusCode).toBe(404)
    expect(mockMutationLocks.lockSkillMutation).toHaveBeenCalledWith(mockDb, 'skill-001')
    expect(mockDb.skill.update).not.toHaveBeenCalled()
  })

  describe('analyze expectedProfile concurrency guard (#181)', () => {
    const timestamp = new Date('2026-10-01T00:00:00.000Z')
    const storedSkill = {
      id: 'skill-001',
      name: 'research-helper',
      displayName: '研究助手',
      description: '已有的简介',
      category: '搜索与研究',
      labels: ['研究'],
      triggerScenarios: ['资料检索'],
      compatibleAgents: ['codex'],
      authorId: 'user-001',
      currentVersion: 'v1.0',
      installCount: 3,
      visibility: 'private',
      marketplaceStatus: 'none',
      ossPackageKey: null,
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const expectedProfile = {
      displayName: '研究助手',
      description: '已有的简介',
      category: '搜索与研究',
      labels: ['研究'],
      triggerScenarios: ['资料检索'],
    }
    const aiProfile = {
      displayName: '深度研究助手',
      description: '汇总资料并生成结构化研究结果',
      category: '搜索与研究',
      labels: ['信息检索', '深度研究'],
      triggerScenarios: ['资料检索', '竞品研究'],
    }
    // The AI guard limits each user/IP per minute; give every case its own IP.
    let ipSequence = 0
    const nextIp = (): string => `10.0.181.${++ipSequence}`
    const aiReply = (): Response => new Response(JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(aiProfile) }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })

    beforeEach(() => {
      mockConfig.AI_API_BASE_URL = 'https://provider.example'
      mockConfig.AI_API_KEY = 'test-api-key'
    })

    it('persists the AI profile when the stored profile still matches the expected snapshot', async () => {
      mockDb.skill.findUnique.mockResolvedValue(storedSkill)
      mockDb.skill.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...storedSkill, ...data }))
      vi.stubGlobal('fetch', vi.fn(async () => aiReply()))
      app = await buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/skills/skill-001/analyze',
        remoteAddress: nextIp(),
        payload: { skillMd: '# Research Helper', aiAnalysisConsent: true, expectedProfile },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ skill: { displayName: '深度研究助手' }, analysis: { status: 'completed' } })
      expect(mockDb.skill.update).toHaveBeenCalledWith({
        where: { id: 'skill-001' },
        data: { ...aiProfile, sourceContent: '# Research Helper' },
      })
    })

    it('keeps the legacy behaviour when no expected snapshot is sent', async () => {
      mockDb.skill.findUnique.mockResolvedValue({ ...storedSkill, displayName: '别处改过的名字' })
      mockDb.skill.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...storedSkill, ...data }))
      vi.stubGlobal('fetch', vi.fn(async () => aiReply()))
      app = await buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/skills/skill-001/analyze',
        remoteAddress: nextIp(),
        payload: { skillMd: '# Research Helper', aiAnalysisConsent: true },
      })

      expect(response.statusCode).toBe(200)
      expect(mockDb.skill.update).toHaveBeenCalledTimes(1)
    })

    it('returns 409 before calling AI when the snapshot is already stale', async () => {
      const aiFetch = vi.fn(async () => aiReply())
      mockDb.skill.findUnique.mockResolvedValue({ ...storedSkill, labels: ['研究', '用户新加'] })
      vi.stubGlobal('fetch', aiFetch)
      app = await buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/skills/skill-001/analyze',
        remoteAddress: nextIp(),
        payload: { skillMd: '# Research Helper', aiAnalysisConsent: true, expectedProfile },
      })

      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ code: 'PROFILE_CONFLICT' })
      expect(aiFetch).not.toHaveBeenCalled()
      expect(mockDb.$transaction).not.toHaveBeenCalled()
      expect(mockDb.skill.update).not.toHaveBeenCalled()
    })

    it('returns 409 and persists nothing when the profile is edited during the AI request', async () => {
      const aiStarted = deferred<void>()
      const aiResponse = deferred<Response>()
      mockDb.skill.findUnique
        .mockResolvedValueOnce(storedSkill)
        .mockResolvedValueOnce({ ...storedSkill, description: '用户在分析期间保存的简介' })
      vi.stubGlobal('fetch', vi.fn(async () => {
        aiStarted.resolve()
        return aiResponse.promise
      }))
      app = await buildApp()

      const pending = app.inject({
        method: 'POST',
        url: '/api/skills/skill-001/analyze',
        remoteAddress: nextIp(),
        payload: { skillMd: '# Research Helper', aiAnalysisConsent: true, expectedProfile },
      })
      await aiStarted.promise
      aiResponse.resolve(aiReply())
      const response = await pending

      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ code: 'PROFILE_CONFLICT' })
      expect(mockMutationLocks.lockSkillMutation).toHaveBeenCalledWith(mockDb, 'skill-001')
      expect(mockDb.skill.update).not.toHaveBeenCalled()
    })

    it('treats a null stored description as matching an explicit null snapshot', async () => {
      mockDb.skill.findUnique.mockResolvedValue({ ...storedSkill, description: null, category: null })
      mockDb.skill.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...storedSkill, ...data }))
      vi.stubGlobal('fetch', vi.fn(async () => aiReply()))
      app = await buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/skills/skill-001/analyze',
        remoteAddress: nextIp(),
        payload: { skillMd: '# Research Helper', aiAnalysisConsent: true, expectedProfile: { ...expectedProfile, description: null, category: null } },
      })

      expect(response.statusCode).toBe(200)
    })

    it('rejects unknown keys inside the expected snapshot', async () => {
      mockDb.skill.findUnique.mockResolvedValue(storedSkill)
      app = await buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/skills/skill-001/analyze',
        remoteAddress: nextIp(),
        payload: { skillMd: '# Research Helper', aiAnalysisConsent: true, expectedProfile: { ...expectedProfile, authorId: 'x' } },
      })

      expect(response.statusCode).toBe(400)
      expect(mockDb.skill.update).not.toHaveBeenCalled()
    })
  })

  it('rejects malformed analyze payloads without throwing', async () => {
    mockDb.skill.findUnique.mockResolvedValue({
      id: 'skill-001',
      name: 'research-helper',
      authorId: 'user-001',
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/skill-001/analyze',
      payload: { skillMd: 123 },
    })

    expect(response.statusCode).toBe(400)
    expect(mockDb.skill.update).not.toHaveBeenCalled()
  })

  it('requires explicit AI analysis consent during import', async () => {
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: { name: 'research-helper', skillMd: '# Research Helper' },
    })

    expect(response.statusCode).toBe(400)
    expect(mockDb.skill.create).not.toHaveBeenCalled()
  })

  it('redacts common secrets before external analysis', () => {
    const result = redactSensitiveContent([
      'OPENAI_API_KEY=sk-1234567890abcdefghijklmnop',
      'endpoint=https://user:private-password@example.com/api',
    ].join('\n'))

    expect(result.redactedSecrets).toBe(2)
    expect(result.content).not.toContain('1234567890abcdefghijklmnop')
    expect(result.content).not.toContain('private-password')
    expect(result.content).toContain('OPENAI_API_KEY=[REDACTED]')
  })

  it('redacts real GitHub token prefixes and encrypted private keys', () => {
    const result = redactSensitiveContent([
      'ghp_1234567890abcdefghijklmnop',
      'github_pat_1234567890_abcdefghijklmnop',
      '-----BEGIN ENCRYPTED PRIVATE KEY-----',
      'private-key-material',
      '-----END ENCRYPTED PRIVATE KEY-----',
    ].join('\n'))

    expect(result.redactedSecrets).toBe(3)
    expect(result.content).not.toContain('ghp_')
    expect(result.content).not.toContain('github_pat_')
    expect(result.content).not.toContain('private-key-material')
  })

  it('redacts database URLs, bearer credentials, AWS keys, and JWTs', () => {
    const result = redactSensitiveContent([
      'DATABASE_URL=postgresql://admin:database-password@db.example.com/app',
      'Authorization: Bearer bearer-token-1234567890',
      'AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF',
      'session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.signature12345678',
    ].join('\n'))

    for (const secret of ['database-password', 'bearer-token-1234567890', 'AKIA1234567890ABCDEF', 'signature12345678']) {
      expect(result.content).not.toContain(secret)
    }
    expect(result.redactedSecrets).toBeGreaterThanOrEqual(4)
  })

  it('does not persist a secret through the fallback profile', async () => {
    mockDb.skill.findFirst.mockResolvedValue(null)
    mockDb.skill.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'skill-secret',
      ...data,
      installCount: 0,
      visibility: 'private',
      marketplaceStatus: 'none',
      ossPackageKey: null,
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
      updatedAt: new Date('2026-08-02T00:00:00.000Z'),
    }))
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      payload: {
        name: 'secret-skill',
        skillMd: '# Secret Skill\nOPENAI_API_KEY=sk-1234567890abcdefghijklmnop',
        aiAnalysisConsent: true,
      },
    })

    expect(response.statusCode).toBe(201)
    const createCall = mockDb.skill.create.mock.calls[0]?.[0] as {
      data: {
        description: string
        sourceContent: string
        versions: { create: { sourceContent: string } }
      }
    }
    expect(createCall.data.description).not.toContain('1234567890abcdefghijklmnop')
    expect(createCall.data.sourceContent).toContain('OPENAI_API_KEY=[REDACTED]')
    expect(createCall.data.versions.create.sourceContent).toBe(createCall.data.sourceContent)
    expect(createCall.data.sourceContent).not.toContain('1234567890abcdefghijklmnop')
    expect(response.json()).toMatchObject({ analysis: { redactedSecrets: 1 } })
  })
})
