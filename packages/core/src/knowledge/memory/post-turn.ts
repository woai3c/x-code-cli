import path from 'node:path'

import type { ModelMessage } from 'ai'

import { extractText } from '../../utils/message-helpers.js'
import { redactMemoryValue } from './redaction.js'
import { extractMemoryIdentifiers, extractMemoryPaths } from './search-index.js'
import { memoryContentHash } from './transaction-store.js'
import type { MemoryJob, TurnMemoryProjection } from './types.js'

const PURE_SLASH_RE = /^\/[a-z][\w-]*(?:\s+[^\n]*)?$/i
const PURE_GREETING_RE = /^(?:你好|您好|嗨|哈喽|早上好|下午好|晚上好|hello|hi|hey)[!！,.，。?？~～\s]*$/i
const EXPLICIT_MEMORY_INTENT_RE =
  /(?:记住|记一下|以后|始终|总是|不要再|别再|我的产品|我的项目|忘记|别记|remember|from now on|always|never again|my product|my project|forget)/i

interface ToolPart {
  type?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  isError?: boolean
}

// Executable and tool protocol identifiers are stable machine syntax. This
// never inspects user prose or tool-result prose to infer intent or meaning.
const VERIFICATION_COMMAND_RE =
  /(?:^|[\s"'=:/\\])(?:test|tests|build|typecheck|lint|check|ci|pytest|vitest|jest|eslint|tsc)(?=$|[\s"'&,;:/\\])/i

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`
}

function cleanUserText(value: string): string {
  return value
    .replace(/<activated_skill\b[^>]*>[\s\S]*?<\/activated_skill>/gi, '')
    .replace(/<plugin_context>[\s\S]*?<\/plugin_context>/gi, '')
    .replace(/^The user sent a new message while you were working:\s*/i, '')
    .replace(
      /\n\nIMPORTANT: After completing your current task, you MUST address the user's message above\.[\s\S]*$/i,
      '',
    )
    .trim()
}

function summarizeInput(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value ?? '').slice(0, 500)
  const record = value as Record<string, unknown>
  const safe: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    if (/(?:content|data|image|base64|body)/i.test(key)) continue
    safe[key] = typeof item === 'string' ? item.slice(0, 500) : item
  }
  return stableStringify(safe).slice(0, 1000)
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (!output || typeof output !== 'object') return String(output ?? '')
  const record = output as Record<string, unknown>
  if (typeof record.value === 'string') return record.value
  if (Array.isArray(record.value)) {
    return record.value
      .filter((item): item is { type: string; text: string } =>
        Boolean(
          item &&
          typeof item === 'object' &&
          (item as { type?: string }).type === 'text' &&
          typeof (item as { text?: unknown }).text === 'string',
        ),
      )
      .map((item) => item.text)
      .join('\n')
  }
  return stableStringify(output)
}

function summarizeOutputSignals(output: unknown): string {
  const text = outputText(output)
  const paths = extractMemoryPaths(text).slice(0, 20)
  const identifiers = extractMemoryIdentifiers(text).slice(0, 40)
  return stableStringify({ paths, identifiers })
}

function isFailedToolResult(part: ToolPart): boolean {
  if (part.isError) return true
  if (part.output && typeof part.output === 'object') {
    const output = part.output as Record<string, unknown>
    if (output.isError === true || output.success === false || output.ok === false) return true
    if ('error' in output && output.error !== undefined && output.error !== null && output.error !== false) return true
    if (output.status === 'error' || output.status === 'failed') return true
    if (typeof output.exitCode === 'number' && output.exitCode !== 0) return true
    if (output.type === 'error-text' || output.type === 'error-json') return true
  }
  return false
}

function isVerificationToolResult(toolName: string, input: string): boolean {
  return toolName === 'shell' && VERIFICATION_COMMAND_RE.test(input)
}

function changedFilesSince(current: ReadonlySet<string>, before: ReadonlySet<string>): string[] {
  return [...current]
    .filter((file) => !before.has(file))
    .map((file) => path.resolve(file).replace(/\\/g, '/'))
    .sort()
}

export function shouldCreateMemoryJob(projection: TurnMemoryProjection): boolean {
  const userText = projection.userMessages.join('\n').trim()
  if (!userText || !projection.assistantFinal.trim()) return false
  if (PURE_SLASH_RE.test(userText)) return false
  return EXPLICIT_MEMORY_INTENT_RE.test(userText) || !PURE_GREETING_RE.test(userText)
}

export function buildTurnMemoryProjection(input: {
  messages: readonly ModelMessage[]
  turnStartMessageIndex: number
  filesModifiedBefore: ReadonlySet<string>
  filesModifiedAfter: ReadonlySet<string>
  repositoryId: string
  turnStartedAt: string
  turnCompletedAt: string
  maxInputTokens?: number
}): TurnMemoryProjection {
  const messages = input.messages.slice(input.turnStartMessageIndex)
  const userMessages: string[] = []
  let assistantFinal = ''
  const events: TurnMemoryProjection['events'] = []
  const verification: string[] = []
  const toolInputs = new Map<string, string>()

  for (const message of messages) {
    if (message.role === 'user') {
      const text = cleanUserText(extractText(message.content))
      if (text && !text.startsWith('Output token limit hit.')) userMessages.push(text)
      continue
    }
    if (message.role === 'assistant') {
      const text = extractText(message.content).trim()
      if (text) assistantFinal = text
      if (Array.isArray(message.content)) {
        for (const part of message.content as ToolPart[]) {
          if (part.type === 'tool-call' && part.toolName) {
            const summary = summarizeInput(part.input)
            events.push({ type: 'tool-call', name: part.toolName, summary })
            toolInputs.set(part.toolCallId ?? part.toolName, summary)
          }
        }
      }
      continue
    }
    if (message.role === 'tool' && Array.isArray(message.content)) {
      for (const part of message.content as ToolPart[]) {
        if (part.type !== 'tool-result' || !part.toolName) continue
        const status = isFailedToolResult(part) ? 'error' : 'ok'
        const evidence =
          `${toolInputs.get(part.toolCallId ?? part.toolName) ?? '{}'}; signals=${summarizeOutputSignals(part.output)}; status=${status}`.slice(
            0,
            1000,
          )
        events.push({ type: 'tool-result', name: part.toolName, status, evidence })
        if (
          status === 'ok' &&
          isVerificationToolResult(part.toolName, toolInputs.get(part.toolCallId ?? part.toolName) ?? '')
        ) {
          verification.push(`${part.toolName}: ${evidence.slice(0, 500)}`)
        }
      }
    }
  }

  const projection: TurnMemoryProjection = {
    userMessages,
    assistantFinal,
    events,
    changedFiles: changedFilesSince(input.filesModifiedAfter, input.filesModifiedBefore),
    verification,
    repositoryId: input.repositoryId,
    turnStartedAt: input.turnStartedAt,
    turnCompletedAt: input.turnCompletedAt,
  }
  return redactMemoryValue(trimProjection(projection, input.maxInputTokens ?? 12_000))
}

function trimProjection(projection: TurnMemoryProjection, maxTokens: number): TurnMemoryProjection {
  const maxBytes = maxTokens * 3
  const clone = structuredClone(projection)
  const size = () => Buffer.byteLength(JSON.stringify(clone), 'utf-8')
  clone.userMessages = clone.userMessages.slice(-32).map((value) => value.slice(0, 12_000))
  clone.assistantFinal = clone.assistantFinal.slice(0, 18_000)
  clone.events = clone.events.slice(-128)
  clone.changedFiles = clone.changedFiles.slice(0, 512).map((value) => value.slice(0, 8192))
  clone.verification = clone.verification.slice(-128).map((value) => value.slice(0, 1000))
  while (size() > maxBytes) {
    const ordinary = clone.events.findIndex((event) => event.type === 'tool-call')
    if (ordinary < 0) break
    clone.events.splice(ordinary, 1)
  }
  while (size() > maxBytes) {
    const successful = clone.events.findIndex((event) => event.type === 'tool-result' && event.status === 'ok')
    if (successful < 0) break
    clone.events.splice(successful, 1)
  }
  while (size() > maxBytes && clone.changedFiles.length > 0) {
    clone.changedFiles.pop()
  }
  while (size() > maxBytes && clone.events.length > 0) clone.events.pop()
  while (size() > maxBytes && clone.verification.length > 1) {
    clone.verification.pop()
  }
  while (size() > maxBytes && clone.assistantFinal.length > 1000) {
    clone.assistantFinal = clone.assistantFinal.slice(0, Math.max(1000, Math.floor(clone.assistantFinal.length * 0.8)))
  }
  while (size() > maxBytes) {
    const index = clone.userMessages.reduce(
      (longest, value, current) => (value.length > (clone.userMessages[longest]?.length ?? 0) ? current : longest),
      0,
    )
    const value = clone.userMessages[index]
    if (!value || value.length <= 1000) break
    clone.userMessages[index] = value.slice(0, Math.max(1000, Math.floor(value.length * 0.8)))
  }
  while (size() > maxBytes && clone.verification.length > 0) clone.verification.pop()
  while (size() > maxBytes && clone.assistantFinal.length > 0) {
    clone.assistantFinal = clone.assistantFinal.slice(0, Math.floor(clone.assistantFinal.length * 0.8))
  }
  while (size() > maxBytes && clone.userMessages.length > 0) {
    const value = clone.userMessages.at(-1)!
    if (value.length > 1)
      clone.userMessages[clone.userMessages.length - 1] = value.slice(0, Math.floor(value.length * 0.8))
    else clone.userMessages.pop()
  }
  return clone
}

export function createMemoryJob(input: {
  projection: TurnMemoryProjection
  sessionId: string
  turnStartMessageIndex: number
  modelId: string
  repositoryId: string
}): MemoryJob {
  const projection = redactMemoryValue(input.projection)
  const projectionHash = memoryContentHash(stableStringify(projection)).slice(0, 20)
  const jobId = `${input.sessionId}-${input.turnStartMessageIndex}-${projectionHash}`
  return {
    version: 2,
    jobId,
    sessionId: input.sessionId,
    turnStartMessageIndex: input.turnStartMessageIndex,
    modelId: input.modelId,
    repositoryId: input.repositoryId,
    createdAt: new Date().toISOString(),
    sourceOccurredAt: projection.turnCompletedAt,
    attempt: 0,
    explicitMemoryIntent: EXPLICIT_MEMORY_INTENT_RE.test(projection.userMessages.join('\n')),
    projection,
  }
}
