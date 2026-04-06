// @x-code-cli/cli — Active tool call display component (Claude Code style)
//
// Shows the currently executing tool call with a spinner and elapsed time.
// Format: ● ToolName(input_preview)
//         ⎿  ⠋ Running... (Xs)
import React, { useEffect, useRef, useState } from 'react'

import { Box, Text } from 'ink'

import { ACCENT, DIM, WARNING } from '../theme.js'
import { getToolInputPreview, getToolLabel } from '../tool-display.js'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

interface ToolCallProps {
  toolName: string
  input: Record<string, unknown>
}

export function ToolCall({ toolName, input }: ToolCallProps) {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(Date.now())

  useEffect(() => {
    startRef.current = Date.now()
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length)
      setElapsed(Date.now() - startRef.current)
    }, 80)
    return () => clearInterval(timer)
  }, [toolName]) // Reset timer when tool changes

  const label = getToolLabel(toolName)
  const inputPreview = getToolInputPreview(toolName, input)
  const elapsedStr = elapsed >= 1000 ? `${(elapsed / 1000).toFixed(0)}s` : ''

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Text>
        <Text color={WARNING}>{'● '}</Text>
        <Text bold>{label}</Text>
        <Text dimColor>({inputPreview})</Text>
      </Text>
      <Text>
        <Text color={DIM}>{'  ⎿  '}</Text>
        <Text color={ACCENT}>{SPINNER_FRAMES[frame]} Running...</Text>
        {elapsedStr && <Text color={DIM}> ({elapsedStr})</Text>}
      </Text>
    </Box>
  )
}
