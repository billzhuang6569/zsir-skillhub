import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { TextDecoder } from 'node:util'
import { containsSensitiveContent } from './sensitive-content.js'
import { detectEnvSuggestions, type EnvSuggestion } from './env-detect.js'
import { EnvDeclarationError, parseEnvDeclarations, type EnvDeclaration } from './skill-env-declaration.js'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50

export const SKILL_PACKAGE_LIMITS = {
  maxArchiveBytes: 20 * 1024 * 1024,
  maxFiles: 2_000,
  maxSingleFileBytes: 20 * 1024 * 1024,
  maxTotalUncompressedBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxPathBytes: 1_024,
} as const

export const SKILL_PACKAGE_REVIEW_LIMITS = {
  // A successful inspection response contains every readable text file. If a
  // package exceeds this budget, review fails closed instead of silently
  // hiding source from the reviewer.
  maxReadableTextBytes: 1024 * 1024,
  maxSerializedResponseBytes: 8 * 1024 * 1024,
} as const

export type ValidatedSkillPackage = {
  entryNames: string[]
  skillMd: string
  totalUncompressedBytes: number
}

export type SkillPackageReviewEntry = {
  path: string
  kind: 'directory' | 'text' | 'binary'
  size: number
  content: string | null
}

export type InspectedSkillPackage = ValidatedSkillPackage & {
  files: SkillPackageReviewEntry[]
  readableTextBytes: number
}

export class SkillPackageValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillPackageValidationError'
  }
}

type CentralEntry = {
  name: string
  nameBytes: Buffer
  flags: number
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  isDirectory: boolean
  isExecutable: boolean
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const utf16LeDecoder = new TextDecoder('utf-16le', { fatal: true })
const utf16BeDecoder = new TextDecoder('utf-16be', { fatal: true })
const likelyTextExtensions = new Set([
  'bash', 'bat', 'c', 'cc', 'cfg', 'cjs', 'conf', 'config', 'cpp', 'cs', 'css',
  'csv', 'fish', 'go', 'gradle', 'h', 'hpp', 'html', 'ini', 'java', 'js', 'json',
  'jsonc', 'jsx', 'kt', 'kts', 'lock', 'md', 'mjs', 'php', 'properties', 'ps1',
  'py', 'rb', 'rs', 'sh', 'sql', 'swift', 'toml', 'ts', 'tsx', 'tsv', 'txt',
  'xml', 'yaml', 'yml', 'zsh',
])
const likelyTextBasenames = new Set([
  'dockerfile', 'gemfile', 'makefile', 'procfile', 'readme',
])

function invalid(message: string): never {
  throw new SkillPackageValidationError(message)
}

function ensureRange(buffer: Buffer, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    invalid('Invalid Skill package structure')
  }
  if (offset > buffer.length || length > buffer.length - offset) {
    invalid('Invalid Skill package structure')
  }
}

function decodeEntryName(bytes: Buffer): string {
  if (bytes.length === 0 || bytes.length > SKILL_PACKAGE_LIMITS.maxPathBytes) {
    invalid('Skill package contains an unsafe path')
  }
  try {
    return utf8Decoder.decode(bytes)
  } catch {
    return invalid('Skill package contains an unsafe path')
  }
}

function normalizedEntryName(name: string): { normalized: string; duplicateKey: string } {
  if (
    name.includes(String.fromCharCode(92))
    || name.includes(String.fromCharCode(0))
    || name.startsWith('/')
    || /^[A-Za-z]:/.test(name)
  ) {
    invalid('Skill package contains an unsafe path')
  }
  const directory = name.endsWith('/')
  const withoutTrailingSlash = directory ? name.slice(0, -1) : name
  const parts = withoutTrailingSlash.split('/')
  if (parts.length === 0 || parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    invalid('Skill package contains an unsafe path')
  }
  const normalized = parts.join('/').normalize('NFC')
  return {
    normalized: directory ? `${normalized}/` : normalized,
    duplicateKey: normalized.toLocaleLowerCase('en-US'),
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === buffer.length) return offset
  }
  return invalid('Invalid Skill package structure')
}

