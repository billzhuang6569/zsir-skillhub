import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useStore, type LocalSkill } from '../store/index.js'
import {
  addQuickAccess, canonicalTagName, deleteTag, groupSkillsByTag, isInQuickAccess, normalizeTagName, removeQuickAccess,
  renameTag, setTagCollapsed, tagKey, type TagGroup,
} from '../lib/skill-organizer.js'
import { nextRovingIndex } from '../lib/ui-helpers.js'
import type { EnvKeySummary } from '../lib/skill-library.js'
import SkillLibraryList from './SkillLibraryList.js'
import ConfirmModal from './ConfirmModal.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import { Icon } from './Icon.js'
import { toast } from './Toast.js'
import { isImeKey } from './SkillTagPopover.js'
import './SkillTags.css'

type Props = {
  /** Every Skill of the account (the cloud tab's source), for the tag list. */
  allSkills: LocalSkill[]
  /** The filtered, ordered Skills to place into groups. */
  skills: LocalSkill[]
  filtering: boolean
  selectionResetKey: string
  onBatch: (skills: LocalSkill[], action: 'share' | 'delete') => void
  envKeysBySkill: Record<string, EnvKeySummary>
  envPolicyErrorBySkill: Record<string, true>
}

type GroupMenu = { name: string; x: number; y: number; trigger: HTMLElement | null }

/**
 * 「我的 Skills · 标签」 (#324): every Skill grouped by its private tags in
 * collapsible groups; a Skill with several tags shows in each, and 【无标签】
 * is always last. Collapse state lives in the account's organizer file.
 */
