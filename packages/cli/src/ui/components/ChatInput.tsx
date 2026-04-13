// @x-code-cli/cli — User text input component
//
// RENDERING STRATEGY — OVERWRITE, NEVER ERASE:
//   Standard Ink clears the dynamic region before each repaint, causing a
//   brief flash visible as jitter (especially with CJK IME input). Claude
//   Code avoids this with cell-level diffing that patches only changed cells.
//
//   We achieve the same effect without forking Ink: ChatInput returns null
//   to Ink (empty dynamic region = nothing to clear/redraw), and writes
//   directly to stdout using ANSI cursor movement + overwrite. Each line is
//   right-padded with spaces to terminal width, so old content is covered
//   without any erase command. No erase = no flash = no jitter.
import { Chalk } from 'chalk'

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useStdout } from 'ink'

import { usePromptInput } from '../hooks/use-prompt-input.js'
import {
  type PastedContents,
  expandPasteRefs,
  formatPasteRef,
  stripTrailingRef,
} from '../paste-refs.js'
import { ACCENT, PROMPT_BORDER } from '../theme.js'

const c = new Chalk({ level: 3 })

const PASTE_REF_MIN_LINES = 3
const PASTE_REF_MIN_CHARS = 400

// ── CJK width helpers ───────────────────────────────────────────────────

function isWide(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fa1f) || (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x3100 && cp <= 0x312f) ||
    (cp >= 0x3200 && cp <= 0x32ff) || (cp >= 0x3300 && cp <= 0x33ff)
  )
}

function visualWidth(str: string): number {
  let w = 0
  for (const ch of str) w += isWide(ch.codePointAt(0)!) ? 2 : 1
  return w
}

function sliceByWidth(str: string, maxCols: number): string {
  let w = 0, i = 0
  for (const ch of str) {
    const cw = isWide(ch.codePointAt(0)!) ? 2 : 1
    if (w + cw > maxCols) break
    w += cw; i += ch.length
  }
  return str.slice(0, i)
}

function skipByWidth(str: string, skipCols: number): number {
  let w = 0, i = 0
  for (const ch of str) {
    if (w >= skipCols) break
    w += isWide(ch.codePointAt(0)!) ? 2 : 1; i += ch.length
  }
  return i
}

/** Pad a visual-width-aware string to exactly `cols` terminal columns with spaces. */
function padLine(ansiStr: string, plainStr: string, cols: number): string {
  const vw = visualWidth(plainStr)
  if (vw >= cols) return ansiStr
  return ansiStr + ' '.repeat(cols - vw)
}

// ── Types ───────────────────────────────────────────────────────────────

export interface SlashCommand { name: string; description: string }

interface ChatInputProps {
  onSubmit: (text: string) => void
  onInterrupt: () => void
  disabled?: boolean
  commands?: readonly SlashCommand[]
}

const MAX_VISIBLE_LINES = 6

// ── Component ───────────────────────────────────────────────────────────

