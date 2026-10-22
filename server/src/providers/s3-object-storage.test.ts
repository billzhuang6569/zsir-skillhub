import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { objectStorageContract } from './object-storage-contract.js'
import { createS3ObjectStorage, signS3Request, type S3Options } from './s3-object-storage.js'

const options: S3Options = { endpoint: 'https://s3.example.test', bucket: 'examplebucket', prefix: 'test',
  region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', forcePathStyle: true }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('AWS published SigV4 vectors', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
  it.each([
    ['https://examplebucket.s3.amazonaws.com/test.txt', { range: 'bytes=0-9' }, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'],
    ['https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J', {}, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7'],
  ] as const)('matches %s', (url, headers, signature) => {
    expect(signS3Request('GET', new URL(url), Buffer.alloc(0), options, headers, new Date('2013-05-24T00:00:00Z')).authorization)
      .toContain(`Signature=${signature}`)
  })
})

describe('S3 transport faults without a listener', () => {
  it.each([
    ['PUT', 30 * 1024 * 1024, 135_000],
    ['PUT', 1, 16_000],
    ['GET', 0, 135_000],
    ['HEAD', 0, 15_000],
    ['DELETE', 0, 15_000],
  ] as const)('%s with %i request bytes aborts after %i ms and retains bounded retries', async (method, size, timeoutMs): Promise<void> => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const fetcher = vi.fn((_url: URL, init: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      signals.push(init.signal!)
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    vi.stubGlobal('fetch', fetcher)
    const storage = createS3ObjectStorage(options, 30 * 1024 * 1024)
    const pending = method === 'PUT' ? storage.put('valid', Buffer.alloc(size))
      : method === 'GET' ? storage.get('valid')
      : method === 'HEAD' ? storage.head('valid') : storage.delete('valid')
    const assertion = expect(pending).rejects.toThrow(`S3 ${method} network request failed`)
    await vi.advanceTimersByTimeAsync(timeoutMs - 1)
    expect(signals[0].aborted).toBe(false)
    expect(fetcher).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(signals[0].aborted).toBe(true)
    await vi.runAllTimersAsync()
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(signals.every(signal => signal.aborted)).toBe(true)
  })
  it.each([403, 500, 429])('preserves status %i without treating it as missing', async status => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('sensitive upstream body', { status }))
    vi.stubGlobal('fetch', fetcher)
    const storage = createS3ObjectStorage(options, 32)
    await expect(storage.get('valid')).rejects.toMatchObject({ statusCode: 503 })
    expect(fetcher).toHaveBeenCalledTimes(status === 403 ? 1 : 3)
    await expect(storage.head('valid')).rejects.toThrow(`(${status})`)
  })
  it('sanitizes network failures and retries only finitely', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error(options.secretAccessKey))
    vi.stubGlobal('fetch', fetcher)
    await expect(createS3ObjectStorage(options, 32).get('valid')).rejects.toThrow('S3 GET network request failed')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('rejects redirects without forwarding credentials', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 307, headers: { location: 'https://other.test' } }))
    vi.stubGlobal('fetch', fetcher)
    await expect(createS3ObjectStorage(options, 32).get('valid')).rejects.toThrow('(307)')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]).toBeDefined()
  })
  it('bounds declared and streamed response sizes without retries', async () => {
    for (const headers of [{ 'content-length': '33' }, {}]) {
      const fetcher = vi.fn(async () => new Response(new Uint8Array(33), { headers }))
      vi.stubGlobal('fetch', fetcher)
      await expect(createS3ObjectStorage(options, 32).get('valid')).rejects.toThrow('size limit')
      expect(fetcher).toHaveBeenCalledOnce()
    }
  })
  it('checks PUT MD5, HEAD size and virtual-host URL', async () => {
    const fetcher = vi.fn(async () => new Response(null, { headers: { 'content-length': '9' } }))
    vi.stubGlobal('fetch', fetcher)
    const storage = createS3ObjectStorage({ ...options, forcePathStyle: false }, 32)
    await expect(storage.put('valid', Buffer.from('abc'))).rejects.toThrow('size verification')
    const calls = fetcher.mock.calls as unknown as Array<[URL, RequestInit]>
    expect(calls[0][0].href).toBe('https://examplebucket.s3.example.test/test/valid')
    expect(calls[0][1].headers).toMatchObject({ 'content-md5': 'kAFQmDzST7DWlj99KOF/cg==' })
    expect(calls.map(call => call[1].method)).toEqual(['PUT', 'HEAD'])
  })
  it('times out stalled reads and bounds retries', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn((_url: URL, init: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    vi.stubGlobal('fetch', fetcher)
    const assertion = expect(createS3ObjectStorage(options, 32).get('valid')).rejects.toThrow('network request failed')
    await vi.runAllTimersAsync()
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})

describe('S3 in-process HTTP contract', () => {
  let server: Server
  let endpoint: string
  const objects = new Map<string, Buffer>()
  beforeAll(async () => {
    server = createServer(async (request, response) => {
      try {
        expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/)
        expect(request.url).toMatch(/^\/examplebucket\/test\//)
        const key = request.url!
        if (request.method === 'PUT') {
          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
          const bytes = Buffer.concat(chunks)
          expect(request.headers['content-md5']).toBe(createHash('md5').update(bytes).digest('base64'))
          objects.set(key, bytes)
          response.writeHead(200).end()
        } else if (request.method === 'DELETE') {
          objects.delete(key); response.writeHead(204).end()
        } else {
          const bytes = objects.get(key)
          if (!bytes) response.writeHead(404).end()
          else { response.writeHead(200, { 'content-length': bytes.length }); response.end(request.method === 'HEAD' ? undefined : bytes) }
        }
      } catch { response.writeHead(400).end() }
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test listener')
    endpoint = `http://127.0.0.1:${address.port}`
  })
  afterAll(async () => { if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  objectStorageContract('fake S3', () => createS3ObjectStorage({ ...options, endpoint }, 30 * 1024 * 1024))
})
