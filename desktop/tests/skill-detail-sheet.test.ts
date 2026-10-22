import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { replaceSkillAcrossSources } from '../src/lib/skills.ts'
import {
  currentOwnedServerSkillId,
  ensureCurrentAccountServerSkill,
  finishTeamShareJob,
  moveLocalSkillToRecycle,
  shareSkillWithServerSync,
  startTeamShareJob,
} from '../src/lib/team-share-flow.ts'
import type { LocalSkill } from '../src/store/index.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const component = readFileSync(resolve(desktopRoot, 'src/components/SkillDetailSheet.tsx'), 'utf8')
const skillCard = readFileSync(resolve(desktopRoot, 'src/components/SkillCard.tsx'), 'utf8')
const app = readFileSync(resolve(desktopRoot, 'src/App.tsx'), 'utf8')
const agentDetection = readFileSync(resolve(desktopRoot, 'src/lib/agent-detection.ts'), 'utf8')
const styles = readFileSync(resolve(desktopRoot, 'src/components/SkillDetailSheet.css'), 'utf8')
const focusTrap = readFileSync(resolve(desktopRoot, 'src/components/FocusTrapDialog.tsx'), 'utf8')
const keysComponent = readFileSync(resolve(desktopRoot, 'src/components/SkillKeys.tsx'), 'utf8')

