// Wires the background 「从账号删除」 job (#360) to the store, the Tauri
// bridge and toasts. The batch dialog calls `startAccountDeleteBatch` and
// closes; rows show a processing state, leave with an animation once their
// account copy is gone, and one toast reports anything that needs attention.
import { useStore, type LocalSkill } from '../store/index.js'
import { readAuthSpace } from '../store/index.js'
import { libraryDeleteFromAccount } from './tauri.js'
import { cloudOperationReason, cloudSelectionId, type BatchResult } from './cloud-selection.js'
import { accountDeleteResult, LIBRARY_ENTRIES_CHANGED_EVENT, requestLibrarySync } from './library-sync.js'
import { userMessage } from './user-message.js'
import { toast } from '../components/Toast.js'
import { runAccountDeleteJob, summarizeAccountDelete } from './account-delete-job.js'

/** Deletes one account copy; the result kinds match the old dialog's. */
async function deleteOneFromAccount(original: LocalSkill, accountId: string): Promise<BatchResult> {
  const id = cloudSelectionId(original)
  const skill = useStore.getState().skills.find((item) => cloudSelectionId(item) === id) ?? original
  const base = { id, name: original.displayName }
  const blocked = cloudOperationReason(skill, accountId, 'delete', useStore.getState().librarySyncEnabled, navigator.onLine)
  if (blocked) return { ...base, kind: 'failed', message: blocked }
  try {
    const outcome = await libraryDeleteFromAccount(skill.localPath ? skill.marketplaceLocalId ?? skill.id : null, accountId, skill.libraryEntryId ?? undefined)
    const result = accountDeleteResult(skill.displayName, outcome)
    return { ...base, kind: result.kind, message: result.message }
  } catch (error: unknown) {
    return { ...base, kind: 'unconfirmed', message: `账号结果尚未确认：${userMessage(error)}；保留本机副本，先同步核验` }
  }
}

/**
 * Starts the batch for the signed-in account and returns at once. Rows of
 * `skills` that are not deletable (per `cloudOperationReason`) are reported
 * in the final toast instead of being attempted.
 */
export function startAccountDeleteBatch(skills: readonly LocalSkill[]): void {
  const accountId = useStore.getState().currentUser?.id ?? null
  const space = readAuthSpace()
  if (!accountId || !space) return
  const sessionMatches = (): boolean => useStore.getState().currentUser?.id === accountId && readAuthSpace() === space
  const targets = skills.filter((skill) => !skill.isSystem)
  const ids = targets.map(cloudSelectionId)
  void runAccountDeleteJob<LocalSkill>({
    targets,
    idOf: cloudSelectionId,
    nameOf: (skill) => skill.displayName,
    canContinue: sessionMatches,
    execute: (skill) => deleteOneFromAccount(skill, accountId),
    onPending: (ids) => useStore.getState().markAccountDeletePending(ids),
    onLeaving: (id) => useStore.getState().markAccountDeleteLeaving(id),
    onSettled: (id, removed) => useStore.getState().settleAccountDelete(id, removed && sessionMatches()),
  }).then((results) => {
    const summary = summarizeAccountDelete(results)
    if (summary) toast(summary.message, summary.kind)
  }).catch((error: unknown) => {
    toast(`从账号删除时出错：${userMessage(error)}`, 'error')
  }).finally(() => {
    // The list refresh and the sync pass run once the rows have left, so the
    // leave animation is never cut short by an early reload (#360 review).
    const state = useStore.getState()
    for (const id of ids) if (state.accountDeletes.pending[id] || state.accountDeletes.leaving[id]) state.settleAccountDelete(id, false)
    window.dispatchEvent(new Event(LIBRARY_ENTRIES_CHANGED_EVENT))
    if (sessionMatches()) requestLibrarySync()
  })
}
