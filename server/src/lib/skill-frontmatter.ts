// Bounded SKILL.md frontmatter reader. It mirrors the Desktop reader in
// desktop/src-tauri/src/skill_document.rs and both run the shared cases in
// desktop/src-tauri/tests/fixtures/skill-frontmatter-cases.json, so a Skill
// shows the same name, description and labels on every surface.
//
// Only the YAML subset real Skills use for display fields is interpreted:
// plain, single- and double-quoted scalars, literal and folded block scalars,
// multi-line plain scalars, and inline or block lists. Nested mappings are
// kept verbatim. Anything else is skipped rather than guessed.

const MAX_FRONTMATTER_LINES = 200
const MAX_LABELS = 16

export type FrontmatterValue =
  | { kind: 'text'; value: string }
  | { kind: 'list'; value: string[] }
  | { kind: 'block'; value: string }

export type FrontmatterField = { key: string; value: FrontmatterValue }

export type SkillDocument = {
  hasFrontmatter: boolean
  unterminated: boolean
  fields: FrontmatterField[]
  body: string
}

function lineText(raw: string): string {
  return raw.replace(/\n$/u, '').replace(/\r$/u, '')
}

export function isIndented(line: string): boolean {
  return line.startsWith(' ') || line.startsWith('\t')
}

export function isBlank(line: string): boolean {
  return line.trim().length === 0
}

export function indentation(line: string): number {
  return line.length - line.replace(/^[ \t]+/u, '').length
}

export function topLevelKey(line: string): { key: string; rest: string } | null {
  if (isIndented(line) || line.startsWith('#') || line.startsWith('-')) return null
  const separator = line.indexOf(':')
  if (separator <= 0) return null
  const key = line.slice(0, separator)
  const rest = line.slice(separator + 1)
  if (!/^[A-Za-z0-9_.-]+$/u.test(key)) return null
  if (!(rest.length === 0 || rest.startsWith(' ') || rest.startsWith('\t'))) return null
  return { key, rest: rest.trim() }
}

export function stripComment(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '#' && (index === 0 || value[index - 1] === ' ' || value[index - 1] === '\t')) {
      return value.slice(0, index).trimEnd()
    }
  }
  return value
}

export function quotedScalar(value: string): string {
  const quote = value[0]
  if (quote === undefined) return ''
  let output = ''
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index] ?? ''
    if (quote === "'") {
      if (character === "'") {
        if (value[index + 1] === "'") {
          output += "'"
          index += 1
          continue
        }
        break
      }
      output += character
      continue
    }
    if (character === '"') break
    if (character === '\\') {
      const next = value[index + 1]
      index += 1
      if (next === undefined) break
      if (next === 'n') output += '\n'
      else if (next === 't') output += '\t'
      else if (next === 'u') {
        const code = Number.parseInt(value.slice(index + 1, index + 5), 16)
        index += 4
        if (Number.isFinite(code)) output += String.fromCharCode(code)
      } else output += next
      continue
    }
    output += character
  }
  return output.trim()
}

export function unquotePlain(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return quotedScalar(value)
  }
  return value
}

function foldPlain(lines: readonly string[]): string {
  let output = ''
  let pendingBreak = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      if (output.length > 0) output += '\n'
      pendingBreak = false
      continue
    }
    if (pendingBreak) output += ' '
    output += trimmed
    pendingBreak = true
  }
  return output.trim()
}

function blockScalar(lines: readonly string[], folded: boolean, explicitIndent: number | null): string {
  const indents = lines.filter((line) => !isBlank(line)).map(indentation)
  const indent = explicitIndent ?? (indents.length > 0 ? Math.min(...indents) : 0)
  const content = lines.map((line) => (isBlank(line) ? '' : line.slice(Math.min(indent, indentation(line)))))
  if (!folded) return content.join('\n').trimEnd()
  let output = ''
  let previousText = false
  for (const line of content) {
    if (line.length === 0) {
      output += '\n'
      previousText = false
    } else if (line.startsWith(' ') || line.startsWith('\t')) {
      if (output.length > 0 && !output.endsWith('\n')) output += '\n'
      output += `${line}\n`
      previousText = false
    } else {
      if (previousText) output += ' '
      output += line
      previousText = true
    }
  }
  return output.trimEnd()
}

function joinFlow(first: string, continuation: readonly string[]): string {
  return [first, ...continuation.map((line) => line.trim())].filter((line) => line.length > 0).join(' ')
}

