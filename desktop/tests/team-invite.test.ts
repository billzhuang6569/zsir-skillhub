import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseTeamInvite, teamInviteDeepLink, teamInviteWebLink, isSameInviteServer, inviteSwitchTarget, isLoopbackInviteServer, resumePendingTeamInvite, PENDING_INVITE_KEY } from '../src/lib/team-invite.ts'
import { OFFICIAL_ENDPOINTS } from '../src/lib/official-endpoints.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const token = `shti1.${'a'.repeat(54)}.${'b'.repeat(27)}`
const inviteHelpers = readFileSync(resolve(desktopRoot, 'src/lib/team-invite.ts'), 'utf8')
const inviteDialog = readFileSync(resolve(desktopRoot, 'src/components/TeamInviteCreatorDialog.tsx'), 'utf8')
const teamsPage = readFileSync(resolve(desktopRoot, 'src/pages/TeamsPage.tsx'), 'utf8')

test('signed invitations normalize every instance address through Rust', () => {
  assert.match(inviteHelpers, /TOKEN_PATTERN = \/\^shti1/)
  assert.match(inviteHelpers, /\$\{DEEP_LINK_SCHEME\}:\/\/join-team\//)
  assert.match(inviteHelpers, /await normalizeInviteServer\(/)
  assert.match(readFileSync(resolve(desktopRoot, 'src/lib/tauri.ts'), 'utf8'), /invoke<string>\('normalize_invite_server', \{ value \}\)/)
  assert.doesNotMatch(inviteHelpers, /UUID_PATTERN/)
})

// IPC is the normalization boundary; Rust tests exercise the real URL policy.
Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
  invoke: async (command: string, args: { value: string }): Promise<string> => {
    assert.equal(command, 'normalize_invite_server')
    const url = new URL(args.value)
    if (url.username || url.password || url.search || url.hash || args.value.includes('%') || /\/\.\.(\/|$)/.test(args.value)
      || !['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('invalid base')
    return url.href.replace(/\/+$/, '')
  },
} } })

test('deep links support legacy official, encoded server, encoded token and selfhost clipboard web URLs', async () => {
  assert.equal((await parseTeamInvite(`skillhub://join-team/${token}`))?.server, OFFICIAL_ENDPOINTS.serverOrigin)
  const link = teamInviteDeepLink(token, 'https://EXAMPLE.test:443/base/')
  assert.deepEqual(await parseTeamInvite(link), { token, server: 'https://example.test/base', source: 'app-link' })
  assert.equal((await parseTeamInvite(link.replace('shti1.', 'shti1%2E')))?.token, token)
  assert.deepEqual(await parseTeamInvite(`复制此邀请：${teamInviteWebLink(token, 'http://127.0.0.1:3001/base')}。`), {
    token, server: 'http://127.0.0.1:3001/base', source: 'web-link',
  })
})

test('invalid addresses, duplicate servers and malformed token paths fail closed', async () => {
  for (const server of ['http://evil.test', 'https://user:pass@example.test', 'https://example.test/a/../b', 'https://example.test/%61', 'https://example.test?x=1', 'https://example.test#x', 'file:///tmp']) {
    assert.equal(await parseTeamInvite(teamInviteDeepLink(token, server)), null, server)
  }
  for (const tail of ['?server=', '?server=https://a.test&server=https://b.test', '?other=x', '#fragment']) {
    assert.equal(await parseTeamInvite(`skillhub://join-team/${token}${tail}`), null)
  }
  assert.equal(await parseTeamInvite(`skillhub://join-team/a/../${token}`), null)
  assert.equal(await parseTeamInvite('skillhub://join-team/bad-token'), null)
  assert.equal(await parseTeamInvite(`https://example.test/a/../invite/${token}`), null)
})

test('same-instance matching keeps path prefixes, previous origins and compiled official identity', () => {
  assert.equal(isSameInviteServer(OFFICIAL_ENDPOINTS.serverOrigin, 'official'), true)
  assert.equal(isSameInviteServer('https://elsewhere.test', 'official', 'https://elsewhere.test'), false)
  assert.equal(isSameInviteServer('https://self.test/base', 'selfhost', 'https://self.test/base/'), true)
  assert.equal(isSameInviteServer('https://self.test/other', 'selfhost', 'https://self.test/base'), false)
  assert.equal(isSameInviteServer('https://old.test/base', 'selfhost', 'https://new.test', ['https://old.test/base']), true)
  assert.equal(isSameInviteServer(OFFICIAL_ENDPOINTS.serverOrigin, 'local'), false)
  assert.equal(inviteSwitchTarget(OFFICIAL_ENDPOINTS.serverOrigin), 'official')
  assert.equal(inviteSwitchTarget('https://self.test'), 'https://self.test')
})

