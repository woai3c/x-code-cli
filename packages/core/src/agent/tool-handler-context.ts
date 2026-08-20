import type { ToolHookSnapshot } from '../hooks/bus.js'
import type { PreparedPeerSend } from '../peers/service.js'
import type { PreparedShellRequest, ShellHookOrigin } from '../tools/shell-session/types.js'
import type { AgentCallbacks, AgentOptions, LanguageModel } from '../types/index.js'
import type { LoopState } from './loop-state.js'
import type { ToolImage } from './messages.js'
import type { SubAgentLoopRunner } from './sub-agents/runner.js'

export interface ToolExecutionControl {
  stopTurn: boolean
}

/** Mutable per-call context shared by permission, preparation, and dispatch stages. */
export interface ToolHandlerContext {
  toolName: string
  input: Record<string, unknown>
  toolCallId: string
  state: LoopState
  options: AgentOptions
  callbacks: AgentCallbacks
  parentModel: LanguageModel
  runSubAgentLoop?: SubAgentLoopRunner
  control: ToolExecutionControl
  authorityApprovedOnce?: boolean
  preparedPeerSend?: PreparedPeerSend
  effectiveCwd?: string
  preparedShell?: PreparedShellRequest
  shellHookSnapshot?: ToolHookSnapshot
  shellPreToolUse?: ShellHookOrigin['preToolUse']
}

export type ToolHandler = (context: ToolHandlerContext) => Promise<void>

export type PushToolResult = (
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
  isError?: boolean,
  images?: readonly ToolImage[],
  notifyUi?: boolean,
) => void
