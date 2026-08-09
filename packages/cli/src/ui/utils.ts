// @x-code-cli/cli — Shared UI utilities.
//
// Small helpers used by multiple modules. Extracted here to avoid
// copy-paste drift across files.
import type { DisplayToolCall } from '@x-code-cli/core'
import { getShellProvider } from '@x-code-cli/core'

// ── Layout constants ───────────────────────────────────────────────────

/** Indent for tool-result rows so the body aligns under the `   ⎿  `
 *  bracket (3 spaces + bracket + 2 spaces = 6 cells). Used by both the
 *  scrollback writer (stdout-writer) and the diff renderer (render-diff). */
export const RESULT_INDENT = '      '

// ── Line-ending normalization ──────────────────────────────────────────

/** Normalize line endings to `\n`. Critical before any terminal write:
 *  Windows pastes / clipboard content commonly arrive with `\r\n` or bare
 *  `\r`, and a bare `\r` in the terminal means "move cursor to column 0
 *  of the current row" — subsequent characters OVERWRITE whatever was
 *  previously printed on that row. */
export function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

// ── Boolean argument parsing ───────────────────────────────────────────

/** Parse a string as a boolean for CLI argument consumption.
 *  Accepts `on/true/1/enable/enabled` → true,
 *  `off/false/0/disable/disabled` → false,
 *  everything else → null (caller can show an error). */
export function parseBooleanArg(s: string): boolean | null {
  const trimmed = s.trim().toLowerCase()
  if (trimmed === 'on' || trimmed === 'true' || trimmed === '1' || trimmed === 'enable' || trimmed === 'enabled')
    return true
  if (trimmed === 'off' || trimmed === 'false' || trimmed === '0' || trimmed === 'disable' || trimmed === 'disabled')
    return false
  return null
}

// ── Duration formatting ────────────────────────────────────────────────

export interface DurationFmtOptions {
  /** Sub-second precision: number of decimal places for the seconds
   *  field when duration < 60s. Default 1. */
  precision?: number
  /** When true, omit trailing 's' on seconds fields. Default false. */
  compact?: boolean
}

/**
 * Format a millisecond duration into a human-readable string.
 *   <1s  → `"120ms"`
 *   <60s → `"3.5s"` (precision from options)
 *   >=60s → `"2m 15s"` (or `"2m"` when compact && secs === 0)
 */
