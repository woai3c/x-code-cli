// @x-code-cli/core — Provider-specific compatibility shims
import type { ModelMessage } from 'ai'

/**
 * Ensure all assistant messages have a reasoning content part.
 *
 * DeepSeek V4 models in thinking mode require the `reasoning_content` field on
 * every assistant message during tool-call chains. The upstream
 * `@ai-sdk/deepseek` converter sets `reasoning_content: undefined` when no
 * reasoning part exists, and `JSON.stringify` strips `undefined` values —
 * causing the DeepSeek API to reject the request with a 400
 * "Missing reasoning_content" error.
 *
 * This helper injects an empty `{ type: 'reasoning', text: '' }` part into any
 * assistant message that lacks one, so the converter always produces
 * `"reasoning_content": ""` in the JSON body.
 */
export function ensureReasoningContentParts(messages: ModelMessage[], modelId: string): void {
  if (!modelId.includes('deepseek-v4')) return

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue

    const content = msg.content
    if (!Array.isArray(content)) continue

    const hasReasoning = (content as Array<{ type: string }>).some((p) => p.type === 'reasoning')
    if (!hasReasoning) {
      ;(content as Array<{ type: string; text?: string }>).unshift({ type: 'reasoning', text: '' })
    }
  }
}
