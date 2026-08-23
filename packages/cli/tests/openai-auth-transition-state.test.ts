import type { OpenAIAuthSnapshot } from '@x-code-cli/core'

import {
  commitOpenAIAuthTransition,
  createOpenAIAuthTransitionState,
  needsOpenAIAuthTransition,
  needsOpenAIModelEntitlementCheck,
  openAIModelEntitlementKey,
  planOpenAIModelReconciliation,
} from '../src/ui/app/openai-auth-transition.js'

function snapshot(revision: string, mode: 'api-key' | 'chatgpt' | 'none'): OpenAIAuthSnapshot {
  return {
    context: mode === 'api-key' ? { mode, apiKey: 'key' } : { mode },
    generation: revision.length,
    revision,
  }
}

describe('OpenAI auth transition state', () => {
  it('keeps a revision pending until this consumer successfully applies it', () => {
    const initial = snapshot('api-key:old', 'api-key')
    const observed = snapshot('chatgpt:new', 'chatgpt')
    const state = createOpenAIAuthTransitionState(initial)

    expect(needsOpenAIAuthTransition(state, observed)).toBe(true)
    expect(needsOpenAIAuthTransition(state, observed)).toBe(true)

    commitOpenAIAuthTransition(state, observed)
    expect(needsOpenAIAuthTransition(state, observed)).toBe(false)
  })

  it('does not commit a failed transition implicitly', () => {
    const state = createOpenAIAuthTransitionState(snapshot('chatgpt:old', 'chatgpt'))
    const logout = snapshot('none', 'none')

    expect(needsOpenAIAuthTransition(state, logout)).toBe(true)
    expect(state.applied.context.mode).toBe('chatgpt')
  })

  it('reconciles an external account before its first model request', () => {
    expect(
      planOpenAIModelReconciliation(
        'openai:old-account-only',
        [{ id: 'openai:new-account-model' }],
        ['openai'],
        'blocked',
        (id) => id,
      ),
    ).toMatchObject({ modelId: 'openai:new-account-model' })
  })

  it('checks a saved OpenAI model once for the initial ChatGPT revision', () => {
    const observed = snapshot('chatgpt:launch', 'chatgpt')
    const catalog = { models: [{ id: 'openai:saved-model' }], source: 'remote' as const, verifiedAt: 1 }
    const checkedKey = openAIModelEntitlementKey(observed, catalog)

    expect(needsOpenAIModelEntitlementCheck(null, observed, 'openai:saved-model', catalog)).toBe(true)
    expect(needsOpenAIModelEntitlementCheck(checkedKey, observed, 'openai:saved-model', catalog)).toBe(false)
    expect(
      needsOpenAIModelEntitlementCheck(checkedKey, observed, 'openai:saved-model', {
        ...catalog,
        models: [{ id: 'openai:replacement-model' }],
        verifiedAt: 2,
      }),
    ).toBe(true)
    expect(needsOpenAIModelEntitlementCheck(null, observed, 'deepseek:deepseek-chat', catalog)).toBe(false)
  })

  it('falls back or disables deterministically when the new account has no models', () => {
    expect(planOpenAIModelReconciliation('openai:old', [], ['deepseek'], 'blocked', (id) => id)).toMatchObject({
      modelId: 'deepseek:deepseek-v4-flash',
    })
    expect(planOpenAIModelReconciliation('openai:old', [], [], 'blocked', (id) => id)).toEqual({
      blockedMessage: 'blocked',
      note: ' Sending messages is disabled until authentication recovers.',
    })
  })
})
