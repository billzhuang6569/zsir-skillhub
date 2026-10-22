import assert from 'node:assert/strict'
import test from 'node:test'
import { runSkillInstallFlow } from '../src/lib/install-flow.ts'

type Asset = {
  id: string
  localPath: string
  installed: boolean
  serverId?: string
  teamSharedFrom?: string
  sharedTo?: Record<string, { version: string; envShared: boolean }>
  accountSyncRequired?: boolean
}

test('a downloaded remote asset is reconciled before a failed projection', async () => {
  const remote: Asset = { id: 'server:skill-001', localPath: '', installed: false }
  const imported: Asset = { id: 'release-verifier', localPath: '/managed/release-verifier', installed: false }
  const replacements: Array<[string, Asset]> = []

  await assert.rejects(runSkillInstallFlow({
    asset: remote,
    agents: ['codex'],
    importRemote: async () => imported,
    install: async () => { throw new Error('projection conflict') },
    refresh: async () => undefined,
    replace: (currentId, updated) => replacements.push([currentId, updated]),
  }), /projection conflict/)

  assert.deepEqual(replacements, [['server:skill-001', imported]])
})

test('retrying the reconciled local asset never imports it again', async () => {
  const imported: Asset = { id: 'release-verifier', localPath: '/managed/release-verifier', installed: false }
  const installed: Asset = { ...imported, installed: true }
  const calls: string[] = []

  await runSkillInstallFlow({
    asset: imported,
    agents: ['codex'],
    importRemote: async () => { calls.push('unexpected-import'); return imported },
    install: async (localId) => { calls.push(`install:${localId}`) },
    refresh: async (localId) => { calls.push(`refresh:${localId}`); return installed },
    replace: (currentId, updated) => calls.push(`replace:${currentId}:${updated.installed}`),
  })

  assert.deepEqual(calls, [
    'install:release-verifier',
    'refresh:release-verifier',
    'replace:release-verifier:true',
  ])
})

test('an install refresh cannot restore a server binding detached after an account switch', async () => {
  const detached: Asset = {
    id: 'release-verifier',
    localPath: '/managed/release-verifier',
    installed: false,
    sharedTo: {},
    accountSyncRequired: true,
  }
  const rawSidecarRefresh: Asset = {
    ...detached,
    installed: true,
    serverId: 'old-account-skill-id',
    teamSharedFrom: 'old-team',
    sharedTo: { 'old-team': { version: 'v1.0', envShared: false } },
    accountSyncRequired: undefined,
  }
  const replacements: Asset[] = []

  await runSkillInstallFlow({
    asset: detached,
    agents: ['codex'],
    install: async () => undefined,
    refresh: async () => rawSidecarRefresh,
    replace: (_currentId, updated) => replacements.push(updated),
  })

  assert.equal(replacements[0]?.installed, true)
  assert.equal(replacements[0]?.serverId, undefined)
  assert.equal(replacements[0]?.teamSharedFrom, undefined)
  assert.deepEqual(replacements[0]?.sharedTo, {})
  assert.equal(replacements[0]?.accountSyncRequired, true)
})
