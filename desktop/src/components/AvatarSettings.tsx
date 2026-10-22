import { Fragment, useEffect, useRef, useState } from 'react'
import DocHelp from './DocHelp.js'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  apiAvatarStyle, apiAvatarStyles, apiAvatarStylePreview, apiAvatarStyleApply,
  apiInstanceFal, apiInstanceFalTest, apiInstanceFalSave, apiInstanceFalDelete, sameSpace,
  type AvatarStyle, type AvatarStyleSelection, type AvatarStylePreview, type AvatarStyleApply, type InstanceFalSettings,
} from '../lib/api.js'
import type { SpaceHandle } from '../lib/tauri.js'
import { canManageAvatarStyle, canSaveFal, falError, falForm, styleApplyInput, styleConfirmation, styleGallery, styleResultMessage, styleUnavailable } from '../lib/avatar-settings.js'
import { useMediaUrl } from '../lib/media.js'
import { requestLibrarySync, LIBRARY_ENTRIES_CHANGED_EVENT } from '../lib/library-sync.js'
import { AVATAR_SELECTIONS_CHANGED_EVENT } from '../lib/skill-avatars.js'
import { useStore } from '../store/index.js'
import ConfirmModal from './ConfirmModal.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import { Icon } from './Icon.js'
import { toast } from './Toast.js'
import './InstanceSettings.css'

function StyleImage({ style, onPreview, onUnavailable }: { style: AvatarStyle; onPreview?: () => void; onUnavailable?: () => void }) {
  const url = useMediaUrl(style.preview.url)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [url])
  const content = url && !failed ? <img src={url} alt={style.name.zh} onError={() => { setFailed(true); onUnavailable?.() }} />
    : <span className="avatar-style-placeholder" aria-label="暂无示例图"><Icon name="image" size={24} /></span>
  return url && !failed && onPreview
    ? <button type="button" className="avatar-style-image" aria-label={`预览「${style.name.zh}」`} onClick={onPreview}>{content}</button>
    : <div className="avatar-style-image">{content}</div>
}

