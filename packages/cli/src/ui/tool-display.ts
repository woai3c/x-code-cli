// @x-code-cli/cli — Shared tool display utilities
//
// Provides human-readable labels, input previews, and result summaries
// for tool calls. Used by ChatInput's scrollback writer (committed tool
// rows) and its in-frame live tool indicator (`● Tool / ⎿ ⠋ Running...`)
// so both render paths produce the same label / preview / summary text.
//
// Tool name matching is case-insensitive to handle model/provider
// variations (e.g. "listDir" vs "ListDir", "readFile" vs "Read").

import { getShellProvider } from '@x-code-cli/core'

const SHELL_LABELS: Record<string, string> = {
  bash: 'Bash',
  zsh: 'Zsh',
  powershell: 'PowerShell',
}

/** Normalize tool name to lowercase for matching */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '')
}

/** Map tool name → human-readable label for display */
export function getToolLabel(toolName: string): string {
  const n = normalizeName(toolName)
  if (n === 'shell' || n === 'bash') return SHELL_LABELS[getShellProvider().type] ?? 'Shell'
  if (n === 'readfile' || n === 'read') return 'Read'
  if (n === 'writefile' || n === 'write') return 'Write'
  if (n === 'edit' || n === 'update') return 'Update'
  if (n === 'glob') return 'Glob'
  if (n === 'grep' || n === 'search') return 'Grep'
  if (n === 'listdir' || n === 'ls') return 'ListDir'
  if (n === 'websearch') return 'WebSearch'
  if (n === 'webfetch') return 'WebFetch'
  if (n === 'askuser') return 'AskUser'
  if (n === 'saveknowledge') return 'SaveKnowledge'
  if (n === 'enterplanmode') return 'EnterPlanMode'
  if (n === 'exitplanmode') return 'ExitPlanMode'
  if (n === 'task') return 'Task'
  if (n === 'todowrite') return 'TodoWrite'
  return toolName
}

/**
 * Extract the most relevant input preview for a tool call.
 * Tries to find a file path, pattern, command, or query — never falls
 * back to JSON.stringify (which produces escaped backslashes on Windows).
 */
export function getToolInputPreview(toolName: string, input: Record<string, unknown>): string {
  const n = normalizeName(toolName)

  // Shell / Bash — show the command
  if (n === 'shell' || n === 'bash') {
    return (input.command as string) || ''
  }

  // File operations — show the file path
  if (n === 'readfile' || n === 'read' || n === 'writefile' || n === 'write' || n === 'edit' || n === 'update') {
    return (input.filePath as string) || (input.file_path as string) || (input.path as string) || ''
  }

  // Directory listing
  if (n === 'listdir' || n === 'ls') {
    return (input.dirPath as string) || (input.dir_path as string) || (input.path as string) || ''
  }

  // Pattern-based tools
  if (n === 'glob' || n === 'grep' || n === 'search') {
    return (input.pattern as string) || (input.query as string) || ''
  }

  // Web tools
  if (n === 'websearch' || n === 'webfetch') {
    return (input.query as string) || (input.url as string) || ''
  }

  // Task (sub-agent)
  if (n === 'task') {
    const desc = (input.description as string) || ''
    const agent = (input.subagent_type as string) || ''
    return agent ? `${desc} (${agent})` : desc
  }

  // Generic: try common parameter names before falling back
  for (const key of ['filePath', 'file_path', 'path', 'dirPath', 'dir_path', 'command', 'pattern', 'query', 'url']) {
    if (typeof input[key] === 'string' && input[key]) {
      return input[key]
    }
  }

  // Last resort: show first string value (NOT JSON.stringify)
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.length <= 100) return val
  }

  return ''
}

