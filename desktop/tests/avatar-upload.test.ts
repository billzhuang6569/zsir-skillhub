import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const component = readFileSync(resolve(desktopRoot, 'src/components/AvatarUploader.tsx'), 'utf8')
const styles = readFileSync(resolve(desktopRoot, 'src/components/AvatarUploader.css'), 'utf8')
const accountSettings = readFileSync(resolve(desktopRoot, 'src/components/AccountSettings.tsx'), 'utf8')
const teamDetail = readFileSync(resolve(desktopRoot, 'src/components/TeamDetailSheet.tsx'), 'utf8')
const settingsPage = readFileSync(resolve(desktopRoot, 'src/pages/SettingsPage.tsx'), 'utf8')
const teamsPage = readFileSync(resolve(desktopRoot, 'src/pages/TeamsPage.tsx'), 'utf8')
const settingsStyles = readFileSync(resolve(desktopRoot, 'src/pages/SettingsPage.css'), 'utf8')
const agentBrandIcon = readFileSync(resolve(desktopRoot, 'src/components/AgentBrandIcon.tsx'), 'utf8')
const agentBrandStyles = readFileSync(resolve(desktopRoot, 'src/components/AgentBrandIcon.css'), 'utf8')
const tauriClient = readFileSync(resolve(desktopRoot, 'src/lib/tauri.ts'), 'utf8')
const agentDefinitions = readFileSync(resolve(desktopRoot, 'src/lib/agents.ts'), 'utf8')
const rustUpload = readFileSync(resolve(desktopRoot, 'src-tauri/src/avatar_upload.rs'), 'utf8')
const rustNet = readFileSync(resolve(desktopRoot, 'src-tauri/src/net.rs'), 'utf8')
const rustApp = readFileSync(resolve(desktopRoot, 'src-tauri/src/lib.rs'), 'utf8')
const cargo = readFileSync(resolve(desktopRoot, 'src-tauri/Cargo.toml'), 'utf8')
const tauriConfig = readFileSync(resolve(desktopRoot, 'src-tauri/tauri.conf.json'), 'utf8')

test('avatar upload is a registered authenticated native command', () => {
  assert.match(cargo, /reqwest[^\n]+"multipart"/)
  assert.match(rustApp, /mod avatar_upload;/)
  assert.match(rustApp, /avatar_upload::pick_and_upload_avatar/)
  assert.match(tauriClient, /invoke<AvatarUploadResult \| null>\('pick_and_upload_avatar', \{ accountUserId, space: await currentSpace\(\) \}\)/)
})

test('native avatar upload authenticates to SkillHub and constrains local files', () => {
  assert.match(rustUpload, /state\.connection\(Some\(&session\.session\)\)/)
  assert.match(rustUpload, /bearer_auth\(&session\.token\)/)
  assert.match(rustUpload, /\/api\/media\/avatars/)
  assert.match(rustUpload, /MAX_AVATAR_BYTES: u64 = 5 \* 1024 \* 1024/)
  assert.match(rustUpload, /custom_flags\(crate::platform_fs::NOFOLLOW_FLAG\)/)
  assert.match(rustUpload, /file_type\(\)\.is_symlink\(\)/)
  assert.match(rustUpload, /verify_remote_identity\(&session\.session\)/)
  assert.match(rustNet, /redirect\(reqwest::redirect::Policy::none\(\)\)/)
  assert.match(rustUpload, /crate::media::image_reference\(value, base, hosts\)/)
  assert.doesNotMatch(rustUpload, /pub struct AvatarUploadResult[^}]*delete_/s)
})

test('shared avatar control exposes loading, keyboard, removal, and image fallback semantics', () => {
  assert.match(component, /aria-busy=\{busy\}/)
  assert.match(component, /aria-label=\{busy \? `正在上传\$\{label\}` : `选择\$\{label\}`\}/)
  assert.match(component, /onClick=\{\(\) => void chooseAvatar\(\)\}/)
  assert.match(component, /onError=\{\(\) => setImageFailed\(true\)\}/)
  assert.match(component, /onPersist\(null\)/)
  assert.match(component, /aria-live="polite"/)
  assert.match(styles, /:focus-visible/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/)
})

