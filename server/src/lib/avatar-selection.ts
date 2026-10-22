import type { Prisma } from '@prisma/client'
import { config } from '../config.js'
import { db } from '../db.js'
import { lockSkillMutation } from './mutation-lock.js'

export const variantsMode = (): boolean => config.SKILL_AVATAR_MODEL_READS === 'variants'

export function listingAvatar(listing: { avatarUrl: string | null; avatarStatus: string | null; avatarSource: string | null },
  legacy: { avatarUrl?: string | null; avatarStatus?: string }): { avatarUrl: string | null; avatarStatus: string; avatarSource?: string } {
  return variantsMode()
    ? { avatarUrl: listing.avatarUrl, avatarStatus: listing.avatarStatus ?? 'none', avatarSource: listing.avatarSource ?? 'generated' }
    : { avatarUrl: legacy.avatarUrl ?? null, avatarStatus: legacy.avatarStatus ?? 'none' }
}
export const selectionDisplaySelect = {
  source: true, customUrl: true, revision: true,
  variant: { select: { url: true } }, currentJob: { select: { status: true } },
  anchor: { select: { variants: { orderBy: [{ createdAt: 'desc' }, { generationRevision: 'desc' }], take: 1, select: { url: true } } } },
} satisfies Prisma.AvatarSelectionSelect
type SelectedDisplay = Prisma.AvatarSelectionGetPayload<{ select: typeof selectionDisplaySelect }>
export type SelectionDisplay = Omit<SelectedDisplay, 'anchor'> & Partial<Pick<SelectedDisplay, 'anchor'>>
export function selectionAvatar(selection: SelectionDisplay | null | undefined): { avatarUrl: string | null; avatarStatus: string; avatarSource: 'generated' | 'custom' } {
  if (selection?.source === 'custom' && selection.customUrl) return { avatarUrl: selection.customUrl, avatarStatus: 'ready', avatarSource: 'custom' }
  if (selection?.variant) return { avatarUrl: selection.variant.url, avatarStatus: 'ready', avatarSource: 'generated' }
  const fallback = selection?.anchor?.variants[0]
  if (fallback) return { avatarUrl: fallback.url, avatarStatus: 'ready', avatarSource: 'generated' }
  const status = selection?.currentJob?.status
  return { avatarUrl: null, avatarStatus: !status ? 'none' : ['failed', 'needs_review'].includes(status) ? status : 'pending', avatarSource: 'generated' }
}

export async function projectSkillAvatars<T extends { id: string }>(skills: T[], tx: Prisma.TransactionClient = db): Promise<Array<T & Partial<ReturnType<typeof selectionAvatar>>>> {
  if (!variantsMode() || !skills.length) return skills
  const anchors = await tx.skillAvatar.findMany({ where: { skillId: { in: skills.map(s => s.id) } },
    select: { skillId: true, selection: { select: selectionDisplaySelect } } })
  const bySkill = new Map(anchors.map(a => [a.skillId, a.selection]))
  return skills.map(skill => ({ ...skill, ...selectionAvatar(bySkill.get(skill.id)) }))
}

export async function projectSkillAvatar<T extends { id: string }>(skill: T, tx: Prisma.TransactionClient = db): Promise<T & Partial<ReturnType<typeof selectionAvatar>>> {
  return (await projectSkillAvatars([skill], tx))[0]
}

export async function readOwnerSelection(tx: Prisma.TransactionClient, skillId: string): Promise<SelectionDisplay | null> {
  const anchor = await tx.skillAvatar.findUnique({ where: { skillId }, select: { selection: { select: selectionDisplaySelect } } })
  return anchor?.selection ?? null
}

/** Caller already holds the author's User lock; never acquire these in reverse order. */
export async function fillEmptyListingAvatar(tx: Prisma.TransactionClient, ownerId: string, skillId: string | null): Promise<void> {
  if (!skillId) return
  await lockSkillMutation(tx, skillId)
  const display = selectionAvatar(await readOwnerSelection(tx, skillId))
  if (display.avatarStatus !== 'ready' || !display.avatarUrl) return
  await tx.marketplaceListing.updateMany({ where: { skillId, avatarUrl: null }, data: {
    ...display, avatarSnapshotAt: new Date(), avatarUpdatedById: ownerId,
  } })
}
