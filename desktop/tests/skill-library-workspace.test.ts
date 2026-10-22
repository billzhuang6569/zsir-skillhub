import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const app = readFileSync(resolve(desktopRoot, 'src/App.tsx'), 'utf8')
const agentDetection = readFileSync(resolve(desktopRoot, 'src/lib/agent-detection.ts'), 'utf8')
const skillsPage = readFileSync(resolve(desktopRoot, 'src/pages/SkillsPage.tsx'), 'utf8')
const list = readFileSync(resolve(desktopRoot, 'src/components/SkillLibraryList.tsx'), 'utf8')
const listStyles = readFileSync(resolve(desktopRoot, 'src/components/SkillLibraryList.css'), 'utf8')
const detail = readFileSync(resolve(desktopRoot, 'src/components/SkillDetailSheet.tsx'), 'utf8')
const detailStyles = readFileSync(resolve(desktopRoot, 'src/components/SkillDetailSheet.css'), 'utf8')

test('My Skills uses a persistent directory and automatically selects a visible managed Skill', () => {
  assert.match(skillsPage, /<SkillLibraryList skills=\{skills\}/)
  assert.match(skillsPage, /orderSkills\(managedSkills\.filter/)
  assert.match(skillsPage, /orderSkillsByName\(unmanagedSkills\.filter/)
  assert.match(skillsPage, /filtered\.some\(\(skill\) => skill\.id === sheet\.skillId\)/)
  assert.match(skillsPage, /openSkillSheet\(firstSkill\.id\)/)
  assert.match(skillsPage, /告诉 SkillHub 你想找什么/)
  assert.doesNotMatch(skillsPage, />目录<\/span>/)
})

test('Skill workspace keeps the directory and non-modal detail side by side', () => {
  assert.match(app, /className=\{`app-workspace\$\{workspaceSkillSheet \|\| localSkillWorkspace \? ' skill-browser-open' : ''\}`\}/)
  assert.match(app, /<SkillDetailSheet\s+mode="workspace"/)
  assert.match(app, /localSkillWorkspace && <LocalSkillPreviewPanel/)
  assert.match(detail, /<section className="detail-sheet workspace on"/)
  assert.match(detail, /mode === 'overlay' && <button className="ico-btn sh-close"/)
  assert.match(detailStyles, /\.detail-sheet\.workspace\s*\{[^}]*position:\s*relative;[^}]*border-radius:\s*0;/s)
})

test('Skill directory rows expose compact identity, Agent state, issues, and vertical keyboard navigation', () => {
  assert.match(list, /role="listbox"/)
  assert.match(list, /role="option"/)
  assert.match(list, /nextRovingIndex\(index, skills\.length, event\.key, 'vertical'\)/)
  assert.match(list, /<AgentBrandIcon/)
  assert.match(list, /issueForSkill/)
  assert.match(list, /activeAgentEntries\(skill\.agents\)/)
  assert.match(list, /supportedAgentKeys\.has\(agentKey\)/)
  assert.match(list, /skill-library-no-agent">未安装/)
  assert.match(app, /refreshAgentCapabilities\(\)/)
  assert.match(agentDetection, /setAgentCapabilities\(agents\)/)
  assert.match(skillsPage, /platformAgents\.map\(\(agent\) => agent\.key\)/)
  assert.doesNotMatch(skillsPage, /import \{[^}]*AGENT_KEYS/)
  assert.match(listStyles, /\.skill-library-row\s*\{[^}]*grid-template-columns:/s)
  assert.match(listStyles, /\.skill-library-row\.selected::before/)
})

test('Skill directory avatar owns one stable geometry and preserves its shared outline', () => {
  assert.match(list, /size=\{44\}/)
  assert.match(list, /avatarUrl=\{skill.avatarUrl\}/)
  assert.match(listStyles, /--skill-library-avatar-size:\s*48px/)
  assert.match(listStyles, /\.skill-library-avatar-wrap\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;[^}]*width:\s*var\(--skill-library-avatar-size\);[^}]*height:\s*var\(--skill-library-avatar-size\);/s)
  assert.match(listStyles, /\.skill-library-avatar-wrap\.team-shared::before\s*\{[^}]*inset:\s*-50%;[^}]*border-radius:\s*50%;/s)
  assert.match(listStyles, /\.skill-library-avatar\s*\{[^}]*width:\s*44px\s*!important;[^}]*height:\s*44px\s*!important;/s)
  assert.doesNotMatch(listStyles, /@media[^}]+\.skill-library-avatar\s*\{[^}]*width:/s)
})
