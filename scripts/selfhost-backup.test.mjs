import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const passphrase = 'test-backup-passphrase-never-in-argv'
const dataKey = Buffer.alloc(32, 7).toString('base64')
const instanceId = '12345678-1234-4123-8123-123456789012'
const migration = '20261018170000_instance_ai_management'

function fixture(t, { installed = true, running = true, failure = '', publicPreset = false, volume = false, objects = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'selfhost-backup-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const directory = join(base, 'deploy/selfhost')
  mkdirSync(join(base, 'deploy'))
  cpSync(join(root, 'deploy/selfhost'), directory, { recursive: true, filter: path => !path.endsWith('/.env') && !path.includes('/backups') })
  // Never copy a developer's real installation into the fixture.
  rmSync(join(directory, '.env'), { force: true })
  if (installed) writeFileSync(join(directory, '.env'), `COMPOSE_PROJECT_NAME=skillhub-selfhost\nCOMPOSE_FILE=compose.yaml:compose.${publicPreset ? 'public' : 'local'}.yaml${objects ? ':compose.s3-local.yaml' : ''}\nPUBLIC_BASE_URL=http://127.0.0.1:3001\nJWT_SECRET=fixture-only-secret\n`, { mode: 0o600 })
  const migrationDir = join(base, 'server/prisma/migrations', migration)
  mkdirSync(migrationDir, { recursive: true })
  writeFileSync(join(migrationDir, 'migration.sql'), '-- fixture')
  const bin = join(base, 'bin'); mkdirSync(bin)
  const trace = join(base, 'trace'); writeFileSync(trace, '')
  const passwordFile = join(base, 'password'); writeFileSync(passwordFile, passphrase + '\n', { mode: 0o600 })
  writeFileSync(join(bin, 'openssl'), `#!/bin/sh\nprintf '%s\\n' '${dataKey}'\n`, { mode: 0o755 })
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}
import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (!readdirSync(process.env.TMPDIR).some(name => name.startsWith('skillhub-server-')
  && (statSync(process.env.TMPDIR + '/' + name).mode & 0o777) === 0o600)) process.exit(3);
appendFileSync(process.env.TRACE, JSON.stringify(args) + '\\n');
const s = args.join(' ');
const fail = process.env.FAILURE;
// Real Compose rejects flags that \`create\` does not support (found in the Docker drill).
if (args[0] === 'compose' && args.includes('create') && args.includes('--no-deps')) process.exit(2);
if (fail &&((fail === 'helper' && s.includes('--input-type=module'))
  || (fail === 'crypt' && s.includes('encrypt-part'))
  || (fail === 'build' && args[0] === 'build')
  || (fail === 'compose' && s.includes('compose up'))
  || (fail === 'restart' && s.includes('compose start'))
  || (fail === 'restore' && s.includes('pg_restore')))) {
  for (let i = 1; i <= 35; i++) process.stderr.write('docker diagnostic ' + fail + ' ' + i + '\\n');
  process.exit(1);
}
const output = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
if (args[0] === 'run') {
  if (args.includes('tar')) {
    if (s.includes('-cf -')) { output('objects archive'); if (fail === 'tar') process.exit(1); }
    else readFileSync(0);
    process.exit(0);
  }
  const input = readFileSync(0);
  const op = args.indexOf('dist/ops/instance-backup.js');
  if (op < 0) {
    const start = args.indexOf('--input-type=module');
    const result = spawnSync(process.execPath, args.slice(start), {input, env: process.env});
    process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);
  }
  const command = args[op + 1];
  const field = args[args.indexOf('--field') + 1];
  if (command === 'sha256') output(createHash('sha256').update(input).digest('hex'));
  else if (command === 'encrypt-part') {
    if (fail === 'encrypt') process.exit(1);
    process.stdout.write(Buffer.concat([Buffer.alloc(32, 1), input]));
  } else if (command === 'decrypt-part') {
    if (fail === 'decrypt') process.exit(1);
    process.stdout.write(input.subarray(32));
  } else if (command === 'seal-recovery') {
    const body = JSON.parse(input);
    output({...body, backupId: args[args.indexOf('--backup-id')+1], password: process.env.SKILLHUB_BACKUP_PASSPHRASE});
  } else if (command === 'open-recovery') {
    const body = JSON.parse(input);
    if (body.password !== process.env.SKILLHUB_BACKUP_PASSPHRASE) process.exit(1);
    output(body[{'data-key':'dataKey','manifest-sha256':'manifestSha256','env':'env','backup-id':'backupId'}[field]]);
  } else process.exit(2);
} else if (args[0] === 'volume') {
  if (process.env.VOLUME === 'true') output('skillhub-selfhost_postgres-data\\n');
  else if (process.env.VOLUME === 'objects-data') output('skillhub-selfhost_objects-data\\n');
} else if (args[0] === 'inspect') output('healthy');
else if (args[0] === 'build') process.exit(0);
else if (s === 'compose images -q server') output('actual-server-image-id');
else if (s === 'compose ps -q postgres') output('postgres-container');
else if (s.includes('ps --status running')) { if (process.env.RUNNING === 'true') output('running-container'); }
else if (s.includes(' metadata')) output({
  instanceId: '${instanceId}', publicKey: 'public-key', serverVersion: '0.31.0', buildId: 'build',
  migration: '${migration}', postgresMajor: 16, media: {files: 1, bytes: 8}, cards: {files: 1, bytes: 8}
});
else if (s.includes('pg_dump')) { output('database'); if (fail === 'dump') process.exit(1); }
else if (s.includes('-cf -')) { output('archive'); if (fail === 'tar') process.exit(1); }
else if (s.includes('verify-restore')) output('{"failed":0,"missing":0}\\n');
else if (s.includes('pg_restore') || s.includes('-xf -')) readFileSync(0);
else if (s.includes('node -e')) output('APP 地址：http://127.0.0.1:3001\\n');
else if (args[0] !== 'compose') process.exit(2);
`, { mode: 0o755 })
  const logs = join(base, 'logs'); mkdirSync(logs)
  const env = { ...process.env, TMPDIR: logs, PATH: bin + ':' + process.env.PATH, TRACE: trace, RUNNING: String(running), FAILURE: failure, VOLUME: String(volume) }
  function run(command, extra = []) {
    return spawnSync('bash', ['./skillhub-server', command, '--passphrase-file', passwordFile, ...extra], { cwd: directory, env, encoding: 'utf8' })
  }
  const calls = () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const backupPath = () => join(directory, 'backups', readdirSync(join(directory, 'backups')).find(name => name.startsWith('skillhub-')))
  const recoveryPath = () => join(directory, 'backups/recovery', readdirSync(join(directory, 'backups/recovery'))[0])
  return { directory, env, run, calls, passwordFile, backupPath, recoveryPath, trace, logs }
}

test('failures retain private stderr logs and print only the last 30 lines without secrets', t => {
  const source = fixture(t)
  assert.equal(source.run('backup').status, 0)
  for (const failure of ['helper', 'crypt', 'restart', 'build', 'compose', 'restore']) {
    const restoring = ['build', 'compose', 'restore'].includes(failure)
    const f = fixture(t, { installed: !restoring, failure })
    const command = restoring ? 'restore' : 'backup'
    const result = f.run(command, restoring ? ['--backup', source.backupPath(), '--recovery', source.recoveryPath()] : [])
    assert.notEqual(result.status, 0)
    const path = result.stderr.match(/详细日志：(.+)/)?.[1]
    assert.ok(path)
    assert.equal(path, join(f.logs, readdirSync(f.logs)[0]))
    assert.match(path, new RegExp('skillhub-server-' + command + '-[0-9]{8}T[0-9]{6}Z-.+\\.log$'))
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const log = readFileSync(path, 'utf8')
    assert.ok(log.includes(`docker diagnostic ${failure} 1\n`))
    assert.ok(result.stderr.includes(`docker diagnostic ${failure} 35\n`))
    assert.ok(!result.stderr.includes(`docker diagnostic ${failure} 5\n`))
    assert.equal(result.stderr.split('详细日志：')[1].split('\n').slice(1).join('\n'), log.trimEnd().split('\n').slice(-30).join('\n') + '\n')
    for (const secret of [passphrase, dataKey, 'fixture-only-secret']) {
      assert.ok(!(log + result.stdout + result.stderr + JSON.stringify(f.calls())).includes(secret))
    }
    if (failure === 'helper') {
      f.env.FAILURE = ''
      assert.equal(f.run('backup').status, 0)
      assert.deepEqual(readdirSync(f.logs), [path.split('/').at(-1)])
      assert.equal(readFileSync(path, 'utf8'), log)
    }
  }
})

test('backup streams in order, restores original services, uses private modes and never exposes secrets in argv', t => {
  const f = fixture(t, { publicPreset: true })
  const result = f.run('backup')
  assert.equal(result.status, 0, result.stderr)
  const calls = f.calls().map(args => args.join(' '))
  const index = token => calls.findIndex(call => call.includes(token))
  assert.ok(index('stop server') < index('pg_dump'))
  assert.ok(index('pg_dump') < index('-cf - media'))
  assert.ok(index('-cf - media') < index('-cf - cards'))
  assert.ok(index('-cf - data config') < index('start server'))
  assert.ok(index('start caddy') > index('stop caddy'))
  const trace = JSON.stringify(f.calls())
  for (const secret of [passphrase, dataKey, 'fixture-only-secret']) assert.ok(!trace.includes(secret))
  assert.ok(!result.stdout.includes(dataKey) && !result.stdout.includes(passphrase))
  assert.match(result.stdout, /两者都需要才能恢复/)
  for (const path of [join(f.directory, 'backups'), join(f.directory, 'backups/recovery'), f.backupPath(), join(f.backupPath(), 'parts')]) assert.equal(statSync(path).mode & 0o777, 0o700)
  for (const path of [f.recoveryPath(), join(f.backupPath(), 'manifest.json'), ...readdirSync(join(f.backupPath(), 'parts')).map(name => join(f.backupPath(), 'parts', name))]) assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(f.run('verify', ['--backup', f.backupPath(), '--recovery', f.recoveryPath()]).status, 0)
  assert.deepEqual(readdirSync(f.logs), [])
})

test('backup failures retain partial data and restart only previously running services; upgrade stops', t => {
  for (const failure of ['dump', 'encrypt', 'tar']) {
    const f = fixture(t, { failure })
    const result = f.run('upgrade')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /保留未完成备份/)
    assert.ok(f.backupPath().endsWith('.partial'))
    const trace = f.calls().map(args => args.join(' ')).join('\n')
    assert.match(trace, /start server/)
    assert.doesNotMatch(trace, /compose (pull|build|up) /)
  }
  const stopped = fixture(t, { running: false })
  assert.equal(stopped.run('backup').status, 0)
  assert.doesNotMatch(JSON.stringify(stopped.calls()), /"start"|"stop"/)
})

test('passphrase checks fail before any Docker writes', t => {
  for (const mode of [0o644, 0o400]) {
    const f = fixture(t)
    chmodSync(f.passwordFile, mode)
    assert.notEqual(f.run('backup').status, 0)
    assert.equal(f.calls().length, 0)
  }
  const f = fixture(t)
  writeFileSync(f.passwordFile, 'short')
  assert.notEqual(f.run('backup').status, 0)
  assert.equal(f.calls().length, 0)
  const wrongOwner = fixture(t)
  const bin = wrongOwner.env.PATH.split(':')[0]
  writeFileSync(join(bin, 'stat'), '#!/bin/sh\ncase "$2" in *u) echo 999999;; *) echo 600;; esac\n', { mode: 0o755 })
  assert.notEqual(wrongOwner.run('backup').status, 0)
  assert.equal(wrongOwner.calls().length, 0)
})

test('restore refuses existing env or volumes before build or writes', t => {
  for (const options of [{ installed: true }, { installed: false, volume: true }, { installed: false, volume: 'objects-data' }]) {
    const f = fixture(t, options)
    assert.notEqual(f.run('restore', ['--backup', '/unused', '--recovery', '/unused']).status, 0)
    assert.ok(f.calls().every(call => call[0] === 'volume'))
  }
})

test('restore authenticates all material before creating env and volumes, then restores in order', t => {
  const source = fixture(t)
  assert.equal(source.run('backup').status, 0)
  const backup = source.backupPath(); const recovery = source.recoveryPath()
  const target = fixture(t, { installed: false })
  const result = target.run('restore', ['--backup', backup, '--recovery', recovery])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /恢复完成/)
  assert.equal(statSync(join(target.directory, '.env')).mode & 0o777, 0o600)
  const calls = target.calls().map(args => args.join(' '))
  const index = token => calls.findIndex(call => call.includes(token))
  assert.ok(index('build -t') < index('open-recovery'))
  assert.ok(index('decrypt-part --name cards') < index('up -d --wait postgres'))
  assert.ok(index('pg_restore') < index('verify-restore'))
  assert.ok(index('verify-restore') < index('node -e'))
  for (const secret of [passphrase, dataKey, 'fixture-only-secret']) assert.ok(!JSON.stringify(target.calls()).includes(secret))
  for (const corrupt of ['manifest.json', 'parts/db.enc']) {
    const original = readFileSync(join(backup, corrupt))
    writeFileSync(join(backup, corrupt), Buffer.concat([original, Buffer.from('corrupt')]))
    const refused = fixture(t, { installed: false })
    assert.notEqual(refused.run('restore', ['--backup', backup, '--recovery', recovery]).status, 0)
    assert.throws(() => statSync(join(refused.directory, '.env')))
    assert.ok(!refused.calls().some(call => call[0] === 'compose' && call.includes('up')))
    writeFileSync(join(backup, corrupt), original)
  }
  for (const reason of ['migration', 'postgres', 'password', 'decrypt']) {
    const refused = fixture(t, { installed: false, failure: reason === 'decrypt' ? reason : '' })
    if (reason === 'migration') rmSync(resolve(refused.directory, '../../server/prisma/migrations', migration), { recursive: true })
    if (reason === 'postgres') {
      const compose = join(refused.directory, 'compose.yaml')
      writeFileSync(compose, readFileSync(compose, 'utf8').replace('postgres:16-bookworm', 'postgres:17-bookworm'))
    }
    if (reason === 'password') writeFileSync(refused.passwordFile, 'wrong-password-long-enough')
    assert.notEqual(refused.run('restore', ['--backup', backup, '--recovery', recovery]).status, 0)
    assert.throws(() => statSync(join(refused.directory, '.env')))
    assert.ok(!refused.calls().some(call => call[0] === 'compose' && call.includes('up')))
  }
})

test('helper preserves UTF-8 env text when a character crosses stdin chunks', async () => {
  const script = readFileSync(join(root, 'deploy/selfhost/backup-helper.mjs'), 'utf8')
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, '--', 'recovery-input'], {
    env: { ...process.env, SKILLHUB_BACKUP_DATA_KEY: dataKey, SKILLHUB_BACKUP_MANIFEST_HASH: 'a'.repeat(64) },
  })
  const bytes = Buffer.from('# 中文注释\nPUBLIC_BASE_URL=https://example.test\n')
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += chunk })
  const complete = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error('helper failed')))
  })
  child.stdin.write(bytes.subarray(0, 3))
  await new Promise(resolve => setTimeout(resolve, 100))
  child.stdin.end(bytes.subarray(3))
  await complete
  assert.equal(JSON.parse(output).env, bytes.toString())
})

test('upgrade takes a complete backup before pull/build/up and performs health probes', t => {
  const f = fixture(t)
  const result = f.run('upgrade')
  assert.equal(result.status, 0, result.stderr)
  const calls = f.calls().map(call => call.join(' '))
  const index = token => calls.findIndex(call => call.includes(token))
  assert.ok(index('seal-recovery') < index('compose pull --ignore-buildable'))
  assert.ok(index('start server') < index('compose pull --ignore-buildable'))
  assert.ok(index('compose pull --ignore-buildable') < index('compose build --pull server'))
  assert.ok(index('compose build --pull server') < index('compose up -d --wait --wait-timeout 180'))
  assert.ok(index('compose up -d --wait --wait-timeout 180') < index('node -e'))
  assert.match(result.stdout, /升级完成；自动备份/)
})

test('SeaweedFS overlay backs up and restores its offline volume as the final authenticated shard', t => {
  for (const publicPreset of [false, true]) {
    const source = fixture(t, { objects: true, publicPreset })
    const result = source.run('backup')
    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(readFileSync(join(source.backupPath(), 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.parts.map(p => p.name), ['db', 'media', 'cards', ...(publicPreset ? ['caddy'] : []), 'objects'])
    const calls = source.calls().map(call => call.join(' '))
    assert.ok(calls.findIndex(s => s.includes('stop seaweedfs')) < calls.findIndex(s => s.includes('objects-data:/data:ro')))
    assert.ok(calls.findIndex(s => s.includes('start seaweedfs')) < calls.findIndex(s => s.includes('start server')))
    const target = fixture(t, { installed: false })
    const restored = target.run('restore', ['--backup', source.backupPath(), '--recovery', source.recoveryPath()])
    assert.equal(restored.status, 0, restored.stderr)
    const restoredCalls = target.calls().map(call => call.join(' '))
    assert.ok(restoredCalls.findIndex(s => s.includes('objects-data:/data') && s.includes('-xf -'))
      < restoredCalls.findIndex(s => s.includes('compose up -d --wait --wait-timeout')))
  }
  const failed = fixture(t, { objects: true, failure: 'tar' })
  assert.notEqual(failed.run('backup').status, 0)
  assert.ok(failed.calls().some(args => args.join(' ').includes('start seaweedfs')))
})
