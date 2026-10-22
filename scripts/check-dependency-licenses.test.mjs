import assert from 'node:assert/strict'
import { test } from 'node:test'
import { licenseAllowed } from './check-dependency-licenses.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('conservative license screening respects alternatives, conjunctions and exceptions', () => {
  for (const value of ['MIT', 'MIT OR SSPL-1.0', '(Apache-2.0 OR MIT) AND BSD-3-Clause', 'Apache-2.0 WITH LLVM-exception']) assert.equal(licenseAllowed(value), true, value)
  for (const value of ['', null, 'UNKNOWN', 'SSPL-1.0', 'BUSL-1.1', 'CC-BY-NC-4.0', 'Proprietary', 'MIT AND SSPL-1.0', 'MIT WITH unknown', '(MIT', 'MIT garbage', 'MIT OR', 'MIT AND']) assert.equal(licenseAllowed(value), false, String(value))
})

test('check fails for unknown terms and accepts only exact reviewed exceptions', { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'license-check-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const component of ['desktop', 'server']) {
    mkdirSync(join(root, component), { recursive: true })
    writeFileSync(join(root, component, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/example': { version: '1.0.0', license: 'SSPL-1.0' } } }))
  }
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin/cargo'), '#!/bin/sh\nprintf \'{"packages":[],"workspace_members":[]}\'\n', { mode: 0o755 })
  const script = fileURLToPath(new URL('./check-dependency-licenses.mjs', import.meta.url))
  const run = (...args) => spawnSync(process.execPath, [script, '--root', root, '--check', ...args], { encoding: 'utf8', env: { ...process.env, PATH: join(root, 'bin') } })
  assert.equal(run().status, 1)
  const exceptions = join(root, 'exceptions.json')
  writeFileSync(exceptions, JSON.stringify(['desktop', 'server'].map(component => ({ id: `npm:${component}:node_modules/example@1.0.0`, license: 'SSPL-1.0', reason: 'Fixture-only review; not a real approval' }))))
  assert.equal(run('--exceptions', exceptions).status, 0)
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts/dependency-license-exceptions.json'), JSON.stringify(['desktop', 'server'].map(component => ({ id: `npm:${component}:node_modules/example@1.0.0`, license: 'SSPL-1.0', reason: 'Fixture default review' }))))
  assert.equal(run().status, 0, 'default reviewed exceptions are loaded by --check')
  writeFileSync(exceptions, '[{"id":"*","license":"SSPL-1.0","reason":"not an exact match"}]')
  assert.equal(run('--exceptions', exceptions).status, 1)
})
