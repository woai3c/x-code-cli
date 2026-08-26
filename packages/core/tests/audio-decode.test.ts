import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { decodeAudioToPcm } from '../src/agent/audio-decode.js'
import { MAX_AUDIO_DURATION_SECONDS, MAX_AUDIO_PCM_INPUT_BYTES } from '../src/agent/audio-limits.js'
import { prepareM4aForDecode } from '../src/agent/audio-mp4.js'
import { TINY_VORBIS_EXPECTED, makeTinyM4aBuffer, makeTinyVorbisBuffer } from './helpers/audio.js'

let tempDir: string

function pcmWav(sampleRate: number, samples: number[]): Buffer {
  const buffer = Buffer.alloc(44 + samples.length * 2)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WAVEfmt ', 8, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(samples.length * 2, 40)
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2))
  return buffer
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-audio-decode-'))
})

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('bounded audio decoder', () => {
  it('streams and resamples decoded audio into signed 16-bit mono PCM', async () => {
    const input = path.join(tempDir, 'input.wav')
    const output = path.join(tempDir, 'output.pcm')
    await fs.writeFile(input, pcmWav(8_000, [0, 8_192, 16_384, 24_576]))

    const metadata = await decodeAudioToPcm(input, output)
    const pcm = await fs.readFile(output)

    expect(metadata).toMatchObject({
      codec: 'PCM',
      container: 'WAVE',
      durationSeconds: 0.0005,
      numberOfChannels: 1,
      sampleRate: 8_000,
    })
    expect(pcm.length).toBe(8 * Int16Array.BYTES_PER_ELEMENT)
    expect(pcm.readInt16LE(0)).toBe(0)
    expect(pcm.readInt16LE(2)).toBeCloseTo(4_096, -1)
  })

  it('rejects ADPCM metadata that could amplify a tiny block into a huge allocation', async () => {
    const input = path.join(tempDir, 'malformed-adpcm.wav')
    const output = path.join(tempDir, 'malformed-adpcm.pcm')
    const wav = Buffer.alloc(52)
    wav.write('RIFF', 0, 'ascii')
    wav.writeUInt32LE(wav.length - 8, 4)
    wav.write('WAVEfmt ', 8, 'ascii')
    wav.writeUInt32LE(20, 16)
    wav.writeUInt16LE(0x11, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(8_000, 24)
    wav.writeUInt32LE(8_000, 28)
    wav.writeUInt16LE(4, 32)
    wav.writeUInt16LE(4, 34)
    wav.writeUInt16LE(2, 36)
    wav.writeUInt16LE(65_535, 38)
    wav.write('data', 40, 'ascii')
    wav.writeUInt32LE(4, 44)
    await fs.writeFile(input, wav)

    await expect(decodeAudioToPcm(input, output)).rejects.toThrow(/physical allocation/i)
  })

  it('decodes FLAC through individually bounded frames', async () => {
    const input = path.join(tempDir, 'input.flac')
    const output = path.join(tempDir, 'output-flac.pcm')
    const flac = Buffer.from(
      'ZkxhQwAAACISABIAAAALAAANAfQA8AAAH0Ae4Bk2cWCcfWPP6JuSCtMThAAANgUAAABBcHBsZQEAAAAlAAAAV0FWRUZPUk1BVEVYVEVOU0lCTEVfQ0hBTk5FTF9NQVNLPTB4NP/4VAgArQAAANVn//h0CAENP6oAAAAw/A==',
      'base64',
    )
    await fs.writeFile(input, flac)

    const metadata = await decodeAudioToPcm(input, output)

    expect(metadata).toMatchObject({ codec: 'FLAC', container: 'FLAC', numberOfChannels: 1, sampleRate: 8_000 })
    expect(metadata.durationSeconds).toBeCloseTo(0.576)
    expect((await fs.stat(output)).size).toBe(4_608 * 2 * Int16Array.BYTES_PER_ELEMENT)
  })

  it('decodes valid Ogg Vorbis through the real parser and WASM decoder', async () => {
    const input = path.join(tempDir, 'input.ogg')
    const output = path.join(tempDir, 'output-vorbis.pcm')
    await fs.writeFile(input, makeTinyVorbisBuffer())

    const metadata = await decodeAudioToPcm(input, output)

    expect(metadata).toMatchObject({
      codec: 'Vorbis',
      container: 'Ogg',
      durationSeconds: TINY_VORBIS_EXPECTED.durationSeconds,
      numberOfChannels: TINY_VORBIS_EXPECTED.numberOfChannels,
      sampleRate: TINY_VORBIS_EXPECTED.sampleRate,
    })
    expect((await fs.stat(output)).size).toBe(TINY_VORBIS_EXPECTED.pcmBytes)
  })

  it('decodes an AAC/M4A with trailing movie metadata through the bundled native decoder', async () => {
    const input = path.join(tempDir, 'voice recording.m4a')
    const output = path.join(tempDir, 'output-m4a.pcm')
    await fs.writeFile(input, makeTinyM4aBuffer())

    const metadata = await decodeAudioToPcm(input, output)
    const pcm = await fs.readFile(output)

    expect(metadata).toMatchObject({ codec: 'AAC', container: 'MPEG-4', numberOfChannels: 1, sampleRate: 16_000 })
    expect(metadata.durationSeconds).toBeCloseTo(0.256)
    expect(pcm.length).toBe(4_096 * Int16Array.BYTES_PER_ELEMENT)
    expect(pcm.some((sample) => sample !== 0)).toBe(true)
  })

  it('bounds M4A output using codec config and sample tables rather than the untrusted sample-entry channels', () => {
    const prepared = prepareM4aForDecode(makeTinyM4aBuffer())

    expect(prepared).toMatchObject({ declaredFrames: 4_096, numberOfChannels: 1, sampleRate: 16_000 })
  })

  it('rejects an M4A whose forged media duration disagrees with its actual sample table before native decode', async () => {
    const input = path.join(tempDir, 'forged-duration.m4a')
    const output = path.join(tempDir, 'forged-duration.pcm')
    const forged = makeTinyM4aBuffer()
    const mdhdType = forged.indexOf(Buffer.from('mdhd'))
    expect(mdhdType).toBeGreaterThan(0)
    forged.writeUInt32BE(1, mdhdType + 20)
    await fs.writeFile(input, forged)

    await expect(decodeAudioToPcm(input, output)).rejects.toThrow(/duration does not match.*time-to-sample/i)
    await expect(fs.stat(output)).resolves.toMatchObject({ size: 0 })
  })

  it('enforces the PCM cap against actual decoded frames', async () => {
    const input = path.join(tempDir, 'over-duration.wav')
    const output = path.join(tempDir, 'over-duration.pcm')
    const sampleRate = 8_000
    const samples = MAX_AUDIO_DURATION_SECONDS * sampleRate + 1
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'ascii')
    header.writeUInt32LE(36 + samples, 4)
    header.write('WAVEfmt ', 8, 'ascii')
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate, 28)
    header.writeUInt16LE(1, 32)
    header.writeUInt16LE(8, 34)
    header.write('data', 36, 'ascii')
    header.writeUInt32LE(samples, 40)
    await fs.writeFile(input, header)
    await fs.truncate(input, header.length + samples)

    await expect(decodeAudioToPcm(input, output)).rejects.toThrow(
      `Audio exceeds the ${MAX_AUDIO_DURATION_SECONDS}s local decode limit`,
    )
    expect((await fs.stat(output)).size).toBeLessThanOrEqual(MAX_AUDIO_PCM_INPUT_BYTES)
  })
})
