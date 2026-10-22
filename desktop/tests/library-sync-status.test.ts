import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  INITIAL_LIBRARY_SYNC_STATE, librarySyncIndicator, reduceLibrarySync, startLibrarySync,
  type LibrarySyncEvent, type LibrarySyncReport, type LibrarySyncState, type LibrarySyncStatus,
} from '../src/lib/library-sync.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const report = (overrides: Partial<LibrarySyncReport> = {}): LibrarySyncReport => ({
  uploaded: 0, downloaded: 0, profilesUpdated: 0, copiesCreated: 0, trashed: 0, bound: 0,
  keptLocal: 0, problems: [], ...overrides,
})
const status = (overrides: Partial<LibrarySyncStatus> = {}): LibrarySyncStatus => ({
  userId: 'owner', keptLocal: [], blocked: [], pendingCopies: 0, lastRun: null, ...overrides,
})
const result = (overrides: Partial<Extract<LibrarySyncEvent, { type: 'result' }>> = {}): LibrarySyncEvent => ({
  type: 'result', report: report(), followUp: false, offline: false, status: status(), baseline: 'fp-1', ...overrides,
})
const run = (...events: LibrarySyncEvent[]): LibrarySyncState =>
  events.reduce(reduceLibrarySync, INITIAL_LIBRARY_SYNC_STATE)
const kind = (...events: LibrarySyncEvent[]): string => librarySyncIndicator(run(...events)).kind

test('scheduler reports each pass start and whether another pass is already queued', async () => {
  const events: string[] = []
  let release: (() => void) | null = null
  const scheduler = startLibrarySync({
    run: async () => { await new Promise<void>((resolve) => { release = resolve }); return report() },
    onStart: () => { events.push('start') },
    onResult: ({ followUp }) => { events.push(`result:${followUp}`) },
    isVisible: () => true,
    setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  })
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  await settle()
  scheduler.trigger()
  release!()
  await settle(); await settle()
  release!()
  await settle(); await settle()
  scheduler.stop()
  assert.deepEqual(events, ['start', 'result:true', 'start', 'result:false'])
})

test('✅ appears only after a successful pass with confirmed local status', () => {
  assert.equal(kind(), 'hidden')
  assert.equal(kind({ type: 'enabled' }), 'checking')
  assert.equal(kind({ type: 'enabled' }, { type: 'start' }), 'checking')
  assert.equal(kind({ type: 'enabled' }, { type: 'start' }, result()), 'synced')
  // An empty library that synced cleanly is done too.
  assert.equal(kind({ type: 'enabled' }, result({ status: status({ candidates: [] }) })), 'synced')
  // A status read that failed or belonged to another account never claims success.
  assert.equal(kind({ type: 'enabled' }, result({ status: null })), 'checking')
})

test('routine checks never blink: the cloud shows only after the slow threshold', () => {
  const synced = [{ type: 'enabled' } as const, result()]
  assert.equal(kind(...synced, { type: 'start' }), 'synced')
  assert.equal(kind(...synced, { type: 'start' }, { type: 'slow' }), 'syncing')
  assert.equal(kind(...synced, { type: 'start' }, result()), 'synced')
  // A late slow timer after the pass ended changes nothing.
  assert.equal(kind(...synced, { type: 'start' }, result(), { type: 'slow' }), 'synced')
})

test('queued passes keep the cloud on instead of flashing ✅ in between', () => {
  const state = run({ type: 'enabled' }, { type: 'start' }, { type: 'slow' }, result({ followUp: true }))
  assert.equal(librarySyncIndicator(state).kind, 'syncing')
  assert.equal(librarySyncIndicator(reduceLibrarySync(state, { type: 'start' })).kind, 'syncing')
})

test('a local edit invalidates ✅ until the next pass, but SkillHub\'s own writes do not', () => {
  const synced = [{ type: 'enabled' } as const, result({ baseline: 'after-pass' })]
  assert.equal(kind(...synced, { type: 'local-change', fingerprint: 'after-pass' }), 'synced')
  assert.equal(kind(...synced, { type: 'local-change', fingerprint: 'edited' }), 'pending')
  assert.equal(kind(...synced, { type: 'local-change', fingerprint: 'edited' }, { type: 'start' }, result({ baseline: 'edited' })), 'synced')
  // Changes observed while a pass runs are that pass's own landing.
  assert.equal(kind(...synced, { type: 'start' }, { type: 'local-change', fingerprint: 'downloaded' }, result({ baseline: 'downloaded' })), 'synced')
})

test('blocked items, copies, problems, offline and errors never show ✅', () => {
  const on = { type: 'enabled' } as const
  assert.deepEqual(librarySyncIndicator(run(on, result({
    report: report({ problems: [{ message: 'quota' }] }),
    status: status({ blocked: [{ entryId: 'e', message: 'blocked' }], pendingCopies: 1 }),
  }))), { kind: 'attention', count: 3 })
  assert.equal(kind(on, result({ report: undefined, error: 'Load failed', offline: true })), 'offline')
  assert.equal(kind(on, result({ report: undefined, error: 'server error', offline: false })), 'attention')
  // Copies already created and Skills kept on this device are settled, not open problems.
  const kept = { skillId: 's', localId: 'l', displayName: 'S', reason: 'r', joining: false }
  assert.equal(kind(on, result({ report: report({ copiesCreated: 2, keptLocal: 1 }), status: status({ keptLocal: [kept] }) })), 'synced')
})

test('sign-out or account switch clears the indicator; stale events after that are ignored', () => {
  const cleared = run({ type: 'enabled' }, result(), { type: 'disabled' }, result(), { type: 'start' }, { type: 'slow' })
  assert.equal(librarySyncIndicator(cleared).kind, 'hidden')
  assert.deepEqual(cleared, INITIAL_LIBRARY_SYNC_STATE)
})

test('the filter bar no longer renders a count or sync badge (#488)', () => {
  const page = readFileSync(resolve(desktopRoot, 'src/pages/SkillsPage.tsx'), 'utf8')
  assert.doesNotMatch(page, /skills-filter-count|LibrarySyncBadge|librarySyncIndicatorLabel/)
  const toolbar = page.slice(page.indexOf('className="skills-filter-bar"'), page.indexOf("{agentDetectionStatus === 'error'"))
  assert.doesNotMatch(toolbar, /role="status"|个 Skill/)
  const css = readFileSync(resolve(desktopRoot, 'src/styles/app.css'), 'utf8')
  assert.doesNotMatch(css, /skills-filter-count|library-sync-badge|library-sync-blink/)
})
