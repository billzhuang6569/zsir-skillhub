// Read-only env key detection over an uploaded Skill package (#251). It is the
// TypeScript twin of desktop/src-tauri/src/env_detect.rs: both read the same
// rule tables (env-detect-rules.json, byte-identical copies) and run
// desktop/src-tauri/tests/fixtures/env-detect-cases.json. Values are never
// read: `.env.example` lines yield only the name left of `=`.
import rulesJson from './env-detect-rules.json' with { type: 'json' }

export type EnvConfidence = 'declared' | 'high' | 'medium' | 'low'

export type EnvSuggestion = { key: string; confidence: EnvConfidence; evidence: string[] }

export type EnvScanFile = { path: string; data: Buffer }

type FileKind = 'python' | 'script' | 'shell' | 'powershell' | 'batch' | 'markdown' | 'other'

type SdkRule = { ecosystem: 'python' | 'node'; names: string[]; label: string; keys: string[] }

const MAX_SCAN_FILE_BYTES = 1024 * 1024
const MAX_SCAN_FILES = 5_000
const MAX_SCAN_DEPTH = 8
const MAX_EVIDENCE_PER_KEY = 5
const CONFIDENCE_ORDER: readonly EnvConfidence[] = ['declared', 'high', 'medium', 'low']
const LOCAL_TEMPLATE_NAMES = new Set(['.env.example', '.env.sample', '.env.template'])

const KEY_GROUP = rulesJson.keyGroup
const compile = (pattern: string, flags = 'gd'): RegExp => new RegExp(pattern.replaceAll('{KEY}', KEY_GROUP), flags)

const rules = {
  candidateKey: new RegExp(rulesJson.candidateKey),
  excludedKeys: new Set(rulesJson.excludedKeys),
  excludedKeyPrefixes: rulesJson.excludedKeyPrefixes,
  secretKeyTokens: new Set(rulesJson.secretKeyTokens),
  prunedDirs: new Set(rulesJson.prunedDirs),
  envTemplateNames: new Set(rulesJson.envTemplateNames),
  extensions: new Map<string, FileKind>(
    (Object.entries(rulesJson.extensions) as [FileKind, string[]][])
      .flatMap(([kind, names]) => names.map((name): [string, FileKind] => [name, kind]))
  ),
  shebang: rulesJson.shebang as { kind: FileKind; contains: string[] }[],
  sdkCatalog: rulesJson.sdkCatalog as SdkRule[],
  patterns: {
    common: rulesJson.patterns.common.map((pattern) => compile(pattern)),
    destructuring: compile(rulesJson.patterns.destructuring),
    shellBare: compile(rulesJson.patterns.shellBare),
    powershell: compile(rulesJson.patterns.powershell),
    batch: compile(rulesJson.patterns.batch),
    markdownInline: compile(rulesJson.patterns.markdownInline),
    markdownExport: compile(rulesJson.patterns.markdownExport),
    envTemplateLine: compile(rulesJson.patterns.envTemplateLine, ''),
    pythonImport: compile(rulesJson.patterns.pythonImport, 'gmd'),
    pythonFrom: compile(rulesJson.patterns.pythonFrom, 'gmd'),
    scriptImport: compile(rulesJson.patterns.scriptImport),
    pyprojectQuoted: compile(rulesJson.patterns.pyprojectQuoted),
    pyprojectTableKey: compile(rulesJson.patterns.pyprojectTableKey, ''),
  },
}

/** A valid, non-placeholder key: two or more characters, excluding common system names and `LC_*`. */
export function isCandidateKey(key: string): boolean {
  return rules.candidateKey.test(key)
    && !rules.excludedKeys.has(key)
    && !rules.excludedKeyPrefixes.some((prefix) => key.startsWith(prefix))
}

/**
 * A name that looks like a key: one of its `_` segments is KEY / TOKEN / SECRET /
 * PASSWORD … (`secretKeyTokens`). Other names (OUTPUT_DIR, BASE_URL, FAL_MODEL) are
 * the Skill's own configuration; SkillHub only manages keys, so detection drops them
 * (#287). Doubtful names count as configuration and rely on the author's declaration.
 */
export function isSecretKeyName(key: string): boolean {
  return key.split('_').some((segment) => rules.secretKeyTokens.has(segment))
}

class Collector {
  readonly found = new Map<string, { confidence: EnvConfidence; evidence: string[] }>()

  /** Names read from code, templates and docs must look like keys (#287). */
  add(key: string, confidence: EnvConfidence, evidence: string): void {
    if (!isCandidateKey(key) || !isSecretKeyName(key)) return
    this.insert(key, confidence, evidence)
  }

