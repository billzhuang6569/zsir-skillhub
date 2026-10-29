import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useStore } from '../store/index.js'
import type { SkillFileDiff, SkillTreeEntry } from '../lib/tauri.js'
import { buildReviewTree, diffRowsWithHunkSeparators } from '../lib/file-diff-review.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import { Icon } from './Icon.js'
import './FileDiffReview.css'

type FileDiffReviewProps = {
  title: string
  eyebrow: string
  files: SkillFileDiff[]
  tree: SkillTreeEntry[]
  summary: ReactNode
  form: ReactNode
  notices?: ReactNode
  busy: boolean
  submitDisabled: boolean
  submitLabel: string
  onBack: () => void
  onCancel: () => void
  onSubmit: () => void
}

function statusLabel(status: SkillFileDiff['status']): string {
  return status === 'added' ? '新增' : status === 'deleted' ? '已删除' : '已修改'
}

export default function FileDiffReview({ title, eyebrow, files: fileDiffs, tree, summary, form, notices, busy, submitDisabled, submitLabel, onBack, onCancel, onSubmit }: FileDiffReviewProps) {
  const sidebarWidth = useStore(state => state.sidebarWidth)
  const [onlyChanged, setOnlyChanged] = useState(false)
  const reviewTree = useMemo(() => buildReviewTree(tree, fileDiffs), [tree, fileDiffs])
  const firstChangedPath = reviewTree.find(entry => entry.kind === 'file' && entry.status)?.path ?? ''
  const [selectedPath, setSelectedPath] = useState(firstChangedPath)
  const visibleTree = reviewTree.filter(entry => !onlyChanged || entry.status)
  const selectedDiff = fileDiffs.find(file => file.path === selectedPath)
  const selectedRows = useMemo(() => selectedDiff ? diffRowsWithHunkSeparators(selectedDiff.lines) : [], [selectedDiff])
  useEffect(() => {
    if (!visibleTree.some(entry => entry.kind === 'file' && entry.path === selectedPath)) setSelectedPath(firstChangedPath)
  }, [firstChangedPath, visibleTree, selectedPath])

  return <FocusTrapDialog className="modal-layer above-sheet team-review-layer" style={{ left: `${sidebarWidth}px` }} label={title} onEscape={onBack} escapeDisabled={busy}>
    <div className="team-review-screen">
      <header className="team-review-header">
        <div className="team-review-heading"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>
        <button type="button" className="ico-btn" aria-label="返回确认" title="返回确认" disabled={busy} onClick={onBack}><Icon name="x" size={16} /></button>
        <div className="team-review-summary">{summary}</div>
      </header>
      <div className="team-review-workspace">
        <aside className="skill-tree-panel team-review-tree" aria-label="Skill 文件结构">
          <select className="team-review-file-select" value={selectedPath} onChange={event => setSelectedPath(event.target.value)} aria-label="选择变化文件">{visibleTree.filter(entry => entry.kind === 'file').map(entry => <option key={entry.path} value={entry.path}>{entry.path}{entry.status ? ` · ${statusLabel(entry.status)}` : ''}</option>)}</select>
          <div className="details-panel-head"><div><h3>文件结构</h3><p>{fileDiffs.length} 个文件有变化</p></div><label className="team-review-filter"><input type="checkbox" checked={onlyChanged} onChange={event => setOnlyChanged(event.target.checked)} />只看有变化的文件</label></div>
          <ul className="skill-tree-list">{visibleTree.map(entry => {
            const change = fileDiffs.find(file => file.path === entry.path)
            const status = change?.status ?? entry.status
            return <li key={entry.path} className={entry.path === selectedPath ? 'active' : ''} style={{ paddingLeft: `${10 + entry.depth * 14}px` }} title={entry.path}>
              {entry.kind === 'directory' ? <><Icon name="folder" size={12} /><span>{entry.name}</span>{status && <i className={`team-review-dot ${status}`} aria-label="目录中有变化" />}</> : <button type="button" className={`skill-tree-file${status === 'deleted' ? ' deleted' : ''}`} aria-label={`${entry.path}${status ? ` · ${statusLabel(status)}` : ''}`} aria-current={entry.path === selectedPath ? 'true' : undefined} onClick={() => setSelectedPath(entry.path)}><Icon name="doc" size={12} /><span>{entry.name}</span>{status && <i className={`team-review-dot ${status}`} aria-hidden="true" />}{(status === 'added' || status === 'deleted') && <b className={`team-review-mark ${status}`}>{status === 'added' ? '+' : '−'}</b>}</button>}
            </li>
          })}</ul>
        </aside>
        <section className="skill-document-panel team-review-diff" aria-label={selectedPath ? `${selectedPath} 差异` : '文件差异'}>
          {selectedDiff ? <><div className="details-panel-head"><div><h3 className="mono">{selectedDiff.path}</h3><p><span className={`chip ${selectedDiff.status === 'added' ? 'chip-ok' : selectedDiff.status === 'deleted' ? 'chip-danger' : 'chip-warn'}`}>{statusLabel(selectedDiff.status)}</span></p></div></div>
            {selectedDiff.binary ? <div className="compact-empty">这是二进制文件，无法显示逐行差异。</div> : selectedDiff.tooLarge ? <div className="compact-empty">此文件超过审阅显示限额，已省略全文（单文件 2000 行；本次总量 20000 行或 2 MB）。</div> : selectedDiff.lines.length === 0 ? <div className="compact-empty">没有可显示的逐行差异（空文件或仅权限变化）</div> : <pre className="team-review-lines">{selectedRows.map((row, index) => row.type === 'gap'
              ? <span key={`gap-${index}`} className="team-review-gap">⋯ 跳过 {row.skipped} 行未变化内容</span>
              : <span key={`${row.line.oldLine}-${row.line.newLine}-${index}`} className={`team-review-line ${row.line.kind}`}><i>{row.line.oldLine ?? ''}</i><i>{row.line.newLine ?? ''}</i><code>{row.line.kind === 'add' ? '+' : row.line.kind === 'del' ? '−' : ' '}{row.line.content}</code></span>)}</pre>}
          </> : <div className="compact-empty">{selectedPath ? '此文件没有变化。' : '没有有变化的文件。'}</div>}
        </section>
      </div>
      <footer className="team-review-footer">
        {form}
        <div className="team-review-actions">{notices}<div className="modal-actions">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>取消</button>
          <button type="button" className="btn btn-primary" disabled={busy || submitDisabled} onClick={onSubmit}>{busy ? '处理中…' : submitLabel}</button>
        </div></div>
      </footer>
    </div>
  </FocusTrapDialog>
}
