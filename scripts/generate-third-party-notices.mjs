#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..')
const DEFAULT_TARGET = 'aarch64-apple-darwin'
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|copyright|notice|unlicense)([-._].*)?$/i
const SPDX_OPERATORS = new Set(['AND', 'OR', 'WITH'])

const CANONICAL_LICENSE_DONORS = Object.freeze({
  '0BSD': { ecosystem: 'cargo', name: 'adler2', file: /^LICENSE-0BSD$/i },
  'Apache-2.0': { ecosystem: 'cargo', name: 'anyhow', file: /^LICENSE-APACHE$/i },
  'BSD-2-Clause': { ecosystem: 'cargo', name: 'zerocopy', file: /^LICENSE-BSD$/i },
  'BSD-3-Clause': { ecosystem: 'cargo', name: 'alloc-no-stdlib', file: /^LICENSE$/i },
  'CC0-1.0': { ecosystem: 'cargo', name: 'dunce', file: /^LICENSE$/i },
  ISC: { ecosystem: 'cargo', name: 'untrusted', file: /^LICENSE\.txt$/i },
  'LLVM-exception': { ecosystem: 'cargo', name: 'rustix', file: /^LICENSE-Apache-2\.0_WITH_LLVM-exception$/i },
  MIT: { ecosystem: 'cargo', name: 'anyhow', file: /^LICENSE-MIT$/i },
  'MIT-0': { ecosystem: 'cargo', name: 'aws-lc-sys', file: /^LICENSE$/i },
  'MPL-2.0': { ecosystem: 'cargo', name: 'cssparser', file: /^LICENSE$/i },
  'OFL-1.1': { ecosystem: 'npm', name: '@fontsource/jetbrains-mono', file: /^LICENSE$/i },
  'Python-2.0': { ecosystem: 'npm', name: 'argparse', file: /^LICENSE$/i },
  'Unicode-3.0': { ecosystem: 'cargo', name: 'icu_collections', file: /^LICENSE$/i },
  Unlicense: { ecosystem: 'cargo', name: 'aho-corasick', file: /^UNLICENSE$/i },
  Zlib: { ecosystem: 'cargo', name: 'foldhash', file: /^LICENSE$/i },
})

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function compareStrings(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function normalizeLicenseText(value) {
  const normalized = value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim()

  if (normalized.length === 0) {
    throw new Error('Encountered an empty license or notice file')
  }
  return `${normalized}\n`
}

function readJson(path, description) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not read ${description} at ${path}: ${message}`)
  }
}

function assertRegularFile(path, description) {
  if (!existsSync(path)) {
    throw new Error(`${description} is missing: ${path}`)
  }
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${description} must be a regular, non-symlink file: ${path}`)
  }
}

function assertWithin(directory, path, description) {
  const root = `${realpathSync(directory)}${sep}`
  const candidate = realpathSync(path)
  if (!candidate.startsWith(root)) {
    throw new Error(`${description} escapes its package directory: ${path}`)
  }
}

export function findLicenseFiles(packageDirectory, explicitLicenseFile = null) {
  const files = readdirSync(packageDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && LICENSE_FILE_PATTERN.test(entry.name))
    .map((entry) => resolve(packageDirectory, entry.name))

  if (typeof explicitLicenseFile === 'string' && explicitLicenseFile.trim().length > 0) {
    const explicitPath = isAbsolute(explicitLicenseFile)
      ? explicitLicenseFile
      : resolve(packageDirectory, explicitLicenseFile)
    assertRegularFile(explicitPath, 'Declared license file')
    assertWithin(packageDirectory, explicitPath, 'Declared license file')
    files.push(explicitPath)
  }

  return [...new Set(files.map((path) => realpathSync(path)))].sort(compareStrings)
}

function normalizeRepository(repository) {
  if (typeof repository === 'string') return repository
  if (repository && typeof repository === 'object' && typeof repository.url === 'string') {
    return repository.url
  }
  return null
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim()
}

export function productionNpmEntries(lock) {
  if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error('desktop/package-lock.json must use a lockfile with a packages map')
  }

  return Object.entries(lock.packages)
    .filter(([packagePath, metadata]) => {
      return packagePath.startsWith('node_modules/') && metadata && metadata.dev !== true
    })
    .sort(([left], [right]) => compareStrings(left, right))
}

