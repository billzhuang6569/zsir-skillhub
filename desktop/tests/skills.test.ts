import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  commentScopeTeamId, detachStaleServerBinding, isSkillSharedWithActiveTeam,
  resolveRemoteSkillBinding,
} from '../src/lib/ui-helpers.ts'
import {
  findLocalSkillByManagedId, hydrateDownloadedSkill, mergeMarketplaceSkill, mergeSkillSources, mergeApiSkill,
  remoteManagedSkillId,
} from '../src/lib/skills.ts'
import { deleteScopeFor, syncedToAccount } from '../src/lib/library-sync.ts'

test('managed IDs match the shared Rust/TypeScript vectors', () => {
  const cases: { name: string; serverId: string; spaceId: string; expected: string | null }[] =
    JSON.parse(readFileSync(new URL('./fixtures/remote-managed-skill-ids.json', import.meta.url), 'utf8'))
  for (const item of cases) {
    const generate = (): string => remoteManagedSkillId(item.name, item.serverId, item.spaceId)
    if (item.expected === null) assert.throws(generate, item.spaceId)
    else assert.equal(generate(), item.expected, item.spaceId)
  }
})

function localSkill() {
  return {
    id: 'local-1',
    name: 'research-skill',
    displayName: '研究 Skill',
    labels: [],
    version: 'v1.0',
    latestVersion: 'v1.0',
    installCount: 0,
    sources: ['本机创建'],
    agents: {},
    installed: false,
    isOwn: true,
    acquisitionSource: 'local' as const,
    envDeps: [],
    sharedTo: { 'old-team': { version: 'v1.0', envShared: true } },
    versions: [],
    localPath: '/tmp/research-skill',
    serverId: 'old-account-skill-id',
  }
}

test('team update keeps installed keys and compares immutable IDs, including local edits', () => {
  const local = { ...localSkill(), acquisitionSource: 'team' as const, acquiredByUserId: 'member', sourceVersionId: 'old', sourceLocalModified: true,
    envDeps: [{ key: 'OLD_KEY', required: true, configured: true, sharePolicy: 'none' as const, sharedTeams: [] }],
  }
  const remote = { id: local.serverId, name: local.name, displayName: local.displayName, labels: [], triggerScenarios: [], compatibleAgents: [],
    currentVersion: '0.1.1', teamVersionId: 'new', authorId: 'author', installCount: 1, visibility: 'team', marketplaceStatus: 'none', createdAt: '', updatedAt: '',
    envDependencies: [{ key: 'NEW_KEY', required: true }],
  }
  const merged = mergeApiSkill(remote, local, 'team-a', 'member')
  assert.deepEqual(merged.envDeps, local.envDeps)
  assert.equal(merged.teamEnvDeps?.[0].key, 'NEW_KEY')
  assert.equal(merged.teamUpdateStatus, 'local_modified')
  assert.equal(mergeApiSkill({ ...remote, teamVersionId: 'old' }, local, 'team-a', 'member').teamUpdateStatus, 'up_to_date')
  assert.equal(mergeApiSkill(remote, local, 'team-a', 'other').teamUpdateStatus, 'account_mismatch')
  const syncedTeamLocal = { ...local, acquiredByUserId: undefined, libraryAccountId: 'member' }
  assert.equal(mergeApiSkill(remote, syncedTeamLocal, 'team-a', 'member').teamUpdateStatus, 'local_modified')
  assert.equal(mergeApiSkill(remote, { ...syncedTeamLocal, libraryAccountId: 'other' }, 'team-a', 'member').teamUpdateStatus, 'account_mismatch')
  assert.equal(mergeApiSkill(remote, undefined, 'team-a', 'member').teamUpdateStatus, undefined)
})

test('withdrawn source keeps local content and does not switch to another team implicitly', () => {
  const local = { ...localSkill(), isOwn: false, acquisitionSource: 'team' as const, teamSharedFrom: 'team-a' }
  const [merged] = mergeSkillSources([local], [], { accountUserId: 'member', activeTeamId: null, membershipsValidated: true, teamSources: [] })
  assert.equal(merged.teamUnshared, true)
  assert.equal(merged.serverId, local.serverId)
  assert.equal(merged.localPath, local.localPath)
  assert.equal(merged.teamUpdateStatus, 'access_revoked')
})

