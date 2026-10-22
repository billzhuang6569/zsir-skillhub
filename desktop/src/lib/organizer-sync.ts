// #326 (EPIC #321): sync the account's private tags and quick access with the
// Server (`skills.library-organizer.v1`, #322). The local organizer file stays
// the offline cache; the Server is the source of truth for everything that is
// not a pending local edit.
//
// Order of one pass: replay pending account-wide tag operations (rename /
// delete) → upload per-entry tag sets marked dirty → pull all tags → reconcile
// quick access with revision CAS. Every write back goes through `commit`,
// which refuses once the account changed, and only touches keys whose local
// value is still what was uploaded, so edits made during a pass survive.

import type { OrganizerState, PendingTagOp, QuickAccessItem } from './skill-organizer.js'
import { itemIdentity, QUICK_ACCESS_ITEMS_MAX, sameQuickAccessItems, tagKey } from './skill-organizer.js'

export const ORGANIZER_SYNC_CAPABILITY = 'skills.library-organizer.v1'
export const ORGANIZER_SYNC_DEBOUNCE_MS = 1500
export const ORGANIZER_SYNC_INTERVAL_MS = 5 * 60_000
/** Retry delays after a failed or still-conflicting pass. */
export const ORGANIZER_SYNC_RETRY_MS = [30_000, 2 * 60_000, 5 * 60_000] as const
/** Per-request timeout, so a hung request cannot hold the single-flight slot. */
export const ORGANIZER_SYNC_REQUEST_TIMEOUT_MS = 15_000

type TagSet = { entryId: string; names: string[] }
type ServerQuickAccess = { revision: number; items: QuickAccessItem[] }

export type OrganizerSyncApi = {
  getTags: () => Promise<{ tags: TagSet[] }>
  /** Atomic delta against the entry's stored tags (remove by name key, then add). */
  patchTags: (entryId: string, delta: { add: string[]; remove: string[] }) => Promise<TagSet>
  renameTag: (from: string, to: string) => Promise<unknown>
  deleteTag: (name: string) => Promise<unknown>
  getQuickAccess: () => Promise<ServerQuickAccess>
  putQuickAccess: (baseRevision: number, items: QuickAccessItem[]) => Promise<ServerQuickAccess>
}

export type OrganizerSyncContext = {
  api: OrganizerSyncApi
  /** The latest organizer of the syncing account, or null once another account is current. */
  read: () => OrganizerState | null
  /** Apply a change to the latest state; false (nothing applied) once the account changed. */
  commit: (update: (latest: OrganizerState) => OrganizerState) => boolean
  now?: () => Date
}

export type OrganizerSyncOutcome =
  | { ok: true; quickAccessConflict: QuickAccessConflict; rejected: string[] }
  | { ok: false; aborted: true }
  | { ok: false; aborted: false; error: string }

/** `merged`: a 409 was merged and saved; `pending`: still conflicting, local edits kept for the next pass. */
export type QuickAccessConflict = 'merged' | 'pending' | null

class SyncAborted extends Error {}

const ENTRY_PREFIX = 'entry:'

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index])
}

/** Local intent relative to the last synced names, by case-insensitive key. */
export function tagDelta(base: readonly string[], local: readonly string[]): { add: string[]; remove: string[] } {
  const baseKeys = new Set(base.map(tagKey))
  const localKeys = new Set(local.map(tagKey))
  return {
    add: local.filter(name => !baseKeys.has(tagKey(name))),
    remove: base.filter(name => !localKeys.has(tagKey(name))),
  }
}

function sameTagKeys(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(tagKey))
  return a.length === b.length && b.every(name => left.has(tagKey(name)))
}

/** `saved` plus the edits made between `snapshot` and `current` (case-insensitive). */
export function rebaseTags(saved: readonly string[], snapshot: readonly string[], current: readonly string[]): string[] {
  const later = tagDelta(snapshot, current)
  const removed = new Set(later.remove.map(tagKey))
  const result = saved.filter(name => !removed.has(tagKey(name)))
  const present = new Set(result.map(tagKey))
  for (const name of later.add) if (!present.has(tagKey(name))) { result.push(name); present.add(tagKey(name)) }
  return result
}

