import { db } from '../db.js'
import { parseMarketplaceRoleOperation } from '../lib/marketplace-role-ops.js'

async function main(): Promise<void> {
  const operation = parseMarketplaceRoleOperation(process.argv.slice(2))
  const user = await db.user.findUnique({
    where: operation.userId
      ? { id: operation.userId }
      : { email: operation.email as string },
    select: { id: true, email: true, displayName: true, marketplaceRole: true },
  })
  if (!user) throw new Error('SkillHub user not found')

  const updated = user.marketplaceRole === operation.role
    ? user
    : await db.user.update({
      where: { id: user.id },
      data: { marketplaceRole: operation.role },
      select: { id: true, email: true, displayName: true, marketplaceRole: true },
    })

  process.stdout.write(`${JSON.stringify(updated)}\n`)
}

try {
  await main()
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : 'Marketplace role operation failed'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
} finally {
  await db.$disconnect()
}
