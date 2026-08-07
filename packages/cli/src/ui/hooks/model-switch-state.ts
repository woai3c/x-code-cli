import { markExpectedCacheMiss } from '@x-code-cli/core'
import type { LoopState } from '@x-code-cli/core'

/** Invalidate every cached surface whose contents can depend on model
 *  capabilities. Activated names survive and are resolved against the newly
 *  built catalog on the next submit, so stale schema objects are never reused. */
export function invalidateModelDependentState(state: LoopState | null): void {
  if (!state) return
  state.systemPromptCache = null
  state.deferredCatalog = undefined
  markExpectedCacheMiss(state, 'model-change')
}

/** Invalidate prompt and deferred-tool metadata after a registry or MCP
 *  surface changes. Keeping the cache-miss reason beside the invalidation
 *  prevents legitimate refreshes from being reported as unexpected misses. */
export function invalidateToolSurfaceState(state: LoopState | null): void {
  if (!state) return
  state.systemPromptCache = null
  state.deferredCatalog = undefined
  markExpectedCacheMiss(state, 'tool-surface-change')
}
