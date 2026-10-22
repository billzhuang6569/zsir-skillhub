import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

const EDGE_REQUEST_ID = /^[0-9a-f]{32}$/

export function requestIdFromTrustedEdge(request: IncomingMessage): string {
  const remote = request.socket.remoteAddress
  const received = request.headers['x-request-id']
  if ((remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')
    && typeof received === 'string' && EDGE_REQUEST_ID.test(received)) {
    return received
  }
  return randomBytes(16).toString('hex')
}
