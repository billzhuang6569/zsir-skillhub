import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { desktopRoot, readChannel } from './build-channel.mjs'

const [channel, command, ...args] = process.argv.slice(2)
try {
  const { config } = readChannel(channel)
  const overlays = []
  if (channel === 'dev') {
    const overlay = JSON.parse(readFileSync(resolve(desktopRoot, 'src-tauri/tauri.dev.conf.json'), 'utf8'))
    overlay.plugins.updater = { endpoints: [config.updater.endpoint], pubkey: config.updater.pubkey }
    overlays.push('--config', JSON.stringify(overlay))
  }
  const separator = args.indexOf('--')
  args.splice(separator === -1 ? args.length : separator, 0, ...overlays)
  const result = spawnSync(process.execPath, [resolve(desktopRoot, 'node_modules/@tauri-apps/cli/tauri.js'), command, ...args], {
    cwd: desktopRoot, stdio: 'inherit', env: { ...process.env, SKILLHUB_CHANNEL: channel },
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} catch (error) {
  process.stderr.write(`SkillHub channel build failed: ${error.message}\n`)
  process.exitCode = 1
}
