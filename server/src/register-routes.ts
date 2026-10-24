import type { FastifyInstance } from 'fastify'
import type { Config } from './config.js'
import { teamsRoutes } from './routes/teams.js'
import { skillsRoutes } from './routes/skills.js'
import { migrationRoutes } from './routes/migrations.js'
import { commentsRoutes } from './routes/comments.js'
import { notificationsRoutes } from './routes/notifications.js'
import { authRoutes } from './routes/auth.js'
import { setupRoutes } from './routes/setup.js'
import { instanceRoutes } from './routes/instance.js'
import { instanceSettingsRoutes } from './routes/instance-settings.js'
import { instanceAiStatusRoutes } from './routes/instance-ai.js'
import { localAiRoutes } from './routes/local-ai.js'
import { legacyCredentialsRoutes, teamCredentialsRoutes } from './routes/team-credentials.js'
import { runtimeRoutes } from './routes/runtime.js'
import { marketplaceRoutes } from './routes/marketplace.js'
import { marketplaceExperienceRoutes } from './routes/marketplace-experience.js'
import { teamInviteRoutes } from './routes/team-invites.js'
import { teamSkillLinkRoutes } from './routes/team-skill-links.js'
import { feedbackRoutes } from './routes/feedback.js'
import { appUpdatesRoutes } from './routes/app-updates.js'
import { appReleasesRoutes } from './routes/app-releases.js'
import { webAdminSessionRoutes } from './routes/web-admin-session.js'
import { mediaRoutes } from './routes/media.js'
import { publicMediaRoutes } from './routes/public-media.js'
import { skillAvatarRoutes } from './routes/skill-avatars.js'
import { avatarStylesRoutes } from './routes/avatar-styles.js'
import { libraryRoutes } from './routes/library.js'
import { libraryOrganizerRoutes } from './routes/library-organizer.js'
import { adminAgentKeyRoutes } from './routes/admin-agent-keys.js'
import { adminAgentApiRoutes } from './routes/admin-agent-api.js'
import { createAdminAgentAccess } from './middleware/admin-agent.js'
import { catalogBoundary } from './middleware/catalog-auth.js'

export async function registerRoutes(server: FastifyInstance, config: Pick<Config, 'SKILLHUB_PROFILE'>): Promise<void> {
  server.addHook('onRequest', catalogBoundary)
  await server.register(instanceRoutes, { prefix: '/api/instance' })
  await server.register(authRoutes, { prefix: '/api/auth' })
  if (config.SKILLHUB_PROFILE === 'selfhost') {
    await server.register(publicMediaRoutes)
    await server.register(setupRoutes, { prefix: '/api/setup' })
    await server.register(instanceSettingsRoutes, { prefix: '/api/instance/settings' })
    await server.register(instanceAiStatusRoutes, { prefix: '/api/instance' })
    await server.register(localAiRoutes, { prefix: '/api/local-ai' })
  }
  await server.register(teamsRoutes, { prefix: '/api/teams' })
  await server.register(teamCredentialsRoutes, { prefix: '/api/teams' })
  await server.register(skillsRoutes, { prefix: '/api/skills' })
  await server.register(migrationRoutes, { prefix: '/api/migrations' })
  await server.register(commentsRoutes, { prefix: '/api/comments' })
  await server.register(notificationsRoutes, { prefix: '/api/notifications' })
  // Retired per-Skill binding API: v0.29 clients get 426 with an upgrade hint.
  await server.register(legacyCredentialsRoutes, { prefix: '/api/credentials' })
  await server.register(runtimeRoutes, { prefix: '/api/runtime' })
  if (config.SKILLHUB_PROFILE === 'yitan-official') {
    await server.register(marketplaceRoutes, { prefix: '/api/marketplace' })
    await server.register(marketplaceExperienceRoutes, { prefix: '/api/marketplace' })
  }
  await server.register(teamInviteRoutes)
  await server.register(teamSkillLinkRoutes)
  await server.register(feedbackRoutes, { prefix: '/api/feedback' })
  await server.register(appUpdatesRoutes, { prefix: '/api/app-updates' })
  await server.register(appReleasesRoutes, { prefix: '/api/app-releases' })
  if (config.SKILLHUB_PROFILE === 'yitan-official') {
    await server.register(webAdminSessionRoutes, { prefix: '/api/web-admin' })
  }
  await server.register(mediaRoutes, { prefix: '/api/media' })
  await server.register(skillAvatarRoutes, { prefix: '/api/skill-avatars' })
  await server.register(avatarStylesRoutes, { prefix: '/api/avatar-styles' })
  await server.register(libraryRoutes, { prefix: '/api' })
  await server.register(libraryOrganizerRoutes, { prefix: '/api' })
  if (config.SKILLHUB_PROFILE === 'yitan-official') {
    await server.register(adminAgentKeyRoutes, { prefix: '/api/marketplace' })
    const adminAgentAccess = createAdminAgentAccess()
    await server.register(adminAgentApiRoutes, { prefix: '/api/admin/v1', access: adminAgentAccess })
    await server.register(marketplaceRoutes, { prefix: '/api/admin/v1/marketplace', agentAccess: adminAgentAccess })
    await server.register(marketplaceExperienceRoutes, { prefix: '/api/admin/v1/marketplace', agentAccess: adminAgentAccess })
  }
}
