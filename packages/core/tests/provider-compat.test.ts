import { describe, expect, it } from 'vitest'

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText } from 'ai'
import type { ModelMessage } from 'ai'

import { reattachToolResultImagesForProvider } from '../src/agent/provider-compat.js'
import { collapseStaleToolResults } from '../src/agent/tool-result-pruning.js'

function imageToolResult(toolCallId: string, data: string, toolName = 'readFile'): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: {
          type: 'content',
          value: [
            { type: 'text', text: `Loaded ${toolCallId}` },
            { type: 'image-data', data, mediaType: 'image/png' },
          ],
        },
      },
    ],
  }
}

describe('reattachToolResultImagesForProvider', () => {
  it('moves a contiguous Kimi tool-image group into one following user message', () => {
    const messages: ModelMessage[] = [
      { role: 'assistant', content: [] },
      imageToolResult('tc-1', 'AAAA1'),
      imageToolResult('tc-2', 'AAAA2'),
      { role: 'assistant', content: 'continued' },
    ]

    const requestMessages = reattachToolResultImagesForProvider(messages, 'moonshotai:kimi-k3')

    expect(requestMessages.map((message) => message.role)).toEqual(['assistant', 'tool', 'tool', 'user', 'assistant'])
    for (const message of requestMessages.slice(1, 3)) {
      const output = (
        message.content as Array<{
          output: { type: string; value: unknown }
        }>
      )[0]!.output
      expect(output.type).toBe('text')
      expect(output.value).toMatch(/^Loaded tc-/)
    }
    expect(requestMessages[3]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Attached media from tool result:' },
        { type: 'image', image: 'AAAA1', mediaType: 'image/png' },
        { type: 'image', image: 'AAAA2', mediaType: 'image/png' },
      ],
    })
  })

  it('is idempotent', () => {
    const messages = [imageToolResult('tc-1', 'AAAA1')]
    const once = reattachToolResultImagesForProvider(messages, 'moonshotai:kimi-k3')
    const twice = reattachToolResultImagesForProvider(once, 'moonshotai:kimi-k3')
    expect(twice).toEqual(once)
  })

  it('does not mutate canonical history so stale screenshots remain prunable', () => {
    const messages = [imageToolResult('tc-1', 'AAAA1')]
    const original = structuredClone(messages)
    const requestMessages = reattachToolResultImagesForProvider(messages, 'moonshotai:kimi-k3')
    expect(messages).toEqual(original)
    expect(requestMessages).not.toBe(messages)
  })

  it('projects only the latest screenshot after stale-result pruning', () => {
    const messages: ModelMessage[] = [
      { role: 'assistant', content: [] },
      imageToolResult('tc-old', 'OLD', 'browser__browser_take_screenshot'),
      { role: 'assistant', content: [] },
      imageToolResult('tc-new', 'NEW', 'browser__browser_take_screenshot'),
    ]

    collapseStaleToolResults(messages, ['browser_take_screenshot'])
    const requestMessages = reattachToolResultImagesForProvider(messages, 'moonshotai:kimi-k3')
    const imageParts = requestMessages.flatMap((message) =>
      message.role === 'user' && Array.isArray(message.content)
        ? message.content.filter((part) => part.type === 'image')
        : [],
    )

    expect(imageParts).toEqual([{ type: 'image', image: 'NEW', mediaType: 'image/png' }])
    expect(JSON.stringify(messages)).not.toContain('OLD')
  })

  it('leaves native and text-only transports unchanged', () => {
    for (const modelId of ['openai:gpt-5.6-sol', 'anthropic:claude-sonnet-5', 'deepseek:deepseek-v4-flash']) {
      const messages = [imageToolResult('tc-1', 'AAAA1')]
      const original = structuredClone(messages)
      const requestMessages = reattachToolResultImagesForProvider(messages, modelId)
      expect(messages, modelId).toEqual(original)
      expect(requestMessages, modelId).toBe(messages)
    }
  })

  it('serializes reattached base64 as image_url rather than tool text', async () => {
    let requestBody: {
      messages?: Array<{ role?: string; content?: unknown }>
    } = {}
    const provider = createOpenAICompatible({
      name: 'moonshotai',
      baseURL: 'https://example.test/v1',
      apiKey: 'test-key',
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body))
        return new Response(
          JSON.stringify({
            id: 'response-1',
            object: 'chat.completion',
            created: 0,
            model: 'k3',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'done' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })
    const messages: ModelMessage[] = [
      { role: 'user', content: 'load it' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'readFile',
            input: { filePath: 'image.png' },
          },
        ],
      },
      imageToolResult('tc-1', 'QUFBQQ=='),
    ]
    const requestMessages = reattachToolResultImagesForProvider(messages, 'moonshotai:kimi-k3')

    await generateText({ model: provider('k3'), messages: requestMessages })

    const toolMessage = requestBody.messages?.find((message) => message.role === 'tool')
    expect(toolMessage?.content).toBe('Loaded tc-1')
    const imageMessage = requestBody.messages?.find(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) => typeof part === 'object' && part !== null && (part as { type?: string }).type === 'image_url',
        ),
    )
    expect(imageMessage?.content).toEqual([
      { type: 'text', text: 'Attached media from tool result:' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,QUFBQQ==' },
      },
    ])
  })
})
