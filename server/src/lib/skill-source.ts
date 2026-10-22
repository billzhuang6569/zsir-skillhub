import { z } from 'zod'

/** Omission preserves a prior value; explicit null/blank clears it. */
export const SkillSourceUrlSchema = z.string().trim().max(2048).refine(value => {
  if (!value) return true
  try {
    const url = new URL(value)
    return /^https?:\/\//i.test(value) && ['http:', 'https:'].includes(url.protocol)
      && Boolean(url.hostname) && !url.username && !url.password && !/[\s\\<>"\u0000-\u001f]/.test(value)
  } catch { return false }
}, '来源须为不含账号密码的 HTTP/HTTPS 网址').transform(value => value || null).nullable().optional()
