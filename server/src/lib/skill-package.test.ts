import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  describeSkillPackage,
  inspectPublicSkillPackage,
  inspectSkillPackage,
  reviewSkillPackageEnv,
  skillContentHash,
  SkillPackageValidationError,
  SKILL_PACKAGE_LIMITS,
  validatePublicSkillPackage,
  validateSkillPackage,
} from './skill-package.js'

const REAL_GOOGLE_API_KEY = `AIza${'A'.repeat(35)}`
const GOOGLE_API_KEY_PLACEHOLDER = `AIza${'EXAMPLE'.padEnd(35, 'X')}`
const STRIPE_SECRET_KEY = `sk_live_${'A'.repeat(24)}`
const GOOGLE_OAUTH_CLIENT_SECRET = `GOCSPX-${'A'.repeat(24)}`

type ZipEntryFixture = {
  name: string
  data?: Buffer | string
  method?: 0 | 8 | number
  flags?: number
  extra?: Buffer
  externalAttributes?: number
  versionMadeBy?: number
  declaredUncompressedSize?: number
  crcOverride?: number
  compressedSuffix?: Buffer
}

const testCrcTable = (() => {
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

function testCrc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (testCrcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function createZip(
  fixtures: ZipEntryFixture[],
  options: { disk?: number; centralDisk?: number } = {}
): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0

  for (const fixture of fixtures) {
    const name = Buffer.from(fixture.name, 'utf8')
    const data = Buffer.isBuffer(fixture.data)
      ? fixture.data
      : Buffer.from(fixture.data ?? '', 'utf8')
    const method = fixture.method ?? 0
    const compressedData = method === 8 ? deflateRawSync(data) : data
    const compressed = fixture.compressedSuffix
      ? Buffer.concat([compressedData, fixture.compressedSuffix])
      : compressedData
    const flags = fixture.flags ?? 0x0800
    const extra = fixture.extra ?? Buffer.alloc(0)
    const crc = fixture.crcOverride ?? testCrc32(data)
    const declaredSize = fixture.declaredUncompressedSize ?? data.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(declaredSize, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(extra.length, 28)
    localParts.push(local, name, extra, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(fixture.versionMadeBy ?? 0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(declaredSize, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(extra.length, 30)
    central.writeUInt32LE(
      fixture.externalAttributes ?? ((fixture.name.endsWith('/') ? 0o040755 : 0o100644) * 0x10000) >>> 0,
      38
    )
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name, extra)
    localOffset += local.length + name.length + extra.length + compressed.length
  }

  const central = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(options.disk ?? 0, 4)
  eocd.writeUInt16LE(options.centralDisk ?? 0, 6)
  eocd.writeUInt16LE(fixtures.length, 8)
  eocd.writeUInt16LE(fixtures.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, central, eocd])
}

function safeSkill(extra: ZipEntryFixture[] = []): Buffer {
  return createZip([{ name: 'SKILL.md', data: '# Safe Skill\n' }, ...extra])
}

function utf16Be(value: string): Buffer {
  const encoded = Buffer.from(value, 'utf16le')
  for (let index = 0; index < encoded.length; index += 2) {
    const first = encoded[index]
    const second = encoded[index + 1]
    if (first === undefined || second === undefined) throw new Error('Invalid UTF-16 fixture')
    encoded[index] = second
    encoded[index + 1] = first
  }
  return encoded
}

describe('validateSkillPackage', () => {
  it('accepts stored and deflated files and returns the root SKILL.md', () => {
    const result = validateSkillPackage(safeSkill([
      { name: 'scripts/run.ts', data: 'export const ok = true\n', method: 8 },
      { name: 'references/', data: '' },
    ]))
    expect(result.skillMd).toBe('# Safe Skill\n')
    expect(result.entryNames).toEqual(['SKILL.md', 'scripts/run.ts', 'references/'])
  })

  it('reuses full package validation to expose text scripts and mark binary files', () => {
    const script = 'export const verify = (): boolean => true\n'
    const binary = Buffer.from([0, 1, 2, 3, 255, 137, 80, 78, 71])
    const result = inspectSkillPackage(safeSkill([
      { name: 'scripts/verify.ts', data: script, method: 8 },
      { name: 'assets/icon.bin', data: binary },
      { name: 'references/', data: '' },
    ]))

    expect(result.files).toEqual([
      { path: 'SKILL.md', kind: 'text', size: 13, content: '# Safe Skill\n' },
      { path: 'scripts/verify.ts', kind: 'text', size: Buffer.byteLength(script), content: script },
      { path: 'assets/icon.bin', kind: 'binary', size: binary.length, content: null },
      { path: 'references/', kind: 'directory', size: 0, content: null },
    ])
    expect(result.readableTextBytes).toBe(13 + Buffer.byteLength(script))
  })

  it.each([
    '../escape',
    '/absolute',
    'C:/drive-path',
    `folder${String.fromCharCode(92)}escape`,
    './relative',
    'folder//empty',
  ])('rejects unsafe entry path %s', (name) => {
    expect(() => validateSkillPackage(safeSkill([{ name, data: 'safe' }]))).toThrow(
      'Skill package contains an unsafe path'
    )
  })

  it('rejects duplicate normalized paths', () => {
    expect(() => validateSkillPackage(safeSkill([
      { name: 'scripts/run.ts', data: 'one' },
      { name: 'Scripts/Run.ts', data: 'two' },
    ]))).toThrow('Skill package contains duplicate paths')
  })

  it('rejects Unix symlink entries', () => {
    expect(() => validateSkillPackage(safeSkill([{
      name: 'linked',
      data: 'target',
      externalAttributes: (0o120777 * 0x10000) >>> 0,
      versionMadeBy: 0x0314,
    }]))).toThrow('Skill package contains unsupported links')
  })

  it.each([
    ['FIFO', 0o010644],
    ['character device', 0o020644],
    ['block device', 0o060644],
    ['socket', 0o140644],
  ])('rejects Unix %s entries before Marketplace approval', (_label, mode) => {
    expect(() => validateSkillPackage(safeSkill([{
      name: 'scripts/special',
      data: 'not a regular file',
      externalAttributes: (mode * 0x10000) >>> 0,
      versionMadeBy: 0x0314,
    }]))).toThrow('Skill package contains an unsupported file type')
  })

  it.each([
    ['directory mode without a trailing slash', 'scripts', 0o040755],
    ['regular-file mode with a trailing slash', 'scripts/', 0o100644],
  ])('rejects %s', (_label, name, mode) => {
    expect(() => validateSkillPackage(safeSkill([{
      name,
      data: '',
      externalAttributes: (mode * 0x10000) >>> 0,
      versionMadeBy: 0x0314,
    }]))).toThrow('Skill package entry type does not match its path')
  })

  it.each([
    { label: 'encrypted entry', entry: { name: 'file.txt', data: 'safe', flags: 0x0801 } },
    { label: 'unsupported compression', entry: { name: 'file.txt', data: 'safe', method: 12 } },
    { label: 'ZIP64 extra field', entry: { name: 'file.txt', data: 'safe', extra: Buffer.from([1, 0, 0, 0]) } },
  ])('rejects $label', ({ entry }) => {
    expect(() => validateSkillPackage(safeSkill([entry]))).toThrow(
      'Skill package uses unsupported ZIP features'
    )
  })

  it('rejects multi-disk archives', () => {
    expect(() => validateSkillPackage(createZip([{ name: 'SKILL.md', data: '# Safe' }], { disk: 1 })))
      .toThrow('Skill package uses unsupported ZIP features')
  })

  it('enforces entry-count and declared single-file limits before extraction', () => {
    const tooMany = Array.from({ length: SKILL_PACKAGE_LIMITS.maxFiles }, (_, index) => ({
      name: `files/${index}.txt`,
      data: '',
    }))
    expect(() => validateSkillPackage(safeSkill(tooMany))).toThrow(
      'Skill package exceeds safety limits'
    )
    expect(() => validateSkillPackage(safeSkill([{
      name: 'large.bin',
      data: 'x',
      declaredUncompressedSize: SKILL_PACKAGE_LIMITS.maxSingleFileBytes + 1,
    }]))).toThrow('Skill package exceeds safety limits')
  })

  it('limits actual inflate output even when metadata declares a small file', () => {
    expect(() => validateSkillPackage(safeSkill([{
      name: 'bomb.txt',
      data: Buffer.alloc(4_096, 65),
      method: 8,
      declaredUncompressedSize: 32,
    }]))).toThrow('Skill package decompression failed')
  })

  it('rejects extreme compression ratios', () => {
    expect(() => validateSkillPackage(safeSkill([{
      name: 'repetitive.txt',
      data: Buffer.alloc(2 * 1024 * 1024, 65),
      method: 8,
    }]))).toThrow('Skill package compression ratio exceeds safety limits')
  })

  it('rejects hidden trailing bytes inside a deflate payload', () => {
    expect(() => validateSkillPackage(safeSkill([{
      name: 'script.txt',
      data: 'safe content',
      method: 8,
      compressedSuffix: Buffer.from('hidden-secret'),
    }]))).toThrow('Skill package integrity check failed')
  })

  it.each([
    '.env',
    '.env.production',
    '.envrc',
    'credentials.json',
    'auth.json',
    'token.txt',
    'private.pem',
    'id_rsa',
  ])('allows previously blocked filename %s for personal synchronization', (name) => {
    expect(() => validateSkillPackage(safeSkill([{
      name,
      data: 'not-a-secret',
    }]))).not.toThrow()
  })

  it('allows documentation paths that describe external secrets', () => {
    expect(() => validateSkillPackage(safeSkill([{
      name: 'references/wiki/concepts/external-secrets.md',
      data: '# External secrets\n',
    }]))).not.toThrow()
  })

  it('keeps forbidden filename checks for public Marketplace packages', () => {
    expect(() => validatePublicSkillPackage(safeSkill([{
      name: 'credentials.json',
      data: 'not-a-secret',
    }]))).toThrow('Skill package contains a forbidden file')
  })

  it.each([
    '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP',
    'AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz1234567890ABCD',
    'token=abcdefghijklmnopqrstuvwxyz123456',
    'DATABASE_URL=postgres://user:realpassword@db.internal/app',
    'eyJabcdefghijk.abcdefghijkl.abcdefghijkl',
    REAL_GOOGLE_API_KEY,
    STRIPE_SECRET_KEY,
    GOOGLE_OAUTH_CLIENT_SECRET,
  ])('allows token-like text in Skill content', (content) => {
    expect(() => validateSkillPackage(safeSkill([{
      name: 'notes.txt',
      data: content,
    }]))).not.toThrow()
  })

  it('keeps credential scanning for public Marketplace packages', () => {
    expect(() => validatePublicSkillPackage(safeSkill([{
      name: 'notes.txt',
      data: STRIPE_SECRET_KEY,
    }]))).toThrow('Skill package contains sensitive content')
  })

  it('allows token-like UTF-16 text with a BOM', () => {
    const encoded = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`Use ${STRIPE_SECRET_KEY}\n`, 'utf16le'),
    ])
    expect(() => validateSkillPackage(safeSkill([{
      name: 'references/windows-notes.txt',
      data: encoded,
    }]))).not.toThrow()
  })

  it.each([
    ['little-endian', Buffer.from(`OPENAI_API_KEY=${STRIPE_SECRET_KEY}\n`, 'utf16le')],
    ['big-endian', utf16Be(`OPENAI_API_KEY=${STRIPE_SECRET_KEY}\n`)],
  ])('allows token-like BOM-less UTF-16 %s text', (_encoding, encoded) => {
    expect(() => validateSkillPackage(safeSkill([{
      name: 'references/windows-notes.txt',
      data: encoded,
    }]))).not.toThrow()
  })

  it('rejects ambiguous BOM-less UTF-16 text without treating its contents as credentials', () => {
    const padded = Buffer.concat([
      Buffer.from(`OPENAI_API_KEY=${STRIPE_SECRET_KEY}\n`, 'utf16le'),
      Buffer.from('\u4100'.repeat(1_000), 'utf16le'),
    ])

    expect(() => validateSkillPackage(safeSkill([{
      name: 'references/padded-windows-notes.txt',
      data: padded,
    }]))).toThrow('Skill package contains invalid text content')
  })

  it.each([
    ['little-endian', Buffer.from('No credential values here.\n', 'utf16le')],
    ['big-endian', utf16Be('No credential values here.\n')],
  ])('shows safe BOM-less UTF-16 %s text in package review', (_encoding, encoded) => {
    const inspected = inspectSkillPackage(safeSkill([{
      name: 'references/windows-notes.txt',
      data: encoded,
    }]))
    expect(inspected.files.find((file) => file.path === 'references/windows-notes.txt')).toMatchObject({
      kind: 'text',
      content: 'No credential values here.\n',
    })
  })

  it.each([
    ['an unexplained NUL', Buffer.from('apparently safe\u0000but not UTF-16', 'utf8')],
    ['an escape control', Buffer.from('apparently safe\u001b[31m', 'utf8')],
  ])('fails closed when a likely-text file contains %s', (_label, data) => {
    expect(() => validateSkillPackage(safeSkill([{
      name: 'references/control.txt',
      data,
    }]))).toThrow('Skill package contains invalid text content')
  })

  it('continues to allow binary assets containing NUL and invalid UTF-8 bytes', () => {
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x00, 0x7f, 0x89, 0x50, 0x4e, 0x47])
    expect(() => validateSkillPackage(safeSkill([{
      name: 'assets/payload.bin',
      data: binary,
    }]))).not.toThrow()
    expect(inspectSkillPackage(safeSkill([{
      name: 'assets/payload.bin',
      data: binary,
    }])).files.find((file) => file.path === 'assets/payload.bin')).toMatchObject({
      kind: 'binary',
      content: null,
    })
  })

  it.each([
    ['a sensitive assignment', 'OPENAI_API_KEY=ordinary-runtime-token-value'],
    ['a direct token', `sk_live_${'A'.repeat(24)}`],
    ['URL credentials', 'https://user:private-password@example.com/api'],
    ['a private-key header', '-----BEGIN PRIVATE KEY-----'],
  ])('allows token-like printable ASCII inside a binary asset for %s', (_label, literal) => {
    const disguised = Buffer.concat([
      Buffer.from([0x00, 0xff, 0x80]),
      Buffer.from(literal, 'ascii'),
      Buffer.from([0x00, 0xff]),
    ])

    expect(() => validateSkillPackage(safeSkill([{
      name: 'assets/disguised.bin',
      data: disguised,
    }]))).not.toThrow()
  })

  it.each([
    {
      label: 'a shebang script',
      name: 'bin/run',
      prefix: '#!/bin/sh\n',
      mode: 0o100644,
    },
    {
      label: 'a Unix executable script without a shebang',
      name: 'bin/run',
      prefix: '',
      mode: 0o100755,
    },
    {
      label: 'a common extensionless script path',
      name: 'scripts/run',
      prefix: '',
      mode: 0o100644,
    },
  ])('rejects unreadable source-like files even when token text is allowed in $label', ({ name, prefix, mode }) => {
    const disguised = Buffer.concat([
      Buffer.from(`${prefix}TOKEN=ordinary-runtime-token-value\n`, 'utf8'),
      Buffer.from([0xff]),
    ])

    expect(() => validateSkillPackage(safeSkill([{
      name,
      data: disguised,
      externalAttributes: (mode * 0x10000) >>> 0,
      versionMadeBy: 0x0314,
    }]))).toThrow('Skill package contains invalid text content')
  })

  it('fails closed for an executable native binary that cannot be completely reviewed', () => {
    const elfBinary = Buffer.from([
      0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00,
      0x00, 0xff, 0x80, 0x00, 0x10, 0x20, 0x30, 0x40,
    ])
    const archive = safeSkill([{
      name: 'bin/native-tool',
      data: elfBinary,
      externalAttributes: (0o100755 * 0x10000) >>> 0,
      versionMadeBy: 0x0314,
    }])

    expect(() => validateSkillPackage(archive)).toThrow('Skill package contains invalid text content')
  })

  it('shows safe UTF-16 review text and fails closed for undecodable source-like files', () => {
    const safeUtf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('No credential values here.\n', 'utf16le'),
    ])
    const inspected = inspectSkillPackage(safeSkill([{
      name: 'references/windows-notes.txt',
      data: safeUtf16,
    }]))
    expect(inspected.files.find((file) => file.path === 'references/windows-notes.txt')).toMatchObject({
      kind: 'text',
      content: 'No credential values here.\n',
    })
    expect(() => validateSkillPackage(safeSkill([{
      name: 'references/broken.json',
      data: Buffer.from([0xff, 0xff, 0x00, 0x80]),
    }]))).toThrow('Skill package contains invalid text content')
  })

  it('allows documented placeholders instead of treating them as credentials', () => {
    expect(() => validateSkillPackage(safeSkill([{
      name: 'README.md',
      data: [
        'GOOGLE_API_KEY',
        'API_KEY=your_api_key_here',
        'TOKEN=${TOKEN}',
        'GOOGLE_API_KEY=GOOGLE_API_KEY',
        `GOOGLE_API_KEY=${GOOGLE_API_KEY_PLACEHOLDER}`,
      ].join('\n'),
    }]))).not.toThrow()
  })

  it('allows exact credential formats in Skill package content', () => {
    expect(REAL_GOOGLE_API_KEY).toHaveLength(39)
    expect(() => validateSkillPackage(safeSkill([{
      name: 'README.md',
      data: `Use ${REAL_GOOGLE_API_KEY}`,
    }]))).not.toThrow()

    for (const nonSecret of [
      `AIza${'A'.repeat(34)}`,
      `AIza${'A'.repeat(36)}`,
      GOOGLE_API_KEY_PLACEHOLDER,
      'GOOGLE_API_KEY=${GOOGLE_API_KEY}',
    ]) {
      expect(() => validateSkillPackage(safeSkill([{
        name: 'README.md',
        data: nonSecret,
      }]))).not.toThrow()
    }
  })

  it.each([
    'scripts/verify.test.mjs',
    'scripts/verify.spec.mjs',
    'test/verify.mjs',
    'tests/verify.mjs',
    'fixtures/verify.mjs',
  ])('allows explicit fixture values in test path %s', (name) => {
    expect(() => validateSkillPackage(safeSkill([{
      name,
      data: "const secret = 'fixture-secret-that-must-not-be-printed'\n",
    }]))).not.toThrow()
  })

  it('allows fixture-prefixed values outside explicit test paths', () => {
    expect(() => validateSkillPackage(safeSkill([{
      name: 'scripts/runtime.mjs',
      data: "const secret = 'fixture-secret-that-must-not-be-printed'\n",
    }]))).not.toThrow()
  })

  it.each([
    ['scripts/runtime.mjs', "const token = process.env.API_TOKEN\n"],
    ['scripts/runtime.py', "token = os.environ['API_TOKEN']\n"],
  ])('allows runtime environment references in %s', (name, data) => {
    expect(() => validateSkillPackage(safeSkill([{
      name,
      data,
    }]))).not.toThrow()
  })

  it('allows ordinary credential literals in runtime source', () => {
    expect(() => validateSkillPackage(safeSkill([{
      name: 'scripts/runtime.mjs',
      data: "const token = 'ordinary-runtime-token-value'\n",
    }]))).not.toThrow()
  })

  it('requires a root SKILL.md and validates CRC integrity', () => {
    expect(() => validateSkillPackage(createZip([{ name: 'nested/SKILL.md', data: '# Nested' }])))
      .toThrow('Skill package must contain SKILL.md')
    expect(() => validateSkillPackage(createZip([{
      name: 'SKILL.md',
      data: '# Safe',
      crcOverride: 123,
    }]))).toThrow('Skill package integrity check failed')
  })
})

