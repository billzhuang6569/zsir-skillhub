import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudOperationReason, cloudSelectionId, emptyCloudSelection, focusCloudRow, isRetryableCloudBatchResult, retainCloudSelection, runCloudBatch, selectCloudRow, type BatchResult } from '../src/lib/cloud-selection.ts'
import { prepareAccountSkillForShare, SharePreparationUnknown, shareSkillWithServerSync, shareVersionReadbackUnknown } from '../src/lib/team-share-flow.ts'

test('cloud selection keeps stable identity across landing, filtered ranges and context clicks', () => {
  const ids = ['a', 'b', 'c', 'd']
  let selection = selectCloudRow(emptyCloudSelection, ids, 'b')
  selection = selectCloudRow(selection, ids, 'd', { range: true })
  assert.deepEqual(selection.ids, ['b', 'c', 'd'])
  selection = selectCloudRow(selection, ids, 'a', { additive: true })
  selection = selectCloudRow(selection, ids, 'b', { additive: true, range: true })
  assert.deepEqual(new Set(selection.ids), new Set(ids))
  assert.deepEqual(selectCloudRow(selection, ids, 'c', { context: true }).ids, selection.ids)
  assert.deepEqual(selectCloudRow(selection, [...ids, 'e'], 'e', { context: true }).ids, ['e'])
  const retained = retainCloudSelection(selection, ['a', 'd'])
  assert.deepEqual(retained.ids, ['d', 'a'])
  assert.equal(retained.focus, null)
  assert.equal(cloudSelectionId({ id: 'library:uuid', libraryEntryId: 'uuid' }), cloudSelectionId({ id: 'folder', libraryEntryId: 'uuid' }))
  assert.deepEqual(selectCloudRow(emptyCloudSelection, ids, 'd', { range: true }).ids, ['d'])
  assert.deepEqual(selectCloudRow(selectCloudRow(emptyCloudSelection, ids, 'a'), ids, 'a', { additive: true }).ids, [])
})

test('placeholder and foreign source account copies remain deletable while sharing is blocked', () => {
  const skill = { isOwn: false, localPath: '', cloudDownload: {}, libraryAccountId: 'u', libraryEntryId: 'entry' }
  assert.equal(cloudOperationReason(skill, 'u', 'delete', true, true), null)
  assert.match(cloudOperationReason(skill, 'u', 'share', true, true) ?? '', /下载/)
  assert.match(cloudOperationReason(skill, 'other', 'delete', true, true) ?? '', /关联/)
  assert.match(cloudOperationReason({ ...skill, isSystem: true }, 'u', 'delete', true, true) ?? '', /系统/)
  assert.match(cloudOperationReason({ ...skill, localPath: '/skill', cloudDownload: undefined }, 'u', 'share', true, true) ?? '', /权限/)
  assert.match(cloudOperationReason(skill, 'u', 'delete', true, false) ?? '', /联网/)
})

test('modifier navigation only moves focus and Space can toggle the focused row', () => {
  const ids = ['a', 'b', 'c']
  const selected = selectCloudRow(emptyCloudSelection, ids, 'a')
  const focused = focusCloudRow(selected, ids, 'b')
  assert.deepEqual(focused, { ids: ['a'], anchor: 'a', focus: 'b' })
  assert.equal(focusCloudRow(focused, ids, 'missing'), focused)
  const toggled = selectCloudRow(focused, ids, 'b', { additive: true })
  assert.deepEqual(toggled.ids, ['a', 'b'])
  assert.deepEqual(selectCloudRow(toggled, ids, 'b', { additive: true }).ids, ['a'])
})

test('batch stays serial and stops subsequent writes on account switch; outcomes are retained', async () => {
  let matching = true
  const writes: number[] = []
  const outcomes: string[] = []
  await runCloudBatch([1, 2, 3], () => matching, async item => {
    writes.push(item)
    await Promise.resolve()
    matching = false
    return { id: String(item), name: String(item), kind: 'local-pending', message: 'account deleted' }
  }, item => ({ id: String(item), name: String(item) }), result => outcomes.push(result.kind))
  assert.deepEqual(writes, [1])
  assert.deepEqual(outcomes, ['local-pending', 'stopped', 'stopped'])
})

test('batch reports an unexpected execute rejection as unknown and continues without retrying it', async () => {
  const writes: number[] = []
  const results: BatchResult[] = []
  await runCloudBatch([1, 2, 3], () => true, async item => {
    writes.push(item)
    if (item === 2) throw new Error('unexpected execute rejection')
    return { id: String(item), name: String(item), kind: 'done', message: 'ok' }
  }, item => ({ id: String(item), name: String(item) }), result => results.push(result))
  assert.deepEqual(writes, [1, 2, 3])
  assert.deepEqual(results.map(result => result.kind), ['done', 'unconfirmed', 'done'])
  assert.deepEqual(results.filter(isRetryableCloudBatchResult), [])
  assert.equal(isRetryableCloudBatchResult({ kind: 'failed' }), true)
  assert.equal(isRetryableCloudBatchResult({ kind: 'kept' }), true)
})