function flowList(value: string): string[] {
  const inner = value.trim().replace(/^\[/u, '')
  const items: string[] = []
  let current = ''
  let quote: string | null = null
  for (const character of inner) {
    if (quote === null && character === ']') break
    if (quote === null && character === ',') {
      items.push(unquotePlain(current))
      current = ''
      continue
    }
    if (quote === null && (character === '"' || character === "'")) quote = character
    else if (quote !== null && character === quote) quote = null
    current += character
  }
  items.push(unquotePlain(current))
  return items.filter((item) => item.length > 0)
}

function blockList(lines: readonly string[]): string[] {
  return lines
    .map((line) => line.trimStart())
    .filter((line) => line === '-' || line.startsWith('- '))
    .map((line) => unquotePlain(stripComment(line.slice(1).trim())))
    .filter((item) => item.length > 0)
}

function dedent(lines: readonly string[]): string {
  const indents = lines.filter((line) => !isBlank(line)).map(indentation)
  const indent = indents.length > 0 ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(Math.min(indent, indentation(line)))).join('\n').trimEnd()
}

function parseValue(rest: string, continuation: readonly string[]): FrontmatterValue | null {
  if (rest.startsWith('|') || rest.startsWith('>')) {
    const header = stripComment(rest.slice(1)).trim()
    const digit = /[1-9]/u.exec(header)?.[0]
    return { kind: 'text', value: blockScalar(continuation, rest.startsWith('>'), digit ? Number(digit) : null) }
  }
  if (rest.startsWith('"') || rest.startsWith("'")) {
    return { kind: 'text', value: quotedScalar(joinFlow(rest, continuation)) }
  }
  if (rest.startsWith('[')) return { kind: 'list', value: flowList(joinFlow(rest, continuation)) }
  if (rest.length === 0) {
    const first = continuation.find((line) => !isBlank(line))
    if (first === undefined) return null
    const trimmed = first.trimStart()
    if (trimmed === '-' || trimmed.startsWith('- ')) return { kind: 'list', value: blockList(continuation) }
    if (topLevelKey(trimmed)) return { kind: 'block', value: dedent(continuation) }
    return { kind: 'text', value: foldPlain(continuation) }
  }
  return { kind: 'text', value: unquotePlain(foldPlain([stripComment(rest), ...continuation])) }
}

function parseFields(lines: readonly string[]): FrontmatterField[] {
  const fields: FrontmatterField[] = []
  let index = 0
  while (index < lines.length) {
    const parsed = topLevelKey(lines[index] ?? '')
    index += 1
    if (!parsed) continue
    const start = index
    while (index < lines.length) {
      const line = lines[index] ?? ''
      const compactItem = parsed.rest.length === 0 && (line.startsWith('- ') || line === '-')
      if (isBlank(line) || isIndented(line) || compactItem) index += 1
      else break
    }
    let continuation = lines.slice(start, index)
    while (continuation.length > 0 && isBlank(continuation[continuation.length - 1] ?? '')) {
      continuation = continuation.slice(0, -1)
    }
    const value = parseValue(parsed.rest, continuation)
    if (value && !fields.some((field) => field.key === parsed.key)) fields.push({ key: parsed.key, value })
  }
  return fields
}

export function parseSkillDocument(source: string): SkillDocument {
  const content = source.startsWith('﻿') ? source.slice(1) : source
  const rawLines = content.match(/[^\n]*\n|[^\n]+$/gu) ?? []
  const first = rawLines[0]
  if (first === undefined || lineText(first).trimEnd() !== '---') {
    return { hasFrontmatter: false, unterminated: false, fields: [], body: content }
  }
  const frontmatter: string[] = []
  let offset = first.length
  for (const raw of rawLines.slice(1, 1 + MAX_FRONTMATTER_LINES)) {
    offset += raw.length
    const text = lineText(raw)
    if (text.trimEnd() === '---' || text.trimEnd() === '...') {
      return { hasFrontmatter: true, unterminated: false, fields: parseFields(frontmatter), body: content.slice(offset) }
    }
    frontmatter.push(text)
  }
  return { hasFrontmatter: true, unterminated: true, fields: parseFields(frontmatter), body: '' }
}

function fieldValue(document: SkillDocument, key: string): FrontmatterValue | undefined {
  return document.fields.find((field) => field.key === key)?.value
}

export function frontmatterText(document: SkillDocument, key: string): string | undefined {
  const value = fieldValue(document, key)
  return value?.kind === 'text' && value.value.length > 0 ? value.value : undefined
}

export function frontmatterList(document: SkillDocument, key: string): string[] | undefined {
  const value = fieldValue(document, key)
  if (!value || value.kind === 'block') return undefined
  const items = value.kind === 'list' ? value.value : value.value.split(',').map((item) => unquotePlain(item))
  const unique: string[] = []
  for (const item of items) {
    if (item.length > 0 && !unique.includes(item)) unique.push(item)
    if (unique.length === MAX_LABELS) break
  }
  return unique
}

export function frontmatterDisplayName(document: SkillDocument): string | undefined {
  for (const key of ['displayName', 'display_name', 'title', 'name']) {
    const value = frontmatterText(document, key)
    if (value) return value
  }
  return undefined
}

export function firstHeading(body: string): string | undefined {
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ')) {
      const heading = trimmed.slice(2).trim()
      if (heading.length > 0) return heading
    }
  }
  return undefined
}

export function firstParagraphLine(body: string): string | undefined {
  return body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('<!--') && !line.startsWith('```'))
}
