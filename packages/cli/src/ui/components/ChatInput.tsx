// @x-code-cli/cli — User text input component with cursor navigation,
// slash command completion, and Claude Code-style paste placeholders.
//
// Behavior:
//   * Input box is a vertical textarea — it grows with line count, wraps
//     long lines, and shows a cursor at the current position.
//   * Left/right arrow keys move the cursor. Home/End jump to start/end.
//   * Large pastes (>= 3 lines OR >= 400 chars) are stored in a map and
//     displayed as `[Pasted text #N +M lines]`. Smaller pastes are inlined.
//   * Backspace at the tail of a ref removes the whole ref atomically.
//   * On Enter, refs are expanded back to full content before submission.
//
// Input plumbing goes through usePromptInput (not Ink's useInput) so that
// bracketed paste mode delivers every paste as a single atomic event. This
// fixes the Windows character-drop bug where large pastes arrived mangled.
import React, { useMemo, useRef, useState } from 'react'

import { Box, Text, useStdout } from 'ink'

import { usePromptInput } from '../hooks/use-prompt-input.js'
import {
  type PastedContents,
  expandPasteRefs,
  formatPasteRef,
  stripTrailingRef,
} from '../paste-refs.js'
import { ACCENT, PROMPT_BORDER } from '../theme.js'

// ── CJK / full-width character width helpers ────────────────────────────
// Needed for viewport slicing: Chinese/Japanese/Korean characters occupy
// 2 terminal columns but count as 1 in String.prototype.slice().

/** Check if a code point is a CJK / full-width character (2 terminal cells). */
function isWide(cp: number): boolean {
  return (
    // CJK Unified Ideographs + Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    // CJK Compatibility Ideographs
    (cp >= 0xf900 && cp <= 0xfaff) ||
    // Hangul Syllables
    (cp >= 0xac00 && cp <= 0xd7af) ||
    // Full-width forms
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    // CJK Extension B+
    (cp >= 0x20000 && cp <= 0x2fa1f) ||
    // Common CJK punctuation
    (cp >= 0x3000 && cp <= 0x303f) ||
    // Hiragana + Katakana
    (cp >= 0x3040 && cp <= 0x30ff) ||
    // Bopomofo
    (cp >= 0x3100 && cp <= 0x312f) ||
    // Enclosed CJK
    (cp >= 0x3200 && cp <= 0x32ff) ||
    // CJK Compatibility
    (cp >= 0x3300 && cp <= 0x33ff)
  )
}

/** Visual width of a string in terminal columns. */
function visualWidth(str: string): number {
  let w = 0
  for (const ch of str) {
    w += isWide(ch.codePointAt(0)!) ? 2 : 1
  }
  return w
}

/** Slice a string to fit within `maxCols` terminal columns.
 *  Returns [sliced, charCount] where charCount is the number of JS characters consumed. */
function sliceByWidth(str: string, maxCols: number): [string, number] {
  let w = 0
  let i = 0
  for (const ch of str) {
    const cw = isWide(ch.codePointAt(0)!) ? 2 : 1
    if (w + cw > maxCols) break
    w += cw
    i += ch.length // handle surrogate pairs
  }
  return [str.slice(0, i), i]
}

/** Skip `skipCols` terminal columns, return the char index where the remainder starts. */
function skipByWidth(str: string, skipCols: number): number {
  let w = 0
  let i = 0
  for (const ch of str) {
    if (w >= skipCols) break
    w += isWide(ch.codePointAt(0)!) ? 2 : 1
    i += ch.length
  }
  return i
}

// Pastes this big get stored as `[Pasted text #N …]` placeholders.
const PASTE_REF_MIN_LINES = 3
const PASTE_REF_MIN_CHARS = 400

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

