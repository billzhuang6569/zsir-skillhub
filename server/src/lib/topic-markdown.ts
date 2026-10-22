// Topic article bodies (#211): Skill embed extraction, safety checks (design §3.5 table A)
// and the derived plain-text introContent. The Server never renders Markdown; it only
// decides which Skills an article references and whether the body is safe to store.
//
// Block rules follow the CommonMark subset of §3.3 closely enough that an embed here is
// an embed in the Web / Desktop renderers: a paragraph (blank-line separated, not inside
// a list, quote, table or fenced / indented code) made only of 1–3 links whose targets
// are all `skill:` references.

export const TOPIC_CONTENT_MAX = 60_000
export const TOPIC_INTRO_MAX = 1_000
export const TOPIC_EMBED_MAX_LINKS = 3

export type TopicErrorCode = 'TOPIC_CONTENT_TOO_LONG' | 'TOPIC_HTML_FORBIDDEN' | 'TOPIC_LINK_FORBIDDEN' | 'TOPIC_SKILL_REF_INVALID'
export type TopicWarningCode = 'TOPIC_SKILL_UNKNOWN' | 'TOPIC_SKILL_UNAVAILABLE' | 'TOPIC_IMAGE_HOST' | 'TOPIC_NO_PUBLIC_SKILL'
export type TopicError = { code: TopicErrorCode; line: number }
/** `line` is 1-based; `TOPIC_NO_PUBLIC_SKILL` is about the whole body and has `line: null`. */
export type TopicWarning = { code: TopicWarningCode; line: number | null; listingId?: string }

export type TopicEmbed = { listingId: string; line: number }
export type TopicImage = { url: string; line: number; allowed: boolean }
export type TopicAnalysis =
  | { ok: false; error: TopicError }
  | { ok: true; content: string; embeds: TopicEmbed[]; images: TopicImage[]; introContent: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FORBIDDEN_SCHEME = /^(?:javascript|data|vbscript|file):/
const ERROR_ORDER: readonly TopicErrorCode[] = ['TOPIC_HTML_FORBIDDEN', 'TOPIC_LINK_FORBIDDEN', 'TOPIC_SKILL_REF_INVALID']

/** NFC, no BOM, `\n` line endings: the form every check, line number and stored body uses. */
export function normalizeTopicMarkdown(input: string): string {
  return input.normalize('NFC').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

type Line = { text: string; line: number }
type BlockKind = 'paragraph' | 'heading' | 'list' | 'quote' | 'code' | 'table' | 'hr'
type Block = { kind: BlockKind; lines: Line[] }

const isBlank = (text: string): boolean => text.trim() === ''
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const LIST = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const QUOTE = /^ {0,3}>/
const INDENTED = /^(?: {4}|\t)/
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

/** Leading indentation in columns (a tab counts as 4). */
const indentOf = (text: string): number => (/^[ \t]*/.exec(text)?.[0] ?? '').replace(/\t/g, '    ').length

/** Column where a list item's content starts: marker plus 1–4 spaces (one space when more, or when empty). */
function listContentWidth(text: string): number {
  const match = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]*)(.*)$/.exec(text)
  if (!match) return 2
  const marker = match[1]!.length + match[2]!.length
  const spaces = match[3]!.replace(/\t/g, '    ').length
  return match[4]!.length === 0 || spaces > 4 ? marker + 1 : marker + spaces
}

const interruptsParagraph =(text: string): boolean => FENCE.test(text) || HEADING.test(text) || HR.test(text) || LIST.test(text) || QUOTE.test(text)

