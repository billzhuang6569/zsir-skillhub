import { useEffect, useRef, useState } from 'react'
import DocHelp from '../components/DocHelp.js'
import { apiInstanceOverview, apiInstanceMembers, apiInstanceRole, apiInstanceRegistration, apiInstanceInvite,
  type InstanceOverview, type InstanceMember, type InstanceRegistration, type InstanceDirectory } from '../lib/api.js'
import type { SpaceHandle } from '../lib/tauri.js'
import { instanceError, lastAdministrator, instanceIsLoopback } from '../lib/instance-settings.js'
import { useStore } from '../store/index.js'
import { SegmentedControl } from '../components/SegmentedControl.js'
import ConfirmModal from '../components/ConfirmModal.js'
import { PageHeading } from '../components/PageHeading.js'
import { Icon } from '../components/Icon.js'
import { toast } from '../components/Toast.js'
import '../components/InstanceSettings.css'

function storageSize(value: InstanceDirectory): string {
  return `${value.complete ? '' : '至少 '}${(value.bytes / 1024 / 1024).toFixed(2)} MB${value.complete ? '' : '（统计未完成）'}`
}
export default function InstanceSettingsPage({ space, onBack }: { space: SpaceHandle; onBack: () => void }) {
  const user = useStore(state => state.currentUser)
  const [overview, setOverview] = useState<InstanceOverview | null>(null)
  const [members, setMembers] = useState<InstanceMember[]>([])
  const [registration, setRegistration] = useState<InstanceRegistration | null>(null)
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const [changingInvite, setChangingInvite] = useState(false)
  const [target, setTarget] = useState<InstanceMember | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const load = async (): Promise<void> => {
    setError(''); setBusy(true)
    try {
      const value = await apiInstanceOverview(space)
      const all: InstanceMember[] = []
      let total = Infinity
      while (all.length < total) {
        if (!mounted.current) return
        const page = await apiInstanceMembers(all.length, space)
        all.push(...page.members); total = page.total
        if (!page.members.length) break
      }
      if (mounted.current) { setOverview(value); setMembers(all); setRegistration(value.registration) }
    } catch (failure: unknown) { if (mounted.current) setError(instanceError(failure)) }
    finally { if (mounted.current) setBusy(false) }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false } }, [])
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (failure: unknown) { if (mounted.current) setError(instanceError(failure)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const setMode = async (mode: InstanceRegistration['mode']): Promise<void> => {
    const value = await apiInstanceRegistration(mode, space)
    if (mounted.current) { setRegistration(value); setInviteCode(null) }
  }
  return <>
    <PageHeading title="实例管理" beforeTitle={<a className="instance-back-link" href="#settings" onClick={event => { event.preventDefault(); onBack() }}><Icon name="left" size={16} />返回设置</a>} />
    <div className="page-body settings-page instance-page">
      <p className="connection-caption">只有实例管理员能看到这一页。存储、证书等运维项在这里查看状态，修改在服务器配置中完成。</p>
      {error && <p role="alert" className="inline-status offline">{error}</p>}
      {busy && <p role="status" className="inline-status checking">处理中…</p>}
      {!overview && !busy && <button className="btn btn-ghost" onClick={() => void load()}>重新加载</button>}
      {overview && <>
        <p className="settings-label">成员</p>
        <section className="settings-group">
          <div className="instance-table-scroll"><table className="instance-table"><thead><tr><th scope="col">成员</th><th scope="col">角色</th><th scope="col">加入时间</th><th scope="col">操作</th></tr></thead><tbody>
            {members.map(member => <tr key={member.id}><td><b>{member.displayName}</b>{member.id === user?.id && <span className="chip">你</span>}<span className="connection-caption">{member.email}</span></td>
              <td><span className={`chip${member.role === 'admin' ? ' chip-accent' : ''}`}>{member.role === 'admin' ? '管理员' : '成员'}</span></td>
              <td>{new Date(member.createdAt).toLocaleDateString('zh-CN')}</td><td><button type="button" className="btn btn-ghost btn-sm" disabled={busy || lastAdministrator(member, members)} onClick={() => setTarget(member)}>{member.role === 'admin' ? '设为成员' : '设为管理员'}</button>
                {lastAdministrator(member, members) && <span className="connection-caption">至少保留一名管理员</span>}</td></tr>)}
          </tbody></table></div>
          <p className="connection-caption">成员忘记密码时，在服务器上运行 <code className="mono">npm run admin -- reset-password --email 成员邮箱</code>，新密码只显示一次。</p>
        </section>
        <p className="settings-label">注册与邀请</p>
        {registration && <section className="settings-group instance-panel">
          <div className="settings-row-info"><b>注册方式</b><span>邀请码注册时，只有拿到邀请码的人能注册账号。</span></div>
          <SegmentedControl mode="radiogroup" aria-label="注册方式" value={registration.mode} options={[
            { value: 'invite' as const, label: '邀请码' }, { value: 'closed' as const, label: '关闭注册' },
            ...(registration.mode === 'open' ? [{ value: 'open' as const, label: '开放注册' }] : []),
          ].map(option => ({ ...option, disabled: busy || registration.source === 'env' }))} onChange={mode => void run(() => setMode(mode))} />
          {registration.source === 'env' && <p className="connection-caption">由服务器环境变量配置，修改请编辑服务器配置</p>}
          <div className="instance-actions"><b>当前邀请码</b><code>{inviteCode ?? registration.inviteCodeMask ?? '未设置'}</code>
            {inviteCode && <button type="button" className="btn btn-ghost" onClick={() => void run(async () => { await navigator.clipboard.writeText(inviteCode); if (mounted.current) toast('邀请码已复制') })}>复制</button>}
            {registration.source !== 'env' && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setChangingInvite(true)}>换一个</button>}</div>
          {inviteCode && <p className="connection-caption">新邀请码仅本次显示，请及时复制。旧邀请码已失效。</p>}
        </section>}
        <p className="settings-label">地址与证书</p>
        <section className="settings-group">{[overview.addresses.primary, ...overview.addresses.additional].map((address, index) => {
          const loopback = instanceIsLoopback(address.baseUrl)
          return <div key={address.baseUrl}><div className="settings-row"><b>{index ? '附加地址' : '对外地址'}</b><code>{address.baseUrl}</code></div>
            <div className="settings-row"><b>部署位置</b><span>{loopback ? '这台电脑。其他人无法访问，要邀请成员请部署到服务器。' : '服务器'}</span></div>
            <div className="settings-row"><b>证书</b><span>{loopback ? '本机地址不需要证书' : address.https ? !address.certificate || address.certificate === 'reverse_proxy' ? '由反向代理提供' : address.certificate : '未启用 HTTPS'}</span></div></div>
        })}</section>
        <p className="settings-label">存储 <DocHelp topic="storage" variant="section" label="存储说明" /> <DocHelp topic="backup" label="备份与恢复" /></p><section className="settings-group">
          <div className="settings-row"><b>存储方式</b><span>{overview.storage.provider === 'builtin' ? '本地目录' : overview.storage.provider}</span></div>
          <div className="settings-row"><b>已用空间</b><span>媒体 {storageSize(overview.storage.media)} · Skill 名片 {storageSize(overview.storage.cards)}</span></div>
        </section>
        <p className="settings-label">今日用量</p><section className="settings-group"><div className="settings-row"><b>AI 分析</b><span>{overview.aiUsage.used} / {overview.aiUsage.limit} 次</span></div><p className="connection-caption">按 UTC 日期统计，包含进行中批次的预留次数。</p></section>
        <p className="settings-label">版本</p><section className="settings-group">
          <div className="settings-row"><b>Server 版本</b><span>{overview.version.server}</span></div>
          <div className="settings-row"><div className="settings-row-info"><b>APP 最低版本</b><span>低于这个版本的 APP 连接时会提示升级</span></div><span>{overview.minClientVersion ?? '未设置'}</span></div>
        </section>
      </>}
    </div>
    {changingInvite && <ConfirmModal title="换一个邀请码？" description="旧邀请码会立即失效，已经发出但还没用的邀请码将无法注册。" confirmLabel="换一个" busy={busy} onCancel={() => setChangingInvite(false)} onConfirm={() => void run(async () => {
      setInviteCode(null)
      const { inviteCode: generated, ...value } = await apiInstanceInvite(space)
      if (mounted.current) { setRegistration(value); setInviteCode(generated); setChangingInvite(false) }
    })} />}
    {target && <ConfirmModal title={target.role === 'admin' ? '设为成员？' : '设为管理员？'} description={`确认修改 ${target.displayName}（${target.email}）的实例角色？${target.id === user?.id ? '降级后你将无法访问实例管理。' : '管理员可以修改实例配置与成员角色。'}`} confirmLabel="确认修改" busy={busy} onCancel={() => setTarget(null)} onConfirm={() => void run(async () => {
      const value = await apiInstanceRole(target.id, target.role === 'admin' ? 'member' : 'admin', space)
      if (!mounted.current) return
      setMembers(previous => previous.map(member => member.id === value.id ? value : member)); setTarget(null)
      if (value.id === user?.id && value.role !== 'admin') {
        useStore.getState().updateCurrentUser({ ...user, marketplaceRole: 'user' }); onBack()
      }
    })} />}
  </>
}
