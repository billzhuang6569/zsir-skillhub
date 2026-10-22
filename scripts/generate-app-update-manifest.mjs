#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0 || !process.argv[index + 1]) fail(`Missing --${name}`)
  return process.argv[index + 1]
}

function optionalArgument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? null : process.argv[index + 1] || fail(`Missing --${name}`)
}

const version = argument('version').replace(/^v/, '')
const target = argument('target')
const arch = argument('arch')
const artifactPath = resolve(argument('artifact'))
const signaturePath = resolve(argument('signature'))
const legacyDmgPath = optionalArgument('dmg')
const installerPath = resolve(optionalArgument('installer') ?? legacyDmgPath ?? fail('Missing --installer'))
const installerKind = optionalArgument('installer-kind') ?? (legacyDmgPath ? 'dmg' : null)
const baseManifestPath = optionalArgument('base-manifest')
const baseUrl = argument('base-url').replace(/\/$/, '')
const outputPath = resolve(argument('output'))
const notes = process.env.SKILLHUB_UPDATE_NOTES?.trim() || `一探 SkillHub v${version}`
const minimumSystemVersion = optionalArgument('minimum-system-version')
  ?? (target === 'darwin' ? process.env.SKILLHUB_MINIMUM_MACOS?.trim() || '11.0' : '10.0.19041')

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail('Version must be semantic versioning')
if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(target) || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(arch)) fail('Target and arch are invalid')
if (!['dmg', 'nsis'].includes(installerKind)) fail('Installer kind must be dmg or nsis')
if (!/^\d+\.\d+(?:\.\d+)?$/.test(minimumSystemVersion)) fail('Minimum system version is invalid')
if ((target === 'darwin' && installerKind !== 'dmg') || (target === 'windows' && installerKind !== 'nsis')) fail('Installer kind does not match target')
const parsedBaseUrl = new URL(baseUrl)
if (parsedBaseUrl.protocol !== 'https:') fail('Update base URL must use HTTPS')

for (const [path, label] of [[artifactPath, 'Updater artifact'], [signaturePath, 'Updater signature'], [installerPath, 'Installer']]) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) fail(`${label} must be a non-empty regular file`)
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const signature = readFileSync(signaturePath, 'utf8').trim()
if (!signature) fail('Updater signature is empty')
const artifactName = basename(artifactPath)
const installerName = basename(installerPath)
const installerStat = lstatSync(installerPath)
const artifactStat = lstatSync(artifactPath)
let releases = []
if (baseManifestPath) {
  const base = JSON.parse(readFileSync(resolve(baseManifestPath), 'utf8'))
  if (base?.schemaVersion !== 2 || !Array.isArray(base.releases)) fail('Base manifest must use schema version 2')
  releases = base.releases.filter((item) => item?.target !== target || item?.arch !== arch)
}
releases.push({
  target,
  arch,
  version,
  notes,
  pubDate: new Date().toISOString(),
  minimumSystemVersion,
  installer: {
    kind: installerKind,
    url: `${baseUrl}/v${version}/${encodeURIComponent(installerName)}`,
    sha256: await sha256File(installerPath),
    size: installerStat.size,
  },
  updater: {
    url: `${baseUrl}/v${version}/${encodeURIComponent(artifactName)}`,
    signature,
    sha256: await sha256File(artifactPath),
    size: artifactStat.size,
  },
})
releases.sort((left, right) => `${left.target}/${left.arch}`.localeCompare(`${right.target}/${right.arch}`))
const manifest = {
  schemaVersion: 2,
  releases,
}

writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
process.stdout.write(`${outputPath}\n`)
