import type { ApiError } from './api.ts'

function asApiError(error: unknown): ApiError | null {
  return error instanceof Error && error.name === 'ApiError' && 'kind' in error ? error as ApiError : null
}

/** A server message worth showing as is (not a bare status line or English default). */
function isReadableServerText(text: string): boolean {
  return /[一-鿿]/.test(text)
}

/**
 * Status-aware wording first: the gateway's own rejections (GATEWAY_*),
 * plain status lines and transport failures each get one clear sentence.
 */
function apiErrorMessage(error: ApiError): string | null {
  if (error.kind === 'network') return '连接失败，请检查网络后重试'
  if (error.kind === 'timeout') return '请求超时，请稍后重试'
  if (error.kind === 'aborted') return '请求已取消'
  const status = error.status
  if (status === 429 && (error.code === 'GATEWAY_RATE_LIMITED' || !isReadableServerText(error.message))) {
    return error.retryAfterSeconds && error.retryAfterSeconds > 0 && error.retryAfterSeconds <= 600
      ? `请求过于频繁，请 ${error.retryAfterSeconds} 秒后再试`
      : '请求过于频繁，请稍后再试'
  }
  if (status === 503 && (error.code === 'GATEWAY_BUSY' || !isReadableServerText(error.message))) return '服务暂时繁忙，请稍后再试'
  if ((status === 502 || status === 504) && !isReadableServerText(error.message)) return '暂时无法连接服务，请稍后再试'
  return null
}

/** Translate known transport/native failures without hiding actionable Chinese errors. */
export function userMessage(error: unknown): string {
  const apiError = asApiError(error)
  const translated = apiError ? apiErrorMessage(apiError) : null
  if (translated) return translated
  const text = error instanceof Error ? error.message : String(error)
  if (/^(Load failed|Failed to fetch|NetworkError.*|Network request failed)$/i.test(text)) return '连接失败，请检查网络后重试'
  if (/^(Request timed out|TimeoutError.*)$/i.test(text)) return '请求超时，请稍后重试'
  if (/^(Forbidden|403 Forbidden|Skill access is no longer available)$/i.test(text)) return '当前账号无法访问此 Skill，请确认账号或团队权限'
  if (/^(Unauthorized|401 Unauthorized)$/i.test(text)) return '登录已过期，请重新登录'
  if (/^.*Read-only file system \(os error 30\).*$/i.test(text)) return '当前位置无法写入，请将应用移到“应用程序”后重试'
  if (/^(Internal Server Error|500 Internal Server Error)$/i.test(text)) return '服务暂不可用，请稍后重试'
  return text
}
