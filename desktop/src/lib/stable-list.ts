/** Plain DTO comparison includes permissions, key state and sync receipts. */
export function sameListData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) return false
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a).filter(key => a[key] !== undefined)
  const other = Object.keys(b).filter(key => b[key] !== undefined)
  return keys.length === other.length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameListData(a[key], b[key]))
}

export function shareList<T>(previous: readonly T[], next: T[], key: (item: T) => string): T[] {
  const known = new Map(previous.map(item => [key(item), item]))
  const result = next.map(item => {
    const old = known.get(key(item))
    return old && sameListData(old, item) ? old : item
  })
  return previous.length === result.length && result.every((item, index) => item === previous[index])
    ? previous as T[] : result
}

type SkillIdentity = { id: string; libraryEntryId?: string | null; serverId?: string }
export function sameSkillIdentity(left: SkillIdentity, right: SkillIdentity): boolean {
  return left.id === right.id || Boolean(left.libraryEntryId && left.libraryEntryId === right.libraryEntryId)
    || Boolean(left.serverId && left.serverId === right.serverId)
}
export function stableSkillIdentity(skill: SkillIdentity): string {
  return skill.libraryEntryId ? `library:${skill.libraryEntryId}` : skill.serverId ? `server:${skill.serverId}` : skill.id
}

/** Existing identities keep their session order; genuinely new rows enter deterministically. */
export function reconcileSkillList<T extends SkillIdentity>(previous: readonly T[], next: T[]): T[] {
  const ids = new Map<string, number>()
  const libraryIds = new Map<string, number>()
  const serverIds = new Map<string, number>()
  previous.forEach((item, index) => {
    if (!ids.has(item.id)) ids.set(item.id, index)
    if (item.libraryEntryId && !libraryIds.has(item.libraryEntryId)) libraryIds.set(item.libraryEntryId, index)
    if (item.serverId && !serverIds.has(item.serverId)) serverIds.set(item.serverId, index)
  })
  const positions = new Map(next.map(item => {
    const index = Math.min(ids.get(item.id) ?? Infinity,
      (item.libraryEntryId ? libraryIds.get(item.libraryEntryId) : undefined) ?? Infinity,
      (item.serverId ? serverIds.get(item.serverId) : undefined) ?? Infinity)
    return [stableSkillIdentity(item), Number.isFinite(index) ? index : undefined]
  }))
  return shareList(previous, [...next].sort((a, b) => {
    const left = positions.get(stableSkillIdentity(a))
    const right = positions.get(stableSkillIdentity(b))
    if (left !== undefined && right !== undefined) return left - right
    if (left !== undefined) return -1
    if (right !== undefined) return 1
    return stableSkillIdentity(a).localeCompare(stableSkillIdentity(b), 'en')
  }), stableSkillIdentity)
}
