import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { requestIdFromTrustedEdge } from './request-id.js'
import { skillHubCorsOptions } from '../cors.js'

function raw(remoteAddress: string, value: string | string[] | undefined): IncomingMessage {
  return { socket: { remoteAddress }, headers: { 'x-request-id': value } } as unknown as IncomingMessage
}

describe('request ID bridge', () => {
  it('uses only a canonical ID supplied by the loopback nginx hop', () => {
    const edgeId = 'a'.repeat(32)
    expect(requestIdFromTrustedEdge(raw('127.0.0.1', edgeId))).toBe(edgeId)
    expect(requestIdFromTrustedEdge(raw('::ffff:127.0.0.1', edgeId))).toBe(edgeId)
    expect(requestIdFromTrustedEdge(raw('203.0.113.4', edgeId))).not.toBe(edgeId)
    expect(requestIdFromTrustedEdge(raw('127.0.0.1', ['a'.repeat(32), 'b'.repeat(32)]))).not.toBe(edgeId)
    expect(requestIdFromTrustedEdge(raw('127.0.0.1', 'x'.repeat(200)))).toMatch(/^[0-9a-f]{32}$/)
  })

  it('exposes both the request ID and the existing back-off header to Desktop', () => {
    expect(skillHubCorsOptions('tauri://localhost').exposedHeaders).toEqual(expect.arrayContaining(['Retry-After', 'X-Request-ID']))
  })
})
