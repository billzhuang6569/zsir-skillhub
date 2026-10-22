// 专题正文（#211 / #213）：把 contentMarkdown 按「嵌入段落」切成 markdown 片段与 Skill 卡片组。
// markdown 片段交给 markdown.ts 的 renderTopicMarkdown（markdown-it，html:false）渲染。
//
// 块切分、嵌入段落判定（只含 1–3 个 `skill:<uuid>` 链接的独立段落；代码块、列表、引用、表格里的不算）
// 与图片域名白名单逐条移植自官网 landing-page/src/shared/topic-article.ts（#212），后者又对齐
// Server 的 server/src/lib/topic-markdown.ts。两端不能互相导入（独立 npm 项目），
// tests/topic-article.test.ts 用同一组夹具核对，并在官网解析器存在时逐例比较结果，避免悄悄漂移。

import { mediaUrl, type MediaContext } from './media.ts'

export const TOPIC_EMBED_MAX_LINKS = 3

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** NFC、去 BOM、`\n` 换行（与 Server 存储形态一致）。 */
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

const indentOf = (text: string): number => (/^[ \t]*/.exec(text)?.[0] ?? '').replace(/\t/g, '    ').length

function listContentWidth(text: string): number {
  const match = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]*)(.*)$/.exec(text)
  if (!match) return 2
  const marker = match[1].length + match[2].length
  const spaces = match[3].replace(/\t/g, '    ').length
  return match[4].length === 0 || spaces > 4 ? marker + 1 : marker + spaces
}

const interruptsParagraph = (text: string): boolean => FENCE.test(text) || HEADING.test(text) || HR.test(text) || LIST.test(text) || QUOTE.test(text)

function closingFence(marker: string): RegExp {
  return new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
}

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
    const text = lines[index].text
    if (isBlank(text)) { afterBlank = true; index += 1; continue }
    const fence = FENCE.exec(text)
    if (fence) {
      const closing = closingFence(fence[1])
      let end = index + 1
      while (end < lines.length && !closing.test(lines[end].text)) end += 1
      push('code', index, Math.min(end + 1, lines.length))
      index = end + 1
      continue
    }
    if (INDENTED.test(text) && afterBlank && lastKind !== 'list') {
      let end = index + 1
      const nextContent = (from: number): Line | undefined => lines.slice(from).find(line => !isBlank(line.text))
      while (end < lines.length && (INDENTED.test(lines[end].text) || (isBlank(lines[end].text) && nextContent(end) !== undefined && INDENTED.test(nextContent(end)!.text)))) end += 1
      push('code', index, end)
      index = end
      continue
    }
    if (HEADING.test(text)) { push('heading', index, index + 1); index += 1; continue }
    if (HR.test(text)) { push('hr', index, index + 1); index += 1; continue }
    if (LIST.test(text) || QUOTE.test(text)) {
      let end = index + 1
      while (end < lines.length && !isBlank(lines[end].text) && !FENCE.test(lines[end].text)) end += 1
      if (QUOTE.test(text)) { push('quote', index, end); index = end; continue }
      const width = listContentWidth(text)
      let from = index
      for (;;) {
        let next = end
        while (next < lines.length && isBlank(lines[next].text)) next += 1
        if (next === end || next >= lines.length || indentOf(lines[next].text) < width) break
        const dedented = lines[next].text.slice(Math.min(width, lines[next].text.length))
        const innerFence = FENCE.exec(dedented)
        if (innerFence) {
          push('list', from, end)
          const closing = closingFence(innerFence[1])
          let close = next + 1
          while (close < lines.length && !closing.test(lines[close].text.slice(Math.min(width, indentOf(lines[close].text))))) close += 1
          push('code', next, Math.min(close + 1, lines.length))
          from = end = Math.min(close + 1, lines.length)
          continue
        }
        end = next + 1
        while (end < lines.length && !isBlank(lines[end].text)) end += 1
      }
      if (end > from) push('list', from, end)
      lastKind = 'list'
      index = end
      continue
    }
    let end = index + 1
    let kind: BlockKind = 'paragraph'
    while (end < lines.length && !isBlank(lines[end].text)) {
      if (SETEXT.test(lines[end].text)) { kind = 'heading'; end += 1; break }
      if (interruptsParagraph(lines[end].text)) break
      end += 1
    }
    if (kind === 'paragraph' && end - index >= 2 && text.includes('|') && TABLE_DELIMITER.test(lines[index + 1].text)) kind = 'table'
    push(kind, index, end)
    index = end
  }
  return blocks
}

type ParsedLink = { destination: string; end: number }

/** `[text](destination "title")` at `start`; the text may hold balanced or escaped brackets. */
function parseLinkAt(text: string, start: number): ParsedLink | null {
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
      const char = text[index]
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
    const end = text.indexOf(quote === '(' ? ')' : quote, index + 1)
    if (end < 0) return null
    index = end + 1
    while (text[index] === ' ' || text[index] === '\t' || text[index] === '\n') index += 1
  }
  if (text[index] !== ')') return null
  return { destination, end: index + 1 }
}

function linkOnlyParagraph(text: string): string[] | null {
  const destinations: string[] = []
  let index = 0
  while (index < text.length) {
    if (/\s/.test(text[index])) { index += 1; continue }
    const parsed = parseLinkAt(text, index)
    if (!parsed) return null
    destinations.push(parsed.destination)
    index = parsed.end
  }
  return destinations.length > 0 ? destinations : null
}