function splitBlocks(content: string): Block[] {
  const lines = content.split('\n').map((text, index): Line => ({ text, line: index + 1 }))
  const blocks: Block[] = []
  let index = 0
  let afterBlank = true
  let lastKind: BlockKind | null = null
  const push = (kind: BlockKind, from: number, to: number): void => {
    blocks.push({ kind, lines: lines.slice(from, to) }); lastKind = kind; afterBlank = false
  }
  while (index < lines.length) {
    const text = lines[index]!.text
    if (isBlank(text)) { afterBlank = true; index += 1; continue }
    const fence = FENCE.exec(text)
    if (fence) {
      const marker = fence[1]!
      const closing = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
      let end = index + 1
      while (end < lines.length && !closing.test(lines[end]!.text)) end += 1
      push('code', index, Math.min(end + 1, lines.length))
      index = end + 1
      continue
    }
    if (INDENTED.test(text) && afterBlank && lastKind !== 'list') {
      let end = index + 1
      while (end < lines.length && (INDENTED.test(lines[end]!.text) || (isBlank(lines[end]!.text)
        && lines.slice(end).find(line => !isBlank(line.text)) !== undefined
        && INDENTED.test(lines.slice(end).find(line => !isBlank(line.text))!.text)))) end += 1
      push('code', index, end)
      index = end
      continue
    }
    if (HEADING.test(text)) { push('heading', index, index + 1); index += 1; continue }
    if (HR.test(text)) { push('hr', index, index + 1); index += 1; continue }
    if (LIST.test(text) || QUOTE.test(text)) {
      // A container runs until a blank line; lazy continuation lines belong to it.
      let end = index + 1
      while (end < lines.length && !isBlank(lines[end]!.text) && !FENCE.test(lines[end]!.text)) end += 1
      if (QUOTE.test(text)) { push('quote', index, end); index = end; continue }
      // A list item also continues after blank lines with every line indented to its content
      // column (CommonMark): `- item\n\n  [p](skill:…)` is a paragraph inside the item, never
      // a top-level embed. A fence inside the item is still code.
      const width = listContentWidth(text)
      let from = index
      for (;;) {
        let next = end
        while (next < lines.length && isBlank(lines[next]!.text)) next += 1
        if (next === end || next >= lines.length || indentOf(lines[next]!.text) < width) break
        const dedented = lines[next]!.text.slice(Math.min(width, lines[next]!.text.length))
        const fence = FENCE.exec(dedented)
        if (fence) {
          push('list', from, end)
          const marker = fence[1]!
          const closing = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
          let close = next + 1
          while (close < lines.length && !closing.test(lines[close]!.text.slice(Math.min(width, indentOf(lines[close]!.text))))) close += 1
          push('code', next, Math.min(close + 1, lines.length))
          from = end = Math.min(close + 1, lines.length)
          continue
        }
        end = next + 1
        while (end < lines.length && !isBlank(lines[end]!.text)) end += 1
      }
      if (end > from) push('list', from, end)
      lastKind = 'list'
      index = end
      continue
    }
    let end = index + 1
    let kind: BlockKind = 'paragraph'
    while (end < lines.length && !isBlank(lines[end]!.text)) {
      if (SETEXT.test(lines[end]!.text)) { kind = 'heading'; end += 1; break }
      if (interruptsParagraph(lines[end]!.text)) break
      end += 1
    }
    if (kind === 'paragraph' && end - index >= 2 && text.includes('|') && TABLE_DELIMITER.test(lines[index + 1]!.text)) kind = 'table'
    push(kind, index, end)
    index = end
  }
  return blocks
}

/** Joined block text plus a map from offset to its 1-based source line. */
function joined(block: Block): { text: string; lineAt: (offset: number) => number } {
  const starts: number[] = []
  let offset = 0
  for (const line of block.lines) { starts.push(offset); offset += line.text.length + 1 }
  return {
    text: block.lines.map(line => line.text).join('\n'),
    lineAt: (position: number): number => {
      let found = 0
      for (let index = 0; index < starts.length; index += 1) if (starts[index]! <= position) found = index
      return block.lines[found]!.line
    },
  }
}

/** Inline code spans replaced by spaces (offsets and newlines kept), so checks skip their contents. */
function withoutCodeSpans(text: string): string {
  return text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, match => match.replace(/[^\n]/g, ' '))
}

type ParsedLink = { destination: string; start: number }

/** Parses `[text](destination "title")` at `start`; text may hold balanced or escaped brackets. */
function parseLinkAt(text: string, start: number): { link: ParsedLink; end: number } | null {
  if (text[start] !== '[') return null
  let depth = 0
  let index = start
  for (; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') { index += 1; continue }
    if (char === '[') depth += 1
    else if (char === ']') { depth -= 1; if (depth === 0) break }
  }
  if (depth !== 0 || text[index + 1] !== '(') return null
  index += 2
  while (text[index] === ' ' || text[index] === '\t' || text[index] === '\n') index += 1
  let destination = ''
  if (text[index] === '<') {
    const close = text.indexOf('>', index)
    if (close < 0) return null
    destination = text.slice(index + 1, close)
    index = close + 1
  } else {
    let parens = 0
    for (; index < text.length; index += 1) {
      const char = text[index]!
      if (char === '\\') { destination += text[index + 1] ?? ''; index += 1; continue }
      if (/\s/.test(char)) break
      if (char === '(') parens += 1
      if (char === ')') { if (parens === 0) break; parens -= 1 }
      destination += char
    }
  }
  while (text[index] === ' ' || text[index] === '\t' || text[index] === '\n') index += 1
  const quote = text[index]
  if (quote === '"' || quote === '\'' || quote === '(') {
    const close = quote === '(' ? ')' : quote
    const end = text.indexOf(close, index + 1)
    if (end < 0) return null
    index = end + 1
    while (text[index] === ' ' || text[index] === '\t' || text[index] === '\n') index += 1
  }
  if (text[index] !== ')') return null
  return { link: { destination, start }, end: index + 1 }
}

