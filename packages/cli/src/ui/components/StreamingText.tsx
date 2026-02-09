// @x-code/cli — Streaming text output component
//
// IMPORTANT: This component renders OUTSIDE of Ink's <Static> region, which
// means Ink clears and redraws it on every state change.  If the rendered
// output exceeds the terminal's visible height, Ink cannot erase the overflow
// that has already scrolled off-screen — causing the same content to appear
// multiple times (the "duplicate rendering" bug).
//
// The fix follows the same approach used by Gemini CLI:
//   Only display the TAIL of the streaming text, capped to
//   (terminal rows − reserved rows for StatusBar / ChatInput / padding).
//
// The full text is still accumulated in state.streamingText; once streaming
// finishes it is moved into the <Static> message history where Ink writes
// it permanently without further redraws.

import React, { useMemo } from 'react'

import { Box, Text, useStdout } from 'ink'

/** Rows reserved for other non-Static UI: StatusBar + ChatInput + padding + 1 buffer */
const RESERVED_ROWS = 6

interface StreamingTextProps {
  text: string
}

export function StreamingText({ text }: StreamingTextProps) {
  const { stdout } = useStdout()
  const terminalRows = stdout?.rows ?? 24

  // Maximum lines the streaming area may occupy
  const maxLines = Math.max(1, terminalRows - RESERVED_ROWS)

  // Only show the last `maxLines` lines so the non-Static area never
  // exceeds the terminal viewport.
  const visibleText = useMemo(() => {
    if (!text) return ''
    const lines = text.split('\n')
    if (lines.length <= maxLines) return text
    return lines.slice(-maxLines).join('\n')
  }, [text, maxLines])

  if (!visibleText) return null

  return (
    <Box flexDirection="column" overflow="hidden">
      <Text color="green">{visibleText}</Text>
    </Box>
  )
}
