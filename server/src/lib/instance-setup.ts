import { createHash, randomInt } from 'node:crypto'
import type { InstanceSetup, Prisma } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import { config } from '../config.js'
import { db } from '../db.js'

export function hashSetupCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

export async function lockInstanceSetup(transaction: Prisma.TransactionClient): Promise<InstanceSetup | undefined> {
  const rows = await transaction.$queryRaw<InstanceSetup[]>`
    SELECT * FROM "instance_setup" WHERE "id" = 1 FOR UPDATE
  `
  return rows[0]
}

export async function issueSetupCode(
  logger: Pick<FastifyBaseLogger, 'warn'>,
  write: (message: string) => void = (message) => { process.stdout.write(message) }
): Promise<void> {
  if (config.SKILLHUB_PROFILE !== 'selfhost') return
  const code = await db.$transaction(async (transaction): Promise<string | null> => {
    const setup = await lockInstanceSetup(transaction)
    if (!setup) throw new Error('Instance setup migration is required')
    if (setup.initializedAt) return null
    // 32 unambiguous symbols, 16 independent draws: 80 bits of entropy.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const groups = Array.from({ length: 4 }, () =>
      Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join(''))
    const freshCode = groups.join('-')
    await transaction.instanceSetup.update({
      where: { id: 1 },
      data: {
        codeHash: hashSetupCode(freshCode),
        codeExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
        codeAttempts: 0,
      },
    })
    return freshCode
  })
  if (code === null) return
  write(`----------------------------------------\nSkillHub 自部署初始化码：${code}\n在 SkillHub APP 设置 → 自部署服务器 填写 ${config.PUBLIC_BASE_URL}，按提示输入初始化码\n初始化码 30 分钟后过期；重启服务器会签发新码，旧码立即失效。\n----------------------------------------\n`)
  logger.warn('Instance not initialized; a one-time setup code was printed to stdout')
}
