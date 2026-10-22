// #186：两份条款的固定公开地址（页面由 #184 /privacy/、#185 /terms/ 制作）。
// 官网页尾使用同一组地址；不附加 JWT、账号 ID、追踪参数，游客也能打开。
import { OFFICIAL_ENDPOINTS } from './official-endpoints.ts'

export const LEGAL_PRIVACY_URL = `${OFFICIAL_ENDPOINTS.siteOrigin}/privacy/`
export const LEGAL_TERMS_URL = `${OFFICIAL_ENDPOINTS.siteOrigin}/terms/`

export type LegalLink = { readonly label: string; readonly url: string }

/** 设置「关于」第一行右侧按钮的顺序与文案。 */
export const LEGAL_LINKS: readonly LegalLink[] = [
  { label: '隐私与数据安全', url: LEGAL_PRIVACY_URL },
  { label: '使用条款', url: LEGAL_TERMS_URL },
]

/**
 * 在系统默认浏览器打开条款页面；失败只回报错误，不改变当前页面。
 * opener 与 onError 由调用方注入，便于脱离 Tauri 运行测试。
 */
export async function openLegalLink(
  link: LegalLink,
  opener: (url: string) => Promise<void>,
  onError: (message: string) => void,
  describeError: (error: unknown) => string,
): Promise<boolean> {
  try {
    await opener(link.url)
    return true
  } catch (error: unknown) {
    onError(`无法打开「${link.label}」：${describeError(error)}`)
    return false
  }
}
