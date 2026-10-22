import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarketplaceDeepLink } from '../src/lib/marketplace-deep-link.ts'

const LISTING_ID = '22222222-2222-4222-8222-222222222222'
const INTENT_ID = '33333333-3333-4333-8333-333333333333'

test('accepts the strict Marketplace install and discuss routes', () => {
  assert.deepEqual(
    parseMarketplaceDeepLink(`skillhub://marketplace/${LISTING_ID}?action=install&intentId=${INTENT_ID}`),
    { listingId: LISTING_ID, action: 'install', intentId: INTENT_ID },
  )
  assert.deepEqual(
    parseMarketplaceDeepLink(`skillhub://marketplace/${LISTING_ID}?action=discuss`),
    { listingId: LISTING_ID, action: 'discuss' },
  )
})

test('rejects executable fields, unknown actions, and non-UUID identities', () => {
  assert.equal(parseMarketplaceDeepLink(`skillhub://marketplace/${LISTING_ID}?action=run&command=rm`), null)
  assert.equal(parseMarketplaceDeepLink('skillhub://marketplace/not-an-id?action=install'), null)
  assert.equal(parseMarketplaceDeepLink(`https://example.com/${LISTING_ID}?action=install`), null)
})
