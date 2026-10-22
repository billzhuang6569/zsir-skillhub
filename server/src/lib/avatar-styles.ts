import type { AvatarStyleVersion, Prisma } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import { db } from '../db.js'
import type { Config } from '../config.js'
import { avatarStyleCatalog, avatarStyleSchema, canonicalJson, contentSha256, type AvatarStyle } from './avatar-style-catalog.js'
import { startStartupRetry } from './startup-retry.js'

type Logger = Pick<FastifyBaseLogger, 'warn'>

export async function cacheAvatarStyles(entries: unknown[], source: 'repository' | 'fetched', logger: Logger): Promise<void> {
  let invalid = 0
  for (const entry of entries) {
    const parsed = avatarStyleSchema.safeParse(entry)
    if (!parsed.success) { invalid += 1; continue }
    const style = parsed.data
    const content = canonicalJson(style)
    const hash = contentSha256(content)
    // Bind content as a parameter: raw-query errors never print a Prisma data object containing prompts.
    await db.$executeRaw`
      INSERT INTO "avatar_style_versions" ("styleId", "styleVersion", "content", "contentSha256", "source")
      VALUES (${style.styleId}, ${style.styleVersion}, ${content}, ${hash}, ${source})
      ON CONFLICT ("styleId", "styleVersion") DO NOTHING
    `
    const stored = await db.avatarStyleVersion.findUniqueOrThrow({
      where: { styleId_styleVersion: { styleId: style.styleId, styleVersion: style.styleVersion } },
      select: { contentSha256: true },
    })
    if (stored.contentSha256 !== hash) {
      logger.warn({ code: 'avatar_style_hash_conflict', styleId: style.styleId, styleVersion: style.styleVersion }, 'Avatar style version retained')
    }
  }
  if (invalid) logger.warn({ code: 'avatar_style_invalid', count: invalid }, 'Avatar style entries ignored')
}

export function cachedStyle(row: AvatarStyleVersion): AvatarStyle | null {
  try {
    const parsed = avatarStyleSchema.safeParse(JSON.parse(row.content) as unknown)
    if (!parsed.success || parsed.data.styleId !== row.styleId || parsed.data.styleVersion !== row.styleVersion
      || contentSha256(canonicalJson(parsed.data)) !== row.contentSha256) return null
    return parsed.data
  } catch { return null }
}

export async function listAvatarStyles(): Promise<AvatarStyle[]> {
  const rows = await db.avatarStyleVersion.findMany({ orderBy: [{ styleId: 'asc' }, { styleVersion: 'desc' }] })
  const latest = new Map<string, AvatarStyle>()
  for (const row of rows) {
    if (latest.has(row.styleId)) continue
    const style = cachedStyle(row)
    if (style?.status === 'published') latest.set(style.styleId, style)
  }
  return [...latest.values()]
}

export async function getAvatarStyle(styleId: string, styleVersion: number, tx: Prisma.TransactionClient = db): Promise<AvatarStyle | null> {
  const row = await tx.avatarStyleVersion.findUnique({ where: { styleId_styleVersion: { styleId, styleVersion } } })
  return row ? cachedStyle(row) : null
}

export async function latestAvatarStyle(styleId: string, tx: Prisma.TransactionClient = db): Promise<AvatarStyle | null> {
  const rows = await tx.avatarStyleVersion.findMany({ where: { styleId }, orderBy: { styleVersion: 'desc' } })
  for (const row of rows) { const style = cachedStyle(row); if (style?.status === 'published') return style }
  return null
}

export async function fetchAvatarStyles(origin: string, logger: Logger): Promise<void> {
  const response = await fetch(`${origin}/api/avatar-styles`, {
    redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json' },
  })
  if (!response.ok || !response.body) throw new Error('avatar_style_fetch_failed')
  // Bound even chunked responses before JSON parsing; never retain a failed payload in an error.
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 2 * 1024 * 1024) throw new Error('avatar_style_response_too_large')
      chunks.push(value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  let payload: unknown
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new Error('avatar_style_response_invalid') }
  if (!Array.isArray(payload) || payload.length > 200) throw new Error('avatar_style_response_invalid')
  await cacheAvatarStyles(payload, 'fetched', logger)
}

export function startAvatarStyleSync(config: Pick<Config, 'SKILLHUB_PROFILE' | 'AVATAR_STYLE_ORIGIN'>, logger: Logger): () => void {
  const official = config.SKILLHUB_PROFILE === 'yitan-official'
  return startStartupRetry('avatar-styles',
    () => official ? cacheAvatarStyles(avatarStyleCatalog, 'repository', logger) : fetchAvatarStyles(config.AVATAR_STYLE_ORIGIN, logger),
    logger, official ? undefined : 12 * 60 * 60 * 1_000, {
      maxDelayMs: 60 * 60 * 1_000,
      failureMessage: 'Avatar style catalog sync failed; using cached styles',
      failureCode: 'avatar_style_fetch_failed',
      warnOnce: true,
    })
}
