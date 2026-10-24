import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReviewTree, diffRowsWithHunkSeparators } from '../src/lib/team-push-review.ts'
import type { SkillPackageDiffLine, SkillPackageFileDiff } from '../src/lib/tauri.ts'

test('review tree includes all local files and deleted paths with directory status', () => {
  const tree = [
    { path: 'SKILL.md', name: 'SKILL.md', kind: 'file' as const, depth: 0 },
    { path: 'references', name: 'references', kind: 'directory' as const, depth: 0 },
    { path: 'references/guide.md', name: 'guide.md', kind: 'file' as const, depth: 1 },
    { path: 'scripts', name: 'scripts', kind: 'directory' as const, depth: 0 },
    { path: 'scripts/run.sh', name: 'run.sh', kind: 'file' as const, depth: 1 },
  ]
  const diffs: SkillPackageFileDiff[] = [
    { path: 'SKILL.md', status: 'modified', binary: false, tooLarge: false, lines: [] },
    { path: 'references/guide.md', status: 'deleted', binary: false, tooLarge: false, lines: [] },
    { path: 'scripts/new.sh', status: 'added', binary: false, tooLarge: false, lines: [] },
  ]
  const result = buildReviewTree(tree, diffs)
  assert.equal(result.find(entry => entry.path === 'SKILL.md')?.status, 'modified')
  assert.equal(result.find(entry => entry.path === 'references/guide.md')?.status, 'deleted')
  assert.equal(result.find(entry => entry.path === 'scripts/new.sh')?.status, 'added')
  assert.equal(result.find(entry => entry.path === 'references')?.status, 'deleted')
  assert.equal(result.find(entry => entry.path === 'scripts')?.status, 'added')
  assert.equal(result.find(entry => entry.path === 'scripts/run.sh')?.status, undefined)
})

test('diff hunks insert non-clickable gap rows for unchanged lines only', () => {
  const lines: SkillPackageDiffLine[] = [
    { kind: 'ctx', oldLine: 3, newLine: 4, content: 'before deletion' },
    { kind: 'del', oldLine: 4, newLine: null, content: 'removed' },
    { kind: 'ctx', oldLine: 5, newLine: 5, content: 'after deletion' },
    { kind: 'ctx', oldLine: 10, newLine: 10, content: 'next hunk' },
  ]
  assert.deepEqual(diffRowsWithHunkSeparators(lines), [
    { type: 'line', line: lines[0] },
    { type: 'line', line: lines[1] },
    { type: 'line', line: lines[2] },
    { type: 'gap', skipped: 4 },
    { type: 'line', line: lines[3] },
  ])
})

test('team push review uses the per-file Rust command and shares the existing push action', () => {
  const rust = readFileSync(new URL('../src-tauri/src/source_edits.rs', import.meta.url), 'utf8')
  const registered = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../src/lib/tauri.ts', import.meta.url), 'utf8')
  const component = readFileSync(new URL('../src/components/TeamSkillPushButton.tsx', import.meta.url), 'utf8')
  assert.match(rust, /pub async fn get_skill_package_file_diffs[\s\S]*?collect_package_file_diffs/)
  assert.match(rust, /old_line: line\.old_lineno\(\)/)
  assert.match(rust, /new_line: line\.new_lineno\(\)/)
  assert.match(registered, /commands::source_edits::get_skill_package_file_diffs/)
  assert.match(bridge, /invoke\('get_skill_package_file_diffs'/)
  assert.match(component, /onClick=\{\(\) => void push\(\)\}/)
  assert.match(component, /setReviewOpen\(true\)/)
  assert.doesNotMatch(component, /<details>|<summary>/)
})
