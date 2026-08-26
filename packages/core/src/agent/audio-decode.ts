import type { CodecFrame, FLACHeader, OggPage, VorbisHeader } from 'codec-parser'

import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'

import {
  MAX_AUDIO_DURATION_SECONDS,
  MAX_AUDIO_PCM_INPUT_BYTES,
  MAX_AUDIO_PCM_SAMPLES,
  MAX_AUDIO_SOURCE_BYTES,
  WHISPER_PCM_SAMPLE_RATE,
} from './audio-limits.js'
import { prepareM4aForDecode } from './audio-mp4.js'
import type { WhisperAudioMetadata } from './audio-transcribe-protocol.js'

const INPUT_CHUNK_BYTES = 16 * 1024
const PCM_WRITE_CHUNK_SAMPLES = 16 * 1024
const MAX_AUDIO_CHANNELS = 8
const MIN_AUDIO_SAMPLE_RATE = 8_000
const MAX_AUDIO_SAMPLE_RATE = 192_000
const MAX_WAV_HEADER_BYTES = 1024 * 1024
const MAX_FLAC_FRAME_SAMPLES = 65_535
const MAX_VORBIS_PACKET_SAMPLES = 8_192

type AudioFormat = 'flac' | 'm4a' | 'mp3' | 'vorbis' | 'wav'

interface DecoderError {
  message?: unknown
}

interface DecodedAudioChunk {
  channelData: Float32Array[]
  errors?: DecoderError[]
  sampleRate: number
}

interface SyncStreamingAudioDecoder {
  decode(data: Uint8Array | ArrayBuffer): DecodedAudioChunk
  flush?(): DecodedAudioChunk
  free(): void
}

type AcceptDecodedAudio = (chunk: DecodedAudioChunk) => Promise<void>

interface BoundedStreamingAudioDecoder {
  decode(data: Uint8Array | ArrayBuffer, accept: AcceptDecodedAudio): Promise<void>
  flush(accept: AcceptDecodedAudio): Promise<void>
  free(): void
}

interface WavFormat {
  bitsPerSample: number
  blockAlign: number
  channels: number
  codec: number
  sampleRate: number
  samplesPerBlock?: number
}

