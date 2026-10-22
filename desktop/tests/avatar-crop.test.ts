import { fixtureSpace } from './helpers/space.ts'
import type { SpaceHandle } from '../src/lib/tauri.ts'
import { serverFixture } from './helpers/server-ipc.ts'
/**
 * Custom Skill avatars (#214): the pure crop geometry, who may change an avatar,
 * and the upload / restore flows against a mocked native bridge and HTTP — the
 * request reuses the avatar registration, and late responses are dropped.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CROP_OUTPUT, CROP_VIEWPORT, MAX_ZOOM, clampOffset, coverTransform, cropRect, cropToCanvas, encodeAvatar, panTransform,
  sourceTooSmall, zoomTransform, type CropCanvas,
} from '../src/lib/avatar-crop.ts'
import type { LocalSkill } from '../src/store/index.ts'

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/desktop/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
  }
  return nextResolve(specifier, context)
} })
const avatars = await import('../src/lib/skill-avatars.ts')
const { useStore } = await import('../src/store/index.ts')

const { ApiError } = await import('../src/lib/api.ts')
hooks.deregister()

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')
const near = (actual: number, expected: number): void => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`)

test('cover: the short side fills the viewfinder and the image is centred, for landscape, portrait, square and extreme ratios', () => {
  const landscape = coverTransform(1200, 800)
  near(landscape.scale, CROP_VIEWPORT / 800)
  near(landscape.y, 0)
  near(landscape.x, (CROP_VIEWPORT - 1200 * landscape.scale) / 2)
  const portrait = coverTransform(600, 1800)
  near(portrait.scale, CROP_VIEWPORT / 600)
  near(portrait.x, 0)
  assert.ok(portrait.y < 0)
  assert.deepEqual(coverTransform(512, 512), { scale: CROP_VIEWPORT / 512, x: 0, y: 0 })
  const panorama = coverTransform(8000, 256)
  near(panorama.scale, CROP_VIEWPORT / 256)
  assert.deepEqual(cropRect(panorama, 8000, 256), { sx: (8000 - 256) / 2, sy: 0, size: 256 })
})

test('panning and zooming never uncover the background, and zoom stays within 1×–3×', () => {
  const start = coverTransform(1200, 800)
  const farLeft = panTransform(start, 1200, 800, 10_000, 10_000)
  assert.deepEqual({ x: farLeft.x, y: farLeft.y }, { x: 0, y: 0 })
  const farRight = panTransform(start, 1200, 800, -10_000, -10_000)
  near(farRight.x, CROP_VIEWPORT - 1200 * start.scale)
  near(farRight.y, 0) // the short side already fits exactly
  assert.deepEqual(clampOffset({ scale: start.scale, x: 5, y: -999 }, 1200, 800), { scale: start.scale, x: 0, y: 0 })
  const nudged = panTransform(start, 1200, 800, 1, 0)
  near(nudged.x - start.x, 1) // arrow keys move one pixel
  const zoomed = zoomTransform(start, 1200, 800, 10)
  near(zoomed.scale, start.scale * MAX_ZOOM)
  const back = zoomTransform(zoomed, 1200, 800, 0.2)
  near(back.scale, start.scale)
  assert.ok(back.x <= 0 && back.x >= CROP_VIEWPORT - 1200 * back.scale)
  // Zooming keeps the source pixel under the anchor in place.
  const anchor = { x: 100, y: 120 }
  const sourceX = (anchor.x - start.x) / start.scale
  const twice = zoomTransform(start, 1200, 800, 2, anchor)
  near((anchor.x - twice.x) / twice.scale, sourceX)
  const rect = cropRect(twice, 1200, 800)
  near(rect.size, CROP_VIEWPORT / twice.scale)
  assert.ok(rect.sx >= 0 && rect.sy >= 0 && rect.sx + rect.size <= 1200 && rect.sy + rect.size <= 800)
})

test('the crop is drawn edge to edge into a 512×512 canvas with high-quality smoothing', () => {
  const calls: number[][] = []
  const context = { imageSmoothingEnabled: false, imageSmoothingQuality: 'low' as 'low' | 'medium' | 'high',
    drawImage: (_image: never, ...args: number[]): void => { calls.push(args) } }
  const canvas: CropCanvas = { width: 0, height: 0, getContext: () => context }
  const transform = zoomTransform(coverTransform(1600, 900), 1600, 900, 1.5)
  const result = cropToCanvas({ image: true }, 1600, 900, transform, () => canvas)
  assert.equal(result.width, CROP_OUTPUT)
  assert.equal(result.height, CROP_OUTPUT)
  assert.equal(context.imageSmoothingQuality, 'high')
  const [sx, sy, sw, sh, dx, dy, dw, dh] = calls[0]!
  assert.deepEqual([dx, dy, dw, dh], [0, 0, CROP_OUTPUT, CROP_OUTPUT])
  assert.equal(sw, sh)
  assert.ok(sx! >= 0 && sy! >= 0 && sx! + sw! <= 1600 && sy! + sh! <= 900)
  assert.throws(() => cropToCanvas({}, 10, 10, coverTransform(10, 10), () => ({ width: 0, height: 0, getContext: () => null })))
})

test('WebP 0.9 output, JPEG 0.9 where the engine cannot write WebP; originals under 256px are refused', async () => {
  const requested: Array<[string, number]> = []
  const webp = await encodeAvatar({ toBlob: (done, type, quality) => { requested.push([type, quality]); done(new Blob(['x'], { type })) } })
  assert.equal(webp.mimeType, 'image/webp')
  assert.deepEqual(requested, [['image/webp', 0.9]])
  // Engines without WebP encoding hand back PNG (or nothing) for the WebP request.
  const fallback = await encodeAvatar({ toBlob: (done, type) => done(new Blob(['x'], { type: type === 'image/webp' ? 'image/png' : type })) })
  assert.equal(fallback.mimeType, 'image/jpeg')
  assert.equal(sourceTooSmall(255, 4000), true)
  assert.equal(sourceTooSmall(256, 256), false)
  const dialog = source('src/components/AvatarCropDialog.tsx')
  assert.match(dialog, /createImageBitmap\(blob, \{ imageOrientation: 'from-image' \}\)/)
  assert.match(dialog, /图片太小，至少 256×256/)
  assert.match(dialog, /'使用这张'/)
})

const ownLocal = {
  id: 'managed', name: 'sample', displayName: 'Sample', description: 'Sample skill', localPath: '/fixture/sample',
  version: '0.1.0', latestVersion: '0.1.0', labels: [], sources: [], agents: {}, installed: false, isOwn: true,
  installCount: 0, acquisitionSource: 'local', compatibleAgents: [], sharedTo: {}, envDeps: [], versions: [],
  avatarLocalId: 'device-id', avatarStatus: 'pending', avatarAccountUserId: 'owner', fitScenarios: ['weekly report'],
  libraryAccountId: 'owner', libraryEntryId: 'entry-id',
} as unknown as LocalSkill

test('only the owner of a Skill that may generate an avatar can change it: never system, team, store Skills or guests', () => {
  assert.equal(avatars.canChangeSkillAvatar(ownLocal, 'owner'), true)
  assert.equal(avatars.canChangeSkillAvatar(ownLocal, null), false)
  assert.equal(avatars.canChangeSkillAvatar({ ...ownLocal, isSystem: true }, 'owner'), false)
  assert.equal(avatars.canChangeSkillAvatar({ ...ownLocal, teamSharedFrom: 'team-1' }, 'owner'), false)
  assert.equal(avatars.canChangeSkillAvatar({ ...ownLocal, id: 'market:listing' }, 'owner'), false)
  assert.equal(avatars.canChangeSkillAvatar({ ...ownLocal, acquisitionSource: 'marketplace' } as LocalSkill, 'owner'), false)
  const cloud = { ...ownLocal, serverId: 'cloud-id', serverOwnerId: 'owner', serverAccessValidatedForUserId: 'owner' }
  assert.equal(avatars.canChangeSkillAvatar(cloud, 'owner'), true)
  assert.equal(avatars.canChangeSkillAvatar({ ...cloud, serverOwnerId: 'someone-else' }, 'owner'), false)
  const sheet = source('src/components/SkillDetailSheet.tsx')
  assert.match(sheet, /if \(!capabilities\.avatarUpload \|\| !currentUser \|\| !canChangeSkillAvatar\(skill, currentUser\.id\)\) return icon/)
  assert.match(sheet, /aria-label="更换头像"/)
  assert.match(sheet, /<Icon name="camera" size=\{11\} \/>/)
  assert.match(sheet, /<SkillAvatarControl key=\{skill\.id\} skill=\{skill\} \/>/)
})

test('responses are applied only for the same account, space and open sheet', () => {
  const request = { userId: 'owner', space: fixtureSpace('t1'), skillId: 'managed', sheetOpen: () => true }
  const state = { currentUserId: 'owner', space: fixtureSpace('t1'), skill: { id: 'managed', avatarAccountUserId: 'owner' } }
  assert.equal(avatars.customAvatarResponseIsCurrent(request, state), true)
  assert.equal(avatars.customAvatarResponseIsCurrent(request, { ...state, currentUserId: 'other' }), false)
  assert.equal(avatars.customAvatarResponseIsCurrent(request, { ...state, space: fixtureSpace('t2') }), false)
  assert.equal(avatars.customAvatarResponseIsCurrent({ ...request, sheetOpen: () => false }, state), false)
  assert.equal(avatars.customAvatarResponseIsCurrent(request, { ...state, skill: undefined }), false)
  assert.equal(avatars.customAvatarResponseIsCurrent(request, { ...state, skill: { id: 'managed', avatarAccountUserId: 'other' } }), false)
})

type Sent = { url: string; method: string; body: Record<string, unknown> | null }
let spaceSeq = 0
async function withBridge(respond: (sent: Sent) => Promise<Response>, run: (sent: Sent[], cached: unknown[], space: SpaceHandle) => Promise<void>): Promise<void> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = serverFixture.fetch
  const sent: Sent[] = []
  const cached: unknown[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown>): Promise<unknown> => {
      if (['current_space', 'server_request', 'cancel_server_request'].includes(command)) return serverFixture.invoke(command, args)
      if (command === 'cache_skill_avatar') { cached.push(args); return undefined }
      if (command === 'ensure_skill_avatar_identity') return 'device-id'
      throw new Error(`Unexpected native command: ${command}`)
    } },
  } })
  serverFixture.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const request = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null }
    sent.push(request)
    return respond(request)
  }) as typeof fetch
  const space = fixtureSpace(`fixture.jwt.custom.${++spaceSeq}`)
  setSpace(space)
  useStore.setState({ currentUser: { id: 'owner', email: 'owner@example.invalid', displayName: 'Owner' } as never, skills: [{ ...ownLocal }] })
  try { await run(sent, cached, space) } finally {
    serverFixture.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  }
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const image = { mimeType: 'image/webp' as const, dataBase64: 'UklGRg==' }
const CUSTOM_URL = 'https://picem-media.whatonearth.work/public/app/ast/custom.webp'

test('upload sends exactly the avatar registration plus the image, then updates the store and the account cache', async () => {
  await withBridge(async () => json({ localSkillId: 'entry-id', skillId: null, avatarUrl: CUSTOM_URL, avatarStatus: 'ready', avatarSource: 'custom' }), async (sent, cached, space) => {
    const outcome = await avatars.uploadCustomSkillAvatar(ownLocal, image, 'owner', space, () => true)
    assert.equal(outcome.status, 'applied')
    assert.equal(sent.length, 1)
    assert.match(sent[0]!.url, /\/skill-avatars\/local\/custom$/)
    assert.equal(sent[0]!.method, 'POST')
    const { image: sentImage, ...registration } = sent[0]!.body!
    assert.deepEqual(sentImage, image)
    const expected = avatars.avatarRegistration(ownLocal, { stableId: 'entry-id', aliasLocalIds: ['device-id'] })
    // Same fields and values as the ensure body (JSON drops the absent skillId).
    assert.deepEqual(registration, JSON.parse(JSON.stringify(expected)))
    assert.deepEqual(cached, [{ space, skillId: 'managed', accountUserId: 'owner', avatarUrl: CUSTOM_URL, avatarStatus: 'ready' }])
    assert.deepEqual(useStore.getState().skills[0], { ...ownLocal, avatarUrl: CUSTOM_URL, avatarStatus: 'ready', avatarSource: 'custom', avatarAccountUserId: 'owner' })
  })
  // The ensure call in the avatar pass is built by the same function.
  assert.match(source('src/lib/skill-avatars.ts'), /avatar = await apiEnsureSkillAvatar\(avatarRegistration\(skill, identity\), space, signal\)/)
})

test('a response that arrives after an account switch or after the sheet closed is dropped', async () => {
  let release: (response: Response) => void = () => undefined
  await withBridge(() => new Promise<Response>((done) => { release = done }), async (_sent, cached, space) => {
    const pending = avatars.uploadCustomSkillAvatar(ownLocal, image, 'owner', space, () => true)
    await new Promise((done) => setImmediate(done))
    useStore.setState({ currentUser: { id: 'other', email: 'other@example.invalid', displayName: 'Other' } as never })
    release(json({ avatarUrl: CUSTOM_URL, avatarStatus: 'ready', avatarSource: 'custom' }))
    assert.deepEqual(await pending, { status: 'stale' })
    assert.deepEqual(cached, [])
    assert.equal(useStore.getState().skills[0]?.avatarUrl, undefined)
  })
  let open = true
  await withBridge(() => new Promise<Response>((done) => { release = done }), async (_sent, cached, space) => {
    const pending = avatars.uploadCustomSkillAvatar(ownLocal, image, 'owner', space, () => open)
    await new Promise((done) => setImmediate(done))
    open = false
    release(json({ avatarUrl: CUSTOM_URL, avatarStatus: 'ready', avatarSource: 'custom' }))
    assert.deepEqual(await pending, { status: 'stale' })
    assert.deepEqual(cached, [])
  })
})

test('restore keeps the custom image when the quota is full, and words each failure for the user', async () => {
  const custom = { ...ownLocal, avatarUrl: CUSTOM_URL, avatarStatus: 'ready', avatarSource: 'custom' as const }
  await withBridge(async () => json({ error: '头像生成额度已达上限，请稍后重试', code: 'AVATAR_DAILY_QUOTA' }, 429, { 'retry-after': '3600' }), async (sent, _cached, space) => {
    useStore.setState({ skills: [custom] })
    await assert.rejects(avatars.restoreGeneratedSkillAvatar(custom, 'owner', space, () => true), (error: unknown) => {
      assert.equal(avatars.customAvatarErrorMessage(error, 'restore'), '暂时无法恢复默认头像，请稍后再试；当前头像已保留')
      return true
    })
    assert.match(sent[0]!.url, /\/skill-avatars\/local\/entry-id\/custom$/)
    assert.equal(sent[0]!.method, 'DELETE')
    assert.deepEqual(useStore.getState().skills[0], custom)
  })
  const rate = new ApiError('http', '上传过于频繁', { status: 429, code: 'AVATAR_CUSTOM_RATE_LIMITED', retryAfterSeconds: 42 })
  assert.equal(avatars.customAvatarErrorMessage(rate, 'upload'), '上传过于频繁，42 秒后再试')
  assert.equal(avatars.customAvatarErrorMessage(new ApiError('http', 'x', { status: 503 }), 'upload'), '头像服务暂时不可用，请稍后重试')
  assert.equal(avatars.customAvatarErrorMessage(new ApiError('network', 'fetch failed'), 'upload'), '头像服务暂时不可用，请稍后重试')
  assert.equal(avatars.customAvatarErrorMessage(new ApiError('http', 'x', { status: 400, code: 'AVATAR_IMAGE_DIMENSIONS' }), 'upload'), '图片太小，至少 256×256')
  const sheet = source('src/components/SkillDetailSheet.tsx')
  assert.match(sheet, /<span>自定义头像<\/span>/)
  assert.match(sheet, />恢复默认头像<\/button>/)
  assert.doesNotMatch(sheet, /生成额度|头像生成中|头像生成失败/)
})

test('pick_avatar_source is the only new native command and is registered with a typed wrapper', () => {
  assert.match(source('src/lib/tauri.ts'), /invoke<AvatarSource \| null>\('pick_avatar_source'\)/)
  assert.match(source('src-tauri/src/lib.rs'), /avatar_upload::pick_avatar_source,/)
  const rust = source('src-tauri/src/avatar_upload.rs')
  assert.match(rust, /const MAX_AVATAR_SOURCE_BYTES: u64 = 10 \* 1024 \* 1024;/)
  assert.match(rust, /read_avatar_file_limited\(path, MAX_AVATAR_SOURCE_BYTES\)/)
})

function setSpace(space: SpaceHandle): void { useStore.setState({ authSpace: space }); serverFixture.space = space }
