import { createHash } from 'node:crypto'
import { z } from 'zod'
import catalog from '../avatar-styles/catalog.json' with { type: 'json' }

const text = (max: number): z.ZodEffects<z.ZodString, string, string> =>
  z.string().max(max).refine(value => value.trim().length > 0)
const localized = z.object({ zh: text(2_000), en: text(2_000) }).strict()
const mode = z.object({
  model: z.string().max(200).regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)+$/),
  parameters: z.record(z.union([z.string().max(4_000), z.number().finite(), z.boolean(), z.null()]))
    .refine(value => Object.keys(value).length <= 32 && !Object.hasOwn(value, 'prompt')),
}).strict()

export const avatarStyleIdSchema = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
export const avatarStyleVersionSchema = z.number().int().positive().max(2_147_483_647)
export const avatarStyleSchema = z.object({
  styleId: avatarStyleIdSchema,
  styleVersion: avatarStyleVersionSchema,
  name: localized,
  description: localized,
  preview: z.object({
    url: z.string().url().max(2_048).refine(value => {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password
    }).nullable(),
    license: text(2_000),
    attribution: text(2_000),
  }).strict(),
  metaPrompt: text(32_000),
  directPrompt: text(32_000),
  // These are field limits, not executable templates; no full Skill content is sent.
  inputTemplate: z.object({
    name: z.object({ maxLength: z.number().int().min(1).max(128) }).strict(),
    description: z.object({ maxLength: z.number().int().min(1).max(500) }).strict(),
    scenarios: z.object({
      maxItems: z.number().int().min(1).max(8),
      maxLength: z.number().int().min(1).max(100),
    }).strict().optional(),
  }).strict(),
  aspectRatio: z.string().regex(/^[1-9][0-9]?:[1-9][0-9]?$/),
  fal: z.object({ meta: mode, direct: mode }).strict(),
  status: z.enum(['published', 'test']),
  // Compatibility fragments used by the existing generation pipeline.
  legacy: z.object({ promptVersion: text(100), fixedStyle: text(32_000), artSystem: text(32_000), canvas: text(2_000) }).strict().optional(),
}).strict()

export type AvatarStyle = z.infer<typeof avatarStyleSchema>
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function contentSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

const parsed = z.array(avatarStyleSchema).min(1).safeParse(catalog)
// Zod errors may include input; never throw them into startup logging.
if (!parsed.success) throw new Error('avatar_style_catalog_invalid')
export const avatarStyleCatalog = parsed.data
if (new Set(avatarStyleCatalog.map(style => `${style.styleId}@${style.styleVersion}`)).size !== avatarStyleCatalog.length) {
  throw new Error('avatar_style_catalog_duplicate')
}
const classic = avatarStyleCatalog.find(style => style.styleId === 'classic' && style.styleVersion === 1)
if (!classic?.legacy) throw new Error('avatar_style_classic_missing')
export const classicAvatarStyle = classic as AvatarStyle & { legacy: NonNullable<AvatarStyle['legacy']> }
