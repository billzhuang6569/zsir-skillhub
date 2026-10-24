import { Prisma } from '@prisma/client'
import { variantsMode } from './avatar-selection.js'

type InheritanceDb = Pick<Prisma.TransactionClient, 'skill' | 'skillAvatar'>

/** A source id is a hint, never authorization. Historical grants remain valid. */
export async function inheritAuthorAsset(db: InheritanceDb, userId: string, skillId: string, sourceId?: string): Promise<void> {
  if (!sourceId || sourceId === skillId) return
  const source = await db.skill.findFirst({
    where: { id: sourceId, deletedAt: null, OR: [
      { authorId: userId },
      { versions: { some: { card: { grants: { some: { userId } } } } } },
    ] },
    select: { category: true, labels: true, triggerScenarios: true, analysisStatus: true,
      avatar: true },
  })
  if (!source) return
  const { avatar, ...profile } = source
  // shortcut: variants requires a generation job even for custom-only anchors; inherit images when that model supports jobless uploads.
  const customUrl = variantsMode()
    ? null
    : avatar?.source === 'custom' ? avatar.customUrl : avatar?.status === 'ready' ? avatar.url : null
  const customAssetId = variantsMode()
    ? null
    : avatar?.source === 'custom' ? avatar.customAssetId : avatar?.status === 'ready' ? avatar.assetId : null
  await db.skill.update({ where: { id: skillId }, data: {
    ...(profile.analysisStatus === 'completed' ? {
      category: profile.category,
      labels: profile.labels ?? Prisma.JsonNull,
      triggerScenarios: profile.triggerScenarios ?? Prisma.JsonNull,
      analysisStatus: 'completed',
    } : {}),
    ...(customUrl && customAssetId ? { avatarUrl: customUrl, avatarStatus: 'ready' } : {}),
  } })
  if (customUrl && customAssetId) {
    await db.skillAvatar.create({ data: {
      ownerId: userId, skillId, input: {}, inputFingerprint: 'inherited', promptVersion: 'inherited',
      status: 'cancelled', source: 'custom', customAssetId, customUrl, customUpdatedAt: new Date(),
    } })
  }
}