test('remote assets with the same name receive distinct deterministic local ids', () => {
  const first = remoteManagedSkillId('shared-skill', '019f9d24-3624-7be0-917f-a9b197c2cde7')
  const second = remoteManagedSkillId('shared-skill', '019f9d24-37d5-74b2-8468-0841d6bac0da')
  assert.equal(first, 'shared-skill--019f9d243624')
  assert.equal(remoteManagedSkillId('shared-skill', '019f9d24-3624-7be0-917f-a9b197c2cde7'), first)
  assert.notEqual(first, second)
})

test('local refresh resolves downloaded assets by managed id instead of Agent-facing name', () => {
  const first = { ...localSkill(), id: 'shared-skill--019f9d243624', name: 'shared-skill' }
  const second = { ...localSkill(), id: 'shared-skill--019f9d2437d5', name: 'shared-skill' }

  assert.equal(findLocalSkillByManagedId([first, second], second.id), second)
  assert.equal(findLocalSkillByManagedId([first, second], second.name), undefined)
})

test('remote local ids remain portable and within the Rust id limit', () => {
  const id = remoteManagedSkillId('a'.repeat(128), '019f9d24-3624-7be0-917f-a9b197c2cde7')
  assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  assert.equal(id.length, 128)
})

test('remote local ids reject invalid names and non-UUID server ids', () => {
  assert.throws(() => remoteManagedSkillId('../escape', '019f9d24-3624-7be0-917f-a9b197c2cde7'))
  assert.throws(() => remoteManagedSkillId('safe-name', 'not-a-uuid'))
})

test('downloading an owner-shared Skill keeps its team identity and catalog metadata', () => {
  const remote = {
    ...localSkill(),
    id: 'server:019f9d24-3624-7be0-917f-a9b197c2cde7',
    localPath: '',
    serverId: '019f9d24-3624-7be0-917f-a9b197c2cde7',
    serverOwnerId: 'owner-1',
    installCount: 27,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-03T10:00:00.000Z',
    envDeps: [{ key: 'TOKEN', required: true, configured: false, sharePolicy: 'team' as const }],
    sharedTo: { 'team-1': { version: 'v1.0', envShared: true } },
  }
  const imported = {
    ...localSkill(),
    id: 'research-skill--019f9d243624',
    localPath: '/tmp/research-skill--019f9d243624',
    installCount: 0,
    sharedTo: {},
    envDeps: [],
  }

  const hydrated = hydrateDownloadedSkill(remote, imported)

  assert.equal(hydrated.id, imported.id)
  assert.equal(hydrated.localPath, imported.localPath)
  assert.equal(hydrated.installCount, 27)
  assert.deepEqual(hydrated.sharedTo, remote.sharedTo)
  assert.deepEqual(hydrated.envDeps, remote.envDeps)
  assert.equal(hydrated.createdAt, remote.createdAt)
  assert.equal(hydrated.updatedAt, remote.updatedAt)
  assert.equal(isSkillSharedWithActiveTeam(hydrated, 'team-1'), true)
})

