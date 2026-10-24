import type { FastifyCorsOptions } from '@fastify/cors'

export const SKILL_PACKAGE_EXPOSED_HEADERS = [
  'X-Checksum-Sha256',
  'X-Skill-Version',
  'X-Skill-Version-Id',
] as const

export function skillHubCorsOptions(corsOrigin: string): FastifyCorsOptions {
  return {
    origin: corsOrigin.split(',').map((origin) => origin.trim()),
    credentials: true,
    // Expose back-off and request correlation headers to the desktop WebView.
    exposedHeaders: [...SKILL_PACKAGE_EXPOSED_HEADERS, 'Retry-After', 'X-Request-ID'],
  }
}
