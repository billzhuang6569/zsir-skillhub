import { invoke } from '@tauri-apps/api/core'
export async function getSkillPackageDiff(skillId: string, packageBase64: string, expectedSha256: string): Promise<[number, SkillDiffLine[]]> {
  return invoke('get_skill_package_diff', { skillId, packageBase64, expectedSha256 })
}
export type SkillPackageDiffLine = { kind: 'add' | 'del' | 'ctx'; oldLine: number | null; newLine: number | null; content: string }
export type SkillFileDiff = { path: string; status: 'added' | 'modified' | 'deleted'; binary: boolean; tooLarge: boolean; lines: SkillPackageDiffLine[] }
export type SkillPackageFileDiff = SkillFileDiff
export async function getSkillWorkingFileDiffs(skillId: string): Promise<SkillFileDiff[]> {
  return invoke('get_skill_working_file_diffs', { skillId })
}
export async function getSkillPackageFileDiffs(skillId: string, packageBase64: string, expectedSha256: string): Promise<SkillPackageFileDiff[]> {
  return invoke('get_skill_package_file_diffs', { skillId, packageBase64, expectedSha256 })
}
export async function getSkillSourceDiff(skillId: string): Promise<SkillDiffLine[]> {
  return invoke('get_skill_source_diff', { skillId })
}
export async function saveSkillAsPersonal(skillId: string): Promise<LocalSkill> {
  return invoke('save_skill_as_personal', { skillId })
}
export async function discardSkillSourceChanges(skillId: string): Promise<LocalSkill> {
  return invoke('discard_skill_source_changes', { skillId })
}
import type { ApiAuthSession } from './api.js'
import type { AcquisitionSource, LocalSkill } from '../store/index.js'
import type { AccountDeleteOutcome, LibraryEntryList, LibrarySyncReport, LibrarySyncStatus } from './library-sync.js'
import { notifyEnvReadinessChanged } from './env-readiness.ts'
import type serverRoutes from './server-routes.json'
import type { OrganizerState } from './skill-organizer.js'

export type SpaceHandle = { spaceId: string; generation: number }
export async function onboardingEvidence(): Promise<{ hasSession: boolean; hasManagedSkills: boolean }> {
  return invoke('onboarding_evidence')
}
export type LocalInferenceAgent = 'claude' | 'codex'
export type LocalInferenceWorkerStatus = {
  revision: number
  space: SpaceHandle; userId: string
  state: 'off' | 'idle' | 'running' | 'paused' | 'unavailable' | 'error'
  completed: number; analyzed: number; drafted: number; failed: number
  lastError?: string; pausedReason?: string; skillId?: string; avatarJobId?: string
}
export async function localInferenceWorkerConfigure(space: SpaceHandle, enabled: boolean, agent: LocalInferenceAgent): Promise<void> {
  return invoke('local_inference_worker_configure', { space, enabled, agent })
}
export async function localInferenceWorkerStatus(space: SpaceHandle): Promise<LocalInferenceWorkerStatus> {
  return invoke('local_inference_worker_status', { space })
}
export type LocalInferenceProbe = {
  agent: LocalInferenceAgent; version: string | null; available: boolean; reason: string | null; modelsSupported: boolean
  checks: Array<{ name: 'executable' | 'version' | 'login' | 'minimalCall' | 'isolation'; status: 'passed' | 'failed' | 'skipped'; reason: string | null }>
}
export type LocalInferenceProfile = { displayName: string; description: string; category: string; labels: string[]; triggerScenarios: string[] }
export async function localInferenceProbe(space: SpaceHandle, runId: string): Promise<{ space: SpaceHandle; probes: LocalInferenceProbe[] }> {
  return invoke('local_inference_probe', { space, runId })
}
/** Part 1 only runs a native-owned fixed sample; no user input or background jobs. */
export async function localInferenceRun(space: SpaceHandle, runId: string, agent: LocalInferenceAgent): Promise<{ space: SpaceHandle; result: LocalInferenceProfile; elapsedMs: number }> {
  return invoke('local_inference_run', { space, runId, agent })
}
export async function localInferenceCancel(space: SpaceHandle, runId: string): Promise<boolean> {
  return invoke('local_inference_cancel', { space, runId })
}
export type ServerRoute = keyof typeof serverRoutes
export type ServerRequestBody = { kind: 'json'; value: unknown } | { kind: 'bytes'; value: number[] }
export type ServerRequest = {
  requestId: string
  space: SpaceHandle
  route: ServerRoute
  params?: Record<string, string>
  query?: Record<string, string>
  body?: ServerRequestBody
  timeoutMs?: number
}
export type ServerResponse = {
  space?: SpaceHandle
  status: number
  statusText?: string
  headers: Record<string, string>
  body: { kind: 'empty' } | { kind: 'json'; value: unknown } | { kind: 'bytes'; value: Uint8Array }
}

export async function currentSpace(): Promise<SpaceHandle> {
  return invoke<SpaceHandle>('current_space')
}

export async function currentMediaSpace(catalog = false): Promise<{ space: SpaceHandle; serverBase: string; mediaKey: string; previousOrigins?: string[]; allowedImageHosts?: string[] }> {
  return invoke('current_media_space', { catalog })
}

export async function serverRequest(request: ServerRequest): Promise<ServerResponse> {
  const response = await invoke<ServerResponse | ArrayBuffer | number[]>('server_request', {
    request: { ...request, space: { spaceId: request.space.spaceId, generation: request.space.generation } },
  })
  if (!(response instanceof ArrayBuffer) && !Array.isArray(response)) return response
  // Tauri's macOS postMessage fallback serializes a raw response as number[].
  const bytes = new Uint8Array(response)
  // Native binary IPC: u32 LE metadata length, JSON metadata, then body bytes.
  if (bytes.byteLength < 4) throw new Error('SkillHub 二进制响应格式无效')
  const length = new DataView(bytes.buffer).getUint32(0, true)
  if (length > bytes.byteLength - 4) throw new Error('SkillHub 二进制响应格式无效')
  const metadata: ServerResponse = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)))
  return { ...metadata, body: { kind: 'bytes', value: bytes.subarray(4 + length) } }
}

