#!/usr/bin/env node

import { readFileSync } from 'node:fs'

const manifestPaths = {
  desktopPackage: 'desktop/package.json',
  desktopPackageLock: 'desktop/package-lock.json',
  serverPackage: 'server/package.json',
  serverPackageLock: 'server/package-lock.json',
  cargoPackage: 'desktop/src-tauri/Cargo.toml',
  cargoLock: 'desktop/src-tauri/Cargo.lock',
  tauriConfig: 'desktop/src-tauri/tauri.conf.json',
}

function readJsonVersion(path) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${path} is not valid JSON: ${message}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`)
  }
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error(`${path} must contain a non-empty string version`)
  }
  return parsed.version
}

function readCargoPackageVersion(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  let packageSections = 0
  let inPackageSection = false
  const versions = []

  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inPackageSection = line.trim() === '[package]'
      if (inPackageSection) packageSections += 1
      continue
    }
    if (!inPackageSection || !/^\s*version\s*=/.test(line)) continue

    const match = /^\s*version\s*=\s*"([^"]+)"\s*(?:#.*)?$/.exec(line)
    if (!match) {
      throw new Error(`${path} [package].version must be a literal string`)
    }
    versions.push(match[1])
  }

  if (packageSections !== 1) {
    throw new Error(`${path} must contain exactly one [package] section`)
  }
  if (versions.length !== 1) {
    throw new Error(`${path} must contain exactly one [package].version`)
  }
  return versions[0]
}

function readPackageLockRootVersion(path, expectedName) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${path} is not valid JSON: ${message}`)
  }
  const root = parsed?.packages?.['']
  if (
    !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.name !== expectedName
    || typeof parsed.version !== 'string'
    || !root || typeof root !== 'object' || Array.isArray(root)
    || root.name !== expectedName
    || root.version !== parsed.version
  ) {
    throw new Error(`${path} root package must be ${expectedName} with matching top-level and packages[""] versions`)
  }
  return parsed.version
}

function readCargoLockPackageVersion(path, expectedName) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const matches = []
  let current = null

  const finish = () => {
    if (current?.name === expectedName && typeof current.version === 'string') matches.push(current.version)
  }
  for (const line of lines) {
    if (line.trim() === '[[package]]') {
      finish()
      current = {}
      continue
    }
    if (/^\s*\[/.test(line)) {
      finish()
      current = null
      continue
    }
    if (!current) continue
    const match = /^\s*(name|version)\s*=\s*"([^"]+)"\s*$/.exec(line)
    if (match) current[match[1]] = match[2]
  }
  finish()
  if (matches.length !== 1) {
    throw new Error(`${path} must contain exactly one locked ${expectedName} package version`)
  }
  return matches[0]
}

function assertStrictSemver(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(version)
  if (!match) throw new Error(`Version is not strict SemVer: ${version}`)

  const prerelease = match[4]
  const build = match[5]
  for (const identifier of prerelease ? prerelease.split('.') : []) {
    if (!identifier || !/^[0-9A-Za-z-]+$/.test(identifier)) {
      throw new Error(`Version has an invalid prerelease identifier: ${version}`)
    }
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
      throw new Error(`Version has a zero-padded numeric prerelease identifier: ${version}`)
    }
  }
  for (const identifier of build ? build.split('.') : []) {
    if (!identifier || !/^[0-9A-Za-z-]+$/.test(identifier)) {
      throw new Error(`Version has an invalid build identifier: ${version}`)
    }
  }
}

function main() {
  const args = process.argv.slice(2)
  if (args.length > 1) {
    throw new Error('Usage: node scripts/verify-release-version.mjs [vX.Y.Z]')
  }

  const versions = new Map([
    [manifestPaths.desktopPackage, readJsonVersion(manifestPaths.desktopPackage)],
    [manifestPaths.desktopPackageLock, readPackageLockRootVersion(manifestPaths.desktopPackageLock, 'skillhub-desktop')],
    [manifestPaths.serverPackage, readJsonVersion(manifestPaths.serverPackage)],
    [manifestPaths.serverPackageLock, readPackageLockRootVersion(manifestPaths.serverPackageLock, '@skillhub/server')],
    [manifestPaths.cargoPackage, readCargoPackageVersion(manifestPaths.cargoPackage)],
    [manifestPaths.cargoLock, readCargoLockPackageVersion(manifestPaths.cargoLock, 'skillhub')],
    [manifestPaths.tauriConfig, readJsonVersion(manifestPaths.tauriConfig)],
  ])
  const uniqueVersions = new Set(versions.values())
  if (uniqueVersions.size !== 1) {
    const details = Array.from(versions, ([path, version]) => `${path}=${version}`).join(', ')
    throw new Error(`Release versions do not match: ${details}`)
  }

  const [version] = uniqueVersions
  assertStrictSemver(version)

  const tag = args[0]
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match manifest version v${version}`)
  }

  const tagMessage = tag === undefined ? '' : ` and tag ${tag}`
  process.stdout.write(`Version gate passed: ${version} across all release manifests${tagMessage}.\n`)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Version gate failed: ${message}\n`)
  process.exitCode = 1
}
