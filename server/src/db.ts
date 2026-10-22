import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env['SKILLHUB_BACKUP_QUIET_DB'] === '1' ? [] : process.env['NODE_ENV'] === 'development' ? ['query', 'error'] : ['error'],
  })

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = db
}
