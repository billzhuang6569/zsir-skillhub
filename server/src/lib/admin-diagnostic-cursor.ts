import { createHmac, timingSafeEqual } from 'node:crypto'

export type DiagnosticPosition = {
  keyId: string
  from: string
  until: string
  status: number | null
  limit: number
  createdAt: string
  id: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update('admin-diagnostic-cursor-v1:').update(payload).digest('base64url')
}

export function encodeDiagnosticCursor(position: DiagnosticPosition, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...position })).toString('base64url')
  return payload + '.' + signature(payload, secret)
}

export function decodeDiagnosticCursor(cursor: string, keyId: string, secret: string): DiagnosticPosition | null {
  if (cursor.length > 900 || !/^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/.test(cursor)) return null
  const [payload, provided] = cursor.split('.')
  const expected = signature(payload, secret)
  const left = Buffer.from(provided, 'ascii')
  const right = Buffer.from(expected, 'ascii')
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null
  let value: unknown
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.v !== 1 || row.keyId !== keyId || typeof row.from !== 'string' || !ISO.test(row.from)
    || typeof row.until !== 'string' || !ISO.test(row.until)
    || (row.status !== null && (typeof row.status !== 'number' || !Number.isInteger(row.status) || row.status < 400 || row.status > 599))
    || typeof row.limit !== 'number' || !Number.isInteger(row.limit) || row.limit < 1 || row.limit > 500
    || typeof row.createdAt !== 'string' || !ISO.test(row.createdAt)
    || typeof row.id !== 'string' || !UUID.test(row.id)) return null
  return {
    keyId,
    from: row.from,
    until: row.until,
    status: row.status as number | null,
    limit: row.limit,
    createdAt: row.createdAt,
    id: row.id,
  }
}
