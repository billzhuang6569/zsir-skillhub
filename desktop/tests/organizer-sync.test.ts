/** Organizer ↔ Server sync (#326): merge rules against an in-memory Server. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { OrganizerSyncApi } from '../src/lib/organizer-sync.ts'
import type { OrganizerResult, OrganizerState, QuickAccessItem } from '../src/lib/skill-organizer.ts'

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/desktop/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
  }
  return nextResolve(specifier, context)
} })
const {
  mergeQuickAccess, organizerPendingCount, rebaseTags, tagDelta, quickAccessFromServer, quickAccessToServer, syncOrganizerOnce, withLocalOnlyItems,
} = await import('../src/lib/organizer-sync.ts')
const {
  addQuickAccess, deleteTag, emptyOrganizerState, pruneQuickAccess, rekeyOrganizer, removeQuickAccess, renameTag, setSkillTags, tagKey,
} = await import('../src/lib/skill-organizer.ts')
hooks.deregister()

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function ok(result: OrganizerResult): OrganizerState {
  assert.equal(result.ok, true)
  return (result as { ok: true; state: OrganizerState }).state
}

class HttpError extends Error {
  status: number
  constructor(status: number, message = `HTTP ${status}`) { super(message); this.status = status }
}

/** Mirrors server/src/routes/library-organizer.ts closely enough for the client contract. */
class FakeServer {
  entries = new Set<string>(['e1', 'e2', 'e3'])
  tags = new Map<string, string[]>()
  quick: { revision: number; items: QuickAccessItem[] } = { revision: 0, items: [] }
  calls: string[] = []
  /** Bumps the revision before the next PUT, as if another device saved. */
  racePuts = 0

  canonical(name: string, exceptEntry?: string): string {
    for (const [entryId, names] of this.tags) {
      if (entryId === exceptEntry) continue
      const hit = names.find(item => tagKey(item) === tagKey(name))
      if (hit) return hit
    }
    return name
  }

  normalizeQuick(items: QuickAccessItem[]): QuickAccessItem[] {
    return items.filter(item => item.kind === 'skill' ? this.entries.has(item.ref) : [...this.tags.values()].some(names => names.some(name => tagKey(name) === tagKey(item.ref))))
  }

  api(): OrganizerSyncApi {
    return {
      getTags: async () => { this.calls.push('GET tags'); return { tags: [...this.tags].filter(([id]) => this.entries.has(id)).map(([entryId, names]) => ({ entryId, names })) } },
      patchTags: async (entryId, { add, remove }) => {
        this.calls.push(`PATCH tags ${entryId} +${add.join(',')} -${remove.join(',')}`)
        if (!this.entries.has(entryId)) throw new HttpError(404)
        const removeKeys = new Set(remove.map(tagKey))
        const kept = (this.tags.get(entryId) ?? []).filter(name => !removeKeys.has(tagKey(name)))
        const present = new Set(kept.map(tagKey))
        const names = [...kept, ...add.filter(name => !present.has(tagKey(name)))]
        if (names.length > 8) throw new HttpError(400, 'A Skill can have at most 8 tags')
        const saved = names.map(name => this.canonical(name, entryId))
        if (saved.length === 0) this.tags.delete(entryId); else this.tags.set(entryId, saved)
        return { entryId, names: saved }
      },
      renameTag: async (from, to) => {
        this.calls.push(`rename ${from}->${to}`)
        if (![...this.tags.values()].some(names => names.some(name => tagKey(name) === tagKey(from)))) throw new HttpError(404, 'Tag not found')
        const target = tagKey(from) === tagKey(to) ? to : this.canonical(to)
        for (const [id, names] of this.tags) this.tags.set(id, [...new Map(names.map(name => tagKey(name) === tagKey(from) || tagKey(name) === tagKey(to) ? [tagKey(target), target] : [tagKey(name), name])).values()])
        return {}
      },
      deleteTag: async (name) => {
        this.calls.push(`delete ${name}`)
        for (const [id, names] of this.tags) {
          const kept = names.filter(item => tagKey(item) !== tagKey(name))
          if (kept.length) this.tags.set(id, kept); else this.tags.delete(id)
        }
        this.quick = { revision: this.quick.revision + 1, items: this.quick.items.filter(item => !(item.kind === 'tag' && tagKey(item.ref) === tagKey(name))) }
        return {}
      },
      getQuickAccess: async () => { this.calls.push('GET quick'); return { revision: this.quick.revision, items: this.normalizeQuick(this.quick.items) } },
      putQuickAccess: async (baseRevision, items) => {
        this.calls.push(`PUT quick @${baseRevision} ${items.map(item => item.ref).join(',')}`)
        if (this.racePuts > 0) { this.racePuts -= 1; this.quick = { ...this.quick, revision: this.quick.revision + 1 } }
        if (baseRevision !== this.quick.revision) throw new HttpError(409, 'Quick access changed on another device')
        this.quick = { revision: this.quick.revision + 1, items: this.normalizeQuick(items) }
        return { ...this.quick }
      },
    }
  }
}

