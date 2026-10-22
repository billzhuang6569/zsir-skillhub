import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { catalogListValues, catalogSettingsMode, catalogPublishMode, catalogPending, catalogSwitchChoice } from '../src/lib/catalog-login.ts'

test('store settings distinguish official, independent signed out and signed in', () => {
  assert.equal(catalogSettingsMode('official', false), 'official')
  assert.equal(catalogSettingsMode('selfhost', false), 'signedOut')
  assert.equal(catalogSettingsMode('local', true), 'signedIn')
  assert.equal(catalogSettingsMode('local', false), 'local')
})

test('catalog profile lists accept Chinese delimiters and keep at most eight nonempty values', () => {
  assert.deepEqual(catalogListValues(' 研究, 写作，开发、 自动化 ,, '), ['研究', '写作', '开发', '自动化'])
  assert.deepEqual(catalogListValues('1、2、3、4、5、6、7、8、9'), ['1', '2', '3', '4', '5', '6', '7', '8'])
  assert.deepEqual(catalogListValues(' ，、 '), [])
})

test('catalog submission uses existing modal fields, disclosure, error and retry patterns', () => {
  const source = readFileSync(new URL('../src/components/CatalogPublish.tsx', import.meta.url), 'utf8')
  assert.match(source, /className="eyebrow">一探官方商店<\/span><h2>提交到一探官方商店/)
  assert.match(source, /className="ico-btn" disabled=\{busy\}[^\n]+aria-label="关闭商店提交对话框"><Icon name="x" size=\{16\}/)
  assert.match(source, /显示名称<input autoFocus maxLength=\{80\}/)
  assert.match(source, /简介<textarea rows=\{3\} maxLength=\{500\}/)
  assert.match(source, /来源（可选）<input type="url"[^\n]+placeholder="https:\/\/github.com\/owner\/repo"/)
  assert.match(source, /className="profile-source-hint"/)
  assert.match(source, /审核说明<textarea rows=\{4\} maxLength=\{500\}[^\n]+说明这个 Skill 解决什么问题、适用场景与建议验收方式/)
  assert.match(source, /disabled=\{busy \|\| !profile.displayName.trim\(\) \|\| !note.trim\(\)\}/)
  assert.match(source, /className="marketplace-disclosure"><Icon name="shield"/)
  assert.match(source, /当前正式版本安装包和需要的钥匙名称/)
  assert.match(source, /className="banner banner-error" role="alert"><Icon name="warn" size=\{14\}/)
  assert.doesNotMatch(source, /className="compact-empty"|className="connection-caption"/)
  assert.match(source, /上次提交尚未确认。重试将发送完全相同的内容；修改资料后会作为新的提交。/)
  assert.match(source, /readOnly=\{fieldsLocked\}/)
  assert.match(source, /operation \? '重试原请求' : '提交审核'/)
  assert.match(source, /const \[operation, setOperation\] = useState<string \| null>\(null\)/)
  assert.match(source, /onClick=\{\(\) => \{ setOperation\(null\); setError\(null\) \}\}>修改后重新提交/)
  assert.match(source, /修改后重新提交/)
})

test('catalog settings always offer the store and keep signed-out local mode free of login actions', () => {
  const source = readFileSync(new URL('../src/components/CatalogLogin.tsx', import.meta.url), 'utf8')
  assert.match(source, /setView\('marketplace'\)\}>打开商店/)
  assert.match(source, /\(mode === 'signedIn' \|\| mode === 'signedOut'\) && <button/)
  assert.match(source, /<span>已登录：\{session.user.displayName\}<\/span>/)
  assert.ok(source.indexOf('已登录：') < source.indexOf('className="settings-row-actions"'))
  assert.match(source, /发布需要连接自部署或一探官方服务器/)
  assert.match(source, /<p className="auth-dialog-alert" role="alert">\{error\}<\/p>/)
  assert.match(source, /等待浏览器登录…/)
})

test('account reuse is a checkbox after the explanation and before connection fields', () => {
  const source = readFileSync(new URL('../src/components/ConnectServerDialog.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /type="radio"/)
  assert.match(source, /className="connection-check"><input type="checkbox" checked=\{otherAccount\} disabled=\{busy\} onChange=\{e => setOtherAccount\(e.target.checked\)\}/)
  assert.match(source, /className="connection-check"><input type="checkbox" checked=\{retainCatalog\}/)
  assert.match(source, /startYitanPortalAuth\('login', null, candidate, otherAccount\)/)
  const body = source.slice(source.indexOf('className="connection-dialog-body"'))
  assert.ok(body.indexOf('className="modal-copy"') < body.indexOf("choice === 'reuse'"))
  assert.ok(body.indexOf('原空间数据保留') < body.indexOf("choice === 'retain'"))
  assert.ok(body.indexOf("choice === 'retain'") < body.indexOf('htmlFor="connect-server-address"'))
})
test('publishing preserves official block and permits only selfhost independent publishing', () => {
  assert.equal(catalogPublishMode('official'), 'official')
  assert.equal(catalogPublishMode('selfhost'), 'selfhost')
  assert.equal(catalogPublishMode('local'), 'local')
  for (const status of ['submitted', 'under_review']) assert.equal(catalogPending(status), true)
  for (const status of [undefined, 'approved', 'rejected', 'withdrawn']) assert.equal(catalogPending(status), false)
  const source = readFileSync(new URL('../src/components/SkillDetailSheet.tsx', import.meta.url), 'utf8')
  assert.match(source, /<MarketplaceShareBlock/)
  assert.match(source, /publishMode === 'selfhost' \? <CatalogPublish/)
})
test('space carry-over choices exclude migration and never copy credentials', () => {
  assert.equal(catalogSwitchChoice('selfhost', 'official', true, false), 'reuse')
  assert.equal(catalogSwitchChoice('local', 'official', false, false), null)
  assert.equal(catalogSwitchChoice('official', 'selfhost', false, false), 'retain')
  assert.equal(catalogSwitchChoice('official', 'local', true, false), 'retain')
  assert.equal(catalogSwitchChoice('official', 'selfhost', true, true), null)
  assert.equal(catalogSwitchChoice('selfhost', 'selfhost', true, false), null)
})
