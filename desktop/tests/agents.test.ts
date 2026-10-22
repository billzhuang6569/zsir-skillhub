import assert from 'node:assert/strict'
import test from 'node:test'
import { activeAgentEntries, agentAcceptsSkillWrites, agentStateLabel, agentStateTitle, cardAgentOptions, parseHiddenCardAgents } from '../src/lib/agents.ts'

test('Skill list shows no Agent icons after removal from every tool', () => {
  assert.deepEqual(activeAgentEntries({
    claude: 'off',
    codex: 'off',
    opencode: null,
    gemini: 'off',
  }), [])
})

test('Skill list keeps active and broken installations only', () => {
  assert.deepEqual(activeAgentEntries({
    gemini: 'off',
    codex: 'broken',
    claude: 'on',
  }), [
    ['claude', 'on'],
    ['codex', 'broken'],
  ])
})

const detectedAgents = [
  { key: 'claude', detected: true },
  { key: 'codex', detected: true },
  { key: 'workbuddy', detected: true },
  { key: 'doubao', detected: true },
  { key: 'opencode', detected: false },
  { key: 'openclaw', detected: true },
  { key: 'gemini', detected: true },
  { key: 'trae', detected: true },
]

test('Skill cards show every detected Agent instead of truncating at six', () => {
  assert.deepEqual(
    cardAgentOptions(detectedAgents, {}, []).map((agent) => agent.key),
    ['claude', 'codex', 'workbuddy', 'doubao', 'openclaw', 'gemini', 'trae'],
  )
})

test('Hidden card Agents stay visible while this Skill is installed or broken there', () => {
  assert.deepEqual(
    cardAgentOptions(detectedAgents, { gemini: 'on', trae: 'broken', codex: 'off' }, ['gemini', 'trae', 'codex'])
      .map((agent) => agent.key),
    ['claude', 'workbuddy', 'doubao', 'openclaw', 'gemini', 'trae'],
  )
})

test('Undetected Agents never become card toggles, even with a stale installation state', () => {
  assert.deepEqual(
    cardAgentOptions(detectedAgents, { opencode: 'on' }, []).some((agent) => agent.key === 'opencode'),
    false,
  )
})

test('Hidden card Agent preference tolerates missing or corrupted storage', () => {
  assert.deepEqual(parseHiddenCardAgents(null), [])
  assert.deepEqual(parseHiddenCardAgents('not json'), [])
  assert.deepEqual(parseHiddenCardAgents('{"gemini":true}'), [])
  assert.deepEqual(parseHiddenCardAgents('["gemini", 3, "", "gemini", "trae"]'), ['gemini', 'trae'])
})

test('Settings shows 检测未完成 only for native incomplete detection and keeps 未检测 otherwise', () => {
  assert.equal(agentStateLabel({ detected: false, detectionSource: 'none' }), '未检测')
  assert.equal(agentStateLabel({ detected: false, detectionSource: 'none', detectionState: 'notFound' }), '未检测')
  assert.equal(agentStateLabel({ detected: false, detectionSource: 'none', detectionState: 'incomplete', detectionIssues: ['x'] }), '检测未完成')
  assert.equal(agentStateLabel({ detected: true, detectionSource: 'application', detectionState: 'detected' }), '已检测 APP')
  assert.equal(agentStateLabel({ detected: true, detectionSource: 'cli' }), '已检测 CLI')
})

test('Detection issues are exposed as a local tooltip and absent when there are none', () => {
  assert.equal(agentStateTitle({ detected: false, detectionSource: 'none' }), undefined)
  assert.equal(agentStateTitle({ detected: false, detectionSource: 'none', detectionIssues: [] }), undefined)
  assert.equal(
    agentStateTitle({ detected: false, detectionSource: 'none', detectionState: 'incomplete', detectionIssues: ['无法读取注册表 HKCU\\Environment'] }),
    '部分检测来源读取失败，无法确认是否已安装：\n无法读取注册表 HKCU\\Environment',
  )
  assert.match(agentStateTitle({ detected: true, detectionSource: 'cli', detectionIssues: ['a', 'b'] }) ?? '', /^已检测到，但部分来源读取失败：\na\nb$/)
})

test('Card shortcuts skip Agents whose Skill root is unconfirmed unless they already hold the Skill', () => {
  const agents = [
    { key: 'claude', detected: true, skillsStatus: 'ready' },
    { key: 'codex', detected: true, skillsStatus: 'unconfirmed' },
  ]
  assert.deepEqual(cardAgentOptions(agents, { claude: null, codex: null }, []).map((agent) => agent.key), ['claude'])
  assert.deepEqual(cardAgentOptions(agents, { claude: null, codex: 'on' }, []).map((agent) => agent.key), ['claude', 'codex'])
})

test('Write pickers use the native admission rule: unconfirmed roots are never selectable', () => {
  assert.equal(agentAcceptsSkillWrites({ detected: true, skillsStatus: 'ready' }), true)
  assert.equal(agentAcceptsSkillWrites({ detected: true, skillsStatus: 'missing' }), true)
  assert.equal(agentAcceptsSkillWrites({ detected: true, skillsStatus: 'unconfirmed' }), false)
  assert.equal(agentAcceptsSkillWrites({ detected: false, skillsStatus: 'ready' }), false)
})
