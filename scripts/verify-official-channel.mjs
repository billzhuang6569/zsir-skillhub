#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkTauriChannel, mergeConfig, readChannel } from '../desktop/scripts/build-channel.mjs'

export function verifyOfficialChannel(root = process.cwd(), env = process.env) {
  if (env.SKILLHUB_CHANNEL && env.SKILLHUB_CHANNEL !== 'official') throw new Error('release channel must be official')
  const read = (path) => readFileSync(resolve(root, path), 'utf8')
  const json = (path) => JSON.parse(read(path))
  const { config } = readChannel('official', resolve(root, 'desktop'))
  const tauri = json('desktop/src-tauri/tauri.conf.json')
  checkTauriChannel(config, 'official', tauri)
  checkTauriChannel(config, 'official', mergeConfig(tauri, JSON.parse(env.TAURI_CONFIG ?? '{}')))
  if (JSON.stringify(config) !== JSON.stringify(json('desktop/skillhub.build.example.json'))) {
    throw new Error('skillhub.build.example.json must match official constants')
  }
  const scripts = json('desktop/package.json').scripts
  if (scripts['tauri:build'] !== 'node scripts/tauri-channel.mjs official build'
    || scripts.build !== 'tsc && vite build' || scripts.dev !== 'vite'
    || scripts.tauri !== 'tauri' || tauri.build.beforeBuildCommand !== 'npm run build'
    || tauri.build.beforeDevCommand !== 'npm run dev') {
    throw new Error('default build commands must use the official channel')
  }
  const tauriDir = resolve(root, 'desktop/src-tauri')
  for (const name of readdirSync(tauriDir)) {
    if (/^tauri\..*\.conf\.json$/.test(name) && name !== 'tauri.dev.conf.json') {
      checkTauriChannel(config, 'official', mergeConfig(tauri, json(`desktop/src-tauri/${name}`)))
    }
  }
  for (const path of ['.cargo/config', '.cargo/config.toml', 'desktop/.cargo/config', 'desktop/.cargo/config.toml',
    'desktop/src-tauri/.cargo/config', 'desktop/src-tauri/.cargo/config.toml']) {
    if (existsSync(resolve(root, path)) && /SKILLHUB_CHANNEL|TAURI_CONFIG/.test(read(path))) {
      throw new Error(`${path} must not select a build channel or override Tauri constants`)
    }
  }
  return 'Official channel gate passed: constants, updater and default build identity agree.'
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(verifyOfficialChannel()) } catch (error) {
    console.error(`Official channel gate failed: ${error.message}`)
    process.exitCode = 1
  }
}
