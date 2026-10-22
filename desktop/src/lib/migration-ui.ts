import type { MigrationItemChoice, MigrationKeyChoice, MigrationStatus, SpaceHandle } from './tauri.js'
import type { SpaceCommitChoice } from './spaces.js'

export function migrationCommitChoice(again: boolean): SpaceCommitChoice { return again ? '取消' : '迁移并切换' }

export type MigrationItem = MigrationStatus['items'][number]
const REASONS: Record<string, string> = {
  READY: '可以迁移', name_exists: '目标账号已有同名 Skill', USER_SKIPPED: '已选择跳过',
  OPERATION_RECORDED: '已处理，无需重复迁移', TEAM_SHARED_NOT_COPYABLE: '团队共享不支持复制',
  SOURCE_PACKAGE_UNAVAILABLE: '原服务器上没有可安装的包', PENDING_DELTA: '快照之后原账号中的修改未迁移',
  SOURCE_VERSION_UNAVAILABLE: '源 Skill 的版本不可用', SOURCE_COMMITTED_PACKAGE_UNAVAILABLE: '尚无可迁移的已提交版本',
  SOURCE_STORE_ID_MISSING: '缺少商店来源信息',
  AVATAR_STYLE_UNAVAILABLE: '头像风格不可用，已跳过', AVATAR_SELECTION_SKIPPED: '原选中的头像不可用',
  SKILL_LIMIT: '超出目标 Skill 数量上限', SKILL_RECORD_LIMIT: '超出目标记录上限（含回收站）',
  STORAGE_LIMIT: '超出目标存储上限', PACKAGE_TOO_LARGE: '内容包过大', AVATAR_TOO_LARGE: '头像文件过大',
  CATALOG_REACQUIRED: '已从商店重新取得', TARGET_CATALOG_VERSION_CONFLICT: '目标已安装其他版本',
  TARGET_LIBRARY_CONFLICT: '目标库中已有不同内容', MIGRATION_NAME_CONFLICT: '目标账号已有同名 Skill',
  MIGRATION_TARGET_NOT_FOUND: '映射的 Skill 不存在或不可访问',
  MIGRATION_PAYLOAD_MISMATCH: '内容与已记录操作不一致，请重新发起迁移',
  MIGRATION_CONTENT_INVALID: '内容包校验未通过', MIGRATION_ENV_INVALID: '钥匙声明校验未通过',
  MIGRATION_HASH_MISMATCH: '文件校验未通过', MIGRATION_RATE_LIMIT: '请求较多，等待后继续',
  MIGRATION_UNAVAILABLE: '服务器暂不可用', MIGRATION_MEDIA_UNAVAILABLE: '图片存储暂不可用',
  MIGRATION_LIBRARY_SYNC_REQUIRED: '等待 Skill 下载后再继续复制钥匙',
  MIGRATION_RETRY_REQUIRED: '迁移未完成，请继续重试',
  MIGRATION_ORGANIZER_RETRY: '目标快捷访问仍在变化，请稍后继续',
  MIGRATION_INTERRUPTED: '上次迁移被中断，请继续',
  MIGRATION_TARGET_VAULT_NOT_READY: '目标钥匙库尚未就绪，请重新登录后继续',
  MIGRATION_CANCELLED: '已取消，保留已成功部分', MIGRATION_BUSY: '已有迁移正在处理，请稍后再试',
  MIGRATION_SAME_IDENTITY: '来源和目标是同一个账号', MIGRATION_INVALID_CONTEXT: '切换状态已变化，请重新连接',
  MIGRATION_FINALIZED_START_NEW: '这次迁移已完成，请重新发起',
  HTTP_401: '原账号登录已失效', HTTP_403: '原账号登录已失效',
  MIGRATION_SESSION_CHANGED: '切换状态已变化', MIGRATION_NETWORK: '无法连接原服务器',
  MIGRATION_INVALID_RESPONSE: '原服务器返回的条目格式不正确',
  MIGRATION_INVALID_PROFILE: 'Skill 资料格式不正确', MIGRATION_INVALID_PACKAGE: '内容包格式不正确',
  MIGRATION_PACKAGE_TOO_LARGE: '内容包过大', MIGRATION_RESPONSE_TOO_LARGE: '原服务器返回的内容过大',
  MIGRATION_SOURCE_ID_INVALID: '源 Skill 标识不正确', MIGRATION_SOURCE_CHANGED: '读取时本机内容发生了变化',
  MIGRATION_LOCAL_PACKAGE_FAILED: '本机文件夹无法打包', CATALOG_UNAVAILABLE: '商店暂不可用',
  CATALOG_PACKAGE_UNAVAILABLE: '商店内容包不可用', AVATAR_SKIPPED: '头像不可用，已跳过',
  MIGRATION_DISK_WRITE: '无法写入本机迁移文件', MIGRATION_STAGING_INVALID: '本机暂存文件校验未通过',
  MIGRATION_CREDENTIAL_DESTINATION: '凭据目的地校验未通过', MIGRATION_ROUTE_DENIED: '迁移请求不在允许范围内',
}
export function migrationReason(reason: string): string {
  if (!reason) return ''
  return reason.split(',').map(code => REASONS[code]
    ?? (/^HTTP_\d{3}$/.test(code) ? `原服务器请求失败（${code}）`
      : /^[A-Z][A-Z0-9_]+$/.test(code) ? `迁移未完成，请重试（${code}）` : '未能处理，请重试或重新发起迁移')).join('；')
}
export function migrationSnapshotError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const legacyErrors: Record<string, string> = {
    'SkillHub 空间或账号已切换，本次请求结果已丢弃': 'MIGRATION_SESSION_CHANGED',
    '无法连接服务器，请检查地址与网络': 'MIGRATION_NETWORK',
    '证书不受信任': 'MIGRATION_NETWORK', '证书已过期': 'MIGRATION_NETWORK',
    '域名不匹配': 'MIGRATION_NETWORK', '无法验证服务器证书': 'MIGRATION_NETWORK',
  }
  const code = legacyErrors[message] ?? (/^[A-Z][A-Z0-9_]+$/.test(message) ? message : 'MIGRATION_UNKNOWN')
  // Native errors are already user-facing Chinese text; showing them beats an opaque code.
  if (code === 'MIGRATION_UNKNOWN' && message.trim()) return `未能读取迁移内容：${message.trim().slice(0, 120)}。请重试或取消。`
  const reason = migrationReason(code)
  return `未能读取迁移内容（${reason === code ? code : `${reason} · ${code}`}），请重试或取消。`
}
export function migrationAvatarSkipped(item: MigrationItem): number {
  return item.warnings.filter(code => code === 'AVATAR_SKIPPED').length
    + item.avatars.filter(avatar => avatar.status === 'skipped').length
}
export function migrationResultReason(item: MigrationItem): string {
  return ['imported', 'mapped'].includes(item.state) ? '' : migrationReason(item.reason || item.precheck?.reason || '')
}
export function migrationCategory(item: MigrationItem): string {
  if (item.category === 'team') return '团队共享 · 跳过'
  if (item.category === 'reacquire') return '商店 · 重新取得'
  if (item.category === 'store_copy') return `商店 · 个人副本（${item.storeState === 'delisted' ? '已下架' : '已非当前版本'}）`
  return '自己的 Skill'
}
export function migrationGroup(item: MigrationItem): string {
  return item.category === 'team' ? '团队共享' : ['store_copy', 'reacquire', 'marketplace', 'catalog'].includes(item.category) ? '商店安装' : '自己的 Skill'
}
export function migrationCounts(status: MigrationStatus) {
  return {
    ready: status.items.filter(item => item.state === 'pending' && (!item.precheck || item.precheck.status === 'ok')).length,
    skipped: status.items.filter(item => item.state === 'skipped' || item.precheck?.status === 'skip').length,
    conflicts: status.items.filter(item => item.precheck?.status === 'conflict' || item.state === 'awaitingChoice' && item.precheck?.status !== 'over_quota').length,
    overQuota: status.items.filter(item => item.precheck?.status === 'over_quota').length,
    pendingDelta: status.items.filter(item => item.pendingDelta).length,
    imported: status.items.filter(item => item.state === 'imported').length,
    mapped: status.items.filter(item => item.state === 'mapped').length,
    failed: status.items.filter(item => item.state === 'failed').length,
    done: status.items.filter(item => ['imported', 'mapped', 'skipped', 'failed'].includes(item.state)).length,
  }
}
export function defaultMigrationChoices(status: MigrationStatus): MigrationItemChoice[] {
  return status.items.filter(item => !['imported', 'mapped', 'failed', 'submitting', 'skipped'].includes(item.state))
    .map(item => ({ id: item.id, action: item.state === 'skipped' || item.precheck && item.precheck.status !== 'ok' ? 'skip' : 'copy' }))
}
export function copyName(name: string): string { return `${name.slice(0, 126)}-2` }
export function migrationChoiceError(choice: MigrationItemChoice, item: MigrationItem): string | null {
  if (choice.action === 'copy' && choice.targetName !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(choice.targetName)) {
    return '名称须为 1–128 个英文、数字、点、下划线或短横线，并以英文或数字开头'
  }
  if (choice.action === 'map' && (!item.precheck?.existingSkillId || choice.mapToSkillId !== item.precheck.existingSkillId)) return '没有可映射的已有 Skill'
  return null
}
export function migrationKeys(enabled: boolean, selected: MigrationKeyChoice[]): MigrationKeyChoice[] { return enabled ? selected : [] }
export function migrationKeyError(keys: MigrationKeyChoice[]): string | null {
  const destinations = new Set<string>()
  for (const key of keys) {
    const name = key.conflict.action === 'rename' ? key.conflict.name : key.name
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(name)) return '钥匙名称须以大写字母开头，只含大写字母、数字或下划线，最多 100 字符'
    if (destinations.has(name)) return '目标钥匙名称不能重复'
    destinations.add(name)
  }
  return null
}
export function unfinishedMigration(status: MigrationStatus): boolean {
  return !['completed', 'cancelled', 'snapshotFailed', 'snapshotting'].includes(status.state)
}
export type MigrationProgress = { localMigrationId: string; state: string; space?: SpaceHandle; userId?: string }
export function acceptsMigrationProgress(event: MigrationProgress, space: SpaceHandle | null, userId: string | undefined, pending: boolean): boolean {
  return !pending && !!space && !!userId && event.space?.spaceId === space.spaceId
    && event.space.generation === space.generation && event.userId === userId
}
export function migrationSummary(status: MigrationStatus): string {
  const count = migrationCounts(status)
  return `导入 ${count.imported} · 映射 ${count.mapped} · 跳过 ${count.skipped} · 失败 ${count.failed}`
}
export function migrationState(state: string): string {
  return ({ pending: '待迁移', ready: '待开始', running: '正在迁移', submitting: '正在提交', imported: '已导入', mapped: '已映射',
    skipped: '已跳过', failed: '失败', completed: '已完成', paused: '已暂停', awaitingChoice: '待确认',
    cancelled: '已取消', snapshotting: '正在读取', snapshotFailed: '快照未完成，请重新发起' } as Record<string, string>)[state] ?? '待处理'
}
