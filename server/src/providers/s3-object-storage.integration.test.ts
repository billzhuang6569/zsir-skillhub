import { randomUUID } from 'node:crypto'
import { describe } from 'vitest'
import { objectStorageContract } from './object-storage-contract.js'
import { createS3ObjectStorage } from './s3-object-storage.js'

describe.skipIf(!process.env.SKILLHUB_S3_TEST_ENDPOINT)('real S3 compatible storage', () => {
  const prefix = `skillhub-contract-${randomUUID()}`
  objectStorageContract('S3 integration contract', () => createS3ObjectStorage({
    endpoint: process.env.SKILLHUB_S3_TEST_ENDPOINT!,
    region: process.env.SKILLHUB_S3_TEST_REGION ?? 'us-east-1',
    bucket: process.env.SKILLHUB_S3_TEST_BUCKET!,
    accessKeyId: process.env.SKILLHUB_S3_TEST_ACCESS_KEY_ID!,
    secretAccessKey: process.env.SKILLHUB_S3_TEST_SECRET_ACCESS_KEY!,
    forcePathStyle: true, prefix,
  }, 30 * 1024 * 1024))
})
