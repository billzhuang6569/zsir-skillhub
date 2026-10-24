import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { Prisma, type Skill } from '@prisma/client'
import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { db } from '../db.js'
import { variantsMode, projectSkillAvatar, projectSkillAvatars } from '../lib/avatar-selection.js'
import { describeSkillPackage, reviewSkillPackageEnv, validateSkillPackage, type SkillPackageEnvReview } from '../lib/skill-package.js'
import { EnvDeclarationError, EnvObtainSchema, parseEnvDeclarations, type EnvDeclaration } from '../lib/skill-env-declaration.js'
import type { EnvSuggestion } from '../lib/env-detect.js'
import { redactSensitiveContent } from '../lib/sensitive-content.js'
import { notifyTeamCredentialHoldersOfNewScope } from '../lib/credential-lifecycle.js'
import {
  lockSkillMutation,
  lockSkillTeamMutation,
  lockUserMutation,
} from '../lib/mutation-lock.js'
import { authMiddleware } from '../middleware/auth.js'
import {
  firstHeading,
  firstParagraphLine,
  frontmatterDisplayName,
  frontmatterList,
  frontmatterText,
  parseSkillDocument,
} from '../lib/skill-frontmatter.js'
import { config } from '../config.js'
import OpenAI from 'openai'
import { aiProviderInfo, aiStatus, resolveAiConfig, requestSafeAiCompletion, type EffectiveAi } from '../lib/ai-settings.js'
import { aiBudget, type AiReservation } from '../lib/ai-budget.js'
import { AiRequestGuardError, createAiRequestGuard, type AiRequestPriority } from '../utils/ai-request-guard.js'
import { readAiProviderHttpError } from '../utils/retry-after.js'
import { LocalAvatarId } from '../lib/skill-avatar-input.js'
import { continueCloudAvatar } from '../lib/skill-avatars.js'
import { avatarGenerationEnabled } from '../lib/avatar-generation.js'
import { grantCard, loadVersionPackage, prepareCard, registerCard, requireCardAuthorship, type PreparedCard } from '../lib/skill-cards.js'
import { allocateVersion, exactFormalRetry, formalVersionDto, requireVersion, sameCardContent, skillHighWater, versionOrdinal, VersionPolicyError } from '../lib/version-policy.js'
import { recordTeamActivities, recordTeamActivity } from '../lib/team-activity.js'
import { SkillSourceUrlSchema } from '../lib/skill-source.js'
import { aiBatchRoutes } from './ai-batches.js'
import { acquiredTeamRecipients, resolveTeamVersion } from '../lib/team-skill-version.js'

export const SkillNameSchema = z.string()
  .trim()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'Skill name must be a portable folder name')

const EnvDependencySchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
  description: z.string().trim().max(200).optional(),
  required: z.boolean().default(true),
  // Display link from the SKILL.md declaration (#251); https only.
  obtain: EnvObtainSchema.optional(),
})

type EnvDependency = z.infer<typeof EnvDependencySchema>

export const EnvDependenciesSchema = z.array(EnvDependencySchema).max(100).superRefine((dependencies, context) => {
  const seen = new Set<string>()
  dependencies.forEach((dependency, index) => {
    if (seen.has(dependency.key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'key'],
        message: `Duplicate environment dependency: ${dependency.key}`,
      })
    }
    seen.add(dependency.key)
  })
})

const CompatibleAgentSchema = z.enum([
  'claude', 'codex', 'agent-skills', 'workbuddy', 'workbuddy-ai', 'doubao', 'opencode', 'openclaw', 'gemini', 'trae',
])
export const ImportCompatibleAgentsSchema = z.array(CompatibleAgentSchema)
type CompatibleAgent = z.infer<typeof CompatibleAgentSchema>

function jsonArrayInput(value: Prisma.JsonValue): Prisma.InputJsonValue {
  return Array.isArray(value) ? value as Prisma.InputJsonValue : []
}

const CreateSkillBody = z.object({
  sourceUrl: SkillSourceUrlSchema,
  name: SkillNameSchema,
  displayName: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  category: z.string().optional(),
  labels: z.array(z.string()).default([]),
  compatibleAgents: z.array(z.string()).default([]),
  envDependencies: EnvDependenciesSchema.default([]),
})

const UpdateSkillBody = CreateSkillBody.partial()

export const ImportSkillBody = z.object({
  sourceUrl: SkillSourceUrlSchema,
  name: SkillNameSchema,
  skillMd: z.string().trim().min(1).max(100_000),
  compatibleAgents: ImportCompatibleAgentsSchema.default([]),
  envDependencies: EnvDependenciesSchema.default([]),
  currentVersion: z.string().min(1).max(40).default('0.1.0'),
  aiAnalysisConsent: z.literal(true),
  localSkillId: LocalAvatarId.optional(),
  aliasLocalIds: z.array(LocalAvatarId).max(4).optional(),
  packageBase64: z.string().max(28_000_000).optional(),
  packageSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
})

// The profile the author saw when starting the analysis. When present, the
// result is only persisted while the stored profile still equals it, so a
// late AI result never silently overwrites an edit made in the meantime.
const ExpectedAnalyzeProfile = z.object({
  displayName: z.string().max(200),
  description: z.string().max(5_000).nullable(),
  category: z.string().max(200).nullable(),
  labels: z.array(z.string().max(200)).max(100),
  triggerScenarios: z.array(z.string().max(1_000)).max(100),
}).strict()

const AnalyzeSkillBody = z.object({
  skillMd: z.string().trim().min(1).max(100_000),
  aiAnalysisConsent: z.literal(true),
  expectedProfile: ExpectedAnalyzeProfile.optional(),
})

type ExpectedAnalyzeProfile = z.infer<typeof ExpectedAnalyzeProfile>

function storedStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function profileMatchesExpected(
  skill: Pick<Skill, 'displayName' | 'description' | 'category' | 'labels' | 'triggerScenarios'>,
  expected: ExpectedAnalyzeProfile | undefined,
): boolean {
  if (!expected) return true
  return skill.displayName === expected.displayName
    && (skill.description ?? null) === expected.description
    && (skill.category ?? null) === expected.category
    && sameStringList(storedStringList(skill.labels), expected.labels)
    && sameStringList(storedStringList(skill.triggerScenarios), expected.triggerScenarios)
}

const PROFILE_CONFLICT = { error: 'Skill profile changed since the analysis started', code: 'PROFILE_CONFLICT' } as const

const CreateVersionBody = z.object({
  version: z.string().min(1).max(40),
  libraryVersionReceiptId: z.string().uuid().optional(),
  changelog: z.string().max(500).optional(),
  gitHash: z.string().trim().max(100).optional(),
  skillMd: z.string().trim().min(1).max(100_000),
  envDependencies: EnvDependenciesSchema.optional(),
  packageBase64: z.string().max(28_000_000),
  packageSha256: z.string().regex(/^[a-f0-9]{64}$/),
})

const ShareSkillBody = z.object({
  teamId: z.string().trim().min(1),
})

const aiRequestGuard = createAiRequestGuard({
  budget: () => config.SKILLHUB_PROFILE === 'selfhost' ? aiBudget : undefined,
  perMinute: config.AI_RATE_LIMIT_PER_MINUTE,
  globalDaily: config.AI_GLOBAL_DAILY_LIMIT,
  maxConcurrent: config.AI_MAX_CONCURRENT,
})

