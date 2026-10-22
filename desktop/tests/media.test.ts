import assert from 'node:assert/strict'
import test, { beforeEach, afterEach } from 'node:test'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { mockConvertFileSrc, clearMocks } from '@tauri-apps/api/mocks'
import { mediaUrl, restoreMediaContext, setMediaContext, type MediaContext } from '../src/lib/media.ts'
import { renderTopicMarkdown } from '../src/lib/markdown.ts'

const key = `aa/${'a'.repeat(64)}.png`
const scope: MediaContext = { spaceId: 'space-a', serverBase: 'http://127.0.0.1:3001/skillhub', allowedImageHosts: ['picem-media.whatonearth.work'] }
const remote = 'https://picem-media.whatonearth.work/public/app/image.png'

test('previous complete bases resolve only built-in media keys to the current native space', () => {
  const rebound = { ...scope, serverBase: 'http://127.0.0.1:3003/new-prefix', previousOrigins: [scope.serverBase, 'https://older.test/deep/prefix'] }
  const current = mediaUrl(`${rebound.serverBase}/media/${key}`, rebound)
  assert.equal(mediaUrl(`${scope.serverBase}/media/${key}`, rebound), current)
  assert.equal(mediaUrl(`https://older.test/deep/prefix/media/${key}`, rebound), current)
  assert.equal(mediaUrl(`https://overlap.test/prefix/media/media/${key}`, { ...rebound, serverBase: 'https://overlap.test/prefix', previousOrigins: ['https://overlap.test/prefix/media'] }), current)
  for (const invalid of [`${scope.serverBase}2/media/${key}`, `https://older.test/media/${key}`, `${scope.serverBase}/public/${key}`, `${scope.serverBase}/media/aa/source.png`]) assert.equal(mediaUrl(invalid, rebound), null)
  assert.equal(mediaUrl(`${scope.serverBase}/media/${key}`, { ...rebound, previousOrigins: [] }), null)
  restoreMediaContext(rebound.spaceId, rebound.serverBase, rebound.previousOrigins)
  assert.equal(mediaUrl(`${scope.serverBase}/media/${key}`), current)
})
let previousWindow: PropertyDescriptor | undefined
let previousStorage: PropertyDescriptor | undefined
beforeEach(() => {
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string): string | null => storage.get(key) ?? null,
    setItem: (key: string, value: string): void => { storage.set(key, value) },
  } })
  mockConvertFileSrc('macos')
  setMediaContext(null)
})
afterEach(() => {
  setMediaContext(null)
  clearMocks()
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

test('instance keys and allowlisted HTTPS images use Tauri conversion on both platforms', () => {
  for (const [os, prefix] of [['macos', 'skillhub-media://localhost/'], ['windows', 'http://skillhub-media.localhost/']] as const) {
    mockConvertFileSrc(os)
    assert.equal(mediaUrl(`${scope.serverBase}/media/${key}`, scope), prefix + encodeURIComponent(`space-a/m/${key}`))
    assert.equal(mediaUrl(remote, scope), prefix + encodeURIComponent('space-a/h/picem-media.whatonearth.work/public/app/image.png'))
  }
  for (const base of ['https://official.example/skillhub', 'http://[::1]:3001', 'http://[::ffff:127.0.0.1]:3001']) {
    assert.ok(mediaUrl(`${base}/media/${key}`, { ...scope, serverBase: base }))
  }
})

test('URLs reject non-allowlisted hosts, credentials, query/fragment, traversal and ambiguous paths', () => {
  for (const value of [undefined, null, '', '/media/' + key, 'data:image/png;base64,AAAA',
    'https://evil.example/public/image.png', 'http://picem-media.whatonearth.work/public/a.png',
    remote + '?', remote + '#', remote + '?secret=redacted', remote + '#x',
    remote.replace('https://', 'https://user:pass@'), remote.replace('.work/', '.work:444/'),
    remote.replace('/app/', '/./'), remote.replace('/app/', '/../'), remote.replace('/app/', '//'),
    remote.replace('/app/', '/a%2fb/'), remote.replace('/app/', '/%2e%2e/'), remote.replace('/app/', '/a\\b/'),
    `${scope.serverBase}/media/aa/not-a-digest.png`, `${scope.serverBase}/media/bb/${'a'.repeat(64)}.png`,
    `${scope.serverBase}/media/aa/${'a'.repeat(64)}.svg`, `http://127.0.0.1:3002/skillhub/media/${key}`]) {
    assert.equal(mediaUrl(value, scope), null, String(value))
  }
  assert.equal(mediaUrl(remote), null)
  assert.equal(mediaUrl(remote, { ...scope, spaceId: '..' }), null)
  assert.equal(mediaUrl(remote, { ...scope, allowedImageHosts: [] }), null)
})

test('last health policy restores offline only for the same native space and base', () => {
  setMediaContext(scope)
  const original = mediaUrl(remote)
  setMediaContext(null)
  restoreMediaContext(scope.spaceId, scope.serverBase)
  assert.equal(mediaUrl(remote), original)
  restoreMediaContext('space-b', scope.serverBase)
  assert.equal(mediaUrl(remote), null)
  assert.notEqual(mediaUrl(`${scope.serverBase}/media/${key}`), mediaUrl(`${scope.serverBase}/media/${key}`, scope))
  restoreMediaContext(scope.spaceId, 'https://another.example')
  assert.equal(mediaUrl(remote), null)
})

test('article images use the same policy and update when server-info arrives', () => {
  const markdown = `![x](${remote})\n\n![local](${scope.serverBase}/media/${key})\n\n![bad](https://evil.example/a.png)`
  assert.doesNotMatch(renderTopicMarkdown(markdown, null), /<img /)
  const html = renderTopicMarkdown(markdown, scope)
  assert.equal((html.match(/<img /g) ?? []).length, 2)
  assert.doesNotMatch(html, /<img src="https?:/)
  assert.match(html, /skillhub-media:\/\/localhost\/space-a%2Fm%2F/)
  assert.match(html, /skillhub-media:\/\/localhost\/space-a%2Fh%2F/)
})

test('SkillAvatarIcon renders only native addresses and keeps its neutral placeholder', async () => {
  const sourceUrl = new URL('../src/components/SkillAvatarIcon.tsx', import.meta.url)
  const source = readFileSync(sourceUrl, 'utf8').replace("'../lib/media.js'", JSON.stringify(new URL('../src/lib/media.ts', import.meta.url).href))
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  } })
  const directory = fileURLToPath(new URL('../node_modules/.cache/media-test/', import.meta.url))
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'SkillAvatarIcon.mjs')
  writeFileSync(path, outputText)
  const { SkillAvatarIcon } = await import(pathToFileURL(path).href) as { SkillAvatarIcon: ComponentType<{ avatarUrl: string }> }
  setMediaContext(scope)
  const render = (url: string): string => renderToStaticMarkup(createElement(SkillAvatarIcon, { avatarUrl: url }))
  assert.match(render(remote), /<img src="skillhub-media:\/\/localhost\/space-a%2Fh%2F/)
  assert.match(render('https://evil.example/a.png'), /data-skill-avatar="placeholder"/)
  assert.doesNotMatch(render('https://evil.example/a.png'), /<img /)
})

