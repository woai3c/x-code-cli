// @x-code/cli — Message history (uses Ink Static for performance)
//
// Static items are rendered ONCE and written permanently to the terminal's
// scrollback buffer.  Ink never clears or redraws them.  This is why
// the startup header is included here as the first Static item — it gets
// "printed" once and stays at the top, just like Gemini CLI does.

import React from 'react'

import { Box, Static, Text } from 'ink'

import type { DisplayMessage } from '@x-code/core'

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
                <Text color="blue" bold>
                  {'> '}
                </Text>
                <Text color="blue">{msg.content}</Text>
              </Text>
            ) : (
              <Text color="green">{msg.content}</Text>
            )}
            {msg.toolCalls?.map((tc) => (
              <Box key={tc.id} marginLeft={2}>
                <Text color="yellow" dimColor>
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
