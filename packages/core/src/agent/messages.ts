// @x-code/core — Message types and helpers
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

/** Estimate token count from text (rough: chars / 4) */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part && typeof part.text === 'string') {
          chars += part.text.length
        } else if ('result' in part && typeof part.result === 'string') {
          chars += part.result.length
        }
      }
    }
  }
  return Math.ceil(chars / 4)
}
