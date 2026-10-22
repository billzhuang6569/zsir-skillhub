import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyOfficialChannel } from './verify-official-channel.mjs'
import { checkTauriChannel, mergeConfig, readChannel } from '../desktop/scripts/build-channel.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'skillhub-channel-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'desktop/src-tauri'), { recursive: true })
  for (const path of ['desktop/official-channel.json', 'desktop/skillhub.build.example.json',
    'desktop/package.json', 'desktop/src-tauri/tauri.conf.json']) {
    writeFileSync(join(root, path), readFileSync(new URL(`../${path}`, import.meta.url)))
  }
  const config = readChannel('official', join(root, 'desktop')).config
  const tauri = JSON.parse(readFileSync(join(root, 'desktop/src-tauri/tauri.conf.json')))
  return { root, config, tauri, write: (path, value) => writeFileSync(join(root, path), JSON.stringify(value)) }
}

test('matching official constants pass and a local dev file is never read', (t) => {
  const { root } = fixture(t)
  writeFileSync(join(root, 'desktop/skillhub.build.json'), 'invalid local file')
  assert.match(verifyOfficialChannel(root, {}), /^Official channel gate passed:/)
})

for (const field of ['endpoint', 'pubkey']) {
  test(`mismatching updater ${field} fails`, (t) => {
    const { root, tauri, write } = fixture(t)
    if (field === 'endpoint') tauri.plugins.updater.endpoints = ['https://wrong.example/update']
    else tauri.plugins.updater.pubkey = 'wrong'
    write('desktop/src-tauri/tauri.conf.json', tauri)
    assert.throws(() => verifyOfficialChannel(root, {}), /endpoint\/pubkey differ/)
  })
}

test('dev enabled by default in identity, commands, environment or Cargo config fails', (t) => {
  const { root, tauri, write } = fixture(t)
  assert.throws(() => verifyOfficialChannel(root, { SKILLHUB_CHANNEL: 'dev' }), /must be official/)
  assert.throws(() => verifyOfficialChannel(root, { TAURI_CONFIG: '{"identifier":"com.yitan.skillhub.dev"}' }), /identity/)
  assert.throws(() => verifyOfficialChannel(root, { TAURI_CONFIG: '{"build":{"beforeBuildCommand":"SKILLHUB_CHANNEL=dev npm run build"}}' }), /default build/)
  write('desktop/src-tauri/tauri.conf.json', { ...tauri, identifier: 'com.yitan.skillhub.dev' })
  assert.throws(() => verifyOfficialChannel(root, {}), /identity/)
  write('desktop/src-tauri/tauri.conf.json', tauri)
  const pkg = JSON.parse(readFileSync(join(root, 'desktop/package.json')))
  write('desktop/package.json', { ...pkg, scripts: { ...pkg.scripts, build: 'SKILLHUB_CHANNEL=dev vite build' } })
  assert.throws(() => verifyOfficialChannel(root, {}), /default build/)
  write('desktop/package.json', pkg)
  mkdirSync(join(root, '.cargo'))
  writeFileSync(join(root, '.cargo/config.toml'), '[env]\nSKILLHUB_CHANNEL="dev"\n')
  assert.throws(() => verifyOfficialChannel(root, {}), /must not select/)
})

test('platform overlay and example drift fail', (t) => {
  const { root, config, write } = fixture(t)
  write('desktop/src-tauri/tauri.windows.conf.json', { plugins: { updater: { pubkey: 'wrong' } } })
  assert.throws(() => verifyOfficialChannel(root, {}), /endpoint\/pubkey differ/)
  rmSync(join(root, 'desktop/src-tauri/tauri.windows.conf.json'))
  write('desktop/src-tauri/tauri.windows.conf.json', { build: { beforeBuildCommand: 'SKILLHUB_CHANNEL=dev npm run build' } })
  assert.throws(() => verifyOfficialChannel(root, {}), /default build/)
  rmSync(join(root, 'desktop/src-tauri/tauri.windows.conf.json'))
  write('desktop/skillhub.build.example.json', { ...config, siteOrigin: 'https://wrong.example' })
  assert.throws(() => verifyOfficialChannel(root, {}), /must match/)
})

test('only dev derives missing docsOrigin; explicit invalid values still fail', (t) => {
  const { root, config, write } = fixture(t)
  const desktop = join(root, 'desktop')
  delete config.docsOrigin
  config.siteOrigin = 'https://dev.example/skillhub'
  write('desktop/skillhub.build.json', config)
  assert.equal(readChannel('dev', desktop).config.docsOrigin, 'https://dev.example/skillhub/docs/')
  write('desktop/official-channel.json', config)
  assert.throws(() => readChannel('official', desktop), /invalid docsOrigin/)
  for (const docsOrigin of ['', null, 'http://unsafe.example/docs/']) {
    write('desktop/skillhub.build.json', { ...config, docsOrigin })
    assert.throws(() => readChannel('dev', desktop), /docsOrigin/)
  }
})

test('dev requires a complete valid build file and matching identity/updater overlay', (t) => {
  const { root, config, tauri, write } = fixture(t)
  const desktop = join(root, 'desktop')
  assert.throws(() => readChannel('typo', desktop), /official or dev/)
  assert.throws(() => readChannel('dev', desktop), /copy skillhub.build.example/)
  write('desktop/skillhub.build.json', { ...config, siteOrigin: 'http://localhost:3001' })
  assert.throws(() => readChannel('dev', desktop), /HTTPS/)
  write('desktop/skillhub.build.json', { ...config, updater: { ...config.updater, pubkey: 'invalid' } })
  assert.throws(() => readChannel('dev', desktop), /invalid updater.pubkey/)
  const staging = { ...config, serverOrigin: 'https://staging.example/skillhub',
    updater: { ...config.updater, endpoint: 'https://staging.example/updates/{{target}}' } }
  write('desktop/skillhub.build.json', staging)
  assert.deepEqual(readChannel('dev', desktop).config, staging)
  assert.throws(() => checkTauriChannel(staging, 'dev', tauri), /identity/)
  const overlay = JSON.parse(readFileSync(new URL('../desktop/src-tauri/tauri.dev.conf.json', import.meta.url)))
  assert.throws(() => checkTauriChannel(staging, 'dev', mergeConfig(tauri, overlay)), /endpoint\/pubkey differ/)
  overlay.plugins.updater = { endpoints: [staging.updater.endpoint], pubkey: staging.updater.pubkey }
  assert.doesNotThrow(() => checkTauriChannel(staging, 'dev', mergeConfig(tauri, overlay)))
  assert.equal(mergeConfig(tauri, overlay).identifier, 'com.yitan.skillhub.dev')
  assert.deepEqual(mergeConfig({ nested: { keep: 1, remove: 2 } }, { nested: { remove: null } }), { nested: { keep: 1 } })
})
