import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudLibrarySkills, managedOutsideAccount } from '../src/lib/cloud-library.ts'
import { libraryTransferFraction, type LibraryEntryList, type LibraryTransfer } from '../src/lib/library-sync.ts'
import type { LocalSkill } from '../src/store/index.ts'
import { skillVersionDisplay } from '../src/lib/versioning.ts'

const skill = (changes: Partial<LocalSkill>): LocalSkill => ({
  id: 'folder', name: 'same-name', displayName: 'Name', labels: [], version: '1', latestVersion: '1',
  installCount: 0, sources: [], agents: {}, installed: false, isOwn: false, acquisitionSource: 'local',
  envDeps: [], sharedTo: {}, versions: [], compatibleAgents: [], localPath: '/managed/folder', ...changes,
})
const list: LibraryEntryList = { userId: 'A', entries: [
  { entryId: 'e1', name: 'same-name', displayName: 'First', revision: 1, deleted: false, localSkillId: null },
  { entryId: 'e2', name: 'same-name', displayName: 'Second', revision: 2, deleted: false, localSkillId: null },
  { entryId: 'gone', name: 'gone', displayName: 'Gone', revision: 2, deleted: true, localSkillId: null },
] }
const transfer: LibraryTransfer = { userId: 'A', entryId: 'e1', revision: 1, received: 50, total: 100, phase: 'downloading', error: null }

test('fresh server analysis wins over a stale cloud placeholder and immutable library profile', () => {
  const inventory = { ...list, entries: [{ ...list.entries[0], serverSkillId: 'server-1', profile: { description: 'old', labels: ['old'] } }] }
  const stale = skill({ id: 'library:e1', localPath: '', libraryAccountId: 'A', serverAnalysisStatus: 'unanalysed' })
  const fresh = skill({ id: 'server:server-1', localPath: '', serverId: 'server-1', serverAccessValidatedForUserId: 'A',
    serverAnalysisStatus: 'completed', description: 'new', labels: ['manual'] })
  for (const input of [[fresh, stale], [stale, fresh]]) {
    const row = cloudLibrarySkills(input, inventory, 'A')[0]
    assert.equal(row.serverAnalysisStatus, 'completed')
    assert.equal(row.description, 'new')
    assert.deepEqual(row.labels, ['manual'])
  }
})

test('all account entries appear before files exist; unrelated same-name files never count as downloaded', () => {
  const local = [skill({ libraryAccountId: 'B', libraryEntryId: 'e1' }), skill({ id: 'guest' })]
  const rows = cloudLibrarySkills(local, list, 'A', { e1: transfer })
  assert.deepEqual(rows.map(row => row.id), ['library:e1', 'library:e2'])
  assert.ok(rows.every(row => row.localPath === '' && !row.isOwn && row.cloudDownload))
  assert.equal(rows[0].cloudDownload, transfer)
  assert.equal(managedOutsideAccount(local, 'A').length, 2)
})

test('each verified local binding replaces one placeholder without duplicating entries', () => {
  const ready = skill({ id: 'downloaded', libraryAccountId: 'A', libraryEntryId: 'e1' })
  const rows = cloudLibrarySkills([ready], list, 'A', { e1: { ...transfer, phase: 'ready' } })
  assert.equal(rows.length, 2)
  assert.equal(rows[0], ready)
  assert.equal(rows[0].cloudDownload, undefined)
  assert.equal(rows[1].id, 'library:e2')
})

test('cloud-only entries preserve confirmed receipt identity and distinguish explicit unversioned from old Server', () => {
  const rows = cloudLibrarySkills([], { userId: 'A', entries: [
    { ...list.entries[0], versionPolicy: 1, version: { receiptId: 'r', label: '0.2.0', cardSha256: 'card', formalVersionId: 'formal', formalLabel: '0.1.0' } },
    { ...list.entries[1], versionPolicy: 1, version: null },
  ] }, 'A')
  assert.equal(rows[0].version, '0.2.0')
  assert.equal(rows[0].formalVersionId, 'formal')
  assert.equal(rows[0].formalLabel, '0.1.0')
  assert.equal(rows[0].versionStatus, 'confirmed')
  assert.equal(rows[1].versionStatus, 'unversioned')
  assert.deepEqual(skillVersionDisplay(rows[0]), { label: '0.2.0', problem: null })
  assert.deepEqual(skillVersionDisplay(rows[1]), { label: '版本待获取', problem: null })
  assert.equal(cloudLibrarySkills([], list, 'A')[0].versionStatus, undefined)
})

test('account switching rejects old lists and progress; deleted entries stay out; a new signed-in import stays visible', () => {
  const old = skill({ libraryAccountId: 'A', libraryEntryId: 'e1' })
  assert.deepEqual(cloudLibrarySkills([old], list, 'B'), [])
  const uploaded = skill({ id: 'new', addedByAccountId: 'A' })
  const rows = cloudLibrarySkills([uploaded], list, 'A', { e1: { ...transfer, userId: 'B' } })
  assert.equal(rows[0].cloudDownload?.received, 0)
  assert.equal(rows.at(-1), uploaded)
  assert.equal(managedOutsideAccount([uploaded], 'A').length, 0)
  assert.equal(managedOutsideAccount([uploaded], 'B').length, 1)
  assert.ok(!rows.some(row => row.libraryEntryId === 'gone'))
})

test('failed downloads keep their rows; unknown length is indeterminate and network completion is not landing', () => {
  const error = { ...transfer, phase: 'error' as const, error: '连接失败' }
  assert.equal(cloudLibrarySkills([], list, 'A', { e1: error })[0].cloudDownload?.error, '连接失败')
  assert.equal(libraryTransferFraction(), null)
  assert.equal(libraryTransferFraction({ ...transfer, total: null }), null)
  assert.equal(libraryTransferFraction(transfer), 0.45)
  assert.equal(libraryTransferFraction({ ...transfer, received: 100 }), 0.9)
  assert.equal(libraryTransferFraction({ ...transfer, phase: 'landing' }), 0.95)
  assert.equal(libraryTransferFraction({ ...transfer, phase: 'ready' }), 1)
})

test('cloud-only entries carry a valid source before download and drop missing or invalid ones (#330)', () => {
  const profile = { displayName: 'First', labels: [], compatibleAgents: [] }
  const rows = cloudLibrarySkills([], { userId: 'A', entries: [
    { ...list.entries[0], localSkillId: null, profile: { ...profile, sourceUrl: '  https://github.com/acme/demo  ' } },
    { ...list.entries[1], localSkillId: null, profile },
    { entryId: 'e3', name: 'bad', displayName: 'Bad', revision: 1, deleted: false, localSkillId: null, profile: { ...profile, sourceUrl: 'javascript:alert(1)' } },
    { entryId: 'e4', name: 'old', displayName: 'Old', revision: 1, deleted: false, localSkillId: null },
  ] }, 'A')
  assert.deepEqual(rows.map(row => [row.id, row.sourceUrl]), [
    ['library:e1', 'https://github.com/acme/demo'],
    ['library:e2', undefined],
    ['library:e3', undefined],
    ['library:e4', undefined],
  ])
  assert.ok(rows.every(row => row.localPath === ''))
})
