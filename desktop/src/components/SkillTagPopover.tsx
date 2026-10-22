import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useStore, type LocalSkill } from '../store/index.js'
import {
  addQuickAccess, allTags, canonicalTagName, isInQuickAccess, removeQuickAccess, normalizeTagName, skillOrganizerKey, tagCoverage, tagKey, tagsForSkill, toggleTagOnSkills,
  TAGS_PER_SKILL_MAX,
} from '../lib/skill-organizer.js'
import { Icon } from './Icon.js'
import { toast } from './Toast.js'
import './SkillTags.css'

type Props = {
  skills: readonly LocalSkill[]
  /** Viewport point the panel opens at (clamped into the window). */
  anchor: { x: number; y: number }
  onClose: () => void
  /** Focus goes back here when the panel closes. */
  returnFocus?: HTMLElement | null
}

/**
 * 「加入目录…」 (#323, EPIC #321 decision; product wording 目录 since #355): one small panel, no wizard. Typing
 * filters the account's tags; Enter checks a matching tag or creates a new one.
 * Each checkbox applies to every selected Skill; a tag only some of them carry
 * shows as indeterminate. Escape or a click outside closes it.
 */
/** Key events that belong to an active IME composition (WKWebView reports keyCode 229 after ending it). */
export function isImeKey(event: { nativeEvent: KeyboardEvent; keyCode: number }): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229
}

export default function SkillTagPopover({ skills, anchor, onClose, returnFocus }: Props) {
  const organizer = useStore((state) => state.organizer)
  const mutateOrganizer = useStore((state) => state.mutateOrganizer)
  const currentUserId = useStore((state) => state.currentUser?.id ?? null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const skillKeys = useMemo(() => skills.map(skill => skillOrganizerKey(skill, currentUserId)), [currentUserId, skills])
  const coverage = tagCoverage(organizer, skillKeys)
  const tags = allTags(organizer)
  const query = draft.trim() ? tagKey(draft) : ''
  const visibleTags = query ? tags.filter(tag => tag.key.includes(query)) : tags
  const exact = query ? tags.find(tag => tag.key === query) : undefined
  const returnFocusRef = useRef(returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const close = (): void => {
    closeRef.current()
    const target = returnFocusRef.current
    if (target?.isConnected) target.focus()
  }

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    panel.style.left = `${Math.max(8, Math.min(anchor.x, window.innerWidth - rect.width - 8))}px`
    panel.style.top = `${Math.max(8, Math.min(anchor.y, window.innerHeight - rect.height - 8))}px`
    inputRef.current?.focus()
  }, [anchor.x, anchor.y])

  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (panelRef.current && event.target instanceof Node && !panelRef.current.contains(event.target)) closeRef.current()
    }
    const blur = (): void => closeRef.current()
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', blur)
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', blur) }
  }, [])

  const apply = (name: string, checked: boolean): boolean => {
    const problem = mutateOrganizer(state => toggleTagOnSkills(state, skillKeys, name, checked))
    setError(problem)
    return !problem
  }

  const submitDraft = (): void => {
    const normalized = normalizeTagName(draft)
    if (!normalized.ok) { setError(normalized.error); return }
    const existing = canonicalTagName(organizer, normalized.name)
    // Enter on an existing tag checks it for every selected Skill; it never unchecks.
    if (apply(existing ?? normalized.name, true)) setDraft('')
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Enter/Escape that confirm or cancel an IME composition (Pinyin, kana) belong to the IME.
    if (isImeKey(event)) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Tab') {
      const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)'))
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const boxes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input'))
      const index = boxes.indexOf(document.activeElement as HTMLElement)
      const next = event.key === 'ArrowDown' ? Math.min(boxes.length - 1, index + 1) : Math.max(0, index - 1)
      if (boxes[next]) { event.preventDefault(); boxes[next].focus() }
    }
  }

  const multiple = skills.length > 1
  return createPortal(<div
    ref={panelRef}
    className="skill-tag-popover"
    role="dialog"
    aria-modal="false"
    // An enclosing FocusTrapDialog (overlay Skill sheet) leaves focus, Tab and Escape to this popover.
    data-nested-popover
    aria-label={multiple ? `为 ${skills.length} 个 Skill 设置目录` : '设置目录'}
    data-skill-context-menu
    style={{ left: anchor.x, top: anchor.y }}
    onKeyDown={onKeyDown}
    onClick={(event) => event.stopPropagation()}
    onContextMenu={(event) => event.preventDefault()}
  >
    <div className="skill-tag-popover-head">
      <Icon name="tag" size={14} />
      <span>{multiple ? `为 ${skills.length} 个 Skill 设置目录` : '目录'}</span>
    </div>
    <input
      ref={inputRef}
      className="skill-tag-popover-input"
      type="text"
      value={draft}
      maxLength={64}
      placeholder={tags.length > 0 ? '搜索或新建目录，回车确认' : '输入目录名，回车新建'}
      aria-label="目录名"
      aria-describedby={error ? 'skill-tag-popover-error' : undefined}
      aria-invalid={error ? true : undefined}
      onChange={(event) => { setDraft(event.target.value); setError(null) }}
      onKeyDown={(event) => { if (event.key === 'Enter' && !isImeKey(event)) { event.preventDefault(); submitDraft() } }}
    />
    {error && <p id="skill-tag-popover-error" className="skill-tag-popover-error" role="alert">{error}</p>}
    {visibleTags.length > 0 && <ul className="skill-tag-popover-list" aria-label="已有目录">
      {visibleTags.map((tag) => {
        const count = coverage.get(tag.key) ?? 0
        const checked = count > 0 && count === skillKeys.length
        const indeterminate = count > 0 && !checked
        return <li key={tag.key}>
          <label className="skill-tag-popover-option">
            <input
              type="checkbox"
              checked={checked}
              aria-checked={indeterminate ? 'mixed' : checked}
              ref={(element) => { if (element) element.indeterminate = indeterminate }}
              onChange={() => apply(tag.name, !checked)}
            />
            <span className="skill-tag-popover-name">{tag.name}</span>
            <small aria-label={`${tag.count} 个 Skill`}>{tag.count}</small>
          </label>
        </li>
      })}
    </ul>}
    {query && !exact && <button type="button" className="skill-tag-popover-create" onClick={submitDraft}>
      <Icon name="plus" size={13} /><span>新建目录「{draft.trim()}」</span>
    </button>}
    <p className="skill-tag-popover-hint">每个 Skill 最多 {TAGS_PER_SKILL_MAX} 个目录，目录只有你自己能看到</p>
  </div>, document.body)
}

