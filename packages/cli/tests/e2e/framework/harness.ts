// Harness: spawn `xc -p` in print mode and parse the resulting session jsonl.
//
// Why parse jsonl rather than stdout: stdout in print mode is just the model's
// final assistant text (no structured tool-call markers). Sessions jsonl has
// every assistant tool-call + tool-result event in a parse-friendly format
// that's stable across UI changes. See packages/core/src/agent/session-store.ts.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { RunCliOptions, RunResult, ToolCall } from './types.js'

export interface HarnessConfig {
  cliBin: string
  modelId: string
  defaultTimeoutMs: number
}

export async function runCliInDir(
  cwd: string,
  prompt: string,
  cfg: HarnessConfig,
  options?: RunCliOptions,
): Promise<RunResult> {
  const args = ['-p', prompt, ...(options?.args ?? [])]
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    X_CODE_HOME: path.join(cwd, '.x-code-home'), // isolate user-scope ~/.x-code per scenario
    X_CODE_MODEL: cfg.modelId,
    NODE_ENV: 'test',
    NO_COLOR: '1',
    ...(options?.env ?? {}),
  }
  const startedAt = Date.now()

  const child = spawn(process.execPath, [cfg.cliBin, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (b: Buffer) => {
    stdout += b.toString('utf-8')
  })
  child.stderr.on('data', (b: Buffer) => {
    stderr += b.toString('utf-8')
  })

  const timeoutMs = options?.timeoutMs ?? cfg.defaultTimeoutMs
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 5000).unref()
  }, timeoutMs)

  const exitCode: number = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? -1))
  })
  clearTimeout(timer)

  if (timedOut) {
    stderr += `\n[harness] timeout after ${timeoutMs}ms — killed`
  }

  // print.ts uses `saveSession().catch()` (fire-and-forget) and then process.exit().
  // The final jsonl write may not be flushed when the process exits. Poll the
  // sessions dir until file size stops changing (or up to 2s).
  await waitForJsonlStable(path.join(cwd, '.x-code', 'sessions'))

  // Locate the freshest session jsonl in cwd/.x-code/sessions/
  const sessionJsonlPath = await pickLatestSessionJsonl(path.join(cwd, '.x-code', 'sessions'))
  const parsed = sessionJsonlPath
    ? await parseSessionJsonl(sessionJsonlPath)
    : { assistantText: '', toolCalls: [], tokenUsage: undefined as RunResult['tokenUsage'] }

  return {
    assistantText: parsed.assistantText || stdout, // fallback: stdout already is the assistant text in print mode
    toolCalls: parsed.toolCalls,
    stdout,
    stderr,
    exitCode,
    durationMs: Date.now() - startedAt,
    sessionJsonlPath: sessionJsonlPath ?? '',
    tokenUsage: parsed.tokenUsage,
  }
}

async function waitForJsonlStable(dir: string, maxWaitMs = 2000, pollMs = 100): Promise<void> {
  const deadline = Date.now() + maxWaitMs
  let lastSize = -1
  let stableTicks = 0
  while (Date.now() < deadline) {
    let size = 0
    try {
      const entries = await fs.readdir(dir)
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue
        const s = await fs.stat(path.join(dir, name))
        size += s.size
      }
    } catch {
      // dir doesn't exist yet — keep polling
    }
    if (size > 0 && size === lastSize) {
      stableTicks++
      if (stableTicks >= 2) return // 2 consecutive equal sizes ≈ ~200ms idle
    } else {
      stableTicks = 0
      lastSize = size
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

async function pickLatestSessionJsonl(dir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dir)
    const jsonls = entries.filter((e) => e.endsWith('.jsonl'))
    if (jsonls.length === 0) return null
    const stats = await Promise.all(
      jsonls.map(async (name) => {
        const full = path.join(dir, name)
        const s = await fs.stat(full)
        return { full, mtime: s.mtimeMs }
      }),
    )
    stats.sort((a, b) => b.mtime - a.mtime)
    return stats[0]!.full
  } catch {
    return null
  }
}

interface ParsedSession {
  assistantText: string
  toolCalls: ToolCall[]
  tokenUsage?: RunResult['tokenUsage']
}

async function parseSessionJsonl(filePath: string): Promise<ParsedSession> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const lines = raw.split('\n').filter(Boolean)
  const assistantPieces: string[] = []
  const toolCalls: ToolCall[] = []
  const resultByCallId = new Map<string, { text: string; isError?: boolean }>()
  let tokenUsage: RunResult['tokenUsage'] | undefined

  for (const line of lines) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>

    if (e.t === 'meta' && e.kind === 'usage') {
      const usage = e.usage as Record<string, number> | undefined
      if (usage) {
        tokenUsage = {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          cacheRead: usage.cacheReadTokens ?? 0,
          cacheWrite: usage.cacheCreationTokens ?? 0,
        }
      }
      continue
    }

    if (e.t !== 'msg') continue
    const message = e.message as { role?: string; content?: unknown } | undefined
    if (!message) continue

    if (message.role === 'assistant') {
      // content can be a string or an array of parts
      if (typeof message.content === 'string') {
        assistantPieces.push(message.content)
      } else if (Array.isArray(message.content)) {
        for (const part of message.content as Record<string, unknown>[]) {
          if (part.type === 'text' && typeof part.text === 'string') {
            assistantPieces.push(part.text)
          } else if (part.type === 'tool-call') {
            toolCalls.push({
              toolCallId: String(part.toolCallId ?? ''),
              toolName: String(part.toolName ?? ''),
              input: (part.input ?? {}) as Record<string, unknown>,
            })
          }
        }
      }
    } else if (message.role === 'tool' && Array.isArray(message.content)) {
      for (const part of message.content as Record<string, unknown>[]) {
        if (part.type !== 'tool-result') continue
        const callId = String(part.toolCallId ?? '')
        const output = part.output as Record<string, unknown> | undefined
        const text = extractToolResultText(output)
        const isError = (part as { isError?: boolean }).isError === true
        resultByCallId.set(callId, { text, isError })
      }
    }
  }

  // Merge results into the matching tool calls.
  for (const tc of toolCalls) {
    const r = resultByCallId.get(tc.toolCallId)
    if (r) {
      tc.resultText = r.text
      tc.isError = r.isError
    }
  }

  return {
    assistantText: assistantPieces.join('').trim(),
    toolCalls,
    tokenUsage,
  }
}

function extractToolResultText(output: Record<string, unknown> | undefined): string {
  if (!output) return ''
  // AI SDK v6 tool-result output shape: { type: 'content', value: [{ type: 'text', text }, ...] }
  if (output.type === 'content' && Array.isArray(output.value)) {
    const pieces: string[] = []
    for (const part of output.value as Record<string, unknown>[]) {
      if (part.type === 'text' && typeof part.text === 'string') pieces.push(part.text)
    }
    return pieces.join('')
  }
  // Some tools push { type: 'text', value: '...' } directly.
  if (output.type === 'text' && typeof output.value === 'string') return output.value
  // Fallback: stringify whole object — at least gives the test something to match.
  try {
    return JSON.stringify(output)
  } catch {
    return ''
  }
}
