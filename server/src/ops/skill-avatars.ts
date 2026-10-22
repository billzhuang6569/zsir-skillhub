import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import Fastify from 'fastify'
import { avatarGenerationEnabled } from '../lib/avatar-generation.js'
import { loadServerSettings } from '../lib/server-settings.js'
import { config } from '../config.js'
import { db } from '../db.js'
import { AvatarError, avatarQuotaToday, avatarStage, ensureSkillAvatar, retryFailedAvatar, retryTarget, runAvatarWorkerOnce } from '../lib/skill-avatars.js'
import { findSubmittedFalAvatar, FalError } from '../lib/fal.js'
import { mirrorSkillAvatar } from '../lib/avatar-model.js'
import { verifyAvatarModel } from '../lib/avatar-model-verification.js'
import { variantsMode } from '../lib/avatar-selection.js'
import { mirrorAvatarJob, retryAvatarJob } from '../lib/avatar-jobs.js'
import { lockUserMutation } from '../lib/mutation-lock.js'
import type { Prisma, AvatarGenerationJob } from '@prisma/client'

type Operation = { mode: 'report' | 'backfill' | 'reconcile' | 'work' | 'inspect' | 'retry' | 'verify-model'; apply: boolean;
  limit: number; task?: string; imageMicroUsd: number | null; budgetMicroUsd: number | null
  /** retry (#246): explicit `--task` ids (repeatable), or every failed task with `--all-failed`. */
  tasks?: string[]; allFailed?: boolean; images?: boolean; reportPath?: string }

function microUsd(value: string | undefined): number | null {
  if (value === undefined) return null
  if (!/^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/.test(value)) throw new Error('Invalid USD amount')
  return Math.round(Number(value) * 1_000_000)
}

export function parseAvatarOperation(args: string[]): Operation {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    apply: { type: 'boolean', default: false }, limit: { type: 'string', default: '20' },
    task: { type: 'string', multiple: true }, 'all-failed': { type: 'boolean', default: false },
    'image-usd': { type: 'string' }, 'max-image-usd': { type: 'string' },
    images: { type: 'boolean', default: false }, report: { type: 'string' },
  } })
  const mode = z.enum(['report', 'backfill', 'reconcile', 'work', 'inspect', 'retry', 'verify-model']).parse(positionals[0] ?? 'report')
  if (positionals.length > 1 || !/^[1-9]\d{0,2}$/.test(values.limit)) throw new Error('Invalid operation or limit')
  const limit = z.number().int().min(1).max(200).parse(Number(values.limit))
  const tasks = (values.task ?? []).map(value => z.string().uuid().parse(value))
  const allFailed = values['all-failed']
  if (mode === 'verify-model') {
    if (values.apply || allFailed || tasks.length || values['image-usd'] || values['max-image-usd']) throw new Error('verify-model is read-only')
    return { mode, apply: false, limit, imageMicroUsd: null, budgetMicroUsd: null, images: values.images, reportPath: values.report }
  }
  if (values.images || values.report) throw new Error('--images and --report are only for verify-model')
  if (mode === 'retry') {
    // Paid redraws go through the #221 ledger and its daily quota, not an image budget.
    if ((tasks.length > 0) === allFailed) throw new Error('retry requires --task <id> (repeatable) or --all-failed')
    if (new Set(tasks).size !== tasks.length || tasks.length > 200) throw new Error('Invalid --task list')
    return { mode, apply: values.apply, limit, imageMicroUsd: null, budgetMicroUsd: null, tasks, allFailed }
  }
  if (allFailed) throw new Error('--all-failed is only for retry')
  if (tasks.length > 1) throw new Error('--task may be repeated only for retry')
  const task = tasks[0]
  if ((mode === 'reconcile' || mode === 'inspect') && !task) throw new Error(`${mode} requires --task`)
  if (task && mode !== 'reconcile' && mode !== 'inspect') throw new Error('--task is only for reconciliation or inspection')
  if (values.apply && (mode === 'report' || mode === 'inspect')) throw new Error('Report and inspect are always read-only')
  const imageMicroUsd = microUsd(values['image-usd']), budgetMicroUsd = microUsd(values['max-image-usd'])
  if (values.apply && (mode === 'backfill' || mode === 'work')
    && (!imageMicroUsd || budgetMicroUsd === null)) throw new Error('Apply requires current --image-usd and --max-image-usd')
  return { mode, apply: values.apply, limit, task, imageMicroUsd, budgetMicroUsd }
}

