import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EnvDeclarationError, parseEnvDeclarations, validateEnvDeclarations } from './skill-env-declaration.js'

type Case = { name: string; input: string; expected?: unknown[]; error?: boolean }

// The Desktop reader (skill_document.rs) runs the same cases.
const cases = JSON.parse(readFileSync(
  new URL('../../../desktop/src-tauri/tests/fixtures/env-declaration-cases.json', import.meta.url),
  'utf8',
)) as Case[]

describe('SKILL.md metadata.skillhub.env declaration', () => {
  it('has the shared cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(15)
  })

  it.each(cases.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    if (testCase.error) {
      expect(() => parseEnvDeclarations(testCase.input)).toThrow(EnvDeclarationError)
    } else {
      expect(parseEnvDeclarations(testCase.input)).toEqual(testCase.expected)
    }
  })

  it('counts description length in characters like Desktop', () => {
    expect(validateEnvDeclarations([{ key: 'FAL_KEY', description: '🔑'.repeat(200) }])).toHaveLength(1)
    expect(() => validateEnvDeclarations([{ key: 'FAL_KEY', description: '🔑'.repeat(201) }])).toThrow(EnvDeclarationError)
  })
})
