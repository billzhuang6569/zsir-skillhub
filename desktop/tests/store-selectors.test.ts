import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shallow } from 'zustand/vanilla/shallow'
import { selectSkillCardState, selectSkillDetailSheetState, selectSkillLibraryListState } from '../src/lib/store-selectors.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')

// A minimal store shape: stable function identities, as zustand keeps them.
const fns = { openSkillSheet: () => undefined, setSkills: () => undefined, replaceSkill: () => undefined, promptForAuth: () => undefined, setMarketplaceSkills: () => undefined, closeSheet: () => undefined, setSheetTab: () => undefined }
const base = {
  ...fns, teams: [], activeTeamId: null, currentUser: null, skillTitlePreference: 'display', sheet: null, agentCapabilities: [],
  skills: [], marketplaceSkills: [], view: 'skills', searchQuery: '', categoryFilter: '全部', isLoadingSkills: false, hiddenCardAgents: new Set(),
} as unknown as Parameters<typeof selectSkillCardState>[0]

test('hot components re-render only for the fields they read (shallow-equal selector output)', () => {
  for (const select of [selectSkillCardState, selectSkillLibraryListState, selectSkillDetailSheetState]) {
    const before = select(base)
    // Unrelated updates the page makes constantly: search text, filters, loading flag, another list.
    const unrelated = { ...base, searchQuery: 'x', categoryFilter: '写作', isLoadingSkills: true, hiddenCardAgents: new Set(['codex']) }
    assert.equal(shallow(before, select(unrelated as typeof base)), true, `${select.name}: unrelated change must be shallow-equal`)
    // A related update is seen.
    const related = { ...base, teams: [{ id: 't' }] }
    assert.equal(shallow(before, select(related as typeof base)), false, `${select.name}: teams change must re-render`)
  }
  // The card does not subscribe to the whole skills array (only the sheet does).
  const skillsChanged = { ...base, skills: [{ id: 's' }] } as typeof base
  assert.equal(shallow(selectSkillCardState(base), selectSkillCardState(skillsChanged)), true)
  assert.equal(shallow(selectSkillLibraryListState(base), selectSkillLibraryListState(skillsChanged)), true)
  assert.equal(shallow(selectSkillDetailSheetState(base), selectSkillDetailSheetState(skillsChanged)), false)
})

test('the hot components subscribe through the shallow selectors and refresh single Skills by id', () => {
  const card = source('src/components/SkillCard.tsx')
  const list = source('src/components/SkillLibraryList.tsx')
  const sheet = source('src/components/SkillDetailSheet.tsx')
  assert.match(card, /useStore\(useShallow\(selectSkillCardState\)\)/)
  assert.match(list, /useStore\(useShallow\(selectSkillLibraryListState\)\)/)
  assert.match(sheet, /useStore\(useShallow\(selectSkillDetailSheetState\)\)/)
  for (const component of [card, list]) assert.doesNotMatch(component, /= useStore\(\)/)
  // Single-Agent toggles and version flows read back one Skill, not the whole list.
  assert.match(card, /const refreshed = await getLocalSkill\(managedSkillId\)/)
  assert.match(card, /const restored = await getLocalSkill\(managedSkillId\)/)
  assert.doesNotMatch(card, /getLocalSkills\(\)/)
  assert.match(sheet, /const refreshed = await getLocalSkill\(localId\)/)
  assert.doesNotMatch(sheet, /\(await getLocalSkills\(\)\)\.find\(/)
  // The page coalesces refreshes and publishes local results before the cloud answer.
  const page = source('src/pages/SkillsPage.tsx')
  assert.match(page, /createRefreshCoalescer\(runLoad\)/)
  assert.match(page, /const loadSkills = useCallback\(\(silent = false\): Promise<void> => loadCoalescer\.request\(silent\)/)
  assert.match(page, /loadCoalescer\.cancel\(\)/)
  assert.match(page, /await runSkillsLoad\(/)
  assert.doesNotMatch(page, /Promise\.allSettled\(\[\s*getLocalSkills\(\),\s*getUnmanagedAgentSkills\(\),\s*currentUser \? apiGetMySkills\(\)/)
  // The list placeholder clears when native results are published, not when the cloud answers;
  // the cloud phase has its own indicator and is not awaited by the native run (coalescer-free next refresh).
  assert.match(page, /publishLocal: \(local, unmanaged\) => \{[\s\S]{0,1800}if \(!silent\) setLoadingSkills\(false\)\s*\n\s*\},/)
  assert.match(page, /if \(load\.cloud\) void load\.cloud\.finally\(\(\) => \{ if \(current\(\)\) setCloudLoading\(false\) \}\)/)
  // The cloud phase shows only on the header refresh icon, never as text that widens the row (#317).
  assert.match(page, /const skillsRefreshing = isLoadingSkills \|\| cloudLoading/)
  assert.doesNotMatch(page, /skills-cloud-loading|同步云端资料/)
  // One in-flight owned request per account is shared by overlapping native refreshes.
  assert.match(page, /ownedInFlightRef\.current\?\.userId === expectedUserId \? ownedInFlightRef\.current\.request : null/)
  // The render gate is unchanged, so a settled local phase shows both tabs (list, or empty state) while the cloud is pending.
  assert.match(page, /\{isLoadingSkills && !\(skillTab !== 'local' && managedSkills\.length > 0\) \? \(/)
  // Earlier validation is carried over only for Skills this session already proved, never created here.
  assert.match(page, /known\.serverAccessValidatedForUserId === expectedUserId\s*\n?\s*\? reconcileLocalSkillRefresh\(known, skill\)/)
  assert.match(page, /publishOwnedFailure: \(\) => \{[\s\S]{0,400}mergeSkillSources\(localSkills, null, mergeContext\)/)
})
