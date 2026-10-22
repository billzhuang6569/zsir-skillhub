import { serverFixture } from './helpers/server-ipc.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  apiCreateMarketplaceInstallIntent, apiFinishMarketplaceInstallIntent,
  apiSyncMarketplacePresence, apiPostMarketplaceComment, onApiUnauthorized,
} from '../src/lib/api.ts'
import { cachedCatalog, catalogOfflineAt, catalogOfflineMessage } from '../src/lib/catalog-cache.ts'
import { remoteManagedSkillId, hydrateDownloadedSkill, mergeApiSkill, mergeSkillSources, replaceSkillAcrossSources } from '../src/lib/skills.ts'
import type { ApiSkill } from '../src/lib/api.ts'
import { acquireMarketplaceSkill } from '../src/lib/marketplace-acquisition.ts'
import { currentOwnedServerSkillId } from '../src/lib/team-share-flow.ts'
import { currentAccountServerId, reconcileLocalSkillRefresh } from '../src/lib/ui-helpers.ts'
import type { LocalSkill } from '../src/store/index.ts'
import { OFFICIAL_ENDPOINTS } from '../src/lib/official-endpoints.ts'

const listing = '11111111-1111-4111-8111-111111111111'

test('every catalog route preserves a selfhost session on 401/403 and native missing-login errors', async () => {
  const previous = serverFixture.fetch
  let invalidations = 0
  const unsubscribe = onApiUnauthorized(() => { invalidations += 1 })
  serverFixture.space = { spaceId: 'selfhost-example', generation: 1 }
  try {
    for (const status of [401, 403]) {
      serverFixture.fetch = async () => new Response(JSON.stringify({ message: '拒绝' }), { status })
      await assert.rejects(apiPostMarketplaceComment(listing, { visibility: 'public', content: 'test' }))
      assert.equal(serverFixture.space.spaceId, 'selfhost-example')
    }
    serverFixture.fetch = async () => { throw new Error('请先在 SkillHub APP 登录') }
    await assert.rejects(apiPostMarketplaceComment(listing, { visibility: 'public', content: 'test' }))
    assert.equal(invalidations, 0)
  } finally { serverFixture.fetch = previous; unsubscribe() }
})

