import { createHash } from 'node:crypto'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import { redactMemoryValue } from '../knowledge/memory-redaction.js'
import type { MemoryJob, TurnMemoryProjection } from '../knowledge/memory-types.js'
import { extractText } from '../utils/message-helpers.js'

const PURE_SLASH_RE = /^\/[a-z][\w-]*(?:\s+[^\n]*)?$/i

interface ToolPart {
  type?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  isError?: boolean
}

const FILE_CONTENT_TOOL_RE = /(?:readFile|read_file|readMcpResource)$/i
const VERIFICATION_TOOL_RE = /(?:test|check|lint|build|compile|verify)/i
const COMMAND_TOOL_RE = /(?:shell|command|terminal|powershell|bash)/i
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
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>
    if (typeof record.value === 'string') return record.value
    if (Array.isArray(record.value)) {
      return record.value
        .filter((item): item is { type: string; text: string } =>
          Boolean(item && typeof item === 'object' && (item as { type?: string }).type === 'text'),
        )
        .map((item) => item.text)
        .join('\n')
    }
  }
  return JSON.stringify(output ?? '')
}

function isFailedToolResult(part: ToolPart, evidence: string): boolean {
  if (part.isError) return true
  if (part.output && typeof part.output === 'object') {
    const output = part.output as Record<string, unknown>
    if (output.isError === true || output.success === false || output.ok === false) return true
    if ('error' in output && output.error !== undefined && output.error !== null && output.error !== false) return true
    if (output.status === 'error' || output.status === 'failed') return true
    if (typeof output.exitCode === 'number' && output.exitCode !== 0) return true
    if (output.type === 'error-text' || output.type === 'error-json') return true
  }
  if (/^(?:Error:|\[Tool execution (?:failed|interrupted))/i.test(evidence.trim())) return true
  const exitCodes = [...evidence.matchAll(/\bexit code\s*[:=]?\s*(-?\d+)/gi)].map((match) => Number(match[1]))
  return exitCodes.some((code) => code !== 0)
}

function isVerificationToolResult(toolName: string, input: string): boolean {
  return VERIFICATION_TOOL_RE.test(toolName) || (COMMAND_TOOL_RE.test(toolName) && VERIFICATION_COMMAND_RE.test(input))
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
  return !PURE_SLASH_RE.test(userText)
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
        const rawEvidence = outputText(part.output).replace(/\b[A-Za-z0-9+/]{160,}={0,2}\b/g, '[binary removed]')
        const status = isFailedToolResult(part, rawEvidence) ? 'error' : 'ok'
        const evidence = FILE_CONTENT_TOOL_RE.test(part.toolName)
          ? `${toolInputs.get(part.toolCallId ?? part.toolName) ?? '{}'}; file content omitted; status=${status}`.slice(
              0,
              1000,
            )
          : rawEvidence.slice(0, 1000)
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
  while (size() > maxBytes && clone.events.length > 0) {
    const ordinary = clone.events.findIndex((event) => event.type === 'tool-call')
    clone.events.splice(ordinary >= 0 ? ordinary : clone.events.length - 1, 1)
  }
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
  return clone
}

export function createMemoryJob(input: {
  projection: TurnMemoryProjection
  sessionId: string
  turnStartMessageIndex: number
  modelId: string
  repositoryId: string
  cwd: string
}): MemoryJob {
  const projection = redactMemoryValue(input.projection)
  const projectionHash = createHash('sha256').update(stableStringify(projection)).digest('hex').slice(0, 20)
  const jobId = `${input.sessionId}-${input.turnStartMessageIndex}-${projectionHash}`
  return {
    version: 2,
    jobId,
    sessionId: input.sessionId,
    turnStartMessageIndex: input.turnStartMessageIndex,
    modelId: input.modelId,
    repositoryId: input.repositoryId,
    cwd: input.cwd,
    createdAt: new Date().toISOString(),
    sourceOccurredAt: projection.turnCompletedAt,
    attempt: 0,
    projection,
  }
}
