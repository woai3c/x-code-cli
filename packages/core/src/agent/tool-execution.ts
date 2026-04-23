// @x-code-cli/core — Tool execution & dispatch
import { execa } from 'execa'

import fs from 'node:fs/promises'
import path from 'node:path'

import { checkPermission } from '../permissions/index.js'
import { truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, reportProgress, setProgressReporter } from '../tools/progress.js'
import { getShellConfig } from '../tools/shell-utils.js'
import type { AgentCallbacks, AgentOptions } from '../types/index.js'
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
    await fs.writeFile(filePath, content, 'utf-8')
    return `File written: ${filePath} (${content.length} characters)`
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
): Promise<string> {
  const { executable, args, type } = getShellConfig()

  // On Windows, force the console codepage to UTF-8 (65001) at the OS level
  // BEFORE PowerShell starts parsing the command. This ensures even parse errors
  // (e.g. `&&` on PS 5.1) produce UTF-8 output instead of GBK garbled text.
  // We wrap via `cmd.exe /c "chcp 65001 >nul && powershell ..."` because
  // [Console]::OutputEncoding only takes effect after parsing completes.
  let proc
  if (type === 'powershell') {
    const escapedCommand = command.replace(/"/g, '\\"')
    const psCmd = `chcp 65001 >nul && ${executable} ${args.join(' ')} "${escapedCommand}"`
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
  return `exit code: ${result.exitCode}\n${result.stdout}\n${result.stderr}`.trim()
}

/** Push a tool result to state and notify the UI. */
function pushToolResult(
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
): void {
  state.messages.push(toolResultMessage(toolCallId, toolName, output))
  // Clear the progress reporter for manually-dispatched tools (shell,
  // writeFile, edit, askUser). Auto-executed tools go through the SDK
  // stream's `tool-result` event and are cleared there — this call is
  // a no-op in that case since the reporter would already be gone.
  clearProgressReporter(toolCallId)
  callbacks.onToolResult(toolCallId, output)
}

type ToolCall = { toolName: string; toolCallId: string; input: Record<string, unknown> }

/** Handle a single tool call. Returns when the call has been fully dispatched. */
async function handleToolCall(
  tc: ToolCall,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
): Promise<void> {
  const { toolName, input, toolCallId } = tc

  // ── askUser tool ──
  if (toolName === 'askUser') {
    const question = input.question as string
    const optionsList = input.options as { label: string; description: string }[]
    const answer = await callbacks.onAskUser(question, optionsList)
    pushToolResult(state, callbacks, toolCallId, toolName, `User answered: ${answer}`)
    return
  }

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
  try {
    if (toolName === 'writeFile' || toolName === 'edit') {
      output = await executeWriteTool(toolName, input, toolCallId)
      state.filesModified.add(input.filePath as string)
    } else if (toolName === 'shell') {
      const timeout = (input.timeout as number) ?? 30000
      output = await executeShell(input.command as string, timeout, callbacks, toolCallId)
    } else {
      // Tools with execute (readFile, glob, grep, etc.) are auto-executed by AI SDK
      return
    }
  } catch (err) {
    output = `Error: ${err instanceof Error ? err.message : String(err)}`
  }

  pushToolResult(state, callbacks, toolCallId, toolName, truncateToolResult(output))
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
