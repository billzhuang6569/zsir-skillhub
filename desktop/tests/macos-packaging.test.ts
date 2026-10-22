import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(readFileSync(resolve(desktopRoot, 'src-tauri/tauri.conf.json'), 'utf8')) as {
  bundle?: { macOS?: { signingIdentity?: string; hardenedRuntime?: boolean } }
}

test('internal macOS bundles receive a complete ad-hoc signature', () => {
  assert.equal(config.bundle?.macOS?.signingIdentity, '-')
  assert.equal(config.bundle?.macOS?.hardenedRuntime, true)
})
