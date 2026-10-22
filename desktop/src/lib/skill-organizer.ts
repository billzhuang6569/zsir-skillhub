// #323 (EPIC #321): private per-account Skill tags and sidebar quick access.
//
// The whole account's organizer lives in one local file
// (`~/.skillhub/organizer/<userId|guest>.json`, see `library_organizer.rs`);
// these pure functions own every rule. Limits and name normalisation match the
// Server (`server/src/lib/library-organizer.ts`) so #326 can sync without
// surprises: 1–32 Unicode code points after NFC + trim + collapsed whitespace, no
// control/zero-width/bidi characters, case-insensitive identity where the
// account's first spelling wins, at most 8 tags per Skill, 200 per account and
// 100 quick-access items.

export const TAG_NAME_MAX_LENGTH = 32
export const TAGS_PER_SKILL_MAX = 8
export const DISTINCT_TAGS_PER_ACCOUNT_MAX = 200
export const QUICK_ACCESS_ITEMS_MAX = 100
export const ORGANIZER_VERSION = 1
export const GUEST_ORGANIZER_ACCOUNT = 'guest'

const INVISIBLE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/

export type QuickAccessItem = { kind: 'tag' | 'skill'; ref: string }

/**
 * Bookkeeping for Server sync (#326). `dirtyTagKeys` holds the **skill keys**
 * whose tag set changed since the last successful upload (the Server replaces
 * a Skill's tags per entry); `quickAccessDirty` marks a local quick-access edit.
 */
export type OrganizerSync = {
  dirtyTagKeys: string[]
  quickAccessDirty: boolean
  lastSyncedAt: string | null
  /**
   * Account-wide tag operations not yet replayed on the Server (#326), in order.
   * Per-entry PUTs cannot express a case-only rename or a delete across entries.
   */
  pendingOps: PendingTagOp[]
  /**
   * Quick access as the Server last confirmed it (Server refs: bare entry ids,
   * tag names); null before the first sync. Local additions and removals are
   * computed against it, so a stale device never resurrects another device's removal.
   */
  quickAccessBase: QuickAccessItem[] | null
  /** Per `entry:` key, the Server's tag names at the last sync; uploads are deltas against it. */
  tagBase: Record<string, string[]>
}

export type PendingTagOp = { op: 'rename'; from: string; to: string } | { op: 'delete'; name: string }

export type OrganizerState = {
  version: typeof ORGANIZER_VERSION
  /** skillKey (see `skillOrganizerKey`) → tag names in the order they were added. */
  tags: Record<string, string[]>
  /** Skill items reference a skillKey; tag items the tag's display name. */
  quickAccess: { revision: number; items: QuickAccessItem[] }
  /** `tagKey`s of collapsed groups on the 标签 page (#324); local only. */
  collapsedTags: string[]
  sync: OrganizerSync
}

export type OrganizerResult = { ok: true; state: OrganizerState } | { ok: false; error: string }

export type OrganizerSkill = { id: string; libraryEntryId?: string | null; libraryAccountId?: string | null }

export type TagSummary = { key: string; name: string; count: number }

export function emptyOrganizerState(): OrganizerState {
  return {
    version: ORGANIZER_VERSION,
    tags: {},
    quickAccess: { revision: 0, items: [] },
    collapsedTags: [],
    sync: { dirtyTagKeys: [], quickAccessDirty: false, lastSyncedAt: null, pendingOps: [], quickAccessBase: null, tagBase: {} },
  }
}

/** `guest` while signed out, otherwise the SkillHub user UUID. */
export function organizerAccountKey(userId: string | null | undefined): string {
  return userId || GUEST_ORGANIZER_ACCOUNT
}

/**
 * A Skill bound to the signed-in account's library is keyed by its stable
 * library entry, so tags follow it across devices; anything else by its local id.
 */
export function skillOrganizerKey(skill: OrganizerSkill, accountUserId: string | null = null): string {
  return skill.libraryEntryId && accountUserId && skill.libraryAccountId === accountUserId
    ? `entry:${skill.libraryEntryId}`
    : `local:${skill.id}`
}

function collapse(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/g, ' ')
}

/** Case-insensitive identity of a tag name (same as the Server's `tagKey`). */
export function tagKey(name: string): string {
  return collapse(name).toLocaleLowerCase('en-US')
}

export function normalizeTagName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = collapse(raw)
  if (!name) return { ok: false, error: '请输入目录名' }
  if (Array.from(name).length > TAG_NAME_MAX_LENGTH) return { ok: false, error: `目录名最多 ${TAG_NAME_MAX_LENGTH} 个字符` }
  if (INVISIBLE_CHARACTERS.test(name)) return { ok: false, error: '目录名不能包含不可见字符' }
  return { ok: true, name }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Defensive parse of a loaded file; anything unusable falls back to empty parts. */
