// @x-code/cli — Message history (uses Ink Static for performance)

import React from 'react'

import { Static, Box, Text } from 'ink'

import type { DisplayMessage } from '@x-code/core'

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
              <Text color="blue" bold>{'> '}</Text>
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
      )}
    </Static>
  )
}