export async function cancelServerRequest(space: SpaceHandle, requestId: string): Promise<boolean> {
  return invoke<boolean>('cancel_server_request', { space: { spaceId: space.spaceId, generation: space.generation }, requestId })
}

export type YitanPortalAuthMode = 'login' | 'link'

export async function startYitanPortalAuth(
  mode: YitanPortalAuthMode,
  expectedUserId: string | null = null,
  space: SpaceHandle | null = null,
  useOtherAccount = false,
): Promise<ApiAuthSession> {
  return invoke<ApiAuthSession>('start_yitan_portal_auth', { mode, expectedUserId, space, useOtherAccount })
}

export async function cancelYitanPortalAuth(): Promise<boolean> {
  return invoke<boolean>('cancel_yitan_portal_auth')
}

export type CatalogSessionStatus = { signedIn: boolean; user?: { id: string; displayName: string; avatarUrl: string | null }; expiresAt?: string }
export type CatalogProfile = { displayName: string; description: string; category: string; labels: string[]; triggerScenarios: string[]; sourceUrl?: string; compatibleAgents: string[]; envDependencies: { key: string; description?: string; required: boolean }[] }
export type CatalogSubmission = { id: string; skillId: string; status: string; reviewNote?: string | null }
export async function catalogSessionStatus(): Promise<CatalogSessionStatus> { return invoke('catalog_session_status') }
export async function startCatalogLogin(expectedUserId: string | null = null): Promise<CatalogSessionStatus> { return invoke('start_catalog_login', { expectedUserId }) }
export async function cancelCatalogLogin(): Promise<boolean> { return invoke('cancel_catalog_login') }
export async function catalogLogout(): Promise<void> { return invoke('catalog_logout') }
export async function catalogPublish(input: { space: SpaceHandle; sourceSkillId: string; clientOperationId: string; profile: CatalogProfile; note?: string }): Promise<CatalogSubmission> { return invoke('catalog_publish', { input }) }
export async function catalogSubmissionStatus(space: SpaceHandle, sourceSkillId: string): Promise<CatalogSubmission | null> { return invoke('catalog_submission_status', { space, sourceSkillId }) }

export async function openYitanAccountPortal(): Promise<void> {
  return invoke('open_yitan_account_portal')
}

// ---- Native image upload ----
export type AvatarUploadResult = { url: string }

export async function pickAndUploadAvatar(accountUserId: string): Promise<AvatarUploadResult | null> {
  return invoke<AvatarUploadResult | null>('pick_and_upload_avatar', { accountUserId, space: await currentSpace() })
}

/** A validated original (≤ 10 MiB, 64–8192 px) for the Skill avatar crop dialog; null when the picker is cancelled. */
export type AvatarSource = { mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; dataBase64: string; width: number; height: number }

export async function pickAvatarSource(): Promise<AvatarSource | null> {
  return invoke<AvatarSource | null>('pick_avatar_source')
}

/** `null` when nothing is new: unchanged clipboard, a read still in flight, or a slow read (#223). */
export async function readClipboardText(): Promise<string | null> {
  return invoke<string | null>('read_clipboard_text')
}

export async function takePendingDeepLinks(): Promise<string[]> {
  return invoke<string[]>('take_pending_deep_links')
}

export async function normalizeInviteServer(value: string): Promise<string> {
  return invoke<string>('normalize_invite_server', { value })
}

// ---- Local skill management ----
export async function getLocalSkills(): Promise<LocalSkill[]> {
  return invoke<LocalSkill[]>('get_local_skills')
}

/** One managed Skill by its folder id, read like the list reads it; `null` when the folder is gone. */
export async function getLocalSkill(skillId: string): Promise<LocalSkill | null> {
  return invoke<LocalSkill | null>('get_local_skill', { skillId })
}

export type AgentSkillSource = {
  agentKey: string
  agentName: string
  entryName: string
  /** Grouping folder when the Skill sits at `<agent skills>/<group>/<entryName>`. */
  group?: string
}

export type ImportSkillSource = {
  agentKey: string
  agentName: string
  entryName: string
  path: string
  canonicalPath: string
  fingerprint: string
  matchesSelected: boolean
  selected: boolean
}

export type ImportSkillPreflight = {
  skillId: string
  selectedPath: string
  selectedFingerprint: string
  sources: ImportSkillSource[]
  hasConflicts: boolean
  planDigest: string
}

export type ImportSkillOptions = {
  replaceConflicts?: boolean
  planDigest?: string
}

export type InstallSkillOptions = ImportSkillOptions

export type TrashItem = {
  id: string
  kind: string
  skillId: string
  displayName: string
  createdAt: number
  status: string
  reason: string | null
  sourceCount: number
  restorable: boolean
  location: string
  serverId: string | null
  serverOwnerId: string | null
}

export type UnmanagedSkill = {
  managedSkillId?: string
  joinLocalId?: string
  id: string
  name: string
  displayName: string
  description?: string
  category?: string
  labels: string[]
  version: string
  sources: AgentSkillSource[]
  localPath: string
}

export async function skillLibraryFingerprint(): Promise<string> {
  return invoke<string>('skill_library_fingerprint')
}

export async function getUnmanagedAgentSkills(): Promise<UnmanagedSkill[]> {
  return invoke<UnmanagedSkill[]>('get_unmanaged_agent_skills')
}

export async function openAgentSkillDir(agent: string, skillName: string, group?: string): Promise<void> {
  return invoke('open_agent_skill_dir', { agent, skillName, group: group ?? null })
}

export async function openAgentSkillConflict(agent: string, skillName: string): Promise<void> {
  return invoke('open_agent_skill_conflict', { agent, skillName })
}

export async function preflightInstallSkill(skillId: string, agents: string[]): Promise<ImportSkillPreflight> {
  return invoke<ImportSkillPreflight>('preflight_install_skill', { skillId, agents })
}

