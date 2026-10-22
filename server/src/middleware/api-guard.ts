import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'

type GuardConfig = Pick<Config, 'PUBLIC_BASE_URL' | 'INSTANCE_ADDITIONAL_BASE_URLS' | 'SKILLHUB_PROFILE' | 'CORS_ORIGIN' | 'YITAN_WEB_SUCCESS_URL' | 'NODE_ENV'>

export function isAdminOrigin(origin: string, config: Pick<Config, 'YITAN_WEB_SUCCESS_URL' | 'NODE_ENV'>): boolean {
  if (origin === new URL(config.YITAN_WEB_SUCCESS_URL).origin) return true
  if (config.NODE_ENV === 'production') return false
  try {
    const url = new URL(origin)
    return ['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:'
  } catch { return false }
}

export function registerApiGuard(server: FastifyInstance, config: GuardConfig): void {
  const bases = [config.PUBLIC_BASE_URL, ...config.INSTANCE_ADDITIONAL_BASE_URLS].map(base => new URL(base))
  if (config.SKILLHUB_PROFILE === 'yitan-official') bases.push(new URL(config.YITAN_WEB_SUCCESS_URL))
  const origins = new Set(config.CORS_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean))
  server.addHook('onRequest', async (request, reply): Promise<void> => {
    const path = request.url.split('?')[0]
    const health = ['GET', 'HEAD'].includes(request.method) && ['/health', '/ready'].includes(path)
    const host = request.headers.host
    const authority = typeof host === 'string' ? /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?$/.exec(host) : null
    const matches = authority && bases.some(base => {
      const port = authority[2] ?? ''
      const normalizedPort = port === (base.protocol === 'https:' ? '443' : '80') ? '' : port
      return authority[1].toLowerCase() === base.hostname && normalizedPort === base.port
    })
    if (!health && !matches) return reply.code(421).send({ error: 'Host does not match this instance', code: 'HOST_MISMATCH' })
    const origin = request.headers.origin
    if (origin === undefined) return
    const admin = /^\/api\/(?:web-admin|marketplace\/admin)(?:\/|$)/.test(path)
    // The public website's same-origin proxy preserves Origin on install-intent POSTs.
    const publicStore = /^\/api\/marketplace(?:\/|$)/.test(path)
      && (['GET', 'HEAD'].includes(request.method) || /^\/api\/marketplace\/[^/]+\/install-intents$/.test(path))
    const allowed = config.SKILLHUB_PROFILE === 'yitan-official'
      && (origins.has(origin) || ((admin || publicStore) && isAdminOrigin(origin, config)))
    if (!allowed) return reply.code(403).send({ error: 'Browser origin is not allowed', code: 'CROSS_SITE_REQUEST' })
  })
}

// Fastify logs before onRequest, including rejected and unknown URLs. Never log raw URLs.
export function safeRequestLog(request: { method?: string; url?: string }): { method?: string; url: string } {
  return { method: request.method, url: (request.url ?? '').split('?')[0]
    .replace(/(\/(?:api\/team-invites|invite)\/)[^/]+/g, '$1[REDACTED]') }
}

export function isInviteRequest(request: { url?: string }): boolean {
  // Default 404/error log messages can also embed the raw URL outside the req serializer.
  try { return /\/(?:invite|team-invites)(?:\/|\?|$)/i.test(decodeURIComponent(request.url ?? '')) }
  catch { return true }
}
