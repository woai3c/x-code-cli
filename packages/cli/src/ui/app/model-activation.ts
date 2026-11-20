import {
  PROVIDER_BASE_URLS,
  createModelRegistry,
  getProviderModels,
  loadUserConfig,
  saveUserConfig,
} from '@x-code-cli/core'
import type { AgentOptions, LanguageModel } from '@x-code-cli/core'

export function replaceActiveModelProvider(
  modelId: string,
  options: Pick<AgentOptions, 'modelRegistry'>,
  switchModel: (modelId: string, model: LanguageModel) => void,
): void {
  const registry = createModelRegistry()
  const model = registry.languageModel(modelId as `${string}:${string}`)
  options.modelRegistry = registry
  switchModel(modelId, model)
}

/** Look up a human-friendly label for a model id; falls back to the raw id. */
export function renderModelLabel(modelId: string): string {
  for (const models of Object.values(getProviderModels())) {
    for (const m of models) {
      if (m.id === modelId) return m.label
    }
  }
  return modelId
}

/** Prompt for a multi-endpoint provider's base URL and persist the selection when chosen. */
export async function promptProviderBaseUrl(
  modelProvider: string,
  askQuestion: (
    question: string,
    options: { label: string; description: string }[],
    opts?: { noOther?: boolean },
  ) => Promise<string>,
  opts?: { onlyIfUnset?: boolean },
): Promise<void> {
  const baseUrlConfig = PROVIDER_BASE_URLS[modelProvider]
  if (!baseUrlConfig) return
  if (opts?.onlyIfUnset && loadUserConfig().baseUrls?.[modelProvider]) return
  const baseAnswer = await askQuestion(
    `Pick the API endpoint for ${modelProvider}:`,
    baseUrlConfig.options.map((o) => ({ label: o.label, description: o.url })),
    { noOther: true },
  )
  const chosen = baseUrlConfig.options.find((o) => o.label === baseAnswer)
  if (chosen) {
    const prev = loadUserConfig().baseUrls ?? {}
    saveUserConfig({ baseUrls: { ...prev, [modelProvider]: chosen.url } })
  }
}
