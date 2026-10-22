import assert from 'node:assert/strict'
import test from 'node:test'
import { tourCardPosition } from '../src/lib/onboarding.ts'

test('tour card chooses a fitting side and stays inside narrow viewports', () => {
  const card = { width: 200, height: 100 }, viewport = { width: 800, height: 600 }
  for (const target of [
    { left: 24, right: 100, top: 100, bottom: 150 },
    { left: 700, right: 776, top: 100, bottom: 150 },
    { left: 24, right: 776, top: 24, bottom: 100 },
    { left: 24, right: 776, top: 500, bottom: 576 },
  ]) {
    const p = tourCardPosition(target, card, viewport)
    assert.ok(p)
    assert.ok(p.left >= 24 && p.top >= 24 && p.left + card.width <= 776 && p.top + card.height <= 576)
    assert.ok(p.left >= target.right || p.left + card.width <= target.left || p.top >= target.bottom || p.top + card.height <= target.top)
  }
  const p = tourCardPosition({ left: 20, right: 300, top: 100, bottom: 200 }, { width: 272, height: 200 }, { width: 320, height: 400 })
  assert.ok(p)
  assert.ok(p.left >= 24 && p.left + 272 <= 296 && p.top >= 24 && p.top + 200 <= 376)
})

test('missing targets, zero sizes and non-finite geometry use the centered fallback', () => {
  const target = { left: 20, right: 100, top: 20, bottom: 100 }
  const card = { width: 200, height: 100 }, viewport = { width: 800, height: 600 }
  assert.equal(tourCardPosition(null, card, viewport), null)
  assert.equal(tourCardPosition(target, { width: 0, height: 0 }, viewport), null)
  assert.equal(tourCardPosition({ ...target, right: 20 }, card, viewport), null)
  assert.equal(tourCardPosition({ ...target, top: NaN }, card, viewport), null)
})
