#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  lstatSync,
  existsSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, '..')
const DEFAULT_OUTPUT = 'server/dist/release-metadata.json'
const METADATA_SCHEMA_VERSION = 1
const DIGEST_DOMAIN = 'yitan-skillhub-server-release-v1\0'
const MIGRATION_PATTERN = /^\d{14}_[a-z0-9_]+$/

const RELEASE_DIRECTORIES = Object.freeze([
  'server/dist',
  'server/prisma',
  'server/scripts',
])

const RELEASE_FILES = Object.freeze([
  'server/package.json',
  'server/package-lock.json',
  'server/tsconfig.json',
  'server/.env.example',
  'script/verify_production_e2e.mjs',
  'script/verify_production_deploy.mjs',
  'scripts/generate-server-release-metadata.mjs',
  'scripts/verify-production-compatibility.mjs',
  'deploy/nginx/skillhub.locations.conf',
  'deploy/nginx/skillhub.http.conf',
  'deploy/nginx/skillhub-gateway.logrotate',
])

function compareStrings(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function normalizedRelativePath(projectRoot, path) {
  const normalized = relative(projectRoot, path).split(sep).join('/')
  if (!normalized || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Release input escapes the project root: ${path}`)
  }
  return normalized
}

function assertRegularFile(path, description) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${description} must be a regular, non-symlink file: ${path}`)
  }
}

function collectDirectoryFiles(directory, logicalDirectory, outputPath, files, ignoredPhysicalPaths) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    const relativePath = `${logicalDirectory}/${entry.name}`
    if (ignoredPhysicalPaths.has(path)) continue
    if (path === outputPath) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Release metadata output must be a regular file: ${relativePath}`)
      }
      continue
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`Release input must not be a symbolic link: ${relativePath}`)
    }
    if (entry.isDirectory()) {
      collectDirectoryFiles(path, relativePath, outputPath, files, ignoredPhysicalPaths)
      continue
    }
    if (!entry.isFile()) {
      throw new Error(`Release input must be a regular file: ${relativePath}`)
    }
    files.push({ path, relativePath })
  }
}

function physicalReleasePath(root, logicalPath, flatRuntime) {
  const physicalPath = flatRuntime && logicalPath.startsWith('server/')
    ? logicalPath.slice('server/'.length)
    : logicalPath
  return resolve(root, physicalPath)
}

function collectServerReleaseInputsForLayout(root, output, flatRuntime) {
  const resolvedRoot = resolve(root)
  const resolvedOutput = resolve(resolvedRoot, output)
  normalizedRelativePath(resolvedRoot, resolvedOutput)
  const files = []

  // Public exports declare their build inputs without private deployment files.
  const publicInputsPath = resolve(resolvedRoot, 'scripts/public-server-inputs.json')
  const publicInputs = existsSync(publicInputsPath)
    ? JSON.parse(readFileSync(publicInputsPath, 'utf8')) : null
  const directories = publicInputs?.directories ?? RELEASE_DIRECTORIES
  const inputFiles = publicInputs?.files ?? RELEASE_FILES

  for (const relativeDirectory of directories) {
    normalizedRelativePath(resolvedRoot, resolve(resolvedRoot, relativeDirectory))
    const directory = physicalReleasePath(resolvedRoot, relativeDirectory, flatRuntime)
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Release directory must be a real directory: ${relativeDirectory}`)
    }
    const ignoredPhysicalPaths = flatRuntime && relativeDirectory === 'server/scripts'
      ? new Set(
        RELEASE_FILES
          .filter((relativeFile) => relativeFile.startsWith('scripts/'))
          .map((relativeFile) => resolve(resolvedRoot, relativeFile)),
      )
      : new Set()
    collectDirectoryFiles(
      directory,
      relativeDirectory,
      resolvedOutput,
      files,
      ignoredPhysicalPaths,
    )
  }

  for (const relativeFile of inputFiles) {
    normalizedRelativePath(resolvedRoot, resolve(resolvedRoot, relativeFile))
    const path = physicalReleasePath(resolvedRoot, relativeFile, flatRuntime)
    assertRegularFile(path, 'Release input')
    files.push({ path, relativePath: relativeFile })
  }

  return files.sort((left, right) => compareStrings(left.relativePath, right.relativePath))
}

export function collectServerReleaseInputs(
  projectRoot = DEFAULT_PROJECT_ROOT,
  output = DEFAULT_OUTPUT,
) {
  return collectServerReleaseInputsForLayout(projectRoot, output, false)
}

export function collectFlatServerReleaseInputs(flatRoot) {
  return collectServerReleaseInputsForLayout(flatRoot, 'dist/release-metadata.json', true)
}

export function latestMigrationMarker(projectRoot = DEFAULT_PROJECT_ROOT) {
  return latestMigrationMarkerForLayout(projectRoot, false)
}