function parseCentralDirectory(buffer: Buffer): { entries: CentralEntry[]; centralOffset: number } {
  if (buffer.length < 22) invalid('Invalid Skill package structure')
  const eocdOffset = findEndOfCentralDirectory(buffer)
  ensureRange(buffer, eocdOffset, 22)
  if (buffer.readUInt16LE(eocdOffset + 20) !== 0) {
    invalid('Skill package uses unsupported ZIP features')
  }
  const disk = buffer.readUInt16LE(eocdOffset + 4)
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6)
  const diskEntries = buffer.readUInt16LE(eocdOffset + 8)
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10)
  const centralSize = buffer.readUInt32LE(eocdOffset + 12)
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16)
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    invalid('Skill package uses unsupported ZIP features')
  }
  if (
    totalEntries === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
  ) {
    invalid('Skill package uses unsupported ZIP features')
  }
  if (totalEntries === 0 || totalEntries > SKILL_PACKAGE_LIMITS.maxFiles) {
    invalid('Skill package exceeds safety limits')
  }
  ensureRange(buffer, centralOffset, centralSize)
  if (centralOffset + centralSize !== eocdOffset) {
    invalid('Invalid Skill package structure')
  }

  const entries: CentralEntry[] = []
  const duplicatePaths = new Set<string>()
  let cursor = centralOffset
  for (let index = 0; index < totalEntries; index += 1) {
    ensureRange(buffer, cursor, 46)
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      invalid('Invalid Skill package structure')
    }
    const versionNeeded = buffer.readUInt16LE(cursor + 6)
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const startDisk = buffer.readUInt16LE(cursor + 34)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const variableLength = nameLength + extraLength + commentLength
    ensureRange(buffer, cursor + 46, variableLength)

    if (
      versionNeeded > 20
      || startDisk !== 0
      || compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localOffset === 0xffffffff
      || (flags & ~(0x0008 | 0x0800)) !== 0
      || (method !== 0 && method !== 8)
      || extraLength !== 0
      || commentLength !== 0
    ) {
      invalid('Skill package uses unsupported ZIP features')
    }
    if (uncompressedSize > SKILL_PACKAGE_LIMITS.maxSingleFileBytes) {
      invalid('Skill package exceeds safety limits')
    }

    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength)
    const { normalized, duplicateKey } = normalizedEntryName(decodeEntryName(nameBytes))
    if (duplicatePaths.has(duplicateKey)) invalid('Skill package contains duplicate paths')
    duplicatePaths.add(duplicateKey)
    const isDirectory = normalized.endsWith('/')
    const unixMode = externalAttributes >>> 16
    const unixKind = unixMode & 0o170000
    const isSymlink = unixKind === 0o120000
    if (isSymlink) invalid('Skill package contains unsupported links')
    if (unixKind !== 0 && unixKind !== 0o100000 && unixKind !== 0o040000) {
      invalid('Skill package contains an unsupported file type')
    }
    if ((isDirectory && unixKind === 0o100000) || (!isDirectory && unixKind === 0o040000)) {
      invalid('Skill package entry type does not match its path')
    }
    if (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0)) {
      invalid('Invalid Skill package structure')
    }

    entries.push({
      name: normalized,
      nameBytes: Buffer.from(nameBytes),
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      isDirectory,
      isExecutable: !isDirectory
        && unixKind === 0o100000
        && (unixMode & 0o111) !== 0,
    })
    cursor += 46 + variableLength
  }
  if (cursor !== eocdOffset) invalid('Invalid Skill package structure')
  return { entries, centralOffset }
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function readDataDescriptor(
  buffer: Buffer,
  offset: number,
  entry: CentralEntry
): number {
  ensureRange(buffer, offset, 12)
  const hasSignature = buffer.readUInt32LE(offset) === DATA_DESCRIPTOR_SIGNATURE
  const valuesOffset = offset + (hasSignature ? 4 : 0)
  ensureRange(buffer, valuesOffset, 12)
  if (
    buffer.readUInt32LE(valuesOffset) !== entry.crc
    || buffer.readUInt32LE(valuesOffset + 4) !== entry.compressedSize
    || buffer.readUInt32LE(valuesOffset + 8) !== entry.uncompressedSize
  ) {
    invalid('Skill package integrity check failed')
  }
  return valuesOffset + 12
}

