import { ApiError, apiAnalysisBatch, apiAnalysisSubmit, sameSpace, type AnalysisBatch } from './api.js'
import { currentSpace, type SpaceHandle } from './tauri.js'
import { instanceError } from './instance-settings.js'
import { requestLibrarySync, LIBRARY_ENTRIES_CHANGED_EVENT } from './library-sync.js'

export type InstanceAnalysisTask = {
  space: SpaceHandle; running: boolean; queued: number; skipped: number; completed: number; failed: number; error: string | null
}
let task: InstanceAnalysisTask | null = null
const listeners = new Set<() => void>()
export function subscribeInstanceAnalysis(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function instanceAnalysisTask(space: SpaceHandle): InstanceAnalysisTask | null {
  return task && sameSpace(task.space, space) ? task : null
}

/** The confirmed selection survives settings navigation; the captured session gates every paid submission. */
export async function startInstanceAnalysis(groups: string[][], space: SpaceHandle,
  notify: (message: string) => void): Promise<void> {
  if (instanceAnalysisTask(space)?.running) return
  const owner = { ...space }
  const totals = { queued: 0, skipped: 0, completed: 0, failed: 0 }
  const publish = (batch: Partial<AnalysisBatch>, running: boolean, error: string | null = null): void => {
    if (task && task.space !== owner) return
    task = { space: owner, running, error, queued: totals.queued + (batch.queued ?? 0), skipped: totals.skipped + (batch.skipped ?? 0),
      completed: totals.completed + (batch.completed ?? 0), failed: totals.failed + (batch.failed ?? 0) }
    listeners.forEach(listener => listener())
  }
  task = null
  publish({}, true)
  try {
    for (const group of groups) {
      if (!sameSpace(await currentSpace(), owner)) throw new ApiError('aborted', 'Space changed')
      let batch = await apiAnalysisSubmit(group, owner)
      publish(batch, true)
      while (batch.state === 'queued' || batch.state === 'running') {
        await new Promise<void>(resolve => setTimeout(resolve, 1200))
        batch = await apiAnalysisBatch(batch.batchId, owner)
        publish(batch, true)
      }
      totals.queued += batch.queued; totals.skipped += batch.skipped; totals.completed += batch.completed; totals.failed += batch.failed
      if (batch.state === 'cancelled') break
    }
    publish({}, false)
    if (sameSpace(await currentSpace(), owner)) {
      notify(`重新分析完成：已排队 ${totals.queued}，跳过 ${totals.skipped}，成功 ${totals.completed}，失败 ${totals.failed}`)
      requestLibrarySync()
      window.dispatchEvent(new Event(LIBRARY_ENTRIES_CHANGED_EVENT))
    }
  } catch (error: unknown) {
    const current = instanceAnalysisTask(owner)
    if (current?.space === owner) {
      task = { ...current, running: false, error: instanceError(error) }
      listeners.forEach(listener => listener())
    }
  }
}
