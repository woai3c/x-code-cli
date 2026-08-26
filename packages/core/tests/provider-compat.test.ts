import { describe, expect, it, vi } from 'vitest'

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText } from 'ai'
import type { ModelMessage } from 'ai'

import { ocrImage } from '../src/agent/image-ocr.js'
import {
  downgradeBinaryPartsForProvider,
  reattachToolResultImagesForProvider,
  stripBinaryPartsFromMessages,
} from '../src/agent/provider-compat.js'
import { collapseStaleToolResults } from '../src/agent/tool-result-pruning.js'

vi.mock('../src/agent/image-ocr.js', () => ({
  ocrImage: vi.fn(async () => 'mock compatibility OCR'),
}))

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
            { type: 'file', data: { type: 'data', data }, mediaType: 'image/png' },
          ],
        },
      },
    ],
  }
}

describe('stripBinaryPartsFromMessages', () => {
  it('replaces user image/file parts and tool-result media with text notices', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', image: 'AAAA', mediaType: 'image/png' },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc-1',
            toolName: 'browser',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'screenshot' },
                { type: 'media', data: 'BBBB', mediaType: 'image/png' },
              ],
            },
          },
        ],
      },
    ] as unknown as ModelMessage[]

    expect(stripBinaryPartsFromMessages(messages)).toBe(true)

    const userContent = messages[0]!.content as Array<{ type: string; text?: string }>
    expect(userContent.map((p) => p.type)).toEqual(['text', 'text'])
    expect(userContent[1]!.text).toContain('Image omitted')
    const toolParts = messages[1]!.content as Array<{ output: { value: Array<{ type: string; text?: string }> } }>
    const output = toolParts[0]!.output.value
    expect(output.map((e) => e.type)).toEqual(['text', 'text'])
    expect(output[1]!.text).toContain('Image omitted')
  })

  it('returns false and changes nothing when there are no binary parts', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]
    expect(stripBinaryPartsFromMessages(messages)).toBe(false)
    expect(messages[0]).toEqual({ role: 'user', content: 'hello' })
  })
})

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
        { type: 'file', data: { type: 'data', data: 'AAAA1' }, mediaType: 'image/png' },
        { type: 'file', data: { type: 'data', data: 'AAAA2' }, mediaType: 'image/png' },
      ],
    })
  })

  it('is idempotent', () => {
    const messages = [imageToolResult('tc-1', 'AAAA1')]
    const once = reattachToolResultImagesForProvider(messages, 'moonshotai:kimi-k3')
    const twice = reattachToolResultImagesForProvider(once, 'moonshotai:kimi-k3')
    expect(twice).toEqual(once)
  })

  it('still reattaches legacy image-data entries from saved sessions', () => {
    const legacy = imageToolResult('tc-legacy-image', 'AAAA1')
    const output = (legacy.content as Array<{ output: { value: unknown[] } }>)[0]!.output
    output.value[1] = { type: 'image-data', data: 'LEGACY', mediaType: 'image/png' }

    const requestMessages = reattachToolResultImagesForProvider([legacy], 'moonshotai:kimi-k3')

    expect(requestMessages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Attached media from tool result:' },
        { type: 'file', data: { type: 'data', data: 'LEGACY' }, mediaType: 'image/png' },
      ],
    })
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
        ? message.content.filter((part) => part.type === 'file')
        : [],
    )

    expect(imageParts).toEqual([{ type: 'file', data: { type: 'data', data: 'NEW' }, mediaType: 'image/png' }])
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