export async function installSkill(
  skillId: string,
  agents: string[],
  options: InstallSkillOptions = {},
): Promise<void> {
  return invoke('install_skill', {
    skillId,
    agents,
    replaceConflicts: options.replaceConflicts ?? null,
    planDigest: options.planDigest ?? null,
  })
}

export async function uninstallSkill(skillId: string): Promise<void> {
  return invoke('uninstall_skill', { skillId })
}

export type UnmanagePlan = { destinations: string[]; affectedAgents: string[]; planDigest: string }
export async function preflightUnmanageSkill(skillId: string, agents: string[]): Promise<UnmanagePlan> {
  return invoke('preflight_unmanage_skill', { skillId, agents })
}
export async function unmanageSkill(skillId: string, agents: string[], planDigest: string): Promise<string> {
  return invoke('unmanage_skill', { skillId, agents, planDigest })
}

export async function deleteManagedSkill(skillId: string): Promise<string> {
  return invoke<string>('delete_managed_skill', { skillId })
}

export async function enableSkill(skillId: string, agent: string): Promise<void> {
  return invoke('enable_skill', { skillId, agent })
}

export async function disableSkill(skillId: string, agent: string): Promise<void> {
  return invoke('disable_skill', { skillId, agent })
}

export async function preflightImportSkill(
  path: string,
  skillId: string | null = null,
): Promise<ImportSkillPreflight> {
  return invoke<ImportSkillPreflight>('preflight_import_skill', { path, skillId })
}

export async function importSkill(
  path: string,
  skillId: string | null = null,
  options: ImportSkillOptions = {},
): Promise<LocalSkill> {
  return invoke<LocalSkill>('import_skill', {
    path,
    skillId,
    replaceConflicts: options.replaceConflicts ?? null,
    planDigest: options.planDigest ?? null,
  })
}

export async function openSkillDir(skillId: string): Promise<void> {
  return invoke('open_skill_dir', { skillId })
}

export async function listTrashItems(): Promise<TrashItem[]> {
  return invoke<TrashItem[]>('list_trash_items_async')
}

export async function restoreTrashItem(id: string): Promise<void> {
  return invoke('restore_trash_item', { id })
}

export async function openTrashItem(id: string): Promise<void> {
  return invoke('open_trash_item', { id })
}

// ---- Version management ----
export async function getSkillVersions(skillId: string) {
  return invoke<LocalSkill['versions']>('get_skill_versions', { skillId })
}

export type SkillVersionReceipt = {
  receiptId: string
  label: string
  cardSha256: string
  formalVersionId: string | null
  formalLabel: string | null
}

export type SkillVersionState = {
  highWater: number
  nextVersion: string | null
  currentReceipt: SkillVersionReceipt | null
  pending: boolean
  pendingAllocation?: 'auto' | 'manual' | null
  pendingLabel?: string | null
}

export async function getSkillVersionState(skillId: string): Promise<SkillVersionState> {
  return invoke('get_skill_version_state', { skillId })
}

export async function createSkillSnapshot(skillId: string, message: string, version?: string, allocation: 'auto' | 'manual' = 'auto'): Promise<void> {
  return invoke('create_skill_snapshot_with_version', { skillId, message, version, allocation })
}

export async function recordSkillFormalVersion(skillId: string, versionId: string, gitHash?: string, frozenToken?: string): Promise<void> {
  return invoke('record_skill_formal_version', { skillId, versionId, gitHash, ...(frozenToken ? { frozenToken } : {}) })
}

export async function freezeSkillVersion(skillId: string, message: string, version: string): Promise<string> {
  return invoke('freeze_skill_version', { skillId, message, version })
}
export type FrozenVersionPackage = { package: SkillPackage; skillMd: string; envDependencies: EnvDeclaration[] }
export async function packageFrozenSkillVersion(skillId: string, snapshotId: string): Promise<FrozenVersionPackage> {
  return invoke('package_frozen_skill_version', { skillId, snapshotId })
}
export async function saveFrozenSkillVersion(skillId: string, snapshotId: string, version: string, allocation: 'auto' | 'manual'): Promise<void> {
  return invoke('save_frozen_skill_version', { skillId, snapshotId, version, allocation })
}
export async function releaseFrozenSkillVersion(snapshotId: string): Promise<void> {
  return invoke('release_frozen_skill_version', { snapshotId })
}

export async function restoreSkillVersion(skillId: string, hash: string, receiptId?: string): Promise<void> {
  return invoke('restore_skill_version', { skillId, hash, receiptId })
}

export type SkillDiffLine = { kind: 'add' | 'del' | 'ctx'; content: string }

export async function getSkillDiff(skillId: string, fromHash: string, toHash: string): Promise<SkillDiffLine[]> {
  return invoke<SkillDiffLine[]>('get_skill_diff', { skillId, fromHash, toHash })
}

// ---- Environment variables ----
export async function detectEnvVars(skillId: string): Promise<string[]> {
  return invoke<string[]>('detect_env_vars', { skillId })
}

export type EnvConfidence = 'declared' | 'high' | 'medium' | 'low'

/** 检测建议：证据只随检测结果返回，不写入 sidecar。 */
export type EnvSuggestion = {
  key: string
  confidence: EnvConfidence
  evidence: string[]
}

export async function detectEnvVarSuggestions(skillId: string): Promise<EnvSuggestion[]> {
  return invoke<EnvSuggestion[]>('detect_env_var_suggestions', { skillId })
}

/** SKILL.md `metadata.skillhub.env` 中的一项声明（#251）。 */
export type EnvDeclaration = {
  key: string
  required: boolean
  description?: string
  obtain?: string
}

/** 读取受管 SKILL.md 的钥匙声明；声明无效时报错。 */
export async function readEnvDeclarations(skillId: string): Promise<EnvDeclaration[]> {
  return invoke<EnvDeclaration[]>('read_env_declarations', { skillId })
}

/** 只改写 SKILL.md frontmatter 的 `metadata.skillhub.env`，并同步 sidecar。 */
export async function writeEnvDeclarations(skillId: string, deps: EnvDeclaration[]): Promise<LocalSkill> {
  return invoke<LocalSkill>('write_env_declarations', { skillId, deps })
}