test('WebView connects only to IPC and displays server images only through the native protocol', () => {
  const config = JSON.parse(tauriConfig) as { app: { security: { csp: string } } }
  const csp = config.app.security.csp
  assert.equal(csp.split(';').map(part => part.trim()).find(part => part.startsWith('img-src ')),
    "img-src 'self' data: asset: http://asset.localhost skillhub-media: http://skillhub-media.localhost")
  assert.doesNotMatch(csp, /connect-src[^;]*pictshare\.whatonearth\.work/)
})

test('account and owner-only team avatars persist through their existing real APIs', () => {
  assert.match(accountSettings, /<AvatarUploader/)
  assert.match(accountSettings, /apiUpdateProfile\(\{ avatarUrl \}\)/)
  assert.match(accountSettings, /本机 Skill 无需登录即可管理和使用/)
  assert.match(accountSettings, /promptForAuth\(\{ reason: '登录后查看和修改个人资料', intent: \{ kind: 'account' \} \}\)/)
  assert.doesNotMatch(accountSettings, /头像网址|type="url"/)

  assert.match(teamDetail, /<AvatarUploader/)
  assert.match(teamDetail, /detail\.ownerId !== currentUser\?\.id/)
  assert.match(teamDetail, /apiUpdateTeam\(teamId, \{ avatarUrl \}\)/)
  assert.match(teamDetail, /'编辑资料'/)
  assert.doesNotMatch(teamDetail, /头像 URL|avatarUrl\}\s+maxLength/)
  // #295 board 8: every team is one row button that opens the detail sheet.
  assert.match(teamsPage, /<button type="button" className=\{`team-list-row\$\{active \? ' active' : ''\}`\}[^>]*onClick=\{\(\) => openTeamSheet\(team\.id\)\}/)
})

test('Settings hides server internals and presents Agent tools as a compact branded list', () => {
  assert.doesNotMatch(settingsPage, /SERVER_ORIGIN|apiHealth|一探 SkillHub API|settings-label">服务端/)
  assert.match(settingsPage, /<AgentBrandIcon agent=\{agent\} size=\{28\} \/>/)
  assert.match(settingsPage, /className="agent-tool-list"/)
  assert.doesNotMatch(settingsPage, /agent-tool-grid|agent-tool-card/)
  assert.match(settingsStyles, /\.agent-tool-row \{[^}]*grid-template-columns: 28px minmax\(0, 1fr\) auto;/)
  assert.match(agentBrandIcon, /agentKey === 'claude'/)
  assert.match(agentBrandIcon, /agentKey === 'codex'/)
  assert.match(agentBrandStyles, /agent-brand-claude/)
  assert.match(agentBrandStyles, /agent-brand-codex/)
})

test('Agent cards distinguish application detection and directory readiness without unsupported placeholders', () => {
  assert.match(agentDefinitions, /'workbuddy'/)
  assert.match(agentDefinitions, /'doubao'/)
  assert.doesNotMatch(agentDefinitions.split('as const')[0] ?? '', /agent-skills/)
  assert.match(tauriClient, /detectionSource: 'application' \| 'cli' \| 'none'/)
  assert.match(tauriClient, /skillsStatus: 'ready' \| 'missing'/)
  assert.match(agentDefinitions, /已检测 APP/)
  assert.match(agentDefinitions, /已检测 CLI/)
  assert.match(agentDefinitions, /检测未完成/)
  assert.match(settingsPage, /const issues = agentStateTitle\(agent\)/)
  assert.match(settingsPage, /<Icon name="circle-alert" size=\{12\} \/>\{agentStateLabel\(agent\)\}/)
  assert.doesNotMatch(settingsPage, /当前平台不支持|该应用在 Windows 端自行管理/)
  assert.match(settingsPage, /首次安装 Skill 时创建/)
})
