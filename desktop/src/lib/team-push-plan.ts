import type { ApiSkillVersion } from './api.js'
import type { SkillPackage, SkillVersionState } from './tauri.js'
import { skillVersionOrdinal, suggestNextSkillVersion } from './versioning.ts'

export function matchesPushContent(remote: Pick<ApiSkillVersion, 'packageSha256' | 'contentIdentity'>, pack: SkillPackage): boolean {
  return remote.packageSha256 === pack.sha256 || Boolean(remote.contentIdentity
    && remote.contentIdentity.contentHash === pack.contentHash
    && JSON.stringify(remote.contentIdentity.executablePaths) === JSON.stringify(pack.executablePaths))
}

export function teamPushPlan(versions: ApiSkillVersion[], pack: SkillPackage, state: SkillVersionState, currentVersion: string, teamVersionId: string | null, saved: boolean) {
  const matching = versions.filter(item => matchesPushContent(item, pack))
  const existing = matching.find(item => item.id === teamVersionId)
    ?? matching.sort((a, b) => (skillVersionOrdinal(b.version) ?? -1) - (skillVersionOrdinal(a.version) ?? -1))[0]
  const receipt = state.currentReceipt
  const reserved = saved && !state.pending && receipt && !receipt.formalVersionId ? receipt : null
  return { existing, receiptId: existing ? undefined : reserved?.receiptId,
    version: existing?.version ?? (state.pending ? null : reserved?.label ?? suggestNextSkillVersion(currentVersion, versions.flatMap(item => [item.version, ...(item.aliases ?? [])]), state.highWater)) }
}

export function teamPushError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (/VERSION_SOURCE_UNAVAILABLE|Formal version is not available/.test(message)) return '正式版本与账号内容尚未对齐。请先完成账号同步，再重新打开推送窗口。'
  if (/VERSION_.*CONFLICT|VERSION_LABEL/.test(message)) return '版本记录已变化。请刷新 Skill 后重新确认版本号。'
  if (/SKILL_VERSION_LIMIT|VERSION_RANGE_EXHAUSTED/.test(message)) return '版本名额已用尽，请先整理版本记录。'
  if (/^[\u4e00-\u9fff]/.test(message) && !/[A-Z]{3,}_/.test(message)) return message
  return '推送未完成。请检查网络、登录状态和团队权限，重新打开窗口核对后重试。'
}
