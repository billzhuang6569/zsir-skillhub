import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesPushContent, teamPushError, teamPushPlan } from '../src/lib/team-push-plan.ts'

const pack = { base64: '', size: 12, sha256: 'new-zip', contentHash: 'files', executablePaths: ['run.sh'] }
const state = { highWater: 11, nextVersion: '0.1.2', currentReceipt: null, pending: false }
const version = { id: 'old', skillId: 'skill', version: '0.1.0', createdAt: '', packageSha256: 'old-zip', contentIdentity: { contentHash: 'files', executablePaths: ['run.sh'] } }

test('unchanged files reuse the team formal UUID despite different ZIP bytes and a newer unrelated version', () => {
  const plan = teamPushPlan([version, { ...version, id: 'newer', version: '0.1.2', contentIdentity: { ...version.contentIdentity, contentHash: 'other' } }], pack, state, '0.1.0', 'old', true)
  assert.equal(matchesPushContent(version, pack), true)
  assert.equal(plan.existing?.id, 'old')
  assert.equal(plan.version, '0.1.0')
  assert.equal(plan.receiptId, undefined)
})

test('reuse another matching formal version; executable changes require publication', () => {
  assert.equal(teamPushPlan([version], pack, state, '0.1.0', 'different', true).existing?.id, 'old')
  assert.equal(matchesPushContent(version, { ...pack, executablePaths: [] }), false)
  assert.equal(matchesPushContent({ packageSha256: pack.sha256 }, pack), true)
})

test('publish saved 0.1.1 with its receipt instead of incrementing it again', () => {
  const saved = { ...state, currentReceipt: { receiptId: 'receipt', label: '0.1.1', cardSha256: 'another-zip', formalVersionId: null, formalLabel: null } }
  const plan = teamPushPlan([], pack, saved, '0.1.1', 'old', true)
  assert.equal(plan.version, '0.1.1')
  assert.equal(plan.receiptId, 'receipt')
  assert.equal(teamPushPlan([], pack, saved, '0.1.1', 'old', false).version, '0.1.2')
  assert.equal(teamPushPlan([], pack, { ...saved, pending: true }, '0.1.1', 'old', true).version, null)
})

test('push errors give Chinese recovery instructions without internal codes', () => {
  for (const error of ['VERSION_SOURCE_UNAVAILABLE: Formal version is not available', 'VERSION_LABEL_CONFLICT', 'SKILL_VERSION_LIMIT_REACHED', 'fetch failed']) {
    assert.doesNotMatch(teamPushError(new Error(error)), /VERSION_|SKILL_|fetch/)
    assert.match(teamPushError(error), /请/)
  }
  assert.equal(teamPushError(new Error('内容已变化，请重新打开推送确认框')), '内容已变化，请重新打开推送确认框')
})
