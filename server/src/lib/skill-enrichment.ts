import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { Prisma, type SkillEnrichment } from '@prisma/client'
import { db } from '../db.js'
import { config } from '../config.js'
import { aiStatus } from './ai-settings.js'
import { avatarGenerationEnabled } from './avatar-generation.js'
import { avatarDto, type AvatarDisplay, AvatarError, ensureEnrichmentAvatar } from './skill-avatars.js'
import { selectionDisplaySelect } from './avatar-selection.js'
import { analyzeSkillWithAI } from '../routes/skills.js'
import { AiRequestGuardError } from '../utils/ai-request-guard.js'
import { lockUserMutation, lockSkillMutation } from './mutation-lock.js'

export const ENRICHMENT_INTERVAL_MS = 30_000
const BATCH_SIZE = 10
const MAX_ATTEMPTS = 5
const CONFIG_RETRY_MS = 60 * 60_000
const includeAvatar = { avatar: { include: { selection: { select: selectionDisplaySelect } } } } as const
const hasImage = (skill: { avatarUrl: string | null; avatar: AvatarDisplay | null }): boolean =>
  Boolean(skill.avatarUrl || (skill.avatar && (skill.avatar.source === 'custom' || avatarDto(skill.avatar).avatarUrl)))

/** All creation paths (including future ones) enter through the same bounded compensation scan. */
export async function scanSkillEnrichment(): Promise<void> {
  if (!aiStatus().configured && !avatarGenerationEnabled()) return
  if (aiStatus().configured && config.AI_MAX_CONCURRENT >= 2) {
    const waiting = await db.skillEnrichment.findMany({ where: { phase: 'done', awaitingAnalysis: true,
      nextAttemptAt: { lte: new Date() }, skill: { analysisStatus: 'unanalysed', deletedAt: null } },
    take: BATCH_SIZE, orderBy: { nextAttemptAt: 'asc' } })
    if (waiting.length) await db.skillEnrichment.updateMany({ where: { skillId: { in: waiting.map(row => row.skillId) },
      phase: 'done', awaitingAnalysis: true }, data: { phase: 'analysis', nextAttemptAt: new Date() } })
  }
  const skills = await db.skill.findMany({ where: { deletedAt: null, analysisStatus: 'unanalysed',
    avatarUrl: null, enrichment: null }, orderBy: { id: 'asc' }, take: BATCH_SIZE, select: { id: true } })
  if (skills.length) await db.skillEnrichment.createMany({
    data: skills.map(skill => ({ skillId: skill.id, phase: 'analysis' })), skipDuplicates: true,
  })
}

