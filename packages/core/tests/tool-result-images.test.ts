// Tests for deliverToolImages — how an MCP tool's returned image reaches the
// model. Only Anthropic carries an image inside a tool-result; everyone else
// must caption it to text (a raw screenshot would JSON.stringify to base64 and
// blow the context window). The captioner is mocked here; the real one makes a
// live API call.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { deliverToolImages } from '../src/agent/tool-execution.js'
import { captionImageBuffer, pickVisionProvider } from '../src/agent/vision-fallback.js'

vi.mock('../src/agent/vision-fallback.js', () => ({
  captionImageBuffer: vi.fn(async () => 'A MAP OF BERLIN WITH A SEARCH BOX AT [40,20]'),
  pickVisionProvider: vi.fn(() => null),
}))

// Minimal HandlerCtx — deliverToolImages only reads ctx.options.modelId and
// ctx.options.abortSignal.
function ctx(modelId: string) {
  return { options: { modelId } } as unknown as Parameters<typeof deliverToolImages>[0]
}

const IMG = [{ data: Buffer.from('fake-png-bytes').toString('base64'), mediaType: 'image/png' }]

describe('deliverToolImages', () => {
  beforeEach(() => {
    vi.mocked(captionImageBuffer).mockClear()
    vi.mocked(captionImageBuffer).mockResolvedValue('A MAP OF BERLIN WITH A SEARCH BOX AT [40,20]')
    vi.mocked(pickVisionProvider).mockReset()
    vi.mocked(pickVisionProvider).mockReturnValue(null)
  })

  it('passes images through untouched on Anthropic (native tool-result images)', async () => {
    const r = await deliverToolImages(ctx('anthropic:claude-sonnet-4-6'), 'shot taken', IMG)
    expect(r.images).toEqual(IMG)
    expect(r.text).toBe('shot taken')
    expect(captionImageBuffer).not.toHaveBeenCalled()
  })

  it('falls back to the active vision model when no separate vision provider is configured (Kimi-only user)', async () => {
    // pickVisionProvider returns null (beforeEach) → no borrowable provider →
    // caption with the active model itself, which is guaranteed reachable.
    const r = await deliverToolImages(ctx('moonshotai:kimi-k2.6'), 'shot taken', IMG)
    expect(r.images).toBeUndefined()
    expect(r.text).toContain('shot taken')
    expect(r.text).toContain('A MAP OF BERLIN')
    expect(captionImageBuffer).toHaveBeenCalledTimes(1)
    expect(vi.mocked(captionImageBuffer).mock.calls[0]?.[2]).toBe('moonshotai:kimi-k2.6')
  })

  it('prefers a separate fast vision provider over a slow active vision model', async () => {
    // A Kimi user who also has a Gemini key: caption with Gemini (fast/free),
    // not the slow active Kimi.
    vi.mocked(pickVisionProvider).mockReturnValue({
      provider: 'google',
      modelId: 'google:gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
    })
    const r = await deliverToolImages(ctx('moonshotai:kimi-k2.6'), 'shot taken', IMG)
    expect(r.images).toBeUndefined()
    expect(vi.mocked(captionImageBuffer).mock.calls[0]?.[2]).toBe('google:gemini-2.5-flash')
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
    expect(vi.mocked(captionImageBuffer).mock.calls[0]?.[2]).toBe('google:gemini-2.5-flash')
  })

  it('drops the image with a clear note when no vision model is available', async () => {
    const r = await deliverToolImages(ctx('deepseek:deepseek-v4-flash'), 'shot taken', IMG)
    expect(r.images).toBeUndefined()
    expect(r.text).toContain('no vision model is available')
    expect(captionImageBuffer).not.toHaveBeenCalled()
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