function inflateEntry(buffer: Buffer, entry: CentralEntry, centralOffset: number): {
  data: Buffer
  range: { start: number; end: number }
} {
  ensureRange(buffer, entry.localOffset, 30)
  if (entry.localOffset >= centralOffset || buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
    invalid('Invalid Skill package structure')
  }
  const versionNeeded = buffer.readUInt16LE(entry.localOffset + 4)
  const flags = buffer.readUInt16LE(entry.localOffset + 6)
  const method = buffer.readUInt16LE(entry.localOffset + 8)
  const localCrc = buffer.readUInt32LE(entry.localOffset + 14)
  const localCompressedSize = buffer.readUInt32LE(entry.localOffset + 18)
  const localUncompressedSize = buffer.readUInt32LE(entry.localOffset + 22)
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26)
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28)
  ensureRange(buffer, entry.localOffset + 30, nameLength + extraLength)
  const localName = buffer.subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength)
  if (
    versionNeeded > 20
    || flags !== entry.flags
    || method !== entry.method
    || !localName.equals(entry.nameBytes)
    || extraLength !== 0
  ) {
    invalid('Invalid Skill package structure')
  }
  const usesDescriptor = (flags & 0x0008) !== 0
  if (!usesDescriptor) {
    if (
      localCrc !== entry.crc
      || localCompressedSize !== entry.compressedSize
      || localUncompressedSize !== entry.uncompressedSize
    ) {
      invalid('Skill package integrity check failed')
    }
  } else if (
    (localCrc !== 0 && localCrc !== entry.crc)
    || (localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize)
    || (localUncompressedSize !== 0 && localUncompressedSize !== entry.uncompressedSize)
  ) {
    invalid('Skill package integrity check failed')
  }

  const dataOffset = entry.localOffset + 30 + nameLength + extraLength
  ensureRange(buffer, dataOffset, entry.compressedSize)
  if (dataOffset + entry.compressedSize > centralOffset) invalid('Invalid Skill package structure')
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize)
  let data: Buffer
  try {
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        invalid('Skill package integrity check failed')
      }
      data = Buffer.from(compressed)
    } else {
      const inflated = inflateRawSync(compressed, {
        info: true,
        maxOutputLength: Math.max(1, Math.min(
          SKILL_PACKAGE_LIMITS.maxSingleFileBytes + 1,
          entry.uncompressedSize + 1
        )),
      }) as unknown as { buffer: Uint8Array; engine: { bytesWritten: number } }
      if (inflated.engine.bytesWritten !== compressed.length) {
        invalid('Skill package integrity check failed')
      }
      data = Buffer.from(inflated.buffer)
    }
  } catch (error: unknown) {
    if (error instanceof SkillPackageValidationError) throw error
    return invalid('Skill package decompression failed')
  }
  if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc) {
    invalid('Skill package integrity check failed')
  }
  if (
    data.length > 0
    && (entry.compressedSize === 0
      || data.length / entry.compressedSize > SKILL_PACKAGE_LIMITS.maxCompressionRatio)
  ) {
    invalid('Skill package compression ratio exceeds safety limits')
  }
  const rawEnd = dataOffset + entry.compressedSize
  const end = usesDescriptor ? readDataDescriptor(buffer, rawEnd, entry) : rawEnd
  if (end > centralOffset) invalid('Invalid Skill package structure')
  return { data, range: { start: entry.localOffset, end } }
}

const CREDENTIAL_FILE_STEMS: ReadonlySet<string> = new Set([
  'credentials', 'credential', 'auth', 'token', 'tokens', 'secret', 'secrets',
])
const DOCUMENTATION_EXTENSIONS: ReadonlySet<string> = new Set([
  'md', 'markdown', 'mdx', 'rst', 'adoc', 'asciidoc', 'html', 'htm',
])

function forbiddenFileName(name: string): boolean {
  const parts = name.replace(/\/$/, '').split('/')
  // Windows strips trailing dots and spaces, so `credentials. ` is `credentials`.
  const base = (parts.at(-1) ?? '').toLocaleLowerCase('en-US').replace(/[. ]+$/, '')
  const stem = base.startsWith('.') ? base : base.split('.')[0] ?? base
  // Env templates carry key names only and are packaged by Desktop (#251).
  if (base === '.env.example' || base === '.env.sample' || base === '.env.template') return false
  if (base === '.env' || base.startsWith('.env.') || base === '.envrc') return true
  if (base === '.npmrc' || base === '.netrc') return true
  if (CREDENTIAL_FILE_STEMS.has(stem)) {
    // Ordinary documentation such as `references/auth.md` explains a credential
    // flow and is still content-scanned. Every other name with one of these
    // stems (`auth.json`, `credentials`, `token.txt`, ...) is a credential file.
    const extensionIndex = base.lastIndexOf('.')
    const extension = extensionIndex > 0 ? base.slice(extensionIndex + 1) : ''
    return !DOCUMENTATION_EXTENSIONS.has(extension)
  }
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|private(?:[_-]?key)?)(?:\.|$)/i.test(base)) {
    return true
  }
  return /\.(?:key|p12|pfx|jks|keystore)$/i.test(base)
}

