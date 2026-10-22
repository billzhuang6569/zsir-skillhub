export type OwnedServerSkill = {
  localPath?: string
  serverId?: string
  serverOwnerId?: string
  catalogOrigin?: string
  accountSyncRequired?: boolean
}

export type TeamShareJob = {
  id: string
  teamId: string
  action: 'share' | 'unshare'
}

export type ShareVersionReceipt = { serverId: string; version: string; packageSha256: string; changelog: string; gitHash?: string }
export class SharePreparationUnknown extends Error {
  readonly receipt: ShareVersionReceipt
  constructor(message: string, receipt: ShareVersionReceipt) { super(message); this.receipt = receipt }
}

/** Public version fields cannot confirm the environment snapshot or full mutation. */
export function shareVersionReadbackUnknown(receipt: ShareVersionReceipt, versions: readonly {
  version: string; packageSha256?: string | null; changelog?: string | null; gitHash?: string | null
}[]): SharePreparationUnknown {
  const observed = versions.some(item => item.version === receipt.version && item.packageSha256 === receipt.packageSha256
    && item.changelog === receipt.changelog && (item.gitHash ?? undefined) === receipt.gitHash)
  return new SharePreparationUnknown(observed ? '观察到同版本及内容包，但完整版本请求尚未核验；未继续共享' : '版本上传结果仍需完整核验；未继续共享', receipt)
}

export function startTeamShareJob(
  jobs: Readonly<Record<string, TeamShareJob>>,
  skillId: string,
  job: TeamShareJob,
): Record<string, TeamShareJob> {
  return { ...jobs, [skillId]: job }
}

export function finishTeamShareJob(
  jobs: Readonly<Record<string, TeamShareJob>>,
  skillId: string,
  jobId: string,
): Record<string, TeamShareJob> {
  if (jobs[skillId]?.id !== jobId) return jobs
  const next = { ...jobs }
  delete next[skillId]
  return next
}

export function currentOwnedServerSkillId(
  skill: OwnedServerSkill,
  currentUserId: string,
): string | undefined {
  if (skill.accountSyncRequired || skill.catalogOrigin) return undefined
  if (skill.serverOwnerId !== currentUserId) return undefined
  return skill.serverId
}

export async function ensureCurrentAccountServerSkill<T extends OwnedServerSkill>(input: {
  skill: T
  currentUserId: string
  sync: () => Promise<T | null>
}): Promise<{ skill: T; serverId: string }> {
  if (input.skill.catalogOrigin) throw new Error('官方商店 Skill 不拥有作者权限')
  let ownedSkill = input.skill
  let serverId = currentOwnedServerSkillId(ownedSkill, input.currentUserId)

  if (!serverId) {
    const synced = await input.sync()
    if (!synced) throw new Error('当前 Skill 尚未完成账号同步')
    ownedSkill = synced
    serverId = currentOwnedServerSkillId(ownedSkill, input.currentUserId)
  }

  if (!serverId) throw new Error('当前 Skill 的云端归属与登录账号不一致')
  return { skill: ownedSkill, serverId }
}

export async function shareSkillWithServerSync<T extends OwnedServerSkill>(input: {
  skill: T
  currentUserId: string
  teamId: string
  sync: () => Promise<T | null>
  share: (serverId: string, teamId: string) => Promise<void>
}): Promise<T> {
  const { skill: shareable, serverId } = await ensureCurrentAccountServerSkill(input)
  await input.share(serverId, input.teamId)
  return shareable
}

/** Publish a saved local version before sharing, without inventing a version label. */
export async function prepareAccountSkillForShare<T extends OwnedServerSkill & { version: string; hasWorkingCopy?: boolean }>(input: {
  skill: T
  currentUserId: string
  sessionMatches: () => boolean
  prepare: () => Promise<{ serverId: string; serverOwnerId: string; currentVersion: string; contentMatchesVersion: boolean }>
  publish: (serverId: string, version: string) => Promise<void>
}): Promise<T> {
  const check = (): void => { if (!input.sessionMatches()) throw new Error('账号已切换，已停止共享准备') }
  check()
  if (input.skill.catalogOrigin) throw new Error('官方商店 Skill 不拥有作者权限')
  if (input.skill.hasWorkingCopy) throw new Error('存在未保存的内容修改，请先处理')
  const asset = await input.prepare()
  check()
  if (asset.serverOwnerId !== input.currentUserId) throw new Error('作者资产与当前账号不一致')
  let version = asset.currentVersion
  if (!asset.contentMatchesVersion) {
    if (!input.skill.version || input.skill.version === asset.currentVersion) throw new Error('同一版本的本机内容与云端不同，请先保存为新版本')
    await input.publish(asset.serverId, input.skill.version)
    check()
    version = input.skill.version
  }
  return { ...input.skill, serverId: asset.serverId, serverOwnerId: asset.serverOwnerId, accountSyncRequired: undefined, version }
}

export async function moveLocalSkillToRecycle(input: {
  skill: OwnedServerSkill
  currentUserId?: string
  deleteRemote?: (serverId: string) => Promise<void>
  deleteLocal: () => Promise<void>
}): Promise<{ remoteWarning?: string }> {
  // Local recycle is deliberately not an account/cloud deletion operation.
  // Keep the input contract compatible with callers; never call deleteRemote.
  if (!input.skill.localPath) throw new Error('此 Skill 不在本机，无需移入本机回收站')
  await input.deleteLocal()
  return {}
}
