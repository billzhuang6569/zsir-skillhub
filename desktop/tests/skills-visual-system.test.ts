// 「我的 Skills」 list rows, cards, badges, unmanaged cards and the detail sheet shell
// aligned to the Tan Skillhub Design System (#261). Source-text checks in the style
// of the other desktop tests, plus the row issue matrix as real data.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { issueForSkill, issueTooltipParts, lastRunFailureTooltip, skillIssueTagClass } from '../src/lib/skill-library.ts'
import type { LastRunRecord } from '../src/lib/tauri.ts'
import { LEGACY_TOKEN_NAMES } from './legacy-token-names.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')
const rule = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = withoutComments(css).match(new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`))
  assert.ok(match, `missing rule ${selector}`)
  return match[1] ?? ''
}

const OWNED = [
  'src/components/SkillLibraryList.css', 'src/components/SkillLibraryList.tsx',
  'src/components/SkillCard.css', 'src/components/SkillCard.tsx',
  'src/components/UnmanagedSkillCard.tsx',
  'src/components/LocalSkillPreviewPanel.css', 'src/components/LocalSkillPreviewPanel.tsx',
  'src/components/SkillBatchDialog.tsx', 'src/components/DeleteSkillDialog.tsx', 'src/components/UnmanageSkillDialog.tsx',
  'src/components/EditorialLabels.css', 'src/components/EditorialLabels.tsx',
  'src/components/SkillAvatarIcon.tsx',
  'src/components/SkillDetailSheet.css', 'src/components/SkillDetailSheet.tsx',
  'src/components/SkillControls.css',
]

const list = read('src/components/SkillLibraryList.tsx')
const listCss = read('src/components/SkillLibraryList.css')
const card = read('src/components/SkillCard.tsx')
const cardCss = read('src/components/SkillCard.css')
const unmanaged = read('src/components/UnmanagedSkillCard.tsx')
const sheet = read('src/components/SkillDetailSheet.tsx')
const sheetCss = read('src/components/SkillDetailSheet.css')
const controls = read('src/components/SkillControls.css')
const storeUi = read('src/components/store/StoreUI.tsx')
const storeCss = read('src/components/store/StoreUI.css')

test('owned files use only canonical tokens: no deprecated aliases, no --tsh- names', () => {
  const legacy = LEGACY_TOKEN_NAMES
  for (const name of ['accent', 'ink2', 'line2', 'surface2', 'sh3', 'r3', 'font', 'mono']) assert.ok(legacy.includes(name), name)
  for (const path of OWNED) {
    const source = read(path)
    for (const name of legacy) assert.doesNotMatch(source, new RegExp(`var\\(--${name}[,)]`), `${path} uses deprecated --${name}`)
    assert.doesNotMatch(source, /--tsh-/, `${path} uses a --tsh- store alias`)
    assert.doesNotMatch(source, /var\(--ink1\)/, path)
  }
})

test('StoreBadges and the store Tag / SkillAvatar ring render from global tokens without a token scope', () => {
  for (const selector of ['.tsh-tag', '.tsh-tag-brand', '.tsh-tag-warning', '.tsh-tag-success', '.tsh-tag-outline', '.tsh-avatar::after', '.tsh-avatar-md']) {
    const body = rule(storeCss, selector)
    assert.doesNotMatch(body, /--tsh-/, selector)
  }
  assert.match(rule(storeCss, '.tsh-tag-warning'), /background: var\(--color-warning-tint\); color: var\(--color-warning\);/)
  assert.match(rule(storeCss, '.tsh-avatar::after'), /box-shadow: inset 0 0 0 1px var\(--color-line\);/)
  // #263 deleted store-tokens.css and the .tsh-tokens scope.
  assert.match(storeUi, /<span className="tsh-badges" aria-label="商店标签">/)
  assert.doesNotMatch(storeUi, /tsh-tokens|store-tokens/)
})

test('row issue matrix: one icon, most urgent first, env as warning + key-round with the #255 key wording', () => {
  const base = { agents: {}, isOrphan: false, hasWorkingCopy: false, accountSyncRequired: false }
  const two = { needsValue: 2, needsChoice: 0 }
  const none = { needsValue: 0, needsChoice: 0 }
  const cases: Array<[string, ReturnType<typeof issueForSkill>]> = [
    ['orphan', issueForSkill({ ...base, isOrphan: true }, two, true, true, 'x')],
    ['broken', issueForSkill({ ...base, agents: { claude: 'broken', codex: 'on' } }, two, false, true, null)],
    ['env', issueForSkill(base, two, true, true, 'x')],
    ['choice', issueForSkill(base, { needsValue: 0, needsChoice: 1 }, false, true, null)],
    ['policy', issueForSkill(base, none, true, true, 'x')],
    ['version', issueForSkill({ ...base, hasWorkingCopy: true }, none, false, true, '版本冲突')],
    ['modified', issueForSkill({ ...base, hasWorkingCopy: true, accountSyncRequired: true }, none, false, true, null)],
    ['relink', issueForSkill({ ...base, accountSyncRequired: true }, none, false, true, null)],
    ['guest', issueForSkill({ ...base, accountSyncRequired: true }, none, false, false, null)],
  ]
  assert.deepEqual(Object.fromEntries(cases.map(([key, issue]) => [key, issue && [issue.label, issue.tone, issue.icon, skillIssueTagClass(issue)]])), {
    orphan: ['资料暂不可用', 'danger', 'warn', 'skill-issue-icon skill-issue-icon-danger'],
    broken: ['安装有问题', 'danger', 'warn', 'skill-issue-icon skill-issue-icon-danger'],
    env: ['需要填写 2 把钥匙', 'warning', 'key-round', 'skill-issue-icon skill-issue-icon-warning'],
    choice: ['需要选择', 'warning', 'list', 'skill-issue-icon skill-issue-icon-warning'],
    policy: ['钥匙检查未完成', 'warning', 'warn', 'skill-issue-icon skill-issue-icon-warning'],
    version: ['版本需要处理', 'danger', 'warn', 'skill-issue-icon skill-issue-icon-danger'],
    modified: ['已修改', 'info', 'hist', 'skill-issue-icon skill-issue-icon-info'],
    relink: ['重新连接账号', 'info', 'refresh', 'skill-issue-icon skill-issue-icon-info'],
    guest: null,
  })
  // #289 board 1: warnings are a 14px icon next to the name, wrapped in Tooltip; the label stays the aria-label.
  assert.match(list, /\{issue && issueIcon && <SkillIssueIcon issue=\{issue\} \/>\}/)
  assert.match(list, /<Tooltip content=\{content\} align="start" className="skill-issue-tip">/)
  assert.match(list, /className=\{skillIssueTagClass\(issue\)\}\n\s*aria-label=\{issue\.label\}\n\s*data-issue-target=\{issue\.target\}\n\s*><Icon name=\{issue\.icon\} size=\{14\}/)
  assert.match(list, /<span className="ui-tip-title">[^]*<span className="ui-tip-body">[^]*<span className="ui-tip-actions">/)
  assert.match(list, /data-issue-action="env">去填写<\/span>/)
  assert.match(list, /data-issue-action="overview">查看详情<\/span>/)
  // The row's own label keeps the warning text for screen readers.
  assert.match(list, /aria-label=\{`查看 \$\{title\.primary\}[^`]*\$\{issueIcon && issue \? `，\$\{issue\.label\}` : ''\}`\}/)
  // Clicking a key icon opens the Skill on its 「需要的钥匙」 section; tooltip buttons route by data-issue-action.
  assert.match(list, /issue\?\.target === 'env' && \(event\.target as Element\)\.closest\?\.\('\[data-issue-target="env"\]'\)\) openSkillSheet\(skill\.id, 'environment', 'env'\)/)
  assert.match(list, /if \(action === 'env'\) openSkillSheet\(skill\.id, 'environment', 'env'\)\n\s*else if \(action === 'overview'\) openSkillSheet\(skill\.id, 'profile'\)/)
  assert.match(rule(listCss, '.skill-issue-icon-danger'), /color: var\(--color-danger\);/)
  assert.match(rule(listCss, '.skill-issue-icon-warning'), /color: var\(--color-warning\);/)
  assert.match(rule(listCss, '.skill-issue-icon-info'), /color: var\(--color-brand\);/)
  // The tooltip must not be clipped by the row's content-visibility paint containment.
  assert.match(listCss, /\.skill-library-row:hover,\n\.skill-library-row:focus-within \{ content-visibility: visible; \}/)
  // The card issue pill uses the same key wording and icon as the list.
  assert.match(card, /const keyIssue = envKeyIssue\(envKeys\)/)
  assert.match(card, /<Icon name=\{keyIssue\.icon\} size=\{13\} strokeWidth=\{1\.75\} \/>\{keyIssue\.label\}/)
  assert.match(rule(cardCss, '.card-issue.warning'), /background: var\(--color-warning-tint\); color: var\(--color-warning\);/)
})