export function checkAvatarBudget(count: number, operation: Operation): number | null {
  const cost = operation.imageMicroUsd === null ? null : count * operation.imageMicroUsd
  if (operation.apply && (cost === null || operation.budgetMicroUsd === null || cost > operation.budgetMicroUsd)) {
    throw new Error('Batch exceeds the image budget')
  }
  return cost === null ? null : cost / 1_000_000
}

export async function avatarCoverage(): Promise<Record<string, number | Record<string, number>>> {
  const active = { deletedAt: null }
  const [total, excluded, missing, states, local, errors] = await Promise.all([
    db.skill.count({ where: active }), db.skill.count({ where: { deletedAt: { not: null } } }),
    db.skill.count({ where: { ...active, avatar: { is: null } } }),
    variantsMode() ? db.avatarGenerationJob.groupBy({ by: ['status'], _count: { _all: true } })
      : db.skillAvatar.groupBy({ by: ['status'], where: { skill: { is: active } }, _count: { _all: true } }),
    db.skillAvatar.count({ where: { skillId: null, localSkillId: { not: null } } }),
    // Error classes across every non-ready task (cloud and local-only): which stage/mechanism is failing.
    variantsMode() ? db.avatarGenerationJob.groupBy({ by: ['errorCode'], where: { status: { not: 'ready' }, errorCode: { not: null } }, _count: { _all: true } })
      : db.skillAvatar.groupBy({ by: ['errorCode'], where: { status: { not: 'ready' }, errorCode: { not: null } }, _count: { _all: true } }),
  ])
  const result: Record<string, number | Record<string, number>> = { activeCloudSkills: total, recycleBinExcluded: excluded, missing,
    ready: 0, failed: 0, needs_review: 0, pending: 0, registeredLocalOnly: local }
  for (const state of states) {
    const key = ['ready', 'failed', 'needs_review'].includes(state.status) ? state.status : 'pending'
    result[key] = (result[key] as number) + state._count._all
  }
  const errorCodes: Record<string, number> = {}
  for (const row of errors ?? []) if (row.errorCode) errorCodes[row.errorCode] = row._count._all
  result.errorCodes = errorCodes
  if (variantsMode()) result.identities = await db.skillAvatar.count()
  return result
}

/**
 * Read-only view of one task for support: status, error class and stage,
 * attempt count, next attempt, and whether a provider request / image / asset
 * exists. Never the prompt, the input, URLs, the owner or Skill identity.
 */
export async function inspectAvatar(taskId: string): Promise<Record<string, unknown>> {
  const task = variantsMode() ? await readJob(taskId) : await db.skillAvatar.findUnique({ where: { id: taskId }, select: {
    status: true, errorCode: true, attempts: true, nextAttemptAt: true, submittedAt: true,
    createdAt: true, updatedAt: true, promptVersion: true, leaseUntil: true,
    requestId: true, imageUrl: true, imageData: true, assetId: true, url: true, skillId: true, localSkillId: true, prompt: true,
  } })
  if (!task) return { found: false }
  const active = ['queued', 'drafting', 'prompting', 'submitting', 'awaiting', 'transferring'].includes(task.status)
  return {
    found: true, status: task.status, stage: active ? avatarStage(task.status) : null,
    errorCode: task.errorCode ?? 'unknown', attempts: task.attempts,
    nextAttemptAt: active ? task.nextAttemptAt.toISOString() : null,
    leasedUntil: task.leaseUntil?.toISOString() ?? null,
    submittedAt: task.submittedAt?.toISOString() ?? null,
    hasPrompt: Boolean(task.prompt), hasRequestId: Boolean(task.requestId),
    hasImage: Boolean(task.imageUrl || task.imageData), hasAsset: Boolean(task.assetId && task.url),
    boundToCloudSkill: Boolean(task.skillId), registeredLocally: Boolean(task.localSkillId),
    promptVersion: task.promptVersion, createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString(),
  }
}

