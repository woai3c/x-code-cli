// Tests for vision-fallback module — pickVisionProvider() priority logic.
// captionImage() is not exercised here because it makes a real API call;
// integration testing is handled separately in scripts/.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { generateText } from 'ai'

import { captionImageBuffer, pickVisionProvider } from '../src/agent/vision-fallback.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return { ...actual, generateText: vi.fn() }
})

vi.mock('../src/providers/registry.js', () => ({
  createModelRegistry: () => ({ languageModel: () => ({}) }),
}))

vi.mock('../src/utils/image-compress.js', () => ({
  ATTACH_BYTE_BUDGET: 1024,
  compressImage: vi.fn(async (data: Buffer, mimeType: string) => ({ data, mimeType, changed: false })),
}))

const VISION_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'XAI_API_KEY',
  'ALIBABA_API_KEY',
  'ZHIPU_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
]

function clearAllKeys(): void {
  for (const k of VISION_KEYS) delete process.env[k]
}

describe('pickVisionProvider', () => {
  beforeEach(clearAllKeys)
  afterEach(clearAllKeys)

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
    expect(onUsage).toHaveBeenCalledOnce()
    expect(onUsage).toHaveBeenCalledWith({ modelId: 'google:actual-vision', usage })
  })
})
