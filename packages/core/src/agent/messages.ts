// @x-code-cli/core — Message types and helpers
import type { FilePart, ImagePart, ModelMessage, TextPart } from 'ai'

/** Content accepted by a user message — a plain string for simple prompts,
 *  or a parts array for prompts that include attached images / files. */
export type UserContent = string | Array<TextPart | ImagePart | FilePart>

/** Create a user message */
export function userMessage(content: UserContent): ModelMessage {
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