class PcmLimitError extends Error {
  constructor() {
    super(`Audio exceeds the ${MAX_AUDIO_DURATION_SECONDS}s local decode limit`)
    this.name = 'PcmLimitError'
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function detectAudioFormat(sample: Buffer): AudioFormat {
  if (sample.length >= 12 && ascii(sample, 0, 4) === 'RIFF' && ascii(sample, 8, 4) === 'WAVE') return 'wav'
  if (sample.length >= 4 && ascii(sample, 0, 4) === 'fLaC') return 'flac'
  if (sample.length >= 12 && ascii(sample, 4, 4) === 'ftyp') return 'm4a'
  if (sample.length >= 4 && ascii(sample, 0, 4) === 'OggS') {
    if (sample.includes(Buffer.from([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]))) return 'vorbis'
    throw new Error('Ogg audio is supported only when encoded as Vorbis')
  }
  if (
    (sample.length >= 3 && ascii(sample, 0, 3) === 'ID3') ||
    (sample.length >= 2 && sample[0] === 0xff && (sample[1]! & 0xe0) === 0xe0)
  ) {
    return 'mp3'
  }
  throw new Error('Unsupported audio content; supported formats are MP3, WAV, FLAC, OGG Vorbis, and M4A')
}

function wavFormat(sample: Buffer): WavFormat {
  const view = new DataView(sample.buffer, sample.byteOffset, sample.byteLength)
  let offset = 12
  let format: WavFormat | null = null
  while (offset + 8 <= sample.length) {
    const name = ascii(sample, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const dataStart = offset + 8
    const next = dataStart + size + (size & 1)
    if (!Number.isSafeInteger(next) || next < dataStart) throw new Error('WAV contains an invalid chunk size')
    if (name === 'fmt ') {
      if (size < 16 || dataStart + Math.min(size, 40) > sample.length) {
        throw new Error('WAV format header is incomplete or too large')
      }
      let codec = view.getUint16(dataStart, true)
      const channels = view.getUint16(dataStart + 2, true)
      const sampleRate = view.getUint32(dataStart + 4, true)
      const blockAlign = view.getUint16(dataStart + 12, true)
      const bitsPerSample = view.getUint16(dataStart + 14, true)
      if (codec === 0xfffe) {
        if (size < 40 || dataStart + 40 > sample.length) throw new Error('WAV extensible format header is incomplete')
        codec = view.getUint16(dataStart + 24, true)
      }
      const samplesPerBlock = size >= 20 && dataStart + 20 <= sample.length ? view.getUint16(dataStart + 18, true) : 0
      format = {
        bitsPerSample,
        blockAlign,
        channels,
        codec,
        sampleRate,
        ...(samplesPerBlock ? { samplesPerBlock } : {}),
      }
    } else if (name === 'data') {
      if (!format) throw new Error('WAV data chunk appears before its format header')
      validateWavFormat(format)
      return format
    }
    if (next > sample.length) break
    offset = next
  }
  throw new Error(`WAV audio header exceeds the ${MAX_WAV_HEADER_BYTES}-byte safety limit or has no data chunk`)
}

function validateWavFormat(format: WavFormat): void {
  const { bitsPerSample, blockAlign, channels, codec, sampleRate, samplesPerBlock } = format
  if (!Number.isInteger(channels) || channels < 1 || channels > MAX_AUDIO_CHANNELS) {
    throw new Error('WAV channel count exceeds the supported safety range')
  }
  if (!Number.isInteger(sampleRate) || sampleRate < MIN_AUDIO_SAMPLE_RATE || sampleRate > MAX_AUDIO_SAMPLE_RATE) {
    throw new Error('WAV sample rate exceeds the supported safety range')
  }
  if (!Number.isInteger(blockAlign) || blockAlign < 1 || blockAlign > 64 * 1024) {
    throw new Error('WAV block alignment exceeds the supported safety range')
  }
  if (codec === 1 || codec === 3) {
    const supportedDepth = codec === 1 ? [8, 16, 24, 32] : [32, 64]
    if (!supportedDepth.includes(bitsPerSample) || blockAlign !== channels * Math.ceil(bitsPerSample / 8)) {
      throw new Error('WAV PCM format has inconsistent sample dimensions')
    }
    return
  }
  if (codec === 6 || codec === 7) {
    if (bitsPerSample !== 8 || blockAlign !== channels) throw new Error('WAV G.711 format has inconsistent dimensions')
    return
  }
  if (codec === 0x11) {
    const maximum = blockAlign >= channels * 4 ? 1 + (blockAlign / channels - 4) * 2 : 0
    if (!samplesPerBlock || !Number.isInteger(maximum) || samplesPerBlock > maximum) {
      throw new Error('WAV IMA ADPCM block metadata exceeds its physical allocation')
    }
    return
  }
  if (codec === 2) {
    const maximum = blockAlign >= channels * 7 ? 2 + ((blockAlign - channels * 7) * 2) / channels : 0
    if (!samplesPerBlock || !Number.isInteger(maximum) || samplesPerBlock > maximum) {
      throw new Error('WAV MS ADPCM block metadata exceeds its physical allocation')
    }
    return
  }
  throw new Error(`Unsupported WAV codec: 0x${codec.toString(16)}`)
}

function wrapSyncDecoder(decoder: SyncStreamingAudioDecoder): BoundedStreamingAudioDecoder {
  return {
    async decode(data, accept) {
      await accept(decoder.decode(data))
    },
    async flush(accept) {
      if (decoder.flush) await accept(decoder.flush())
    },
    free() {
      decoder.free()
    },
  }
}

async function createFlacDecoder(): Promise<BoundedStreamingAudioDecoder> {
  // The convenience decoder concatenates every frame found in one input chunk before returning PCM.
  const [{ FLACDecoder }, { default: CodecParser }] = await Promise.all([
    import('@wasm-audio-decoders/flac'),
    import('codec-parser'),
  ])
  const decoder = new FLACDecoder()
  await decoder.ready
  const parser = new CodecParser<CodecFrame>('audio/flac', {
    onCodec(codec) {
      if (codec !== 'flac') throw new Error(`FLAC decoder received an unsupported ${codec} stream`)
    },
    enableFrameCRC32: false,
  })
  let decodedSamples = 0
  let inputRate: number | null = null

  const decodeFrames = async (frames: Iterator<CodecFrame>, accept: AcceptDecodedAudio): Promise<void> => {
    for (let next = frames.next(); !next.done; next = frames.next()) {
      const frame = next.value
      const header = frame.header as FLACHeader
      if (
        !Number.isInteger(frame.samples) ||
        frame.samples < 1 ||
        frame.samples > MAX_FLAC_FRAME_SAMPLES ||
        header.blockSize !== frame.samples
      ) {
        throw new Error('FLAC frame exceeds the supported sample-allocation range')
      }
      if (
        !Number.isInteger(header.sampleRate) ||
        header.sampleRate < MIN_AUDIO_SAMPLE_RATE ||
        header.sampleRate > MAX_AUDIO_SAMPLE_RATE
      ) {
        throw new Error('FLAC frame has an unsafe sample rate')
      }
      if (!Number.isInteger(header.channels) || header.channels < 1 || header.channels > MAX_AUDIO_CHANNELS) {
        throw new Error('FLAC frame has an unsafe channel count')
      }
      if (inputRate !== null && inputRate !== header.sampleRate) {
        throw new Error('FLAC sample rate changed during decoding')
      }
      if (decodedSamples + frame.samples > MAX_AUDIO_DURATION_SECONDS * header.sampleRate) throw new PcmLimitError()

      const decoded = await decoder.decodeFrames([frame.data])
      if (
        decoded.samplesDecoded !== frame.samples ||
        decoded.sampleRate !== header.sampleRate ||
        decoded.channelData.length !== header.channels
      ) {
        throw new Error('FLAC decoder output does not match the bounded frame metadata')
      }
      await accept(decoded)
      inputRate = decoded.sampleRate
      decodedSamples += decoded.samplesDecoded
    }
  }

  return {
    async decode(data, accept) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      await decodeFrames(parser.parseChunk(bytes), accept)
    },
    async flush(accept) {
      await decodeFrames(parser.flush(), accept)
    },
    free() {
      decoder.free()
    },
  }
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0
}

function validateVorbisHeader(header: VorbisHeader): void {
  if (
    !Number.isInteger(header.sampleRate) ||
    header.sampleRate < MIN_AUDIO_SAMPLE_RATE ||
    header.sampleRate > MAX_AUDIO_SAMPLE_RATE
  ) {
    throw new Error('Vorbis stream has an unsafe sample rate')
  }
  if (!Number.isInteger(header.channels) || header.channels < 1 || header.channels > MAX_AUDIO_CHANNELS) {
    throw new Error('Vorbis stream has an unsafe channel count')
  }
  if (
    !isPowerOfTwo(header.blocksize0) ||
    !isPowerOfTwo(header.blocksize1) ||
    header.blocksize0 < 64 ||
    header.blocksize0 > header.blocksize1 ||
    header.blocksize1 > MAX_VORBIS_PACKET_SAMPLES
  ) {
    throw new Error('Vorbis stream has unsafe block sizes')
  }
}

async function createVorbisDecoder(): Promise<BoundedStreamingAudioDecoder> {
  // decodeOggPages() batches every packet it receives, so pass it at most one audio packet at a time.
  const [{ OggVorbisDecoder }, { default: CodecParser }] = await Promise.all([
    import('@wasm-audio-decoders/ogg-vorbis'),
    import('codec-parser'),
  ])
  const decoder = new OggVorbisDecoder()
  await decoder.ready
  const parser = new CodecParser<OggPage>('audio/ogg', {
    onCodec(codec) {
      if (codec !== 'vorbis') throw new Error(`Vorbis decoder received an unsupported ${codec} stream`)
    },
    enableFrameCRC32: false,
  })
  let decodedSamples = 0
  let inputRate: number | null = null
  let channels: number | null = null

  const decodePages = async (pages: Iterator<OggPage>, accept: AcceptDecodedAudio): Promise<void> => {
    for (let next = pages.next(); !next.done; next = pages.next()) {
      const page = next.value
      if (page.codecFrames.length === 0) {
        const decoded = await decoder.decodeOggPages([page])
        const error = decoderErrors(decoded)
        if (error) throw new Error(`Audio decoder rejected the input: ${error}`)
        if (decoded.samplesDecoded !== 0) throw new Error('Vorbis header page unexpectedly produced PCM samples')
        continue
      }

      for (let index = 0; index < page.codecFrames.length; index++) {
        const frame = page.codecFrames[index]!
        const header = frame.header as VorbisHeader
        validateVorbisHeader(header)
        if (!Number.isInteger(frame.samples) || frame.samples < 0 || frame.samples > MAX_VORBIS_PACKET_SAMPLES) {
          throw new Error('Vorbis packet exceeds the supported sample-allocation range')
        }
        if (inputRate !== null && inputRate !== header.sampleRate) {
          throw new Error('Vorbis sample rate changed during decoding')
        }
        if (channels !== null && channels !== header.channels) {
          throw new Error('Vorbis channel count changed during decoding')
        }
        if (decodedSamples + frame.samples > MAX_AUDIO_DURATION_SECONDS * header.sampleRate) throw new PcmLimitError()

        const boundedPage = {
          ...page,
          codecFrames: [frame],
          isLastPage: page.isLastPage && index === page.codecFrames.length - 1,
        } as OggPage
        const decoded = await decoder.decodeOggPages([boundedPage])
        const error = decoderErrors(decoded)
        if (error) throw new Error(`Audio decoder rejected the input: ${error}`)
        if (
          !Number.isInteger(decoded.samplesDecoded) ||
          decoded.samplesDecoded < 0 ||
          decoded.samplesDecoded > MAX_VORBIS_PACKET_SAMPLES ||
          decoded.sampleRate !== header.sampleRate ||
          decoded.channelData.length !== header.channels
        ) {
          throw new Error('Vorbis decoder output exceeds the bounded packet metadata')
        }
        if (decodedSamples + decoded.samplesDecoded > MAX_AUDIO_DURATION_SECONDS * decoded.sampleRate) {
          throw new PcmLimitError()
        }
        await accept(decoded)
        decodedSamples += decoded.samplesDecoded
        inputRate = decoded.sampleRate
        channels = decoded.channelData.length
      }
    }
  }

  return {
    async decode(data, accept) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      await decodePages(parser.parseChunk(bytes), accept)
    },
    async flush(accept) {
      await decodePages(parser.flush(), accept)
    },
    free() {
      decoder.free()
    },
  }
}

async function createDecoder(format: Exclude<AudioFormat, 'm4a'>): Promise<BoundedStreamingAudioDecoder> {
  if (format === 'mp3') {
    const { decoder } = await import('@audio/decode-mp3')
    return wrapSyncDecoder((await decoder()) as SyncStreamingAudioDecoder)
  }
  if (format === 'flac') return createFlacDecoder()
  if (format === 'vorbis') return createVorbisDecoder()
  const { decoder } = await import('@audio/decode-wav')
  return wrapSyncDecoder(decoder() as SyncStreamingAudioDecoder)
}

function metadataFor(
  format: AudioFormat,
  sampleRate: number,
  numberOfChannels: number,
  samples: number,
): WhisperAudioMetadata {
  const names: Record<AudioFormat, { codec: string; container: string }> = {
    flac: { codec: 'FLAC', container: 'FLAC' },
    m4a: { codec: 'AAC', container: 'MPEG-4' },
    mp3: { codec: 'MP3', container: 'MPEG' },
    vorbis: { codec: 'Vorbis', container: 'Ogg' },
    wav: { codec: 'PCM', container: 'WAVE' },
  }
  return {
    ...names[format],
    durationSeconds: samples / WHISPER_PCM_SAMPLE_RATE,
    numberOfChannels,
    sampleRate,
  }
}

function decoderErrors(chunk: DecodedAudioChunk): string | null {
  if (!chunk.errors?.length) return null
  return chunk.errors.map((error) => String(error.message ?? 'decoder error')).join('; ')
}

class PcmSink {
  private buffer = Buffer.allocUnsafe(PCM_WRITE_CHUNK_SAMPLES * Int16Array.BYTES_PER_ELEMENT)
  private offset = 0
  private position = 0
  samples = 0

