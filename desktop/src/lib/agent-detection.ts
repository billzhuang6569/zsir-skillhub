import { useStore } from '../store/index.js'
import { getInstalledAgents, type AgentInfo } from './tauri.js'
import { runLatestAgentDetection, type AgentDetectionResult } from './agent-detection-state.js'

export async function refreshAgentCapabilities(
  detect: () => Promise<AgentInfo[]> = getInstalledAgents,
): Promise<AgentDetectionResult<AgentInfo[]>> {
  return runLatestAgentDetection(
    detect,
    (agents) => useStore.getState().setAgentCapabilities(agents),
    (status) => useStore.getState().setAgentDetectionStatus(status),
  )
}
