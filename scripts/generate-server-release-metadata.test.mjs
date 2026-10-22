import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  assertFlatServerReleaseMetadataCurrent,
  assertServerReleaseMetadataCurrent,
  computeFlatServerReleaseMetadata,
  computeServerReleaseMetadata,
  writeServerReleaseMetadata,
} from './generate-server-release-metadata.mjs'

const roots = []

function write(root, path, content) {
  const absolutePath = resolve(root, path)
  mkdirSync(resolve(absolutePath, '..'), { recursive: true })
  writeFileSync(absolutePath, content)
}

function releaseFixture() {
  const root = mkdtempSync(join(tmpdir(), 'skillhub-release-metadata-'))
  roots.push(root)
  write(root, 'server/dist/index.js', 'export const service = true\n')
  write(root, 'server/dist/index.d.ts', 'export declare const service = true;\n')
  write(root, 'server/prisma/schema.prisma', 'generator client {}\n')
  write(root, 'server/prisma/migrations/20260803000000_first/migration.sql', 'SELECT 1;\n')
  write(root, 'server/prisma/migrations/20260804000000_second/migration.sql', 'SELECT 2;\n')
  write(root, 'server/scripts/verify-auth-cutover.mjs', 'export const verified = true\n')
  write(root, 'server/package.json', '{"name":"@skillhub/server"}\n')
  write(root, 'server/package-lock.json', '{"lockfileVersion":3}\n')
  write(root, 'server/tsconfig.json', '{}\n')
  write(root, 'server/.env.example', 'NODE_ENV=production\n')
  write(root, 'script/verify_production_e2e.mjs', 'export {}\n')
  write(root, 'script/verify_production_deploy.mjs', 'export {}\n')
  write(root, 'scripts/generate-server-release-metadata.mjs', 'export {}\n')
  write(root, 'scripts/verify-production-compatibility.mjs', 'export {}\n')
  write(root, 'deploy/nginx/skillhub.locations.conf', 'location = /skillhub/api/auth/register { return 410; }\n')
  write(root, 'deploy/nginx/skillhub.http.conf', 'log_format skillhub_diagnostic escape=json "$status";\n')
  write(root, 'deploy/nginx/skillhub-gateway.logrotate', '/var/log/skillhub/gateway-access.jsonl { rotate 7 }\n')
  return root
}

function copyAsFlatRuntime(root) {
  const flatRoot = mkdtempSync(join(tmpdir(), 'skillhub-flat-release-metadata-'))
  roots.push(flatRoot)
  const files = [
    'dist/index.js',
    'dist/index.d.ts',
    'prisma/schema.prisma',
    'prisma/migrations/20260803000000_first/migration.sql',
    'prisma/migrations/20260804000000_second/migration.sql',
    'scripts/verify-auth-cutover.mjs',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    '.env.example',
    'script/verify_production_e2e.mjs',
    'script/verify_production_deploy.mjs',
    'scripts/generate-server-release-metadata.mjs',
    'scripts/verify-production-compatibility.mjs',
    'deploy/nginx/skillhub.locations.conf',
    'deploy/nginx/skillhub.http.conf',
    'deploy/nginx/skillhub-gateway.logrotate',
  ]
  for (const relativePath of files) {
    const repositoryPath = relativePath === 'scripts/verify-auth-cutover.mjs'
      ? `server/${relativePath}`
      : relativePath.startsWith('script') || relativePath.startsWith('deploy/')
      ? relativePath
      : `server/${relativePath}`
    write(flatRoot, relativePath, readFileSync(resolve(root, repositoryPath)))
  }
  return flatRoot
}

test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('creates a reproducible content digest and selects the latest migration marker', () => {
  const root = releaseFixture()
  const first = computeServerReleaseMetadata(root)
  const second = computeServerReleaseMetadata(root)

  assert.match(first.buildId, /^[a-f0-9]{64}$/)
  assert.equal(first.buildId, second.buildId)
  assert.equal(first.migrationMarker, '20260804000000_second')

  write(root, 'deploy/nginx/skillhub.locations.conf', 'location = /skillhub/api/auth/register { return 411; }\n')
  assert.notEqual(computeServerReleaseMetadata(root).buildId, first.buildId)

  write(root, 'server/dist/index.js', 'export const service = false\n')
  assert.notEqual(computeServerReleaseMetadata(root).buildId, first.buildId)

  write(root, 'server/scripts/verify-auth-cutover.mjs', 'export const verified = false\n')
  assert.notEqual(computeServerReleaseMetadata(root).buildId, first.buildId)
})

