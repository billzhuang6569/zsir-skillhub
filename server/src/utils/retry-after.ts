/**
 * `Retry-After` handling shared by every upstream adapter the avatar worker
 * (and other AI callers) sit behind. The header is either delta-seconds or an
 * HTTP-date; anything else is treated as "no wait stated" rather than as zero,
 * so a malformed header can neither skip nor fake a wait.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: () => number = Date.now): number | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (/^\d{1,9}$/.test(trimmed)) return Number(trimmed) * 1_000
  // Only the IMF-fixdate form HTTP mandates (RFC 7231 §7.1.3); `Date.parse`
  // alone would turn bare numbers or fragments into dates.
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) return null
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now())
}

/**
 * A non-2xx answer from an AI provider, carrying only the status and the
 * `Retry-After` wait: never the body, headers or credentials. The avatar
 * worker's classifier reads `status` and `retryAfterMs`.
 */
export class AiProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
    readonly upstreamCode: 'insufficient_user_quota' | null = null,
  ) {
    super(`AI provider returned HTTP ${status}`)
    this.name = 'AiProviderHttpError'
  }
}

export function aiProviderHttpError(provider: string, response: Pick<Response, 'status' | 'headers'>): AiProviderHttpError {
  return new AiProviderHttpError(provider, response.status, parseRetryAfterMs(response.headers.get('retry-after')))
}

/** Read a bounded error body; retain only the known quota code, never upstream text. */
export async function readAiProviderHttpError(provider: string, response: Response): Promise<AiProviderHttpError> {
  const fallback = aiProviderHttpError(provider, response)
  const reader = response.body?.getReader()
  if (!reader) return fallback
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192) return fallback
      chunks.push(value)
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (body && typeof body === 'object' && 'error' in body) {
      const error = body.error
      if (error && typeof error === 'object' && 'code' in error && error.code === 'insufficient_user_quota') {
        return new AiProviderHttpError(provider, response.status, fallback.retryAfterMs, 'insufficient_user_quota')
      }
    }
  } catch {
    // A malformed or interrupted error body must not hide the original HTTP failure.
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return fallback
}