/** 导入时（桌面与 CLI 同一规则）自动写入的置信度；low 只作提示。 */
export function isImportedEnvSuggestion(suggestion: EnvSuggestion): boolean {
  return suggestion.confidence !== 'low'
}

export type AgentInfo = {
  key: string
  name: string
  dir: string
  detected: boolean
  detectionSource: 'application' | 'cli' | 'none'
  /** `unconfirmed`：设置了 Skill 目录覆盖变量（如 CODEX_HOME），保留安装证据但不允许写入默认目录。 */
  skillsStatus: 'ready' | 'missing' | 'unconfirmed'
  /** `incomplete`：未找到安装证据，且该 Agent 依赖的检测来源读取失败，不能断定未安装；不授予写入资格。 */
  detectionState?: AgentDetectionState
  /** 仅本机展示的检测诊断（如注册表或命令目录读取失败）。 */
  detectionIssues?: string[]
}

export type AgentDetectionState = 'detected' | 'notFound' | 'incomplete'

export type SkillPackage = { base64: string; sha256: string; size: number; contentHash: string; executablePaths: string[] }

export async function getInstalledAgents(): Promise<AgentInfo[]> {
  return invoke<AgentInfo[]>('get_installed_agents')
}

export async function readSkillMd(skillId: string): Promise<string> {
  return invoke<string>('read_skill_md', { skillId })
}

export type FrontmatterValue =
  | { kind: 'text'; value: string }
  | { kind: 'list'; value: string[] }
  | { kind: 'block'; value: string }

export type SkillLintIssue = { code: string; message: string }

export type SkillMarkdownInspection = {
  hasFrontmatter: boolean
  fields: { key: string; value: FrontmatterValue }[]
  body: string
  lint: SkillLintIssue[]
}

export async function inspectSkillMarkdown(content: string): Promise<SkillMarkdownInspection> {
  return invoke<SkillMarkdownInspection>('inspect_skill_markdown', { content })
}

export type SkillFilePreview =
  | { kind: 'text'; path: string; size: number; content: string }
  | { kind: 'binary'; path: string; size: number }
  | { kind: 'tooLarge'; path: string; size: number }

export async function readSkillFile(skillId: string, path: string): Promise<SkillFilePreview> {
  return invoke<SkillFilePreview>('read_skill_file', { skillId, path })
}

export type SkillTreeEntry = {
  path: string
  name: string
  kind: 'file' | 'directory'
  depth: number
}

export async function getSkillTree(skillId: string): Promise<SkillTreeEntry[]> {
  return invoke<SkillTreeEntry[]>('get_skill_tree', { skillId })
}

export async function updateSkillProfile(skillId: string, profile: {
  serverId?: string
  serverOwnerId?: string
  displayName?: string
  description?: string
  /** Omit to keep the stored 「来源」; `null` or blank clears it. */
  sourceUrl?: string | null
  /** With a clear: the source the user removed (kept from coming back by account sync). */
  clearedSourceUrl?: string
  category?: string
  labels: string[]
  triggerScenarios: string[]
  compatibleAgents: string[]
  version?: string
}, space: SpaceHandle): Promise<LocalSkill> {
  return invoke<LocalSkill>('update_skill_profile', { skillId, profile, space })
}

/** Parked avatar identity conflicts for one account, as the JSON text the app persists (null when none). */
export const readAvatarParking = async (accountUserId: string): Promise<string | null> =>
  invoke<string | null>('read_avatar_parking', { space: await currentSpace(), accountUserId })
export const writeAvatarParking = async (accountUserId: string, json: string): Promise<void> =>
  invoke('write_avatar_parking', { space: await currentSpace(), accountUserId, json })
export const ensureSkillAvatarIdentity = (skillId: string): Promise<string> =>
  invoke<string>('ensure_skill_avatar_identity', { skillId })
export const cacheSkillAvatar = async (skillId: string, accountUserId: string, avatarUrl: string | null, avatarStatus: string, space?: SpaceHandle): Promise<void> =>
  invoke('cache_skill_avatar', { space: space ?? await currentSpace(), skillId, accountUserId, avatarUrl, avatarStatus })

/**
 * Where 「填写个人值」 stores a value: `vault` (default) is the account key
 * vault, shared by every Skill declaring the same key; `skill` keeps it as
 * this Skill's own override (「仅此 Skill」).
 */
export type SkillEnvScope = 'vault' | 'skill'

export async function setSkillEnv(
  skillId: string,
  key: string,
  value: string,
  accountUserId: string | null = null,
  scope: SkillEnvScope = 'vault',
): Promise<void> {
  await invoke('set_skill_env', { space: await currentSpace(), skillId, key, value, accountUserId, scope })
  // A vault value can make every Skill declaring this key ready.
  notifyEnvReadinessChanged(scope === 'skill' ? { skillId } : {})
}

/** Removes only this Skill's own (override) value; the vault is untouched. */
export async function deleteSkillEnv(skillId: string, key: string, accountUserId: string | null = null): Promise<void> {
  await invoke('delete_skill_env', { skillId, key, accountUserId })
  notifyEnvReadinessChanged({ skillId })
}

// ── Personal key vault (#253): names and metadata only, never a value ──

export type VaultKeySkill = {
  id: string
  name: string
  declaredDescription: string | null
  /** The name this Skill declares; differs from the vault key when served through an alias (#288). */
  declaredKey: string
  /** Store, team and system Skills ask before using an account key (#294). */
  requiresConsent?: boolean
  /** This Skill can use the key now: not turned off and allowed (or never asks). Computed natively (#294). */
  enabled?: boolean
  /** #306: this Skill actually resolves to this row's value. */
  inUse?: boolean
}

