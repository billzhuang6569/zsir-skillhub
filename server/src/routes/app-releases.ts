import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { db } from '../db.js'
import { readAppReleaseManifest } from '../lib/app-release-manifest.js'

type ReleaseQuery = { target?: string; arch?: string }
const TARGET_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

function shanghaiDay(now = new Date()): Date {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  return new Date(`${day}T00:00:00.000Z`)
}

async function recordDownloadStart(
  request: FastifyRequest,
  release: { version: string; target: string; arch: string },
): Promise<void> {
  try {
    const day = shanghaiDay()
    await db.appReleaseDownloadMetric.upsert({
      where: {
        day_version_target_arch: {
          day,
          version: release.version,
          target: release.target,
          arch: release.arch,
        },
      },
      create: {
        day,
        version: release.version,
        target: release.target,
        arch: release.arch,
        count: 1,
      },
      update: { count: { increment: 1 } },
    })
  } catch (error: unknown) {
    request.log.warn({ error, version: release.version, target: release.target, arch: release.arch }, 'Unable to record app download start')
  }
}

async function loadManifest(request: FastifyRequest, reply: FastifyReply) {
  reply.header('cache-control', 'no-store')
  const result = await readAppReleaseManifest(config.APP_UPDATE_MANIFEST_PATH)
  if (result.status === 'missing') {
    reply.code(204).send()
    return null
  }
  if (result.status === 'invalid') {
    request.log.error({ error: result.error }, 'Unable to load app release manifest')
    reply.code(503).send({ error: 'Release service unavailable' })
    return null
  }
  return result.manifest
}

export const appReleasesRoutes: FastifyPluginAsync = async (fastify) => {
  const selectRelease = async (
    request: FastifyRequest,
    reply: FastifyReply,
    query: ReleaseQuery,
  ) => {
    const manifest = await loadManifest(request, reply)
    if (!manifest) return null
    const target = query.target ?? 'darwin'
    // A platform-only website request should choose the architecture most
    // visitors expect: Apple Silicon for macOS and x64 for Windows. Windows
    // on ARM callers can request `arch=aarch64` explicitly.
    const arch = query.arch ?? (target === 'windows' ? 'x86_64' : 'aarch64')
    if (!TARGET_PATTERN.test(target) || !TARGET_PATTERN.test(arch)) {
      reply.code(400).send({ error: 'Invalid release target' })
      return null
    }
    const release = manifest.releases.find((item) => item.target === target && item.arch === arch)
    if (!release) {
      reply.code(204).send()
      return null
    }
    return release
  }

  fastify.get<{ Querystring: ReleaseQuery }>('/latest', async (request, reply) => {
    const release = await selectRelease(request, reply, request.query)
    if (!release) return reply
    return reply.send({
      version: release.version,
      notes: release.notes,
      pubDate: release.pubDate,
      platform: release.target,
      target: release.target,
      arch: release.arch,
      minimumSystemVersion: release.minimumSystemVersion,
      download: release.installer,
    })
  })

  fastify.get<{ Querystring: ReleaseQuery }>('/latest/download', async (request, reply) => {
    const release = await selectRelease(request, reply, request.query)
    if (!release) return reply
    await recordDownloadStart(request, release)
    return reply
      .code(307)
      .header('location', release.installer.url)
      .send()
  })

  fastify.get('/latest/dmg', async (request, reply) => {
    const release = await selectRelease(request, reply, { target: 'darwin', arch: 'aarch64' })
    if (!release) return reply
    await recordDownloadStart(request, release)
    return reply.code(307).header('location', release.installer.url).send()
  })
}
