import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { isValidElement, type ReactElement } from 'react'
import ts from 'typescript'
import { buildReviewTree, diffRowsWithHunkSeparators } from '../src/lib/file-diff-review.ts'
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
  assert.match(component, /onConfirm=\{\(\) => void push\(\)\}/)
  assert.match(component, /onSubmit=\{\(\) => void push\(\)\}/)
  assert.match(component, /setReviewOpen\(true\)/)
  assert.match(component, /covered=\{reviewOpen\}/)
  assert.doesNotMatch(component, /<details>|<summary>/)
})

test('replacement rows do not create false hunk gaps and gaps may start with a deletion', () => {
  const lines: SkillPackageDiffLine[] = [
    { kind: 'ctx', oldLine: 1, newLine: 1, content: 'keep' },
    { kind: 'del', oldLine: 2, newLine: null, content: 'old' },
    { kind: 'add', oldLine: null, newLine: 2, content: 'new' },
    { kind: 'ctx', oldLine: 3, newLine: 3, content: 'keep' },
    { kind: 'del', oldLine: 10, newLine: null, content: 'next hunk' },
  ]
  const rows = diffRowsWithHunkSeparators(lines)
  assert.deepEqual(rows.filter(row => row.type === 'gap'), [{ type: 'gap', skipped: 6 }])
})

test('review tree preserves unchanged files and summarizes mixed directory changes', () => {
  const result = buildReviewTree([{ path: 'keep.md', name: 'keep.md', kind: 'file', depth: 0 }], [
    { path: 'nested/add.md', status: 'added', binary: false, tooLarge: false, lines: [] },
    { path: 'nested/delete.md', status: 'deleted', binary: false, tooLarge: false, lines: [] },
  ])
  assert.equal(result.find(entry => entry.path === 'nested')?.status, 'modified')
  assert.equal(result.find(entry => entry.path === 'keep.md')?.status, undefined)
  assert.equal(result.filter(entry => entry.status).length, 3)
})

