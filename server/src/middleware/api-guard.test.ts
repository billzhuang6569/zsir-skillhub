import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import { Writable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { registerApiGuard, safeRequestLog, isInviteRequest } from './api-guard.js'
import { skillHubCorsOptions } from '../cors.js'
vi.mock('../db.js', () => ({ db: { user: { findUnique: vi.fn() } } }))
import { authMiddleware } from './auth.js'

const config = {
  SKILLHUB_PROFILE: 'yitan-official' as 'yitan-official' | 'selfhost', NODE_ENV: 'production' as const,
  PUBLIC_BASE_URL: 'https://api.example.test/skillhub', INSTANCE_ADDITIONAL_BASE_URLS: ['http://127.0.0.1:3001', 'https://[::1]:3443'],
  CORS_ORIGIN: 'tauri://localhost,http://tauri.localhost,https://tauri.localhost', YITAN_WEB_SUCCESS_URL: 'https://sk.woe.show/admin/',
}

async function appFor(profile = config.SKILLHUB_PROFILE) {
  const app = Fastify()
  registerApiGuard(app, { ...config, SKILLHUB_PROFILE: profile })
  await app.register(cors, skillHubCorsOptions(config.CORS_ORIGIN))
  await app.register(jwt, { secret: 'test-only-api-guard-secret' })
  for (const url of ['/health', '/ready', '/api/example', '/api/web-admin/session', '/api/marketplace/admin/keys', '/api/marketplace/home']) {
    app.get(url, async () => ({ ok: true }))
  }
  app.post('/api/marketplace/id/install-intents', async () => ({ ok: true }))
  app.get('/api/product', { onRequest: authMiddleware }, async () => ({ ok: true }))
  return app
}

describe('global product API guard', () => {
  it('accepts the website Host only in the official profile and rejects unrelated Hosts', async () => {
    const app = await appFor('yitan-official')
    try {
      for (const host of ['sk.woe.show', 'SK.WOE.SHOW:443']) {
        expect((await app.inject({ url: '/api/marketplace/home', headers: { host, origin: 'https://sk.woe.show' } })).statusCode).toBe(200)
        expect((await app.inject({ method: 'POST', url: '/api/marketplace/id/install-intents', headers: { host, origin: 'https://sk.woe.show' } })).statusCode).toBe(200)
      }
      for (const host of ['evil.test', 'sk.woe.show.evil.test', 'sk.woe.show:80']) {
        const response = await app.inject({ url: '/api/marketplace/home', headers: { host, origin: 'https://sk.woe.show' } })
        expect(response.statusCode, host).toBe(421)
        expect(response.json().code).toBe('HOST_MISMATCH')
      }
    } finally { await app.close() }
  })

  it('rejects the website Host in selfhost', async () => {
    const app = await appFor('selfhost')
    try {
      for (const host of ['sk.woe.show', 'sk.woe.show:443']) {
        const response = await app.inject({ url: '/api/example', headers: { host } })
        expect(response.statusCode, host).toBe(421)
        expect(response.json().code).toBe('HOST_MISMATCH')
      }
    } finally { await app.close() }
  })

  it('rejects forged Host regardless of forwarded headers and folds only scheme default ports', async () => {
    const app = await appFor()
    try {
      for (const host of ['evil.test', 'api.example.test:80', 'api.example.test.', 'api.example.test@evil.test', 'api.example.test/']) {
        const response = await app.inject({ url: '/api/example', headers: { host, 'x-forwarded-host': 'api.example.test' } })
        expect(response.statusCode, host).toBe(421)
        expect(response.json().code).toBe('HOST_MISMATCH')
      }
      for (const host of ['API.EXAMPLE.TEST', 'api.example.test:443', '127.0.0.1:3001', '[::1]:3443']) {
        expect((await app.inject({ url: '/api/example', headers: { host } })).statusCode, host).toBe(200)
      }
    } finally { await app.close() }
  })

  it.each(['selfhost', 'yitan-official'] as const)('permits GET/HEAD health probes with arbitrary Host in %s', async profile => {
    const app = await appFor(profile)
    try {
      for (const url of ['/health', '/ready?probe=1']) for (const method of ['GET', 'HEAD'] as const) {
        expect((await app.inject({ url, method, headers: { host: 'localhost:3001' } })).statusCode).toBe(200)
      }
      expect((await app.inject({ url: '/health', method: 'POST', headers: { host: 'evil.test' } })).statusCode).toBe(421)
    } finally { await app.close() }
  })

  it('blocks every selfhost browser Origin, including preflights, but permits native requests', async () => {
    const app = await appFor('selfhost')
    try {
      for (const origin of ['null', '', 'tauri://localhost', 'https://api.example.test', 'https://evil.test']) {
        for (const method of ['GET', 'OPTIONS'] as const) {
          const response = await app.inject({ url: '/api/example', method, headers: { host: 'api.example.test', origin, 'access-control-request-method': 'GET' } })
          expect(response.statusCode).toBe(403)
          expect(response.json().code).toBe('CROSS_SITE_REQUEST')
        }
      }
      expect((await app.inject({ url: '/api/example', headers: { host: 'api.example.test' } })).statusCode).toBe(200)
    } finally { await app.close() }
  })

  it('preserves official v0.31 CORS origins and exact website proxy origins', async () => {
    const app = await appFor()
    try {
      for (const origin of config.CORS_ORIGIN.split(',')) {
        const response = await app.inject({ url: '/api/example', headers: { host: 'api.example.test', origin } })
        expect(response.statusCode).toBe(200)
        expect(response.headers['access-control-allow-origin']).toBe(origin)
        expect((await app.inject({ url: '/api/example', method: 'OPTIONS', headers: { host: 'api.example.test', origin, 'access-control-request-method': 'GET' } })).statusCode).toBe(204)
      }
      for (const url of ['/api/web-admin/session', '/api/marketplace/admin/keys', '/api/marketplace/home', '/api/marketplace/id/install-intents']) {
        const method = url.endsWith('install-intents') ? 'POST' : 'GET'
        expect((await app.inject({ method, url, headers: { host: 'api.example.test', origin: 'https://sk.woe.show' } })).statusCode).toBe(200)
        expect((await app.inject({ method, url, headers: { host: 'api.example.test', origin: 'https://sk.woe.show.evil.test' } })).statusCode).toBe(403)
      }
      for (const origin of ['https://evil.test', 'tauri://localhost/', 'null']) {
        expect((await app.inject({ url: '/api/example', headers: { host: 'api.example.test', origin } })).statusCode).toBe(403)
      }
    } finally { await app.close() }
  })

  it.each(['selfhost', 'yitan-official'] as const)('does not authenticate a product API from an admin Cookie in %s', async profile => {
    const app = await appFor(profile)
    try {
      const cookie = app.jwt.sign({ sub: 'admin', ver: 0, webAdmin: true, purpose: 'web-admin' })
      expect((await app.inject({ url: '/api/product', headers: { host: 'api.example.test', cookie: `skillhub_admin_session=${cookie}` } })).statusCode).toBe(401)
    } finally { await app.close() }
  })

  it('redacts invite credentials in real Fastify request logs, including rejected requests', async () => {
    let logs = ''
    const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done() } })
    const app = Fastify({ disableRequestLogging: isInviteRequest, logger: { level: 'info', stream, serializers: { req: safeRequestLog } } })
    registerApiGuard(app, config)
    app.get('/invite/:token', async () => 'ok')
    try {
      for (const host of ['api.example.test', 'evil.test']) {
        await app.inject({ url: '/invite/secret-invite-token?server=also-secret', headers: { host } })
        await app.inject({ url: '/api/team-invites/secret-invite-token/not-found', headers: { host } })
        await app.inject({ url: '/%69nvite/secret-invite-token/not-found', headers: { host } })
      }
      expect(safeRequestLog({ url: '/invite/secret-invite-token' }).url).toContain('[REDACTED]')
      expect(logs).not.toContain('secret-invite-token')
      expect(logs).not.toContain('also-secret')
      const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
      expect(source.indexOf('registerApiGuard(server, config)')).toBeLessThan(source.indexOf('await server.register(cors'))
      expect(source).toContain('serializers: { req: safeRequestLog }')
      expect(source).toContain('disableRequestLogging: isInviteRequest')
    } finally { await app.close() }
  })
})
