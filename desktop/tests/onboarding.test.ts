import assert from 'node:assert/strict'
import test from 'node:test'
import { onboardingKind, completionKey, GUIDE_STEPS, nextGuideStep, nextTourTarget, emptyStateActions, restoreGuideProgress } from '../src/lib/onboarding.ts'
import { docsUrl, connectionHelpTopic, DOC_LINKS } from '../src/lib/docs.ts'
import { OFFICIAL_ENDPOINTS } from '../src/lib/official-endpoints.ts'

test('settings documentation topics reach the agent, migration and documentation index pages', () => {
  assert.equal(DOC_LINKS.agents, docsUrl('guides/manage-agent-skills'))
  assert.equal(DOC_LINKS.migrate, docsUrl('account-and-data/migrate-skills'))
  assert.equal(DOC_LINKS.docs, OFFICIAL_ENDPOINTS.docsOrigin)
  assert.equal('cli' in DOC_LINKS, false)
})

test('only no session, no managed Skill and no completion is a fresh install', () => {
  const fresh = { hasSession: false, hasManagedSkills: false, completed: false, introSeen: false }
  for (const hasSession of [false, true]) for (const hasManagedSkills of [false, true]) {
    for (const completed of [false, true]) for (const introSeen of [false, true]) {
      assert.equal(onboardingKind({ ...fresh, hasSession, hasManagedSkills, completed, introSeen }),
        completed || introSeen ? null : hasSession || hasManagedSkills ? 'upgrade' : 'welcome')
    }
  }
})
test('configuration belongs to each space; tour and completion belong to device', () => {
  for (const step of ['mode', 'ai'] as const) assert.notEqual(completionKey(step, 'official'), completionKey(step, 'selfhost-a'))
  for (const step of ['tour', 'completed', 'intro'] as const) assert.equal(completionKey(step, 'official'), completionKey(step, 'selfhost-a'))
  const preferences = new Map<string, string>()
  preferences.set(completionKey('ai', 'official'), '1')
  assert.equal(preferences.get(completionKey('ai', 'selfhost-a')), undefined)
  preferences.set(completionKey('tour', 'official'), '1')
  assert.equal(preferences.get(completionKey('tour', 'selfhost-a')), '1')
})
test('skipping all steps reaches done without requiring configuration', () => {
  assert.deepEqual(GUIDE_STEPS.map(step => nextGuideStep(step, true)), ['agents', 'ai', 'tour', 'done', null])
  assert.equal(nextGuideStep('agents', false), 'tour')
})
test('AI progress cannot resume for another space or a non-admin', () => {
  const progress = JSON.stringify({ step: 'ai', spaceId: 'selfhost-a' })
  assert.equal(restoreGuideProgress(progress, 'selfhost-a', true), 'ai')
  assert.equal(restoreGuideProgress(progress, 'selfhost-b', true), 'tour')
  assert.equal(restoreGuideProgress(progress, 'selfhost-a', false), 'tour')
  assert.equal(restoreGuideProgress('{broken', 'official', false), null)
})
test('missing tour targets skip forward and backward, including all missing', () => {
  const ids = ['skills', 'install', 'marketplace']
  assert.equal(nextTourTarget(ids, 0, 1, id => id !== 'install'), 2)
  assert.equal(nextTourTarget(ids, 2, -1, id => id !== 'install'), 0)
  assert.equal(nextTourTarget(ids, -1, 1, () => false), null)
})
test('local Skills still allow explicit catalogue access; unsupported teams have no creation action', () => {
  assert.deepEqual(emptyStateActions({ teams: false }, 'skills'), ['import', 'marketplace'])
  assert.deepEqual(emptyStateActions({ teams: false }, 'teams'), [])
  assert.deepEqual(emptyStateActions({ teams: true }, 'teams'), ['create-team'])
})
test('docs URL uses compiled origin and rejects traversal or external destinations', () => {
  assert.equal(docsUrl('guides/keys'), 'https://sk.woe.show/docs/guides/keys/')
  assert.equal(docsUrl('self-host/troubleshooting', 'setup-code-expired'), 'https://sk.woe.show/docs/self-host/troubleshooting/#setup-code-expired')
  for (const slug of ['../keys', '/keys', 'https://example.com', 'keys?x=1']) assert.throws(() => docsUrl(slug))
  assert.throws(() => docsUrl('guides/keys', '../bad'))
})
test('connection errors link to their specific troubleshooting anchors', () => {
  for (const [code, anchor] of [['certificate_untrusted', 'cert-untrusted'], ['certificate_expired', 'cert-expired'], ['certificate_name_mismatch', 'cert-name-mismatch'], ['instance_changed', 'instance-changed'], ['host_mismatch', 'host-mismatch']]) {
    assert.ok(DOC_LINKS[connectionHelpTopic(code)].endsWith(`#${anchor}`))
  }
  assert.equal(connectionHelpTopic('unknown'), 'connectionError')
})
