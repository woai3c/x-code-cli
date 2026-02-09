// @x-code/cli — Shell command real-time output component
import React from 'react'

import { Box, Text } from 'ink'

import { DIM, WARNING } from '../theme.js'

interface ShellOutputProps {
  output: string
}

export function ShellOutput({ output }: ShellOutputProps) {
  if (!output) return null

  // Show last N lines to avoid overwhelming the terminal
  const lines = output.split('\n')
  const maxLines = 20
  const displayLines = lines.length > maxLines ? lines.slice(-maxLines) : lines

  return (
    <Box flexDirection="column" marginLeft={2} borderStyle="single" borderColor={DIM} paddingX={1}>
      {displayLines.map((line, i) => (
        <Text key={i} dimColor>
          {line}
        </Text>
      ))}
      {lines.length > maxLines && (
        <Text dimColor color={WARNING}>
          ... ({lines.length - maxLines} lines above)
        </Text>
      )}
    </Box>
  )
}
