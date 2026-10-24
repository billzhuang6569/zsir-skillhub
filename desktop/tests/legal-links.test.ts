import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { LEGAL_LINKS, LEGAL_PRIVACY_URL, LEGAL_TERMS_URL, openLegalLink } from '../src/lib/legal-links.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')
const settings = source('src/pages/SettingsPage.tsx')
const styles = source('src/pages/SettingsPage.css')

test('legal links are fixed public HTTPS addresses without account or tracking parameters', () => {
  assert.equal(LEGAL_PRIVACY_URL, 'https://sk.woe.show/privacy/')
  assert.equal(LEGAL_TERMS_URL, 'https://sk.woe.show/terms/')
  assert.deepEqual(LEGAL_LINKS.map((link) => [link.label, link.url]), [
    ['隐私与数据安全', 'https://sk.woe.show/privacy/'],
    ['使用条款', 'https://sk.woe.show/terms/'],
  ])
  for (const link of LEGAL_LINKS) {
    const url = new URL(link.url)
    assert.equal(url.protocol, 'https:')
    assert.equal(url.host, 'sk.woe.show')
    assert.equal(url.search, '')
    assert.equal(url.hash, '')
  }
})

test('openLegalLink hands the exact URL to the system opener', async () => {
  const opened: string[] = []
  const errors: string[] = []
  for (const link of LEGAL_LINKS) {
    const ok = await openLegalLink(link, async (url) => { opened.push(url) }, (message) => errors.push(message), String)
    assert.equal(ok, true)
  }
  assert.deepEqual(opened, ['https://sk.woe.show/privacy/', 'https://sk.woe.show/terms/'])
  assert.deepEqual(errors, [])
})

test('openLegalLink reports opener failures without throwing', async () => {
  const errors: string[] = []
  const ok = await openLegalLink(
    LEGAL_LINKS[1]!,
    async () => { throw new Error('denied') },
    (message) => errors.push(message),
    (error) => (error instanceof Error ? error.message : String(error)),
  )
  assert.equal(ok, false)
  assert.deepEqual(errors, ['无法打开「使用条款」：denied'])
})

test('Settings About version row keeps name/version left and the two legal buttons right, in order', () => {
  const about = settings.indexOf('id="settings-help" data-settings-section>帮助与关于</p>')
  assert.ok(about >= 0)
  const firstRow = settings.indexOf('<div className="settings-row settings-about-row">', about)
  const info = settings.indexOf('<b>一探 SkillHub</b><span>v{appVersion} · 内部正式版</span>', firstRow)
  const links = settings.indexOf('<div className="settings-about-links">', firstRow)
  const update = settings.indexOf('<b>应用更新</b>', about)
  assert.ok(firstRow > about)
  assert.ok(info > firstRow && links > info, 'version info stays left of the buttons')
  assert.ok(update > about && update < firstRow, 'app update precedes the version and legal row')
  assert.match(settings, /import \{ openUrl \} from '@tauri-apps\/plugin-opener'/)
  assert.match(settings, /import \{ LEGAL_LINKS, openLegalLink \} from '\.\.\/lib\/legal-links\.js'/)
  assert.match(
    settings,
    /\{LEGAL_LINKS\.map\(\(link\) => <button key=\{link\.url\} type="button" className="btn btn-ghost btn-sm" onClick=\{\(\) => void openLegalLink\(link, openUrl, \(message\) => toast\(message, 'error'\), messageOf\)\}>\{link\.label\}<\/button>\)\}/,
  )
})

test('About legal buttons wrap as a group at narrow widths instead of truncating', () => {
  assert.match(styles, /\.settings-about-row \{ flex-wrap: wrap;/)
  assert.match(styles, /\.settings-about-links \{ display: flex; flex-wrap: wrap; justify-content: flex-end;/)
  assert.match(styles, /\.settings-about-links \.btn \{ flex: none; white-space: nowrap; \}/)
})

// http is allowed for a Skill's 「来源」 link (#330), which the Server accepts as http or https.
test('opener capability allows only http(s) and mailto URLs (payment, external links, legal pages, Skill sources)', () => {
  const capability = JSON.parse(source('src-tauri/capabilities/default.json')) as { permissions: Array<string | { identifier: string; allow?: Array<{ url?: string }> }> }
  const openUrl = capability.permissions.find((entry) => typeof entry === 'object' && entry.identifier === 'opener:allow-open-url')
  assert.ok(openUrl && typeof openUrl === 'object')
  assert.deepEqual(openUrl.allow, [{ url: 'https://*' }, { url: 'http://*' }, { url: 'mailto:*' }])
  assert.equal(capability.permissions.includes('opener:allow-open-url'), false)
})
