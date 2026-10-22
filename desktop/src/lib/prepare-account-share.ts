import type { LocalSkill } from '../store/index.js'
import { ApiError, apiCreateSkillVersion, apiGetSkillVersions, type ApiSkillVersion } from './api.js'
import { createSkillPackage, getLocalSkills, libraryAuthorAsset, readSkillMd, recordSkillFormalVersion } from './tauri.js'
import { prepareAccountSkillForShare, SharePreparationUnknown, shareVersionReadbackUnknown } from './team-share-flow.js'
export { SharePreparationUnknown, type ShareVersionReceipt } from './team-share-flow.js'

/** GUI single and batch sharing use the same saved-content preparation. */
export async function prepareAccountTeamShare(skill: LocalSkill, userId: string, sessionMatches: () => boolean): Promise<LocalSkill> {
  const check = (): void => { if (!sessionMatches()) throw new Error('账号已切换，已停止共享准备') }
  const localId = skill.marketplaceLocalId ?? skill.id
  check()
  const before = (await getLocalSkills()).find(item => item.id === localId)
  check()
  if (!before || before.libraryAccountId !== userId || before.libraryEntryId !== skill.libraryEntryId || before.hasWorkingCopy) throw new Error('本机副本或未保存内容已变化，请重新确认')
  return prepareAccountSkillForShare({ skill: before, currentUserId: userId, sessionMatches,
    prepare: () => libraryAuthorAsset(localId),
    publish: async (serverId, version) => {
      check()
      const fresh = (await getLocalSkills()).find(item => item.id === localId)
      check()
      if (!fresh || fresh.hasWorkingCopy || fresh.version !== version || fresh.libraryAccountId !== userId || fresh.libraryEntryId !== skill.libraryEntryId) {
        throw new Error('本机内容或版本已变化，请重新确认共享范围')
      }
      const [pack, skillMd] = await Promise.all([createSkillPackage(localId), readSkillMd(localId)])
      check()
      const verified = (await getLocalSkills()).find(item => item.id === localId)
      const finalPack = await createSkillPackage(localId)
      check()
      if (!verified || verified.hasWorkingCopy || verified.version !== version || verified.libraryAccountId !== userId
        || verified.libraryEntryId !== skill.libraryEntryId || verified.versionReceiptId !== fresh.versionReceiptId
        || finalPack.sha256 !== pack.sha256) throw new Error('内容或账号版本回执在打包期间发生变化，请重新确认')
      const gitHash = fresh.versions.find(item => item.isCurrent)?.gitHash
      const changelog = '共享已保存的本机版本'
      let formal: ApiSkillVersion
      try {
        formal = await apiCreateSkillVersion(serverId, { version, changelog, gitHash, skillMd,
          packageBase64: pack.base64, packageSha256: pack.sha256,
          libraryVersionReceiptId: fresh.versionReceiptId,
          envDependencies: fresh.envDeps.map(({ key, description, required }) => ({ key, description, required })),
        })
      } catch (error: unknown) {
        // An explicit refusal is safe to retry after its cause is corrected.
        if (error instanceof ApiError && error.kind === 'http' && error.status !== null && error.status < 500) throw error
        const receipt = { serverId, version, packageSha256: pack.sha256, changelog, gitHash }
        if (!sessionMatches()) throw new SharePreparationUnknown('账号已切换，原账号版本准备结果待核验', receipt)
        let versions
        try { versions = await apiGetSkillVersions(serverId) }
        catch { throw new SharePreparationUnknown('版本上传响应中断，结果尚未确认；先读回版本记录，禁止盲目重试', receipt) }
        if (!sessionMatches()) throw new SharePreparationUnknown('账号已切换，原账号版本准备结果待核验', receipt)
        throw shareVersionReadbackUnknown(receipt, versions)
      }
      check()
      await recordSkillFormalVersion(localId, formal.id, gitHash)
      check()
    },
  })
}