async function readJob(id: string): Promise<(AvatarGenerationJob & { isCurrent: boolean; skillId: string | null; localSkillId: string | null; source: string }) | null> {
  const job = await db.avatarGenerationJob.findUnique({ where: { id }, include: { anchor: { select: { currentJobId: true, skillId: true, localSkillId: true, selection: { select: { source: true } } } } } })
  return job ? { ...job, isCurrent: job.anchor.currentJobId === job.id, skillId: job.anchor.skillId, localSkillId: job.anchor.localSkillId, source: job.anchor.selection?.source ?? 'generated' } : null
}

export async function reconcileAvatar(taskId: string, apply: boolean): Promise<string> {
  if (variantsMode()) return reconcileJob(taskId, apply)
  const task = await db.skillAvatar.findUnique({ where: { id: taskId } })
  if (!task || task.status !== 'needs_review' || task.requestId || !task.prompt || !task.submittedAt) return 'not_reconcilable'
  const submittedAt = task.submittedAt
  const requestId = await findSubmittedFalAvatar(task.prompt, submittedAt)
  if (!requestId) return 'unresolved'
  return db.$transaction(async (transaction): Promise<string> => {
    if (apply) await transaction.$queryRaw`SELECT pg_advisory_xact_lock(71382655)::text`
    const overlap = await transaction.skillAvatar.count({ where: { id: { not: taskId }, prompt: task.prompt,
      status: { in: ['submitting', 'needs_review'] }, submittedAt: {
        gte: new Date(submittedAt.getTime() - 150_000), lte: new Date(submittedAt.getTime() + 150_000),
      } } })
    if (overlap || await transaction.skillAvatar.findUnique({ where: { requestId } })) return 'ambiguous_or_claimed'
    if (!apply) return 'unique_provider_request'
    const changed = await transaction.skillAvatar.updateMany({ where: {
      id: taskId, status: 'needs_review', requestId: null, leaseToken: null,
    }, data: { requestId, status: 'awaiting', errorCode: null, attempts: 0, nextAttemptAt: new Date() } })
    if (changed.count !== 1) return 'state_changed'
    await mirrorSkillAvatar(transaction, taskId)
    if (task.skillId) await transaction.skill.updateMany({ where: { id: task.skillId, deletedAt: null }, data: { avatarStatus: 'pending' } })
    return 'reconciled'
  })
}

