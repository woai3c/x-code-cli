import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { decodeAudioToPcm } from '../src/agent/audio-decode.js'
import { MAX_AUDIO_DURATION_SECONDS, MAX_AUDIO_PCM_INPUT_BYTES } from '../src/agent/audio-limits.js'
import { prepareM4aForDecode } from '../src/agent/audio-mp4.js'
import { TINY_VORBIS_EXPECTED, makeTinyAlacBuffer, makeTinyM4aBuffer, makeTinyVorbisBuffer } from './helpers/audio.js'

let tempDir: string

interface TestMp4Box {
  end: number
  size: number
  start: number
  type: string
}

function testMp4Boxes(buffer: Buffer, start: number, end: number): TestMp4Box[] {
  const boxes: TestMp4Box[] = []
  for (let offset = start; offset < end; ) {
    const size = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (size < 8 || offset + size > end) throw new Error(`Invalid test MP4 ${type} box`)
    boxes.push({ end: offset + size, size, start: offset, type })
    offset += size
  }
  return boxes
}

function testMp4Children(buffer: Buffer, parent: TestMp4Box | null): TestMp4Box[] {
  if (!parent) return testMp4Boxes(buffer, 0, buffer.length)
  const prefixBytes = parent.type === 'stsd' ? 8 : parent.type === 'mp4a' || parent.type === 'alac' ? 28 : 0
  return testMp4Boxes(buffer, parent.start + 8 + prefixBytes, parent.end)
}

function duplicateMp4Box(buffer: Buffer, pathTypes: string[]): Buffer {
  const ancestors: TestMp4Box[] = []
  let parent: TestMp4Box | null = null
  for (const type of pathTypes) {
    const match: TestMp4Box | undefined = testMp4Children(buffer, parent).find((box) => box.type === type)
    if (!match) throw new Error(`Missing test MP4 path: ${pathTypes.join('/')}`)
    ancestors.push(match)
    parent = match
  }
  const target = ancestors.pop()
  if (!target) throw new Error('Test MP4 path must not be empty')
  const duplicate = buffer.subarray(target.start, target.end)
  const result = Buffer.concat([buffer.subarray(0, target.end), duplicate, buffer.subarray(target.end)])
  for (const ancestor of ancestors) result.writeUInt32BE(ancestor.size + target.size, ancestor.start)
  return result
}

function mutateAacConfig(buffer: Buffer, firstByte: number, secondByte: number): Buffer {
  const marker = Buffer.from([0x05, 0x80, 0x80, 0x80, 0x02, 0x14, 0x08])
  const offset = buffer.indexOf(marker)
  if (offset < 0) throw new Error('Missing AAC AudioSpecificConfig in test fixture')
  buffer[offset + marker.length - 2] = firstByte
  buffer[offset + marker.length - 1] = secondByte
  return buffer
}

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

  it('bounds AAC output using packet count and codec frames rather than untrusted duration metadata', () => {
    const prepared = prepareM4aForDecode(makeTinyM4aBuffer())

    expect(prepared).toMatchObject({
      expectedDecodedFrames: 4_096,
      maximumDecodedFrames: 4_096,
      numberOfChannels: 1,
      sampleRate: 16_000,
    })
  })

  it('decodes a standard ALAC remainder packet without trusting stts as exact PCM output', async () => {
    const input = path.join(tempDir, 'input-alac.m4a')
    const output = path.join(tempDir, 'output-alac.pcm')
    const source = makeTinyAlacBuffer()
    const prepared = prepareM4aForDecode(source)
    await fs.writeFile(input, source)

    const metadata = await decodeAudioToPcm(input, output)

    expect(prepared).toMatchObject({
      codec: 'ALAC',
      declaredDurationSeconds: 0.768,
      expectedDecodedFrames: null,
      maximumDecodedFrames: 12_288,
      numberOfChannels: 1,
      sampleRate: 16_000,
    })
    expect(metadata).toMatchObject({
      codec: 'ALAC',
      container: 'MPEG-4',
      durationSeconds: 0.512,
      numberOfChannels: 1,
      sampleRate: 16_000,
    })
    expect((await fs.stat(output)).size).toBe(8_192 * Int16Array.BYTES_PER_ELEMENT)
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

  it('rejects forged mdhd and stts durations that understate fixed AAC-LC packet output', () => {
    const forged = makeTinyM4aBuffer()
    const mdhdType = forged.indexOf(Buffer.from('mdhd'))
    const sttsType = forged.indexOf(Buffer.from('stts'))
    expect(mdhdType).toBeGreaterThan(0)
    expect(sttsType).toBeGreaterThan(0)
    forged.writeUInt32BE(2_048, mdhdType + 20)
    forged.writeUInt32BE(512, sttsType + 16)

    expect(() => prepareM4aForDecode(forged)).toThrow(/AAC-LC packets must declare exactly 1024 decoded frames/i)
  })

  it.each([
    ['mdia', ['moov', 'trak', 'mdia']],
    ['hdlr', ['moov', 'trak', 'mdia', 'hdlr']],
    ['minf', ['moov', 'trak', 'mdia', 'minf']],
    ['stbl', ['moov', 'trak', 'mdia', 'minf', 'stbl']],
    ['stsd', ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']],
    ['mdhd', ['moov', 'trak', 'mdia', 'mdhd']],
    ['stts', ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stts']],
    ['stsz', ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz']],
    ['stsc', ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsc']],
  ])('rejects duplicate mandatory %s boxes before native decode', (type, boxPath) => {
    const duplicated = duplicateMp4Box(makeTinyM4aBuffer(), boxPath)

    expect(() => prepareM4aForDecode(duplicated)).toThrow(new RegExp(`duplicate ${type}|exactly one ${type}`, 'i'))
  })

  it('rejects duplicate AAC decoder configuration boxes before native decode', () => {
    const duplicated = duplicateMp4Box(makeTinyM4aBuffer(), [
      'moov',
      'trak',
      'mdia',
      'minf',
      'stbl',
      'stsd',
      'mp4a',
      'esds',
    ])

    expect(() => prepareM4aForDecode(duplicated)).toThrow(/exactly one esds/i)
  })

  it('rejects multiple audio tracks so native track selection cannot bypass the validated budget', () => {
    const duplicated = duplicateMp4Box(makeTinyM4aBuffer(), ['moov', 'trak'])

    expect(() => prepareM4aForDecode(duplicated)).toThrow(/exactly one audio track/i)
  })

  it('rejects duplicate ALAC decoder configuration boxes before native decode', () => {
    const duplicated = duplicateMp4Box(makeTinyAlacBuffer(), [
      'moov',
      'trak',
      'mdia',
      'minf',
      'stbl',
      'stsd',
      'alac',
      'alac',
    ])

    expect(() => prepareM4aForDecode(duplicated)).toThrow(/exactly one codec config/i)
  })

  it.each([
    ['SBR', 0x2c, 0x08, /unsupported AAC object type: 5/i],
    ['PS', 0xec, 0x08, /unsupported AAC object type: 29/i],
    ['three channels', 0x14, 0x18, /unsupported AAC channel configuration: 3/i],
    ['960-frame packets', 0x14, 0x0c, /unsupported 960-frame AAC packets/i],
  ])('rejects unsupported native AAC config: %s', (_name, firstByte, secondByte, expected) => {
    const unsupported = mutateAacConfig(makeTinyM4aBuffer(), firstByte, secondByte)

    expect(() => prepareM4aForDecode(unsupported)).toThrow(expected)
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
  }, 15_000)
})
