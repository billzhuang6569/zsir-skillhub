import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../db.js'
import { aiBudget, utcDay, type AiReservation } from '../lib/ai-budget.js'
import { aiStatus } from '../lib/ai-settings.js'
import { lockUserMutation } from '../lib/mutation-lock.js'
import { analyzeSkillWithAI } from './skills.js'
import { AiRequestGuardError } from '../utils/ai-request-guard.js'

const Selection = z.object({ skillIds: z.array(z.string().uuid()).min(1).max(200) }).strict()
type Job = { id: string; userId: string; queued: number; skipped: number; completed: number; failed: number;
  state: 'running' | 'completed' | 'cancelled'; reservation: AiReservation; abort: AbortController }

export const aiBatchRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.addHook('onSend', async (_request, reply, payload): Promise<typeof payload> => { reply.header('Cache-Control', 'no-store'); return payload })
  const jobs = new Map<string, Job>()
  const starting = new Set<string>()
  const dto = (job: Job): object => ({ batchId: job.id, queued: job.queued, skipped: job.skipped,
    completed: job.completed, failed: job.failed, state: job.state })
  async function selection(input: unknown, userId: string): Promise<Awaited<ReturnType<typeof db.skill.findMany>>> {
    const { skillIds } = Selection.parse(input)
    const ids = [...new Set(skillIds)]
    const rows = await db.skill.findMany({ where: { id: { in: ids }, authorId: userId, deletedAt: null }, orderBy: { id: 'asc' } })
    if (rows.length !== ids.length) throw fastify.httpErrors.notFound('Skill not found')
    return rows
  }
  fastify.post('/preview', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const parsed = Selection.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST' })
    const skills = await selection(parsed.data, request.user.id)
    const available = await aiBudget.available(request.user.id)
    const eligible = skills.filter(skill => skill.sourceContent).length
    return reply.header('Cache-Control', 'no-store').send({ total: skills.length, eligible,
      coverable: aiStatus().configured ? Math.min(eligible, available.instance, available.user) : 0,
      remaining: available, requiresConfirmation: true, mayIncurCost: true })
  })
  fastify.post('/', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const parsed = Selection.extend({ confirm: z.literal(true), aiAnalysisConsent: z.literal(true) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ code: 'CONFIRMATION_REQUIRED' })
    const userId = request.user.id
    const tokenVersion = request.verifiedAuthToken?.ver
    if (tokenVersion === undefined) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    if (!aiStatus().configured) return reply.code(409).send({ code: 'AI_NOT_CONFIGURED' })
    if (starting.has(userId) || [...jobs.values()].some(job => job.userId === userId && job.state === 'running')) return reply.code(409).send({ code: 'BATCH_RUNNING' })
    if (jobs.size + starting.size >= 1000) {
      for (const [id, job] of jobs) if (job.state !== 'running') jobs.delete(id)
      if (jobs.size + starting.size >= 1000) return reply.code(429).send({ code: 'BATCH_CAPACITY' })
    }
    starting.add(userId)
    try {
      const skills = await selection({ skillIds: parsed.data.skillIds }, userId)
      const eligible = skills.filter(skill => skill.sourceContent)
      const reservation = await aiBudget.reserve(userId, eligible.length)
      for (const [id, job] of jobs) if (job.userId === userId && job.state !== 'running') jobs.delete(id)
      const job: Job = { id: randomUUID(), userId, queued: reservation.remaining, skipped: skills.length - reservation.remaining,
        completed: 0, failed: 0, state: 'running', reservation, abort: new AbortController() }
      jobs.set(job.id, job)
      const work = async (): Promise<void> => {
        try {
          for (const skill of eligible.slice(0, job.queued)) {
            if (job.abort.signal.aborted || reservation.day !== utcDay()) break
            while (!job.abort.signal.aborted && reservation.day === utcDay()) {
              const user = await db.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } })
              if (user?.tokenVersion !== tokenVersion) { job.abort.abort(); break }
              try {
                const analysis = await analyzeSkillWithAI(skill.name, skill.sourceContent!, userId, reservation)
                if (analysis.source !== 'ai') { job.failed += 1; break }
                const changed = await db.$transaction(async transaction => {
                  await lockUserMutation(transaction, userId)
                  const currentUser = await transaction.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } })
                  if (currentUser?.tokenVersion !== tokenVersion || job.abort.signal.aborted) return 0
                  const result = await transaction.skill.updateMany({ where: { id: skill.id, authorId: userId, deletedAt: null, updatedAt: skill.updatedAt },
                    data: { ...analysis.profile, ...(skill.labelsManuallyEdited ? { labels: skill.labels as string[] } : {}), analysisStatus: 'completed' } })
                  return result.count
                })
                if (changed) job.completed += 1
                else job.failed += 1
                break
              } catch (error: unknown) {
                if (error instanceof AiRequestGuardError && (error.reason === 'concurrency' || error.reason === 'per_minute')) {
                  await delay(Math.min(error.retryAfterSeconds, 60) * 1000, undefined, { signal: job.abort.signal })
                  continue
                }
                job.failed += 1
                break
              }
            }
          }
        } catch { job.abort.abort() }
        finally {
          try { await aiBudget.release(reservation) } catch { fastify.log.warn({ code: 'AI_RESERVATION_RELEASE_DEFERRED' }, 'Unused AI reservations expire at UTC midnight') }
          job.state = job.abort.signal.aborted ? 'cancelled' : 'completed'
        }
      }
      setImmediate(() => { void work() })
      return reply.code(202).header('Cache-Control', 'no-store').send(dto(job))
    } finally { starting.delete(userId) }
  })
  fastify.get('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    const job = jobs.get(request.params.id)
    if (!job || job.userId !== request.user.id) return reply.code(404).send({ code: 'BATCH_NOT_FOUND' })
    return reply.header('Cache-Control', 'no-store').send(dto(job))
  })
  fastify.delete('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    const job = jobs.get(request.params.id)
    if (!job || job.userId !== request.user.id) return reply.code(404).send({ code: 'BATCH_NOT_FOUND' })
    job.abort.abort()
    return reply.code(202).header('Cache-Control', 'no-store').send(dto(job))
  })
  fastify.addHook('onClose', async (): Promise<void> => { for (const job of jobs.values()) job.abort.abort() })
}
