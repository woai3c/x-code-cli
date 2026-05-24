// @x-code-cli/core — Sub-agent type definitions
import type { TokenUsage } from '../../types/index.js'

export interface SubAgentDefinition {
  name: string
  description: string
  /** Markdown body = system prompt for the sub-agent */
  prompt: string
  /** Allowed tools. Omit = default read-only set */
  tools?: string[]
  /** Tools to explicitly deny (applied after `tools`) */
  disallowedTools?: string[]
  /** Model override (e.g. "anthropic:claude-sonnet-4-6"). Omit = inherit parent */
  model?: string
  /** Max agentic turns before forced stop */
  maxTurns: number
  /** Shell commands to deny (keyword matching). Only relevant when shell is in tools */
  shellRestrictions?: string[]
  /** Where this definition came from */
  source: 'built-in' | 'user' | 'project'
  /** When this sub-agent comes from a plugin contribution, the owning
   *  plugin's id (`name@marketplace`). */
  pluginId?: string
}

export interface SubAgentTrace {
  toolCalls: Array<{
    toolName: string
    input: unknown
    result: string
    durationMs: number
    isError: boolean
  }>
  finalText: string
  tokenUsage: TokenUsage
  turnCount: number
}

export type SubAgentEvent =
  | { kind: 'start'; toolCallId: string; agentName: string; description: string; prompt: string }
  | { kind: 'tool-call'; toolCallId: string; subToolName: string; subInput: unknown }
  | {
      kind: 'tool-result'
      toolCallId: string
      subToolName: string
      resultPreview: string
      durationMs: number
      isError: boolean
    }
  | { kind: 'text-delta'; toolCallId: string; delta: string }
  | {
      kind: 'end'
      toolCallId: string
      finalText: string
      tokenUsage: TokenUsage
      turnCount: number
      durationMs: number
      aborted: boolean
    }
