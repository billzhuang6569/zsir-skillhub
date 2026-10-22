import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('brand surfaces consume canonical asset files instead of duplicated inline geometry', () => {
  const component = readFileSync(resolve(desktopRoot, 'src/components/BrandMark.tsx'), 'utf8')
  assert.match(component, /new URL\('\.\.\/assets\/brand-mark\.png'/)
  assert.match(component, /new URL\('\.\.\/assets\/brand-mark-inverse\.svg'/)
  assert.doesNotMatch(component, /<svg|<circle|<path/)
  const brandMark = resolve(desktopRoot, 'src/assets/brand-mark.png')
  assert.equal(existsSync(brandMark), true)
  assert.equal(existsSync(resolve(desktopRoot, 'src/assets/brand-mark-inverse.svg')), true)
  assert.equal(
    sha256(resolve(desktopRoot, '../design/LOGO_app_icon_pureShape.png')),
    '69cfa90ae26302556782d01a783b3195ab64da8832121a17c3591ab86e967e18',
  )
  assert.equal(sha256(brandMark), '889888d92f2a4d91fbb532b973dce6de61817712e582154fa917b184456f3a24')
})

test('macOS bundle icons are generated from the approved complete app icon', () => {
  const source = resolve(desktopRoot, '../design/LOGO_app_icon.png')
  assert.equal(sha256(source), '2bb64a3084f5bf2308f1a5b5f14443408c5951a181547bef388dc0e5d51e163d')
  assert.equal(sha256(resolve(desktopRoot, 'src-tauri/icons/32x32.png')), '90b6d852db33ade125b5dc0dbc20d964702ec794ddfb52cee2f98946576b376e')
  assert.equal(sha256(resolve(desktopRoot, 'src-tauri/icons/128x128.png')), '29ffbacc921d0962ae9d52c641f6ad0f03e2fc2b205e31a3a41075944884723c')
  assert.equal(sha256(resolve(desktopRoot, 'src-tauri/icons/128x128@2x.png')), 'f17e5f27a6bc82f7d0fdb2a1e0a6cfd583fae932c46be92f9da086b1e280c1b2')
  assert.equal(sha256(resolve(desktopRoot, 'src-tauri/icons/icon.icns')), '0bded4ea0633707d8b319233196afd50208d220fdeda61576c0c52fc8fdc23ab')
})

test('release UI bundles fonts and favicon locally under the Tauri CSP', () => {
  const html = readFileSync(resolve(desktopRoot, 'index.html'), 'utf8')
  const entrypoint = readFileSync(resolve(desktopRoot, 'src/main.tsx'), 'utf8')
  const tauriConfig = JSON.parse(readFileSync(resolve(desktopRoot, 'src-tauri/tauri.conf.json'), 'utf8')) as {
    bundle?: { resources?: Record<string, string> }
  }

  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/)
  assert.match(html, /\/src\/assets\/brand-mark\.png/)
  assert.doesNotMatch(entrypoint, /@fontsource\/manrope/)
  assert.match(entrypoint, /@fontsource\/jetbrains-mono\/latin-400\.css/)

  const resources = tauriConfig.bundle?.resources ?? {}
  const dependencies = (JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }).dependencies ?? {}
  for (const [source, destination] of Object.entries(resources)) {
    assert.equal(existsSync(resolve(desktopRoot, 'src-tauri', source)), true, source)
    assert.match(destination, /^licenses\//)
    // A stale node_modules (or a worktree symlinked to another checkout) can still hold a
    // removed package, so existsSync alone does not prove the resource ships (#258).
    const packageName = /^\.\.\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(source)?.[1]
    if (packageName) assert.ok(packageName in dependencies, `${source} needs ${packageName} in dependencies`)
  }
  assert.equal(resources['../node_modules/@fontsource/jetbrains-mono/LICENSE'], 'licenses/JetBrains-Mono-OFL.txt')
})
