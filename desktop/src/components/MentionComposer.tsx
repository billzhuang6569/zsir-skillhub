import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  apiGetCommentMentionCandidates,
  type ApiCommentMentionCandidate,
  type ApiUser,
} from '../lib/api.js'
import { userMessage } from '../lib/user-message.js'

type Props = {
  skillId: string
  teamId?: string
  value: string
  onChange: (value: string) => void
  mentions: ApiUser[]
  onMentionsChange: (mentions: ApiUser[]) => void
  placeholder: string
  rows?: number
  autoFocus?: boolean
  disabled?: boolean
}

type ActiveQuery = { start: number; end: number; text: string }

function mentionQuery(value: string, cursor: number): ActiveQuery | null {
  const beforeCursor = value.slice(0, cursor)
  const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/u)
  if (!match || match.index === undefined) return null
  const atOffset = match[0].lastIndexOf('@')
  return {
    start: match.index + atOffset,
    end: cursor,
    text: match[1] ?? '',
  }
}

export function activeMentionIds(content: string, mentions: readonly ApiUser[]): string[] {
  return mentions
    .filter((user) => content.includes(`@${user.displayName}`))
    .map((user) => user.id)
}

export default function MentionComposer({
  skillId,
  teamId,
  value,
  onChange,
  mentions,
  onMentionsChange,
  placeholder,
  rows = 2,
  autoFocus = false,
  disabled = false,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [query, setQuery] = useState<ActiveQuery | null>(null)
  const [candidates, setCandidates] = useState<ApiCommentMentionCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    setQuery(null)
    setCandidates([])
    setLoadError(null)
  }, [skillId, teamId])

  const visibleCandidates = useMemo(() => {
    if (!query) return []
    const needle = query.text.trim().toLocaleLowerCase('zh-CN')
    const filtered = needle
      ? candidates.filter((candidate) => candidate.displayName.toLocaleLowerCase('zh-CN').includes(needle))
      : candidates
    return filtered.slice(0, 12)
  }, [candidates, query])

  const ensureCandidates = async (): Promise<void> => {
    if (!teamId || candidates.length > 0 || loading) return
    setLoading(true)
    setLoadError(null)
    try {
      setCandidates(await apiGetCommentMentionCandidates(skillId, teamId))
    } catch (error: unknown) {
      setLoadError(userMessage(error))
    } finally {
      setLoading(false)
    }
  }

  const updateQuery = (nextValue: string, cursor: number): void => {
    const nextQuery = teamId ? mentionQuery(nextValue, cursor) : null
    setQuery(nextQuery)
    setActiveIndex(0)
    if (nextQuery) void ensureCandidates()
  }

  const choose = (candidate: ApiCommentMentionCandidate): void => {
    if (!query || !candidate.canMention) return
    const nextValue = `${value.slice(0, query.start)}@${candidate.displayName} ${value.slice(query.end)}`
    const nextCursor = query.start + candidate.displayName.length + 2
    onChange(nextValue)
    if (!mentions.some((mention) => mention.id === candidate.id)) {
      onMentionsChange([...mentions, candidate])
    }
    setQuery(null)
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current
      textarea?.focus()
      textarea?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!query || visibleCandidates.length === 0) {
      if (event.key === 'Escape') setQuery(null)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((current) => (current + direction + visibleCandidates.length) % visibleCandidates.length)
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      const candidate = visibleCandidates[activeIndex]
      if (!candidate?.canMention) return
      event.preventDefault()
      choose(candidate)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setQuery(null)
    }
  }

  return <div className="mention-composer">
    <textarea
      ref={textareaRef}
      autoFocus={autoFocus}
      disabled={disabled}
      maxLength={2000}
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(event) => {
        const nextValue = event.target.value
        onChange(nextValue)
        onMentionsChange(mentions.filter((mention) => nextValue.includes(`@${mention.displayName}`)))
        updateQuery(nextValue, event.target.selectionStart ?? nextValue.length)
      }}
      onClick={(event) => updateQuery(value, event.currentTarget.selectionStart ?? value.length)}
      onKeyDown={onKeyDown}
    />
    {query && <div className="mention-menu" role="listbox" aria-label="选择要提醒的团队成员">
      {loading ? <div className="mention-menu-state">正在读取团队成员…</div>
        : loadError ? <div className="mention-menu-state error">{loadError}</div>
          : visibleCandidates.length === 0 ? <div className="mention-menu-state">没有匹配的成员</div>
            : visibleCandidates.map((candidate, index) => <button
              key={candidate.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              disabled={!candidate.canMention}
              className={index === activeIndex ? 'active' : ''}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(candidate)}
            >
              <span className="mention-avatar">{candidate.displayName.slice(0, 1)}</span>
              <span><b>{candidate.displayName}</b><small>{candidate.teams.map((team) => team.name).join(' · ')}</small></span>
              {!candidate.canMention && <em>{candidate.reason}</em>}
            </button>)}
    </div>}
  </div>
}