test('selfhost and local intent/presence never send requests or create client identifiers', async () => {
  const previous = serverFixture.fetch
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { assert.fail('must not access device storage') } })
  serverFixture.fetch = async () => { assert.fail('must not report') }
  try {
    for (const spaceId of ['local', 'selfhost-example']) {
      serverFixture.space = { spaceId, generation: 2 }
      assert.equal(await apiCreateMarketplaceInstallIntent(listing, 'one'), undefined)
      assert.equal(await apiFinishMarketplaceInstallIntent('old-official-intent', 'completed'), undefined)
      assert.deepEqual(await apiSyncMarketplacePresence('device', [listing]), { activeListingIds: [], syncedAt: '' })
    }
  } finally {
    serverFixture.fetch = previous
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('public cache survives network failure with a timestamp and ignores storage failures', async () => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  } })
  try {
    const path = '/marketplace/home?test=409'
    const payload = { items: [{ id: listing }] }
    assert.deepEqual(await cachedCatalog(path, async () => payload), payload)
    const failed = async (): Promise<never> => { throw new Error('offline') }
    assert.deepEqual(await cachedCatalog(path, failed), payload)
    assert.match(catalogOfflineMessage(catalogOfflineAt()!), /无法连接官方商店，显示 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 的缓存/)
    await assert.rejects(cachedCatalog('/marketplace/missing', failed), /offline/)
    await cachedCatalog('/marketplace/another-online-page', async () => payload)
    assert.equal(catalogOfflineAt(), null)
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('disk unavailable') } })
    assert.deepEqual(await cachedCatalog(path, async () => payload), payload)
    await assert.rejects(cachedCatalog(path, failed), /offline/)
  } finally {
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('offline store surfaces disable downloads and display the timestamp banner', () => {
  const read = (name: string): string => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
  assert.match(read('pages/MarketplacePage.tsx'), /catalogOfflineMessage\(offlineAt\)/)
  for (const file of ['components/SkillCard.tsx', 'components/SkillDetailSheet.tsx', 'components/store/TopicArticle.tsx', 'components/store/StoreUI.tsx']) {
    assert.match(read(file), /disabled=\{[^}]*Boolean\(offlineAt\)/)
    assert.match(read(file), /CATALOG_INSTALL_OFFLINE/)
  }
})

test('catalog assets never become owned even when author UUID matches', () => {
  const asset = { serverId: listing, serverOwnerId: 'same', isOwn: true, catalogOrigin: OFFICIAL_ENDPOINTS.catalogOrigin }
  assert.equal(currentOwnedServerSkillId(asset, 'same'), undefined)
  assert.equal(currentAccountServerId({ ...asset, serverAccessValidatedForUserId: 'same' }, 'same'), undefined)
  assert.equal(hydrateDownloadedSkill(asset as LocalSkill, asset as LocalSkill).isOwn, false)
  assert.equal(reconcileLocalSkillRefresh(asset, asset).isOwn, false)
})

test('account refresh keeps catalog provenance and separates an instance asset with the same UUID', () => {
  const catalog = { id: 'local-catalog', name: 'demo', serverId: listing, serverOwnerId: 'same',
    isOwn: false, acquisitionSource: 'marketplace', catalogOrigin: OFFICIAL_ENDPOINTS.catalogOrigin,
    acquisitionVersion: '1.2.3', localPath: '/catalog', envDeps: [], sharedTo: {}, versions: [] } as unknown as LocalSkill
  const owned = { id: listing, name: 'private-demo', authorId: 'same', labels: [], currentVersion: '0.1.0' } as ApiSkill
  const refreshed = mergeApiSkill(owned, catalog, undefined, 'same', true)
  assert.equal(refreshed.catalogOrigin, catalog.catalogOrigin)
  assert.equal(refreshed.acquisitionVersion, '1.2.3')
  assert.equal(refreshed.isOwn, false)
  const merged = mergeSkillSources([catalog], [owned], {
    selfhost: true, accountUserId: 'same', activeTeamId: null, membershipsValidated: true, teamSources: [],
  })
  assert.equal(merged.length, 2)
  assert.equal(merged.find(item => item.id === catalog.id)?.name, 'demo')
  assert.equal(merged.find(item => item.id === catalog.id)?.isOwn, false)
  assert.equal(merged.find(item => item.id !== catalog.id)?.isOwn, true)
  const publicCard = { ...catalog, id: `market:${listing}`, localPath: undefined }
  const privateAsset = { ...catalog, id: 'instance-private', catalogOrigin: undefined, localPath: '/private', isOwn: true }
  const updated = replaceSkillAcrossSources([catalog, privateAsset], [publicCard], privateAsset.id, privateAsset)
  assert.equal(updated.marketplaceSkills[0].localPath, undefined)
  assert.equal(updated.marketplaceSkills[0].marketplaceLocalId, undefined)
  assert.equal(updated.skills[0].localPath, '/catalog')
})

test('official and selfhost installs have stable distinct folder IDs and update only their own copy', async () => {
  const spaceId = `selfhost-${'a'.repeat(64)}`
  const official = remoteManagedSkillId('demo', listing)
  const selfhost = remoteManagedSkillId('demo', listing, spaceId)
  assert.notEqual(official, selfhost)
  assert.equal(selfhost, remoteManagedSkillId('demo', listing, spaceId))
  assert.ok(remoteManagedSkillId('a'.repeat(128), listing, spaceId).length <= 128)
  const skill = { serverId: listing, serverOwnerId: 'author', name: 'demo', version: '0.1.0', marketplaceStatus: 'approved', marketplacePackageSha256: 'b'.repeat(64), labels: [], envDeps: [], compatibleAgents: [] } as unknown as LocalSkill
  const imported = await acquireMarketplaceSkill(skill, {
    spaceId,
    // Rust local_view hides another space's server identity.
    localSkills: async () => [{ ...skill, id: official, serverId: undefined, localPath: '/official' }],
    download: async () => ({ base64: 'zip', sha256: 'b'.repeat(64), version: '0.1.0' }),
    importPackage: async input => {
      assert.equal(input.skillId, selfhost)
      assert.equal(input.catalogOrigin, OFFICIAL_ENDPOINTS.catalogOrigin.replace(/\/+$/, ''))
      assert.equal(input.isOwn, false)
      return { ...skill, id: input.skillId, localPath: '/selfhost' }
    },
  })
  assert.equal(imported.id, selfhost)
})

test('legacy long catalog folder IDs are reused for repeat installs and updates', async () => {
  const spaceId = `selfhost-${'a'.repeat(64)}`
  const legacyId = `demo--111111111111-${spaceId}`
  const installed = { id: legacyId, serverId: listing, serverOwnerId: 'author', name: 'demo',
    version: '0.1.0', acquisitionVersion: '0.1.0', acquisitionSource: 'marketplace',
    catalogOrigin: OFFICIAL_ENDPOINTS.catalogOrigin.replace(/\/+$/, ''), localPath: '/legacy',
    marketplaceStatus: 'approved', marketplacePackageSha256: 'b'.repeat(64),
    sharedTo: {}, envDeps: [], compatibleAgents: [] } as unknown as LocalSkill
  const next = { ...installed, id: `market:${listing}`, localPath: undefined, version: '0.1.1' }
  let downloads = 0
  const dependencies = {
    spaceId,
    localSkills: async (): Promise<LocalSkill[]> => [installed],
    download: async () => {
      downloads += 1
      return { base64: 'zip', sha256: 'b'.repeat(64), version: '0.1.1' }
    },
    importPackage: async (input: Parameters<Parameters<typeof acquireMarketplaceSkill>[1]['importPackage']>[0]) => {
      assert.equal(input.skillId, legacyId)
      assert.equal(input.replaceExistingMarketplace, true)
      return { ...installed, version: input.version! }
    },
  }
  assert.equal(await acquireMarketplaceSkill(next, dependencies), installed)
  assert.equal(downloads, 0)
  assert.equal((await acquireMarketplaceSkill(next, dependencies, true)).id, legacyId)
  assert.equal(downloads, 1)
})
