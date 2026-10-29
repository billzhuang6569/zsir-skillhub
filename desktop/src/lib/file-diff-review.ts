import type { SkillPackageDiffLine, SkillFileDiff, SkillTreeEntry } from './tauri.js'

export type ReviewTreeEntry = SkillTreeEntry & { status?: SkillFileDiff['status'] }
export type ReviewDiffRow = { type: 'line'; line: SkillPackageDiffLine } | { type: 'gap'; skipped: number }

export function diffRowsWithHunkSeparators(lines: SkillPackageDiffLine[]): ReviewDiffRow[] {
  const rows: ReviewDiffRow[] = []
  let oldEnd = 0
  let newEnd = 0
  for (const line of lines) {
    if (oldEnd || newEnd) {
      const skipped = Math.max(
        line.oldLine === null ? 0 : line.oldLine - oldEnd - 1,
        line.newLine === null ? 0 : line.newLine - newEnd - 1,
      )
      if (skipped > 0) rows.push({ type: 'gap', skipped })
    }
    rows.push({ type: 'line', line })
    if (line.oldLine !== null) oldEnd = line.oldLine
    if (line.newLine !== null) newEnd = line.newLine
  }
  return rows
}

export function buildReviewTree(tree: SkillTreeEntry[], diffs: SkillFileDiff[]): ReviewTreeEntry[] {
  const entries = new Map(tree.map(entry => [entry.path, { ...entry }]))
  for (const file of diffs) {
    const parts = file.path.split('/')
    for (let index = 1; index < parts.length; index++) {
      const path = parts.slice(0, index).join('/')
      if (!entries.has(path)) entries.set(path, { path, name: parts[index - 1]!, kind: 'directory', depth: index - 1 })
    }
    if (!entries.has(file.path)) entries.set(file.path, { path: file.path, name: parts[parts.length - 1]!, kind: 'file', depth: parts.length - 1 })
  }
  const files = new Map(diffs.map(file => [file.path, file.status]))
  return [...entries.values()].map(entry => {
    const childStatuses = [...new Set(diffs.filter(file => file.path.startsWith(`${entry.path}/`)).map(file => file.status))]
    return { ...entry, status: entry.kind === 'file' ? files.get(entry.path) : childStatuses.length === 1 ? childStatuses[0] : childStatuses.length ? 'modified' : undefined }
  }).sort((a, b) => a.path.localeCompare(b.path))
}
