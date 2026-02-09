// @x-code/cli — Message history (uses Ink Static for performance)
//
// Static items are rendered ONCE and written permanently to the terminal's
// scrollback buffer.  Ink never clears or redraws them.
//
// The startup header is printed via printHeader() BEFORE Ink starts,
// so it is never subject to Static re-render issues.
//
// Assistant messages are passed through renderMarkdown() so headings,
// bold, code blocks, lists, etc. display with proper terminal formatting.
import React from 'react'

import { Box, Static, Text } from 'ink'

import type { DisplayMessage } from '@x-code/core'

import { renderMarkdown } from '../render-markdown.js'
import { ACCENT, WARNING } from '../theme.js'

interface MessageListProps {
  messages: DisplayMessage[]
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <Static items={messages}>
      {(msg) => (
        <Box key={msg.id} flexDirection="column" marginBottom={1}>
          {msg.role === 'user' ? (
            <Text>
              <Text color={ACCENT} bold>
                {'> '}
              </Text>
              {msg.content}
            </Text>
          ) : (
            <Text>{renderMarkdown(msg.content)}</Text>
          )}
          {msg.toolCalls?.map((tc) => (
            <Box key={tc.id} marginLeft={2}>
              <Text color={WARNING} dimColor>
                [{tc.status}] {tc.toolName}
                {tc.output ? `: ${tc.output.slice(0, 100)}${tc.output.length > 100 ? '...' : ''}` : ''}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Static>
  )
}
