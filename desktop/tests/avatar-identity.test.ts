import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { avatarIdentityFor, avatarParkSignature, parkingResolvedByReadBack, parseParkedAvatars } from '../src/lib/avatar-identity.ts'
import { createAvatarRetryState, isAvatarIdentityConflict, needsAvatarWork, parkAvatarConflict, parkedSignatureFor, recordAvatarFailure, releaseAvatarParking } from '../src/lib/avatar-retry.ts'
import { ApiError } from '../src/lib/api.ts'
import type { LocalSkill } from '../src/store/index.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')
const bound = { id: 'managed', localPath: '/m', isOwn: true, acquisitionSource: 'local', avatarLocalId: 'device-id',
  libraryAccountId: 'owner', libraryEntryId: 'entry-id', serverId: 'cloud', serverOwnerId: 'owner', serverAccessValidatedForUserId: 'owner',
  avatarStatus: 'pending', sharedTo: {}, labels: [], versions: [] } as LocalSkill

test('the account entry id is the stable identity once bound; the device id stays an alias and never crosses accounts', () => {
  assert.deepEqual(avatarIdentityFor(bound, 'owner'), { stableId: 'entry-id', aliasLocalIds: ['device-id'] })
  // Not in any account library: the device id is the identity, no aliases.
  assert.deepEqual(avatarIdentityFor({ ...bound, libraryAccountId: null, libraryEntryId: null }, 'owner'), { stableId: 'device-id', aliasLocalIds: [] })
  // Bound to another account: never borrow that account's entry id.
  assert.deepEqual(avatarIdentityFor(bound, 'other'), { stableId: 'device-id', aliasLocalIds: [] })
  assert.equal(avatarIdentityFor({ ...bound, avatarLocalId: undefined, libraryEntryId: null }, 'owner'), null)
  // A freshly derived device id can be supplied before it is on the store copy.
  assert.deepEqual(avatarIdentityFor({ ...bound, avatarLocalId: undefined }, 'owner', 'fresh'), { stableId: 'entry-id', aliasLocalIds: ['fresh'] })
})

test('parking signatures depend only on identity fields; status, URL and re-renders do not change them', () => {
  const identity = avatarIdentityFor(bound, 'owner')!
  const a = avatarParkSignature('owner', identity, 'cloud')
  assert.equal(a, avatarParkSignature('owner', { ...identity, aliasLocalIds: [...identity.aliasLocalIds] }, 'cloud'))
  assert.notEqual(a, avatarParkSignature('owner', identity, 'other-cloud'))
  assert.notEqual(a, avatarParkSignature('other', identity, 'cloud'))
  assert.notEqual(a, avatarParkSignature('owner', { ...identity, stableId: 'x' }, 'cloud'))
})

test('a 409 identity conflict parks the Skill: no timer, no ensure on focus/re-render, survives serialization', () => {
  const state = createAvatarRetryState()
  const conflict = new ApiError('http', '头像身份关联冲突', { status: 409, code: 'AVATAR_IDENTITY_CONFLICT' })
  assert.equal(isAvatarIdentityConflict(conflict), true)
  assert.equal(isAvatarIdentityConflict(new ApiError('http', 'busy', { status: 429, code: 'AVATAR_RATE_LIMITED' })), false)
  recordAvatarFailure(state, 'managed', conflict, 1_000)
  assert.equal(state.skills.has('managed'), false, 'a conflict schedules no retry time')
  const signature = parkAvatarConflict(state, 'owner', bound, 1_000)!
  assert.equal(parkedSignatureFor(state, 'owner', bound), signature)
  assert.equal(needsAvatarWork(bound, 'owner', new Map(), state.parked), false)
  assert.equal(needsAvatarWork(bound, 'owner', new Map()), true, 'without parking the Skill would be worked on')
  // Persisted and reloaded (sign-out / sign-in / restart) it is still parked; an identity change is not.
  const reloaded = parseParkedAvatars(JSON.stringify(state.parked))!
  assert.equal(needsAvatarWork(bound, 'owner', new Map(), reloaded), false)
  assert.equal(needsAvatarWork({ ...bound, serverId: 'rebound-cloud' }, 'owner', new Map(), reloaded), true)
  // No file yet is an empty record; anything malformed is a read failure (null), never "nothing parked".
  assert.deepEqual(parseParkedAvatars(null), {})
  assert.equal(parseParkedAvatars('not json'), null)
  assert.equal(parseParkedAvatars(JSON.stringify({ bad: { stableId: 1 } })), null)
  assert.equal(parseParkedAvatars(JSON.stringify([])), null)
  assert.equal(parseParkedAvatars(JSON.stringify({ x: { stableId: 'a', parkedAt: 1, aliasLocalIds: [3] } })), null)
  releaseAvatarParking(state, signature)
  assert.equal(parkedSignatureFor(state, 'owner', bound), null)
})