export function ChatInput({ onSubmit, onInterrupt, disabled, commands = [] }: ChatInputProps) {
  const [text, setText] = useState('')
  const [cursor, setCursor] = useState(0)
  const cursorRef = useRef(0)
  const syncCursor = (pos: number | ((prev: number) => number)) => {
    setCursor((prev) => {
      const next = typeof pos === 'function' ? pos(prev) : pos
      cursorRef.current = next
      return next
    })
  }
  const [pastedContents, setPastedContents] = useState<PastedContents>({})
  const [completionIndex, setCompletionIndex] = useState(0)
  const nextPasteIdRef = useRef(1)
  const lastEscRef = useRef(0)
  const prevLinesRef = useRef(0)
  const mountedRef = useRef(false)

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
    setText('')
    syncCursor(0)
    setPastedContents({})
    setCompletionIndex(0)
  }

  const moveCursorVertically = (delta: number) => {
    const lines = text.split('\n')
    let line = 0, col = cursorRef.current, charsSoFar = 0
    for (let i = 0; i < lines.length; i++) {
      if (charsSoFar + lines[i].length >= cursorRef.current && cursorRef.current >= charsSoFar) {
        line = i; col = cursorRef.current - charsSoFar; break
      }
      charsSoFar += lines[i].length + 1
    }
    const targetLine = Math.max(0, Math.min(lines.length - 1, line + delta))
    if (targetLine === line) return
    const targetCol = Math.min(col, lines[targetLine].length)
    let newPos = 0
    for (let i = 0; i < targetLine; i++) newPos += lines[i].length + 1
    newPos += targetCol
    syncCursor(newPos)
  }

  usePromptInput({
    enabled: !disabled,
    onInterrupt,
    onText: (chunk) => {
      const pos = cursorRef.current
      setText((prev) => prev.slice(0, pos) + chunk + prev.slice(pos))
      syncCursor(pos + chunk.length)
      setCompletionIndex(0)
    },
    onPaste: (content) => {
      const lineCount = content.split(/\r\n|\r|\n/).length
      const isLarge = lineCount >= PASTE_REF_MIN_LINES || content.length >= PASTE_REF_MIN_CHARS
      const pos = cursorRef.current
      if (isLarge) {
        const id = nextPasteIdRef.current++
        setPastedContents((prev) => ({ ...prev, [id]: { id, content, lineCount } }))
        const ref = formatPasteRef(id, lineCount)
        setText((prev) => prev.slice(0, pos) + ref + prev.slice(pos))
        syncCursor(pos + ref.length)
      } else {
        setText((prev) => prev.slice(0, pos) + content + prev.slice(pos))
        syncCursor(pos + content.length)
      }
      setCompletionIndex(0)
    },
    onKey: (key) => {
      if (key === 'return') { handleSubmit(); return }
      if (key === 'escape') {
        const now = Date.now()
        if (now - lastEscRef.current < 500 && text.length > 0) {
          setText(''); syncCursor(0); setPastedContents({}); setCompletionIndex(0)
        }
        lastEscRef.current = now; return
      }
      if (key === 'backspace') {
        const pos = cursorRef.current
        if (pos === 0) return
        setText((prev) => {
          const before = prev.slice(0, pos)
          const stripped = stripTrailingRef(before)
          if (stripped) {
            setPastedContents((pc) => { const n = { ...pc }; delete n[stripped.id]; return n })
            syncCursor(pos - (before.length - stripped.without.length))
            return stripped.without + prev.slice(pos)
          }
          syncCursor(pos - 1)
          return prev.slice(0, pos - 1) + prev.slice(pos)
        })
        setCompletionIndex(0); return
      }
      if (key === 'delete') {
        const pos = cursorRef.current
        setText((prev) => pos >= prev.length ? prev : prev.slice(0, pos) + prev.slice(pos + 1)); return
      }
      if (key === 'left') { syncCursor((p) => Math.max(0, p - 1)); return }
      if (key === 'right') { syncCursor((p) => Math.min(text.length, p + 1)); return }
      if (key === 'home') { syncCursor(0); return }
      if (key === 'end') { syncCursor(text.length); return }
      if (key === 'tab') {
        if (currentMatch) { setText(currentMatch.name); syncCursor(currentMatch.name.length); setCompletionIndex(0) }
        return
      }
      if (key === 'up') {
        if (matches.length > 0) setCompletionIndex((p) => (p - 1 + matches.length) % matches.length)
        else moveCursorVertically(-1); return
      }
      if (key === 'down') {
        if (matches.length > 0) setCompletionIndex((p) => (p + 1) % matches.length)
        else moveCursorVertically(1); return
      }
      if (key === 'pageup') { moveCursorVertically(-MAX_VISIBLE_LINES); return }
      if (key === 'pagedown') { moveCursorVertically(MAX_VISIBLE_LINES); return }
    },
  })

  // ── Direct ANSI overwrite rendering (no erase, no flash) ──────────

  useLayoutEffect(() => {
    if (disabled) {
      // Clear our lines by overwriting with spaces
      if (prevLinesRef.current > 0) {
        let out = `\x1b[${prevLinesRef.current}A`
        for (let i = 0; i < prevLinesRef.current; i++) {
          out += '\r' + ' '.repeat(termWidth) + '\n'
        }
        out += `\x1b[${prevLinesRef.current}A`
        process.stdout.write(out)
        prevLinesRef.current = 0
      }
      return
    }

    const PROMPT_WIDTH = 2
    const vpWidth = Math.max(20, termWidth - PROMPT_WIDTH - 1)
    const separatorPlain = '─'.repeat(Math.max(0, termWidth - 1))
    const separatorAnsi = c.hex(PROMPT_BORDER)(separatorPlain)

    const rawLines = text.length === 0 ? [''] : text.split('\n')

    let rawCursorLine = 0, cursorCol = cursor
    { let charsSoFar = 0
      for (let i = 0; i < rawLines.length; i++) {
        if (charsSoFar + rawLines[i].length >= cursor && cursor >= charsSoFar) {
          rawCursorLine = i; cursorCol = cursor - charsSoFar; break
        }
        charsSoFar += rawLines[i].length + 1
      }
    }

    let displayLines: string[], cursorLine: number
    if (rawLines.length <= MAX_VISIBLE_LINES) {
      displayLines = rawLines; cursorLine = rawCursorLine
    } else {
      let start = rawCursorLine - Math.floor(MAX_VISIBLE_LINES / 2)
      start = Math.max(0, Math.min(start, rawLines.length - MAX_VISIBLE_LINES))
      displayLines = rawLines.slice(start, start + MAX_VISIBLE_LINES)
      cursorLine = rawCursorLine - start
      if (start > 0) { displayLines[0] = `… (+${start} above)`; if (cursorLine === 0) cursorLine = -1 }
      if (start + MAX_VISIBLE_LINES < rawLines.length) {
        displayLines[displayLines.length - 1] = `… (+${rawLines.length - start - MAX_VISIBLE_LINES} below)`
        if (cursorLine === displayLines.length - 1) cursorLine = -1
      }
    }

    // Build lines as [ansiString, plainString] pairs for pad calculation
    const lines: Array<[string, string]> = []

    lines.push([separatorAnsi, separatorPlain])

    for (let i = 0; i < displayLines.length; i++) {
      const line = displayLines[i]
      const promptA = c.hex(PROMPT_BORDER)(i === 0 ? '> ' : '  ')
      const promptP = i === 0 ? '> ' : '  '
      const showCursor = i === cursorLine && cursorLine >= 0

      if (!showCursor) {
        const lw = visualWidth(line)
        const truncated = lw > vpWidth ? sliceByWidth(line, vpWidth) : line
        lines.push([promptA + truncated, promptP + truncated])
        continue
      }

      const before = line.slice(0, cursorCol)
      const cursorChar = cursorCol < line.length ? line[cursorCol] : ' '
      const after = cursorCol < line.length ? line.slice(cursorCol + 1) : ''
      const lw = visualWidth(line)

      if (lw <= vpWidth) {
        lines.push([
          promptA + before + c.inverse(cursorChar) + after,
          promptP + before + cursorChar + after,
        ])
      } else {
        const beforeWidth = visualWidth(before)
        const halfVP = Math.floor(vpWidth / 2)
        let skipCols = Math.max(0, beforeWidth - halfVP)
        const totalWidth = lw + (cursorCol >= line.length ? 1 : 0)
        if (skipCols + vpWidth > totalWidth) skipCols = Math.max(0, totalWidth - vpWidth)
        const startIdx = skipByWidth(line, skipCols)
        const vb = line.slice(startIdx, cursorCol)
        const afterStart = cursorCol < line.length ? cursorCol + 1 : line.length
        const remaining = vpWidth - visualWidth(vb) - (isWide(cursorChar.codePointAt(0)!) ? 2 : 1)
        const va = sliceByWidth(line.slice(afterStart), Math.max(0, remaining))
        lines.push([
          promptA + vb + c.inverse(cursorChar) + va,
          promptP + vb + cursorChar + va,
        ])
      }
    }

    lines.push([separatorAnsi, separatorPlain])

    if (matches.length > 0) {
      const maxNameLen = matches.reduce((max, cmd) => Math.max(max, cmd.name.length), 0)
      for (let i = 0; i < matches.length; i++) {
        const cmd = matches[i]
        const sel = i === safeIndex
        const name = sel ? c.hex(ACCENT).bold(cmd.name.padEnd(maxNameLen + 2)) : c.gray(cmd.name.padEnd(maxNameLen + 2))
        const desc = sel ? cmd.description : c.gray(cmd.description)
        const plain = '  ' + cmd.name.padEnd(maxNameLen + 2) + cmd.description
        lines.push(['  ' + name + desc, plain])
      }
    }

    // Build ANSI output: move up to start, overwrite each line (padded to termWidth)
    const prevLines = prevLinesRef.current
    const newLines = lines.length

    let out = ''
    // Move cursor up to start of our region
    if (prevLines > 0) {
      out += `\x1b[${prevLines}A`
    }
    // Write each line: CR + padded content + LF
    for (const [ansi, plain] of lines) {
      out += '\r' + padLine(ansi, plain, termWidth) + '\n'
    }
    // If previous frame had more lines, overwrite extras with blank lines
    for (let i = newLines; i < prevLines; i++) {
      out += '\r' + ' '.repeat(termWidth) + '\n'
    }
    // Move back up past the extra blank lines so cursor is right after our content
    if (newLines < prevLines) {
      out += `\x1b[${prevLines - newLines}A`
    }

    process.stdout.write(out)
    prevLinesRef.current = Math.max(newLines, prevLines)

    if (!mountedRef.current) mountedRef.current = true
  })

  // Cleanup on unmount — clear our lines
  useEffect(() => {
    return () => {
      if (prevLinesRef.current > 0) {
        let out = `\x1b[${prevLinesRef.current}A`
        for (let i = 0; i < prevLinesRef.current; i++) {
          out += '\r' + ' '.repeat(termWidth) + '\n'
        }
        out += `\x1b[${prevLinesRef.current}A`
        process.stdout.write(out)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Return null — Ink's dynamic region is empty, so log-update has nothing
  // to clear/redraw. Our rendering is pure overwrite, no erase, no flash.
  return null
}
