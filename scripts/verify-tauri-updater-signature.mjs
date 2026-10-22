#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const cargoManifest = join(rootDir, 'desktop', 'src-tauri', 'Cargo.toml')
const temporaryPrefix = 'skillhub-updater-signature-'
const requiredArguments = ['artifact', 'signature', 'config']
const maxSignatureBytes = 16 * 1024
const maxConfigBytes = 1024 * 1024
const allowedChildEnvironment = new Set([
  'AR',
  'CARGO_HOME',
  'CC',
  'COMSPEC',
  'DEVELOPER_DIR',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'FRAMEWORKDIR',
  'FRAMEWORKVERSION',
  'FRAMEWORKVERSION64',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'INCLUDE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LD_LIBRARY_PATH',
  'LIB',
  'LIBPATH',
  'MACOSX_DEPLOYMENT_TARGET',
  'NETFXSDKDIR',
  'PATH',
  'PATHEXT',
  'RUSTUP_HOME',
  'RUSTUP_TOOLCHAIN',
  'SDKROOT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'UNIVERSALCRTSDKDIR',
  'UCRTVERSION',
  'USERPROFILE',
  'VCINSTALLDIR',
  'VCTOOLSINSTALLDIR',
  'VSCMD_ARG_HOST_ARCH',
  'VSCMD_ARG_TGT_ARCH',
  'VSCMD_VER',
  'VSINSTALLDIR',
  'WINDIR',
  'WINDOWSSDKDIR',
])

const verifierSource = String.raw`
extern crate minisign_verify;

use minisign_verify::{PublicKey, Signature};
use std::{env, fs, process};

fn verify() -> Result<(), &'static str> {
    let arguments: Vec<_> = env::args_os().collect();
    if arguments.len() != 4 {
        return Err("invalid invocation");
    }
    let artifact = fs::read(&arguments[1]).map_err(|_| "artifact read failed")?;
    let public_key_text =
        fs::read_to_string(&arguments[2]).map_err(|_| "public key read failed")?;
    let signature_text =
        fs::read_to_string(&arguments[3]).map_err(|_| "signature read failed")?;
    let public_key = PublicKey::decode(&public_key_text).map_err(|_| "public key invalid")?;
    let signature = Signature::decode(&signature_text).map_err(|_| "signature invalid")?;
    public_key
        .verify(&artifact, &signature, true)
        .map_err(|_| "signature mismatch")
}

fn main() {
    if verify().is_err() {
        process::exit(1);
    }
}
`

class GateError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

function usageError(message) {
  return new GateError(
    `${message}\nUsage: node scripts/verify-tauri-updater-signature.mjs --artifact <path> --signature <path> --config <path>`,
    2,
  )
}

function parseArguments(argv) {
  const parsed = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index]
    const value = argv[index + 1]
    if (!option?.startsWith('--') || !value || value.startsWith('--')) {
      throw usageError('Arguments must be --name value pairs.')
    }
    const name = option.slice(2)
    if (!requiredArguments.includes(name)) throw usageError(`Unknown argument: --${name}`)
    if (parsed.has(name)) throw usageError(`Duplicate argument: --${name}`)
    parsed.set(name, value)
  }
  for (const name of requiredArguments) {
    if (!parsed.has(name)) throw usageError(`Missing --${name}`)
  }
  return Object.fromEntries(parsed)
}

function requireRegularFile(path, label, maxBytes = Number.MAX_SAFE_INTEGER) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    throw new GateError(`${label} must be a non-empty regular file.`)
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > maxBytes) {
    throw new GateError(`${label} must be a non-empty regular file.`)
  }
}

function canonicalRegularFile(path, label, maxBytes = Number.MAX_SAFE_INTEGER) {
  requireRegularFile(path, label, maxBytes)
  let canonicalPath
  try {
    canonicalPath = realpathSync(path)
  } catch {
    throw new GateError(`${label} must be a non-empty regular file.`)
  }
  requireRegularFile(canonicalPath, label, maxBytes)
  return canonicalPath
}

function decodeStrictBase64(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GateError(`${label} must be non-empty base64.`)
  }
  const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
  if (!base64Pattern.test(value)) throw new GateError(`${label} must be canonical base64.`)
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new GateError(`${label} must be canonical base64.`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decoded)
  } catch {
    throw new GateError(`${label} must decode to UTF-8.`)
  }
}

function compilerEnvironment() {
  const environment = { CARGO_NET_OFFLINE: 'true' }
  for (const name of Object.keys(process.env)) {
    if (!allowedChildEnvironment.has(name.toUpperCase())) continue
    const value = process.env[name]
    if (typeof value === 'string') environment[name] = value
  }
  return environment
}

