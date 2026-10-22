import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runAccountDeleteJob, summarizeAccountDelete } from '../src/lib/account-delete-job.ts'
import type { BatchResult } from '../src/lib/cloud-selection.ts'

type Target = { id: string; name: string; outcome: BatchResult['kind'] | 'throw' }
const target = (id: string, outcome: Target['outcome'] = 'done'): Target => ({ id, name: `Skill ${id}`, outcome })

async function run(targets: Target[], canContinue: () => boolean = () => true) {
  const events: string[] = []
  const results = await runAccountDeleteJob<Target>({
    targets,
    idOf: (t) => t.id,
    nameOf: (t) => t.name,
    canContinue,
    execute: async (t) => {
      events.push(`execute:${t.id}`)
      if (t.outcome === 'throw') throw new Error('网络中断')
      return { id: t.id, name: t.name, kind: t.outcome, message: t.outcome === 'done' ? '已从账号删除' : '原因' }
    },
    onPending: (ids) => events.push(`pending:${ids.join(',')}`),
    onLeaving: (id) => events.push(`leaving:${id}`),
    onSettled: (id, removed) => events.push(`settled:${id}:${removed ? 'removed' : 'kept'}`),
    leaveMs: 5,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  return { events, results }
}

test('the dialog hands over at once: every row is pending first, deletions run in order, removed rows leave after their animation', async () => {
  const { events, results } = await run([target('a'), target('b', 'failed'), target('c')])
  assert.equal(events[0], 'pending:a,b,c')
  assert.deepEqual(events.filter((event) => event.startsWith('execute:')), ['execute:a', 'execute:b', 'execute:c'])
  // A failed row settles immediately and stays; successful rows leave then settle as removed.
  assert.ok(events.indexOf('settled:b:kept') < events.indexOf('execute:c'))
  assert.ok(events.indexOf('leaving:a') < events.indexOf('settled:a:removed'))
  assert.ok(events.indexOf('leaving:c') < events.indexOf('settled:c:removed'))
  assert.deepEqual(results.map((result) => result.kind), ['done', 'failed', 'done'])
})

test('a thrown executor becomes an unconfirmed result and never removes the row', async () => {
  const { events, results } = await run([target('a', 'throw')])
  assert.equal(results[0].kind, 'unconfirmed')
  assert.match(results[0].message, /网络中断/)
  assert.ok(events.includes('settled:a:kept'))
  assert.ok(!events.some((event) => event.startsWith('leaving:')))
})

test('an account switch stops the remaining targets without touching them', async () => {
  let calls = 0
  const { events, results } = await run([target('a'), target('b'), target('c')], () => calls++ < 1)
  assert.deepEqual(results.map((result) => result.kind), ['done', 'stopped', 'stopped'])
  assert.deepEqual(events.filter((event) => event.startsWith('execute:')), ['execute:a'])
})

test('the summary is quiet on success and names the first failure otherwise', () => {
  const done = (id: string): BatchResult => ({ id, name: `S${id}`, kind: 'done', message: '' })
  assert.equal(summarizeAccountDelete([])?.message, undefined)
  assert.deepEqual(summarizeAccountDelete([done('1')]), { kind: 'default', message: '已从账号删除「S1」' })
  assert.deepEqual(summarizeAccountDelete([done('1'), done('2')]), { kind: 'default', message: '已从账号删除 2 个 Skill' })
  const failed = summarizeAccountDelete([done('1'), { id: '2', name: 'S2', kind: 'kept', message: '刚在其他设备上被修改' }, { id: '3', name: 'S3', kind: 'failed', message: 'x' }])
  assert.equal(failed?.kind, 'error')
  assert.match(failed?.message ?? '', /2 个未能从账号删除：「S2」刚在其他设备上被修改，其余 1 个可重新选择后重试；已删除 1 个/)
  const pending = summarizeAccountDelete([{ id: '2', name: 'S2', kind: 'unconfirmed', message: '' }])
  assert.equal(pending?.kind, 'warn')
  assert.match(pending?.message ?? '', /待同步确认/)
  assert.equal(summarizeAccountDelete([{ id: '2', name: 'S2', kind: 'stopped', message: '' }])?.kind, 'warn')
})

test('the batch dialog no longer renders a result report for deletes and the list animates leaving rows', () => {
  const dialog = readFileSync(new URL('../src/components/SkillBatchDialog.tsx', import.meta.url), 'utf8')
  assert.match(dialog, /startAccountDeleteBatch/)
  assert.doesNotMatch(dialog, /账号已删，本机待清理/)
  const list = readFileSync(new URL('../src/components/SkillLibraryList.tsx', import.meta.url), 'utf8')
  assert.match(list, /accountDeletes/)
  assert.match(list, /leaving/)
  const css = readFileSync(new URL('../src/components/SkillLibraryList.css', import.meta.url), 'utf8')
  assert.match(css, /\.skill-library-row\.leaving \{[^}]*animation: skill-row-leave/)
  assert.match(css, /@keyframes skill-row-leave/)
  // Reduced motion keeps the removal but drops the movement.
  assert.match(css, /prefers-reduced-motion: reduce\) \{[^}]*\.skill-library-row\.leaving \{ animation: none; opacity: 0; \}/)
})