  /** Names from the SDK catalog: the dependency itself is the evidence, the name is not judged. */
  addSdk(rule: SdkRule): void {
    for (const key of rule.keys) {
      if (isCandidateKey(key)) this.insert(key, 'high', `依赖 ${rule.label}（读取 ${key}）`)
    }
  }

  private insert(key: string, confidence: EnvConfidence, evidence: string): void {
    const entry = this.found.get(key) ?? { confidence, evidence: [] }
    if (CONFIDENCE_ORDER.indexOf(confidence) < CONFIDENCE_ORDER.indexOf(entry.confidence)) entry.confidence = confidence
    if (entry.evidence.length < MAX_EVIDENCE_PER_KEY && !entry.evidence.includes(evidence)) entry.evidence.push(evidence)
    this.found.set(key, entry)
  }

  suggestions(): EnvSuggestion[] {
    return [...this.found.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => ({ key, confidence: entry.confidence, evidence: entry.evidence }))
  }
}

function addPythonPackage(collector: Collector, packageName: string): void {
  const candidate = packageName.trim().toLowerCase().replaceAll('-', '_')
  for (const rule of rules.sdkCatalog) {
    if (rule.ecosystem !== 'python') continue
    if (rule.names.some((name) => candidate === name || (candidate.startsWith(name) && candidate.slice(name.length).startsWith('.')))) {
      collector.addSdk(rule)
    }
  }
}

function addNodePackage(collector: Collector, rawSpecifier: string): void {
  const specifier = rawSpecifier.startsWith('npm:') ? rawSpecifier.slice(4) : rawSpecifier
  const segments = specifier.split('/')
  const first = segments[0] ?? ''
  let packageName: string
  if (first.startsWith('@')) {
    const name = segments[1]
    if (name === undefined) return
    packageName = `${first}/${name}`
  } else {
    packageName = first
  }
  for (const rule of rules.sdkCatalog) {
    if (rule.ecosystem === 'node' && rule.names.includes(packageName)) collector.addSdk(rule)
  }
}

