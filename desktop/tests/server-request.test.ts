import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/lib/tauri.ts') && specifier === './env-readiness.js') {
    return nextResolve('./env-readiness.ts', context)
  }
  return nextResolve(specifier, context)
} })
const { currentSpace, serverRequest, cancelServerRequest } = await import('../src/lib/tauri.ts')
hooks.deregister()

test('server IPC wrappers preserve JSON, decode binary metadata, and bind cancellation to a handle', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const space = { spaceId: 'official', generation: 7 }
  const request = { requestId: 'request-1', space, route: 'health' as const, timeoutMs: 500 }
  let wire: unknown = { status: 429, headers: { 'retry-after': '2' }, body: { kind: 'json', value: { error: 'busy' } } }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: unknown): Promise<unknown> => {
      if (command === 'current_space') return space
      if (command === 'cancel_server_request') {
        assert.deepEqual(args, { space, requestId: request.requestId })
        return true
      }
      assert.equal(command, 'server_request')
      assert.deepEqual(args, { request })
      return wire
    } },
  } })
  try {
    assert.deepEqual(await currentSpace(), space)
    assert.deepEqual(await serverRequest(request), wire)
    const metadata = new TextEncoder().encode(JSON.stringify({ status: 200, headers: { 'x-request-id': 'r' }, body: { kind: 'empty' } }))
    const bytes = new Uint8Array([0, 255, 128])
    const frame = new Uint8Array(4 + metadata.length + bytes.length)
    new DataView(frame.buffer).setUint32(0, metadata.length, true)
    frame.set(metadata, 4)
    frame.set(bytes, 4 + metadata.length)
    for (const nativeResponse of [frame.buffer, Array.from(frame)]) {
      wire = nativeResponse
      assert.deepEqual(await serverRequest(request), {
        status: 200, headers: { 'x-request-id': 'r' }, body: { kind: 'bytes', value: bytes },
      })
    }
    assert.equal(await cancelServerRequest(space, request.requestId), true)
    for (const invalid of [new ArrayBuffer(2), new Uint8Array([255, 255, 255, 255]).buffer]) {
      wire = invalid
      await assert.rejects(serverRequest(request), /二进制响应格式无效/)
    }
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
