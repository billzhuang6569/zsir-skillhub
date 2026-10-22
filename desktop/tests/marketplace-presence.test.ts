import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { marketplaceManagedListingIds } from '../src/lib/marketplace-presence-state.ts'
import type { LocalSkill } from '../src/store/index.js'

function skill(overrides: Partial<LocalSkill>): LocalSkill {
  return {
    id: 'local', name: 'demo', displayName: 'Demo', labels: [], version: '1.0.0', latestVersion: '1.0.0',
    installCount: 0, sources: [], agents: {}, installed: false, isOwn: true, acquisitionSource: 'local', envDeps: [],
    sharedTo: {}, versions: [], compatibleAgents: [], ...overrides,
  }
}

describe('Marketplace managed presence', () => {
  it('counts every locally managed public Skill regardless of acquisition source', () => {
    assert.deepEqual(marketplaceManagedListingIds([
      skill({ id: 'own', serverId: 'listing-own', localPath: '/managed/own', acquisitionSource: 'local' }),
      skill({ id: 'store', serverId: 'listing-store', localPath: '/managed/store', acquisitionSource: 'marketplace' }),
      skill({ id: 'team', serverId: 'listing-team', localPath: '/managed/team', acquisitionSource: 'team' }),
      skill({ id: 'remote-only', serverId: 'listing-remote' }),
    ]), ['listing-own', 'listing-store', 'listing-team'])
  })
})
