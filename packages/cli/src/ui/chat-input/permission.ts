// Permission-dialog cell builders + `formatElapsed`.
//
// Lives outside ChatInput.tsx because the permission rendering is a
// self-contained data → Cell[] mapping that has no React state.
import { getPermissionLevel } from '@x-code-cli/core'

import { highlightShellCommand } from '../render/shiki-highlight.js'
import { GLYPH_ELLIPSIS } from '../render/terminal-glyphs.js'
import { type Cell, ansiTextToCells, textToCells } from './cells.js'
import { S_DIM, S_ERROR_BOLD, S_NONE, S_PRIMARY, S_SUCCESS, S_WARNING } from './palette.js'
import { truncatePathFromStart } from './text-helpers.js'

export function permissionTitle(toolName: string, mcp?: { serverName: string; rawName: string }): string {
  if (mcp) return `X-Code wants to use MCP tool: ${mcp.serverName}/${mcp.rawName}`
  switch (toolName) {
    case 'shell':
      return 'X-Code wants to run a shell command'
    case 'writeFile':
      return 'X-Code wants to write a file'
    case 'edit':
      return 'X-Code wants to edit a file'
    case 'enterPlanMode':
      return 'X-Code wants to enter plan mode'
    default:
      return `X-Code wants to use ${toolName}`
  }
}

// Resolved per call (not a module-level table) because palette styles are
// `let` bindings re-derived on `/theme` switches — a captured table would
// freeze the strings from module load.
function permissionLevelStyle(level: string): { label: string; style: string } {
  switch (level) {
    case 'always-allow':
      return { label: 'read-only', style: S_SUCCESS }
    case 'deny':
      return { label: 'dangerous', style: S_ERROR_BOLD }
    default:
      return { label: 'write', style: S_WARNING }
  }
}

/** One-line `key: value, key: value` summary of an MCP tool's input.
 *  Values are JSON-encoded so strings render with their quotes and
 *  nested objects stay readable; long ones get trimmed before the join
 *  so a single oversized field can't swallow every other key. The outer
 *  truncate-to-terminal-width in `permissionContentCells` then caps the
 *  whole row. */
function mcpInputPreview(input: Record<string, unknown>): string {
  const keys = Object.keys(input)
  if (keys.length === 0) return '(no args)'
  const PER_VALUE_MAX = 60
  const parts = keys.map((k) => {
    let v: string
    try {
      v = JSON.stringify(input[k])
    } catch {
      v = String(input[k])
    }
    if (v === undefined) v = 'undefined'
    if (v.length > PER_VALUE_MAX) v = v.slice(0, PER_VALUE_MAX - 1) + '…'
    return `${k}: ${v}`
  })
  return parts.join(', ')
}

export function permissionContentCells(
  toolName: string,
  input: Record<string, unknown>,
  termWidth: number,
  mcp?: { serverName: string; rawName: string },
): Cell[] | null {
  // Frame geometry assumes exactly ONE row per permission content line.
  // When a string is longer than termWidth the terminal will auto-wrap it
  // onto the next physical row, which breaks every downstream absolute
  // cursor position (the Yes/No rows, the input separator, the prompt
  // itself) — the dialog appears "half missing" with only the title
  // visible. Truncate here so the cell matrix and the on-screen rows
  // stay 1:1. Mirrors the tool-bubble preview truncation in the live
  // tool-list rendering below.
  const truncateToWidth = (text: string, reservedCols: number): string => {
    const maxLen = Math.max(10, termWidth - reservedCols)
    return text.length > maxLen ? text.slice(0, maxLen - 1) + GLYPH_ELLIPSIS : text
  }
  if (mcp) {
    // One-line `key: value, key: value` preview of the input. MCP tools
    // can take arbitrary schemas, so we fall back to a generic serialiser
    // rather than trying to guess "the important field". Empty input
    // still renders the row (with `(no args)`) so the dialog height
    // matches shell/edit and the always-allow row sits where the user
    // expects it.
    const preview = mcpInputPreview(input)
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells(truncateToWidth(preview, 2 + 2), S_PRIMARY))
    return cells
  }
  if (toolName === 'shell') {
    const level = getPermissionLevel('shell', input)
    const info = permissionLevelStyle(level)
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    const rawCommand = String(input.command ?? '')
    // Leading 2 spaces + `$ ` + trailing space + `[label]` + 2-col safety
    // margin. The `$ ` is prepended AFTER truncation, so it must be in the
    // budget — otherwise a max-length command overflows boxedRow's content
    // width and truncateCellRow clips the tail of the `[label]` tag.
    const decoration = 2 + 2 + 1 + (info.label.length + 2) + 2 + 2
    const command = truncateToWidth(rawCommand, decoration)
    // Same codex-style shell highlighting as the live/committed tool rows.
    cells.push(...textToCells('$ ', S_PRIMARY))
    cells.push(...ansiTextToCells(highlightShellCommand(command)))
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells(`[${info.label}]`, info.style))
    return cells
  }
  if (toolName === 'writeFile') {
    const fp = String(input.filePath ?? '')
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    const suffix = ' (new file)'
    const truncated = truncatePathFromStart(fp, Math.max(10, termWidth - (2 + suffix.length + 2)))
    cells.push(...textToCells(truncated, S_PRIMARY))
    cells.push(...textToCells(suffix, S_DIM))
    return cells
  }
  if (toolName === 'edit') {
    const fp = String(input.filePath ?? '')
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells(truncatePathFromStart(fp, Math.max(10, termWidth - 4)), S_PRIMARY))
    return cells
  }
  if (toolName === 'enterPlanMode') {
    // Plan-mode entry has no per-call input — describe the consequence
    // so the user knows what Yes/No actually means.
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells('Read-only exploration; no edits until you approve a plan.', S_DIM))
    return cells
  }
  return null
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${minutes}m ${secs}s`
}
