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
import type { DisplayToolCall } from '@x-code-cli/core'

const SHELL_LABELS: Record<string, string> = {
  bash: 'Bash',
  zsh: 'Zsh',
  powershell: 'PowerShell',
}

/** Normalize tool name to lowercase for matching */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '')
}

/** Tools whose calls can be folded into a single "● Read 3 files" summary line
 *  when 2+ of them appear consecutively in scrollback. Excludes WebSearch /
 *  WebFetch (their result blurbs carry meaningful info — collapsing hides it),
 *  Shell (no reliable read-only classification), and Task (sub-agent, not a
 *  read). Mirrors the categories Claude Code groups in its `collapseReadSearch`
 *  pipeline minus the model-tagged Bash branch. */
const COLLAPSIBLE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'readfile', 'read',
  'glob',
  'grep', 'search',
  'listdir', 'ls',
])

export function isCollapsibleReadOnlyTool(toolName: string): boolean {
  return COLLAPSIBLE_READ_ONLY_TOOLS.has(normalizeName(toolName))
}

/** Strip directory prefix — used for the "(foo.ts, bar.ts)" detail suffix.
 *  Handles both POSIX and Windows separators because tool inputs sometimes
 *  carry mixed slashes on Windows (model outputs `/` while ListDir results
 *  use `\`). */
function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

export interface ReadGroupSummary {
  /** Bold-rendered label, e.g. "Read 3 files" or
   *  "Searched for 2 patterns, read 1 file". Mirrors the single-tool
   *  `Tool` portion of an existing tool row. */
  label: string
  /** Optional paren'd detail rendered in BLUE_PURPLE to match the
   *  single-tool `(input)` suffix. Currently used to list the basename
   *  of files Read'd so users still see WHAT was read at a glance —
   *  losing that to a bare count makes the summary feel opaque. */
  detail?: string
}

/** Build the label/detail pair for a collapsed read-group. Caller (the
 *  stdout-writer flush path) wraps the label in `c.bold` and the detail
 *  in `c.hex(BLUE_PURPLE)` to visually match a regular tool row.
 *
 *  Bucket strategy: count by category (read / search / glob / list).
 *  Single-clause cases get pluralization right; mixed clauses join with
 *  ", " and only the first clause is capitalized so the line reads as
 *  one sentence ("Read 2 files, searched for 1 pattern"). */
export function formatReadGroupSummary(tools: readonly DisplayToolCall[]): ReadGroupSummary {
  let readCount = 0
  let grepCount = 0
  let globCount = 0
  let lsCount = 0
  const readPaths: string[] = []

  for (const tc of tools) {
    const n = normalizeName(tc.toolName)
    if (n === 'read' || n === 'readfile') {
      readCount++
      const p =
        (tc.input.filePath as string) ||
        (tc.input.file_path as string) ||
        (tc.input.path as string) ||
        ''
      if (p) readPaths.push(basename(p))
    } else if (n === 'grep' || n === 'search') {
      grepCount++
    } else if (n === 'glob') {
      globCount++
    } else if (n === 'listdir' || n === 'ls') {
      lsCount++
    }
  }

  const clauses: string[] = []
  if (readCount > 0) clauses.push(`read ${readCount} file${readCount === 1 ? '' : 's'}`)
  if (grepCount > 0) clauses.push(`searched for ${grepCount} pattern${grepCount === 1 ? '' : 's'}`)
  if (globCount > 0) clauses.push(`globbed ${globCount} pattern${globCount === 1 ? '' : 's'}`)
  if (lsCount > 0) clauses.push(`listed ${lsCount} director${lsCount === 1 ? 'y' : 'ies'}`)

  if (clauses.length > 0) {
    const first = clauses[0]!
    clauses[0] = first.charAt(0).toUpperCase() + first.slice(1)
  }
  const label = clauses.join(', ')

  // Sample basenames for read calls so the summary still says WHAT was
  // read. Cap at 3 names; anything beyond becomes "+N more" so very long
  // chains don't wrap onto a second line.
  let detail: string | undefined
  if (readPaths.length > 0) {
    const shown = readPaths.slice(0, 3).join(', ')
    const rest = readPaths.length > 3 ? `, +${readPaths.length - 3} more` : ''
    detail = shown + rest
  }

  return detail ? { label, detail } : { label }
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

  // Task (sub-agent) — only show the description; subagent_type
  // (explore, shell, etc.) is internal detail and redundant with
  // the description the model already chose.
  if (n === 'task') {
    return (input.description as string) || ''
  }

  // AskUser — show only the first line of the question in the
  // preview (the title row). Full question text can be very long
  // multi-paragraph markdown; collapsing it into one line makes
  // it overflow the terminal width and become unreadable.
  if (n === 'askuser') {
    const q = (input.question as string) || ''
    const firstLine = q.split(/\r?\n/)[0]?.trim() || ''
    return firstLine
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