function harness(initial: OrganizerState, server = new FakeServer()) {
  let state = initial
  let current = true
  return {
    server,
    get state() { return state },
    set state(value: OrganizerState) { state = value },
    switchAccount() { current = false },
    run: () => syncOrganizerOnce({
      api: server.api(),
      read: () => current ? state : null,
      commit: (update) => { if (!current) return false; state = update(state); return true },
      now: () => new Date('2026-10-15T08:00:00Z'),
    }),
  }
}

test('dirty entry tags upload, take the account casing from the Server and clear their dirty mark', async () => {
  const h = harness(ok(setSkillTags(emptyOrganizerState(), 'entry:e1', ['daily', '写作'])))
  h.server.tags.set('e2', ['Daily'])
  assert.equal(organizerPendingCount(h.state), 1)
  const outcome = await h.run()
  assert.deepEqual(outcome, { ok: true, quickAccessConflict: null, rejected: [] })
  assert.deepEqual(h.state.tags, { 'entry:e1': ['Daily', '写作'], 'entry:e2': ['Daily'] })
  assert.deepEqual(h.state.sync.dirtyTagKeys, [])
  assert.equal(h.state.sync.lastSyncedAt, '2026-10-15T08:00:00.000Z')
  assert.equal(organizerPendingCount(h.state), 0)
})

test('the Server wins for clean keys; local-only Skills never upload; missing Server tags drop clean entry keys', async () => {
  let state = ok(setSkillTags(emptyOrganizerState(), 'local:s9', ['本机']))
  state = { ...state, tags: { ...state.tags, 'entry:e3': ['旧'] }, sync: { ...state.sync, dirtyTagKeys: ['local:s9'] } }
  const h = harness(state)
  h.server.tags.set('e1', ['服务端'])
  await h.run()
  assert.deepEqual(h.state.tags, { 'local:s9': ['本机'], 'entry:e1': ['服务端'] })
  assert.deepEqual(h.state.sync.dirtyTagKeys, ['local:s9'])
  assert.equal(h.server.calls.some(call => call.includes('s9')), false)
})

test('a 404 entry (deleted or not owned) drops its local tags', async () => {
  const h = harness(ok(setSkillTags(emptyOrganizerState(), 'entry:gone', ['写作'])))
  const outcome = await h.run()
  assert.equal(outcome.ok, true)
  assert.deepEqual(h.state.tags, {})
  assert.deepEqual(h.state.sync.dirtyTagKeys, [])
})

test('a rekeyed local Skill uploads its tags under the library entry', async () => {
  const local = ok(setSkillTags(emptyOrganizerState(), 'local:s1', ['迁移']))
  const h = harness(rekeyOrganizer(local, [{ id: 's1', libraryEntryId: 'e2', libraryAccountId: USER }], USER))
  await h.run()
  assert.deepEqual(h.server.tags.get('e2'), ['迁移'])
  assert.deepEqual(h.state.tags, { 'entry:e2': ['迁移'] })
})

test('pending rename and delete replay before uploads, including a case-only rename', async () => {
  const server = new FakeServer()
  server.tags.set('e1', ['daily', '旧标签'])
  server.tags.set('e2', ['daily'])
  let state = { ...emptyOrganizerState(), tags: { 'entry:e1': ['daily', '旧标签'], 'entry:e2': ['daily'] } }
  state = ok(renameTag(state, 'daily', 'Daily'))
  state = deleteTag(state, '旧标签')
  assert.equal(state.sync.pendingOps.length, 2)
  const h = harness(state, server)
  await h.run()
  assert.deepEqual(server.calls.slice(0, 2), ['rename daily->Daily', 'delete 旧标签'])
  assert.deepEqual([server.tags.get('e1'), server.tags.get('e2')], [['Daily'], ['Daily']])
  assert.deepEqual(h.state.tags, { 'entry:e1': ['Daily'], 'entry:e2': ['Daily'] })
  assert.deepEqual(h.state.sync.pendingOps, [])
})