/** `server` items plus the quick-access edits made between `snapshot` and `current`, by identity. */
export function rebaseQuickAccess(server: readonly QuickAccessItem[], snapshot: readonly QuickAccessItem[], current: readonly QuickAccessItem[]): QuickAccessItem[] {
  const before = new Set(snapshot.map(itemIdentity))
  const after = new Set(current.map(itemIdentity))
  const removed = new Set([...before].filter(identity => !after.has(identity)))
  const result = dedupe(server).filter(item => !removed.has(itemIdentity(item)))
  const present = new Set(result.map(itemIdentity))
  for (const item of current) if (!before.has(itemIdentity(item)) && !present.has(itemIdentity(item))) { result.push(item); present.add(itemIdentity(item)) }
  // Same members as the local list: keep the local order (a move made in flight).
  if (result.length === current.length && current.every(item => present.has(itemIdentity(item)))) return [...current]
  return result.slice(0, QUICK_ACCESS_ITEMS_MAX)
}

function sameOp(a: PendingTagOp | undefined, b: PendingTagOp): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Number of local changes waiting for upload, for the settings status. */
export function organizerPendingCount(state: OrganizerState): number {
  return state.sync.dirtyTagKeys.filter(key => key.startsWith(ENTRY_PREFIX)).length
    + state.sync.pendingOps.length
    + (state.sync.quickAccessDirty ? 1 : 0)
}

type TagPlaces = { onEntries: Set<string>; onLocalSkills: Set<string> }

/** Where each tag lives: on library entries (the Server knows it) and/or on `local:` Skills. */
function tagPlaces(state: OrganizerState): TagPlaces {
  const places: TagPlaces = { onEntries: new Set(), onLocalSkills: new Set() }
  for (const [key, names] of Object.entries(state.tags)) {
    const target = key.startsWith(ENTRY_PREFIX) ? places.onEntries : places.onLocalSkills
    for (const name of names) target.add(tagKey(name))
  }
  return places
}

/**
 * Items that never leave the device: `local:` Skills, and tags carried only by
 * `local:` Skills (the Server would drop a tag it does not know). A pinned tag
 * that exists nowhere (e.g. renamed on another device) is an ordinary shared
 * item, so the Server merge removes it instead of keeping it here forever.
 */
export function isLocalOnlyItem(item: QuickAccessItem, state: OrganizerState, places = tagPlaces(state)): boolean {
  if (item.kind === 'skill') return !item.ref.startsWith(ENTRY_PREFIX)
  const key = tagKey(item.ref)
  return !places.onEntries.has(key) && places.onLocalSkills.has(key)
}

/** Local `entry:<id>` Skill refs become bare entry ids; local-only items are left out. */
export function quickAccessToServer(items: readonly QuickAccessItem[], state: OrganizerState): QuickAccessItem[] {
  const known = tagPlaces(state)
  return items.flatMap((item): QuickAccessItem[] => {
    if (isLocalOnlyItem(item, state, known)) return []
    return item.kind === 'tag' ? [item] : [{ kind: 'skill', ref: item.ref.slice(ENTRY_PREFIX.length) }]
  })
}

export function quickAccessFromServer(items: readonly QuickAccessItem[]): QuickAccessItem[] {
  return items.map(item => item.kind === 'skill' ? { kind: 'skill' as const, ref: `${ENTRY_PREFIX}${item.ref}` } : { kind: 'tag' as const, ref: item.ref })
}

function dedupe(items: readonly QuickAccessItem[]): QuickAccessItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const identity = itemIdentity(item)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

/** Server order, then this device's local-only items back at their local positions. */
export function withLocalOnlyItems(server: readonly QuickAccessItem[], local: readonly QuickAccessItem[], state: OrganizerState): QuickAccessItem[] {
  const known = tagPlaces(state)
  const result = dedupe(server)
  const present = new Set(result.map(itemIdentity))
  local.forEach((item, index) => {
    if (isLocalOnlyItem(item, state, known) && !present.has(itemIdentity(item))) {
      result.splice(Math.min(index, result.length), 0, item)
      present.add(itemIdentity(item))
    }
  })
  return result.slice(0, QUICK_ACCESS_ITEMS_MAX)
}

/**
 * Three-way merge in Server refs: start from the Server's current list, drop
 * what this device removed since `base`, append what it added (in local order).
 * Without a base (never synced) every local item counts as an addition.
 */
export function mergeQuickAccess(server: readonly QuickAccessItem[], local: readonly QuickAccessItem[], base: readonly QuickAccessItem[] | null): QuickAccessItem[] {
  const baseIds = new Set((base ?? []).map(itemIdentity))
  const localIds = new Set(local.map(itemIdentity))
  const removed = new Set([...baseIds].filter(identity => !localIds.has(identity)))
  const result = dedupe(server).filter(item => !removed.has(itemIdentity(item)))
  const present = new Set(result.map(itemIdentity))
  for (const item of local) {
    const identity = itemIdentity(item)
    if (!baseIds.has(identity) && !present.has(identity)) { result.push(item); present.add(identity) }
  }
  return result.slice(0, QUICK_ACCESS_ITEMS_MAX)
}

