// 设置 · 钥匙相关的两行（#289 board 10）：「以后不再询问」开关与「钥匙备份文件」。
// 纯函数与文案，便于 node:test 覆盖；界面在 SettingsPage。
import type { EnvBackupSummary } from './tauri.js'

export const SETTINGS_KEY_COPY = {
  autoAllowTitle: '以后不再询问，有能用的就用',
  autoAllowDescription: '开启后，商店或团队来源的 Skill 使用你的钥匙时不再弹窗确认。你的钥匙仍只给声明了它的 Skill。',
  autoAllowSignedOut: '登录后可以设置。',
  backupDescription: '导入 Skill 时自动生成的钥匙文件，以及所有备份。可删除。',
  backupEmpty: '没有备份文件',
  backupDelete: '删除',
  backupDeleted: (removed: number): string => `已删除 ${removed} 份钥匙备份文件`,
  backupConfirmDescription: '钥匙库里的钥匙不受影响，此操作不可恢复。',
} as const

/** 「1.2 KB」: binary units, one decimal under 10. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unit]}`
}

/** 「钥匙备份文件 · 3 份 · 12 KB」, or the bare title while nothing is known. */
export function envBackupTitle(summary: Pick<EnvBackupSummary, 'count' | 'bytes'> | null): string {
  if (!summary || summary.count === 0) return '钥匙备份文件'
  return `钥匙备份文件 · ${summary.count} 份 · ${formatBytes(summary.bytes)}`
}

export function envBackupConfirmTitle(count: number): string {
  return `删除 ${count} 份钥匙备份文件？`
}

/** 「在访达中显示」 on macOS, 「在文件管理器中显示」 on Windows, 「打开文件夹」 elsewhere. */
export function revealFolderLabel(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  if (/Windows/i.test(userAgent)) return '在文件管理器中显示'
  if (/Mac/i.test(userAgent)) return '在访达中显示'
  return '打开文件夹'
}
