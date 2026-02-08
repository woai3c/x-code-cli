// @x-code/core — Agent Loop (core logic: streaming, tool calls, permission, context compression)

import fs from 'node:fs/promises'
import path from 'node:path'

import { streamText, generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'
import { execa } from 'execa'

import type { AgentCallbacks, AgentOptions, TokenUsage } from '../types/index.js'
import { toolRegistry, truncateToolResult } from '../tools/index.js'
import { getShellConfig } from '../tools/shell-utils.js'
import { checkPermission } from '../permissions/index.js'
import { buildSystemPrompt } from './system-prompt.js'
import { estimateTokens, toolResultMessage } from './messages.js'
import { estimateCost } from './pricing.js'
import { buildKnowledgeContext, loadRuleFiles } from '../knowledge/loader.js'
import {
  generateSessionSummary,
  saveSessionSummary,
  formatSessionForPrompt,
  loadLatestSession,
} from '../knowledge/session.js'
import { ensurePlansDir, generatePlanId, getPlanPath } from './plan-mode.js'

const KEEP_RECENT = 6
const DEFAULT_TOKEN_BUDGET_RATIO = 0.8

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  anthropic: 200000,
  openai: 128000,
  google: 1000000,
  deepseek: 64000,
  alibaba: 128000,
  xai: 128000,
  zhipu: 128000,
  moonshotai: 128000,
}

function getTokenBudget(modelId: string): number {
  const provider = modelId.split(':')[0]
  const contextWindow = MODEL_CONTEXT_WINDOWS[provider] ?? 128000
  return Math.floor(contextWindow * DEFAULT_TOKEN_BUDGET_RATIO)
}

interface LoopState {
  messages: ModelMessage[]
  tokenUsage: TokenUsage
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
      const count = content.split(oldString).length - 1
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
  const { executable, args } = getShellConfig()
  const proc = execa(executable, [...args, command], {
    timeout,
    reject: false,
  })

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
    system: 'Summarize the following conversation concisely, preserving key decisions, file changes, and context needed to continue.',
    messages: old,
  })

  return [{ role: 'user', content: `[Previous conversation summary]\n${summary}` }, ...recent]
}

