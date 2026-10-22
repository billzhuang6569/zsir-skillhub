import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../desktop/scripts/tauri-channel.mjs', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
const desktopRoot = resolve('desktop')
const updater = { endpoint: 'https://staging.example/updates', pubkey: 'test-public-key' }
const overlay = JSON.stringify({ plugins: { updater: { endpoints: [updater.endpoint], pubkey: updater.pubkey } } })

for (const [name, tauriArgs, cargoArgs] of [
  ['no extra arguments', [], []],
  ['Tauri arguments only', ['--ci', '--target', 'aarch64-apple-darwin', '--bundles', 'app'], []],
  ['Tauri arguments followed by cargo --locked', ['--ci', '--target', 'aarch64-apple-darwin', '--bundles', 'app'], ['--', '--locked']],
]) {
  test(`channel wrapper assembles ${name}`, () => {
    for (const channel of ['dev', 'official']) {
      let spawnedArgs
      runInNewContext(source, {
        desktopRoot,
        resolve,
        readChannel: () => ({ config: { updater } }),
        readFileSync: () => '{"plugins":{}}',
        spawnSync: (_executable, args) => {
          spawnedArgs = Array.from(args)
          return { status: 0 }
        },
        process: {
          argv: ['node', 'tauri-channel.mjs', channel, 'build', ...tauriArgs, ...cargoArgs],
          execPath: 'node',
          env: {},
          stderr: { write: (message) => assert.fail(message) },
        },
      })
      assert.deepEqual(spawnedArgs, [
        resolve(desktopRoot, 'node_modules/@tauri-apps/cli/tauri.js'),
        'build',
        ...tauriArgs,
        ...(channel === 'dev' ? ['--config', overlay] : []),
        ...cargoArgs,
      ])
    }
  })
}
