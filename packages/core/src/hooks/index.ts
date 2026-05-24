// @x-code-cli/core — Hooks subsystem public surface
export type {
  DecisionEvent,
  HookConfig,
  HookConfigEntry,
  HookDecision,
  HookEvent,
  HookEventName,
  RegisteredHook,
  SessionContext,
} from './types.js'
export { hookConfigSchema, parseHookConfig, HookConfigParseError } from './config-schema.js'
export { buildVariableContext, expandVariables } from './variables.js'
export type { VariableContext } from './variables.js'
export { executeHook } from './executor.js'
export type { ExecuteHookOptions } from './executor.js'
export { HookRegistry, buildHookRegistry, emptyHookRegistry } from './registry.js'
export { HookBus, emptyHookBus, aggregatePreToolUse, aggregatePostToolUse, aggregateUserPromptSubmit } from './bus.js'
export type { EmitOptions, PreToolEffect, PostToolEffect, UserPromptEffect } from './bus.js'
