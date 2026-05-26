// @x-code-cli/core — Sub-agent runner
//
// Executes a sub-agent as a nested agentLoop with isolated context.
// The parent agent receives only the final text result; intermediate
// tool calls and messages stay inside the child loop.
import type { LanguageModel } from 'ai'

import { resolveModelId } from '../../config/index.js'
import type { HookBus } from '../../hooks/bus.js'
import type { HookEvent } from '../../hooks/types.js'
import type { AgentCallbacks, AgentOptions, TokenUsage } from '../../types/index.js'
import { debugLog } from '../../utils.js'
import { createLoopState } from '../loop-state.js'
import type { LoopState } from '../loop-state.js'
import { agentLoop } from '../loop.js'
import { buildSubAgentSystemPrompt } from '../system-prompt.js'
import type { SubAgentRegistry } from './registry.js'
import type { SubAgentDefinition } from './types.js'

/** Fire a SubagentStart / SubagentStop hook. Best effort — sub-agent
 *  invocation is mandatory once the parent decides to delegate, so hook
 *  failures and aborts must never bubble. */
function emitSubAgentHook(
  bus: HookBus | undefined,
  event: HookEvent & { name: 'SubagentStart' | 'SubagentStop' },
  signal: AbortSignal | undefined,
): void {
  if (!bus?.has(event.name)) return
  void bus.emit(event, { signal }).catch((err) => debugLog(`agent.hook-${event.name.toLowerCase()}-error`, String(err)))
}

export interface RunSubAgentArgs {
  parentState: LoopState
  parentOptions: AgentOptions
  callbacks: AgentCallbacks
  toolCallId: string
  agentName: string
  description: string
  prompt: string
  knowledgeContext: string
  isGitRepo: boolean
}

export interface RunSubAgentResult {
  resultText: string
  tokenUsage: TokenUsage
  turnCount: number
  toolCallCount: number
  durationMs: number
  aborted: boolean
}