test('a rename of a tag the Server never had (404) is simply dropped', async () => {
  let state = ok(setSkillTags(emptyOrganizerState(), 'local:s1', ['本机']))
  state = ok(renameTag(state, '本机', '本机二'))
  const h = harness(state)
  const outcome = await h.run()
  assert.equal(outcome.ok, true)
  assert.deepEqual(h.state.sync.pendingOps, [])
})

test('a network failure keeps every pending change for the next pass', async () => {
  const state = ok(setSkillTags(emptyOrganizerState(), 'entry:e1', ['写作']))
  const h = harness(state)
  const api = h.server.api()
  const outcome = await syncOrganizerOnce({
    api: { ...api, patchTags: async () => { throw Object.assign(new Error('offline'), { kind: 'network' }) } },
    read: () => h.state,
    commit: (update) => { h.state = update(h.state); return true },
  })
  assert.deepEqual(outcome, { ok: false, aborted: false, error: 'offline' })
  assert.deepEqual(h.state.sync.dirtyTagKeys, ['entry:e1'])
})

test('edits made during a pass stay dirty and are not overwritten by the pull', async () => {
  const h = harness(ok(setSkillTags(emptyOrganizerState(), 'entry:e1', ['A'])))
  const api = h.server.api()
  const outcome = await syncOrganizerOnce({
    api: { ...api, patchTags: async (entryId, delta) => { const saved = await api.patchTags(entryId, delta); h.state = ok(setSkillTags(h.state, 'entry:e1', ['A', 'B'])); return saved } },
    read: () => h.state,
    commit: (update) => { h.state = update(h.state); return true },
  })
  assert.equal(outcome.ok, true)
  assert.deepEqual(h.state.tags['entry:e1'], ['A', 'B'])
  assert.deepEqual(h.state.sync.dirtyTagKeys, ['entry:e1'])
})

test('an account switch mid-flight aborts and never applies results to the next account', async () => {
  const h = harness(ok(setSkillTags(emptyOrganizerState(), 'entry:e1', ['A'])))
  const api = h.server.api()
  const before = h.state
  let switched = false
  const outcome = await syncOrganizerOnce({
    api: { ...api, patchTags: async (entryId, delta) => { const saved = await api.patchTags(entryId, delta); switched = true; return saved } },
    read: () => switched ? null : h.state,
    commit: (update) => { if (switched) return false; h.state = update(h.state); return true },
  })
  assert.deepEqual(outcome, { ok: false, aborted: true })
  assert.equal(h.state, before)
  assert.equal(h.server.calls.includes('GET tags'), false)
})

test('quick access maps entry refs to bare ids, keeps local-only Skills local and adopts the Server revision', async () => {
  let state = ok(setSkillTags(emptyOrganizerState(), 'entry:e1', ['写作']))
  state = ok(addQuickAccess(state, { kind: 'skill', ref: 'local:s1' }))
  state = ok(addQuickAccess(state, { kind: 'tag', ref: '写作' }))
  state = ok(addQuickAccess(state, { kind: 'skill', ref: 'entry:e1' }))
  assert.deepEqual(quickAccessToServer(state.quickAccess.items, state), [{ kind: 'tag', ref: '写作' }, { kind: 'skill', ref: 'e1' }])
  const h = harness(state)
  await h.run()
  assert.deepEqual(h.server.quick, { revision: 1, items: [{ kind: 'tag', ref: '写作' }, { kind: 'skill', ref: 'e1' }] })
  assert.deepEqual(h.state.quickAccess, { revision: 1, items: [{ kind: 'skill', ref: 'local:s1' }, { kind: 'tag', ref: '写作' }, { kind: 'skill', ref: 'entry:e1' }] })
  assert.deepEqual(h.state.sync.quickAccessBase, h.server.quick.items)
  assert.equal(h.state.sync.quickAccessDirty, false)
})

