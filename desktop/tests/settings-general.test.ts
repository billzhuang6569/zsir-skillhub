/** #289 board 10: 设置 › 通用 rows — segmented preferences, the auto-allow Switch and 钥匙备份文件. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { SETTINGS_KEY_COPY, envBackupConfirmTitle, envBackupTitle, formatBytes, revealFolderLabel } from '../src/lib/env-backups.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')
const settings = source('src/pages/SettingsPage.tsx')

test('#585 settings navigation follows visible groups, scrolls to them and respects reduced motion', () => {
  const styles = source('src/pages/SettingsPage.css')
  for (const id of ['service', 'agents', 'keys', 'ai', 'sync', 'store', 'preferences', 'trash', 'feedback', 'help']) {
    assert.match(settings, new RegExp(`id="settings-${id}" data-settings-section`))
  }
  assert.match(settings, /<nav className="settings-nav" aria-label="设置分组">\{settingsSections\.map/)
  assert.match(settings, /aria-current=\{activeSection === section\.id \? 'location' : undefined\}/)
  assert.match(settings, /main\.addEventListener\('scroll', updateActive, \{ passive: true \}\)/)
  assert.match(settings, /scrollIntoView\(\{ behavior: window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches \? 'auto' : 'smooth'/)
  assert.match(styles, /\.settings-nav button:focus-visible \{ outline:/)
  assert.match(styles, /@media \(max-width: 850px\) \{ \.settings-page \{ display: block; \} \.settings-nav \{ display: none; \} \}/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{ \.app-main \{ scroll-behavior: auto; \} \}/)
  const help = settings.slice(settings.indexOf('id="settings-help"'))
  assert.match(help, /<RuntimeCliPathNotice guidance=\{runtimeCliStatus\.pathGuidance\} \/>/)
  assert.match(help, /<b>CLI 组件占用<\/b>/)
  assert.doesNotMatch(settings.slice(settings.indexOf('id="settings-agents"'), settings.indexOf('id="settings-keys"')), /<RuntimeCliPathNotice|CLI 组件占用/)
})

test('#490 groups follow the approved order in all spaces, with admin feedback only on official', () => {
  const connected = /\{capabilities\.profile !== 'local' && <>[\s\S]*?\n      <\/>\}/
  const store = /\{capabilities\.profile !== 'official' && <>[\s\S]*?\n      <\/>\}/
  const feedback = /\{showFeedback && <>[^\n]*<\/>\}/
  assert.match(settings, connected)
  assert.match(settings, store)
  assert.match(settings, feedback)
  for (const profile of ['official', 'selfhost', 'local']) for (const admin of [false, true]) {
    const visible = settings
      .replace(connected, match => profile === 'local' ? '' : match)
      .replace(store, match => profile === 'official' ? '' : match)
      .replace(feedback, match => profile === 'official' && admin ? match : '')
    const labels = ['服务与账号', ...Array.from(visible.matchAll(/<p className="settings-label"[^>]*>([^<]+)/g), match => match[1].trim())]
    assert.deepEqual(labels, [
      '服务与账号', 'Agent 工具', '钥匙',
      ...(profile === 'local' ? [] : ['AI 与头像', '同步与迁移']),
      ...(profile === 'official' ? [] : ['Skill 商店']),
      '偏好', '回收站', ...(profile === 'official' && admin ? ['反馈管理'] : []), '帮助与关于',
    ], `${profile}/${admin}`)
    assert.equal(visible.includes('<CatalogLogin />'), profile !== 'official')
    assert.equal(visible.includes('<MigrationSettings />'), profile !== 'local')
    assert.equal(visible.includes('<OrganizerSyncStatus />'), profile !== 'local')
  }
  const service = source('src/components/ServiceSettings.tsx')
  assert.match(service, /settings-label">服务与账号 /)
  assert.match(service, /showCurrent && caps.profile !== 'local' && <AccountSettings/)
  assert.match(service, /showCurrent && caps.profile === 'selfhost' && admin/)
  assert.doesNotMatch(settings + service, /settings-label">(?:使用指南|通用|关于|一探官方服务|实例管理|账号与数据)<|data-tour="cli"|skillhub run/)
  for (const component of ['MigrationActivity', 'CatalogLogin', 'InstanceAiSettings', 'AvatarSettings']) {
    assert.doesNotMatch(source(`src/components/${component}.tsx`), /className="settings-label"|className="settings-group/)
  }
})

test('#490 avatar gallery shares its title row, wraps square thumbnails, and keeps preview sizing', () => {
  const avatar = source('src/components/AvatarSettings.tsx')
  assert.match(avatar, /settings-row settings-row-stack avatar-settings">\s*<div className="settings-row-info"><b>头像风格/)
  assert.match(avatar, /新生成的 Skill 头像使用这个风格；已有头像不变。/)
  assert.match(avatar, /实例内所有成员使用同一个风格。/)
  assert.match(avatar, /当前风格由实例管理员设置/)
  const css = source('src/components/InstanceSettings.css')
  assert.match(css, /\.avatar-style-grid \{ display: flex; flex-wrap: wrap;/)
  assert.match(css, /\.avatar-style-card \{ width: 112px;/)
  assert.match(css, /aspect-ratio: 1 \/ 1/)
  assert.match(css, /\.avatar-style-preview \.avatar-style-image \{[^}]*width: auto/)
})

test('#490 tour has four stations and uses the station count in its eyebrow', () => {
  const tour = source('src/components/FeatureTour.tsx')
  assert.deepEqual(Array.from(tour.matchAll(/\{ id: '([^']+)'/g), match => match[1]), ['skills', 'install', 'marketplace', 'keys'])
  assert.match(tour, /功能导览 · \{index \+ 1\} \/ \{STOPS.length\}/)
  assert.doesNotMatch(tour, /topic="cli"|skillhub run/)
})

test('通用 keeps the page subtitle short and uses the shared segmented control with icons', () => {
  assert.match(settings, /<PageHeading title="设置" subtitle="偏好与账号" \/>/)
  assert.match(settings, /aria-label="列表主要显示" options=\{TITLE_OPTIONS\}/)
  assert.match(settings, /aria-label="外观" options=\{THEME_OPTIONS\}/)
  assert.equal(settings.match(/<SegmentedControl mode="radiogroup" size="sm"/g)?.length, 2)
})

test('「以后不再询问，有能用的就用」 is a role="switch" bound to the vault setting', () => {
  assert.equal(SETTINGS_KEY_COPY.autoAllowTitle, '以后不再询问，有能用的就用')
  assert.equal(SETTINGS_KEY_COPY.autoAllowDescription, '开启后，商店或团队来源的 Skill 使用你的钥匙时不再弹窗确认。你的钥匙仍只给声明了它的 Skill。')
  assert.match(settings, /<b id="settings-auto-allow-title">\{SETTINGS_KEY_COPY\.autoAllowTitle\}<\/b>/)
  assert.match(settings, /<Switch checked=\{autoAllow\}[^\n]*aria-labelledby="settings-auto-allow-title"/)
  assert.match(settings, /await getKeyVaultSettings\(accountUserId\)/)
  assert.match(settings, /await setKeyAutoAllow\(enabled, null, accountUserId\)/)
  assert.match(source('src/components/Switch.tsx'), /role="switch"/)
})

test('钥匙备份文件 row: count and size, reveal and delete with a confirm, empty text when none', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(12 * 1024), '12 KB')
  assert.equal(formatBytes(3.25 * 1024 * 1024), '3.3 MB')
  assert.equal(envBackupTitle({ count: 3, bytes: 12 * 1024 }), '钥匙备份文件 · 3 份 · 12 KB')
  assert.equal(envBackupTitle({ count: 0, bytes: 0 }), '钥匙备份文件')
  assert.equal(envBackupTitle(null), '钥匙备份文件')
  assert.equal(envBackupConfirmTitle(3), '删除 3 份钥匙备份文件？')
  assert.equal(SETTINGS_KEY_COPY.backupConfirmDescription, '钥匙库里的钥匙不受影响，此操作不可恢复。')
  assert.equal(SETTINGS_KEY_COPY.backupDescription, '导入 Skill 时自动生成的钥匙文件，以及所有备份。可删除。')
  assert.equal(SETTINGS_KEY_COPY.backupEmpty, '没有备份文件')
  assert.equal(revealFolderLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), '在访达中显示')
  assert.equal(revealFolderLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), '在文件管理器中显示')
  assert.equal(revealFolderLabel('Mozilla/5.0 (X11; Linux x86_64)'), '打开文件夹')

  assert.match(settings, /envBackups && envBackups\.count > 0\n\s+\? <div className="settings-row-actions">/)
  assert.match(settings, /onClick=\{\(\) => void revealBackups\(\)\}><Icon name="folder" size=\{13\} \/>\{revealFolderLabel\(\)\}/)
  assert.match(settings, /className="btn btn-danger-soft btn-sm" onClick=\{\(\) => setConfirmBackupDelete\(true\)\}/)
  assert.match(settings, /<ConfirmModal eyebrow="钥匙备份文件" title=\{envBackupConfirmTitle\(envBackups\.count\)\}[^>]*destructive/)
  assert.match(settings, /const \{ removed \} = await deleteEnvBackups\(\)[^]*await loadEnvBackups\(\)/)
  assert.match(settings, /useEffect\(\(\) => \{ void loadEnvBackups\(\) \}, \[loadEnvBackups\]\)/)

  const tauri = source('src/lib/tauri.ts')
  assert.match(tauri, /export type EnvBackupSummary = \{\n\s+count: number\n\s+bytes: number\n\s+oldestAt: number \| null\n\s+dir: string\n\}/)
  for (const command of ['list_env_backups', 'reveal_env_backups', 'delete_env_backups']) {
    assert.match(tauri, new RegExp(`invoke(<[^>]+>)?\\('${command}'\\)`), command)
    assert.match(source('src-tauri/src/lib.rs'), new RegExp(`commands::${command},`), command)
  }
})

test('the other Settings sections stay; 团队钥匙 moved to the 钥匙 page (#294)', () => {
  for (const label of ['回收站', '帮助与关于', '偏好']) assert.match(settings, new RegExp(`<p className="settings-label"[^>]*>${label}</p>`))
  assert.match(settings, /<ServiceSettings onOpenInstance=/)
  assert.ok(!settings.includes('<p className="settings-label">团队钥匙</p>'))
  assert.doesNotMatch(settings, /TeamKeyList/)
})

test('every runtime notice starts with an Icon in the first grid column', () => {
  const notices = [...settings.matchAll(/<div className=(?:"agent-runtime-notice(?: [^"]*)?"|\{`agent-runtime-notice[^`]*`\})>([^]*?)<\/div>/g)]
  assert.ok(notices.length > 0)
  for (const notice of notices) assert.match(notice[1], /^\s*<Icon\b/)
  assert.match(settings, /runtimeCliUnmanaged \? <div className="agent-runtime-notice"><Icon name="info" size=\{14\} \/>/)
  assert.match(source('src/pages/SettingsPage.css'), /\.agent-runtime-notice > svg \{ color: var\(--color-muted\); \}/)
})

test('#334 AGENT 工具: detected list with one switch, incomplete kept apart, undetected collapsed to one line', () => {
  const styles = source('src/pages/SettingsPage.css')
  const panel = settings.slice(settings.indexOf('function AgentToolsPanel('), settings.indexOf('export default function SettingsPage'))
  // Detected / incomplete / missing are split by the native detectionState; incomplete never lands in 未检测.
  assert.match(panel, /const detected = agents\.filter\(\(agent\) => agent\.detected\)/)
  assert.match(panel, /const incomplete = agents\.filter\(\(agent\) => !agent\.detected && agent\.detectionState === 'incomplete'\)/)
  assert.match(panel, /const missing = agents\.filter\(\(agent\) => !agent\.detected && agent\.detectionState !== 'incomplete'\)/)
  // One shared Switch per detected tool, bound to hiddenCardAgents with a readable aria-label; hint lives in its tooltip.
  assert.match(panel, /<Tooltip content=\{CARD_TOGGLE_HINT\}[^>]*>\s*<Switch checked=\{visible\} onChange=\{\(next\) => onToggleCard\(agent\.key, next\)\} aria-label=\{`在 Skill 卡片上显示 \$\{agent\.name\}`\} \/>/)
  assert.match(panel, /const visible = !hiddenCardAgents\.includes\(agent\.key\)/)
  assert.match(panel, />显示在 Skill 卡片</)
  assert.match(settings, /onToggleCard=\{setCardAgentVisible\}/)
  assert.doesNotMatch(settings, /agent-tools-hint|type="checkbox"[^>]*agent|卡片显示</)
  // Path, APP/CLI source and diagnostics move into a focusable detail tooltip; no 「· Skill 目录可用」 concatenation.
  assert.doesNotMatch(settings, / · Skill 目录可用| · 首次安装/)
  assert.match(settings, /const lines = \[agentStateLabel\(agent\), `Skill 目录：\$\{agent\.dir\}`\]/)
  assert.match(settings, /aria-label=\{`\$\{agent\.name\} 检测详情`\}/)
  // 检测未完成 rows show a neutral warning badge and no switch.
  const incompleteRows = panel.slice(panel.indexOf('incomplete.map('), panel.indexOf('agent-tools-empty', panel.indexOf('incomplete.map(')))
  assert.match(incompleteRows, /agent-tool-state-badge/)
  assert.doesNotMatch(incompleteRows, /<Switch/)
  // Undetected tools collapse into one expandable line.
  assert.match(panel, /aria-expanded=\{showMissing\} aria-controls=\{showMissing \? 'agent-tools-missing-list' : undefined\}/)
  assert.match(panel, /未检测：\{missing\.map\(\(agent\) => agent\.name\)\.join\('、'\)\}/)
  // Five states: checking (skeleton, no placeholder agents), error, all undetected, detected, not detected.
  assert.match(panel, /'正在检测本机工具…'/)
  assert.match(panel, /\{firstRun && checking && <div className="agent-tool-skeleton" aria-hidden="true">/)
  assert.match(panel, /'未检测到可用工具'/)
  assert.match(panel, /无法检测本机 Agent，当前选项保持不变；可以重试。/)
  // Runtime notices stay inside the panel, unchanged.
  assert.match(settings, /<AgentToolsPanel [^\n]*>\n\s+\{\(!runtimeCliChecking \|\| shellIntegrated\) && <div className="agent-runtime-notices">/)
  // Neutral styling: no whole-card green tint; tooltips not clipped; label hides on narrow containers.
  assert.doesNotMatch(styles, /\.agent-tool-card\.detected|color-success-tint\) 45%/)
  assert.match(styles, /\.settings-group\.agent-tools-group \{ overflow: visible;[^}]*container: agent-tools \/ inline-size; \}/)
  assert.match(styles, /@container agent-tools \(max-width: 440px\) \{\s*\.agent-tool-toggle-label \{ display: none; \}/)
  assert.match(styles, /\.agent-tool-state-badge \{[^}]*var\(--color-warning-tint\)/)
})

test('WorkBuddy upgrade guidance keeps old installs and directs users to the distinct target', () => {
  assert.match(settings, /agents\.some\(\(agent\) => agent\.key === 'workbuddy-ai'\)/)
  assert.match(settings, /旧安装现属 WorkBuddy AI/)
  assert.match(settings, /「WorkBuddy」安装，确认后可停用 WorkBuddy AI/)
})

test('#334 × #335: unconfirmed Skill roots stay in the detected list with a badge, no card switch, and are not counted as usable', () => {
  const panel = settings.slice(settings.indexOf('function AgentToolsPanel('), settings.indexOf('export default function SettingsPage'))
  assert.match(panel, /const unconfirmed = detected\.filter\(\(agent\) => !agentAcceptsSkillWrites\(agent\)\)/)
  assert.match(panel, /`已检测到 \$\{detected\.length\} 个工具\$\{unconfirmed\.length > 0 \? `，\$\{unconfirmed\.length\} 个目录未确认` : ''\}`/)
  const unconfirmedRow = panel.slice(panel.indexOf('if (!agentAcceptsSkillWrites(agent)) return'), panel.indexOf('return <li key={agent.key} className="agent-tool-row">'))
  assert.match(unconfirmedRow, /className="agent-tool-row unconfirmed"/)
  assert.match(unconfirmedRow, /agent-tool-state-badge"><Icon name="circle-alert" size=\{12\} \/>Skill 目录未确认</)
  assert.doesNotMatch(unconfirmedRow, /<Switch/)
  assert.match(settings, /agent\.skillsStatus === 'unconfirmed' \? UNCONFIRMED_SKILL_ROOT_HINT/)
})
