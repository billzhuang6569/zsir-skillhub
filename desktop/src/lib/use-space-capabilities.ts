import { useStore } from '../store/index.js'
import { spaceCapabilities } from './space-capabilities.js'

export function useSpaceCapabilities(): ReturnType<typeof spaceCapabilities> {
  const space = useStore(state => state.activeSpace)
  const info = useStore(state => state.serverInfo)
  const pending = useStore(state => state.spacePending)
  return spaceCapabilities(space, info, pending)
}