test('a clean device adopts the Server list', async () => {
  const server = new FakeServer()
  server.tags.set('e1', ['写作'])
  server.quick = { revision: 7, items: [{ kind: 'skill', ref: 'e2' }, { kind: 'tag', ref: '写作' }] }
  const h = harness(emptyOrganizerState(), server)
  await h.run()
  assert.deepEqual(h.state.quickAccess, { revision: 7, items: [{ kind: 'skill', ref: 'entry:e2' }, { kind: 'tag', ref: '写作' }] })
  assert.equal(server.calls.some(call => call.startsWith('PUT quick')), false)
})

/** Two devices of one account against the same Server, both synced once. */
async function twoDevices(server: FakeServer, setup: (state: OrganizerState) => OrganizerState) {
  const a = harness(setup(emptyOrganizerState()), server)
  await a.run()
  const b = harness(emptyOrganizerState(), server)
  await b.run()
  const qa = (h: { state: OrganizerState }): string => h.state.quickAccess.items.map(item => `${item.kind}:${item.ref}`).join(',')
  return { a, b, qa }
}

test('E2E 6: A adds Z while B removes X → merged, X stays removed, both converge', async () => {
  const server = new FakeServer()
  const { a, b, qa } = await twoDevices(server, state => ok(addQuickAccess(ok(addQuickAccess(state, { kind: 'skill', ref: 'entry:e1' })), { kind: 'skill', ref: 'entry:e2' })))
  a.state = ok(addQuickAccess(a.state, { kind: 'skill', ref: 'entry:e3' }))
  b.state = removeQuickAccess(b.state, { kind: 'skill', ref: 'entry:e1' })
  assert.equal((await b.run()).ok, true)
  const outcome = await a.run()
  assert.deepEqual(outcome, { ok: true, quickAccessConflict: 'merged', rejected: [] })
  await b.run()
  assert.equal(qa(a), 'skill:entry:e2,skill:entry:e3')
  assert.equal(qa(b), qa(a))
})

test('E2E 7: A(−Y,+tag) vs B(+X,−tag2) → each side keeps the other’s changes', async () => {
  const server = new FakeServer()
  const { a, b, qa } = await twoDevices(server, (state) => {
    let next = ok(setSkillTags(state, 'entry:e2', ['WORK']))
    next = ok(addQuickAccess(next, { kind: 'skill', ref: 'entry:e2' }))
    return ok(addQuickAccess(next, { kind: 'tag', ref: 'WORK' }))
  })
  a.state = removeQuickAccess(a.state, { kind: 'skill', ref: 'entry:e2' })
  a.state = ok(setSkillTags(a.state, 'entry:e3', ['zed']))
  await a.run()
  a.state = ok(addQuickAccess(a.state, { kind: 'tag', ref: 'zed' }))
  b.state = ok(addQuickAccess(b.state, { kind: 'skill', ref: 'entry:e1' }))
  b.state = removeQuickAccess(b.state, { kind: 'tag', ref: 'WORK' })
  await a.run()
  await b.run()
  await a.run()
  assert.equal(qa(a), 'tag:zed,skill:entry:e1')
  assert.equal(qa(b), qa(a))
})

test('E2E 10: pins of a local-only Skill and of a tag only local Skills carry survive sync', async () => {
  let state = ok(setSkillTags(emptyOrganizerState(), 'local:abc', ['draft']))
  state = ok(addQuickAccess(state, { kind: 'skill', ref: 'local:abc' }))
  state = ok(addQuickAccess(state, { kind: 'tag', ref: 'draft' }))
  state = ok(addQuickAccess(state, { kind: 'skill', ref: 'entry:e1' }))
  const h = harness(state)
  await h.run()
  assert.deepEqual(h.server.quick.items, [{ kind: 'skill', ref: 'e1' }])
  assert.deepEqual(h.state.quickAccess.items.map(item => item.ref), ['local:abc', 'draft', 'entry:e1'])
  // Once the tag reaches a library entry it uploads like any other pin.
  h.state = ok(setSkillTags(h.state, 'entry:e1', ['draft']))
  await h.run()
  assert.deepEqual(h.server.quick.items.map(item => item.ref), ['draft', 'e1'])
  assert.deepEqual(h.state.quickAccess.items.map(item => item.ref), ['local:abc', 'draft', 'entry:e1'])
})

