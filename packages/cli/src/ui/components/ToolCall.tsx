// @x-code/cli — Tool call display component
import React from 'react'

import { Box, Text } from 'ink'

import { ACCENT, ERROR, SUCCESS, WARNING } from '../theme.js'

interface ToolCallProps {
  toolName: string
  input: Record<string, unknown>
  status: 'pending' | 'running' | 'completed' | 'denied'
  output?: string
}

export function ToolCall({ toolName, input, status, output }: ToolCallProps) {
  const statusColors: Record<string, string> = {
    pending: WARNING,
    running: ACCENT,
    completed: SUCCESS,
    denied: ERROR,
  }

  const statusIcons: Record<string, string> = {
    pending: '○',
    running: '◑',
    completed: '●',
    denied: '✕',
  }

  // Show relevant input preview
  const inputPreview =
    toolName === 'shell'
      ? (input.command as string)
      : toolName === 'readFile' || toolName === 'writeFile' || toolName === 'edit'
        ? (input.filePath as string)
        : toolName === 'glob'
          ? (input.pattern as string)
          : toolName === 'grep'
            ? (input.pattern as string)
            : JSON.stringify(input).slice(0, 80)

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Text>
        <Text color={statusColors[status]}>{statusIcons[status]} </Text>
        <Text bold color={ACCENT}>
          {toolName}
        </Text>
        <Text dimColor> {inputPreview}</Text>
      </Text>
      {output && status === 'completed' && (
        <Box marginLeft={3}>
          <Text dimColor>
            {output.slice(0, 200)}
            {output.length > 200 ? '...' : ''}
          </Text>
        </Box>
      )}
    </Box>
  )
}
