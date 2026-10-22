// #251: Desktop (Rust `include_str!`) and Server (TypeScript import) run the
// same env detection rule table. The Server keeps a checked-in copy because its
// build only compiles server/src; the two files must stay byte-identical.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const desktop = new URL('../desktop/src-tauri/env-detect-rules.json', import.meta.url)
const server = new URL('../server/src/lib/env-detect-rules.json', import.meta.url)

test('env detection rule tables are byte-identical on Desktop and Server', () => {
  const desktopBytes = readFileSync(desktop)
  assert.ok(desktopBytes.length > 0)
  assert.ok(
    desktopBytes.equals(readFileSync(server)),
    'server/src/lib/env-detect-rules.json differs; copy desktop/src-tauri/env-detect-rules.json over it'
  )
  const rules = JSON.parse(desktopBytes.toString('utf8'))
  assert.ok(Array.isArray(rules.sdkCatalog) && rules.sdkCatalog.length > 0)
  assert.ok(Array.isArray(rules.patterns.common) && rules.patterns.common.length > 0)
})
