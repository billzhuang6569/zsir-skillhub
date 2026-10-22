import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { readAdminAgentReleaseSummary } from './admin-agent-release-summary.js'

const buildId = 'a'.repeat(64)
const marker = '20261004160000_add_admin_agent_keys'
const temporaryDirectories: string[] = []

afterEach(async (): Promise<void> => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'skillhub-admin-release-'))
  temporaryDirectories.push(path)
  return path
}

describe('Admin Agent release evidence', () => {
  it('writes an atomic secret-free summary and rejects stale or invalid evidence', async () => {
    const path = join(await directory(), 'summary.json')
    const writer = fileURLToPath(new URL('../../scripts/write-admin-agent-release-summary.mjs', import.meta.url))
    const written = spawnSync(process.execPath, [writer, '0.27.0', buildId, marker, 'unknown'], {
      env: { ...process.env, NODE_ENV: 'test', SKILLHUB_ADMIN_RELEASE_SUMMARY_OUTPUT: path }, encoding: 'utf8',
    })
    expect(written.status, written.stderr).toBe(0)
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('skh_agent_')
    const result = await readAdminAgentReleaseSummary(buildId, marker, path)
    expect(result).toMatchObject({ status: 'verified', summary: { app: { version: null, evidenceLevel: 'unknown' }, cardIntegrity: { evidenceLevel: 'verified' } } })
    expect(await readAdminAgentReleaseSummary('b'.repeat(64), marker, path)).toMatchObject({ status: 'stale', reasonCode: 'BUILD_MISMATCH' })
    await writeFile(path, '{ invalid', 'utf8')
    expect(await readAdminAgentReleaseSummary(buildId, marker, path)).toMatchObject({ status: 'unknown', reasonCode: 'SUMMARY_INVALID' })
  })

  it('rejects a symlink instead of following an attacker-selected summary', async () => {
    const base = await directory()
    const target = join(base, 'target.json')
    const link = join(base, 'summary.json')
    await writeFile(target, '{}', 'utf8')
    await symlink(target, link)
    expect(await readAdminAgentReleaseSummary(buildId, marker, link)).toMatchObject({ status: 'unknown', reasonCode: 'SUMMARY_INVALID' })
  })
})