test('pending invite survives reload, waits for target login, accepts once and clears immediately', async () => {
  const data = new Map([[PENDING_INVITE_KEY, teamInviteDeepLink(token, 'https://target.test')]])
  const storage = { getItem: (key: string) => data.get(key) ?? null, removeItem: (key: string) => { data.delete(key) } }
  let calls = 0
  const accept = async (): Promise<boolean> => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return true }
  await resumePendingTeamInvite(storage, async () => false, accept)
  assert.equal(calls, 0)
  assert.equal(data.size, 1)
  await Promise.all([
    resumePendingTeamInvite(storage, async invite => invite.server === 'https://target.test', accept),
    resumePendingTeamInvite(storage, async () => true, accept),
  ])
  await resumePendingTeamInvite(storage, async () => true, accept)
  assert.equal(calls, 1)
  assert.equal(data.size, 0)
})

test('failed acceptance remains retryable and cancellation never starts a switch', async () => {
  const data = new Map([[PENDING_INVITE_KEY, teamInviteDeepLink(token)]])
  const storage = { getItem: (key: string) => data.get(key) ?? null, removeItem: (key: string) => { data.delete(key) } }
  await resumePendingTeamInvite(storage, async () => true, async () => false)
  assert.equal(data.size, 1)
  const app = readFileSync(resolve(desktopRoot, 'src/App.tsx'), 'utf8')
  assert.match(app, /onCancel=\{\(\) => setOtherServerInvite\(null\)\}/)
  assert.ok(app.indexOf('if (!await matchesInviteSpace(parsed))') < app.indexOf('const info = await apiGetTeamInvite'))
  assert.match(app, /sessionStorage.setItem\(PENDING_INVITE_KEY, teamInviteDeepLink\(invite.token, invite.server\)\)/)
  assert.match(app, /authStatus !== 'authenticated'[\s\S]*resumePendingTeamInvite/)
  const connect = readFileSync(resolve(desktopRoot, 'src/components/ConnectServerDialog.tsx'), 'utf8')
  assert.match(connect, /onConnected\?\.\(result\)[\s\S]*window.location.reload\(\)/)
  assert.match(connect, /readOnly=\{lockAddress\}/)
  assert.match(app, /if \(selfhostAuth \|\| inviteSwitch.current !== 'idle'\) return/)
  const guest = app.slice(app.indexOf("if (state.authStatus !== 'authenticated' || !state.currentUser)", app.indexOf('const acceptInviteToken')))
  assert.ok(guest.indexOf('sessionStorage.setItem(PENDING_INVITE_KEY') < guest.indexOf('promptForAuth({'))
  assert.match(app, /token => acceptInviteToken\(token, expectedSpace\)/)
  assert.match(app, /inviteSpace && !sameSpace\(inviteSpace, state.activeSpace\)/)
  assert.match(app, /error.status === 404 \|\| error.status === 410/)
})

test('invitation login carries its context into the connection dialog', () => {
  const app = readFileSync(resolve(desktopRoot, 'src/App.tsx'), 'utf8')
  assert.match(app, /setSelfhostAuth\(\{ target, report, teamInvite: true \}\)/)
  assert.match(app, /setSelfhostAuth\(\{ target: context.serverBase, report, teamInvite: Boolean\(sessionStorage.getItem\(PENDING_INVITE_KEY\)\) \}\)/)
  assert.match(app, /<ConnectServerDialog[^>]*teamInvite=\{selfhostAuth.teamInvite\}/)
})

test('a new-space resume waits for a stale attempt and then continues without another reload', async () => {
  const data = new Map([[PENDING_INVITE_KEY, teamInviteDeepLink(token, 'https://target.test')]])
  const storage = { getItem: (key: string) => data.get(key) ?? null, removeItem: (key: string) => { data.delete(key) } }
  let release!: (matches: boolean) => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const deferred = new Promise<boolean>(resolve => { release = resolve })
  let accepted = 0
  const stale = resumePendingTeamInvite(storage, async () => { started(); return deferred }, async () => { assert.fail('stale space must not accept') })
  await ready
  const current = resumePendingTeamInvite(storage, async () => true, async () => { accepted++; return true })
  release(false)
  await Promise.all([stale, current])
  assert.equal(accepted, 1)
  assert.equal(data.size, 0)
})