  constructor(private readonly handle: Awaited<ReturnType<typeof fs.open>>) {}

  push(value: number): Buffer | null {
    if (this.samples >= MAX_AUDIO_PCM_SAMPLES) throw new PcmLimitError()
    const clamped = Math.max(-1, Math.min(1, value))
    const sample = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767)
    this.buffer.writeInt16LE(sample, this.offset)
    this.offset += Int16Array.BYTES_PER_ELEMENT
    this.samples++
    if (this.offset !== this.buffer.length) return null
    const full = this.buffer
    this.buffer = Buffer.allocUnsafe(PCM_WRITE_CHUNK_SAMPLES * Int16Array.BYTES_PER_ELEMENT)
    this.offset = 0
    return full
  }

  async finish(): Promise<void> {
    if (this.offset > 0) await this.write(this.buffer.subarray(0, this.offset))
    this.offset = 0
    if (this.position > MAX_AUDIO_PCM_INPUT_BYTES) throw new PcmLimitError()
  }

  async write(chunk: Buffer): Promise<void> {
    let written = 0
    while (written < chunk.length) {
      const result = await this.handle.write(chunk, written, chunk.length - written, this.position + written)
      if (result.bytesWritten === 0) throw new Error('Could not write decoded PCM data')
      written += result.bytesWritten
    }
    this.position += written
  }
}