describe('skill content identity', () => {
  it('matches the fixed cross-platform test vector shared with the desktop client', () => {
    expect(skillContentHash([
      { path: 'scripts/run.sh', data: Buffer.from('echo ok\n') },
      { path: 'SKILL.md', data: Buffer.from('# Exec\n') },
      { path: '资料/说明.md', data: Buffer.from('中文\n') },
    ])).toBe('2c30294abac1d915b8e9d5427c14547d16acb323f4cfcc4857e19bc75a9e0143')
  })

  it('ignores compression, entry order and directories but reports executable files', () => {
    const stored = createZip([
      { name: 'SKILL.md', data: '# Exec\n' },
      { name: 'scripts/', externalAttributes: (0o040755 * 0x10000) >>> 0 },
      { name: 'scripts/run.sh', data: 'echo ok\n', externalAttributes: (0o100755 * 0x10000) >>> 0 },
    ])
    const deflated = createZip([
      { name: 'scripts/run.sh', data: 'echo ok\n', method: 8, externalAttributes: (0o100644 * 0x10000) >>> 0 },
      { name: 'SKILL.md', data: '# Exec\n', method: 8 },
    ])
    const first = describeSkillPackage(stored)
    const second = describeSkillPackage(deflated)
    expect(first.contentHash).toBe(second.contentHash)
    expect(first.executablePaths).toEqual(['scripts/run.sh'])
    expect(second.executablePaths).toEqual([])
  })
})

