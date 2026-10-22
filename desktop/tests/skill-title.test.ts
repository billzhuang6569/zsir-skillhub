import assert from 'node:assert/strict'
import test from 'node:test'
import { skillListText } from '../src/lib/skill-title.ts'

const skill = { name: 'hollywood-writer', displayName: '好莱坞编剧助手' }

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
