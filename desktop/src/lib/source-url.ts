// 「来源」 sourceUrl display parser (#330). The same file lives in
// desktop/src/lib/source-url.ts and landing-page/src/shared/source-url.ts;
// keep both copies and their tests identical.
//
// It only parses the URL string: no network request, favicon or embed.
// Sites are recognized by exact hostname (an optional leading `www.` is
// allowed), never by substring, so look-alike domains stay generic.

export type SourceUrlKind = 'x' | 'github' | 'skills-sh' | 'skillsmp' | 'clawhub' | 'generic'

export type SourceUrlDescription = {
  kind: SourceUrlKind
  /** Site name, or the host for an unknown site. */
  label: string
  /** Short account / repository / path summary; null when nothing useful parses. */
  detail: string | null
  /** The full target to open; always http: or https:. */
  href: string
}

/** Same limit as the Server's `SkillSourceUrlSchema`. */
export const SOURCE_URL_MAX_LENGTH = 2048
/** Longest `detail` shown before eliding the middle; the full URL stays in `href`. */
export const SOURCE_URL_DETAIL_MAX = 48

const SITES: ReadonlyArray<{ kind: Exclude<SourceUrlKind, 'generic'>; hosts: readonly string[]; label: string }> = [
  { kind: 'x', hosts: ['x.com', 'twitter.com'], label: 'X' },
  { kind: 'github', hosts: ['github.com'], label: 'GitHub' },
  { kind: 'skills-sh', hosts: ['skills.sh'], label: 'skills.sh' },
  { kind: 'skillsmp', hosts: ['skillsmp.com'], label: 'SkillsMP' },
  { kind: 'clawhub', hosts: ['clawhub.ai'], label: 'ClawHub' },
]

const X_RESERVED = new Set(['home', 'i', 'search', 'explore', 'hashtag', 'settings', 'intent', 'share', 'messages', 'notifications', 'compose', 'login', 'signup', 'tos', 'privacy'])
const GITHUB_RESERVED = new Set(['orgs', 'settings', 'topics', 'marketplace', 'explore', 'features', 'collections', 'trending', 'sponsors', 'search', 'login', 'about', 'pricing', 'apps', 'notifications', 'issues', 'pulls'])

/**
 * Validation mirroring the Server: trimmed, at most 2048 characters, an
 * `http://` / `https://` URL with a host, no user name or password, and no
 * whitespace, `\`, `<`, `>`, `"` or control characters. Blank → null.
 * Returns the trimmed value or an error message.
 */
export function validateSourceUrl(value: string | null | undefined): { ok: true; value: string | null } | { ok: false; error: string } {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return { ok: true, value: null }
  if (trimmed.length > SOURCE_URL_MAX_LENGTH) return { ok: false, error: `来源网址不能超过 ${SOURCE_URL_MAX_LENGTH} 个字符` }
  const invalid = { ok: false as const, error: '来源须为不含账号密码的 HTTP/HTTPS 网址' }
  if (!/^https?:\/\//i.test(trimmed) || /[\s\\<>"\u0000-\u001f\u007f]/.test(trimmed)) return invalid
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return invalid
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return invalid
  return { ok: true, value: trimmed }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function pathSegments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean).map(decodeSegment)
}

/** Elides the middle of a long summary so both ends stay readable. */
export function elideMiddle(text: string, max: number = SOURCE_URL_DETAIL_MAX): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - (keep - head)).join('')}`
}

function pathSummary(url: URL): string | null {
  const segments = pathSegments(url)
  return segments.length > 0 ? elideMiddle(segments.join('/')) : null
}

function xDetail(url: URL): string | null {
  const [handle, kind] = pathSegments(url)
  if (!handle || X_RESERVED.has(handle.toLowerCase()) || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null
  return kind === 'status' ? `@${handle} 的帖子` : `@${handle}`
}

function githubDetail(url: URL): string | null {
  const [owner, repo] = pathSegments(url)
  if (!owner || GITHUB_RESERVED.has(owner.toLowerCase()) || !/^[A-Za-z0-9-]{1,39}$/.test(owner)) return pathSummary(url)
  const name = repo?.replace(/\.git$/i, '')
  return elideMiddle(name && /^[A-Za-z0-9._-]+$/.test(name) ? `${owner}/${name}` : owner)
}

/**
 * Display data for a Skill's 「来源」, or null when it is missing, blank or
 * not a valid http/https URL (the UI then renders nothing at all).
 */
export function describeSourceUrl(value: string | null | undefined): SourceUrlDescription | null {
  const checked = validateSourceUrl(value)
  if (!checked.ok || !checked.value) return null
  const url = new URL(checked.value)
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const bare = host.startsWith('www.') ? host.slice(4) : host
  const site = SITES.find((candidate) => candidate.hosts.includes(bare))
  const href = url.href
  if (!site) return { kind: 'generic', label: bare, detail: pathSummary(url), href }
  const detail = site.kind === 'x' ? xDetail(url) : site.kind === 'github' ? githubDetail(url) : pathSummary(url)
  return { kind: site.kind, label: site.label, detail, href }
}