test('E2E 11: a stale device adding one item does not resurrect another device’s removal', async () => {
  const server = new FakeServer()
  const { a, b, qa } = await twoDevices(server, (state) => {
    const next = ok(setSkillTags(state, 'entry:e3', ['offline']))
    return ok(addQuickAccess(ok(addQuickAccess(next, { kind: 'skill', ref: 'entry:e1' })), { kind: 'skill', ref: 'entry:e2' }))
  })
  a.state = removeQuickAccess(a.state, { kind: 'skill', ref: 'entry:e1' })
  await a.run()
  b.state = ok(addQuickAccess(b.state, { kind: 'tag', ref: 'offline' }))
  await b.run()
  await a.run()
  assert.equal(qa(b), 'skill:entry:e2,tag:offline')
  assert.equal(qa(a), qa(b))
})

test('a second conflict keeps the local edits dirty against the old base and retries next pass', async () => {
  const server = new FakeServer()
  server.quick = { revision: 1, items: [{ kind: 'skill', ref: 'e2' }] }
  let state: OrganizerState = { ...emptyOrganizerState(), quickAccess: { revision: 1, items: [{ kind: 'skill', ref: 'entry:e2' }] } }
  state = { ...state, sync: { ...state.sync, quickAccessBase: [{ kind: 'skill', ref: 'e2' }] } }
  state = ok(addQuickAccess(state, { kind: 'skill', ref: 'entry:e1' }))
  const h = harness(state, server)
  server.racePuts = 2
  assert.deepEqual(await h.run(), { ok: true, quickAccessConflict: 'pending', rejected: [] })
  assert.equal(h.state.sync.quickAccessDirty, true)
  assert.deepEqual(h.state.quickAccess.items.map(item => item.ref), ['entry:e2', 'entry:e1'])
  assert.deepEqual(h.state.sync.quickAccessBase, [{ kind: 'skill', ref: 'e2' }])
  assert.deepEqual(await h.run(), { ok: true, quickAccessConflict: 'merged', rejected: [] })
  assert.deepEqual(server.quick.items.map(item => item.ref), ['e2', 'e1'])
  assert.equal(h.state.sync.quickAccessDirty, false)
})

test('a deleted Skill pruned from quick access syncs its removal', async () => {
  const server = new FakeServer()
  server.quick = { revision: 1, items: [{ kind: 'skill', ref: 'e1' }, { kind: 'skill', ref: 'e2' }] }
  const base = { ...emptyOrganizerState(), quickAccess: { revision: 1, items: quickAccessFromServer(server.quick.items) } }
  const h = harness({ ...base, sync: { ...base.sync, quickAccessBase: server.quick.items } }, server)
  h.state = pruneQuickAccess(h.state, new Set(['entry:e2']))
  assert.equal(h.state.sync.quickAccessDirty, true)
  await h.run()
  assert.deepEqual(server.quick.items, [{ kind: 'skill', ref: 'e2' }])
})

test('pending operations are committed one by one, so a failure later keeps only the rest', async () => {
  let state = { ...emptyOrganizerState(), tags: { 'entry:e1': ['a', 'b'] } }
  state = deleteTag(state, 'a')
  state = deleteTag(state, 'b')
  const h = harness(state)
  const api = h.server.api()
  let calls = 0
  const outcome = await syncOrganizerOnce({
    api: { ...api, deleteTag: async (name) => { calls += 1; if (calls === 2) throw Object.assign(new Error('offline'), { kind: 'network' }); return api.deleteTag(name) } },
    read: () => h.state,
    commit: (update) => { h.state = update(h.state); return true },
  })
  assert.equal(outcome.ok, false)
  assert.deepEqual(h.state.sync.pendingOps, [{ op: 'delete', name: 'b' }])
})

test('helpers: local-only items keep their positions; three-way merge against the base', () => {
  const state = { ...emptyOrganizerState(), tags: { 'entry:e1': ['a'] } }
  assert.deepEqual(withLocalOnlyItems([{ kind: 'tag', ref: 'a' }], [{ kind: 'skill', ref: 'local:x' }, { kind: 'tag', ref: 'a' }], state), [{ kind: 'skill', ref: 'local:x' }, { kind: 'tag', ref: 'a' }])
  const server = [{ kind: 'tag' as const, ref: 'A' }, { kind: 'tag' as const, ref: 'b' }, { kind: 'tag' as const, ref: 'n' }]
  const base = [{ kind: 'tag' as const, ref: 'a' }, { kind: 'tag' as const, ref: 'b' }]
  // Local removed a, added c; the Server's own addition n stays.
  assert.deepEqual(mergeQuickAccess(server, [{ kind: 'tag', ref: 'b' }, { kind: 'tag', ref: 'c' }], base).map(item => item.ref), ['b', 'n', 'c'])
  // Without a base every local item is an addition and nothing is removed.
  assert.deepEqual(mergeQuickAccess(server, [{ kind: 'tag', ref: 'c' }], null).map(item => item.ref), ['A', 'b', 'n', 'c'])
})

