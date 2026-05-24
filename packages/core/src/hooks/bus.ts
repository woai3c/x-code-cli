// @x-code-cli/core — Hook event bus
//
// Thin orchestration layer over [[HookRegistry]]. The agent loop,
// tool-execution, compression, and sub-agent runner call `bus.emit(event)`
// at ten lifecycle points; the bus filters hooks by matcher (PreToolUse /
// PostToolUse only), runs them, and returns the aggregated decisions.
//
// Serial vs parallel:
//
//   Decision events (UserPromptSubmit / PreToolUse / PostToolUse) run
//   serially. A `deny` short-circuits the remaining hooks — the agent
//   stops at the first stop. Order is registration order, so plugin
//   authors get deterministic behaviour.
//
//   Fire-and-forget events (SessionStart / PreCompact / PostCompact /
//   SubagentStart / SubagentStop / TurnComplete / SessionEnd) run in
//   parallel — they have no decisions and no ordering concerns.
//
// The bus catches per-hook errors and degrades to `allow` so one
// broken hook never blocks the loop. The executor already does the
// "non-zero exit / timeout → allow" handling — this layer adds the
// matcher-regex error guard.
import { debugLog } from '../utils.js'
import { type ExecuteHookOptions, executeHook } from './executor.js'
import { type HookRegistry, emptyHookRegistry } from './registry.js'
import type { HookDecision, HookEvent, RegisteredHook } from './types.js'

export interface EmitOptions extends ExecuteHookOptions {
  /** Force parallel execution. Default is serial for decision events
   *  and parallel for fire-and-forget. Caller almost never overrides. */
  parallel?: boolean
}

export class HookBus {
  // Mutable so /plugin refresh can swap in a fresh registry without
  // forcing callers to re-capture the bus reference. New incoming
  // event emissions then see the new hooks; any in-flight executeHook
  // calls finish against the old registry (deliberate — finishing the
  // hook is cheaper than coordinating shutdown).
  constructor(private registry: HookRegistry) {}

  has(event: HookEvent['name']): boolean {
    return this.registry.has(event)
  }

  /** Replace the internal registry. Used by /plugin refresh after a
   *  rescan to pick up newly-installed / removed plugin hooks. */
  replaceRegistry(registry: HookRegistry): void {
    this.registry = registry
  }

  /** Emit an event. Returns the per-hook decisions in run order — empty
   *  when no hooks matched. Callers typically only inspect the result
   *  for the three DecisionEvents; for the others they just await
   *  completion for side effects. */
  async emit(event: HookEvent, opts: EmitOptions = {}): Promise<HookDecision[]> {
    const hooks = this.registry.get(event.name)
    if (hooks.length === 0) return []

    const applicable = hooks.filter((h) => matches(h, event))
    if (applicable.length === 0) return []

    const isDecisionEvent =
      event.name === 'UserPromptSubmit' || event.name === 'PreToolUse' || event.name === 'PostToolUse'
    const parallel = opts.parallel ?? !isDecisionEvent

    if (parallel) {
      // For fire-and-forget events we still await the results so the
      // caller's await-for-completion semantics work; we just don't
      // serialise execution. Individual hook failures don't fail the
      // batch (executor returns `allow` on failure).
      const settled = await Promise.allSettled(applicable.map((h) => executeHook(h, event, opts)))
      const out: HookDecision[] = []
      for (const r of settled) {
        if (r.status === 'fulfilled') out.push(r.value)
        else {
          if (opts.signal?.aborted) throw r.reason
          debugLog('hooks.bus-error', `${event.name}: ${String(r.reason)}`)
          out.push({ decision: 'allow' })
        }
      }
      return out
    }

    // Serial: first `deny` halts the rest. modify decisions stack on
    // the next hook's input via the caller (we just collect them).
    const decisions: HookDecision[] = []
    for (const h of applicable) {
      try {
        const d = await executeHook(h, event, opts)
        decisions.push(d)
        if (d.decision === 'deny') break
      } catch (err) {
        if (opts.signal?.aborted) throw err
        debugLog('hooks.bus-error', `${h.pluginId} ${event.name}: ${String(err)}`)
        decisions.push({ decision: 'allow' })
      }
    }
    return decisions
  }
}

/** A bus with no registered hooks. The CLI passes this when plugins
 *  are disabled (`--no-plugins`) so the agent loop's emit-sites don't
 *  need null-checks. */
export function emptyHookBus(): HookBus {
  return new HookBus(emptyHookRegistry())
}

function matches(hook: RegisteredHook, event: HookEvent): boolean {
  if (event.name !== 'PreToolUse' && event.name !== 'PostToolUse') return true
  if (!hook.entry.matcher) return true
  try {
    return new RegExp(hook.entry.matcher).test(event.tool.name)
  } catch (err) {
    // Bad regex shouldn't silently disable the hook — degrade to
    // "matches every tool" but log so support can spot the bad pattern.
    debugLog('hooks.matcher-invalid', `${hook.pluginId}: ${String(err)}`)
    return true
  }
}

// ── Decision aggregation helpers used by the agent loop emit-sites ──

/** Collapse a list of PreToolUse decisions into a single effective
 *  outcome. Order matters: deny short-circuits earlier in `emit`, so
 *  if we see a `deny` here it's the final word. Modifications stack —
 *  the last `modify` with `args` wins (later plugins refine earlier
 *  plugins). */
export interface PreToolEffect {
  decision: 'allow' | 'deny'
  reason?: string
  /** Modified args, or undefined to use the original. */
  args?: unknown
  /** Extra context to inject (rare for PreToolUse; supported for symmetry). */
  context?: string
}

export function aggregatePreToolUse(decisions: ReadonlyArray<HookDecision>): PreToolEffect {
  let args: unknown
  let context: string | undefined
  for (const d of decisions) {
    if (d.decision === 'deny') return { decision: 'deny', reason: d.reason }
    if (d.decision === 'modify') {
      if (d.args !== undefined) args = d.args
      if (d.context) context = d.context
    } else if (d.decision === 'allow' && d.context) {
      context = d.context
    }
  }
  return { decision: 'allow', args, context }
}

export interface PostToolEffect {
  /** Replacement output, or undefined to keep original. */
  output?: string
  context?: string
}

export function aggregatePostToolUse(decisions: ReadonlyArray<HookDecision>): PostToolEffect {
  let output: string | undefined
  let context: string | undefined
  for (const d of decisions) {
    if (d.decision === 'modify') {
      if (typeof d.output === 'string') output = d.output
      if (d.context) context = d.context
    } else if (d.decision === 'allow' && d.context) {
      context = d.context
    }
  }
  return { output, context }
}

export interface UserPromptEffect {
  decision: 'allow' | 'deny'
  reason?: string
  /** Concatenated context from every hook, ready to prepend to the user
   *  message. Empty string when no hook injected anything. */
  context: string
}

export function aggregateUserPromptSubmit(decisions: ReadonlyArray<HookDecision>): UserPromptEffect {
  const contexts: string[] = []
  for (const d of decisions) {
    if (d.decision === 'deny') return { decision: 'deny', reason: d.reason, context: '' }
    // `context` is present on both 'allow' and 'modify' branches; the
    // narrowing above eliminates 'deny', so this is safe.
    if (d.decision === 'allow' && d.context) contexts.push(d.context)
    else if (d.decision === 'modify' && d.context) contexts.push(d.context)
  }
  return { decision: 'allow', context: contexts.join('\n\n') }
}
