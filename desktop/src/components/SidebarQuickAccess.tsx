import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { useStore, type LocalSkill } from '../store/index.js'
import { cloudLibrarySkills } from '../lib/cloud-library.js'
import { allTags, moveQuickAccess, removeQuickAccess, skillOrganizerKey, tagKey, type QuickAccessItem } from '../lib/skill-organizer.js'
import { nextRovingIndex } from '../lib/ui-helpers.js'
import { Icon } from './Icon.js'
import { SkillAvatarIcon } from './SkillAvatarIcon.js'
import { toast } from './Toast.js'

/** Pointer travel (px) before a press on an item turns into a drag. */
const DRAG_THRESHOLD = 4

type Entry =
  | { kind: 'tag'; index: number; item: QuickAccessItem; label: string }
  | { kind: 'skill'; index: number; item: QuickAccessItem; label: string; skill: LocalSkill }

type Drag = { from: number; pointerId: number; startY: number; active: boolean; over: number }

/** Resolve stored items to what can be shown now; unresolved items stay stored until the data-level prune. */
function quickAccessEntries(items: readonly QuickAccessItem[], skills: readonly LocalSkill[], tagNames: ReadonlyMap<string, string>, userId: string | null): Entry[] {
  const byKey = new Map(skills.map(skill => [skillOrganizerKey(skill, userId), skill]))
  return items.flatMap((item, index): Entry[] => {
    if (item.kind === 'tag') {
      const label = tagNames.get(tagKey(item.ref))
      return label ? [{ kind: 'tag', index, item, label }] : []
    }
    const skill = byKey.get(item.ref)
    return skill ? [{ kind: 'skill', index, item, label: skill.displayName || skill.name, skill }] : []
  })
}

/**
 * 「快捷访问」 under the main navigation (#325, EPIC #321): the account's pinned
 * tags and Skills in their stored order. Hidden entirely while empty. Tags open
 * their group on 我的 Skills · 标签; Skills open their detail and offer a copy
 * button for the folder name. Drag (or Alt+↑/↓, or the item menu) reorders and
 * saves immediately.
 */