test('Marketplace metadata hydrates local state without reusing Team or personal remote ids', () => {
  const item = {
    id: '019f9d24-3624-7be0-917f-a9b197c2cde7',
    name: 'profile-auditor',
    displayName: 'SkillHub Profile 审计',
    description: '检查 SkillHub Profile 与 ZIP 导入链路',
    category: '自动化与集成',
    labels: ['Profile', 'ZIP', '审计'],
    triggerScenarios: ['审计 ZIP 导入'],
    compatibleAgents: ['codex', 'claude'],
    envDependencies: [],
    currentVersion: '1.0.0',
    author: { id: 'author-1', displayName: '一探团队', avatarUrl: null },
    version: {
      id: 'version-1', version: '1.0.0', changelog: '首次发布',
      packageSha256: 'a'.repeat(64), packageSize: 512,
      createdAt: '2026-08-03T00:00:00.000Z',
    },
    downloadCount: 18,
    publishedAt: '2026-08-03T01:00:00.000Z',
    skillMd: '# SkillHub Profile 审计',
  }

  const remote = mergeMarketplaceSkill(item, undefined, 'viewer-1')
  assert.equal(remote.id, `market:${item.id}`)
  assert.equal(remote.serverId, item.id)
  assert.equal(remote.isOwn, false)
  assert.equal(remote.acquisitionSource, 'marketplace')
  assert.deepEqual(remote.sources, ['Skill 商店'])
  assert.equal(remote.installCount, 18)
  assert.equal(remote.marketplaceSkillMd, item.skillMd)
  assert.equal(remote.authorName, '一探团队')
  assert.equal(remote.marketplaceStatus, 'approved')
  assert.equal(remote.marketplaceFeatured, false)
  assert.deepEqual(remote.marketplaceEditorialLabels, [])
  const curated = mergeMarketplaceSkill({ ...item, featured: true, editorialLabels: ['效率工具'] }, undefined, 'viewer-1')
  assert.equal(curated.marketplaceFeatured, true)
  assert.deepEqual(curated.marketplaceEditorialLabels, ['效率工具'])
  assert.deepEqual(curated.labels, item.labels)

  const local = {
    ...localSkill(), serverId: item.id, serverOwnerId: 'author-1',
    version: '1.0.0', latestVersion: '1.0.0',
    acquisitionSource: 'marketplace' as const, sources: ['Skill 商店'],
    acquisitionPackageSha256: 'a'.repeat(64),
  }
  const hydrated = mergeMarketplaceSkill(item, local, 'author-1')
  assert.equal(hydrated.id, `market:${item.id}`)
  assert.equal(hydrated.marketplaceLocalId, local.id)
  assert.equal(hydrated.localPath, local.localPath)
  assert.equal(hydrated.isOwn, false)
  assert.equal(hydrated.marketplaceVersionId, 'version-1')
  assert.equal(hydrated.acquisitionSource, 'marketplace')
  assert.deepEqual(hydrated.sources, ['Skill 商店'])
})

test('Marketplace retains real local identity and Agent states independently of package reuse', () => {
  const item = {
    id: '019f9d24-3624-7be0-917f-a9b197c2cde7',
    name: 'profile-auditor',
    displayName: 'Profile Auditor',
    description: 'Audit profiles',
    category: '开发与工程',
    labels: ['测试验证'],
    triggerScenarios: [],
    compatibleAgents: ['codex'],
    envDependencies: [],
    currentVersion: 'v2.0.0',
    author: { id: 'author-1', displayName: 'Author', avatarUrl: null },
    version: {
      id: 'version-2', version: 'v2.0.0', changelog: 'approved',
      packageSha256: 'b'.repeat(64), packageSize: 512,
      createdAt: '2026-08-03T00:00:00.000Z',
    },
    downloadCount: 3,
    publishedAt: '2026-08-03T01:00:00.000Z',
    skillMd: '# Profile Auditor',
  }
  const exact = {
    ...localSkill(),
    id: 'profile-auditor--019f9d243624',
    serverId: item.id,
    version: 'v2.0.0',
    latestVersion: 'v2.0.0',
    acquisitionSource: 'marketplace' as const,
    acquisitionPackageSha256: 'b'.repeat(64),
    hasWorkingCopy: false,
    versions: [{ version: 'v2.0.0 · 从 Skill 商店导入', date: 'today' }],
  }
  const reusable = mergeMarketplaceSkill(item, exact, 'viewer')
  assert.equal(reusable.marketplaceLocalId, exact.id)
  assert.equal(reusable.marketplaceReplacementLocalId, undefined)
  assert.equal(reusable.localPath, exact.localPath)

  for (const changed of [
    { ...exact, acquisitionSource: 'team' as const },
    { ...exact, acquisitionPackageSha256: 'c'.repeat(64) },
    { ...exact, version: 'v1.0.0' },
    { ...exact, hasWorkingCopy: true },
    { ...exact, versions: [
      { version: 'v2.0.0', date: 'today' },
      { version: 'v1.0.0', date: 'yesterday' },
    ] },
  ]) {
    const catalog = mergeMarketplaceSkill(item, changed, 'viewer')
    assert.equal(catalog.marketplaceLocalId, exact.id)
    assert.equal(catalog.marketplaceReplacementLocalId, undefined)
    assert.equal(catalog.localPath, exact.localPath)
    assert.deepEqual(catalog.agents, changed.agents)
    assert.equal(catalog.marketplaceLocalVersion, changed.version)
    assert.equal(catalog.version, 'v2.0.0')
    assert.equal(catalog.marketplacePackageSha256, 'b'.repeat(64))
  }
})