type BomlessUtf16Encoding = 'utf-16le' | 'utf-16be'

type DecodedTextContent = {
  primary: string | null
  candidates: string[]
}

function bomlessUtf16Encoding(data: Buffer): BomlessUtf16Encoding | null {
  if (data.length < 4 || data.length % 2 !== 0) return null

  let evenNuls = 0
  let oddNuls = 0
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] !== 0) continue
    if (index % 2 === 0) evenNuls += 1
    else oddNuls += 1
  }

  // Two populated NUL lanes are ambiguous, so do not guess a primary decoder.
  if (evenNuls >= 2 && oddNuls >= 2) return null

  const codeUnits = data.length / 2
  const minimumExpectedNuls = Math.max(2, Math.ceil(codeUnits * 0.2))
  const maximumUnexpectedNuls = Math.floor(codeUnits * 0.1)
  const looksLittleEndian = oddNuls >= minimumExpectedNuls
    && evenNuls <= maximumUnexpectedNuls
    && oddNuls >= Math.max(2, evenNuls * 4)
  const looksBigEndian = evenNuls >= minimumExpectedNuls
    && oddNuls <= maximumUnexpectedNuls
    && evenNuls >= Math.max(2, oddNuls * 4)

  if (looksLittleEndian === looksBigEndian) return null
  return looksLittleEndian ? 'utf-16le' : 'utf-16be'
}

function decodeWith(decoder: TextDecoder, data: Buffer): string | null {
  try {
    return decoder.decode(data)
  } catch {
    return null
  }
}

function uniqueTextCandidates(values: (string | null)[]): string[] {
  const candidates: string[] = []
  for (const value of values) {
    if (value !== null && !candidates.includes(value)) candidates.push(value)
  }
  return candidates
}

function decodeTextContent(data: Buffer, likelyText: boolean): DecodedTextContent {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    const content = decodeWith(utf16LeDecoder, data)
    return { primary: content, candidates: content === null ? [] : [content] }
  }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    const content = decodeWith(utf16BeDecoder, data)
    return { primary: content, candidates: content === null ? [] : [content] }
  }
  if (likelyText && data.includes(0)) {
    if (data.length % 2 !== 0) return { primary: null, candidates: [] }
    const littleEndian = decodeWith(utf16LeDecoder, data)
    const bigEndian = decodeWith(utf16BeDecoder, data)
    const candidates = uniqueTextCandidates([littleEndian, bigEndian])
    const encoding = bomlessUtf16Encoding(data)
    return {
      primary: encoding === 'utf-16le'
        ? littleEndian
        : encoding === 'utf-16be'
          ? bigEndian
          : null,
      candidates,
    }
  }
  const content = decodeWith(utf8Decoder, data)
  return { primary: content, candidates: content === null ? [] : [content] }
}

function isLikelyTextPath(name: string): boolean {
  const parts = name.toLocaleLowerCase('en-US').split('/').filter(Boolean)
  const base = parts.at(-1) ?? ''
  if (likelyTextBasenames.has(base)) return true
  const extensionIndex = base.lastIndexOf('.')
  if (extensionIndex < 0 || extensionIndex === base.length - 1) {
    return parts.slice(0, -1).some((part) => part === 'script' || part === 'scripts' || part === 'hooks')
  }
  return likelyTextExtensions.has(base.slice(extensionIndex + 1))
}

function hasShebang(data: Buffer): boolean {
  return data.length >= 2 && data[0] === 0x23 && data[1] === 0x21
}

function printableAsciiView(data: Buffer): string {
  const printable = Buffer.allocUnsafe(data.length)
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index] ?? 0
    printable[index] = byte === 0x09 || byte === 0x0a || byte === 0x0d
      || (byte >= 0x20 && byte <= 0x7e)
      ? byte
      : 0x0a
  }
  return printable.toString('ascii')
}

function containsUnsafeTextControl(content: string): boolean {
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index)
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
      || (code >= 0x7f && code <= 0x9f)
    ) return true
  }
  return false
}

type InspectedTextContent = {
  content: string | null
  rejection: 'invalid' | 'sensitive' | null
}

