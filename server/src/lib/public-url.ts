import { config } from '../config.js'

export function publicUrl(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Public URL path must be an absolute path')
  }
  return `${config.PUBLIC_BASE_URL}${path}`
}