test('account B cannot inherit account A author rights from a Marketplace sidecar', () => {
  const local = {
    ...localSkill(),
    serverId: '019f9d24-3624-7be0-917f-a9b197c2cde7',
    serverOwnerId: 'author-1',
    isOwn: true,
    acquisitionSource: 'marketplace' as const,
    sources: ['Skill 商店'],
    teamSharedFrom: 'team-from-account-a',
    sharedTo: { 'team-from-account-a': { version: 'v1.0', envShared: true } },
  }

  const [merged] = mergeSkillSources([local], [], {
    activeTeamId: null,
    // My Skills can finish the protected owned request before team membership
    // data is loaded. Cached author rights must already fail closed here.
    membershipsValidated: false,
    teamSources: [],
  })

  assert.equal(merged.serverId, local.serverId)
  assert.equal(merged.serverOwnerId, local.serverOwnerId)
  assert.equal(merged.isOwn, false)
  assert.equal(merged.acquisitionSource, 'marketplace')
  assert.equal(merged.teamSharedFrom, undefined)
  assert.deepEqual(merged.sharedTo, {})
  assert.equal(merged.accountSyncRequired, undefined)
})

test('an owned API response restores author rights after a Marketplace restart', () => {
  const local = {
    ...localSkill(),
    serverId: '019f9d24-3624-7be0-917f-a9b197c2cde7',
    serverOwnerId: 'author-1',
    isOwn: false,
    acquisitionSource: 'marketplace' as const,
    sources: ['Skill 商店'],
    versionProblem: '本机版本维护忙，请稍后重试',
  }
  const owned = {
    id: local.serverId,
    name: local.name,
    displayName: local.displayName,
    labels: [],
    triggerScenarios: [],
    compatibleAgents: ['codex'],
    envDependencies: [],
    currentVersion: 'v1.0',
    installCount: 0,
    authorId: 'author-1',
    visibility: 'public',
    marketplaceStatus: 'approved',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  }

  const [merged] = mergeSkillSources([local], [owned], {
    activeTeamId: null,
    membershipsValidated: true,
    teamSources: [],
  })

  assert.equal(merged.isOwn, true)
  assert.equal(merged.acquisitionSource, 'marketplace')
  assert.equal(merged.serverOwnerId, 'author-1')
  assert.equal(merged.versionProblem, local.versionProblem)
})

test('Marketplace package hydration keeps store and sidecar provenance separate from Team ownership', () => {
  const remote = {
    ...localSkill(),
    id: 'market:019f9d24-3624-7be0-917f-a9b197c2cde7',
    localPath: '',
    sources: ['Skill 商店'],
    acquisitionSource: 'marketplace' as const,
    isOwn: false,
    teamSharedFrom: undefined,
  }
  const imported = {
    ...localSkill(),
    id: 'profile-auditor--019f9d243624',
    localPath: '/tmp/profile-auditor--019f9d243624',
    sources: ['Skill 商店'],
    acquisitionSource: 'marketplace' as const,
    isOwn: false,
  }

  const hydrated = hydrateDownloadedSkill(remote, imported)
  assert.equal(hydrated.acquisitionSource, 'marketplace')
  assert.deepEqual(hydrated.sources, ['Skill 商店'])
  assert.equal(hydrated.isOwn, false)
  assert.equal(hydrated.teamSharedFrom, undefined)
})

test('a local Skill never reuses another account server id or team shares', () => {
  const skill = detachStaleServerBinding(localSkill())
  assert.equal(skill.serverId, undefined)
  assert.equal(skill.accountSyncRequired, true)
  assert.equal(skill.teamSharedFrom, undefined)
  assert.deepEqual(skill.sharedTo, {})
  assert.equal(skill.localPath, '/tmp/research-skill')
})

test('stale ids never fall through to same-name owned or team Skills', () => {
  const local = { name: 'same-name', serverId: 'old-id' }
  assert.deepEqual(resolveRemoteSkillBinding(local, [{ id: 'new-own-id', name: 'same-name' }], []), { kind: 'stale' })
  assert.deepEqual(resolveRemoteSkillBinding(local, [], [{ id: 'new-team-id', name: 'same-name' }]), { kind: 'stale' })
})

