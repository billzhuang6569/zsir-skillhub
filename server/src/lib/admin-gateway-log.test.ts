import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readGatewayEvents } from './admin-gateway-log.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('bounded gateway diagnostics', () => {
  it('returns only fixed safe fields from recent rejection records', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'skillhub-gateway-test-'))
    directories.push(directory)
    const path = join(directory, 'gateway.jsonl')
    const id = 'a'.repeat(32)
    const row = {
      time: new Date().toISOString(), requestId: id, method: 'GET', route: 'skills',
      status: 429, upstreamStatus: '-', requestTime: 0.125,
      url: '/api/skills?token=secret', ip: '203.0.113.1', authorization: 'Bearer secret',
    }
    writeFileSync(path, JSON.stringify(row) + String.fromCharCode(10))
    const result = await readGatewayEvents(path, {
      from: new Date(Date.now() - 60_000), until: new Date(Date.now() + 60_000),
    })
    expect(result.status).toBe('ok')
    expect(result.events).toEqual([{
      time: row.time, requestId: id, method: 'GET', route: 'skills',
      status: 429, upstreamStatus: null, requestTimeMs: 125,
    }])
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('rejects symlinked files and does not read their contents', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'skillhub-gateway-test-'))
    directories.push(directory)
    const real = join(directory, 'real.jsonl')
    const link = join(directory, 'gateway.jsonl')
    writeFileSync(real, 'sensitive')
    symlinkSync(real, link)
    const result = await readGatewayEvents(link, {
      from: new Date(Date.now() - 60_000), until: new Date(Date.now() + 60_000),
    })
    expect(result).toMatchObject({ status: 'unknown', events: [], reasonCode: 'GATEWAY_LOG_UNAVAILABLE' })
  })

  it('uses one rotated file, ignores malformed rows and reports result truncation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'skillhub-gateway-test-'))
    directories.push(directory)
    const path = join(directory, 'gateway.jsonl')
    const now = new Date().toISOString()
    const row = (requestId: string, status: number): string => JSON.stringify({
      time: now, requestId, method: 'GET', route: 'skills', status,
      upstreamStatus: '-', requestTime: 0.01,
    })
    writeFileSync(path, [row('a'.repeat(32), 429), 'not-json', row('b'.repeat(32), 200)].join('\n') + '\n')
    writeFileSync(path + '.1', row('c'.repeat(32), 503) + '\n')
    const window = { from: new Date(Date.now() - 60_000), until: new Date(Date.now() + 60_000) }
    const all = await readGatewayEvents(path, { ...window, limit: 10 })
    expect(all.events.map(event => event.requestId)).toEqual(['a'.repeat(32), 'c'.repeat(32)])
    expect(all.truncated).toBe(false)
    expect(all.malformedRows).toBe(1)
    const limited = await readGatewayEvents(path, { ...window, limit: 1 })
    expect(limited.events).toHaveLength(1)
    expect(limited.truncated).toBe(true)
    const oneRequest = await readGatewayEvents(path, { ...window, requestId: 'b'.repeat(32) })
    expect(oneRequest.events).toMatchObject([{ status: 200 }])
  })

  it('reports unknown when an existing log has only malformed rows', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'skillhub-gateway-test-'))
    directories.push(directory)
    const path = join(directory, 'gateway.jsonl')
    writeFileSync(path, 'not-json\n')
    const result = await readGatewayEvents(path, {
      from: new Date(Date.now() - 60_000), until: new Date(Date.now() + 60_000),
    })
    expect(result).toMatchObject({
      status: 'unknown', events: [], malformedRows: 1, reasonCode: 'GATEWAY_LOG_MALFORMED',
    })
  })
})