function inspectTextContent(
  data: Buffer,
  name: string,
  isExecutable: boolean,
  rejectSensitiveContent: boolean
): InspectedTextContent {
  const likelyText = isLikelyTextPath(name)
    || hasShebang(data)
    || isExecutable
  if (
    rejectSensitiveContent
    && containsSensitiveContent(printableAsciiView(data))
  ) {
    return { content: null, rejection: 'sensitive' }
  }
  const decoded = decodeTextContent(data, likelyText)
  if (
    rejectSensitiveContent
    && decoded.candidates.some((candidate) => containsSensitiveContent(candidate))
  ) {
    return { content: null, rejection: 'sensitive' }
  }
  // Token-like words and values are ordinary Skill content. Only distinguish
  // readable text from binary data for package review; do not block syncing.
  const content = decoded.primary
  if (content === null) {
    return { content: null, rejection: likelyText ? 'invalid' : null }
  }
  const unsafeControl = containsUnsafeTextControl(content)
  return {
    content: unsafeControl ? null : content,
    rejection: likelyText && unsafeControl ? 'invalid' : null,
  }
}

export const SKILL_CONTENT_HASH_VERSION = 'skillhub-content-v1'

export type DescribedSkillPackage = ValidatedSkillPackage & {
  /** Hash of relative file paths and bytes; independent of ZIP container details. */
  contentHash: string
  /** Sorted relative paths of regular files with executable semantics. */
  executablePaths: string[]
}

type ContentFile = { path: string; data: Buffer; isExecutable: boolean }

/**
 * The cross-platform content identity shared with the desktop client:
 * SHA-256 over "skillhub-content-v1\n" followed by, for each regular file in
 * bytewise UTF-8 path order, `path \n decimal-size \n bytes \n`. Directory
 * entries, ZIP timestamps, compression and permission bits are excluded;
 * executable semantics are tracked separately in `executablePaths`.
 */
export function skillContentHash(files: readonly { path: string; data: Buffer }[]): string {
  const ordered = [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'))
  )
  const hash = createHash('sha256')
  hash.update(`${SKILL_CONTENT_HASH_VERSION}\n`, 'utf8')
  for (const file of ordered) {
    hash.update(`${file.path}\n${file.data.length}\n`, 'utf8')
    hash.update(file.data)
    hash.update('\n', 'utf8')
  }
  return hash.digest('hex')
}

function sortedExecutablePaths(files: readonly ContentFile[]): string[] {
  return files
    .filter((file) => file.isExecutable)
    .map((file) => file.path)
    .sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))
}

function parseValidatedSkillPackage(
  buffer: Buffer,
  includeReviewFiles: boolean,
  rejectSensitiveContent: boolean,
  contentFiles?: ContentFile[]
): ValidatedSkillPackage & { files: SkillPackageReviewEntry[]; readableTextBytes: number } {
  try {
    if (buffer.length === 0 || buffer.length > SKILL_PACKAGE_LIMITS.maxArchiveBytes) {
      invalid('Skill package exceeds safety limits')
    }
    const { entries, centralOffset } = parseCentralDirectory(buffer)
    const localRanges: { start: number; end: number }[] = []
    const entryNames: string[] = []
    const files: SkillPackageReviewEntry[] = []
    let totalUncompressedBytes = 0
    let readableTextBytes = 0
    let skillMd: string | undefined

    for (const entry of entries) {
      const { data, range } = inflateEntry(buffer, entry, centralOffset)
      localRanges.push(range)
      entryNames.push(entry.name)
      if (entry.isDirectory) {
        if (includeReviewFiles) {
          files.push({ path: entry.name, kind: 'directory', size: 0, content: null })
        }
        continue
      }
      totalUncompressedBytes += data.length
      if (totalUncompressedBytes > SKILL_PACKAGE_LIMITS.maxTotalUncompressedBytes) {
        invalid('Skill package exceeds safety limits')
      }
      contentFiles?.push({ path: entry.name, data, isExecutable: entry.isExecutable })
      if (rejectSensitiveContent && forbiddenFileName(entry.name)) {
        invalid('Skill package contains a forbidden file')
      }
      const inspectedText = inspectTextContent(
        data,
        entry.name,
        entry.isExecutable,
        rejectSensitiveContent
      )
      if (inspectedText.rejection === 'sensitive') {
        invalid('Skill package contains sensitive content')
      }
      if (inspectedText.rejection === 'invalid') {
        invalid('Skill package contains invalid text content')
      }
      if (includeReviewFiles) {
        const content = inspectedText.content
        if (content === null) {
          files.push({ path: entry.name, kind: 'binary', size: data.length, content: null })
        } else {
          readableTextBytes += data.length
          if (readableTextBytes > SKILL_PACKAGE_REVIEW_LIMITS.maxReadableTextBytes) {
            invalid('Skill package readable text exceeds review limit')
          }
          files.push({ path: entry.name, kind: 'text', size: data.length, content })
        }
      }
      if (entry.name === 'SKILL.md') {
        try {
          const decodedSkillMd = utf8Decoder.decode(data)
          if (containsUnsafeTextControl(decodedSkillMd)) {
            invalid('SKILL.md must be valid UTF-8 text')
          }
          skillMd = decodedSkillMd
        } catch {
          invalid('SKILL.md must be valid UTF-8 text')
        }
      }
    }

    localRanges.sort((left, right) => left.start - right.start)
    if (localRanges[0]?.start !== 0) invalid('Invalid Skill package structure')
    for (let index = 1; index < localRanges.length; index += 1) {
      const previous = localRanges[index - 1]
      const current = localRanges[index]
      if (previous && current && current.start !== previous.end) {
        invalid('Invalid Skill package structure')
      }
    }
    if (localRanges.at(-1)?.end !== centralOffset) invalid('Invalid Skill package structure')
    if (skillMd === undefined) invalid('Skill package must contain SKILL.md')
    return { entryNames, skillMd, totalUncompressedBytes, files, readableTextBytes }
  } catch (error: unknown) {
    if (error instanceof SkillPackageValidationError) throw error
    return invalid('Invalid Skill package structure')
  }
}

