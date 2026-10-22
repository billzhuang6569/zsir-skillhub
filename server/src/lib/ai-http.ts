import { lookup } from 'node:dns/promises'
import { isIP, BlockList } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export class AiServiceError extends Error {
  constructor(readonly code: string, readonly statusCode = 400) {
    super(code)
  }
}

const privateNetworks = new BlockList()
const transitionNetworks = new BlockList()
for (const [address, prefix] of [['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16], ['2001::', 32]] as const) {
  transitionNetworks.addSubnet(address, prefix, 'ipv6')
}
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10],
  ['192.0.0.0', 24], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) privateNetworks.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['::', 96], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  // Transition mechanisms can tunnel an otherwise blocked IPv4 destination.
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16], ['2001::', 32],
] as const) privateNetworks.addSubnet(address, prefix, 'ipv6')

export function normalizedIp(input: string): string {
  const address = input.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(address) !== 6) return address
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1)
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical)
  if (!mapped) return canonical
  const number = parseInt(mapped[1], 16) * 65536 + parseInt(mapped[2], 16)
  return [24, 16, 8, 0].map(shift => (number >>> shift) & 255).join('.')
}

export function isMetadataIp(input: string): boolean {
  const address = normalizedIp(input)
  return address === '169.254.169.254' || address === '169.254.170.2'
    || address === '100.100.100.200' || address === 'fd00:ec2::254'
}

export function isPrivateIp(input: string): boolean {
  const address = normalizedIp(input)
  const family = isIP(address)
  return !family || privateNetworks.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

export function normalizeAiBaseUrl(input: string): string {
  let url: URL
  try { url = new URL(input) } catch { throw new AiServiceError('INVALID_BASE_URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AiServiceError('INVALID_BASE_URL')
  }
  return url.toString().replace(/\/+$/, '')
}

export function normalizeAllowedHost(input: string): string {
  if (/[\s/@?#\\]/.test(input)) throw new AiServiceError('INVALID_ALLOWED_HOST')
  let url: URL
  try { url = new URL(`http://${input}`) } catch { throw new AiServiceError('INVALID_ALLOWED_HOST') }
  if (url.pathname !== '/') throw new AiServiceError('INVALID_ALLOWED_HOST')
  // Preserve an explicit :80; host-only entries intentionally allow any port.
  return `${url.hostname}${url.port ? `:${url.port}` : input.endsWith(':80') ? ':80' : ''}`
}

export async function checkedAiTarget(url: URL, allowedPrivateHosts: string[]): Promise<{ address: string; family: number }> {
  normalizeAiBaseUrl(url.toString())
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  const allowed = allowedPrivateHosts.some(entry => entry === url.hostname || entry === `${url.hostname}:${port}`)
  if (url.protocol === 'http:' && !allowed) throw new AiServiceError('SSRF_BLOCKED')
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(({ address }) => isMetadataIp(address)
    || (isIP(address) === 6 && transitionNetworks.check(address, 'ipv6')) || (!allowed && isPrivateIp(address)))) {
    throw new AiServiceError('SSRF_BLOCKED')
  }
  return addresses[0]
}

/** Native HTTP pins the validated IP while retaining the original Host and TLS SNI. */
export async function aiJsonRequest(url: URL, headers: Record<string, string>, body: unknown,
  allowedPrivateHosts: string[], timeoutMs = 30_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const target = await Promise.race([
      checkedAiTarget(url, allowedPrivateHosts),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new AiServiceError('AI_TIMEOUT', 504)), timeoutMs) }),
    ])
    clearTimeout(timer)
    return await new Promise<unknown>((resolve, reject) => {
      const fail = (code: string, status = 502): void => { reject(new AiServiceError(code, status)) }
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: body === undefined ? 'GET' : 'POST', agent: false,
        headers: { ...headers, 'content-type': 'application/json', 'accept-encoding': 'identity' },
        lookup: (_host, _options, callback) => callback(null, target.address, target.family),
        family: target.family,
      }, response => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy()
          fail(response.statusCode && response.statusCode >= 300 && response.statusCode < 400 ? 'AI_REDIRECT_BLOCKED' : 'AI_PROVIDER_ERROR')
          return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 1024 * 1024) { response.destroy(); fail('AI_RESPONSE_TOO_LARGE'); return }
          chunks.push(chunk)
        })
        response.on('error', () => fail('AI_NETWORK_ERROR'))
        response.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) }
          catch { fail('AI_INVALID_RESPONSE') }
        })
      })
      timer = setTimeout(() => { request.destroy(); fail('AI_TIMEOUT', 504) }, Math.max(1, deadline - Date.now()))
      request.on('error', () => fail('AI_NETWORK_ERROR'))
      request.end(body === undefined ? undefined : JSON.stringify(body))
    })
  } catch (error: unknown) {
    if (error instanceof AiServiceError) throw error
    throw new AiServiceError('AI_NETWORK_ERROR', 502)
  } finally { clearTimeout(timer) }
}
