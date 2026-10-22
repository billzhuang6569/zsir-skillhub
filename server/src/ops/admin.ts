import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { db } from '../db.js'
import { hashPassword } from '../lib/password.js'
import { lockUserMutation } from '../lib/mutation-lock.js'

class AdminOperationError extends Error {}

export async function runAdmin(argv: string[]): Promise<void> {
  const email = z.string().trim().toLowerCase().email().max(254).safeParse(argv[2])
  if (argv.length !== 3 || argv[0] !== 'reset-password' || argv[1] !== '--email' || !email.success) {
    throw new AdminOperationError('Usage: npm run admin -- reset-password --email EMAIL')
  }
  const password = await db.$transaction(async (transaction): Promise<string> => {
    const account = await transaction.user.findUnique({ where: { email: email.data }, select: { id: true } })
    if (!account) throw new AdminOperationError('SkillHub user not found')
    await lockUserMutation(transaction, account.id)
    const user = await transaction.user.findUniqueOrThrow({
      where: { id: account.id }, select: { passwordHash: true, passwordSalt: true },
    })
    if (!user.passwordHash || !user.passwordSalt) {
      throw new AdminOperationError('This account has no local password. Recover it through its identity provider.')
    }
    const freshPassword = randomBytes(24).toString('base64url')
    const credentials = await hashPassword(freshPassword)
    await transaction.user.update({
      where: { id: account.id }, data: { ...credentials, tokenVersion: { increment: 1 } },
    })
    return freshPassword
  })
  process.stdout.write(`新密码：${password}\n请在登录后立即修改密码。原有会话已失效。\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runAdmin(process.argv.slice(2))
  } catch (error: unknown) {
    // Database errors may contain connection details; never echo them to the terminal.
    process.stderr.write(`${error instanceof AdminOperationError ? error.message : 'Password reset failed. Check database availability.'}\n`)
    process.exitCode = 1
  } finally {
    await db.$disconnect()
  }
}
