import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const tauriConfig = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
const capabilities = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8'))
const windowControls = readFileSync('src/components/WindowControls.tsx', 'utf8')
const updater = readFileSync('src/lib/app-updater.ts', 'utf8')
const updateDialog = readFileSync('src/components/AppUpdateDialog.tsx', 'utf8')
const feedbackDialog = readFileSync('src/components/FeedbackDialog.tsx', 'utf8')
const feedbackAdmin = readFileSync('src/components/FeedbackAdminPanel.tsx', 'utf8')
const sidebar = readFileSync('src/components/Sidebar.tsx', 'utf8')
const globalCss = readFileSync('src/styles/global.css', 'utf8')
const appCss = readFileSync('src/styles/app.css', 'utf8')
const skillsPage = readFileSync('src/pages/SkillsPage.tsx', 'utf8')

test('desktop window chrome is frameless and adapts native-style controls per platform', () => {
  assert.equal(tauriConfig.app.windows[0].decorations, false)
  assert.equal(tauriConfig.app.windows[0].shadow, false)
  assert.match(windowControls, /invokeWindowAction\('close'\)/)
  assert.match(windowControls, /invokeWindowAction\('minimize'\)/)
  assert.match(windowControls, /invokeWindowAction\('toggleMaximize'\)/)
  assert.match(windowControls, /data-tauri-drag-region/)
  assert.match(windowControls, /\/Windows\/i\.test\(navigator\.userAgent\)/)
  assert.match(windowControls, /windows \? '−' : ''/)
  assert.ok(capabilities.permissions.includes('core:window:allow-close'))
  assert.ok(capabilities.permissions.includes('core:window:allow-start-dragging'))
})

test('rounded window corners reveal transparency and keep a subtle outline', () => {
  assert.match(globalCss, /body\s*\{[^}]*background:\s*transparent/s)
  assert.match(appCss, /:root \{ --window-radius: 22px; \}/)
  assert.match(appCss, /:root\.window-expanded \{ --window-radius: 0px; \}/)
  assert.match(appCss, /\.app-shell\s*\{[^}]*border:\s*1px solid[^}]*border-radius:\s*var\(--window-radius\)/s)
  // Blurred full-window scrims follow the rounded window instead of drawing square corners.
  assert.match(appCss, /\.modal-layer, \.scrim \{ border-radius: var\(--window-radius\); overflow: hidden; \}/)
  assert.match(appCss, /\.app-shell\.window-expanded\s*\{[^}]*border:\s*0/s)
  assert.match(skillsPage, /className="btn btn-ghost marketplace-shortcut"/)
  assert.match(skillsPage, /className="btn btn-ghost marketplace-shortcut" aria-label="Skill 商店"/)
  assert.match(skillsPage, /<Icon name="market" size=\{16\} \/><span className="marketplace-shortcut-label">Skill 商店<\/span>/)
  assert.match(appCss, /\.marketplace-shortcut\s*\{[^}]*gap:\s*0;/s)
  assert.match(appCss, /\.marketplace-shortcut-label\s*\{\s*display:\s*none;/)
  assert.match(appCss, /\.marketplace-shortcut svg\s*\{\s*transform:\s*translateY\(-1px\)/)
})

test('signed updater checks in the background, waits for consent, and relaunches only after installation', () => {
  assert.equal(tauriConfig.bundle.createUpdaterArtifacts, true)
  assert.match(tauriConfig.plugins.updater.endpoints[0], /\{\{target\}\}\/\{\{arch\}\}\/\{\{current_version\}\}/)
  assert.ok(tauriConfig.plugins.updater.pubkey.length > 80)
  assert.ok(capabilities.permissions.includes('updater:default'))
  assert.ok(capabilities.permissions.includes('process:allow-restart'))
  assert.match(updater, /await check\(\{ timeout: 15_000 \}\)/)
  assert.match(updater, /availableUpdate\.downloadAndInstall/)
  assert.match(updater, /phase: 'error'[^]*更新安装失败/s)
  assert.match(updater, /await relaunch\(\)/)
  assert.match(updateDialog, /下载更新/)
  assert.match(updateDialog, /签名校验通过/)
})

test('feedback stays minimal, guest-capable, and gives administrators only status controls', () => {
  assert.match(sidebar, />反馈<\/button>/)
  assert.match(feedbackDialog, /反馈信息/)
  assert.match(feedbackDialog, /联系方式 <em>选填<\/em>/)
  assert.match(feedbackDialog, /maxLength=\{2000\}/)
  assert.match(feedbackDialog, /onPaste=/)
  assert.match(feedbackDialog, /onDrop=\{onDrop\}/)
  assert.match(feedbackDialog, /最多 3 张/)
  assert.match(feedbackDialog, /defaultContact\?\.trim\(\)/)
  assert.match(feedbackAdmin, /待处理/)
  assert.match(feedbackAdmin, /处理中/)
  assert.match(feedbackAdmin, /已解决/)
  assert.doesNotMatch(feedbackAdmin, /管理员备注|指派|回复用户/)
})

test('feedback retries reuse their operation until the submitted payload changes', () => {
  assert.match(feedbackDialog, /operationRef = useRef/)
  assert.match(feedbackDialog, /previous\.type !== type.*previous\.content !== normalizedContent.*previous\.contact !== normalizedContact.*previous\.attachments !== attachments/)
  assert.match(feedbackDialog, /clientOperationId = operationRef\.current!\.id/)
  assert.match(feedbackDialog, /apiSubmitFeedback\(\{[\s\S]*clientOperationId,/)
})

test('Detail Agent icons wrap without a scroll container that clips hover and badges', () => {
  const detailCss = readFileSync('src/components/SkillDetailSheet.css', 'utf8')
  assert.match(detailCss, /\.profile-agent-actions \{[^}]*flex-wrap: wrap;[^}]*overflow: visible;/)
  assert.doesNotMatch(detailCss, /\.profile-agent-actions \{[^}]*overflow-x: auto/)
})

test('Portaled overlays learn the maximised state from the root element', () => {
  assert.match(windowControls, /document\.documentElement\.classList\.toggle\('window-expanded', expanded\)/)
})