/**
 * Catalog entries as chips (row line 2 and the detail 「目录」 row). `limit` keeps
 * the first tags and folds the rest into 「+N」 with the full list as its title.
 */
export function SkillTagChips({ names, limit, onRemove }: { names: readonly string[]; limit?: number; onRemove?: (name: string) => void }) {
  if (names.length === 0) return null
  const shown = limit === undefined ? names : names.slice(0, limit)
  const hidden = names.length - shown.length
  return <span className="skill-tag-chips" aria-label={`目录：${names.join('、')}`}>
    {shown.map(name => <span key={name} className={`skill-tag-chip${onRemove ? ' removable' : ''}`}>
      <span className="skill-tag-chip-text" title={name}>{name}</span>
      {onRemove && <button type="button" className="skill-tag-chip-remove" aria-label={`移出目录「${name}」`} title="移出目录" onClick={() => onRemove(name)}><Icon name="x" size={11} /></button>}
    </span>)}
    {hidden > 0 && <span className="skill-tag-chip more" title={names.slice(shown.length).join('、')}>+{hidden}</span>}
  </span>
}

/**
 * Detail 「标签」 row (#355): only the AI-analysed labels, read-only. The
 * account's own grouping is a separate 「目录」 row (`SkillProfileCatalog`), so
 * the two never share a line or need an AI / 我的 prefix.
 */
export function SkillProfileLabels({ skill }: { skill: LocalSkill }) {
  if (skill.labels.length === 0) return <>未分析</>
  return <span className="profile-label-list" aria-label="AI 标签">
    {skill.labels.map((label) => <i key={label}>{label}</i>)}
  </span>
}

/**
 * Detail 「目录」 row (#355): the account's private catalog entries for this
 * Skill (brand chips, removable) with an 「添加目录」 button opening the popover.
 */
export function SkillProfileCatalog({ skill }: { skill: LocalSkill }) {
  const organizer = useStore((state) => state.organizer)
  const mutateOrganizer = useStore((state) => state.mutateOrganizer)
  const currentUserId = useStore((state) => state.currentUser?.id ?? null)
  const organizerReady = useStore((state) => Boolean(state.organizerAccount))
  const addRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const skillKey = skillOrganizerKey(skill, currentUserId)
  const custom = tagsForSkill(organizer, skillKey)
  useEffect(() => { setAnchor(null) }, [skill.id, currentUserId])
  const remove = (name: string): void => {
    const problem = mutateOrganizer(state => toggleTagOnSkills(state, [skillKey], name, false))
    if (problem) toast(problem, 'error')
    else addRef.current?.focus()
  }
  return <div className="profile-tag-groups">
    <div className="profile-tag-mine">
      <SkillTagChips names={custom} onRemove={remove} />
      <button
        ref={addRef}
        type="button"
        className="btn btn-ghost btn-sm profile-tag-add"
        disabled={!organizerReady}
        aria-haspopup="dialog"
        aria-expanded={Boolean(anchor)}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setAnchor(current => current ? null : { x: rect.left, y: rect.bottom + 6 })
        }}
      ><Icon name="plus" size={12} />添加目录</button>
    </div>
    {anchor && <SkillTagPopover skills={[skill]} anchor={anchor} returnFocus={addRef.current} onClose={() => setAnchor(null)} />}
  </div>
}

/** 「加入 / 移出快捷访问」 for one Skill (#325): rows, detail; shows the outcome as a toast. */
export function toggleSkillQuickAccess(skill: LocalSkill): void {
  const state = useStore.getState()
  const item = { kind: 'skill' as const, ref: skillOrganizerKey(skill, state.currentUser?.id ?? null) }
  const inside = isInQuickAccess(state.organizer, item)
  const problem = state.mutateOrganizer(organizer => inside ? removeQuickAccess(organizer, item) : addQuickAccess(organizer, item))
  if (problem) toast(problem, 'error')
  else toast(inside ? '已移出快捷访问' : '已加入快捷访问')
}

/** Detail title button that pins or unpins the Skill in the sidebar quick access (#325). */
export function SkillQuickAccessButton({ skill }: { skill: LocalSkill }) {
  const organizerReady = useStore((state) => Boolean(state.organizerAccount))
  const pinned = useStore((state) => isInQuickAccess(state.organizer, { kind: 'skill', ref: skillOrganizerKey(skill, state.currentUser?.id ?? null) }))
  return <button
    type="button"
    className={`rawname sh-store-copy sh-quick-access${pinned ? ' pinned' : ''}`}
    disabled={!organizerReady}
    aria-pressed={pinned}
    aria-label={pinned ? '移出快捷访问' : '加入快捷访问'}
    title={pinned ? '移出快捷访问' : '加入左侧快捷访问'}
    onClick={() => toggleSkillQuickAccess(skill)}
  ><Icon name="star" size={10} /></button>
}
