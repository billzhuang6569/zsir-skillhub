import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

const MAX_SCAN_BYTES = 4 * 1024 * 1024
const REQUEST_ID = /^[0-9a-f]{32}$/
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OTHER'])
const ROUTES = new Set(['auth', 'admin', 'skills', 'library', 'marketplace', 'runtime', 'updates', 'downloads', 'other'])

export type GatewayEvent = {
  time: string
  requestId: string
  method: string
  route: string
  status: number
  upstreamStatus: string | null
  requestTimeMs: number
}

export type GatewayRead = {
  status: 'ok' | 'unknown'
  events: GatewayEvent[]
  scannedBytes: number
  truncated: boolean
  malformedRows: number
  reasonCode?: string
}

function parseLine(line: string): GatewayEvent | null {
  if (line.length > 2_048) return null
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.time !== 'string' || !Number.isFinite(Date.parse(row.time))
    || typeof row.requestId !== 'string' || !REQUEST_ID.test(row.requestId)
    || typeof row.method !== 'string' || !METHODS.has(row.method)
    || typeof row.route !== 'string' || !ROUTES.has(row.route)
    || typeof row.status !== 'number' || !Number.isInteger(row.status) || row.status < 100 || row.status > 599
    || typeof row.requestTime !== 'number' || !Number.isFinite(row.requestTime) || row.requestTime < 0 || row.requestTime > 3_600) return null
  const upstreamStatus = typeof row.upstreamStatus === 'string' && /^(?:[1-5][0-9]{2}(?:, [1-5][0-9]{2})*)$/.test(row.upstreamStatus)
    ? row.upstreamStatus : null
  return {
    time: row.time,
    requestId: row.requestId,
    method: row.method,
    route: row.route,
    status: row.status,
    upstreamStatus,
    requestTimeMs: Math.round(row.requestTime * 1_000),
  }
}

async function readTail(path: string, budget: number): Promise<{ lines: string[]; scanned: number; truncated: boolean; missing: boolean }> {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { lines: [], scanned: 0, truncated: false, missing: true }
    }
    throw error
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error('INVALID_GATEWAY_LOG')
    const scanned = Math.min(stat.size, budget)
    const start = stat.size - scanned
    const buffer = Buffer.alloc(scanned)
    const result = await file.read(buffer, 0, scanned, start)
    const text = buffer.subarray(0, result.bytesRead).toString('utf8')
    const lines = text.split(String.fromCharCode(10))
    if (start > 0) lines.shift()
    if (!text.endsWith(String.fromCharCode(10))) lines.pop()
    return { lines, scanned: result.bytesRead, truncated: start > 0, missing: false }
  } finally {
    await file.close()
  }
}

export async function readGatewayEvents(
  path: string,
  options: { from: Date; until: Date; requestId?: string; status?: number; limit?: number },
): Promise<GatewayRead> {
  const limit = Math.min(500, Math.max(1, options.limit ?? 100))
  let scannedBytes = 0
  let truncated = false
  let foundFile = false
  let validRows = 0
  let malformedRows = 0
  const events: GatewayEvent[] = []
  let atCapacity = false
  try {
    for (const file of [path, path + '.1']) {
      const remaining = MAX_SCAN_BYTES - scannedBytes
      if (remaining <= 0) { truncated = true; break }
      const tail = await readTail(file, remaining)
      if (tail.missing) continue
      foundFile = true
      scannedBytes += tail.scanned
      truncated ||= tail.truncated
      for (let index = tail.lines.length - 1; index >= 0; index -= 1) {
        const event = parseLine(tail.lines[index])
        if (!event) {
          if (tail.lines[index].trim()) malformedRows += 1
          continue
        }
        validRows += 1
        const time = Date.parse(event.time)
        if (time < options.from.getTime() || time > options.until.getTime()) continue
        if (options.requestId && event.requestId !== options.requestId) continue
        if (options.status !== undefined && event.status !== options.status) continue
        if (!options.requestId && event.status < 400) continue
        events.push(event)
        if (events.length > limit) { atCapacity = true; break }
      }
      if (atCapacity) break
    }
  } catch {
    return { status: 'unknown', events: [], scannedBytes, truncated: true, malformedRows, reasonCode: 'GATEWAY_LOG_UNAVAILABLE' }
  }
  if (!foundFile) return { status: 'unknown', events: [], scannedBytes, truncated: false, malformedRows, reasonCode: 'GATEWAY_LOG_MISSING' }
  if (validRows === 0 && malformedRows > 0) {
    return { status: 'unknown', events: [], scannedBytes, truncated, malformedRows, reasonCode: 'GATEWAY_LOG_MALFORMED' }
  }
  if (atCapacity) { events.length = limit; truncated = true }
  return { status: 'ok', events, scannedBytes, truncated, malformedRows }
}
