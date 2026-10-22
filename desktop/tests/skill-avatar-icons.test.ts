import { serverFixture } from './helpers/server-ipc.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { mayGenerateSkillAvatar, skillForAvatarAccount } from '../src/lib/skills.ts'
import { apiEnsureSkillAvatar, apiGetSkillAvatars } from '../src/lib/api.ts'
import type { LocalSkill } from '../src/store/index.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const local = { id: 'managed-id', localPath: '/managed/id', isOwn: true, acquisitionSource: 'local',
  avatarLocalId: 'stable-uuid', avatarUrl: 'https://picem-media.whatonearth.work/avatar.jpg',
  avatarAccountUserId: 'owner', sharedTo: {}, labels: [], versions: [] } as LocalSkill

test('only managed local assets or currently proved cloud ownership may generate an avatar', () => {
  assert.equal(mayGenerateSkillAvatar(local, 'owner'), true)
  assert.equal(mayGenerateSkillAvatar({ ...local, localPath: '' }, 'owner'), false)
  assert.equal(mayGenerateSkillAvatar({ ...local, isOwn: false, acquisitionSource: 'team', teamSharedFrom: 'team' }, 'owner'), false)
  assert.equal(mayGenerateSkillAvatar({ ...local, id: 'market:cloud', acquisitionSource: 'marketplace' }, 'owner'), false)
  const cloud = { ...local, serverId: 'cloud', serverOwnerId: 'owner', serverAccessValidatedForUserId: 'owner' }
  assert.equal(mayGenerateSkillAvatar(cloud, 'owner'), true)
  assert.equal(mayGenerateSkillAvatar(cloud, 'other'), false)
  assert.equal(mayGenerateSkillAvatar({ ...cloud, serverAccessValidatedForUserId: undefined }, 'owner'), false)
})

test('switching accounts clears an old avatar while preserving local identity', () => {
  assert.equal(skillForAvatarAccount(local, 'owner').avatarUrl, local.avatarUrl)
  const switched = skillForAvatarAccount(local, 'other')
  assert.equal(switched.avatarUrl, null)
  assert.equal(switched.avatarLocalId, 'stable-uuid')
  assert.equal(skillForAvatarAccount(local).avatarUrl, null)
})

test('APP and web retain safe images and a neutral broken-image fallback; APP task states stay silent', () => {
  for (const path of ['src/components/SkillAvatarIcon.tsx', '../landing-page/src/shared/SkillAvatarIcon.tsx']) {
    const component = readFileSync(resolve(desktopRoot, path), 'utf8')
    assert.match(component, /onError=/)
    assert.match(component, path.startsWith('src/') ? /useMediaUrl\(avatarUrl\)/ : /picem-media\.whatonearth\.work/)
    assert.match(component, /objectFit: 'cover'/)
    assert.doesNotMatch(component, /ICON_PATHS|LABEL_OPTIONS|CATEGORY_OPTIONS|dangerouslySetInnerHTML/)
  }
  const app = readFileSync(resolve(desktopRoot, 'src/components/SkillAvatarIcon.tsx'), 'utf8')
  assert.doesNotMatch(app, /skill-avatar-flag|avatarStatusLabel|aria-label=|title=/)
})

test('account transition aborts avatar requests without replacing their pinned Bearer token', async () => {
  const original = serverFixture.fetch
  const controller = new AbortController()
  serverFixture.fetch = ((_url: unknown, options: RequestInit): Promise<Response> => {
    assert.equal((options.headers as Record<string, string>).Authorization, 'Bearer old-account-token')
    return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
  }) as typeof fetch
  try {
    const pending = apiGetSkillAvatars('old-account-token', controller.signal)
    controller.abort()
    await assert.rejects(pending)
  } finally { serverFixture.fetch = original }
})

test('native null cloud bindings are omitted from local avatar requests and valid bindings are preserved', async () => {
  const original = serverFixture.fetch
  const localSkillId = '5c5ee6cb-3b0c-4bcb-8b0b-7788fa8a3a22'
  const cloudSkillId = '9b2d0d85-89e2-4aa9-b8c3-2b6736c944cf'
  const payloads: Record<string, unknown>[] = []
  serverFixture.fetch = ((_url: unknown, options: RequestInit): Promise<Response> => {
    payloads.push(JSON.parse(options.body as string) as Record<string, unknown>)
    assert.equal((options.headers as Record<string, string>).Authorization, 'Bearer native.fixture')
    return Promise.resolve(new Response(JSON.stringify({ avatarUrl: null, avatarStatus: 'pending' })))
  }) as typeof fetch
  try {
    for (const skillId of [null, cloudSkillId]) {
      await apiEnsureSkillAvatar({ localSkillId, skillId, name: 'Local Skill', description: 'A local Skill', scenarios: [] },
        serverFixture.space, new AbortController().signal)
    }
    assert.equal(Object.hasOwn(payloads[0]!, 'skillId'), false)
    assert.equal(payloads[0]!.localSkillId, localSkillId)
    assert.equal(payloads[1]!.skillId, cloudSkillId)
  } finally { serverFixture.fetch = original }
})
