import routes from './server-routes.json' with { type: 'json' }
import type { ServerRoute } from './tauri.ts'

export type ServerRouteDefinition = {
  method: string
  path: string
  auth: boolean
  optional?: boolean
  session?: string
  profiles?: readonly string[]
  sessionByProfile?: Readonly<Record<string, string>>
  query: readonly string[]
}

// Prefer literal routes (e.g. skills/trash) over parameterized routes.
const entries = (Object.entries(routes satisfies Record<ServerRoute, ServerRouteDefinition>) as [ServerRoute, ServerRouteDefinition][])
  .sort((a, b) => a[1].path.split(':').length - b[1].path.split(':').length)

export function resolveServerRoute(path: string, method: string): {
  route: ServerRoute; params: Record<string, string>; query: Record<string, string>
} {
  const [pathname, search = ''] = path.split('?')
  const segments = pathname.split('/')
  for (const [route, definition] of entries) {
    if (definition.method !== method) continue
    const template = definition.path.split('/')
    if (segments.length !== template.length) continue
    const params: Record<string, string> = {}
    if (!template.every((part, index) => {
      if (!part.startsWith(':')) return part === segments[index]
      const value = decodeURIComponent(segments[index])
      if (!value || value === '.' || value === '..') return false
      params[part.slice(1)] = value
      return true
    })) continue
    const query = Object.fromEntries(new URLSearchParams(search))
    if (Object.keys(query).some(key => !(definition.query as readonly string[]).includes(key))) {
      throw new Error('Unknown SkillHub query parameter')
    }
    return { route, params, query }
  }
  throw new Error('Unknown SkillHub route')
}
