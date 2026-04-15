// @x-code-cli/cli — User text input component (multi-line textarea)
//
// RENDERING STRATEGY — MULTI-LINE CELL-LEVEL DIFF:
//   Renders a multi-line textarea with top/bottom separators directly to
//   stdout.  Each frame is a 2D grid of cells.  The renderer diffs against
//   the previous frame cell-by-cell, line-by-line, and writes ALL changes
//   in a SINGLE process.stdout.write() call.  Unchanged CJK characters are
//   never re-written, eliminating jitter on ConHost.
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'

import { useStdout } from 'ink'

import { usePromptInput } from '../hooks/use-prompt-input.js'
import { type PastedContents, expandPasteRefs, stripTrailingRef } from '../paste-refs.js'

const PASTE_REF_MIN_LINES = 3
const PASTE_REF_MIN_CHARS = 400

// ── CJK width helpers ───────────────────────────────────────────────────

function isWide(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fa1f) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3100 && cp <= 0x312f) ||
    (cp >= 0x3200 && cp <= 0x32ff) ||
    (cp >= 0x3300 && cp <= 0x33ff)
  )
}

function charWidth(ch: string): number {
  return isWide(ch.codePointAt(0)!) ? 2 : 1
}

function visualWidth(str: string): number {
  let w = 0
  for (const ch of str) w += charWidth(ch)
  return w
}

function sliceByWidth(str: string, maxCols: number): string {
  let w = 0,
    i = 0
  for (const ch of str) {
    const cw = charWidth(ch)
    if (w + cw > maxCols) break
    w += cw
    i += ch.length
  }
  return str.slice(0, i)
}

function skipByWidth(str: string, skipCols: number): number {
  let w = 0,
    i = 0
  for (const ch of str) {
    if (w >= skipCols) break
    w += charWidth(ch)
    i += ch.length
  }
  return i
}

// ── Types ───────────────────────────────────────────────────────────────

export interface SlashCommand {
  name: string
  description: string
}

interface ChatInputProps {
  onSubmit: (text: string) => void
  onInterrupt: () => void
  disabled?: boolean
  commands?: readonly SlashCommand[]
}

const MAX_VISIBLE_LINES = 10

// ── Reducer for atomic text + cursor updates ──────────────────────────

interface InputState {
  text: string
  cursor: number
}

type InputAction =
  | { type: 'INSERT'; pos: number; chunk: string }
  | { type: 'BACKSPACE_REF'; pos: number; deleteCount: number }
  | { type: 'DELETE'; pos: number }
  | { type: 'SET_CURSOR'; cursor: number }
  | { type: 'SET_TEXT'; text: string; cursor: number }
  | { type: 'RESET' }

function inputReducer(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case 'INSERT': {
      const { pos, chunk } = action
      return {
        text: state.text.slice(0, pos) + chunk + state.text.slice(pos),
        cursor: pos + chunk.length,
      }
    }
    case 'BACKSPACE_REF': {
      const { pos, deleteCount } = action
      if (pos === 0) return state
      return {
        text: state.text.slice(0, pos - deleteCount) + state.text.slice(pos),
        cursor: pos - deleteCount,
      }
    }
    case 'DELETE': {
      const { pos } = action
      if (pos >= state.text.length) return state
      return { text: state.text.slice(0, pos) + state.text.slice(pos + 1), cursor: state.cursor }
    }
    case 'SET_CURSOR':
      return state.cursor === action.cursor ? state : { ...state, cursor: action.cursor }
    case 'SET_TEXT':
      return { text: action.text, cursor: action.cursor }
    case 'RESET':
      return { text: '', cursor: 0 }
    default:
      return state
  }
}

// ── Cell representation ─────────────────────────────────────────────────

interface Cell {
  char: string
  style: string
  width: number
}

function cellsEqual(a: Cell, b: Cell): boolean {
  return a.char === b.char && a.style === b.style
}

const S_GRAY = '\x1b[38;2;136;136;136m'
const S_ACCENT = `\x1b[38;2;215;119;87m`
const S_ACCENT_BOLD = `\x1b[38;2;215;119;87;1m`
const S_DIM = '\x1b[2m'
const S_BOLD_OFF = '\x1b[22m'
const S_RESET = '\x1b[39m'
const S_INV = '\x1b[7m'
const S_INV_OFF = '\x1b[27m'
const S_NONE = ''

function textToCells(text: string, style: string): Cell[] {
  const cells: Cell[] = []
  for (const ch of text) cells.push({ char: ch, style, width: charWidth(ch) })
  return cells
}

// ── Component ───────────────────────────────────────────────────────────