test('exact server ids bind to the correct current account source', () => {
  const owned = { id: 'owned-id', name: 'owned-name' }
  const team = { id: 'team-id', name: 'team-name' }
  assert.deepEqual(resolveRemoteSkillBinding({ name: 'ignored', serverId: 'owned-id' }, [owned], [team]), { kind: 'owned', skill: owned })
  assert.deepEqual(resolveRemoteSkillBinding({ name: 'ignored', serverId: 'team-id' }, [owned], [team]), { kind: 'team', skill: team })
})

test('local Skills without ids never reconnect by name', () => {
  const owned = { id: 'owned-id', name: 'legacy-name' }
  const team = { id: 'team-id', name: 'legacy-name' }
  assert.deepEqual(resolveRemoteSkillBinding({ name: 'legacy-name' }, [owned], [team]), { kind: 'none' })
})

test('a downloaded team Skill keeps its exact server binding for a non-author member', () => {
  const local = {
    ...localSkill(),
    serverId: 'shared-skill-id',
    serverOwnerId: 'author-user',
    teamSharedFrom: 'team-1',
    isOwn: false,
  }
  const shared = {
    id: 'shared-skill-id',
    name: 'research-skill',
    displayName: '团队研究 Skill',
    description: '共享给团队成员',
    category: '搜索与研究',
    labels: [],
    triggerScenarios: [],
    compatibleAgents: ['codex'],
    currentVersion: 'v1.1',
    installCount: 2,
    authorId: 'author-user',
    visibility: 'private',
    marketplaceStatus: 'none',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  }

  const [merged] = mergeSkillSources([local], [], {
    activeTeamId: null,
    membershipsValidated: true,
    teamSources: [{ teamId: 'team-1', skills: [shared] }],
  })
  assert.equal(merged.serverId, 'shared-skill-id')
  assert.equal(merged.serverOwnerId, 'author-user')
  assert.equal(merged.teamSharedFrom, 'team-1')
  assert.equal(merged.accountSyncRequired, undefined)
})

test('switching to another team does not detach an inactive team Skill', () => {
  const local = {
    ...localSkill(),
    serverId: 'shared-skill-id',
    serverOwnerId: 'author-user',
    teamSharedFrom: 'team-1',
    isOwn: false,
  }
  const shared = {
    id: 'shared-skill-id',
    name: 'research-skill',
    displayName: '团队研究 Skill',
    labels: [],
    triggerScenarios: [],
    compatibleAgents: ['codex'],
    currentVersion: 'v1.1',
    installCount: 2,
    authorId: 'author-user',
    visibility: 'private',
    marketplaceStatus: 'none',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  }

  const merged = mergeSkillSources([local], [], {
    activeTeamId: 'team-2',
    membershipsValidated: true,
    teamSources: [
      { teamId: 'team-1', skills: [shared] },
      { teamId: 'team-2', skills: [] },
    ],
  })
  assert.equal(merged[0]?.serverId, 'shared-skill-id')
  assert.equal(merged[0]?.teamSharedFrom, 'team-1')
  assert.equal(merged[0]?.accountSyncRequired, undefined)
  assert.equal(merged.length, 1)
})

test('the active team scopes a Skill shared through multiple memberships', () => {
  const local = {
    ...localSkill(),
    serverId: 'shared-skill-id',
    serverOwnerId: 'author-user',
    teamSharedFrom: 'team-1',
    isOwn: false,
  }
  const shared = {
    id: 'shared-skill-id',
    name: 'research-skill',
    displayName: '多团队共享 Skill',
    labels: [],
    triggerScenarios: [],
    compatibleAgents: ['codex'],
    currentVersion: 'v1.1',
    installCount: 2,
    authorId: 'author-user',
    visibility: 'private',
    marketplaceStatus: 'none',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  }

  const [merged] = mergeSkillSources([local], [], {
    activeTeamId: 'team-2',
    membershipsValidated: true,
    teamSources: [
      { teamId: 'team-1', skills: [shared] },
      { teamId: 'team-2', skills: [shared] },
    ],
  })

  assert.equal(merged.teamSharedFrom, 'team-2')
  assert.equal(isSkillSharedWithActiveTeam(merged, 'team-2'), true)
  assert.equal(commentScopeTeamId(merged, 'team-2'), 'team-2')
})

