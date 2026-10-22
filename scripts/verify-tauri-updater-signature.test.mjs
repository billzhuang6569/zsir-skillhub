import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const verifier = fileURLToPath(new URL('./verify-tauri-updater-signature.mjs', import.meta.url))
const publicKeyText = `untrusted comment: minisign public key E7620F1842B4E81F
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3`
const signatureText = `untrusted comment: signature from minisign secret key
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=
trusted comment: timestamp:1556193335\tfile:test
y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==`
const encodedPublicKey = Buffer.from(publicKeyText, 'utf8').toString('base64')
const encodedSignature = Buffer.from(signatureText, 'utf8').toString('base64')

test('filters locked Cargo metadata to the validated Rust host platform', () => {
  const source = readFileSync(verifier, 'utf8')
  assert.match(source, /run\('rustc', \['-vV'\], 'Rust host lookup'/)
  assert.match(source, /'--filter-platform',\s+hostTriple,/)
  assert.match(source, /'--locked',\s+'--offline',/)
  assert.match(source, /updaterNodes\.some\(\(entry\) => entry\.dependencies\?\.includes\(package_\.id\)\)/)
})

function fixture(artifactContent) {
  const root = mkdtempSync(join(tmpdir(), 'skillhub-updater-signature-test-'))
  const artifact = join(root, 'SkillHub.app.tar.gz')
  const signature = `${artifact}.sig`
  const config = join(root, 'tauri.conf.json')
  writeFileSync(artifact, artifactContent)
  writeFileSync(signature, `${encodedSignature}\n`)
  writeFileSync(config, JSON.stringify({ plugins: { updater: { pubkey: encodedPublicKey } } }))
  return { artifact, config, root, signature }
}

function invoke(paths, extraArguments = []) {
  return spawnSync(process.execPath, [
    verifier,
    '--artifact', paths.artifact,
    '--signature', paths.signature,
    '--config', paths.config,
    ...extraArguments,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TEMP: paths.root,
      TMP: paths.root,
      TMPDIR: paths.root,
    },
  })
}

function assertVerifierTemporaryFilesRemoved(root) {
  assert.deepEqual(
    readdirSync(root).filter((entry) => entry.startsWith('skillhub-updater-signature-')),
    [],
  )
}

test('verifies a real Tauri-format Minisign signature and removes temporary compiler files', () => {
  const paths = fixture('test')
  try {
    const result = invoke(paths)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Verified Tauri updater signature/)
    assert.equal(`${result.stdout}${result.stderr}`.includes(encodedPublicKey), false)
    assert.equal(`${result.stdout}${result.stderr}`.includes(encodedSignature), false)
    assert.equal(`${result.stdout}${result.stderr}`.includes(publicKeyText), false)
    assert.equal(`${result.stdout}${result.stderr}`.includes(signatureText), false)
    assertVerifierTemporaryFilesRemoved(paths.root)
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
})

test('rejects a valid signature paired with tampered artifact bytes and still cleans up', () => {
  const paths = fixture('Test')
  try {
    const result = invoke(paths)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Tauri updater signature verification failed/)
    assert.equal(`${result.stdout}${result.stderr}`.includes(encodedPublicKey), false)
    assert.equal(`${result.stdout}${result.stderr}`.includes(encodedSignature), false)
    assert.equal(`${result.stdout}${result.stderr}`.includes(publicKeyText), false)
    assert.equal(`${result.stdout}${result.stderr}`.includes(signatureText), false)
    assertVerifierTemporaryFilesRemoved(paths.root)
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
})

test('requires only the explicit artifact, signature, and config arguments', () => {
  const missing = spawnSync(process.execPath, [verifier, '--artifact', 'artifact'], { encoding: 'utf8' })
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /Missing --signature/)

  const unknown = spawnSync(process.execPath, [verifier, '--unknown', 'value'], { encoding: 'utf8' })
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /Unknown argument: --unknown/)

  const duplicate = spawnSync(process.execPath, [
    verifier,
    '--artifact', 'first',
    '--artifact', 'second',
  ], { encoding: 'utf8' })
  assert.equal(duplicate.status, 2)
  assert.match(duplicate.stderr, /Duplicate argument: --artifact/)
})

test('rejects a symlinked artifact before compiling the verifier', { skip: process.platform === 'win32' }, () => {
  const paths = fixture('test')
  try {
    const symlink = join(paths.root, 'linked.app.tar.gz')
    symlinkSync(paths.artifact, symlink)
    const result = invoke({ ...paths, artifact: symlink })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Updater artifact must be a non-empty regular file/)
    assertVerifierTemporaryFilesRemoved(paths.root)
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
})
