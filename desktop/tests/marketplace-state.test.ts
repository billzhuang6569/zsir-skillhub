import assert from 'node:assert/strict'
import test from 'node:test'
import { compareSkillVersions, marketplaceAction } from '../src/lib/marketplace-state.ts'
import { acquireMarketplaceSkill } from '../src/lib/marketplace-acquisition.ts'
import type { LocalSkill } from '../src/store/index.ts'

test('version ordering handles prefixes, numeric segments and prereleases without suggesting downgrades', () => {
  for (const [a, b, result] of [['v1.0.0','1.0.0',0], ['1.10.0','1.9.0',1], ['1.0.0','1.0.0-rc.2',1], ['1.0.0-rc.10','1.0.0-rc.2',1], ['1.0.0-alpha','1.0.0-beta',-1], ['1.0.0+build','1.0.0',0], ['bad','1.0.0',null], ['1.0.0-01','1.0.0',null]] as const) assert.equal(compareSkillVersions(a,b),result)
})
test('card and details agree on membership and upgrade state', () => {
  const local = { marketplaceLocalId: 'local', localPath: '/local', marketplaceLocalVersion: '1.0.0', version: '1.0.0' } as LocalSkill
  assert.equal(marketplaceAction({ ...local, marketplaceLocalVersion: '1.0.0-personal.1' }).label, '已加入我的 Skills')
  assert.equal(marketplaceAction(local).label, '已加入我的 Skills')
  assert.equal(marketplaceAction({ ...local, version: '1.1.0' }).label, '更新')
  assert.equal(marketplaceAction({ ...local, version: '0.9.0' }).update, false)
  assert.equal(marketplaceAction({ ...local, localPath: '', marketplaceLocalId: undefined }).label, '加入我的 Skills')
})
test('explicit update uses stable local folder and approved package, repeated update does not download', async () => {
  const skill = { id:'market:id', serverId:'id',serverOwnerId:'author',marketplaceStatus:'approved',marketplacePackageSha256:'a'.repeat(64),version:'2.0.0',name:'skill',labels:[],envDeps:[] } as unknown as LocalSkill
  let local = { ...skill, id:'local-folder', localPath:'/local',version:'1.0.0', agents:{codex:'on'} } as LocalSkill
  let downloads = 0
  const deps = { localSkills:async()=>[local],download:async()=>{ downloads++; return {base64:'package',sha256:'a'.repeat(64),version:'2.0.0'} }, importPackage:async(input: {skillId:string;replaceExistingMarketplace?:boolean})=>{ assert.equal(input.skillId,'local-folder');assert.equal(input.replaceExistingMarketplace,true);local={...local,version:'2.0.0'};return local } }
  await acquireMarketplaceSkill(skill,deps,true)
  await acquireMarketplaceSkill(skill,deps,true)
  assert.equal(downloads,1)
  assert.equal(local.agents.codex,'on')
})
