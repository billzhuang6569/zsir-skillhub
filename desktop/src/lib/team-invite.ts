import { normalizeInviteServer } from './tauri.ts'
import { DEEP_LINK_SCHEME, OFFICIAL_ENDPOINTS } from './official-endpoints.ts'

const SERVER_ORIGIN = OFFICIAL_ENDPOINTS.serverOrigin.replace(/\/+$/, '')

const TOKEN_PATTERN = /^shti1\.[A-Za-z0-9_-]{54}\.[A-Za-z0-9_-]{27}$/

export type ParsedTeamInvite = { token: string; server: string; source: 'app-link' | 'web-link' }
export const PENDING_INVITE_KEY = 'skillhub-pending-team-invite'
const resuming = new Map<string, Promise<void>>()

export async function resumePendingTeamInvite(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  matches: (invite: ParsedTeamInvite) => Promise<boolean>,
  accept: (token: string) => Promise<boolean>,
): Promise<void> {
  const raw = storage.getItem(PENDING_INVITE_KEY)
  if (!raw) return
  const previous = resuming.get(raw)
  if (previous) {
    await previous.catch(() => {})
    return resumePendingTeamInvite(storage, matches, accept)
  }
  const task = (async (): Promise<void> => {
    const invite = await parseTeamInvite(raw)
    if (!invite) { storage.removeItem(PENDING_INVITE_KEY); return }
    if (await matches(invite) && storage.getItem(PENDING_INVITE_KEY) === raw && await accept(invite.token)) {
      if (storage.getItem(PENDING_INVITE_KEY) === raw) storage.removeItem(PENDING_INVITE_KEY)
    }
  })().finally(() => { resuming.delete(raw) })
  resuming.set(raw, task)
  await task
}

export function isSameInviteServer(server: string, profile: 'official' | 'local' | 'selfhost', currentBase = '', previousOrigins: string[] = []): boolean {
  if (profile === 'local') return false
  if (profile === 'official') return server === SERVER_ORIGIN
  return server === currentBase.replace(/\/+$/, '') || previousOrigins.includes(server)
}

export function inviteSwitchTarget(server: string): string {
  return server === SERVER_ORIGIN ? 'official' : server
}

export function isLoopbackInviteServer(profile: string, base: string): boolean {
  if (profile !== 'selfhost') return false
  try {
    const host = new URL(base).hostname
    return host === 'localhost' || host === '[::1]' || /^127\./.test(host) || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]+\]$/i.test(host)
  } catch { return false }
}

export function teamInviteDeepLink(token: string, server = SERVER_ORIGIN): string {
  return `${DEEP_LINK_SCHEME}://join-team/${encodeURIComponent(token)}?server=${encodeURIComponent(server)}`
}

export function teamInviteWebLink(token: string, server = SERVER_ORIGIN): string {
  return `${server.replace(/\/+$/, '')}/invite/${encodeURIComponent(token)}`
}

function validatedToken(value: string): string | null {
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { return null }
  return TOKEN_PATTERN.test(decoded) ? decoded : null
}

export async function parseTeamInvite(value: string): Promise<ParsedTeamInvite | null> {
  if (value.length > 64 * 1024) return null
  const appMatch = value.match(new RegExp(`${DEEP_LINK_SCHEME}://join-team/([^\\s<>"'，。；]+)`, 'i'))
  if (appMatch?.[1]) {
    try {
      if (appMatch[0].length > 4096) return null
      const url = new URL(appMatch[0])
      if (url.hash || url.username || url.password || url.port) return null
      const entries = [...url.searchParams]
      if (entries.length > 1 || (entries.length === 1 && entries[0][0] !== 'server')) return null
      if (url.host.toLowerCase() !== 'join-team') return null
      const token = validatedToken(appMatch[1].split('?')[0])
      const server = await normalizeInviteServer(url.searchParams.get('server') ?? SERVER_ORIGIN)
      if (token) return { token, server, source: 'app-link' }
    } catch { return null }
  }

  const links = value.match(/https?:\/\/[^\s<>"']+/gi) ?? []
  for (const rawLink of links) {
    const candidate = rawLink.replace(/[，。；、）)\]]+$/, '')
    try {
      if (candidate.length > 4096) continue
      const url = new URL(candidate)
      if (url.search || url.hash) continue
      const match = url.pathname.match(/^(.*)\/invite\/([^/]+)$/)
      if (!match) continue
      const token = validatedToken(match[2])
      // Preserve the raw base for Rust to reject dot segments/ambiguous encodings.
      const base = candidate.slice(0, candidate.lastIndexOf('/invite/'))
      const server = await normalizeInviteServer(base)
      if (token) return { token, server, source: 'web-link' }
    } catch {
      continue
    }
  }
  return null
}

export function teamInviteMessage(input: { teamName: string; teamId: string; token: string; landingPageUrl?: string }): string {
  return [
    `邀请你加入一探 SkillHub 团队「${input.teamName}」`,
    '',
    '复制这段文字后打开一探 SkillHub，软件会自动识别邀请：',
    input.landingPageUrl ?? teamInviteWebLink(input.token),
    '',
    '也可以在 My Team 中手动输入团队 ID：',
    input.teamId,
  ].join('\n')
}