test('E2E 13: a pin of a tag renamed on another device does not linger as device-only', async () => {
  const server = new FakeServer()
  const { a, b, qa } = await twoDevices(server, state => ok(setSkillTags(state, 'entry:e1', ['u'])))
  a.state = ok(renameTag(a.state, 'u', 'v'))
  await a.run()
  // B was offline: it still has u and pins it.
  b.state = ok(addQuickAccess(b.state, { kind: 'tag', ref: 'u' }))
  await b.run()
  assert.deepEqual(b.state.tags, { 'entry:e1': ['v'] })
  assert.equal(qa(b).includes('tag:u'), false)
  assert.deepEqual(server.quick.items, [])
  // A tag that only local Skills carry is still device-only.
  b.state = ok(setSkillTags(b.state, 'local:s1', ['草稿']))
  b.state = ok(addQuickAccess(b.state, { kind: 'tag', ref: '草稿' }))
  await b.run()
  assert.equal(qa(b), 'tag:草稿')
  assert.deepEqual(server.quick.items, [])
  void a
})

test('P2-1: concurrent offline additions on the same Skill are both kept', async () => {
  const server = new FakeServer()
  server.tags.set('e1', ['Base'])
  const a = harness(emptyOrganizerState(), server)
  const b = harness(emptyOrganizerState(), server)
  await a.run(); await b.run()
  a.state = ok(setSkillTags(a.state, 'entry:e1', ['Base', 'Added-A']))
  b.state = ok(setSkillTags(b.state, 'entry:e1', ['Base', 'Added-B']))
  await a.run(); await b.run(); await a.run()
  assert.deepEqual(server.tags.get('e1'), ['Base', 'Added-A', 'Added-B'])
  assert.deepEqual(a.state.tags['entry:e1'], ['Base', 'Added-A', 'Added-B'])
  assert.deepEqual(b.state.tags['entry:e1'], ['Base', 'Added-A', 'Added-B'])
  assert.deepEqual(a.state.sync.tagBase['entry:e1'], ['Base', 'Added-A', 'Added-B'])
})

test('P2-1: a removal on one device is not undone by another device adding a tag', async () => {
  const server = new FakeServer()
  server.tags.set('e1', ['Base', 'X'])
  const a = harness(emptyOrganizerState(), server)
  const b = harness(emptyOrganizerState(), server)
  await a.run(); await b.run()
  a.state = ok(setSkillTags(a.state, 'entry:e1', ['Base']))
  b.state = ok(setSkillTags(b.state, 'entry:e1', ['Base', 'X', 'Y']))
  await b.run(); await a.run(); await b.run()
  assert.deepEqual(server.tags.get('e1'), ['Base', 'Y'])
  assert.deepEqual([a.state.tags['entry:e1'], b.state.tags['entry:e1']], [['Base', 'Y'], ['Base', 'Y']])
  assert.equal(server.calls.some(call => call.includes('+X')), false)
})

test('P2-1: deltas against the base; a combined limit overflow is rejected and the Server state restored', async () => {
  assert.deepEqual(tagDelta(['Base', 'x'], ['base', 'Y']), { add: ['Y'], remove: ['x'] })
  const server = new FakeServer()
  server.tags.set('e1', ['1', '2', '3', '4', '5', '6', '7'])
  const a = harness(emptyOrganizerState(), server)
  await a.run()
  server.tags.set('e1', ['1', '2', '3', '4', '5', '6', '7', 'other'])
  a.state = ok(setSkillTags(a.state, 'entry:e1', ['1', '2', '3', '4', '5', '6', '7', 'mine']))
  const outcome = await a.run()
  assert.equal(outcome.ok && outcome.rejected.length, 1)
  assert.deepEqual(a.state.tags['entry:e1'], ['1', '2', '3', '4', '5', '6', '7', 'other'])
  assert.deepEqual(a.state.sync.dirtyTagKeys, [])
})