/** Generate a short result summary for a completed tool call */
export function getToolResultSummary(toolName: string, output: string | undefined, status: string): string | null {
  if (status === 'denied') return 'Denied by user'
  if (!output) return 'Done'

  const n = normalizeName(toolName)

  if (n === 'writefile' || n === 'write') {
    // Result format: "File created: <path> (N lines)" or "File written: <path> (N lines)"
    const m = output.match(/\((\d+) lines?\)/)
    if (m) return `Wrote ${m[1]} lines`
    return 'Wrote file'
  }

  if (n === 'edit' || n === 'update') {
    return 'Applied changes'
  }

  if (n === 'readfile' || n === 'read') {
    const lineCount = (output.match(/\n/g) || []).length + 1
    return `${lineCount} lines`
  }

  if (n === 'listdir' || n === 'ls') {
    const entries = output
      .trim()
      .split('\n')
      .filter((l) => l.trim())
    return entries.length <= 6
      ? entries.join('\n')
      : entries.slice(0, 3).join('\n') + `\n... +${entries.length - 3} items`
  }

  if (n === 'glob') {
    const files = output
      .trim()
      .split('\n')
      .filter((l) => l.trim())
    return `${files.length} file${files.length !== 1 ? 's' : ''} matched`
  }

  if (n === 'grep' || n === 'search') {
    const lines = output
      .trim()
      .split('\n')
      .filter((l) => l.trim())
    return `${lines.length} result${lines.length !== 1 ? 's' : ''}`
  }

  // Task (sub-agent) — show a CC-style stats summary line
  if (n === 'task') {
    const statsMatch = output.match(/<task_stats\s+tool_calls="(\d+)"\s+tokens="(\d+)"\s+duration_ms="(\d+)"\s*\/>/)
    const resultMatch = output.match(/<task_result>\n?([\s\S]*?)\n?<\/task_result>/)
    const body = resultMatch ? resultMatch[1]! : output.replace(/<task_stats[^/]*\/>/, '').trim()
    const lines = body.trim().split('\n').filter((l) => l.trim())

    if (statsMatch) {
      const toolCalls = parseInt(statsMatch[1]!, 10)
      const tokens = parseInt(statsMatch[2]!, 10)
      const durationMs = parseInt(statsMatch[3]!, 10)
      const toolStr = toolCalls === 1 ? '1 tool use' : `${toolCalls} tool uses`
      const tokenStr = formatTokenCount(tokens)
      const durStr = formatTaskDuration(durationMs)
      return `Done (${toolStr} · ${tokenStr} tokens · ${durStr})`
    }

    if (lines.length === 0) return 'Done'
    if (lines.length <= 3) return lines.join('\n')
    return lines.slice(0, 2).join('\n') + `\n... +${lines.length - 2} lines`
  }

  // Web tools — compact one-line status in scrollback, matching Claude
  // Code's pattern. The "which websites" info lives on the STREAMING
  // progress line (⎿ ⠋ Found N results: host1, host2, host3) while the
  // tool is in-flight; once it finishes we collapse to a tight summary
  // so the history stays readable. Duration is appended by
  // stdout-writer.formatToolCall → `Did 1 search (6s)` / `Fetched page (1.2s)`.
  if (n === 'websearch') {
    return 'Did 1 search'
  }

  if (n === 'webfetch') {
    return 'Fetched page'
  }

  if (n === 'shell' || n === 'bash') {
    let text = output.trim()
    // Strip legacy "exit code: 0" prefix from old format results
    text = text.replace(/^exit code: 0\n?/, '')
    const lines = text.split('\n').filter((l) => l.trim())
    if (lines.length === 0) return 'Done'
    if (lines.length <= 4) return lines.join('\n')
    return lines.slice(0, 3).join('\n') + `\n... +${lines.length - 3} lines`
  }

  // Generic: show first few lines
  const lines = output
    .trim()
    .split('\n')
    .filter((l) => l.trim())
  if (lines.length === 0) return 'Done'
  if (lines.length <= 3) return lines.join('\n')
  return lines.slice(0, 2).join('\n') + `\n... +${lines.length - 2} lines`
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

function formatTaskDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSecs = seconds % 60
  return remainingSecs > 0 ? `${minutes}m ${remainingSecs}s` : `${minutes}m`
}
