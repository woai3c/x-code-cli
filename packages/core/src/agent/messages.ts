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

/** Standard error string returned to the model from a tool. The "Error: "
 *  prefix is load-bearing — handleToolCall checks for it via
 *  isToolErrorString to flip the scrollback line to red, and the model
 *  itself learns to read it as a failure marker. */
export function toolErrorString(message: string): string {
  return `Error: ${message}`
}

/** Wrap a thrown / unknown value into the standard tool-error string. */
export function toolErrorFromUnknown(err: unknown): string {
  return toolErrorString(err instanceof Error ? err.message : String(err))
}

/** Match the result-string prefix produced by toolErrorString. */
export function isToolErrorString(value: string): boolean {
  return value.startsWith('Error:')
}