describe('downgradeBinaryPartsForProvider', () => {
  it('removes legacy PDF/audio files for every provider without mutating canonical messages', async () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'old session' },
          { type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf', filename: 'old.pdf' },
          { type: 'file', data: 'UklGRg==', mediaType: 'audio/wav', filename: 'old.wav' },
        ],
      },
    ] as ModelMessage[]
    const canonical = structuredClone(messages)

    const projected = await downgradeBinaryPartsForProvider(messages, 'openai:gpt-5.6-sol')

    expect(messages).toEqual(canonical)
    expect(projected).not.toBe(messages)
    expect(JSON.stringify(projected)).not.toContain('application/pdf')
    expect(JSON.stringify(projected)).not.toContain('audio/wav')
    expect(JSON.stringify(projected)).toContain('Legacy file attachment omitted')
  })

  it('keeps a nested-base64 image FilePart for vision models and OCRs it for text models', async () => {
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII='
    const imagePart = {
      type: 'file' as const,
      data: { type: 'data' as const, data: pngBase64 },
      mediaType: 'image/png',
      filename: 'image.png',
    }
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'look' }, imagePart] }] as ModelMessage[]
    const canonical = structuredClone(messages)

    const vision = await downgradeBinaryPartsForProvider(messages, 'moonshotai:kimi-k3')
    expect(vision[0]).toEqual(messages[0])
    const text = await downgradeBinaryPartsForProvider(messages, 'deepseek:deepseek-v4-flash')
    expect(JSON.stringify(text)).toContain('mock compatibility OCR')
    expect(JSON.stringify(text)).not.toContain('"type":"file"')
    expect(messages).toEqual(canonical)
  })

  it('does not share OCR for images with matching length, head, and tail', async () => {
    const { Jimp } = await import('jimp')
    const first = await new Jimp({ width: 16, height: 16, color: 0xff0000ff }).getBuffer('image/bmp')
    const second = Buffer.from(first)
    second[Math.floor(second.length / 2)]! ^= 1
    const asMessages = (data: Buffer) =>
      [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              data: { type: 'data', data: data.toString('base64') },
              mediaType: 'image/bmp',
              filename: 'legacy.bmp',
            },
          ],
        },
      ] as ModelMessage[]
    const callsBefore = vi.mocked(ocrImage).mock.calls.length

    await downgradeBinaryPartsForProvider(asMessages(first), 'deepseek:deepseek-v4-flash')
    await downgradeBinaryPartsForProvider(asMessages(second), 'deepseek:deepseek-v4-flash')

    expect(vi.mocked(ocrImage).mock.calls.length - callsBefore).toBe(2)
  })

  it('normalizes a legacy BMP FilePart for vision models without mutating canonical history', async () => {
    const { Jimp } = await import('jimp')
    const bmp = await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/bmp')
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: { type: 'data', data: bmp.toString('base64') },
            mediaType: 'image/bmp',
            filename: 'legacy.bmp',
          },
        ],
      },
    ] as ModelMessage[]
    const canonical = structuredClone(messages)

    const projected = await downgradeBinaryPartsForProvider(messages, 'moonshotai:kimi-k3')
    const part = (projected[0]!.content as Array<{ type: string; data?: { data?: string }; mediaType?: string }>)[0]!

    expect(part).toMatchObject({ type: 'file', mediaType: 'image/png' })
    expect(Buffer.from(part.data!.data!, 'base64').subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    expect(messages).toEqual(canonical)
  })

  it('omits a legacy GIF from an xAI request without mutating canonical history', async () => {
    const { Jimp } = await import('jimp')
    const gif = await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/gif')
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: { type: 'data', data: gif.toString('base64') },
            mediaType: 'image/gif',
            filename: 'legacy.gif',
          },
        ],
      },
    ] as ModelMessage[]
    const canonical = structuredClone(messages)

    const projected = await downgradeBinaryPartsForProvider(messages, 'xai:grok-4.3')

    expect(JSON.stringify(projected)).toContain('accepts only PNG, JPEG')
    expect(JSON.stringify(projected)).not.toContain('"type":"file"')
    expect(messages).toEqual(canonical)
  })

  it('omits an animated legacy GIF from an OpenAI request without mutating canonical history', async () => {
    const { Jimp } = await import('jimp')
    const singleFrame = await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/gif')
    const frameStart = singleFrame.indexOf(0x2c)
    const trailer = singleFrame.lastIndexOf(0x3b)
    const animated = Buffer.concat([
      singleFrame.subarray(0, trailer),
      singleFrame.subarray(frameStart, trailer),
      singleFrame.subarray(trailer),
    ])
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: { type: 'data', data: animated.toString('base64') },
            mediaType: 'image/gif',
            filename: 'legacy-animated.gif',
          },
        ],
      },
    ] as ModelMessage[]
    const canonical = structuredClone(messages)

    const projected = await downgradeBinaryPartsForProvider(messages, 'openai:gpt-5.6-sol')

    expect(JSON.stringify(projected)).toMatch(/animated image\/gif|non-animated/i)
    expect(JSON.stringify(projected)).not.toContain('"type":"file"')
    expect(messages).toEqual(canonical)
  })

  it('omits a corrupt legacy image from a vision request without mutating canonical history', async () => {
    const corruptPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ', 'base64')
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: { type: 'data', data: corruptPng.toString('base64') },
            mediaType: 'image/png',
            filename: 'broken.png',
          },
        ],
      },
    ] as ModelMessage[]
    const canonical = structuredClone(messages)

    const projected = await downgradeBinaryPartsForProvider(messages, 'moonshotai:kimi-k3')

    expect(JSON.stringify(projected)).toContain('Image')
    expect(JSON.stringify(projected)).not.toContain('"type":"file"')
    expect(messages).toEqual(canonical)
  })

  it('cleans legacy tool file-data while retaining ordinary tool text', async () => {
    const messages = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc-legacy',
            toolName: 'readFile',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'before' },
                { type: 'file-data', data: 'JVBERi0=', mediaType: 'application/pdf', filename: 'old.pdf' },
              ],
            },
          },
        ],
      },
    ] as unknown as ModelMessage[]

    const projected = await downgradeBinaryPartsForProvider(messages, 'openai:gpt-5.6-sol')
    expect(JSON.stringify(projected)).toContain('before')
    expect(JSON.stringify(projected)).toContain('Legacy file attachment omitted')
    expect(JSON.stringify(projected)).not.toContain('file-data')
    expect(JSON.stringify(messages)).toContain('file-data')
  })

  it('cleans legacy non-image media entries for every provider', async () => {
    const messages = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc-legacy-media',
            toolName: 'readFile',
            output: {
              type: 'content',
              value: [{ type: 'media', data: 'JVBERi0=', mediaType: 'application/pdf', filename: 'old.pdf' }],
            },
          },
        ],
      },
    ] as unknown as ModelMessage[]

    const projected = await downgradeBinaryPartsForProvider(messages, 'openai:gpt-5.6-sol')
    expect(JSON.stringify(projected)).toContain('Legacy file attachment omitted')
    expect(JSON.stringify(projected)).not.toContain('application/pdf')
    expect(JSON.stringify(messages)).toContain('application/pdf')
  })

  it('serializes an image FilePart as image_url rather than input_file', async () => {
    let requestBody: { messages?: Array<{ content?: unknown }> } = {}
    const provider = createOpenAICompatible({
      name: 'compatible',
      baseURL: 'https://example.test/v1',
      apiKey: 'test-key',
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body))
        return new Response(
          JSON.stringify({
            id: 'response-image-file',
            object: 'chat.completion',
            created: 0,
            model: 'vision',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })

    await generateText({
      model: provider('vision'),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            {
              type: 'file',
              data: { type: 'data', data: 'aW1hZ2U=' },
              mediaType: 'image/png',
              filename: 'image.png',
            },
          ],
        },
      ],
    })

    expect(JSON.stringify(requestBody)).toContain('image_url')
    expect(JSON.stringify(requestBody)).not.toContain('input_file')
  })
})
