import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { db } from '../db.js'
import { lockUserMutation } from '../lib/mutation-lock.js'
import { mirrorSkillAvatar } from '../lib/avatar-model.js'
import { mirrorAvatarJob } from '../lib/avatar-jobs.js'
import { variantsMode, selectionDisplaySelect } from '../lib/avatar-selection.js'
import { loadServerSettings } from '../lib/server-settings.js'
import { skillAvatarColumns } from '../lib/skill-avatars.js'

// Operator-only authorization: never accept this manifest from a business API.
export const ContinuationManifest = z.object({
  approval: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/#-]{0,199}$/),
  ownerId: z.string().uuid(),
  taskId: z.string().uuid(),
  oldLocalId: z.string().uuid(),
  entryId: z.string().uuid(),
  entryRevision: z.number().int().positive(),
  authorSkillId: z.string().uuid().nullable(),
  taskUpdatedAt: z.string().datetime(),
}).strict().refine(value => value.oldLocalId !== value.entryId, 'Identity is already canonical')

class ContinuationError extends Error {}
type StateSummary = { localSkillId: string | null; skillId: string | null; status: string; hasRequest: boolean; hasImage: boolean }
type ContinuationResult = { dryRun: boolean; outcome: 'eligible' | 'continued'; approval: string; taskId: string;
  entryId: string; skillId: string | null; checks: 'passed'; before: StateSummary; after: StateSummary }

/** Only stable reason codes are logged; never serialize a database/provider error message. */
export function continuationFailure(error: unknown, raw: unknown, apply: boolean): Record<string, unknown> {
  const plan = ContinuationManifest.safeParse(raw)
  return { dryRun: !apply, outcome: 'refused', checks: 'failed',
    ...(plan.success ? { approval: plan.data.approval, taskId: plan.data.taskId, entryId: plan.data.entryId, skillId: plan.data.authorSkillId } : {}),
    reason: error instanceof ContinuationError ? error.message : !plan.success ? 'INVALID_MANIFEST' : 'CONTINUATION_OPERATION_FAILED' }
}

/** Explicitly reviewed legacy mapping, with the same checks in preview and apply.
 * The approval is out-of-band evidence, not inferred from ownership or image content.
 * No generation, task creation, deletion, or conflict merging is allowed here.
 */
