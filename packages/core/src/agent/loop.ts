// @x-code-cli/core — Agent Loop (core logic: streaming, tool calls, permission, context compression)
import { execa } from 'execa'

import fs from 'node:fs/promises'
import path from 'node:path'

import { generateText, streamText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import { buildKnowledgeContext, loadRuleFiles } from '../knowledge/loader.js'
import { generateSessionSummary, saveSessionSummary } from '../knowledge/session.js'
import { checkPermission } from '../permissions/index.js'
import { toolRegistry, truncateToolResult } from '../tools/index.js'
import { getShellConfig } from '../tools/shell-utils.js'
import type { AgentCallbacks, AgentOptions, TokenUsage } from '../types/index.js'
import { toolResultMessage } from './messages.js'
import { ensurePlansDir, generatePlanId, getPlanPath } from './plan-mode.js'
import { buildSystemPrompt } from './system-prompt.js'

/** Minimal shape of what we use from streamText() result — avoids complex generic propagation */
interface StreamResult {
  fullStream: AsyncIterable<{
    type: string
    text?: string
    toolName?: string
    input?: unknown
    output?: unknown
    toolCallId?: string
  }>
  response: Promise<{ messages: ModelMessage[] }>
  usage: Promise<{ inputTokens?: number; outputTokens?: number } | undefined>
  finishReason: Promise<string>
  toolCalls: Promise<
    Array<{
      toolName: string
      toolCallId: string
      input: Record<string, unknown>
    }>
  >
}

const KEEP_RECENT = 6
/**
 * Compress context when the previous turn's real input-token count (reported
 * by the model API) exceeds this fraction of the model's context window. We
 * intentionally use real usage, not a char-based estimate, because estimates
 * drift badly — tool output and non-ASCII text blow them up.
 */
const COMPRESSION_TRIGGER_RATIO = 0.8

/** Count occurrences of a substring without creating intermediate arrays */
function countOccurrences(content: string, search: string): number {
  let count = 0
  let pos = 0
  while ((pos = content.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}

/**
 * Ensure all assistant messages have a reasoning content part.
 *
 * DeepSeek Reasoner requires the `reasoning_content` field on every assistant
 * message during tool-call chains.  The upstream `@ai-sdk/deepseek` converter
 * sets `reasoning_content: undefined` when no reasoning part exists, and
 * `JSON.stringify` strips `undefined` values — causing the DeepSeek API to
 * reject the request with a 400 "Missing reasoning_content" error.
 *
 * This helper injects an empty `{ type: 'reasoning', text: '' }` part into any
 * assistant message that lacks one, so the converter always produces
 * `"reasoning_content": ""` in the JSON body.
 */
function ensureReasoningContentParts(messages: ModelMessage[], modelId: string): void {
  if (!modelId.includes('deepseek-reasoner')) return

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue

    const content = msg.content
    if (!Array.isArray(content)) continue

    const hasReasoning = (content as Array<{ type: string }>).some((p) => p.type === 'reasoning')
    if (!hasReasoning) {
      // Prepend an empty reasoning part so the converter produces `reasoning_content: ""`
      ;(content as Array<{ type: string; text?: string }>).unshift({ type: 'reasoning', text: '' })
    }
  }
}

/** Context window sizes per model (tokens). Falls back to provider default, then 128k. */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  'anthropic:claude-opus-4-6': 200000,
  'anthropic:claude-sonnet-4-5': 200000,
  'anthropic:claude-haiku-4-5': 200000,
  // OpenAI
  'openai:gpt-4.1': 1047576,
  'openai:gpt-4.1-mini': 1047576,
  'openai:gpt-4.1-nano': 1047576,
  'openai:o3': 200000,
  'openai:o4-mini': 200000,
  // Google
  'google:gemini-2.5-pro': 1000000,
  'google:gemini-2.5-flash': 1000000,
  // DeepSeek
  'deepseek:deepseek-chat': 64000,
  'deepseek:deepseek-reasoner': 64000,
  // Alibaba
  'alibaba:qwen-max': 128000,
  'alibaba:qwen-plus': 128000,
  // xAI
  'xai:grok-3': 131072,
  'xai:grok-3-mini': 131072,
  // Zhipu
  'zhipu:glm-4-plus': 128000,
  // Moonshot
  'moonshotai:kimi-k2.5': 131072,
}

/** Provider-level fallback context windows */
const PROVIDER_CONTEXT_WINDOWS: Record<string, number> = {
  anthropic: 200000,
  openai: 128000,
  google: 1000000,
  deepseek: 64000,
  alibaba: 128000,
  xai: 128000,
  zhipu: 128000,
  moonshotai: 128000,
}

function getCompressionThreshold(modelId: string): number {
  const contextWindow = MODEL_CONTEXT_WINDOWS[modelId] ?? PROVIDER_CONTEXT_WINDOWS[modelId.split(':')[0]] ?? 128000
  return Math.floor(contextWindow * COMPRESSION_TRIGGER_RATIO)
}

export interface LoopState {
  messages: ModelMessage[]
  tokenUsage: TokenUsage
  /** Real input-token count from the most recent API response, used to trigger compression. */
  lastInputTokens: number
  planMode: boolean
  planId: string | null
  sessionId: string
  startedAt: string
  filesModified: Set<string>
  turnCount: number
}

/** Execute a write tool (writeFile / edit) */
async function executeWriteTool(toolName: string, input: Record<string, unknown>): Promise<string> {
  if (toolName === 'writeFile') {
    const filePath = input.filePath as string
    const content = input.content as string
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
    return `File written: ${filePath} (${content.length} characters)`
  }

  if (toolName === 'edit') {
    const filePath = input.filePath as string
    const oldString = input.oldString as string
    const newString = input.newString as string
    const replaceAll = (input.replaceAll as boolean) ?? false

    const content = await fs.readFile(filePath, 'utf-8')
    if (!replaceAll) {
      const count = countOccurrences(content, oldString)
      if (count === 0) return `Error: old_string not found in ${filePath}`
      if (count > 1)
        return `Error: old_string is not unique in ${filePath} (found ${count} occurrences). Provide more context or set replaceAll: true.`
    }

    const newContent = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString)
    await fs.writeFile(filePath, newContent, 'utf-8')
    return `File edited: ${filePath}`
  }

  return 'Error: unknown write tool'
}

