import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createTeamSkillBaseUrlsCache, isTeamSkillServer, parseTeamSkillLink, teamSkillAppLink } from '../src/lib/team-skill-link.ts'
import { teamSkillMenuState } from '../src/lib/team-skill-menu.ts'
import { acquireTeamSkill } from '../src/lib/team-skill-acquisition.ts'
import { ApiError, apiGetTeamSkillLink } from '../src/lib/api.ts'
import type { LocalSkill } from '../src/store/index.ts'
import type { ServerRequest } from '../src/lib/tauri.ts'

const team = '11111111-1111-4111-8111-111111111111'
const id = '22222222-2222-4222-8222-222222222222'
const space = { spaceId: 'official', generation: 1 }
const remote = { id, serverId: id, serverOwnerId: 'author', name: 'english-skill', displayName: '中文名',
  version: '1.0.0', latestVersion: '1.0.0', labels: [], compatibleAgents: [], envDeps: [], installCount: 0,
  agents: {}, sources: [], sharedTo: { [team]: { version: '1.0.0', envShared: false } }, isOwn: false,
} as LocalSkill
const calls: string[] = []
let failDownload = false
Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
  invoke: async (command: string, args: { value: string; request: ServerRequest; data: Record<string, unknown>; space: unknown }): Promise<unknown> => {
    calls.push(command)
    if (command === 'normalize_invite_server') {
      const url = new URL(args.value)
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || args.value.includes('%')) throw new Error('invalid')
      return url.href.replace(/\/+$/, '')
    }
    if (command === 'current_space') return space
    if (command === 'server_request') {
      assert.deepEqual(args.request.space, space)
      if (args.request.route === 'teams.skill-link') return { status: 200, body: { kind: 'json', value: { landingPageUrl: 'https://instance.test/link' } } }
      assert.equal(args.request.route, 'skills.package')
      if (failDownload) throw new Error('offline')
      return { status: 200, headers: { 'x-checksum-sha256': 'test-hash', 'x-skill-version': '1.0.0' }, body: { kind: 'bytes', value: [1, 2, 3] } }
    }
    assert.equal(command, 'import_skill_package')
    assert.deepEqual(args.space, space)
    assert.equal(args.data.acquisitionSource, 'team')
    assert.equal(args.data.teamId, team)
    assert.deepEqual(args.data.teamIds, [team])
    assert.equal(args.data.acquiredByUserId, 'member')
    assert.equal(args.data.isOwn, false)
    assert.equal('agents' in args.data, false)
    return { ...remote, id: 'managed', acquisitionSource: 'team', localPath: '/fixture/managed', agents: {}, hasWorkingCopy: false }
  },
} } })

test('strict team link parsing accepts IDs and normalized instance only', async () => {
  const link = teamSkillAppLink(team, id, 'https://INSTANCE.test:443/base/')
  assert.deepEqual(await parseTeamSkillLink(link), { teamId: team, skillId: id, server: 'https://instance.test/base' })
  assert.equal(await parseTeamSkillLink(link.replace(`/${id}?`, `/x/../${id}?`)), null)
  assert.equal(await parseTeamSkillLink(`${link}&`), null)
  assert.equal(await parseTeamSkillLink(link.replace('?server=', '?&server=')), null)
  const uppercase = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
  assert.equal((await parseTeamSkillLink(teamSkillAppLink(uppercase, id, 'https://instance.test')))?.teamId, uppercase.toLowerCase())
  for (const invalid of [link.replace('team-skill', 'other'), link.replace(team, 'no-uuid'), `${link}&other=1`, `${link}&server=https://x.test`, `${link}#`, link.replace('team-skill/', 'user@team-skill/'), link.replace('team-skill/', 'team-skill:99/'), link.replace(`/${id}?`, `/${id}/?`), `${link}${'x'.repeat(4096)}`, `skillhub://team-skill/${team}/${id}`, teamSkillAppLink(team, id, 'https://user:pass@instance.test')]) {
    assert.equal(await parseTeamSkillLink(invalid), null, invalid)
  }
})

