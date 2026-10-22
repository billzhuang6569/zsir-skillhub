import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { containsSensitiveContent, redactSensitiveContent } from './sensitive-content.js'

describe('sensitive content scanning', () => {
  it('redacts bounded assignment names while preserving documented references', () => {
    const result = redactSensitiveContent([
      'OPENAI_API_KEY=ordinary-runtime-token-value',
      "const password = 'another-runtime-password-value'",
      'TOKEN=${TOKEN}',
      'token = process.env.API_TOKEN',
    ].join('\n'))

    expect(result).toEqual({
      content: [
        'OPENAI_API_KEY=[REDACTED]',
        'const password = [REDACTED]',
        'TOKEN=${TOKEN}',
        'token = process.env.API_TOKEN',
      ].join('\n'),
      redactedSecrets: 2,
    })
  })

  it('handles a 100 KiB adversarial identifier within a broad linear-time budget', () => {
    containsSensitiveContent('warmup=value-that-is-not-sensitive')
    const adversarial = 'a-'.repeat(50 * 1024)
    expect(Buffer.byteLength(adversarial)).toBe(100 * 1024)

    const startedAt = performance.now()
    const containsSecret = containsSensitiveContent(adversarial)
    const elapsedMs = performance.now() - startedAt

    expect(containsSecret).toBe(false)
    // The bounded scanner normally completes in milliseconds. Two seconds is
    // intentionally generous for slower CI hosts while still catching the
    // previous expression, which took over ten seconds on this fixture.
    expect(elapsedMs).toBeLessThan(2_000)
  }, 20_000)

  // All values below are self-made and invalid; none is a real credential.
  it.each([
    ['a function call', 'token = getToken()'],
    ['property access', 'token = options.token'],
    ['optional property access', 'const apiKey = this.config?.apiKey'],
    ['an elided URL password', 'https://default:sk_...@api.rivet.dev'],
    ['an angle-bracket URL password', 'https://default:<RIVET_TOKEN>@api.rivet.dev'],
    ['a shell reference', 'TOKEN=${TOKEN}'],
    ['a shell reference with an empty default', 'TOKEN=${TOKEN:-}'],
    ['a process.env reference', 'token = process.env.TOKEN'],
    ['an os.environ lookup', "token = os.environ['API_TOKEN']"],
    ['an os.getenv call', "token = os.getenv('API_TOKEN')"],
    ['your_token_here', 'API_TOKEN=your_token_here'],
    ['an angle-bracket value', 'api_key: <your-api-key>'],
    ['an elided provider prefix', 'OPENAI_API_KEY=sk-...'],
    ['an asterisk mask', 'password = ********'],
    ['a canonical AWS example key', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'],
  ])('does not flag %s', (_label, content) => {
    expect(containsSensitiveContent(content)).toBe(false)
    expect(redactSensitiveContent(content)).toEqual({ content, redactedSecrets: 0 })
  })

  it.each([
    ['a quoted fixture-prefixed literal', 'token = "fixture-credential-value-12345"'],
    ['a value merely containing example', 'token = "opaque-prefix-example-opaque-suffix"'],
    ['a value merely containing placeholder', 'api_key=opaque-placeholder-opaque-suffix'],
    ['a shell reference with a concrete default', 'TOKEN=${TOKEN:-opaque-default-value-123}'],
    ['a bare literal', 'token=abcdefghijklmnopqrstuvwxyz123456'],
    ['random text shaped like property access', 'password: abc123def.ghi456'],
  ])('flags %s', (_label, content) => {
    expect(containsSensitiveContent(content)).toBe(true)
  })

  it('detects and redacts literals used as fallbacks inside expressions', () => {
    const result = redactSensitiveContent([
      'token = process.env.TOKEN || "fixture-credential-value-12345"',
      "const apiKey = env.API_KEY ?? 'opaque-fallback-value-67890'",
      "password = os.getenv('DB_PASSWORD', 'opaque-default-pass-11223')",
      'secret = getenv("APP_SECRET") or "opaque-or-fallback-44556"',
      'token = process.env.TOKEN || "<TOKEN>"',
      'token = getToken(user.id, "API_TOKEN")',
    ].join('\n'))

    expect(result).toEqual({
      content: [
        'token = process.env.TOKEN || [REDACTED]',
        'const apiKey = env.API_KEY ?? [REDACTED]',
        "password = os.getenv('DB_PASSWORD', [REDACTED])",
        'secret = getenv("APP_SECRET") or [REDACTED]',
        'token = process.env.TOKEN || "<TOKEN>"',
        'token = getToken(user.id, "API_TOKEN")',
      ].join('\n'),
      redactedSecrets: 4,
    })
  })

  it('treats an empty env-template value as empty instead of reading the next line', () => {
    expect(containsSensitiveContent('API_TOKEN=\nOPENAI_API_KEY=your_api_key_here\n')).toBe(false)
    expect(redactSensitiveContent('API_TOKEN=\nDB_PASSWORD=opaque-db-pass-12345\n')).toEqual({
      content: 'API_TOKEN=\nDB_PASSWORD=[REDACTED]\n',
      redactedSecrets: 1,
    })
    expect(containsSensitiveContent('password:\n  opaque-yaml-secret-123\n')).toBe(true)
  })

  it('redacts every concrete literal inside an expression but keeps names and references', () => {
    const opaque = 'Zq8vR2mN4kL7pX1wT9yB3cD6'
    const result = redactSensitiveContent([
      `token = getToken("${opaque}")`,
      `api_key = client.config.get("api_key", "${opaque}")`,
      `token = authConfig.apiToken + "${opaque}"`,
      'token = os.environ["TOKEN"]',
    ].join('\n'))

    expect(result).toEqual({
      content: [
        'token = getToken([REDACTED])',
        'api_key = client.config.get("api_key", [REDACTED])',
        'token = authConfig.apiToken + [REDACTED]',
        'token = os.environ["TOKEN"]',
      ].join('\n'),
      redactedSecrets: 3,
    })
  })

  it.each([
    'password: Spring[2024]Secure!',
    'password=Pass(word)2024!',
    'api_key=k(9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c)',
    'password: Correct.Horse.Battery.Staple',
    'password:\n  c2VjcmV0cGFzc3dvcmQx=',
    'token = changeme_Zq8vR2mN',
    'token = your_Zq8vR2mN4k',
  ])('does not mistake %j for code or a placeholder', (content) => {
    expect(containsSensitiveContent(content)).toBe(true)
  })

  it.each([
    'password: correct.horse.battery.staple',
    'password: hunter.two',
    'password = login("correct-horse-battery-staple")',
    'password = cfg.pw || "Pass:Word:Secret:Value"',
    'password:\n  SECRETVALUEABCDEF=',
    'TOKEN=${TOKEN:?Zq8vR2mN4kL7pX1wT9yB3cD6}',
    'token = a1b2c3d4e5f6g7h8example',
  ])('fails closed for %j', (content) => {
    expect(containsSensitiveContent(content)).toBe(true)
  })

  it('fails closed on an expression longer than the bounded scan window', () => {
    const content = `token = getToken(${'"a" + '.repeat(300)}"b")\nnext = 1`
    const result = redactSensitiveContent(content)
    expect(result.redactedSecrets).toBe(1)
    expect(result.content).toBe(`token = [REDACTED]${content.slice(8 + 1024)}`)
  })

  it('still detects provider-format tokens passed as call arguments', () => {
    const fakeStripeKey = `sk_live_${'A'.repeat(24)}`
    const result = redactSensitiveContent(`token = client.auth("${fakeStripeKey}")`)
    expect(result.redactedSecrets).toBe(1)
    expect(result.content).not.toContain(fakeStripeKey)
  })

  it('handles a 100 KiB adversarial expression within a broad linear-time budget', () => {
    const chain = `token = ${'a.'.repeat(50 * 1024 - 8)}b || ${'|'.repeat(8)}`
    const fallbacks = `token = TOKEN ${'|| "'.repeat(20 * 1024)}`
    const placeholder = `token = ${'sk_'.repeat(34 * 1024)}...`
    const calls = `token = ${'a('.repeat(50 * 1024 - 4)}`
    const literals = `token = a.b ${'+ "Zq8vR2mN" '.repeat(8 * 1024)}`

    for (const adversarial of [chain, fallbacks, placeholder, calls, literals]) {
      const startedAt = performance.now()
      containsSensitiveContent(adversarial)
      expect(performance.now() - startedAt).toBeLessThan(2_000)
    }
  }, 20_000)
})

describe('common credential holders count as code roots (#333 review)', () => {
  it('does not flag property access from credentials/auth/session objects', () => {
    for (const line of ['token = credentials.token', 'password = auth.password', 'api_key = session.apiKey', 'token = creds.token']) {
      expect(containsSensitiveContent(line)).toBe(false)
    }
    expect(containsSensitiveContent('password: hunter.two')).toBe(true)
  })
})
