import { z } from 'zod'

export class CatalogError extends Error {
  constructor(readonly code: 'CATALOG_UNREACHABLE' | 'CATALOG_NOT_AVAILABLE' | 'CATALOG_MISMATCH') {
    super(code === 'CATALOG_UNREACHABLE' ? '官方商店暂时不可用，请稍后重试'
      : code === 'CATALOG_NOT_AVAILABLE' ? '该 Skill 当前未在官方商店上架' : '官方商店的版本或包哈希已变化，请重新下载')
  }
  get statusCode(): number { return this.code === 'CATALOG_UNREACHABLE' ? 503 : 409 }
}

const listingSchema = z.object({
  id: z.string().uuid(),
  version: z.object({ version: z.string().min(1).max(40), packageSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  // Public detail is already gated by approved submission + active listing.
  // If a newer catalog exposes explicit state, it must agree with that gate.
  status: z.string().optional(),
  withdrawnAt: z.string().nullable().optional(),
})
type Listing = z.infer<typeof listingSchema>
export type CatalogSource = { skillId: string; version: string; packageSha256: string }
export type CatalogVerifier = (source: CatalogSource) => Promise<void>

export function createCatalogVerifier(origin: string): CatalogVerifier {
  const cache = new Map<string, { listing: Listing; expiresAt: number }>()
  return async (source): Promise<void> => {
    const key = `${source.skillId}@${source.version}`
    const cached = cache.get(key)
    let listing = cached && cached.expiresAt > Date.now() ? cached.listing : undefined
    if (!listing) {
      cache.delete(key)
      try {
        const response = await fetch(`${origin}/api/marketplace/${source.skillId}`, {
          redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' },
        })
        if (!response.ok || !response.body) {
          await response.body?.cancel()
          throw new CatalogError(response.status === 404 || response.status === 410 ? 'CATALOG_NOT_AVAILABLE' : 'CATALOG_UNREACHABLE')
        }
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let length = 0
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            length += value.byteLength
            if (length > 256 * 1024) throw new CatalogError('CATALOG_UNREACHABLE')
            chunks.push(value)
          }
        } finally { await reader.cancel(); reader.releaseLock() }
        const parsed = listingSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
        if (!parsed.success) throw new CatalogError('CATALOG_UNREACHABLE')
        listing = parsed.data
        if ((listing.status !== undefined && listing.status !== 'approved') || listing.withdrawnAt) {
          throw new CatalogError('CATALOG_NOT_AVAILABLE')
        }
      } catch (error: unknown) {
        if (error instanceof CatalogError) throw error
        // Never expose upstream bodies or fetch errors (which may contain URLs).
        throw new CatalogError('CATALOG_UNREACHABLE')
      }
    }
    if (listing.id !== source.skillId || listing.version.version !== source.version || listing.version.packageSha256 !== source.packageSha256) {
      throw new CatalogError('CATALOG_MISMATCH')
    }
    if (!cached || cached.expiresAt <= Date.now()) {
      cache.set(key, { listing, expiresAt: Date.now() + 60_000 })
      if (cache.size > 256) cache.delete(cache.keys().next().value!)
    }
  }
}
