import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildEnvReview, confirmPendingKey, declarationsWithConfirmedKey, envConfidenceLabel, envDeclarationsChanged, envDeclarationsFromDependencies,
  envDeclarationsFromReview, envEvidenceText, envReviewIsEmpty,
} from '../src/lib/env-declaration.ts'
import type { EnvDeclaration } from '../src/lib/tauri.ts'
import type { EnvDep } from '../src/store/index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('pre-publish checklist splits declared / detected-undeclared / declared-undetected (#251)', () => {
  const review = buildEnvReview(
    [
      { key: 'FAL_KEY', required: true, description: 'fal.ai API Key', obtain: 'https://fal.ai/dashboard/keys' },
      { key: 'LEGACY_TOKEN', required: false },
    ],
    [
      { key: 'FAL_KEY', confidence: 'high', evidence: ['依赖 fal_client（读取 FAL_KEY）'] },
      { key: 'OPENAI_API_KEY', confidence: 'high', evidence: ['依赖 openai（读取 OPENAI_API_KEY）'] },
      { key: 'OUTPUT_DIR', confidence: 'medium', evidence: ['scripts/run.py:3'] },
      { key: 'HINT_KEY', confidence: 'low', evidence: ['README.md:1'] },
    ],
    [{ key: 'OUTPUT_DIR', required: true, configured: false, sharePolicy: 'none', description: '输出目录' } satisfies EnvDep],
  )
  assert.deepEqual(review.declared.map((row) => row.key), ['FAL_KEY'])
  assert.deepEqual(review.declared[0]?.evidence, ['依赖 fal_client（读取 FAL_KEY）'])
  assert.deepEqual(review.declaredUndetected.map((row) => row.key), ['LEGACY_TOKEN'])
  assert.deepEqual(review.detectedUndeclared.map((row) => [row.key, row.checked, row.required, row.description]), [
    ['OPENAI_API_KEY', true, true, undefined],
    ['OUTPUT_DIR', false, true, '输出目录'],
  ])
  assert.equal(envReviewIsEmpty(review), false)
  assert.equal(envReviewIsEmpty(buildEnvReview([], [{ key: 'HINT_KEY', confidence: 'low', evidence: [] }])), true)

  // Unchecked keys are not written; checked ones are sorted by key.
  const written = envDeclarationsFromReview(review, new Set(['OPENAI_API_KEY', 'FAL_KEY']))
  assert.deepEqual(written, [
    { key: 'FAL_KEY', required: true, description: 'fal.ai API Key', obtain: 'https://fal.ai/dashboard/keys' },
    { key: 'OPENAI_API_KEY', required: true },
  ])
  assert.equal(envDeclarationsChanged([{ key: 'FAL_KEY', required: true }], [{ key: 'FAL_KEY', required: true }]), false)
  assert.equal(envDeclarationsChanged([{ key: 'FAL_KEY', required: true }], written), true)
})