export default function SkillTagGroups({ allSkills, skills, filtering, selectionResetKey, onBatch, envKeysBySkill, envPolicyErrorBySkill }: Props) {
  const organizer = useStore((state) => state.organizer)
  const mutateOrganizer = useStore((state) => state.mutateOrganizer)
  const currentUserId = useStore((state) => state.currentUser?.id ?? null)
  const tagGroupFocus = useStore((state) => state.tagGroupFocus)
  const clearTagGroupFocus = useStore((state) => state.clearTagGroupFocus)
  const [untaggedCollapsed, setUntaggedCollapsed] = useState(false)
  const [menu, setMenu] = useState<GroupMenu | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  // Only one group holds a selection at a time: interacting with a group resets
  // the others, so the highlighted rows always match what batch actions use.
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const headerRefs = useRef(new Map<string, HTMLButtonElement>())
  const { groups, untagged } = useMemo(
    () => groupSkillsByTag(organizer, allSkills, skills, currentUserId, filtering),
    [organizer, allSkills, skills, currentUserId, filtering],
  )
  const collapsed = new Set(organizer.collapsedTags)

  // Reveal a group requested through `openTagGroup` (sidebar quick access, #325).
  useEffect(() => {
    if (!tagGroupFocus) return
    const header = headerRefs.current.get(tagGroupFocus.key)
    // A tag that no longer exists (or is filtered out) just leaves the page at the top.
    if (!header) {
      clearTagGroupFocus(tagGroupFocus.nonce)
      if (filtering) toast('这个目录在当前筛选下没有 Skill，清除筛选后可查看')
      return
    }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    header.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
    header.focus({ preventScroll: true })
    clearTagGroupFocus(tagGroupFocus.nonce)
  }, [clearTagGroupFocus, filtering, tagGroupFocus])

  const toggle = (group: TagGroup<LocalSkill>): void => {
    const problem = mutateOrganizer(state => setTagCollapsed(state, group.name, !collapsed.has(group.key)))
    if (problem) toast(problem, 'error')
  }

  const openMenu = (name: string, x: number, y: number, trigger: HTMLElement | null): void => setMenu({ name, x, y, trigger })

  const quickAccess = (name: string): void => {
    const item = { kind: 'tag' as const, ref: name }
    const inside = isInQuickAccess(organizer, item)
    const problem = mutateOrganizer(state => inside ? removeQuickAccess(state, item) : addQuickAccess(state, item))
    if (problem) toast(problem, 'error')
    else toast(inside ? `已将「${name}」移出快捷访问` : `已将「${name}」加入快捷访问`)
  }

  const renderGroup = (group: TagGroup<LocalSkill> | null): ReactElement => {
    const key = group?.key ?? ''
    const name = group?.name ?? '无目录'
    const list = group ? group.skills : untagged
    const isCollapsed = group ? collapsed.has(group.key) : untaggedCollapsed
    const groupId = group ? `tag:${key}` : 'untagged'
    const panelId = `skill-tag-group-${group ? encodeURIComponent(group.key).replace(/%/g, '_') : 'untagged'}`
    return <section key={group ? `tag:${key}` : 'untagged'} className={`skill-tag-group${isCollapsed ? ' collapsed' : ''}${group ? '' : ' untagged'}`} aria-label={group ? `目录「${name}」` : '无目录'}>
      <div
        className="skill-tag-group-head"
        onContextMenu={group ? (event) => { event.preventDefault(); openMenu(group.name, event.clientX, event.clientY, headerRefs.current.get(group.key) ?? null) } : undefined}
      >
        <button
          ref={(element) => { if (!group) return; if (element) headerRefs.current.set(group.key, element); else headerRefs.current.delete(group.key) }}
          type="button"
          className="skill-tag-group-toggle"
          aria-expanded={!isCollapsed}
          aria-controls={panelId}
          onClick={() => group ? toggle(group) : setUntaggedCollapsed(value => !value)}
          onKeyDown={(event) => {
            if (group && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
              event.preventDefault()
              const rect = event.currentTarget.getBoundingClientRect()
              openMenu(group.name, rect.left + 24, rect.bottom, event.currentTarget)
            }
          }}
        >
          <Icon name="chev" size={14} className="skill-tag-group-chevron" />
          {group ? <Icon name="tag" size={14} /> : null}
          <span className="skill-tag-group-name">{group ? name : '【无目录】'}</span>
          <span className="skill-tag-group-count" aria-label={`${list.length} 个 Skill`}>{list.length}</span>
        </button>
        {group && <button
          type="button"
          className="ico-btn skill-tag-group-more"
          aria-label={`目录「${name}」更多操作`}
          aria-haspopup="menu"
          aria-expanded={menu?.name === group.name}
          onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openMenu(group.name, rect.right - 218, rect.bottom + 4, event.currentTarget) }}
        ><Icon name="more" size={15} /></button>}
      </div>
      {!isCollapsed && <div id={panelId} className="skill-tag-group-body" onPointerDownCapture={() => setActiveGroup(groupId)} onFocusCapture={() => setActiveGroup(groupId)}>
        {list.length > 0
          ? <SkillLibraryList skills={list} selectionResetKey={`${selectionResetKey}:${groupId}:${activeGroup === groupId ? '' : activeGroup ?? ''}`} onBatch={onBatch} envKeysBySkill={envKeysBySkill} envPolicyErrorBySkill={envPolicyErrorBySkill} />
          : <p className="skill-tag-group-empty">{group ? '这个目录下没有 Skill。' : groups.length === 0 ? '还没有目录。在 Skill 上右键选择「加入目录…」，或在详情的「目录」中添加，就能在这里按目录归类。' : '所有 Skill 都已在目录中。'}</p>}
      </div>}
    </section>
  }

  return <div className="skill-tag-groups">
    {groups.map(group => renderGroup(group))}
    {(untagged.length > 0 || !filtering || groups.length === 0) && renderGroup(null)}
    {menu && <TagGroupMenu
      menu={menu}
      inQuickAccess={isInQuickAccess(organizer, { kind: 'tag', ref: menu.name })}
      onClose={(restore) => { const trigger = menu.trigger; setMenu(null); if (restore) trigger?.focus() }}
      onRename={() => { setRenaming(menu.name); setMenu(null) }}
      onDelete={() => { setDeleting(menu.name); setMenu(null) }}
      onQuickAccess={() => { quickAccess(menu.name); setMenu(null) }}
    />}
    {renaming && <RenameTagDialog
      name={renaming}
      onClose={() => { const name = renaming; setRenaming(null); headerRefs.current.get(tagKey(name))?.focus() }}
      onRenamed={(target) => { setRenaming(null); requestAnimationFrame(() => headerRefs.current.get(tagKey(target))?.focus()) }}
    />}
    {deleting && <ConfirmModal
      eyebrow="删除目录"
      title={`删除目录「${deleting}」？`}
      description="只解除所有 Skill 与这个目录的关系，Skill 本身和其他目录都会保留；快捷访问中的这个目录也会一并移除。"
      confirmLabel="删除目录"
      destructive
      onCancel={() => { const name = deleting; setDeleting(null); headerRefs.current.get(tagKey(name))?.focus() }}
      onConfirm={() => {
        const problem = mutateOrganizer(state => deleteTag(state, deleting))
        if (problem) { toast(problem, 'error'); return }
        toast(`已删除目录「${deleting}」`)
        setDeleting(null)
      }}
    />}
  </div>
}

