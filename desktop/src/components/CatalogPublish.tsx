import { useEffect, useState } from 'react'
import { useStore, type LocalSkill } from '../store/index.js'
import { catalogPublish, catalogSubmissionStatus, cancelCatalogLogin, type CatalogProfile, type CatalogSubmission } from '../lib/tauri.js'
import { currentOwnedServerSkillId } from '../lib/team-share-flow.js'
import { catalogListValues, catalogPending } from '../lib/catalog-login.js'
import { SOURCE_URL_MAX_LENGTH } from '../lib/source-url.js'
import { useCatalogSession } from './CatalogLogin.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import { Icon } from './Icon.js'

export default function CatalogPublish({ skill, categories }: { skill: LocalSkill; categories: string[] }) {
  const space = useStore(s => s.activeSpace)
  const account = useStore(s => s.currentUser?.id)
  const id = account ? currentOwnedServerSkillId(skill, account) : undefined
  const { session, login, busy: loggingIn, error: loginError } = useCatalogSession()
  const [submission, setSubmission] = useState<CatalogSubmission | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const [operation, setOperation] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [labels, setLabels] = useState(skill.labels.join('，'))
  const [scenarios, setScenarios] = useState((skill.fitScenarios ?? []).join('，'))
  const [profile, setProfile] = useState<CatalogProfile>({ displayName: skill.displayName || skill.name, description: skill.description ?? '', category: categories.includes(skill.category ?? '') ? skill.category! : '其他', labels: skill.labels, triggerScenarios: skill.fitScenarios ?? [], ...(skill.sourceUrl ? { sourceUrl: skill.sourceUrl } : {}), compatibleAgents: skill.compatibleAgents, envDependencies: skill.envDeps.map(({ key, description, required }) => ({ key, description, required })) })
  useEffect(() => {
    let active = true
    setSubmission(null); setError(null); setChecking(false)
    if (!space || !id || !session.signedIn) return
    setChecking(true)
    void catalogSubmissionStatus(space, id).then(value => { if (active) setSubmission(value) }).catch((e: unknown) => { if (active) { setError(String(e)); window.dispatchEvent(new Event('skillhub-catalog-session')) } }).finally(() => { if (active) setChecking(false) })
    return () => { active = false }
  }, [space, id, session.user?.id, session.signedIn, retry])
  const prepare = async (): Promise<void> => {
    if (!session.signedIn && !await login()) return
    if (!space || !id) return
    setChecking(true); setError(null)
    try { const value = await catalogSubmissionStatus(space, id); setSubmission(value); if (!catalogPending(value?.status)) setOpen(true) }
    catch (e: unknown) { setError(String(e)); window.dispatchEvent(new Event('skillhub-catalog-session')) }
    finally { setChecking(false) }
  }
  const submit = async (): Promise<void> => {
    if (!space || !id || busy || !note.trim()) return
    setBusy(true); setError(null)
    const operationId = operation ?? crypto.randomUUID()
    setOperation(operationId)
    try { setSubmission(await catalogPublish({ space, sourceSkillId: id, clientOperationId: operationId, profile: { ...profile, sourceUrl: profile.sourceUrl?.trim() || undefined, labels: catalogListValues(labels), triggerScenarios: catalogListValues(scenarios) }, note })); setOperation(null); setOpen(false) }
    catch (e: unknown) { setError(String(e)); window.dispatchEvent(new Event('skillhub-catalog-session')) }
    finally { setBusy(false) }
  }
  const pending = catalogPending(submission?.status)
  const fieldsLocked = busy || Boolean(operation)
  return <><div className="marketplace-share-card"><div className="marketplace-share-copy"><b>发布到一探官方商店</b><span>{pending ? '已提交审核' : submission ? `最近投稿：${({ approved: '已通过', rejected: '未通过', withdrawn: '已撤回' } as Record<string, string>)[submission.status] ?? submission.status}` : '提交当前正式版本，审核通过后公开。'}</span>{submission?.reviewNote && <span>{submission.reviewNote}</span>}{!id && <span>请先将自己的 Skill 保存到实例私人库。</span>}</div><button type="button" className="btn btn-primary btn-sm" disabled={!id || pending || checking || busy || loggingIn} onClick={() => void prepare()}>{loggingIn ? '等待登录…' : checking ? '读取中…' : !session.signedIn ? '登录一探账号以发布' : pending ? '等待审核' : '提交审核'}</button>{loggingIn && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void cancelCatalogLogin()}>取消登录</button>}</div>
    {(error || loginError) && <div className="banner banner-error" role="alert"><Icon name="warn" size={14} />{error ?? loginError}<button type="button" className="btn btn-ghost btn-sm" onClick={() => setRetry(v => v + 1)}>刷新状态</button></div>}
    {open && <FocusTrapDialog className="modal-layer above-sheet" label="提交到一探官方商店" onEscape={() => { if (!busy) setOpen(false) }} escapeDisabled={busy}>
      <div className="modal-card skill-dialog compact">
        <div className="modal-head">
          <div><span className="eyebrow">一探官方商店</span><h2>提交到一探官方商店</h2></div>
          <button type="button" className="ico-btn" disabled={busy} onClick={() => setOpen(false)} aria-label="关闭商店提交对话框"><Icon name="x" size={16} /></button>
        </div>
        <p className="modal-copy">将提交实例中的当前正式版本包与以下资料。审核通过前不会公开。</p>
        {operation && <p className="modal-copy">上次提交尚未确认。重试将发送完全相同的内容；修改资料后会作为新的提交。</p>}
        <div className="form-stack marketplace-submit-form">
          <label>显示名称<input autoFocus maxLength={80} value={profile.displayName} readOnly={fieldsLocked} onChange={e => setProfile(p => ({ ...p, displayName: e.target.value }))} /></label>
          <label>简介<textarea rows={3} maxLength={500} value={profile.description} readOnly={fieldsLocked} onChange={e => setProfile(p => ({ ...p, description: e.target.value }))} /></label>
          <label>分类<select value={profile.category} disabled={fieldsLocked} onChange={e => setProfile(p => ({ ...p, category: e.target.value }))}>{categories.map(category => <option key={category}>{category}</option>)}</select></label>
          <label>标签（用逗号或顿号分隔，最多 8 个）<input value={labels} readOnly={fieldsLocked} onChange={e => setLabels(e.target.value)} /></label>
          <label>来源（可选）<input type="url" inputMode="url" spellCheck={false} maxLength={SOURCE_URL_MAX_LENGTH} placeholder="https://github.com/owner/repo" value={profile.sourceUrl ?? ''} readOnly={fieldsLocked} onChange={e => setProfile(p => ({ ...p, sourceUrl: e.target.value }))} /><span className="profile-source-hint">Skill 的原始网址，仅支持 http/https；清空即删除来源</span></label>
          <label>适用场景（用逗号或顿号分隔，最多 8 个）<input value={scenarios} readOnly={fieldsLocked} onChange={e => setScenarios(e.target.value)} /></label>
          <label>审核说明<textarea rows={4} maxLength={500} value={note} readOnly={fieldsLocked} onChange={e => setNote(e.target.value)} placeholder="说明这个 Skill 解决什么问题、适用场景与建议验收方式" /></label>
        </div>
        <div className="marketplace-disclosure"><Icon name="shield" size={15} /><div><b>将公开</b><span>Profile、脱敏后的 SKILL.md、当前正式版本安装包和需要的钥匙名称。</span><strong>不会公开任何钥匙的值或凭据。</strong></div></div>
        {error && <div className="banner banner-error" role="alert"><Icon name="warn" size={14} />{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>取消</button>
          {operation && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setOperation(null); setError(null) }}>修改后重新提交</button>}
          <button type="button" className="btn btn-primary" disabled={busy || !profile.displayName.trim() || !note.trim()} onClick={() => void submit()}>{busy ? '提交中…' : operation ? '重试原请求' : '提交审核'}</button>
        </div>
      </div>
    </FocusTrapDialog>}
  </>
}
