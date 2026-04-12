// @x-code-cli/cli — User text input component with slash command completion
// and Claude Code-style paste placeholders.
//
// Behavior:
//   * Input box is a vertical textarea — it grows with line count, wraps
//     long lines, and shows a cursor on the last line.
//   * Large pastes (>= 3 lines OR >= 400 chars) are stored in a map and
//     displayed as `[Pasted text #N +M lines]`. Smaller pastes are inlined.
//   * Backspace at the tail of a ref removes the whole ref atomically.
//   * On Enter, refs are expanded back to full content before submission.
//
// Input plumbing goes through usePromptInput (not Ink's useInput) so that
// bracketed paste mode delivers every paste as a single atomic event. This
// fixes the Windows character-drop bug where large pastes arrived mangled.
import React, { useMemo, useRef, useState } from 'react'

import { Box, Text } from 'ink'

import { usePromptInput } from '../hooks/use-prompt-input.js'
import {
  type PastedContents,
  expandPasteRefs,
  formatPasteRef,
  stripTrailingRef,
} from '../paste-refs.js'
import { ACCENT, PROMPT_BORDER } from '../theme.js'

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
  const [pastedContents, setPastedContents] = useState<PastedContents>({})
  const [completionIndex, setCompletionIndex] = useState(0)
  const nextPasteIdRef = useRef(1)

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
    setPastedContents({})
    setCompletionIndex(0)
  }

  usePromptInput({
    enabled: !disabled,
    onInterrupt,
    onText: (chunk) => {
      // Functional setState so rapid bursts (terminal keypress batching)
      // concatenate correctly instead of racing on a stale closure.
      setText((prev) => prev + chunk)
      setCompletionIndex(0)
    },
    onPaste: (content) => {
      const lineCount = content.split(/\r\n|\r|\n/).length
      const isLarge = lineCount >= PASTE_REF_MIN_LINES || content.length >= PASTE_REF_MIN_CHARS

      if (isLarge) {
        const id = nextPasteIdRef.current++
        setPastedContents((prev) => ({ ...prev, [id]: { id, content, lineCount } }))
        setText((prev) => prev + formatPasteRef(id, lineCount))
      } else {
        setText((prev) => prev + content)
      }
      setCompletionIndex(0)
    },
    onKey: (key) => {
      if (key === 'return') {
        handleSubmit()
        return
      }

      if (key === 'backspace') {
        // Smart delete: if text ends with a paste ref, remove the whole ref.
        setText((prev) => {
          const stripped = stripTrailingRef(prev)
          if (stripped) {
            setPastedContents((prevContents) => {
              const next = { ...prevContents }
              delete next[stripped.id]
              return next
            })
            return stripped.without
          }
          return prev.slice(0, -1)
        })
        setCompletionIndex(0)
        return
      }

      if (key === 'tab') {
        if (currentMatch) {
          setText(currentMatch.name)
          setCompletionIndex(0)
        }
        return
      }

      if (key === 'up' && matches.length > 0) {
        setCompletionIndex((prev) => (prev - 1 + matches.length) % matches.length)
        return
      }
      if (key === 'down' && matches.length > 0) {
        setCompletionIndex((prev) => (prev + 1) % matches.length)
        return
      }
    },
  })

  if (disabled) return null

  // Hard cap on how tall the input box is allowed to get. Even if some
  // upstream paste-detection failure lets a huge string land in `text`,
  // the visible box is always bounded — we never let Ink's dynamic region
  // grow beyond what the terminal can safely repaint.
  const MAX_VISIBLE_LINES = 6

  // Multi-line rendering: split the full text by newlines and render one Box
  // per row inside the bordered container. The container grows vertically
  // with content automatically, up to MAX_VISIBLE_LINES. Anything beyond
  // gets truncated with a trailing "… +N more" indicator.
  const rawLines = text.length === 0 ? [''] : text.split('\n')
  const overflow = rawLines.length > MAX_VISIBLE_LINES
  const displayLines = overflow
    ? [...rawLines.slice(0, MAX_VISIBLE_LINES - 1), `… +${rawLines.length - (MAX_VISIBLE_LINES - 1)} more lines`]
    : rawLines

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
          const isLast = i === displayLines.length - 1
          return (
            <Box key={i}>
              <Text color={PROMPT_BORDER}>{i === 0 ? '❯ ' : '  '}</Text>
              <Text>{line}</Text>
              {isLast && <Text dimColor>█</Text>}
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
