import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { hydrateDownloadedSkill, mergeApiSkill, mergeMarketplaceSkill, mergeSkillSources } from '../src/lib/skills.ts'
import type { ApiMarketplaceItem, ApiSkill } from '../src/lib/api.ts'
import type { LocalSkill } from '../src/store/index.ts'

const source = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function apiSkill(overrides: Partial<ApiSkill> = {}): ApiSkill {
  return {
    id: '019f9d24-3624-7be0-917f-a9b197c2cde7',
    name: 'pdf-skill',
    displayName: 'PDF',
    labels: [],
    triggerScenarios: [],
    compatibleAgents: [],
    currentVersion: '1.0.0',
    installCount: 0,
    authorId: 'u-author',
    visibility: 'private',
    marketplaceStatus: 'none',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  }
}

function local(overrides: Partial<LocalSkill> = {}): LocalSkill {
  return {
    id: 'pdf-skill',
    name: 'pdf-skill',
    displayName: 'PDF',
    labels: [],
    version: '1.0.0',
    latestVersion: '1.0.0',
    installCount: 0,
    sources: ['本机创建'],
    agents: {},
    installed: false,
    isOwn: true,
    acquisitionSource: 'local',
    envDeps: [],
    sharedTo: {},
    versions: [],
    compatibleAgents: [],
    localPath: '/tmp/pdf-skill',
    serverId: '019f9d24-3624-7be0-917f-a9b197c2cde7',
    ...overrides,
  }
}

test('Server sourceUrl wins, explicit null clears, and an old Server without the field keeps the local value', () => {
  const withLocal = local({ sourceUrl: 'https://github.com/acme/local' })
  assert.equal(mergeApiSkill(apiSkill({ sourceUrl: 'https://x.com/acme' }), withLocal).sourceUrl, 'https://x.com/acme')
  assert.equal(mergeApiSkill(apiSkill({ sourceUrl: null }), withLocal).sourceUrl, null)
  assert.equal(mergeApiSkill(apiSkill(), withLocal).sourceUrl, 'https://github.com/acme/local')
  assert.equal(mergeApiSkill(apiSkill(), undefined).sourceUrl, undefined)
})

test('team shares carry the shared version source', () => {
  const [team] = mergeSkillSources([], null, {
    accountUserId: 'u-me',
    activeTeamId: 'team-1',
    membershipsValidated: true,
    teamSources: [{ teamId: 'team-1', skills: [apiSkill({ visibility: 'team', sourceUrl: 'https://skills.sh/acme/pdf' })] }],
  })
  assert.equal(team?.sourceUrl, 'https://skills.sh/acme/pdf')
})

test('store listings and installs keep the listing source', () => {
  const item: ApiMarketplaceItem = {
    id: '019f9d24-3624-7be0-917f-a9b197c2cde7',
    name: 'pdf-skill',
    displayName: 'PDF',
    sourceUrl: 'https://clawhub.ai/acme/pdf',
    labels: [],
    triggerScenarios: [],
    compatibleAgents: [],
    envDependencies: [],
    currentVersion: '1.0.0',
    author: { id: 'u-author', displayName: '作者', avatarUrl: null },
    version: { id: 'v-1', version: '1.0.0', createdAt: '2026-10-01T00:00:00.000Z' } as ApiMarketplaceItem['version'],
    downloadCount: 1,
    publishedAt: '2026-10-02T00:00:00.000Z',
  }
  const listing = mergeMarketplaceSkill(item, undefined)
  assert.equal(listing.sourceUrl, 'https://clawhub.ai/acme/pdf')
  const { sourceUrl: _omitted, ...legacyItem } = item
  assert.equal(mergeMarketplaceSkill(legacyItem, local({ sourceUrl: 'https://kept.example/' })).sourceUrl, 'https://kept.example/')

  const imported = local({ id: 'pdf-skill--019f9d243624', sourceUrl: 'https://clawhub.ai/acme/pdf' })
  assert.equal(hydrateDownloadedSkill(listing, imported).sourceUrl, 'https://clawhub.ai/acme/pdf')
  assert.equal(hydrateDownloadedSkill({ ...listing, sourceUrl: undefined }, imported).sourceUrl, 'https://clawhub.ai/acme/pdf')
  assert.match(source('src/lib/marketplace-acquisition.ts'), /description: skill\.description, sourceUrl: skill\.sourceUrl,/)
  assert.match(source('src/components/SkillDetailSheet.tsx'), /sourceUrl: skill\.sourceUrl, category: skill\.category, labels: skill\.labels, version: packageData\.version,/)
})