export function ChatInput({ onSubmit, onInterrupt, disabled, commands = [] }: ChatInputProps) {
  const [{ text, cursor }, dispatch] = useReducer(inputReducer, { text: '', cursor: 0 })
  const cursorRef = useRef(0)
  useLayoutEffect(() => {
    cursorRef.current = cursor
  })
  const [pastedContents, setPastedContents] = useState<PastedContents>({})
  const [completionIndex, setCompletionIndex] = useState(0)
  const nextPasteIdRef = useRef(1)
  const lastEscRef = useRef(0)
  const activeRef = useRef(false)
  const prevFrameRef = useRef<Cell[][]>([])

  const { stdout } = useStdout()
  const termWidth = stdout?.columns ?? 80

  // ── Fuzzy matching ──
  const matches = useMemo(() => {
    if (!text.startsWith('/') || text.includes(' ')) return []
    const query = text.slice(1).toLowerCase()
    if (!query) return [...commands]
    return commands.filter((cmd) => {
      const name = cmd.name.slice(1).toLowerCase()
      let qi = 0
      for (let ni = 0; ni < name.length && qi < query.length; ni++) {
        if (name[ni] === query[qi]) qi++
      }
      return qi === query.length
    })
  }, [text, commands])

  const safeIndex = matches.length > 0 ? completionIndex % matches.length : 0
  const currentMatch = matches.length > 0 ? matches[safeIndex] : null

  const handleSubmit = () => {
    if (!text.trim()) return
    const expanded = expandPasteRefs(text, pastedContents)
    onSubmit(expanded)
    dispatch({ type: 'RESET' })
    setPastedContents({})
    setCompletionIndex(0)
  }

  const moveCursorVertically = (delta: number) => {
    const lines = text.split('\n')
    let line = 0,
      col = cursorRef.current,
      charsSoFar = 0
    for (let i = 0; i < lines.length; i++) {
      if (charsSoFar + lines[i].length >= cursorRef.current && cursorRef.current >= charsSoFar) {
        line = i
        col = cursorRef.current - charsSoFar
        break
      }
      charsSoFar += lines[i].length + 1
    }
    const targetLine = Math.max(0, Math.min(lines.length - 1, line + delta))
    if (targetLine === line) return
    const targetCol = Math.min(col, lines[targetLine].length)
    let newPos = 0
    for (let i = 0; i < targetLine; i++) newPos += lines[i].length + 1
    newPos += targetCol
    dispatch({ type: 'SET_CURSOR', cursor: newPos })
  }

  usePromptInput({
    enabled: !disabled,
    onInterrupt,
    onText: (chunk) => {
      dispatch({ type: 'INSERT', pos: cursorRef.current, chunk })
      setCompletionIndex(0)
    },
    onPaste: (content) => {
      dispatch({ type: 'INSERT', pos: cursorRef.current, chunk: content })
      setCompletionIndex(0)
    },
    onKey: (key) => {
      if (key === 'return') {
        handleSubmit()
        return
      }
      if (key === 'escape') {
        const now = Date.now()
        if (now - lastEscRef.current < 500 && text.length > 0) {
          dispatch({ type: 'RESET' })
          setPastedContents({})
          setCompletionIndex(0)
        }
        lastEscRef.current = now
        return
      }
      if (key === 'backspace') {
        const pos = cursorRef.current
        if (pos === 0) return
        const before = text.slice(0, pos)
        const stripped = stripTrailingRef(before)
        if (stripped) {
          setPastedContents((pc) => {
            const n = { ...pc }
            delete n[stripped.id]
            return n
          })
          const deleteCount = before.length - stripped.without.length
          dispatch({ type: 'BACKSPACE_REF', pos, deleteCount })
        } else {
          dispatch({ type: 'BACKSPACE_REF', pos, deleteCount: 1 })
        }
        setCompletionIndex(0)
        return
      }
      if (key === 'delete') {
        dispatch({ type: 'DELETE', pos: cursorRef.current })
        return
      }
      if (key === 'left') {
        dispatch({ type: 'SET_CURSOR', cursor: Math.max(0, cursorRef.current - 1) })
        return
      }
      if (key === 'right') {
        dispatch({ type: 'SET_CURSOR', cursor: Math.min(text.length, cursorRef.current + 1) })
        return
      }
      if (key === 'home') {
        dispatch({ type: 'SET_CURSOR', cursor: 0 })
        return
      }
      if (key === 'end') {
        dispatch({ type: 'SET_CURSOR', cursor: text.length })
        return
      }
      if (key === 'tab') {
        if (currentMatch) {
          dispatch({ type: 'SET_TEXT', text: currentMatch.name, cursor: currentMatch.name.length })
          setCompletionIndex(0)
        }
        return
      }
      if (key === 'up') {
        if (matches.length > 0) setCompletionIndex((p) => (p - 1 + matches.length) % matches.length)
        else moveCursorVertically(-1)
        return
      }
      if (key === 'down') {
        if (matches.length > 0) setCompletionIndex((p) => (p + 1) % matches.length)
        else moveCursorVertically(1)
        return
      }
      if (key === 'pageup') {
        moveCursorVertically(-MAX_VISIBLE_LINES)
        return
      }
      if (key === 'pagedown') {
        moveCursorVertically(MAX_VISIBLE_LINES)
        return
      }
    },
  })

  // ── Multi-line frame rendering with cell-level diff ──────────────────

  useEffect(() => {
    if (disabled) {
      if (activeRef.current) {
        // Erase our region
        const prevH = prevFrameRef.current.length
        if (prevH > 1) {
          let buf = `\x1b[${prevH - 1}A` // move to top of region
          for (let i = 0; i < prevH; i++) buf += '\r\x1b[K' + (i < prevH - 1 ? '\x1b[1B' : '')
          buf += `\x1b[${prevH - 1}A` // move back to top
          process.stdout.write(buf)
        } else if (prevH === 1) {
          process.stdout.write('\r\x1b[K')
        }
        activeRef.current = false
        prevFrameRef.current = []
      }
      return
    }

    activeRef.current = true

    const PROMPT_WIDTH = 2
    const vpWidth = Math.max(20, termWidth - PROMPT_WIDTH - 1)
    const sepChar = '\u2500'
    const sepText = sepChar.repeat(Math.max(0, termWidth - 1))

    // ── Build display lines (with visible windowing) ──
    const rawLines = text.length === 0 ? [''] : text.split('\n')

    let rawCursorLine = 0,
      cursorCol = cursor
    {
      let charsSoFar = 0
      for (let i = 0; i < rawLines.length; i++) {
        if (cursor >= charsSoFar && cursor <= charsSoFar + rawLines[i].length) {
          rawCursorLine = i
          cursorCol = cursor - charsSoFar
          break
        }
        charsSoFar += rawLines[i].length + 1
      }
    }

    let displayLines: string[]
    let cursorLine: number
    if (rawLines.length <= MAX_VISIBLE_LINES) {
      displayLines = rawLines
      cursorLine = rawCursorLine
    } else {
      let start = rawCursorLine - Math.floor(MAX_VISIBLE_LINES / 2)
      start = Math.max(0, Math.min(start, rawLines.length - MAX_VISIBLE_LINES))
      displayLines = rawLines.slice(start, start + MAX_VISIBLE_LINES)
      cursorLine = rawCursorLine - start
      if (start > 0) {
        displayLines[0] = `\u2026 (+${start} above)`
        if (cursorLine === 0) cursorLine = -1
      }
      if (start + MAX_VISIBLE_LINES < rawLines.length) {
        displayLines[displayLines.length - 1] = `\u2026 (+${rawLines.length - start - MAX_VISIBLE_LINES} below)`
        if (cursorLine === displayLines.length - 1) cursorLine = -1
      }
    }

    // ── Build 2D cell frame ──
    const frame: Cell[][] = []

    // Top separator
    frame.push(textToCells(sepText, S_GRAY))

    // Input lines
    for (let i = 0; i < displayLines.length; i++) {
      const line = displayLines[i]
      const prompt = i === 0 ? '> ' : '  '
      const showCursor = i === cursorLine && cursorLine >= 0
      const cells: Cell[] = []

      // Prompt
      cells.push({ char: prompt[0], style: S_GRAY, width: 1 })
      cells.push({ char: prompt[1], style: S_NONE, width: 1 })

      if (!showCursor) {
        const lw = visualWidth(line)
        const truncated = lw > vpWidth ? sliceByWidth(line, vpWidth) : line
        cells.push(...textToCells(truncated, S_RESET))
      } else {
        const before = line.slice(0, cursorCol)
        const cursorChar = cursorCol < line.length ? line[cursorCol] : ' '
        const after = cursorCol < line.length ? line.slice(cursorCol + 1) : ''
        const lw = visualWidth(line)

        if (lw <= vpWidth) {
          cells.push(...textToCells(before, S_RESET))
          cells.push({ char: cursorChar, style: S_INV, width: charWidth(cursorChar) })
          cells.push(...textToCells(after, S_RESET))
        } else {
          const beforeWidth = visualWidth(before)
          const halfVP = Math.floor(vpWidth / 2)
          let skipCols = Math.max(0, beforeWidth - halfVP)
          const totalWidth = lw + (cursorCol >= line.length ? 1 : 0)
          if (skipCols + vpWidth > totalWidth) skipCols = Math.max(0, totalWidth - vpWidth)
          const startIdx = skipByWidth(line, skipCols)
          const vb = line.slice(startIdx, cursorCol)
          const afterStart = cursorCol < line.length ? cursorCol + 1 : line.length
          const remaining = vpWidth - visualWidth(vb) - charWidth(cursorChar)
          const va = sliceByWidth(line.slice(afterStart), Math.max(0, remaining))
          cells.push(...textToCells(vb, S_RESET))
          cells.push({ char: cursorChar, style: S_INV, width: charWidth(cursorChar) })
          cells.push(...textToCells(va, S_RESET))
        }
      }
      frame.push(cells)
    }

    // Bottom separator
    frame.push(textToCells(sepText, S_GRAY))

    // Completion menu
    if (matches.length > 0) {
      const maxNameLen = matches.reduce((max, cmd) => Math.max(max, cmd.name.length), 0)
      for (let i = 0; i < matches.length; i++) {
        const cmd = matches[i]
        const sel = i === safeIndex
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        const nameStr = cmd.name.padEnd(maxNameLen + 2)
        if (sel) {
          cells.push(...textToCells(nameStr, S_ACCENT_BOLD))
          cells.push(...textToCells(cmd.description, S_RESET))
        } else {
          cells.push(...textToCells(nameStr + cmd.description, S_DIM))
        }
        frame.push(cells)
      }
    }

    // ── Diff with previous frame and build output buffer ──
    const prevFrame = prevFrameRef.current
    const prevH = prevFrame.length
    const nextH = frame.length
    const maxH = Math.max(prevH, nextH)

    let buf = ''

    // Move cursor to top of region.
    // After the previous render the cursor sits on the LAST row (prevH-1),
    // so we move up by (prevH - 1) rows to reach row 0.
    if (prevH > 1) {
      buf += `\x1b[${prevH - 1}A`
    }

    for (let row = 0; row < maxH; row++) {
      const prevRow = row < prevH ? prevFrame[row] : []
      const nextRow = row < nextH ? frame[row] : []

      if (row < nextH) {
        // Find first diff cell
        let diffIdx = 0
        const minCells = Math.min(prevRow.length, nextRow.length)
        while (diffIdx < minCells && cellsEqual(prevRow[diffIdx], nextRow[diffIdx])) {
          diffIdx++
        }

        if (diffIdx < nextRow.length || nextRow.length < prevRow.length) {
          // Calculate column at diffIdx
          let col = 0
          for (let c = 0; c < diffIdx; c++) col += nextRow[c].width

          // Move to the diff column
          buf += `\x1b[${col + 1}G`

          // Write changed cells
          let lastStyle = ''
          for (let c = diffIdx; c < nextRow.length; c++) {
            const cell = nextRow[c]
            if (cell.style !== lastStyle) {
              buf += cell.style
              lastStyle = cell.style
            }
            buf += cell.char
            if (cell.style === S_INV) {
              buf += S_INV_OFF
              lastStyle = S_NONE
            }
          }
          buf += S_RESET

          // Pad/erase if old row was wider
          let oldTailW = 0
          for (let c = diffIdx; c < prevRow.length; c++) oldTailW += prevRow[c].width
          let newTailW = 0
          for (let c = diffIdx; c < nextRow.length; c++) newTailW += nextRow[c].width
          if (oldTailW > newTailW) {
            buf += ' '.repeat(oldTailW - newTailW)
          }
        }
        // else: row unchanged, skip
      } else {
        // Extra old row — erase it
        buf += '\r\x1b[K'
      }

      // Move to next row (except after last row)
      if (row < maxH - 1) {
        if (row < prevH - 1) {
          // Line below already exists — cursor down (no scroll, no new line)
          buf += '\x1b[1B'
        } else {
          // Line below doesn't exist yet — line feed to create it
          buf += '\n'
        }
      }
    }

    // After the loop, cursor is on the last row we touched (row maxH-1).
    // We want it on the last row of the NEW frame (row nextH-1).
    // Move up by (maxH-1) - (nextH-1) = maxH - nextH.
    if (maxH > nextH) {
      buf += `\x1b[${maxH - nextH}A`
    }

    if (buf) {
      process.stdout.write(buf)
    }

    prevFrameRef.current = frame
  })

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (activeRef.current) {
        const prevH = prevFrameRef.current.length
        if (prevH > 1) {
          let buf = `\x1b[${prevH - 1}A`
          for (let i = 0; i < prevH; i++) buf += '\r\x1b[K' + (i < prevH - 1 ? '\x1b[1B' : '')
          buf += `\x1b[${prevH - 1}A`
          process.stdout.write(buf)
        } else if (prevH === 1) {
          process.stdout.write('\r\x1b[K')
        }
        activeRef.current = false
        prevFrameRef.current = []
      }
    }
  }, [])

  // Return null — everything is rendered via direct stdout writes
  return null
}
