import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { serverFixture } from './helpers/server-ipc.ts'
import { restoreNativeAuth, shouldRenewSession } from '../src/lib/auth-restore.ts'
import { AUTH_TOKEN_STORAGE_KEY } from '../src/lib/auth.ts'
import { apiSubmitFeedback, apiCreateMarketplaceInstallIntent, apiFinishMarketplaceInstallIntent, onApiUnauthorized } from '../src/lib/api.ts'

test('renewal window uses strict half-life and 30-day boundaries and tolerates old servers', () => {
  const day = 86400000
  const issuedAt = new Date(0).toISOString()
  const expiresAt = new Date(100 * day).toISOString()
  assert.equal(shouldRenewSession({ issuedAt, expiresAt, now: 50 * day }), false)
  assert.equal(shouldRenewSession({ issuedAt, expiresAt, now: 50 * day + 1 }), true)
  const shortExpiry = new Date(40 * day).toISOString()
  assert.equal(shouldRenewSession({ issuedAt, expiresAt: shortExpiry, now: 10 * day }), false)
  assert.equal(shouldRenewSession({ issuedAt, expiresAt: shortExpiry, now: 10 * day + 1 }), true)
  assert.equal(shouldRenewSession({ issuedAt, expiresAt, now: 101 * day }), true)
  for (const fields of [{}, { issuedAt }, { expiresAt }, { issuedAt: 'invalid', expiresAt }, { issuedAt, expiresAt: issuedAt }]) {
    assert.equal(shouldRenewSession({ ...fields, now: 0 }), false)
  }
})

test('restore renews once in the same space and returns the committed generation', async () => {
  serverFixture.userId = 'fixture-user'
  const original = { ...serverFixture.space }
  let renewals = 0
  serverFixture.fetch = async (input, init) => {
    if (String(input).endsWith('/renew')) {
      renewals++
      assert.equal(init?.method, 'POST')
      assert.deepEqual(serverFixture.space, original)
      serverFixture.space = { ...original, generation: original.generation + 1 }
      return new Response(JSON.stringify({ user: { id: 'fixture-user' }, space: serverFixture.space }))
    }
    return new Response(JSON.stringify({ user: { id: 'fixture-user' }, tokenIssuedAt: new Date(Date.now() - 86400000).toISOString(), tokenExpiresAt: new Date(Date.now() + 86400000).toISOString() }))
  }
  // Model the native session effect's response envelope as well as its JSON body.
  const invoke = serverFixture.invoke
  window.__TAURI_INTERNALS__ = { invoke: async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    if (command === 'server_request' && (args.request as { route: string }).route === 'auth.renew') {
      await serverFixture.fetch('https://fixture.invalid/api/auth/renew', { method: 'POST' })
      return { status: 200, statusText: 'OK', headers: {}, space: serverFixture.space, body: { kind: 'json', value: { user: { id: 'fixture-user' }, space: serverFixture.space } } }
    }
    return invoke(command, args)
  } }
  assert.deepEqual((await restoreNativeAuth())?.space, serverFixture.space)
  assert.deepEqual((await restoreNativeAuth({ allowRenew: false }))?.space, serverFixture.space)
  assert.equal(renewals, 1)
  serverFixture.userId = 'switched-user'
  serverFixture.space = { ...serverFixture.space, generation: serverFixture.space.generation + 1 }
  serverFixture.fetch = async input => {
    assert.ok(String(input).endsWith('/me'))
    return new Response(JSON.stringify({ user: { id: 'switched-user' }, tokenIssuedAt: new Date(Date.now() - 86400000).toISOString(), tokenExpiresAt: new Date(Date.now() + 86400000).toISOString() }))
  }
  assert.equal((await restoreNativeAuth({ allowRenew: false }))?.user.id, 'switched-user')
})

test('renewal network failure preserves restored auth; renewal 401 follows existing logout rules', async () => {
  for (const status of [503, 401]) {
    serverFixture.userId = 'fixture-user'
    const original = { ...serverFixture.space }
    let renewals = 0
    serverFixture.fetch = async input => {
      if (String(input).endsWith('/renew')) {
        renewals++
        return new Response('{}', { status })
      }
      return new Response(JSON.stringify({ user: { id: 'fixture-user' }, tokenIssuedAt: new Date(Date.now() - 86400000).toISOString(), tokenExpiresAt: new Date(Date.now() + 86400000).toISOString() }))
    }
    const result = await restoreNativeAuth()
    assert.equal(renewals, 1)
    if (status === 401) assert.equal(result, null)
    else { assert.equal(result?.user.id, 'fixture-user'); assert.deepEqual(result?.space, original) }
  }
})

