import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { decodeAudioToPcm } from '../src/agent/audio-decode.js'

interface MockVorbisHeader {
  blocksize0: number
  blocksize1: number
  channels: number
  sampleRate: number
}

interface MockVorbisFrame {
  data: Uint8Array
  header: MockVorbisHeader
  samples: number
}

interface MockOggPage {
  codecFrames: MockVorbisFrame[]
  data: Uint8Array
  isLastPage: boolean
  totalSamples: number
}

const vorbisMock = vi.hoisted(() => ({
  decodePacketCounts: [] as number[],
  freed: false,
  pages: [] as MockOggPage[],
}))

vi.mock('codec-parser', () => ({
  default: class MockCodecParser {
    private emitted = false

    constructor(_mimeType: string, options?: { onCodec?(codec: string): void }) {
      options?.onCodec?.('vorbis')
    }

    parseChunk(): Iterator<MockOggPage> {
      if (this.emitted) return [][Symbol.iterator]()
      this.emitted = true
      return vorbisMock.pages[Symbol.iterator]()
    }

    flush(): Iterator<MockOggPage> {
      return [][Symbol.iterator]()
    }
  },
}))

vi.mock('@wasm-audio-decoders/ogg-vorbis', () => ({
  OggVorbisDecoder: class MockOggVorbisDecoder {
    ready = Promise.resolve()

    async decodeOggPages(pages: MockOggPage[]) {
      const page = pages[0]!
      vorbisMock.decodePacketCounts.push(page.codecFrames.length)
      const frame = page.codecFrames[0]
      if (!frame) return { bitDepth: 16, channelData: [], errors: [], sampleRate: 0, samplesDecoded: 0 }
      return {
        bitDepth: 16,
        channelData: Array.from({ length: frame.header.channels }, () => new Float32Array(frame.samples)),
        errors: [],
        sampleRate: frame.header.sampleRate,
        samplesDecoded: frame.samples,
      }
    }

    free(): void {
      vorbisMock.freed = true
    }
  },
}))

let tempDir: string

function identificationPacket(): Uint8Array {
  const packet = Buffer.alloc(30)
  packet[0] = 1
  packet.write('vorbis', 1, 'ascii')
  packet[11] = 1
  packet.writeUInt32LE(8_000, 12)
  packet[28] = 0x66
  packet[29] = 1
  return packet
}

function frame(samples: number): MockVorbisFrame {
  return {
    data: new Uint8Array([0]),
    header: { blocksize0: 64, blocksize1: 8_192, channels: 1, sampleRate: 8_000 },
    samples,
  }
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-audio-vorbis-'))
})

beforeEach(() => {
  vorbisMock.decodePacketCounts.length = 0
  vorbisMock.freed = false
  vorbisMock.pages = []
})

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('bounded Vorbis decoder', () => {
  it('passes at most one Vorbis packet to the native decoder at a time', async () => {
    const input = path.join(tempDir, 'packetized.ogg')
    const output = path.join(tempDir, 'packetized.pcm')
    await fs.writeFile(input, Buffer.concat([Buffer.from('OggS'), Buffer.from([1]), Buffer.from('vorbis')]))
    vorbisMock.pages = [
      { codecFrames: [], data: identificationPacket(), isLastPage: false, totalSamples: 0 },
      { codecFrames: [frame(0), frame(32)], data: new Uint8Array([0]), isLastPage: true, totalSamples: 32 },
    ]

    const metadata = await decodeAudioToPcm(input, output)

    expect(vorbisMock.decodePacketCounts).toEqual([0, 1, 1])
    expect(vorbisMock.freed).toBe(true)
    expect(metadata).toMatchObject({ codec: 'Vorbis', container: 'Ogg', numberOfChannels: 1, sampleRate: 8_000 })
    expect((await fs.stat(output)).size).toBe(64 * Int16Array.BYTES_PER_ELEMENT)
  })

  it('rejects an oversized packet before passing it to the native decoder', async () => {
    const input = path.join(tempDir, 'oversized-packet.ogg')
    const output = path.join(tempDir, 'oversized-packet.pcm')
    await fs.writeFile(input, Buffer.concat([Buffer.from('OggS'), Buffer.from([1]), Buffer.from('vorbis')]))
    vorbisMock.pages = [
      { codecFrames: [], data: identificationPacket(), isLastPage: false, totalSamples: 0 },
      { codecFrames: [frame(8_193)], data: new Uint8Array([0]), isLastPage: true, totalSamples: 8_193 },
    ]

    await expect(decodeAudioToPcm(input, output)).rejects.toThrow(
      /packet exceeds the supported sample-allocation range/i,
    )

    expect(vorbisMock.decodePacketCounts).toEqual([0])
    expect(vorbisMock.freed).toBe(true)
  })
})
