import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DONATION_PAGE_URL } from '../src/lib/official-endpoints.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const notificationLib = readFileSync(resolve(root, 'src/lib/notification-center.ts'), 'utf8')
const notificationCenter = readFileSync(resolve(root, 'src/components/NotificationCenter.tsx'), 'utf8')
const app = readFileSync(resolve(root, 'src/App.tsx'), 'utf8')
const styles = readFileSync(resolve(root, 'src/components/Sidebar.css'), 'utf8')

test('invite joins show a named member and join requests have direct decisions', () => {
  assert.match(notificationLib, /team_member_joined: '新成员加入团队'/)
  assert.match(notificationLib, /\$\{memberName\} 通过邀请加入了「\$\{teamName\}」/)
  assert.match(notificationCenter, /apiApproveJoinRequest\(teamId, requestId, space\)/)
  assert.match(notificationCenter, /apiRejectJoinRequest\(teamId, requestId, space\)/)
  // Handling a request marks it read and refreshes the team list (#295).
  assert.match(notificationCenter, /apiMarkNotificationRead\(notification\.id, space\)\.catch\(\(\) => undefined\)[^]*apiGetTeams\(space\)/)
})

test('donation opens a fixed HTTPS page without login or private URL data', () => {
  const url = new URL(DONATION_PAGE_URL)
  assert.equal(url.protocol, 'https:')
  assert.equal(url.search, '')
  assert.equal(url.hash, '')
  assert.equal(url.username, '')
  assert.equal(url.password, '')
  assert.ok(url.pathname.endsWith('/'))
  const handler = app.match(/onDonate=\{\(\) => \{([^]*?)\}\}/)?.[1]
  assert.ok(handler)
  assert.match(handler, /openUrl\(DONATION_PAGE_URL\)/)
  assert.doesNotMatch(handler, /authStatus|promptForAuth|currentUser/)
  assert.match(styles, /prefers-reduced-motion: reduce/)
})