/** The paragraph's links when it consists of nothing but links (and whitespace); null otherwise. */
function linkOnlyParagraph(text: string): ParsedLink[] | null {
  const links: ParsedLink[] = []
  let index = 0
  while (index < text.length) {
    if (/\s/.test(text[index]!)) { index += 1; continue }
    const parsed = parseLinkAt(text, index)
    if (!parsed) return null
    links.push(parsed.link)
    index = parsed.end
  }
  return links.length > 0 ? links : null
}

/** Named entities that matter for schemes and hosts; anything else is left as text. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  colon: ':', tab: '\t', newline: '\n', period: '.', sol: '/', bsol: '\\', amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'',
  num: '#', commat: '@', excl: '!', quest: '?', lpar: '(', rpar: ')', percnt: '%', nbsp: ' ',
}

/** A numeric character reference as CommonMark decodes it: invalid, surrogate or out-of-range values become U+FFFD. */
function codePointText(value: number): string {
  return Number.isSafeInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value) : '�'
}

/**
 * Entity decoding a renderer applies to a link destination before following it. Never
 * throws: digit runs are bounded and every value is range-checked (`&#99999999999999;`
 * decodes to U+FFFD and the rest stays text). The semicolon is optional here on purpose,
 * so lenient decoders cannot smuggle a scheme past the check.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#[xX]([0-9a-fA-F]{1,7});?/g, (_match, hex: string) => codePointText(Number.parseInt(hex, 16)))
    .replace(/&#(\d{1,8});?/g, (_match, dec: string) => codePointText(Number.parseInt(dec, 10)))
    .replace(/&([A-Za-z]+);/g, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

/** The scheme part a browser would see (`java&#115;cript:`, tabs inside the scheme …). */
function linkScheme(destination: string): string {
  return decodeEntities(destination).replace(/[\u0000- \u007f]/g, '').toLowerCase()
}

/** Any `](target` — stricter than real link syntax on purpose, so nested or odd link text cannot hide a target. */
const LINK_TARGET = /\]\(\s*<?([^\s)>]*)/g
const REFERENCE_DEFINITION = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*(.*)$/

function imageAllowed(url: string, hosts: readonly string[]): boolean {
  try {
    const parsed = new URL(decodeEntities(url).trim())
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && hosts.includes(parsed.hostname.toLowerCase())
  } catch { return false }
}

/** Reference labels match case-insensitively with whitespace collapsed (CommonMark). */
const normalizeLabel = (label: string): string => label.trim().replace(/\s+/g, ' ').toLowerCase()

/** First token of a definition destination: `<…>` or a run without whitespace. */
function definitionDestination(rest: string): string | null {
  const value = rest.trim()
  if (!value) return null
  if (value.startsWith('<')) { const close = value.indexOf('>'); return close > 0 ? value.slice(1, close) : null }
  return value.split(/\s/)[0] ?? null
}

type Definition = { destination: string; line: number }

/** `[label]: destination` definitions, including a destination on the next line. */
function collectDefinitions(blocks: Block[]): Map<string, Definition> {
  const definitions = new Map<string, Definition>()
  for (const block of blocks) {
    if (block.kind === 'code') continue
    block.lines.forEach(({ text }, index) => {
      const match = REFERENCE_DEFINITION.exec(text.replace(/^ {0,3}(?:>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/, ''))
      if (!match) return
      let destination = definitionDestination(match[2] ?? '')
      let line = block.lines[index]!.line
      if (destination === null && block.lines[index + 1]) {
        destination = definitionDestination(block.lines[index + 1]!.text)
        line = block.lines[index + 1]!.line
      }
      const label = normalizeLabel(match[1] ?? '')
      if (destination !== null && label && !definitions.has(label)) definitions.set(label, { destination, line })
    })
  }
  return definitions
}

/** End index of the `]` that closes the bracket at `start` (balanced, backslash escapes skipped); -1 when unclosed. */
function closingBracket(text: string, start: number): number {
  let depth = 0
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') { index += 1; continue }
    if (char === '[') depth += 1
    else if (char === ']') { depth -= 1; if (depth === 0) return index }
  }
  return -1
}

