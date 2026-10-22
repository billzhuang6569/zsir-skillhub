import { beforeEach, afterEach } from 'node:test'
import routes from '../../src/lib/server-routes.json' with { type: 'json' }
import type { SpaceHandle, ServerRequest } from '../../src/lib/tauri.ts'
import type { ServerRouteDefinition } from '../../src/lib/server-routes.ts'

// Preserve existing HTTP fixtures/assertions while exercising the real IPC adapter.
// This never invokes global fetch or opens a socket.
const pending = new Map<string, AbortController>()
export const serverFixture = {
  space: { spaceId: 'official', generation: 0 } as SpaceHandle,
  userId: 'fixture-user' as string | null,
  fetch: (async (): Promise<Response> => { throw new Error('Missing server fixture') }) as typeof fetch,
  async invoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (command === 'current_space') return serverFixture.space
    if (command === 'current_media_space') return { space: serverFixture.space, serverBase: 'https://fixture.invalid', mediaKey: `official_fixture_${serverFixture.space.generation}` }
    if (command === 'auth_state') return { ...serverFixture.space, userId: serverFixture.userId, pending: false }
    if (command === 'clear_auth_session') {
      const space = args.space as SpaceHandle
      if (space.generation !== serverFixture.space.generation) return null
      serverFixture.userId = null
      serverFixture.space = { ...space, generation: space.generation + 1 }
      return serverFixture.space
    }
    if (command === 'cancel_server_request') {
      pending.get(String(args.requestId))?.abort()
      return true
    }
    if (command !== 'server_request') throw new Error(`Unexpected command: ${command}`)
    const request = args.request as ServerRequest
    if (request.space.generation !== serverFixture.space.generation) throw 'SkillHub 空间或账号已切换，本次请求结果已丢弃'
    const definition: ServerRouteDefinition = routes[request.route]
    if (definition.auth && !serverFixture.userId) throw '请先在 SkillHub APP 登录'
    const path = definition.path.replace(/:([\w]+)/g, (_match, key: string) => encodeURIComponent(request.params?.[key] ?? ''))
    const search = new URLSearchParams(request.query).toString()
    const controller = new AbortController()
    pending.set(request.requestId, controller)
    try {
      const response = await serverFixture.fetch(`https://fixture.invalid${path}${search ? `?${search}` : ''}`, {
        method: definition.method,
        headers: {
          ...((definition.auth || definition.optional) && serverFixture.userId ? { Authorization: 'Bearer native.fixture' } : {}),
          ...(request.body?.kind === 'json' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: request.body?.kind === 'json' ? JSON.stringify(request.body.value) : undefined,
        signal: controller.signal,
      })
      const bytes = new Uint8Array(await response.arrayBuffer())
      const metadata = new TextEncoder().encode(JSON.stringify({ status: response.status, statusText: response.statusText,
        headers: Object.fromEntries(response.headers), body: { kind: 'empty' } }))
      if (!bytes.length) return JSON.parse(new TextDecoder().decode(metadata)) as unknown
      const frame = new Uint8Array(4 + metadata.length + bytes.length)
      new DataView(frame.buffer).setUint32(0, metadata.length, true)
      frame.set(metadata, 4)
      frame.set(bytes, 4 + metadata.length)
      return frame.buffer
    } finally { pending.delete(request.requestId) }
  },
}

let originalWindow: PropertyDescriptor | undefined
beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: serverFixture.invoke },
  } })
})
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})