function collectNpmPackages(desktopRoot) {
  const lockPath = resolve(desktopRoot, 'package-lock.json')
  const lock = readJson(lockPath, 'desktop package lock')

  return productionNpmEntries(lock).map(([packagePath, lockMetadata]) => {
    const packageDirectory = resolve(desktopRoot, packagePath)
    const packageJsonPath = resolve(packageDirectory, 'package.json')
    assertRegularFile(packageJsonPath, 'Installed npm package metadata')
    const packageJson = readJson(packageJsonPath, `npm package metadata for ${packagePath}`)

    if (packageJson.version !== lockMetadata.version) {
      throw new Error(
        `Installed npm package ${packageJson.name ?? packagePath} is ${packageJson.version}, ` +
          `but package-lock.json requires ${lockMetadata.version}`,
      )
    }

    const license = packageJson.license ?? lockMetadata.license
    if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
      throw new Error(`Installed npm package metadata is incomplete: ${packageJsonPath}`)
    }
    if (typeof license !== 'string' || license.trim().length === 0) {
      throw new Error(`npm package ${packageJson.name}@${packageJson.version} has no declared license`)
    }

    const repository = normalizeRepository(packageJson.repository)
    const source = repository ?? packageJson.homepage ?? lockMetadata.resolved ?? 'npm registry'
    const authors = [packageJson.author, ...(Array.isArray(packageJson.contributors) ? packageJson.contributors : [])]
      .map((author) => {
        if (typeof author === 'string') return oneLine(author)
        if (author && typeof author === 'object') {
          return oneLine([author.name, author.email].filter(Boolean).join(' '))
        }
        return ''
      })
      .filter(Boolean)

    return {
      ecosystem: 'npm',
      name: packageJson.name,
      version: packageJson.version,
      license: oneLine(license),
      source: oneLine(source),
      authors: [...new Set(authors)].sort(compareStrings),
      packageDirectory,
      licenseFiles: findLicenseFiles(packageDirectory),
    }
  })
}

export function reachableCargoPackageIds(metadata) {
  if (!metadata?.resolve?.root || !Array.isArray(metadata.resolve.nodes)) {
    throw new Error('cargo metadata did not return a resolved dependency graph')
  }

  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const seen = new Set([metadata.resolve.root])
  const queue = [metadata.resolve.root]

  while (queue.length > 0) {
    const id = queue.shift()
    const node = nodes.get(id)
    if (!node) continue

    for (const dependency of node.deps ?? []) {
      const dependencyKinds = dependency.dep_kinds ?? []
      const isProduction =
        dependencyKinds.length === 0 || dependencyKinds.some(({ kind }) => kind !== 'dev')
      if (!isProduction || seen.has(dependency.pkg)) continue
      seen.add(dependency.pkg)
      queue.push(dependency.pkg)
    }
  }

  seen.delete(metadata.resolve.root)
  return [...seen]
}

function cargoMetadata(cargoRoot, target) {
  const result = spawnSync(
    'cargo',
    [
      'metadata',
      '--manifest-path',
      resolve(cargoRoot, 'Cargo.toml'),
      '--locked',
      '--filter-platform',
      target,
      '--format-version',
      '1',
    ],
    {
      cwd: cargoRoot,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    },
  )

  if (result.error) {
    throw new Error(`Could not run cargo metadata: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`cargo metadata failed:\n${result.stderr || result.stdout}`)
  }

  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`cargo metadata returned invalid JSON: ${message}`)
  }
}

function collectCargoPackages(cargoRoot, target) {
  const metadata = cargoMetadata(cargoRoot, target)
  const packagesById = new Map(metadata.packages.map((entry) => [entry.id, entry]))

  return reachableCargoPackageIds(metadata)
    .map((id) => {
      const entry = packagesById.get(id)
      if (!entry) throw new Error(`cargo metadata omitted resolved package ${id}`)
      if (typeof entry.license !== 'string' || entry.license.trim().length === 0) {
        throw new Error(`Cargo package ${entry.name}@${entry.version} has no declared license`)
      }

      const packageDirectory = dirname(entry.manifest_path)
      const source = entry.repository ?? `https://crates.io/crates/${entry.name}/${entry.version}`
      return {
        ecosystem: 'cargo',
        name: entry.name,
        version: entry.version,
        license: oneLine(entry.license),
        source: oneLine(source),
        authors: (entry.authors ?? []).map(oneLine).filter(Boolean),
        packageDirectory,
        licenseFiles: findLicenseFiles(packageDirectory, entry.license_file),
      }
    })
    .sort(comparePackages)
}