export type VaultKey = {
  key: string
  /** Other variable names that use this same value (#288), e.g. FAL_API_KEY for FAL_KEY. */
  aliases: string[]
  /** Unix milliseconds. */
  createdAt: number | null
  updatedAt: number | null
  usedBySkills: VaultKeySkill[]
  allowedSkills: string[]
  /** Skills this key is turned off for on the 钥匙 page (#294). */
  blockedSkills?: string[]
  autoAllow: boolean
  /** Skills keeping their own (different) value for this key. */
  overrideSkills: string[]
  lastUsedAt: number | null
  /** #306: `null` = the unlabelled value of this name; otherwise the labelled variant's id. */
  variant?: string | null
  /** #306: the variant's label (「公司」); `null` on the unlabelled row. */
  label?: string | null
  /** #306: Skills of this name use this value unless they pick another one. */
  isDefault?: boolean
  /** #306: every value of this name, the unlabelled one as `id: null` (same array on every row of the name). */
  variants?: VaultKeyVariantRef[]
}

/** One value of a vault key name (#306): `id`/`label` are `null` for the unlabelled value, `V<n>` otherwise. */
export type VaultKeyVariantRef = { id: string | null; label: string | null; isDefault: boolean }

export type VaultMigrationReport = {
  version: number
  migratedAt: number
  backupDir: string | null
  migratedKeys: string[]
  conflicts: { key: string; skillIds: string[] }[]
  skipped: { skillId: string | null; reason: string }[]
}

export type KeyVaultSettings = {
  autoAllow: boolean
  migration: VaultMigrationReport | null
}

export type KeyConsentRequest = {
  skillId: string
  skillName: string
  /** Vault identities: `FAL_KEY`, or the synthetic `FAL_KEY__V1` of a labelled value (#306). */
  keys: string[]
  /** #306: `keys` as the user reads them, same order (`FAL_KEY · 公司`). */
  displayKeys?: string[]
  requestedAt: number
}

export async function listVaultKeys(accountUserId: string | null = null): Promise<VaultKey[]> {
  return invoke<VaultKey[]>('list_vault_keys', { space: await currentSpace(), accountUserId })
}

export async function getKeyVaultSettings(accountUserId: string | null = null): Promise<KeyVaultSettings> {
  return invoke<KeyVaultSettings>('get_key_vault_settings', { space: await currentSpace(), accountUserId })
}

/** Writes the unlabelled value, or with `variant` that labelled variant's value (#306). */
export async function setVaultKey(key: string, value: string, accountUserId: string | null = null, variant: string | null = null): Promise<void> {
  await invoke('set_vault_key', { space: await currentSpace(), key, value, variant, accountUserId })
  notifyEnvReadinessChanged()
}

/** Revokes the unlabelled value, or with `variant` one labelled variant (#306). */
export async function deleteVaultKey(key: string, accountUserId: string | null = null, variant: string | null = null): Promise<void> {
  await invoke('delete_vault_key', { space: await currentSpace(), key, variant, accountUserId })
  notifyEnvReadinessChanged()
}

/** 「添加另一把（带标签）」 (#306): a second value of the same name; errors are Chinese messages (e.g. 标签「公司」已存在). */
export async function createVaultKeyVariant(key: string, label: string, value: string, accountUserId: string | null = null): Promise<{ variant: string }> {
  const result = await invoke<{ variant: string }>('create_vault_key_variant', { space: await currentSpace(), key, label, value, accountUserId })
  notifyEnvReadinessChanged()
  return result
}

/** 「重命名标签」 (#306). */
export async function setVaultKeyVariantLabel(key: string, variant: string, label: string, accountUserId: string | null = null): Promise<void> {
  await invoke('set_vault_key_variant_label', { space: await currentSpace(), key, variant, label, accountUserId })
  notifyEnvReadinessChanged()
}

/** 「设为默认」 (#306): `null` makes the unlabelled value the default again. */
export async function setVaultDefaultVariant(key: string, variant: string | null, accountUserId: string | null = null): Promise<void> {
  await invoke('set_vault_default_variant', { space: await currentSpace(), key, variant, accountUserId })
  notifyEnvReadinessChanged()
}

/** 「转成一把带标签的钥匙」 (#306): one Skill's own value becomes a labelled variant that Skill now uses. */
export async function convertSkillOverrideToVariant(skillId: string, key: string, label: string, accountUserId: string | null = null): Promise<{ variant: string }> {
  const result = await invoke<{ variant: string }>('convert_skill_override_to_variant', { space: await currentSpace(), skillId, key, label, accountUserId })
  notifyEnvReadinessChanged({ skillId })
  return result
}

/** Replaces the alias list of one vault key (#288). Names only; errors are Chinese messages (e.g. a name taken by another key). */
export async function setVaultKeyAliases(key: string, aliases: string[], accountUserId: string | null = null): Promise<void> {
  await invoke('set_vault_key_aliases', { space: await currentSpace(), key, aliases, accountUserId })
  notifyEnvReadinessChanged()
}

/**
 * Turns the vault key (main name or alias) on or off for one Skill (#294).
 * Off: that Skill runs as if the vault had no value; on: also allows a
 * Skill that would otherwise ask first.
 */
export async function setVaultKeySkillAccess(key: string, skillId: string, enabled: boolean, accountUserId: string | null = null, variant: string | null = null): Promise<void> {
  await invoke('set_vault_key_skill_access', { space: await currentSpace(), key, skillId, enabled, variant, accountUserId })
  notifyEnvReadinessChanged({ skillId })
}

/** The vault already holds a same-service key under another name (#288). */
export type VaultKeyAliasSuggestion = { service: string; existingKey: string }

export async function suggestVaultKeyAlias(key: string, accountUserId: string | null = null): Promise<VaultKeyAliasSuggestion | null> {
  return invoke<VaultKeyAliasSuggestion | null>('suggest_vault_key_alias', { space: await currentSpace(), key, accountUserId })
}

/** `~/.skillhub/env-import-backups/` at a glance (#289): counts and sizes only, never contents. */
export type EnvBackupSummary = {
  count: number
  bytes: number
  oldestAt: number | null
  dir: string
}

export async function listEnvBackups(): Promise<EnvBackupSummary> {
  return invoke<EnvBackupSummary>('list_env_backups')
}

/** Opens the backup folder in Finder / Explorer (created when missing). */
export async function revealEnvBackups(): Promise<void> {
  await invoke('reveal_env_backups')
}

