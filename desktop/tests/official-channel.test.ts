import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import official from '../official-channel.json' with { type: 'json' }
import { channelDocsOrigin, DEEP_LINK_SCHEME, DONATION_PAGE_URL, OFFICIAL_ENDPOINTS } from '../src/lib/official-endpoints.ts'
import { SERVER_ORIGIN } from '../src/lib/api.ts'
import { LEGAL_PRIVACY_URL, LEGAL_TERMS_URL } from '../src/lib/legal-links.ts'
import { buildMarketplaceShareUrl } from '../src/lib/marketplace-deep-link.ts'

test('official constants and every public link use the compiled JSON', () => {
  assert.deepEqual(OFFICIAL_ENDPOINTS, official)
  assert.equal(SERVER_ORIGIN, official.serverOrigin)
  assert.equal(DONATION_PAGE_URL, official.supportOrigin)
  assert.equal(LEGAL_PRIVACY_URL, `${official.siteOrigin}/privacy/`)
  assert.equal(LEGAL_TERMS_URL, `${official.siteOrigin}/terms/`)
  assert.equal(buildMarketplaceShareUrl('12345678-1234-1234-8234-123456789abc'), `${official.siteOrigin}/marketplace/skills/12345678-1234-1234-8234-123456789abc`)
  assert.equal(DEEP_LINK_SCHEME, 'skillhub')
})

test('runtime environment, settings and server-info cannot replace compiled constants', async () => {
  const previous = process.env.SKILLHUB_CHANNEL
  const previousOrigin = process.env.VITE_SKILLHUB_SERVER_ORIGIN
  process.env.SKILLHUB_CHANNEL = 'dev'
  process.env.VITE_SKILLHUB_SERVER_ORIGIN = 'https://attacker.example'
  try {
    const fresh = await import('../src/lib/official-endpoints.ts?runtime-overrides') as typeof import('../src/lib/official-endpoints.ts')
    assert.deepEqual(fresh.OFFICIAL_ENDPOINTS, official)
    assert.throws(() => Object.assign(fresh.OFFICIAL_ENDPOINTS, { siteOrigin: 'https://attacker.example' }), TypeError)
    assert.throws(() => Object.assign(fresh.OFFICIAL_ENDPOINTS.updater, { pubkey: 'attacker' }), TypeError)
    const source = readFileSync(new URL('../src/lib/official-endpoints.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /localStorage|sessionStorage|server-info|process\.env|import\.meta\.env/)
    const api = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(api, /VITE_SKILLHUB_SERVER_ORIGIN|resolveServerOrigin/)
  } finally {
    if (previous === undefined) delete process.env.SKILLHUB_CHANNEL
    else process.env.SKILLHUB_CHANNEL = previous
    if (previousOrigin === undefined) delete process.env.VITE_SKILLHUB_SERVER_ORIGIN
    else process.env.VITE_SKILLHUB_SERVER_ORIGIN = previousOrigin
  }
})

test('older dev configs without docsOrigin derive it instead of blanking the APP', () => {
  // Vite aliases the raw dev JSON, so the frontend needs the same fallback as build-channel.mjs.
  assert.equal(channelDocsOrigin({ siteOrigin: 'https://example.com' }), 'https://example.com/docs/')
  assert.equal(channelDocsOrigin({ siteOrigin: 'https://example.com/' }), 'https://example.com/docs/')
  assert.equal(channelDocsOrigin({ siteOrigin: 'https://example.com', docsOrigin: 'https://docs.example.com/' }), 'https://docs.example.com/')
  assert.equal(OFFICIAL_ENDPOINTS.docsOrigin, official.docsOrigin)
})