test('a failed inactive-team request preserves an unverified local binding', () => {
  const local = {
    ...localSkill(),
    serverId: 'shared-skill-id',
    teamSharedFrom: 'team-1',
    isOwn: false,
  }
  const [merged] = mergeSkillSources([local], [], {
    activeTeamId: 'team-2',
    membershipsValidated: true,
    teamSources: [
      { teamId: 'team-1', skills: null },
      { teamId: 'team-2', skills: [] },
    ],
  })
  assert.equal(merged.serverId, 'shared-skill-id')
  assert.equal(merged.accountSyncRequired, undefined)
})

test('an account switch detaches a server id that is not visible to the current user', () => {
  const local = {
    ...localSkill(),
    serverId: 'old-account-skill-id',
    serverOwnerId: 'old-account-user',
  }
  const sameNameButDifferentId = {
    id: 'new-account-skill-id',
    name: 'research-skill',
    displayName: '新账号 Skill',
    labels: [],
    triggerScenarios: [],
    compatibleAgents: [],
    currentVersion: 'v1.0',
    installCount: 0,
    authorId: 'new-account-user',
    visibility: 'private',
    marketplaceStatus: 'none',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  }

  const [merged] = mergeSkillSources(
    [local],
    [sameNameButDifferentId],
    {
      activeTeamId: null,
      membershipsValidated: true,
      teamSources: [],
    },
  )
  assert.equal(merged.serverId, undefined)
  assert.equal(merged.accountSyncRequired, true)
  assert.deepEqual(merged.sharedTo, {})
})

test('My Skills detaches a stale personal binding without waiting for Team catalogs', () => {
  const local = {
    ...localSkill(),
    serverId: 'old-account-skill-id',
    serverOwnerId: 'old-account-user',
    isOwn: true,
  }

  const [merged] = mergeSkillSources([local], [], {
    activeTeamId: null,
    membershipsValidated: false,
    teamSources: [],
  })

  assert.equal(merged.serverId, undefined)
  assert.equal(merged.accountSyncRequired, true)
  assert.deepEqual(merged.sharedTo, {})
})

test('My Skills preserves an unvalidated downloaded Team binding', () => {
  const local = {
    ...localSkill(),
    serverId: 'team-skill-id',
    serverOwnerId: 'team-author',
    isOwn: false,
    teamSharedFrom: 'team-1',
  }

  const [merged] = mergeSkillSources([local], [], {
    activeTeamId: null,
    membershipsValidated: false,
    teamSources: [],
  })

  assert.equal(merged.serverId, 'team-skill-id')
  assert.equal(merged.teamSharedFrom, 'team-1')
  assert.equal(merged.accountSyncRequired, undefined)
  assert.equal(merged.serverAccessValidatedForUserId, undefined)
})

test('authenticated Team reconciliation binds remote access to the current account', () => {
  const local = {
    ...localSkill(),
    serverId: '22222222-2222-4222-8222-222222222222',
    serverOwnerId: 'team-author',
    isOwn: false,
    acquisitionSource: 'team' as const,
    teamSharedFrom: 'team-1',
  }
  const remote = {
    id: local.serverId,
    name: local.name,
    displayName: local.displayName,
    labels: [],
    triggerScenarios: [],
    compatibleAgents: ['codex'],
    envDependencies: [],
    currentVersion: 'v1.0',
    installCount: 0,
    authorId: 'team-author',
    visibility: 'team',
    marketplaceStatus: 'none',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  }

  const [merged] = mergeSkillSources([local], [], {
    accountUserId: 'current-user',
    activeTeamId: 'team-1',
    membershipsValidated: true,
    teamSources: [{ teamId: 'team-1', skills: [remote] }],
  })

  assert.equal(merged.serverAccessValidatedForUserId, 'current-user')
})