export function normalizeOrganizerState(raw: unknown): OrganizerState {
  const state = emptyOrganizerState()
  if (!raw || typeof raw !== 'object') return state
  const input = raw as Record<string, unknown>
  if (input.tags && typeof input.tags === 'object') {
    for (const [skillKey, names] of Object.entries(input.tags as Record<string, unknown>)) {
      const clean = dedupe(stringArray(names).map(name => normalizeTagName(name)).flatMap(result => result.ok ? [result.name] : []))
        .slice(0, TAGS_PER_SKILL_MAX)
      if (clean.length > 0) state.tags[skillKey] = clean
    }
  }
  const quick = input.quickAccess as { revision?: unknown; items?: unknown } | undefined
  if (quick && typeof quick === 'object') {
    state.quickAccess.revision = typeof quick.revision === 'number' && Number.isInteger(quick.revision) && quick.revision >= 0 ? quick.revision : 0
    state.quickAccess.items = parseQuickAccessItems(Array.isArray(quick.items) ? quick.items : [])
  }
  state.collapsedTags = Array.from(new Set(stringArray(input.collapsedTags)))
  const sync = input.sync as Partial<OrganizerSync> | undefined
  if (sync && typeof sync === 'object') {
    state.sync = {
      dirtyTagKeys: Array.from(new Set(stringArray(sync.dirtyTagKeys))),
      quickAccessDirty: sync.quickAccessDirty === true,
      lastSyncedAt: typeof sync.lastSyncedAt === 'string' ? sync.lastSyncedAt : null,
      pendingOps: (Array.isArray(sync.pendingOps) ? sync.pendingOps : []).flatMap((raw): PendingTagOp[] => {
        const op = raw as Partial<{ op: string; from: unknown; to: unknown; name: unknown }> | null
        if (op?.op === 'rename' && typeof op.from === 'string' && typeof op.to === 'string') return [{ op: 'rename', from: op.from, to: op.to }]
        if (op?.op === 'delete' && typeof op.name === 'string') return [{ op: 'delete', name: op.name }]
        return []
      }).slice(-200),
      quickAccessBase: Array.isArray(sync.quickAccessBase) ? parseQuickAccessItems(sync.quickAccessBase) : null,
      tagBase: Object.fromEntries(Object.entries(sync.tagBase && typeof sync.tagBase === 'object' ? sync.tagBase : {})
        .map(([key, names]): [string, string[]] => [key, stringArray(names)])),
    }
  }
  return state
}

function parseQuickAccessItems(items: readonly unknown[]): QuickAccessItem[] {
  return items
    .filter((item): item is QuickAccessItem => Boolean(item) && typeof item === 'object'
      && ((item as QuickAccessItem).kind === 'tag' || (item as QuickAccessItem).kind === 'skill')
      && typeof (item as QuickAccessItem).ref === 'string' && (item as QuickAccessItem).ref.length > 0)
    .map(item => ({ kind: item.kind, ref: item.ref }))
    .slice(0, QUICK_ACCESS_ITEMS_MAX)
}

