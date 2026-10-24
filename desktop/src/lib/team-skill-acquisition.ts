import type { LocalSkill } from '../store/index.ts'
import { apiDownloadSkillPackage } from './api.ts'
import { currentSpace, importSkillPackage, type SpaceHandle } from './tauri.ts'
import { hydrateDownloadedSkill, remoteManagedSkillId } from './skills.ts'

/** Download into SkillHub only. Agent projection remains an explicit separate action. */
export async function acquireTeamSkill(skill: LocalSkill, userId: string, teamId: string, space?: SpaceHandle): Promise<LocalSkill> {
  if (skill.localPath) return skill
  if (!skill.serverId || !skill.serverOwnerId || !userId) throw new Error('团队 Skill 缺少归属信息，请刷新后重试')
  const expectedSpace = space ?? await currentSpace()
  const data = await apiDownloadSkillPackage(skill.serverId, expectedSpace, teamId)
  const imported = await importSkillPackage({
    skillId: remoteManagedSkillId(skill.name, skill.serverId), name: skill.name,
    packageBase64: data.base64, expectedSha256: data.sha256,
    sourceVersionId: data.versionId,
    serverId: skill.serverId, serverOwnerId: skill.serverOwnerId,
    displayName: skill.displayName, description: skill.description, sourceUrl: skill.sourceUrl,
    category: skill.category, labels: skill.labels, version: data.version,
    teamId, teamIds: [teamId], isOwn: skill.isOwn,
    acquisitionSource: 'team', acquiredByUserId: userId,
    installCount: skill.installCount + 1, createdAt: skill.createdAt, updatedAt: skill.updatedAt,
    triggerScenarios: skill.fitScenarios ?? [], compatibleAgents: skill.compatibleAgents,
    envDependencies: skill.envDeps.map(dependency => ({ ...dependency, sharedTeams: dependency.sharedTeams ?? [] })),
  }, expectedSpace)
  return hydrateDownloadedSkill({ ...skill, teamSharedFrom: teamId }, imported)
}