test('SkillRow (#289, v0.29 type sizes): 44px ringed avatar, name line, 友好名 + tag chips + Agents line, description line', () => {
  assert.match(list, /const AVATAR_CLASS = 'skill-library-avatar tsh-avatar tsh-avatar-md'/)
  assert.match(list, /className=\{AVATAR_CLASS\}\n\s*avatarUrl=\{skill\.avatarUrl\}\n\s*status=\{skill\.avatarStatus\}\n\s*size=\{44\}/)
  const order = ['skill-library-name-row', 'skill-library-text', 'skill-library-subtitle', 'skill-library-desc', 'skill-library-side'].map((name) => list.indexOf(name))
  assert.ok(order.every((index, position) => index > 0 && (position === 0 || index > (order[position - 1] ?? 0))), `row order ${order}`)
  assert.match(list, /\{title\.secondary && <span className=\{`skill-library-subtitle/)
  // #289: the description is always shown; a version problem lives in the warning tooltip instead.
  assert.match(list, /\{skill\.description && <span className="skill-library-desc" title=\{skill\.description\}>\{skill\.description\}<\/span>\}/)
  // #323: line 2 shows the private tag chips instead of the AI category text.
  assert.match(list, /<SkillTagChips names=\{tagsForSkill\(organizer, skillOrganizerKey\(skill, currentUser\?\.id \?\? null\)\)\} limit=\{ROW_TAG_LIMIT\} \/>/)
  assert.doesNotMatch(list, /skill-library-category/)
  assert.doesNotMatch(list, /skill-library-problem/)
  const row = rule(listCss, '.skill-library-row')
  // 6px + 18px name + 16px text + 3px + 16px description + 6px = 65px with a description; the row floor is 64px.
  // Type sizes stay at the v0.29 values (13.5px name, 11px subtitle / description): the design tokens read too large here.
  assert.match(row, /padding: 6px var\(--space-4\);/)
  assert.match(row, /row-gap: 0;/)
  assert.match(listCss, /--skill-library-avatar-size: 48px;/)
  assert.match(rule(listCss, '.skill-library-name-row'), /min-height: 18px;/)
  const text = rule(listCss, '.skill-library-text')
  assert.match(text, /min-height: 16px;[^]*white-space: nowrap;/)
  assert.match(rule(listCss, '.skill-library-desc'), /text-overflow: ellipsis;/)
  assert.match(row, /content-visibility: auto;/)
  assert.match(row, /contain-intrinsic-size: auto 70px;/)
  assert.match(row, /min-height: 64px;/)
  assert.match(row, /transition-duration: var\(--motion-base\);/)
  // Wide list: badges in a trailing column; narrow Skill browser: badges lead line 2.
  assert.match(row, /grid-template-areas:\n\s*"avatar name name chevron"\n\s*"avatar text side chevron"\n\s*"avatar desc desc chevron";/)
  assert.match(listCss, /container: skill-library \/ inline-size;/)
  assert.match(listCss, /@container skill-library \(max-width: 560px\) \{[^@]*\.skill-library-row \{ padding-inline: var\(--space-3\); \}/)
  assert.match(rule(listCss, '.skill-library-copy'), /display: contents;/)
  assert.match(rule(listCss, '.skill-library-row:hover'), /transform: translateY\(-2px\); box-shadow: var\(--shadow-card\);/)
  assert.match(listCss, /@media \(prefers-reduced-motion: reduce\) \{\n\s*\.skill-library-row \{ transition: none; \}\n\s*\.skill-library-row:hover \{ transform: none; box-shadow: none; \}/)
  // v0.29 list type sizes (user 2026-10-14): 13.5px / 680 name, 11px subtitle and description.
  assert.match(rule(listCss, '.skill-library-name-row strong'), /font-size: 13\.5px;[^]*font-weight: 680;[^]*line-height: 1\.3;/)
  assert.match(rule(listCss, '.skill-library-subtitle'), /font-size: 11px;/)
  assert.match(rule(listCss, '.skill-library-desc'), /font-size: 11px;/)
  assert.match(rule(listCss, '.skill-library-subtitle'), /color: var\(--color-ink\);[^]*font-size: 11px;[^]*font-weight: 650;/)
  assert.match(rule(listCss, '.skill-library-desc'), /color: var\(--color-muted\);[^]*font-size: 11px;/)
  assert.match(rule(listCss, '.skill-library-row:focus-visible'), /outline: 2px solid var\(--color-brand\);/)
  // Team-share ring keeps its animation and the static reduced-motion variant, now from brand tokens.
  assert.match(rule(listCss, '.skill-library-avatar-wrap.team-shared::before'), /conic-gradient\(from 0deg, var\(--color-brand-tint\), var\(--color-brand\)/)
  assert.match(listCss, /@media \(prefers-reduced-motion: reduce\) \{\n\s*\.skill-library-avatar-wrap\.team-shared::before \{ animation: none; background: linear-gradient\(135deg, var\(--color-brand-tint\), var\(--color-brand\)\); \}/)
})

test('row badges: muted mono version text, 待确认/已修改 pills, system brand tag, Agent installed / broken dots, 未安装 fallback', () => {
  assert.match(list, /<span className="skill-library-version-text mono">\{versionDisplay\.label\}<\/span>/)
  assert.match(rule(listCss, '.skill-library-version-text'), /color: var\(--color-muted\);/)
  assert.match(list, /\{skill\.versionStatus === 'pending' && <span className="skill-library-version">待确认<\/span>\}/)
  assert.match(list, /\{skill\.hasWorkingCopy && <span className="skill-library-version">已修改<\/span>\}/)
  assert.match(rule(listCss, '.skill-library-version,\n.skill-library-system'), /border-radius: var\(--radius-pill\);[^]*font-size: var\(--font-size-caption\);/)
  assert.match(listCss, /\n\.skill-library-system \{ border-color: transparent; background: var\(--color-brand-tint\); color: var\(--color-brand\); \}/)
  assert.match(rule(listCss, '.skill-library-agent.on .skill-library-agent-state'), /background: var\(--color-success\);/)
  assert.match(rule(listCss, '.skill-library-agent.broken .skill-library-agent-state'), /background: var\(--color-danger\);/)
  assert.match(list, /title=\{`\$\{agentDisplayName\(agentKey\)\}：\$\{status === 'on' \? '已安装' : status === 'broken' \? '安装有问题' : '未安装'\}`\}/)
  assert.match(list, /: <span className="skill-library-no-agent">未安装<\/span>\}/)
})

test('SkillCard: 48px ringed avatar, radius-lg, shadow-sm at rest, 2px hover lift with shadow-card', () => {
  assert.match(card, /function CategoryIcon\(\{ avatarUrl, status, size = 48 \}/)
  assert.match(card, /className=\{`skill-cat-icon tsh-avatar tsh-avatar-\$\{radius\}`\}/)
  const body = rule(cardCss, '.skill-card')
  assert.match(body, /border: 1px solid var\(--color-line\);[^]*border-radius: var\(--radius-lg\);[^]*box-shadow: var\(--shadow-sm\);/)
  assert.match(body, /transition: box-shadow var\(--motion-base\) var\(--ease-standard\), transform var\(--motion-base\) var\(--ease-standard\);/)
  assert.match(rule(cardCss, '.skill-card:hover'), /box-shadow: var\(--shadow-card\); transform: translateY\(-2px\);/)
  assert.match(cardCss, /@media \(prefers-reduced-motion: reduce\) \{\n\s*\.skill-card \{ transition: none; \}\n\s*\.skill-card:hover \{ transform: none; \}/)
  assert.match(rule(cardCss, '.card-slug'), /color: var\(--color-ink\);[^]*font-size: 13px; font-weight: 600;/)
  assert.match(rule(cardCss, '.card-desc'), /color: var\(--color-muted\);/)
  assert.doesNotMatch(card, /className="chip"/)
})

test('unmanaged cards share the dense row geometry and keep the lasso selection indicator room', () => {
  assert.match(unmanaged, /<CategoryIcon size=\{44\} \/>/)
  assert.match(unmanaged, /local-library-subtitle/)
  const body = rule(cardCss, '.local-library-card')
  assert.match(body, /grid-template-columns: 44px minmax\(0, 1fr\) auto 14px;/)
  assert.match(body, /padding: 14px var\(--space-4\) 14px 44px;/)
  assert.match(body, /contain-intrinsic-size: auto 72px;/)
  assert.match(body, /content-visibility: auto;/)
  assert.match(read('src/components/LocalSkillPreviewPanel.tsx'), /<CategoryIcon size=\{112\} \/>/)
})

test('detail sheet shell: 64px header avatar for every Skill, label tabs with a brand underline, no gradients', () => {
  assert.match(sheet, /<SkillAvatarIcon className="sh-cat-icon" avatarUrl=\{skill\.avatarUrl\} status=\{skill\.avatarStatus\} size=\{64\} \/>/)
  assert.match(sheet, /<SkillDetailTitle skill=\{skill\} onCopyName=\{copySkillName\} problem=\{<SkillProblemButton skill=\{skill\} onRepair=\{\(brokenAgents\) => void openInstall\(brokenAgents\)\} \/>\} \/>/)
  assert.match(sheet, /<span className="tsh-tag tsh-tag-brand mono">\{versionDisplay\.label\}<\/span>/)
  const tab = rule(sheetCss, '.sh-tab')
  assert.match(tab, /font: var\(--font-weight-label\) var\(--font-size-label\)\/var\(--line-height-label\) var\(--font-sans\);/)
  assert.match(tab, /min-height: 44px;/)
  assert.match(rule(sheetCss, '.sh-tab.on'), /border-color: var\(--color-brand\);/)
  assert.match(rule(sheetCss, '.sh-panel'), /border-radius: var\(--radius-lg\);/)
  assert.doesNotMatch(withoutComments(sheetCss), /gradient\(/)
  assert.doesNotMatch(rule(sheetCss, '.comment-replies'), /border-left/)
  // The key tab markup is #255's own SkillKeys component.
  assert.doesNotMatch(sheet, /env-source-panel/)
})

test('Skill dialogs follow the button spec: radius-lg card, brand primary, solid danger, 2px brand focus ring', () => {
  for (const path of ['src/components/SkillBatchDialog.tsx', 'src/components/DeleteSkillDialog.tsx', 'src/components/UnmanageSkillDialog.tsx']) {
    const source = read(path)
    assert.match(source, /className="modal-card skill-dialog/, path)
    assert.match(source, /import '\.\/SkillControls\.css'/, path)
  }
  assert.match(read('src/components/DeleteSkillDialog.tsx'), /<button className="btn btn-danger" onClick=\{\(\) => onConfirm\(decision\.kind\)\}/)
  assert.match(rule(controls, '.skill-dialog'), /border-radius: var\(--radius-lg\);/)
  assert.match(rule(controls, '.detail-sheet .btn-primary,\n.skill-dialog .btn-primary'), /background: var\(--color-brand\); color: var\(--color-on-brand\);/)
  assert.match(rule(controls, '.detail-sheet .btn-danger,\n.skill-dialog .btn-danger'), /background: var\(--color-danger\);/)
  assert.match(controls, /\.skill-dialog \.btn:focus-visible,[^{]*\{ outline: 2px solid var\(--color-brand\); outline-offset: 2px; \}/)
})

const NOW = new Date(2026, 9, 14, 15, 0).getTime()
const failure = (overrides: Partial<LastRunRecord>): LastRunRecord => ({
  version: 1, skillId: 'demo', at: new Date(2026, 9, 14, 10, 42).getTime(), outcome: 'failed',
  reasonCode: 'missing_key', keys: ['REPLICATE_API_TOKEN'], exitCode: null, agent: 'claude', message: 'MISSING_KEY: …',
  ...overrides,
})

test('上次运行失败 (#292): right after 安装有问题, danger + warn, key causes open 钥匙 and others 概览', () => {
  const base = { agents: {}, isOrphan: false, hasWorkingCopy: false, accountSyncRequired: false }
  const two = { needsValue: 2, needsChoice: 0 }
  const missing = failure({})
  assert.equal(issueForSkill({ ...base, agents: { claude: 'broken' } }, two, false, true, null, missing)?.label, '安装有问题')
  assert.equal(issueForSkill({ ...base, isOrphan: true }, two, false, true, null, missing)?.label, '资料暂不可用')
  const issue = issueForSkill(base, two, true, true, 'x', missing)
  assert.ok(issue)
  assert.deepEqual([issue.label, issue.tone, issue.icon, issue.target, skillIssueTagClass(issue)],
    ['上次运行失败', 'danger', 'warn', 'env', 'skill-issue-icon skill-issue-icon-danger'])
  assert.deepEqual(issueTooltipParts(issue), { title: issue.title?.split('\n')[0], body: '缺少钥匙 REPLICATE_API_TOKEN，Skill 没有拿到它就停止了。' })
  assert.match(issue.title ?? '', /^上次运行失败 · .+ · Claude Code\n缺少钥匙 REPLICATE_API_TOKEN，Skill 没有拿到它就停止了。$/)
  assert.equal(issueForSkill(base, two, false, true, null, failure({ reasonCode: 'needs_choice' }))?.target, 'env')
  assert.equal(issueForSkill(base, two, false, true, null, failure({ reasonCode: 'needs_consent' }))?.target, 'env')
  assert.equal(issueForSkill(base, two, false, true, null, failure({ reasonCode: 'exit_code', keys: [], exitCode: 2 }))?.target, 'overview')
  assert.equal(issueForSkill(base, two, false, true, null, failure({ outcome: 'ok' }))?.label, '需要填写 2 把钥匙')
  assert.equal(issueForSkill(base, two, false, true, null, null)?.label, '需要填写 2 把钥匙')
  assert.match(list, /context === 'personal' \? lastRunFailures\[skill\.id\] : null/)
  assert.match(list, /issue\?\.target === 'overview' && \(event\.target as Element\)\.closest\?\.\('\[data-issue-target="overview"\]'\)\) openSkillSheet\(skill\.id, 'profile'\)/)
})

test('last-run tooltip variants name keys and codes only', () => {
  assert.equal(lastRunFailureTooltip(failure({}), 'Claude Code', NOW),
    '上次运行失败 · 今天 10:42 · Claude Code\n缺少钥匙 REPLICATE_API_TOKEN，Skill 没有拿到它就停止了。')
  assert.equal(lastRunFailureTooltip(failure({ reasonCode: 'needs_choice', keys: ['API_KEY'] }), undefined, NOW),
    '上次运行失败 · 今天 10:42\n需要选择用哪把钥匙：API_KEY')
  assert.equal(lastRunFailureTooltip(failure({ reasonCode: 'needs_consent', keys: ['K1', 'K2'] }), undefined, NOW),
    '上次运行失败 · 今天 10:42\n等待你授权钥匙 K1、K2')
  assert.equal(lastRunFailureTooltip(failure({ reasonCode: 'exit_code', keys: [], exitCode: 3 }), undefined, NOW),
    '上次运行失败 · 今天 10:42\n程序退出码 3')
  assert.equal(lastRunFailureTooltip(failure({ reasonCode: 'spawn_failed', keys: [] }), undefined, NOW),
    '上次运行失败 · 今天 10:42\n程序没有启动')
  assert.equal(lastRunFailureTooltip(failure({ reasonCode: 'other', keys: [], message: '当前 SkillHub 登录已失效' }), undefined, NOW),
    '上次运行失败 · 今天 10:42\n当前 SkillHub 登录已失效')
  const yesterday = new Date(2026, 9, 13, 9, 5).getTime()
  assert.match(lastRunFailureTooltip(failure({ at: yesterday }), undefined, NOW), /^上次运行失败 · 昨天 09:05\n/)
  const earlier = new Date(2026, 9, 2, 18, 30).getTime()
  assert.match(lastRunFailureTooltip(failure({ at: earlier }), undefined, NOW), /^上次运行失败 · 10月2日 18:30\n/)
})