/** Classify API error and return a user-friendly recovery message */
function classifyApiError(err: unknown): { message: string; retryable: boolean } {
  const msg = err instanceof Error ? err.message : String(err)
  const statusMatch = msg.match(/(\d{3})/)
  const status = statusMatch ? Number(statusMatch[1]) : 0

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
      message: 'Rate limited (429). Waiting for retry... (AI SDK handles exponential backoff automatically with maxRetries: 3)',
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
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 },
    planMode: false,
    planId: null,
    sessionId: Date.now().toString(36),
    startedAt: new Date().toISOString(),
    filesModified: new Set(),
    turnCount: 0,
  }

  state.messages.push({ role: 'user', content: userMessage })

  // Check for @rule-name references in user message and load matching rules
  const ruleRefs = userMessage.match(/@([\w-]+)/g)
  let extraRuleContext = ''
  if (ruleRefs) {
    const rules = await loadRuleFiles()
    for (const ref of ruleRefs) {
      const ruleName = ref.slice(1) // remove @
      const rule = rules.find((r) => r.filename === ruleName)
      if (rule) {
        extraRuleContext += `\n\n### Rule: ${rule.filename}\n${rule.content}`
      }
    }
  }

  const sessionSummary = await loadLatestSession()
  const sessionContext = sessionSummary ? formatSessionForPrompt(sessionSummary) : undefined
  const knowledgeContext = await buildKnowledgeContext({ sessionContext })
  const fullKnowledgeContext = knowledgeContext + extraRuleContext

  const tokenBudget = getTokenBudget(options.modelId)

  while (state.turnCount < options.maxTurns) {
    state.turnCount++

    // Context compression check — also saves session summary before compressing
    if (estimateTokens(state.messages) > tokenBudget) {
      try {
        const summary = await generateSessionSummary(
          state.messages,
          model,
          state.sessionId,
          state.startedAt,
          [...state.filesModified],
        )
        await saveSessionSummary(summary)
      } catch {
        // Don't block compression on session save failure
      }
      state.messages = await compressMessages(state.messages, model)
      callbacks.onContextCompressed('Context compressed to fit token budget.')
    }

    const systemPrompt = buildSystemPrompt({
      knowledgeContext: fullKnowledgeContext,
      planMode: state.planMode,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any
    try {
      result = streamText({
        model,
        system: systemPrompt,
        messages: state.messages,
        tools: toolRegistry,
        maxRetries: 3,
        abortSignal: options.abortSignal,
      })
    } catch (err) {
      const classified = classifyApiError(err)
      callbacks.onError(new Error(classified.message))
      break
    }

    // Stream chunks to UI
    let fullText = ''
    try {
      for await (const chunk of result.fullStream) {
        if (chunk.type === 'text-delta') {
          fullText += chunk.text
          callbacks.onTextDelta(chunk.text)
        }
        if (chunk.type === 'tool-call') {
          callbacks.onToolCall(chunk.toolName, chunk.input as Record<string, unknown>)
        }
        // Truncate auto-executed tool results (readFile, glob, grep, etc.)
        if (chunk.type === 'tool-result') {
          const raw = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output)
          const truncated = truncateToolResult(raw)
          if (truncated !== raw) {
            // Result was truncated — the original is already in messages via AI SDK,
            // but we notify via callback so the UI can show it
            callbacks.onToolResult(chunk.toolCallId, truncated)
          }
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

    // Collect response + usage
    const response = await result.response
    state.messages.push(...response.messages)

    const usage = await result.usage
    if (usage) {
      state.tokenUsage.inputTokens += usage.inputTokens ?? 0
      state.tokenUsage.outputTokens += usage.outputTokens ?? 0
      state.tokenUsage.totalTokens = state.tokenUsage.inputTokens + state.tokenUsage.outputTokens
      state.tokenUsage.estimatedCost = estimateCost(
        options.modelId,
        state.tokenUsage.inputTokens,
        state.tokenUsage.outputTokens,
      )
      callbacks.onUsageUpdate(state.tokenUsage)
    }

    const finishReason = await result.finishReason

    if (finishReason === 'tool-calls') {
      const toolCalls = await result.toolCalls

      for (const tc of toolCalls) {
        const toolName = tc.toolName
        const input = tc.input as Record<string, unknown>
        let output: string

        // ── Plan mode tools ──
        if (toolName === 'enterPlanMode') {
          state.planMode = true
          state.planId = generatePlanId()
          await ensurePlansDir()
          output = `Plan mode activated. Plan ID: ${state.planId}. Use only read-only tools. Save plan to ${getPlanPath(state.planId)}`
          state.messages.push(toolResultMessage(tc.toolCallId, toolName, output))
          callbacks.onToolResult(tc.toolCallId, output)
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
          state.messages.push(toolResultMessage(tc.toolCallId, toolName, output))
          callbacks.onToolResult(tc.toolCallId, output)
          continue
        }

        // ── askUser tool ──
        if (toolName === 'askUser') {
          const question = input.question as string
          const optionsList = input.options as { label: string; description: string }[]
          const answer = await callbacks.onAskUser(question, optionsList)
          output = `User answered: ${answer}`
          state.messages.push(toolResultMessage(tc.toolCallId, toolName, output))
          callbacks.onToolResult(tc.toolCallId, output)
          continue
        }

        // ── Permission check for write tools and shell ──
        if (toolName === 'writeFile' || toolName === 'edit' || toolName === 'shell') {
          const approved = await checkPermission(
            { toolName, input },
            options.trustMode,
            callbacks.onAskPermission,
          )

          if (!approved) {
            output = 'Permission denied by user.'
            state.messages.push(toolResultMessage(tc.toolCallId, toolName, output))
            callbacks.onToolResult(tc.toolCallId, output)
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
        state.messages.push(toolResultMessage(tc.toolCallId, toolName, output))
        callbacks.onToolResult(tc.toolCallId, output)
      }

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
    const summary = await generateSessionSummary(
      state.messages,
      model,
      state.sessionId,
      state.startedAt,
      [...state.filesModified],
    )
    await saveSessionSummary(summary)
  } catch {
    // Don't crash on session save failure
  }
}
