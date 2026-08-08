import { describe, expect, it } from 'vitest'

import { createLoopState } from '@x-code-cli/core'

import { invalidateModelDependentState, invalidateToolSurfaceState } from '../src/ui/agent/model-switch-state.js'

describe('model switch state invalidation', () => {
  it('drops model-dependent caches while retaining activated tool names', () => {
    const state = createLoopState()
    state.systemPromptCache = 'prompt for old:model'
    state.deferredCatalog = [
      {
        name: 'deferredTool',
        description: 'old schema',
        searchText: 'deferred tool',
        source: 'builtin',
        def: { description: 'old schema' },
      },
    ]
    state.activatedTools.add('deferredTool')

    invalidateModelDependentState(state)

    expect(state.systemPromptCache).toBeNull()
    expect(state.deferredCatalog).toBeUndefined()
    expect(state.expectCacheMiss).toBe(true)
    expect([...state.expectedCacheMissReasons]).toEqual(['model-change'])
    expect([...state.activatedTools]).toEqual(['deferredTool'])
  })

  it('attributes prompt and catalog invalidation to a tool-surface change', () => {
    const state = createLoopState()
    state.systemPromptCache = 'prompt with old tools'
    state.deferredCatalog = []

    invalidateToolSurfaceState(state)

    expect(state.systemPromptCache).toBeNull()
    expect(state.deferredCatalog).toBeUndefined()
    expect([...state.expectedCacheMissReasons]).toEqual(['tool-surface-change'])
  })
})