class StreamingResampler {
  private channels: number | null = null
  private inputRate: number | null = null
  private inputSamples = 0
  private nextOutputSample = 0
  private previousSample = 0

  constructor(private readonly sink: PcmSink) {}

  get metadata(): { inputRate: number; channels: number; outputSamples: number } {
    if (!this.inputRate || !this.channels || this.inputSamples === 0 || this.sink.samples === 0) {
      throw new Error('Audio decoder produced no PCM samples')
    }
    return { inputRate: this.inputRate, channels: this.channels, outputSamples: this.sink.samples }
  }

  async accept(chunk: DecodedAudioChunk): Promise<void> {
    const error = decoderErrors(chunk)
    if (error) throw new Error(`Audio decoder rejected the input: ${error}`)
    const channels = chunk.channelData
    if (channels.length === 0) return
    if (channels.length > MAX_AUDIO_CHANNELS) throw new Error('Audio channel count exceeds the supported safety range')
    const frames = channels[0]!.length
    if (channels.some((channel) => channel.length !== frames)) throw new Error('Audio decoder returned uneven channels')
    if (
      !Number.isInteger(chunk.sampleRate) ||
      chunk.sampleRate < MIN_AUDIO_SAMPLE_RATE ||
      chunk.sampleRate > MAX_AUDIO_SAMPLE_RATE
    ) {
      throw new Error('Audio decoder returned an unsafe sample rate')
    }
    if (this.inputRate !== null && this.inputRate !== chunk.sampleRate) {
      throw new Error('Audio sample rate changed during decoding')
    }
    if (this.channels !== null && this.channels !== channels.length) {
      throw new Error('Audio channel count changed during decoding')
    }
    this.inputRate = chunk.sampleRate
    this.channels = channels.length
    if (this.inputSamples + frames > MAX_AUDIO_DURATION_SECONDS * chunk.sampleRate) throw new PcmLimitError()

    for (let frame = 0; frame < frames; frame++) {
      let current = 0
      for (const channel of channels) current += channel[frame]!
      current /= channels.length
      if (!Number.isFinite(current)) throw new Error('Audio decoder returned a non-finite PCM sample')
      const sourceIndex = this.inputSamples++
      while (this.nextOutputSample * chunk.sampleRate <= sourceIndex * WHISPER_PCM_SAMPLE_RATE) {
        const sourcePosition = (this.nextOutputSample * chunk.sampleRate) / WHISPER_PCM_SAMPLE_RATE
        const fraction = sourcePosition - Math.floor(sourcePosition)
        const value =
          sourceIndex === 0 || fraction === 0
            ? current
            : this.previousSample + (current - this.previousSample) * fraction
        const full = this.sink.push(value)
        if (full) await this.sink.write(full)
        this.nextOutputSample++
      }
      this.previousSample = current
    }
  }