/** The parent keys this form by space generation, account and role. No draft survives a switch. */
export default function AvatarSettings({ space, admin, selfhost }: { space: SpaceHandle; admin: boolean; selfhost: boolean }) {
  const userId = useStore(state => state.currentUser?.id)
  const feature = useStore(state => state.serverInfo?.features?.avatars)
  const [fal, setFal] = useState<InstanceFalSettings | null>(null)
  const [form, setForm] = useState(falForm)
  const [editing, setEditing] = useState(false)
  const [tested, setTested] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [selection, setSelection] = useState<AvatarStyleSelection | null>(null)
  const [styles, setStyles] = useState<AvatarStyle[]>([])
  const [expanded, setExpanded] = useState(false)
  const [columns, setColumns] = useState(6)
  const [image, setImage] = useState<AvatarStyle | null>(null)
  const imageUrl = useMediaUrl(image?.preview.url)
  const [preview, setPreview] = useState<{ style: AvatarStyle; value: AvatarStylePreview } | null>(null)
  const [includeCustom, setIncludeCustom] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const locked = useRef(false)
  const revision = useRef(0)
  const current = (): boolean => mounted.current && sameSpace(space, useStore.getState().activeSpace)
    && useStore.getState().currentUser?.id === userId
    && (!selfhost || (useStore.getState().currentUser?.marketplaceRole === 'admin') === admin)
  const configured = selfhost && admin ? fal?.configured ?? feature : feature
  const manageable = canManageAvatarStyle(selection, selfhost, admin)
  const gallery = styleGallery(styles, selection?.styleId ?? '', expanded, columns)
  const installFal = (value: InstanceFalSettings): void => {
    if (!current()) return
    setFal(value); setForm(falForm()); setTested(false); setEditing(value.source === 'none')
    useStore.setState(state => ({ serverInfo: state.serverInfo?.features ? { ...state.serverInfo,
      features: { ...state.serverInfo.features, avatars: value.configured } } : state.serverInfo }))
  }
  const loadStyle = async (): Promise<void> => {
    try {
      const value = await apiAvatarStyle(space)
      if (!current()) return
      setSelection(value)
      const list = await apiAvatarStyles(space)
      if (current()) setStyles(list)
    } catch (failure: unknown) {
      if (!current()) return
      if (styleUnavailable(failure)) { setSelection(null); setStyles([]) }
      else setError('无法读取头像风格，请稍后重试。')
    }
  }
  const load = async (includeGallery = true): Promise<void> => {
    setLoading(true); setError('')
    await Promise.all([
      selfhost && admin ? apiInstanceFal(space).then(installFal).catch(() => { if (current()) setError('无法读取 fal.ai 配置，请稍后重试。') }) : Promise.resolve(),
      includeGallery && (selfhost || feature === true) ? loadStyle() : Promise.resolve(),
    ])
    if (current()) setLoading(false)
  }
  useEffect(() => {
    mounted.current = true; void load(selfhost)
    return () => { mounted.current = false; revision.current += 1 }
  }, [space.spaceId, space.generation, userId, admin, selfhost])
  useEffect(() => {
    if (!selfhost && feature === true) void loadStyle()
    if (!selfhost && feature === false) { setSelection(null); setStyles([]); setPreview(null) }
  }, [selfhost, feature])
  useEffect(() => {
    const narrow = window.matchMedia?.('(max-width: 480px)')
    const medium = window.matchMedia?.('(max-width: 800px)')
    const resize = (): void => setColumns(narrow?.matches ? 2 : medium?.matches ? 3 : 6)
    resize(); narrow?.addEventListener('change', resize); medium?.addEventListener('change', resize)
    return () => { narrow?.removeEventListener('change', resize); medium?.removeEventListener('change', resize) }
  }, [])
  useEffect(() => {
    if (!form.draftToken) return
    const timer = window.setTimeout(() => {
      if (!current()) return
      setForm(previous => ({ ...previous, draftToken: null, expiresAt: 0 })); setTested(false)
      setError(falError({ code: 'TEST_REQUIRED' }))
    }, Math.max(0, form.expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [form.draftToken, form.expiresAt])
  const run = async (action: () => Promise<void>, kind: 'fal' | 'style'): Promise<void> => {
    if (locked.current || !current()) return
    locked.current = true; setBusy(true); setError('')
    try { await action() } catch (failure: unknown) {
      if (!current()) return
      setError(kind === 'fal' ? falError(failure) : '风格操作失败，请刷新状态后重试。')
      if (kind === 'fal' && failure && typeof failure === 'object' && 'code' in failure && failure.code === 'ENV_OVERRIDE') {
        setForm(falForm()); setEditing(false)
        setFal(previous => previous ? { ...previous, source: 'env' } : previous)
        await apiInstanceFal(space).then(installFal).catch(() => {})
      }
    } finally { locked.current = false; if (current()) setBusy(false) }
  }
  const test = async (): Promise<void> => {
    if (!admin || fal?.source === 'env') return
    const attempt = ++revision.current
    const startedAt = Date.now()
    setForm(falForm(form.apiKey)); setTested(false)
    const result = await apiInstanceFalTest(form.apiKey, space)
    if (!current() || attempt !== revision.current) return
    setForm({ apiKey: form.apiKey, draftToken: result.draftToken, expiresAt: startedAt + 600_000 }); setTested(true)
  }
  const save = async (): Promise<void> => {
    if (!fal || !admin || !canSaveFal(form, fal.source, false)) return
    const body = { apiKey: form.apiKey, draftToken: form.draftToken! }
    setForm(falForm(form.apiKey)); setTested(false)
    const value = await apiInstanceFalSave(body, space)
    if (current()) { installFal(value); toast('fal.ai 配置已保存') }
  }
  const prepare = async (style: AvatarStyle): Promise<void> => {
    if (!manageable || style.styleId === selection?.styleId) return
    const value = await apiAvatarStylePreview(style.styleId, space)
    if (current()) { setIncludeCustom(false); setPreview({ style, value }) }
  }
  const apply = async (mode: AvatarStyleApply['mode']): Promise<void> => {
    if (!preview || !manageable || (mode === 'applyExisting' && !configured)) return
    const result = await apiAvatarStyleApply(styleApplyInput(preview.style.styleId, mode, includeCustom), space)
    if (!current()) return
    setPreview(null)
    toast(mode === 'newOnly' ? `已切换为「${preview.style.name.zh}」，现有头像保持不变` : styleResultMessage(result))
    requestLibrarySync(); window.dispatchEvent(new Event(LIBRARY_ENTRIES_CHANGED_EVENT))
    window.dispatchEvent(new Event(AVATAR_SELECTIONS_CHANGED_EVENT))
    await loadStyle()
  }

  return <>
    {selfhost && <div className="settings-row settings-row-stack avatar-settings">
      <div className="settings-row-info"><b>fal.ai API Key
        <span className={`inline-status ${configured ? 'online' : 'checking'}`}>
          {fal?.source === 'env' ? '由服务器环境变量提供' : configured === undefined ? '状态未知' : configured ? '已配置' : '未配置'}
        </span>
      </b><span>用于生成 Skill 头像。 <DocHelp topic="fal" variant="inline" label="了解更多" /></span>
        {admin && (fal?.source === 'env' ? <span>由服务器环境变量提供，在此不可修改</span>
          : fal?.configured ? <span>{fal.masked} · 最近测试：{fal.lastTest ? new Date(fal.lastTest.at).toLocaleString() : '暂无记录'}</span> : null)}
        {!admin && <span>由实例管理员配置</span>}
      </div>
      {selfhost && admin && fal && fal.source !== 'env' && <>
        {!editing && <div className="instance-actions"><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEditing(true)}>更换</button></div>}
        {editing && <fieldset className="instance-form" disabled={busy}>
          <input id="instance-fal-key" aria-label="fal.ai API Key" placeholder="粘贴 fal.ai API Key" className="form-input" type="password" autoComplete="off" spellCheck={false} value={form.apiKey} maxLength={512} onChange={event => {
            revision.current += 1; setForm(falForm(event.target.value)); setTested(false); setError('')
          }} />
          <div className="instance-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openUrl('https://fal.ai/dashboard/keys').catch(() => { if (current()) toast('无法打开浏览器，请稍后重试', 'error') })}>获取 API Key</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy || form.apiKey.length < 16} onClick={() => void run(test, 'fal')}>测试</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={!canSaveFal(form, fal.source, busy)} onClick={() => void run(save, 'fal')}>保存</button>
          </div>
          <p className="connection-caption">只验证 Key，不生成收费图片</p>
          {tested && <span className="inline-status online">测试通过，10 分钟内可保存</span>}
        </fieldset>}
        {fal.configured && <div className="instance-actions"><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setDeleting(true)}>删除</button></div>}
      </>}
    </div>}
    <div className="settings-row settings-row-stack avatar-settings">
      <div className="settings-row-info"><b>头像风格</b><span>{selfhost ? admin ? '实例内所有成员使用同一个风格。' : '当前风格由实例管理员设置' : '新生成的 Skill 头像使用这个风格；已有头像不变。'}</span></div>
      {!selfhost && feature !== true && <span className="inline-status checking">{feature === undefined ? '状态未知' : '官方头像服务未启用'}</span>}
      {loading && <span className="inline-status checking">正在读取配置…</span>}
      {selection && (selfhost || feature === true) && <>
        <div className="avatar-style-grid">
          {gallery.visible.map(style => <div className="avatar-style-card" key={style.styleId}>
            <StyleImage style={style} onPreview={() => setImage(style)} />
            <div className="settings-row-info"><b title={style.name.zh}>{style.name.zh}</b><span title={style.description.zh}>{style.description.zh}</span></div>
            {style.styleId === selection.styleId ? <span className="inline-status online">当前风格</span>
              : manageable && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => prepare(style), 'style')}>使用此风格</button>}
          </div>)}
        </div>
        {!gallery.total && <p className="connection-caption">暂无可用风格</p>}
        {gallery.canExpand && <div className="instance-actions"><button className="btn btn-ghost btn-sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : `显示全部 ${gallery.total} 个风格`}</button></div>}
      </>}
      {error && <div className="auth-dialog-alert" role="alert">{error}<button className="btn btn-ghost btn-sm" disabled={busy || loading} onClick={() => void load()}>刷新状态</button></div>}
    </div>
    {deleting && <ConfirmModal title="删除 fal.ai 配置？" description={`删除后不再生成新头像，已有头像保留${error ? `。${error}` : ''}`} confirmLabel="删除" destructive busy={busy} onCancel={() => setDeleting(false)} onConfirm={() => void run(async () => {
      if (!admin || fal?.source === 'env') return
      await apiInstanceFalDelete(space)
      if (!current()) return
      installFal({ configured: false, source: 'none' }); setDeleting(false); toast('fal.ai 配置已删除')
      installFal(await apiInstanceFal(space))
    }, 'fal')} />}
    {image && imageUrl && <FocusTrapDialog className="modal-layer above-sheet" label={image.name.zh} onEscape={() => setImage(null)} closeOnBackdrop>
      <div className="modal-card avatar-style-preview">
        <div className="modal-head"><h2>{image.name.zh}</h2><button className="ico-btn" aria-label="关闭预览" onClick={() => setImage(null)}><Icon name="x" size={16} /></button></div>
        <p className="connection-caption">{image.name.en}</p>
        <StyleImage style={image} onUnavailable={() => setImage(null)} />
        <p className="modal-copy">{image.description.zh}</p>
        <p className="connection-caption">授权：{image.preview.license}</p><p className="connection-caption">署名：{image.preview.attribution}</p>
      </div>
    </FocusTrapDialog>}
    {preview && <FocusTrapDialog className="modal-layer above-sheet" label={`将头像切换到「${preview.style.name.zh}」？`} onEscape={() => setPreview(null)} escapeDisabled={busy} closeOnBackdrop>
      <div className="modal-card compact avatar-style-confirmation">
        <div className="modal-head"><div><span className="eyebrow">Skill 头像</span><h2>将头像切换到「{preview.style.name.zh}」？</h2>
          <p className="connection-caption">{preview.value.scope === 'instance' ? '按整台服务器统计' : '只影响你自己的 Skill'}</p>
        </div><button className="ico-btn" aria-label="关闭确认对话框" disabled={busy} onClick={() => setPreview(null)}><Icon name="x" size={16} /></button></div>
        <div className="selection-box compact">{styleConfirmation(preview.value).map(row => <Fragment key={row.label}><b>{row.label}</b><span>{row.value}</span></Fragment>)}</div>
        {preview.value.customSkipped > 0 && <label className="avatar-style-custom"><input type="checkbox" checked={includeCustom} disabled={busy} onChange={event => setIncludeCustom(event.target.checked)} />同时替换自定义头像</label>}
        {includeCustom && preview.value.customSkipped > 0 && <p className="connection-caption">上方估算不含自定义头像；替换可能增加生成数量和费用，超出额度的部分不会排队。</p>}
        {error && <p className="auth-dialog-alert" role="alert">{error}</p>}
        <div className="modal-actions">
          {!configured && <div className="banner banner-warn" role="status">配置 fal.ai 后才能为现有 Skill 生成新头像</div>}
          {preview.value.needsGeneration > preview.value.coverable && <div className="banner banner-warn" role="status">超出额度的部分不会排队</div>}
          <button className="btn btn-ghost" disabled={busy} onClick={() => setPreview(null)}>取消</button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => apply('newOnly'), 'style')}>仅用于新头像</button>
          <button className="btn btn-primary" disabled={busy || !configured} onClick={() => void run(() => apply('applyExisting'), 'style')}>应用到现有</button>
        </div>
      </div>
    </FocusTrapDialog>}
  </>
}
