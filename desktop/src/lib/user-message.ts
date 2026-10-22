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
  if (status === 409 && error.code === 'PACKAGE_NOT_PUBLISHABLE') {
    const path = error.path || '未知文件'
    switch (error.reason) {
      case 'forbidden_file':
        return `安装包里的「${path}」被识别为凭据文件，请改名或移除后重新上传版本`
      case 'sensitive_content':
        return `「${path}」中有疑似密钥或令牌的文本，请改为占位内容后重新上传版本`
      case 'invalid_text':
        return `「${path}」不是有效的文本文件，请检查编码后重新上传版本`
      case 'limits':
      case 'review_limit':
        return '安装包超过公开发布的大小限制，请精简后重新上传版本'
      case 'structure':
      case 'missing_skill_md':
        return '安装包结构不完整（缺少 SKILL.md 或 ZIP 结构异常），请重新上传版本'
      default:
        return '该版本当前没有可公开的安装包，请重新上传版本后再试'
    }
  }
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
