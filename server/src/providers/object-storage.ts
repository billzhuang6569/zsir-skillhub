/** Providers translate only a confirmed ENOENT (or equivalent) into this error. */
export class ObjectMissingError extends Error {
  constructor() {
    super('Storage object does not exist')
    this.name = 'ObjectMissingError'
  }
}

export type ObjectStorage = {
  provider: 'filesystem' | 's3'
  get: (key: string) => Promise<Buffer>
  /** null only for confirmed missing objects; other I/O failures propagate. */
  head: (key: string) => Promise<{ size: number } | null>
  /** Reuse identical bytes or atomically replace them; confirm durability on every call. */
  put: (key: string, data: Buffer) => Promise<void>
  delete: (key: string) => Promise<void>
}

export function assertObjectStorageKey(key: string): void {
  if (/[^A-Za-z0-9._/-]/.test(key) || key.includes('..') || key.split('/').some(part => !part || part.startsWith('.'))) {
    throw new Error('Invalid object storage key')
  }
}
