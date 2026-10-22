import assert from 'node:assert/strict'
import test from 'node:test'
import { acquireMarketplaceSkill } from '../src/lib/marketplace-acquisition.ts'
import { buildMarketplaceShareUrl } from '../src/lib/marketplace-deep-link.ts'
import type { LocalSkill } from '../src/store/index.ts'

const id = '22222222-2222-4222-8222-222222222222'
const skill = {
  id, serverId: id, serverOwnerId: 'author', name: 'my-skill', displayName: 'Skill',
  version: '1.0.0', labels: [], compatibleAgents: [], envDeps: [], installCount: 0,
  marketplaceStatus: 'approved', marketplacePackageSha256: 'a'.repeat(64),
} as LocalSkill

test('joining imports the approved package without enabling any Agent', async () => {
  let imported = false
  const result = await acquireMarketplaceSkill(skill, {
    localSkills: async () => [],
    download: async () => ({ base64: 'cGtn', sha256: 'a'.repeat(64), version: '1.0.0' }),
    importPackage: async input => {
      imported = true
      assert.equal(input.acquisitionSource, 'marketplace')
      assert.equal(input.replaceExistingMarketplace, false)
      assert.equal(input.isOwn, false)
      assert.deepEqual(input.teamIds, [])
      assert.equal('agents' in input, false)
      return { ...skill, localPath: '/managed', agents: {} }
    },
  })
  assert.equal(imported, true)
  assert.deepEqual(result.agents, {})
})

test('joining an existing Skill preserves its working copy and Agent state', async () => {
  const existing = { ...skill, localPath: '/managed', hasWorkingCopy: true, agents: { codex: 'on' as const } }
  const result = await acquireMarketplaceSkill(skill, {
    localSkills: async () => [existing],
    download: async () => { throw new Error('must not download') },
    importPackage: async () => { throw new Error('must not replace') },
  })
  assert.equal(result, existing)
})

test('official store update preserves an existing team acquisition and account binding', async () => {
  const existing = { ...skill, version: '0.1.0', localPath: '/managed', acquisitionSource: 'team' as const, isOwn: false, teamSharedFrom: 'team', sharedTo: { team: { version: '0.1.0', envShared: false } } }
  await acquireMarketplaceSkill(skill, {
    spaceId: 'official', currentUserId: 'member',
    localSkills: async () => [existing],
    download: async () => ({ base64: 'cGtn', sha256: 'a'.repeat(64), version: '1.0.0' }),
    importPackage: async input => {
      assert.equal(input.acquisitionSource, 'team')
      assert.equal(input.acquiredByUserId, 'member')
      assert.equal(input.catalogOrigin, undefined)
      assert.equal(input.replaceExistingMarketplace, true)
      return existing
    },
  }, true)
})

for (const mismatch of ['checksum', 'version']) {
  test(`joining refuses an unapproved ${mismatch} before import`, async () => {
    await assert.rejects(acquireMarketplaceSkill(skill, {
      localSkills: async () => [],
      download: async () => ({ base64: 'cGtn', sha256: mismatch === 'checksum' ? 'b'.repeat(64) : 'a'.repeat(64), version: mismatch === 'version' ? '2.0.0' : '1.0.0' }),
      importPackage: async () => { assert.fail('must not import') },
    }), /商店版本已更新/)
  })
}

test('share URL uses only the immutable identity, rejecting path injection', () => {
  assert.equal(buildMarketplaceShareUrl(id), `https://sk.woe.show/marketplace/skills/${id}`)
  assert.throws(() => buildMarketplaceShareUrl('../admin'))
})
