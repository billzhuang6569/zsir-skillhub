#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import {
  lstatSync,
  readlinkSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const CHECK_NAME = 'skillhub-release-verifier'
const DEFAULT_ENV_KEY = 'SKILLHUB_QA_TOKEN'

function assertCheck(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function modeOf(path) {
  return lstatSync(path).mode & 0o777
}

function readProfile(profilePath) {
  const profileStat = lstatSync(profilePath)
  assertCheck(profileStat.isFile() && !profileStat.isSymbolicLink(), 'profile sidecar must be a regular file')

  let profile
  try {
    profile = JSON.parse(readFileSync(profilePath, 'utf8'))
  } catch {
    throw new Error('profile sidecar must contain valid JSON')
  }

  const metadata = profile?.skillhub
  assertCheck(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'profile sidecar must contain skillhub metadata')
  for (const field of ['name', 'displayName', 'description', 'category']) {
    assertCheck(typeof metadata[field] === 'string' && metadata[field].trim().length > 0, `profile sidecar is missing ${field}`)
  }
  assertCheck(Array.isArray(metadata.labels) && metadata.labels.length > 0, 'profile sidecar must contain labels')
  return metadata
}

function verifyGitRepository(skillRoot) {
  const gitDir = join(skillRoot, '.git')
  assertCheck(lstatSync(gitDir).isDirectory(), 'managed Skill must contain local Git history')

  let topLevel
  let head
  try {
    topLevel = execFileSync('git', ['-C', skillRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    head = execFileSync('git', ['-C', skillRoot, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error('managed Skill Git repository must have a readable HEAD commit')
  }

  assertCheck(realpathSync(topLevel) === realpathSync(skillRoot), 'managed Skill must be the Git repository root')
  assertCheck(/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head), 'managed Skill Git HEAD must be a valid object ID')
  try {
    execFileSync('git', ['-C', skillRoot, 'ls-files', '--error-unmatch', 'SKILL.md'], { stdio: 'ignore' })
    execFileSync('git', ['-C', skillRoot, 'diff', '--quiet', 'HEAD', '--', 'SKILL.md'])
  } catch {
    throw new Error('managed SKILL.md must be tracked and match the current Git version')
  }
}

function resolveDeclaredLink(linkPath) {
  return resolve(dirname(linkPath), readlinkSync(linkPath))
}

function verifyGeneratedProjection(skillhubRoot, skillRoot, skillId) {
  const currentPath = join(skillhubRoot, 'projections', skillId, 'current')
  const currentStat = lstatSync(currentPath)
  assertCheck(currentStat.isSymbolicLink(), 'current SkillHub projection must be a symbolic link')

  const generationPath = realpathSync(currentPath)
  const markerPath = join(generationPath, '.skillhub-projection.json')
  const markerStat = lstatSync(markerPath)
  assertCheck(markerStat.isFile() && !markerStat.isSymbolicLink(), 'projection marker must be a regular file')

  let marker
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    throw new Error('projection marker must contain valid JSON')
  }
  assertCheck(marker?.version === 2, 'projection marker version must be 2')
  assertCheck(marker.skillId === skillId, 'projection marker Skill ID must match')
  assertCheck(realpathSync(marker.sourceRoot) === realpathSync(skillRoot), 'projection marker must target the managed Skill')
  assertCheck(marker.generation === basename(generationPath), 'projection marker generation must match current')
  assertCheck(/^generation-[0-9a-f-]{36}$/.test(marker.generation), 'projection generation name must be valid')
  for (const digest of [marker.canonicalSkillMdSha256, marker.renderedSkillMdSha256]) {
    assertCheck(typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest), 'projection marker digests must be valid')
  }
  assertCheck(realpathSync(join(generationPath, 'SKILL.md')) !== realpathSync(join(skillRoot, 'SKILL.md')), 'generated SKILL.md must be isolated from the canonical file')
  return currentPath
}

function verifyProjection(linkPath, currentPath, agentName) {
  const linkStat = lstatSync(linkPath)
  assertCheck(linkStat.isSymbolicLink(), `${agentName} projection must be a symbolic link`)
  assertCheck(resolveDeclaredLink(linkPath) === currentPath, `${agentName} projection must declare the current SkillHub projection`)
  assertCheck(realpathSync(linkPath) === realpathSync(currentPath), `${agentName} projection must resolve to the current SkillHub generation`)
}

function verifyEnvironment(skillhubRoot, envDirectory, envFile, envKey) {
  const envRoot = join(skillhubRoot, 'envs')
  const rootStat = lstatSync(envRoot)
  assertCheck(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'environment root must be a real directory')
  assertCheck(modeOf(envRoot) === 0o700, 'environment root permissions must be 0700')

  const directoryStat = lstatSync(envDirectory)
  assertCheck(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), 'environment directory must be a real directory')
  assertCheck(modeOf(envDirectory) === 0o700, 'environment directory permissions must be 0700')

  const fileStat = lstatSync(envFile)
  assertCheck(fileStat.isFile() && !fileStat.isSymbolicLink(), 'environment file must be a regular file')
  assertCheck(modeOf(envFile) === 0o600, 'environment file permissions must be 0600')

  const escapedKey = envKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const assignmentPattern = new RegExp(`^\\s*(?:export\\s+)?${escapedKey}\\s*=`, 'm')
  assertCheck(assignmentPattern.test(readFileSync(envFile, 'utf8')), `environment file must contain ${envKey}`)
  assertCheck(typeof process.env[envKey] === 'string' && process.env[envKey].length > 0, `${envKey} must be injected into the verifier process`)

  const runtimePath = join(skillhubRoot, 'runtime', 'bin', 'yitan-skillhub-runtime')
  const runtimeStat = lstatSync(runtimePath)
  assertCheck(runtimeStat.isFile() && !runtimeStat.isSymbolicLink(), 'private SkillHub runtime must be a regular file')
  assertCheck(modeOf(runtimePath) === 0o700, 'private SkillHub runtime permissions must be 0700')
}

function main() {
  const qaHome = resolve(process.env.SKILLHUB_QA_HOME || homedir())
  const skillId = process.env.SKILLHUB_QA_SKILL_ID || CHECK_NAME
  const envKey = process.env.SKILLHUB_QA_ENV_KEY || DEFAULT_ENV_KEY
  const skillhubRoot = resolve(process.env.SKILLHUB_QA_ROOT || join(qaHome, '.skillhub'))
  const skillRoot = resolve(process.env.SKILLHUB_QA_SKILL_ROOT || join(skillhubRoot, 'skills', skillId))
  const checks = []

  const run = (name, verification) => {
    try {
      verification()
      checks.push({ name, ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'verification failed'
      process.stderr.write(`${JSON.stringify({ ok: false, check: CHECK_NAME, failed: name, message })}\n`)
      process.exitCode = 1
      return false
    }
    return true
  }

  let profile
  if (!run('profile-sidecar', () => {
    profile = readProfile(join(skillRoot, '.skillhub.json'))
    assertCheck(profile.name === skillId, 'profile sidecar name must match the installed Skill ID')
    assertCheck(
      Array.isArray(profile.envDependencies) && profile.envDependencies.some((dependency) => dependency?.key === envKey),
      `profile sidecar must declare ${envKey}`,
    )
  })) return

  if (!run('git-history', () => verifyGitRepository(skillRoot))) return
  let currentPath
  if (!run('generated-projection', () => { currentPath = verifyGeneratedProjection(skillhubRoot, skillRoot, skillId) })) return
  if (!run('codex-symlink', () => verifyProjection(join(qaHome, '.codex', 'skills', skillId), currentPath, 'Codex'))) return
  if (!run('claude-symlink', () => verifyProjection(join(qaHome, '.claude', 'skills', skillId), currentPath, 'Claude Code'))) return
  let runtimeUserId = profile.serverOwnerId
  if (!runtimeUserId) {
    try {
      runtimeUserId = JSON.parse(readFileSync(join(skillhubRoot, 'runtime', 'session.json'), 'utf8')).userId
    } catch {
      runtimeUserId = null
    }
  }
  if (!run('runtime-account', () => assertCheck(typeof runtimeUserId === 'string' && runtimeUserId.length > 0, 'active runtime account must be identifiable'))) return
  const envDirectory = resolve(process.env.SKILLHUB_QA_ENV_DIR || join(skillhubRoot, 'envs', runtimeUserId))
  const envFile = join(envDirectory, `${skillId}.env`)
  if (!run('environment-security', () => verifyEnvironment(skillhubRoot, envDirectory, envFile, envKey))) return

  process.stdout.write(`${JSON.stringify({ ok: true, check: CHECK_NAME, skillId, checks })}\n`)
}

main()