export async function runSkillEnrichment(job: SkillEnrichment, logger?: FastifyBaseLogger): Promise<void> {
  let attempts = job.attempts
  const finish = async (data: Prisma.SkillEnrichmentUpdateManyMutationInput): Promise<void> => {
    await db.skillEnrichment.updateMany({ where: { skillId: job.skillId, leaseToken: job.leaseToken },
      data: { ...data, leaseToken: null, leaseUntil: null } })
  }
  const reserveAttempt = async (): Promise<boolean> => {
    if (attempts >= MAX_ATTEMPTS) { await finish({ phase: 'failed' }); return false }
    const reserved = await db.skillEnrichment.updateMany({ where: { skillId: job.skillId, leaseToken: job.leaseToken,
      attempts: { lt: MAX_ATTEMPTS }, leaseUntil: { gt: new Date() } }, data: { attempts: { increment: 1 } } })
    if (!reserved.count) return false
    attempts += 1
    return true
  }
  const protectedImage = (skill: Parameters<typeof hasImage>[0]): boolean =>
    Boolean(skill.avatar && (skill.avatar.source === 'custom' || avatarDto(skill.avatar).avatarSource === 'custom'))
      || (hasImage(skill) && !(job.phase === 'analysis' && job.awaitingAnalysis))
  try {
    const skill = await db.skill.findUnique({ where: { id: job.skillId }, include: includeAvatar })
    if (!skill || skill.deletedAt || protectedImage(skill)
      || (job.phase === 'analysis' && skill.analysisStatus !== 'unanalysed')) {
      await finish({ phase: 'done', awaitingAnalysis: false }); return
    }
    if (job.phase === 'analysis') {
      if (!aiStatus().configured || config.AI_MAX_CONCURRENT < 2) {
        // Missing configuration is not a failure; local-AI leases remain eligible.
        await finish({ ...(avatarGenerationEnabled() ? { phase: 'avatar', awaitingAnalysis: true } : {}),
          nextAttemptAt: new Date(Date.now() + (avatarGenerationEnabled() ? 0 : CONFIG_RETRY_MS)) }); return
      }
      if (skill.profileManuallyEdited) {
        await finish({ phase: 'avatar', attempts: 0, awaitingAnalysis: false, nextAttemptAt: new Date() }); return
      }
      if (!skill.sourceContent) {
        // /skills can create metadata before /versions supplies the author's source.
        await finish({ nextAttemptAt: new Date(Date.now() + CONFIG_RETRY_MS) }); return
      }
      if (!await reserveAttempt()) return
      const analysis = await analyzeSkillWithAI(skill.name, skill.sourceContent, skill.authorId, undefined, 'background')
      if (analysis.source !== 'ai') throw new Error('ANALYSIS_UNAVAILABLE')
      await db.$transaction(async transaction => {
        await lockUserMutation(transaction, skill.authorId)
        await lockSkillMutation(transaction, skill.id)
        // Lock the claimed row before touching Skill; an expired worker cannot commit over a new lease.
        const owned = await transaction.skillEnrichment.updateMany({ where: { skillId: job.skillId, leaseToken: job.leaseToken,
          leaseUntil: { gt: new Date() } }, data: { leaseUntil: new Date(Date.now() + 60_000) } })
        if (!owned.count) return
        const current = await transaction.skill.findUnique({ where: { id: skill.id }, include: includeAvatar })
        if (!current || current.deletedAt || protectedImage(current) || current.analysisStatus !== 'unanalysed') {
          await transaction.skillEnrichment.update({ where: { skillId: skill.id }, data: { phase: 'done', awaitingAnalysis: false, leaseToken: null, leaseUntil: null } })
          return
        }
        const updated = await transaction.skill.updateMany({ where: { id: skill.id, authorId: skill.authorId,
          deletedAt: null, name: skill.name, sourceContent: skill.sourceContent,
          displayName: skill.displayName, description: skill.description, category: skill.category,
          triggerScenarios: { equals: skill.triggerScenarios ?? Prisma.DbNull }, labels: { equals: skill.labels ?? Prisma.DbNull },
          labelsManuallyEdited: skill.labelsManuallyEdited, analysisStatus: 'unanalysed', profileManuallyEdited: false },
        data: { ...analysis.profile, ...(skill.labelsManuallyEdited ? { labels: skill.labels ?? Prisma.JsonNull } : {}), analysisStatus: 'completed' } })
        await transaction.skillEnrichment.update({ where: { skillId: skill.id }, data: {
          phase: updated.count ? 'avatar' : attempts >= MAX_ATTEMPTS ? 'failed' : 'analysis',
          attempts: updated.count ? 0 : attempts, awaitingAnalysis: updated.count ? false : job.awaitingAnalysis,
          errorCode: updated.count ? null : 'PROFILE_CHANGED', nextAttemptAt: new Date(), leaseToken: null, leaseUntil: null,
        } })
      })
      return
    }
    if (!avatarGenerationEnabled()) {
      await finish({ nextAttemptAt: new Date(Date.now() + CONFIG_RETRY_MS) }); return
    }
    if (!await reserveAttempt()) return
    await ensureEnrichmentAvatar(skill.authorId, skill.id)
    await finish({ phase: 'done', attempts: 0, errorCode: null, nextAttemptAt: new Date(Date.now() + CONFIG_RETRY_MS) })
  } catch (error: unknown) {
    const conflict = error instanceof AvatarError && error.code === 'AVATAR_IDENTITY_CONFLICT'
    const waiting = error instanceof AiRequestGuardError || (error instanceof AvatarError && [429, 503].includes(error.statusCode))
    if (waiting || conflict) attempts = job.attempts
    const errorCode = error instanceof AiRequestGuardError || error instanceof AvatarError ? error.code : 'ENRICHMENT_FAILED'
    logger?.warn({ skillId: job.skillId, errorCode }, 'Skill enrichment deferred')
    const delay = waiting ? Math.max(ENRICHMENT_INTERVAL_MS, (error.retryAfterSeconds ?? 30) * 1000)
      : Math.min(30 * 60_000, ENRICHMENT_INTERVAL_MS * 2 ** attempts)
    await finish({ attempts, errorCode, phase: conflict ? 'parked' : attempts >= MAX_ATTEMPTS ? 'failed' : job.phase, nextAttemptAt: new Date(Date.now() + delay) })
  }
}

export async function enrichmentCycle(stopped: () => boolean = () => false, logger?: FastifyBaseLogger): Promise<void> {
  if (!aiStatus().configured && !avatarGenerationEnabled()) return
  await scanSkillEnrichment()
  const phases = ['analysis', ...(avatarGenerationEnabled() ? ['avatar'] : [])]
  const now = new Date()
  const due = { phase: { in: phases }, nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }
  const jobs = await db.skillEnrichment.findMany({ where: due, orderBy: { nextAttemptAt: 'asc' }, take: BATCH_SIZE })
  for (const job of jobs) {
    if (stopped()) break
    const leaseToken = randomUUID()
    const leaseUntil = new Date(Date.now() + Math.max(180_000, config.AI_TIMEOUT_MS + 60_000))
    const claimed = await db.skillEnrichment.updateMany({ where: { skillId: job.skillId, ...due, phase: job.phase }, data: { leaseToken, leaseUntil } })
    if (claimed.count) await runSkillEnrichment({ ...job, leaseToken, leaseUntil }, logger)
  }
}

/** One serial lane per process; durable CAS leases coordinate other processes and survive restarts. */
export function startSkillEnrichmentWorker(logger: FastifyBaseLogger): () => Promise<void> {
  let stopped = false
  let active: Promise<void> | null = null
  const tick = (): void => {
    if (stopped || active) return
    active = enrichmentCycle(() => stopped, logger).catch(() => { logger.warn('Skill enrichment cycle deferred') }).finally(() => { active = null })
  }
  const timer = setInterval(tick, ENRICHMENT_INTERVAL_MS)
  timer.unref()
  tick()
  return async (): Promise<void> => { stopped = true; clearInterval(timer); await active }
}