test('P2-2: a failed capability probe stays unknown, retries with backoff and on wake; only a real answer decides', async () => {
  const { startCapabilityProbe } = await import('../src/lib/organizer-sync.ts')
  const reports: string[] = []
  const timers: number[] = []
  let answer: () => Promise<{ capabilities?: string[] }> = async () => { throw new Error('offline') }
  const prober = startCapabilityProbe({
    health: () => answer(),
    report: (capability, failed) => { reports.push(`${capability}${failed ? '!' : ''}`) },
    setTimer: (_run, delay) => { timers.push(delay); return delay },
    clearTimer: () => {},
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(reports, ['unknown!'])
  assert.deepEqual(timers, [30_000])
  prober.wake()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(timers, [30_000, 120_000])
  answer = async () => ({ capabilities: ['skills.library-organizer.v1'] })
  prober.wake() // online
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(reports, ['unknown!', 'unknown!', 'supported'])
  prober.wake()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(reports.length, 3)
  prober.stop()
  const other: string[] = []
  startCapabilityProbe({ health: async () => ({ capabilities: [] }), report: c => { other.push(c) }, setTimer: () => 0, clearTimer: () => {} })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(other, ['unsupported'])
})

test('E2E 19: an edit made while a tag PATCH is in flight keeps other devices’ tags', async () => {
  const server = new FakeServer()
  server.tags.set('e1', ['base'])
  const a = harness(emptyOrganizerState(), server)
  const b = harness(emptyOrganizerState(), server)
  await a.run(); await b.run()
  b.state = ok(setSkillTags(b.state, 'entry:e1', ['base', 'fromB']))
  await b.run()
  a.state = ok(setSkillTags(a.state, 'entry:e1', ['base', 'a1']))
  const api = server.api()
  await syncOrganizerOnce({
    api: { ...api, patchTags: async (entryId, delta) => { const saved = await api.patchTags(entryId, delta); a.state = ok(setSkillTags(a.state, 'entry:e1', ['base', 'a1', 'a2'])); return saved } },
    read: () => a.state,
    commit: (update) => { a.state = update(a.state); return true },
  })
  assert.deepEqual(a.state.tags['entry:e1'], ['base', 'fromB', 'a1', 'a2'])
  assert.deepEqual(a.state.sync.tagBase['entry:e1'], ['base', 'fromB', 'a1'])
  assert.deepEqual(a.state.sync.dirtyTagKeys, ['entry:e1'])
  await a.run(); await b.run()
  assert.deepEqual(server.tags.get('e1'), ['base', 'fromB', 'a1', 'a2'])
  assert.deepEqual(b.state.tags['entry:e1'], ['base', 'fromB', 'a1', 'a2'])
  assert.deepEqual(rebaseTags(['x', 'Y'], ['x', 'y'], ['z']), ['z'])
})

test('E2E 19 (quick access): an edit while the PUT is in flight is replayed on the Server result', async () => {
  const server = new FakeServer()
  server.quick = { revision: 1, items: [{ kind: 'skill', ref: 'e1' }] }
  const a = harness(emptyOrganizerState(), server)
  await a.run()
  a.state = ok(addQuickAccess(a.state, { kind: 'skill', ref: 'entry:e2' }))
  const api = server.api()
  await syncOrganizerOnce({
    api: { ...api, putQuickAccess: async (revision, items) => {
      const saved = await api.putQuickAccess(revision, items)
      // In flight: remove what was just added and add another.
      a.state = ok(addQuickAccess(removeQuickAccess(a.state, { kind: 'skill', ref: 'entry:e2' }), { kind: 'skill', ref: 'entry:e3' }))
      return saved
    } },
    read: () => a.state,
    commit: (update) => { a.state = update(a.state); return true },
  })
  assert.deepEqual(a.state.quickAccess.items.map(item => item.ref), ['entry:e1', 'entry:e3'])
  assert.deepEqual(a.state.sync.quickAccessBase?.map(item => item.ref), ['e1', 'e2'])
  assert.equal(a.state.sync.quickAccessDirty, true)
  await a.run()
  // The in-flight removal is not resurrected; the addition reaches the Server.
  assert.deepEqual(server.quick.items.map(item => item.ref), ['e1', 'e3'])
  assert.deepEqual(a.state.quickAccess.items.map(item => item.ref), ['entry:e1', 'entry:e3'])
  assert.equal(a.state.sync.quickAccessDirty, false)
})
