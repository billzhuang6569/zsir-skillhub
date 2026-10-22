import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('node:https', () => ({ request: mocks.request }))
vi.mock('node:http', () => ({ request: mocks.request }))
import { aiJsonRequest, checkedAiTarget, isMetadataIp, normalizeAiBaseUrl, normalizeAllowedHost } from './ai-http.js'

beforeEach(() => { vi.resetAllMocks(); mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]) })
describe('AI SSRF boundary', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.2', '100.64.0.1',
    '0.0.0.0', '[::]', '[::1]', '[fc00::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[::7f00:1]',
    '169.254.169.254', '[fd00:ec2::254]', '100.100.100.200'])('rejects blocked address %s', async host => {
    await expect(checkedAiTarget(new URL(`https://${host}`), [])).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
  })
  it.each(['169.254.169.254', '169.254.170.2', '100.100.100.200', '[fd00:ec2::254]', '[::ffff:169.254.169.254]'])('never allows metadata %s', async host => {
    const url = new URL(`http://${host}`)
    expect(isMetadataIp(url.hostname)).toBe(true)
    await expect(checkedAiTarget(url, [url.hostname])).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
  })
  it('allows exact private host/port, but not another port, subdomain, or unlisted HTTP', async () => {
    mocks.lookup.mockResolvedValue([{ address: '10.0.0.2', family: 4 }])
    await expect(checkedAiTarget(new URL('http://llm.internal:8080/v1'), ['llm.internal:8080'])).resolves.toEqual({ address: '10.0.0.2', family: 4 })
    for (const url of ['http://llm.internal:8081', 'https://other.llm.internal', 'http://llm.internal']) {
      await expect(checkedAiTarget(new URL(url), ['llm.internal:8080'])).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
    }
    await expect(checkedAiTarget(new URL('http://llm.internal:9999'), ['llm.internal'])).resolves.toMatchObject({ address: '10.0.0.2' })
  })
  it('checks every DNS answer and refuses mixed public/private and metadata', async () => {
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }])
    await expect(checkedAiTarget(new URL('https://provider.test'), [])).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
    mocks.lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])
    await expect(checkedAiTarget(new URL('https://provider.test'), ['provider.test'])).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
  })
  it.each(['[64:ff9b::a9fe:a9fe]', '[2002:a9fe:a9fe::1]'])('refuses metadata tunnelling even when %s is allowlisted', async host => {
    await expect(checkedAiTarget(new URL(`https://${host}`), [host])).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
  })
  it('rejects credentials, queries, fragments, protocols and invalid allowlist entries', () => {
    for (const value of ['ftp://host', 'https://user:secret@host', 'https://host?secret=key', 'https://host/#key']) {
      expect(() => normalizeAiBaseUrl(value)).toThrow()
    }
    for (const value of ['host/path', 'host@other', 'host?x', 'host#x', 'host\\other']) expect(() => normalizeAllowedHost(value)).toThrow()
    expect(normalizeAllowedHost('HOST:80')).toBe('host:80')
    expect(normalizeAiBaseUrl('https://HOST:443/v1/')).toBe('https://host/v1')
  })

  function response(status: number, body: string): void {
    mocks.request.mockImplementation((_url, _options, callback) => {
      const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void }
      request.destroy = vi.fn()
      request.end = (): void => {
        const stream = new PassThrough() as PassThrough & { statusCode: number }
        stream.statusCode = status
        callback(stream)
        stream.end(body)
      }
      return request
    })
  }
  it('pins the validated IP without another DNS lookup and preserves the original URL', async () => {
    response(200, '{"ok":true}')
    const url = new URL('https://provider.test/v1/models')
    await expect(aiJsonRequest(url, {}, undefined, [])).resolves.toEqual({ ok: true })
    const [actualUrl, options] = mocks.request.mock.calls[0]
    expect(actualUrl).toEqual(url)
    expect(options.agent).toBe(false)
    const callback = vi.fn()
    mocks.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    options.lookup('provider.test', {}, callback)
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4)
    expect(mocks.lookup).toHaveBeenCalledTimes(1)
  })
  it.each([301, 302, 307, 308])('rejects redirect %s without following it', async status => {
    response(status, 'secret-provider-response')
    await expect(aiJsonRequest(new URL('https://provider.test'), {}, {}, [])).rejects.toMatchObject({ code: 'AI_REDIRECT_BLOCKED' })
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
  it('caps response bytes and discards provider errors', async () => {
    response(200, 'x'.repeat(1024 * 1024 + 1))
    await expect(aiJsonRequest(new URL('https://provider.test'), {}, {}, [])).rejects.toMatchObject({ code: 'AI_RESPONSE_TOO_LARGE' })
    response(401, 'secret-provider-response')
    await expect(aiJsonRequest(new URL('https://provider.test'), {}, {}, [])).rejects.toMatchObject({ message: 'AI_PROVIDER_ERROR' })
  })
  it('bounds DNS resolution time', async () => {
    mocks.lookup.mockReturnValue(new Promise(() => {}))
    await expect(aiJsonRequest(new URL('https://provider.test'), {}, {}, [], 5)).rejects.toMatchObject({ code: 'AI_TIMEOUT' })
    expect(mocks.request).not.toHaveBeenCalled()
  })
})