test('parking is released only by an explicit canonical + alias read-back; anything else keeps it parked', () => {
  const identity = avatarIdentityFor(bound, 'owner')!
  const ok = [{ localSkillId: 'entry-id', skillId: 'cloud', aliases: ['device-id'] }]
  assert.equal(parkingResolvedByReadBack(ok, identity, 'cloud'), true)
  assert.equal(parkingResolvedByReadBack(null, identity, 'cloud'), false, 'read-back failed')
  assert.equal(parkingResolvedByReadBack([], identity, 'cloud'), false, 'no conflicting rows proves nothing')
  assert.equal(parkingResolvedByReadBack([{ localSkillId: 'entry-id', skillId: 'cloud' }], identity, 'cloud'), false, 'older Server without aliases')
  assert.equal(parkingResolvedByReadBack([{ localSkillId: 'entry-id', skillId: 'cloud', aliases: [] }], identity, 'cloud'), false, 'our alias is not listed')
  assert.equal(parkingResolvedByReadBack([{ localSkillId: 'entry-id', skillId: 'other', aliases: ['device-id'] }], identity, 'cloud'), false, 'different cloud binding')
  assert.equal(parkingResolvedByReadBack([{ localSkillId: 'device-id', skillId: 'cloud', aliases: [] }], identity, 'cloud'), false, 'only the old key, no canonical')
  const unbound = { stableId: 'device-id', aliasLocalIds: [] }
  assert.equal(parkingResolvedByReadBack([{ localSkillId: 'device-id', skillId: null, aliases: [] }], unbound, null), true)
})

test('the avatar pass sends the stable identity with aliases, parks on 409, verifies read-only, and never ensures downloads', () => {
  const pass = source('src/lib/skill-avatars.ts')
  assert.match(pass, /localSkillId: identity\.stableId, aliasLocalIds: identity\.aliasLocalIds, skillId: skill\.serverId/)
  assert.match(pass, /if \(isAvatarIdentityConflict\(error\)\) \{[\s\S]{0,400}parkAvatarConflict\(retry, userId, skill, Date\.now\(\)\)[\s\S]{0,200}await persistParking\(userId, retry\)[\s\S]{0,100}continue/)
  assert.match(pass, /parsed = parseParkedAvatars\(await readAvatarParking\(userId\)\)/)
  assert.match(pass, /if \(parsed === null\) \{\s*\n\s*retry\.parkingLoadFailed = true/)
  assert.match(pass, /needsAvatarWork\(skill, userId, settled, retry\.parked\)/)
  // Read-back failure keeps parking; the only release path is the strict rule.
  // (Read-back failure keeping parking is exercised end-to-end in avatar-sync-flow.test.ts.)
  assert.match(pass, /\/\/ A failed read-back keeps every parked Skill parked/)
  assert.match(pass, /parkingResolvedByReadBack\(items, identity, skill\.serverId\)/)
  // Manual recheck is a GET only.
  const recheck = pass.slice(pass.indexOf('export async function recheckSkillAvatarIdentity'), pass.indexOf('export async function syncSkillAvatars'))
  assert.match(recheck, /apiGetSkillAvatars/)
  assert.doesNotMatch(recheck, /apiEnsureSkillAvatar|apiEnsureCloudSkillAvatar|apiRetrySkillAvatar/)
  // Downloads / team assets: the generate gate is the existing mayGenerateSkillAvatar; ensure is inside `if (generate && identity …)`.
  assert.match(pass, /if \(generate && identity && \(!avatar/)
  const sheet = source('src/components/SkillDetailSheet.tsx')
  // #228: task recovery remains internal; APP users see no generation diagnostics.
  assert.doesNotMatch(sheet, /apiRetrySkillAvatar|recheckSkillAvatarIdentity|重试生成|生成额度|avatarParkingProblem/)
  const icon = source('src/components/SkillAvatarIcon.tsx')
  assert.doesNotMatch(icon, /avatarStatusLabel|skill-avatar-flag|data-skill-avatar-status/)
})
