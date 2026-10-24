import type { SkillPackageDiffLine, SkillPackageFileDiff, SkillTreeEntry } from './tauri.js'

export type ReviewTreeEntry = SkillTreeEntry & { status?: SkillPackageFileDiff['status'] }
export type ReviewDiffRow = { type: 'line'; line: SkillPackageDiffLine } | { type: 'gap'; skipped: number }

export function diffRowsWithHunkSeparators(lines: SkillPackageDiffLine[]): ReviewDiffRow[] {
  const rows: ReviewDiffRow[] = []
  let previous: SkillPackageDiffLine | undefined
  for (const line of lines) {
    if (previous && line.oldLine !== null && line.newLine !== null && previous.oldLine !== null && previous.newLine !== null) {
      const skipped = Math.min(line.oldLine - previous.oldLine - 1, line.newLine - previous.newLine - 1)
      if (skipped > 0) rows.push({ type: 'gap', skipped })
    }
    rows.push({ type: 'line', line })
    if (line.oldLine !== null && line.newLine !== null) previous = line
  }
  return rows
}

export function buildReviewTree(tree: SkillTreeEntry[], diffs: SkillPackageFileDiff[]): ReviewTreeEntry[] {
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
