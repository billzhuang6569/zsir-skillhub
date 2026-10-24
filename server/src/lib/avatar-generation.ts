import { config } from '../config.js'
import { falAvailable } from './fal.js'
import { AttemptLimiter } from './attempt-limiter.js'

export const avatarRegistrationLimiter = new AttemptLimiter()

export function avatarGenerationEnabled(): boolean {
  return config.SKILLHUB_PROFILE === 'selfhost' ? falAvailable() : config.SKILL_AVATARS_ENABLED
}
