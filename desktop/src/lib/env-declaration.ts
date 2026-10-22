// 发布 / 新版本前的钥匙声明确认清单（#251）。纯函数，便于 node:test 覆盖；
// 界面在 SkillDetailSheet 的 EnvDeclarationReview。
import type { EnvDeclaration, EnvSuggestion } from './tauri.js'
import type { EnvDep } from '../store/index.js'

export type EnvReviewRow = {
  key: string
  column: 'declared' | 'detected' | 'undetected'
  /** 默认勾选：已声明的项与 high 置信度的检测项。 */
  checked: boolean
  required: boolean
  description?: string
  obtain?: string
  confidence?: EnvSuggestion['confidence']
  evidence: string[]
}

export type EnvReview = {
  declared: EnvReviewRow[]
  detectedUndeclared: EnvReviewRow[]
  declaredUndetected: EnvReviewRow[]
}

const AUTO_DESCRIPTIONS = new Set(['由 SkillHub 静态分析检测', '由 SkillHub 从本机 Skill 检测', '由用户手动添加', 'Agent 运行时发现需要'])

/** Descriptions the APP or CLI wrote itself are not the author's words and never reach SKILL.md. */
export function authoredDescription(description: string | undefined | null): string | undefined {
  const text = description?.trim()
  return text && !AUTO_DESCRIPTIONS.has(text) ? text : undefined
}

/** 「重新检测」 pill: declared / high / medium / low → 声明 / 很可能 / 可能 / 线索 (#284). */
export const ENV_CONFIDENCE_LABELS: Record<EnvSuggestion['confidence'], string> = {
  declared: '声明',
  high: '很可能',
  medium: '可能',
  low: '线索',
}

export function envConfidenceLabel(confidence: EnvSuggestion['confidence']): string {
  return ENV_CONFIDENCE_LABELS[confidence]
}

/** Evidence lines (file:line / SDK name) for the pill tooltip; empty when the detector gave none. */
export function envEvidenceText(suggestion: Pick<EnvSuggestion, 'evidence'>): string {
  return suggestion.evidence.map((line) => line.trim()).filter(Boolean).join('\n')
}

/**
 * What 「写回 SKILL.md」 writes (#284): the sidecar's confirmed keys, sorted, with
 * the author's own description and obtain link. Pending runtime requests wait for
 * 「确认需要」.
 */
export function envDeclarationsFromDependencies(envDeps: readonly EnvDep[]): EnvDeclaration[] {
  return envDeps
    .filter((dependency) => !dependency.pending)
    .map((dependency): EnvDeclaration => {
      const description = authoredDescription(dependency.description)
      return {
        key: dependency.key,
        required: dependency.required,
        ...(description ? { description } : {}),
        ...(dependency.obtain ? { obtain: dependency.obtain } : {}),
      }
    })
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

/**
 * 「确认需要」 for a runtime-requested key (#284): the file's declarations plus this
 * key as required, keeping its description and obtain link; other entries are
 * left exactly as declared.
 */
export function declarationsWithConfirmedKey(
  declared: readonly EnvDeclaration[],
  dependency: Pick<EnvDep, 'key' | 'description' | 'obtain'>,
): EnvDeclaration[] {
  const description = authoredDescription(dependency.description)
  const existing = declared.find((item) => item.key === dependency.key)
  const confirmed: EnvDeclaration = {
    key: dependency.key,
    required: true,
    ...(description ?? existing?.description ? { description: description ?? existing?.description } : {}),
    ...(dependency.obtain ?? existing?.obtain ? { obtain: dependency.obtain ?? existing?.obtain } : {}),
  }
  return [...declared.filter((item) => item.key !== dependency.key), confirmed]
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

/**
 * 三列：已声明（且检测到）/ 检测到但未声明 / 已声明但未检测到。low 只是提示，
 * 不进入清单；未声明的检测项沿用 sidecar 中作者已改过的 required 与说明。
 */
export function buildEnvReview(declared: readonly EnvDeclaration[], suggestions: readonly EnvSuggestion[], sidecar: readonly EnvDep[] = []): EnvReview {
  const detected = suggestions.filter((suggestion) => suggestion.confidence !== 'low' && suggestion.confidence !== 'declared')
  const declaredKeys = new Set(declared.map((item) => item.key))
  const evidenceOf = (key: string): string[] => detected.find((item) => item.key === key)?.evidence ?? []
  const fromDeclaration = (item: EnvDeclaration, column: EnvReviewRow['column']): EnvReviewRow => ({
    key: item.key, column, checked: true, required: item.required, description: item.description, obtain: item.obtain, evidence: evidenceOf(item.key),
  })
  return {
    declared: declared.filter((item) => detected.some((suggestion) => suggestion.key === item.key)).map((item) => fromDeclaration(item, 'declared')),
    declaredUndetected: declared.filter((item) => !detected.some((suggestion) => suggestion.key === item.key)).map((item) => fromDeclaration(item, 'undetected')),
    detectedUndeclared: detected.filter((suggestion) => !declaredKeys.has(suggestion.key)).map((suggestion) => {
      const local = sidecar.find((dep) => dep.key === suggestion.key)
      const description = local?.description && !AUTO_DESCRIPTIONS.has(local.description) ? local.description : undefined
      return {
        key: suggestion.key,
        column: 'detected',
        checked: suggestion.confidence === 'high',
        required: local?.required ?? suggestion.confidence === 'high',
        description,
        obtain: local?.obtain,
        confidence: suggestion.confidence,
        evidence: suggestion.evidence,
      }
    }),
  }
}

export function envReviewIsEmpty(review: EnvReview): boolean {
  return review.declared.length + review.detectedUndeclared.length + review.declaredUndetected.length === 0
}

/** 勾选项按 key 排序写回；未勾选项不写入。 */
export function envDeclarationsFromReview(review: EnvReview, checked: ReadonlySet<string>): EnvDeclaration[] {
  return [...review.declared, ...review.declaredUndetected, ...review.detectedUndeclared]
    .filter((row) => checked.has(row.key))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((row) => ({
      key: row.key,
      required: row.required,
      ...(row.description ? { description: row.description } : {}),
      ...(row.obtain ? { obtain: row.obtain } : {}),
    }))
}

/** 写回是否会改变 SKILL.md：同一组 key 与取值时跳过写入。 */
export function envDeclarationsChanged(before: readonly EnvDeclaration[], after: readonly EnvDeclaration[]): boolean {
  const canonical = (items: readonly EnvDeclaration[]): string => JSON.stringify(
    [...items].sort((left, right) => (left.key < right.key ? -1 : 1)).map((item) => [item.key, item.required, item.description ?? null, item.obtain ?? null]),
  )
  return canonical(before) !== canonical(after)
}


/**
 * Confirms a key an Agent registered with `skillhub env request` (#284): reads
 * the SKILL.md declarations and writes them back with this key as required,
 * keeping its description. `write` is `writeEnvDeclarations`, which also clears
 * the sidecar's pending flag. Values are not touched.
 */
export async function confirmPendingKey<T>(
  dependency: Pick<EnvDep, 'key' | 'description' | 'obtain'>,
  read: () => Promise<EnvDeclaration[]>,
  write: (declarations: EnvDeclaration[]) => Promise<T>,
): Promise<T> {
  return write(declarationsWithConfirmedKey(await read(), dependency))
}
