import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('generates a target-aware Tauri updater manifest without exposing credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skillhub-update-manifest-'))
  const artifact = join(dir, 'SkillHub.app.tar.gz')
  const signature = `${artifact}.sig`
  const dmg = join(dir, 'SkillHub_1.2.3_aarch64.dmg')
  const output = join(dir, 'manifest.json')
  writeFileSync(artifact, 'artifact')
  writeFileSync(signature, 'trusted-signature\n')
  writeFileSync(dmg, 'dmg-artifact')
  execFileSync(process.execPath, [
    fileURLToPath(new URL('./generate-app-update-manifest.mjs', import.meta.url)),
    '--version', '1.2.3', '--target', 'darwin', '--arch', 'aarch64',
    '--artifact', artifact, '--signature', signature,
    '--dmg', dmg,
    '--base-url', 'https://updates.example.com/skillhub/updates', '--output', output,
  ])
  const manifest = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(manifest.schemaVersion, 2)
  const release = manifest.releases[0]
  assert.equal(release.version, '1.2.3')
  assert.equal(release.target, 'darwin')
  assert.equal(release.arch, 'aarch64')
  assert.equal(release.updater.signature, 'trusted-signature')
  assert.equal(release.updater.url, 'https://updates.example.com/skillhub/updates/v1.2.3/SkillHub.app.tar.gz')
  assert.equal(release.updater.sha256, 'c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c')
  assert.equal(release.updater.size, 8)
  assert.equal(release.minimumSystemVersion, '11.0')
  assert.equal(release.installer.kind, 'dmg')
  assert.equal(release.installer.url, 'https://updates.example.com/skillhub/updates/v1.2.3/SkillHub_1.2.3_aarch64.dmg')
  assert.equal(release.installer.sha256, 'e5a3434efd3a41b352631d96f980e8172d574833bf571748102e3ac853d338b6')
  assert.equal(release.installer.size, 12)
})

test('publishing Intel macOS preserves Apple Silicon and both Windows architecture records exactly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skillhub-update-manifest-merge-'))
  const updater = join(dir, 'SkillHub.app.tar.gz')
  const signature = `${updater}.sig`
  const installer = join(dir, 'SkillHub_1.2.4_x86_64.dmg')
  const base = join(dir, 'base.json')
  const output = join(dir, 'manifest.json')
  writeFileSync(updater, 'mac-updater')
  writeFileSync(signature, 'mac-signature\n')
  writeFileSync(installer, 'mac-installer')
  const oldMac = {
    target: 'darwin', arch: 'aarch64', version: '1.2.3', notes: '', pubDate: '2026-09-01T00:00:00.000Z', minimumSystemVersion: '11.0',
    installer: { kind: 'dmg', url: 'https://updates.example.com/v1.2.3/app.dmg', sha256: 'a'.repeat(64), size: 1 },
    updater: { url: 'https://updates.example.com/v1.2.3/app.tar.gz', signature: 'mac-signature' },
  }
  const windowsArm = {
    target: 'windows', arch: 'aarch64', version: '1.2.3', notes: 'Windows ARM', pubDate: '2026-09-01T00:00:00.000Z', minimumSystemVersion: '10.0.19041',
    installer: { kind: 'nsis', url: 'https://updates.example.com/v1.2.3/arm.exe', sha256: 'b'.repeat(64), size: 2 },
    updater: { url: 'https://updates.example.com/v1.2.3/arm.nsis.zip', signature: 'windows-arm-signature' },
  }
  const windowsX64 = {
    target: 'windows', arch: 'x86_64', version: '1.2.3', notes: 'Windows x64', pubDate: '2026-09-01T00:00:00.000Z', minimumSystemVersion: '10.0.19041',
    installer: { kind: 'nsis', url: 'https://updates.example.com/v1.2.3/x64.exe', sha256: 'c'.repeat(64), size: 3 },
    updater: { url: 'https://updates.example.com/v1.2.3/x64.nsis.zip', signature: 'windows-x64-signature' },
  }
  writeFileSync(base, JSON.stringify({ schemaVersion: 2, releases: [oldMac, windowsArm, windowsX64] }))
  execFileSync(process.execPath, [
    fileURLToPath(new URL('./generate-app-update-manifest.mjs', import.meta.url)),
    '--version', '1.2.4', '--target', 'darwin', '--arch', 'x86_64',
    '--artifact', updater, '--signature', signature,
    '--installer', installer, '--installer-kind', 'dmg', '--minimum-system-version', '11.0',
    '--base-manifest', base,
    '--base-url', 'https://updates.example.com/skillhub/updates', '--output', output,
  ])
  const releases = JSON.parse(readFileSync(output, 'utf8')).releases
  assert.deepEqual(releases.map(({ target, arch }) => `${target}/${arch}`), [
    'darwin/aarch64',
    'darwin/x86_64',
    'windows/aarch64',
    'windows/x86_64',
  ])
  assert.deepEqual(releases[0], oldMac)
  assert.equal(releases[1].version, '1.2.4')
  assert.equal(releases[1].updater.signature, 'mac-signature')
  assert.equal(releases[1].installer.url, 'https://updates.example.com/skillhub/updates/v1.2.4/SkillHub_1.2.4_x86_64.dmg')
  assert.deepEqual(releases[2], windowsArm)
  assert.deepEqual(releases[3], windowsX64)
})
