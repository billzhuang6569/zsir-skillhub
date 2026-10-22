import { config } from '../config.js'
import { falAvailable } from './fal.js'

export function avatarGenerationEnabled(): boolean {
  return config.SKILLHUB_PROFILE === 'selfhost' ? falAvailable() : config.SKILL_AVATARS_ENABLED
}
