// @x-code-cli/core — hooks.json zod schema
//
// Validates a `HookConfig` whether it came from a hooks.json file on
// disk or an inline manifest object. Same schema both paths — keeps the
// failure mode identical so plugin authors don't get different errors
// depending on which form they used.
//
// Bad regex in `matcher` is NOT a schema error — it'd be inconvenient
// to require authors to author / test their regex against zod's strict
// mode. The bus catches RegExp construction errors at emit time and
// degrades to "matches every tool" (logged for support).
import { z } from 'zod'

import type { HookConfig } from './types.js'

const hookEntrySchema = z.object({
  matcher: z.string().optional(),
  command: z.string().min(1),
  // Platform-specific overrides. Optional; missing on a platform falls
  // back to `command`. We deliberately don't enforce that at least one
  // of them is set — the base command is always required.
  commandWindows: z.string().min(1).optional(),
  commandDarwin: z.string().min(1).optional(),
  commandLinux: z.string().min(1).optional(),
  timeout: z.number().int().positive().max(30_000).optional(),
  description: z.string().optional(),
  failurePolicy: z.enum(['allow', 'block']).optional(),
})

export const hookConfigSchema = z
  .object({
    SessionStart: z.array(hookEntrySchema).optional(),
    UserPromptSubmit: z.array(hookEntrySchema).optional(),
    PreToolUse: z.array(hookEntrySchema).optional(),
    PostToolUse: z.array(hookEntrySchema).optional(),
    PreCompact: z.array(hookEntrySchema).optional(),
    PostCompact: z.array(hookEntrySchema).optional(),
    SubagentStart: z.array(hookEntrySchema).optional(),
    SubagentStop: z.array(hookEntrySchema).optional(),
    TurnComplete: z.array(hookEntrySchema).optional(),
    SessionEnd: z.array(hookEntrySchema).optional(),
  })
  // Unknown keys are tolerated for forward compat (future event names).
  .passthrough()

export class HookConfigParseError extends Error {
  constructor(
    message: string,
    public readonly sourceLabel: string,
  ) {
    super(message)
    this.name = 'HookConfigParseError'
  }
}

/** Validate an already-parsed-object form. Used for inline manifest
 *  configs and for the body of hooks.json after JSON.parse. */
export function parseHookConfig(raw: unknown, sourceLabel: string): HookConfig {
  const result = hookConfigSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new HookConfigParseError(`invalid hooks config — ${issues}`, sourceLabel)
  }
  // Strip unknown future keys at the type boundary — passthrough kept
  // them on the runtime object, but our HookConfig type only knows the
  // ten events.
  const known: HookConfig = {}
  for (const k of [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PreCompact',
    'PostCompact',
    'SubagentStart',
    'SubagentStop',
    'TurnComplete',
    'SessionEnd',
  ] as const) {
    const arr = (result.data as Record<string, unknown>)[k]
    if (Array.isArray(arr)) known[k] = arr as HookConfig[typeof k]
  }
  return known
}
