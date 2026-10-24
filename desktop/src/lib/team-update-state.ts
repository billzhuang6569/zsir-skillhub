export type TeamUpdateInput = { accountMatches: boolean; available: boolean; sameVersion: boolean; localModified: boolean }
export function teamUpdateAccountMatches(input: {
  accountUserId?: string
  acquiredByUserId?: string | null
  libraryAccountId?: string | null
}): boolean {
  return input.libraryAccountId
    ? input.libraryAccountId === input.accountUserId
    : input.acquiredByUserId === input.accountUserId
}

export function teamUpdateState(input: TeamUpdateInput): string {
  if (!input.accountMatches) return 'account_mismatch'
  if (!input.available) return 'access_revoked'
  if (input.sameVersion) return 'up_to_date'
  return input.localModified ? 'local_modified' : 'update_available'
}

type KeyRequirement = { key: string; required: boolean; description?: string; obtain?: string }
export function teamKeyChanges(current: readonly KeyRequirement[], next: readonly KeyRequirement[]): { added: string[]; removed: string[]; changed: string[] } {
  const old = new Map(current.map(item => [item.key, item]))
  const keys = new Set(next.map(item => item.key))
  return {
    added: next.filter(item => !old.has(item.key)).map(item => item.key),
    removed: current.filter(item => !keys.has(item.key)).map(item => item.key),
    changed: next.filter(item => {
      const previous = old.get(item.key)
      return previous && (previous.required !== item.required || (previous.description ?? '') !== (item.description ?? '') || (previous.obtain ?? '') !== (item.obtain ?? ''))
    }).map(item => item.key),
  }
}
