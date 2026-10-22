import { lstat, readFile } from 'node:fs/promises'
import { z } from 'zod'
import { config } from '../config.js'

const Summary = z.object({
  schemaVersion: z.literal(1),
  verifiedAt: z.string().datetime({ offset: true }),
  server: z.object({
    version: z.string().max(80),
    buildId: z.string().regex(/^[0-9a-f]{64}$/),
    migrationMarker: z.string().regex(/^\d{14}_[a-z0-9_]+$/),
    evidenceLevel: z.literal('verified'),
  }),
  app: z.object({
    version: z.string().max(80).nullable(),
    evidenceLevel: z.enum(['verified', 'unknown']),
  }),
  cardIntegrity: z.object({ evidenceLevel: z.literal('verified') }),
  verificationScope: z.array(z.enum(['local-readiness', 'production-api-smoke', 'production-compatibility', 'skill-card-integrity', 'public-app-downloads'])).min(1).max(5),
}).strict()

export type AdminAgentReleaseSummary = z.infer<typeof Summary>
export type ReleaseSummaryResult =
  | { status: 'verified'; summary: AdminAgentReleaseSummary }
  | { status: 'unknown'; reasonCode: 'SUMMARY_MISSING' | 'SUMMARY_INVALID' | 'SUMMARY_UNREADABLE' }
  | { status: 'stale'; reasonCode: 'BUILD_MISMATCH' }

export async function readAdminAgentReleaseSummary(
  expectedBuildId: string,
  expectedMigrationMarker: string,
  path = config.ADMIN_AGENT_RELEASE_SUMMARY_PATH,
): Promise<ReleaseSummaryResult> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4_096) {
      return { status: 'unknown', reasonCode: 'SUMMARY_INVALID' }
    }
    const parsed = Summary.safeParse(JSON.parse(await readFile(path, 'utf8')) as unknown)
    if (!parsed.success) return { status: 'unknown', reasonCode: 'SUMMARY_INVALID' }
    if (parsed.data.server.buildId !== expectedBuildId || parsed.data.server.migrationMarker !== expectedMigrationMarker) {
      return { status: 'stale', reasonCode: 'BUILD_MISMATCH' }
    }
    return { status: 'verified', summary: parsed.data }
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return { status: 'unknown', reasonCode: 'SUMMARY_INVALID' }
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null
    return { status: 'unknown', reasonCode: code === 'ENOENT' ? 'SUMMARY_MISSING' : 'SUMMARY_UNREADABLE' }
  }
}
