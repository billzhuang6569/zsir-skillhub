import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test, { beforeEach, afterEach } from 'node:test'
import ts from 'typescript'
import { apiGetSkill } from '../src/lib/api.ts'
import { restoreNativeAuth } from '../src/lib/auth-restore.ts'
import { cancelServerRequest, clearNativeAuthSession, serverRequest, type AuthState, type ServerRequest } from '../src/lib/tauri.ts'

const state: AuthState = { spaceId: 'official', generation: 7, userId: 'user', pending: false, error: '' }
const handle = { spaceId: state.spaceId, generation: state.generation }
let calls: { command: string; args: Record<string, unknown> }[] = []
let originalWindow: PropertyDescriptor | undefined
beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  calls = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      calls.push({ command, args })
      if (command === 'auth_state' || command === 'current_space') return state
      if (command === 'clear_auth_session') return null
      if (command === 'cancel_server_request') return true
      assert.equal(command, 'server_request')
      return { status: 200, headers: {}, body: { kind: 'json', value: { user: { id: 'user' } } } }
    } },
  } })
})
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

function assertSpacePayload(space: unknown): void {
  assert.ok(space && typeof space === 'object')
  assert.deepEqual(Object.keys(space).sort(), ['generation', 'spaceId'])
  assert.deepEqual(space, handle)
  assert.notEqual(space, state)
}

test('startup restore sends only the SpaceHandle fields to the actual invoke boundary', async () => {
  assert.equal((await restoreNativeAuth())?.user.id, 'user')
  const requests = calls.filter(call => call.command === 'server_request')
  assert.equal(requests.length, 1)
  const request = requests[0].args.request as ServerRequest
  assert.equal(request.route, 'auth.me')
  assertSpacePayload(request.space)
})

test('normal API calls strip AuthState extras from explicit and default spaces', async () => {
  await apiGetSkill('skill', state)
  await apiGetSkill('skill')
  const requests = calls.filter(call => call.command === 'server_request')
  assert.equal(requests.length, 2)
  for (const { args } of requests) assertSpacePayload((args.request as ServerRequest).space)
  assert.deepEqual(Object.keys(state).sort(), ['error', 'generation', 'pending', 'spaceId', 'userId'])
})

test('direct request, cancellation and session clearing sanitize SpaceHandle at IPC', async () => {
  await serverRequest({ requestId: 'request', space: state, route: 'health' })
  await cancelServerRequest(state, 'request')
  await clearNativeAuthSession(state)
  assert.deepEqual(calls.map(call => call.command), ['server_request', 'cancel_server_request', 'clear_auth_session'])
  for (const { command, args } of calls) {
    assertSpacePayload(command === 'server_request' ? (args.request as ServerRequest).space : args.space)
  }
  assert.equal(calls[1].args.requestId, 'request')
})

test('#430 invoke keys match Rust command parameters with Tauri camelCase mapping', () => {
  const commands = new Set([
    'auth_state', 'current_space', 'clear_auth_session', 'import_legacy_auth',
    'start_yitan_portal_auth', 'cancel_yitan_portal_auth', 'pick_and_upload_avatar',
    'cache_skill_avatar', 'get_skill_env_source_policy', 'provide_personal_env_to_team',
    'list_team_keys', 'put_team_key', 'delete_team_key', 'set_team_key_exclusion',
    'set_team_key_aliases', 'team_key_usage', 'server_request', 'cancel_server_request',
  ])
  const signatures = new Map<string, string[]>()
  for (const file of readdirSync('src-tauri/src').filter(file => file.endsWith('.rs'))) {
    const rust = readFileSync(`src-tauri/src/${file}`, 'utf8')
    for (const match of rust.matchAll(/#\[tauri::command\]\s+pub(?:\([^)]*\))?\s+(?:async\s+)?fn\s+(\w+)\((.*?)\)\s*->/gs)) {
      const [, command, parameters] = match
      if (!commands.has(command)) continue
      const keys: string[] = []
      // These scoped signatures have one named parameter per line; fail on unsupported syntax.
      for (const line of parameters.split('\n').map(line => line.trim()).filter(Boolean)) {
        const parameter = line.match(/^(\w+): (.+),$/)
        assert.ok(parameter, `Unparsed Rust parameter: ${command}: ${line}`)
        const [, name, type] = parameter
        if (/^(?:tauri::)?(?:State<|AppHandle\b)/.test(type)) continue
        keys.push(name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()))
      }
      signatures.set(command, keys.sort())
    }
  }
  assert.deepEqual([...signatures.keys()].sort(), [...commands].sort())
  const checked = new Set<string>()
  for (const file of readdirSync('src/lib').filter(file => file.endsWith('.ts'))) {
    const source = ts.createSourceFile(file, readFileSync(`src/lib/${file}`, 'utf8'), ts.ScriptTarget.Latest, true)
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'invoke') {
        const command = node.arguments[0]
        if (command && ts.isStringLiteral(command) && commands.has(command.text)) {
          const payload = node.arguments[1]
          const keys: string[] = []
          if (payload) {
            assert.ok(ts.isObjectLiteralExpression(payload), `${command.text}: explicit argument object required`)
            for (const property of payload.properties) {
              assert.ok(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
              assert.ok(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
              keys.push(property.name.text)
            }
          }
          assert.deepEqual(keys.sort(), signatures.get(command.text), `${file}: ${command.text}`)
          checked.add(command.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  assert.deepEqual([...checked].sort(), [...commands].sort())
})
