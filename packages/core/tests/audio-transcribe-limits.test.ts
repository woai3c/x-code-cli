import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { transcribeAudio } from '../src/agent/audio-transcribe.js'

const runner = vi.hoisted(() => ({
  prepareWhisperAudio: vi.fn(),
  probeWhisperRuntime: vi.fn(),
  runWhisperTranscription: vi.fn(),
}))

vi.mock('../src/agent/audio-transcribe-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/audio-transcribe-runner.js')>()
  return {
    ...actual,
    prepareWhisperAudio: runner.prepareWhisperAudio,
    probeWhisperRuntime: runner.probeWhisperRuntime,
    runWhisperTranscription: runner.runWhisperTranscription,
  }
})

let tempDir: string
let audioPath: string

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-audio-resource-limit-'))
  audioPath = path.join(tempDir, 'sample.audio')
  await fs.writeFile(audioPath, 'bounded audio fixture')
})

beforeEach(() => {
  vi.clearAllMocks()
  runner.probeWhisperRuntime.mockResolvedValue(undefined)
})

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('audio decode safety gates', () => {
  it('rejects unsupported formats before model download or transcription', async () => {
    runner.prepareWhisperAudio.mockRejectedValue(
      new Error('Unsupported audio content; supported formats are MP3, WAV, FLAC, and OGG Vorbis'),
    )

    await expect(transcribeAudio(audioPath)).resolves.toMatch(/unsupported audio content/i)
    expect(runner.runWhisperTranscription).not.toHaveBeenCalled()
  })

  it('propagates the hard decoded PCM limit before model download or transcription', async () => {
    runner.prepareWhisperAudio.mockRejectedValue(new Error('Audio exceeds the 1200s local decode limit'))

    await expect(transcribeAudio(audioPath)).resolves.toMatch(/exceeds the .* local decode limit/i)
    expect(runner.runWhisperTranscription).not.toHaveBeenCalled()
  })
})