/**
 * Every image the renderers would draw: inline `![alt](url)` with balanced brackets in the
 * alt text, and full / collapsed / shortcut references `![alt][ref]`, `![ref][]`, `![ref]`
 * resolved through the definitions. An undefined reference is literal text, not an image.
 * (HTML `<img>` and autolinks never get here: they are TOPIC_HTML_FORBIDDEN.)
 */
function extractImages(text: string, definitions: ReadonlyMap<string, Definition>): Array<{ url: string; offset: number }> {
  const images: Array<{ url: string; offset: number }> = []
  for (let index = text.indexOf('!['); index >= 0; index = text.indexOf('![', index + 2)) {
    let slashes = 0
    for (let back = index - 1; back >= 0 && text[back] === '\\'; back -= 1) slashes += 1
    if (slashes % 2 === 1) continue
    const close = closingBracket(text, index + 1)
    if (close < 0) continue
    const alt = text.slice(index + 2, close)
    if (text[close + 1] === '(') {
      const parsed = parseLinkAt(text, index + 1)
      if (parsed) { images.push({ url: parsed.link.destination, offset: index }); continue }
    }
    let label = alt
    if (text[close + 1] === '[') {
      const end = text.indexOf(']', close + 2)
      if (end > close + 1) label = text.slice(close + 2, end) || alt
    }
    const definition = definitions.get(normalizeLabel(label))
    if (definition) images.push({ url: definition.destination, offset: index })
  }
  return images
}

function stripInline(text: string): string {
  return text
    .replace(/!\[((?:[^\]\\]|\\.)*)\]\([^)]*\)/g, '')
    .replace(/\[((?:[^\]\\]|\\.)*)\]\([^)]*\)/g, '$1')
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, '$2')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\*(?=\S)([^*]*?\S)\*/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!>|])/g, '$1')
}

