export type AgentDetectionResult<Value> =
  | { status: 'success'; value: Value }
  | { status: 'error'; error: unknown }
  | { status: 'stale' }

let latestRequest = 0

export async function runLatestAgentDetection<Value>(
  detect: () => Promise<Value>,
  commit: (value: Value) => void,
  setStatus: (status: 'checking' | 'success' | 'error') => void,
): Promise<AgentDetectionResult<Value>> {
  const request = ++latestRequest
  setStatus('checking')
  try {
    const value = await detect()
    if (request !== latestRequest) return { status: 'stale' }
    commit(value)
    setStatus('success')
    return { status: 'success', value }
  } catch (error: unknown) {
    if (request !== latestRequest) return { status: 'stale' }
    setStatus('error')
    return { status: 'error', error }
  }
}
