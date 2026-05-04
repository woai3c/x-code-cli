// Tests for agent/tool-result-sanitize.ts
import { describe, expect, it } from 'vitest'

import type { ModelMessage } from 'ai'

import { truncateToolResultsInMessages } from '../src/agent/tool-result-sanitize.js'

function toolMsg(toolName: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'tc',
        toolName,
        output: { type: 'text', value },
      },
    ],
  } as ModelMessage
}

describe('truncateToolResultsInMessages', () => {
  it('is a no-op when all results fit the budget', () => {
    const messages: ModelMessage[] = [toolMsg('grep', 'short result')]
    const originalValue = (messages[0].content as unknown as Array<{ output: { value: string } }>)[0].output.value
    truncateToolResultsInMessages(messages)
    const after = (messages[0].content as unknown as Array<{ output: { value: string } }>)[0].output.value
    expect(after).toBe(originalValue)
  })

  it('truncates an oversized readFile result in place', () => {
    const huge = 'line\n'.repeat(5000) // 5000 lines, over default 2000
    const messages: ModelMessage[] = [toolMsg('readFile', huge)]
    truncateToolResultsInMessages(messages)
    const after = (messages[0].content as unknown as Array<{ output: { value: string } }>)[0].output.value
    expect(after.length).toBeLessThan(huge.length)
    expect(after).toMatch(/truncated/)
  })

  it('applies head-only policy to grep', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `match-${i}: something`).join('\n')
    const messages: ModelMessage[] = [toolMsg('grep', lines)]
    truncateToolResultsInMessages(messages)
    const after = (messages[0].content as unknown as Array<{ output: { value: string } }>)[0].output.value
    // grep policy is head-only; the tail should NOT be preserved
    expect(after).toContain('match-0')
    expect(after).not.toContain('match-1999')
  })

  it('leaves non-tool messages untouched', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'x'.repeat(100000) } as ModelMessage,
      toolMsg('readFile', 'short'),
    ]
    truncateToolResultsInMessages(messages)
    expect((messages[0].content as string).length).toBe(100000)
  })

  it('handles content-type output arrays with text entries', () => {
    const huge = 'x'.repeat(100000)
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc',
            toolName: 'readFile',
            output: {
              type: 'content',
              value: [{ type: 'text', text: huge }],
            },
          },
        ],
      } as ModelMessage,
    ]
    truncateToolResultsInMessages(messages)
    const entry = (messages[0].content as unknown as Array<{ output: { value: Array<{ text: string }> } }>)[0].output
      .value[0]
    expect(entry.text.length).toBeLessThan(huge.length)
  })
})
