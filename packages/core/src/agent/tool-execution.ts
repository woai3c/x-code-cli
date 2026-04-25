// @x-code-cli/core — Tool execution & dispatch
import fs from 'node:fs/promises'
import path from 'node:path'

import { checkPermission } from '../permissions/index.js'
import { truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, reportProgress } from '../tools/progress.js'
import { getShellProvider } from '../tools/shell-provider.js'
import type { AgentCallbacks, AgentOptions } from '../types/index.js'
import { foldShellErrorNoise } from '../utils/shell-error.js'
import { checkForLoop, recordToolCall } from './loop-guard.js'
import type { LoopState } from './loop-state.js'
import { toolResultMessage } from './messages.js'

/** Count occurrences of a substring without creating intermediate arrays. */
function countOccurrences(content: string, search: string): number {
  let count = 0
  let pos = 0
  while ((pos = content.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}

/** Execute a write tool (writeFile / edit). */
async function executeWriteTool(toolName: string, input: Record<string, unknown>, toolCallId: string): Promise<string> {
  if (toolName === 'writeFile') {
    const filePath = input.filePath as string
    const content = input.content as string
    reportProgress(toolCallId, `Writing ${filePath}`)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const isNew = await fs.access(filePath).then(() => false, () => true)
    await fs.writeFile(filePath, content, 'utf-8')
    const parts = content.split('\n')
    const lineCount = content.endsWith('\n') ? parts.length - 1 : parts.length
    if (isNew) {
      return `File created: ${filePath} (${lineCount} lines)`
    }
    return `File written: ${filePath} (${lineCount} lines)`
  }

  if (toolName === 'edit') {
    const filePath = input.filePath as string
    const oldString = input.oldString as string
    const newString = input.newString as string
    const replaceAll = (input.replaceAll as boolean) ?? false

    reportProgress(toolCallId, `Editing ${filePath}`)
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

/** Execute a shell command with streaming. */
async function executeShell(
  command: string,
  timeout: number,
  callbacks: AgentCallbacks,
  toolCallId: string,
): Promise<{ output: string; isError: boolean }> {
  const proc = getShellProvider().spawn(command, { timeout })

  reportProgress(toolCallId, 'Running command...')

  const onChunk = (chunk: Buffer) => {
    const s = chunk.toString()
    callbacks.onShellOutput(s)
    // Take the last non-empty line of the chunk as the progress message.
    // Long-running commands (tsc, test suites) stream many lines; showing
    // the most recent is a natural "what's happening right now" signal.
    const lines = s.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const last = lines[lines.length - 1]
    if (last) {
      const trimmed = last.length > 120 ? last.slice(0, 117) + '...' : last
      reportProgress(toolCallId, trimmed)
    }
  }

  proc.stdout?.on('data', onChunk)
  proc.stderr?.on('data', onChunk)

  const result = await proc
  // Fold PowerShell/cmd multi-line error blocks to a single line before they
  // reach the model. A misquoted command on Windows emits 5–10 lines per
  // attempt; across a loop of failed retries those stacks accumulate faster
  // than the actual diagnostic signal. execa's stdout/stderr are typed as
  // `string | unknown[] | Uint8Array` — we spawn with default string mode, so
  // a cast is safe, but keep a defensive fallback for non-string just in case.
  const toStr = (v: unknown): string => (typeof v === 'string' ? v : '')
  const stdout = foldShellErrorNoise(toStr(result.stdout))
  const stderr = foldShellErrorNoise(toStr(result.stderr))
  const output = [stdout, stderr].filter(Boolean).join('\n').trim()
  if (result.exitCode !== 0) {
    const text = output ? `${output}\nExit code ${result.exitCode}` : `Exit code ${result.exitCode}`
    return { output: text, isError: true }
  }
  return { output: output || 'Done', isError: false }
}

/** Push a tool result to state and notify the UI. */
function pushToolResult(
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
  isError = false,
): void {
  state.messages.push(toolResultMessage(toolCallId, toolName, output))
  // Clear the progress reporter for manually-dispatched tools (shell,
  // writeFile, edit, askUser). Auto-executed tools go through the SDK
  // stream's `tool-result` event and are cleared there — this call is
  // a no-op in that case since the reporter would already be gone.
  clearProgressReporter(toolCallId)
  callbacks.onToolResult(toolCallId, output, isError)
}

type ToolCall = { toolName: string; toolCallId: string; input: Record<string, unknown> }

/** Tools whose execution is driven by the AI SDK (they have an `execute` on
 *  the tool definition). By the time we see them in `processToolCalls`, the
 *  tool has already run and its result is already in `state.messages`. We
 *  can't pre-block these — only record for loop detection and annotate. */
const AUTO_EXECUTED_TOOLS = new Set(['readFile', 'glob', 'grep', 'listDir', 'webFetch', 'webSearch', 'saveKnowledge'])

/** Handle a single tool call. Returns when the call has been fully dispatched. */
async function handleToolCall(
  tc: ToolCall,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
): Promise<void> {
  const { toolName, input, toolCallId } = tc

  // ── askUser tool ──
  // Skip the loop guard for askUser — the model asking the user the same
  // clarifying question twice is almost always intentional (e.g. the user
  // answered ambiguously) and blocking it would silently break the UX.
  if (toolName === 'askUser') {
    const question = input.question as string
    const optionsList = input.options as { label: string; description: string }[]
    const answer = await callbacks.onAskUser(question, optionsList)
    pushToolResult(state, callbacks, toolCallId, toolName, `User answered: ${answer}`)
    return
  }

  // ── Doom-loop detection ──
  // For manual tools we pre-block. For auto-executed tools the call has
  // already run (result landed in state.messages via collectTurnResponse);
  // we still record the hash and, on soft-block, push a supplemental notice
  // so the next turn sees a clear stop signal. On hard-block, we additionally
  // prompt the user before returning.
  const isAutoExecuted = AUTO_EXECUTED_TOOLS.has(toolName)
  const loopCheck = checkForLoop(state, toolName, input, toolCallId)
  if (loopCheck.kind !== 'ok') {
    recordToolCall(state, toolName, input, loopCheck.hash)

    if (isAutoExecuted) {
      // The tool result already exists in state.messages. Append a follow-up
      // user-role notice so the model's next step has explicit context that
      // this path is spinning — without this nudge, some models keep trying.
      state.messages.push({
        role: 'user',
        content: `[loop-guard] ${loopCheck.message}`,
      })
      callbacks.onToolResult(toolCallId, `[loop-guard] ${loopCheck.message}`, true)
    } else {
      // Manual tool — short-circuit by synthesising the result. The tool body
      // never runs; no side effects, no permission prompt.
      pushToolResult(state, callbacks, toolCallId, toolName, `[loop-guard] ${loopCheck.message}`, true)
    }

    if (loopCheck.kind === 'hard-block') {
      const answer = await callbacks
        .onAskUser(
          `The model keeps calling ${toolName} with identical arguments. How do you want to proceed?`,
          [
            { label: 'Pause', description: 'Pause the turn — you can type a new instruction.' },
            { label: 'Continue', description: 'Let the model keep trying; the loop guard stays armed.' },
          ],
        )
        .catch(() => 'Pause')
      if (answer.toLowerCase().startsWith('pause')) {
        // Clear the recent-calls window so the guard doesn't immediately
        // re-trigger on the next turn if the model legitimately retries
        // once with the same args under the user's guidance.
        state.recentToolCalls = []
        state.messages.push({
          role: 'user',
          content: '[loop-guard] User paused the loop. Wait for further instructions rather than calling more tools.',
        })
      }
    }
    return
  }

  recordToolCall(state, toolName, input, loopCheck.hash)

  // ── Permission check for write tools and shell ──
  if (toolName === 'writeFile' || toolName === 'edit' || toolName === 'shell') {
    const approved = await checkPermission(
      { toolCallId, toolName, input },
      options.trustMode,
      callbacks.onAskPermission,
    )
    if (!approved) {
      pushToolResult(state, callbacks, toolCallId, toolName, 'Permission denied by user.')
      return
    }
  }

  // ── Execute tool ──
  let output: string
  let isError = false
  try {
    if (toolName === 'writeFile' || toolName === 'edit') {
      output = await executeWriteTool(toolName, input, toolCallId)
      // executeWriteTool returns "Error: ..." strings for in-band failures
      // (missing match, non-unique match) rather than throwing — surface
      // those as errored results so the scrollback line flips to red.
      if (output.startsWith('Error:')) isError = true
      else state.filesModified.add(input.filePath as string)
    } else if (toolName === 'shell') {
      const timeout = (input.timeout as number) ?? 30000
      const shellResult = await executeShell(input.command as string, timeout, callbacks, toolCallId)
      output = shellResult.output
      isError = shellResult.isError
    } else {
      // Tools with execute (readFile, glob, grep, etc.) are auto-executed by AI SDK
      return
    }
  } catch (err) {
    output = `Error: ${err instanceof Error ? err.message : String(err)}`
    isError = true
  }

  pushToolResult(state, callbacks, toolCallId, toolName, truncateToolResult(output), isError)
}

/** Handle all tool calls from a single model turn, sequentially. */
export async function processToolCalls(
  toolCalls: ToolCall[],
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
): Promise<void> {
  for (const tc of toolCalls) {
    await handleToolCall(tc, state, options, callbacks)
  }
}
