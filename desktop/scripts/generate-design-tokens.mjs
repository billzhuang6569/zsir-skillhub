#!/usr/bin/env node
// Generates desktop/src/styles/design-tokens.css from desktop/design-tokens.json (#258).
//   node scripts/generate-design-tokens.mjs           write the CSS
//   node scripts/generate-design-tokens.mjs --check   exit 1 when the committed CSS is stale
// Optional --input <json> / --output <css> override the default paths (used by the tests).

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_INPUT = resolve(DESKTOP_ROOT, 'design-tokens.json')
export const DEFAULT_OUTPUT = resolve(DESKTOP_ROOT, 'src/styles/design-tokens.css')

const THEMES = ['light', 'dark']
const DARK_SYSTEM_SELECTOR = ':root:not([data-theme="light"])'
const DARK_FORCED_SELECTOR = ':root[data-theme="dark"]'

function fail(message) {
  throw new Error(`design-tokens.json: ${message}`)
}

/** A token value is either one string for both themes or `{ light, dark }`. */
function themedValue(token, where) {
  const { value } = token
  if (typeof value === 'string') return { light: value, dark: value, themed: false }
  if (value && typeof value === 'object' && typeof value.light === 'string' && typeof value.dark === 'string') {
    return { light: value.light, dark: value.dark, themed: value.light !== value.dark }
  }
  return fail(`${where} "${token.name}" needs a string value or { light, dark }`)
}

function assertName(name, where) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) fail(`${where} has an invalid name: ${String(name)}`)
}

function tokenList(section, where) {
  const tokens = section?.tokens
  if (!Array.isArray(tokens)) fail(`${where}.tokens must be an array`)
  for (const token of tokens) assertName(token?.name, where)
  return tokens
}

/** Flattens the tokens.json shape into ordered CSS custom properties, grouped for readable output. */
export function collectDeclarations(tokens) {
  const themes = tokens?.color?.themes?.map((theme) => theme.id)
  if (JSON.stringify(themes) !== JSON.stringify(THEMES)) fail('color.themes must be [light, dark]')

  const groups = []
  const seen = new Set()
  const add = (group, name, light, dark) => {
    if (seen.has(name)) fail(`duplicate variable --${name}`)
    seen.add(name)
    group.items.push({ name, light, dark })
  }
  const group = (title) => {
    const created = { title, items: [] }
    groups.push(created)
    return created
  }

  const designColors = group('Color · design system')
  const desktopColors = group('Color · desktop supplements')
  for (const token of tokenList(tokens.color, 'color')) {
    const value = themedValue(token, 'color')
    add(token.scope === 'desktop' ? desktopColors : designColors, `color-${token.name}`, value.light, value.dark)
  }

  const type = group('Type')
  const families = tokens.type?.families ?? {}
  for (const family of ['sans', 'code']) {
    if (typeof families[family] !== 'string') fail(`type.families.${family} is required`)
    add(type, `font-${family}`, families[family], families[family])
  }
  for (const typeGroup of tokens.type?.groups ?? []) {
    for (const style of typeGroup.styles ?? []) {
      assertName(style.name, 'type style')
      add(type, `font-size-${style.name}`, style.fontSize, style.fontSize)
      add(type, `line-height-${style.name}`, style.lineHeight, style.lineHeight)
      add(type, `font-weight-${style.name}`, String(style.fontWeight), String(style.fontWeight))
      if (style.letterSpacing) add(type, `letter-spacing-${style.name}`, style.letterSpacing, style.letterSpacing)
    }
  }

  for (const [key, title] of [['spacing', 'Spacing'], ['radius', 'Radius'], ['shadow', 'Shadow'], ['motion', 'Motion']]) {
    const target = group(title)
    for (const token of tokenList(tokens[key], key)) {
      const value = themedValue(token, key)
      add(target, token.name, value.light, value.dark)
    }
  }

  // The pre-#258 aliases (--accent, --ink2, --tsh-* …) were deleted in V6 (#263); they must not come back.
  if (tokens.legacy !== undefined) fail('the legacy section was removed in #263; use the canonical token names')
  return groups
}

function block(selector, lines, indent = '') {
  return `${indent}${selector} {\n${lines.map((line) => (line ? `${indent}  ${line}` : '')).join('\n')}\n${indent}}`
}

export function renderCss(tokens) {
  const groups = collectDeclarations(tokens)
  const lightLines = ['color-scheme: light;']
  const darkLines = ['color-scheme: dark;']
  for (const { title, items } of groups) {
    if (items.length === 0) continue
    lightLines.push('', `/* ${title} */`)
    const darkItems = items.filter((item) => item.dark !== item.light)
    if (darkItems.length > 0) darkLines.push('', `/* ${title} */`)
    for (const item of items) lightLines.push(`--${item.name}: ${item.light};`)
    for (const item of darkItems) darkLines.push(`--${item.name}: ${item.dark};`)
  }
  return [
    '/* ============================================================',
    '   一探 SkillHub · 设计系统 Token（生成文件，勿手改）',
    '   Source: desktop/design-tokens.json (Tan Skillhub Design System tokens.json)',
    '   Regenerate: npm run tokens   ·   Gate: npm run tokens:check',
    '   Light lives on :root. Dark applies when the OS prefers dark and the user did',
    '   not force light, or when the user forces dark via <html data-theme="dark">.',
    '   ============================================================ */',
    block(':root', lightLines),
    '',
    '@media (prefers-color-scheme: dark) {',
    block(DARK_SYSTEM_SELECTOR, darkLines, '  '),
    '}',
    '',
    block(DARK_FORCED_SELECTOR, darkLines),
    '',
  ].join('\n')
}

export function readTokens(path = DEFAULT_INPUT) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function relativeLuminance(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) throw new Error(`contrast needs a 6-digit hex colour, got ${hex}`)
  const channels = [0, 2, 4].map((offset) => parseInt(match[1].slice(offset, offset + 2), 16) / 255)
  const [r, g, b] = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.x contrast ratio between two opaque hex colours. */
export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground)
  const b = relativeLuminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** Returns the colour of `name` in `theme` from the tokens.json shape. */
export function colorValue(tokens, name, theme) {
  const token = tokens.color.tokens.find((candidate) => candidate.name === name)
  if (!token) throw new Error(`unknown colour token ${name}`)
  return themedValue(token, 'color')[theme]
}

function optionValue(argv, flag, fallback) {
  const index = argv.indexOf(flag)
  if (index === -1) return fallback
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a path`)
  return resolve(value)
}

export function run(argv) {
  const input = optionValue(argv, '--input', DEFAULT_INPUT)
  const output = optionValue(argv, '--output', DEFAULT_OUTPUT)
  const css = renderCss(readTokens(input))
  if (argv.includes('--check')) {
    let current = null
    try {
      current = readFileSync(output, 'utf8')
    } catch {
      current = null
    }
    if (current !== css) {
      process.stderr.write(`${output} is out of date with ${input}; run \`npm run tokens\` in desktop/.\n`)
      return 1
    }
    process.stdout.write('design tokens are up to date\n')
    return 0
  }
  writeFileSync(output, css)
  process.stdout.write(`wrote ${output}\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = run(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
