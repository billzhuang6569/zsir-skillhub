import { createHash, createHmac } from 'node:crypto'
import { assertObjectStorageKey, ObjectMissingError, type ObjectStorage } from './object-storage.js'

export type S3Options = {
  endpoint: string; region: string; bucket: string; prefix: string
  accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean
}

/** HTTPS except operator-configured loopback / single-label Compose service names. */
export function normalizeS3Endpoint(value: string): string {
  const url = new URL(value)
  const local = url.hostname === 'localhost' || url.hostname === '[::1]'
    || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
    || /^[a-z][a-z0-9-]*$/.test(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    || url.username || url.password || value.includes('@') || value.includes('?') || value.includes('#')
    || url.pathname !== '/') throw new Error('Invalid S3 endpoint')
  return url.origin
}

function hash(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex') }
function hmac(key: Buffer | string, value: string): Buffer { return createHmac('sha256', key).update(value).digest() }

/** Only S3 header authentication; paths are already validated, with no URL normalization. */
export function signS3Request(method: string, url: URL, body: Buffer, options: Pick<S3Options, 'region' | 'accessKeyId' | 'secretAccessKey'>,
  extraHeaders: Record<string, string> = {}, now = new Date()): Record<string, string> {
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const headers: Record<string, string> = {
    ...extraHeaders, host: url.host, 'x-amz-content-sha256': hash(body), 'x-amz-date': timestamp,
  }
  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(';')
  const canonical = [method, url.pathname, url.search.slice(1),
    names.map(name => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join(''), signedHeaders, hash(body)].join('\n')
  const day = timestamp.slice(0, 8)
  const scope = `${day}/${options.region}/s3/aws4_request`
  const key = hmac(hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, day), options.region), 's3'), 'aws4_request')
  const signature = hmac(key, `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).toString('hex')
  key.fill(0)
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}` }
}

class S3Failure extends Error {
  readonly statusCode = 503
  constructor(message: string) { super(message); this.name = 'S3Failure' }
}

export function createS3ObjectStorage(options: S3Options, maxBytes: number): ObjectStorage {
  const endpoint = normalizeS3Endpoint(options.endpoint)
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)
    || !/^[a-z0-9-]+$/.test(options.region) || !options.accessKeyId || !options.secretAccessKey) throw new Error('Invalid S3 configuration')
  if (options.prefix) assertObjectStorageKey(options.prefix)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid S3 size limit')

  function objectUrl(key: string): URL {
    assertObjectStorageKey(key)
    const url = new URL(endpoint)
    if (!options.forcePathStyle) url.hostname = `${options.bucket}.${url.hostname}`
    url.pathname = '/' + [options.forcePathStyle ? options.bucket : '', options.prefix, key].filter(Boolean).join('/')
    return url
  }

  async function request(method: string, key: string, bytes = Buffer.alloc(0)): Promise<{ status: number; size: number | null; bytes: Buffer }> {
    const url = objectUrl(key)
    const transferBytes = method === 'PUT' ? bytes.length : method === 'GET' ? maxBytes : 0
    const timeoutMs = 15_000 + Math.ceil(transferBytes / (256 * 1024)) * 1_000
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let retry = false
      try {
        const response = await fetch(url, {
          method, redirect: 'manual', signal: controller.signal,
          headers: signS3Request(method, url, bytes, options,
            method === 'PUT' ? { 'content-md5': createHash('md5').update(bytes).digest('base64') } : {}),
          ...(method === 'PUT' ? { body: new Uint8Array(bytes) } : {}),
        })
        retry = response.status === 429 || response.status >= 500
        if (retry || response.status === 404 || !response.ok || method !== 'GET') {
          await response.body?.cancel()
          if (retry) {
            if (attempt >= 2) throw new S3Failure(`S3 ${method} failed (${response.status})`)
          } else {
            if (!response.ok && response.status !== 404) throw new S3Failure(`S3 ${method} failed (${response.status})`)
            const length = response.headers.get('content-length')
            const size = length !== null && /^\d+$/.test(length) ? Number(length) : null
            return { status: response.status, size, bytes: Buffer.alloc(0) }
          }
        } else {
          const declared = response.headers.get('content-length')
          if (declared !== null && Number(declared) > maxBytes) {
            await response.body?.cancel()
            throw new S3Failure('S3 object exceeds size limit')
          }
          const chunks: Buffer[] = []
          let size = 0
          if (!response.body) throw new S3Failure('S3 response has no body')
          for await (const chunk of response.body) {
            size += chunk.length
            if (size > maxBytes) throw new S3Failure('S3 object exceeds size limit')
            chunks.push(Buffer.from(chunk))
          }
          return { status: response.status, size, bytes: Buffer.concat(chunks, size) }
        }
      } catch (error: unknown) {
        // Never retain upstream errors: they can contain the URL or signed request.
        if (error instanceof S3Failure) throw error
        if (attempt >= 2) throw new S3Failure(`S3 ${method} network request failed`)
        retry = true
      } finally { clearTimeout(timer); controller.abort() }
      if (retry) await new Promise<void>(resolve => setTimeout(resolve, Math.min(200 * 2 ** attempt, 800)))
    }
  }

  async function head(key: string): Promise<{ size: number } | null> {
    const result = await request('HEAD', key)
    if (result.status === 404) return null
    if (result.size === null || !Number.isSafeInteger(result.size)) throw new S3Failure('S3 HEAD returned invalid size')
    return { size: result.size }
  }
  return {
    provider: 's3',
    async get(key): Promise<Buffer> {
      const result = await request('GET', key)
      if (result.status === 404) throw new ObjectMissingError()
      return result.bytes
    },
    head,
    async put(key, data): Promise<void> {
      assertObjectStorageKey(key)
      if (data.length > maxBytes) throw new S3Failure('S3 object exceeds size limit')
      const bytes = Buffer.from(data)
      const result = await request('PUT', key, bytes)
      if (result.status === 404) throw new S3Failure('S3 PUT failed (404)')
      if ((await head(key))?.size !== bytes.length) throw new S3Failure('S3 PUT size verification failed')
    },
    async delete(key): Promise<void> { await request('DELETE', key) },
  }
}