/** Rust `str::lines`: splits on `\n` and drops one trailing `\r` per line. */
function lines(contents: string): string[] {
  const parts = contents.split('\n')
  if (parts.at(-1) === '') parts.pop()
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

function scanRequirements(collector: Collector, contents: string): void {
  for (const raw of lines(contents)) {
    const line = (raw.split('#')[0] ?? '').trim()
    if (line.length === 0 || line.startsWith('-')) continue
    addPythonPackage(collector, line.split(/[=<>!~;@ \t\[]/u)[0] ?? '')
  }
}

function scanPyproject(collector: Collector, contents: string): void {
  for (const line of lines(contents)) {
    for (const match of line.matchAll(rules.patterns.pyprojectQuoted)) addPythonPackage(collector, match[1] ?? '')
    const table = rules.patterns.pyprojectTableKey.exec(line)
    if (table) addPythonPackage(collector, table[1] ?? '')
  }
}

function scanPackageJson(collector: Collector, contents: string): void {
  let value: unknown
  try { value = JSON.parse(contents) } catch { return }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = (value as Record<string, unknown>)[section]
    if (dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
      for (const name of Object.keys(dependencies)) addNodePackage(collector, name)
    }
  }
}

function scanImports(collector: Collector, kind: FileKind, contents: string): void {
  if (kind === 'python') {
    for (const match of contents.matchAll(rules.patterns.pythonImport)) {
      for (const module of (match[1] ?? '').split(',')) {
        addPythonPackage(collector, module.trim().split(/\s+/u)[0] ?? '')
      }
    }
    for (const match of contents.matchAll(rules.patterns.pythonFrom)) {
      const module = match[1] ?? ''
      addPythonPackage(collector, module)
      for (const name of (match[2] ?? '').split(',')) {
        const first = name.trim().split(/\s+/u)[0]
        if (first) addPythonPackage(collector, `${module}.${first}`)
      }
    }
  } else if (kind === 'script') {
    for (const match of contents.matchAll(rules.patterns.scriptImport)) addNodePackage(collector, match[1] ?? '')
  }
}

function scanCode(collector: Collector, kind: FileKind, relative: string, contents: string): void {
  const lineStarts = [0]
  for (let index = contents.indexOf('\n'); index !== -1; index = contents.indexOf('\n', index + 1)) lineStarts.push(index + 1)
  const lineOf = (offset: number): number => {
    let low = 0
    let high = lineStarts.length
    while (low < high) {
      const middle = (low + high) >> 1
      if ((lineStarts[middle] ?? 0) <= offset) low = middle + 1
      else high = middle
    }
    return low
  }
  // Offset of capture group 1 (patterns carry the `d` flag for group indices).
  const groupOffset = (match: RegExpMatchArray): number => match.indices?.[1]?.[0] ?? match.index ?? 0
  const add = (key: string, offset: number, confidence: EnvConfidence): void => {
    collector.add(key, confidence, `${relative}:${lineOf(offset)}`)
  }
  const medium = [...rules.patterns.common]
  if (kind === 'shell') medium.push(rules.patterns.shellBare)
  if (kind === 'powershell') medium.push(rules.patterns.powershell)
  if (kind === 'batch') medium.push(rules.patterns.batch)
  for (const pattern of medium) {
    for (const match of contents.matchAll(pattern)) add(match[1] ?? '', groupOffset(match), 'medium')
  }
  for (const match of contents.matchAll(rules.patterns.destructuring)) {
    const offset = groupOffset(match)
    for (const name of (match[1] ?? '').split(',')) {
      add((name.split(/[:=]/u)[0] ?? '').trim().replace(/^(?:\.\.\.)+/u, ''), offset, 'medium')
    }
  }
  if (kind === 'markdown') {
    for (const pattern of [rules.patterns.markdownInline, rules.patterns.markdownExport]) {
      for (const match of contents.matchAll(pattern)) add(match[1] ?? '', groupOffset(match), 'low')
    }
  }
}

function scanEnvTemplate(collector: Collector, relative: string, contents: string): void {
  lines(contents).forEach((line, index) => {
    const match = rules.patterns.envTemplateLine.exec(line)
    // Only the key is taken; the value right of `=` is never read.
    if (match) collector.add(match[1] ?? '', 'high', `${relative}:${index + 1}`)
  })
}

function isLocalEnvValueFile(name: string): boolean {
  return name === '.env' || name === '.envrc' || (name.startsWith('.env.') && !LOCAL_TEMPLATE_NAMES.has(name))
}

function shebangKind(firstLine: string): FileKind {
  return rules.shebang.find((rule) => rule.contains.some((needle) => firstLine.includes(needle)))?.kind ?? 'other'
}

// Keep a BOM like Rust's `String::from_utf8`, so a BOM-prefixed file is never read as a shebang script.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Scans regular package files (paths relative to the Skill root) and returns suggestions sorted by key. */
export function detectEnvSuggestions(files: readonly EnvScanFile[]): EnvSuggestion[] {
  const collector = new Collector()
  let scanned = 0
  for (const file of files) {
    const parts = file.path.split('/').filter((part) => part.length > 0)
    const name = parts.at(-1)
    if (!name || parts.length > MAX_SCAN_DEPTH) continue
    if (parts.slice(0, -1).some((part) => rules.prunedDirs.has(part))) continue
    const lowerName = name.toLowerCase()
    if (isLocalEnvValueFile(lowerName) || lowerName === '.skillhub.json') continue
    const isTemplate = rules.envTemplateNames.has(lowerName)
    const isRequirements = lowerName.startsWith('requirements') && lowerName.endsWith('.txt')
    const dot = name.lastIndexOf('.')
    const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : null
    const extensionKind = extension === null ? undefined : rules.extensions.get(extension)
    const maybeShebang = extension === null && !name.startsWith('.')
    if (!isTemplate && !isRequirements && extensionKind === undefined && !maybeShebang) continue
    if (file.data.length > MAX_SCAN_FILE_BYTES) continue
    if (scanned >= MAX_SCAN_FILES) break
    scanned += 1
    let contents: string
    try { contents = utf8.decode(file.data) } catch { continue }
    const relative = parts.join('/')
    if (isTemplate) {
      scanEnvTemplate(collector, relative, contents)
      continue
    }
    if (isRequirements) {
      scanRequirements(collector, contents)
      continue
    }
    if (lowerName === 'pyproject.toml') scanPyproject(collector, contents)
    else if (lowerName === 'package.json') scanPackageJson(collector, contents)
    let kind = extensionKind
    if (kind === undefined) {
      const firstLine = lines(contents)[0]
      if (firstLine === undefined || !firstLine.startsWith('#!')) continue
      kind = shebangKind(firstLine)
    }
    scanImports(collector, kind, contents)
    scanCode(collector, kind, relative, contents)
  }
  return collector.suggestions()
}
