import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { compareAppVersions, readAppReleaseManifest } from '../lib/app-release-manifest.js'

const VersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/).max(80)
const TargetSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)

export { compareAppVersions }

export const appUpdatesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { target: string; arch: string; currentVersion: string } }>(
    '/:target/:arch/:currentVersion',
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const params = z.object({ target: TargetSchema, arch: TargetSchema, currentVersion: VersionSchema }).safeParse(request.params)
      if (!params.success) return reply.code(400).send({ error: 'Invalid update request' })

      const result = await readAppReleaseManifest(config.APP_UPDATE_MANIFEST_PATH)
      if (result.status === 'missing') return reply.code(204).send()
      if (result.status === 'invalid') {
        request.log.error({ error: result.error }, 'Unable to load app update manifest')
        return reply.code(503).send({ error: 'Update service unavailable' })
      }
      const manifest = result.manifest
      const release = manifest.releases.find((item) => item.target === params.data.target && item.arch === params.data.arch)
      if (!release || compareAppVersions(release.version, params.data.currentVersion) <= 0) return reply.code(204).send()

      return reply.send({
        version: release.version,
        notes: release.notes,
        pub_date: release.pubDate,
        url: release.updater.url,
        signature: release.updater.signature,
      })
    }
  )
}