describe('env templates and the package env re-check (#251)', () => {
  it.each(['.env.example', '.env.sample', '.env.template', 'config/.ENV.EXAMPLE'])(
    'allows the key-only template %s in public Marketplace packages',
    (name) => {
      expect(() => validatePublicSkillPackage(safeSkill([{ name, data: 'FAL_KEY=\n' }]))).not.toThrow()
    }
  )

  it.each(['.env', '.env.local', '.env.production', '.envrc'])(
    'still rejects the value file %s in public Marketplace packages',
    (name) => {
      expect(() => validatePublicSkillPackage(safeSkill([{ name, data: 'FAL_KEY=x\n' }])))
        .toThrow('Skill package contains a forbidden file')
    }
  )

  it('detects an undeclared SDK key without reading values and keeps old packages valid', () => {
    const review = reviewSkillPackageEnv(safeSkill([
      { name: 'scripts/gen.py', data: 'import fal_client\n' },
      { name: '.env.example', data: 'REPLICATE_API_TOKEN=not-a-value\n' },
    ]))
    expect(review.env.declared).toEqual([])
    expect(review.env.detected.map(({ key, confidence }) => ({ key, confidence }))).toEqual([
      { key: 'FAL_KEY', confidence: 'high' },
      { key: 'REPLICATE_API_TOKEN', confidence: 'high' },
    ])
    expect(JSON.stringify(review.env)).not.toContain('not-a-value')
  })

  it('reads the SKILL.md declaration and rejects an invalid one explicitly', () => {
    const declared = reviewSkillPackageEnv(createZip([{
      name: 'SKILL.md',
      data: '---\nname: demo\nmetadata:\n  skillhub:\n    env:\n      - key: FAL_KEY\n        obtain: https://fal.ai/dashboard/keys\n---\n',
    }]))
    expect(declared.env.declared).toEqual([{ key: 'FAL_KEY', required: true, obtain: 'https://fal.ai/dashboard/keys' }])
    expect(() => reviewSkillPackageEnv(createZip([{
      name: 'SKILL.md',
      data: '---\nname: demo\nmetadata:\n  skillhub:\n    env:\n      - key: FAL_KEY\n        obtain: http://fal.ai\n---\n',
    }]))).toThrow(new SkillPackageValidationError('SKILL.md metadata.skillhub.env is invalid: item 1 has an invalid obtain'))
  })
})