export async function continueLegacyAvatar(raw: unknown, apply = false): Promise<ContinuationResult> {
  const plan = ContinuationManifest.parse(raw)
  return db.$transaction(async tx => {
    await lockUserMutation(tx, plan.ownerId)
    const task = await tx.skillAvatar.findUnique({ where: { id: plan.taskId }, include: {
      currentJob: true, selection: { select: { ...selectionDisplaySelect, ownerId: true, logicalSkillId: true, currentJobId: true } },
    } })
    const entry = await tx.libraryEntry.findFirst({ where: { id: plan.entryId, userId: plan.ownerId, deletedAt: null } })
    if (!task) throw new ContinuationError('TASK_NOT_FOUND')
    if (task.ownerId !== plan.ownerId) throw new ContinuationError('TASK_OWNER_MISMATCH')
    if (task.localSkillId !== plan.oldLocalId || task.skillId !== null) throw new ContinuationError('TASK_IDENTITY_CHANGED')
    if (task.updatedAt.toISOString() !== plan.taskUpdatedAt) throw new ContinuationError('TASK_VERSION_CHANGED')
    if (task.status !== 'ready' || !task.url || !task.assetId || task.leaseToken !== null) throw new ContinuationError('TASK_NOT_READY_OR_LEASED')
    if (!entry) throw new ContinuationError('ENTRY_NOT_ACTIVE_OR_OWNED')
    if (entry.revision !== plan.entryRevision || entry.authorSkillId !== plan.authorSkillId) throw new ContinuationError('ENTRY_CHANGED')
    // An old canonical key that already names an account entry is not a local-only task.
    if (await tx.libraryEntry.findUnique({ where: { id: plan.oldLocalId } })) throw new ContinuationError('OLD_KEY_IS_LIBRARY_ENTRY')
    if (plan.authorSkillId && !await tx.skill.findFirst({ where: { id: plan.authorSkillId, authorId: plan.ownerId, deletedAt: null } })) {
      throw new ContinuationError('AUTHOR_ASSET_NOT_OWNED')
    }
    const conflicts = await tx.skillAvatar.count({ where: { id: { not: task.id }, OR: [
      { ownerId: plan.ownerId, localSkillId: plan.entryId },
      ...(plan.authorSkillId ? [{ skillId: plan.authorSkillId }] : []),
    ] } })
    const aliases = await tx.skillAvatarAlias.findMany({ where: { ownerId: plan.ownerId,
      OR: [{ aliasLocalId: { in: [plan.oldLocalId, plan.entryId] } }, { avatarId: task.id }] } })
    if (aliases.some(alias => alias.aliasLocalId === plan.entryId)) throw new ContinuationError('TARGET_KEY_ALREADY_ALIAS')
    if (conflicts || aliases.some(alias => alias.avatarId !== task.id || alias.aliasLocalId !== plan.oldLocalId)) {
      throw new ContinuationError('CONFLICTING_TASK_OR_ALIAS')
    }
    if (variantsMode()) {
      const job = task.currentJob, selection = task.selection
      if (!job || !selection) throw new ContinuationError('AVATAR_MODEL_INCOMPLETE')
      if (job.id !== task.currentJobId || job.ownerId !== plan.ownerId || job.logicalSkillId !== task.id
        || job.status !== 'ready' || job.leaseToken !== null || job.url !== task.url || job.assetId !== task.assetId || job.requestId !== task.requestId
        || selection.ownerId !== plan.ownerId || selection.logicalSkillId !== task.id || selection.currentJobId !== job.id
        || skillAvatarColumns(task).avatarStatus !== 'ready' || !skillAvatarColumns(task).avatarUrl) {
        throw new ContinuationError('AVATAR_MODEL_NOT_READY_OR_INCONSISTENT')
      }
    }
    const before: StateSummary = { localSkillId: task.localSkillId, skillId: task.skillId, status: task.status,
      hasRequest: Boolean(task.requestId), hasImage: Boolean(task.url && task.assetId) }
    const audit = { approval: plan.approval, taskId: plan.taskId, entryId: plan.entryId, skillId: plan.authorSkillId, checks: 'passed' as const, before }
    if (!apply) return { ...audit, dryRun: true, outcome: 'eligible', after: before }
    // CAS also protects against workers, which do not take the user mutation lock.
    const changed = await tx.skillAvatar.updateMany({ where: { id: task.id, updatedAt: task.updatedAt,
      ownerId: plan.ownerId, localSkillId: plan.oldLocalId, skillId: null, status: 'ready', leaseToken: null },
    data: { localSkillId: plan.entryId, skillId: plan.authorSkillId } })
    if (changed.count !== 1) throw new ContinuationError('TASK_CAS_LOST')
    if (!aliases.some(alias => alias.aliasLocalId === plan.oldLocalId)) {
      await tx.skillAvatarAlias.create({ data: { ownerId: plan.ownerId, aliasLocalId: plan.oldLocalId, avatarId: task.id } })
    }
    if (variantsMode()) await mirrorAvatarJob(tx, task.id)
    else await mirrorSkillAvatar(tx, task.id)
    if (plan.authorSkillId) await tx.skill.update({ where: { id: plan.authorSkillId }, data: skillAvatarColumns(task) })
    return { ...audit, dryRun: false, outcome: 'continued', after: { ...before, localSkillId: plan.entryId, skillId: plan.authorSkillId } }
  })
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { manifest: { type: 'string' }, apply: { type: 'boolean', default: false } } })
  let raw: unknown
  try {
    if (!values.manifest) throw new ContinuationError('MANIFEST_REQUIRED')
    try { raw = JSON.parse(await readFile(values.manifest, 'utf8')) } catch { throw new ContinuationError('MANIFEST_READ_FAILED') }
    await loadServerSettings()
    const result = await continueLegacyAvatar(raw, values.apply)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify(continuationFailure(error, raw, values.apply))}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('{"outcome":"refused","reason":"INVALID_ARGUMENTS"}\n'); process.exitCode = 1 })
    .finally(async () => { await db.$disconnect() })
}