function TagGroupMenu({ menu, inQuickAccess, onClose, onRename, onDelete, onQuickAccess }: {
  menu: GroupMenu
  inQuickAccess: boolean
  onClose: (restoreFocus: boolean) => void
  onRename: () => void
  onDelete: () => void
  onQuickAccess: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`
    element.querySelector<HTMLButtonElement>('button')?.focus()
  }, [menu.x, menu.y])
  useEffect(() => {
    const close = (): void => closeRef.current(false)
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopImmediatePropagation(); closeRef.current(true) } }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    window.addEventListener('blur', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [])
  return createPortal(<div
    ref={ref}
    className="skill-context-menu"
    data-skill-context-menu
    role="menu"
    aria-label={`目录「${menu.name}」操作`}
    style={{ left: menu.x, top: menu.y }}
    onPointerDown={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      if (event.key === 'Tab') { event.preventDefault(); onClose(true); return }
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      const next = nextRovingIndex(buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length, event.key, 'vertical')
      if (next !== null) { event.preventDefault(); buttons[next]?.focus() }
    }}
  >
    <button type="button" role="menuitem" onClick={onRename}><Icon name="pencil" size={14} /><span>重命名</span></button>
    <button type="button" role="menuitem" onClick={onQuickAccess}><Icon name="star" size={14} /><span>{inQuickAccess ? '移出快捷访问' : '加入快捷访问'}</span></button>
    <button type="button" role="menuitem" onClick={onDelete}><Icon name="trash" size={14} /><span>删除目录</span></button>
  </div>, document.body)
}

function RenameTagDialog({ name, onClose, onRenamed }: { name: string; onClose: () => void; onRenamed: (target: string) => void }) {
  const organizer = useStore((state) => state.organizer)
  const mutateOrganizer = useStore((state) => state.mutateOrganizer)
  const [draft, setDraft] = useState(name)
  const [error, setError] = useState<string | null>(null)
  const normalized = normalizeTagName(draft)
  const existing = normalized.ok && tagKey(normalized.name) !== tagKey(name) ? canonicalTagName(organizer, normalized.name) : undefined
  const unchanged = normalized.ok && normalized.name === name
  const submit = (): void => {
    if (!normalized.ok) { setError(normalized.error); return }
    if (unchanged) { onClose(); return }
    const problem = mutateOrganizer(state => renameTag(state, name, normalized.name))
    if (problem) { setError(problem); return }
    const target = existing ?? normalized.name
    toast(existing ? `已合并到目录「${existing}」` : `已重命名为「${target}」`)
    onRenamed(target)
  }
  return <FocusTrapDialog className="modal-layer above-sheet" label={`重命名目录「${name}」`} onEscape={onClose}>
    <form className="modal-card compact" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <div className="modal-head"><div><span className="eyebrow">重命名目录</span><h2>「{name}」</h2></div><button type="button" className="ico-btn" onClick={onClose} aria-label="关闭重命名"><Icon name="x" size={16} /></button></div>
      <div className="form-stack">
        <label>新名称<input
          autoFocus
          value={draft}
          maxLength={64}
          aria-invalid={error ? true : undefined}
          aria-describedby="rename-tag-note"
          onChange={(event) => { setDraft(event.target.value); setError(null) }}
          onFocus={(event) => event.currentTarget.select()}
          // Enter that confirms an IME candidate must not submit the rename (WKWebView, #343 review).
          onKeyDown={(event) => { if (event.key === 'Enter' && isImeKey(event)) event.preventDefault() }}
        /></label>
        <p id="rename-tag-note" className={error ? 'skill-tag-popover-error' : 'skill-tag-rename-note'} role={error ? 'alert' : undefined}>
          {error ?? (existing ? `已有目录「${existing}」，确认后会合并到该目录。` : '这个目录里的所有 Skill 都会一起更新。')}
        </p>
      </div>
      <div className="modal-actions"><button type="button" className="btn btn-ghost" onClick={onClose}>取消</button><button type="submit" className="btn btn-primary" disabled={!draft.trim()}>{existing ? '合并' : '重命名'}</button></div>
    </form>
  </FocusTrapDialog>
}