test('detail header shows the source after 更新于 and opens it in the system browser', () => {
  const sheet = source('src/components/SkillDetailSheet.tsx')
  assert.match(sheet, /更新于 \{line\.updated\}<\/span><\/>\}\n\s*<SourceUrlLink url=\{skill\.sourceUrl\} leadingDot onOpen=\{\(href\) => void openUrl\(href\)/)
  const link = source('src/components/SourceUrlLink.tsx')
  assert.match(link, /const source = describeSourceUrl\(url\)\n\s*if \(!source\) return null/)
  assert.match(link, /title=\{source\.href\}/)
  assert.match(link, /event\.preventDefault\(\)/)
  assert.doesNotMatch(link, /fetch\(|favicon/i)
})

test('owners edit the source through the profile dialog; invalid input keeps the draft', () => {
  const sheet = source('src/components/SkillDetailSheet.tsx')
  assert.match(sheet, /<label>来源（可选）<input type="url"/)
  assert.match(sheet, /const checkedSource = validateSourceUrl\(sourceUrl\)\n\s*if \(!checkedSource\.ok\) \{\n\s*setError\(checkedSource\.error\)\n\s*return/)
  // Only an edited source is sent (explicit null clears both the Server Skill
  // and the local sidecar); an untouched field omits it, which keeps.
  assert.match(sheet, /const sourceChange = checkedSource\.value === \(skill\.sourceUrl \?\? null\) \? \{\} : \{ sourceUrl: checkedSource\.value \}/)
  assert.match(sheet, /const clearedSource = checkedSource\.value === null && skill\.sourceUrl \? \{ clearedSourceUrl: skill\.sourceUrl \} : \{\}/)
  assert.match(sheet, /\.\.\.sourceChange,\n\s*\}\)\n\s*\}\n\s*if \(skill\.localPath\)/)
  assert.match(sheet, /description: next\.description,\n\s*\.\.\.sourceChange,\n\s*\.\.\.clearedSource,/)
  // The edit button stays behind the existing owner check.
  assert.match(sheet, /\{canManage && <div className="env-panel-actions">/)
})

test('AI analysis and Server read-backs never write the source', () => {
  const sheet = source('src/components/SkillDetailSheet.tsx')
  const writer = sheet.slice(sheet.indexOf('writeLocalProfile: async'), sheet.indexOf('replaceSkill: (currentId, updated)'))
  assert.ok(writer.length > 0)
  assert.doesNotMatch(writer, /sourceUrl/)
  assert.doesNotMatch(source('src/lib/ai-analysis-job.ts'), /sourceUrl/)
  const skillsPage = source('src/pages/SkillsPage.tsx')
  assert.doesNotMatch(skillsPage, /sourceUrl/)
})

test('the source parser is byte-identical in the APP and the web store', () => {
  const root = new URL('../../', import.meta.url)
  const desktop = readFileSync(new URL('desktop/src/lib/source-url.ts', root))
  const web = readFileSync(new URL('landing-page/src/shared/source-url.ts', root))
  assert.ok(desktop.length > 0)
  assert.ok(desktop.equals(web), 'desktop/src/lib/source-url.ts and landing-page/src/shared/source-url.ts differ')
})