async function reconcileJob(taskId: string, apply: boolean): Promise<string> {
  const task = await db.avatarGenerationJob.findUnique({ where: { id: taskId } })
  if (!task || task.status !== 'needs_review' || task.requestId || !task.prompt || !task.submittedAt) return 'not_reconcilable'
  const submittedAt = task.submittedAt
  const requestId = await findSubmittedFalAvatar(task.prompt, submittedAt, { model: task.falModel, parameters: task.falParameters as Record<string, Prisma.JsonValue> })
  if (!requestId) return 'unresolved'
  return db.$transaction(async tx => {
    if (apply) {
      await lockUserMutation(tx, task.ownerId)
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(71382655)::text`
    }
    const overlap = await tx.avatarGenerationJob.count({ where: { id: { not: taskId }, prompt: task.prompt,
      falModel: task.falModel, submittedAt: { gte: new Date(submittedAt.getTime() - 150_000), lte: new Date(submittedAt.getTime() + 150_000) } } })
    if (overlap || await tx.avatarGenerationJob.findUnique({ where: { requestId } })) return 'ambiguous_or_claimed'
    if (!apply) return 'unique_provider_request'
    const changed = await tx.avatarGenerationJob.updateMany({ where: { id: taskId, status: 'needs_review', requestId: null, leaseToken: null },
      data: { requestId, status: 'awaiting', attempts: 0, errorCode: null, nextAttemptAt: new Date() } })
    if (changed.count !== 1) return 'state_changed'
    await mirrorAvatarJob(tx, task.logicalSkillId)
    return 'reconciled'
  })
}

export type RetryOutcome = 'would_retry' | 'retried' | 'unchanged' | 'not_found' | 'not_failed' | 'needs_review' | 'custom_active' | 'quota_full'
export type RetryRow = { task: string; status: string | null; target: 'queued' | 'awaiting' | 'transferring' | null; chargesAttempt: boolean; outcome: RetryOutcome }

/**
 * 重新生成 for support (#246), through the product's own `retryFailedAvatar` (the path behind
 * `POST /api/skill-avatars/local/:id/retry`), so the rules are the same: only an unclaimed
 * `failed` task moves, to `transferring` / `awaiting` (free) or `queued` (one `retry` row in
 * the #221 ledger); `needs_review` and a shown custom image are refused like the route; a full
 * day is 429 with the task unchanged; `Skill.avatarStatus` follows; a re-run is a no-op.
 * Without `--apply` nothing is written. Output: task ids, statuses and quota numbers only.
 */
export async function retryAvatars(operation: Operation): Promise<Record<string, unknown>> {
  if (operation.apply && !avatarGenerationEnabled()) throw new AvatarError(503, '头像生成暂未开启', 'AVATAR_GENERATION_DISABLED')
  const select = { id: true, ownerId: true, status: true, source: true, leaseToken: true, requestId: true, imageUrl: true, imageData: true } as const
  const ids = operation.allFailed
    ? (await (variantsMode()
      ? db.avatarGenerationJob.findMany({ where: { status: 'failed', OR: [
        { currentFor: { isNot: null } },
        { OR: [{ assetId: { not: null }, url: { not: null } }, { imageData: { not: null } }, { imageUrl: { not: null } }, { requestId: { not: null } }] },
      ] }, select: { id: true }, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: operation.limit })
      : db.skillAvatar.findMany({ where: { status: 'failed' }, select: { id: true }, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: operation.limit }))).map(row => row.id)
    : operation.tasks ?? []
  const quotaBefore = await avatarQuotaToday()
  const rows: RetryRow[] = []
  for (const id of ids) {
    const task = variantsMode() ? await readJob(id) : await db.skillAvatar.findUnique({ where: { id }, select })
    if (!task) { rows.push({ task: id, status: null, target: null, chargesAttempt: false, outcome: 'not_found' }); continue }
    let target = retryTarget(task)
    if (variantsMode() && 'isCurrent' in task && 'logicalSkillId' in task && typeof task.logicalSkillId === 'string'
      && 'styleId' in task && typeof task.styleId === 'string') {
      if ((!task.isCurrent && target === 'queued') || await db.avatarGenerationJob.count({ where: { logicalSkillId: task.logicalSkillId, styleId: task.styleId,
        id: { not: id }, status: { in: ['queued', 'drafting', 'prompting', 'submitting', 'awaiting', 'transferring', 'needs_review'] } } })) target = null
    }
    const row: RetryRow = { task: id, status: task.status, target, chargesAttempt: target === 'queued', outcome: 'would_retry' }
    if (task.source === 'custom') row.outcome = 'custom_active'
    else if (task.status === 'needs_review') row.outcome = 'needs_review'
    else if (task.status !== 'failed') row.outcome = 'not_failed'
    else if (!target) row.outcome = 'unchanged' // claimed by a worker right now
    if (row.outcome !== 'would_retry') { rows.push({ ...row, target: null, chargesAttempt: false }); continue }
    if (operation.apply) {
      try { row.outcome = (await (variantsMode() ? retryAvatarJob(task.ownerId, id, true) : retryFailedAvatar(task.ownerId, id))).transitioned ? 'retried' : 'unchanged' }
      catch (error: unknown) {
        if (!(error instanceof AvatarError && error.code === 'AVATAR_DAILY_QUOTA')) throw error
        row.outcome = 'quota_full'
      }
      if (row.outcome !== 'retried') { row.target = null; row.chargesAttempt = false }
    }
    rows.push(row)
  }
  const wouldCharge = rows.filter(row => row.chargesAttempt).length
  return { dryRun: !operation.apply, generationEnabled: avatarGenerationEnabled(), selected: ids.length,
    quotaToday: quotaBefore, ...(operation.apply ? { quotaAfter: await avatarQuotaToday() } : { paidAttemptsIfApplied: wouldCharge }), tasks: rows }
}

export async function runAvatarOperation(operation: Operation): Promise<Record<string, unknown>> {
  if (operation.mode === 'verify-model') return verifyAvatarModel({ images: operation.images, reportPath: operation.reportPath })
  if (operation.mode === 'retry') return retryAvatars(operation)
  const coverage = await avatarCoverage()
  if (operation.mode === 'report') return { ...coverage, dryRun: true, generationEnabled: avatarGenerationEnabled() }
  if (operation.mode === 'inspect') return { dryRun: true, task: await inspectAvatar(operation.task!) }
  if (operation.mode === 'reconcile') return { ...coverage, dryRun: !operation.apply,
    reconciliation: await reconcileAvatar(operation.task!, operation.apply), additionalImageCostUsd: 0 }
  if (operation.mode === 'work') {
    const estimatedImageCostUsd = checkAvatarBudget(operation.limit, operation)
    if (operation.apply) {
      if (!avatarGenerationEnabled()) throw new AvatarError(503, '头像生成暂未开启')
      const server = Fastify({ logger: true })
      try { for (let step = 0; step < operation.limit; step += 1) await runAvatarWorkerOnce(server.log) }
      finally { await server.close() }
    }
    return { ...await avatarCoverage(), dryRun: !operation.apply, steps: operation.limit, estimatedImageCostUsd,
      excludesLlmAndPicem: true }
  }
  const selected = await db.skill.findMany({ where: { deletedAt: null, avatar: { is: null } },
    select: { id: true, authorId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: operation.limit })
  const estimatedImageCostUsd = checkAvatarBudget(selected.length, operation)
  let queued = 0, deferred = 0
  if (operation.apply) {
    for (const skill of selected) {
      try { await ensureSkillAvatar({ ownerId: skill.authorId, skillId: skill.id }); queued += 1 }
      catch (error: unknown) { if (error instanceof AvatarError && [404, 429, 503].includes(error.statusCode)) deferred += 1; else throw error }
    }
  }
  return { ...coverage, dryRun: !operation.apply, selected: selected.length, queued, deferred, estimatedImageCostUsd,
    excludesLlmAndPicem: true, coverageAfter: operation.apply ? await avatarCoverage() : undefined }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const operation = parseAvatarOperation(process.argv.slice(2))
    if (config.SKILLHUB_PROFILE === 'selfhost') await loadServerSettings()
    const result = await runAvatarOperation(operation)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (operation.mode === 'verify-model' && (result.counts as Record<string, number>).mismatches > 0) process.exitCode = 1
  }
  catch (error: unknown) {
    // Never print provider bodies, prompts, owner identities or connection details.
    process.stderr.write(`${error instanceof FalError ? error.code : 'Skill avatar operation failed; inspect arguments and protected server configuration'}\n`)
    process.exitCode = 1
  } finally { await db.$disconnect() }
}
