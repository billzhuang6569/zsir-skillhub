// Background 「从账号删除」 batch (#360): the dialog only confirms; this job
// runs the deletions, lets the list animate each removed row out, and
// reports once at the end. No React or Tauri imports, so it is unit-testable.
import type { BatchResult } from './cloud-selection.js'

/** How long a removed row stays mounted for its leave animation (`--motion-base` 200ms plus a frame of slack). */
export const ACCOUNT_DELETE_LEAVE_MS = 240

export type AccountDeleteJobOptions<T> = {
  targets: readonly T[]
  idOf: (target: T) => string
  nameOf: (target: T) => string
  /** Deletes one Skill; never throws (an unknown outcome is an `unconfirmed` result). */
  execute: (target: T) => Promise<BatchResult>
  /** False once the account changed or the APP is closing; remaining targets become `stopped`. */
  canContinue: () => boolean
  /** The rows that are about to be deleted (processing state, no further actions). */
  onPending: (ids: string[]) => void
  /** A row whose account copy is gone starts its leave animation. */
  onLeaving: (id: string) => void
  /** Called after the leave animation (or at once for rows that stay): the row leaves the pending state and, when `removed`, the list. */
  onSettled: (id: string, removed: boolean) => void
  leaveMs?: number
  wait?: (ms: number) => Promise<void>
}

const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Deletes sequentially (same ordering guarantee as the old dialog) while leave
 * animations overlap with the next deletion. Resolves with every result once
 * the last animation finished, so callers can toast a complete summary.
 */
export async function runAccountDeleteJob<T>(options: AccountDeleteJobOptions<T>): Promise<BatchResult[]> {
  const leaveMs = options.leaveMs ?? ACCOUNT_DELETE_LEAVE_MS
  const wait = options.wait ?? defaultWait
  const ids = options.targets.map(options.idOf)
  options.onPending(ids)
  const results: BatchResult[] = []
  const leaving: Promise<void>[] = []
  for (const target of options.targets) {
    const id = options.idOf(target)
    if (!options.canContinue()) {
      results.push({ id, name: options.nameOf(target), kind: 'stopped', message: '账号已切换，未执行' })
      options.onSettled(id, false)
      continue
    }
    let result: BatchResult
    try {
      result = await options.execute(target)
    } catch (error: unknown) {
      result = { id, name: options.nameOf(target), kind: 'unconfirmed', message: error instanceof Error ? error.message : String(error) }
    }
    results.push(result)
    if (result.kind === 'done') {
      options.onLeaving(id)
      leaving.push(wait(leaveMs).then(() => options.onSettled(id, true)))
    } else {
      options.onSettled(id, false)
    }
  }
  await Promise.all(leaving)
  return results
}

export type AccountDeleteSummary = { message: string; kind: 'default' | 'warn' | 'error' } | null

/**
 * One toast for the whole batch. Success is quiet (the rows already left);
 * anything the user must act on names the first Skill and its reason.
 */
export function summarizeAccountDelete(results: readonly BatchResult[]): AccountDeleteSummary {
  const done = results.filter((result) => result.kind === 'done')
  const pending = results.filter((result) => result.kind === 'unconfirmed' || result.kind === 'local-pending')
  const failed = results.filter((result) => result.kind === 'failed' || result.kind === 'kept' || result.kind === 'ineligible')
  const stopped = results.filter((result) => result.kind === 'stopped')
  if (failed.length > 0) {
    const first = failed[0]
    const rest = failed.length - 1
    return {
      kind: 'error',
      message: `${failed.length} 个未能从账号删除：「${first.name}」${first.message}${rest > 0 ? `，其余 ${rest} 个可重新选择后重试` : ''}${done.length > 0 ? `；已删除 ${done.length} 个` : ''}`,
    }
  }
  if (pending.length > 0) {
    return { kind: 'warn', message: `${pending.length} 个的账号结果待同步确认，稍后会自动核对${done.length > 0 ? `；已删除 ${done.length} 个` : ''}` }
  }
  if (stopped.length > 0) {
    return { kind: 'warn', message: `账号已切换，${stopped.length} 个未执行${done.length > 0 ? `；已删除 ${done.length} 个` : ''}` }
  }
  if (done.length > 0) return { kind: 'default', message: done.length === 1 ? `已从账号删除「${done[0].name}」` : `已从账号删除 ${done.length} 个 Skill` }
  return null
}
