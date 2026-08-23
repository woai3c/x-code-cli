import { resetChatGPTModelPreloadForTesting, startChatGPTModelPreload } from '../src/chatgpt-model-preload.js'

describe('ChatGPT model preload', () => {
  beforeEach(resetChatGPTModelPreloadForTesting)

  it('starts once without waiting for the model request', () => {
    const refresh = vi.fn(() => new Promise<readonly never[]>(() => undefined))

    expect(startChatGPTModelPreload('chatgpt', 'test', refresh)).toBe(true)
    expect(startChatGPTModelPreload('chatgpt', 'test', refresh)).toBe(false)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('does not consume the one preload before ChatGPT is authenticated', () => {
    const refresh = vi.fn(async () => [])

    expect(startChatGPTModelPreload('none', 'test', refresh)).toBe(false)
    expect(startChatGPTModelPreload('chatgpt', 'test', refresh)).toBe(true)
    expect(refresh).toHaveBeenCalledOnce()
  })
})
