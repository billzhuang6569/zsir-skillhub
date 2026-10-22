import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '../db.js'
import {
  DISTINCT_TAGS_PER_USER_MAX,
  dedupeTagNames,
  normalizeQuickAccessItems,
  QuickAccessPutSchema,
  tagKey,
  TagNameSchema,
  TAGS_PER_SKILL_MAX,
  type QuickAccessItem,
} from '../lib/library-organizer.js'
import { lockUserMutation } from '../lib/mutation-lock.js'
import { authMiddleware } from '../middleware/auth.js'

const EntryIdSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/)
const TagsPutSchema = z.object({ names: z.array(TagNameSchema).max(TAGS_PER_SKILL_MAX * 4) }).strict()
const TagsPatchSchema = z.object({
  add: z.array(TagNameSchema).max(TAGS_PER_SKILL_MAX * 4).default([]),
  remove: z.array(TagNameSchema).max(TAGS_PER_SKILL_MAX * 4).default([]),
}).strict()
const TagRenameSchema = z.object({ from: TagNameSchema, to: TagNameSchema }).strict()
const TagDeleteSchema = z.object({ name: TagNameSchema }).strict()

type Tx = Prisma.TransactionClient
type TagSummary = { entryId: string; names: string[] }
type QuickAccessState = { revision: number; items: QuickAccessItem[] }

class OrganizerRequestError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code?: string, readonly current?: QuickAccessState) {
    super(message)
  }
}

/** Tags on the user's live (not deleted) library entries, in first-added order. */
async function liveTags(tx: Tx, userId: string): Promise<Array<{ entryId: string; nameKey: string; name: string }>> {
  return tx.librarySkillTag.findMany({
    where: { userId, entry: { deletedAt: null } },
    select: { entryId: true, nameKey: true, name: true },
    orderBy: [{ createdAt: 'asc' }, { nameKey: 'asc' }],
  })
}

function summarizeTags(rows: ReadonlyArray<{ entryId: string; name: string }>): TagSummary[] {
  const byEntry = new Map<string, string[]>()
  for (const row of rows) byEntry.set(row.entryId, [...(byEntry.get(row.entryId) ?? []), row.name])
  return Array.from(byEntry, ([entryId, names]) => ({ entryId, names }))
}

async function quickAccessState(tx: Tx, userId: string): Promise<QuickAccessState> {
  const [row, entries, tags] = await Promise.all([
    tx.libraryQuickAccess.findUnique({ where: { userId } }),
    tx.libraryEntry.findMany({ where: { userId, deletedAt: null }, select: { id: true } }),
    liveTags(tx, userId),
  ])
  const names = new Map<string, string>()
  for (const tag of tags) if (!names.has(tag.nameKey)) names.set(tag.nameKey, tag.name)
  const items = Array.isArray(row?.items) ? row.items : []
  return {
    revision: row?.revision ?? 0,
    items: normalizeQuickAccessItems(items, new Set(entries.map((entry) => entry.id)), names),
  }
}

/** Rewrite stored quick-access items after a tag rename/delete; bumps revision only on change. */
async function rewriteQuickAccessTags(tx: Tx, userId: string, fromKey: string, to: string | null): Promise<void> {
  const row = await tx.libraryQuickAccess.findUnique({ where: { userId } })
  if (!row || !Array.isArray(row.items)) return
  let changed = false
  const items: Prisma.InputJsonValue[] = []
  for (const raw of row.items) {
    const item = raw as { kind?: unknown; ref?: unknown }
    if (item?.kind === 'tag' && typeof item.ref === 'string' && tagKey(item.ref) === fromKey) {
      changed = true
      if (to !== null) items.push({ kind: 'tag', ref: to })
      continue
    }
    items.push(raw as Prisma.InputJsonValue)
  }
  if (!changed) return
  await tx.libraryQuickAccess.update({ where: { userId }, data: { items, revision: { increment: 1 } } })
}

