// Permission-dialog cell builders + `formatElapsed`.
//
// Lives outside ChatInput.tsx because the permission rendering is a
// self-contained data → Cell[] mapping that has no React state.
import { getPermissionLevel } from '@x-code-cli/core'

import { GLYPH_ELLIPSIS } from '../../terminal-glyphs.js'
import { type Cell, textToCells } from './cells.js'
import { S_ACCENT, S_ACCENT_DIM, S_DIM, S_ERROR_BOLD, S_NONE, S_SUCCESS, S_WARNING } from './palette.js'

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

const PERMISSION_LEVEL_STYLE: Record<string, { label: string; style: string }> = {
  'always-allow': { label: 'read-only', style: S_SUCCESS },
  ask: { label: 'write', style: S_WARNING },
  deny: { label: 'dangerous', style: S_ERROR_BOLD },
}

/** One-line `key: value, key: value` summary of an MCP tool's input.
 *  Values are JSON-encoded so strings render with their quotes and
 *  nested objects stay readable; long ones get trimmed before the join
 *  so a single oversized field can't swallow every other key. The outer
 *  truncate-to-terminal-width in `permissionContentCells` then caps the
 *  whole row. */
export function mcpInputPreview(input: Record<string, unknown>): string {
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
    cells.push(...textToCells(truncateToWidth(preview, 2 + 2), S_ACCENT))
    return cells
  }
  if (toolName === 'shell') {
    const level = getPermissionLevel('shell', input)
    const info = PERMISSION_LEVEL_STYLE[level] ?? PERMISSION_LEVEL_STYLE.ask
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    const rawCommand = String(input.command ?? '')
    const decoration = 2 + 2 + 1 + (info.label.length + 2) + 2
    const command = truncateToWidth('$ ' + rawCommand, decoration)
    cells.push(...textToCells(command, S_ACCENT))
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
    const truncated = truncateToWidth(fp, 2 + suffix.length + 2)
    cells.push(...textToCells(truncated, S_ACCENT))
    cells.push(...textToCells(suffix, S_ACCENT_DIM))
    return cells
  }
  if (toolName === 'edit') {
    const fp = String(input.filePath ?? '')
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells(truncateToWidth(fp, 2 + 2), S_ACCENT))
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