// OpenAI-compatible client pointing at the configured provider.
export function openAiCompatibleBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1`
}

function getAiClient(settings: EffectiveAi): OpenAI {
  return new OpenAI({
    apiKey: settings.apiKey,
    baseURL: openAiCompatibleBaseUrl(settings.baseUrl),
  })
}

const AnthropicResponseSchema = z.object({
  content: z.array(z.object({
    type: z.string(),
    text: z.string().optional(),
  })),
})

const OpenAiResponsesSchema = z.object({
  output: z.array(z.object({
    content: z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
    })).optional().default([]),
  })).optional().default([]),
})

const CATEGORY_LIST = [
  '协作与办公', '自动化与集成', '搜索与研究',
  '内容与创作', '开发与工程', '数据与分析',
  '其他',
] as const

type SkillCategory = typeof CATEGORY_LIST[number]

/**
 * Stable, server-owned labels used as the fine-grained Skill classification key.
 * Broad `category` values remain for compatibility, while generated profiles may
 * only use labels from this catalog.
 */
export const SKILL_LABEL_CATALOG = [
  '代码开发', '代码审查', '调试排障', '测试验证', '版本管理', '发布部署',
  '信息检索', '网页浏览', '深度研究', '知识管理',
  '内容写作', '文档处理', '图像创作', '音视频处理', '演示文稿',
  '数据处理', '数据分析', '数据可视化', 'AI生成',
  '流程自动化', 'API集成', '命令行工具', '文件管理',
  '团队协作', '项目管理', '办公效率',
  'Agent工具', 'Skill管理', '环境配置', '安全合规', '通用工具',
] as const

export type SkillProfileLabel = typeof SKILL_LABEL_CATALOG[number]

export const SKILL_LABEL_TAXONOMY: ReadonlyArray<{
  group: string
  purpose: string
  labels: readonly SkillProfileLabel[]
}> = [
  {
    group: '研发工程',
    purpose: '代码从开发到交付的生命周期',
    labels: ['代码开发', '代码审查', '调试排障', '测试验证', '版本管理', '发布部署'],
  },
  {
    group: '搜索与知识',
    purpose: '外部信息获取、研究和内部知识沉淀',
    labels: ['信息检索', '网页浏览', '深度研究', '知识管理'],
  },
  {
    group: '内容创作',
    purpose: '文字、文档和多媒体成果生产',
    labels: ['内容写作', '文档处理', '图像创作', '音视频处理', '演示文稿'],
  },
  {
    group: '数据与AI',
    purpose: '数据加工、分析展示和生成式AI任务',
    labels: ['数据处理', '数据分析', '数据可视化', 'AI生成'],
  },
  {
    group: '自动化与系统',
    purpose: '工作流、接口、命令行和文件系统能力',
    labels: ['流程自动化', 'API集成', '命令行工具', '文件管理'],
  },
  {
    group: '协作与效率',
    purpose: '团队、项目和日常办公场景',
    labels: ['团队协作', '项目管理', '办公效率'],
  },
  {
    group: 'Agent生态',
    purpose: 'Agent和Skill管理、运行配置与安全',
    labels: ['Agent工具', 'Skill管理', '环境配置', '安全合规'],
  },
  {
    group: '通用',
    purpose: '暂无更精确业务归属的工具',
    labels: ['通用工具'],
  },
]

const SKILL_LABEL_PROMPT_CATALOG = SKILL_LABEL_TAXONOMY
  .map((group) => `${group.group}（${group.purpose}）：${group.labels.join('、')}`)
  .join('\n')

const SkillLabelSchema = z.enum(SKILL_LABEL_CATALOG)
const SkillLabelsSchema = z.array(SkillLabelSchema).min(2).max(5).superRefine((labels, context) => {
  const seen = new Set<SkillProfileLabel>()
  labels.forEach((label, index) => {
    if (seen.has(label)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: `Duplicate Skill profile label: ${label}`,
      })
    }
    seen.add(label)
  })
})

export const SkillProfileSchema = z.object({
  displayName: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  category: z.enum(CATEGORY_LIST),
  labels: SkillLabelsSchema,
  triggerScenarios: z.array(z.string().min(1).max(100)).max(8),
})

type SkillProfile = z.infer<typeof SkillProfileSchema>

type SkillAnalysis = {
  profile: { displayName: string; description: string; category: string | null; labels: string[]; triggerScenarios: string[] }
  source: 'ai' | 'fallback' | 'unanalysed'
  redactedSecrets: number
}

const MAX_PACKAGE_BYTES = 20 * 1024 * 1024

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

export function skillPackageContentDisposition(skillName: string): string {
  const encodedName = encodeRfc5987Value(`${skillName}.zip`)
  return `attachment; filename="skill-package.zip"; filename*=UTF-8''${encodedName}`
}

type PackageFields = { packageData?: Buffer; packageSha256?: string; packageSize?: number }

function versionContentIdentity(version: { card?: { contentHash: string; executablePaths: Prisma.JsonValue } | null; packageData: Uint8Array | null }): { contentHash: string; executablePaths: Prisma.JsonValue } | null {
  if (version.card) return { contentHash: version.card.contentHash, executablePaths: version.card.executablePaths }
  if (!version.packageData) return null
  try {
    const described = describeSkillPackage(Buffer.from(version.packageData))
    return { contentHash: described.contentHash, executablePaths: described.executablePaths }
  } catch { return null }
}

export function decodePackage(
  packageBase64?: string,
  expectedSha256?: string,
  expectedSkillMd?: string
): PackageFields {
  return decodePackageWithEnv(packageBase64, expectedSha256, expectedSkillMd).packageFields
}

/** `decodePackage` plus the read-only env re-check of the package (#251); `env` is null without a package. */
export function decodePackageWithEnv(
  packageBase64?: string,
  expectedSha256?: string,
  expectedSkillMd?: string
): { packageFields: PackageFields; env: SkillPackageEnvReview | null } {
  if (!packageBase64) return { packageFields: {}, env: null }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(packageBase64) || packageBase64.length % 4 !== 0) {
    throw new Error('Invalid package encoding')
  }
  const packageData = Buffer.from(packageBase64, 'base64')
  if (packageData.length === 0 || packageData.length > MAX_PACKAGE_BYTES) {
    throw new Error('Skill package must be between 1 byte and 20 MB')
  }
  const packageSha256 = createHash('sha256').update(packageData).digest('hex')
  if (expectedSha256 && expectedSha256 !== packageSha256) {
    throw new Error('Skill package checksum mismatch')
  }
  const validated = reviewSkillPackageEnv(packageData)
  if (expectedSkillMd) {
    const normalize = (value: string): string => value
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .trim()
    if (normalize(validated.skillMd) !== normalize(expectedSkillMd)) {
      throw new Error('SKILL.md does not match the uploaded package')
    }
  }
  return { packageFields: { packageData, packageSha256, packageSize: packageData.length }, env: validated.env }
}

/**
 * Stored env dependencies are the package declaration ∪ the client's list
 * (#251): a declared key keeps the declaration's required/description/obtain,
 * client entries only add keys. Without a declaration the client list is kept as is.
 */
export function mergeDeclaredEnvDependencies(declared: readonly EnvDeclaration[], submitted: EnvDependency[]): EnvDependency[] {
  if (declared.length === 0) return submitted
  const merged = new Map(submitted.map((dependency) => [dependency.key, dependency]))
  for (const declaration of declared) merged.set(declaration.key, { ...declaration })
  return [...merged.values()].sort((left, right) => left.key.localeCompare(right.key, 'en-US'))
}

/** Keys the Server's re-check found (high/medium) that the stored dependencies do not list. */
export function detectedUndeclaredKeys(detected: readonly EnvSuggestion[], dependencies: readonly { key: string }[]): string[] {
  const listed = new Set(dependencies.map((dependency) => dependency.key))
  return detected
    .filter((suggestion) => suggestion.confidence !== 'low' && !listed.has(suggestion.key))
    .map((suggestion) => suggestion.key)
}

type PackageEnvOutcome =
  | { ok: true; envDependencies: EnvDependency[] | undefined; detectedUndeclared: string[] | null }
  | { ok: false; message: string }

/**
 * Applies the package declaration to the client list. `submitted` undefined
 * keeps the "preserve" semantics unless the package declares keys, in which
 * case the stored list is merged with the declaration.
 */
export function packageEnvOutcome(
  env: SkillPackageEnvReview | null,
  skillMd: string,
  submitted: EnvDependency[] | undefined,
  stored: () => EnvDependency[],
): PackageEnvOutcome {
  let declared: EnvDeclaration[]
  try {
    declared = env?.declared ?? parseEnvDeclarations(skillMd)
  } catch (error: unknown) {
    if (error instanceof EnvDeclarationError) return { ok: false, message: error.message }
    throw error
  }
  const base = submitted ?? (declared.length > 0 ? stored() : undefined)
  const envDependencies = base === undefined ? undefined : mergeDeclaredEnvDependencies(declared, base)
  if (envDependencies && envDependencies.length > 100) {
    return { ok: false, message: 'Too many environment dependencies (declared and submitted exceed 100)' }
  }
  const detectedUndeclared = env ? detectedUndeclaredKeys(env.detected, envDependencies ?? stored()) : null
  return { ok: true, envDependencies, detectedUndeclared }
}

function stringArray(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizedEnvDependencies(dependencies: EnvDependency[]): EnvDependency[] {
  return dependencies
    .map((dependency) => ({
      key: dependency.key,
      ...(dependency.description?.trim() ? { description: dependency.description.trim() } : {}),
      required: dependency.required,
      ...(dependency.obtain ? { obtain: dependency.obtain } : {}),
    }))
    .sort((left, right) => left.key.localeCompare(right.key, 'en-US'))
}

function normalizedCompatibleAgents(agents: CompatibleAgent[]): CompatibleAgent[] {
  return [...new Set(agents)].sort((left, right) => left.localeCompare(right, 'en-US'))
}

export function importMutationDigest(input: {
  currentVersion: string
  compatibleAgents: CompatibleAgent[]
  envDependencies: EnvDependency[]
}, packageSha256: string): string {
  const canonical = JSON.stringify({
    schema: 1,
    currentVersion: input.currentVersion,
    packageSha256,
    compatibleAgents: normalizedCompatibleAgents(input.compatibleAgents),
    envDependencies: normalizedEnvDependencies(input.envDependencies),
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export function versionMutationDigest(input: {
  version: string
  changelog?: string
  gitHash?: string
  envDependencies?: EnvDependency[]
}, packageSha256: string): string {
  const canonical = JSON.stringify({
    schema: 1,
    version: input.version,
    packageSha256,
    changelog: input.changelog ?? null,
    gitHash: input.gitHash ?? null,
    envDependencies: input.envDependencies === undefined
      ? { mode: 'preserve' }
      : { mode: 'replace', values: normalizedEnvDependencies(input.envDependencies) },
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function anthropicMessagesUrl(settings: EffectiveAi): string {
  const baseUrl = settings.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '')
  return `${baseUrl}/v1/messages`
}

async function requestAnthropicCompletion(
  settings: EffectiveAi,
  systemPrompt: string,
  userPrompt: string
): Promise<string | null> {
  const response = await fetch(anthropicMessagesUrl(settings), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: config.AI_MAX_TOKENS,
      temperature: 0.3,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(config.AI_TIMEOUT_MS),
  })
  // Keep only status + Retry-After: the worker schedules on them; bodies stay out.
  if (!response.ok) throw await readAiProviderHttpError('anthropic', response)

  const payload: unknown = await response.json()
  const parsed = AnthropicResponseSchema.safeParse(payload)
  if (!parsed.success) return null
  const text = parsed.data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim()
  return text || null
}

async function requestOpenAiCompletion(
  client: OpenAI,
  settings: EffectiveAi,
  systemPrompt: string,
  userPrompt: string,
  format: 'json' | 'text' = 'json',
): Promise<string | null> {
  const response = await client.chat.completions.create(
    {
      model: settings.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      ...(format === 'json' ? { response_format: { type: 'json_object' as const } } : {}),
      max_tokens: config.AI_MAX_TOKENS,
      temperature: 0.3,
    },
    { timeout: config.AI_TIMEOUT_MS, maxRetries: 0 }
  )
  return response.choices[0]?.message?.content ?? null
}

async function requestOpenAiResponse(settings: EffectiveAi, systemPrompt: string, userPrompt: string): Promise<string | null> {
  const response = await fetch(`${openAiCompatibleBaseUrl(settings.baseUrl)}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: settings.model,
      instructions: systemPrompt,
      input: userPrompt,
      max_output_tokens: config.AI_MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(config.AI_TIMEOUT_MS),
  })
  if (!response.ok) throw await readAiProviderHttpError('openai-responses', response)
  const payload: unknown = await response.json()
  const parsed = OpenAiResponsesSchema.safeParse(payload)
  if (!parsed.success) return null
  const text = parsed.data.output
    .flatMap((item) => item.content)
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text ?? '')
    .join('')
    .trim()
  return text || null
}

/**
 * One AI completion through the shared guard. `priority` is `user` for requests a person
 * waits on (topic AI drafting) and `background` for avatar drawing prompts, which must leave
 * a concurrency slot and part of the daily quota for users (#238).
 */
export async function requestConfiguredAiDraft(key: string, system: string, input: string, format: 'json' | 'text' = 'json', priority: AiRequestPriority = 'user'): Promise<string | null> {
  const settings = await resolveAiConfig()
  if (!settings) return null
  return aiRequestGuard.run(key, async () => {
    return configuredCompletion(settings, system, input, format)
  }, priority)
}

async function configuredCompletion(settings: EffectiveAi, system: string, input: string, format: 'json' | 'text' = 'json'): Promise<string | null> {
  if (config.SKILLHUB_PROFILE === 'selfhost') return requestSafeAiCompletion(settings, system, input, format)
  if (settings.protocol === 'anthropic') return requestAnthropicCompletion(settings, system, input)
  if (settings.protocol === 'openai-responses') return requestOpenAiResponse(settings, system, input)
  return requestOpenAiCompletion(getAiClient(settings), settings, system, input, format)
}

export { redactSensitiveContent }

type SkillDto = Pick<Skill, keyof typeof skillDtoSelect> & { avatarSource?: 'generated' | 'custom' }
async function toSkillDto(skill: Skill): Promise<SkillDto> {
  const display = await projectSkillAvatar(skill)
  return {
    id: skill.id,
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    sourceUrl: skill.sourceUrl ?? null,
    storeCopy: skill.storeCopy ?? null,
    avatarUrl: display.avatarUrl ?? null,
    avatarStatus: display.avatarStatus ?? 'none',
    ...(variantsMode() ? { avatarSource: display.avatarSource ?? 'generated' } : {}),
    category: skill.category,
    labels: skill.labels,
    analysisStatus: skill.analysisStatus,
    triggerScenarios: skill.triggerScenarios,
    compatibleAgents: skill.compatibleAgents,
    envDependencies: skill.envDependencies,
    authorId: skill.authorId,
    currentVersion: skill.currentVersion,
    installCount: skill.installCount,
    visibility: skill.visibility,
    marketplaceStatus: skill.marketplaceStatus,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  }
}

function withoutPrivateSkillFields<T extends object>(
  skill: T
): Omit<T, 'sourceContent' | 'ossPackageKey' | 'deletedAt'> {
  const dto = { ...skill } as Record<string, unknown>
  const enrichment = dto.enrichment as { phase: string } | null | undefined
  if ('enrichment' in dto) {
    const analysisEnabled = aiStatus().configured && config.AI_MAX_CONCURRENT >= 2
    const avatarsEnabled = avatarGenerationEnabled()
    dto.enrichmentPending = enrichment?.phase === 'analysis' ? analysisEnabled || avatarsEnabled
      : enrichment?.phase === 'avatar' ? avatarsEnabled
      : enrichment?.phase === 'failed' || enrichment?.phase === 'parked' ? false
      : enrichment?.phase === 'done' ? avatarsEnabled && dto.avatarStatus === 'pending'
      : dto.analysisStatus === 'unanalysed' && !dto.avatarUrl && (analysisEnabled || avatarsEnabled)
  }
  if (enrichment?.phase === 'avatar' && avatarGenerationEnabled() && !dto.avatarUrl
    && (!dto.avatarStatus || dto.avatarStatus === 'none')) dto.avatarStatus = 'pending'
  delete dto.enrichment
  delete dto.sourceContent
  delete dto.ossPackageKey
  delete dto.deletedAt
  delete dto.profileManuallyEdited
  return dto as Omit<T, 'sourceContent' | 'ossPackageKey' | 'deletedAt'>
}