/**
 * Persistently drop quick-access items made stale by deleting a library entry:
 * the Skill itself and tags that no longer have a live Skill (EPIC #321). Must
 * run inside the delete transaction, after the entry is marked deleted, so a
 * later restore brings the tags back but never the old pins.
 */
export async function pruneQuickAccessAfterEntryDelete(tx: Tx, userId: string, entryId: string): Promise<void> {
  const row = await tx.libraryQuickAccess.findUnique({ where: { userId } })
  if (!row || !Array.isArray(row.items) || row.items.length === 0) return
  const liveKeys = new Set((await liveTags(tx, userId)).map((tag) => tag.nameKey))
  const items = row.items.filter((raw) => {
    const item = raw as { kind?: unknown; ref?: unknown }
    if (item?.kind === 'skill') return item.ref !== entryId
    if (item?.kind === 'tag') return typeof item.ref === 'string' && liveKeys.has(tagKey(item.ref))
    return false
  }) as Prisma.InputJsonValue[]
  if (items.length === row.items.length) return
  await tx.libraryQuickAccess.update({ where: { userId }, data: { items, revision: { increment: 1 } } })
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof OrganizerRequestError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.current ? { current: error.current } : {}),
    })
  }
  throw error
}

function invalid(reply: FastifyReply, issues: z.ZodIssue[]): FastifyReply {
  return reply.code(400).send({ error: issues[0]?.message ?? 'Invalid request', issues: issues.map((issue) => ({ path: issue.path, message: issue.message })) })
}

/**
 * Write one entry's tag set under the user mutation lock. `resolve` gets the
 * entry's current names (first-added order) and returns the wanted names, so a
 * delta is computed against what is stored now, inside the same transaction.
 */
async function saveEntryTags(userId: string, entryId: string, resolve: (current: string[]) => string[]): Promise<TagSummary> {
  return db.$transaction(async (tx) => {
    await lockUserMutation(tx, userId)
    const entry = await tx.libraryEntry.findFirst({ where: { id: entryId, userId, deletedAt: null }, select: { id: true } })
    if (!entry) throw new OrganizerRequestError(404, 'Library entry not found')
    // Tags on soft-deleted entries are kept for restore but never count or decide casing.
    const existing = await tx.librarySkillTag.findMany({
      where: { userId, OR: [{ entryId: entry.id }, { entry: { deletedAt: null } }] },
      select: { entryId: true, nameKey: true, name: true },
      orderBy: [{ createdAt: 'asc' }, { nameKey: 'asc' }],
    })
    const current = existing.filter((row) => row.entryId === entry.id)
    const names = dedupeTagNames(resolve(current.map((row) => row.name)))
    if (names.length > TAGS_PER_SKILL_MAX) {
      throw new OrganizerRequestError(400, `A Skill can have at most ${TAGS_PER_SKILL_MAX} tags`, 'TAG_LIMIT')
    }
    // Reuse the casing the account already uses for the same tag elsewhere.
    const canonical = new Map<string, string>()
    for (const row of existing) if (row.entryId !== entry.id && !canonical.has(row.nameKey)) canonical.set(row.nameKey, row.name)
    const wanted = names.map((name) => ({ nameKey: tagKey(name), name: canonical.get(tagKey(name)) ?? name }))
    const distinct = new Set(existing.filter((row) => row.entryId !== entry.id).map((row) => row.nameKey))
    for (const tag of wanted) distinct.add(tag.nameKey)
    if (distinct.size > DISTINCT_TAGS_PER_USER_MAX) {
      throw new OrganizerRequestError(400, `An account can have at most ${DISTINCT_TAGS_PER_USER_MAX} tags`, 'TAG_LIMIT')
    }
    const wantedKeys = new Set(wanted.map((tag) => tag.nameKey))
    const removed = current.filter((row) => !wantedKeys.has(row.nameKey)).map((row) => row.nameKey)
    if (removed.length > 0) await tx.librarySkillTag.deleteMany({ where: { userId, entryId: entry.id, nameKey: { in: removed } } })
    for (const tag of wanted) {
      const before = current.find((row) => row.nameKey === tag.nameKey)
      if (!before) await tx.librarySkillTag.create({ data: { userId, entryId: entry.id, ...tag } })
      else if (before.name !== tag.name) await tx.librarySkillTag.update({ where: { userId_entryId_nameKey: { userId, entryId: entry.id, nameKey: tag.nameKey } }, data: { name: tag.name } })
    }
    // An emptied tag leaves quick access for good (EPIC #321), so re-adding it later does not resurrect the pin.
    const stillUsed = new Set(existing.filter((row) => row.entryId !== entry.id).map((row) => row.nameKey))
    for (const key of removed) if (!stillUsed.has(key)) await rewriteQuickAccessTags(tx, userId, key, null)
    const saved = await tx.librarySkillTag.findMany({ where: { userId, entryId: entry.id }, select: { name: true }, orderBy: [{ createdAt: 'asc' }, { nameKey: 'asc' }] })
    return { entryId: entry.id, names: saved.map((row) => row.name) }
  })
}

