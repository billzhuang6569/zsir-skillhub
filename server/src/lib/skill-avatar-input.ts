import { z } from 'zod'

export const LocalAvatarId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
export const AvatarInput = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(500),
  scenarios: z.array(z.string().trim().max(100)).max(8).default([]),
}).strict()
export type Input = z.infer<typeof AvatarInput>