test('batch stops remaining writes when execute rejects after an account switch', async () => {
  let matching = true
  const writes: number[] = []
  const results: BatchResult[] = []
  await runCloudBatch([1, 2], () => matching, async item => {
    writes.push(item)
    matching = false
    throw new Error('original account request failed')
  }, item => ({ id: String(item), name: String(item) }), result => results.push(result))
  assert.deepEqual(writes, [1])
  assert.deepEqual(results.map(result => result.kind), ['stopped', 'stopped'])
  assert.match(results[0].message, /原账号操作结果需重新核验/)
})

test('batch lets result reporting failures surface instead of treating them as item failures', async () => {
  const failure = new Error('UI report failed')
  const writes: number[] = []
  await assert.rejects(runCloudBatch([1, 2], () => true, async item => {
    writes.push(item)
    return { id: String(item), name: String(item), kind: 'done', message: 'ok' }
  }, item => ({ id: String(item), name: String(item) }), () => { throw failure }), error => error === failure)
  assert.deepEqual(writes, [1])
})

test('shared preparation uploads a saved new version and blocks same-label content conflicts', async () => {
  const published: string[] = []
  const input = { skill: { localPath: '/skill', version: '0.1.1' }, currentUserId: 'u', sessionMatches: () => true,
    prepare: async () => ({ serverId: 'server', serverOwnerId: 'u', currentVersion: '0.1.0', contentMatchesVersion: false }),
    publish: async (server: string, version: string) => { published.push(`${server}:${version}`) },
  }
  const prepared = await prepareAccountSkillForShare(input)
  assert.deepEqual(published, ['server:0.1.1'])
  assert.equal(prepared.version, '0.1.1')
  assert.equal(prepared.serverId, 'server')
  await assert.rejects(prepareAccountSkillForShare({ ...input, skill: { ...input.skill, version: '0.1.0' } }), /同一版本/)
  assert.equal(published.length, 1)
  const identical = await prepareAccountSkillForShare({ ...input, prepare: async () => ({ serverId: 'server', serverOwnerId: 'u', currentVersion: '0.1.0', contentMatchesVersion: true }) })
  assert.equal(identical.version, '0.1.0')
  assert.equal(published.length, 1)
})

test('shared preparation keeps unpublished content on failures and account switches', async () => {
  let matching = true
  let writes = 0
  const input = { skill: { localPath: '/skill', version: '0.1.1' }, currentUserId: 'u', sessionMatches: () => matching,
    prepare: async () => { matching = false; return { serverId: 'server', serverOwnerId: 'u', currentVersion: '0.1.0', contentMatchesVersion: false } },
    publish: async () => { writes++ },
  }
  await assert.rejects(prepareAccountSkillForShare(input), /账号已切换/)
  assert.equal(writes, 0)
  matching = true
  await assert.rejects(prepareAccountSkillForShare({ ...input, skill: { ...input.skill, hasWorkingCopy: true } }), /未保存/)
  assert.equal(writes, 0)
})

test('matching public version readback after a lost upload never completes preparation or shares', async () => {
  const receipt = { serverId: 'server', version: '0.1.1', packageSha256: 'package-sha', changelog: '共享已保存的本机版本', gitHash: 'saved-commit' }
  // The public versions response has no environment snapshot or mutation digest.
  const versions = [{ version: receipt.version, packageSha256: receipt.packageSha256, changelog: receipt.changelog, gitHash: receipt.gitHash }]
  const unknown = shareVersionReadbackUnknown(receipt, versions)
  assert.ok(unknown instanceof SharePreparationUnknown)
  assert.equal(unknown.receipt, receipt)
  assert.match(unknown.message, /观察到同版本.*完整版本请求尚未核验/)
  assert.ok(shareVersionReadbackUnknown(receipt, []) instanceof SharePreparationUnknown)
  let uploads = 0
  let shares = 0
  const execute = async (): Promise<BatchResult> => {
    const prepared = await prepareAccountSkillForShare({
      skill: { localPath: '/skill', version: receipt.version }, currentUserId: 'u', sessionMatches: () => true,
      prepare: async () => ({ serverId: receipt.serverId, serverOwnerId: 'u', currentVersion: '0.1.0', contentMatchesVersion: false }),
      publish: async () => { uploads++; throw unknown },
    })
    await shareSkillWithServerSync({ skill: prepared, currentUserId: 'u', teamId: 'team',
      sync: async () => prepared, share: async () => { shares++ },
    })
    return { id: 'entry', name: 'Skill', kind: 'done', message: 'shared' }
  }
  await assert.rejects(execute(), error => error === unknown)
  assert.equal(uploads, 1)
  assert.equal(shares, 0)
  // The same readback used by reconciliation still cannot permit a retry/share.
  const reconciled: BatchResult = { id: 'entry', name: 'Skill', kind: 'unconfirmed', message: shareVersionReadbackUnknown(receipt, versions).message }
  assert.deepEqual([reconciled].filter(isRetryableCloudBatchResult), [])
  assert.equal(uploads, 1)
  assert.equal(shares, 0)
})