export function validateSkillPackage(buffer: Buffer): ValidatedSkillPackage {
  const result = parseValidatedSkillPackage(buffer, false, false)
  return {
    entryNames: result.entryNames,
    skillMd: result.skillMd,
    totalUncompressedBytes: result.totalUncompressedBytes,
  }
}

/** Validates like `validateSkillPackage` and adds the cross-platform content identity. */
export function describeSkillPackage(buffer: Buffer): DescribedSkillPackage {
  const contentFiles: ContentFile[] = []
  const result = parseValidatedSkillPackage(buffer, false, false, contentFiles)
  return {
    entryNames: result.entryNames,
    skillMd: result.skillMd,
    totalUncompressedBytes: result.totalUncompressedBytes,
    contentHash: skillContentHash(contentFiles),
    executablePaths: sortedExecutablePaths(contentFiles),
  }
}

export function inspectSkillPackage(buffer: Buffer): InspectedSkillPackage {
  return parseValidatedSkillPackage(buffer, true, false)
}

export function validatePublicSkillPackage(buffer: Buffer): ValidatedSkillPackage {
  const result = parseValidatedSkillPackage(buffer, false, true)
  return {
    entryNames: result.entryNames,
    skillMd: result.skillMd,
    totalUncompressedBytes: result.totalUncompressedBytes,
  }
}

export function inspectPublicSkillPackage(buffer: Buffer): InspectedSkillPackage {
  return parseValidatedSkillPackage(buffer, true, true)
}

export type SkillPackageEnvReview = {
  /** `metadata.skillhub.env` of the package's own SKILL.md. */
  declared: EnvDeclaration[]
  /** Read-only re-run of the Desktop detection rules over the package files. */
  detected: EnvSuggestion[]
}

/**
 * Validates like `validateSkillPackage` and re-checks env keys read-only
 * (#251): the SKILL.md declaration (an invalid one is rejected) plus the
 * shared detection rules. Nothing in the package is changed.
 */
export function reviewSkillPackageEnv(buffer: Buffer): ValidatedSkillPackage & { env: SkillPackageEnvReview } {
  const contentFiles: ContentFile[] = []
  const result = parseValidatedSkillPackage(buffer, false, false, contentFiles)
  let declared: EnvDeclaration[]
  try {
    declared = parseEnvDeclarations(result.skillMd)
  } catch (error: unknown) {
    if (error instanceof EnvDeclarationError) invalid(error.message)
    throw error
  }
  return {
    entryNames: result.entryNames,
    skillMd: result.skillMd,
    totalUncompressedBytes: result.totalUncompressedBytes,
    env: { declared, detected: detectEnvSuggestions(contentFiles) },
  }
}
