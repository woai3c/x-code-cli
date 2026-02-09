// @x-code/cli — User text input component
import React, { useState } from 'react'

import { Box, Text, useInput } from 'ink'

const PASTE_PREVIEW_THRESHOLD = 500
const PASTE_PREVIEW_LINES = 3

interface ChatInputProps {
  onSubmit: (text: string) => void
  disabled?: boolean
}

export function ChatInput({ onSubmit, disabled }: ChatInputProps) {
  const [text, setText] = useState('')
  const [isPasteTruncated, setIsPasteTruncated] = useState(false)

  useInput((input, key) => {
    if (disabled) return

    if (key.return) {
      if (text.trim()) {
        onSubmit(text)
        setText('')
        setIsPasteTruncated(false)
      }
      return
    }

    if (key.backspace || key.delete) {
      setText((prev) => prev.slice(0, -1))
      if (text.length <= PASTE_PREVIEW_THRESHOLD) {
        setIsPasteTruncated(false)
      }
      return
    }

    if (input && !key.ctrl && !key.meta) {
      const newText = text + input
      setText(newText)
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

  return (
    <Box>
      <Text color="blue" bold>
        {'> '}
      </Text>
      <Text>{displayText}</Text>
      <Text dimColor>█</Text>
    </Box>
  )
}
