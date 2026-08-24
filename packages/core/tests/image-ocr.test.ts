import { afterEach, describe, expect, it, vi } from 'vitest'

import { disposeOcrWorker, ocrImage } from '../src/agent/image-ocr.js'

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  recognize: vi.fn(),
  terminate: vi.fn(async () => {}),
}))

vi.mock('tesseract.js', () => ({ createWorker: mocks.createWorker }))

afterEach(async () => {
  await disposeOcrWorker()
  vi.clearAllMocks()
})

describe('ocrImage', () => {
  it('rejects an aborted queued job immediately without cancelling the active job', async () => {
    let finishFirst!: (value: { data: { text: string } }) => void
    const firstRecognition = new Promise<{ data: { text: string } }>((resolve) => {
      finishFirst = resolve
    })
    mocks.createWorker.mockResolvedValue({ recognize: mocks.recognize, terminate: mocks.terminate })
    mocks.recognize.mockReturnValueOnce(firstRecognition)

    const first = ocrImage(Buffer.from('first'))
    await vi.waitFor(() => expect(mocks.recognize).toHaveBeenCalledOnce())
    const controller = new AbortController()
    const queued = ocrImage(Buffer.from('queued'), { abortSignal: controller.signal })
    controller.abort()

    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      queued.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), 100)
      }),
    ])
    clearTimeout(timer)
    expect(outcome).toMatchObject({ name: 'AbortError' })
    expect(mocks.terminate).not.toHaveBeenCalled()

    finishFirst({ data: { text: 'first OCR' } })
    await expect(first).resolves.toBe('first OCR')
  })
})
