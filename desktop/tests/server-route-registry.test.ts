import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import routes from '../src/lib/server-routes.json' with { type: 'json' }
import { resolveServerRoute, type ServerRouteDefinition } from '../src/lib/server-routes.ts'

const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true)

test('only feedback and install-intent writes accept optional login', () => {
  const optional = Object.entries(routes).filter(([, definition]: [string, ServerRouteDefinition]) => definition.optional)
  assert.deepEqual(optional.map(([id]) => id).sort(), [
    'feedback.create', 'marketplace.install-intents.create', 'marketplace.install-intents.update',
  ])
  for (const [, definition] of optional) assert.equal(definition.auth, false)
  assert.equal(routes['auth.me'].auth, true)
  assert.equal(routes.health.auth, false)
})

// Extract every endpoint from the actual call expressions, including both comment visibilities.
function paths(node: ts.Expression): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isConditionalExpression(node)) return [...paths(node.whenTrue), ...paths(node.whenFalse)]
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text
    for (const span of node.templateSpans) {
      if (value.includes('?')) break
      // Feedback's optional query suffix is not a path parameter.
      value += ts.isConditionalExpression(span.expression) ? '' : 'fixture'
      value += span.literal.text
    }
    return [value.split('?')[0]]
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return paths(node.left).flatMap(left => paths(node.right).map(right => left + right))
  }
  if (ts.isCallExpression(node)) {
    if (node.expression.getText(ast) === 'marketplaceCatalogPath') return ['/marketplace']
    if (node.expression.getText(ast) === 'encodeURIComponent') return ['fixture']
  }
  throw new Error(`Unhandled endpoint expression: ${node.getText(ast)}`)
}

test('every API call is registered with its method/path and every registry entry has a caller', () => {
  const reached = new Set<string>()
  let count = 0
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ['apiFetch', 'apiResponse'].includes(node.expression.getText(ast))
      && node.getStart(ast) > source.indexOf('export type ApiTeam')) {
      const method = node.arguments[1]?.getText(ast).match(/method: '(\w+)'/)?.[1] ?? 'GET'
      for (const path of paths(node.arguments[0])) {
        const full = node.expression.getText(ast) === 'apiFetch' ? `/api${path}` : path
        const resolved = resolveServerRoute(full, method)
        assert.equal(routes[resolved.route].method, method)
        assert.equal(routes[resolved.route].path.replace(/:\w+/g, 'fixture'), full)
        reached.add(resolved.route)
        count++
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(count, 121) // Includes authenticated instance bases for team Skill links.
  // Lease bodies are native-only; count their actual Rust callers, never add a
  // WebView API merely to satisfy this reachability check.
  const worker = readFileSync(new URL('../src-tauri/src/local_inference/worker.rs', import.meta.url), 'utf8')
  for (const match of worker.matchAll(/\.request\(\s*"(localAi\.[^"]+)"/g)) reached.add(match[1])
  assert.deepEqual([...reached].sort(), Object.keys(routes).sort())
})

test('path params round-trip once and query keys are allowlisted', () => {
  for (const value of ['../', '/', '?', '#', 'a b', '%2F']) {
    const result = resolveServerRoute(`/api/skills/${encodeURIComponent(value)}`, 'GET')
    assert.equal(result.route, 'skills.get')
    assert.deepEqual(result.params, { skillId: value })
  }
  assert.equal(resolveServerRoute('/api/skills/trash', 'GET').route, 'skills.trash')
  assert.deepEqual(resolveServerRoute('/api/teams/id/activity?limit=5&before=a%20%2F%3F', 'GET').query, { limit: '5', before: 'a /?' })
  for (const path of ['https://evil.test/api/skills', '/api/unknown', '/api/skills?url=https://evil.test']) {
    assert.throws(() => resolveServerRoute(path, 'GET'))
  }
})

test('instance and analysis registry entries match actual Server routes', () => {
  const registered = new Set<string>()
  for (const [file, prefix] of [['instance.ts', '/api/instance'], ['instance-ai.ts', '/api/instance/settings'], ['instance-fal.ts', '/api/instance/settings'], ['ai-batches.ts', '/api/skills/analysis/batches']]) {
    const serverSource = readFileSync(new URL(`../../server/src/routes/${file}`, import.meta.url), 'utf8')
    for (const match of serverSource.matchAll(/fastify\.(get|post|put|delete)\('([^']+)'/g)) {
      const base = match[2] === '/ai/status' ? '/api/instance' : prefix
      registered.add(`${match[1].toUpperCase()} ${base}${match[2] === '/' ? '' : match[2]}`)
    }
  }
  for (const [id, route] of Object.entries(routes)) if (id.startsWith('instance.') || id.startsWith('analysis.')) {
    assert.ok(registered.has(`${route.method} ${route.path}`), id)
    assert.equal(route.auth, true)
    assert.deepEqual((route as ServerRouteDefinition).profiles, id === 'instance.base-urls' ? undefined : ['selfhost'])
  }
})

test('avatar style routes match Server handlers and profile/auth contracts', () => {
  const serverSource = readFileSync(new URL('../../server/src/routes/skill-avatars.ts', import.meta.url), 'utf8')
  for (const [id, suffix, method] of [['get', '', 'GET'], ['preview', '/preview', 'POST'], ['apply', '/apply', 'POST']]) {
    const route = (routes as Record<string, ServerRouteDefinition>)[`skill-avatars.style.${id}`]
    assert.equal(route.path, `/api/skill-avatars/style${suffix}`); assert.equal(route.method, method)
    assert.equal(route.auth, true); assert.deepEqual(route.profiles, ['official', 'selfhost'])
    assert.ok(serverSource.includes(`fastify.${method.toLowerCase()}('/style${suffix}'`))
  }
  assert.equal(routes['avatar-styles.list'].auth, false)
  assert.deepEqual(routes['avatar-styles.list'].profiles, ['official', 'selfhost'])
  assert.equal(routes['avatar-styles.list'].path, '/api/avatar-styles')
})

test('frontend has no HTTP transport; CSP only allows IPC', () => {
  let fetches = 0
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'fetch') {
      fetches++
      let ancestor: ts.Node | undefined = node.parent
      while (ancestor && !(ts.isIfStatement(ancestor) && ancestor.expression.getText(ast).includes('import.meta.env?.DEV'))) ancestor = ancestor.parent
      assert.ok(ancestor, 'fetch must be lexically guarded by import.meta.env.DEV')
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(fetches, 0)
  function checkDirectory(url: URL): void {
    for (const item of readdirSync(url, { withFileTypes: true })) {
      const child = new URL(item.name, url)
      if (item.isDirectory()) checkDirectory(new URL(`${item.name}/`, url))
      else if (/\.tsx?$/.test(item.name)) {
        const text = readFileSync(child, 'utf8')
        assert.doesNotMatch(text, /XMLHttpRequest|EventSource|WebSocket/)
        if (child.pathname !== new URL('../src/lib/api.ts', import.meta.url).pathname) assert.doesNotMatch(text, /\bfetch\s*\(/)
      }
    }
  }
  checkDirectory(new URL('../src/', import.meta.url))
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as { app: { security: { csp: string } } }
  assert.equal(config.app.security.csp.split(';').find(part => part.trim().startsWith('connect-src'))?.trim(), "connect-src 'self' ipc: http://ipc.localhost")
  assert.equal(config.app.security.csp.split(';').find(part => part.trim().startsWith('img-src'))?.trim(),
    "img-src 'self' data: asset: http://asset.localhost skillhub-media: http://skillhub-media.localhost")
})