export async function syncOrganizerOnce(context: OrganizerSyncContext): Promise<OrganizerSyncOutcome> {
  const { api } = context
  const read = (): OrganizerState => {
    const state = context.read()
    if (!state) throw new SyncAborted()
    return state
  }
  const commit = (update: (latest: OrganizerState) => OrganizerState): void => {
    if (!context.commit(update)) throw new SyncAborted()
  }
  const rejected: string[] = []
  try {
    // 1. Account-wide operations, in order, each committed once the Server has it.
    //    A tag the Server never had (404) is done; a rejected one (400) is dropped.
    for (const op of read().sync.pendingOps) {
      try {
        if (op.op === 'rename') await api.renameTag(op.from, op.to)
        else await api.deleteTag(op.name)
      } catch (error) {
        if (statusOf(error) === 400) rejected.push(messageOf(error))
        else if (statusOf(error) !== 404) throw error
      }
      commit(latest => sameOp(latest.sync.pendingOps[0], op)
        ? { ...latest, sync: { ...latest.sync, pendingOps: latest.sync.pendingOps.slice(1) } }
        : latest)
    }

    // 2. Per-entry uploads of dirty tag sets as deltas against `tagBase` (the
    //    Server's names at the last sync), so concurrent edits on other devices
    //    are kept and their removals are not undone. `local:` keys wait for their rekey.
    const dropDirty = (latest: OrganizerState, key: string): OrganizerState['sync'] =>
      ({ ...latest.sync, dirtyTagKeys: latest.sync.dirtyTagKeys.filter(item => item !== key) })
    for (const key of read().sync.dirtyTagKeys.filter(item => item.startsWith(ENTRY_PREFIX))) {
      const snapshot = read()
      const names = snapshot.tags[key] ?? []
      const delta = tagDelta(snapshot.sync.tagBase[key] ?? [], names)
      if (delta.add.length === 0 && delta.remove.length === 0) {
        // Nothing to send (e.g. a casing change the Server decides): the pull below settles it.
        commit(latest => sameNames(latest.tags[key] ?? [], names) ? { ...latest, sync: dropDirty(latest, key) } : latest)
        continue
      }
      let saved: string[] | null
      try {
        saved = (await api.patchTags(key.slice(ENTRY_PREFIX.length), delta)).names
      } catch (error) {
        const status = statusOf(error)
        if (status === 400) {
          // Invalid for the Server (e.g. tag limit after other devices' additions): stop retrying; the pull restores Server state.
          rejected.push(messageOf(error))
          commit(latest => sameNames(latest.tags[key] ?? [], names) ? { ...latest, sync: dropDirty(latest, key) } : latest)
          continue
        }
        if (status !== 404) throw error
        saved = null // the entry was deleted or is not this account's: drop its local tags
      }
      commit((latest) => {
        const tagBase = { ...latest.sync.tagBase }
        if (saved && saved.length > 0) tagBase[key] = saved
        else delete tagBase[key]
        const tags = { ...latest.tags }
        // Edited again while the request was in flight: replay only those later edits
        // on top of what the Server saved, so other devices' tags in `saved` survive.
        const current = latest.tags[key] ?? []
        const rebased = sameNames(current, names) ? saved ?? [] : rebaseTags(saved ?? [], names, current)
        if (rebased.length > 0) tags[key] = rebased
        else delete tags[key]
        const settled = sameTagKeys(rebased, saved ?? [])
        return { ...latest, tags, sync: { ...(settled ? dropDirty(latest, key) : latest.sync), tagBase } }
      })
    }

    // 3. Pull: the Server's tag sets replace every non-dirty `entry:` key and become its base.
    const server = await api.getTags()
    commit((latest) => {
      const dirty = new Set(latest.sync.dirtyTagKeys)
      const tags: Record<string, string[]> = {}
      const tagBase: Record<string, string[]> = {}
      for (const [key, names] of Object.entries(latest.tags)) {
        if (!key.startsWith(ENTRY_PREFIX) || dirty.has(key)) tags[key] = names
      }
      for (const [key, names] of Object.entries(latest.sync.tagBase)) if (dirty.has(key)) tagBase[key] = names
      for (const set of server.tags) {
        const key = `${ENTRY_PREFIX}${set.entryId}`
        if (dirty.has(key) || set.names.length === 0) continue
        tags[key] = set.names
        tagBase[key] = set.names
      }
      const same = Object.keys(tags).length === Object.keys(latest.tags).length
        && Object.entries(tags).every(([key, names]) => sameNames(latest.tags[key] ?? [], names))
        && JSON.stringify(tagBase) === JSON.stringify(latest.sync.tagBase)
      return same ? latest : { ...latest, tags, sync: { ...latest.sync, tagBase } }
    })

    // 4. Quick access with revision CAS, merged against the last confirmed base.
    const snapshot = read()
    const local = snapshot.quickAccess
    const outgoing = quickAccessToServer(local.items, snapshot)
    let result: ServerQuickAccess
    let conflict: QuickAccessConflict = null
    // Also upload when the shareable part differs from the base without a local edit,
    // e.g. a pinned tag that only now reached a library entry.
    const base = snapshot.sync.quickAccessBase
    if (snapshot.sync.quickAccessDirty || (base !== null && !sameQuickAccessItems(outgoing, base))) {
      try {
        result = await api.putQuickAccess(local.revision, outgoing)
      } catch (error) {
        if (statusOf(error) !== 409) throw error
        const current = await api.getQuickAccess()
        const merged = mergeQuickAccess(current.items, outgoing, snapshot.sync.quickAccessBase)
        try {
          result = await api.putQuickAccess(current.revision, merged)
          conflict = 'merged'
        } catch (retryError) {
          if (statusOf(retryError) !== 409) throw retryError
          // Still racing another device: keep the local edits for the next pass.
          conflict = 'pending'
          result = current
        }
      }
    } else {
      result = await api.getQuickAccess()
    }
    const at = (context.now?.() ?? new Date()).toISOString()
    commit((latest) => {
      if (conflict === 'pending') {
        // The Server did not take our list: stays dirty against the old base for the next merge.
        return { ...latest, sync: { ...latest.sync, lastSyncedAt: at } }
      }
      const unchanged = sameQuickAccessItems(latest.quickAccess.items, local.items) && latest.sync.quickAccessDirty === snapshot.sync.quickAccessDirty
      if (!unchanged) {
        // Edited while the request was in flight: adopt the Server's result as the new base and
        // replay only those later edits on top, so nothing the Server holds is lost or resurrected.
        const serverLocal = withLocalOnlyItems(quickAccessFromServer(result.items), local.items, latest)
        const items = rebaseQuickAccess(serverLocal, local.items, latest.quickAccess.items)
        const settled = sameQuickAccessItems(quickAccessToServer(items, latest), result.items)
        return {
          ...latest,
          quickAccess: { revision: result.revision, items },
          sync: { ...latest.sync, quickAccessDirty: !settled, quickAccessBase: result.items, lastSyncedAt: at },
        }
      }
      return {
        ...latest,
        quickAccess: { revision: result.revision, items: withLocalOnlyItems(quickAccessFromServer(result.items), latest.quickAccess.items, latest) },
        sync: { ...latest.sync, quickAccessDirty: false, quickAccessBase: result.items, lastSyncedAt: at },
      }
    })
    return { ok: true, quickAccessConflict: conflict, rejected }
  } catch (error) {
    if (error instanceof SyncAborted || (error as { kind?: unknown } | null)?.kind === 'aborted') return { ok: false, aborted: true }
    return { ok: false, aborted: false, error: messageOf(error) }
  }
}

