// @x-code-cli/core — Sub-agent runner
//
// Executes a sub-agent as a nested agentLoop with isolated context.
// The parent agent receives only the final text result; intermediate
// tool calls and messages stay inside the child loop.
import type { LanguageModel } from 'ai'

import { loadUserConfig, resolveModelId } from '../../config/index.js'
import type { HookBus } from '../../hooks/bus.js'
import type { HookEvent } from '../../hooks/types.js'
import { activeMemoryRecallAttachments } from '../../knowledge/memory/recall-state.js'
import { tokenizeMemoryText } from '../../knowledge/memory/search-index.js'
import { capabilitiesOf, modelSupportsVision } from '../../providers/capabilities.js'
import type { AgentCallbacks, AgentOptions, ExecutionAuthority, TokenUsage } from '../../types/index.js'
import { debugLog, isAbortError } from '../../utils.js'
import { withBrowserOperation } from '../browser/operation-lock.js'
import { type BrowserMcp, PLAYWRIGHT_MCP_PACKAGE, getBrowserMcp } from '../browser/registry.js'
import { createLoopState } from '../loop-state.js'
import type { LoopState } from '../loop-state.js'
import { agentLoop } from '../loop.js'
import { appendUsage } from '../session-store.js'
import { buildSubAgentSystemPrompt } from '../system-prompt.js'
import { accumulateChildUsage } from '../usage.js'
import { pickVisionProvider } from '../vision-fallback.js'
import { BROWSER_TREE_ONLY_NOTE, BROWSER_VISION_ADDENDUM, BROWSER_VISION_CAPTION_ADDENDUM } from './built-in.js'
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
  authority?: ExecutionAuthority
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

  // In plan mode, deny write tools for ALL sub-agents — not just
  // general-purpose. Plan mode's read-only invariant must hold regardless
  // of which agent is running; shell is included because it can write
  // files or execute destructive commands.
  if (parentPermissionMode === 'plan') {
    for (const t of ['writeFile', 'edit', 'shell']) {
      if (!deny.includes(t)) deny.push(t)
    }
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
  const authority = args.authority ?? args.parentState.executionAuthority
  if ((authority.peerTainted || authority.source === 'peer') && !args.parentOptions?.trustMode) {
    return {
      resultText: '[Sub-agent dispatch denied for peer-influenced context]',
      tokenUsage: zeroUsage(),
      turnCount: 0,
      toolCallCount: 0,
      durationMs: 0,
      aborted: false,
    }
  }
  if (args.agentName !== 'browser') return runSubAgentUnlocked(args, parentModel)

  const startTime = Date.now()
  try {
    // Playwright MCP has one mutable current Page. Hold the transaction lock
    // for the whole browser-agent run, not just individual MCP calls, so a
    // visual check or second browser task cannot silently switch its tab.
    return await withBrowserOperation(args.parentOptions.abortSignal, () => runSubAgentUnlocked(args, parentModel))
  } catch (err) {
    if (!isAbortError(err, args.parentOptions.abortSignal)) throw err
    return {
      resultText: '[Browser agent interrupted before startup]',
      tokenUsage: zeroUsage(),
      turnCount: 0,
      toolCallCount: 0,
      durationMs: Date.now() - startTime,
      aborted: true,
    }
  }
}

