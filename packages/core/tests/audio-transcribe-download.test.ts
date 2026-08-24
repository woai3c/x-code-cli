import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { transcribeAudio } from '../src/agent/audio-transcribe.js'

const whisper = vi.hoisted(() => ({
  loadWhisperModule: vi.fn(async () => ({})),
}))

const runner = vi.hoisted(() => ({
  runWhisperTranscription: vi.fn(),
}))

vi.mock('../src/agent/audio-transcribe-models.js', () => ({
  WHISPER_MODEL_REVISION: 'test-revision',
  WHISPER_MODELS: {
    tiny: {
      filename: 'ggml-tiny.bin',
      bytes: 4,
      sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
    },
  },
}))

vi.mock('../src/agent/audio-transcribe-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../src/agent/audio-transcribe-runner.js')>(
    '../src/agent/audio-transcribe-runner.js',
  )
  return { ...actual, runWhisperTranscription: runner.runWhisperTranscription }
})

vi.mock('@fugood/whisper.node', () => ({
  loadWhisperModule: whisper.loadWhisperModule,
}))

let tempDir: string
let audioPath: string
let previousHome: string | undefined

const modelResult = {
  isAborted: false,
  language: 'en',
  result: 'done',
  segments: [{ t0: 0, t1: 1, text: 'done' }],
}

function modelFile(): string {
  return path.join(tempDir, 'whisper-models', 'ggml-tiny.bin')
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-whisper-download-'))
  previousHome = process.env.X_CODE_HOME
  process.env.X_CODE_HOME = tempDir
  audioPath = path.join(tempDir, 'sample.wav')
  await fs.writeFile(audioPath, 'audio')
})

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await fs.rm(modelFile(), { force: true })
  await fs.rm(`${modelFile()}.tmp`, { recursive: true, force: true })
  runner.runWhisperTranscription.mockResolvedValue(modelResult)
})

afterAll(async () => {
  vi.unstubAllGlobals()
  if (previousHome === undefined) delete process.env.X_CODE_HOME
  else process.env.X_CODE_HOME = previousHome
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('Whisper first-time setup', () => {
  it('settles and removes the partial model when the download stream fails', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3]))
        controller.error(new Error('simulated network failure'))
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200, headers: { 'content-length': '4' } })),
    )

    const result = await Promise.race([
      transcribeAudio(audioPath),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('transcription did not settle')), 1500)),
    ])

    expect(result).toMatch(/simulated network failure/i)
    await expect(fs.access(`${modelFile()}.tmp`)).rejects.toThrow()
  })

  it('settles and removes the partial model when the download is cancelled', async () => {
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        setTimeout(() => controller.abort(), 0)
        return new Response(body, { status: 200 })
      }),
    )

    await expect(transcribeAudio(audioPath, { abortSignal: controller.signal })).resolves.toBe(
      '[Audio transcription was cancelled.]',
    )
    await expect(fs.access(`${modelFile()}.tmp`)).rejects.toThrow()
  })

  it('settles and cleans up when the model writer cannot be opened', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await fs.mkdir(`${modelFile()}.tmp`)
        return new Response(Uint8Array.from([1, 2, 3]), { status: 200 })
      }),
    )

    const result = await Promise.race([
      transcribeAudio(audioPath),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('transcription did not settle')), 1500)),
    ])

    expect(result).toMatch(/Audio transcription failed/i)
    await expect(fs.access(`${modelFile()}.tmp`)).rejects.toThrow()
  })

  it('downloads and initializes once for concurrent first transcriptions', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(Uint8Array.from([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-length': '4' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const results = await Promise.all([transcribeAudio(audioPath), transcribeAudio(audioPath)])

    expect(results).toEqual([expect.objectContaining({ text: 'done' }), expect.objectContaining({ text: 'done' })])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(runner.runWhisperTranscription).toHaveBeenCalledTimes(2)
  })

  it('does not cache a short HTTP 200 response', async () => {
    const fetchMock = vi.fn(
      async () => new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { 'content-length': '3' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(transcribeAudio(audioPath)).resolves.toMatch(/expected 4/i)
    await expect(transcribeAudio(audioPath)).resolves.toMatch(/expected 4/i)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    await expect(fs.access(modelFile())).rejects.toThrow()
    expect(runner.runWhisperTranscription).not.toHaveBeenCalled()
  })

  it('does not cache a same-size HTTP 200 response with the wrong checksum', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(Uint8Array.from([9, 9, 9, 9]), {
          status: 200,
          headers: { 'content-length': '4' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(transcribeAudio(audioPath)).resolves.toMatch(/checksum verification failed/i)

    await expect(fs.access(modelFile())).rejects.toThrow()
    expect(runner.runWhisperTranscription).not.toHaveBeenCalled()
  })

  it('replaces an invalid same-size cache entry only after checksum verification', async () => {
    await fs.mkdir(path.dirname(modelFile()), { recursive: true })
    await fs.writeFile(modelFile(), Uint8Array.from([9, 9, 9, 9]))
    const fetchMock = vi.fn(
      async () =>
        new Response(Uint8Array.from([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-length': '4' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(transcribeAudio(audioPath)).resolves.toMatchObject({ text: 'done' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(modelFile())).toEqual(Buffer.from([1, 2, 3, 4]))
  })
})