/** Execute a shell command with streaming */
async function executeShell(command: string, timeout: number, callbacks: AgentCallbacks): Promise<string> {
  const { executable, args, type } = getShellConfig()

  // On Windows, force the console codepage to UTF-8 (65001) at the OS level
  // BEFORE PowerShell starts parsing the command. This ensures even parse errors
  // (e.g. `&&` on PS 5.1) produce UTF-8 output instead of GBK garbled text.
  // We wrap via `cmd.exe /c "chcp 65001 >nul && powershell ..."` because
  // [Console]::OutputEncoding only takes effect after parsing completes.
  let proc
  if (type === 'powershell') {
    // Build as a single string for cmd.exe /c so redirections like >nul work
    const psCmd = `chcp 65001 >nul && ${executable} ${args.join(' ')} ${command}`
    proc = execa('cmd.exe', ['/c', psCmd], {
      timeout,
      reject: false,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
  } else {
    proc = execa(executable, [...args, command], {
      timeout,
      reject: false,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
  }

  proc.stdout?.on('data', (chunk: Buffer) => {
    callbacks.onShellOutput(chunk.toString())
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    callbacks.onShellOutput(chunk.toString())
  })

  const result = await proc
  return `exit code: ${result.exitCode}\n${result.stdout}\n${result.stderr}`.trim()
}

/** Compress old messages into a summary */
export async function compressMessages(messages: ModelMessage[], model: LanguageModel): Promise<ModelMessage[]> {
  const recent = messages.slice(-KEEP_RECENT)
  const old = messages.slice(0, -KEEP_RECENT)

  if (old.length === 0) return messages

  const { text: summary } = await generateText({
    model,
    system:
      'Summarize the following conversation concisely, preserving key decisions, file changes, and context needed to continue.',
    messages: old,
  })

  return [{ role: 'user', content: `[Previous conversation summary]\n${summary}` }, ...recent]
}

/** Classify API error and return a user-friendly recovery message */
function classifyApiError(err: unknown): { message: string; retryable: boolean } {
  const msg = err instanceof Error ? err.message : String(err)
  const statusMatch = msg.match(/(\d{3})/)
  const status = statusMatch ? Number(statusMatch[1]) : 0

  if (msg.includes('Missing `reasoning_content`') || msg.includes('reasoning_content')) {
    return {
      message:
        'DeepSeek Reasoner requires reasoning_content in assistant messages during tool-call chains. This is usually an SDK compatibility issue — please report it.',
      retryable: false,
    }
  }
  if (msg.includes('API key is missing') || msg.includes('API_KEY')) {
    // Extract provider name from message like "DeepSeek API key API key is missing..."
    const providerMatch = msg.match(/^(\w+)\s+API key/i)
    const provider = providerMatch ? providerMatch[1] : 'Provider'
    return {
      message: `${provider} API key is not set. Please set the corresponding environment variable (e.g. ${provider.toUpperCase()}_API_KEY).`,
      retryable: false,
    }
  }
  if (status === 401 || msg.includes('Unauthorized') || msg.includes('Invalid API Key')) {
    return {
      message: 'API authentication failed (401). Please check your API key with /model or reconfigure with `xc init`.',
      retryable: false,
    }
  }
  if (status === 403 || msg.includes('Forbidden')) {
    return {
      message: 'API access forbidden (403). Your API key may not have permission for this model.',
      retryable: false,
    }
  }
  if (status === 503 || msg.includes('Service Unavailable') || msg.includes('overloaded')) {
    return {
      message: 'Model service unavailable (503). Try switching to a different model with /model.',
      retryable: false,
    }
  }
  if (status === 429 || msg.includes('rate limit') || msg.includes('Rate limit')) {
    return {
      message:
        'Rate limited (429). Waiting for retry... (AI SDK handles exponential backoff automatically with maxRetries: 3)',
      retryable: true, // AI SDK maxRetries handles this
    }
  }
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')) {
    return {
      message: `Network error: ${msg}. Retrying...`,
      retryable: true,
    }
  }
  return { message: msg, retryable: false }
}

/** Helper to push a tool result to state and notify the UI */
function pushToolResult(
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
): void {
  state.messages.push(toolResultMessage(toolCallId, toolName, output))
  callbacks.onToolResult(toolCallId, output)
}

/** Handle all tool calls from a single model turn */
async function handleToolCalls(
  toolCalls: Array<{ toolName: string; toolCallId: string; input: Record<string, unknown> }>,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
): Promise<void> {
  for (const tc of toolCalls) {
    const { toolName, input, toolCallId } = tc
    let output: string

    // ── Plan mode tools ──
    if (toolName === 'enterPlanMode') {
      state.planMode = true
      state.planId = generatePlanId()
      await ensurePlansDir()
      output = `Plan mode activated. Plan ID: ${state.planId}. Use only read-only tools. Save plan to ${getPlanPath(state.planId)}`
      pushToolResult(state, callbacks, toolCallId, toolName, output)
      continue
    }

    if (toolName === 'exitPlanMode') {
      state.planMode = false
      if (state.planId) {
        const planPath = getPlanPath(state.planId)
        try {
          const planContent = await fs.readFile(planPath, 'utf-8')
          output = `Plan ready for review:\n\n${planContent}`
        } catch {
          output = 'Plan mode exited. No plan file found.'
        }
      } else {
        output = 'Plan mode exited.'
      }
      pushToolResult(state, callbacks, toolCallId, toolName, output)
      continue
    }

    // ── askUser tool ──
    if (toolName === 'askUser') {
      const question = input.question as string
      const optionsList = input.options as { label: string; description: string }[]
      const answer = await callbacks.onAskUser(question, optionsList)
      output = `User answered: ${answer}`
      pushToolResult(state, callbacks, toolCallId, toolName, output)
      continue
    }

    // ── Permission check for write tools and shell ──
    if (toolName === 'writeFile' || toolName === 'edit' || toolName === 'shell') {
      const approved = await checkPermission({ toolName, input }, options.trustMode, callbacks.onAskPermission)

      if (!approved) {
        pushToolResult(state, callbacks, toolCallId, toolName, 'Permission denied by user.')
        continue
      }
    }

    // ── Execute tool ──
    try {
      if (toolName === 'writeFile' || toolName === 'edit') {
        output = await executeWriteTool(toolName, input)
        const filePath = input.filePath as string
        state.filesModified.add(filePath)
      } else if (toolName === 'shell') {
        const timeout = (input.timeout as number) ?? 30000
        output = await executeShell(input.command as string, timeout, callbacks)
      } else {
        // Tools with execute (readFile, glob, grep, etc.) are auto-executed by AI SDK
        continue
      }
    } catch (err) {
      output = `Error: ${err instanceof Error ? err.message : String(err)}`
    }

    output = truncateToolResult(output)
    pushToolResult(state, callbacks, toolCallId, toolName, output)
  }
}

/** Main agent loop */
export async function agentLoop(
  userMessage: string,
  model: LanguageModel,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  existingState?: LoopState,
): Promise<LoopState> {
  const state: LoopState = existingState ?? {
    messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    lastInputTokens: 0,
    planMode: false,
    planId: null,
    sessionId: Date.now().toString(36),
    startedAt: new Date().toISOString(),
    filesModified: new Set(),
    turnCount: 0,
  }

  state.messages.push({ role: 'user', content: userMessage })

  // Load rules once — shared between @rule-name resolution and buildKnowledgeContext
  const rules = await loadRuleFiles()

  // Check for @rule-name references in user message
  const ruleRefs = userMessage.match(/@([\w-]+)/g)
  let extraRuleContext = ''
  if (ruleRefs) {
    for (const ref of ruleRefs) {
      const ruleName = ref.slice(1) // remove @
      const rule = rules.find((r) => r.filename === ruleName)
      if (rule) {
        extraRuleContext += `\n\n### Rule: ${rule.filename}\n${rule.content}`
      }
    }
  }

  // Session continuation is handled explicitly by the UI: if the user accepts
  // the resume prompt, the pending work is embedded directly in their first
  // user message. Auto-injecting it into every system prompt made the model
  // treat trivial greetings as "continue exploring", so we no longer do that.
  const knowledgeContext = await buildKnowledgeContext({ rules })
  const fullKnowledgeContext = knowledgeContext + extraRuleContext

  const compressionThreshold = getCompressionThreshold(options.modelId)

  while (state.turnCount < options.maxTurns) {
    state.turnCount++

    // Context compression check — driven by real input-token count from the
    // previous turn, not a char-based estimate. Also saves session summary
    // before compressing.
    if (state.lastInputTokens > compressionThreshold) {
      try {
        const summary = await generateSessionSummary(state.messages, model, state.sessionId, state.startedAt, [
          ...state.filesModified,
        ])
        await saveSessionSummary(summary)
      } catch {
        // Don't block compression on session save failure
      }
      state.messages = await compressMessages(state.messages, model)
      state.lastInputTokens = 0
      callbacks.onContextCompressed('Context compressed to fit context window.')
    }

    const systemPrompt = buildSystemPrompt({
      knowledgeContext: fullKnowledgeContext,
      planMode: state.planMode,
      modelId: options.modelId,
    })

    let result: StreamResult
    try {
      result = streamText({
        model,
        system: systemPrompt,
        messages: state.messages,
        tools: toolRegistry,
        maxRetries: 3,
        abortSignal: options.abortSignal,
      }) as unknown as StreamResult
    } catch (err) {
      const classified = classifyApiError(err)
      callbacks.onError(new Error(classified.message))
      break
    }

    // Stream chunks to UI
    try {
      for await (const chunk of result.fullStream) {
        if (chunk.type === 'text-delta') {
          callbacks.onTextDelta(chunk.text ?? '')
        }
        if (chunk.type === 'tool-call') {
          callbacks.onToolCall(chunk.toolName ?? '', (chunk.input ?? {}) as Record<string, unknown>)
        }
        // Notify UI about auto-executed tool results (readFile, glob, grep, etc.)
        if (chunk.type === 'tool-result') {
          const raw = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output ?? '')
          const truncated = truncateToolResult(raw)
          callbacks.onToolResult(chunk.toolCallId ?? '', truncated)
        }
      }
    } catch (err) {
      const classified = classifyApiError(err)
      callbacks.onError(new Error(classified.message))
      if (!classified.retryable) break
      // For retryable errors, AI SDK maxRetries already handles retry;
      // if we still get here, the retries were exhausted — break
      break
    }

    // Collect response + usage (may fail if stream errored)
    let finishReason: string
    try {
      const response = await result.response
      state.messages.push(...response.messages)

      // Workaround: DeepSeek Reasoner requires `reasoning_content` on every
      // assistant message in tool-call chains.  Ensure it's always present.
      ensureReasoningContentParts(state.messages, options.modelId)

      const usage = await result.usage
      if (usage) {
        state.tokenUsage.inputTokens += usage.inputTokens ?? 0
        state.tokenUsage.outputTokens += usage.outputTokens ?? 0
        state.tokenUsage.totalTokens = state.tokenUsage.inputTokens + state.tokenUsage.outputTokens
        if (usage.inputTokens != null) state.lastInputTokens = usage.inputTokens
        callbacks.onUsageUpdate(state.tokenUsage)
      }

      finishReason = await result.finishReason
    } catch (err) {
      const classified = classifyApiError(err)
      callbacks.onError(new Error(classified.message))
      break
    }

    if (finishReason === 'tool-calls') {
      let toolCalls: Awaited<StreamResult['toolCalls']>
      try {
        toolCalls = await result.toolCalls
      } catch (err) {
        const classified = classifyApiError(err)
        callbacks.onError(new Error(classified.message))
        break
      }

      await handleToolCalls(toolCalls, state, options, callbacks)
      continue
    }

    break
  }

  if (state.turnCount >= options.maxTurns) {
    callbacks.onError(new Error(`Reached maximum turns (${options.maxTurns}). Stopping agent loop.`))
  }

  return state
}

/** Save session on exit */
export async function saveSession(state: LoopState, model: LanguageModel): Promise<void> {
  try {
    const summary = await generateSessionSummary(state.messages, model, state.sessionId, state.startedAt, [
      ...state.filesModified,
    ])
    await saveSessionSummary(summary)
  } catch {
    // Don't crash on session save failure
  }
}
