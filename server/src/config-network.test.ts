import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'

const original = getDefaultAutoSelectFamilyAttemptTimeout()
afterEach(() => { setDefaultAutoSelectFamilyAttemptTimeout(original); vi.unstubAllEnvs(); vi.resetModules() })

it.each([250, 5000])('applies a connection window floor on service and CLI config load (%i ms)', async (initial) => {
  vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test')
  vi.stubEnv('JWT_SECRET', 'test-secret-longer-than-sixteen-characters')
  vi.stubEnv('CREDENTIAL_KEK_BASE64', Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64'))
  setDefaultAutoSelectFamilyAttemptTimeout(initial)
  await import('./config.js')
  expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(initial < 2000 ? 2000 : initial)
})
