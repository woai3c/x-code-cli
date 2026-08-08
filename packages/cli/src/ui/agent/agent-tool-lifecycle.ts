import { TOOL_SEARCH_TOOL_NAME } from '@x-code-cli/core'
import type { AgentCallbacks, DisplayMessage, DisplayToolCall, EditDiffPayload } from '@x-code-cli/core'

import { isCollapsibleReadOnlyTool } from '../utils.js'
import { previewSubInput } from './use-agent-display.js'
import type { AgentState } from './use-agent.js'

interface MutableRef<T> {
  current: T
}

type PendingTool = { toolName: string; input: Record<string, unknown>; startedAt: number }
type StateUpdate = AgentState | ((previous: AgentState) => AgentState)

export interface ToolLifecycleDependencies {
  setState: (update: StateUpdate) => void
  flushBuffer: () => void
  pendingToolsRef: MutableRef<Map<string, PendingTool>>
  pendingEditDiffsRef: MutableRef<Map<string, EditDiffPayload>>
  now?: () => number
}

export type ToolLifecycleCallbacks = Pick<
  AgentCallbacks,
  'onToolCall' | 'onToolProgress' | 'onFileEdit' | 'onToolResult' | 'onSubAgentEvent' | 'onShellOutput'
>

export type GoalToolLifecycleCallbacks = Pick<AgentCallbacks, 'onToolCall' | 'onToolProgress' | 'onToolResult'>

function createToolProgressCallback(setState: ToolLifecycleDependencies['setState']): AgentCallbacks['onToolProgress'] {
  return (toolCallId, message) => {
    setState((previous) => {
      const index = previous.activeToolCalls.findIndex((tool) => tool.id === toolCallId)
      if (index < 0) return previous
      const activeToolCalls = previous.activeToolCalls.slice()
      activeToolCalls[index] = { ...activeToolCalls[index], progress: message }
      return { ...previous, activeToolCalls }
    })
  }
}

function createCompletedToolMessage(
  pending: PendingTool | undefined,
  result: string,
  isError: boolean | undefined,
  durationMs: number,
  now: () => number,
  editPayload?: EditDiffPayload,
): DisplayMessage {
  const toolCall: DisplayToolCall = {
    id: `tc-${now()}`,
    toolName: pending?.toolName ?? 'unknown',
    input: pending?.input ?? {},
    output: result,
    status: isError ? 'error' : 'completed',
    durationMs,
    ...(editPayload ? { editPayload } : {}),
  }
  return {
    id: `tool-${now()}`,
    role: 'assistant',
    content: '',
    toolCalls: [toolCall],
    timestamp: now(),
  }
}

export function createToolLifecycleCallbacks({
  setState,
  flushBuffer,
  pendingToolsRef,
  pendingEditDiffsRef,
  now = Date.now,
}: ToolLifecycleDependencies): ToolLifecycleCallbacks {
  const onToolProgress = createToolProgressCallback(setState)

  return {
    onToolCall: (toolCallId, toolName, input) => {
      flushBuffer()
      pendingToolsRef.current.set(toolCallId, { toolName, input, startedAt: now() })

      // toolSearch is an internal deferred-tool loader. Keep it out of both
      // the live tool list and scrollback while retaining its pending record
      // so onToolResult can identify and discard the matching result.
      if (toolName === TOOL_SEARCH_TOOL_NAME) return

      const isReadOnly = isCollapsibleReadOnlyTool(toolName)
      setState((previous) => ({
        ...previous,
        activeToolCalls: [...previous.activeToolCalls, { id: toolCallId, toolName, input }],
        bufferingReads: isReadOnly,
      }))
    },
    onToolProgress,
    onFileEdit: (toolCallId, payload) => {
      pendingEditDiffsRef.current.set(toolCallId, payload)
    },
    onToolResult: (toolCallId, result, isError) => {
      const pending = pendingToolsRef.current.get(toolCallId)
      pendingToolsRef.current.delete(toolCallId)
      const editPayload = pendingEditDiffsRef.current.get(toolCallId)
      pendingEditDiffsRef.current.delete(toolCallId)

      if (pending?.toolName === TOOL_SEARCH_TOOL_NAME) return

      const durationMs = pending ? now() - pending.startedAt : 0
      setState((previous) => {
        const message = createCompletedToolMessage(pending, result, isError, durationMs, now, editPayload)
        return {
          ...previous,
          activeToolCalls: previous.activeToolCalls.filter((tool) => tool.id !== toolCallId),
          shellOutput: '',
          messages: [...previous.messages, message],
        }
      })
    },
    onSubAgentEvent: (event) => {
      if (event.kind === 'tool-call') {
        setState((previous) => {
          const index = previous.activeToolCalls.findIndex((tool) => tool.id === event.toolCallId)
          if (index < 0) return previous
          const tool = previous.activeToolCalls[index]!
          const label = `${event.subToolName}: ${previewSubInput((event.subInput as Record<string, unknown>) ?? {})}`
          const history = [...(tool.subToolHistory ?? []), label]
          const activeToolCalls = previous.activeToolCalls.slice()
          activeToolCalls[index] = { ...tool, progress: label, subToolHistory: history }
          return { ...previous, activeToolCalls }
        })
      }
      if (event.kind === 'end') {
        const turnInfo = `${event.turnCount}t`
        const tokenInfo =
          event.tokenUsage.totalTokens > 1000
            ? `${(event.tokenUsage.totalTokens / 1000).toFixed(1)}k tok`
            : `${event.tokenUsage.totalTokens} tok`
        const durationInfo =
          event.durationMs > 1000 ? `${(event.durationMs / 1000).toFixed(1)}s` : `${event.durationMs}ms`
        onToolProgress(event.toolCallId, `Done (${turnInfo}, ${tokenInfo}, ${durationInfo})`)
      }
    },
    onShellOutput: (chunk) => {
      setState((previous) => ({ ...previous, shellOutput: previous.shellOutput + chunk }))
    },
  }
}

export function createGoalToolLifecycleCallbacks({
  setState,
  flushBuffer,
  pendingToolsRef,
  now = Date.now,
}: Omit<ToolLifecycleDependencies, 'pendingEditDiffsRef'>): GoalToolLifecycleCallbacks {
  const onToolProgress = createToolProgressCallback(setState)

  return {
    onToolCall: (toolCallId, toolName, input) => {
      flushBuffer()
      pendingToolsRef.current.set(toolCallId, { toolName, input, startedAt: now() })
      setState((previous) => ({
        ...previous,
        activeToolCalls: [...previous.activeToolCalls, { id: toolCallId, toolName, input }],
      }))
    },
    onToolProgress,
    onToolResult: (toolCallId, result, isError) => {
      const pending = pendingToolsRef.current.get(toolCallId)
      pendingToolsRef.current.delete(toolCallId)
      const durationMs = pending ? now() - pending.startedAt : 0

      setState((previous) => {
        const message = createCompletedToolMessage(pending, result, isError, durationMs, now)
        return {
          ...previous,
          activeToolCalls: previous.activeToolCalls.filter((tool) => tool.id !== toolCallId),
          messages: [...previous.messages, message],
        }
      })
    },
  }
}
