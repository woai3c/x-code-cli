// @x-code-cli/cli — Streaming text output component
//
// Renders the assistant's response as it streams in.
// The use-agent hook flushes text to Static when it exceeds a threshold,
// so the non-Static area stays small and avoids Ink flicker/jumping.
// This component just renders whatever text is currently in state.
import React, { useMemo } from 'react'

import { Box, Text } from 'ink'

import { renderMarkdown } from '../render-markdown.js'

interface StreamingTextProps {
  text: string
}

export function StreamingText({ text }: StreamingTextProps) {
  const rendered = useMemo(() => renderMarkdown(text), [text])

  if (!rendered) return null

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>{rendered}</Text>
    </Box>
  )
}