  async acceptInterleavedInt16(data: Int16Array, sampleRate: number, channels: number): Promise<void> {
    if (!Number.isInteger(channels) || channels < 1 || channels > MAX_AUDIO_CHANNELS) {
      throw new Error('Audio decoder returned an unsafe channel count')
    }
    if (!Number.isInteger(sampleRate) || sampleRate < MIN_AUDIO_SAMPLE_RATE || sampleRate > MAX_AUDIO_SAMPLE_RATE) {
      throw new Error('Audio decoder returned an unsafe sample rate')
    }
    if (data.length % channels !== 0) throw new Error('Audio decoder returned misaligned interleaved PCM')
    if (this.inputRate !== null && this.inputRate !== sampleRate) {
      throw new Error('Audio sample rate changed during decoding')
    }
    if (this.channels !== null && this.channels !== channels) {
      throw new Error('Audio channel count changed during decoding')
    }
    const frames = data.length / channels
    if (this.inputSamples + frames > MAX_AUDIO_DURATION_SECONDS * sampleRate) throw new PcmLimitError()
    this.inputRate = sampleRate
    this.channels = channels

    for (let frame = 0; frame < frames; frame++) {
      let current = 0
      const frameOffset = frame * channels
      for (let channel = 0; channel < channels; channel++) {
        const sample = data[frameOffset + channel]!
        current += sample < 0 ? sample / 32768 : sample / 32767
      }
      current /= channels
      const sourceIndex = this.inputSamples++
      while (this.nextOutputSample * sampleRate <= sourceIndex * WHISPER_PCM_SAMPLE_RATE) {
        const sourcePosition = (this.nextOutputSample * sampleRate) / WHISPER_PCM_SAMPLE_RATE
        const fraction = sourcePosition - Math.floor(sourcePosition)
        const value =
          sourceIndex === 0 || fraction === 0
            ? current
            : this.previousSample + (current - this.previousSample) * fraction
        const full = this.sink.push(value)
        if (full) await this.sink.write(full)
        this.nextOutputSample++
      }
      this.previousSample = current
    }
  }

