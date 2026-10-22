import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export const desktopRoot = fileURLToPath(new URL('../', import.meta.url))

export function readChannel(channel = process.env.SKILLHUB_CHANNEL ?? 'official', root = desktopRoot) {
  if (!['official', 'dev'].includes(channel)) throw new Error('SKILLHUB_CHANNEL must be official or dev')
  const path = resolve(root, channel === 'dev' ? 'skillhub.build.json' : 'official-channel.json')
  let config
  try { config = JSON.parse(readFileSync(path, 'utf8')) } catch {
    throw new Error(`${path} is missing or invalid; for dev copy skillhub.build.example.json to skillhub.build.json`)
  }
  if (channel === 'dev' && config.docsOrigin === undefined) config.docsOrigin = `${config.siteOrigin}/docs/`
  for (const key of ['serverOrigin', 'catalogOrigin', 'supportOrigin', 'styleOrigin', 'siteOrigin', 'docsOrigin', 'updater.endpoint']) {
    const value = key === 'updater.endpoint' ? config?.updater?.endpoint : config?.[key]
    let url
    try { url = new URL(value) } catch { throw new Error(`${path}: invalid ${key}`) }
    if (typeof value !== 'string' || value !== value.trim() || url.protocol !== 'https:' || !url.hostname
      || url.username || url.password || url.search || url.hash || /[\s\\]/.test(value)) {
      throw new Error(`${path}: ${key} must be HTTPS without credentials, query or fragment`)
    }
  }
  const key = config?.updater?.pubkey
  const decoded = typeof key === 'string' ? Buffer.from(key, 'base64').toString('utf8').trim().split('\n') : []
  if (!decoded[0]?.startsWith('untrusted comment:') || decoded.length !== 2
    || Buffer.from(decoded[1], 'base64').length !== 42) throw new Error(`${path}: invalid updater.pubkey`)
  for (const field of ['serverOrigin', 'catalogOrigin', 'styleOrigin', 'siteOrigin']) {
    if (config[field].endsWith('/')) throw new Error(`${path}: ${field} must not end with /`)
  }
  return { channel, config, path }
}

export function checkTauriChannel(config, channel, tauri) {
  const dev = channel === 'dev'
  if (tauri.build?.beforeBuildCommand !== 'npm run build' || tauri.build?.beforeDevCommand !== 'npm run dev') {
    throw new Error('default build commands must use the selected compile-time channel')
  }
  if (tauri.identifier !== (dev ? 'com.yitan.skillhub.dev' : 'com.yitan.skillhub')
    || tauri.productName !== (dev ? 'SkillHub Dev' : '一探 SkillHub')
    || JSON.stringify(tauri.plugins?.['deep-link']?.desktop?.schemes) !== JSON.stringify([dev ? 'skillhub-dev' : 'skillhub'])) {
    throw new Error(`${channel} channel requires its matching Tauri identity overlay`)
  }
  if (tauri.plugins?.updater?.pubkey !== config.updater.pubkey
    || JSON.stringify(tauri.plugins?.updater?.endpoints) !== JSON.stringify([config.updater.endpoint])) {
    throw new Error(`${channel} Tauri updater endpoint/pubkey differ from channel constants`)
  }
}

// Tauri applies JSON Merge Patch to TAURI_CONFIG before embedding its context.
export function mergeConfig(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const merged = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key]
    else merged[key] = mergeConfig(merged[key], value)
  }
  return merged
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { config, channel } = readChannel()
    let tauri = JSON.parse(readFileSync(resolve(desktopRoot, 'src-tauri/tauri.conf.json'), 'utf8'))
    const platform = process.env.CARGO_CFG_TARGET_OS ?? (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform)
    const platformConfig = resolve(desktopRoot, `src-tauri/tauri.${platform}.conf.json`)
    if (existsSync(platformConfig)) tauri = mergeConfig(tauri, JSON.parse(readFileSync(platformConfig, 'utf8')))
    checkTauriChannel(config, channel, mergeConfig(tauri, JSON.parse(process.env.TAURI_CONFIG ?? '{}')))
    const scheme = channel === 'dev' ? 'skillhub-dev' : 'skillhub'
    const constants = { CHANNEL: channel, CHANNEL_JSON: JSON.stringify(config), DEEP_LINK_SCHEME: scheme,
      INVITE_PREFIX: `${scheme}://join-team/`, APP_OPEN_LINK: `${scheme}://open` }
    for (const [name, value] of Object.entries(constants)) {
      process.stdout.write(`pub const ${name}: &str = ${JSON.stringify(value)};\n`)
    }
  } catch (error) {
    process.stderr.write(`SkillHub channel build failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