function latestMigrationMarkerForLayout(root, flatRuntime) {
  const migrationsDirectory = physicalReleasePath(root, 'server/prisma/migrations', flatRuntime)
  const markers = readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => MIGRATION_PATTERN.test(name))
    .sort(compareStrings)

  const marker = markers.at(-1)
  if (!marker) throw new Error('No canonical Prisma migration marker was found')
  assertRegularFile(
    resolve(migrationsDirectory, marker, 'migration.sql'),
    `Latest Prisma migration ${marker}`,
  )
  return marker
}

export function computeServerReleaseMetadata(
  projectRoot = DEFAULT_PROJECT_ROOT,
  output = DEFAULT_OUTPUT,
) {
  return computeServerReleaseMetadataForLayout(
    collectServerReleaseInputs(projectRoot, output),
    latestMigrationMarker(projectRoot),
  )
}

function computeServerReleaseMetadataForLayout(inputs, migrationMarker) {
  const hash = createHash('sha256')
  hash.update(DIGEST_DOMAIN, 'utf8')

  for (const input of inputs) {
    const content = readFileSync(input.path)
    hash.update(`path:${Buffer.byteLength(input.relativePath, 'utf8')}\n`, 'utf8')
    hash.update(input.relativePath, 'utf8')
    hash.update(`\nsize:${content.length}\n`, 'utf8')
    hash.update(content)
    hash.update('\n', 'utf8')
  }

  return Object.freeze({
    schemaVersion: METADATA_SCHEMA_VERSION,
    buildId: hash.digest('hex'),
    migrationMarker,
  })
}

export function computeFlatServerReleaseMetadata(flatRoot) {
  return computeServerReleaseMetadataForLayout(
    collectFlatServerReleaseInputs(flatRoot),
    latestMigrationMarkerForLayout(flatRoot, true),
  )
}

function canonicalMetadata(metadata) {
  return `${JSON.stringify(metadata, null, 2)}\n`
}

export function writeServerReleaseMetadata(
  projectRoot = DEFAULT_PROJECT_ROOT,
  output = DEFAULT_OUTPUT,
) {
  const metadata = computeServerReleaseMetadata(projectRoot, output)
  const outputPath = resolve(projectRoot, output)
  writeFileSync(outputPath, canonicalMetadata(metadata), { encoding: 'utf8', mode: 0o644 })
  return metadata
}

export function assertServerReleaseMetadataCurrent(
  projectRoot = DEFAULT_PROJECT_ROOT,
  output = DEFAULT_OUTPUT,
) {
  const expected = canonicalMetadata(computeServerReleaseMetadata(projectRoot, output))
  const actual = readFileSync(resolve(projectRoot, output), 'utf8')
  if (actual !== expected) {
    throw new Error(`Server release metadata is stale: ${output}`)
  }
  return JSON.parse(actual)
}

export function assertFlatServerReleaseMetadataCurrent(flatRoot) {
  const expected = canonicalMetadata(computeFlatServerReleaseMetadata(flatRoot))
  const metadataPath = resolve(flatRoot, 'dist/release-metadata.json')
  const actual = readFileSync(metadataPath, 'utf8')
  if (actual !== expected) {
    throw new Error('Server release metadata is stale: dist/release-metadata.json')
  }
  return JSON.parse(actual)
}

function parseArgs(args) {
  if (args.length === 0) return { mode: 'write', output: DEFAULT_OUTPUT, flatRoot: null }
  if (args.length === 1 && args[0] === '--check') {
    return { mode: 'check', output: DEFAULT_OUTPUT, flatRoot: null }
  }
  if (args.length === 3 && args[0] === '--check' && args[1] === '--flat-root' && args[2]) {
    return { mode: 'check', output: 'dist/release-metadata.json', flatRoot: resolve(args[2]) }
  }
  throw new Error(
    'Usage: node scripts/generate-server-release-metadata.mjs [--check [--flat-root <release-dir>]]',
  )
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const metadata = options.flatRoot
    ? assertFlatServerReleaseMetadataCurrent(options.flatRoot)
    : options.mode === 'check'
      ? assertServerReleaseMetadataCurrent(DEFAULT_PROJECT_ROOT, options.output)
      : writeServerReleaseMetadata(DEFAULT_PROJECT_ROOT, options.output)
  process.stdout.write(
    `Server release metadata ${options.mode === 'check' ? 'verified' : 'generated'}: ` +
      `${metadata.buildId} / ${metadata.migrationMarker}.\n`,
  )
}

const entrypoint = process.argv[1]
if (
  entrypoint &&
  realpathSync(resolve(entrypoint)) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Server release metadata failed: ${message}\n`)
    process.exitCode = 1
  }
}
