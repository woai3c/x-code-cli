// @x-code/cli — User text input component with slash command completion
//
// Inspired by Claude Code: completion list appears BELOW the input line,
// with a soft colour scheme — selected item uses the accent blue, unselected
// items are dimmed grey.  The input line only ever shows what the user has
// actually typed — no ghost hints that confuse backspace behaviour.
import React, { useMemo, useState } from 'react'

import { Box, Text, useInput } from 'ink'

import { ACCENT } from '../theme.js'

const PASTE_PREVIEW_THRESHOLD = 500
const PASTE_PREVIEW_LINES = 3

export interface SlashCommand {
  name: string
  description: string
}

interface ChatInputProps {
  onSubmit: (text: string) => void
  disabled?: boolean
  commands?: readonly SlashCommand[]
}

export function ChatInput({ onSubmit, disabled, commands = [] }: ChatInputProps) {
  const [text, setText] = useState('')
  const [isPasteTruncated, setIsPasteTruncated] = useState(false)
  // Index for cycling through multiple completion matches
  const [completionIndex, setCompletionIndex] = useState(0)

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

  // The currently highlighted completion (if any)
  const safeIndex = matches.length > 0 ? completionIndex % matches.length : 0
  const currentMatch = matches.length > 0 ? matches[safeIndex] : null

  useInput((input, key) => {
    if (disabled) return

    // Tab — accept the current completion, append a space so the
    // dropdown closes and the user can continue typing arguments
    if (key.tab) {
      if (currentMatch) {
        setText(currentMatch.name)
        setCompletionIndex(0)
      }
      return
    }

    // Enter — submit
    if (key.return) {
      if (text.trim()) {
        onSubmit(text)
        setText('')
        setIsPasteTruncated(false)
        setCompletionIndex(0)
      }
      return
    }

    // Backspace / Delete — always removes exactly one character
    if (key.backspace || key.delete) {
      setText((prev) => prev.slice(0, -1))
      setCompletionIndex(0)
      if (text.length <= PASTE_PREVIEW_THRESHOLD) {
        setIsPasteTruncated(false)
      }
      return
    }

    // Arrow up/down — cycle through completions
    if (key.upArrow && matches.length > 0) {
      setCompletionIndex((prev) => (prev - 1 + matches.length) % matches.length)
      return
    }
    if (key.downArrow && matches.length > 0) {
      setCompletionIndex((prev) => (prev + 1) % matches.length)
      return
    }

    // Regular character input
    if (input && !key.ctrl && !key.meta) {
      const newText = text + input
      setText(newText)
      setCompletionIndex(0)
      if (input.length > PASTE_PREVIEW_THRESHOLD) {
        setIsPasteTruncated(true)
      }
    }
  })

  if (disabled) return null

  // Display text (truncated if paste)
  let displayText = text
  if (isPasteTruncated && text.length > PASTE_PREVIEW_THRESHOLD) {
    const lines = text.split('\n')
    const previewLines = lines.slice(0, PASTE_PREVIEW_LINES)
    displayText = previewLines.join('\n') + `\n... (${text.length} characters)`
  }

  // Pad command names so descriptions line up nicely
  const maxNameLen = matches.reduce((max, c) => Math.max(max, c.name.length), 0)

  return (
    <Box flexDirection="column">
      {/* Input line — only shows what the user actually typed, no ghost text */}
      <Box>
        <Text color={ACCENT} bold>
          {'> '}
        </Text>
        <Text>{displayText}</Text>
        <Text dimColor>█</Text>
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
