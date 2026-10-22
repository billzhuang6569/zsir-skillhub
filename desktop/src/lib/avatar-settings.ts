import type { AvatarStyle, AvatarStyleApply, AvatarStylePreview, AvatarStyleResult, AvatarStyleSelection, InstanceSource } from './api.js'

export type FalForm = { apiKey: string; draftToken: string | null; expiresAt: number }
export const falForm = (apiKey = ''): FalForm => ({ apiKey, draftToken: null, expiresAt: 0 })
export function canSaveFal(form: FalForm, source: InstanceSource, busy: boolean, now = Date.now()): boolean {
  return source !== 'env' && !busy && Boolean(form.draftToken) && now < form.expiresAt
}
export function falError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null
  switch (code) {
    case 'FAL_KEY_INVALID': return 'Key 无效或已被撤销'
    case 'FAL_UNREACHABLE': return '无法连接 fal.ai，请检查服务器网络'
    case 'TEST_REQUIRED': return '配置已变化或测试已过期，请重新测试后保存。'
    case 'ENV_OVERRIDE': return '由服务器环境变量配置，修改请编辑服务器配置。'
    default: return '操作失败，请检查连接后重试。'
  }
}
export function styleGallery(styles: AvatarStyle[], currentId: string, expanded: boolean, columns = 6): { visible: AvatarStyle[]; total: number; canExpand: boolean } {
  const published = styles.filter(style => style.status === 'published')
  const visible = expanded ? published : published.slice(0, columns)
  const currentIndex = published.findIndex(style => style.styleId === currentId)
  if (!expanded && currentIndex >= columns) visible[columns - 1] = published[currentIndex]
  return { visible, total: published.length, canExpand: published.length > columns }
}
export function canManageAvatarStyle(selection: AvatarStyleSelection | null, selfhost: boolean, admin: boolean): boolean {
  return Boolean(selection?.canManage && (!selfhost || admin))
}
export function styleUnavailable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'status' in error && error.status === 404)
}
export function styleConfirmation(preview: AvatarStylePreview): { label: string; value: string }[] {
  return [
    { label: '可复用', value: `${preview.reusable} 个` },
    { label: '需生成', value: `${preview.needsGeneration} 个` },
    { label: '预计费用', value: preview.needsGeneration === 0 ? '无需生成，不产生费用'
      : preview.estimatedCostUsd === null ? '以 fal.ai 实际计费为准' : `约 $${preview.estimatedCostUsd.toFixed(2)}，以 fal.ai 实际计费为准` },
    { label: '跳过的自定义头像', value: `${preview.customSkipped} 个` },
    { label: '今日剩余额度', value: `${preview.quota.remaining}/${preview.quota.limit}` },
    ...(preview.inFlight ? [{ label: '进行中', value: `${preview.inFlight} 个` }] : []),
  ]
}
export function styleApplyInput(styleId: string, mode: AvatarStyleApply['mode'], includeCustom: boolean): AvatarStyleApply {
  return { styleId, mode, includeCustom: mode === 'applyExisting' && includeCustom }
}
export function styleResultMessage(result: AvatarStyleResult): string {
  return `风格已切换：复用 ${result.reused}，新建 ${result.queued}，跳过 ${result.skippedCustom}，因额度未排队 ${result.deferredByQuota}，已取消的未提交任务 ${result.cancelledUnsubmitted}`
}
