import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

const VersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const VersionSchema = z.string().regex(VersionPattern).max(80)
const TargetSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
const HttpsUrlSchema = z.string().url().refine((value) => new URL(value).protocol === 'https:')
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const DownloadSchema = z.object({
  kind: z.enum(['dmg', 'nsis']),
  url: HttpsUrlSchema,
  sha256: Sha256Schema,
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})
const UpdaterSchema = z.object({
  url: HttpsUrlSchema,
  signature: z.string().trim().min(1).max(4_096),
  sha256: Sha256Schema.optional(),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
})

export const AppReleaseManifestSchema = z.object({
  schemaVersion: z.literal(2),
  releases: z.array(z.object({
    target: TargetSchema,
    arch: TargetSchema,
    version: VersionSchema,
    notes: z.string().max(20_000).default(''),
    pubDate: z.string().datetime({ offset: true }),
    minimumSystemVersion: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/).max(32),
    installer: DownloadSchema,
    updater: UpdaterSchema,
  })).min(1).max(32).superRefine((releases, context) => {
    const seen = new Set<string>()
    for (const [index, release] of releases.entries()) {
      const key = `${release.target}/${release.arch}`
      if (seen.has(key)) {
        context.addIssue({ code: 'custom', message: `Duplicate release target: ${key}`, path: [index] })
      }
      seen.add(key)
    }
  }),
})

const LegacyAppReleaseManifestSchema = z.object({
  version: VersionSchema,
  notes: z.string().max(20_000).default(''),
  pubDate: z.string().datetime({ offset: true }),
  minimumSystemVersion: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/).max(32),
  dmg: z.object({
    url: HttpsUrlSchema,
    sha256: Sha256Schema,
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  artifacts: z.array(z.object({
    target: TargetSchema,
    arch: TargetSchema,
    url: HttpsUrlSchema,
    signature: z.string().trim().min(1).max(4_096),
  })).min(1).max(32),
})

export type AppReleaseManifest = z.infer<typeof AppReleaseManifestSchema>
export type AppReleaseManifestResult =
  | { status: 'ok'; manifest: AppReleaseManifest }
  | { status: 'missing' }
  | { status: 'invalid'; error: unknown }

type ParsedVersion = { core: [number, number, number]; prerelease: string[] }

function parseVersion(value: string): ParsedVersion | null {
  const match = VersionPattern.exec(value)
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  }
}

export function compareAppVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left)
  const rightVersion = parseVersion(right)
  if (!leftVersion || !rightVersion) throw new Error('Invalid semantic version')
  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const delta = leftVersion.core[index] - rightVersion.core[index]
    if (delta !== 0) return Math.sign(delta)
  }
  if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
    return leftVersion.prerelease.length === rightVersion.prerelease.length
      ? 0
      : leftVersion.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index]
    const rightPart = rightVersion.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1
    }
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

export async function readAppReleaseManifest(path: string): Promise<AppReleaseManifestResult> {
  let rawManifest: string
  try {
    rawManifest = await readFile(resolve(path), 'utf8')
  } catch (error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : null
    return code === 'ENOENT' ? { status: 'missing' } : { status: 'invalid', error }
  }

  try {
    const input = JSON.parse(rawManifest) as unknown
    const current = AppReleaseManifestSchema.safeParse(input)
    if (current.success) return { status: 'ok', manifest: current.data }

    // Keep the currently deployed macOS-only manifest readable while the
    // production catalog is atomically upgraded to schema v2.
    const legacy = LegacyAppReleaseManifestSchema.safeParse(input)
    if (!legacy.success) return { status: 'invalid', error: current.error }
    const artifact = legacy.data.artifacts.find((item) => item.target === 'darwin' && item.arch === 'aarch64')
    if (!artifact) return { status: 'invalid', error: new Error('Legacy manifest has no Apple Silicon updater') }
    return {
      status: 'ok',
      manifest: {
        schemaVersion: 2,
        releases: [{
          target: 'darwin',
          arch: 'aarch64',
          version: legacy.data.version,
          notes: legacy.data.notes,
          pubDate: legacy.data.pubDate,
          minimumSystemVersion: legacy.data.minimumSystemVersion,
          installer: { kind: 'dmg', ...legacy.data.dmg },
          updater: { url: artifact.url, signature: artifact.signature },
        }],
      },
    }
  } catch (error: unknown) {
    return { status: 'invalid', error }
  }
}