/** Deletes everything inside the backup folder; vault keys are untouched. */
export async function deleteEnvBackups(): Promise<{ removed: number }> {
  return invoke<{ removed: number }>('delete_env_backups')
}

/** Without `key`: the account-level 「以后不再询问，有能用的就用」 switch. */
export async function setKeyAutoAllow(enabled: boolean, key: string | null = null, accountUserId: string | null = null, variant: string | null = null, space?: SpaceHandle): Promise<void> {
  await invoke('set_key_auto_allow', { space: space ?? await currentSpace(), enabled, key, variant, accountUserId })
}

/** 「允许」, or with `once` 「仅这次」 (the next run within ten minutes). `variant` names a labelled variant (#306). */
export async function grantKeyAccess(skillId: string, key: string, once = false, accountUserId: string | null = null, variant: string | null = null, space?: SpaceHandle): Promise<void> {
  await invoke('grant_key_access', { space: space ?? await currentSpace(), skillId, key, once, variant, accountUserId })
  notifyEnvReadinessChanged({ skillId })
}

export async function revokeKeyAccess(skillId: string, key: string, accountUserId: string | null = null, variant: string | null = null): Promise<void> {
  await invoke('revoke_key_access', { space: await currentSpace(), skillId, key, variant, accountUserId })
  notifyEnvReadinessChanged({ skillId })
}

export async function listKeyConsentRequests(accountUserId: string | null = null): Promise<KeyConsentRequest[]> {
  return invoke<KeyConsentRequest[]>('list_key_consent_requests', { space: await currentSpace(), accountUserId })
}

export type LastRunReasonCode = 'missing_key' | 'needs_choice' | 'needs_consent' | 'spawn_failed' | 'exit_code' | 'other'

/** One `skillhub run` outcome (#292): key names and codes only, never values. */
export type LastRunRecord = {
  version: number
  skillId: string
  /** Unix milliseconds. */
  at: number
  outcome: 'ok' | 'failed'
  reasonCode: LastRunReasonCode | null
  keys: string[]
  exitCode: number | null
  /** `AGENT_DEFINITIONS` key of the Agent that ran it, when detectable. */
  agent: string | null
  message: string | null
}

/** Failed last runs of the current runtime identity, newest first. */
export async function listLastRunFailures(accountUserId: string | null = null): Promise<LastRunRecord[]> {
  return invoke<LastRunRecord[]>('list_last_run_failures', { space: await currentSpace(), accountUserId })
}

export async function clearLastRunFailure(skillId: string, accountUserId: string | null = null): Promise<void> {
  await invoke('clear_last_run_failure', { space: await currentSpace(), skillId, accountUserId })
}

/** 「拒绝」: nothing is stored; the next run asks again. */
export async function dismissKeyConsentRequest(skillId: string, accountUserId: string | null = null, space?: SpaceHandle): Promise<void> {
  await invoke('dismiss_key_consent_request', { space: space ?? await currentSpace(), skillId, accountUserId })
}

export type SkillEnvSource =
  /** The personal key's default value. */
  | { kind: 'personal' }
  /** One value of the personal key (#306): a labelled `V<n>`, or `null` = explicitly the unlabelled value. */
  | { kind: 'personalVariant'; variant: string | null }
  | { kind: 'team'; teamId: string }

/** A personal value of this name (#306); `id: null` is the unlabelled value. */
export type PersonalKeyVariantOption = { id: string | null; label: string | null; isDefault: boolean }

export type SkillEnvSourceOption =
  | { kind: 'personal'; available: boolean }
  | { kind: 'team'; teamId: string; teamName: string; available: boolean }

/**
 * Fixed resolution order (explicit choice → personal → the only available
 * team → choose): `ready` has a usable source, `needs_choice` has several
 * candidates (or a stale explicit choice) and `needs_value` has none.
 */
export type SkillEnvRowState = 'ready' | 'needs_value' | 'needs_choice'

export type SkillEnvSourcePolicyRow = {
  key: string
  description?: string
  required: boolean
  selected: SkillEnvSource | null
  /** The source a run would use now, including an automatically used team. */
  effective?: SkillEnvSource | null
  valid: boolean
  state?: SkillEnvRowState
  options: SkillEnvSourceOption[]
  /** Where the effective value comes from: this Skill's own value, the key vault or a team. */
  source?: 'override' | 'vault' | 'team' | null
  personalSource?: 'override' | 'vault' | null
  /** The vault value is usable only after the user allows this Skill. */
  needsConsent?: boolean
  /** #306: every value of the vault name (the unlabelled one as `id: null`); empty without a vault value. */
  personalVariants?: PersonalKeyVariantOption[]
  /** #306: the personal variant a run would actually use (`null` = the unlabelled value). */
  selectedVariant?: string | null
}

export type AuthState = SpaceHandle & { userId: string | null; pending: boolean; error?: string }
export async function authState(): Promise<AuthState> { return invoke<AuthState>('auth_state') }
export async function clearNativeAuthSession(space: SpaceHandle): Promise<SpaceHandle | null> {
  return invoke<SpaceHandle | null>('clear_auth_session', { space: { spaceId: space.spaceId, generation: space.generation } })
}

export async function getSkillEnvSourcePolicy(
  skillId: string,
  accountUserId: string | null = null,
  includeTeamSources = true,
): Promise<SkillEnvSourcePolicyRow[]> {
  return invoke<SkillEnvSourcePolicyRow[]>('get_skill_env_source_policy', { space: await currentSpace(),
    skillId,
    accountUserId,
    includeTeamSources,
  })
}

export async function setSkillEnvSource(
  skillId: string,
  key: string,
  source: SkillEnvSource,
  accountUserId: string | null = null,
): Promise<void> {
  await invoke('set_skill_env_source', { space: await currentSpace(), skillId, key, source, accountUserId })
  notifyEnvReadinessChanged({ skillId })
}

// ── Team key vault (#254) ──
// One value per (team, KEY) on the Server. Listings, usage and receipts carry
// names, ids and timestamps only; values are read natively and never reach
// the WebView.

