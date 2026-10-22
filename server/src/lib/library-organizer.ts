import { z } from 'zod'

// #322: private per-account Skill tags and sidebar quick access. Tags never
// leave the account (no Marketplace, team share or package exposure).

export const TAG_NAME_MAX_LENGTH = 32
export const TAGS_PER_SKILL_MAX = 8
export const DISTINCT_TAGS_PER_USER_MAX = 200
export const QUICK_ACCESS_ITEMS_MAX = 100

// Control characters, line/paragraph separators and zero-width/bidi marks would
// render invisibly or reorder the sidebar text.
const INVISIBLE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/

export const TagNameSchema = z.string()
  .transform((value) => value.normalize('NFC').trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).refine((value) => Array.from(value).length <= TAG_NAME_MAX_LENGTH, `Tag name must be at most ${TAG_NAME_MAX_LENGTH} characters`).refine((value) => !INVISIBLE_CHARACTERS.test(value), 'Tag name contains invisible characters'))

/** Case-insensitive identity of a tag name. */
export function tagKey(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

/** Trim, drop case-insensitive duplicates (first spelling wins) and keep order. */
export function dedupeTagNames(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const name of names) {
    const key = tagKey(name)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(name)
  }
  return result
}

export const QuickAccessItemSchema = z.object({
  kind: z.enum(['tag', 'skill']),
  ref: z.string().trim().min(1).max(64),
}).strict()

export type QuickAccessItem = z.infer<typeof QuickAccessItemSchema>

export const QuickAccessPutSchema = z.object({
  baseRevision: z.number().int().min(0),
  items: z.array(QuickAccessItemSchema).max(QUICK_ACCESS_ITEMS_MAX),
}).strict()

/**
 * Keep only items that still point at a live library entry or an existing tag,
 * drop duplicates and show tags with their current casing. A deleted Skill or
 * an emptied tag therefore disappears from quick access (EPIC #321 decision).
 */
export function normalizeQuickAccessItems(
  items: readonly unknown[],
  liveEntryIds: ReadonlySet<string>,
  tagNamesByKey: ReadonlyMap<string, string>,
): QuickAccessItem[] {
  const seen = new Set<string>()
  const result: QuickAccessItem[] = []
  for (const raw of items) {
    const parsed = QuickAccessItemSchema.safeParse(raw)
    if (!parsed.success) continue
    const item = parsed.data
    if (item.kind === 'skill') {
      if (!liveEntryIds.has(item.ref) || seen.has(`skill:${item.ref}`)) continue
      seen.add(`skill:${item.ref}`)
      result.push(item)
      continue
    }
    const key = tagKey(item.ref)
    const name = tagNamesByKey.get(key)
    if (!name || seen.has(`tag:${key}`)) continue
    seen.add(`tag:${key}`)
    result.push({ kind: 'tag', ref: name })
  }
  return result.slice(0, QUICK_ACCESS_ITEMS_MAX)
}
