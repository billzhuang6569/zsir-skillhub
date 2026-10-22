export type MarketplaceRole = 'user' | 'admin'

export type MarketplaceRoleOperation = {
  userId?: string
  email?: string
  role: MarketplaceRole
}

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function parseMarketplaceRoleOperation(argv: string[]): MarketplaceRoleOperation {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key || !value || !['--user-id', '--email', '--role'].includes(key)) {
      throw new Error('Usage: marketplace:role (--user-id UUID | --email EMAIL) --role user|admin')
    }
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`)
    values.set(key, value.trim())
  }

  const userId = values.get('--user-id')
  const email = values.get('--email')?.toLocaleLowerCase('en-US')
  const role = values.get('--role')
  if (Boolean(userId) === Boolean(email)) {
    throw new Error('Choose exactly one user selector: --user-id or --email')
  }
  if (userId && !USER_ID_PATTERN.test(userId)) throw new Error('--user-id must be a UUID')
  if (email && !EMAIL_PATTERN.test(email)) throw new Error('--email must be a valid email address')
  if (role !== 'user' && role !== 'admin') throw new Error('--role must be user or admin')

  return {
    ...(userId ? { userId } : {}),
    ...(email ? { email } : {}),
    role,
  }
}
