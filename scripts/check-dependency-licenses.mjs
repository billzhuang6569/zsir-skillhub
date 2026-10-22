#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { productionNpmEntries } from './generate-third-party-notices.mjs'

// Conservative screening, not a legal opinion; unlisted terms need human review.
const compatible = new Set(['MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'ISC', 'CC0-1.0', 'Unlicense', 'Zlib', 'MPL-2.0', 'Unicode-3.0', 'Unicode-DFS-2016', 'OFL-1.1', 'Python-2.0', 'BSL-1.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later'])

export function licenseAllowed(expression) {
  // Cargo's legacy slash alternatives follow the existing notice generator.
  const tokens = String(expression ?? '').replaceAll('/', ' OR ').match(/\(|\)|[A-Za-z0-9.+-]+|\S/g) ?? []
  let position = 0
  function atom() {
    if (tokens[position] === '(') {
      position++
      const value = or()
      if (tokens[position++] !== ')') throw new Error('unclosed expression')
      return value
    }
    const id = tokens[position++]
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(id) || ['AND', 'OR', 'WITH'].includes(id)) throw new Error('invalid license')
    if (tokens[position] === 'WITH') {
      position++
      const exception = tokens[position++]
      return id === 'Apache-2.0' && exception === 'LLVM-exception'
    }
    return compatible.has(id)
  }
  function and() {
    let value = atom()
    while (tokens[position] === 'AND') { position++; const next = atom(); value = value && next }
    return value
  }
  function or() {
    let value = and()
    while (tokens[position] === 'OR') { position++; const next = and(); value = value || next }
    return value
  }
  try { const value = or(); return position === tokens.length && value } catch { return false }
}

export function auditLicenses(root, exceptions = []) {
  if (!Array.isArray(exceptions) || exceptions.some(e => typeof e.id !== 'string' || typeof e.license !== 'string' || !e.reason?.trim())) throw new Error('Exceptions require id, license and review reason')
  const packages = []
  const errors = []
  for (const component of ['desktop', 'server']) {
    const lock = JSON.parse(readFileSync(resolve(root, component, 'package-lock.json'), 'utf8'))
    const production = productionNpmEntries(lock)
    const development = Object.entries(lock.packages).filter(([path, item]) => path.startsWith('node_modules/') && item.dev === true)
    for (const [path, item] of [...production, ...development]) packages.push({ id: `npm:${component}:${path}@${item.version}`, license: item.license ?? 'UNKNOWN' })
  }
  const cargo = spawnSync('cargo', ['metadata', '--offline', '--locked', '--format-version', '1', '--manifest-path', resolve(root, 'desktop/src-tauri/Cargo.toml')], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  if (cargo.error || cargo.status !== 0) errors.push('Cargo metadata unavailable offline; Cargo inventory incomplete')
  else {
    const metadata = JSON.parse(cargo.stdout)
    for (const item of metadata.packages) if (!metadata.workspace_members.includes(item.id)) packages.push({ id: `cargo:${item.name}@${item.version}`, license: item.license ?? 'UNKNOWN' })
  }
  const distribution = {}
  const byEcosystem = { npm: {}, cargo: {} }
  const flagged = []
  for (const item of packages) {
    distribution[item.license] = (distribution[item.license] ?? 0) + 1
    const group = byEcosystem[item.id.split(':')[0]]
    group[item.license] = (group[item.license] ?? 0) + 1
    if (!licenseAllowed(item.license)) flagged.push({ ...item, exception: exceptions.find(e => e.id === item.id && e.license === item.license)?.reason ?? null })
  }
  return { packages: packages.length, distribution, byEcosystem, flagged, errors, ok: errors.length === 0 && flagged.every(item => item.exception) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let root = process.cwd(), check = false, exceptions
    const args = process.argv.slice(2)
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--check') check = true
      else if (args[i] === '--root' && args[i + 1]) root = resolve(args[++i])
      else if (args[i] === '--exceptions' && args[i + 1]) exceptions = JSON.parse(readFileSync(args[++i], 'utf8'))
      else throw new Error(`Unknown or incomplete argument: ${args[i]}`)
    }
    const defaultExceptions = resolve(root, 'scripts/dependency-license-exceptions.json')
    exceptions ??= existsSync(defaultExceptions) ? JSON.parse(readFileSync(defaultExceptions, 'utf8')) : []
    const result = auditLicenses(root, exceptions)
    console.log(JSON.stringify(result, null, 2))
    if (check && !result.ok) process.exitCode = 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