function plainBlock(block: Block): string | null {
  if (block.kind === 'code' || block.kind === 'hr' || block.kind === 'table') return null
  const lines = block.lines.map(({ text }) => {
    if (block.kind === 'heading') return text.replace(/^ {0,3}#{1,6}[ \t]*/, '').replace(/[ \t]+#+[ \t]*$/, '')
    if (block.kind === 'list') return text.replace(/^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/, '')
    if (block.kind === 'quote') return text.replace(/^ {0,3}>[ \t]?/, '')
    return text
  }).filter(text => !SETEXT.test(text) || block.kind !== 'heading')
  const value = stripInline(lines.map(line => line.trim()).join(block.kind === 'list' ? '\n' : ' ')).replace(/[ \t]+/g, ' ').trim()
  return value || null
}

/**
 * Table A checks, embeds and the derived intro of one article body. Errors carry the
 * first offending 1-based line; classification of embedded ids (unknown / unavailable /
 * public) needs the database and happens in `topicWarnings`.
 */
export function analyzeTopicMarkdown(input: string, imageHosts: readonly string[]): TopicAnalysis {
  const content = normalizeTopicMarkdown(input)
  if (content.length > TOPIC_CONTENT_MAX) {
    return { ok: false, error: { code: 'TOPIC_CONTENT_TOO_LONG', line: content.slice(0, TOPIC_CONTENT_MAX).split('\n').length } }
  }
  const errors: TopicError[] = []
  const embeds: TopicEmbed[] = []
  const images: TopicImage[] = []
  const intro: string[] = []
  const blocks = splitBlocks(content)
  const definitions = collectDefinitions(blocks)
  for (const definition of definitions.values()) {
    if (FORBIDDEN_SCHEME.test(linkScheme(definition.destination))) errors.push({ code: 'TOPIC_LINK_FORBIDDEN', line: definition.line })
  }
  for (const block of blocks) {
    if (block.kind === 'code') continue
    const { text, lineAt } = joined(block)
    const scanned = withoutCodeSpans(text)
    for (let index = scanned.indexOf('<'); index >= 0; index = scanned.indexOf('<', index + 1)) {
      let slashes = 0
      for (let back = index - 1; back >= 0 && scanned[back] === '\\'; back -= 1) slashes += 1
      if (slashes % 2 === 0 && /[A-Za-z/!?]/.test(scanned[index + 1] ?? '')) { errors.push({ code: 'TOPIC_HTML_FORBIDDEN', line: lineAt(index) }); break }
    }
    for (const match of scanned.matchAll(LINK_TARGET)) {
      if (FORBIDDEN_SCHEME.test(linkScheme(match[1] ?? ''))) errors.push({ code: 'TOPIC_LINK_FORBIDDEN', line: lineAt(match.index ?? 0) })
    }
    for (const image of extractImages(scanned, definitions)) {
      images.push({ url: image.url, line: lineAt(image.offset), allowed: imageAllowed(image.url, imageHosts) })
    }
    if (block.kind === 'paragraph') {
      // Judged on the original inline text: a code span (or any other text) beside the
      // links makes this an ordinary paragraph.
      const links = linkOnlyParagraph(text)
      if (links && links.length <= TOPIC_EMBED_MAX_LINKS && links.every(link => /^skill:/i.test(link.destination.trim()))) {
        for (const link of links) {
          const id = link.destination.trim().slice('skill:'.length)
          if (!UUID.test(id)) errors.push({ code: 'TOPIC_SKILL_REF_INVALID', line: lineAt(link.start) })
          else embeds.push({ listingId: id.toLowerCase(), line: lineAt(link.start) })
        }
        continue // an embed line never reaches the intro
      }
    }
    const plain = plainBlock(block)
    if (plain) intro.push(plain)
  }
  if (errors.length > 0) {
    errors.sort((left, right) => left.line - right.line || ERROR_ORDER.indexOf(left.code) - ERROR_ORDER.indexOf(right.code))
    return { ok: false, error: errors[0]! }
  }
  const seen = new Set<string>()
  const unique = embeds.filter(embed => !seen.has(embed.listingId) && seen.add(embed.listingId))
  const introText = Array.from(intro.join('\n\n')).slice(0, TOPIC_INTRO_MAX).join('').trim()
  return { ok: true, content, embeds: unique, images, introContent: introText || null }
}

/**
 * Table A warnings for an analysed body, given which embedded ids have a listing row
 * (`known`) and which of those are public. Sorted by line; the whole-body
 * `TOPIC_NO_PUBLIC_SKILL` comes last.
 */
export function topicWarnings(analysis: Extract<TopicAnalysis, { ok: true }>, listings: { known: ReadonlySet<string>; public: ReadonlySet<string> }): TopicWarning[] {
  const warnings: TopicWarning[] = []
  for (const embed of analysis.embeds) {
    if (!listings.known.has(embed.listingId)) warnings.push({ code: 'TOPIC_SKILL_UNKNOWN', line: embed.line, listingId: embed.listingId })
    else if (!listings.public.has(embed.listingId)) warnings.push({ code: 'TOPIC_SKILL_UNAVAILABLE', line: embed.line, listingId: embed.listingId })
  }
  for (const image of analysis.images) if (!image.allowed) warnings.push({ code: 'TOPIC_IMAGE_HOST', line: image.line })
  warnings.sort((left, right) => (left.line ?? Infinity) - (right.line ?? Infinity))
  if (!analysis.embeds.some(embed => listings.public.has(embed.listingId))) warnings.push({ code: 'TOPIC_NO_PUBLIC_SKILL', line: null })
  return warnings
}

/** Item rows derived from the body: ids that have a listing row (public or unavailable), first-occurrence order. */
export function derivedTopicItemIds(analysis: Extract<TopicAnalysis, { ok: true }>, known: ReadonlySet<string>): string[] {
  return analysis.embeds.map(embed => embed.listingId).filter(id => known.has(id))
}

/** The body a legacy (un-articled) topic reads as: its intro, then one embed per item. */
export function synthesizeTopicMarkdown(introContent: string | null, items: ReadonlyArray<{ id: string; name: string }>): string {
  const escape = (value: string): string => value.replace(/[\\[\]]/g, match => `\\${match}`).replace(/\n/g, ' ')
  return [introContent?.trim() ?? '', ...items.map(item => `[${escape(item.name || item.id)}](skill:${item.id})`)]
    .filter(part => part.length > 0).join('\n\n')
}