  async finish(): Promise<void> {
    if (!this.inputRate || this.inputSamples === 0) throw new Error('Audio decoder produced no PCM samples')
    while (this.nextOutputSample * this.inputRate < this.inputSamples * WHISPER_PCM_SAMPLE_RATE) {
      const full = this.sink.push(this.previousSample)
      if (full) await this.sink.write(full)
      this.nextOutputSample++
    }
    await this.sink.finish()
  }
}

async function readInput(handle: Awaited<ReturnType<typeof fs.open>>, size: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset)
    if (bytesRead === 0) throw new Error('Audio source ended while it was being decoded')
    offset += bytesRead
  }
  return buffer
}

async function decodeM4a(source: Buffer, resampler: StreamingResampler): Promise<'AAC' | 'ALAC'> {
  // This addon's incremental API cannot resume an MP4 demux after an
  // insufficient-data boundary. prepareM4aForDecode therefore validates the
  // codec config, every sample table/range and the native allocation budget
  // before the single append, then we require exact output dimensions.
  const prepared = prepareM4aForDecode(source)
  const { Decoder } = await import('@napi-audio/decoder')
  const decoder = new Decoder({ fileExtension: 'm4a', mimeType: 'audio/mp4' })
  let decodedFrames = 0
  const accept = async (sample: ReturnType<typeof decoder.append>): Promise<void> => {
    if (!sample) return
    if (sample.sampleRate !== prepared.sampleRate || sample.channelCount !== prepared.numberOfChannels) {
      throw new Error('M4A decoder output does not match the bounded codec metadata')
    }
    if (sample.data.length % sample.channelCount !== 0) {
      throw new Error('M4A decoder returned misaligned interleaved PCM')
    }
    const frames = sample.data.length / sample.channelCount
    decodedFrames += frames
    if (decodedFrames > prepared.declaredFrames) {
      throw new Error('M4A decoder output exceeds the validated sample-table duration')
    }
    await resampler.acceptInterleavedInt16(sample.data, sample.sampleRate, sample.channelCount)
  }
  try {
    await accept(decoder.append(prepared.data))
    decoder.finalize()
    await accept(decoder.flush())
    if (decodedFrames !== prepared.declaredFrames) {
      throw new Error('M4A decoder output does not match the validated sample-table duration')
    }
    return prepared.codec
  } finally {
    decoder.close()
  }
}

