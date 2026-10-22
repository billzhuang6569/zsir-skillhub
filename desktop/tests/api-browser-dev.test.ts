import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

test('browser DEV and production both require IPC and cannot fall back to fetch', async () => {
  // Supply Vite's compile-time values to the Node TS runner, with no live server.
  const hooks = registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith('/src/lib/api.ts?browser-dev')) return result
    return { ...result, source: String(result.source)
      .replace('(import.meta as ImportMeta & { env?: ImportMetaEnv }).env', "({ DEV: true, VITE_SKILLHUB_SERVER_ORIGIN: 'http://127.0.0.1:3001' })")
      .replace('import.meta.env?.DEV', 'true') }
  } })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  let calls = 0
  Reflect.deleteProperty(globalThis, 'window')
  globalThis.fetch = async (input, init): Promise<Response> => {
    calls++
    assert.equal(String(input), 'http://127.0.0.1:3001/api/skills/id')
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer explicit.jwt')
    return new Response('{"id":"id"}', { headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const dev = await import('../src/lib/api.ts?browser-dev') as typeof import('../src/lib/api.ts')
    await assert.rejects(dev.apiGetSkill('id'), /window|undefined/)
    assert.equal(calls, 0)
    const production = await import('../src/lib/api.ts')
    await assert.rejects(production.apiGetSkill('id'), (error: unknown) =>
      error instanceof production.ApiError && error.kind === 'network')
    assert.equal(calls, 0)
  } finally {
    hooks.deregister()
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
