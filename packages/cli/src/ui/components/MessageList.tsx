// @x-code/cli — Message history (uses Ink Static for performance)
//
// Static items are rendered ONCE and written permanently to the terminal's
// scrollback buffer.  Ink never clears or redraws them.  This is why
// the startup header is included here as the first Static item — it gets
// "printed" once and stays at the top, just like Gemini CLI does.
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
  header?: React.ReactNode
}

// A special sentinel used as the first Static item so the header renders once.
const HEADER_ID = '__header__'

type StaticItem = DisplayMessage | { id: string; __header: true }

export function MessageList({ messages, header }: MessageListProps) {
  // Prepend the header sentinel to the items array so it renders first
  const items: StaticItem[] = header ? [{ id: HEADER_ID, __header: true }, ...messages] : messages

  return (
    <Static items={items}>
      {(item) => {
        // Render header
        if ('__header' in item) {
          return <Box key={HEADER_ID}>{header}</Box>
        }

        // Render message
        const msg = item
        return (
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
        )
      }}
    </Static>
  )
}
