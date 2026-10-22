import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skillsPage = readFileSync(resolve(desktopRoot, 'src/pages/SkillsPage.tsx'), 'utf8')
const sidebar = readFileSync(resolve(desktopRoot, 'src/components/Sidebar.tsx'), 'utf8')
const skillDetail = readFileSync(resolve(desktopRoot, 'src/components/SkillDetailSheet.tsx'), 'utf8')
const settings = readFileSync(resolve(desktopRoot, 'src/pages/SettingsPage.tsx'), 'utf8')
const appStyles = readFileSync(resolve(desktopRoot, 'src/styles/app.css'), 'utf8')
const globalStyles = readFileSync(resolve(desktopRoot, 'src/styles/global.css'), 'utf8')
const focusTrap = readFileSync(resolve(desktopRoot, 'src/components/FocusTrapDialog.tsx'), 'utf8')

test('cloud batch dialog stays above the filtered list and selection resets do not remount it', () => {
  const list = readFileSync(resolve(desktopRoot, 'src/components/SkillLibraryList.tsx'), 'utf8')
  const batch = readFileSync(resolve(desktopRoot, 'src/components/SkillBatchDialog.tsx'), 'utf8')
  assert.doesNotMatch(skillsPage, /<SkillSection\s+key=/)
  assert.match(skillsPage, /<SkillSection selectionResetKey=\{JSON\.stringify\(\[searchQuery, categoryFilter, managedScope(?:, [^\]]+)?\]\)\}/)
  assert.match(skillsPage, /<SkillLibraryList[^>]+selectionResetKey=\{selectionResetKey\}[^>]+onBatch=\{onBatch\}/)
  assert.match(skillsPage, /\{cloudBatch && <SkillBatchDialog skills=\{cloudBatch\.skills\} action=\{cloudBatch\.action\}/)
  assert.doesNotMatch(list, /SkillBatchDialog|setBatchAction/)
  assert.match(list, /focusOnly\s*\? focusCloudRow/)
  assert.match(list, /if \(!focusOnly\) openSkill/)
  assert.match(batch, /previewAttempt\]/)
  assert.match(batch, /setPreviewAttempt\(attempt => attempt \+ 1\)/)
})

test('My Skills source and local preview keep batch selection keyboard-accessible without a view switcher', () => {
  // #289 board 1: the source switch is the shared icon SegmentedControl (cloud / laptop).
  assert.match(skillsPage, /<SegmentedControl\n\s*className="skills-source-tabs"\n\s*aria-label="Skill 来源"/)
  assert.match(skillsPage, /\{ value: 'skillhub', label: capabilities.library \? 'SkillHub 云端' : '已托管', icon: capabilities.library \? 'cloud' : 'skills', count: personalManagedSkillCount \}/)
  assert.match(skillsPage, /\{ value: 'local', label: '本地', icon: 'laptop', count: unmanagedSkills\.length \}/)
  assert.doesNotMatch(skillsPage, /className="seg-ctrl"|skills-scope-switch/)
  assert.doesNotMatch(skillsPage, /本地 Skill 视图|localView|grid-view|list-view/)
  assert.doesNotMatch(skillsPage, /skill-team-menu|不查看团队共享/)
  assert.match(skillsPage, /role="listbox"/)
  assert.match(skillsPage, /role="checkbox"/)
  assert.match(skillsPage, /tabIndex=\{focusedLocalId === skill\.id \? 0 : -1\}/)
  assert.match(skillsPage, /nextRovingIndex\(index, visibleLocalIds\.length, event\.key, 'vertical'\)/)
  assert.match(skillsPage, /event\.key === 'Enter'[^]*setLocalSkillPreview/s)
  assert.match(skillsPage, /event\.key === ' ' && !managedNames\.has\(skill\.name\)/)
  assert.match(skillsPage, /if \(next\.has\(skill\.id\)\) next\.delete\(skill\.id\)[^]*else next\.add\(skill\.id\)/)
  assert.match(appStyles, /\.local-skills-list\s*\{[^}]*flex-direction:\s*column;/s)
})