function dedupe(names: readonly string[]): string[] {
  const seen = new Set<string>()
  return names.filter((name) => {
    const key = tagKey(name)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The account's spelling of every tag, first occurrence wins. */
function canonicalNames(state: OrganizerState): Map<string, string> {
  const names = new Map<string, string>()
  for (const tags of Object.values(state.tags)) for (const name of tags) if (!names.has(tagKey(name))) names.set(tagKey(name), name)
  return names
}

export function canonicalTagName(state: OrganizerState, name: string): string | undefined {
  return canonicalNames(state).get(tagKey(name))
}

export function tagsForSkill(state: OrganizerState, skillKey: string): string[] {
  return state.tags[skillKey] ?? []
}

/**
 * Every tag of the account with the number of Skills carrying it, sorted by
 * name. With `liveSkillKeys`, only those Skills count and unused tags drop out.
 */
export function allTags(state: OrganizerState, liveSkillKeys?: ReadonlySet<string>): TagSummary[] {
  const summary = new Map<string, TagSummary>()
  for (const [skillKey, names] of Object.entries(state.tags)) {
    if (liveSkillKeys && !liveSkillKeys.has(skillKey)) continue
    for (const name of names) {
      const key = tagKey(name)
      const current = summary.get(key)
      if (current) current.count += 1
      else summary.set(key, { key, name, count: 1 })
    }
  }
  return Array.from(summary.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

function markDirty(sync: OrganizerSync, skillKeys: Iterable<string>): OrganizerSync {
  const dirty = new Set(sync.dirtyTagKeys)
  const before = dirty.size
  for (const key of skillKeys) dirty.add(key)
  return dirty.size === before ? sync : { ...sync, dirtyTagKeys: Array.from(dirty) }
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index])
}

/** Apply new tag sets, enforcing limits; marks changed Skills dirty. */
function applyTagSets(state: OrganizerState, next: Record<string, string[]>): OrganizerResult {
  const tags = { ...state.tags }
  const changed: string[] = []
  for (const [skillKey, names] of Object.entries(next)) {
    if (names.length > TAGS_PER_SKILL_MAX) return { ok: false, error: `每个 Skill 最多 ${TAGS_PER_SKILL_MAX} 个目录` }
    if (sameNames(tags[skillKey] ?? [], names)) continue
    changed.push(skillKey)
    if (names.length === 0) delete tags[skillKey]
    else tags[skillKey] = names
  }
  if (changed.length === 0) return { ok: true, state }
  const candidate: OrganizerState = { ...state, tags }
  if (allTags(candidate).length > DISTINCT_TAGS_PER_ACCOUNT_MAX && allTags(candidate).length > allTags(state).length) {
    return { ok: false, error: `每个账号最多 ${DISTINCT_TAGS_PER_ACCOUNT_MAX} 个目录` }
  }
  return { ok: true, state: pruneQuickAccessTags({ ...candidate, sync: markDirty(state.sync, changed) }) }
}

/** Replace one Skill's tags (deduped, account casing reused). */
export function setSkillTags(state: OrganizerState, skillKey: string, rawNames: readonly string[]): OrganizerResult {
  const canonical = canonicalNames({ ...state, tags: { ...state.tags, [skillKey]: [] } })
  const names: string[] = []
  for (const raw of rawNames) {
    const result = normalizeTagName(raw)
    if (!result.ok) return result
    names.push(canonical.get(tagKey(result.name)) ?? result.name)
  }
  return applyTagSets(state, { [skillKey]: dedupe(names) })
}

/**
 * Batch toggle from the tag popover: checking adds the tag to every listed
 * Skill that lacks it (all-or-nothing on limits); unchecking removes it from all.
 */
export function toggleTagOnSkills(state: OrganizerState, skillKeys: readonly string[], rawName: string, checked: boolean): OrganizerResult {
  const normalized = normalizeTagName(rawName)
  if (!normalized.ok) return normalized
  const key = tagKey(normalized.name)
  const name = canonicalTagName(state, normalized.name) ?? normalized.name
  const next: Record<string, string[]> = {}
  for (const skillKey of new Set(skillKeys)) {
    const current = tagsForSkill(state, skillKey)
    const has = current.some(tag => tagKey(tag) === key)
    if (checked && !has) {
      if (current.length >= TAGS_PER_SKILL_MAX) {
        return { ok: false, error: skillKeys.length > 1 ? `有 Skill 已在 ${TAGS_PER_SKILL_MAX} 个目录中，无法再加入` : `每个 Skill 最多 ${TAGS_PER_SKILL_MAX} 个目录` }
      }
      next[skillKey] = [...current, name]
    } else if (!checked && has) {
      next[skillKey] = current.filter(tag => tagKey(tag) !== key)
    }
  }
  return applyTagSets(state, next)
}

/** How many of the given Skills carry each tag key (for checked / indeterminate). */
export function tagCoverage(state: OrganizerState, skillKeys: readonly string[]): Map<string, number> {
  const coverage = new Map<string, number>()
  for (const skillKey of new Set(skillKeys)) {
    for (const name of tagsForSkill(state, skillKey)) coverage.set(tagKey(name), (coverage.get(tagKey(name)) ?? 0) + 1)
  }
  return coverage
}

/** Rename everywhere; renaming onto an existing tag merges into its spelling. */
export function renameTag(state: OrganizerState, from: string, rawTo: string): OrganizerResult {
  const normalized = normalizeTagName(rawTo)
  if (!normalized.ok) return normalized
  const fromKey = tagKey(from)
  const toKey = tagKey(normalized.name)
  const existing = canonicalTagName(state, normalized.name)
  const target = fromKey === toKey ? normalized.name : existing ?? normalized.name
  const next: Record<string, string[]> = {}
  for (const [skillKey, names] of Object.entries(state.tags)) {
    if (!names.some(name => tagKey(name) === fromKey)) continue
    next[skillKey] = dedupe(names.map(name => tagKey(name) === fromKey ? target : tagKey(name) === toKey ? target : name))
  }
  if (Object.keys(next).length === 0) return { ok: false, error: '目录不存在' }
  // A merge also takes the new spelling on Skills that only had the target tag.
  for (const [skillKey, names] of Object.entries(state.tags)) {
    if (next[skillKey] || !names.some(name => tagKey(name) === toKey && name !== target)) continue
    next[skillKey] = names.map(name => tagKey(name) === toKey ? target : name)
  }
  // Quick-access items follow the rename before the tag sets change, so they are not pruned.
  const items = state.quickAccess.items.map(item => item.kind === 'tag' && tagKey(item.ref) === fromKey ? { kind: 'tag' as const, ref: target } : item)
  const applied = applyTagSets(withQuickAccess(state, dedupeItems(items)), next)
  if (!applied.ok) return applied
  const collapsed = state.collapsedTags.includes(fromKey) ? Array.from(new Set([...state.collapsedTags.filter(key => key !== fromKey), toKey])) : state.collapsedTags
  const sync = { ...applied.state.sync, pendingOps: [...applied.state.sync.pendingOps, { op: 'rename' as const, from, to: target }] }
  return { ok: true, state: { ...applied.state, collapsedTags: collapsed, sync } }
}

/** Remove a tag from every Skill (the Skills stay). */
export function deleteTag(state: OrganizerState, name: string): OrganizerState {
  const key = tagKey(name)
  const next: Record<string, string[]> = {}
  for (const [skillKey, names] of Object.entries(state.tags)) {
    if (names.some(tag => tagKey(tag) === key)) next[skillKey] = names.filter(tag => tagKey(tag) !== key)
  }
  const applied = applyTagSets(state, next)
  const result = applied.ok ? applied.state : state
  const sync = { ...result.sync, pendingOps: [...result.sync.pendingOps, { op: 'delete' as const, name }] }
  return { ...result, collapsedTags: result.collapsedTags.filter(item => item !== key), sync }
}

export function itemIdentity(item: QuickAccessItem): string {
  return item.kind === 'tag' ? `tag:${tagKey(item.ref)}` : `skill:${item.ref}`
}

function dedupeItems(items: readonly QuickAccessItem[]): QuickAccessItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const identity = itemIdentity(item)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

export function sameQuickAccessItems(a: readonly QuickAccessItem[], b: readonly QuickAccessItem[]): boolean {
  return a.length === b.length && a.every((item, index) => item.kind === b[index]?.kind && item.ref === b[index]?.ref)
}

/** Every local quick-access change marks it for upload (#326). */
function withQuickAccess(state: OrganizerState, items: QuickAccessItem[]): OrganizerState {
  if (sameQuickAccessItems(state.quickAccess.items, items)) return state
  return { ...state, quickAccess: { ...state.quickAccess, items }, sync: { ...state.sync, quickAccessDirty: true } }
}

export function isInQuickAccess(state: OrganizerState, item: QuickAccessItem): boolean {
  return state.quickAccess.items.some(existing => itemIdentity(existing) === itemIdentity(item))
}

export function addQuickAccess(state: OrganizerState, item: QuickAccessItem): OrganizerResult {
  if (isInQuickAccess(state, item)) return { ok: true, state }
  if (state.quickAccess.items.length >= QUICK_ACCESS_ITEMS_MAX) return { ok: false, error: `快捷访问最多 ${QUICK_ACCESS_ITEMS_MAX} 项` }
  const ref = item.kind === 'tag' ? canonicalTagName(state, item.ref) : item.ref
  if (!ref) return { ok: false, error: '目录不存在' }
  return { ok: true, state: withQuickAccess(state, [...state.quickAccess.items, { kind: item.kind, ref }]) }
}

export function removeQuickAccess(state: OrganizerState, item: QuickAccessItem): OrganizerState {
  return withQuickAccess(state, state.quickAccess.items.filter(existing => itemIdentity(existing) !== itemIdentity(item)))
}

/** Move the item at `from` to index `to` (clamped); used by drag and 上移/下移. */
export function moveQuickAccess(state: OrganizerState, from: number, to: number): OrganizerState {
  const items = [...state.quickAccess.items]
  if (from < 0 || from >= items.length) return state
  const target = Math.max(0, Math.min(items.length - 1, to))
  const [moved] = items.splice(from, 1)
  if (!moved) return state
  items.splice(target, 0, moved)
  return withQuickAccess(state, items)
}

/** Tag items whose tag no longer exists disappear; tag items follow the account spelling. */
function pruneQuickAccessTags(state: OrganizerState): OrganizerState {
  const names = canonicalNames(state)
  const items = state.quickAccess.items.flatMap((item) => {
    if (item.kind !== 'tag') return [item]
    const name = names.get(tagKey(item.ref))
    return name ? [{ kind: 'tag' as const, ref: name }] : []
  })
  return withQuickAccess(state, dedupeItems(items))
}

/**
 * EPIC #321 decision: quick-access entries of Skills that left the account and
 * of tags that no longer tag any live Skill are removed, never grayed out, and
 * the removal is synced like any other edit (#326). Call it only with the full,
 * loaded Skill list.
 */
export function pruneQuickAccess(state: OrganizerState, liveSkillKeys: ReadonlySet<string>): OrganizerState {
  const live = new Set(allTags(state, liveSkillKeys).map(tag => tag.key))
  const items = state.quickAccess.items.filter(item => item.kind === 'skill' ? liveSkillKeys.has(item.ref) : live.has(tagKey(item.ref)))
  if (items.length === state.quickAccess.items.length) return state
  return withQuickAccess(state, items)
}

/**
 * A local Skill that later joins the account library gains a libraryEntryId:
 * move its `local:` tags, quick-access item and dirty mark to `entry:`.
 * Returns the same object when nothing moved.
 */
export function rekeyOrganizer(state: OrganizerState, skills: readonly OrganizerSkill[], accountUserId: string | null): OrganizerState {
  let next = state
  for (const skill of skills) {
    const from = `local:${skill.id}`
    const to = skillOrganizerKey(skill, accountUserId)
    if (from === to) continue
    const hasTags = Boolean(next.tags[from])
    const hasItem = next.quickAccess.items.some(item => item.kind === 'skill' && item.ref === from)
    if (!hasTags && !hasItem) continue
    const tags = { ...next.tags }
    if (hasTags) {
      tags[to] = dedupe([...(tags[to] ?? []), ...(tags[from] ?? [])]).slice(0, TAGS_PER_SKILL_MAX)
      delete tags[from]
    }
    const items = dedupeItems(next.quickAccess.items.map(item => item.kind === 'skill' && item.ref === from ? { kind: 'skill' as const, ref: to } : item))
    const dirty = next.sync.dirtyTagKeys.filter(key => key !== from)
    next = {
      ...next,
      tags,
      quickAccess: { ...next.quickAccess, items },
      sync: {
        ...next.sync,
        dirtyTagKeys: hasTags && !dirty.includes(to) ? [...dirty, to] : dirty,
        quickAccessDirty: next.sync.quickAccessDirty || hasItem,
      },
    }
  }
  return next
}

/** Collapse state of a group on the 标签 page (#324). */
export function setTagCollapsed(state: OrganizerState, name: string, collapsed: boolean): OrganizerState {
  const key = tagKey(name)
  const has = state.collapsedTags.includes(key)
  if (has === collapsed) return state
  return { ...state, collapsedTags: collapsed ? [...state.collapsedTags, key] : state.collapsedTags.filter(item => item !== key) }
}

export type TagGroup<T> = { key: string; name: string; skills: T[] }

/**
 * Groups of the 标签 page (#324): one per account tag carried by a Skill in
 * `allSkills` (sorted by name), each listing the `visibleSkills` (already
 * filtered and ordered) that carry it, so a Skill with several tags appears in
 * each group. `untagged` holds visible Skills without any tag; the page always
 * renders it last. While `filtering`, groups without a match are left out.
 */
export function groupSkillsByTag<T extends OrganizerSkill>(
  state: OrganizerState,
  allSkills: readonly T[],
  visibleSkills: readonly T[],
  accountUserId: string | null,
  filtering: boolean,
): { groups: TagGroup<T>[]; untagged: T[] } {
  const live = new Set(allSkills.map(skill => skillOrganizerKey(skill, accountUserId)))
  const groups = allTags(state, live).map(tag => ({ key: tag.key, name: tag.name, skills: [] as T[] }))
  const byKey = new Map(groups.map(group => [group.key, group]))
  const untagged: T[] = []
  for (const skill of visibleSkills) {
    const names = tagsForSkill(state, skillOrganizerKey(skill, accountUserId))
    if (names.length === 0) { untagged.push(skill); continue }
    for (const name of names) byKey.get(tagKey(name))?.skills.push(skill)
  }
  return { groups: filtering ? groups.filter(group => group.skills.length > 0) : groups, untagged }
}
