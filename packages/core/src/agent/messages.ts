// @x-code-cli/core — Message types and helpers
import type { ModelMessage } from 'ai'

/** Create a user message */
export function userMessage(content: string): ModelMessage {
  return { role: 'user', content }
}

/** Create a tool result message */
export function toolResultMessage(toolCallId: string, toolName: string, result: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'text', value: result },
      },
    ],
  }
}
