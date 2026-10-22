import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  firstHeading,
  firstParagraphLine,
  frontmatterDisplayName,
  frontmatterList,
  frontmatterText,
  parseSkillDocument,
} from './skill-frontmatter.js'

type SharedCase = {
  name: string
  input: string
  expected: {
    displayName: string | null
    description: string | null
    category: string | null
    version: string | null
    labels: string[]
  }
}

// The Desktop reader runs the same cases, so every surface agrees.
const cases = JSON.parse(readFileSync(
  new URL('../../../desktop/src-tauri/tests/fixtures/skill-frontmatter-cases.json', import.meta.url),
  'utf8',
)) as SharedCase[]

describe('shared SKILL.md frontmatter cases', () => {
  it('covers the documented YAML subset', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10)
  })

  it.each(cases.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    const document = parseSkillDocument(testCase.input)
    expect(frontmatterDisplayName(document) ?? firstHeading(document.body) ?? null).toBe(testCase.expected.displayName)
    expect(frontmatterText(document, 'description') ?? firstParagraphLine(document.body) ?? null).toBe(testCase.expected.description)
    expect(frontmatterText(document, 'category') ?? null).toBe(testCase.expected.category)
    expect(frontmatterText(document, 'version') ?? null).toBe(testCase.expected.version)
    expect(frontmatterList(document, 'labels') ?? frontmatterList(document, 'tags') ?? []).toEqual(testCase.expected.labels)
  })
})

describe('SKILL.md document structure', () => {
  it('keeps nested mappings verbatim and returns the body after the closing marker', () => {
    const document = parseSkillDocument('---\nname: pdf\nmetadata:\n  author: example\n---\nBody\n')
    expect(document.fields.find((field) => field.key === 'metadata')?.value).toEqual({ kind: 'block', value: 'author: example' })
    expect(frontmatterText(document, 'metadata')).toBeUndefined()
    expect(document.body).toBe('Body\n')
  })

  it('reads an unterminated block leniently and marks it', () => {
    const document = parseSkillDocument('---\nname: broken\n')
    expect(document).toMatchObject({ hasFrontmatter: true, unterminated: true, body: '' })
    expect(frontmatterText(document, 'name')).toBe('broken')
  })
})