const skillDtoSelect = {
  storeCopy: true,
  sourceUrl: true,
  id: true,
  name: true,
  displayName: true,
  description: true,
  avatarUrl: !variantsMode(),
  avatarStatus: !variantsMode(),
  category: true,
  labels: true,
  analysisStatus: true,
  triggerScenarios: true,
  compatibleAgents: true,
  envDependencies: true,
  authorId: true,
  currentVersion: true,
  installCount: true,
  visibility: true,
  marketplaceStatus: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SkillSelect

type ImportRecoverySkill = Skill & {
  versions: Array<{ id: string; version: string; sourceUrl: string | null; packageSha256: string | null; compatibleAgents: Prisma.JsonValue | null; envDependencies: Prisma.JsonValue | null; aliases: { oldLabel: string }[] }>
}

async function findOwnedImport(
  authorId: string,
  name: string,
  currentVersion: string,
  client: Pick<Prisma.TransactionClient, 'skill'> = db
): Promise<ImportRecoverySkill | null> {
  return client.skill.findFirst({
    where: { authorId, name, deletedAt: null },
    include: {
      versions: {
        select: { id: true, version: true, sourceUrl: true, packageSha256: true, compatibleAgents: true, envDependencies: true, aliases: { select: { oldLabel: true } } },
      },
    },
  })
}

function isExactImportRecovery(
  skill: ImportRecoverySkill,
  input: {
    currentVersion: string
    sourceUrl?: string | null
    compatibleAgents: CompatibleAgent[]
    envDependencies: EnvDependency[]
  },
  packageSha256: string | undefined
): boolean {
  const first = skill.versions[0]
  if (!packageSha256 || !skill.importVersionId || skill.versions.length !== 1 || first?.id !== skill.importVersionId
    || first.version !== skill.currentVersion || (first.version !== input.currentVersion && !first.aliases.some((a) => a.oldLabel === input.currentVersion))) return false
  const storedPackageSha256 = first.packageSha256
  if (storedPackageSha256 !== packageSha256) return false
  if (input.sourceUrl !== undefined && first.sourceUrl !== input.sourceUrl) return false

  const storedAgents = ImportCompatibleAgentsSchema.safeParse(skill.compatibleAgents)
  const storedDependencies = EnvDependenciesSchema.safeParse(skill.envDependencies)
  if (!storedAgents.success || !storedDependencies.success) return false
  const originalAgents = ImportCompatibleAgentsSchema.safeParse(first.compatibleAgents)
  const originalDependencies = EnvDependenciesSchema.safeParse(first.envDependencies)
  if (!originalAgents.success || !originalDependencies.success) return false
  if (importMutationDigest(input, packageSha256) !== importMutationDigest({ currentVersion: input.currentVersion, compatibleAgents: originalAgents.data, envDependencies: originalDependencies.data }, storedPackageSha256)) return false

  return importMutationDigest(input, packageSha256) === importMutationDigest({
    currentVersion: input.currentVersion,
    compatibleAgents: storedAgents.data,
    envDependencies: storedDependencies.data,
  }, storedPackageSha256)
}

async function recoveredImportResult(skill: Skill): Promise<{ skill: SkillDto; analysis: { status: 'recovered'; provider: null; redactedSecrets: number }; recovered: true; idempotent: true }> {
  return {
    skill: await toSkillDto(skill),
    analysis: {
      status: 'recovered' as const,
      provider: null,
      redactedSecrets: 0,
    },
    recovered: true,
    idempotent: true,
  }
}

type SkillShareDtoSource = {
  skillId: string
  teamId: string
  sharedById: string
  createdAt: Date
}

function toSkillShareDto(share: SkillShareDtoSource) {
  return {
    skillId: share.skillId,
    teamId: share.teamId,
    sharedById: share.sharedById,
    createdAt: share.createdAt,
  }
}

async function hasActiveTeamAccess(userId: string, teamIds: string[]): Promise<boolean> {
  if (teamIds.length === 0) return false
  const memberships = await db.teamMember.count({
    where: {
      userId,
      teamId: { in: teamIds },
      team: { dissolvedAt: null },
    },
  })
  return memberships > 0
}

function analysisResult(analysis: SkillAnalysis) {
  return {
    status: analysis.source === 'ai' ? 'completed' : analysis.source,
    provider: aiProviderInfo().baseUrl ? new URL(aiProviderInfo().baseUrl!).host : null,
    redactedSecrets: analysis.redactedSecrets,
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

/**
 * Legacy uploads keep working from the database copy if the card store is
 * unavailable; the version is carded later by the backfill or on first sync.
 */
async function prepareUploadedCard(
  packageData: Buffer | undefined,
  log: { warn: (details: object, message: string) => void }
): Promise<PreparedCard | undefined> {
  if (!packageData) return undefined
  try {
    return await prepareCard(packageData)
  } catch (error: unknown) {
    log.warn({ error: error instanceof Error ? error.message : 'unknown card error' }, 'Skill card write deferred')
    return undefined
  }
}

export async function userStoredPackageBytes(
  userId: string,
  client: Pick<Prisma.TransactionClient, 'skillVersion'> = db
): Promise<number> {
  const result = await client.skillVersion.aggregate({
    where: { skill: { authorId: userId } },
    _sum: { packageSize: true },
  })
  return result._sum.packageSize ?? 0
}

class SkillQuotaError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 409 | 413
  ) {
    super(message)
  }
}

type SkillLabelRule = {
  label: SkillProfileLabel
  patterns: readonly RegExp[]
}

const SKILL_LABEL_RULES: readonly SkillLabelRule[] = [
  { label: '代码开发', patterns: [/\b(code|coding|developer|programming)\b/iu, /代码|编程|开发脚本/iu] },
  { label: '代码审查', patterns: [/\b(code[ -]?review|lint|static analysis)\b/iu, /代码审查|代码审核|静态分析/iu] },
  { label: '调试排障', patterns: [/\b(debug|troubleshoot|diagnos(?:e|is)|bugfix|bug)\b/iu, /调试|排障|诊断|故障|错误修复/iu] },
  { label: '测试验证', patterns: [/\b(test|testing|verify|verifier|validation|qa)\b/iu, /测试|验证|验收|质量检查/iu] },
  { label: '版本管理', patterns: [/\b(git|version control|changelog|commit history)\b/iu, /版本管理|变更记录|提交历史/iu] },
  { label: '发布部署', patterns: [/\b(release|deploy|deployment|publish|packag(?:e|ing)|distribution)\b/iu, /发布|部署|构建|打包|分发/iu] },
  { label: '信息检索', patterns: [/\b(search|lookup|query|retriev(?:e|al))\b/iu, /搜索|检索|查找|查询/iu] },
  { label: '网页浏览', patterns: [/\b(browser|chrome|webpage|website|crawl|scrape)\b/iu, /网页|浏览器|网站|爬取/iu] },
  { label: '深度研究', patterns: [/\b(research|primary sources?|citation|literature)\b/iu, /深度研究|调研|研究|信源|论文/iu] },
  { label: '知识管理', patterns: [/\b(knowledge base|knowledge management|obsidian|wiki|memory|notes?)\b/iu, /知识库|知识管理|笔记|记忆/iu] },
  { label: '内容写作', patterns: [/\b(writing|copywriting|rewrite|article|blog|tweet|story)\b/iu, /写作|文案|文章|改写|脚本创作/iu] },
  { label: '文档处理', patterns: [/\b(document|documents|pdf|markdown|docx|word)\b/iu, /文档|文件转换/iu] },
  { label: '图像创作', patterns: [/\b(image|photo|figma|svg|diagram|infographic|poster)\b/iu, /图像|图片|海报|视觉|绘图|信息图/iu] },
  { label: '音视频处理', patterns: [/\b(video|audio|media|subtitle|transcri(?:be|ption)|remotion)\b/iu, /视频|音频|多媒体|字幕|转录|剪辑/iu] },
  { label: '演示文稿', patterns: [/\b(slides?|pptx?|presentation|keynote)\b/iu, /幻灯片|演示文稿|演示文档/iu] },
  { label: '数据处理', patterns: [/\b(csv|xlsx?|excel|spreadsheet|database|sql|etl)\b/iu, /数据处理|数据清洗|表格|数据库/iu] },
  { label: '数据分析', patterns: [/\b(analytics?|metrics?|statistics|reporting)\b/iu, /数据分析|统计|指标|报表/iu] },
  { label: '数据可视化', patterns: [/\b(visuali[sz]ation|charts?|dashboard)\b/iu, /数据可视化|图表|仪表盘/iu] },
  { label: 'AI生成', patterns: [/\b(llm|generative ai|prompt engineering|gpt|openai|anthropic)\b/iu, /生成式AI|提示词|大模型|模型生成/iu] },
  { label: '流程自动化', patterns: [/\b(automation|automate|workflow|pipeline|batch|scheduler?)\b/iu, /自动化|工作流|流程|批处理|定时/iu] },
  { label: 'API集成', patterns: [/\b(api|webhook|http|integration|mcp|sdk)\b/iu, /接口|系统集成/iu] },
  { label: '命令行工具', patterns: [/\b(cli|terminal|shell|bash|zsh|command line)\b/iu, /命令行|终端|命令工具/iu] },
  { label: '文件管理', patterns: [/\b(files?|folders?|director(?:y|ies)|archive|zip)\b/iu, /文件管理|文件夹|目录|压缩包/iu] },
  { label: '团队协作', patterns: [/\b(team|sharing|collaboration|collaborate|slack|feishu|lark)\b/iu, /团队|共享|协作|飞书/iu] },
  { label: '项目管理', patterns: [/\b(project management|task management|kanban|asana|linear|jira)\b/iu, /项目管理|任务管理|看板/iu] },
  { label: '办公效率', patterns: [/\b(office|calendar|email|meeting|approval)\b/iu, /办公|日历|邮件|会议|审批/iu] },
  { label: 'Agent工具', patterns: [/\b(codex|claude code|opencode|openclaw|gemini cli|agent tools?)\b/iu, /Agent工具|智能体工具/iu] },
  { label: 'Skill管理', patterns: [/\b(skillhub|skill manager|skill management|skill marketplace)\b/iu, /技能管理|管理.{0,8}Skill|Skill.{0,8}(管理|安装|导入|投影)/iu] },
  { label: '环境配置', patterns: [/\b(environment variables?|env vars?|credentials?|api keys?|macos|windows|linux)\b/iu, /环境变量|运行环境|凭证|密钥|配置/iu] },
  { label: '安全合规', patterns: [/\b(security|authentication|authorization|encryption|permission|audit)\b/iu, /安全|认证|授权|加密|权限|审计/iu] },
]

const CATEGORY_FALLBACK_LABELS: Record<SkillCategory, readonly SkillProfileLabel[]> = {
  '协作与办公': ['团队协作', '办公效率'],
  '自动化与集成': ['流程自动化', 'API集成'],
  '搜索与研究': ['信息检索', '深度研究'],
  '内容与创作': ['内容写作', '文档处理'],
  '开发与工程': ['代码开发', '命令行工具'],
  '数据与分析': ['数据分析', '数据处理'],
  '其他': ['通用工具', 'Agent工具'],
}

const LABEL_COMPANIONS: Partial<Record<SkillProfileLabel, readonly SkillProfileLabel[]>> = {
  '代码审查': ['代码开发'],
  '调试排障': ['代码开发'],
  '测试验证': ['代码开发'],
  '版本管理': ['代码开发'],
  '发布部署': ['代码开发'],
  '网页浏览': ['信息检索'],
  '深度研究': ['信息检索'],
  '演示文稿': ['文档处理'],
  '数据可视化': ['数据分析'],
  'API集成': ['流程自动化'],
  'Skill管理': ['Agent工具'],
  '环境配置': ['Agent工具'],
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

export function inferFallbackSkillLabels(
  skillName: string,
  skillMd: string,
  category: SkillCategory,
  hints: readonly string[] = []
): SkillProfileLabel[] {
  const highSignalText = [skillName, ...hints].join('\n')
  const matchedLabels = SKILL_LABEL_RULES
    .map((rule, index) => {
      const exactLabelHint = highSignalText.includes(rule.label) ? 8 : 0
      const highSignalMatch = matchesAny(highSignalText, rule.patterns) ? 4 : 0
      const contentMatch = matchesAny(skillMd, rule.patterns) ? 1 : 0
      return { label: rule.label, score: exactLabelHint + highSignalMatch + contentMatch, index }
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 5)
    .map((match) => match.label)

  const selected = [...matchedLabels]
  for (const label of matchedLabels) {
    for (const companion of LABEL_COMPANIONS[label] ?? []) {
      if (selected.length >= 2) break
      if (!selected.includes(companion)) selected.push(companion)
    }
  }
  for (const fallbackLabel of CATEGORY_FALLBACK_LABELS[category]) {
    if (selected.length >= 2) break
    if (!selected.includes(fallbackLabel)) selected.push(fallbackLabel)
  }

  return selected.slice(0, 5)
}

export function fallbackProfile(skillName: string, skillMd: string): SkillProfile {
  const document = parseSkillDocument(skillMd)
  const categoryValue = frontmatterText(document, 'category')
  const category = CATEGORY_LIST.find((item) => item === categoryValue) ?? '其他'
  const displayName = frontmatterDisplayName(document) || firstHeading(document.body) || skillName
  const description = frontmatterText(document, 'description') || firstParagraphLine(document.body) || skillName
  const declaredLabels = (frontmatterList(document, 'labels') ?? frontmatterList(document, 'tags') ?? []).slice(0, 8)
  const labels = inferFallbackSkillLabels(
    skillName,
    skillMd,
    category,
    [displayName, description, ...declaredLabels]
  )

  return {
    displayName: displayName.slice(0, 80),
    description: description.slice(0, 500),
    category,
    labels,
    triggerScenarios: [],
  }
}

function unanalysedProfile(skillName: string, skillMd: string): SkillAnalysis['profile'] {
  const document = parseSkillDocument(skillMd)
  return {
    displayName: (frontmatterDisplayName(document) || skillName).slice(0, 80),
    description: (frontmatterText(document, 'description') || '').slice(0, 500),
    category: frontmatterText(document, 'category') ?? null,
    labels: (frontmatterList(document, 'labels') ?? frontmatterList(document, 'tags') ?? []).slice(0, 100),
    triggerScenarios: [],
  }
}

function parseAiProfile(raw: string): SkillProfile | null {
  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  if (firstBrace < 0 || lastBrace <= firstBrace) return null
  try {
    const decoded: unknown = JSON.parse(raw.slice(firstBrace, lastBrace + 1))
    const source = typeof decoded === 'object' && decoded !== null && 'profile' in decoded
      ? (decoded as { profile: unknown }).profile
      : decoded
    if (typeof source !== 'object' || source === null) return null
    const record = source as Record<string, unknown>
    const normalized = {
      displayName: record.displayName ?? record.display_name,
      description: record.description,
      category: record.category,
      labels: record.labels ?? record.tags,
      triggerScenarios: record.triggerScenarios ?? record.trigger_scenarios ?? [],
    }
    const parsed = SkillProfileSchema.safeParse(normalized)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Manual analysis defaults to user priority; enrichment explicitly uses the shared background allowance. */
export async function analyzeSkillWithAI(
  skillName: string,
  skillMd: string,
  guardKey: string,
  reservation?: AiReservation,
  priority: AiRequestPriority = 'user',
): Promise<SkillAnalysis> {
  const sanitized = redactSensitiveContent(skillMd)
  const settings = await resolveAiConfig()
  const unavailable = (): SkillAnalysis => ({
    profile: config.SKILLHUB_PROFILE === 'selfhost' ? unanalysedProfile(skillName, sanitized.content) : fallbackProfile(skillName, sanitized.content),
    source: config.SKILLHUB_PROFILE === 'selfhost' ? 'unanalysed' : 'fallback', redactedSecrets: sanitized.redactedSecrets,
  })
  if (!settings) return unavailable()

  const systemPrompt = `你是一探SkillHub的Skill分析引擎。给定一个Agent Skill的名称和SKILL.md内容，
生成友好的中文Profile。category是宽泛归类，labels是用于检索与筛选的细分类主键。
labels必须只从下方目录选择2–5个；优先选最具体、直接描述Skill主要能力的标签；不得自造、改写或重复标签。
受控标签目录：
${SKILL_LABEL_PROMPT_CATALOG}

返回严格的JSON，不要包含多余文字。格式：
{
  "displayName": "简短中文名（≤10字）",
  "description": "功能说明（≤60字）",
  "category": "${CATEGORY_LIST.join('|')} 中选一个",
  "labels": ["目录标签1","目录标签2"],
  "triggerScenarios": ["场景1","场景2","场景3"]
}`

  const userPrompt = `Skill名称：${skillName}

SKILL.md内容：
${sanitized.content.slice(0, 3000)}`

  try {
    const raw = await aiRequestGuard.run(guardKey, async () => configuredCompletion(settings, systemPrompt, userPrompt), priority, reservation)
    if (!raw) {
      return unavailable()
    }
    const parsedProfile = parseAiProfile(raw)
    if (!parsedProfile) {
      return unavailable()
    }
    return {
      profile: parsedProfile,
      source: 'ai',
      redactedSecrets: sanitized.redactedSecrets,
    }
  } catch (error: unknown) {
    if (error instanceof AiRequestGuardError) throw error
    return unavailable()
  }
}

export const skillsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', authMiddleware)
  if (config.SKILLHUB_PROFILE === 'selfhost') await fastify.register(aiBatchRoutes, { prefix: '/analysis/batches' })
  const versionWrites = new Map<string, { count: number; resetAt: number }>()
  const packageReads = new Map<string, { count: number; resetAt: number }>()
  const validatedPackages = new Map<string, true>()
  const assetWriteTails = new Map<string, Promise<void>>()

  async function withAssetWriteLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const previous = assetWriteTails.get(userId) ?? Promise.resolve()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    assetWriteTails.set(userId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (assetWriteTails.get(userId) === tail) assetWriteTails.delete(userId)
    }
  }

  function consumeVersionWrite(userId: string): number | null {
    const now = Date.now()
    const current = versionWrites.get(userId)
    if (!current || current.resetAt <= now) {
      versionWrites.set(userId, { count: 1, resetAt: now + 60 * 60 * 1000 })
      return null
    }
    if (current.count >= config.SKILL_VERSION_WRITES_PER_HOUR) {
      return Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    }
    current.count += 1
    return null
  }

  function consumePackageRead(userId: string): number | null {
    const now = Date.now()
    const current = packageReads.get(userId)
    if (!current || current.resetAt <= now) {
      packageReads.set(userId, { count: 1, resetAt: now + 60_000 })
      return null
    }
    if (current.count >= 12) {
      return Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    }
    current.count += 1
    return null
  }

  function rememberValidatedPackage(cacheKey: string): void {
    validatedPackages.delete(cacheKey)
    validatedPackages.set(cacheKey, true)
    const oldest = validatedPackages.keys().next().value as string | undefined
    if (validatedPackages.size > 256 && oldest) validatedPackages.delete(oldest)
  }

  async function skillLimitReached(
    userId: string,
    client: Pick<Prisma.TransactionClient, 'skill'> = db
  ): Promise<boolean> {
    const count = await client.skill.count({ where: { authorId: userId, deletedAt: null } })
    return count >= config.SKILL_MAX_PER_USER
  }

  async function skillRecordLimitReached(
    userId: string,
    client: Pick<Prisma.TransactionClient, 'skill'> = db
  ): Promise<boolean> {
    const count = await client.skill.count({ where: { authorId: userId } })
    return count >= config.SKILL_MAX_PER_USER * 20
  }

  // GET /api/skills
  fastify.get<{ Querystring: { scope?: string; teamId?: string } }>('/', async (req, reply) => {
    const userId = req.user.id
    const { scope, teamId } = req.query

    if (scope === 'team' && teamId) {
      const membership = await db.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId } },
        include: { team: { select: { dissolvedAt: true } } },
      })
      if (!membership) return reply.forbidden('Active team membership required')
      if (membership.team.dissolvedAt) return reply.gone('Team has been dissolved')
      const shares = await db.skillTeamShare.findMany({
        where: { teamId, skill: { deletedAt: null } },
        select: {
          sharedById: true,
          createdAt: true,
          version: { select: { id: true, version: true, envDependencies: true, sourceContent: true, sourceUrl: true, changelog: true } },
          skill: {
            select: {
              ...skillDtoSelect,
              author: { select: { id: true, displayName: true } },
            },
          },
        },
      })
      // SkillTeamShare.sharedById has no relation, so resolve the sharers in
      // one query; a sharer whose account is gone shows as null (#293).
      const sharerIds = [...new Set(shares.map((share) => share.sharedById))]
      const sharers = sharerIds.length > 0
        ? await db.user.findMany({
          where: { id: { in: sharerIds } },
          select: { id: true, displayName: true, avatarUrl: true },
        })
        : []
      const sharerById = new Map(sharers.map((sharer) => [sharer.id, sharer]))
      const versions = await db.skillVersion.findMany({ where: { OR: shares.map(share => ({ skillId: share.skill.id, version: share.skill.currentVersion })) }, select: { skillId: true, sourceUrl: true } })
      const sharedSources = new Map(versions.map(version => [version.skillId, version.sourceUrl]))
      const displayed = new Map((await projectSkillAvatars(shares.map(share => share.skill))).map(skill => [skill.id, skill]))
      return shares.map((share) => {
        const sharer = sharerById.get(share.sharedById)
        return {
          ...withoutPrivateSkillFields(displayed.get(share.skill.id)!),
          sourceUrl: sharedSources.get(share.skill.id) ?? null,
          ...(share.version ? { currentVersion: share.version.version, teamVersionId: share.version.id,
            envDependencies: share.version.envDependencies, sourceContent: share.version.sourceContent,
            sourceUrl: share.version.sourceUrl, changelog: share.version.changelog } : {}),
          sharedBy: sharer
            ? { id: sharer.id, displayName: sharer.displayName, avatarUrl: sharer.avatarUrl }
            : null,
          sharedAt: share.createdAt.toISOString(),
        }
      })
    }

    const skills = await db.skill.findMany({
      where: { authorId: userId, deletedAt: null },
      select: {
        ...skillDtoSelect,
        enrichment: { select: { phase: true } },
        teamShares: { select: { teamId: true, versionId: true, version: { select: { version: true, packageSha256: true } } } },
      },
      orderBy: { updatedAt: 'desc' },
    })
    return (await projectSkillAvatars(skills)).map(withoutPrivateSkillFields)
  })

  // GET /api/skills/trash — owner-only recoverable Skill tombstones.
  fastify.get('/trash', async (req) => {
    return projectSkillAvatars(await db.skill.findMany({
      where: { authorId: req.user.id, deletedAt: { not: null } },
      select: {
        ...skillDtoSelect,
        deletedAt: true,
      },
      orderBy: { deletedAt: 'desc' },
      take: config.SKILL_MAX_PER_USER * 20,
    }))
  })

  // POST /api/skills
  fastify.post('/', async (req, reply) => {
    const body = CreateSkillBody.safeParse(req.body)
    if (!body.success) return reply.badRequest(body.error.message)
    try {
      const skill = await withAssetWriteLock(req.user.id, async () => {
        // The User lock also serializes library author-asset publishing,
        // which runs outside this process-local asset lock.
        return db.$transaction(async (transaction) => {
          await lockUserMutation(transaction, req.user.id)
          if (await skillLimitReached(req.user.id, transaction)) {
            throw new SkillQuotaError('Skill account limit reached', 409)
          }
          if (await skillRecordLimitReached(req.user.id, transaction)) {
            throw new SkillQuotaError('Skill recycle bin limit reached', 409)
          }
          return transaction.skill.create({ data: { ...body.data, authorId: req.user.id,
            labelsManuallyEdited: Object.prototype.hasOwnProperty.call(req.body, 'labels') } })
        })
      })
      return reply.code(201).send({ ...await toSkillDto(skill),
        enrichmentPending: (aiStatus().configured && config.AI_MAX_CONCURRENT >= 2) || avatarGenerationEnabled() })
    } catch (error: unknown) {
      if (error instanceof SkillQuotaError) {
        return reply.code(error.statusCode).send({ error: error.message })
      }
      if (isUniqueConstraintError(error)) {
        return reply.conflict('Skill already exists in the asset library')
      }
      throw error
    }
  })

  // GET /api/skills/analysis-policy — disclosure data for the import confirmation UI
  fastify.get('/analysis-policy', async () => {
    const settings = await resolveAiConfig()
    return {
    requiresConsent: true,
    ...aiStatus(),
    provider: settings ? new URL(settings.baseUrl).host : null,
    contentLimitChars: 3_000,
    secretRedaction: true,
    protocol: settings?.protocol ?? null,
    }
  })

  // POST /api/skills/import — analyze SKILL.md and create asset metadata atomically
  fastify.post('/import', { bodyLimit: 30 * 1024 * 1024 }, async (req, reply) => {
    const verifiedAuthToken = req.verifiedAuthToken
    if (
      !verifiedAuthToken
      || verifiedAuthToken.sub !== req.user.id
      || !Number.isInteger(verifiedAuthToken.ver)
    ) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    const body = ImportSkillBody.safeParse(req.body)
    if (!body.success) return reply.badRequest(body.error.message)

    let packageFields: PackageFields
    let packageEnv: SkillPackageEnvReview | null
    try {
      ({ packageFields, env: packageEnv } = decodePackageWithEnv(
        body.data.packageBase64,
        body.data.packageSha256,
        body.data.skillMd
      ))
    } catch (error: unknown) {
      return reply.badRequest(error instanceof Error ? error.message : 'Invalid Skill package')
    }
    const envOutcome = packageEnvOutcome(packageEnv, body.data.skillMd, body.data.envDependencies, () => [])
    if (!envOutcome.ok) return reply.badRequest(envOutcome.message)
    // Package declaration ∪ client list (#251); recovery and storage both use the merged list.
    const importInput = { ...body.data, envDependencies: envOutcome.envDependencies ?? body.data.envDependencies }
    const detectedUndeclared = envOutcome.detectedUndeclared

    const checked = await db.$transaction(async (tx) => {
      await lockUserMutation(tx, req.user.id)
      const existing = await findOwnedImport(req.user.id, body.data.name, body.data.currentVersion, tx)
      if (existing) await lockSkillMutation(tx, existing.id)
      const current = existing ? await findOwnedImport(req.user.id, body.data.name, body.data.currentVersion, tx) : null
      return { existing: current, recovered: current ? isExactImportRecovery(current, importInput, packageFields.packageSha256) : false }
    })
    const existing = checked.existing
    if (existing) {
      if (checked.recovered) {
        await continueCloudAvatar(req.user.id, existing.id, body.data.localSkillId, body.data.aliasLocalIds).catch(() => { req.log.warn('Skill avatar binding deferred') })
        return reply.code(200).send(await recoveredImportResult(existing))
      }
      return reply.code(409).send({ error: 'Existing import cannot be verified', code: existing.importVersionId ? 'VERSION_REQUEST_CONFLICT' : 'IMPORT_RECOVERY_UNVERIFIABLE' })
    }

    try { requireVersion(body.data.currentVersion) } catch (error: unknown) {
      if (error instanceof VersionPolicyError) return reply.code(error.statusCode).send({ error: error.message, code: error.code })
      throw error
    }

    if (await skillLimitReached(req.user.id)) {
      return reply.code(409).send({ error: 'Skill account limit reached' })
    }
    if (await skillRecordLimitReached(req.user.id)) {
      return reply.code(409).send({ error: 'Skill recycle bin limit reached' })
    }

    const storedBytes = await userStoredPackageBytes(req.user.id)
    if (storedBytes + (packageFields.packageSize ?? 0) > config.SKILL_MAX_STORAGE_BYTES_PER_USER) {
      return reply.code(413).send({ error: 'Skill storage quota exceeded' })
    }

    const sanitized = redactSensitiveContent(body.data.skillMd)
    const analysis: SkillAnalysis = { profile: unanalysedProfile(body.data.name, sanitized.content),
      source: 'unanalysed', redactedSecrets: sanitized.redactedSecrets }
    const sourceContent = sanitized.content
    const importCard = await prepareUploadedCard(packageFields.packageData, req.log)

    let commitResult:
      | { outcome: 'created'; skill: Skill }
      | { outcome: 'recovered'; skill: ImportRecoverySkill }
      | { outcome: 'conflict' }
      | { outcome: 'unauthorized' }
    try {
      commitResult = await withAssetWriteLock(req.user.id, async () => {
        return db.$transaction(async (transaction) => {
          await lockUserMutation(transaction, req.user.id)
          // The initial auth check predates package preparation. Share the
          // User lock with logout/password changes and fail closed before any
          // final duplicate/quota read or asset creation.
          const lockedUser = await transaction.user.findUnique({
            where: { id: req.user.id },
            select: { tokenVersion: true },
          })
          if (!lockedUser || lockedUser.tokenVersion !== verifiedAuthToken.ver) {
            return { outcome: 'unauthorized' } as const
          }

          const existingAfterAnalysis = await findOwnedImport(
            req.user.id,
            body.data.name,
            body.data.currentVersion,
            transaction
          )
          if (existingAfterAnalysis) {
            await lockSkillMutation(transaction, existingAfterAnalysis.id)
            return isExactImportRecovery(
              existingAfterAnalysis,
              importInput,
              packageFields.packageSha256
            )
              ? { outcome: 'recovered', skill: existingAfterAnalysis } as const
              : { outcome: 'conflict' } as const
          }
          if (await skillLimitReached(req.user.id, transaction)) {
            throw new SkillQuotaError('Skill account limit reached', 409)
          }
          if (await skillRecordLimitReached(req.user.id, transaction)) {
            throw new SkillQuotaError('Skill recycle bin limit reached', 409)
          }
          const currentBytes = await userStoredPackageBytes(req.user.id, transaction)
          if (currentBytes + (packageFields.packageSize ?? 0) > config.SKILL_MAX_STORAGE_BYTES_PER_USER) {
            throw new SkillQuotaError('Skill storage quota exceeded', 413)
          }
          if (importCard) await registerCard(transaction, importCard, req.user.id)
          const firstVersionId = randomUUID()
          const skill = await transaction.skill.create({
            data: {
              name: body.data.name,
              displayName: analysis.profile.displayName,
              description: analysis.profile.description,
              sourceUrl: body.data.sourceUrl,
              category: analysis.profile.category,
              labels: analysis.profile.labels,
              analysisStatus: analysis.source === 'ai' ? 'completed' : 'unanalysed',
              labelsManuallyEdited: analysis.source !== 'ai' && analysis.profile.labels.length > 0,
              triggerScenarios: analysis.profile.triggerScenarios,
              compatibleAgents: body.data.compatibleAgents,
              envDependencies: importInput.envDependencies,
              sourceContent,
              currentVersion: body.data.currentVersion,
              versionHighWater: requireVersion(body.data.currentVersion),
              authorId: req.user.id,
              versions: {
                create: {
                  id: firstVersionId,
                  version: body.data.currentVersion,
                  changelog: '首次导入',
                  profileSnapshotVersion: 1,
                  skillName: body.data.name,
                  displayName: analysis.profile.displayName,
                  description: analysis.profile.description,
                  sourceUrl: body.data.sourceUrl,
                  category: analysis.profile.category,
                  labels: analysis.profile.labels,
                  triggerScenarios: analysis.profile.triggerScenarios,
                  compatibleAgents: body.data.compatibleAgents,
                  envDependencies: importInput.envDependencies,
                  ...(detectedUndeclared ? { detectedUndeclared } : {}),
                  sourceContent,
                  ...packageFields,
                  ...(importCard ? { cardSha256: importCard.sha256 } : {}),
                },
              },
            },
          })
          await transaction.skill.update({ where: { id: skill.id }, data: { importVersionId: firstVersionId } })
          if (importCard) {
            await grantCard(transaction, req.user.id, importCard.sha256, 'authored', `skill:${skill.id}`)
          }
          return { outcome: 'created', skill } as const
        })
      })
    } catch (error: unknown) {
      if (error instanceof SkillQuotaError) {
        return reply.code(error.statusCode).send({ error: error.message })
      }
      if (isUniqueConstraintError(error)) {
        const collided = await db.$transaction(async (tx) => {
          await lockUserMutation(tx, req.user.id)
          const found = await findOwnedImport(req.user.id, body.data.name, body.data.currentVersion, tx)
          if (!found) return null
          await lockSkillMutation(tx, found.id)
          const current = await findOwnedImport(req.user.id, body.data.name, body.data.currentVersion, tx)
          return current && isExactImportRecovery(current, importInput, packageFields.packageSha256) ? current : null
        })
        if (collided) {
          await continueCloudAvatar(req.user.id, collided.id, body.data.localSkillId, body.data.aliasLocalIds).catch(() => { req.log.warn('Skill avatar binding deferred') })
          return reply.code(200).send(await recoveredImportResult(collided))
        }
        return reply.conflict('Skill already exists in the asset library')
      }
      throw error
    }

    if (commitResult.outcome === 'unauthorized') {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    if (commitResult.outcome === 'recovered') {
      await continueCloudAvatar(req.user.id, commitResult.skill.id, body.data.localSkillId, body.data.aliasLocalIds).catch(() => { req.log.warn('Skill avatar binding deferred') })
      return reply.code(200).send(await recoveredImportResult(commitResult.skill))
    }
    if (commitResult.outcome === 'conflict') {
      return reply.conflict('Skill already exists in the asset library')
    }

    await continueCloudAvatar(req.user.id, commitResult.skill.id, body.data.localSkillId, body.data.aliasLocalIds).catch(() => { req.log.warn('Skill avatar binding deferred') })
    return reply.code(201).send({
      skill: { ...await toSkillDto(commitResult.skill),
        enrichmentPending: (aiStatus().configured && config.AI_MAX_CONCURRENT >= 2) || avatarGenerationEnabled() },
      analysis: { ...analysisResult(analysis), queued: aiStatus().configured && config.AI_MAX_CONCURRENT >= 2 },
      // Author-only: keys the Server's package re-check found but nothing declares (#251).
      detectedUndeclared: detectedUndeclared ?? [],
    })
  })

  // GET /api/skills/:id
  fastify.get<{ Params: { id: string }; Querystring: { teamId?: string } }>('/:id', async (req, reply) => {
    const skill = await db.skill.findUnique({
      where: { id: req.params.id },
      select: {
        ...skillDtoSelect,
        deletedAt: true,
        versions: {
          select: {
            id: true,
            version: true,
            changelog: true,
            gitHash: true,
            packageSha256: true,
            packageSize: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        author: { select: { id: true, displayName: true, avatarUrl: true } },
        teamShares: { include: { team: { select: { id: true, name: true } } } },
      },
    })
    if (!skill || skill.deletedAt) return reply.notFound()
    if (skill.authorId !== req.user.id || req.query.teamId) {
      const memberships = await db.teamMember.findMany({
        where: {
          userId: req.user.id,
          teamId: { in: skill.teamShares.map((share) => share.team.id) },
          team: { dissolvedAt: null },
        },
        select: { teamId: true },
      })
      if (memberships.length === 0) return reply.forbidden()
      const allowedTeamIds = new Set(memberships.map((membership) => membership.teamId))
      const selected = await resolveTeamVersion(req.user.id, skill.id, req.query.teamId)
      if (!selected) return reply.notFound('Skill is no longer shared to this team')
      const sharedVersion = selected.version
      return withoutPrivateSkillFields({
        ...await projectSkillAvatar(skill),
        sourceUrl: sharedVersion?.sourceUrl ?? null,
        currentVersion: sharedVersion.version,
        teamVersionId: sharedVersion.id,
        envDependencies: sharedVersion.envDependencies,
        sourceContent: sharedVersion.sourceContent,
        versions: [formalVersionDto(sharedVersion)],
        teamShares: skill.teamShares.filter((share) => allowedTeamIds.has(share.team.id) && share.teamId === selected.teamId),
      })
    }
    return withoutPrivateSkillFields(await projectSkillAvatar(skill))
  })

  // GET /api/skills/:id/source — redacted SKILL.md for an owner or a member
  // of a team to which this Skill is actively shared.
  fastify.get<{ Params: { id: string }; Querystring: { teamId?: string } }>('/:id/source', async (req, reply) => {
    const skill = await db.skill.findUnique({
      where: { id: req.params.id },
      select: {
        authorId: true,
        sourceContent: true,
        deletedAt: true,
        teamShares: { select: { teamId: true } },
      },
    })
    if (!skill || skill.deletedAt) return reply.notFound('Skill not found')
    if (skill.authorId !== req.user.id || req.query.teamId) {
      const allowed = await hasActiveTeamAccess(
        req.user.id,
        skill.teamShares.map((share) => share.teamId)
      )
      if (!allowed) return reply.forbidden()
      const selected = await resolveTeamVersion(req.user.id, req.params.id, req.query.teamId)
      if (!selected?.version.sourceContent) return reply.notFound('Shared source is unavailable')
      return reply.send({ skillMd: selected.version.sourceContent })
    }
    if (!skill.sourceContent) {
      return reply.notFound('SKILL.md source is unavailable for this legacy asset; upload a new version first')
    }
    return { skillMd: skill.sourceContent }
  })

  // PATCH /api/skills/:id
  fastify.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const body = UpdateSkillBody.safeParse(req.body)
    if (!body.success) return reply.badRequest(body.error.message)
    // Removing a declared key needs no credential write: a team key's scope
    // is computed at runtime from the current declaration.
    const result = await db.$transaction(async (transaction) => {
      await lockUserMutation(transaction, req.user.id)
      await lockSkillMutation(transaction, req.params.id)
      const skill = await transaction.skill.findUnique({ where: { id: req.params.id } })
      if (!skill || skill.deletedAt) return { outcome: 'not_found' } as const
      if (skill.authorId !== req.user.id) return { outcome: 'forbidden' } as const
      const updated = await transaction.skill.update({ where: { id: req.params.id }, data: {
        ...body.data, ...(body.data.labels !== undefined ? { labelsManuallyEdited: true } : {}),
        ...(['displayName', 'description', 'category', 'triggerScenarios'].some(key => key in body.data) ? { profileManuallyEdited: true } : {}),
      } })
      return { outcome: 'updated', skill: updated } as const
    })
    if (result.outcome === 'not_found') return reply.notFound()
    if (result.outcome === 'forbidden') return reply.forbidden()
    return toSkillDto(result.skill)
  })

  // DELETE /api/skills/:id — owner-only recoverable soft delete.
  fastify.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const result = await db.$transaction(async (transaction) => {
      await lockUserMutation(transaction, req.user.id)
      await lockSkillMutation(transaction, req.params.id)
      const skill = await transaction.skill.findUnique({ where: { id: req.params.id } })
      if (!skill || skill.deletedAt) return { outcome: 'not_found' } as const
      if (skill.authorId !== req.user.id) return { outcome: 'forbidden' } as const

      const now = new Date()
      // Removing every team share takes the Skill out of all team keys'
      // scope; the keys themselves belong to their teams and stay.
      const removedTeamShares = await transaction.skillTeamShare.deleteMany({
        where: { skillId: skill.id },
      })
      const withdrawnMarketplaceSubmissions = await transaction.marketplaceSubmission.updateMany({
        where: {
          skillId: skill.id,
          status: { in: ['submitted', 'under_review'] },
        },
        data: { status: 'withdrawn', withdrawnAt: now },
      })
      const unpublishedMarketplaceListings = await transaction.marketplaceListing.updateMany({
        where: { skillId: skill.id, withdrawnAt: null },
        data: { withdrawnAt: now, withdrawnBy: 'author', withdrawnReason: null },
      })
      // An admin-unlisted listing becomes an author withdrawal as well, so restoring the Skill
      // from the recycle bin never lets an admin re-list it without a new reviewed submission.
      await transaction.marketplaceListing.updateMany({
        where: { skillId: skill.id, withdrawnAt: { not: null }, withdrawnBy: 'admin' },
        data: { withdrawnBy: 'author', withdrawnReason: null },
      })
      await transaction.skill.update({
        where: { id: skill.id },
        data: {
          deletedAt: now,
          visibility: 'private',
          marketplaceStatus: 'none',
        },
      })
      await transaction.credentialAuditEvent.create({
        data: {
          id: randomUUID(),
          requestId: String(req.id),
          actorId: req.user.id,
          skillId: skill.id,
          action: 'skill_soft_delete',
          outcome: 'success',
          reasonCode: 'owner_deleted_skill',
          bindingIds: [],
          metadata: {
            removedTeamShareCount: removedTeamShares.count,
            withdrawnMarketplaceSubmissionCount: withdrawnMarketplaceSubmissions.count,
            unpublishedMarketplaceListingCount: unpublishedMarketplaceListings.count,
          },
        },
      })
      return { outcome: 'deleted' } as const
    })
    if (result.outcome === 'not_found') return reply.notFound()
    if (result.outcome === 'forbidden') return reply.forbidden()
    return reply.code(204).send()
  })

  // POST /api/skills/:id/restore — restore metadata only; old Team shares and
  // team-key scopes stay removed until the owner explicitly re-shares.
  fastify.post<{ Params: { id: string } }>('/:id/restore', async (req, reply) => {
    try {
      const result = await withAssetWriteLock(req.user.id, async () => db.$transaction(async (transaction) => {
        await lockUserMutation(transaction, req.user.id)
        await lockSkillMutation(transaction, req.params.id)
        const skill = await transaction.skill.findUnique({ where: { id: req.params.id } })
        if (!skill) return { outcome: 'not_found' } as const
        if (skill.authorId !== req.user.id) return { outcome: 'forbidden' } as const
        if (!skill.deletedAt) return { outcome: 'not_deleted' } as const

        const conflict = await transaction.skill.findFirst({
          where: {
            authorId: req.user.id,
            name: skill.name,
            deletedAt: null,
            id: { not: skill.id },
          },
          select: { id: true },
        })
        if (conflict) return { outcome: 'name_conflict' } as const

        const activeCount = await transaction.skill.count({
          where: { authorId: req.user.id, deletedAt: null },
        })
        if (activeCount >= config.SKILL_MAX_PER_USER) return { outcome: 'quota' } as const

        const restored = await transaction.skill.update({
          where: { id: skill.id },
          data: {
            deletedAt: null,
            visibility: 'private',
            marketplaceStatus: 'none',
          },
        })
        return { outcome: 'restored', skill: restored } as const
      }))
      if (result.outcome === 'not_found') return reply.notFound()
      if (result.outcome === 'forbidden') return reply.forbidden()
      if (result.outcome === 'not_deleted') return reply.conflict('Skill is not in the recycle bin')
      if (result.outcome === 'name_conflict') {
        return reply.conflict('An active Skill with the same name already exists')
      }
      if (result.outcome === 'quota') return reply.conflict('Skill account limit reached')
      return toSkillDto(result.skill)
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        return reply.conflict('An active Skill with the same name already exists')
      }
      throw error
    }
  })

  // GET /api/skills/:id/versions
  fastify.get<{ Params: { id: string }; Querystring: { teamId?: string } }>('/:id/versions', async (req, reply) => {
    const skill = await db.skill.findUnique({
      where: { id: req.params.id },
      include: { teamShares: { select: { teamId: true } } },
    })
    if (!skill || skill.deletedAt) return reply.notFound()
    if (skill.authorId !== req.user.id) {
      const allowed = await hasActiveTeamAccess(
        req.user.id,
        skill.teamShares.map((share) => share.teamId)
      )
      if (!allowed) return reply.forbidden()
    }
    const isAuthor = skill.authorId === req.user.id
    if (!isAuthor || req.query.teamId) {
      const selected = await resolveTeamVersion(req.user.id, skill.id, req.query.teamId)
      if (!selected) return reply.notFound()
      return reply.send([formalVersionDto(selected.version)])
    }
    return db.$transaction(async (tx) => (await tx.skillVersion.findMany({
      where: { skillId: req.params.id }, include: { aliases: true, card: true }, orderBy: { createdAt: 'desc' },
    })).map((version) => ({
      ...formalVersionDto(version),
      contentIdentity: versionContentIdentity(version),
      // Author-only re-check result (#251); team members never see it.
      ...(isAuthor ? { detectedUndeclared: stringArray(version.detectedUndeclared) } : {}),
    })), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  })

  // GET /api/skills/:id/package — the exact current-version package for the owner or a team member
  fastify.get<{ Params: { id: string }; Querystring: { teamId?: string } }>('/:id/package', async (req, reply) => {
    const retryAfter = consumePackageRead(req.user.id)
    if (retryAfter !== null) {
      reply.header('Retry-After', String(retryAfter))
      return reply.code(429).send({ error: 'Too many package downloads. Try again later.' })
    }
    const skill = await db.skill.findUnique({
      where: { id: req.params.id },
      include: { teamShares: { select: { teamId: true } } },
    })
    if (!skill || skill.deletedAt) return reply.notFound()
    if (skill.authorId !== req.user.id) {
      const allowed = await hasActiveTeamAccess(
        req.user.id,
        skill.teamShares.map((share) => share.teamId)
      )
      if (!allowed) return reply.forbidden()
    }
    const selected = skill.authorId !== req.user.id || req.query.teamId
      ? await resolveTeamVersion(req.user.id, skill.id, req.query.teamId) : null
    if ((skill.authorId !== req.user.id || req.query.teamId) && !selected) return reply.forbidden()
    const version = await db.skillVersion.findFirst({
      where: {
        skillId: skill.id,
        ...(selected ? { id: selected.version.id } : { version: skill.currentVersion }),
        OR: [{ packageData: { not: null } }, { cardSha256: { not: null } }],
      },
      select: { id: true, version: true, packageData: true, packageSha256: true, cardSha256: true },
    })
    const packageData = version
      ? await loadVersionPackage(version, (error) => {
        req.log.warn({
          versionId: version.id,
          error: error instanceof Error ? error.message : 'unknown card read error',
        }, 'Skill card unavailable; serving the database package copy')
      })
      : null
    if (!version || !packageData) {
      return reply.conflict('The current Skill version has no installable package; the owner must upload it again')
    }
    const cacheKey = `${version.id}:${version.packageSha256 ?? 'legacy'}`
    let packageSha256 = version.packageSha256
    if (!validatedPackages.has(cacheKey)) {
      packageSha256 = createHash('sha256').update(packageData).digest('hex')
      try {
        validateSkillPackage(packageData)
        if (version.packageSha256 && version.packageSha256 !== packageSha256) {
          throw new Error('Stored checksum does not match package bytes')
        }
        rememberValidatedPackage(cacheKey)
      } catch (error: unknown) {
        req.log.warn({
          skillId: skill.id,
          version: version.version,
          error: error instanceof Error ? error.message : 'unknown package validation error',
        }, 'Blocked an unsafe stored Skill package download')
        return reply.code(409).send({
          error: 'Stored Skill package failed safety validation; the owner must upload a new version',
        })
      }
    }
    packageSha256 ??= createHash('sha256').update(packageData).digest('hex')
    if (selected && skill.authorId !== req.user.id) {
      const recorded = await db.$transaction(async transaction => {
        await lockSkillTeamMutation(transaction, skill.id, selected.teamId)
        const current = await resolveTeamVersion(req.user.id, skill.id, selected.teamId, transaction)
        if (current?.version.id !== version.id) return false
        const acquisition = { skillId: skill.id, teamId: selected.teamId, userId: req.user.id, versionId: version.id }
        await transaction.teamSkillAcquisition.upsert({ where: { skillId_teamId_userId_versionId: acquisition }, create: acquisition, update: {} })
        if (version.cardSha256) await grantCard(transaction, req.user.id, version.cardSha256, 'team', `version:${version.id}`)
        return true
      })
      if (!recorded) return reply.conflict('Team version or access changed; refresh before downloading')
    }
    await db.skill.update({ where: { id: skill.id }, data: { installCount: { increment: 1 } } })
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', skillPackageContentDisposition(skill.name))
      .header('X-Skill-Version', version.version)
      .header('X-Skill-Version-Id', version.id)
      .header('X-Checksum-Sha256', packageSha256)
    return reply.send(packageData)
  })

  // POST /api/skills/:id/versions
  fastify.post<{ Params: { id: string }; Body: z.infer<typeof CreateVersionBody> }>(
    '/:id/versions',
    { bodyLimit: 30 * 1024 * 1024 },
    async (req, reply) => {
      const skill = await db.skill.findUnique({ where: { id: req.params.id } })
      if (!skill || skill.deletedAt) return reply.notFound()
      if (skill.authorId !== req.user.id) return reply.forbidden()
      const body = CreateVersionBody.safeParse(req.body)
      if (!body.success) return reply.badRequest(body.error.message)
      let packageFields: PackageFields
      let packageEnv: SkillPackageEnvReview | null
      try {
        ({ packageFields, env: packageEnv } = decodePackageWithEnv(
          body.data.packageBase64,
          body.data.packageSha256,
          body.data.skillMd
        ))
      } catch (error: unknown) {
        return reply.badRequest(error instanceof Error ? error.message : 'Invalid Skill package')
      }
      if (!packageFields.packageSha256) {
        return reply.badRequest('Skill package checksum is unavailable')
      }
      // The digest stays over the client request: the merged list is a pure
      // function of it, the package bytes and (when preserved) the stored list.
      const mutationDigest = versionMutationDigest(body.data, packageFields.packageSha256)
      const normalizedDependencies = body.data.envDependencies === undefined
        ? undefined
        : normalizedEnvDependencies(body.data.envDependencies)
      const preflightEnv = packageEnvOutcome(packageEnv, body.data.skillMd, normalizedDependencies, () => [])
      if (!preflightEnv.ok) return reply.badRequest(preflightEnv.message)
      const versionSelect = {
        id: true,
        sourceUrl: true,
        skillId: true,
        version: true,
        changelog: true,
        gitHash: true,
        packageSha256: true,
        packageSize: true,
        mutationDigest: true,
        detectedUndeclared: true,
        createdAt: true,
        aliases: true,
      } as const
      try {
        const existingVersion = await db.$transaction(async (tx) => {
          await lockUserMutation(tx, req.user.id)
          await lockSkillMutation(tx, req.params.id)
          const owner = await tx.skill.findUnique({ where: { id: req.params.id } })
          if (!owner || owner.deletedAt) throw new VersionPolicyError('VERSION_SOURCE_UNAVAILABLE', 'Skill unavailable', 404)
          if (owner.authorId !== req.user.id) throw new VersionPolicyError('VERSION_SOURCE_UNAVAILABLE', 'Skill belongs to another author', 403)
          return exactFormalRetry(tx, req.params.id, body.data.version, mutationDigest)
        })
        if (existingVersion) return reply.code(200).send(formalVersionDto(existingVersion))
        requireVersion(body.data.version)
      } catch (error: unknown) {
        if (error instanceof VersionPolicyError) return reply.code(error.statusCode).send({ error: error.message, code: error.code })
        throw error
      }
      const retryAfter = consumeVersionWrite(req.user.id)
      if (retryAfter !== null) {
        reply.header('Retry-After', String(retryAfter))
        return reply.code(429).send({ error: 'Too many version writes. Try again later.' })
      }
      const [versionCount, storedBytes] = await Promise.all([
        db.skillVersion.count({ where: { skillId: req.params.id } }),
        userStoredPackageBytes(req.user.id),
      ])
      if (versionCount >= config.SKILL_MAX_VERSIONS_PER_SKILL) {
        return reply.code(409).send({ error: 'Skill version limit reached', code: 'SKILL_VERSION_LIMIT_REACHED' })
      }
      if (storedBytes + (packageFields.packageSize ?? 0) > config.SKILL_MAX_STORAGE_BYTES_PER_USER) {
        return reply.code(413).send({ error: 'Skill storage quota exceeded' })
      }
      const {
        packageBase64: _packageBase64,
        packageSha256: _packageSha256,
        skillMd,
        envDependencies: _envDependencies,
        libraryVersionReceiptId,
        ...versionData
      } = body.data
      const versionSourceContent = redactSensitiveContent(skillMd).content
      const versionCard = await prepareUploadedCard(packageFields.packageData, req.log)
      try {
        const created = await withAssetWriteLock(req.user.id, async () => {
          return db.$transaction(async (transaction) => {
            // User before Skill: serializes the storage quota with library
            // author-asset publishing, which also locks the User.
            await lockUserMutation(transaction, req.user.id)
            await lockSkillMutation(transaction, req.params.id)
            const lockedSkill = await transaction.skill.findUnique({
              where: { id: req.params.id },
            })
            if (!lockedSkill || lockedSkill.deletedAt) return { outcome: 'not_found' } as const
            if (lockedSkill.authorId !== req.user.id) return { outcome: 'forbidden' } as const
            const racedVersion = await exactFormalRetry(transaction, req.params.id, body.data.version, mutationDigest)
            if (racedVersion) {
              return { outcome: 'existing', version: racedVersion } as const
            }
            const highWater = await skillHighWater(transaction, req.params.id)
            if (versionCard) await registerCard(transaction, versionCard, req.user.id)
            const reserved = libraryVersionReceiptId ? await transaction.libraryEntryVersion.findUnique({ where: { id: libraryVersionReceiptId }, include: { entry: true } }) : null
            if (libraryVersionReceiptId) {
              if (!reserved || reserved.entry.userId !== req.user.id || reserved.entry.authorSkillId !== req.params.id
                || reserved.entry.deletedAt || reserved.formalVersionId || reserved.label !== body.data.version || !versionCard
                || !await sameCardContent(transaction, reserved.cardSha256, versionCard.sha256)) {
                throw new VersionPolicyError('VERSION_LABEL_CONFLICT', 'Reserved version does not match this publication')
              }
            } else allocateVersion(highWater, body.data.version, 'manual')
            const [currentVersionCount, currentStoredBytes] = await Promise.all([
              transaction.skillVersion.count({ where: { skillId: req.params.id } }),
              userStoredPackageBytes(req.user.id, transaction),
            ])
            if (currentVersionCount >= config.SKILL_MAX_VERSIONS_PER_SKILL) {
              throw new VersionPolicyError('SKILL_VERSION_LIMIT_REACHED', 'Skill version limit reached')
            }
            if (currentStoredBytes + (packageFields.packageSize ?? 0) > config.SKILL_MAX_STORAGE_BYTES_PER_USER) {
              throw new SkillQuotaError('Skill storage quota exceeded', 413)
            }
            const lockedEnv = packageEnvOutcome(packageEnv, skillMd, normalizedDependencies, () => {
              const stored = EnvDependenciesSchema.safeParse(lockedSkill.envDependencies)
              return stored.success ? stored.data : []
            })
            if (!lockedEnv.ok) throw new SkillQuotaError(lockedEnv.message, 400)
            const envDependencies = lockedEnv.envDependencies
            const version = await transaction.skillVersion.create({
              data: {
                skillId: req.params.id,
                ...versionData,
                ...packageFields,
                ...(versionCard ? { cardSha256: versionCard.sha256 } : {}),
                mutationDigest,
                profileSnapshotVersion: 1,
                skillName: lockedSkill.name,
                displayName: lockedSkill.displayName,
                description: lockedSkill.description,
                sourceUrl: lockedSkill.sourceUrl,
                category: lockedSkill.category,
                labels: jsonArrayInput(lockedSkill.labels),
                triggerScenarios: jsonArrayInput(lockedSkill.triggerScenarios),
                compatibleAgents: jsonArrayInput(lockedSkill.compatibleAgents),
                envDependencies: envDependencies
                  ?? jsonArrayInput(lockedSkill.envDependencies),
                ...(lockedEnv.detectedUndeclared ? { detectedUndeclared: lockedEnv.detectedUndeclared } : {}),
                sourceContent: versionSourceContent,
              },
              select: versionSelect,
            })
            if (versionCard) {
              await grantCard(transaction, req.user.id, versionCard.sha256, 'authored', `version:${version.id}`)
            }
            if (reserved) {
              await transaction.libraryEntryVersion.update({ where: { id: reserved.id }, data: { formalVersionId: version.id, cardSha256: versionCard!.sha256 } })
              await transaction.libraryEntry.update({ where: { id: reserved.entryId }, data: {
                revision: { increment: 1 },
                ...(reserved.entry.currentVersionReceiptId === reserved.id ? { cardSha256: versionCard!.sha256 } : {}),
              } })
            }
            await transaction.skill.update({
              where: { id: req.params.id },
              data: {
                currentVersion: body.data.version,
                versionHighWater: Math.max(highWater, requireVersion(body.data.version)),
                sourceContent: versionSourceContent,
                ...(envDependencies ? { envDependencies } : {}),
              },
            })
            return { outcome: 'created', version } as const
          })
        })
        if (created.outcome === 'not_found') return reply.notFound()
        if (created.outcome === 'forbidden') return reply.forbidden()
        if (created.outcome === 'existing') {
          return reply.code(200).send(formalVersionDto(created.version))
        }
        return reply.code(201).send({
          ...formalVersionDto(created.version),
          // Author-only: keys the Server's package re-check found but nothing declares (#251).
          detectedUndeclared: stringArray(created.version.detectedUndeclared),
        })
      } catch (error: unknown) {
        if (error instanceof VersionPolicyError) return reply.code(error.statusCode).send({ error: error.message, code: error.code })
        if (error instanceof SkillQuotaError) {
          return reply.code(error.statusCode).send({ error: error.message })
        }
        throw error
      }
    }
  )

  // POST /api/skills/:id/shares
  fastify.post<{ Params: { id: string }; Body: { teamId: string } }>(
    '/:id/shares',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { teamId: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
      const body = ShareSkillBody.safeParse(req.body)
      if (!body.success) return reply.badRequest(body.error.message)
      const { teamId } = body.data
      const result = await db.$transaction(async (transaction) => {
        await lockUserMutation(transaction, req.user.id)
        await lockSkillTeamMutation(transaction, req.params.id, teamId)
        const skill = await transaction.skill.findUnique({ where: { id: req.params.id } })
        if (!skill || skill.deletedAt) return { outcome: 'not_found' } as const
        if (skill.authorId !== req.user.id) return { outcome: 'forbidden' } as const
        const membership = await transaction.teamMember.findUnique({
          where: { teamId_userId: { teamId, userId: req.user.id } },
          include: { team: { select: { dissolvedAt: true, name: true } } },
        })
        if (!membership) return { outcome: 'membership_required' } as const
        if (membership.team.dissolvedAt) return { outcome: 'team_dissolved' } as const
        const installableVersion = await transaction.skillVersion.findFirst({
          where: {
            skillId: skill.id,
            version: skill.currentVersion,
            OR: [{ packageData: { not: null } }, { cardSha256: { not: null } }],
          },
          select: { id: true, version: true, cardSha256: true, packageSha256: true, packageData: true },
        })
        if (!installableVersion) return { outcome: 'package_required' } as const
        const packageHash = installableVersion.cardSha256 ?? installableVersion.packageSha256
          ?? (installableVersion.packageData ? createHash('sha256').update(installableVersion.packageData).digest('hex') : null)
        if (packageHash) await requireCardAuthorship(transaction, req.user.id, packageHash)
        const existingShare = await transaction.skillTeamShare.findUnique({
          where: { skillId_teamId: { skillId: req.params.id, teamId } },
          select: { skillId: true },
        })
        const share = await transaction.skillTeamShare.upsert({
          where: { skillId_teamId: { skillId: req.params.id, teamId } },
          update: {},
          create: { skillId: req.params.id, teamId, sharedById: req.user.id, versionId: installableVersion.id },
          select: { skillId: true, teamId: true, sharedById: true, createdAt: true },
        })
        if (!existingShare) {
          await recordTeamActivity(transaction, {
            teamId,
            actorId: req.user.id,
            type: 'skill_shared',
            payload: { skillId: skill.id, skillName: skill.displayName },
          })
          await notifyTeamCredentialHoldersOfNewScope(transaction, {
            teamId,
            teamName: membership.team.name,
            skillId: skill.id,
            skillName: skill.displayName,
            envDependencies: skill.envDependencies,
          })
        }
        return { outcome: 'shared', share } as const
      })
      if (result.outcome === 'not_found') return reply.notFound()
      if (result.outcome === 'forbidden') return reply.forbidden()
      if (result.outcome === 'membership_required') {
        return reply.forbidden('Active team membership required')
      }
      if (result.outcome === 'team_dissolved') return reply.gone('Team has been dissolved')
      if (result.outcome === 'package_required') {
        return reply.conflict('Skill must have an installable package version before sharing')
      }
      return reply.code(201).send(toSkillShareDto(result.share))
    }
  )

  fastify.get<{ Params: { id: string; teamId: string } }>('/:id/shares/:teamId', async (req, reply): Promise<FastifyReply> => {
    const skill = await db.skill.findUnique({ where: { id: req.params.id } })
    if (!skill || skill.deletedAt) return reply.notFound()
    if (skill.authorId !== req.user.id) return reply.forbidden()
    const selected = await resolveTeamVersion(req.user.id, skill.id, req.params.teamId)
    if (!selected) return reply.notFound()
    const recipients = await acquiredTeamRecipients(db, skill.id, req.params.teamId, req.user.id)
    const card = selected.version.cardSha256 ? await db.skillCard.findUnique({ where: { sha256: selected.version.cardSha256 } }) : null
    return reply.send({ versionId: selected.pinnedVersionId, version: selected.version.version,
      contentIdentity: versionContentIdentity({ ...selected.version, card }),
      packageSha256: selected.version.packageSha256, recipientCount: recipients.length })
  })

  fastify.put<{ Params: { id: string; teamId: string }; Body: { versionId: string; expectedVersionId: string | null } }>(
    '/:id/shares/:teamId', async (req, reply): Promise<FastifyReply> => {
      const body = z.object({ versionId: z.string().uuid(), expectedVersionId: z.string().uuid().nullable() }).safeParse(req.body)
      if (!body.success) return reply.badRequest(body.error.message)
      const { id: skillId, teamId } = req.params
      const owner = await db.skill.findUnique({ where: { id: skillId }, select: { authorId: true, deletedAt: true } })
      if (!owner || owner.deletedAt) return reply.notFound()
      if (owner.authorId !== req.user.id) return reply.forbidden()
      const prepared = await db.skillVersion.findFirst({ where: { id: body.data.versionId, skillId },
        select: { id: true, version: true, packageData: true, cardSha256: true, packageSha256: true } })
      if (!prepared) return reply.badRequest('Version does not belong to this Skill')
      try {
        const bytes = await loadVersionPackage(prepared)
        if (!bytes) throw new Error('Package unavailable')
        validateSkillPackage(bytes)
        if (prepared.packageSha256 && createHash('sha256').update(bytes).digest('hex') !== prepared.packageSha256) throw new Error('Checksum mismatch')
      } catch { return reply.code(409).send({ code: 'TEAM_VERSION_PACKAGE_INVALID', error: 'Team version package failed validation' }) }
      const result = await db.$transaction(async transaction => {
        await lockUserMutation(transaction, req.user.id)
        await lockSkillTeamMutation(transaction, skillId, teamId)
        const skill = await transaction.skill.findUnique({ where: { id: skillId } })
        if (!skill || skill.deletedAt) return { status: 404 } as const
        if (skill.authorId !== req.user.id) return { status: 403 } as const
        const share = await transaction.skillTeamShare.findFirst({ where: { skillId, teamId,
          team: { dissolvedAt: null, members: { some: { userId: req.user.id } } } },
          select: { versionId: true, version: { select: { version: true } } } })
        if (!share) return { status: 404 } as const
        const currentVersion = { versionId: share.versionId ?? null, version: share.version?.version ?? skill.currentVersion }
        if (currentVersion.versionId !== body.data.expectedVersionId) return { status: 409, code: 'TEAM_VERSION_CHANGED', currentVersion } as const
        const version = await transaction.skillVersion.findFirst({ where: { id: prepared.id, skillId },
          select: { id: true, version: true, packageSha256: true, cardSha256: true } })
        if (!version || version.packageSha256 !== prepared.packageSha256 || version.cardSha256 !== prepared.cardSha256 || version.version !== prepared.version) return { status: 409, code: 'TEAM_VERSION_PACKAGE_CHANGED' } as const
        const ordinal = versionOrdinal(version.version)
        const currentOrdinal = versionOrdinal(currentVersion.version)
        // A legacy null pin already follows currentVersion; fixing that exact version is not a rollback.
        if (ordinal === null || currentOrdinal === null || ordinal < currentOrdinal || (share.versionId !== null && share.versionId !== undefined && ordinal === currentOrdinal)) return { status: 409, code: 'TEAM_VERSION_NOT_NEWER', currentVersion } as const
        const recipients = await acquiredTeamRecipients(transaction, skillId, teamId, req.user.id)
        await transaction.skillTeamShare.update({ where: { skillId_teamId: { skillId, teamId } }, data: { versionId: version.id } })
        const payload = { skillId, teamId, skillName: skill.displayName, version: version.version }
        await recordTeamActivity(transaction, { teamId, actorId: req.user.id, type: 'skill_version_published', payload })
        if (recipients.length) await transaction.notification.createMany({ data: recipients.map(userId => ({ userId, type: 'skill_update', payload })) })
        return { status: 200, versionId: version.id, version: version.version, recipientCount: recipients.length } as const
      })
      return reply.code(result.status).send(result.status === 200 ? result : { ...result, error: 'Unable to publish this team version' })
    })

  // DELETE /api/skills/:id/shares/:teamId
  fastify.delete<{ Params: { id: string; teamId: string } }>(
    '/:id/shares/:teamId',
    async (req, reply) => {
      // Unsharing removes the Skill from every team key's scope at once:
      // runtime resolution requires a current share. Keys stay with the team.
      const result = await db.$transaction(async (transaction) => {
        await lockSkillTeamMutation(transaction, req.params.id, req.params.teamId)
        const skill = await transaction.skill.findUnique({ where: { id: req.params.id } })
        if (!skill || skill.deletedAt) return { outcome: 'not_found' } as const
        if (skill.authorId !== req.user.id) {
          const team = await transaction.team.findUnique({
            where: { id: req.params.teamId },
            select: { ownerId: true },
          })
          if (!team || team.ownerId !== req.user.id) return { outcome: 'forbidden' } as const
        }
        const removed = await transaction.skillTeamShare.deleteMany({
          where: { skillId: req.params.id, teamId: req.params.teamId },
        })
        if (removed.count > 0) {
          const recipients = await acquiredTeamRecipients(transaction, skill.id, req.params.teamId, req.user.id)
          if (recipients.length) await transaction.notification.createMany({ data: recipients.map(userId => ({
            userId, type: 'skill_unshared', payload: { skillId: skill.id, teamId: req.params.teamId, skillName: skill.displayName },
          })) })
          await recordTeamActivity(transaction, {
            teamId: req.params.teamId,
            actorId: req.user.id,
            type: 'skill_unshared',
            payload: { skillId: skill.id, skillName: skill.displayName },
          })
        }
        return { outcome: 'deleted' } as const
      })
      if (result.outcome === 'not_found') return reply.notFound()
      if (result.outcome === 'forbidden') return reply.forbidden()
      return reply.code(204).send()
    }
  )

  // POST /api/skills/:id/analyze — AI 分析生成 Profile
  fastify.post<{ Params: { id: string }; Body: { skillMd?: string } }>(
    '/:id/analyze',
    async (req, reply) => {
      const verifiedAuthToken = req.verifiedAuthToken
      if (
        !verifiedAuthToken
        || verifiedAuthToken.sub !== req.user.id
        || !Number.isInteger(verifiedAuthToken.ver)
      ) {
        return reply.code(401).send({ error: 'Unauthorized' })
      }
      const skill = await db.skill.findUnique({ where: { id: req.params.id } })
      if (!skill || skill.deletedAt) return reply.notFound()
      if (skill.authorId !== req.user.id) return reply.forbidden()

      const body = AnalyzeSkillBody.safeParse(req.body)
      if (!body.success) return reply.badRequest(body.error.message)
      // Fail before spending AI quota when the caller already holds a stale view.
      if (!profileMatchesExpected(skill, body.data.expectedProfile)) {
        return reply.code(409).send(PROFILE_CONFLICT)
      }
      let analysis: SkillAnalysis
      try {
        analysis = await analyzeSkillWithAI(
          skill.name,
          body.data.skillMd,
          `${req.user.id}:${req.ip}`
        )
      } catch (error: unknown) {
        if (!(error instanceof AiRequestGuardError)) throw error
        reply.header('Retry-After', String(error.retryAfterSeconds))
        return reply.code(429).send({ error: error.message, code: error.code })
      }
      const sourceContent = redactSensitiveContent(body.data.skillMd).content

      const result = await db.$transaction(async (transaction) => {
        await lockUserMutation(transaction, req.user.id)
        // Authentication was first checked before the potentially slow AI
        // request. Serialize with logout/password changes and re-check the
        // exact verified token version before allowing any persisted result.
        const lockedUser = await transaction.user.findUnique({
          where: { id: req.user.id },
          select: { tokenVersion: true },
        })
        if (!lockedUser || lockedUser.tokenVersion !== verifiedAuthToken.ver) {
          return { outcome: 'unauthorized' } as const
        }
        await lockSkillMutation(transaction, req.params.id)
        const current = await transaction.skill.findUnique({ where: { id: req.params.id } })
        if (!current || current.deletedAt) return { outcome: 'not_found' } as const
        if (current.authorId !== req.user.id) return { outcome: 'forbidden' } as const
        if (!profileMatchesExpected(current, body.data.expectedProfile)) return { outcome: 'conflict' } as const
        if (analysis.source !== 'ai') {
          await transaction.skill.update({
            where: { id: req.params.id },
            data: { sourceContent },
          })
          return { outcome: 'updated', skill: current } as const
        }
        const updated = await transaction.skill.update({
          where: { id: req.params.id },
          data: {
            displayName: analysis.profile.displayName,
            description: analysis.profile.description,
            category: analysis.profile.category,
            labels: config.SKILLHUB_PROFILE === 'selfhost' && current.labelsManuallyEdited ? jsonArrayInput(current.labels) : analysis.profile.labels,
            analysisStatus: 'completed',
            triggerScenarios: analysis.profile.triggerScenarios,
            sourceContent,
          },
        })
        return { outcome: 'updated', skill: updated } as const
      })
      if (result.outcome === 'unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' })
      }
      if (result.outcome === 'not_found') return reply.notFound()
      if (result.outcome === 'forbidden') return reply.forbidden()
      if (result.outcome === 'conflict') return reply.code(409).send(PROFILE_CONFLICT)
      return { skill: await toSkillDto(result.skill), analysis: analysisResult(analysis) }
    }
  )
}
