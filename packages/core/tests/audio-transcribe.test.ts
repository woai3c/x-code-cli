import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_AUDIO_SOURCE_BYTES,
  type TranscribeAudioResult,
  formatTranscription,
  isAudioFile,
  transcribeAudio,
} from '../src/agent/audio-transcribe.js'
import { classifyFile } from '../src/agent/file-ingest.js'

// Don't load the actual native whisper module in unit tests — only test
// the pure-logic helpers (isAudioFile, formatTranscription, classifyFile).
vi.mock('@fugood/whisper.node', () => ({}))

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('isAudioFile', () => {
  it('recognizes common audio extensions', () => {
    expect(isAudioFile('/path/to/file.mp3')).toBe(true)
    expect(isAudioFile('/path/to/file.wav')).toBe(true)
    expect(isAudioFile('/path/to/file.ogg')).toBe(true)
    expect(isAudioFile('/path/to/file.flac')).toBe(true)
  })

  it('rejects formats not supported by the bundled native decoder', () => {
    for (const extension of ['m4a', 'aac', 'aiff', 'aif', 'wma', 'webm', 'opus', 'txt', 'png', 'pdf', 'ts']) {
      expect(isAudioFile(`/path/to/file.${extension}`), extension).toBe(false)
    }
  })

  it('is case-insensitive via path.extname', () => {
    expect(isAudioFile('/path/to/file.MP3')).toBe(true)
    expect(isAudioFile('/path/to/file.Wav')).toBe(true)
    expect(isAudioFile('/path/to/file.FLAC')).toBe(true)
  })
})

describe('classifyFile', () => {
  it('classifies audio from magic bytes and rejects empty extension-only claims', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-audio-classify-'))
    const wavFile = path.join(tmpDir, 'test.wav')
    const emptyMp3 = path.join(tmpDir, 'empty.mp3')
    const emptyM4a = path.join(tmpDir, 'empty.m4a')
    const wav = Buffer.alloc(44)
    wav.write('RIFF', 0, 'ascii')
    wav.writeUInt32LE(36, 4)
    wav.write('WAVEfmt ', 8, 'ascii')
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(16_000, 24)
    wav.writeUInt32LE(32_000, 28)
    wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34)
    wav.write('data', 36, 'ascii')
    await fs.writeFile(wavFile, wav)
    await fs.writeFile(emptyMp3, '')
    await fs.writeFile(emptyM4a, '')

    expect(await classifyFile(wavFile)).toBe('audio')
    expect(await classifyFile(emptyMp3)).toBe('audio')
    expect(await classifyFile(emptyM4a)).toBe('unknown')

    await fs.rm(tmpDir, { recursive: true })
  })
})

describe('formatTranscription', () => {
  it('formats segments with timestamps', () => {
    const result: TranscribeAudioResult = {
      text: 'Hello world. How are you?',
      language: 'en',
      segments: [
        { t0: 0, t1: 2000, text: 'Hello world.' },
        { t0: 2000, t1: 4500, text: ' How are you?' },
      ],
    }

    const formatted = formatTranscription(result, '/path/to/audio.mp3')

    expect(formatted).toContain('Audio transcription: /path/to/audio.mp3')
    expect(formatted).toContain('Language: en')
    expect(formatted).toContain('[00:00.000 --> 00:02.000] Hello world.')
    expect(formatted).toContain('[00:02.000 --> 00:04.500] How are you?')
  })

  it('formats timestamps with hours when needed', () => {
    const result: TranscribeAudioResult = {
      text: 'Long audio',
      segments: [{ t0: 3_600_000, t1: 3_602_500, text: 'Long audio' }],
    }

    const formatted = formatTranscription(result, '/path/to/long.wav')
    expect(formatted).toContain('[01:00:00.000 --> 01:00:02.500] Long audio')
  })

  it('falls back to full text when segments are empty', () => {
    const result: TranscribeAudioResult = {
      text: 'No segments here',
      segments: [],
    }

    const formatted = formatTranscription(result, '/path/to/audio.mp3')
    expect(formatted).toContain('No segments here')
    expect(formatted).not.toContain('-->')
  })

  it('omits language line when language is undefined', () => {
    const result: TranscribeAudioResult = {
      text: 'test',
      segments: [{ t0: 0, t1: 1000, text: 'test' }],
    }

    const formatted = formatTranscription(result, '/test.mp3')
    expect(formatted).not.toContain('Language:')
  })
})

describe('transcribeAudio cancellation', () => {
  it('returns immediately for an already-aborted request without loading the native runtime', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      transcribeAudio('/path/that/does/not/need/to/exist.wav', { abortSignal: controller.signal }),
    ).resolves.toBe('[Audio transcription was cancelled.]')
  })

  it('rejects an oversized source before model loading or native decoding', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-audio-limit-'))
    const audio = path.join(tmpDir, 'large.wav')
    await fs.writeFile(audio, 'RIFF')
    await fs.truncate(audio, MAX_AUDIO_SOURCE_BYTES + 1)

    await expect(transcribeAudio(audio)).resolves.toMatch(/source file is too large/i)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})