test('loopback warning is limited to selfhost and never disables invitations', () => {
  for (const base of ['http://localhost:3001', 'http://127.0.0.1:3001', 'http://127.2.3.4', 'https://[::1]', 'http://[::ffff:127.0.0.1]']) {
    assert.equal(isLoopbackInviteServer('selfhost', base), true)
    assert.equal(isLoopbackInviteServer('official', base), false)
  }
  assert.equal(isLoopbackInviteServer('selfhost', 'https://example.test'), false)
  assert.match(inviteDialog, /这个实例部署在你的电脑上，其他人无法访问。要邀请成员，请把实例部署到服务器。/)
  assert.match(inviteDialog, /查看部署文档 ↗/)
  assert.match(inviteDialog, /invite.landingPageUrl \?\? teamInviteWebLink/)
})

test('copyable invitation text keeps automatic and manual join paths together', () => {
  assert.match(inviteHelpers, /邀请你加入一探 SkillHub 团队/)
  assert.match(inviteHelpers, /teamInviteWebLink\(input\.token\)/)
  assert.match(inviteHelpers, /input\.teamId/)
  assert.equal(token.length < 100, true)
})

test('My Team offers a dedicated invitation dialog with team code before link creation', () => {
  // #295 board 8: 「邀请成员」 lives in the team detail header.
  const teamDetail = readFileSync(resolve(desktopRoot, 'src/components/TeamDetailSheet.tsx'), 'utf8')
  assert.match(teamDetail, />邀请成员<\/button>/)
  assert.match(teamDetail, /<TeamInviteCreatorDialog/)
  assert.match(teamsPage, />加入团队<\/button>/)
  assert.match(inviteDialog, /closeOnBackdrop/)
  assert.match(inviteDialog, /<span>团队码<\/span>/)
  assert.match(inviteDialog, />创建邀请链接</)
  const createStart = inviteDialog.indexOf('const createInvite = async')
  assert.ok(createStart >= 0)
  assert.match(inviteDialog.slice(createStart), /apiCreateTeamInvite\(teamId\)/)
})

test('desktop listens for deep links, scans the clipboard locally, and resumes after login', () => {
  const app = readFileSync(resolve(desktopRoot, 'src/App.tsx'), 'utf8')
  const store = readFileSync(resolve(desktopRoot, 'src/store/index.ts'), 'utf8')
  const rust = readFileSync(resolve(desktopRoot, 'src-tauri/src/app_links.rs'), 'utf8')
  const config = readFileSync(resolve(desktopRoot, 'src-tauri/tauri.conf.json'), 'utf8')

  assert.match(app, /listen<string\[\]>\('skillhub-deep-link'/)
  assert.match(app, /readClipboardText\(\)/)
  assert.match(app, /apiGetTeamInvite\(parsed\.token, expectedSpace\)/)
  assert.match(app, /apiAcceptTeamInvite\(token, expectedSpace\)/)
  assert.match(app, /intent\.kind === 'join-team'/)
  assert.match(store, /\{ kind: 'join-team'; token: string \}/)
  assert.match(rust, /use crate::official_channel::INVITE_PREFIX/)
  assert.match(rust, /MAX_CLIPBOARD_LENGTH/)
  assert.match(config, /"schemes": \["skillhub"\]/)
})

test('the clipboard invite poll never blocks the Windows UI thread (#223)', () => {
  const app = readFileSync(resolve(desktopRoot, 'src/App.tsx'), 'utf8')
  const bridge = readFileSync(resolve(desktopRoot, 'src/lib/tauri.ts'), 'utf8')
  const rust = readFileSync(resolve(desktopRoot, 'src-tauri/src/app_links.rs'), 'utf8')
  // Synchronous Tauri commands run on the main thread; a clipboard owner that stops
  // answering WM_RENDERFORMAT then freezes the window for 30 s every poll.
  assert.match(rust, /#\[tauri::command\]\npub async fn read_clipboard_text\(/)
  assert.match(rust, /spawn_blocking/)
  assert.match(rust, /GetClipboardSequenceNumber/)
  assert.match(rust, /CLIPBOARD_READ_TIMEOUT: Duration = Duration::from_secs\(3\)/)
  assert.match(bridge, /readClipboardText\(\): Promise<string \| null>/)
  assert.match(app, /value === null \|\| value === lastClipboardText\.current/)
})