export const libraryOrganizerRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', authMiddleware)

  // GET /api/library/tags — every private tag on the account's live entries.
  fastify.get('/library/tags', async (request, reply): Promise<FastifyReply> => {
    const rows = await db.$transaction((tx) => liveTags(tx, request.user.id))
    return reply.send({ tags: summarizeTags(rows) })
  })

  // PUT /api/library/tags/:entryId — replace the tag set of one entry.
  fastify.put<{ Params: { entryId: string }; Body: unknown }>('/library/tags/:entryId', async (request, reply): Promise<FastifyReply> => {
    const entryId = EntryIdSchema.safeParse(request.params.entryId)
    if (!entryId.success) return reply.code(404).send({ error: 'Library entry not found' })
    const body = TagsPutSchema.safeParse(request.body)
    if (!body.success) return invalid(reply, body.error.issues)
    const names = dedupeTagNames(body.data.names)
    if (names.length > TAGS_PER_SKILL_MAX) {
      return reply.code(400).send({ error: `A Skill can have at most ${TAGS_PER_SKILL_MAX} tags`, code: 'TAG_LIMIT' })
    }
    try {
      return reply.send(await saveEntryTags(request.user.id, entryId.data, () => names))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  // PATCH /api/library/tags/:entryId — apply a delta (#326): remove by name key,
  // then add, against the entry's tags as stored now, in one locked transaction.
  // Two devices adding different tags offline both keep their additions, and a
  // removal from one device is never undone by another device's addition.
  fastify.patch<{ Params: { entryId: string }; Body: unknown }>('/library/tags/:entryId', async (request, reply): Promise<FastifyReply> => {
    const entryId = EntryIdSchema.safeParse(request.params.entryId)
    if (!entryId.success) return reply.code(404).send({ error: 'Library entry not found' })
    const body = TagsPatchSchema.safeParse(request.body)
    if (!body.success) return invalid(reply, body.error.issues)
    const add = dedupeTagNames(body.data.add)
    const removeKeys = new Set(body.data.remove.map(tagKey))
    try {
      return reply.send(await saveEntryTags(request.user.id, entryId.data, (current) => {
        const kept = current.filter((name) => !removeKeys.has(tagKey(name)))
        const present = new Set(kept.map(tagKey))
        return [...kept, ...add.filter((name) => !present.has(tagKey(name)))]
      }))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  // POST /api/library/tags/rename — rename (or merge into) a tag on every entry.
  fastify.post<{ Body: unknown }>('/library/tags/rename', async (request, reply): Promise<FastifyReply> => {
    const body = TagRenameSchema.safeParse(request.body)
    if (!body.success) return invalid(reply, body.error.issues)
    const userId = request.user.id
    const fromKey = tagKey(body.data.from)
    const toKey = tagKey(body.data.to)
    try {
      const result = await db.$transaction(async (tx) => {
        await lockUserMutation(tx, userId)
        const rows = await tx.librarySkillTag.findMany({ where: { userId, nameKey: { in: [fromKey, toKey] } }, select: { entryId: true, nameKey: true, name: true } })
        const sources = rows.filter((row) => row.nameKey === fromKey)
        if (sources.length === 0) throw new OrganizerRequestError(404, 'Tag not found')
        // Merging into an existing tag keeps that tag's casing; a pure case change takes the new spelling.
        const target = fromKey === toKey ? body.data.to : rows.find((row) => row.nameKey === toKey)?.name ?? body.data.to
        const alreadyTagged = new Set(rows.filter((row) => row.nameKey === toKey).map((row) => row.entryId))
        if (fromKey === toKey) {
          await tx.librarySkillTag.updateMany({ where: { userId, nameKey: fromKey }, data: { name: target } })
        } else {
          await tx.librarySkillTag.deleteMany({ where: { userId, nameKey: fromKey, entryId: { in: [...alreadyTagged] } } })
          await tx.librarySkillTag.updateMany({ where: { userId, nameKey: fromKey }, data: { nameKey: toKey, name: target } })
          await tx.librarySkillTag.updateMany({ where: { userId, nameKey: toKey }, data: { name: target } })
        }
        await rewriteQuickAccessTags(tx, userId, fromKey, target)
        return { tags: summarizeTags(await liveTags(tx, userId)), quickAccess: await quickAccessState(tx, userId) }
      })
      return reply.send(result)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  // POST /api/library/tags/delete — remove a tag from every entry (Skills are kept).
  fastify.post<{ Body: unknown }>('/library/tags/delete', async (request, reply): Promise<FastifyReply> => {
    const body = TagDeleteSchema.safeParse(request.body)
    if (!body.success) return invalid(reply, body.error.issues)
    const userId = request.user.id
    const key = tagKey(body.data.name)
    const result = await db.$transaction(async (tx) => {
      await lockUserMutation(tx, userId)
      await tx.librarySkillTag.deleteMany({ where: { userId, nameKey: key } })
      await rewriteQuickAccessTags(tx, userId, key, null)
      return { tags: summarizeTags(await liveTags(tx, userId)), quickAccess: await quickAccessState(tx, userId) }
    })
    return reply.send(result)
  })

  // GET /api/library/quick-access — ordered sidebar list with its CAS revision.
  fastify.get('/library/quick-access', async (request, reply): Promise<FastifyReply> => {
    const state = await db.$transaction((tx) => quickAccessState(tx, request.user.id))
    return reply.send(state)
  })

  // PUT /api/library/quick-access — replace the whole list if baseRevision is current.
  fastify.put<{ Body: unknown }>('/library/quick-access', async (request, reply): Promise<FastifyReply> => {
    const body = QuickAccessPutSchema.safeParse(request.body)
    if (!body.success) return invalid(reply, body.error.issues)
    const userId = request.user.id
    try {
      const result = await db.$transaction(async (tx) => {
        await lockUserMutation(tx, userId)
        const current = await quickAccessState(tx, userId)
        if (current.revision !== body.data.baseRevision) {
          throw new OrganizerRequestError(409, 'Quick access changed on another device', 'QUICK_ACCESS_CONFLICT', current)
        }
        const [entries, tags] = await Promise.all([
          tx.libraryEntry.findMany({ where: { userId, deletedAt: null }, select: { id: true } }),
          liveTags(tx, userId),
        ])
        const names = new Map<string, string>()
        for (const tag of tags) if (!names.has(tag.nameKey)) names.set(tag.nameKey, tag.name)
        const items = normalizeQuickAccessItems(body.data.items, new Set(entries.map((entry) => entry.id)), names)
        const saved = await tx.libraryQuickAccess.upsert({
          where: { userId },
          create: { userId, revision: 1, items },
          update: { revision: { increment: 1 }, items },
        })
        return { revision: saved.revision, items }
      })
      return reply.send(result)
    } catch (error) {
      return sendError(reply, error)
    }
  })
}