test('team menu requires acquisition for local actions and only author can unshare', () => {
  assert.deepEqual(teamSkillMenuState(remote, 'member', true), { joined: false, openFolder: false, quickAccess: false, acquire: true, unshareVisible: false, unshareEnabled: true })
  const local = { ...remote, localPath: '/fixture', serverOwnerId: 'member' }
  assert.equal(teamSkillMenuState(local, 'member', true).unshareVisible, true)
  assert.equal(teamSkillMenuState(local, 'member', true).acquire, false)
  assert.equal(teamSkillMenuState(local, 'member', true).quickAccess, true)
  assert.equal(teamSkillMenuState(local, 'member', false).unshareEnabled, false)
  assert.equal(teamSkillMenuState(remote, 'member', false).acquire, false)
  assert.equal(teamSkillMenuState({ ...remote, libraryEntryId: 'entry', libraryAccountId: 'member' }, 'member', true).joined, true)
})

test('team acquisition imports without any Agent command, retains provenance and is repeatable', async () => {
  calls.length = 0
  const local = await acquireTeamSkill({ ...remote, sharedTo: { ...remote.sharedTo, unrelated: { version: '1.0.0', envShared: false } } }, 'member', team, space)
  assert.deepEqual(local.agents, {})
  assert.equal(local.teamSharedFrom, team)
  assert.equal(local.acquisitionSource, 'team')
  assert.equal(local.isOwn, false)
  const count = calls.length
  assert.equal(await acquireTeamSkill(local, 'member', team, space), local)
  assert.equal(calls.length, count)
  assert.ok(calls.every(command => ['current_space', 'server_request', 'import_skill_package'].includes(command)))
  failDownload = true
  await assert.rejects(acquireTeamSkill(remote, 'member', team, space), /offline/)
  failDownload = false
})

test('share endpoint is allowlisted and binds the captured space', async () => {
  assert.deepEqual(await apiGetTeamSkillLink(team, id, space), { landingPageUrl: 'https://instance.test/link' })
})

test('team navigation waits for its own refresh, and login resumes the pending link', () => {
  const page = readFileSync(new URL('../src/pages/TeamSharedPage.tsx', import.meta.url), 'utf8')
  assert.match(page, /const navigation = useStore.getState\(\).pendingCommentNavigation/)
  assert.match(page, /setLoadedNavigation\(navigation\)/)
  assert.match(page, /\[activeTeamId, pendingCommentNavigation, loadTeamLibrary\]/)
  assert.match(page, /loadedNavigation !== pendingCommentNavigation/)
  assert.match(page, /sharedIdsByTeam\[activeTeamId\]\?\.has/)
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const effect = app.slice(app.indexOf('const [pendingTeamSkillLink'), app.indexOf('const considerDeepLink'))
  assert.ok(effect.indexOf('await isTeamSkillServer') < effect.indexOf('await apiGetTeamSkillLink'))
  const signedOut = effect.slice(effect.indexOf('if (!currentUser)'), effect.indexOf('const context ='))
  assert.match(signedOut, /promptForAuth/)
  assert.doesNotMatch(signedOut, /setPendingTeamSkillLink/)
  assert.match(effect, /authStatus, currentUser/)
  assert.doesNotMatch(effect, /switchSpace|testSpaceConnection/)
  assert.ok(effect.indexOf('if (!currentUser)') < effect.indexOf('teamSkillBaseUrls.get('))
  assert.doesNotMatch(effect, /serverInfo\??\.baseUrls/)
})