export default function SidebarQuickAccess() {
  const { organizer, organizerAccount, skills, libraryEntries, libraryTransfers, userId, view, sheet } = useStore(useShallow((state) => ({
    organizer: state.organizer,
    organizerAccount: state.organizerAccount,
    skills: state.skills,
    libraryEntries: state.libraryEntries,
    libraryTransfers: state.libraryTransfers,
    userId: state.currentUser?.id ?? null,
    view: state.view,
    sheet: state.sheet,
  })))
  const mutateOrganizer = useStore((state) => state.mutateOrganizer)
  const openTagGroup = useStore((state) => state.openTagGroup)
  const revealSkill = useStore((state) => state.revealSkill)
  const itemRefs = useRef(new Map<number, HTMLButtonElement>())
  const listRef = useRef<HTMLUListElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const suppressClick = useRef(false)
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null)
  const pendingFocus = useRef<number | null>(null)

  const tagNames = new Map(allTags(organizer).map(tag => [tag.key, tag.name]))
  const entries = organizerAccount
    ? quickAccessEntries(organizer.quickAccess.items, cloudLibrarySkills(skills, libraryEntries, userId, libraryTransfers), tagNames, userId)
    : []

  useLayoutEffect(() => {
    if (pendingFocus.current === null) return
    itemRefs.current.get(pendingFocus.current)?.focus()
    pendingFocus.current = null
  })

  // A drag that started may never see its pointerup on the button (released
  // elsewhere before capture, Escape, window blur): clean up at document level.
  const dragRef = useRef<Drag | null>(null)
  dragRef.current = drag
  const dragOpen = drag !== null
  useEffect(() => {
    if (!dragOpen) return
    const cancel = (): void => {
      if (dragRef.current?.active) {
        // The button still holds pointer capture, so the eventual release clicks it:
        // keep swallowing until that release has been delivered.
        suppressClick.current = true
        const release = (): void => { window.setTimeout(() => { suppressClick.current = false }, 0) }
        document.addEventListener('pointerup', release, { once: true, capture: true })
        document.addEventListener('pointercancel', release, { once: true, capture: true })
      }
      setDrag(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !dragRef.current?.active) return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    // Runs after the button's own pointerup (target before document bubble), so it only clears leftovers.
    const onUp = (): void => { if (dragRef.current) setDrag(null) }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', cancel)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', cancel)
    }
  }, [dragOpen])

  /** Swallow only the click that the browser fires right after a drag release. */
  const suppressNextClick = (): void => {
    suppressClick.current = true
    window.setTimeout(() => { suppressClick.current = false }, 0)
  }

  if (entries.length === 0) return null

  const move = (entryPosition: number, targetPosition: number): void => {
    const from = entries[entryPosition]
    const target = entries[Math.max(0, Math.min(entries.length - 1, targetPosition))]
    if (!from || !target || from.index === target.index) return
    const problem = mutateOrganizer(state => moveQuickAccess(state, from.index, target.index))
    if (problem) { toast(problem, 'error'); return }
    // After the move the item sits at the target's stored index.
    pendingFocus.current = target.index
  }

  const remove = (entry: Entry): void => {
    const problem = mutateOrganizer(state => removeQuickAccess(state, entry.item))
    if (problem) toast(problem, 'error')
    else toast(`已将「${entry.label}」移出快捷访问`)
  }

  const open = (entry: Entry): void => {
    if (entry.kind === 'tag') openTagGroup(entry.label)
    else revealSkill(entry.skill.id)
  }

  const copyName = (skill: LocalSkill): void => {
    void navigator.clipboard.writeText(skill.name)
      .then(() => toast('已复制'))
      .catch((error: unknown) => toast(`复制失败：${error instanceof Error ? error.message : String(error)}`, 'error'))
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, position: number): void => {
    const entry = entries[position]
    if (!entry) return
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      move(position, position + (event.key === 'ArrowUp' ? -1 : 1))
      return
    }
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      setMenu({ index: entry.index, x: rect.left + 24, y: rect.bottom })
      return
    }
    const next = nextRovingIndex(position, entries.length, event.key, 'vertical')
    if (next === null) return
    event.preventDefault()
    const nextEntry = entries[next]
    if (nextEntry) itemRefs.current.get(nextEntry.index)?.focus()
  }

  /** Insertion gap under the pointer: 0 = before the first item, entries.length = after the last. */
  const gapAt = (clientY: number): number => {
    for (let index = 0; index < entries.length; index += 1) {
      const element = itemRefs.current.get(entries[index]!.index)?.parentElement
      if (!element) continue
      const rect = element.getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) return index
    }
    return entries.length
  }
  /** Final position of the dragged item for a gap; equals `from` when the drop changes nothing. */
  const dropTarget = (from: number, gap: number): number => gap > from ? gap - 1 : gap

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, position: number): void => {
    suppressClick.current = false
    if (event.button !== 0 || event.pointerType === 'touch') return
    setDrag({ from: position, pointerId: event.pointerId, startY: event.clientY, active: false, over: position })
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.active && Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD) return
    if (!drag.active) event.currentTarget.setPointerCapture(event.pointerId)
    // Keep the list scrolling while dragging past its edges.
    const list = listRef.current
    if (list) {
      const rect = list.getBoundingClientRect()
      if (event.clientY < rect.top + 16) list.scrollTop -= 8
      else if (event.clientY > rect.bottom - 16) list.scrollTop += 8
    }
    setDrag({ ...drag, active: true, over: gapAt(event.clientY) })
  }
  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean): void => {
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.active) {
      suppressNextClick()
      const target = dropTarget(drag.from, drag.over)
      if (commit && target !== drag.from) move(drag.from, target)
    }
    setDrag(null)
  }

  const activeSkillId = view === 'skills' && sheet?.kind === 'skill' ? sheet.skillId : null
  const dragging = drag?.active ? drag : null

  return <section className={`sidebar-quick${dragging ? ' dragging' : ''}`} aria-labelledby="sidebar-quick-title">
    <h2 id="sidebar-quick-title" className="sidebar-quick-title">快捷访问</h2>
    <p id="sidebar-quick-help" className="sr-only">拖动或按 Alt 加上下方向键调整顺序；按 Shift+F10 打开更多操作。</p>
    <ul className="sidebar-quick-list" ref={listRef}>
      {entries.map((entry, position) => {
        const active = entry.kind === 'skill' && entry.skill.id === activeSkillId
        // The line marks the gap the item would land in; no line when the drop changes nothing.
        const moves = dragging !== null && dropTarget(dragging.from, dragging.over) !== dragging.from
        const dropBefore = moves && dragging?.over === position
        const dropAfter = moves && dragging?.over === entries.length && position === entries.length - 1
        return <li
          key={`${entry.item.kind}:${entry.item.ref}`}
          className={`sidebar-quick-item${active ? ' active' : ''}${dragging?.from === position ? ' is-dragged' : ''}${dropBefore ? ' drop-before' : ''}${dropAfter ? ' drop-after' : ''}`}
          onContextMenu={(event) => { event.preventDefault(); setMenu({ index: entry.index, x: event.clientX, y: event.clientY }) }}
        >
          <button
            ref={(element) => { if (element) itemRefs.current.set(entry.index, element); else itemRefs.current.delete(entry.index) }}
            type="button"
            className="sidebar-quick-open"
            aria-current={active ? 'page' : undefined}
            aria-describedby="sidebar-quick-help"
            title={entry.kind === 'skill' ? `${entry.label}（${entry.skill.name}）` : `目录：${entry.label}`}
            onClick={() => { if (suppressClick.current) { suppressClick.current = false; return } open(entry) }}
            onKeyDown={(event) => onKeyDown(event, position)}
            onPointerDown={(event) => onPointerDown(event, position)}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => endDrag(event, true)}
            onPointerCancel={(event) => endDrag(event, false)}
          >
            {entry.kind === 'tag'
              ? <span className="sidebar-quick-icon" aria-hidden="true"><Icon name="tag" size={14} /></span>
              : <SkillAvatarIcon className="sidebar-quick-avatar" avatarUrl={entry.skill.avatarUrl} status={entry.skill.avatarStatus} size={20} />}
            <span className="sidebar-quick-label"><span className="sr-only">{entry.kind === 'tag' ? '目录 ' : 'Skill '}</span>{entry.label}</span>
          </button>
          {entry.kind === 'skill' && <button
            type="button"
            className="sidebar-quick-copy"
            aria-label={`复制 Skill 名称 ${entry.skill.name}`}
            title={`复制 Skill 名称：${entry.skill.name}`}
            onClick={() => copyName(entry.skill)}
          ><Icon name="copy" size={13} /></button>}
        </li>
      })}
    </ul>
    {menu && <QuickAccessMenu
      x={menu.x}
      y={menu.y}
      position={entries.findIndex(entry => entry.index === menu.index)}
      count={entries.length}
      onClose={(restore) => { const index = menu.index; setMenu(null); if (restore) itemRefs.current.get(index)?.focus() }}
      onMove={(delta) => { const position = entries.findIndex(entry => entry.index === menu.index); setMenu(null); move(position, position + delta) }}
      onRemove={() => { const entry = entries.find(item => item.index === menu.index); setMenu(null); if (entry) remove(entry) }}
    />}
  </section>
}