// Every secret below is self-made and invalid. Each case calls the public
// Marketplace entry points, never the personal synchronization validators.
describe('public Marketplace package secret policy (#333)', () => {
  const AUTH_DOC = [
    '# Authentication',
    '',
    'Export `RIVET_TOKEN` before running the client.',
    '',
    '```ts',
    'const token = getToken()',
    'const apiKey = options.token',
    'const fromEnv = process.env.RIVET_TOKEN',
    '```',
    '',
    '- Endpoint: `https://default:sk_...@api.rivet.dev`',
    '- Endpoint: `https://default:<RIVET_TOKEN>@api.rivet.dev`',
    '- Shell: `TOKEN=${TOKEN}`',
    '',
  ].join('\n')

  function expectPublicAccepted(fixtures: ZipEntryFixture[]): void {
    const buffer = safeSkill(fixtures)
    expect(() => validatePublicSkillPackage(buffer)).not.toThrow()
    const inspected = inspectPublicSkillPackage(buffer)
    for (const fixture of fixtures) {
      const file = inspected.files.find((entry) => entry.path === fixture.name)
      expect(file?.content).toBe(fixture.data)
    }
  }

  function expectPublicRejected(fixtures: ZipEntryFixture[], message: string): void {
    const buffer = safeSkill(fixtures)
    expect(() => validatePublicSkillPackage(buffer)).toThrow(message)
    expect(() => inspectPublicSkillPackage(buffer)).toThrow(message)
  }

  it.each([
    'references/auth.md',
    'references/credentials.md',
    'docs/token.md',
    'secrets.md',
    'references/AUTH.MD',
    'guide/Credential.Markdown',
    'docs/tokens.mdx',
    'docs/secret.rst',
  ])('allows the documentation file %s with unchanged content', (name) => {
    expectPublicAccepted([{ name, data: AUTH_DOC }])
  })

  it.each([
    'credentials.json',
    'config/auth.json',
    'credentials',
    'references/token',
    'secrets',
    'token.txt',
    'secrets.yaml',
    'auth.md.json',
    '.env',
    '.env.local',
    'config/.ENV.production',
    '.envrc',
    '.npmrc',
    '.netrc',
    'id_rsa',
    'keys/id_ed25519.pub',
    'private_key.pem',
    'private-key.md',
    'certs/server.key',
    'certs/client.p12',
    'certs/client.pfx',
    'android/release.jks',
    'android/release.keystore',
  ])('still rejects the credential file %s', (name) => {
    expectPublicRejected([{ name, data: 'not-a-secret\n' }], 'Skill package contains a forbidden file')
  })

  it('does not accept a credential file just because it lives under references/', () => {
    expectPublicRejected(
      [{ name: 'references/credentials.json', data: '{}\n' }],
      'Skill package contains a forbidden file'
    )
  })

  it.each([
    ['token = getToken()'],
    ['token = options.token'],
    ['token = process.env.TOKEN'],
    ['TOKEN=${TOKEN}'],
    ['https://default:sk_...@api.rivet.dev'],
    ['https://default:<RIVET_TOKEN>@api.rivet.dev'],
    ['API_KEY=your_token_here'],
  ])('allows the expression or placeholder %s in scripts and docs', (line) => {
    expectPublicAccepted([
      { name: 'scripts/client.mjs', data: `${line}\n` },
      { name: 'references/auth.md', data: `\`\`\`\n${line}\n\`\`\`\n` },
    ])
  })

  const fakeSecrets: [string, string][] = [
    ['an OpenAI-style key', `OPENAI_API_KEY=sk-${'a1B2'.repeat(6)}`],
    ['a GitHub token', `ghp_${'a1B2'.repeat(6)}`],
    ['an AWS access key', 'AKIA1234567890ABCDEF'],
    ['a Google API key', REAL_GOOGLE_API_KEY],
    ['a Stripe key', STRIPE_SECRET_KEY],
    ['a JWT', 'eyJabcdefghijk.abcdefghijkl.abcdefghijkl'],
    ['a Bearer credential', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'],
    ['a Basic credential', 'Authorization: Basic dXNlcjpwYXNzd29yZDEyMw=='],
    ['a connection URL password', 'DATABASE_URL=postgres://user:opaque-db-pass@db.internal/app'],
    ['a complete private key', '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'],
    ['a truncated private key header', '-----BEGIN RSA PRIVATE KEY-----'],
    ['a sensitive name with a concrete value', 'token = "fixture-credential-value-12345"'],
    ['a value that merely contains example', 'token = "opaque-prefix-example-opaque-suffix"'],
    ['a value that merely contains placeholder', 'api_key=opaque-placeholder-opaque-suffix'],
    ['a literal fallback inside an expression', 'token = process.env.TOKEN || "fixture-credential-value-12345"'],
    ['a provider token inside a call', `token = client.auth("${STRIPE_SECRET_KEY}")`],
  ]

  it.each(fakeSecrets)('rejects %s in references/auth.md, a code fence, a script and a config', (_label, secret) => {
    for (const fixture of [
      { name: 'references/auth.md', data: `# Auth\n\n${secret}\n` },
      { name: 'references/guide.md', data: `# Example\n\n\`\`\`sh\n# example placeholder\n${secret}\n\`\`\`\n` },
      { name: 'scripts/run.sh', data: `#!/bin/sh\n${secret}\n` },
      { name: 'config/settings.yaml', data: `${secret}\n` },
    ]) {
      expectPublicRejected([fixture], 'Skill package contains sensitive content')
    }
  })

  it.each([
    ['UTF-16 with a BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`token=${STRIPE_SECRET_KEY}\n`, 'utf16le')])],
    ['BOM-less UTF-16', Buffer.from(`OPENAI_API_KEY=${STRIPE_SECRET_KEY}\n`, 'utf16le')],
  ])('rejects a fake secret in %s documentation', (_label, data) => {
    expectPublicRejected([{ name: 'references/auth.md', data }], 'Skill package contains sensitive content')
  })

  it('rejects a fake secret hidden as printable text inside a binary asset', () => {
    const data = Buffer.concat([
      Buffer.from([0x00, 0xff, 0x80]),
      Buffer.from('token = process.env.TOKEN || "fixture-credential-value-12345"', 'ascii'),
      Buffer.from([0x00, 0xff]),
    ])
    expectPublicRejected([{ name: 'assets/blob.bin', data }], 'Skill package contains sensitive content')
  })

  it.each(['.env.example', '.env.sample', '.env.template'])(
    'allows %s only while it carries no secret value',
    (name) => {
      expectPublicAccepted([{ name, data: 'API_TOKEN=\nOPENAI_API_KEY=your_api_key_here\nDB_PASSWORD=${DB_PASSWORD}\n' }])
      expectPublicRejected(
        [{ name, data: 'API_TOKEN=fixture-credential-value-12345\n' }],
        'Skill package contains sensitive content'
      )
    }
  )

  // Review bypass cases: generic secrets must not pass as expressions,
  // placeholders or next-line assignments.
  const OPAQUE = 'Zq8vR2mN4kL7pX1wT9yB3cD6'
  it.each([
    ['a literal call argument', `token = getToken("${OPAQUE}")`],
    ['a literal getter default', `api_key = client.config.get("api_key", "${OPAQUE}")`],
    ['a concatenated literal', `token = prefix.value + "${OPAQUE}"`],
    ['a concatenated literal after code', `token = authConfig.apiToken + "${OPAQUE}"`],
    ['an index-shaped password', 'password: Spring[2024]Secure!'],
    ['a call-shaped password', 'password=Pass(word)2024!'],
    ['a call-shaped hex key', 'api_key=k(9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c)'],
    ['a dotted passphrase', 'password: Correct.Horse.Battery.Staple'],
    ['a next-line base64 value with padding', 'password:\n  c2VjcmV0cGFzc3dvcmQx='],
    ['a changeme-prefixed value', 'token = changeme_Zq8vR2mN'],
  ])('rejects %s in public packages', (_label, secret) => {
    for (const name of ['references/auth.md', 'scripts/client.mjs']) {
      expectPublicRejected([{ name, data: `${secret}\n` }], 'Skill package contains sensitive content')
    }
  })

  it.each([
    'token = getToken()',
    'token = options.token',
    'token = process.env.TOKEN',
    'token = os.environ["TOKEN"]',
    'token = os.getenv("TOKEN")',
    'api_key = client.config.get("api_key")',
    'token = getToken(user.id, "API_TOKEN")',
    'token = authConfig.apiToken',
    'token = import.meta.env.VITE_TOKEN',
    'TOKEN=${TOKEN:?missing}',
    'token = fetchToken("https://auth.service/oauth?page=2")',
    'token = fetchToken("https://auth.service/oauth")',
    'API_TOKEN=\nOTHER_KEY=\nX_TOKEN=your_token_here',
    'token = changeme',
  ])('still allows the reference or placeholder %s', (line) => {
    expectPublicAccepted([{ name: 'scripts/client.mjs', data: `${line}\n` }])
  })

  // Second review: fail closed for passphrases, broad name-like literals,
  // long or split literals, query-string secrets and placeholder look-alikes.
  it.each([
    ['a lowercase dotted passphrase', 'password: correct.horse.battery.staple'],
    ['a short lowercase dotted password', 'password: hunter.two'],
    ['a hyphenated call argument', 'password = login("correct-horse-battery-staple")'],
    ['a colon-separated fallback', 'password = cfg.pw || "Pass:Word:Secret:Value"'],
    ['a fallback literal longer than 256 characters', `token = getToken() || "${'a1'.repeat(200)}"`],
    ['a literal containing whitespace', `token = getToken("Zq8vR2mN ${OPAQUE}")`],
    ['a literal containing a semicolon', `token = getToken("a;${OPAQUE}")`],
    ['an expression longer than the scan window', `token = getToken(${'"a" + '.repeat(300)}"b")`],
    ['a URL query value', `token = fetchToken("https://api.example.io/v1?q=${OPAQUE}")`],
    ['an upper-case value with padding on the next line', 'password:\n  SECRETVALUEABCDEF='],
    ['a shell error message holding a secret', `TOKEN=\${TOKEN:?${OPAQUE}}`],
    ['an example suffix after random text', 'token = a1b2c3d4e5f6g7h8example'],
    ['an elision after random text', `token = sk_${OPAQUE}_...`],
  ])('rejects %s in public packages', (_label, secret) => {
    for (const name of ['references/auth.md', 'scripts/client.mjs']) {
      expectPublicRejected([{ name, data: `${secret}\n` }], 'Skill package contains sensitive content')
    }
  })

  it.each(['credentials ', 'credentials.', 'auth.json. ', 'token. .'])(
    'rejects the credential file name %j with trailing dots or spaces',
    (name) => {
      expectPublicRejected([{ name, data: 'not-a-secret\n' }], 'Skill package contains a forbidden file')
    }
  )

  it('keeps personal synchronization permissive for the same documentation', () => {
    expect(() => validateSkillPackage(safeSkill([{
      name: 'references/auth.md',
      data: 'token = "fixture-credential-value-12345"\n',
    }]))).not.toThrow()
  })
})
