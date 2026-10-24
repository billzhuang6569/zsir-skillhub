import type { LocalSkill, SkillVersion } from '../store/index.js'
import type { ApiSkillVersion } from './api.js'

export function skillVersionDisplay(skill: Pick<LocalSkill, 'version' | 'localPath' | 'cloudDownload' | 'versionProblem'>): { label: string; problem: string | null } {
  const waitingForDownload = Boolean(skill.cloudDownload && !skill.localPath)
  return {
    label: skill.version || (waitingForDownload ? '版本待获取' : '版本待核对'),
    problem: skill.versionProblem || (!skill.version && !waitingForDownload ? '版本信息尚未确认，请刷新后重试或核对本机历史' : null),
  }
}

export function skillVersionOrdinal(value: string): number | null {
  return /^[0-9]\.[0-9]\.[0-9]$/.test(value) ? Number(value.replace(/\./g, '')) : null
}

export function latestFormalForPackage<T extends Pick<ApiSkillVersion, 'id' | 'version' | 'packageSha256'>>(versions: readonly T[], sha256: string): T | null {
  const latest = [...versions].sort((a, b) => (skillVersionOrdinal(b.version) ?? -1) - (skillVersionOrdinal(a.version) ?? -1))[0]
  return latest?.packageSha256 === sha256 ? latest : null
}

export function skillVersionExists(version: string, knownVersions: string[]): boolean {
  return skillVersionOrdinal(version) !== null && knownVersions.includes(version)
}

/** highWater comes from Rust's complete history, never just the visible rows. */
export function suggestNextSkillVersion(currentVersion: string, knownVersions: string[] = [], highWater = -1): string | null {
  const maximum = Math.max(highWater, ...[currentVersion, ...knownVersions].map(value => skillVersionOrdinal(value) ?? -1))
  if (maximum >= 999) return null
  return String(maximum < 0 ? 10 : maximum + 1).padStart(3, '0').split('').join('.')
}

export function skillVersionInputError(version: string, highWater: number, reserved: readonly string[] = []): string | null {
  if (highWater >= 999) return '版本范围已用尽（9.9.9），不能覆盖或循环使用旧版本'
  const ordinal = skillVersionOrdinal(version)
  if (ordinal === null) return '版本号须为三段单个数字，例如 0.1.1；不接受 v、字母或后缀'
  if (ordinal <= highWater || reserved.includes(version)) return '新版本必须高于所有历史版本，且不能使用已保留的编号'
  return null
}

export function skillSnapshotSuggestedVersion(state: { nextVersion: string | null; pendingLabel?: string | null }): string {
  return state.pendingLabel ?? state.nextVersion ?? ''
}

/** Keep the modal's original suggestion stable even if a later read advances the high water. */
export function skillSnapshotAllocation(version: string, suggestedVersion: string | null): 'auto' | 'manual' {
  return version === suggestedVersion ? 'auto' : 'manual'
}

export function skillSnapshotInputError(version: string, highWater: number, allocation: 'auto' | 'manual', pendingLabel?: string | null): string | null {
  if (allocation === 'manual') return skillVersionInputError(version, highWater)
  if (skillVersionOrdinal(version) === null) return skillVersionInputError(version, -1)
  if (highWater >= 999 && version !== pendingLabel) return skillVersionInputError(version, highWater)
  // Auto is allocated again under the native lock; a stale suggestion is not a manual reservation.
  return null
}

export function mergeSkillVersionHistory(localVersions: SkillVersion[], remoteVersions: ApiSkillVersion[], currentFormalId?: string) {
  const linkedLocalIndices = new Set<number>()
  return [
    ...remoteVersions.map((remote) => {
      const localIndex = localVersions.findIndex((item) => item.formalVersionId === remote.id)
      const local = localIndex >= 0 ? localVersions[localIndex] : undefined
      if (local) linkedLocalIndices.add(localIndex)
      return {
        key: remote.id,
        version: local?.version || remote.version,
        formalLabel: local?.formalLabel,
        versionStatus: local?.versionStatus,
        isCurrent: local?.isCurrent ?? currentFormalId === remote.id,
        remoteVersion: remote,
        changelog: local?.changelog ?? remote.changelog ?? undefined,
        gitHash: local?.gitHash,
        receiptId: local?.receiptId,
        packageSha256: remote.packageSha256 ?? undefined,
        remote: true,
        date: local?.date ?? new Date(remote.createdAt).toLocaleDateString('zh-CN'),
        localIndex: local ? localIndex : undefined,
      }
    }),
    ...localVersions.flatMap((local, localIndex) => linkedLocalIndices.has(localIndex) ? [] : [{
      key: local.receiptId ?? local.gitHash ?? `local-${local.version}-${localIndex}`,
      version: local.version,
      formalLabel: local.formalLabel,
      versionStatus: local.versionStatus,
      isCurrent: local.isCurrent === true,
      remoteVersion: undefined,
      changelog: local.changelog,
      gitHash: local.gitHash,
      receiptId: local.receiptId,
      packageSha256: undefined,
      remote: false,
      date: local.date,
      localIndex,
    }]),
  ]
}