test('cloud Skill rows use the same real version and failure explanation as detail views', () => {
  const list = readFileSync(resolve(desktopRoot, 'src/components/SkillLibraryList.tsx'), 'utf8')
  assert.match(list, /const versionDisplay = skillVersionDisplay\(skill\)/)
  assert.match(list, /\{versionDisplay\.label\}/)
  // #289: the version problem moved from the description line into the 版本需要处理 icon tooltip.
  assert.doesNotMatch(list, /skill-library-problem|role="status">\{versionDisplay\.problem\}/)
  assert.match(list, /versionDisplay\.problem,\n\s*context === 'personal' \? lastRunFailures/)
  assert.match(list, /skill\.hasWorkingCopy[^]*已修改/)
  assert.doesNotMatch(list, /未编号|version \|\| '0\.1\.0'/)
})

test('ordinary read notifications stay static while mention notifications remain actionable', () => {
  // #295: the popover body lives in NotificationCenter; titles and descriptions in lib/notification-center.
  const center = readFileSync(resolve(desktopRoot, 'src/components/NotificationCenter.tsx'), 'utf8')
  const centerLib = readFileSync(resolve(desktopRoot, 'src/lib/notification-center.ts'), 'utf8')
  assert.match(center, /const clickable = entry\.origin === 'server' && \(entry\.type === 'comment_mention' \|\| entry\.type === 'team_key_scope_added' \|\| entry\.unread\)/)
  assert.match(center, /clickable[^]*<button[^]*openServerEntry\(entry\)[^]*: <article/s)
  assert.match(center, /setPendingCommentNavigation\(\{ teamId, serverSkillId, commentId \}\)/)
  assert.match(sidebar, /<NotificationCenter entries=\{notificationEntries\} onClose=\{\(\) => setShowNotifications\(false\)\} \/>/)
  assert.match(sidebar, /id="notification-popover" className="notification-popover" role="region" aria-label="通知列表"/)
  assert.match(sidebar, /document\.addEventListener\('pointerdown', closeOutside\)/)
  assert.match(sidebar, /if \(event\.key !== 'Escape'\) return\n\s*setShowNotifications\(false\)\n\s*bellRef\.current\?\.focus\(\)/)
  assert.match(sidebar, /aria-label=\{bellAriaLabel\(unreadCount\)\}/)
  assert.doesNotMatch(sidebar, /sidebar-spotlight/)
  assert.match(centerLib, /marketplace_approved: 'Skill 商店审核通过'/)
  assert.match(centerLib, /marketplace_rejected: 'Skill 商店审核未通过'/)
  assert.match(centerLib, /marketplace_withdrawn: 'Skill 已被商店下架'/)
  assert.match(centerLib, /const reviewNote = payloadText\(payload, 'reviewNote'\)/)
  assert.match(center, /<SegmentedControl\n\s*className="notification-filter"\n\s*aria-label="通知分类"\n\s*size="sm"/)
  assert.match(center, /只显示最近 30 天的通知/)
  assert.match(appStyles, /\.notification-popover\s*\{[^}]*position:fixed;left:calc\(var\(--sidebar-width\) \+ 8px\);bottom:16px;width:min\(420px,calc\(100vw - var\(--sidebar-width\) - 24px\)\)/)
})

test('team shared and team management use distinct navigation icons', () => {
  assert.match(sidebar, /view: 'team-skills', icon: 'shared-skills'/)
  assert.match(sidebar, /view: 'teams',\s+icon: 'team'/)
})

test('a broken Agent Profile action enters the guarded install repair flow', () => {
  assert.match(skillDetail, /onRepairAgent=\{\(agent\) => void openInstall\(\[agent\]\)\}/)
  assert.match(skillDetail, /state === 'broken'[^]*安装有问题，点击修复[^]*onClick=\{\(\) => state === 'broken' \? onRepairAgent\(agent\)/s)
  assert.match(skillDetail, /className="profile-agent-actions"/)
  assert.doesNotMatch(skillDetail, /<h[234][^>]*>Agent 投影|className="agent-projection"/)
  assert.doesNotMatch(skillDetail, /openAgentSkillConflict/)
  assert.match(skillDetail, /plan\.sources\.length > 0 && installPreflight\?\.planDigest !== plan\.planDigest/)
})

test('local Skill import closes immediately and continues as background work', () => {
  const close = skillsPage.indexOf('closeImport()', skillsPage.indexOf('const executeImport'))
  const background = skillsPage.indexOf('void (async (): Promise<void> =>', close)
  const firstAwait = skillsPage.indexOf('await ', background)
  assert.ok(close >= 0)
  assert.ok(background > close)
  assert.ok(firstAwait > background)
  assert.match(skillsPage, /AI 会分析您的 Skill，给到您适合的标签。/)
  assert.doesNotMatch(skillsPage, /确认并执行|我同意将脱敏后的 SKILL\.md/)
  assert.match(skillsPage, /const accountSpace = currentUser \? readAuthSpace\(\) : null/)
  assert.match(skillsPage, /readAuthSpace\(\) === accountSpace/)
  assert.match(skillsPage, /apiImportSkill\([^]*\}, accountSpace\)/)
  assert.ok(skillsPage.match(/if \(!sessionStillMatches\(\)\)/g)?.length === 3)
  assert.match(skillsPage, /preflightImportSkill\(candidate\.path, candidate\.skillId\)/)
  assert.match(skillsPage, /replaceConflicts: plan\.hasConflicts/)
  assert.match(skillsPage, /planDigest: plan\.planDigest/)
  assert.match(skillsPage, /其他版本.*会移入回收站，并以您当前选择的版本为准/s)
})

