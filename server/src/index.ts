import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import sensible from '@fastify/sensible'
import { config } from './config.js'
import { issueSetupCode } from './lib/instance-setup.js'
import { loadInstanceIdentity } from './lib/instance-identity.js'
import { loadServerSettings } from './lib/server-settings.js'
import { startStartupRetry } from './lib/startup-retry.js'
import { startAvatarStyleSync } from './lib/avatar-styles.js'
import { registerRoutes } from './register-routes.js'
import { requestIdFromTrustedEdge } from './lib/request-id.js'
import { startAgentAuditCleanup } from './lib/admin-agent-audit-cleanup.js'
import { registerDiagnosticCapture } from './lib/admin-diagnostic-events.js'
import { startAvatarWorker } from './lib/skill-avatars.js'
import { assertAvatarReadModeAvailable } from './lib/avatar-model-verification.js'
import { db } from './db.js'
import { StorageUnavailableError } from './providers/storage-registry.js'
import { skillHubCorsOptions } from './cors.js'
import { registerApiGuard, safeRequestLog, isInviteRequest } from './middleware/api-guard.js'
import { catalogBoundary } from './middleware/catalog-auth.js'
import {
  hasAppliedMigrationMarker,
  publicServiceInfo,
  SERVER_MIGRATION_MARKER,
} from './server-info.js'

const server = Fastify({
  disableRequestLogging: isInviteRequest,
  requestIdHeader: false,
  genReqId: requestIdFromTrustedEdge,
  // Trust forwarding headers only from configured proxy addresses/networks.
  trustProxy: config.TRUSTED_PROXIES,
  logger: {
    serializers: { req: safeRequestLog },
    level: config.NODE_ENV === 'development' ? 'info' : 'warn',
    transport:
      config.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
})

// CORS may finish preflight before the business-route authentication hooks.
server.addHook('onRequest', catalogBoundary)
registerApiGuard(server, config)
server.addHook('onError', async (request, _reply, error): Promise<void> => {
  if (error instanceof StorageUnavailableError) {
    request.log.error({ provider: error.storageProvider, namespace: error.storageNamespace }, 'Storage namespace unavailable')
  }
})

server.addHook('onSend', async (request, reply): Promise<void> => {
  reply.header('X-Request-ID', request.id)
})

// ---- Plugins ----
let stopAvatarWorker: (() => Promise<void>) | undefined
let stopAgentAuditCleanup: (() => void) | undefined
const stopStartupRetries: Array<() => void> = []
const stopDiagnosticCapture = config.SKILLHUB_PROFILE === 'yitan-official' ? registerDiagnosticCapture(server) : undefined
server.addHook('onClose', async (): Promise<void> => {
  for (const stop of stopStartupRetries) stop()
  stopAgentAuditCleanup?.()
  await stopDiagnosticCapture?.()
  await stopAvatarWorker?.()
})
await server.register(cors, skillHubCorsOptions(config.CORS_ORIGIN))

await server.register(jwt, { secret: config.JWT_SECRET })
await server.register(sensible)

// ---- Health check ----
server.get('/health', async () => publicServiceInfo('ok'))
server.get('/ready', async (_request, reply) => {
  try {
    const migrationRows = await db.$queryRaw<Array<{ applied: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM "_prisma_migrations"
        WHERE "migration_name" = ${SERVER_MIGRATION_MARKER}
          AND "finished_at" IS NOT NULL
          AND "rolled_back_at" IS NULL
      ) AS "applied"
    `
    if (!hasAppliedMigrationMarker(migrationRows)) {
      server.log.error(
        { migrationMarker: SERVER_MIGRATION_MARKER },
        'Expected production migration is not applied'
      )
      return reply.code(503).send(publicServiceInfo('unavailable'))
    }
    return publicServiceInfo('ready')
  } catch (error: unknown) {
    server.log.error({ error }, 'Readiness check failed')
    return reply.code(503).send(publicServiceInfo('unavailable'))
  }
})

// ---- Routes ----
await registerRoutes(server, config)

// ---- Start ----
const port = config.PORT
try {
  await assertAvatarReadModeAvailable(config.SKILL_AVATAR_MODEL_READS)
  await server.listen({ port, host: config.HOST })
  stopStartupRetries.push(
    startStartupRetry('server-settings', loadServerSettings, server.log),
    startStartupRetry('instance-identity', () => loadInstanceIdentity(server.log), server.log),
    startAvatarStyleSync(config, server.log),
  )
  if (config.SKILLHUB_PROFILE === 'selfhost') {
    stopStartupRetries.push(startStartupRetry('setup-code', () => issueSetupCode(server.log), server.log))
  }
  if (config.SKILLHUB_PROFILE === 'yitan-official') {
    stopAgentAuditCleanup = startAgentAuditCleanup(server.log)
  }
  stopAvatarWorker = startAvatarWorker(server.log)
  server.log.info(`SkillHub API running on http://localhost:${port}`)
} catch (err) {
  server.log.error(err)
  process.exit(1)
}