test('excludes its own metadata file and detects stale release content', () => {
  const root = releaseFixture()
  const written = writeServerReleaseMetadata(root)
  const metadataPath = resolve(root, 'server/dist/release-metadata.json')

  assert.deepEqual(JSON.parse(readFileSync(metadataPath, 'utf8')), written)
  assert.deepEqual(assertServerReleaseMetadataCurrent(root), written)
  assert.equal(computeServerReleaseMetadata(root).buildId, written.buildId)

  write(root, 'server/prisma/schema.prisma', 'generator client { provider = "prisma-client-js" }\n')
  assert.throws(
    () => assertServerReleaseMetadataCurrent(root),
    /release metadata is stale/,
  )
})

test('recomputes the identical digest from the flat production runtime layout', () => {
  const root = releaseFixture()
  const written = writeServerReleaseMetadata(root)
  const flatRoot = copyAsFlatRuntime(root)
  write(
    flatRoot,
    'dist/release-metadata.json',
    readFileSync(resolve(root, 'server/dist/release-metadata.json')),
  )

  assert.deepEqual(computeFlatServerReleaseMetadata(flatRoot), written)
  assert.deepEqual(assertFlatServerReleaseMetadataCurrent(flatRoot), written)

  write(flatRoot, 'dist/index.js', 'export const service = "tampered"\n')
  assert.throws(
    () => assertFlatServerReleaseMetadataCurrent(flatRoot),
    /release metadata is stale/,
  )

  write(flatRoot, 'scripts/verify-auth-cutover.mjs', 'export const verified = "tampered"\n')
  assert.throws(
    () => assertFlatServerReleaseMetadataCurrent(flatRoot),
    /release metadata is stale/,
  )
})

test('rejects a symlink in place of repo or flat release metadata', () => {
  const root = releaseFixture()
  writeServerReleaseMetadata(root)
  const repositoryMetadata = resolve(root, 'server/dist/release-metadata.json')
  write(root, 'server/outside-metadata.json', '{}\n')
  unlinkSync(repositoryMetadata)
  symlinkSync('../outside-metadata.json', repositoryMetadata)
  assert.throws(
    () => assertServerReleaseMetadataCurrent(root),
    /metadata output must be a regular file/,
  )
  assert.throws(
    () => writeServerReleaseMetadata(root),
    /metadata output must be a regular file/,
  )

  const safeRoot = releaseFixture()
  writeServerReleaseMetadata(safeRoot)
  const flatRoot = copyAsFlatRuntime(safeRoot)
  write(flatRoot, 'outside-metadata.json', '{}\n')
  symlinkSync('../outside-metadata.json', resolve(flatRoot, 'dist/release-metadata.json'))
  assert.throws(
    () => assertFlatServerReleaseMetadataCurrent(flatRoot),
    /metadata output must be a regular file/,
  )
})

test('public export input manifest builds without private deployment files', () => {
  const root = releaseFixture()
  write(root, 'scripts/public-server-inputs.json', JSON.stringify({
    directories: ['server/dist', 'server/prisma'],
    files: ['server/package.json', 'scripts/public-server-inputs.json'],
  }))
  rmSync(resolve(root, 'script'), { recursive: true })
  rmSync(resolve(root, 'deploy'), { recursive: true })
  assert.ok(computeServerReleaseMetadata(root).buildId)
})

test('CLI entrypoint still executes when its path contains a symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'skillhub-release-entrypoint-'))
  roots.push(root)
  const linkedEntrypoint = resolve(root, 'metadata-entrypoint.mjs')
  symlinkSync(resolve('scripts/generate-server-release-metadata.mjs'), linkedEntrypoint)

  const result = spawnSync(process.execPath, [linkedEntrypoint, '--definitely-invalid'], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Usage: node scripts\/generate-server-release-metadata\.mjs/)
})