test('owned and team merges keep the account-library binding, so delete and hand-off stay account-scoped (#91)', () => {
  const account = '6f1c2a10-0000-4000-8000-0000000000aa'
  const remote = (id: string, authorId: string) => ({
    id,
    name: 'research-skill',
    displayName: '研究 Skill',
    labels: [],
    triggerScenarios: [],
    compatibleAgents: ['codex'],
    currentVersion: 'v1.1',
    installCount: 0,
    authorId,
    visibility: 'private',
    marketplaceStatus: 'none',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  })
  const context = { accountUserId: account, activeTeamId: null, membershipsValidated: true, teamSources: [] }
  const scope = (skill: { libraryAccountId?: string | null; libraryEntryId?: string | null }) =>
    deleteScopeFor({ signedInUserId: account, syncEnabled: true, online: true, skill })

  // An imported Skill registered as the user's own asset (the AI/asset flow).
  const owned = remote('owned-id', account)
  const bound = { ...localSkill(), serverId: 'owned-id', libraryAccountId: account, libraryEntryId: 'entry-1' }
  const [mergedOwned] = mergeSkillSources([bound], [owned], context)
  assert.equal(mergedOwned.isOwn, true)
  assert.equal(mergedOwned.libraryAccountId, account)
  assert.equal(mergedOwned.libraryEntryId, 'entry-1')
  assert.deepEqual(scope(mergedOwned), { kind: 'account', available: true })
  assert.equal(syncedToAccount(mergedOwned, account), true, '"交给工具自行管理" keeps it managed')
  // A page refresh merges the already merged list again.
  const [refreshed] = mergeSkillSources([mergedOwned], [owned], context)
  assert.deepEqual(scope(refreshed), { kind: 'account', available: true })

  // A team Skill this account obtained: still account-scoped, never "own".
  const teamLocal = {
    ...localSkill(),
    serverId: 'team-skill-id',
    serverOwnerId: 'author-user',
    teamSharedFrom: 'team-1',
    acquisitionSource: 'team' as const,
    isOwn: false,
    libraryAccountId: account,
    libraryEntryId: 'entry-2',
  }
  const [mergedTeam] = mergeSkillSources([teamLocal], [], {
    ...context,
    teamSources: [{ teamId: 'team-1', skills: [remote('team-skill-id', 'author-user')] }],
  })
  assert.equal(mergedTeam.isOwn, false, 'a binding never grants author rights')
  assert.equal(mergedTeam.teamSharedFrom, 'team-1')
  assert.deepEqual(scope(mergedTeam), { kind: 'account', available: true })
  assert.equal(syncedToAccount(mergedTeam, account), true)

  // Not bound, or bound to another account: this computer's recycle bin.
  const [unbound] = mergeSkillSources([{ ...localSkill(), serverId: 'owned-id' }], [owned], context)
  assert.equal(scope(unbound).kind, 'device')
  const [otherAccount] = mergeSkillSources(
    [{ ...bound, libraryAccountId: 'bbbbbbbb-0000-4000-8000-0000000000bb' }], [owned], context,
  )
  const decision = scope(otherAccount)
  assert.ok(decision.kind === 'device' && decision.note.includes('重新下载'))
  assert.equal(syncedToAccount(otherAccount, account), false)
})

test('team merges carry the author and who shared it; owned merges clear sharedBy (#295)', () => {
  const apiSkill = {
    id: '019f9d24-3624-7be0-917f-a9b197c2cde7',
    name: 'seedance-prompt',
    displayName: '视频提示词',
    labels: [],
    triggerScenarios: [],
    compatibleAgents: [],
    currentVersion: '0.3.1',
    installCount: 3,
    authorId: 'u-author',
    visibility: 'team',
    marketplaceStatus: 'none',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    author: { id: 'u-author', displayName: '作者', avatarUrl: null },
    sharedBy: { id: 'u-li', displayName: '李雷', avatarUrl: 'https://example.test/li.png' },
    sharedAt: '2026-10-11T00:00:00.000Z',
  }
  const [team] = mergeSkillSources([], null, {
    accountUserId: 'u-me',
    activeTeamId: 'team-1',
    membershipsValidated: true,
    teamSources: [{ teamId: 'team-1', skills: [apiSkill] }],
  })
  assert.equal(team?.teamSharedFrom, 'team-1')
  assert.equal(team?.authorName, '作者')
  assert.deepEqual(team?.sharedBy, { id: 'u-li', displayName: '李雷', avatarUrl: 'https://example.test/li.png' })
  assert.equal(team?.sharedAt, '2026-10-11T00:00:00.000Z')
  assert.equal(team?.latestVersion, '0.3.1')
  const [owned] = mergeSkillSources([], [apiSkill], { accountUserId: 'u-author', activeTeamId: null, membershipsValidated: true, teamSources: [] })
  assert.equal(owned?.sharedBy, undefined)
  assert.equal(owned?.authorName, '作者')
})