function run(command, arguments_, label, environment) {
  const result = spawnSync(command, arguments_, {
    cwd: rootDir,
    encoding: 'utf8',
    env: environment,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || result.status !== 0) throw new GateError(`${label} failed.`)
  return result.stdout
}

function rustHostTriple(environment) {
  const output = run('rustc', ['-vV'], 'Rust host lookup', environment)
  const match = output.match(/^host:\s+([A-Za-z0-9_.-]+)$/m)
  if (!match) throw new GateError('Rust host lookup returned an invalid target triple.')
  return match[1]
}

function resolvedMinisignSource(environment) {
  const hostTriple = rustHostTriple(environment)
  const output = run('cargo', [
    'metadata',
    '--locked',
    '--offline',
    '--filter-platform',
    hostTriple,
    '--format-version',
    '1',
    '--manifest-path',
    cargoManifest,
  ], 'Locked Cargo metadata lookup', environment)

  let metadata
  try {
    metadata = JSON.parse(output)
  } catch {
    throw new GateError('Locked Cargo metadata lookup returned invalid JSON.')
  }
  const packages = metadata.packages?.filter((entry) => entry.name === 'minisign-verify') ?? []
  if (packages.length !== 1) {
    throw new GateError('Locked Cargo metadata must resolve exactly one minisign-verify package.')
  }
  const package_ = packages[0]
  const packageNode = metadata.resolve?.nodes?.find((entry) => entry.id === package_.id)
  const updaterNodes = metadata.resolve?.nodes?.filter((entry) => {
    const dependencyPackage = metadata.packages?.find((candidate) => candidate.id === entry.id)
    return dependencyPackage?.name === 'tauri-plugin-updater'
  }) ?? []
  if (!packageNode
      || !Array.isArray(packageNode.dependencies)
      || packageNode.dependencies.length !== 0
      || !Array.isArray(packageNode.features)
      || packageNode.features.length !== 0) {
    throw new GateError('The locked minisign-verify package is no longer zero-dependency.')
  }
  if (!updaterNodes.some((entry) => entry.dependencies?.includes(package_.id))) {
    throw new GateError('The locked Tauri updater no longer uses minisign-verify directly.')
  }
  if (typeof package_.source !== 'string' || !package_.source.startsWith('registry+')) {
    throw new GateError('The locked minisign-verify package must come from the Cargo registry.')
  }
  const libraryTargets = package_.targets.filter((target) => (
    target.name === 'minisign_verify' && target.kind.includes('lib')
  ))
  if (libraryTargets.length !== 1) {
    throw new GateError('The locked minisign-verify library source is ambiguous.')
  }
  const source = libraryTargets[0]
  if (!['2015', '2018', '2021', '2024'].includes(source.edition ?? package_.edition)) {
    throw new GateError('The locked minisign-verify Rust edition is unsupported.')
  }
  requireRegularFile(source.src_path, 'Locked minisign-verify source')
  return { edition: source.edition ?? package_.edition, path: source.src_path }
}

function createTemporaryDirectory() {
  const parent = realpathSync(tmpdir())
  const path = mkdtempSync(join(parent, temporaryPrefix))
  return { parent, path }
}

function cleanTemporaryDirectory(temporary) {
  if (!temporary) return
  const stat = lstatSync(temporary.path)
  if (dirname(temporary.path) !== temporary.parent
      || !basename(temporary.path).startsWith(temporaryPrefix)
      || !stat.isDirectory()
      || stat.isSymbolicLink()) {
    throw new GateError('Refusing to clean an unexpected temporary verifier path.')
  }
  rmSync(temporary.path, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 })
}

function verifyUpdaterSignature(arguments_) {
  const artifactPath = canonicalRegularFile(arguments_.artifact, 'Updater artifact')
  const signaturePath = canonicalRegularFile(
    arguments_.signature,
    'Updater signature',
    maxSignatureBytes,
  )
  const configPath = canonicalRegularFile(arguments_.config, 'Tauri config', maxConfigBytes)

  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    throw new GateError('Tauri config must be valid JSON.')
  }
  const publicKeyText = decodeStrictBase64(config?.plugins?.updater?.pubkey, 'Tauri updater public key')
  const encodedSignature = readFileSync(signaturePath, 'utf8').trim()
  const signatureText = decodeStrictBase64(encodedSignature, 'Tauri updater signature')
  const environment = compilerEnvironment()
  const minisignSource = resolvedMinisignSource(environment)
  const temporary = createTemporaryDirectory()

  let failure = null
  try {
    const libraryPath = join(temporary.path, 'libminisign_verify.rlib')
    const verifierSourcePath = join(temporary.path, 'verify-updater.rs')
    const verifierPath = join(temporary.path, process.platform === 'win32' ? 'verify-updater.exe' : 'verify-updater')
    const publicKeyPath = join(temporary.path, 'updater.pub')
    const decodedSignaturePath = join(temporary.path, 'updater.minisig')
    writeFileSync(verifierSourcePath, verifierSource, { mode: 0o600 })
    writeFileSync(publicKeyPath, publicKeyText, { mode: 0o600 })
    writeFileSync(decodedSignaturePath, signatureText, { mode: 0o600 })
    run('rustc', [
      `--edition=${minisignSource.edition}`,
      '--crate-name',
      'minisign_verify',
      '--crate-type',
      'rlib',
      minisignSource.path,
      '-o',
      libraryPath,
    ], 'Locked minisign-verify compilation', environment)
    run('rustc', [
      '--edition=2021',
      verifierSourcePath,
      '--extern',
      `minisign_verify=${libraryPath}`,
      '-o',
      verifierPath,
    ], 'Temporary updater verifier compilation', environment)
    run(verifierPath, [artifactPath, publicKeyPath, decodedSignaturePath], 'Tauri updater signature verification', environment)
  } catch (error) {
    failure = error
  }
  try {
    cleanTemporaryDirectory(temporary)
  } catch {
    failure = new GateError('Temporary updater verifier cleanup failed.')
  }
  if (failure) throw failure
  return basename(artifactPath)
}

let failure = null
let verifiedArtifact = null
try {
  const arguments_ = parseArguments(process.argv.slice(2))
  verifiedArtifact = verifyUpdaterSignature(arguments_)
} catch (error) {
  failure = error instanceof GateError
    ? error
    : new GateError('Tauri updater signature verification failed.')
}

if (failure) {
  process.stderr.write(`${failure.message}\n`)
  process.exitCode = failure.exitCode
} else {
  process.stdout.write(`Verified Tauri updater signature for ${verifiedArtifact}.\n`)
}
