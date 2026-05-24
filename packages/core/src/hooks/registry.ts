// @x-code-cli/core — Hook registry
//
// In-memory map from event name → ordered list of `RegisteredHook`s.
// Built once at CLI startup by [[buildHookRegistry]] and held by the
// HookBus for the session. Same byte-stability constraint as the rest
// of the plugin pipeline: hooks must not change between turns (a hook
// list change should go through `/plugin refresh` + systemPromptCache
// invalidation, even though hooks themselves don't appear in the
// prompt — keeping the rule uniform avoids special cases).
import type { HookConfig, HookEventName, RegisteredHook } from './types.js'

export class HookRegistry {
  private byEvent: Map<HookEventName, RegisteredHook[]>

  constructor(hooks: ReadonlyArray<RegisteredHook> = []) {
    this.byEvent = new Map()
    for (const h of hooks) {
      const list = this.byEvent.get(h.event) ?? []
      list.push(h)
      this.byEvent.set(h.event, list)
    }
  }

  /** Hooks bound to a given event, in registration order. */
  get(event: HookEventName): readonly RegisteredHook[] {
    return this.byEvent.get(event) ?? []
  }

  /** Cheap check the bus uses to skip event-payload construction when
   *  no hook is listening — every emit-site is in a hot path. */
  has(event: HookEventName): boolean {
    return (this.byEvent.get(event)?.length ?? 0) > 0
  }

  /** Every registered hook. Used by `/plugin doctor` to list what's
   *  active alongside which plugin contributed it. */
  list(): readonly RegisteredHook[] {
    const all: RegisteredHook[] = []
    for (const arr of this.byEvent.values()) all.push(...arr)
    return all
  }
}

/** Build a registry from per-plugin hook configs. Iteration order of
 *  the input array determines emit order — the caller (integration.ts)
 *  is responsible for handing us plugins in a stable order. */
export function buildHookRegistry(
  pluginHooks: ReadonlyArray<{ pluginId: string; pluginDir: string; config: HookConfig }>,
): HookRegistry {
  const all: RegisteredHook[] = []
  for (const { pluginId, pluginDir, config } of pluginHooks) {
    for (const eventName of Object.keys(config) as HookEventName[]) {
      const entries = config[eventName]
      if (!entries) continue
      for (const entry of entries) {
        all.push({ pluginId, pluginDir, event: eventName, entry })
      }
    }
  }
  return new HookRegistry(all)
}

export function emptyHookRegistry(): HookRegistry {
  return new HookRegistry([])
}
