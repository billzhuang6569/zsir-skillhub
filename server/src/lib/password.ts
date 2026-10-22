import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const SALT_BYTES = 16
const KEY_BYTES = 64
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 0xa5).toString('base64')
const DUMMY_HASH = Buffer.alloc(KEY_BYTES, 0x5a).toString('base64')

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) {
        reject(error)
        return
      }
      resolve(derivedKey)
    })
  })
}

export type PasswordCredentials = {
  passwordHash: string
  passwordSalt: string
}

export async function hashPassword(password: string): Promise<PasswordCredentials> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await deriveKey(password, salt)
  return {
    passwordHash: hash.toString('base64'),
    passwordSalt: salt.toString('base64'),
  }
}

export async function verifyPassword(
  password: string,
  passwordHash: string | null | undefined,
  passwordSalt: string | null | undefined
): Promise<boolean> {
  const expectedHash = Buffer.from(passwordHash ?? DUMMY_HASH, 'base64')
  const salt = Buffer.from(passwordSalt ?? DUMMY_SALT, 'base64')
  const candidateHash = await deriveKey(password, salt)
  if (expectedHash.length !== candidateHash.length) return false
  return timingSafeEqual(expectedHash, candidateHash)
}