test('restore never renews when the validated session becomes pending or changes', async () => {
  for (const change of ['pending', 'account', 'space'] as const) {
    serverFixture.userId = 'fixture-user'
    let validated = false
    let renewals = 0
    const invoke = serverFixture.invoke
    window.__TAURI_INTERNALS__ = { invoke: async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      if (command === 'auth_state' && validated) return {
        ...serverFixture.space, generation: serverFixture.space.generation + (change === 'space' ? 1 : 0),
        userId: change === 'account' ? 'other-user' : 'fixture-user', pending: change === 'pending',
      }
      return invoke(command, args)
    } }
    serverFixture.fetch = async input => {
      if (String(input).endsWith('/renew')) renewals++
      validated = true
      return new Response(JSON.stringify({ user: { id: 'fixture-user' }, tokenIssuedAt: new Date(Date.now() - 86400000).toISOString(), tokenExpiresAt: new Date(Date.now() + 86400000).toISOString() }))
    }
    await assert.rejects(restoreNativeAuth(), /Request aborted/)
    assert.equal(renewals, 0)
  }
})

test('optional routes attach the signed-in identity and accept guests without prompting for login', async () => {
  let unauthorized = 0
  const unsubscribe = onApiUnauthorized(() => { unauthorized++ })
  const originalUser = serverFixture.userId
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (): string => 'fixture-client',
  } })
  try {
    for (const userId of ['fixture-user', null]) {
      serverFixture.userId = userId
      let requests = 0
      serverFixture.fetch = async (_input, init): Promise<Response> => {
        requests++
        assert.equal(new Headers(init?.headers).get('Authorization'), userId ? 'Bearer native.fixture' : null)
        return new Response(JSON.stringify({ id: 'created' }))
      }
      const feedback = await apiSubmitFeedback({ type: 'bug', content: 'Guest feedback', clientOperationId: 'fixture-operation' })
      assert.equal(feedback.id, 'created')
      await apiCreateMarketplaceInstallIntent('skill', 'fixture-operation')
      await apiFinishMarketplaceInstallIntent('intent', 'completed')
      assert.equal(requests, 3)
    }
    assert.equal(unauthorized, 0)
  } finally {
    serverFixture.userId = originalUser
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
    unsubscribe()
  }
})

test('startup imports a valid legacy credential after recovering a corrupt native session', async () => {
  const originalInvoke = serverFixture.invoke
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const saved = new Map([[AUTH_TOKEN_STORAGE_KEY, 'legacy.fixture']])
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string): string | null => saved.get(key) ?? null,
    removeItem: (key: string): void => { saved.delete(key) },
  } })
  let firstState = true
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {
    invoke: async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    if (command === 'auth_state' && firstState) {
      firstState = false
      return { ...serverFixture.space, userId: null, pending: false, error: 'corrupt session recovered' }
    }
    if (command === 'import_legacy_auth') {
      assert.equal(args?.token, 'legacy.fixture')
      serverFixture.userId = 'imported-user'
      serverFixture.space = { ...serverFixture.space, generation: serverFixture.space.generation + 1 }
      return true
    }
    return originalInvoke(command, args)
    },
  } })
  serverFixture.fetch = async () => new Response(JSON.stringify({ user: { id: 'imported-user' } }))
  try {
    assert.equal((await restoreNativeAuth())?.user.id, 'imported-user')
    assert.equal(saved.has(AUTH_TOKEN_STORAGE_KEY), false)
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('startup restores the native user without exposing a credential', async () => {
  serverFixture.userId = 'fixture-user'
  serverFixture.fetch = async () => new Response(JSON.stringify({ user: { id: 'fixture-user', displayName: 'Fixture' } }))
  const result = await restoreNativeAuth()
  assert.equal(result?.user.id, 'fixture-user')
  assert.deepEqual(result?.space, serverFixture.space)
  assert.equal('token' in result!, false)
})

test('startup 401 clears the matching native generation and becomes guest', async () => {
  serverFixture.userId = 'fixture-user'
  const generation = serverFixture.space.generation
  serverFixture.fetch = async () => new Response('{"error":"Unauthorized"}', { status: 401 })
  assert.equal(await restoreNativeAuth(), null)
  assert.equal(serverFixture.userId, null)
  assert.equal(serverFixture.space.generation, generation + 1)
})

test('startup network failure preserves the native session for retry', async () => {
  serverFixture.userId = 'fixture-user'
  const space = serverFixture.space
  serverFixture.fetch = async () => { throw new Error('offline') }
  await assert.rejects(restoreNativeAuth(), /offline/)
  assert.equal(serverFixture.space, space)
  assert.equal(serverFixture.userId, 'fixture-user')
})

test('frontend credentials exist only in the one-time legacy import helper', () => {
  function check(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) check(path)
      else if (/\.tsx?$/.test(path)) {
        const source = readFileSync(path, 'utf8')
        assert.doesNotMatch(source, /readStoredAuthToken|writeStoredAuthToken|requestToken|legacyAuthToken/)
        if (path !== 'src/lib/auth.ts') assert.doesNotMatch(source, /yitan-skillhub\.auth-token|AUTH_TOKEN_STORAGE_KEY|import_legacy_auth/)
      }
    }
  }
  check('src')
  assert.doesNotMatch(readFileSync('src/lib/tauri.ts', 'utf8'), /authToken|\bbearer\b|\btoken\b/)
  assert.doesNotMatch(readFileSync('src/lib/api.ts', 'utf8'), /Authorization|\bbearer\b/)
})
