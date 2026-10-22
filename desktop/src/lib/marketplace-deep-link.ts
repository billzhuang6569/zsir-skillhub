import { DEEP_LINK_SCHEME, OFFICIAL_ENDPOINTS } from './official-endpoints.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type MarketplaceDeepLink = {
  listingId: string
  action: 'install' | 'discuss'
  intentId?: string
  versionId?: string
}

export function parseMarketplaceDeepLink(raw: string): MarketplaceDeepLink | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:` || url.hostname !== 'marketplace') return null
  const pathParts = url.pathname.split('/').filter(Boolean)
  if (pathParts.length !== 1 || !UUID.test(pathParts[0] ?? '')) return null
  const action = url.searchParams.get('action')
  if (action !== 'install' && action !== 'discuss') return null
  const allowed = new Set(['action', 'intentId', 'versionId'])
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return null
  const intentId = url.searchParams.get('intentId') ?? undefined
  const versionId = url.searchParams.get('versionId') ?? undefined
  if ((intentId && !UUID.test(intentId)) || (versionId && !UUID.test(versionId))) return null
  return {
    listingId: pathParts[0] as string,
    action,
    ...(intentId ? { intentId } : {}),
    ...(versionId ? { versionId } : {}),
  }
}

/** Public identity is independent of the Skill name and published version. */
export function buildMarketplaceShareUrl(listingId: string): string {
  if (!UUID.test(listingId)) throw new Error('无效的 Skill 标识')
  return `${OFFICIAL_ENDPOINTS.siteOrigin}/marketplace/skills/${listingId.toLowerCase()}`
}
