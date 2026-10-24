import { DEEP_LINK_SCHEME } from './official-endpoints.ts'
import { normalizeInviteServer, type SpaceHandle } from './tauri.ts'
import { ApiError, apiGetInstanceBaseUrls } from './api.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export type TeamSkillLink = { teamId: string; skillId: string; server: string }
export const TEAM_SKILL_UNAVAILABLE = '无法打开：你不是该团队成员，或该 Skill 已不再共享'

/** Memory only; one authenticated space/account at a time, including in-flight requests. */
export function createTeamSkillBaseUrlsCache(load = apiGetInstanceBaseUrls) {
  let entry: { key: string; promise: Promise<string[] | undefined> } | null = null
  return {
    clear(): void { entry = null },
    get(space: SpaceHandle, userId: string | null, supported: boolean): Promise<string[] | undefined> {
      if (!userId || !supported) { entry = null; return Promise.resolve(undefined) }
      const key = JSON.stringify([space.spaceId, space.generation, userId])
      if (entry?.key === key) return entry.promise
      const promise = load(space).then(result => result.baseUrls).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return undefined
        if (entry?.promise === promise) entry = null
        throw error
      })
      entry = { key, promise }
      return promise
    },
  }
}

export async function parseTeamSkillLink(raw: string): Promise<TeamSkillLink | null> {
  if (raw.length > 4096) return null
  try {
    const url = new URL(raw)
    if (raw.split('?')[0] !== `${DEEP_LINK_SCHEME}://team-skill${url.pathname}`) return null
    if (url.protocol !== `${DEEP_LINK_SCHEME}:` || url.host !== 'team-skill'
      || url.username || url.password || url.hash || raw.includes('#')) return null
    const parts = url.pathname.split('/')
    if (parts.length !== 3 || !UUID.test(parts[1]) || !UUID.test(parts[2])) return null
    const params = [...url.searchParams]
    if (!url.search.startsWith('?server=') || url.search.includes('&')) return null
    if (params.length !== 1 || params[0][0] !== 'server' || !params[0][1]) return null
    return { teamId: parts[1].toLowerCase(), skillId: parts[2].toLowerCase(), server: await normalizeInviteServer(params[0][1]) }
  } catch { return null }
}

/** Only addresses declared by the currently connected Server may extend its identity. */
export async function isTeamSkillServer(server: string, currentBase: string, declaredBases?: readonly string[]): Promise<boolean> {
  for (const base of declaredBases ?? [currentBase]) {
    try { if (server === await normalizeInviteServer(base)) return true } catch { /* Invalid declarations grant no access. */ }
  }
  return false
}

export function teamSkillAppLink(teamId: string, skillId: string, server: string): string {
  if (!UUID.test(teamId) || !UUID.test(skillId)) throw new Error('无效的团队 Skill 标识')
  return `${DEEP_LINK_SCHEME}://team-skill/${teamId}/${skillId}?server=${encodeURIComponent(server)}`
}
