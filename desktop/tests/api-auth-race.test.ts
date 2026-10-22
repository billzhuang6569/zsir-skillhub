import { serverFixture } from './helpers/server-ipc.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  apiDeleteSkill, apiDownloadMarketplacePackage, apiGetMarketplace, apiGetMe, apiGetSkillTrash,
  apiGetTeams, apiImportSkill, apiLogout, apiMarkNotificationRead, apiRestoreSkill, apiUpdateProfile,
  normalizeTrustedServerOrigin, onApiUnauthorized,
} from '../src/lib/api.ts'
import { fixtureSpace } from './helpers/space.ts'
const setSpace = (label: string): void => { serverFixture.space = fixtureSpace(label) }

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => { values.delete(key) },
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

test('an old request 401 cannot clear a token written by a newer login', async () => {
  const browserGlobal = globalThis as typeof globalThis & { localStorage?: Storage }
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalFetch = serverFixture.fetch
  const storage = memoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })

  let resolveResponse: ((response: Response) => void) | null = null
  serverFixture.fetch = (() => new Promise<Response>((resolve) => { resolveResponse = resolve })) as typeof fetch
  let invalidations = 0
  const unsubscribe = onApiUnauthorized(() => { invalidations += 1 })
  try {
    setSpace('old.jwt')
    const oldRequest = apiGetTeams()
    await new Promise<void>(resolve => setImmediate(resolve))
    setSpace('new.jwt')
    if (!resolveResponse) throw new Error('fetch was not started')
    resolveResponse(new Response(JSON.stringify({ error: 'expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }))

    await assert.rejects(oldRequest, /Request aborted/)
    assert.deepEqual(serverFixture.space, fixtureSpace('new.jwt'))
    assert.equal(invalidations, 0)
  } finally {
    unsubscribe()
    serverFixture.fetch = originalFetch
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete browserGlobal.localStorage
  }
})

test('background Skill import stays bound to the session that started it', async () => {
  const browserGlobal = globalThis as typeof globalThis & { localStorage?: Storage }
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalFetch = serverFixture.fetch
  const storage = memoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  let authorization: string | null = null
  serverFixture.fetch = (async (_input, init) => {
    authorization = new Headers(init?.headers).get('Authorization')
    return new Response(JSON.stringify({ skill: {}, analysis: { status: 'completed' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  try {
    setSpace('account-b.jwt')
    await assert.rejects(apiImportSkill({
      name: 'sample',
      skillMd: '# Sample',
      compatibleAgents: [],
      envDependencies: [],
      currentVersion: 'v0.1.0',
      aiAnalysisConsent: true,
      packageBase64: 'UEs=',
      packageSha256: 'a'.repeat(64),
    }, fixtureSpace('account-a.jwt')), /Request aborted/)
    assert.equal(authorization, null)
    assert.deepEqual(serverFixture.space, fixtureSpace('account-b.jwt'))
  } finally {
    serverFixture.fetch = originalFetch
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete browserGlobal.localStorage
  }
})

test('public Marketplace browsing and package downloads never send or invalidate the account token', async () => {
  const browserGlobal = globalThis as typeof globalThis & { localStorage?: Storage }
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalFetch = serverFixture.fetch
  const storage = memoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  const requests: Array<{ url: string; authorization: string | null }> = []
  serverFixture.fetch = (async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('Authorization'),
    })
    if (String(input).endsWith('/package')) {
      return new Response(new Uint8Array([80, 75, 3, 4]), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'X-Checksum-Sha256': 'a'.repeat(64),
          'X-Skill-Version': '1.0.0',
        },
      })
    }
    return new Response(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 24 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  try {
    setSpace('current.jwt')
    await apiGetMarketplace({ query: 'Profile', agent: 'codex', sort: 'downloads', page: 1, featured: true })
    const packageData = await apiDownloadMarketplacePackage('11111111-1111-4111-8111-111111111111')
    assert.equal(requests.length, 2)
    assert.equal(requests[0]?.authorization, null)
    assert.equal(requests[1]?.authorization, null)
    assert.match(requests[0]?.url ?? '', /query=Profile/)
    assert.match(requests[0]?.url ?? '', /agent=codex/)
    assert.match(requests[0]?.url ?? '', /sort=downloads/)
    assert.match(requests[0]?.url ?? '', /featured=true/)
    await apiGetMarketplace({ featured: false, page: 2 })
    assert.match(requests[2]?.url ?? '', /featured=false/)
    assert.match(requests[2]?.url ?? '', /page=2/)
    assert.equal(packageData.sha256, 'a'.repeat(64))
    assert.equal(packageData.version, '1.0.0')
    assert.deepEqual(serverFixture.space, fixtureSpace('current.jwt'))
  } finally {
    serverFixture.fetch = originalFetch
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete browserGlobal.localStorage
  }
})

test('a timed-out session restore preserves the persisted token for retry', async () => {
  const browserGlobal = globalThis as typeof globalThis & { localStorage?: Storage }
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalFetch = serverFixture.fetch
  const storage = memoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  serverFixture.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })) as typeof fetch
  try {
    setSpace('valid.jwt')
    await assert.rejects(apiGetMe({ timeoutMs: 5 }), /Request timed out/)
    assert.deepEqual(serverFixture.space, fixtureSpace('valid.jwt'))
  } finally {
    serverFixture.fetch = originalFetch
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete browserGlobal.localStorage
  }
})

test('logout calls the protected server revocation endpoint before local cleanup', async () => {
  const browserGlobal = globalThis as typeof globalThis & { localStorage?: Storage }
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalFetch = serverFixture.fetch
  const storage = memoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  let method = ''
  let authorization = ''
  let contentType: string | null = null
  let requestBody: BodyInit | null | undefined
  serverFixture.fetch = (async (_input, init) => {
    method = init?.method ?? ''
    const headers = new Headers(init?.headers)
    authorization = headers.get('Authorization') ?? ''
    contentType = headers.get('Content-Type')
    requestBody = init?.body
    return new Response(null, { status: 204 })
  }) as typeof fetch
  try {
    setSpace('current.jwt')
    await apiLogout()
    assert.equal(method, 'POST')
    assert.equal(authorization, 'Bearer native.fixture')
    assert.equal(contentType, null)
    assert.equal(requestBody, undefined)
    assert.deepEqual(serverFixture.space, fixtureSpace('current.jwt'))
  } finally {
    serverFixture.fetch = originalFetch
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete browserGlobal.localStorage
  }
})

test('bodyless notification writes omit the JSON content type rejected by Fastify', async () => {
  const browserGlobal = globalThis as typeof globalThis & { localStorage?: Storage }
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalFetch = serverFixture.fetch
  const storage = memoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  let method = ''
  let contentType: string | null = null
  let requestBody: BodyInit | null | undefined
  serverFixture.fetch = (async (_input, init) => {
    method = init?.method ?? ''
    contentType = new Headers(init?.headers).get('Content-Type')
    requestBody = init?.body
    return new Response(JSON.stringify({
      id: 'notification-001', type: 'team_created', payload: {}, read: true,
      createdAt: '2026-08-03T00:00:00.000Z',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  try {
    setSpace('current.jwt')
    const notification = await apiMarkNotificationRead('notification-001')
    assert.equal(method, 'POST')
    assert.equal(contentType, null)
    assert.equal(requestBody, undefined)
    assert.equal(notification.read, true)
  } finally {
    serverFixture.fetch = originalFetch
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete browserGlobal.localStorage
  }
})

test('requests with a JSON body keep their content type and serialized payload', async () => {
  const browserGlobal = globalThis as typeof globalThis & { localStorage?: Storage }
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalFetch = serverFixture.fetch
  const storage = memoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  let contentType: string | null = null
  let requestBody: BodyInit | null | undefined
  serverFixture.fetch = (async (_input, init) => {
    contentType = new Headers(init?.headers).get('Content-Type')
    requestBody = init?.body
    return new Response(JSON.stringify({
      user: { id: 'user-001', email: 'user@example.com', displayName: '新名称', avatarUrl: null },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  try {
    setSpace('current.jwt')
    await apiUpdateProfile({ displayName: '新名称' })
    assert.equal(contentType, 'application/json')
    assert.equal(requestBody, JSON.stringify({ displayName: '新名称' }))
  } finally {
    serverFixture.fetch = originalFetch
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete browserGlobal.localStorage
  }
})

test('logout has a bounded request timeout and keeps the token when delivery is unknown', async () => {
  const browserGlobal = globalThis as typeof globalThis & { localStorage?: Storage }
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalFetch = serverFixture.fetch
  const storage = memoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  serverFixture.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })) as typeof fetch
  try {
    setSpace('current.jwt')
    await assert.rejects(apiLogout({ timeoutMs: 5 }), /Request timed out/)
    assert.deepEqual(serverFixture.space, fixtureSpace('current.jwt'))
  } finally {
    serverFixture.fetch = originalFetch
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete browserGlobal.localStorage
  }
})

test('asset deletion treats an already-missing remote as reconciled', async () => {
  const browserGlobal = globalThis as typeof globalThis & { localStorage?: Storage }
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalFetch = serverFixture.fetch
  const storage = memoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  let requestedUrl = ''
  let requestedMethod = ''
  let requestedContentType: string | null = null
  let requestedBody: BodyInit | null | undefined
  serverFixture.fetch = (async (input, init) => {
    requestedUrl = String(input)
    requestedMethod = init?.method ?? 'GET'
    requestedContentType = new Headers(init?.headers).get('Content-Type')
    requestedBody = init?.body
    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  try {
    setSpace('current.jwt')
    await apiDeleteSkill('11111111-1111-4111-8111-111111111111')
    assert.match(requestedUrl, /\/api\/skills\/11111111-1111-4111-8111-111111111111$/)
    assert.equal(requestedMethod, 'DELETE')
    assert.equal(requestedContentType, null)
    assert.equal(requestedBody, undefined)
    assert.deepEqual(serverFixture.space, fixtureSpace('current.jwt'))
  } finally {
    serverFixture.fetch = originalFetch
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete browserGlobal.localStorage
  }
})

test('account recycle-bin list and restore use authenticated bodyless routes', async () => {
  const browserGlobal = globalThis as typeof globalThis & { localStorage?: Storage }
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalFetch = serverFixture.fetch
  const storage = memoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  const requests: Array<{ url: string; method: string; contentType: string | null; body: BodyInit | null | undefined }> = []
  serverFixture.fetch = (async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      contentType: new Headers(init?.headers).get('Content-Type'),
      body: init?.body,
    })
    return new Response(JSON.stringify(requests.length === 1 ? [] : {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'restored',
      displayName: 'Restored',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  try {
    setSpace('current.jwt')
    await apiGetSkillTrash()
    await apiRestoreSkill('11111111-1111-4111-8111-111111111111')
    assert.match(requests[0]?.url ?? '', /\/api\/skills\/trash$/)
    assert.equal(requests[0]?.method, 'GET')
    assert.match(requests[1]?.url ?? '', /\/api\/skills\/11111111-1111-4111-8111-111111111111\/restore$/)
    assert.equal(requests[1]?.method, 'POST')
    assert.equal(requests[1]?.contentType, null)
    assert.equal(requests[1]?.body, undefined)
  } finally {
    serverFixture.fetch = originalFetch
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete browserGlobal.localStorage
  }
})

test('trusted server origin requires HTTPS and strips trailing slashes', () => {
  assert.equal(
    normalizeTrustedServerOrigin('https://api.example.test/skillhub///'),
    'https://api.example.test/skillhub',
  )
  assert.throws(() => normalizeTrustedServerOrigin('http://api.example.test/skillhub'), /trusted HTTPS/)
  assert.throws(() => normalizeTrustedServerOrigin('https://user@api.example.test/skillhub'), /trusted HTTPS/)
  assert.throws(() => normalizeTrustedServerOrigin('https://api.example.test/skillhub?next=internal'), /trusted HTTPS/)
})
