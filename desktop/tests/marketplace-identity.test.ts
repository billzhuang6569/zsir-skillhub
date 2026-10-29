import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  replaceSkillAcrossSources,
} from '../src/lib/skills.ts'
import type { LocalSkill } from '../src/store/index.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const detailSource = readFileSync(resolve(desktopRoot, 'src/components/SkillDetailSheet.tsx'), 'utf8')
const cardSource = readFileSync(resolve(desktopRoot, 'src/components/SkillCard.tsx'), 'utf8')
const keysSource = readFileSync(resolve(desktopRoot, 'src/components/SkillKeys.tsx'), 'utf8')
const storeSource = readFileSync(resolve(desktopRoot, 'src/store/index.ts'), 'utf8')

function skill(overrides: Partial<LocalSkill> = {}): LocalSkill {
  return {
    id: 'profile-auditor--019f9d243624',
    name: 'profile-auditor',
    displayName: 'SkillHub Profile 审计',
    labels: ['Profile', '审计'],
    version: '1.0.0',
    latestVersion: '1.0.0',
    installCount: 18,
    sources: ['本机创建'],
    agents: { codex: 'on' },
    installed: true,
    isOwn: true,
    acquisitionSource: 'local',
    envDeps: [],
    sharedTo: {},
    versions: [],
    compatibleAgents: ['codex'],
    localPath: '/tmp/profile-auditor--019f9d243624',
    serverId: '019f9d24-3624-7be0-917f-a9b197c2cde7',
    serverOwnerId: 'author-1',
    ...overrides,
  }
}

test('an installed listing keeps a separate Marketplace identity and public detail source', () => {
  const local = skill()
  const catalog = skill({
    id: `market:${local.serverId}`,
    marketplaceLocalId: local.id,
    sources: ['Skill 商店'],
    acquisitionSource: 'marketplace',
    visibility: 'public',
    marketplaceStatus: 'approved',
    marketplaceSkillMd: '# Immutable public snapshot',
  })

  assert.notEqual(catalog.id, local.id)
  assert.equal(catalog.marketplaceLocalId, local.id)
  assert.equal([local].find((item) => item.id === catalog.id), undefined)
  assert.equal([catalog].find((item) => item.id === catalog.id)?.marketplaceSkillMd, '# Immutable public snapshot')
})

test('a Marketplace download adds one real local asset without replacing the catalog card', () => {
  const catalog = skill({
    id: 'market:019f9d24-3624-7be0-917f-a9b197c2cde7',
    localPath: '',
    agents: { codex: null },
    installed: false,
    isOwn: true,
    sources: ['Skill 商店'],
    acquisitionSource: 'marketplace',
    visibility: 'public',
    marketplaceStatus: 'approved',
  })
  const downloaded = skill({
    isOwn: true,
    sources: ['Skill 商店'],
    acquisitionSource: 'marketplace',
  })

  const state = replaceSkillAcrossSources([], [catalog], catalog.id, downloaded)

  assert.equal(state.skills.length, 1)
  assert.equal(state.skills[0]?.id, downloaded.id)
  assert.equal(state.skills[0]?.isOwn, true)
  assert.equal(state.marketplaceSkills[0]?.id, catalog.id)
  assert.equal(state.marketplaceSkills[0]?.marketplaceLocalId, downloaded.id)
  assert.equal(state.marketplaceSkills[0]?.isOwn, true)
  assert.equal(state.nextSkillId, catalog.id)
})

test('account session changes downgrade local and catalog Marketplace authorization first', () => {
  assert.match(
    storeSource,
    /setAuthSession:[\s\S]*?skills: sameSession \? shareList\(state.skills, state\.skills\.map\(skill => skillForAvatarAccount\(skill, currentUser.id\)\), skill => skill.id\) : \[\],[\s\S]*?marketplaceSkills: state\.marketplaceSkills\.map\(downgradeMarketplaceAuthorization\)/,
  )
  assert.match(
    storeSource,
    /clearAuthSession:[\s\S]*?skills: state\.skills[\s\S]*?\.map\(skill => skillForAvatarAccount\(skill\)\),[\s\S]*?marketplaceSkills: state\.marketplaceSkills\.map\(downgradeMarketplaceAuthorization\)/,
  )
})

test('Marketplace filesystem actions route through the real managed-folder id', () => {
  assert.match(detailSource, /localManagedSkillId\(skill\)/)
  assert.match(detailSource, /preflightLocalId = skill\.marketplaceReplacementLocalId[\s\S]*?preflightInstallSkill\(preflightLocalId, selectedAgents\)/)
  assert.match(detailSource, /uninstallSkill\(managedSkillId\)/)
  assert.match(detailSource, /openSkillDir\(managedSkillId\)/)
  assert.match(keysSource, /const managedSkillId = managedKeySkillId\(skill\)/)
  assert.match(keysSource, /return skill\.marketplaceLocalId \?\? skill\.id/)
  assert.match(keysSource, /getSkillEnvSourcePolicy\(managedSkillId/)
  assert.match(cardSource, /const managedSkillId = skill\.marketplaceLocalId \?\? skill\.id/)
  assert.match(cardSource, /disableSkill\(managedSkillId, agent\.key\)/)
})

test('Marketplace updates require the fixed Listing checksum and an explicit recoverable replacement', () => {
  assert.match(detailSource, /skill\.marketplacePackageSha256/)
  assert.match(detailSource, /packageData\.sha256\.toLowerCase\(\)/)
  assert.match(detailSource, /packageData\.version !== skill\.version/)
  assert.match(detailSource, /replaceExistingMarketplace: marketplaceInstall/)
  assert.match(detailSource, /marketplaceReplacementLocalId/)
  assert.match(detailSource, /rollbackMarketplaceReplacement\(replacementRecoveryId\)/)
  assert.match(
    detailSource,
    /replacementRecoveryId\s*&& plan\.sources\.length > 0\s*&& \(!installPreflight \|\| !sameAgentPreflightState\(installPreflight, plan\)\)[\s\S]*?rollbackMarketplaceReplacement\(replacementRecoveryId\)[\s\S]*?setInstallPreflight\(plan\)[\s\S]*?setInstallStep\('confirm'\)/,
  )
  assert.match(detailSource, /现有 Skill 和 Agent 投影不会变化/)
})