function comparePackages(left, right) {
  return (
    compareStrings(left.ecosystem, right.ecosystem) ||
    compareStrings(left.name, right.name) ||
    compareStrings(left.version, right.version)
  )
}

export function spdxLicenseIds(expression) {
  const tokens = String(expression)
    .replaceAll('/', ' OR ')
    .match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g)
  if (!tokens) return []
  return [...new Set(tokens.filter((token) => !SPDX_OPERATORS.has(token)))].sort(compareStrings)
}

function collectTexts(packages) {
  const sections = new Map()

  for (const dependency of packages) {
    dependency.texts = []
    for (const file of dependency.licenseFiles) {
      const content = normalizeLicenseText(readFileSync(file, 'utf8'))
      const digest = sha256(content)
      const section = sections.get(digest) ?? { digest, content, origins: new Set() }
      const filename = relative(dependency.packageDirectory, file).split(sep).join('/')
      section.origins.add(
        `${dependency.ecosystem}:${dependency.name}@${dependency.version}/${filename}`,
      )
      sections.set(digest, section)
      dependency.texts.push({ digest, reason: `package file ${filename}` })
    }
  }

  return sections
}

function resolveCanonicalLicenses(packages, sections) {
  const donors = new Map()
  const requiredLicenseIds = new Set()

  for (const dependency of packages) {
    const ids = spdxLicenseIds(dependency.license)
    if (ids.length === 0) {
      throw new Error(
        `Could not parse the license expression for ${dependency.ecosystem}:` +
          `${dependency.name}@${dependency.version}: ${dependency.license}`,
      )
    }
    for (const licenseId of ids) requiredLicenseIds.add(licenseId)
  }

  for (const [licenseId, donor] of Object.entries(CANONICAL_LICENSE_DONORS)) {
    // Dependency cleanup can remove the package that supplied a canonical
    // text for a license no longer present in the production graph. Do not
    // keep that removed package artificially required just for notice output.
    if (!requiredLicenseIds.has(licenseId)) continue
    const candidates = packages
      .filter((dependency) => dependency.ecosystem === donor.ecosystem && dependency.name === donor.name)
      .flatMap((dependency) =>
        dependency.texts
          .filter(({ reason }) => donor.file.test(reason.replace(/^package file /, '')))
          .map(({ digest }) => ({ dependency, digest })),
      )
      .sort((left, right) => {
        return (
          compareStrings(left.dependency.version, right.dependency.version) ||
          compareStrings(left.digest, right.digest)
        )
      })

    if (candidates.length === 0) {
      throw new Error(
        `Could not resolve canonical ${licenseId} text from ` +
          `${donor.ecosystem}:${donor.name}/${donor.file}`,
      )
    }
    donors.set(licenseId, candidates[0].digest)
  }

  for (const dependency of packages) {
    const ids = spdxLicenseIds(dependency.license)

    for (const licenseId of ids) {
      const digest = donors.get(licenseId)
      if (!digest) {
        throw new Error(
          `No canonical license donor is configured for ${licenseId} ` +
            `(required by ${dependency.ecosystem}:${dependency.name}@${dependency.version})`,
        )
      }
      if (!sections.has(digest)) {
        throw new Error(`Canonical ${licenseId} text ${digest} is missing from the notice sections`)
      }
      dependency.texts.push({ digest, reason: `canonical ${licenseId} terms` })
    }

    const uniqueTexts = new Map()
    for (const entry of dependency.texts) {
      // Preserve the package's own file label when the canonical donor is the
      // same byte-for-byte text. The section itself is still globally deduped.
      if (!uniqueTexts.has(entry.digest)) uniqueTexts.set(entry.digest, entry)
    }
    dependency.texts = [...uniqueTexts.values()].sort((left, right) =>
      compareStrings(left.digest, right.digest),
    )
  }
}

function renderPackage(dependency) {
  const lines = [
    `[${dependency.ecosystem.toUpperCase()}] ${dependency.name}@${dependency.version}`,
    `Declared license: ${dependency.license}`,
    `Source: ${dependency.source}`,
  ]
  if (dependency.authors.length > 0) lines.push(`Authors: ${dependency.authors.join('; ')}`)
  lines.push('Included text sections:')
  for (const { digest, reason } of dependency.texts) {
    lines.push(`  - sha256:${digest} (${reason})`)
  }
  return lines.join('\n')
}

