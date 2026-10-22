import type { LocalSkill } from '../store/index.js'

/**
 * Which id names this Skill's avatar inside the signed-in account (#149).
 *
 * Once a Skill is in the current account's library, its library entry id is
 * the stable identity every device and the Server share; the device-local
 * avatar id becomes an alias and is kept on the sidecar untouched. A Skill
 * that is not (yet) in this account's library keeps the device id. A Skill
 * bound to *another* account never borrows that account's entry id.
 */
export type AvatarIdentity = { stableId: string; aliasLocalIds: string[] }

export function avatarIdentityFor(
  skill: Pick<LocalSkill, 'libraryAccountId' | 'libraryEntryId' | 'avatarLocalId'>,
  userId: string,
  deviceLocalId: string | undefined = skill.avatarLocalId,
): AvatarIdentity | null {
  const bound = Boolean(skill.libraryEntryId) && skill.libraryAccountId === userId
  if (bound && skill.libraryEntryId) {
    return { stableId: skill.libraryEntryId, aliasLocalIds: deviceLocalId && deviceLocalId !== skill.libraryEntryId ? [deviceLocalId] : [] }
  }
  return deviceLocalId ? { stableId: deviceLocalId, aliasLocalIds: [] } : null
}

/**
 * Identity-only signature a parked conflict is keyed by: account, stable id,
 * aliases and the cloud Skill. Pending state, URLs and re-renders never change
 * it, so parking survives them; a real identity change produces a new one.
 */
export function avatarParkSignature(userId: string, identity: AvatarIdentity, serverId: string | null | undefined): string {
  return [userId, identity.stableId, [...identity.aliasLocalIds].sort().join(','), serverId ?? ''].join('\n')
}

export type ParkedAvatar = { parkedAt: number; stableId: string; aliasLocalIds: string[]; serverId: string | null }
export type ParkedAvatars = Record<string, ParkedAvatar>

/**
 * Parses the persisted parking file. `null` input means "no file yet" (first
 * run) and yields an empty record. Anything that is not a well-formed record —
 * invalid JSON, a non-object, or any malformed entry — returns `null`: the
 * caller must treat it as a read failure (keep everything paused, never
 * overwrite the file), not as "nothing parked".
 */
export function parseParkedAvatars(json: string | null): ParkedAvatars | null {
  if (json === null) return {}
  let value: unknown
  try { value = JSON.parse(json) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result: ParkedAvatars = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const record = entry as Record<string, unknown>
    if (typeof record.stableId !== 'string' || typeof record.parkedAt !== 'number') return null
    if (record.aliasLocalIds !== undefined && (!Array.isArray(record.aliasLocalIds) || !record.aliasLocalIds.every((v) => typeof v === 'string'))) return null
    if (record.serverId !== undefined && record.serverId !== null && typeof record.serverId !== 'string') return null
    result[key] = {
      parkedAt: record.parkedAt, stableId: record.stableId,
      aliasLocalIds: (record.aliasLocalIds as string[] | undefined) ?? [],
      serverId: typeof record.serverId === 'string' ? record.serverId : null,
    }
  }
  return result
}

export type AvatarListItem = { localSkillId?: string | null; skillId?: string | null; aliases?: string[] }

/**
 * Whether the Server's read-back proves the parked conflict is resolved. Only
 * an explicit canonical item (keyed by the stable id) whose cloud binding
 * matches ours and whose alias list contains every alias we hold releases the
 * parking. A missing `aliases` field (older Server), a missing item, a
 * different cloud binding, or an alias we hold that the Server does not list
 * keeps the Skill parked. Absence of conflicting rows proves nothing.
 */
export function parkingResolvedByReadBack(items: AvatarListItem[] | null, identity: AvatarIdentity, serverId: string | null | undefined): boolean {
  if (!items) return false
  const canonical = items.find((item) => item.localSkillId === identity.stableId)
  if (!canonical || !Array.isArray(canonical.aliases)) return false
  if ((canonical.skillId ?? null) !== (serverId ?? null)) return false
  return identity.aliasLocalIds.every((alias) => canonical.aliases!.includes(alias))
}

/** Client-only status for a parked identity conflict; never written back to the Server. */
export const AVATAR_STATUS_CONFLICT = 'conflict'
