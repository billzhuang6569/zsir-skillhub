import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { detectEnvSuggestions, isCandidateKey, isSecretKeyName, type EnvSuggestion } from './env-detect.js'

type Case = { name: string; files: Record<string, string>; expected: EnvSuggestion[] }

// desktop/src-tauri/src/env_detect.rs runs the same cases on disk.
const cases = JSON.parse(readFileSync(
  new URL('../../../desktop/src-tauri/tests/fixtures/env-detect-cases.json', import.meta.url),
  'utf8',
)) as Case[]

describe('package env detection (Desktop rule twin)', () => {
  it.each(cases.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    const files = Object.entries(testCase.files).map(([path, contents]) => ({ path, data: Buffer.from(contents, 'utf8') }))
    const actual = detectEnvSuggestions(files).map((suggestion) => ({ ...suggestion, evidence: [...suggestion.evidence].sort() }))
    expect(actual).toEqual(testCase.expected)
  })

  it('applies the shared candidate key rules', () => {
    expect(isCandidateKey('FAL_KEY')).toBe(true)
    for (const key of ['A', 'PATH', 'LC_ALL', 'CLAUDE_SKILL_DIR', 'lower']) expect(isCandidateKey(key)).toBe(false)
  })

  it('only treats names that look like keys as keys (#287)', () => {
    for (const key of ['FAL_KEY', 'OPENAI_API_KEY', 'HF_TOKEN', 'DB_PASSWORD', 'CLIENT_SECRET', 'GITHUB_PAT', 'BASIC_AUTH']) {
      expect(isSecretKeyName(key), key).toBe(true)
    }
    for (const key of ['OUTPUT_DIR', 'BASE_URL', 'FAL_MODEL', 'IMAGE_SIZE', 'KEYWORD', 'TOKENIZER', 'REGION', 'TIMEOUT_MS']) {
      expect(isSecretKeyName(key), key).toBe(false)
    }
    const suggestions = detectEnvSuggestions([
      { path: 'gen.py', data: Buffer.from("import fal_client\nimport os\nos.getenv('OUTPUT_DIR')\nos.getenv('REPLICATE_API_TOKEN')\n") },
      { path: '.env.example', data: Buffer.from('BASE_URL=https://example.test\nDB_PASSWORD=\n') },
    ])
    expect(suggestions.map((suggestion) => suggestion.key)).toEqual(['DB_PASSWORD', 'FAL_KEY', 'REPLICATE_API_TOKEN'])
  })

  it('skips oversized, non-UTF-8 and too-deep files', () => {
    const deep = `${Array.from({ length: 8 }, (_, index) => `d${index}`).join('/')}/x.py`
    const suggestions = detectEnvSuggestions([
      { path: 'big.py', data: Buffer.from(`os.getenv('BIG_KEY')\n${' '.repeat(1024 * 1024)}`) },
      { path: 'binary.py', data: Buffer.from([0xff, 0xfe, 0x00]) },
      { path: deep, data: Buffer.from("os.getenv('DEEP_KEY')\n") },
      { path: 'ok.py', data: Buffer.from("os.getenv('OK_KEY')\n") },
    ])
    expect(suggestions.map((suggestion) => suggestion.key)).toEqual(['OK_KEY'])
  })
})