test('managed Skill filters are driven by Profile labels with a category fallback', () => {
  assert.match(skillsPage, /managedSkills\.flatMap\(\(skill\) =>/)
  assert.match(skillsPage, /skill\.labels\.includes\(categoryFilter\)/)
  assert.match(skillsPage, /skill\.labels\.length === 0 && skill\.category === categoryFilter/)
})

test('Settings reports the real runtime CLI readiness and offers a retry', () => {
  assert.match(settings, /getRuntimeCliStatus/)
  assert.match(settings, /runtimeCliStatus\?\.ready === true/)
  assert.match(settings, /CLI 安装有问题/)
  assert.match(settings, /命令路径：\{runtimeCliStatus\?\.commandPath/)
  assert.match(settings, /onClick=\{\(\) => void checkRuntimeCli\(true\)\}/)
  assert.doesNotMatch(settings, /settings-label">环境变量/)
})

test('dev CLI status is informational, with no repair button or initialization polling', () => {
  assert.match(settings, /runtimeCliUnmanaged = runtimeCliStatus\?\.managed === false/)
  assert.match(settings, /if \(!runtimeCliStatus \|\| runtimeCliStatus\.managed === false \|\| runtimeCliStatus\.commandPath\) return/)
  const notice = settings.split('{runtimeCliUnmanaged ? ')[1]?.split(' : !runtimeCliChecking')[0]
  assert.ok(notice)
  assert.match(notice, /dev 构建不管理 CLI/)
  assert.doesNotMatch(notice, /<button|checkRuntimeCli|CLI 安装有问题/)
})

test('global interaction styles respect reduced motion', () => {
  assert.match(globalStyles, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(globalStyles, /animation-duration: \.01ms !important/)
  assert.match(appStyles, /\.ico-btn\s*\{[^}]*width:\s*32px;\s*height:\s*32px;/s)
  assert.match(appStyles, /\.bell-btn\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;/s)
  assert.match(globalStyles, /body\s*\{[^}]*user-select:\s*none;/s)
  assert.match(globalStyles, /input,[^}]*\.selectable-text\s*\{[^}]*user-select:\s*text;/s)
})

test('dialogs escape workspace stacking contexts through a document-level portal', () => {
  assert.match(focusTrap, /import \{ createPortal \} from 'react-dom'/)
  assert.match(focusTrap, /return createPortal\(dialog, document\.body\)/)
})

test('My Skills filter dropdowns are React-controlled popovers, not native details (#318)', () => {
  // WKWebView/WebView2 dropped native <details> toggles; open state must live in React.
  assert.doesNotMatch(skillsPage, /<details className="agent-filter/)
  assert.match(skillsPage, /const \[open, setOpen\] = useState\(false\)/)
  assert.match(skillsPage, /className="agent-filter-trigger"[^>]+aria-expanded=\{open\} aria-controls=\{menuId\}/)
  assert.equal(skillsPage.match(/\{open && <div id=\{menuId\} className="agent-filter-menu"/g)?.length, 2)
  assert.match(skillsPage, /onClick=\{\(\) => select\(agent\.key\)\}/)
  assert.match(skillsPage, /onClick=\{\(\) => \{ onSelect\(option\.value\); close\(\) \}\}/)
  assert.match(skillsPage, /if \(event\.key !== 'Escape'\) return/)
  assert.doesNotMatch(appStyles, /\.agent-filter summary/)
  assert.match(appStyles, /\.agent-filter\.open \.agent-filter-trigger > svg:last-child \{ transform: rotate\(180deg\); \}/)
})