test('instance bases cache belongs only to the current account and space generation', async () => {
  let requests = 0
  const cache = createTeamSkillBaseUrlsCache(async () => { requests++; return { baseUrls: ['https://instance.test'] } })
  assert.equal(await cache.get(space, null, true), undefined)
  assert.equal(await cache.get(space, 'member', false), undefined)
  assert.equal(requests, 0)
  await Promise.all([cache.get(space, 'member', true), cache.get(space, 'member', true)])
  assert.equal(requests, 1)
  await cache.get(space, 'another-member', true)
  await cache.get({ ...space, generation: 2 }, 'another-member', true)
  await cache.get({ ...space, spaceId: 'another-instance' }, 'another-member', true)
  assert.equal(requests, 4)
  cache.clear()
  await cache.get(space, 'member', true)
  assert.equal(requests, 5)
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /teamSkillBaseUrls.clear\(\)[^\n]*activeSpace\?\.spaceId, activeSpace\?\.generation, currentUser\?\.id, spacePending/)
})

test('missing capability or 404 falls back to current connection only; other failures are not hidden', async () => {
  const cache = createTeamSkillBaseUrlsCache(async () => { throw new ApiError('http', 'Not Found', { status: 404 }) })
  const bases = await cache.get(space, 'member', true)
  assert.equal(bases, undefined)
  assert.equal(await isTeamSkillServer('https://current.test', 'https://current.test', bases), true)
  assert.equal(await isTeamSkillServer('https://other.test', 'https://current.test', bases), false)
  const denied = createTeamSkillBaseUrlsCache(async () => { throw new ApiError('http', 'Unauthorized', { status: 401 }) })
  await assert.rejects(denied.get(space, 'member', true), /Unauthorized/)
})

test('a late response from a cleared login cannot replace the new account cache', async () => {
  let resolveOld!: (value: { baseUrls: string[] }) => void
  let requests = 0
  const cache = createTeamSkillBaseUrlsCache(async () => {
    requests++
    if (requests === 1) return new Promise(resolve => { resolveOld = resolve })
    return { baseUrls: ['https://new.test'] }
  })
  const old = cache.get(space, 'old-member', true)
  cache.clear()
  assert.deepEqual(await cache.get(space, 'new-member', true), ['https://new.test'])
  resolveOld({ baseUrls: ['https://old.test'] })
  await old
  assert.deepEqual(await cache.get(space, 'new-member', true), ['https://new.test'])
  assert.equal(requests, 2)
})

test('current Server declarations accept aliases exactly and never infer sibling hosts or paths', async () => {
  const declared = ['https://PUBLIC.test:443/Case/', 'https://tailnet.test/Case']
  assert.equal(await isTeamSkillServer('https://public.test/Case', 'https://tailnet.test/Case', declared), true)
  assert.equal(await isTeamSkillServer('https://tailnet.test/Case', 'https://public.test/Case', declared), true)
  for (const foreign of ['https://evil.test/Case', 'https://public.test/case', 'https://public.test/Case/extra', 'https://public.test.evil.test/Case']) {
    assert.equal(await isTeamSkillServer(foreign, 'https://tailnet.test/Case', declared), false)
  }
  assert.equal(await isTeamSkillServer('https://public.test/Case', 'https://tailnet.test/Case'), false)
  assert.equal(await isTeamSkillServer('https://tailnet.test/Case', 'https://TAILNET.test:443/Case/'), true)
  assert.equal(await isTeamSkillServer('https://evil.test', 'https://tailnet.test', ['https://user:pass@evil.test']), false)
})

test('both login cancellation paths discard pending links and invalidate asynchronous work', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /const cancelTeamSkillLogin = \(\): void => \{\s*updatePendingTeamSkillLink\(null\)\s*teamSkillLoginRequested.current = null\s*dismissAuthPrompt\(\)/)
  assert.match(app, /onClose=\{cancelTeamSkillLogin\}/)
  assert.match(app, /onClose=\{\(\) => \{\s*cancelTeamSkillLogin\(\)/)
  assert.match(app, /teamSkillLinkRef.current === pendingTeamSkillLink/)
  assert.match(app, /if \(teamSkillLoginRequested.current !== pendingTeamSkillLink\)/)
  assert.match(app, /teamSkillLinkRef.current = link\s*setPendingTeamSkillLink\(link\)/)
})