test('snapshot and repair share file review, fields and submission without changing history review', () => {
  const source = readFileSync(new URL('../src/components/SkillDetailSheet.tsx', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../src/lib/tauri.ts', import.meta.url), 'utf8')
  const registered = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.match(bridge, /invoke\('get_skill_working_file_diffs'/)
  assert.match(registered, /commands::source_edits::get_skill_working_file_diffs/)
  assert.match(source, /const openSnapshot[\s\S]*getSkillWorkingFileDiffs\(managedSkillId\)/)
  assert.match(source, /const openRemoteRepair[\s\S]*getSkillWorkingFileDiffs\(managedSkillId\)/)
  assert.match(source, /form=\{snapshotForm\(false\)\} notices=\{snapshotNotices\} busy=\{busy\}/)
  assert.match(source, /onSubmit=\{\(\) => void saveSnapshot\(\)\}/)
  assert.match(source, /snapshotSubmitDisabled[\s\S]*snapshotDiff === null/)
  assert.match(source, /const openHistoryDiff[\s\S]*getSkillDiff\(managedSkillId, fromHash, toHash\)/)
  assert.match(source, /form=\{snapshotForm\(false\)\}/)
  assert.match(source, /\{snapshotForm\(true\)\}/)
})

test('shared review selects the first change, filters files, explains omitted content and delegates actions', () => {
  type Element = ReactElement<Record<string, unknown>>
  const source = readFileSync(new URL('../src/components/FileDiffReview.tsx', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText
  const require = createRequire(import.meta.url)
  const states: unknown[] = []
  let cursor = 0
  const mocks: Record<string, unknown> = {
    react: {
      useEffect: () => undefined,
      useMemo: (fn: () => unknown) => fn(),
      useState: (initial: unknown) => {
        const index = cursor++
        if (!(index in states)) states[index] = initial
        return [states[index], (value: unknown) => { states[index] = value }]
      },
    },
    '../store/index.js': { useStore: (select: (state: { sidebarWidth: number }) => unknown) => select({ sidebarWidth: 200 }) },
    '../lib/file-diff-review.js': { buildReviewTree, diffRowsWithHunkSeparators },
    './FocusTrapDialog.js': { default: () => null },
    './Icon.js': { Icon: () => null },
    './FileDiffReview.css': {},
  }
  const exports: { default?: (props: Record<string, unknown>) => Element } = {}
  new Function('require', 'exports', compiled)((id: string) => id in mocks ? mocks[id] : require(id), exports)
  const Review = exports.default!
  let submitted = 0
  let returned = 0
  const props = {
    title: '审阅', eyebrow: '测试', busy: false, submitDisabled: false, submitLabel: '提交',
    files: [
      { path: 'large.md', status: 'added', binary: false, tooLarge: true, lines: [] },
      { path: 'deleted.md', status: 'deleted', binary: false, tooLarge: false, lines: [{ kind: 'del', oldLine: 1, newLine: null, content: 'removed' }] },
      { path: 'image.dat', status: 'added', binary: true, tooLarge: false, lines: [] },
      { path: 'mode.sh', status: 'modified', binary: false, tooLarge: false, lines: [] },
    ],
    tree: [
      { path: 'aaa-unchanged.md', name: 'aaa-unchanged.md', kind: 'file', depth: 0 },
      { path: 'keep.md', name: 'keep.md', kind: 'file', depth: 0 },
    ],
    onBack: () => { returned++ }, onCancel: () => undefined, onSubmit: () => { submitted++ },
  }
  function nodes(value: unknown): Element[] {
    if (Array.isArray(value)) return value.flatMap(nodes)
    if (!isValidElement<Record<string, unknown>>(value)) return []
    return [value, ...nodes(value.props.children)]
  }
  function render(): Element[] { cursor = 0; return nodes(Review(props)) }
  let rendered = render()
  assert.equal(rendered.find(node => node.type === 'select')?.props.value, 'deleted.md')
  assert.ok(rendered.some(node => node.props.className === 'team-review-line del'))
  ;(rendered.find(node => node.props.children === '提交')!.props.onClick as () => void)()
  assert.equal(submitted, 1)
  ;(rendered[0].props.onEscape as () => void)()
  assert.equal(returned, 1)
  ;(rendered.find(node => node.props.type === 'checkbox')!.props.onChange as (event: unknown) => void)({ target: { checked: true } })
  rendered = render()
  assert.ok(!rendered.some(node => node.type === 'option' && node.props.value === 'keep.md'))
  ;(rendered.find(node => node.type === 'select')!.props.onChange as (event: unknown) => void)({ target: { value: 'large.md' } })
  assert.ok(render().some(node => typeof node.props.children === 'string' && node.props.children.includes('超过审阅显示限额')))
  states[1] = 'image.dat'
  assert.ok(render().some(node => node.props.children === '这是二进制文件，无法显示逐行差异。'))
  states[1] = 'mode.sh'
  rendered = render()
  assert.ok(rendered.some(node => node.props.className === 'compact-empty' && node.props.children === '没有可显示的逐行差异（空文件或仅权限变化）'))
  assert.ok(!rendered.some(node => node.type === 'pre'))
  props.busy = true
  rendered = render()
  assert.equal(rendered[0].props.escapeDisabled, true)
  assert.ok(rendered.filter(node => node.type === 'button' && ['返回确认', '处理中…', '取消'].includes(String(node.props['aria-label'] ?? node.props.children))).every(node => node.props.disabled))
})

test('snapshot review keeps errors by actions, version summary and optional tree fallback', () => {
  const source = readFileSync(new URL('../src/components/SkillDetailSheet.tsx', import.meta.url), 'utf8')
  const compact = source.slice(source.indexOf('{snapshotOpen && <FocusTrapDialog'), source.indexOf('{snapshotOpen && snapshotReviewOpen'))
  assert.match(compact, /\{snapshotForm\(true\)\}\s*\{snapshotNotices\}\s*<div className="modal-actions"/)
  assert.match(source, /summary=\{<><VersionChange current=\{skill.version \|\| '—'\} next=\{version \|\| '—'\} \/><InfoRows/)
  assert.equal(source.match(/getSkillTree\(managedSkillId\)\.catch\(\(\): SkillTreeEntry\[\] => \[\]\)/g)?.length, 2)
  assert.match(source, /snapshotSubmitDisabled = diffLoading \|\| snapshotDiff === null/)
  assert.match(source, /点击「查看区别」可审阅/)
})

test('covered confirmations are hidden from accessibility while the review owns focus', () => {
  const confirm = readFileSync(new URL('../src/components/ConfirmModal.tsx', import.meta.url), 'utf8')
  const detail = readFileSync(new URL('../src/components/SkillDetailSheet.tsx', import.meta.url), 'utf8')
  const focus = readFileSync(new URL('../src/components/FocusTrapDialog.tsx', import.meta.url), 'utf8')
  assert.match(confirm, /ariaHidden=\{covered\}/)
  assert.match(detail, /ariaHidden=\{snapshotReviewOpen\}/)
  assert.match(focus, /aria-hidden=\{ariaHidden\}/)
  assert.match(focus, /element.getAttribute\('aria-hidden'\) === 'true'/)
})