/**
 * The Skill ids of an embed paragraph (UUIDs, lowercased, deduplicated within the group),
 * or null when it is not an embed. Like the Web renderer, an embed with any non-UUID
 * reference (a table-A error the Server never stores) renders as ordinary text.
 */
function embedIds(text: string): string[] | null {
  const destinations = linkOnlyParagraph(text)
  if (!destinations || destinations.length > TOPIC_EMBED_MAX_LINKS || !destinations.every(value => /^skill:/i.test(value.trim()))) return null
  const ids: string[] = []
  for (const destination of destinations) {
    const id = destination.trim().slice('skill:'.length)
    if (!UUID.test(id)) return null
    if (!ids.includes(id.toLowerCase())) ids.push(id.toLowerCase())
  }
  return ids.length ? ids : null
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  colon: ':', tab: '\t', newline: '\n', period: '.', sol: '/', bsol: '\\', amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'',
  num: '#', commat: '@', excl: '!', quest: '?', lpar: '(', rpar: ')', percnt: '%', nbsp: ' ',
}

function codePointText(value: number): string {
  return Number.isSafeInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value) : '�'
}

/** Never throws: out-of-range or surrogate values become U+FFFD, unknown named entities stay text. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#[xX]([0-9a-fA-F]{1,7});?/g, (_match, hex: string) => codePointText(Number.parseInt(hex, 16)))
    .replace(/&#(\d{1,8});?/g, (_match, dec: string) => codePointText(Number.parseInt(dec, 10)))
    .replace(/&([A-Za-z]+);/g, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

/** The instance policy applies equally to article images and avatars. */
export function allowedTopicImageUrl(url: string, scope?: MediaContext | null): string | null {
  return mediaUrl(decodeEntities(url), scope)
}

const REFERENCE_DEFINITION = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*(.*)$/

/** Source lines of `[label]: destination` definitions (including a destination on the next line). */
function definitionLines(blocks: Block[]): Set<number> {
  const lines = new Set<number>()
  for (const block of blocks) {
    if (block.kind === 'code') continue
    block.lines.forEach(({ text }, index) => {
      const match = REFERENCE_DEFINITION.exec(text.replace(/^ {0,3}(?:>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/, ''))
      if (!match || !match[1]?.trim()) return
      const rest = (match[2] ?? '').trim()
      if (rest) { lines.add(block.lines[index].line); return }
      const next = block.lines[index + 1]
      if (next && next.text.trim()) { lines.add(block.lines[index].line); lines.add(next.line) }
    })
  }
  return lines
}

export type TopicSegment =
  | { kind: 'markdown'; source: string }
  /** 1 Skill = a full-width card, 2–3 = a grid. `key` is the paragraph's first line, stable across renders. */
  | { kind: 'skills'; ids: string[]; key: string }

export type TopicArticle = { segments: TopicSegment[]; skillIds: string[] }

/**
 * Body → markdown fragments and Skill card groups in body order. Never throws.
 * Reference definitions are appended to every markdown fragment, so `[text][ref]`
 * still resolves after the body is cut at the embeds (definitions render nothing).
 */
export function topicArticle(input: string): TopicArticle {
  const content = normalizeTopicMarkdown(input)
  const lines = content.split('\n')
  const blocks = splitBlocks(content)
  const definitions = definitionLines(blocks)
  const embeds: Array<{ from: number; to: number; ids: string[] }> = []
  for (const block of blocks) {
    if (block.kind !== 'paragraph') continue
    const kept = block.lines.filter(line => !definitions.has(line.line))
    if (!kept.length) continue
    const ids = embedIds(kept.map(line => line.text).join('\n'))
    if (ids) embeds.push({ from: block.lines[0].line, to: block.lines[block.lines.length - 1].line, ids })
  }
  const references = [...definitions].sort((left, right) => left - right).map(line => lines[line - 1]).join('\n')
  const segments: TopicSegment[] = []
  const pushMarkdown = (from: number, to: number): void => {
    const source = lines.slice(from - 1, to).join('\n').trim()
    if (source && !lines.slice(from - 1, to).every((text, offset) => isBlank(text) || definitions.has(from + offset))) {
      segments.push({ kind: 'markdown', source: references ? `${source}\n\n${references}` : source })
    }
  }
  let cursor = 1
  for (const embed of embeds) {
    pushMarkdown(cursor, embed.from - 1)
    segments.push({ kind: 'skills', ids: embed.ids, key: String(embed.from) })
    cursor = embed.to + 1
  }
  pushMarkdown(cursor, lines.length)
  const skillIds: string[] = []
  for (const segment of segments) if (segment.kind === 'skills') for (const id of segment.ids) if (!skillIds.includes(id)) skillIds.push(id)
  return { segments, skillIds }
}

/** The article for a topic DTO, or null for an old Server (no body) or an unexpected parse failure: keep the old layout. */
export function topicArticleOf(topic: { contentMarkdown?: string | null }): TopicArticle | null {
  if (typeof topic.contentMarkdown !== 'string') return null
  try { return topicArticle(topic.contentMarkdown) } catch { return null }
}
