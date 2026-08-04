import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type TranscribeAudioResult, formatTranscription, isAudioFile } from '../src/agent/audio-transcribe.js'
import { classifyFile } from '../src/agent/file-ingest.js'

// Don't load the actual native whisper module in unit tests — only test
// the pure-logic helpers (isAudioFile, formatTranscription, classifyFile).

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('isAudioFile', () => {
  it('recognizes common audio extensions', () => {
    expect(isAudioFile('/path/to/file.mp3')).toBe(true)
    expect(isAudioFile('/path/to/file.wav')).toBe(true)
    expect(isAudioFile('/path/to/file.m4a')).toBe(true)
    expect(isAudioFile('/path/to/file.ogg')).toBe(true)
    expect(isAudioFile('/path/to/file.flac')).toBe(true)
    expect(isAudioFile('/path/to/file.aac')).toBe(true)
    expect(isAudioFile('/path/to/file.aiff')).toBe(true)
    expect(isAudioFile('/path/to/file.aif')).toBe(true)
    expect(isAudioFile('/path/to/file.wma')).toBe(true)
    expect(isAudioFile('/path/to/file.webm')).toBe(true)
    expect(isAudioFile('/path/to/file.opus')).toBe(true)
  })

  it('rejects non-audio extensions', () => {
    expect(isAudioFile('/path/to/file.txt')).toBe(false)
    expect(isAudioFile('/path/to/file.png')).toBe(false)
    expect(isAudioFile('/path/to/file.pdf')).toBe(false)
    expect(isAudioFile('/path/to/file.ts')).toBe(false)
  })

  it('is case-insensitive via path.extname', () => {
    expect(isAudioFile('/path/to/file.MP3')).toBe(true)
    expect(isAudioFile('/path/to/file.Wav')).toBe(true)
    expect(isAudioFile('/path/to/file.FLAC')).toBe(true)
  })
})

describe('classifyFile', () => {
  it('classifies audio files by extension', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-audio-classify-'))
    const mp3File = path.join(tmpDir, 'test.mp3')
    const wavFile = path.join(tmpDir, 'test.wav')
    const m4aFile = path.join(tmpDir, 'test.m4a')

    // Create empty files — classifyFile checks extension first
    await fs.writeFile(mp3File, '')
    await fs.writeFile(wavFile, '')
    await fs.writeFile(m4aFile, '')

    expect(await classifyFile(mp3File)).toBe('audio')
    expect(await classifyFile(wavFile)).toBe('audio')
    expect(await classifyFile(m4aFile)).toBe('audio')

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
