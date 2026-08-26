// Tests for vision-fallback module — pickVisionProvider() priority logic.
// captionImage() is not exercised here because it makes a real API call;
// integration testing is handled separately in scripts/.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { generateText } from 'ai'

import { captionImage, captionImageBuffer, pickVisionProvider } from '../src/agent/vision-fallback.js'
import { MAX_IMAGE_SOURCE_BYTES } from '../src/utils/image-compress.js'
import { PROVIDER_ENV_VARS, isolateOpenAIAuth } from './provider-env.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return { ...actual, generateText: vi.fn() }
})

vi.mock('../src/providers/registry.js', () => ({
  createModelRegistry: () => ({ languageModel: () => ({}) }),
}))

vi.mock('../src/utils/image-compress.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/image-compress.js')>()),
  ATTACH_BYTE_BUDGET: 1024,
  compressImage: vi.fn(async (data: Buffer, mimeType: string) => ({
    data,
    mimeType,
    changed: false,
    width: 1,
    height: 1,
  })),
}))

function clearAllKeys(): void {
  for (const k of PROVIDER_ENV_VARS) delete process.env[k]
}

describe('pickVisionProvider', () => {
  let restoreOpenAIAuth: () => void

  beforeEach(() => {
    restoreOpenAIAuth = isolateOpenAIAuth()
    clearAllKeys()
  })
  afterEach(() => {
    clearAllKeys()
    restoreOpenAIAuth()
  })

  it('returns null when only custom OpenAI-compatible endpoint is configured', () => {
    // Custom is treated as text-only by default — even with both env vars set,
    // the user has not opted into vision support.
    process.env.OPENAI_COMPATIBLE_API_KEY = 'test'
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://example.com'
    expect(pickVisionProvider()).toBeNull()
  })

  it('picks Gemini when only Google key is configured', () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test'
    const sub = pickVisionProvider()
    expect(sub?.provider).toBe('google')
    expect(sub?.modelId).toBe('google:gemini-2.5-flash')
  })

  it('picks GLM-4V when only Zhipu key is configured', () => {
    process.env.ZHIPU_API_KEY = 'test'
    const sub = pickVisionProvider()
    expect(sub?.provider).toBe('zhipu')
    expect(sub?.modelId).toBe('zhipu:glm-4.6v')
  })

  it('prefers Google over Zhipu when both are configured', () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test'
    process.env.ZHIPU_API_KEY = 'test'
    expect(pickVisionProvider()?.provider).toBe('google')
  })

  it('prefers Zhipu over Alibaba when both are configured', () => {
    process.env.ZHIPU_API_KEY = 'test'
    process.env.ALIBABA_API_KEY = 'test'
    expect(pickVisionProvider()?.provider).toBe('zhipu')
  })

  it('falls through to xAI when only xAI key is configured', () => {
    process.env.XAI_API_KEY = 'test'
    expect(pickVisionProvider()?.provider).toBe('xai')
  })

  it('ignores DeepSeek key when picking — still selects vision provider if present', () => {
    process.env.DEEPSEEK_API_KEY = 'test'
    process.env.ANTHROPIC_API_KEY = 'test'
    expect(pickVisionProvider()?.provider).toBe('anthropic')
  })
})

describe('caption usage', () => {
  beforeEach(() => {
    vi.mocked(generateText).mockReset()
  })

  it('reports provider usage once and does not report again on a cache hit', async () => {
    const usage = {
      inputTokens: 12,
      outputTokens: 3,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
    vi.mocked(generateText).mockResolvedValue({
      text: 'caption',
      usage,
      response: { modelId: 'actual-vision' },
    } as any)
    const onUsage = vi.fn()
    const buffer = Buffer.from(`unique-image-${Date.now()}`)

    await captionImageBuffer(buffer, 'image/png', 'google:requested-vision', { onUsage })
    await captionImageBuffer(buffer, 'image/png', 'google:requested-vision', { onUsage })

    expect(generateText).toHaveBeenCalledOnce()
    expect(vi.mocked(generateText).mock.calls[0]?.[0].messages?.[0]).toMatchObject({
      role: 'user',
      content: expect.arrayContaining([expect.objectContaining({ type: 'file', mediaType: 'image/png' })]),
    })
    expect(onUsage).toHaveBeenCalledOnce()
    expect(onUsage).toHaveBeenCalledWith({ modelId: 'google:actual-vision', usage })
  })

  it('does not reuse a caption generated for a different prompt', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'caption',
      usage: { inputTokens: 1, outputTokens: 1 },
      response: { modelId: 'actual-vision' },
    } as any)
    const buffer = Buffer.from(`prompt-specific-image-${Date.now()}`)

    await captionImageBuffer(buffer, 'image/png', 'google:requested-vision', { prompt: 'Describe layout.' })
    await captionImageBuffer(buffer, 'image/png', 'google:requested-vision', { prompt: 'Report defects.' })

    expect(generateText).toHaveBeenCalledTimes(2)
  })

  it('does not share a caption for buffers with matching length, head, and tail', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'caption',
      usage: { inputTokens: 1, outputTokens: 1 },
      response: { modelId: 'actual-vision' },
    } as any)
    const first = Buffer.alloc(256, 0x61)
    const second = Buffer.from(first)
    first[128] = 0x31
    second[128] = 0x32

    await captionImageBuffer(first, 'image/png', 'google:requested-vision')
    await captionImageBuffer(second, 'image/png', 'google:requested-vision')

    expect(generateText).toHaveBeenCalledTimes(2)
  })

  it('bounds public captionImage file reads before image processing', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-caption-limit-'))
    const file = path.join(directory, 'oversized.png')
    try {
      await fs.writeFile(file, 'not loaded')
      await fs.truncate(file, MAX_IMAGE_SOURCE_BYTES + 1)

      await expect(
        captionImage(file, { provider: 'google', modelId: 'google:test', label: 'test' }),
      ).rejects.toMatchObject({ name: 'FileSizeLimitError' })
      expect(generateText).not.toHaveBeenCalled()
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
