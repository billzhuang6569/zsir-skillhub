import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { canManageSkillAsset } from '../src/lib/ui-helpers.ts'

const component = readFileSync(new URL('../src/components/SkillDetailSheet.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/components/SkillDetailSheet.css', import.meta.url), 'utf8')
const source = ts.createSourceFile('SkillDetailSheet.tsx', component, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

test('guest active-space switches remount version scope and unknown-result exit requires confirmation', () => {
  assert.match(component, /const versionSpace = useStore\(state => state.authSpace \?\? state.activeSpace\)/)
  assert.match(component, /<VersionsTab key=\{`\$\{versionSpace\?\.spaceId\}:\$\{versionSpace\?\.generation\}/)
  assert.match(component, /onClick=\{\(\) => setAbandonTask\(versionTask.key\)\}\>放弃本次并到版本历史核对/)
  assert.match(component, /abandonTask && <ConfirmModal[^\n]+onConfirm=\{\(\) => \{ versionCreateTasks.abandonUnknown\(abandonTask\)/)
})

function initializer(name: string): string {
  let result = ''
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) result = node.initializer.getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(result, `missing ${name}`)
  return result
}

function evaluate<T>(expression: string, context: Record<string, unknown>): T {
  const compiled = ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(context), compiled)(...Object.values(context)) as T
}

test('new version hints require ownership and working changes, independently of version status', () => {
  for (const versionStatus of ['unversioned', 'pending', 'saved', undefined]) {
    for (const hasWorkingCopy of [true, false, undefined]) {
      for (const [kind, isOwn, isSystem] of [
        ['personal', true, false], ['owned team', true, false],
        ['team member', false, false], ['marketplace', false, false], ['system', true, true],
      ] as const) {
        const skill = { isOwn, isSystem, hasWorkingCopy, versionStatus }
        assert.equal(evaluate(initializer('hasVersionChanges'), { skill, canManageSkillAsset }),
          isOwn && !isSystem && hasWorkingCopy === true, `${kind}/${versionStatus}/${hasWorkingCopy}`)
      }
    }
  }
  assert.equal(evaluate(initializer('hasVersionChanges'), { skill: undefined, canManageSkillAsset }), false)
  // Both additions share this condition; selecting a tab or cancelling never clears dirty state.
  assert.match(component, /hasVersionChanges && <button[^>]+btn-soft[^>]+disabled=\{versionBusy && headerVersionTask\?\.phase !== 'failed'\} onClick=\{requestSnapshot\}/)
  assert.match(component, /item.key === 'versions' && hasVersionChanges && <span[^>]+role="img" aria-label="有未保存为版本的修改"/)
  assert.doesNotMatch(component, /hasWorkingCopy\s*=/)
  assert.match(component, /await versionCreateTasks.start\([\s\S]*?setSnapshotOpen\(false\)\s+setSnapshotReviewOpen\(false\)/)
})

test('both entry points consume the same intent once before opening, including effect replay and remount', () => {
  const snapshotIntent: { current: string | null } = { current: null }
  let requests = 0
  let tab = 'profile'
  let focused = 0
  const context = {
    skill: { isOwn: true }, skillId: 'one', canManageSkillAsset, versionBusy: false, snapshotIntent, headerVersionTask: undefined,
    setSnapshotRequest: (update: (value: number) => number): void => { requests = update(requests) },
    setSheetTab: (value: string): void => { tab = value },
    tabRefs: { current: [{ focus: (): void => { focused += 1 } }] }, detailTabs: [{ key: 'versions' }],
  }
  const request = (): void => evaluate<() => void>(initializer('requestSnapshot'), context)()
  const consume = (): boolean => evaluate<() => boolean>(initializer('consumeSnapshotIntent'), context)()
  const effect = component.match(/useEffect\((\(\) => \{\s*if \(lastHandledRequest.current === snapshotRequest\) return\s*lastHandledRequest.current = snapshotRequest\s*if \(consumeSnapshotIntent\(\)\) void openSnapshot\(\)\s*\}), \[snapshotRequest, consumeSnapshotIntent\]\)/)?.[1]
  assert.ok(effect)
  let opened = 0
  const lastHandledRequest: { current: number | null } = { current: null }
  const render = (): void => evaluate<() => void>(effect, {
    lastHandledRequest, snapshotRequest: requests,
    consumeSnapshotIntent: consume,
    openSnapshot: (): void => { assert.equal(snapshotIntent.current, null); opened += 1 },
  })()
  render()
  assert.equal(opened, 0)
  request()
  assert.equal(tab, 'versions')
  assert.equal(focused, 1)
  render()
  render() // StrictMode replay / unrelated rerender
  tab = 'profile'
  tab = 'versions'
  lastHandledRequest.current = null
  render() // VersionsTab remount / cancel then reopen detail
  assert.equal(opened, 1)
  request() // A fresh click while already on Versions still rerenders the consumer.
  render()
  assert.equal(opened, 2)
  assert.equal(requests, 2)
  context.versionBusy = true
  request()
  render()
  assert.equal(opened, 2)
  context.versionBusy = false
  context.skill.isOwn = false
  request()
  assert.equal(snapshotIntent.current, null)
  snapshotIntent.current = 'other-skill'
  lastHandledRequest.current = null
  render()
  assert.equal(opened, 2)
  assert.equal(snapshotIntent.current, null)
  assert.match(component, /snapshotIntent.current = null\s+setVersionBusy\(false\)\s*\}, \[skillId, sourceSpace, currentUser\?\.id\]\)/)
  assert.match(component, /disabled=\{busy\} onClick=\{requestSnapshot\}/)
  assert.equal((component.match(/void openSnapshot\(\)/g) ?? []).length, 1)
})

test('busy feedback and visual hint retain the shared review, focus and narrow layout contracts', () => {
  assert.match(component, /versionTaskBlocks\(headerVersionTask\) \? '正在创建…' : '创建新版本'/)
  assert.match(component, /onBusyChange=\{setVersionBusy\}/)
  assert.match(component, /useEffect\(\(\) => \{ onBusyChange\(busy\) \}, \[busy, onBusyChange\]\)/)
  assert.match(component, /useEffect\(\(\) => \(\) => onBusyChange\(false\)/)
  assert.match(component, /if \(!canManage \|\| busy \|\| snapshotOpen \|\| snapshotOpening.current\) return/)
  assert.match(component, /snapshotOpen && <FocusTrapDialog/)
  assert.match(component, /snapshotOpen && snapshotReviewOpen && <FileDiffReview/)
  assert.match(styles, /\.sh-tab-change-dot\s*\{[^}]*width: 8px;[^}]*background: var\(--color-brand\);/)
  assert.match(styles, /@container \(max-width: 480px\)[^]*?\.sh-act \{ flex-basis: 100%; \}/)
})

test('env review ignores concurrent opens and releases the guard on completion, cancellation and failure', async () => {
  for (const outcome of ['ok', 'cancel', 'error']) {
    const snapshotOpening = { current: false }
    let reviews = 0
    let opened = 0
    let resolveReview!: (value: { ok: boolean }) => void
    let rejectReview!: (reason: Error) => void
    const pending = new Promise<{ ok: boolean }>((resolve, reject) => { resolveReview = resolve; rejectReview = reject })
    const noop = (): void => {}
    const context: Record<string, unknown> = {
      canManage: true, busy: false, snapshotOpen: false, snapshotOpening,
      skill: { hasWorkingCopy: true, envDeps: [] }, currentUser: { id: 'user' },
      currentOwnedServerSkillId: () => 'server', managedSkillId: 'one',
      reviewEnvDeclarations: () => { reviews += 1; return pending },
      setSnapshotOpen: () => { opened += 1 },
      getSkillVersionState: async () => ({}), getSkillWorkingFileDiffs: async () => [],
      getSkillTree: async () => [], skillSnapshotSuggestedVersion: () => '0.1.1',
    }
    for (const name of ['setRemoteRepair', 'setVersionState', 'setSuggestedVersion', 'setVersion', 'setChangelog', 'setSnapshotDiff', 'setSnapshotTree', 'setSnapshotReviewOpen', 'setSnapshotError', 'setDiffLoading']) context[name] = noop
    const open = evaluate<() => Promise<void>>(initializer('openSnapshot'), context)
    const first = open()
    await open()
    assert.equal(reviews, 1)
    assert.equal(opened, 0)
    if (outcome === 'error') {
      rejectReview(new Error('review failed'))
      await assert.rejects(first, /review failed/)
    } else {
      resolveReview({ ok: outcome === 'ok' })
      await first
    }
    assert.equal(snapshotOpening.current, false)
    assert.equal(opened, outcome === 'ok' ? 1 : 0)
  }
})