test('Skill detail uses the four approved product tabs, each with its icon (#289)', () => {
  const profile = component.indexOf("{ key: 'profile', label: '概览', icon: 'info' }")
  const details = component.indexOf("{ key: 'details', label: '详情', icon: 'doc' }")
  const environment = component.indexOf("{ key: 'environment', label: '钥匙', icon: 'key-round' }")
  const versions = component.indexOf("{ key: 'versions', label: '版本', icon: 'hist' }")
  // 14px icon before the label; 钥匙 carries a count only when keys need attention.
  assert.match(component, /<Icon name=\{item\.icon\} size=\{14\} \/><span>\{item\.label\}<\/span>\{item\.key === 'environment' && keyAttention > 0 && <span className="sh-tab-count"/)
  assert.match(component, /const keyAttention = skill\.isSystem \? 0 : envDepsNeedingAttention\(skill\.envDeps\)/)

  assert.ok(profile >= 0)
  assert.ok(details > profile)
  assert.ok(environment > details)
  assert.ok(versions > environment)
  assert.doesNotMatch(component, /label: 'Profile'/)
})

test('managed Skill actions close naturally and Agent icons remain the only local install controls', () => {
  assert.match(component, /const manageMenuRef = useRef<HTMLDetailsElement>\(null\)/)
  assert.match(component, /document\.addEventListener\('pointerdown', closeManageMenuOutside\)/)
  assert.match(component, /menu\?\.open && !menu\.contains\(event\.target as Node\)/)
  assert.doesNotMatch(component, />安装到工具</)
  // #295 board 9: 「获取到本机」 is a 36px icon button; the store-replacement case keeps its text button.
  assert.match(component, /!skill\.localPath && \(skill\.marketplaceReplacementLocalId\n\s*\? <button className="btn btn-primary btn-lg"/)
  assert.match(component, /className="btn btn-primary sh-get-btn" aria-label="获取到本机" title="获取到本机" onClick=\{\(\) => void openInstall\(\)\}><Icon name="download"/)
  assert.doesNotMatch(component, /'下载并安装'/)
})

test('adding one configuration dependency closes without immediately opening another dialog', () => {
  const start = component.indexOf('const addDependency = async')
  const end = component.indexOf('const removeDependency = async', start)
  const flow = component.slice(start, end)
  assert.match(flow, /setAdding\(false\)/)
  assert.doesNotMatch(flow, /openConfigure\(normalized\)/)
})

test('version history explains the user flow without duplicate or technical actions', () => {
  assert.match(component, /当你的 Skill 发生变化时，SkillHub 可以保留旧版本/)
  assert.match(component, /当前 Skill 内容有改动/)
  assert.match(component, /个文件有变化/)
  assert.match(component, /'查看区别并创建版本'/)
  assert.match(component, /'查看待确认状态'/)
  assert.doesNotMatch(component, />创建新版本</)
  assert.doesNotMatch(component, /查看 Diff 并创建版本|当前 Hash/)
  assert.match(component, />查看区别</)
  assert.doesNotMatch(component, />Diff</)
  assert.match(component, />补全本机记录</)
  assert.match(component, /补全记录不会修改 Skill 文件/)
  assert.match(styles, /\.working-copy-icon\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/s)
  assert.doesNotMatch(styles, /\.working-copy-banner b,\.working-copy-banner span/)
})

test('key rows show KEY, purpose, obtain link, one status badge and one primary action; author tools fold away', () => {
  const row = keysComponent.indexOf('return <li className="key-req-row"')
  const end = keysComponent.indexOf('</li>', row)
  const markup = keysComponent.slice(row, end)
  const name = markup.indexOf('<code className="key-req-name"')
  const badge = markup.indexOf('<KeyStatusBadge status={status} />')
  const purpose = markup.indexOf('{purpose && <p className="key-req-purpose">')
  const action = markup.indexOf('className="key-req-action"')
  assert.ok(name >= 0 && badge > name && purpose > badge && action > purpose)
  assert.match(markup, /elements\.runtimeTag && <span className="key-req-tag">\{KEY_COPY\.runtimeRequest\}/)
  assert.match(markup, /openUrl\(elements\.obtainUrl!\)/)
  for (const label of ['>填写<', '>选择<', '>授权<']) assert.ok(markup.includes(label), label)
  // No per-row delete, provenance guess, team popover or copy-from-Skill button.
  assert.doesNotMatch(markup, /删除|来自 |includes\('手动'\)|TeamValueMenu|使用「/)
  assert.doesNotMatch(component, /includes\('手动'\) \? '手动添加' : '自动检测'/)
  // 手动添加 / 重新检测 / 写回 SKILL.md / 删除声明 sit in the canManage-only 「钥匙声明」 disclosure (#289).
  const tools = component.indexOf('{section.authorTools && <details className="key-author-tools">')
  assert.ok(tools > 0)
  const toolsEnd = component.indexOf('</details>}', tools)
  const body = component.slice(tools, toolsEnd)
  for (const label of ['手动添加', '重新检测', '删除声明', 'KEY_COPY.writeBack', 'KEY_COPY.declarationsTitle', 'KEY_COPY.declarationsSubtitle', '<DetectedKeyRow']) assert.ok(body.includes(label), label)
  assert.ok(component.indexOf('重新检测') > tools, 'members never see 重新检测')
  assert.doesNotMatch(component, /TODO\(#251\)|>作者工具</)
})

test('the per-key 「提供给团队」 popover is removed and replaced by 「共享给团队」 to the 钥匙 page', () => {
  assert.equal(existsSync(resolve(desktopRoot, 'src/components/TeamValueMenu.tsx')), false)
  assert.equal(existsSync(resolve(desktopRoot, 'src/lib/skill-env-sharing.ts')), false)
  assert.doesNotMatch(component, /TeamValueMenu|providePersonalEnvToTeam|提供给团队/)
  // #289: a real secondary button; #294 opens the share dialog for this Skill's personal key and
  // falls back to the 团队 tab of the 钥匙 page when the vault has none.
  assert.match(component, /section\.shareHint && currentUser && <button type="button" className="btn btn-ghost btn-sm key-section-share" onClick=\{\(\) => setSharingKeys\(true\)\}><Icon name="key-round" size=\{13\} \/>\{KEY_COPY\.shareToTeam\}<\/button>/)
  assert.match(component, /\{sharingKeys && <ShareKeyLauncher declaredKeys=\{skill\.envDeps\.map\(\(dependency\) => dependency\.key\)\} onClose=\{\(\) => setSharingKeys\(false\)\} onFallback=\{\(\) => \{ setSharingKeys\(false\); setKeysPageIntent\(\{ tab: 'team' \}\); setView\('keys'\) \}\} \/>\}/)
  assert.match(component, /<KeysExplainer \/>\n\s+<section className="key-section-head" id="skill-detail-env">/)
  assert.match(component, /<p>\{KEY_COPY\.sectionSubtitle\}<\/p>/)
})

test('team keys are shared on the 「钥匙」 page, not per variable or at share time (#254)', () => {
  assert.doesNotMatch(component, /TeamValueMenu/)
  assert.doesNotMatch(component, /shareOffer|勾选后，团队成员也能使用对应的个人值|重试未完成项/)
  assert.doesNotMatch(component, /apiGetCredentialMetadata|apiPutCredentialBinding|providePersonalEnvToTeam/)
  assert.doesNotMatch(styles, /\.team-value-|\.share-env-choices/)
})

test('Profile presents the five user-facing fields without engineering status rows', () => {
  assert.match(component, /<dt>可以帮你<\/dt>/)
  assert.match(component, /<dt>什么时候会用<\/dt>/)
  assert.match(component, /<dt>来源<\/dt>/)
  assert.match(component, /<dt>版本<\/dt>/)
  assert.match(component, /<dt>标签<\/dt>/)
  assert.doesNotMatch(component, /<dt>触发场景<\/dt>|<dt>适用场景<\/dt>|<dt>不适用<\/dt>|<dt>云端状态<\/dt>/)
})

test('account reconnection notice keeps its action separate from the message', () => {
  assert.match(styles, /\.account-link-banner\s*\{[^}]*grid-template-columns:\s*16px minmax\(0, 1fr\) max-content;/s)
  assert.match(styles, /\.account-link-banner > div\s*\{\s*min-width:\s*0;/)
  assert.match(styles, /\.account-link-banner > \.btn\s*\{[^}]*grid-column:\s*3;/s)
  assert.match(component, /\{canRelink && <button className="btn btn-warn btn-sm"/)
})

test('Skill detail no longer launches an Agent or embeds a terminal', () => {
  assert.doesNotMatch(component, /AgentTerminal/)
  assert.doesNotMatch(component, /launchAgentWithLocalEnv/)
  assert.doesNotMatch(component, /consumeTeamCredentialsAndLaunch/)
  assert.doesNotMatch(component, /启动 Agent/)
  assert.match(component, /<h3>\{KEYS_SECTION_TITLE\}<\/h3>/)
  assert.doesNotMatch(component, /变量只注入该子进程，不会由 CLI 输出/)
  assert.doesNotMatch(component, /skillhub run \{managedSkillId\} -- env/)
})

test('Details tab renders a safe tree beside the full SKILL.md', () => {
  assert.match(component, /getSkillTree\(managedSkillId\)/)
  assert.match(component, /className="details-workspace"/)
  assert.match(component, /className="skill-tree-list"/)
  assert.match(component, /className="skill-document-source"/)
  assert.match(component, /const copyText = viewingSkillMd \? source :/)
  assert.match(component, /navigator\.clipboard\.writeText\(copyText\)/)
  assert.match(component, /openSkillDir\(managedSkillId\)/)
  assert.match(styles, /\.details-workspace\s*\{[^}]*grid-template-columns:\s*240px minmax\(0, 1fr\)/s)
})

test('key rows write through the resolved policy: fill to the vault or 仅此 Skill, choose a source, consent', () => {
  assert.match(keysComponent, /getSkillEnvSourcePolicy\(managedSkillId, accountUserId \?\? null, capabilities.teamKeys\)/)
  assert.match(keysComponent, /setSkillEnvSource\(managedSkillId, row\.key, choice\.source, currentUser\?\.id \?\? null\)/)
  assert.match(keysComponent, /setSkillEnv\(managedSkillId, keyName, value, accountUserId, scope\)/)
  assert.match(keysComponent, /<input type="password" autoFocus autoComplete="off"/)
  assert.match(keysComponent, /\{labeling \? KEY_COPY\.saveAsVariantHint : KEY_COPY\.fillHint\}/)
  assert.match(keysComponent, /role="radiogroup"/)
  assert.match(keysComponent, /openKeyConsent\(\{ skillId: managedKeySkillId\(skill\)/)
  // A saved value is cleared from the input right away and never shown again.
  assert.match(keysComponent, /await setSkillEnv\([^)]*\)\n\s+setValue\(''\)/)
  // Double clicks never send a second write.
  assert.match(keysComponent, /if \(!value \|\| inFlight\.current\) return/)
  assert.match(keysComponent, /if \(inFlight\.current\) return/)
  for (const old of ['用户自建', '已选来源失效', '重新选择来源', '已有个人值']) assert.doesNotMatch(component + keysComponent, new RegExp(old))
})
test('team sharing shares the Skill only; the 勾选提供配置 window is gone', () => {
  assert.doesNotMatch(component, /shareOffer|availablePersonalKeys|provideSelectedTeamValues|重试未完成项|勾选后，团队成员也能使用/)
  assert.match(component, /const toggle = async \(teamId: string, shared: boolean\): Promise<void> =>/)
  assert.match(component, /toast\(shared \? '已停止共享' : '已共享 Skill'\)/)
})
test('a remote-only team Skill asks for installation before reading local key state', () => {
  assert.match(component, /if \(!skill\.localPath\) return <div className="key-empty" id="skill-detail-env">/)
  assert.match(component, /安装到本机后即可填写需要的钥匙/)
  assert.match(keysComponent, /if \(authStatus === 'restoring' \|\| !skill\.localPath\) return/)
})
test('remote package installation preserves its complete team and catalog identity', () => {
  assert.match(component, /resolveSkillFromSources\(skillId, skills, marketplaceSkills\)/)
  assert.match(component, /const marketplaceInstall = isMarketplaceCatalogSource\(skill\)[\s\S]*?marketplaceInstall\s*\? await apiDownloadMarketplacePackage\(skill\.serverId\)\s*: await apiDownloadSkillPackage\(skill\.serverId\)/)
  assert.match(component, /packageData\.sha256\.toLowerCase\(\) !== skill\.marketplacePackageSha256\.toLowerCase\(\)/)
  assert.match(component, /const downloadedSkill = \{ \.\.\.skill, installCount: skill\.installCount \+ 1 \}/)
  assert.match(component, /teamIds: Object\.keys\(skill\.sharedTo\)/)
  assert.match(component, /installCount: downloadedSkill\.installCount, createdAt: skill\.createdAt, updatedAt: skill\.updatedAt/)
  assert.match(component, /triggerScenarios: skill\.fitScenarios \?\? \[\], compatibleAgents: skill\.compatibleAgents/)
  assert.match(component, /envDependencies: skill\.envDeps\.map/)
  assert.match(component, /currentAsset = hydrateDownloadedSkill\(downloadedSkill, imported\)/)
})

test('Marketplace replacement re-confirms the newly downloaded package without entering a retry loop', () => {
  assert.match(component, /replacementRecoveryId\s*&& plan\.sources\.length > 0\s*&& \(!installPreflight \|\| !sameAgentPreflightState\(installPreflight, plan\)\)/s)
  const reconfirmStart = component.indexOf('if (replacementRecoveryId\n        && plan.sources.length > 0')
  const nextBranch = component.indexOf('if (!replacementRecoveryId && plan.sources.length > 0', reconfirmStart)
  assert.ok(reconfirmStart >= 0)
  assert.ok(nextBranch > reconfirmStart)
  const reconfirm = component.slice(reconfirmStart, nextBranch)
  assert.match(reconfirm, /rollbackMarketplaceReplacement\(replacementRecoveryId\)/)
  assert.match(reconfirm, /replacementRecoveryId = undefined/)
  assert.match(reconfirm, /restoreMarketplaceStateAfterRollback\(\)/)
  assert.match(reconfirm, /setInstallPreflight\(plan\)/)
  assert.match(reconfirm, /setInstallStep\('confirm'\)/)
  assert.match(reconfirm, /return/)
  assert.doesNotMatch(reconfirm, /setInstallPreflight\(null\)/)
  assert.doesNotMatch(component, /Agent 中的同名 Skill 在确认后发生变化/)
})

test('public Marketplace details never fall through to private source, comment, or version APIs', () => {
  assert.match(component, /isPublicMarketplaceSource\(skill\) && skill\.marketplaceSkillMd !== undefined/)
  assert.match(component, /if \(skill\.marketplaceSkillMd !== undefined\) return skill\.marketplaceSkillMd/)
  assert.match(keysComponent, /const space = currentUser \? readAuthSpace\(\) : null/)
  assert.match(keysComponent, /const accountUserId = currentUser\?\.id/)
  assert.match(component, /if \(isPublicMarketplaceSource\(skill\)\) return <MarketplaceDiscussTab skill=\{skill\}/)
  assert.match(component, /apiGetMarketplaceComments\(serverId, visibility/)
  assert.match(component, /apiPostMarketplaceComment/)
  assert.match(component, /if \(!remoteServerId\)/)
  assert.match(component, /选择这条讨论对谁可见/)
})

test('read-only source and version requests require a current-account binding before calling Server', () => {
  assert.match(component, /const readableServerId = currentUser[^]*currentAccountServerId\(skill, currentUser\.id\)/)
  assert.match(component, /apiGetSkillSource\(readableServerId\)/)
  assert.match(component, /const remoteServerId = currentUser && !publicMarketplaceSource[^]*currentAccountServerId\(skill, currentUser\.id\)/)
  assert.match(component, /apiGetSkillVersions\(remoteServerId\)/)
  assert.doesNotMatch(component, /apiGetSkillVersions\(skill\.serverId\)/)
})

test('a detached downloaded Skill can be copied and linked to the current account', () => {
  assert.match(component, /const canRelink = capabilities.uploads && Boolean\(skill\.localPath && skill\.accountSyncRequired\)/)
  assert.match(component, /canRelink && <button[^>]*disabled=\{syncBusy\}[^>]*onClick=\{onRequestSync\}>/)
  assert.match(component, /这个 Skill 需要重新连接你的账号/)
  assert.match(component, /setConfirmation\(null\); void syncToServer\(\)/)
})

test('Team sharing automatically creates a current-account server asset when needed', () => {
  assert.match(component, /shareSkillWithServerSync\(\{/)
  assert.match(component, /sync: \(\) => onSync\(false\)/)
  assert.match(component, /share: async \(serverId, targetTeamId\) => \{[\s\S]*?if \(!sessionStillMatches\(\)\)[\s\S]*?await apiShareSkillToTeam\(serverId, targetTeamId\)/)
  assert.match(component, /currentOwnedServerSkillId\(skill, currentUser\.id\)/)
  assert.doesNotMatch(component, /请先通过导入流程同步到服务端资产库/)
})

test('My Skills does not mount comments, and Team sharing tracks background work per Skill', () => {
  assert.match(component, /showDiscussion=\{view !== 'skills'\}/)
  assert.match(component, /showDiscussion && <DiscussTab skill=\{skill\}/)
  assert.match(component, /state\.teamShareJobs\[skill\.id\]/)
  assert.match(component, /setTeamShareJob\(skill\.id, job\)/)
  assert.match(component, /clearTeamShareJob\(skill\.id, job\.id\)/)
  assert.doesNotMatch(component, /disabled=\{Boolean\(busyTeamId\)\}/)
})

test('background Team sharing keeps independent jobs and ignores stale completion', () => {
  const first = startTeamShareJob({}, 'skill-1', { id: 'job-1', teamId: 'team-1', action: 'share' })
  const both = startTeamShareJob(first, 'skill-2', { id: 'job-2', teamId: 'team-1', action: 'share' })
  assert.deepEqual(Object.keys(both).sort(), ['skill-1', 'skill-2'])

  const staleCompletion = finishTeamShareJob(both, 'skill-1', 'stale-job')
  assert.equal(staleCompletion, both)
  const firstFinished = finishTeamShareJob(both, 'skill-1', 'job-1')
  assert.equal(firstFinished['skill-1'], undefined)
  assert.equal(firstFinished['skill-2']?.id, 'job-2')
})

test('Team sharing binds the current account, preserves async order, and updates the local share state', async () => {
  const calls: string[] = []
  const stale = { serverId: 'old-skill', serverOwnerId: 'old-user' }
  const rebound = { serverId: 'new-skill', serverOwnerId: 'new-user' }
  const shareable = await shareSkillWithServerSync({
    skill: stale,
    currentUserId: 'new-user',
    teamId: 'team-1',
    sync: async () => { calls.push('sync'); return rebound },
    share: async (serverId, teamId) => { calls.push(`share:${serverId}:${teamId}`) },
  })
  assert.equal(shareable, rebound)
  assert.deepEqual(calls, ['sync', 'share:new-skill:team-1'])
  assert.equal(currentOwnedServerSkillId({ ...rebound, accountSyncRequired: true }, 'new-user'), undefined)

  const local = {
    id: 'local-skill',
    localPath: '/tmp/local-skill',
    acquisitionSource: 'local',
    isOwn: true,
    sharedTo: {},
  } as LocalSkill
  const updated = {
    ...local,
    teamSharedFrom: 'team-1',
    sharedTo: { 'team-1': { version: 'v0.1.0', envShared: false } },
  }
  const replacement = replaceSkillAcrossSources([local], [], local.id, updated)
  assert.deepEqual(replacement.skills[0]?.sharedTo, updated.sharedTo)
  assert.equal(replacement.skills[0]?.teamSharedFrom, 'team-1')
  const cleared = replaceSkillAcrossSources(replacement.skills, [], local.id, {
    ...updated,
    teamSharedFrom: undefined,
    sharedTo: {},
  })
  assert.deepEqual(cleared.skills[0]?.sharedTo, {})
  assert.equal(cleared.skills[0]?.teamSharedFrom, undefined)
})

test('a failed automatic sync or Team share does not report a completed flow', async () => {
  await assert.rejects(shareSkillWithServerSync({
    skill: {},
    currentUserId: 'user-1',
    teamId: 'team-1',
    sync: async () => null,
    share: async () => undefined,
  }), /尚未完成账号同步/)
  await assert.rejects(shareSkillWithServerSync({
    skill: { serverId: 'skill-1', serverOwnerId: 'user-1' },
    currentUserId: 'user-1',
    teamId: 'team-1',
    sync: async () => null,
    share: async () => { throw new Error('share failed') },
  }), /share failed/)
})

test('author-only actions replace a stale server binding before use', async () => {
  const calls: string[] = []
  const result = await ensureCurrentAccountServerSkill({
    skill: { serverId: 'legacy-skill', serverOwnerId: 'legacy-user' },
    currentUserId: 'current-user',
    sync: async () => {
      calls.push('sync')
      return { serverId: 'current-skill', serverOwnerId: 'current-user' }
    },
  })
  assert.deepEqual(calls, ['sync'])
  assert.equal(result.serverId, 'current-skill')
})

test('local recycle is never blocked by a foreign or failed server deletion', async () => {
  const foreignCalls: string[] = []
  const foreign = await moveLocalSkillToRecycle({
    skill: { serverId: 'foreign-skill', serverOwnerId: 'foreign-user', localPath: '/local/skill' },
    currentUserId: 'current-user',
    deleteRemote: async () => { foreignCalls.push('remote') },
    deleteLocal: async () => { foreignCalls.push('local') },
  })
  assert.deepEqual(foreignCalls, ['local'])
  assert.equal(foreign.remoteWarning, undefined)

  const ownedCalls: string[] = []
  const owned = await moveLocalSkillToRecycle({
    skill: { serverId: 'owned-skill', serverOwnerId: 'current-user', localPath: '/local/skill' },
    currentUserId: 'current-user',
    deleteRemote: async () => { ownedCalls.push('remote'); throw new Error('temporary outage') },
    deleteLocal: async () => { ownedCalls.push('local') },
  })
  assert.deepEqual(ownedCalls, ['local'])
  assert.equal(owned.remoteWarning, undefined)
})

test('Skill cards ignore hidden Agent roots and read the shared, focus-refreshed detection', () => {
  assert.match(skillCard, /visibleAgentKeys\(installedAgents, skill\.agents\)/)
  assert.match(skillCard, /visibleAgentEntries[\s\S]*?filter\(\(\[key\]\) => visibleAgents\.has\(key\)\)/)
  assert.match(skillCard, /const brokenAgents = visibleAgentEntries\.filter/)
  assert.doesNotMatch(skillCard, /const brokenAgents = orderedAgentEntries\(skill\.agents\)\.filter/)
  // One App-level refresh replaces a native call and focus listener per card.
  assert.match(skillCard, /const installedAgents = useStore\(\(state\) => state\.agentCapabilities\)/)
  assert.doesNotMatch(skillCard, /getInstalledAgents|addEventListener\('focus'/)
  assert.match(app, /window\.addEventListener\('focus', refresh\)/)
  assert.match(app, /refreshAgentCapabilities\(\)/)
  assert.match(agentDetection, /setAgentCapabilities\(agents\)/)
})

test('Team sharing discards every stale result after an account switch', () => {
  const start = component.indexOf('function TeamShareTab')
  const end = component.indexOf('function DiscussTab', start)
  const flow = component.slice(start, end)
  assert.match(flow, /const accountUserId = currentUser\.id/)
  assert.match(flow, /const accountSpace = readAuthSpace\(\)/)
  assert.match(flow, /if \(!sessionStillMatches\(\)\) return[\s\S]*?replaceSkill/)
  assert.match(flow, /const nextTeams = await apiGetTeams\(\)[\s\S]*?if \(!sessionStillMatches\(\)\) return[\s\S]*?setTeams\(nextTeams\)/)
})

test('Team share rows match the Marketplace row and 「共享钥匙给团队」 opens the share dialog', () => {
  const start = component.indexOf('function TeamShareTab')
  const flow = component.slice(start, component.indexOf('function MarketplaceDiscussTab', start))
  assert.match(flow, /className="marketplace-share-card team-share-row"><span className="tava2"[^>]*>\{team\.name\[0\]\}<\/span><div className="marketplace-share-copy"><b>\{team\.name\}<\/b>/)
  assert.match(flow, /className="btn btn-ghost btn-sm team-share-keys" onClick=\{\(\) => setSharingKeys\(true\)\}><Icon name="key-round" size=\{13\} \/>\{KEY_COPY\.shareKeysToTeam\}/)
  assert.match(flow, /\{sharingKeys && <ShareKeyLauncher /)
  assert.doesNotMatch(component, /share-row compact|key-share-hint/)
})

test('Sharing exposes Marketplace above Team sharing without requiring login for local use', () => {
  assert.match(component, /<h3>共享<\/h3>/)
  const marketplace = component.indexOf('<b>Marketplace</b>')
  const team = component.indexOf('<b>团队共享</b>')
  assert.ok(marketplace >= 0)
  assert.ok(team > marketplace)
  assert.match(component, /本机安装、版本和使用仍然无需登录/)
  assert.match(component, /apiGetMarketplaceState\(ownedServerId\)/)
  assert.match(component, /ensureCurrentAccountServerSkill\(\{/)
})

test('Marketplace submissions select a real remote version id and disclose exactly what becomes public', () => {
  assert.match(component, /value=\{selectedVersionId\}/)
  assert.match(component, /<option key=\{version\.id\} value=\{version\.id\}>/)
  assert.match(component, /apiSubmitMarketplaceSkill\(actionServerId, \{\s*versionId: selectedVersionId,\s*note: submitterNote\.trim\(\)/s)
  assert.match(component, /Profile、脱敏后的 SKILL\.md、所选版本安装包和需要的钥匙名称/)
  assert.match(component, /不会公开任何钥匙的值或凭据/)
})

test('Marketplace keeps listing and submission state independent', () => {
  assert.match(component, /const latestSubmission = marketplace\?\.latestSubmission \?\? null/)
  assert.match(component, /const listing = marketplace\?\.listing \?\? publicListing/)
  assert.match(component, /latestSubmission\.version\.version/)
  assert.match(component, /当前上架版本继续公开/)
  assert.match(component, /apiWithdrawMarketplaceSubmission\(latestSubmission\.id\)/)
  assert.match(component, /apiUnpublishMarketplaceSkill\(ownedServerId\)/)
  assert.match(component, /latestSubmission\.reviewNote/)
  assert.match(component, /重新提交/)
  assert.match(component, /已从 Marketplace 下架/)
  assert.doesNotMatch(component, /审核已通过，正在上架/)
})

test('a non-author Marketplace source shows only public author and version identity', () => {
  assert.match(component, /if \(!canManage\)/)
  assert.match(component, /Marketplace 公开来源/)
  assert.match(component, /const publicListing = isPublicMarketplaceSource\(skill\)/)
  assert.match(component, /skill\.marketplaceSkillMd !== undefined/)
  assert.match(component, /&& !skill\.teamSharedFrom/)
  assert.match(component, /skill\.authorName \?\? 'Marketplace 作者'/)
  assert.match(component, /\{listing\.version\}/)

  const marketplaceBlockStart = component.indexOf('function MarketplaceShareBlock')
  const publicCardStart = component.indexOf('if (!canManage)', marketplaceBlockStart)
  const ownerCardStart = component.indexOf('if (!currentUser)', publicCardStart)
  assert.ok(marketplaceBlockStart >= 0)
  assert.ok(publicCardStart >= 0)
  assert.ok(ownerCardStart > publicCardStart)
  assert.doesNotMatch(component.slice(publicCardStart, ownerCardStart), /<button/)
})

test('Marketplace sharing has loading, error, focus, and compact responsive states', () => {
  assert.match(component, /正在读取上架与审核状态/)
  assert.match(component, /<b>\{loadFailedMessage\('Marketplace 状态'\)\}<\/b>/)
  assert.match(component, /role="alert"/)
  assert.match(styles, /\.marketplace-share-card\s*\{/)
  assert.match(styles, /\.marketplace-submit-form select:focus-visible/)
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.marketplace-share-card/)
})

test('Skill sheet and nested dialogs trap focus, consume Escape, and restore the opener', () => {
  assert.match(component, /<FocusTrapDialog className="detail-sheet on pop-in"/)
  assert.match(component, /aria-label="关闭 Skill 详情"/)
  assert.match(focusTrap, /event\.stopImmediatePropagation\(\)/)
  assert.match(focusTrap, /event\.key !== 'Tab'/)
  assert.match(focusTrap, /restoreFocus\.focus\(\{ preventScroll: true \}\)/)
  assert.match(focusTrap, /isTopmostDialog\(dialog\)/)
})

test('Skill detail tabs expose automatic keyboard tab semantics', () => {
  assert.match(component, /className="sh-tabs" role="tablist"/)
  assert.match(component, /role="tab" aria-selected=\{tab === item\.key\} aria-controls=/)
  assert.match(component, /role="tabpanel" aria-labelledby=/)
  assert.match(component, /nextRovingIndex\(index, detailTabs\.length, event\.key, 'horizontal'\)/)
})

test('the bundled SkillHub Manager stays visible and read-only', () => {
  assert.match(component, /skill\?\.isSystem/)
  assert.match(component, /系统自动维护/)
  assert.match(component, /!skill\.isSystem && <SharingSection/)
  assert.match(component, /skill\.localPath && !skill\.isSystem/)
})

test('version hash copy failures are visible and comment actions appear on keyboard focus', () => {
  assert.match(component, /Commit Hash 复制失败/)
  assert.match(styles, /\.comment-list article:focus-within > \.comment-head \.comment-actions/)
})

test('Details tab renders SKILL.md through the native inspector and previews listed files', () => {
  const start = component.indexOf('function DetailsTab')
  const end = component.indexOf('function VersionsTab', start)
  const details = component.slice(start, end)
  assert.match(details, /inspectSkillMarkdown\(source\)/)
  assert.match(details, /readSkillFile\(managedSkillId, selectedPath\)/)
  assert.match(details, /inspection\.lint\.map/)
  assert.match(details, /<FrontmatterTable fields=\{inspection\.fields\} \/>/)
  assert.match(details, /documentView === 'source' \|\| !inspection/)
  assert.match(details, /classifyMarkdownLink\(href, skillFiles, selectedPath\)/)
  assert.match(details, /entry\.kind === 'file'[\s\S]*?className="skill-tree-file"/)
  assert.match(component, /dangerouslySetInnerHTML=\{\{ __html: html \}\}/)
})

test('Narrow document headers wrap their actions instead of overflowing the panel', () => {
  // A clipped header made the panel scroll sideways in packaged-UI acceptance.
  assert.match(styles, /\.details-panel-head \{\s*display: flex;\s*flex-wrap: wrap;/)
  assert.match(styles, /\.details-head-actions \{[^}]*flex-wrap: wrap;/)
  assert.match(styles, /\.document-view-toggle button \{[^}]*white-space: nowrap;/)
})

test('header problem icon (#289): 28px red circle-alert with a non-modal 问题详情 popover, repair and diagnostics', () => {
  assert.match(component, /<div className="sh-title-row"><h2 className="sh-store-title">[^]*<\/h2>\{problem\}<\/div>/)
  assert.match(component, /className="sh-problem-button" aria-label=\{`有 \$\{count\} 个问题，查看详情`\} aria-expanded=\{open\} aria-haspopup="dialog"/)
  assert.match(component, /<Icon name="circle-alert" size=\{16\} \/>/)
  assert.match(component, /className="sh-problem-popover" role="dialog" aria-modal="false" aria-label="问题详情">/)
  assert.match(component, /'Agent 投影没有刷新'/)
  assert.match(component, /投影的身份、权限、硬链接或 current 链接无效。为了安全，SkillHub 保留了原来的投影，没有覆盖。/)
  // 重新修复 reuses the guarded install repair for every broken Agent; diagnostics go to the clipboard.
  assert.match(component, /onRepair=\{\(brokenAgents\) => void openInstall\(brokenAgents\)\}/)
  assert.match(component, /onClick=\{\(\) => \{ setOpen\(false\); onRepair\(broken\) \}\}><Icon name="wrench" size=\{13\} \/>重新修复<\/button>/)
  assert.match(component, /navigator\.clipboard\.writeText\(skillDiagnosticsText\(skill, lastRun\)\)\n\s*\.then\(\(\) => toast\('已复制诊断信息'\)\)/)
  // Escape (captured so the sheet stays open) and outside pointer close it; focus moves in, then back.
  assert.match(component, /document\.addEventListener\('keydown', closeOnEscape, true\)/)
  assert.match(component, /panelRef\.current\?\.querySelector<HTMLButtonElement>\('button'\)\?\.focus\(\)/)
  assert.match(component, /buttonRef\.current\?\.focus\(\)/)
  assert.match(styles, /\.sh-problem-button \{[^}]*width: 28px; height: 28px;[^}]*color: var\(--color-danger\);/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{ \.sh-problem-popover \{ animation: none; \} \}/)
})

test('origin line (#289): every Skill shows 来源 · 作者 <UserChip> · 更新于 under the meta tags', () => {
  assert.match(component, /<SkillOriginLineView skill=\{skill\} \/>/)
  assert.match(component, /const line = skillOriginLine\(skill, \{ currentUserId, teamName, storeListing: isMarketplaceCatalogSource\(skill\) \}\)/)
  assert.match(component, /<span className="sh-origin-updated">更新于 \{line\.updated\}<\/span>/)
  assert.match(styles, /\.sh-origin \{[^}]*color: var\(--color-muted\);/)
})