export function formatDuration(ms: number, opts: DurationFmtOptions = {}): string {
  const { precision = 1, compact = false } = opts
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(precision)}s`
  const minutes = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  if (compact && secs === 0) return `${minutes}m`
  return `${minutes}m ${secs}s`
}

// ── Tool display helpers ───────────────────────────────────────────────

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '')
}

export function isCollapsibleReadOnlyTool(toolName: string): boolean {
  return COLLAPSIBLE_READ_ONLY_TOOLS.has(normalizeToolName(toolName))
}

const COLLAPSIBLE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'readfile',
  'read',
  'glob',
  'grep',
  'search',
  'listdir',
  'ls',
])

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

const SHELL_LABELS: Record<string, string> = {
  bash: 'Bash',
  zsh: 'Zsh',
  powershell: 'PowerShell',
}

export function getToolLabel(toolName: string): string {
  const n = normalizeToolName(toolName)
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
  if (n === 'enterplanmode') return 'EnterPlanMode'
  if (n === 'exitplanmode') return 'ExitPlanMode'
  if (n === 'task') return 'Task'
  if (n === 'todowrite') return 'TodoWrite'
  return toolName
}

export function getToolInputPreview(toolName: string, input: Record<string, unknown>): string {
  const n = normalizeToolName(toolName)

  if (n === 'shell' || n === 'bash') {
    return (input.command as string) || ''
  }

  if (n === 'readfile' || n === 'read' || n === 'writefile' || n === 'write' || n === 'edit' || n === 'update') {
    return (input.filePath as string) || (input.file_path as string) || (input.path as string) || ''
  }

  if (n === 'listdir' || n === 'ls') {
    return (input.dirPath as string) || (input.dir_path as string) || (input.path as string) || ''
  }

  if (n === 'glob' || n === 'grep' || n === 'search') {
    return (input.pattern as string) || (input.query as string) || ''
  }

  if (n === 'websearch' || n === 'webfetch') {
    return (input.query as string) || (input.url as string) || ''
  }

  if (n === 'task') {
    return (input.description as string) || ''
  }

  if (n === 'askuser') {
    const q = (input.question as string) || ''
    const firstLine = q.split(/\r?\n/)[0]?.trim() || ''
    return firstLine
  }

  // Last resort: show first string value (NOT JSON.stringify)
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.length <= 100) return val
  }

  return ''
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

export function formatCompactionResult(tokensBefore: number, tokensAfter: number): string {
  const removed = Math.max(0, tokensBefore - tokensAfter)
  return `Conversation compressed (estimated): before ~${formatTokenCount(tokensBefore)}; removed ~${formatTokenCount(removed)}; after ~${formatTokenCount(tokensAfter)}.`
}

export interface ReadGroupSummary {
  label: string
  detail?: string
}

const TABLE_OUTPUT_MAX_LINES = 30

export function formatReadGroupSummary(tools: readonly DisplayToolCall[]): ReadGroupSummary {
  let readCount = 0
  let grepCount = 0
  let globCount = 0
  let lsCount = 0
  const readPaths: string[] = []

  for (const tc of tools) {
    const n = normalizeToolName(tc.toolName)
    if (n === 'read' || n === 'readfile') {
      readCount++
      const p = (tc.input.filePath as string) || (tc.input.file_path as string) || (tc.input.path as string) || ''
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

  let detail: string | undefined
  if (readPaths.length > 0) {
    const shown = readPaths.slice(0, 3).join(', ')
    const rest = readPaths.length > 3 ? `, +${readPaths.length - 3} more` : ''
    detail = shown + rest
  }

  return detail ? { label, detail } : { label }
}

export function getToolResultSummary(toolName: string, output: string | undefined, status: string): string | null {
  if (status === 'denied') return 'Denied by user'
  if (!output) return 'Done'

  // Per-tool success summaries below are written for the happy path
  // (e.g. "Wrote file", "Applied changes"). When the tool errored —
  // permission denial, hook deny, exception — those cheery messages
  // are misleading; the bullet is rendered red but the text still
  // reads success. Surface the bounded error text instead so the user sees
  // the real cause without opening a debug log.
  if (status === 'error' || /^Error(?:\s|:)/i.test(output.trimStart())) {
    const lines = output
      .trim()
      .split('\n')
      .filter((line) => line.trim())
    return lines.length <= 3 ? lines.join('\n') : lines.slice(0, 3).join('\n') + `\n... +${lines.length - 3} lines`
  }

  const n = normalizeToolName(toolName)

  if (n === 'writefile' || n === 'write') {
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

  if (n === 'task') {
    const statsMatch = output.match(/<task_stats\s+tool_calls="(\d+)"\s+tokens="(\d+)"\s+duration_ms="(\d+)"\s*\/>/)
    const resultMatch = output.match(/<task_result>\n?([\s\S]*?)\n?<\/task_result>/)
    const body = resultMatch ? resultMatch[1]! : output.replace(/<task_stats[^/]*\/>/, '').trim()
    const lines = body
      .trim()
      .split('\n')
      .filter((l) => l.trim())

    if (statsMatch) {
      const toolCalls = parseInt(statsMatch[1]!, 10)
      const tokens = parseInt(statsMatch[2]!, 10)
      const durationMs = parseInt(statsMatch[3]!, 10)
      const toolStr = toolCalls === 1 ? '1 tool use' : `${toolCalls} tool uses`
      const tokenStr = formatTokenCount(tokens)
      const durStr = formatDuration(durationMs, { compact: true, precision: 0 })
      return `Done (${toolStr} · ${tokenStr} tokens · ${durStr})`
    }

    if (lines.length === 0) return 'Done'
    if (lines.length <= 3) return lines.join('\n')
    return lines.slice(0, 2).join('\n') + `\n... +${lines.length - 2} lines`
  }

  if (n === 'websearch') {
    return 'Did 1 search'
  }

  if (n === 'webfetch') {
    return 'Fetched page'
  }

  if (n === 'shell' || n === 'bash') {
    let text = output.trim()
    text = text.replace(/^exit code: 0\n?/, '')
    const lines = text.split('\n').filter((l) => l.trim())
    if (lines.length === 0) return 'Done'
    if (looksLikeTableOutput(lines)) return summarizeTableOutput(lines)
    if (lines.length <= 4) return lines.join('\n')
    return lines.slice(0, 3).join('\n') + `\n... +${lines.length - 3} lines`
  }

  const lines = output
    .trim()
    .split('\n')
    .filter((l) => l.trim())
  if (lines.length === 0) return 'Done'
  if (lines.length <= 3) return lines.join('\n')
  return lines.slice(0, 2).join('\n') + `\n... +${lines.length - 2} lines`
}

function looksLikeTableOutput(lines: readonly string[]): boolean {
  if (lines.length < 3) return false
  if (lines.some((line) => /[┌┬┐├┼┤└┴┘]/.test(line))) return true
  const markdownRows = lines.filter((line) => /^\s*\|.*\|\s*$/.test(line))
  if (
    markdownRows.length >= 2 &&
    lines.some((line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line))
  ) {
    return true
  }
  return lines.filter((line) => /^\s*\+[-=+]+\+\s*$/.test(line)).length >= 2
}

function summarizeTableOutput(lines: readonly string[]): string {
  if (lines.length <= TABLE_OUTPUT_MAX_LINES) return lines.join('\n')
  const bottom = lines.at(-1)
  if (bottom && isTableBottomBorder(bottom)) {
    const head = lines.slice(0, TABLE_OUTPUT_MAX_LINES - 2)
    const omitted = lines.length - head.length - 1
    return [...head, `... +${omitted} lines`, bottom].join('\n')
  }
  const head = lines.slice(0, TABLE_OUTPUT_MAX_LINES - 1)
  return [...head, `... +${lines.length - head.length} lines`].join('\n')
}

function isTableBottomBorder(line: string): boolean {
  const trimmed = line.trim()
  return /[└┴┘]/.test(trimmed) || /^\+[-=+]+\+$/.test(trimmed)
}