export type TeamKeyPerson = { id: string; displayName: string }
export type TeamKeySkill = { id: string; name: string }
/** A Skill using the team key; `declaredKey` differs from the key when served through an alias (#288). */
export type TeamKeyScopeSkill = TeamKeySkill & { declaredKey: string }
export type TeamKeyExclusionEntry = { skillId: string; name: string; createdAt: string }

export type TeamKey = {
  key: string
  /** Other variable names that use this same team value (#288). */
  aliases: string[]
  holder: TeamKeyPerson
  revision: number
  createdAt: string
  updatedAt: string
  /** The current account holds the key or owns the team. */
  canManage: boolean
  /** Shared to this team ∧ declares the key ∧ not excluded. */
  inScopeSkills: TeamKeyScopeSkill[]
  exclusions: TeamKeyExclusionEntry[]
  lastUsedAt: string | null
}

export type TeamKeyList = {
  teamId: string
  teamName: string
  isTeamOwner: boolean
  credentials: TeamKey[]
}

export type TeamKeyWrite = { key: string; teamId: string; revision: number; holderId: string; updatedAt: string }
export type TeamKeyExclusion = { key: string; skillId: string; excluded: boolean }
export type TeamKeyUsageRow = { actor: TeamKeyPerson | null; skill: TeamKeySkill | null; count: number; lastAt: string }
export type TeamKeyUsage = { key: string; teamId: string; days: number; usage: TeamKeyUsageRow[] }

export async function listTeamKeys(teamId: string, accountUserId: string): Promise<TeamKeyList> {
  return invoke<TeamKeyList>('list_team_keys', { space: await currentSpace(), teamId, accountUserId })
}

/** Puts the account vault's KEY into the team (create or rotate). */
export async function putTeamKey(teamId: string, key: string, accountUserId: string, variant: string | null = null): Promise<TeamKeyWrite> {
  const receipt = await invoke<TeamKeyWrite>('put_team_key', { space: await currentSpace(), teamId, key, variant, accountUserId })
  notifyEnvReadinessChanged()
  return receipt
}

export async function deleteTeamKey(teamId: string, key: string, accountUserId: string): Promise<void> {
  await invoke('delete_team_key', { space: await currentSpace(), teamId, key, accountUserId })
  notifyEnvReadinessChanged()
}

export async function setTeamKeyExclusion(
  teamId: string,
  key: string,
  skillId: string,
  excluded: boolean,
  accountUserId: string,
): Promise<TeamKeyExclusion> {
  const result = await invoke<TeamKeyExclusion>('set_team_key_exclusion', { space: await currentSpace(), teamId, key, skillId, excluded, accountUserId })
  notifyEnvReadinessChanged()
  return result
}

/** Replaces the alias list of one team key (#288); holder or team owner only. */
export async function setTeamKeyAliases(
  teamId: string,
  key: string,
  aliases: string[],
  accountUserId: string,
): Promise<void> {
  await invoke('set_team_key_aliases', { space: await currentSpace(), teamId, key, aliases, accountUserId })
  notifyEnvReadinessChanged()
}

export async function teamKeyUsage(teamId: string, key: string, accountUserId: string): Promise<TeamKeyUsage> {
  return invoke<TeamKeyUsage>('team_key_usage', { space: await currentSpace(), teamId, key, accountUserId })
}

/** Puts the value a Skill uses (override → account vault) into the team. */
export async function providePersonalEnvToTeam(
  skillId: string,
  teamId: string,
  key: string,
  accountUserId: string,
): Promise<TeamKeyWrite> {
  const receipt = await invoke<TeamKeyWrite>('provide_personal_env_to_team', { space: await currentSpace(),
    skillId, teamId, key, accountUserId,
  })
  notifyEnvReadinessChanged({ skillId })
  return receipt
}

export type RuntimeCliStatus = {
  managed: boolean
  ready: boolean
  commandPath: string
  error?: string
  warnings?: string[]
  pathGuidance?: { message: string; command: string | null }
}

export async function getRuntimeCliStatus(recheck = false): Promise<RuntimeCliStatus> {
  return invoke<RuntimeCliStatus>(recheck ? 'recheck_runtime_cli' : 'get_runtime_cli_status')
}

export type RuntimeCliStorage = {
  currentBytes: number
  reclaimableCount: number
  reclaimableBytes: number
  warnings: string[]
}

export type RuntimeCliCleanup = {
  deletedCount: number
  freedBytes: number
  warnings: string[]
}

export async function getRuntimeCliStorage(): Promise<RuntimeCliStorage> {
  return invoke<RuntimeCliStorage>('get_runtime_cli_storage')
}

export async function cleanupRuntimeCli(): Promise<RuntimeCliCleanup> {
  return invoke<RuntimeCliCleanup>('cleanup_runtime_cli')
}

export async function syncEnvDependencies(skillId: string, keys: string[], suggestions: EnvSuggestion[] = []): Promise<LocalSkill> {
  return invoke<LocalSkill>('sync_env_dependencies', { skillId, keys, suggestions })
}

export async function checkShellIntegration(): Promise<boolean> {
  return invoke<boolean>('check_shell_integration')
}

export async function disableLegacyShellIntegration(): Promise<string | null> {
  return invoke<string | null>('disable_legacy_shell_integration')
}

export async function createSkillPackage(skillId: string): Promise<SkillPackage> {
  return invoke<SkillPackage>('create_skill_package', { skillId })
}

export async function importSkillPackage(data: {
  sourceVersionId?: string
  teamModifications?: 'preserve' | 'overwrite'
  skillId: string
  name?: string
  packageBase64: string
  expectedSha256: string
  serverId: string
  serverOwnerId: string
  catalogOrigin?: string
  displayName: string
  description?: string
  sourceUrl?: string | null
  category?: string
  labels: string[]
  version: string
  teamId?: string
  teamIds: string[]
  isOwn: boolean
  acquisitionSource: AcquisitionSource
  acquiredByUserId?: string
  replaceExistingMarketplace?: boolean
  installCount: number
  createdAt?: string
  updatedAt?: string
  triggerScenarios: string[]
  compatibleAgents: string[]
  envDependencies: Array<{
    key: string
    description?: string
    required: boolean
    sharePolicy: 'none' | 'private' | 'team'
    sharedTeams: string[]
    origin?: string
    pending?: boolean
  }>
}, space: SpaceHandle): Promise<LocalSkill> {
  return invoke<LocalSkill>('import_skill_package', {
    space,
    data: {
      ...data,
      replaceExistingMarketplace: data.replaceExistingMarketplace ?? false,
    },
  })
}

