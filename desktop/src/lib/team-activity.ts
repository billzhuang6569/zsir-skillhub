/**
 * 团队动态 (#295 board 8): one Chinese sentence per Server activity row.
 * The actor and any person named in the payload render as UserChips; Skill
 * names stay plain text and key names monospace.
 */

export type TeamActivityPerson = { id: string; displayName: string; avatarUrl?: string | null }

export type TeamActivityItem = {
  id: string
  type: string
  actor: TeamActivityPerson | null
  payload: Record<string, unknown>
  createdAt: string
}

export type ActivityPart =
  | { kind: 'text'; text: string }
  | { kind: 'user'; name: string; me: boolean; avatarUrl?: string | null }
  | { kind: 'skill'; text: string }
  | { kind: 'key'; text: string }

function text(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function user(name: string | null, id: string | null, currentUserId: string | null, avatarUrl?: string | null): ActivityPart {
  return { kind: 'user', name: name ?? '成员', me: Boolean(currentUserId && id && id === currentUserId), avatarUrl }
}

function actorPart(item: TeamActivityItem, currentUserId: string | null): ActivityPart {
  return user(item.actor?.displayName ?? null, item.actor?.id ?? null, currentUserId, item.actor?.avatarUrl)
}

/**
 * | type | sentence |
 * | member_joined | 「王小明 加入了团队」 (the joiner from the payload, else the actor) |
 * | member_left | 「韩梅梅 离开了团队」 |
 * | member_removed | 「小庄Sir 移出了 陈晨」 |
 * | skill_shared | 「李雷 共享了 seedance-prompt」 |
 * | skill_unshared | 「李雷 停止共享 seedance-prompt」 |
 * | skill_version_published | 「李雷 发布了 seedance-prompt 0.3.1」 |
 * | key_put | 「小庄Sir 放了钥匙 FAL_KEY」 |
 * | key_rotated | 「小庄Sir 更换了钥匙 FAL_KEY」 |
 * | key_revoked | 「小庄Sir 撤销了钥匙 FAL_KEY」 |
 */
export function activitySentence(item: TeamActivityItem, currentUserId: string | null = null): ActivityPart[] {
  const { payload } = item
  const skill = text(payload, 'skillName') ?? 'Skill'
  const key = text(payload, 'envKey') ?? '钥匙'
  switch (item.type) {
    case 'member_joined': {
      const joiner = text(payload, 'displayName')
      const joinerId = text(payload, 'userId')
      const person = joiner || joinerId ? user(joiner ?? item.actor?.displayName ?? null, joinerId ?? item.actor?.id ?? null, currentUserId) : actorPart(item, currentUserId)
      return [person, { kind: 'text', text: '加入了团队' }]
    }
    case 'member_left': {
      const leaver = text(payload, 'displayName')
      const leaverId = text(payload, 'userId')
      const person = leaver || leaverId ? user(leaver ?? item.actor?.displayName ?? null, leaverId ?? item.actor?.id ?? null, currentUserId) : actorPart(item, currentUserId)
      return [person, { kind: 'text', text: '离开了团队' }]
    }
    case 'member_removed':
      return [actorPart(item, currentUserId), { kind: 'text', text: '移出了' }, user(text(payload, 'displayName'), text(payload, 'userId'), currentUserId)]
    case 'skill_shared':
      return [actorPart(item, currentUserId), { kind: 'text', text: '共享了' }, { kind: 'skill', text: skill }]
    case 'skill_unshared':
      return [actorPart(item, currentUserId), { kind: 'text', text: '停止共享' }, { kind: 'skill', text: skill }]
    case 'skill_version_published': {
      const version = text(payload, 'version')
      return [actorPart(item, currentUserId), { kind: 'text', text: '发布了' }, { kind: 'skill', text: version ? `${skill} ${version}` : skill }]
    }
    case 'key_put':
      return [actorPart(item, currentUserId), { kind: 'text', text: '放了钥匙' }, { kind: 'key', text: key }]
    case 'key_rotated':
      return [actorPart(item, currentUserId), { kind: 'text', text: '更换了钥匙' }, { kind: 'key', text: key }]
    case 'key_revoked':
      return [actorPart(item, currentUserId), { kind: 'text', text: '撤销了钥匙' }, { kind: 'key', text: key }]
    default:
      return [actorPart(item, currentUserId), { kind: 'text', text: '更新了团队' }]
  }
}

/** Plain text of a sentence; the current user reads 「你」. */
export function activitySentenceText(item: TeamActivityItem, currentUserId: string | null = null): string {
  return activitySentence(item, currentUserId)
    .map((part) => part.kind === 'user' ? (part.me ? '你' : part.name) : part.text)
    .join(' ')
}

export const TEAM_ACTIVITY_PAGE_SIZE = 50

/** Appends a 「加载更多」 page without duplicating rows already shown. */
export function appendActivityPage(current: readonly TeamActivityItem[], page: readonly TeamActivityItem[]): TeamActivityItem[] {
  const seen = new Set(current.map((item) => item.id))
  return [...current, ...page.filter((item) => !seen.has(item.id))]
}