/** Extract the last assistant text from a message array (skipping tool-call parts). */
function extractFinalText(messages: LoopState['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'assistant') continue
    const content = msg.content
    if (typeof content === 'string') return content.trim()
    if (Array.isArray(content)) {
      const textParts = (content as Array<{ type?: string; text?: string }>)
        .filter((p) => p?.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
      const joined = textParts.join('').trim()
      if (joined) return joined
    }
  }
  return ''
}

function resolveSubModel(
  agentDef: SubAgentDefinition,
  parentOptions: AgentOptions,
  parentModel: LanguageModel,
): LanguageModel {
  if (!agentDef.model) return parentModel
  if (!parentOptions.modelRegistry) return parentModel

  const resolvedId = resolveModelId(agentDef.model)
  if (!resolvedId) return parentModel

  try {
    return parentOptions.modelRegistry.languageModel(resolvedId as `${string}:${string}`)
  } catch {
    debugLog('sub-agent.model', `Failed to resolve model "${agentDef.model}", falling back to parent model`)
    return parentModel
  }
}

function buildToolFilter(agentDef: SubAgentDefinition, parentPermissionMode: string) {
  const deny = [...(agentDef.disallowedTools ?? []), 'task']

  // In plan mode, deny write tools for general-purpose agent
  if (parentPermissionMode === 'plan' && agentDef.name === 'general-purpose') {
    deny.push('writeFile', 'edit')
  }

  // `'*'` is a wildcard meaning "every tool" — matches Claude Code's
  // `tools: ['*']` semantics for built-in/general-purpose agents. Pass
  // `undefined` so `buildTools` skips the allowlist filter and only the
  // explicit deny list applies. Without this, `['*']` would be treated
  // as a literal tool name and every real tool would be filtered out.
  const allow = agentDef.tools?.includes('*') ? undefined : agentDef.tools

  return {
    allow,
    deny,
  }
}

/** Resolve the model to use for the sub-agent. Need the actual LanguageModel
 *  instance from the parent since we pass it to agentLoop. */
export async function runSubAgent(args: RunSubAgentArgs, parentModel: LanguageModel): Promise<RunSubAgentResult> {
  const {
    parentState,
    parentOptions,
    callbacks,
    toolCallId,
    agentName,
    description,
    prompt,
    knowledgeContext,
    isGitRepo,
  } = args
  const startTime = Date.now()

  const registry = parentOptions.subAgentRegistry as SubAgentRegistry | undefined
  if (!registry) {
    return {
      resultText: '[Sub-agent system not initialized]',
      tokenUsage: zeroUsage(),
      turnCount: 0,
      toolCallCount: 0,
      durationMs: 0,
      aborted: false,
    }
  }

  const agentDef = registry.get(agentName)
  if (!agentDef) {
    const available = registry.names().join(', ')
    return {
      resultText: `[Sub-agent '${agentName}' not found. Available: ${available}]`,
      tokenUsage: zeroUsage(),
      turnCount: 0,
      toolCallCount: 0,
      durationMs: 0,
      aborted: false,
    }
  }

  // Notify UI
  callbacks.onSubAgentEvent?.({
    kind: 'start',
    toolCallId,
    agentName,
    description,
    prompt,
  })

  // Plugin hook: SubagentStart — fires after the agent definition is
  // resolved but before the nested agentLoop runs. Best-effort.
  emitSubAgentHook(
    parentOptions.hookBus,
    {
      name: 'SubagentStart',
      session: { cwd: process.cwd(), modelId: parentOptions.modelId },
      agent: { name: agentName, description, prompt },
    },
    parentOptions.abortSignal,
  )

  const subModel = resolveSubModel(agentDef, parentOptions, parentModel)
  const subModelId = agentDef.model ? (resolveModelId(agentDef.model) ?? parentOptions.modelId) : parentOptions.modelId

  const subSystemPrompt = buildSubAgentSystemPrompt({
    agentPrompt: agentDef.prompt,
    knowledgeContext,
    isGitRepo,
  })

  const subState = createLoopState('default')
  subState.systemPromptCache = subSystemPrompt

  const toolFilter = buildToolFilter(agentDef, parentState.permissionMode)

  const subOptions: AgentOptions = {
    ...parentOptions,
    modelId: subModelId,
    maxTurns: agentDef.maxTurns,
    toolFilter,
    abortSignal: parentOptions.abortSignal,
    permissionMode: 'default',
    printMode: false,
    // Sub-agents don't get their own sub-agent registry — recursion is forbidden
    subAgentRegistry: undefined,
  }

  // Build sub-agent callbacks: forward events to the parent UI via onSubAgentEvent,
  // but don't mix child state into parent state directly.
  const subCallbacks: AgentCallbacks = {
    onTextDelta: (delta) => {
      callbacks.onSubAgentEvent?.({ kind: 'text-delta', toolCallId, delta })
    },
    onToolCall: (_subToolCallId, subToolName, subInput) => {
      callbacks.onSubAgentEvent?.({
        kind: 'tool-call',
        toolCallId,
        subToolName,
        subInput,
      })
      // Also forward to parent's onToolProgress so the live indicator updates
      callbacks.onToolProgress(toolCallId, `${subToolName}: ${previewInput(subInput)}`)
    },
    onToolProgress: (_subToolCallId, message) => {
      callbacks.onToolProgress(toolCallId, message)
    },
    onToolResult: (subToolCallId, result, isError) => {
      const preview = result.length > 200 ? result.slice(0, 197) + '...' : result
      callbacks.onSubAgentEvent?.({
        kind: 'tool-result',
        toolCallId,
        subToolName: subToolCallId,
        resultPreview: preview,
        durationMs: 0,
        isError: isError ?? false,
      })
    },
    onFileEdit: callbacks.onFileEdit,
    onAskPermission: callbacks.onAskPermission,
    onAskUser: callbacks.onAskUser,
    onPlanApprovalRequest: callbacks.onPlanApprovalRequest,
    onPlanModeChange: () => {},
    onTodosUpdate: () => {},
    onShellOutput: callbacks.onShellOutput,
    onUsageUpdate: () => {},
    onContextCompressed: () => {},
    onError: (error) => {
      debugLog('sub-agent.error', `${agentName}: ${error.message}`)
    },
  }

  try {
    const { state: finalSubState, turnCount } = await agentLoop(prompt, subModel, subOptions, subCallbacks, subState)

    const finalText = extractFinalText(finalSubState.messages)
    const toolUseCount = countToolCalls(finalSubState.messages)

    // Accumulate sub-agent token usage into parent
    parentState.tokenUsage.inputTokens += finalSubState.tokenUsage.inputTokens
    parentState.tokenUsage.outputTokens += finalSubState.tokenUsage.outputTokens
    parentState.tokenUsage.totalTokens = parentState.tokenUsage.inputTokens + parentState.tokenUsage.outputTokens
    parentState.tokenUsage.cacheReadTokens += finalSubState.tokenUsage.cacheReadTokens
    parentState.tokenUsage.cacheCreationTokens += finalSubState.tokenUsage.cacheCreationTokens
    callbacks.onUsageUpdate(parentState.tokenUsage)

    const durationMs = Date.now() - startTime
    const resultText = finalText || '[Sub-agent completed without producing a final response]'

    callbacks.onSubAgentEvent?.({
      kind: 'end',
      toolCallId,
      finalText: resultText,
      tokenUsage: finalSubState.tokenUsage,
      turnCount,
      durationMs,
      aborted: false,
    })

    emitSubAgentHook(
      parentOptions.hookBus,
      {
        name: 'SubagentStop',
        session: { cwd: process.cwd(), modelId: parentOptions.modelId },
        agent: { name: agentName, description },
        durationMs,
        outcome: 'completed',
        tokenUsage: {
          inputTokens: finalSubState.tokenUsage.inputTokens,
          outputTokens: finalSubState.tokenUsage.outputTokens,
          totalTokens: finalSubState.tokenUsage.totalTokens,
        },
      },
      parentOptions.abortSignal,
    )

    if (turnCount >= agentDef.maxTurns && !finalText) {
      // finalText is guaranteed empty here (the !finalText branch) and the
      // messages array hasn't been mutated since line 246's call, so the
      // partial-output value can only ever be 'none' on this path.
      return {
        resultText: `[Sub-agent reached max turns (${agentDef.maxTurns}) without finishing. Partial output: none]`,
        tokenUsage: finalSubState.tokenUsage,
        turnCount,
        toolCallCount: toolUseCount,
        durationMs,
        aborted: false,
      }
    }

    return {
      resultText: `<task_result>\n${resultText}\n</task_result>`,
      tokenUsage: finalSubState.tokenUsage,
      turnCount,
      toolCallCount: toolUseCount,
      durationMs,
      aborted: false,
    }
  } catch (err) {
    const durationMs = Date.now() - startTime

    // agentLoop catches abort/error internally and returns normally with
    // an outcome marker, so this catch only fires when something throws
    // past those guards (usually setup-phase code: knowledge load, slug
    // generation, etc.). At that point the sub-agent hasn't really
    // executed any turns, so reporting 0 is honest.
    const fallbackTurnCount = 0

    if (isAbortError(err, parentOptions.abortSignal)) {
      const partial = extractFinalText(subState.messages)
      const text = partial
        ? `[Sub-agent interrupted by user]\n\nPartial output:\n${partial}`
        : '[Sub-agent interrupted by user]'
      const toolUseCount = countToolCalls(subState.messages)

      callbacks.onSubAgentEvent?.({
        kind: 'end',
        toolCallId,
        finalText: text,
        tokenUsage: subState.tokenUsage,
        turnCount: fallbackTurnCount,
        durationMs,
        aborted: true,
      })

      emitSubAgentHook(
        parentOptions.hookBus,
        {
          name: 'SubagentStop',
          session: { cwd: process.cwd(), modelId: parentOptions.modelId },
          agent: { name: agentName, description },
          durationMs,
          outcome: 'aborted',
        },
        parentOptions.abortSignal,
      )

      return {
        resultText: text,
        tokenUsage: subState.tokenUsage,
        turnCount: fallbackTurnCount,
        toolCallCount: toolUseCount,
        durationMs,
        aborted: true,
      }
    }

    const message = err instanceof Error ? err.message : String(err)
    debugLog('sub-agent.crash', `${agentName}: ${message}`)
    const toolUseCount = countToolCalls(subState.messages)

    callbacks.onSubAgentEvent?.({
      kind: 'end',
      toolCallId,
      finalText: `[Sub-agent failed: ${message}]`,
      tokenUsage: subState.tokenUsage,
      turnCount: fallbackTurnCount,
      durationMs,
      aborted: false,
    })

    emitSubAgentHook(
      parentOptions.hookBus,
      {
        name: 'SubagentStop',
        session: { cwd: process.cwd(), modelId: parentOptions.modelId },
        agent: { name: agentName, description },
        durationMs,
        outcome: 'failed',
      },
      parentOptions.abortSignal,
    )

    return {
      resultText: `[Sub-agent failed: ${message}]`,
      tokenUsage: subState.tokenUsage,
      turnCount: fallbackTurnCount,
      toolCallCount: toolUseCount,
      durationMs,
      aborted: false,
    }
  }
}

function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (/aborted|AbortError/i.test(err.message)) return true
  }
  return false
}

function zeroUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    currentContextTokens: 0,
  }
}

function countToolCalls(messages: LoopState['messages']): number {
  let count = 0
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string }>) {
      if (part?.type === 'tool-call') count++
    }
  }
  return count
}

function previewInput(input: Record<string, unknown>): string {
  const val =
    (input.filePath as string) ??
    (input.command as string) ??
    (input.pattern as string) ??
    (input.query as string) ??
    (input.dirPath as string) ??
    ''
  return val.length > 80 ? val.slice(0, 77) + '...' : val
}
