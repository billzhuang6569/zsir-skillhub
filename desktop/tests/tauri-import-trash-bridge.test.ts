import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tauriClient = readFileSync(resolve(desktopRoot, 'src/lib/tauri.ts'), 'utf8')
const nativeCommands = readFileSync(resolve(desktopRoot, 'src-tauri/src/commands.rs'), 'utf8')

function readTypeBody(name: string): string {
  const match = tauriClient.match(new RegExp(`export type ${name} = \\{([\\s\\S]*?)\\n\\}`))
  assert.ok(match, `${name} must be exported by the Tauri bridge`)
  return match[1]
}

test('import preflight bridge mirrors every camelCase Rust response field', () => {
  const source = readTypeBody('ImportSkillSource')
  for (const field of [
    'agentKey: string',
    'agentName: string',
    'entryName: string',
    'path: string',
    'canonicalPath: string',
    'fingerprint: string',
    'matchesSelected: boolean',
    'selected: boolean',
  ]) {
    assert.ok(source.includes(field), `ImportSkillSource is missing ${field}`)
  }

  const preflight = readTypeBody('ImportSkillPreflight')
  for (const field of [
    'skillId: string',
    'selectedPath: string',
    'selectedFingerprint: string',
    'sources: ImportSkillSource[]',
    'hasConflicts: boolean',
    'planDigest: string',
  ]) {
    assert.ok(preflight.includes(field), `ImportSkillPreflight is missing ${field}`)
  }

  assert.match(
    tauriClient,
    /preflightImportSkill\([\s\S]*?skillId: string \| null = null[\s\S]*?invoke<ImportSkillPreflight>\('preflight_import_skill', \{ path, skillId \}\)/,
  )
})

test('import bridge remains two-argument compatible and forwards conflict approval', () => {
  assert.match(
    tauriClient,
    /importSkill\([\s\S]*?skillId: string \| null = null,[\s\S]*?options: ImportSkillOptions = \{\},[\s\S]*?invoke<LocalSkill>\('import_skill', \{[\s\S]*?path,[\s\S]*?skillId,[\s\S]*?replaceConflicts: options\.replaceConflicts \?\? null,[\s\S]*?planDigest: options\.planDigest \?\? null,[\s\S]*?\}\)/,
  )
})

test('install bridge preflights Agent collisions and forwards the confirmed plan', () => {
  assert.match(
    tauriClient,
    /preflightInstallSkill\(skillId: string, agents: string\[\]\)[\s\S]*?invoke<ImportSkillPreflight>\('preflight_install_skill', \{ skillId, agents \}\)/,
  )
  assert.match(
    tauriClient,
    /installSkill\([\s\S]*?options: InstallSkillOptions = \{\},[\s\S]*?invoke\('install_skill', \{[\s\S]*?replaceConflicts: options\.replaceConflicts \?\? null,[\s\S]*?planDigest: options\.planDigest \?\? null/,
  )
  assert.match(nativeCommands, /pub async fn preflight_install_skill\(/)
  assert.match(nativeCommands, /pub async fn install_skill\([\s\S]*?replace_conflicts: Option<bool>,[\s\S]*?plan_digest: Option<String>/)
})

test('remote package import persists ownership, team catalog, Profile, and timing metadata', () => {
  assert.match(tauriClient, /acquisitionSource: AcquisitionSource/)
  assert.match(tauriClient, /acquiredByUserId\?: string/)
  assert.match(tauriClient, /replaceExistingMarketplace\?: boolean/)
  assert.match(tauriClient, /replaceExistingMarketplace: data\.replaceExistingMarketplace \?\? false/)
  assert.match(tauriClient, /rollbackMarketplaceReplacement\(recoveryId: string\)[\s\S]*?rollback_marketplace_replacement/)
  assert.match(tauriClient, /teamIds: string\[\]/)
  assert.match(tauriClient, /installCount: number/)
  assert.match(tauriClient, /createdAt\?: string/)
  assert.match(tauriClient, /updatedAt\?: string/)
  assert.match(tauriClient, /triggerScenarios: string\[\]/)
  assert.match(tauriClient, /compatibleAgents: string\[\]/)
  assert.match(tauriClient, /envDependencies: Array</)
})

test('remote downloads identify their source and bind only Team imports to the current account', () => {
  const detail = readFileSync(resolve(desktopRoot, 'src/components/SkillDetailSheet.tsx'), 'utf8')
  assert.match(
    detail,
    /const acquisitionSource = marketplaceInstall \? 'marketplace' : skill\.teamSharedFrom \? 'team' : 'local'/,
  )
  assert.match(detail, /acquisitionSource === 'team' && !currentUser\?\.id/)
  assert.match(
    detail,
    /acquiredByUserId: acquisitionSource === 'team' \? currentUser\?\.id : undefined/,
  )
})

test('heavy import commands leave the Tauri main thread before filesystem work', () => {
  for (const command of [
    'preflight_import_skill',
    'preflight_install_skill',
    'import_skill',
    'detect_env_vars',
    'sync_env_dependencies',
    'create_skill_package',
    'install_skill',
    'rollback_marketplace_replacement',
  ]) {
    assert.match(nativeCommands, new RegExp(`pub async fn ${command}\\(`))
  }
  assert.ok(
    (nativeCommands.match(/tauri::async_runtime::spawn_blocking/g)?.length ?? 0) >= 8,
    'every heavy import command should use a blocking worker',
  )
})

test('trash bridge exposes typed list, restore, and Finder-open commands', () => {
  const trashItem = readTypeBody('TrashItem')
  for (const field of [
    'id: string',
    'kind: string',
    'skillId: string',
    'displayName: string',
    'createdAt: number',
    'status: string',
    'reason: string | null',
    'sourceCount: number',
    'restorable: boolean',
    'location: string',
    'serverId: string | null',
    'serverOwnerId: string | null',
  ]) {
    assert.ok(trashItem.includes(field), `TrashItem is missing ${field}`)
  }

  assert.match(tauriClient, /listTrashItems\(\): Promise<TrashItem\[]>[\s\S]*?invoke<TrashItem\[]>\('list_trash_items_async'\)/)
  assert.match(tauriClient, /restoreTrashItem\(id: string\): Promise<void>[\s\S]*?invoke\('restore_trash_item', \{ id \}\)/)
  assert.match(tauriClient, /openTrashItem\(id: string\): Promise<void>[\s\S]*?invoke\('open_trash_item', \{ id \}\)/)
})

test('the personal key vault stays native and never returns a secret value to React', () => {
  for (const name of ['VaultKey', 'VaultKeySkill', 'KeyVaultSettings', 'KeyConsentRequest', 'VaultMigrationReport']) {
    assert.doesNotMatch(readTypeBody(name), /\bvalue\??:|secret\w*\??:/i, `${name} must not carry a value`)
  }
  assert.match(readTypeBody('VaultKey'), /usedBySkills: VaultKeySkill\[\]/)
  assert.match(readTypeBody('VaultKey'), /lastUsedAt: number \| null/)
  for (const [wrapper, command] of [
    ['listVaultKeys', 'list_vault_keys'],
    ['getKeyVaultSettings', 'get_key_vault_settings'],
    ['setVaultKey', 'set_vault_key'],
    ['deleteVaultKey', 'delete_vault_key'],
    ['setKeyAutoAllow', 'set_key_auto_allow'],
    ['grantKeyAccess', 'grant_key_access'],
    ['revokeKeyAccess', 'revoke_key_access'],
    ['listKeyConsentRequests', 'list_key_consent_requests'],
    ['dismissKeyConsentRequest', 'dismiss_key_consent_request'],
  ]) {
    assert.match(tauriClient, new RegExp(`${wrapper}[\\s\\S]*?'${command}'`))
    assert.match(nativeCommands, new RegExp(`pub (async )?fn ${command}\\(`))
  }
  assert.match(tauriClient, /setSkillEnv\([\s\S]*?scope: SkillEnvScope = 'vault'/)
  assert.match(nativeCommands, /scope: Option<SkillEnvScope>/)
  // Copying values between Skills is gone: one vault value serves them all.
  assert.doesNotMatch(tauriClient, /list_reusable_skill_envs|copy_skill_env_value|ReusableSkillEnv/)
  assert.doesNotMatch(nativeCommands, /fn list_reusable_skill_envs|fn copy_skill_env_value/)
  assert.match(nativeCommands, /is_local_env_value_path/)
  assert.match(nativeCommands, /discover_skill_env_values/)
})

test('last-run failure records (#292) are value-free and scoped to the current identity', () => {
  const record = readTypeBody('LastRunRecord')
  assert.doesNotMatch(record, /\bvalue\??:|secret\w*\??:/i)
  for (const field of [
    'version: number', 'skillId: string', 'at: number', "outcome: 'ok' | 'failed'",
    'reasonCode: LastRunReasonCode | null', 'keys: string[]', 'exitCode: number | null',
    'agent: string | null', 'message: string | null',
  ]) assert.ok(record.includes(field), `LastRunRecord is missing ${field}`)
  assert.match(tauriClient, /listLastRunFailures\(accountUserId: string \| null = null\): Promise<LastRunRecord\[]>[\s\S]*?invoke<LastRunRecord\[]>\('list_last_run_failures', \{ space: await currentSpace\(\), accountUserId \}\)/)
  assert.match(tauriClient, /clearLastRunFailure\(skillId: string, accountUserId: string \| null = null\): Promise<void>[\s\S]*?invoke\('clear_last_run_failure', \{ space: await currentSpace\(\), skillId, accountUserId \}\)/)
  for (const command of ['list_last_run_failures', 'clear_last_run_failure']) {
    assert.match(nativeCommands, new RegExp(`pub (?:async )?fn ${command}\\([\\s\\S]*?account_user_id: Option<String>[\\s\\S]*?with_current_identity_at`))
    assert.match(readFileSync(resolve(desktopRoot, 'src-tauri/src/lib.rs'), 'utf8'), new RegExp(`commands::${command},`))
  }
})