export type CapabilityProbeDeps = {
  health: () => Promise<{ capabilities?: string[] }>
  report: (capability: 'unknown' | 'supported' | 'unsupported', probeFailed: boolean) => void
  setTimer: (run: () => void, delay: number) => unknown
  clearTimer: (timer: unknown) => void
}

/**
 * Capability probe for organizer sync (#326). A failed /health stays `unknown`
 * (never sticky `unsupported`) and retries after 30 s / 2 min / 5 min; `wake`
 * (focus, online) probes again at once while unknown.
 */
export function startCapabilityProbe(deps: CapabilityProbeDeps): { wake: () => void; stop: () => void } {
  let stopped = false
  let inFlight = false
  let known = false
  let attempt = 0
  let timer: unknown = null
  const probe = (): void => {
    if (stopped || inFlight) return
    inFlight = true
    if (timer !== null) { deps.clearTimer(timer); timer = null }
    void deps.health().then((health) => {
      if (stopped) return
      attempt = 0
      known = true
      deps.report(health.capabilities?.includes(ORGANIZER_SYNC_CAPABILITY) ? 'supported' : 'unsupported', false)
    }, () => {
      if (stopped) return
      deps.report('unknown', true)
      timer = deps.setTimer(probe, ORGANIZER_SYNC_RETRY_MS[Math.min(attempt, ORGANIZER_SYNC_RETRY_MS.length - 1)]!)
      attempt += 1
    }).finally(() => { inFlight = false })
  }
  probe()
  return {
    wake: () => { if (!known) probe() },
    stop: () => { stopped = true; if (timer !== null) deps.clearTimer(timer) },
  }
}
