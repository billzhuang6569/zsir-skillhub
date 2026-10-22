import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_OUTPUT,
  colorValue,
  contrastRatio,
  readTokens,
  renderCss,
} from './generate-design-tokens.mjs'

const script = fileURLToPath(new URL('./generate-design-tokens.mjs', import.meta.url))
const tokens = readTokens()

function runScript(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
}

function withTempDir(callback) {
  const dir = mkdtempSync(join(tmpdir(), 'skillhub-tokens-'))
  try {
    return callback(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const theme of ['light', 'dark']) {
  test(`${theme}: ink on surface and muted on bg/surface reach 4.5:1`, () => {
    const pairs = [['ink', 'surface'], ['ink', 'bg'], ['ink', 'surface-sunken'], ['muted', 'bg'], ['muted', 'surface']]
    for (const [foreground, background] of pairs) {
      const ratio = contrastRatio(colorValue(tokens, foreground, theme), colorValue(tokens, background, theme))
      assert.ok(ratio >= 4.5, `${foreground} on ${background} (${theme}) is ${ratio.toFixed(2)}:1`)
    }
  })
}

test('contrast helper matches the WCAG reference values', () => {
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00')
  assert.equal(contrastRatio('#ffffff', '#ffffff').toFixed(2), '1.00')
})

test('identity pastels and on-pastel keep one value in both themes', () => {
  for (const name of ['logo-mint', 'logo-lilac', 'logo-blush', 'on-pastel']) {
    assert.equal(colorValue(tokens, name, 'light'), colorValue(tokens, name, 'dark'), name)
  }
})

// Every name the pre-#258 CSS used. V6 (#263) deleted them; none may be generated again.
const REMOVED_LEGACY_NAMES = ['bg', 'bg2', 'surface', 'surface2', 'surface3', 'ink', 'ink2', 'ink3', 'line', 'line2',
  'accent', 'accent-ink', 'accent-soft', 'accent-line', 'violet', 'violet-soft', 'ok', 'ok-soft', 'warn', 'warn-soft',
  'warn-line', 'danger', 'danger-soft', 'danger-line', 'sh1', 'sh2', 'sh3', 'r1', 'r2', 'r3', 'font', 'mono',
  'cat-collab-bg', 'cat-collab-fg', 'cat-auto-bg', 'cat-auto-fg', 'cat-research-bg', 'cat-research-fg',
  'cat-content-bg', 'cat-content-fg', 'cat-dev-bg', 'cat-dev-fg', 'cat-data-bg', 'cat-data-fg']

test('generated CSS covers the canonical names, motion tokens and both dark selectors, and no legacy alias', () => {
  const css = renderCss(tokens)
  for (const name of [
    'color-bg', 'color-surface', 'color-surface-sunken', 'color-line', 'color-ink', 'color-muted', 'color-brand',
    'color-brand-strong', 'color-brand-tint', 'color-on-brand', 'color-success', 'color-success-tint', 'color-warning',
    'color-warning-tint', 'color-danger', 'color-logo-night', 'color-logo-mint', 'color-logo-lilac', 'color-logo-blush',
    'color-on-pastel', 'radius-sm', 'radius-md', 'radius-lg', 'radius-xl', 'radius-pill', 'space-1', 'space-8',
    'shadow-sm', 'shadow-card', 'font-sans', 'font-code',
    'color-line-strong', 'color-brand-line', 'color-warning-line', 'color-danger-tint', 'color-danger-line', 'shadow-sheet',
    'motion-fast', 'motion-base', 'ease-standard',
  ]) assert.match(css, new RegExp(`^  --${name}: `, 'm'), name)
  assert.match(css, /^  --motion-base: 200ms;$/m)
  for (const legacy of REMOVED_LEGACY_NAMES) {
    assert.doesNotMatch(css, new RegExp(`--${legacy}:`), legacy)
  }
  assert.doesNotMatch(css, /Legacy names|var\(--/)
  assert.equal(tokens.legacy, undefined)
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\[data-theme="light"\]\) \{\n {4}color-scheme: dark;/)
  assert.match(css, /^:root\[data-theme="dark"\] \{\n {2}color-scheme: dark;/m)
  assert.doesNotMatch(css, /Manrope|#3574f0|--tsh-/)
  assert.doesNotMatch(css, /[ \t]+$/m)
})

test('generation is idempotent and the committed CSS is current', () => {
  assert.equal(renderCss(tokens), renderCss(readTokens()))
  assert.equal(readFileSync(DEFAULT_OUTPUT, 'utf8'), renderCss(tokens))
  const result = runScript(['--check'])
  assert.equal(result.status, 0, result.stderr)
})

test('--check fails when tokens.json drifts from the CSS, and writing fixes it', () => {
  withTempDir((dir) => {
    const input = join(dir, 'tokens.json')
    const output = join(dir, 'tokens.css')
    writeFileSync(input, JSON.stringify(tokens))
    assert.equal(runScript(['--input', input, '--output', output]).status, 0)
    assert.equal(runScript(['--check', '--input', input, '--output', output]).status, 0)
    const first = readFileSync(output, 'utf8')
    assert.equal(runScript(['--input', input, '--output', output]).status, 0)
    assert.equal(readFileSync(output, 'utf8'), first)

    const drifted = structuredClone(tokens)
    drifted.color.tokens.find((token) => token.name === 'brand').value.light = '#000000'
    writeFileSync(input, JSON.stringify(drifted))
    const check = runScript(['--check', '--input', input, '--output', output])
    assert.equal(check.status, 1)
    assert.match(check.stderr, /out of date/)
  })
})

test('a legacy section is rejected so the deleted aliases cannot come back', () => {
  const broken = structuredClone(tokens)
  broken.legacy = { aliases: { accent: 'color-brand' } }
  assert.throws(() => renderCss(broken), /legacy section was removed/)
})