export async function decodeAudioToPcm(inputPath: string, pcmPath: string): Promise<WhisperAudioMetadata> {
  const input = await fs.open(inputPath, 'r')
  let output: Awaited<ReturnType<typeof fs.open>> | null = null
  let decoder: BoundedStreamingAudioDecoder | null = null
  try {
    const stats = await input.stat()
    if (stats.size > MAX_AUDIO_SOURCE_BYTES) throw new Error('Audio source exceeds the configured byte limit')
    const sample = Buffer.allocUnsafe(Math.min(stats.size, MAX_WAV_HEADER_BYTES))
    const { bytesRead } = await input.read(sample, 0, sample.length, 0)
    const header = sample.subarray(0, bytesRead)
    const format = detectAudioFormat(header)
    if (format === 'wav') wavFormat(header)

    output = await fs.open(pcmPath, 'w')
    const sink = new PcmSink(output)
    const resampler = new StreamingResampler(sink)
    if (format === 'm4a') {
      const codec = await decodeM4a(await readInput(input, stats.size), resampler)
      await resampler.finish()
      const metadata = resampler.metadata
      return {
        codec,
        container: 'MPEG-4',
        durationSeconds: metadata.outputSamples / WHISPER_PCM_SAMPLE_RATE,
        numberOfChannels: metadata.channels,
        sampleRate: metadata.inputRate,
      }
    }

    decoder = await createDecoder(format)
    const stream = createReadStream(inputPath, {
      autoClose: false,
      fd: input.fd,
      highWaterMark: INPUT_CHUNK_BYTES,
      start: 0,
    })
    let sourceBytes = 0
    for await (const chunk of stream) {
      sourceBytes += (chunk as Buffer).length
      if (sourceBytes > MAX_AUDIO_SOURCE_BYTES) throw new Error('Audio source exceeds the configured byte limit')
      await decoder.decode(chunk as Buffer, (decoded) => resampler.accept(decoded))
    }
    await decoder.flush((decoded) => resampler.accept(decoded))
    await resampler.finish()
    const metadata = resampler.metadata
    return metadataFor(format, metadata.inputRate, metadata.channels, metadata.outputSamples)
  } finally {
    try {
      decoder?.free()
    } catch {
      // The isolated process is disposable; preserve the original decode error.
    }
    await output?.close().catch(() => {})
    await input.close().catch(() => {})
  }
}
