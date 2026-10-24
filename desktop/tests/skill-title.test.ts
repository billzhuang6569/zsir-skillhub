import assert from 'node:assert/strict'
import test from 'node:test'
import { skillListText, truncateSkillName, UNANALYSED_SKILL_NAME } from '../src/lib/skill-title.ts'

test('list and detail share the missing friendly name copy', () => {
  assert.equal(UNANALYSED_SKILL_NAME, '尚未分析技能名')
})

const skill = { name: 'hollywood-writer', displayName: '好莱坞编剧助手' }

test('list names truncate only beyond 25 Unicode characters', () => {
  assert.equal(truncateSkillName('a'.repeat(25)), 'a'.repeat(25))
  assert.equal(truncateSkillName('技'.repeat(26)), `${'技'.repeat(25)}…`)
  assert.equal(truncateSkillName('😀'.repeat(26)), `${'😀'.repeat(25)}…`)
})

test('Skill name is the default primary list title', () => {
  assert.deepEqual(skillListText(skill, 'skill-name'), {
    primary: 'hollywood-writer',
    secondary: '好莱坞编剧助手',
  })
})

test('AI title preference reverses the title hierarchy', () => {
  assert.deepEqual(skillListText(skill, 'ai-title'), {
    primary: '好莱坞编剧助手',
    secondary: 'hollywood-writer',
  })
})

test('Identical values are not repeated', () => {
  assert.deepEqual(skillListText({ name: 'dbs', displayName: 'dbs' }, 'skill-name'), {
    primary: 'dbs',
    secondary: null,
  })
})
