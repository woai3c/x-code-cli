// @x-code-cli/core — Stream result helpers
import type { ModelMessage } from 'ai'

/** Minimal shape of what we use from streamText() result — avoids complex generic propagation. */
export interface StreamResult {
  stream: AsyncIterable<{
    type: string
    text?: string
    toolName?: string
    input?: unknown
    output?: unknown
    toolCallId?: string
    /** When `type === 'error'`, the SDK's wrapped provider error. The SDK
     *  does NOT throw from stream iteration on request failure — it
     *  enqueues this chunk and closes the stream.
     *  Our streamChunksToUI re-throws so the outer try/catch can classify. */
    error?: unknown
  }>
  response: Promise<{ messages: ModelMessage[] }>
  usage: Promise<
    | {
        inputTokens?: number
        outputTokens?: number
        inputTokenDetails?: {
          cacheReadTokens?: number
          cacheWriteTokens?: number
        }
      }
    | undefined
  >
  finishReason: Promise<string>
  toolCalls: Promise<
    Array<{
      toolName: string
      toolCallId: string
      input: Record<string, unknown>
    }>
  >
}

/**
 * Silently consume all pending promises on a StreamResult to prevent
 * unhandled rejections after a stream error. The AI SDK's internal
 * flush() rejects these with NoOutputGeneratedError when no steps
 * completed — without draining them Node.js dumps the full error to stderr.
 */
export function drainStreamResult(result: StreamResult): void {
  const noop = () => {}
  Promise.resolve(result.response).catch(noop)
  Promise.resolve(result.finishReason).catch(noop)
  Promise.resolve(result.usage).catch(noop)
  Promise.resolve(result.toolCalls).catch(noop)
}