export async function rollbackMarketplaceReplacement(recoveryId: string): Promise<void> {
  return invoke('rollback_marketplace_replacement', { recoveryId })
}

// ---- Account library sync ----

/** One sync pass for the current account; `manual` also retries blocked items. */
export async function librarySyncRun(manual = false): Promise<LibrarySyncReport> {
  return invoke<LibrarySyncReport>('library_sync_run', { manual })
}

export async function librarySyncStatus(): Promise<LibrarySyncStatus> {
  return invoke<LibrarySyncStatus>('library_sync_status')
}

/** "加入账号同步" for Skills kept on this device (sidecar ids), then a sync pass. */
export async function libraryJoinLocal(localIds: string[]): Promise<LibrarySyncReport> {
  return invoke<LibrarySyncReport>('library_join_local', { localIds })
}

/**
 * Removes the account entry on every device, including an unlanded entry.
 * A rejection before contact does not settle a previous attempt; resolved
 * outcomes distinguish deletion, retention and an unconfirmed account result.
 */
export async function libraryDeleteFromAccount(skillId: string | null, accountId?: string, entryId?: string): Promise<AccountDeleteOutcome> {
  return invoke<AccountDeleteOutcome>('library_delete_from_account', { skillId, accountId, entryId })
}

/** Account entries with this device's state; fails rather than returning an empty list. */
export async function libraryListEntries(): Promise<LibraryEntryList> {
  return invoke<LibraryEntryList>('library_list_entries')
}

export async function libraryRestoreEntry(entryId: string): Promise<LibrarySyncReport> {
  return invoke<LibrarySyncReport>('library_restore_entry', { entryId })
}

export type LibraryAuthorAsset = {
  serverId: string
  serverOwnerId: string
  name: string
  currentVersion: string
  contentMatchesVersion: boolean
}

/** Publishes a synced entry as the user's own author asset (idempotent). */
export async function libraryAuthorAsset(skillId: string): Promise<LibraryAuthorAsset> {
  return invoke<LibraryAuthorAsset>('library_author_asset', { skillId })
}

export async function librarySharePreflight(skillId: string, accountId: string): Promise<string> {
  return invoke<string>('library_share_preflight', { skillId, accountId })
}

// Native migration engine: credentials and staged files never cross IPC.
export type MigrationKeyChoice = {
  name: string
  conflict: { action: 'skip' | 'overwrite' } | { action: 'rename'; name: string }
}
export type MigrationItemChoice = { id: string } & (
  { action: 'skip' } | { action: 'copy'; targetName?: string } | { action: 'map'; mapToSkillId: string }
)
export type MigrationStatus = {
  localMigrationId: string
  state: string
  lastError?: string | null
  snapshotAt: number
  keys: MigrationKeyChoice[]
  keysDone: boolean
  keyResults: { name: string; targetName: string; status: string }[]
  limits: Record<string, number | null | Record<string, number> | string[]>
  items: {
    id: string
    sourceSkillId: string
    name: string
    category: string
    state: string
    reason: string
    pendingDelta: boolean
    warnings: string[]
    avatars: { id: string; status: string; code: string | null }[]
    targetSkillId: string | null
    targetEntryId: string | null
    precheck: { operationKey: string; status: string; reason: string; existingSkillId: string | null } | null
    avatarCount: number
    storeState: string | null
  }[]
}
export function migrationSnapshotBegin(
  sourceKind: 'pending' | 'candidate' | 'local',
  options: { space: SpaceHandle; keys?: MigrationKeyChoice[] },
): Promise<MigrationStatus> {
  return invoke('migration_snapshot_begin', { sourceKind, options })
}
export function migrationSetChoices(
  localMigrationId: string, choices: { items: MigrationItemChoice[]; keys?: MigrationKeyChoice[] },
): Promise<void> {
  return invoke('migration_set_choices', { localMigrationId, choices })
}
export function migrationRun(localMigrationId: string): Promise<void> {
  return invoke('migration_run', { localMigrationId })
}
export function migrationCancel(localMigrationId: string): Promise<void> {
  return invoke('migration_cancel', { localMigrationId })
}
export function migrationStatus(localMigrationId: string): Promise<MigrationStatus> {
  return invoke('migration_status', { localMigrationId })
}
export function migrationReport(localMigrationId: string): Promise<MigrationStatus> {
  return invoke('migration_report', { localMigrationId })
}
export function migrationList(): Promise<MigrationStatus[]> {
  return invoke('migration_list')
}
export type MigrationKeyName = { name: string; authorizedSkillCount: number; conflict: boolean }
export function migrationKeyNames(localMigrationId: string): Promise<MigrationKeyName[]> {
  return invoke('migration_key_names', { localMigrationId })
}

// ---- Skill organizer (#323): private tags and quick access of one account ----
/** `accountKey` is the signed-in user UUID or `guest`; a missing or corrupt file loads empty. Untrusted: normalise it. */
let organizerSpace: SpaceHandle | null = null
export function readOrganizerSpace(): SpaceHandle | null { return organizerSpace }
export async function organizerLoad(accountKey: string): Promise<unknown> {
  const space = await currentSpace()
  const result = await invoke<unknown>('organizer_load', { accountKey, space })
  const current = await currentSpace()
  if (current.spaceId !== space.spaceId || current.generation !== space.generation) throw new Error('空间已切换')
  organizerSpace = space
  return result
}

export async function organizerSave(accountKey: string, state: OrganizerState, space: SpaceHandle | null = organizerSpace): Promise<void> {
  if (!space) throw new Error('目录尚未加载')
  await invoke('organizer_save', { accountKey, state, space })
}
