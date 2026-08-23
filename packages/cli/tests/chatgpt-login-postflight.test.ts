import { refreshCatalogAfterCommittedLogin } from '../src/ui/app/chatgpt-login-postflight.js'

describe('committed ChatGPT login catalog postflight', () => {
  it('does not reuse a cancelled authentication signal after credentials commit', async () => {
    const authController = new AbortController()
    authController.abort(new DOMException('late authentication cancellation', 'AbortError'))
    const refresh = vi.fn(async (signal: AbortSignal) => {
      expect(signal).not.toBe(authController.signal)
      expect(signal.aborted).toBe(false)
      return ['gpt-test']
    })

    await expect(refreshCatalogAfterCommittedLogin(refresh)).resolves.toEqual({ models: ['gpt-test'] })
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('keeps catalog failure separate from the committed login result', async () => {
    const failure = new Error('catalog offline')
    await expect(
      refreshCatalogAfterCommittedLogin(async () => {
        throw failure
      }),
    ).resolves.toEqual({ error: failure })
  })
})
