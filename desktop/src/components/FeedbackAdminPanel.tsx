import { userMessage } from '../lib/user-message.js'
import { useCallback, useEffect, useState } from 'react'
import { apiGetFeedback, apiUpdateFeedbackStatus, type ApiFeedback, type FeedbackStatus } from '../lib/api.js'
import { Icon } from './Icon.js'
import { toast } from './Toast.js'
import './FeedbackAdminPanel.css'

const TYPE_LABELS: Record<ApiFeedback['type'], string> = { bug: 'Bug', usage: '使用问题', feature: '功能建议', other: '其他' }
const STATUS_LABELS: Record<FeedbackStatus, string> = { pending: '待处理', reviewing: '处理中', resolved: '已解决' }

function messageOf(error: unknown): string { return userMessage(error) }

export default function FeedbackAdminPanel() {
  const [filter, setFilter] = useState<FeedbackStatus | 'all'>('all')
  const [items, setItems] = useState<ApiFeedback[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try { setItems(await apiGetFeedback(filter === 'all' ? undefined : filter)) }
    catch (reason: unknown) { setError(messageOf(reason)) }
    finally { setLoading(false) }
  }, [filter])

  useEffect(() => { void load() }, [load])

  const changeStatus = async (item: ApiFeedback, status: FeedbackStatus): Promise<void> => {
    if (busyId || item.status === status) return
    setBusyId(item.id)
    try {
      const updated = await apiUpdateFeedbackStatus(item.id, status)
      setItems((current) => filter !== 'all' && status !== filter
        ? current.filter((entry) => entry.id !== item.id)
        : current.map((entry) => entry.id === item.id ? { ...entry, ...updated } : entry))
      toast('反馈状态已更新')
    } catch (reason: unknown) {
      toast(`无法更新反馈：${messageOf(reason)}`, 'error')
    } finally {
      setBusyId(null)
    }
  }

  return <section className="settings-group feedback-admin" aria-busy={loading}>
    <div className="feedback-admin-head">
      <div><b>用户反馈</b><span>最近 100 条提交，仅管理员可见。</span></div>
      <div><select aria-label="筛选反馈状态" value={filter} onChange={(event) => setFilter(event.target.value as FeedbackStatus | 'all')}><option value="all">全部状态</option><option value="pending">待处理</option><option value="reviewing">处理中</option><option value="resolved">已解决</option></select><button type="button" className="ico-btn" disabled={loading} onClick={() => void load()} aria-label="刷新反馈"><Icon name="refresh" size={14} /></button></div>
    </div>
    {loading ? <div className="feedback-admin-loading"><span className="spin-icon" />正在读取反馈…</div>
      : error ? <div className="trash-error" role="alert"><span>{error}</span><button className="btn btn-ghost" onClick={() => void load()}>重试</button></div>
        : items.length === 0 ? <div className="feedback-admin-empty">当前筛选下没有反馈。</div>
          : <div className="feedback-admin-list">{items.map((item) => <article key={item.id} className="feedback-admin-item">
            <div className="feedback-admin-meta"><span className={`feedback-type ${item.type}`}>{TYPE_LABELS[item.type]}</span><span>{item.user?.displayName ?? '游客'}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN')}</time></div>
            <p>{item.content}</p>
            <div className="feedback-admin-foot"><span>{item.contact ? `联系方式：${item.contact}` : item.user?.email ? `账号：${item.user.email}` : '未留联系方式'}</span><select aria-label={`更新 ${TYPE_LABELS[item.type]} 反馈状态`} disabled={busyId !== null} value={item.status} onChange={(event) => void changeStatus(item, event.target.value as FeedbackStatus)}>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          </article>)}</div>}
  </section>
}
