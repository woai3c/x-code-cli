// Tests for deliverToolImages — how an MCP tool's returned image reaches the
// model without ever degrading base64 bytes into ordinary prompt text.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createLoopState } from '../src/agent/loop-state.js'
import { appendUsage } from '../src/agent/session-store.js'
import { deliverToolImages } from '../src/agent/tool-execution.js'
import { captionImageBuffer, pickVisionProvider } from '../src/agent/vision-fallback.js'

vi.mock('../src/agent/session-store.js', () => ({
  appendUsage: vi.fn(async () => undefined),
}))

vi.mock('../src/agent/vision-fallback.js', () => ({
  captionImageBuffer: vi.fn(async () => 'A MAP OF BERLIN WITH A SEARCH BOX AT [40,20]'),
  pickVisionProvider: vi.fn(() => null),
}))

function ctx(modelId: string) {
  return {
    options: { modelId },
    state: createLoopState(),
    callbacks: { onUsageUpdate: vi.fn() },
  } as unknown as Parameters<typeof deliverToolImages>[0]
}

const IMG = [{ data: Buffer.from('fake-png-bytes').toString('base64'), mediaType: 'image/png' }]

describe('deliverToolImages', () => {
  beforeEach(() => {
    vi.mocked(captionImageBuffer).mockClear()
    vi.mocked(captionImageBuffer).mockResolvedValue('A MAP OF BERLIN WITH A SEARCH BOX AT [40,20]')
    vi.mocked(pickVisionProvider).mockReset()
    vi.mocked(pickVisionProvider).mockReturnValue(null)
    vi.mocked(appendUsage).mockReset()
    vi.mocked(appendUsage).mockResolvedValue(undefined)
  })

  it('passes images through in tool results on native transports', async () => {
    for (const modelId of ['anthropic:claude-sonnet-5', 'openai:gpt-5.6-sol', 'google:gemini-2.5-flash']) {
      const r = await deliverToolImages(ctx(modelId), 'shot taken', IMG)
      expect(r.images, modelId).toEqual(IMG)
      expect(r.text, modelId).toBe('shot taken')
    }
    expect(captionImageBuffer).not.toHaveBeenCalled()
  })

  it('keeps Kimi images in canonical tool history for request-time reattachment', async () => {
    const r = await deliverToolImages(ctx('moonshotai:kimi-k3'), 'shot taken', IMG)
    expect(r.images).toEqual(IMG)
    expect(r.text).toBe('shot taken')
    expect(captionImageBuffer).not.toHaveBeenCalled()
  })

  it('does not borrow a separate vision provider when the active Kimi model can view the image', async () => {
    vi.mocked(pickVisionProvider).mockReturnValue({
      provider: 'google',
      modelId: 'google:gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
    })
    const r = await deliverToolImages(ctx('moonshotai:kimi-k3'), 'shot taken', IMG)
    expect(r.images).toEqual(IMG)
    expect(captionImageBuffer).not.toHaveBeenCalled()
  })

  it('borrows a configured vision provider when the active model is text-only', async () => {
    vi.mocked(pickVisionProvider).mockReturnValue({
      provider: 'google',
      modelId: 'google:gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
    })
    const r = await deliverToolImages(ctx('deepseek:deepseek-v4-flash'), 'shot taken', IMG)
    expect(r.images).toBeUndefined()
    expect(r.text).toContain('A MAP OF BERLIN')
    expect(r.text).toContain('Privacy notice')
    expect(r.text).toContain('google:gemini-2.5-flash')
    expect(vi.mocked(captionImageBuffer).mock.calls[0]?.[2]).toBe('google:gemini-2.5-flash')
  })

  it('supports a concise task-specific caption prompt and output limit', async () => {
    vi.mocked(pickVisionProvider).mockReturnValue({
      provider: 'google',
      modelId: 'google:gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
    })
    await deliverToolImages(ctx('deepseek:deepseek-v4-flash'), 'shot taken', IMG, {
      captionPrompt: 'Report only visible UI defects.',
      maxOutputTokens: 400,
    })

    expect(vi.mocked(captionImageBuffer).mock.calls[0]?.[3]).toMatchObject({
      prompt: 'Report only visible UI defects.',
      maxOutputTokens: 400,
    })
  })

  it('persists borrowed-vision usage before returning the tool result', async () => {
    vi.mocked(pickVisionProvider).mockReturnValue({
      provider: 'google',
      modelId: 'google:gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
    })
    vi.mocked(captionImageBuffer).mockImplementationOnce(async (_buffer, _mediaType, _modelId, options) => {
      options?.onUsage?.({
        modelId: 'google:gemini-2.5-flash',
        usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } as any,
      })
      return 'A MAP OF BERLIN'
    })

    let releaseUsageWrite: (() => void) | undefined
    vi.mocked(appendUsage).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseUsageWrite = resolve
        }),
    )
    const context = ctx('deepseek:deepseek-v4-flash')
    let completed = false
    const resultPromise = deliverToolImages(context, 'shot taken', IMG).then((result) => {
      completed = true
      return result
    })

    await vi.waitFor(() => expect(appendUsage).toHaveBeenCalledOnce())
    expect(completed).toBe(false)
    expect(context.state.tokenUsage).toMatchObject({ inputTokens: 50, outputTokens: 10, totalTokens: 60 })
    expect(context.callbacks.onUsageUpdate).toHaveBeenCalledOnce()

    releaseUsageWrite?.()
    const result = await resultPromise
    expect(result.text).toContain('A MAP OF BERLIN')
    expect(appendUsage).toHaveBeenCalledWith(context.state, 'google:gemini-2.5-flash')
  })

  it('drops the image with a clear note when no vision model is available', async () => {
    const r = await deliverToolImages(ctx('deepseek:deepseek-v4-flash'), 'shot taken', IMG)
    expect(r.images).toBeUndefined()
    expect(r.text).toContain('no vision model is available')
    expect(captionImageBuffer).not.toHaveBeenCalled()
  })

  it('uses a caller-specific fallback when no accessibility snapshot exists', async () => {
    const r = await deliverToolImages(ctx('deepseek:deepseek-v4-flash'), 'shot taken', IMG, {
      unavailableFallback: 'No accessibility snapshot was returned for this check.',
    })

    expect(r.images).toBeUndefined()
    expect(r.text).toContain('No accessibility snapshot was returned for this check.')
    expect(r.text).not.toContain('work from the accessibility snapshot')
  })

  it('captions every image when several are returned', async () => {
    vi.mocked(pickVisionProvider).mockReturnValue({
      provider: 'google',
      modelId: 'google:gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
    })
    const two = [...IMG, { data: Buffer.from('second').toString('base64'), mediaType: 'image/png' }]
    const r = await deliverToolImages(ctx('deepseek:deepseek-v4-flash'), 'shots', two)
    expect(captionImageBuffer).toHaveBeenCalledTimes(2)
    expect(r.text).toContain('Screenshot 1')
    expect(r.text).toContain('Screenshot 2')
  })

  it('is a no-op when there are no images', async () => {
    const r = await deliverToolImages(ctx('moonshotai:kimi-k2.6'), 'just text', undefined)
    expect(r.text).toBe('just text')
    expect(r.images).toBeUndefined()
    expect(captionImageBuffer).not.toHaveBeenCalled()
  })
})
