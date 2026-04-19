// @x-code-cli/core — Agent Loop (orchestration: streaming, tool calls, permission, context compression)
import fs from 'node:fs/promises'
import path from 'node:path'

import { generateText, streamText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import { buildKnowledgeContext } from '../knowledge/loader.js'
import { generateSessionSummary, saveSessionSummary } from '../knowledge/session.js'
import { toolRegistry, truncateToolResult } from '../tools/index.js'
import type { AgentCallbacks, AgentOptions } from '../types/index.js'
import { classifyApiError, isContextTooLongError } from './api-errors.js'
import { estimateTokenCount, getCompressionThreshold } from './context-window.js'
import { createLoopState } from './loop-state.js'
import type { LoopState } from './loop-state.js'
import { ensureReasoningContentParts } from './provider-compat.js'
import { drainStreamResult } from './stream-utils.js'
import type { StreamResult } from './stream-utils.js'
import { buildSystemPrompt } from './system-prompt.js'
import { processToolCalls } from './tool-execution.js'

export type { LoopState } from './loop-state.js'

/** Number of recent messages to keep verbatim when compressing. */
const KEEP_RECENT = 6

/** Compress old messages into a summary. */
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

/**
 * Proactive compression: compress when either the last real input-token count
 * or the character-based estimate has crossed the threshold.
 */
async function checkAndCompressContext(
  state: LoopState,
  model: LanguageModel,
  threshold: number,
  callbacks: AgentCallbacks,
): Promise<void> {
  const needsCompression =
    state.lastInputTokens > threshold || estimateTokenCount(state.messages) > threshold

  if (!needsCompression || state.messages.length <= KEEP_RECENT) return

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

/**
 * Reactive compact: when a stream errors because the prompt was too long,
 * compress and signal the caller to retry. Mirrors Claude Code's reactiveCompact.
 * Returns true if compression happened (caller should retry this turn).
 */
async function handleContextTooLong(
  state: LoopState,
  model: LanguageModel,
  callbacks: AgentCallbacks,
): Promise<boolean> {
  if (state.messages.length <= KEEP_RECENT) return false
  state.messages = await compressMessages(state.messages, model)
  state.lastInputTokens = 0
  callbacks.onContextCompressed('Context too long — automatically compressed. Retrying...')
  return true
}

/** Consume streamText output, dispatching chunks to the UI via callbacks.
 *  Reasoning-delta chunks (thinking-mode models — DeepSeek-reasoner, o1,
 *  etc.) are deliberately ignored: that's the model's internal chain of
 *  thought, not user-facing output. The final user-facing answer arrives
 *  as regular text-delta chunks. */
async function streamChunksToUI(result: StreamResult, callbacks: AgentCallbacks): Promise<void> {
  for await (const chunk of result.fullStream) {
    if (chunk.type === 'text-delta') {
      callbacks.onTextDelta(chunk.text ?? '')
    } else if (chunk.type === 'tool-call') {
      callbacks.onToolCall(chunk.toolName ?? '', (chunk.input ?? {}) as Record<string, unknown>)
    } else if (chunk.type === 'tool-result') {
      // Notify UI about auto-executed tool results (readFile, glob, grep, etc.)
      const raw = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output ?? '')
      callbacks.onToolResult(chunk.toolCallId ?? '', truncateToolResult(raw))
    }
    // reasoning-delta / reasoning-start / reasoning-end: intentionally dropped.
  }
}

/** Pull the response + usage off a completed stream and fold into state. */
async function collectTurnResponse(
  result: StreamResult,
  state: LoopState,
  modelId: string,
  callbacks: AgentCallbacks,
): Promise<string> {
  const response = await result.response
  state.messages.push(...response.messages)
  ensureReasoningContentParts(state.messages, modelId)

  const usage = await result.usage
  if (usage) {
    state.tokenUsage.inputTokens += usage.inputTokens ?? 0
    state.tokenUsage.outputTokens += usage.outputTokens ?? 0
    state.tokenUsage.totalTokens = state.tokenUsage.inputTokens + state.tokenUsage.outputTokens
    if (usage.inputTokens != null) state.lastInputTokens = usage.inputTokens
    callbacks.onUsageUpdate(state.tokenUsage)
  }

  return result.finishReason
}

type TurnOutcome =
  /** Turn completed normally; `finishReason` says what to do next. */
  | { kind: 'done'; finishReason: string; result: StreamResult }
  /** Fatal error (already reported to callbacks); caller should break the loop. */
  | { kind: 'error' }
  /** Context overflowed and was compressed; caller should retry this turn. */
  | { kind: 'retry' }

/** Run one agent turn: stream to UI, collect response. Resilient to errors. */
async function runTurn(
  state: LoopState,
  model: LanguageModel,
  options: AgentOptions,
  systemPrompt: string,
  callbacks: AgentCallbacks,
): Promise<TurnOutcome> {
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
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }

  try {
    await streamChunksToUI(result, callbacks)
  } catch (err) {
    // Silently drain all pending AI SDK promises so unhandled-rejection
    // warnings (NoOutputGeneratedError) don't leak to stderr.
    drainStreamResult(result)

    if (isContextTooLongError(err)) {
      const compressed = await handleContextTooLong(state, model, callbacks)
      if (compressed) return { kind: 'retry' }
    }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }

  try {
    const finishReason = await collectTurnResponse(result, state, options.modelId, callbacks)
    return { kind: 'done', finishReason, result }
  } catch (err) {
    drainStreamResult(result)
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }
}

/** Main agent loop. */
export async function agentLoop(
  userMessage: string,
  model: LanguageModel,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  existingState?: LoopState,
): Promise<LoopState> {
  const state = existingState ?? createLoopState()
  state.messages.push({ role: 'user', content: userMessage })

  // Session continuation is handled explicitly by the UI: if the user accepts
  // the resume prompt, the pending work is embedded directly in their first
  // user message. Auto-injecting it into every system prompt made the model
  // treat trivial greetings as "continue exploring", so we no longer do that.
  const fullKnowledgeContext = await buildKnowledgeContext()

  // Detect git repo once — cheap stat, avoids per-turn disk hit
  const isGitRepo = await fs
    .stat(path.join(process.cwd(), '.git'))
    .then(() => true)
    .catch(() => false)

  const compressionThreshold = getCompressionThreshold(options.modelId)

  while (state.turnCount < options.maxTurns) {
    state.turnCount++

    await checkAndCompressContext(state, model, compressionThreshold, callbacks)

    const systemPrompt = buildSystemPrompt({
      knowledgeContext: fullKnowledgeContext,
      planMode: state.planMode,
      modelId: options.modelId,
      isGitRepo,
    })

    const outcome = await runTurn(state, model, options, systemPrompt, callbacks)

    if (outcome.kind === 'error') break
    if (outcome.kind === 'retry') {
      // Don't count a failed attempt that got recovered via reactive compaction.
      state.turnCount--
      continue
    }

    if (outcome.finishReason === 'tool-calls') {
      let toolCalls: Awaited<StreamResult['toolCalls']>
      try {
        toolCalls = await outcome.result.toolCalls
      } catch (err) {
        callbacks.onError(new Error(classifyApiError(err).message))
        break
      }
      await processToolCalls(toolCalls, state, options, callbacks)
      continue
    }

    break
  }

  if (state.turnCount >= options.maxTurns) {
    callbacks.onError(new Error(`Reached maximum turns (${options.maxTurns}). Stopping agent loop.`))
  }

  return state
}

/** Save session on exit. */
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
