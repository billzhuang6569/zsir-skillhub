import type { FastifyBaseLogger } from 'fastify'
import { db } from '../db.js'

const RETENTION_DAYS = 30
const CLEANUP_BATCH = 1_000

export function startAgentAuditCleanup(log: FastifyBaseLogger): () => void {
  let running = false
  async function cleanup(): Promise<void> {
    if (running) return
    running = true
    try {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60_000)
      await db.$executeRaw`
        DELETE FROM "admin_agent_audit_events" WHERE "id" IN (
          SELECT "id" FROM "admin_agent_audit_events"
          WHERE "createdAt" < ${cutoff}
          ORDER BY "createdAt", "id" LIMIT ${CLEANUP_BATCH}
        )
      `
    } catch {
      log.warn('Admin Agent audit cleanup could not run')
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => { void cleanup() }, 60_000)
  timer.unref()
  void cleanup()
  return () => { clearInterval(timer) }
}
