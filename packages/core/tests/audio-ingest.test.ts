import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { transcribeAudio } from '../src/agent/audio-transcribe.js'
import { ingestFile } from '../src/agent/file-ingest.js'
import { createReadFileTool } from '../src/tools/read-file.js'

vi.mock('../src/agent/audio-transcribe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/audio-transcribe.js')>()
  return { ...actual, transcribeAudio: vi.fn() }
})

function wavHeader(): Buffer {
  const buffer = Buffer.alloc(44)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36, 4)
  buffer.write('WAVEfmt ', 8, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16_000, 24)
  buffer.writeUInt32LE(32_000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  return buffer
}

const caps = {
  image: true,
  pdf: true,
  audio: true,
  filesApi: true,
  toolImageTransport: 'tool-result' as const,
}

let tempDir: string
let audioPath: string

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-audio-ingest-'))
  audioPath = path.join(tempDir, 'recording.dat')
  await fs.writeFile(audioPath, wavHeader())
})

beforeEach(() => {
  vi.mocked(transcribeAudio).mockResolvedValue({
    text: 'hello locally',
    language: 'en',
    segments: [{ t0: 0, t1: 1_000, text: 'hello locally' }],
  })
})

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('local audio ingestion', () => {
  it('always transcribes @audio locally even when provider audio capability is true', async () => {
    const parts = await ingestFile({ raw: `@${audioPath}`, absolutePath: audioPath }, caps)

    expect(transcribeAudio).toHaveBeenCalledWith(audioPath, expect.objectContaining({ abortSignal: undefined }))
    expect(parts).toHaveLength(1)
    expect(JSON.stringify(parts)).toContain('hello locally')
    expect(JSON.stringify(parts)).not.toContain('audio/wav')
    expect(JSON.stringify(parts)).not.toContain('type":"file')
  })

  it('uses the same local transcription path from readFile', async () => {
    const tool = createReadFileTool()
    const result = await tool.execute!({ filePath: audioPath }, {
      toolCallId: 'audio-test',
      messages: [],
      abortSignal: undefined,
    } as never)

    expect(transcribeAudio).toHaveBeenCalled()
    expect(result).toContain('hello locally')
    expect(JSON.stringify(result)).not.toContain('audio/wav')
  })

  it('rejects an oversized transcription instead of filling the request history', async () => {
    vi.mocked(transcribeAudio).mockResolvedValue({ text: 'x'.repeat(300 * 1024), segments: [] })

    const attachment = await ingestFile({ raw: `@${audioPath}`, absolutePath: audioPath }, caps)
    const tool = createReadFileTool()
    const toolResult = await tool.execute!({ filePath: audioPath }, {
      toolCallId: 'audio-large',
      messages: [],
      abortSignal: undefined,
    } as never)

    expect(JSON.stringify(attachment)).toContain('too large to inline')
    expect(toolResult).toContain('too large')
    expect(JSON.stringify(attachment)).not.toContain('xxxxxxxxxx')
  })
})