test('all JSX images are audited: server images use the media hook; remaining images are bundled or data', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url))
  const nativeImages: Record<string, string> = {
    'components/AvatarSettings.tsx': 'url',
    'components/SkillAvatarIcon.tsx': 'url!', 'components/AvatarUploader.tsx': 'displayUrl',
    'components/Sidebar.tsx': 'imageUrl', 'components/TeamDetailSheet.tsx': 'url',
    'components/TeamInviteDialog.tsx': 'imageUrl', 'components/UserChip.tsx': 'imageUrl',
    'pages/TeamsPage.tsx': 'imageUrl', 'pages/TeamSharedPage.tsx': 'imageUrl',
  }
  const localImages: Record<string, string> = {
    'components/BrandMark.tsx': 'inverse ? inverseBrandMarkUrl : brandMarkUrl',
    'components/AuthDialog.tsx': 'appIconUrl', 'components/AgentBrandIcon.tsx': 'productLogos[agent.key]',
    'components/FeedbackDialog.tsx': '`data:${attachment.mimeType};base64,${attachment.dataBase64}`',
  }
  const seen = new Set<string>()
  function scan(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { scan(path); continue }
      if (!entry.name.endsWith('.tsx')) continue
      const source = readFileSync(path, 'utf8')
      const name = relative(root, path).split(sep).join('/')
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      function visit(node: ts.Node): void {
        if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(ast) === 'img') {
          seen.add(name)
          const src = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(ast) === 'src')
          assert.ok(src && ts.isJsxAttribute(src) && src.initializer && ts.isJsxExpression(src.initializer), name)
          const expected = nativeImages[name] ?? localImages[name]
          assert.ok(expected, `Unaudited image: ${name}`)
          assert.equal(src.initializer.expression?.getText(ast), expected, name)
          if (nativeImages[name]) {
            const binding = expected.replace(/!$/, '')
            assert.match(source, new RegExp(`const ${binding} = useMediaUrl\\(`), name)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(ast)
      // The tour's local SVG mask references a generated DOM id, never a remote image.
      const imageSource = name === 'components/FeatureTour.tsx' ? source.replace('mask={`url(#${maskId})`}', '') : source
      assert.doesNotMatch(imageSource, /backgroundImage|\burl\(/, `Audit new background image: ${name}`)
    }
  }
  scan(root)
  assert.deepEqual([...seen].sort(), [...Object.keys(nativeImages), ...Object.keys(localImages)].sort())
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  assert.equal(config.app.security.csp.split(';').map((part: string) => part.trim()).find((part: string) => part.startsWith('img-src ')),
    "img-src 'self' data: asset: http://asset.localhost skillhub-media: http://skillhub-media.localhost")
  assert.equal(config.app.security.csp.split(';').map((part: string) => part.trim()).find((part: string) => part.startsWith('connect-src ')),
    "connect-src 'self' ipc: http://ipc.localhost")
})