export function ChatInput({ onSubmit, onInterrupt, disabled, commands = [] }: ChatInputProps) {
  const [text, setText] = useState('')
  const [cursor, setCursor] = useState(0)
  // Synchronous cursor ref — used inside onText/onKey callbacks so that
  // rapid keystrokes within the same render frame read the up-to-date
  // position instead of a stale closure capture.
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

  // ── Fuzzy matching: filter commands whose name contains the typed chars in order ──
  const matches = useMemo(() => {
    if (!text.startsWith('/') || text.includes(' ')) return []
    const query = text.slice(1).toLowerCase() // strip leading "/"
    if (!query) {
      // Just "/" typed — show all commands
      return [...commands]
    }
    return commands.filter((c) => {
      const name = c.name.slice(1).toLowerCase() // strip "/" from command name
      // fuzzy: every character of query appears in order inside name
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

  const MAX_VISIBLE_LINES = 6

  /** Move cursor up (delta < 0) or down (delta > 0) by |delta| lines,
   *  preserving the column position (clamped to the target line's length). */
  const moveCursorVertically = (delta: number) => {
    const lines = text.split('\n')
    // Find current line and column
    let line = 0
    let col = cursorRef.current
    let charsSoFar = 0
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
    // Compute absolute cursor position
    let newPos = 0
    for (let i = 0; i < targetLine; i++) {
      newPos += lines[i].length + 1
    }
    newPos += targetCol
    syncCursor(newPos)
  }

  usePromptInput({
    enabled: !disabled,
    onInterrupt,
    onText: (chunk) => {
      // Insert at cursor position (read from ref for accurate position)
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
      if (key === 'return') {
        handleSubmit()
        return
      }

      if (key === 'escape') {
        const now = Date.now()
        if (now - lastEscRef.current < 500 && text.length > 0) {
          // Double-ESC: clear input
          setText('')
          syncCursor(0)
          setPastedContents({})
          setCompletionIndex(0)
        }
        lastEscRef.current = now
        return
      }

      if (key === 'backspace') {
        const pos = cursorRef.current
        if (pos === 0) return
        // Smart delete: if a paste ref ends right before cursor, remove the whole ref.
        setText((prev) => {
          const before = prev.slice(0, pos)
          const stripped = stripTrailingRef(before)
          if (stripped) {
            setPastedContents((prevContents) => {
              const next = { ...prevContents }
              delete next[stripped.id]
              return next
            })
            const removed = before.length - stripped.without.length
            syncCursor(pos - removed)
            return stripped.without + prev.slice(pos)
          }
          syncCursor(pos - 1)
          return prev.slice(0, pos - 1) + prev.slice(pos)
        })
        setCompletionIndex(0)
        return
      }

      if (key === 'delete') {
        const pos = cursorRef.current
        setText((prev) => {
          if (pos >= prev.length) return prev
          return prev.slice(0, pos) + prev.slice(pos + 1)
        })
        return
      }

      if (key === 'left') {
        syncCursor((prev) => Math.max(0, prev - 1))
        return
      }

      if (key === 'right') {
        syncCursor((prev) => Math.min(text.length, prev + 1))
        return
      }

      if (key === 'home') {
        syncCursor(0)
        return
      }

      if (key === 'end') {
        syncCursor(text.length)
        return
      }

      if (key === 'tab') {
        if (currentMatch) {
          setText(currentMatch.name)
          syncCursor(currentMatch.name.length)
          setCompletionIndex(0)
        }
        return
      }

      // Up/Down: completion navigation takes priority; otherwise move cursor vertically
      if (key === 'up') {
        if (matches.length > 0) {
          setCompletionIndex((prev) => (prev - 1 + matches.length) % matches.length)
        } else {
          moveCursorVertically(-1)
        }
        return
      }
      if (key === 'down') {
        if (matches.length > 0) {
          setCompletionIndex((prev) => (prev + 1) % matches.length)
        } else {
          moveCursorVertically(1)
        }
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

  const { stdout } = useStdout()
  const termWidth = stdout?.columns ?? 80

  // Don't return null here — hooks above must always run in the same order.
  // Instead, render nothing visible when disabled.
  if (disabled) return null

  // ── Viewport computation ──
  // The prompt prefix "❯ " takes 2 chars. The border takes no horizontal
  // space (borderLeft/Right disabled). We reserve 1 char for the cursor
  // block when it's at end-of-line.
  const PROMPT_WIDTH = 2
  const viewportWidth = Math.max(20, termWidth - PROMPT_WIDTH - 1)

  const rawLines = text.length === 0 ? [''] : text.split('\n')

  // Compute which raw line the cursor is on, and the offset within that line
  let rawCursorLine = 0
  let cursorCol = cursor
  {
    let charsSoFar = 0
    for (let i = 0; i < rawLines.length; i++) {
      const lineLen = rawLines[i].length
      if (charsSoFar + lineLen >= cursor && cursor >= charsSoFar) {
        rawCursorLine = i
        cursorCol = cursor - charsSoFar
        break
      }
      charsSoFar += lineLen + 1 // +1 for the '\n'
    }
  }

  // Build display lines: window around the cursor line so it's always visible.
  let displayLines: string[]
  let cursorLine: number // cursor's index within displayLines

  if (rawLines.length <= MAX_VISIBLE_LINES) {
    displayLines = rawLines
    cursorLine = rawCursorLine
  } else {
    // Centre the window on the cursor line
    let start = rawCursorLine - Math.floor(MAX_VISIBLE_LINES / 2)
    start = Math.max(0, Math.min(start, rawLines.length - MAX_VISIBLE_LINES))
    displayLines = rawLines.slice(start, start + MAX_VISIBLE_LINES)
    cursorLine = rawCursorLine - start

    // Add overflow indicators
    if (start > 0) {
      displayLines[0] = `… (+${start} lines above)`
      if (cursorLine === 0) cursorLine = -1 // cursor is in hidden area
    }
    if (start + MAX_VISIBLE_LINES < rawLines.length) {
      const hidden = rawLines.length - start - MAX_VISIBLE_LINES
      displayLines[displayLines.length - 1] = `… (+${hidden} lines below)`
      if (cursorLine === displayLines.length - 1) cursorLine = -1
    }
  }

  // Pad command names so descriptions line up nicely
  const maxNameLen = matches.reduce((max, c) => Math.max(max, c.name.length), 0)

  return (
    <Box flexDirection="column">
      {/* Input box — framed by top + bottom rules (borderLeft/Right disabled),
          matching the Claude Code PromptInput visual. */}
      <Box
        borderStyle="round"
        borderLeft={false}
        borderRight={false}
        borderColor={PROMPT_BORDER}
        flexDirection="column"
        width="100%"
      >
        {displayLines.map((line, i) => {
          const showCursorOnThisLine = i === cursorLine && cursorLine >= 0

          // Apply viewport: if a line's visual width exceeds the terminal,
          // show a sliding window around the cursor so the visible text
          // never wraps. Uses visual-width-aware slicing so CJK characters
          // (2 columns each) are accounted for correctly.
          const lineWidth = visualWidth(line)
          let beforeCursor = ''
          let cursorChar = ''
          let afterCursor = ''

          if (showCursorOnThisLine) {
            const before = line.slice(0, cursorCol)
            const beforeWidth = visualWidth(before)
            cursorChar = cursorCol < line.length ? line[cursorCol] : ' '
            const after = cursorCol < line.length ? line.slice(cursorCol + 1) : ''

            if (lineWidth <= viewportWidth) {
              // Fits — render as-is
              beforeCursor = before
              afterCursor = after
            } else {
              // Viewport: centre on cursor
              const halfVP = Math.floor(viewportWidth / 2)
              let skipCols = Math.max(0, beforeWidth - halfVP)
              // Don't skip past the end
              const totalWidth = lineWidth + (cursorCol >= line.length ? 1 : 0)
              if (skipCols + viewportWidth > totalWidth) {
                skipCols = Math.max(0, totalWidth - viewportWidth)
              }
              const startIdx = skipByWidth(line, skipCols)
              const visibleBefore = line.slice(startIdx, cursorCol)
              const afterStart = cursorCol < line.length ? cursorCol + 1 : line.length
              const remainingCols = viewportWidth - visualWidth(visibleBefore) - (isWide(cursorChar.codePointAt(0)!) ? 2 : 1)
              const [visibleAfter] = sliceByWidth(line.slice(afterStart), Math.max(0, remainingCols))
              beforeCursor = visibleBefore
              afterCursor = visibleAfter
            }
          }

          if (!showCursorOnThisLine) {
            const [truncated] = lineWidth > viewportWidth
              ? sliceByWidth(line, viewportWidth)
              : [line]
            return (
              <Box key={i}>
                <Text color={PROMPT_BORDER}>{i === 0 ? '❯ ' : '  '}</Text>
                <Text>{truncated}</Text>
              </Box>
            )
          }

          return (
            <Box key={i}>
              <Text color={PROMPT_BORDER}>{i === 0 ? '❯ ' : '  '}</Text>
              <Text>{beforeCursor}</Text>
              <Text inverse>{cursorChar}</Text>
              {afterCursor.length > 0 && <Text>{afterCursor}</Text>}
            </Box>
          )
        })}
      </Box>

      {/* Completion suggestions — rendered BELOW the input (like Claude Code) */}
      {matches.length > 0 && (
        <Box flexDirection="column" marginTop={0} marginLeft={2}>
          {matches.map((cmd, i) => {
            const isSelected = i === safeIndex
            return (
              <Box key={cmd.name}>
                <Text color={isSelected ? ACCENT : 'gray'} bold={isSelected}>
                  {cmd.name.padEnd(maxNameLen + 2)}
                </Text>
                <Text color={isSelected ? undefined : 'gray'} dimColor={!isSelected}>
                  {cmd.description}
                </Text>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}
