import { debugLog, refreshOpenAIChatGPTModels } from '@x-code-cli/core'

type RefreshModels = typeof refreshOpenAIChatGPTModels

let startupPreloadStarted = false

/** Start the one normal catalog load for an authenticated product launch. */
export function startChatGPTModelPreload(
  authMode: 'none' | 'api-key' | 'chatgpt',
  clientVersion: string,
  refreshModels: RefreshModels = refreshOpenAIChatGPTModels,
): boolean {
  if (authMode !== 'chatgpt' || startupPreloadStarted) return false
  startupPreloadStarted = true
  void refreshModels(clientVersion, { signal: AbortSignal.timeout(8_000) }).catch((error) =>
    debugLog('openai-chatgpt.models-preload-failed', String(error)),
  )
  return true
}

export function resetChatGPTModelPreloadForTesting(): void {
  startupPreloadStarted = false
}