function QuickAccessMenu({ x, y, position, count, onClose, onMove, onRemove }: {
  x: number; y: number; position: number; count: number
  onClose: (restoreFocus: boolean) => void
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [x, y])
  useEffect(() => {
    const close = (): void => closeRef.current(false)
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopImmediatePropagation(); closeRef.current(true) } }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('blur', close)
    }
  }, [])
  return createPortal(<div
    ref={ref}
    className="skill-context-menu"
    data-skill-context-menu
    role="menu"
    aria-label="快捷访问条目操作"
    style={{ left: x, top: y }}
    onPointerDown={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      if (event.key === 'Tab') { event.preventDefault(); onClose(true); return }
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      const next = nextRovingIndex(buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length, event.key, 'vertical')
      if (next !== null) { event.preventDefault(); buttons[next]?.focus() }
    }}
  >
    <button type="button" role="menuitem" disabled={position <= 0} onClick={() => onMove(-1)}><Icon name="chev" size={14} style={{ transform: 'rotate(180deg)' }} /><span>上移</span></button>
    <button type="button" role="menuitem" disabled={position < 0 || position >= count - 1} onClick={() => onMove(1)}><Icon name="chev" size={14} /><span>下移</span></button>
    <button type="button" role="menuitem" onClick={onRemove}><Icon name="x" size={14} /><span>移出快捷访问</span></button>
  </div>, document.body)
}