export function renderThirdPartyNotices({ packages, sections, target, npmLockHash, cargoLockHash }) {
  const npmCount = packages.filter(({ ecosystem }) => ecosystem === 'npm').length
  const cargoCount = packages.filter(({ ecosystem }) => ecosystem === 'cargo').length
  const sortedSections = [...sections.values()].sort((left, right) =>
    compareStrings(left.digest, right.digest),
  )

  const header = [
    'THIRD-PARTY SOFTWARE NOTICES',
    '============================',
    '',
    'This file is generated by scripts/generate-third-party-notices.mjs.',
    'Do not edit it by hand. Regenerate it after changing either dependency lockfile.',
    '',
    `Release target: ${target}`,
    `Production npm packages: ${npmCount}`,
    `Reachable non-development Cargo packages: ${cargoCount}`,
    `Unique license and notice texts: ${sortedSections.length}`,
    `desktop/package-lock.json SHA-256: ${npmLockHash}`,
    `desktop/src-tauri/Cargo.lock SHA-256: ${cargoLockHash}`,
    '',
    'The inventory records every production npm package and every non-development',
    `Cargo package reachable for ${target}, including build dependencies. Package-specific`,
    'license, copyright, copying, notice, and unlicense files are reproduced below.',
    'Canonical terms are also linked for every declared SPDX license identifier so that',
    'metadata-only packages do not omit the corresponding legal text.',
    '',
    'DEPENDENCY INVENTORY',
    '====================',
    '',
  ].join('\n')

  const inventory = packages.map(renderPackage).join('\n\n')
  const texts = sortedSections
    .map((section) => {
      const origins = [...section.origins].sort(compareStrings)
      return [
        '===============================================================================',
        `TEXT SECTION sha256:${section.digest}`,
        `Origin files: ${origins.join('; ')}`,
        '-------------------------------------------------------------------------------',
        section.content.trimEnd(),
      ].join('\n')
    })
    .join('\n\n')

  return `${header}\n${inventory}\n\nLICENSE AND NOTICE TEXTS\n========================\n\n${texts}\n`
}

export function generateThirdPartyNotices({ rootDir = DEFAULT_ROOT, target = DEFAULT_TARGET } = {}) {
  const desktopRoot = resolve(rootDir, 'desktop')
  const cargoRoot = resolve(desktopRoot, 'src-tauri')
  const npmLockPath = resolve(desktopRoot, 'package-lock.json')
  const cargoLockPath = resolve(cargoRoot, 'Cargo.lock')
  assertRegularFile(npmLockPath, 'Desktop npm lockfile')
  assertRegularFile(cargoLockPath, 'Desktop Cargo lockfile')

  const packages = [
    ...collectNpmPackages(desktopRoot),
    ...collectCargoPackages(cargoRoot, target),
  ].sort(comparePackages)
  const sections = collectTexts(packages)
  resolveCanonicalLicenses(packages, sections)

  return renderThirdPartyNotices({
    packages,
    sections,
    target,
    npmLockHash: sha256(readFileSync(npmLockPath)),
    cargoLockHash: sha256(readFileSync(cargoLockPath)),
  })
}

function parseArguments(argv) {
  const options = { check: false, rootDir: DEFAULT_ROOT, target: DEFAULT_TARGET }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--check') {
      options.check = true
    } else if (argument === '--root') {
      const value = argv[index + 1]
      if (!value) throw new Error('--root requires a directory')
      options.rootDir = resolve(value)
      index += 1
    } else if (argument === '--target') {
      const value = argv[index + 1]
      if (!value) throw new Error('--target requires a Rust target triple')
      options.target = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  const outputPath = resolve(options.rootDir, 'desktop', 'THIRD_PARTY_NOTICES.txt')
  const generated = generateThirdPartyNotices(options)

  if (options.check) {
    assertRegularFile(outputPath, 'Generated third-party notice')
    const current = readFileSync(outputPath, 'utf8')
    if (current !== generated) {
      throw new Error(
        `desktop/THIRD_PARTY_NOTICES.txt is stale ` +
          `(current ${sha256(current)}, expected ${sha256(generated)}). ` +
          'Run node scripts/generate-third-party-notices.mjs and commit the result.',
      )
    }
    process.stdout.write(`Third-party notices are current (${sha256(generated)}).\n`)
    return
  }

  if (existsSync(outputPath)) {
    assertRegularFile(outputPath, 'Generated third-party notice output')
  }
  writeFileSync(outputPath, generated, { encoding: 'utf8', mode: 0o644 })
  process.stdout.write(`Wrote ${outputPath} (${sha256(generated)}).\n`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Third-party notice generation failed: ${message}\n`)
    process.exitCode = 1
  }
}
