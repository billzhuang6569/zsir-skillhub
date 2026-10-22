import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('managed Skill cards keep identity, actions, and issue labels in one compact header', () => {
  const component = readFileSync(resolve(desktopRoot, 'src/components/SkillCard.tsx'), 'utf8')
  const styles = readFileSync(resolve(desktopRoot, 'src/components/SkillCard.css'), 'utf8')

  const headerStart = component.indexOf('<div className={`card-top')
  const identityStart = component.indexOf('<div className="card-identity">', headerStart)
  const sideStart = component.indexOf('<div className={`card-side', identityStart)
  const actionsStart = component.indexOf('<div className="card-icon-actions">', sideStart)
  const issuesStart = component.indexOf('<div className="card-issue-stack"', actionsStart)
  const headerEnd = component.indexOf('{skill.description', issuesStart)

  assert.ok(headerStart >= 0)
  assert.ok(identityStart > headerStart)
  assert.ok(sideStart > identityStart)
  assert.ok(actionsStart > sideStart)
  assert.ok(issuesStart > actionsStart)
  assert.ok(headerEnd > issuesStart)
  assert.doesNotMatch(component, /card-status-row/)

  assert.match(component, /cardAgents = cardAgentOptions\(installedAgents, skill\.agents, hiddenCardAgents\)/)
  assert.doesNotMatch(component, /\.slice\(0, 6\)/)
  assert.match(styles, /\.card-agent-buttons\s*\{[^}]*flex-wrap:\s*wrap;/s)
  assert.match(component, /className=\{`card-agent-button \$\{state\}`\}/)
  assert.match(component, /disableSkill\(managedSkillId, agent\.key\)/)
  assert.match(component, /<button type="button" className=\{`card-issue \$\{primaryIssueTone\}`\}/)
  assert.match(component, /keyIssue\.label[^]*envPolicyFailed[^]*钥匙检查未完成/)
  assert.match(styles, /\.card-top\s*\{[^}]*position:\s*relative;[^}]*display:\s*flex;[^}]*align-items:\s*flex-start;/s)
  assert.match(styles, /\.card-top\.has-issue\s*\{[^}]*margin-bottom:\s*18px;/s)
  assert.match(component, /className=\{`card-side\$\{hasIssues \? ' has-issue' : ''\}`\}/)
  assert.match(styles, /\.card-side\s*\{[^}]*min-width:\s*69px;[^}]*flex-direction:\s*column;[^}]*align-items:\s*flex-end;/s)
  assert.match(styles, /\.card-issue-stack\s*\{[^}]*position:\s*absolute;[^}]*top:\s*37px;[^}]*white-space:\s*nowrap;/s)
  assert.match(component, /<div className="card-issue-stack"[^]*<button[^]*<\/button>[^]*<\/div>/)
  assert.match(styles, /\.card-icon-actions button:focus-visible,[^}]*\.card-issue:focus-visible\s*\{[^}]*outline:/s)
  assert.match(component, /state === 'broken'[\s\S]*安装有问题，点击修复/)
  assert.match(component, /<AgentBrandIcon agent=\{agent\}/)
  assert.match(component, /isTeamDistributed && <span className="card-downloads"/)
  assert.match(component, /name=\{isTeamDistributed \? 'team' : 'user'\}/)
  assert.doesNotMatch(component, /<span className="card-downloads" title="下载量">/)
})