test('publish and new-version flows confirm declarations before packaging (#251)', () => {
  const sheet = readFileSync(resolve(root, 'src/components/SkillDetailSheet.tsx'), 'utf8')
  const sync = sheet.slice(sheet.indexOf('const syncToServer = async'), sheet.indexOf('const deleteAsset = async'))
  assert.ok(sync.indexOf('await reviewEnvDeclarations(') < sync.indexOf('createSkillPackage(managedSkillId)'))
  const snapshot = sheet.slice(sheet.indexOf('const openSnapshot = async'), sheet.indexOf('const openRemoteRepair ='))
  assert.match(snapshot, /await reviewEnvDeclarations\(/)
  assert.match(sheet, /writeEnvDeclarations\(/)
  const tauri = readFileSync(resolve(root, 'src/lib/tauri.ts'), 'utf8')
  assert.match(tauri, /invoke<LocalSkill>\('write_env_declarations', \{ skillId, deps \}\)/)
})

test('「重新检测」 pills: declared / high / medium / low → 声明 / 很可能 / 可能 / 线索, evidence one per line (#284)', () => {
  assert.deepEqual((['declared', 'high', 'medium', 'low'] as const).map(envConfidenceLabel), ['声明', '很可能', '可能', '线索'])
  assert.equal(envEvidenceText({ evidence: ['scripts/run.py:3', ' 依赖 fal_client（读取 FAL_KEY） ', ''] }), 'scripts/run.py:3\n依赖 fal_client（读取 FAL_KEY）')
  assert.equal(envEvidenceText({ evidence: [] }), '')
})

const dep = (overrides: Partial<EnvDep> & Pick<EnvDep, 'key'>): EnvDep => ({ required: true, configured: false, sharePolicy: 'none', ...overrides })

test('「写回 SKILL.md」 writes the confirmed sidecar keys without generated descriptions and only when something changed (#284)', () => {
  const deps = [
    dep({ key: 'Z_KEY', required: false, description: '由用户手动添加' }),
    dep({ key: 'FAL_KEY', description: 'fal.ai API Key', obtain: 'https://fal.ai/dashboard/keys', origin: 'declared' }),
    dep({ key: 'PENDING_KEY', origin: 'runtime_request', pending: true, description: 'Agent 运行时发现需要' }),
    dep({ key: 'OPENAI_API_KEY', description: '由 SkillHub 静态分析检测', origin: 'detected' }),
  ]
  const target = envDeclarationsFromDependencies(deps)
  assert.deepEqual(target, [
    { key: 'FAL_KEY', required: true, description: 'fal.ai API Key', obtain: 'https://fal.ai/dashboard/keys' },
    { key: 'OPENAI_API_KEY', required: true },
    { key: 'Z_KEY', required: false },
  ])
  assert.equal(envDeclarationsChanged(target, [...target].reverse()), false, 'same set: the button stays disabled')
  assert.equal(envDeclarationsChanged(target.slice(0, 1), target), true)
})

test('「确认需要」 keeps the file declarations, adds the key as required and keeps its description (#284)', async () => {
  const declared: EnvDeclaration[] = [
    { key: 'B_KEY', required: false, description: '作者写的说明' },
    { key: 'A_KEY', required: true },
  ]
  assert.deepEqual(declarationsWithConfirmedKey(declared, { key: 'FAL_KEY', description: '生成图片用的 fal.ai Key' }), [
    { key: 'A_KEY', required: true },
    { key: 'B_KEY', required: false, description: '作者写的说明' },
    { key: 'FAL_KEY', required: true, description: '生成图片用的 fal.ai Key' },
  ])
  // The CLI's default reason is not the author's words; an already declared key keeps its description.
  assert.deepEqual(declarationsWithConfirmedKey(declared, { key: 'FAL_KEY', description: 'Agent 运行时发现需要' }).at(-1), { key: 'FAL_KEY', required: true })
  assert.deepEqual(declarationsWithConfirmedKey(declared, { key: 'B_KEY' }).find((item) => item.key === 'B_KEY'), { key: 'B_KEY', required: true, description: '作者写的说明' })

  const writes: EnvDeclaration[][] = []
  const result = await confirmPendingKey({ key: 'FAL_KEY' }, async () => declared, async (next) => { writes.push(next); return next.length })
  assert.equal(result, 3)
  assert.equal(writes.length, 1, 'one write, never the old drop-and-re-add double sync')
  assert.deepEqual(writes[0]?.map((item) => item.key), ['A_KEY', 'B_KEY', 'FAL_KEY'])
})

test('the detail 钥匙 section writes declarations through writeEnvDeclarations, not a double sync (#284)', () => {
  const sheet = readFileSync(resolve(root, 'src/components/SkillDetailSheet.tsx'), 'utf8')
  assert.match(sheet, /confirmPendingKey\(dependency, \(\) => readEnvDeclarations\(managedSkillId\), \(declarations\) => \{/)
  assert.match(sheet, /await writeEnvDeclarations\(managedSkillId, targetDeclarations\)/)
  assert.match(sheet, /disabled=\{!declarationsChanged \|\| writingBack\}/)
  assert.doesNotMatch(sheet, /TODO\(#251\)|TODO\(#250\)/)
  assert.doesNotMatch(readFileSync(resolve(root, 'src/lib/skill-keys.ts'), 'utf8'), /TODO\(#251\)|sync\(keys\.filter/)
  const keys = readFileSync(resolve(root, 'src/components/SkillKeys.tsx'), 'utf8')
  assert.match(keys, /<Tooltip content=\{evidence\}/)
  assert.match(keys, /envConfidenceLabel\(suggestion\.confidence\)/)
})
