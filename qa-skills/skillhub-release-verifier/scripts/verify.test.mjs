import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'verify.mjs')
const secret = 'fixture-secret-that-must-not-be-printed'

function createFixture() {
  const home = mkdtempSync(join(tmpdir(), 'skillhub-release-verifier-'))
  const skillId = 'skillhub-release-verifier'
  const skillRoot = join(home, '.skillhub', 'skills', skillId)
  const runtimeUserId = '98862bf6-9db9-4233-9645-32dd39a7501c'
  const projectionRoot = join(home, '.skillhub', 'projections', skillId)
  const generationName = 'generation-111854cf-f039-4c54-89c9-49c14d522b46'
  const generationRoot = join(projectionRoot, generationName)
  const currentProjection = join(projectionRoot, 'current')
  const envRoot = join(home, '.skillhub', 'envs')
  const envDirectory = join(envRoot, runtimeUserId)
  const envFile = join(envDirectory, `${skillId}.env`)
  mkdirSync(skillRoot, { recursive: true })
  mkdirSync(envDirectory, { recursive: true, mode: 0o700 })
  chmodSync(envRoot, 0o700)
  chmodSync(envDirectory, 0o700)
  writeFileSync(join(skillRoot, 'SKILL.md'), '# Fixture\n')
  writeFileSync(join(skillRoot, '.skillhub.json'), `${JSON.stringify({
    version: '1.0',
    skillhub: {
      name: skillId,
      serverOwnerId: runtimeUserId,
      displayName: 'Release verifier fixture',
      description: 'Exercises the real release acceptance contract.',
      category: 'QA',
      labels: ['release'],
      envDependencies: [{ key: 'SKILLHUB_QA_TOKEN', required: true }],
    },
  }, null, 2)}\n`)
  execFileSync('git', ['init', '-q', skillRoot])
  execFileSync('git', ['-C', skillRoot, 'add', 'SKILL.md'])
  execFileSync('git', ['-C', skillRoot, '-c', 'user.name=SkillHub QA', '-c', 'user.email=qa@localhost', 'commit', '-qm', 'Initial fixture'])
  mkdirSync(generationRoot, { recursive: true })
  writeFileSync(join(generationRoot, 'SKILL.md'), '# Fixture with generated runtime header\n')
  writeFileSync(join(generationRoot, '.skillhub-projection.json'), `${JSON.stringify({
    version: 2,
    skillId,
    sourceRoot: skillRoot,
    generation: generationName,
    canonicalSkillMdSha256: '1'.repeat(64),
    renderedSkillMdSha256: '2'.repeat(64),
  })}\n`)
  symlinkSync(generationName, currentProjection)
  writeFileSync(envFile, `export SKILLHUB_QA_TOKEN='${secret}'\n`, { mode: 0o600 })
  chmodSync(envFile, 0o600)
  const runtimeDirectory = join(home, '.skillhub', 'runtime', 'bin')
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 })
  writeFileSync(join(runtimeDirectory, 'yitan-skillhub-runtime'), '#!/bin/sh\n', { mode: 0o700 })

  for (const agent of ['.codex', '.claude']) {
    const projectionDirectory = join(home, agent, 'skills')
    mkdirSync(projectionDirectory, { recursive: true })
    symlinkSync(currentProjection, join(projectionDirectory, skillId))
  }

  return { home, envDirectory, skillRoot, skillId, currentProjection }
}

function runVerifier(home) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SKILLHUB_QA_HOME: home,
      SKILLHUB_QA_TOKEN: secret,
    },
  })
}

test('passes only when profile, Git, projections, and env security are real', () => {
  const fixture = createFixture()
  try {
    const result = runVerifier(fixture.home)
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.ok, true)
    assert.deepEqual(output.checks.map((check) => check.name), [
      'profile-sidecar',
      'git-history',
      'generated-projection',
      'codex-symlink',
      'claude-symlink',
      'runtime-account',
      'environment-security',
    ])
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('fails when an Agent projection is not a symbolic link', () => {
  const fixture = createFixture()
  try {
    const codexProjection = join(fixture.home, '.codex', 'skills', fixture.skillId)
    unlinkSync(codexProjection)
    mkdirSync(codexProjection)
    const result = runVerifier(fixture.home)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /codex-symlink/)
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('fails when an Agent projection bypasses the current generated projection', () => {
  const fixture = createFixture()
  try {
    const codexProjection = join(fixture.home, '.codex', 'skills', fixture.skillId)
    unlinkSync(codexProjection)
    symlinkSync(fixture.skillRoot, codexProjection)
    const result = runVerifier(fixture.home)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /codex-symlink/)
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('fails when environment permissions are too broad', () => {
  const fixture = createFixture()
  try {
    chmodSync(fixture.envDirectory, 0o755)
    const result = runVerifier(fixture.home)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /environment-security/)
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('fails when SKILL.md has unversioned working-copy changes', () => {
  const fixture = createFixture()
  try {
    writeFileSync(join(fixture.skillRoot, 'SKILL.md'), '# Changed outside version history\n')
    const result = runVerifier(fixture.home)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /git-history/)
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})
