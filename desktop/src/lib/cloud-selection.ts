export type CloudSelection = { ids: string[]; anchor: string | null; focus: string | null }
export const emptyCloudSelection: CloudSelection = { ids: [], anchor: null, focus: null }

export function cloudSelectionId(skill: { id: string; libraryEntryId?: string | null }): string {
  return skill.libraryEntryId ? `library:${skill.libraryEntryId}` : skill.id
}

export function selectCloudRow(state: CloudSelection, visible: readonly string[], id: string,
  modifiers: { range?: boolean; additive?: boolean; context?: boolean } = {}): CloudSelection {
  if (!visible.includes(id)) return state
  if (modifiers.context) return { ids: state.ids.includes(id) ? state.ids : [id], anchor: state.ids.includes(id) ? state.anchor : id, focus: id }
  const anchor = state.anchor && visible.includes(state.anchor) ? state.anchor : id
  if (modifiers.range) {
    const [start, end] = [visible.indexOf(anchor), visible.indexOf(id)].sort((a, b) => a - b)
    const range = visible.slice(start, end + 1)
    return { ids: modifiers.additive ? [...new Set([...state.ids, ...range])] : range, anchor, focus: id }
  }
  return { ids: modifiers.additive ? state.ids.includes(id) ? state.ids.filter(key => key !== id) : [...state.ids, id] : [id], anchor: id, focus: id }
}

export function retainCloudSelection(state: CloudSelection, visible: readonly string[]): CloudSelection {
  const ids = state.ids.filter(id => visible.includes(id))
  const anchor = state.anchor && visible.includes(state.anchor) ? state.anchor : null
  const focus = state.focus && visible.includes(state.focus) ? state.focus : null
  return ids.length === state.ids.length && anchor === state.anchor && focus === state.focus ? state : { ids, anchor, focus }
}

export function focusCloudRow(state: CloudSelection, visible: readonly string[], id: string): CloudSelection {
  return visible.includes(id) ? { ...state, focus: id } : state
}

type AccountSkill = { catalogOrigin?: string; isSystem?: boolean; localPath: string; isOwn: boolean; hasWorkingCopy?: boolean; cloudDownload?: unknown; libraryAccountId?: string | null; libraryEntryId?: string | null; serverOwnerId?: string; acquisitionSource?: string }
export function cloudOperationReason(skill: AccountSkill, accountId: string | null, action: 'share' | 'delete', syncEnabled: boolean, online: boolean): string | null {
  if (skill.isSystem) return '系统组件不可操作'
  if (!accountId || skill.libraryAccountId !== accountId || !skill.libraryEntryId) return '尚未关联当前账号'
  if (!syncEnabled) return '账号同步暂不可用'
  if (!online) return '需要联网'
  if (action === 'delete') return null
  if (!skill.localPath || skill.cloudDownload) return '下载尚未完成'
  if (skill.catalogOrigin || !skill.isOwn || (skill.serverOwnerId && skill.serverOwnerId !== accountId)) return '当前账号不拥有作者权限'
  if (skill.hasWorkingCopy) return '存在未保存的内容修改，请先处理'
  if ((skill.acquisitionSource === 'marketplace' || skill.acquisitionSource === 'team') && !skill.serverOwnerId) return '来源未经作者授权'
  return null
}

export type BatchResult = { id: string; name: string; kind: 'done' | 'local-pending' | 'kept' | 'failed' | 'unconfirmed' | 'skipped' | 'ineligible' | 'stopped'; message: string }
export function isRetryableCloudBatchResult(result: Pick<BatchResult, 'kind'>): boolean {
  return result.kind === 'failed' || result.kind === 'kept'
}

export async function runCloudBatch<T>(items: readonly T[], sessionMatches: () => boolean,
  execute: (item: T) => Promise<BatchResult>, describe: (item: T) => { id: string; name: string },
  report: (result: BatchResult) => void): Promise<void> {
  for (const item of items) {
    let result: BatchResult
    if (!sessionMatches()) result = { ...describe(item), kind: 'stopped', message: '批次已停止，未发起此项操作' }
    else {
      try { result = await execute(item) }
      catch {
        result = sessionMatches()
          ? { ...describe(item), kind: 'unconfirmed', message: '操作异常，结果尚未确认；请先读回核验' }
          : { ...describe(item), kind: 'stopped', message: '批次已停止，原账号操作结果需重新核验' }
      }
    }
    report(result)
  }
}
