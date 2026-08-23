import { PROVIDER_DETECTION_ORDER } from '@x-code-cli/core'
import type { OpenAIAuthSnapshot } from '@x-code-cli/core'

type EntitlementCatalog = {
  errorCode?: string
  models: readonly { id: string }[]
  source: 'cache' | 'fallback' | 'remote'
  verifiedAt?: number
}

export interface OpenAIAuthTransitionState {
  applied: OpenAIAuthSnapshot
}

export function createOpenAIAuthTransitionState(initial: OpenAIAuthSnapshot): OpenAIAuthTransitionState {
  return { applied: initial }
}

export function needsOpenAIAuthTransition(state: OpenAIAuthTransitionState, observed: OpenAIAuthSnapshot): boolean {
  return state.applied.revision !== observed.revision
}

export function commitOpenAIAuthTransition(state: OpenAIAuthTransitionState, applied: OpenAIAuthSnapshot): void {
  state.applied = applied
}

export function needsOpenAIModelEntitlementCheck(
  checkedKey: string | null,
  observed: OpenAIAuthSnapshot,
  currentModelId: string,
  catalog: EntitlementCatalog | undefined,
): boolean {
  return (
    observed.context.mode === 'chatgpt' &&
    currentModelId.startsWith('openai:') &&
    checkedKey !== openAIModelEntitlementKey(observed, catalog)
  )
}

export function openAIModelEntitlementKey(
  observed: OpenAIAuthSnapshot,
  catalog: EntitlementCatalog | undefined,
): string {
  return JSON.stringify([
    observed.revision,
    catalog?.source ?? 'none',
    catalog?.verifiedAt ?? 0,
    catalog?.errorCode ?? '',
    ...(catalog?.models.map((model) => model.id) ?? []),
  ])
}

export function planOpenAIModelReconciliation(
  currentModelId: string,
  models: readonly { id: string }[],
  availableProviders: readonly string[],
  unavailableMessage: string,
  renderModelLabel: (modelId: string) => string,
): { blockedMessage?: string; modelId?: string; note: string } {
  if (!currentModelId.startsWith('openai:')) return { modelId: currentModelId, note: '' }
  const nextModelId = models.some((candidate) => candidate.id === currentModelId) ? currentModelId : models[0]?.id
  if (nextModelId) {
    return {
      modelId: nextModelId,
      note: nextModelId === currentModelId ? '' : ` Switched to ${renderModelLabel(nextModelId)}.`,
    }
  }

  const available = new Set(availableProviders)
  const fallback = PROVIDER_DETECTION_ORDER.find(({ defaultModel }) => {
    const provider = defaultModel.split(':')[0]!
    return provider !== 'openai' && available.has(provider)
  })
  if (fallback) {
    return {
      modelId: fallback.defaultModel,
      note: ` Switched to ${renderModelLabel(fallback.defaultModel)}.`,
    }
  }
  return { blockedMessage: unavailableMessage, note: ' Sending messages is disabled until authentication recovers.' }
}
