import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { EMPTY_COPY, LOADING_COPY } from '../src/lib/state-copy.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const page = readFileSync(resolve(desktopRoot, 'src/pages/TeamSharedPage.tsx'), 'utf8')
const styles = readFileSync(resolve(desktopRoot, 'src/pages/TeamSharedPage.css'), 'utf8')

test('team shared page loads real memberships, remote shares, owned metadata, and local install state', () => {
  assert.match(page, /apiGetTeams\(\)/)
  assert.match(page, /membershipTeams\.map\(\(team\) => apiGetTeamSkills\(team\.id\)\)/)
  assert.match(page, /apiGetMySkills\(\)/)
  assert.match(page, /getLocalSkills\(\)/)
  assert.match(page, /mergeSkillSources\(localSkills, ownedSkills/)
  assert.doesNotMatch(page, /mock|demo/i)
})

test('team shared page scopes the persistent Skill directory to the selected team and keeps detail/install actions real', () => {
  assert.match(page, /isSkillSharedWithActiveTeam\(skill, activeTeamId\)/)
  assert.match(page, /setActiveTeam\(teamId\)/)
  assert.match(page, /<SkillLibraryList/)
  assert.match(page, /context="team"/)
  assert.match(page, /openSkillSheet\(firstSkill\.id\)/)
  assert.match(page, /openTeamSheet\(activeTeam\.id\)/)
  assert.match(page, /getSkillEnvSourcePolicy/)
})

test('team shared page distinguishes loading, unavailable, empty, and filtered-empty states', () => {
  // Copy lives in lib/state-copy.ts (#263); the page picks one per state.
  assert.match(page, /<SkeletonBlock layout="rows" label=\{LOADING_COPY\.teamShared\} \/>/)
  assert.match(page, /EMPTY_COPY\.teamSharedUnavailable/)
  assert.match(page, /EMPTY_COPY\.teamSharedNone/)
  assert.match(page, /EMPTY_COPY\.skillsNoMatch/)
  assert.equal(LOADING_COPY.teamShared, '正在读取真实团队和共享 Skill…')
  assert.equal(EMPTY_COPY.teamSharedUnavailable.title, '暂时无法确认团队共享列表')
  assert.equal(EMPTY_COPY.teamSharedNone.title, '这个团队还没有共享 Skill')
  assert.equal(EMPTY_COPY.skillsNoMatch.title, '没有匹配的 Skill')
  assert.match(page, /className="team-shared-selector-trigger"/)
  assert.match(page, /role="menu" aria-label="切换团队"/)
  assert.match(styles, /\.team-shared-selector-menu\s*\{[^}]*position:\s*absolute;/s)
  assert.doesNotMatch(page, /已同步|刷新团队共享|>团队详情</)
  assert.doesNotMatch(styles, /\.team-shared-team-tabs/)
  assert.match(styles, /@media \(max-width: 720px\)/)
})

test('team shared refreshes on navigation and opens team details from the context identity', () => {
  const sidebar = readFileSync(resolve(desktopRoot, 'src/components/Sidebar.tsx'), 'utf8')
  assert.match(sidebar, /item\.view === 'team-skills'[^\n]*skillhub:refresh-team-shares/)
  assert.match(page, /addEventListener\('skillhub:refresh-team-shares', refreshFromNavigation\)/)
  assert.match(page, /className="team-shared-context-identity"[^>]*onClick=\{\(\) => openTeamSheet\(activeTeam\.id\)\}/)
})

test('team shared catalog exposes install-state filters and latest/download sorting', () => {
  // #295 board 9: 全部 / 可获取 / 有更新 as a small radio SegmentedControl, sorting in a menu.
  assert.match(page, /<SegmentedControl\n\s*className="team-shared-availability"\n\s*mode="radiogroup"\n\s*size="sm"\n\s*aria-label="安装状态"/)
  assert.match(page, /\{ value: 'all', label: '全部' \}/)
  assert.match(page, /\{ value: 'uninstalled', label: '可获取', count: availableCount \}/)
  assert.match(page, /\{ value: 'updates', label: '有更新', count: updateCount \}/)
  assert.match(page, /const updateCount = teamSkills\.filter\(teamSkillHasUpdate\)\.length/)
  assert.match(page, /aria-haspopup="menu" aria-expanded=\{sortMenuOpen\}/)
  assert.match(page, /role="menu" aria-label="排序方式"/)
  assert.match(page, /\[\['latest', '按最新'\], \['downloads', '按下载'\]\]/)
  assert.match(page, /role="menuitemradio" aria-checked=\{sortMode === value\}/)
  assert.match(page, /orderTeamSharedSkills\(matches, availabilityFilter, sortMode\)/)
  assert.match(page, /placeholder="搜索团队里的 Skill"/)
  // 搜索框占满一行；排序菜单在筛选行的右端。
  assert.match(styles, /\.team-shared-toolbar \.search-bar\s*\{[^}]*flex:\s*1 1 100%;/s)
  assert.match(styles, /\.team-shared-catalog-controls\s*\{[^}]*width:\s*100%;/s)
  assert.match(styles, /\.team-shared-sort \{[^}]*margin-left:\s*auto;/)
  assert.ok(page.indexOf('className="team-shared-availability"') < page.indexOf('className="team-shared-sort"'))
  // The list header row (共享 Skill · count) is gone; the count lives in the stats card.
  assert.doesNotMatch(page, /team-shared-results-head|<h2>共享 Skill<\/h2>/)
})

test('team shared header shows 共享 / 已在本机 / 可获取 / 团队钥匙 and rows offer 获取 (#295)', () => {
  assert.match(page, /<b>\{teamSkills\.length\}<\/b>共享/)
  assert.match(page, /<b>\{installedCount\}<\/b>已在本机/)
  assert.match(page, /<b>\{availableCount\}<\/b>可获取/)
  assert.match(page, /<b>\{activeTeam\.credentialCount \?\? '—'\}<\/b>团队钥匙/)
  const list = readFileSync(resolve(desktopRoot, 'src/components/SkillLibraryList.tsx'), 'utf8')
  assert.match(list, /className="btn btn-primary skill-library-get" aria-label="获取" title="获取" data-row-action="get"><Icon name="download"/)
  assert.match(list, /closest\?\.\('\[data-row-action="get"\]'\)\) openSkillSheet\(skill\.id, 'profile', 'install'\)/)
  assert.match(list, /context === 'team' && teamSkillHasUpdate\(skill\) && <span className="skill-library-update">有更新<\/span>/)
  assert.match(list, /<UserChip name=\{teamSharer\.name\} me=\{teamSharer\.me\} avatarUrl=\{teamSharer\.avatarUrl\} \/>共享/)
})
