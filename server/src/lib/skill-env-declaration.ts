// SKILL.md `metadata.skillhub.env` declaration reader (#251). It mirrors the
// Desktop reader in desktop/src-tauri/src/skill_document.rs and both run
// desktop/src-tauri/tests/fixtures/env-declaration-cases.json, so a package is
// read the same way when it is imported locally and when the Server re-checks
// it. An invalid declaration is an explicit error, never silently dropped.
import { z } from 'zod'
import {
  indentation,
  isBlank,
  isIndented,
  parseSkillDocument,
  quotedScalar,
  stripComment,
  topLevelKey,
  unquotePlain,
} from './skill-frontmatter.js'

export const MAX_ENV_DECLARATIONS = 100

/** `obtain` is only ever a display link, and only over https. */
// Lengths count Unicode characters, matching the Desktop (Rust `chars()`) limits.
const characters = (value: string): number => [...value].length

export const EnvObtainSchema = z.string().trim()
  .regex(/^https:\/\/[^\s\p{Cc}]+$/u)
  .refine((value) => characters(value) <= 500)

export const EnvDeclarationSchema = z.object({
  key: z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
  required: z.boolean().default(true),
  description: z.string().trim()
    .regex(/^[^\p{Cc}]*$/u)
    .refine((value) => characters(value) <= 200)
    .optional(),
  obtain: EnvObtainSchema.optional(),
})

export type EnvDeclaration = z.infer<typeof EnvDeclarationSchema>

export class EnvDeclarationError extends Error {
  constructor(detail: string) {
    super(`SKILL.md metadata.skillhub.env is invalid: ${detail}`)
    this.name = 'EnvDeclarationError'
  }
}

type Entry = { rest: string; continuation: string[] }

function mappingEntry(lines: readonly string[], wanted: string): Entry | null {
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
    if (parsed.key === wanted) {
      const continuation = lines.slice(start, index)
      while (continuation.length > 0 && isBlank(continuation[continuation.length - 1] ?? '')) continuation.pop()
      return { rest: stripComment(parsed.rest).trim(), continuation }
    }
  }
  return null
}

function dedentLines(lines: readonly string[]): string[] {
  const indents = lines.filter((line) => !isBlank(line)).map(indentation)
  const indent = indents.length > 0 ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(Math.min(indent, indentation(line))))
}

function scalar(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('|') || value.startsWith('>')) {
    throw new EnvDeclarationError('only single-line values are supported')
  }
  if (value.startsWith('"') || value.startsWith("'")) return quotedScalar(value)
  return unquotePlain(stripComment(value))
}

function parseItem(item: number, lines: readonly string[]): unknown {
  const fields = new Map<string, string>()
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const parsed = topLevelKey(trimmed)
    if (!parsed) throw new EnvDeclarationError(`item ${item} must be written as name: value lines`)
    if (!fields.has(parsed.key)) fields.set(parsed.key, scalar(parsed.rest))
  }
  const key = fields.get('key')
  if (!key) throw new EnvDeclarationError(`item ${item} has no key`)
  const rawRequired = fields.get('required')
  let required = true
  if (rawRequired !== undefined && rawRequired !== '') {
    const lowered = rawRequired.toLowerCase()
    if (lowered !== 'true' && lowered !== 'false') {
      throw new EnvDeclarationError(`required of ${key} must be true or false`)
    }
    required = lowered === 'true'
  }
  const description = fields.get('description')?.trim()
  const obtain = fields.get('obtain')?.trim()
  return {
    key,
    required,
    ...(description ? { description } : {}),
    ...(obtain ? { obtain } : {}),
  }
}

/** Validates the bounds shared with Desktop: key format, https-only obtain, lengths, count, unique keys. */
export function validateEnvDeclarations(items: readonly unknown[]): EnvDeclaration[] {
  if (items.length > MAX_ENV_DECLARATIONS) {
    throw new EnvDeclarationError(`at most ${MAX_ENV_DECLARATIONS} keys can be declared`)
  }
  const seen = new Set<string>()
  return items.map((item, index) => {
    const parsed = EnvDeclarationSchema.safeParse(item)
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0]
      throw new EnvDeclarationError(`item ${index + 1} has an invalid ${typeof field === 'string' ? field : 'value'}`)
    }
    if (seen.has(parsed.data.key)) throw new EnvDeclarationError(`${parsed.data.key} is declared twice`)
    seen.add(parsed.data.key)
    return {
      key: parsed.data.key,
      required: parsed.data.required,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      ...(parsed.data.obtain ? { obtain: parsed.data.obtain } : {}),
    }
  })
}

/** Keys declared under `metadata.skillhub.env`; empty when absent. Throws `EnvDeclarationError`. */
export function parseEnvDeclarations(skillMd: string): EnvDeclaration[] {
  const metadata = parseSkillDocument(skillMd).fields.find((field) => field.key === 'metadata')?.value
  if (metadata?.kind !== 'block') return []
  const skillhub = mappingEntry(metadata.value.split('\n'), 'skillhub')
  if (!skillhub) return []
  if (skillhub.rest.length > 0) throw new EnvDeclarationError('metadata.skillhub must be a block mapping')
  const env = mappingEntry(dedentLines(skillhub.continuation), 'env')
  if (!env || env.rest === '[]') return []
  if (env.rest.length > 0) throw new EnvDeclarationError('env must be a list of - key: NAME items')
  const items: string[][] = []
  for (const line of dedentLines(env.continuation)) {
    if (isBlank(line) || line.trimStart().startsWith('#')) continue
    if (!isIndented(line)) {
      if (!line.startsWith('-')) throw new EnvDeclarationError('each env item must start with -')
      const first = line.slice(1)
      if (!(first.length === 0 || first.startsWith(' '))) throw new EnvDeclarationError('each env item must start with -')
      items.push([first])
      continue
    }
    const current = items.at(-1)
    if (!current) throw new EnvDeclarationError('each env item must start with -')
    current.push(line)
  }
  return validateEnvDeclarations(items.map((lines, index) => parseItem(index + 1, lines)))
}