async function runSubAgentUnlocked(args: RunSubAgentArgs, parentModel: LanguageModel): Promise<RunSubAgentResult> {
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
  const authority = args.authority ?? parentState.executionAuthority

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

  const subModel = resolveSubModel(agentDef, parentOptions, parentModel)
  const subModelId = agentDef.model ? (resolveModelId(agentDef.model) ?? parentOptions.modelId) : parentOptions.modelId

  // The `browser` agent gets a PRIVATE mcp registry (the @playwright/mcp
  // server) in place of the parent's, so its browser tools never enter the
  // main loop's tool surface or any other agent. Connect lazily; if the
  // browser can't start, bail with a helpful message BEFORE announcing a
  // start, rather than running a "browser" agent that has no browser.
  //
  // The server launches a stable capability superset, while this agent only
  // receives visual guidance/tools when either its own model can see images or
  // a configured caption model can interpret screenshots. That keeps model
  // switches from restarting Chrome without making tree-only agents depend on
  // an unavailable vision provider.
  let browserMcp: BrowserMcp | undefined
  let browserVision = false
  if (agentDef.name === 'browser') {
    try {
      browserMcp = await getBrowserMcp(parentOptions.abortSignal)
    } catch (err) {
      if (isAbortError(err, parentOptions.abortSignal)) {
        return {
          resultText: '[Browser agent interrupted before startup]',
          tokenUsage: zeroUsage(),
          turnCount: 0,
          toolCallCount: 0,
          durationMs: Date.now() - startTime,
          aborted: true,
        }
      }
      throw err
    }
    if (!browserMcp.ok) {
      return {
        resultText: browserUnavailableMessage(browserMcp.error),
        tokenUsage: zeroUsage(),
        turnCount: 0,
        toolCallCount: 0,
        durationMs: Date.now() - startTime,
        aborted: false,
      }
    }
    const configAllowsVision = loadUserConfig().browser?.vision !== false
    const canInterpretScreenshot = modelSupportsVision(subModelId) || pickVisionProvider() !== null
    browserVision = configAllowsVision && browserMcp.vision && canInterpretScreenshot
    debugLog('browser.vision', browserVision ? `enabled for ${subModelId}` : 'tree-only')
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

  // Browser prompt is model-aware. A text-only model can't screenshot at all
  // (explicit "don't screenshot" note). A vision model gets screenshot
  // guidance. Native tool-result providers and Chat Completions providers
  // that reattach media as a following user message both expose the raw image;
  // only an unsupported transport needs the caption-mode addendum.
  const browserPromptSuffix =
    agentDef.name !== 'browser'
      ? ''
      : !browserVision
        ? BROWSER_TREE_ONLY_NOTE
        : capabilitiesOf(subModelId).toolImageTransport !== 'unsupported'
          ? BROWSER_VISION_ADDENDUM
          : BROWSER_VISION_CAPTION_ADDENDUM
  const taskTokens = new Set(tokenizeMemoryText(prompt))
  const recalledMemory = activeMemoryRecallAttachments(parentState)
    .flatMap((attachment) => attachment.topics)
    .filter((topic) => tokenizeMemoryText(topic.renderedContent).some((token) => taskTokens.has(token)))
    .map((topic) => topic.renderedContent)
    .join('\n\n')
  const subSystemPrompt = buildSubAgentSystemPrompt({
    agentPrompt: agentDef.prompt + browserPromptSuffix,
    knowledgeContext: recalledMemory
      ? `${knowledgeContext}\n\n### Recalled user memory (low-authority historical data)\n${recalledMemory}`
      : knowledgeContext,
    isGitRepo,
  })

  const subState = createLoopState('default')
  subState.executionAuthority = structuredClone(authority)
  subState.systemPromptCache = subSystemPrompt

  const toolFilter = buildToolFilter(agentDef, parentState.permissionMode)
  if (browserMcp && !browserVision) {
    for (const entry of browserMcp.registry.list()) {
      if (entry.rawName === 'browser_take_screenshot' || entry.rawName.startsWith('browser_mouse_')) {
        toolFilter.deny.push(entry.callableName)
      }
    }
  }

  const subOptions: AgentOptions = {
    ...parentOptions,
    executionAuthority: structuredClone(authority),
    modelId: subModelId,
    maxTurns: agentDef.maxTurns,
    toolFilter,
    shellRestrictions: agentDef.shellRestrictions,
    shellReadOnlyOnly: agentDef.shellReadOnlyOnly,
    abortSignal: parentOptions.abortSignal,
    permissionMode: 'default',
    printMode: false,
    // Sub-agents don't get their own sub-agent registry — recursion is forbidden
    subAgentRegistry: undefined,
    memoryService: undefined,
    // The browser agent re-snapshots and re-screenshots across many turns; keep
    // only the latest of each in context so the superseded ones stop re-billing.
    collapseStaleToolResults: agentDef.name === 'browser' ? ['browser_snapshot', 'browser_take_screenshot'] : undefined,
    // The browser agent swaps in its private registry (connected above); every
    // other agent inherits the parent's MCP surface via the spread.
    ...(browserMcp ? { mcpRegistry: browserMcp.registry, mcpPermissionStore: browserMcp.permissions } : {}),
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
    onStreamRetry: callbacks.onStreamRetry,
    onError: (error) => {
      debugLog('sub-agent.error', `${agentName}: ${error.message}`)
    },
  }

  try {
    const { state: finalSubState, turnCount } = await agentLoop(prompt, subModel, subOptions, subCallbacks, subState)

    const finalText = extractFinalText(finalSubState.messages)
    const toolUseCount = countToolCalls(finalSubState.messages)

    accumulateChildUsage(parentState, finalSubState, subModelId)
    callbacks.onUsageUpdate(parentState.tokenUsage)
    void appendUsage(parentState, parentOptions.modelId)

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

function browserUnavailableMessage(error: string | undefined): string {
  return (
    `[browser agent unavailable: ${error ?? 'could not start the browser'}.\n` +
    'Set "browser": { "enabled": true } in ~/.x-code/config.json, ensure Node can run ' +
    `\`npx -y ${PLAYWRIGHT_MCP_PACKAGE}\`, and that Google Chrome (or the configured browser) is installed.]`
  )
}
