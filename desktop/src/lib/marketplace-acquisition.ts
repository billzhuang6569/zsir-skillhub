import { isMarketplaceUpgrade } from './marketplace-state.ts'
import type { LocalSkill } from '../store/index.js'
import { remoteManagedSkillId } from './skills.ts'
import type { importSkillPackage } from './tauri.js'
import { OFFICIAL_ENDPOINTS } from './official-endpoints.ts'

type Package = { base64: string; sha256: string; version: string }
type ImportInput = Parameters<typeof importSkillPackage>[0]

/** Import only: this operation must never create or replace Agent projections. */
export async function acquireMarketplaceSkill(
  skill: LocalSkill,
  dependencies: {
    currentUserId?: string
    spaceId?: string
    localSkills: () => Promise<LocalSkill[]>
    download: (id: string) => Promise<Package>
    importPackage: (input: ImportInput) => Promise<LocalSkill>
  },
  update = false,
): Promise<LocalSkill> {
  if (!skill.serverId || !skill.serverOwnerId || skill.marketplaceStatus !== 'approved') {
    throw new Error('商店资料不完整，请刷新后重试')
  }
  const catalogOrigin = OFFICIAL_ENDPOINTS.catalogOrigin.replace(/\/+$/, '')
  const official = !dependencies.spaceId || dependencies.spaceId === 'official'
  const existing = (await dependencies.localSkills()).find(item => item.serverId === skill.serverId && item.localPath
    && (official || item.catalogOrigin === catalogOrigin))
  if (existing && (!update || !isMarketplaceUpgrade(skill.version, existing.acquisitionVersion ?? existing.version))) return existing
  if (update && !existing) throw new Error('本机 Skill 已变化，请刷新后重试')
  if (!skill.marketplacePackageSha256) throw new Error('缺少审核包校验值，请刷新后重试')
  const pkg = await dependencies.download(skill.serverId)
  if (pkg.sha256.toLowerCase() !== skill.marketplacePackageSha256.toLowerCase() || pkg.version !== skill.version) {
    throw new Error('商店版本已更新，请刷新后重试')
  }
  const acquisitionSource = existing?.acquisitionSource ?? 'marketplace'
  return dependencies.importPackage({
    skillId: existing?.id ?? remoteManagedSkillId(skill.name, skill.serverId, dependencies.spaceId), name: skill.name,
    packageBase64: pkg.base64, expectedSha256: pkg.sha256,
    serverId: skill.serverId, serverOwnerId: skill.serverOwnerId,
    displayName: skill.displayName, description: skill.description, sourceUrl: skill.sourceUrl,
    category: skill.category, labels: skill.labels, version: pkg.version,
    teamIds: Object.keys(existing?.sharedTo ?? {}), teamId: existing?.teamSharedFrom,
    catalogOrigin: acquisitionSource === 'marketplace' ? catalogOrigin : undefined,
    isOwn: acquisitionSource === 'marketplace' ? false : existing?.isOwn ?? false, acquisitionSource,
    acquiredByUserId: acquisitionSource === 'team' ? dependencies.currentUserId : undefined,
    replaceExistingMarketplace: Boolean(existing && update),
    installCount: skill.installCount, createdAt: skill.createdAt, updatedAt: skill.updatedAt,
    triggerScenarios: skill.fitScenarios ?? [], compatibleAgents: skill.compatibleAgents,
    envDependencies: skill.envDeps.map(({ key, description, required }) => ({
      key, description, required, sharePolicy: 'none', sharedTeams: [],
    })),
  })
}
