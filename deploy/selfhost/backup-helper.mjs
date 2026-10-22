// Runs inside the Server image. Input is piped, never interpolated into argv.
import { parseEnv } from 'node:util'
import { randomUUID } from 'node:crypto'

try {
  const action = process.argv[1]
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    input += chunk
    if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error()
  }
  const emit = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
  if (action === 'uuid') emit(randomUUID())
  else if (action === 'env') {
    const env = parseEnv(input)
    if (env.COMPOSE_PROJECT_NAME !== 'skillhub-selfhost'
      || !/^compose\.yaml:compose\.(local|public|proxy)\.yaml(:compose\.s3-local\.yaml)?$/.test(env.COMPOSE_FILE)
      || !/^https?:\/\/[^\s]+$/.test(env.PUBLIC_BASE_URL)) throw new Error()
    emit(env.COMPOSE_FILE)
  } else if (action === 'recovery-input') {
    const dataKey = process.env.SKILLHUB_BACKUP_DATA_KEY
    delete process.env.SKILLHUB_BACKUP_DATA_KEY
    emit({ manifestSha256: process.env.SKILLHUB_BACKUP_MANIFEST_HASH, dataKey, env: input })
  } else if (action === 'manifest') {
    const [metadata, preset, backupId, ...records] = input.trim().split('\n')
    const parts = records.map(line => {
      const [name, sha256, bytes] = line.split(' ')
      return { name, file: `parts/${name}.enc`, sha256, bytes: Number(bytes) }
    })
    emit({ format: 1, backupId, createdAt: new Date().toISOString(), preset, ...JSON.parse(metadata), parts })
  } else if (action === 'manifest-info') {
    const m = JSON.parse(input)
    if (m.format !== 1 || !/^[0-9a-f-]{36}$/.test(m.backupId)
      || !/^[0-9a-f-]{36}$/.test(m.instanceId)
      || !/^compose\.yaml:compose\.(local|public|proxy)\.yaml(:compose\.s3-local\.yaml)?$/.test(m.preset)
      || !/^[0-9]{14}_[a-z0-9_]+$/.test(m.migration)
      || !Number.isInteger(m.postgresMajor) || typeof m.buildId !== 'string'
      || typeof m.serverVersion !== 'string' || typeof m.publicKey !== 'string') throw new Error()
    const names = m.preset.includes('compose.public.yaml') ? ['db', 'media', 'cards', 'caddy'] : ['db', 'media', 'cards']
    if (m.preset.endsWith(':compose.s3-local.yaml')) names.push('objects')
    if (!Array.isArray(m.parts) || m.parts.length !== names.length) throw new Error()
    for (const [index, part] of m.parts.entries()) {
      if (part.name !== names[index] || part.file !== `parts/${part.name}.enc`
        || !/^[a-f0-9]{64}$/.test(part.sha256) || !Number.isSafeInteger(part.bytes) || part.bytes < 26) throw new Error()
    }
    emit([m.backupId, m.instanceId, m.migration, m.postgresMajor, m.preset,
      ...m.parts.map(p => `${p.name} ${p.sha256} ${p.bytes}`)].join('\n') + '\n')
  } else throw new Error()
} catch {
  process.stderr.write('备份元数据无效。\n')
  process.exitCode = 1
}
