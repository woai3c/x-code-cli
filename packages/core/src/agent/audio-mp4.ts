import { MAX_AUDIO_DURATION_SECONDS } from './audio-limits.js'

// The native API returns one aggregate Int16Array, so validate its maximum
// backing allocation from mutually consistent codec and sample-table data.
const MAX_M4A_NATIVE_PCM_BYTES = 256 * 1024 * 1024
const MAX_M4A_PACKET_COUNT = 300_000
const MAX_M4A_PACKET_FRAMES = 8_192
const MAX_AUDIO_CHANNELS = 8
const MIN_AUDIO_SAMPLE_RATE = 8_000
const MAX_AUDIO_SAMPLE_RATE = 192_000

const AAC_SAMPLE_RATES = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350,
] as const

const AAC_CHANNELS = new Map([
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 4],
  [5, 5],
  [6, 6],
  [7, 8],
])

interface Mp4Box {
  end: number
  headerSize: number
  size: number
  start: number
  type: string
}

interface BoxMapping extends Mp4Box {
  newStart: number
}

export interface PreparedM4a {
  codec: 'AAC' | 'ALAC'
  data: Buffer
  declaredFrames: number
  declaredDurationSeconds: number
  numberOfChannels: number
  sampleRate: number
}

interface AudioTrack {
  codec: 'AAC' | 'ALAC'
  entryIndex: number
  maxPacketFrames: number
  mdia: Mp4Box
  numberOfChannels: number
  sampleRate: number
  stbl: Mp4Box
}

interface Descriptor {
  end: number
  payloadStart: number
  tag: number
}

interface SampleTiming {
  declaredFrames: number
  sampleCount: number
}

interface SampleRange {
  end: number
  start: number
}

function parseBoxes(buffer: Buffer, start = 0, end = buffer.length): Mp4Box[] {
  const boxes: Mp4Box[] = []
  let offset = start
  while (offset < end) {
    if (end - offset < 8) throw new Error('M4A contains a truncated MP4 box header')
    const size32 = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    let headerSize = 8
    let size: number
    if (size32 === 1) {
      if (end - offset < 16) throw new Error(`M4A ${type} box has a truncated extended-size header`)
      const extendedSize = buffer.readBigUInt64BE(offset + 8)
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`M4A ${type} box is too large`)
      size = Number(extendedSize)
      headerSize = 16
    } else {
      size = size32 === 0 ? end - offset : size32
    }
    if (size < headerSize || offset + size > end) throw new Error(`M4A ${type} box has an invalid size`)
    boxes.push({ end: offset + size, headerSize, size, start: offset, type })
    offset += size
  }
  return boxes
}

function children(buffer: Buffer, parent: Mp4Box, prefixBytes = 0): Mp4Box[] {
  const start = parent.start + parent.headerSize + prefixBytes
  if (start > parent.end) throw new Error(`M4A ${parent.type} box is truncated`)
  return parseBoxes(buffer, start, parent.end)
}

function child(buffer: Buffer, parent: Mp4Box, type: string): Mp4Box {
  const found = children(buffer, parent).find((box) => box.type === type)
  if (!found) throw new Error(`M4A audio track is missing its ${type} box`)
  return found
}

function audioSampleEntryChildren(buffer: Buffer, entry: Mp4Box): Mp4Box[] {
  if (entry.start + 36 > entry.end) throw new Error('M4A audio sample description is truncated')
  const version = buffer.readUInt16BE(entry.start + 16)
  const prefixBytes = version === 0 ? 28 : version === 1 ? 44 : version === 2 ? 64 : -1
  if (prefixBytes < 0) throw new Error(`M4A uses an unsupported audio sample-entry version: ${version}`)
  return children(buffer, entry, prefixBytes)
}

function readDescriptor(buffer: Buffer, offset: number, end: number): Descriptor {
  if (offset >= end) throw new Error('M4A AAC descriptor is truncated')
  const tag = buffer[offset]!
  let size = 0
  let cursor = offset + 1
  let complete = false
  for (let index = 0; index < 4; index++) {
    if (cursor >= end) throw new Error('M4A AAC descriptor length is truncated')
    const byte = buffer[cursor++]!
    size = size * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) {
      complete = true
      break
    }
  }
  if (!complete || cursor + size > end) throw new Error('M4A AAC descriptor has an invalid length')
  return { end: cursor + size, payloadStart: cursor, tag }
}

function findDecoderSpecificInfo(buffer: Buffer, start: number, end: number): Buffer | null {
  let offset = start
  while (offset < end) {
    const descriptor = readDescriptor(buffer, offset, end)
    if (descriptor.tag === 0x05) return buffer.subarray(descriptor.payloadStart, descriptor.end)

    let nestedStart: number | null = null
    if (descriptor.tag === 0x03) {
      if (descriptor.payloadStart + 3 > descriptor.end) throw new Error('M4A AAC ES descriptor is truncated')
      const flags = buffer[descriptor.payloadStart + 2]!
      nestedStart = descriptor.payloadStart + 3
      if (flags & 0x80) nestedStart += 2
      if (flags & 0x40) {
        if (nestedStart >= descriptor.end) throw new Error('M4A AAC URL descriptor is truncated')
        nestedStart += 1 + buffer[nestedStart]!
      }
      if (flags & 0x20) nestedStart += 2
    } else if (descriptor.tag === 0x04) {
      nestedStart = descriptor.payloadStart + 13
    }
    if (nestedStart !== null) {
      if (nestedStart > descriptor.end) throw new Error('M4A AAC descriptor fields exceed their box')
      const found = findDecoderSpecificInfo(buffer, nestedStart, descriptor.end)
      if (found) return found
    }
    offset = descriptor.end
  }
  return null
}

class BitReader {
  private bitOffset = 0

  constructor(private readonly data: Buffer) {}

  read(bits: number): number {
    if (!Number.isInteger(bits) || bits < 1 || bits > 24 || this.bitOffset + bits > this.data.length * 8) {
      throw new Error('M4A AAC AudioSpecificConfig is truncated')
    }
    let value = 0
    for (let index = 0; index < bits; index++) {
      const absolute = this.bitOffset++
      value = value * 2 + ((this.data[absolute >>> 3]! >>> (7 - (absolute & 7))) & 1)
    }
    return value
  }
}

function readAacObjectType(bits: BitReader): number {
  const value = bits.read(5)
  return value === 31 ? 32 + bits.read(6) : value
}

function readAacSampleRate(bits: BitReader): number {
  const index = bits.read(4)
  const sampleRate = index === 15 ? bits.read(24) : AAC_SAMPLE_RATES[index]
  if (!sampleRate || sampleRate < MIN_AUDIO_SAMPLE_RATE || sampleRate > MAX_AUDIO_SAMPLE_RATE) {
    throw new Error('M4A AAC config has an unsafe sample rate')
  }
  return sampleRate
}

function aacMetadata(
  buffer: Buffer,
  entry: Mp4Box,
): { maxPacketFrames: number; numberOfChannels: number; sampleRate: number } {
  const esds = audioSampleEntryChildren(buffer, entry).find((box) => box.type === 'esds')
  if (!esds) throw new Error('M4A AAC sample description is missing its esds box')
  const payload = esds.start + esds.headerSize
  if (payload + 4 > esds.end) throw new Error('M4A AAC esds box is truncated')
  const config = findDecoderSpecificInfo(buffer, payload + 4, esds.end)
  if (!config) throw new Error('M4A AAC sample description is missing AudioSpecificConfig')

  const bits = new BitReader(config)
  let objectType = readAacObjectType(bits)
  let sampleRate = readAacSampleRate(bits)
  let channelConfig = bits.read(4)
  if (objectType === 5 || objectType === 29) {
    sampleRate = readAacSampleRate(bits)
    objectType = readAacObjectType(bits)
    if (objectType === 22) channelConfig = bits.read(4)
  }
  if (objectType !== 2) throw new Error(`M4A uses an unsupported AAC object type: ${objectType}`)
  const numberOfChannels = AAC_CHANNELS.get(channelConfig)
  if (!numberOfChannels) throw new Error(`M4A uses an unsupported AAC channel configuration: ${channelConfig}`)
  return { maxPacketFrames: 2_048, numberOfChannels, sampleRate }
}

function alacMetadata(
  buffer: Buffer,
  entry: Mp4Box,
): { maxPacketFrames: number; numberOfChannels: number; sampleRate: number } {
  const config = audioSampleEntryChildren(buffer, entry).find((box) => box.type === 'alac')
  if (!config || config.end - config.start - config.headerSize < 24) {
    throw new Error('M4A ALAC sample description is missing its codec config')
  }
  const start = config.end - 24
  const frameLength = buffer.readUInt32BE(start)
  const numberOfChannels = buffer[start + 9]!
  const sampleRate = buffer.readUInt32BE(start + 20)
  if (frameLength < 1 || frameLength > MAX_M4A_PACKET_FRAMES) {
    throw new Error('M4A ALAC frame length exceeds the supported safety range')
  }
  if (numberOfChannels < 1 || numberOfChannels > MAX_AUDIO_CHANNELS) {
    throw new Error('M4A ALAC channel count exceeds the supported safety range')
  }
  if (sampleRate < MIN_AUDIO_SAMPLE_RATE || sampleRate > MAX_AUDIO_SAMPLE_RATE) {
    throw new Error('M4A ALAC sample rate exceeds the supported safety range')
  }
  return { maxPacketFrames: frameLength, numberOfChannels, sampleRate }
}

function findAudioTrack(buffer: Buffer, moov: Mp4Box): AudioTrack {
  for (const trak of children(buffer, moov).filter((box) => box.type === 'trak')) {
    const mdia = child(buffer, trak, 'mdia')
    const hdlr = child(buffer, mdia, 'hdlr')
    const handlerPayload = hdlr.start + hdlr.headerSize
    if (
      handlerPayload + 12 > hdlr.end ||
      buffer.toString('ascii', handlerPayload + 8, handlerPayload + 12) !== 'soun'
    ) {
      continue
    }

    const minf = child(buffer, mdia, 'minf')
    const stbl = child(buffer, minf, 'stbl')
    const stsd = child(buffer, stbl, 'stsd')
    const stsdPayload = stsd.start + stsd.headerSize
    if (stsdPayload + 8 > stsd.end) throw new Error('M4A sample-description box is truncated')
    const entryCount = buffer.readUInt32BE(stsdPayload + 4)
    const entries = parseBoxes(buffer, stsdPayload + 8, stsd.end)
    if (entries.length !== entryCount) throw new Error('M4A sample-description count is inconsistent')
    const entryIndex = entries.findIndex((box) => box.type === 'mp4a' || box.type === 'alac')
    const entry = entries[entryIndex]
    if (!entry) throw new Error('M4A does not contain a supported AAC or ALAC audio track')
    const codec = entry.type === 'alac' ? 'ALAC' : 'AAC'
    const metadata = codec === 'AAC' ? aacMetadata(buffer, entry) : alacMetadata(buffer, entry)
    return { codec, entryIndex: entryIndex + 1, mdia, stbl, ...metadata }
  }
  throw new Error('M4A does not contain an audio track')
}

function mediaTiming(buffer: Buffer, track: AudioTrack): { duration: bigint; timescale: number } {
  const mdhd = child(buffer, track.mdia, 'mdhd')
  const mdhdPayload = mdhd.start + mdhd.headerSize
  if (mdhdPayload + 4 > mdhd.end) throw new Error('M4A media header is truncated')
  const version = buffer[mdhdPayload]
  let timescale: number
  let duration: bigint
  if (version === 0) {
    if (mdhdPayload + 20 > mdhd.end) throw new Error('M4A media header is truncated')
    timescale = buffer.readUInt32BE(mdhdPayload + 12)
    duration = BigInt(buffer.readUInt32BE(mdhdPayload + 16))
    if (duration === 0xffffffffn) throw new Error('M4A has an unknown audio duration')
  } else if (version === 1) {
    if (mdhdPayload + 32 > mdhd.end) throw new Error('M4A media header is truncated')
    timescale = buffer.readUInt32BE(mdhdPayload + 20)
    duration = buffer.readBigUInt64BE(mdhdPayload + 24)
    if (duration === 0xffffffffffffffffn) throw new Error('M4A has an unknown audio duration')
  } else {
    throw new Error(`M4A uses an unsupported media-header version: ${version}`)
  }
  if (timescale === 0 || duration === 0n) throw new Error('M4A has invalid audio timing metadata')
  if (duration > BigInt(timescale) * BigInt(MAX_AUDIO_DURATION_SECONDS)) {
    throw new Error(`M4A exceeds the ${MAX_AUDIO_DURATION_SECONDS}s local decode limit`)
  }
  return { duration, timescale }
}

function sampleTiming(buffer: Buffer, track: AudioTrack, timescale: number, mdhdDuration: bigint): SampleTiming {
  const stts = child(buffer, track.stbl, 'stts')
  const payload = stts.start + stts.headerSize
  if (payload + 8 > stts.end) throw new Error('M4A time-to-sample table is truncated')
  const entryCount = buffer.readUInt32BE(payload + 4)
  if (entryCount > Math.floor((stts.end - payload - 8) / 8)) {
    throw new Error('M4A time-to-sample entry count exceeds its box size')
  }
  let duration = 0n
  let sampleCount = 0
  for (let index = 0; index < entryCount; index++) {
    const offset = payload + 8 + index * 8
    const count = buffer.readUInt32BE(offset)
    const delta = buffer.readUInt32BE(offset + 4)
    if (count === 0 || delta === 0 || sampleCount + count > MAX_M4A_PACKET_COUNT) {
      throw new Error('M4A time-to-sample table exceeds the supported packet range')
    }
    const packetFrames = Number((BigInt(delta) * BigInt(track.sampleRate) + BigInt(timescale) - 1n) / BigInt(timescale))
    if (packetFrames < 1 || packetFrames > track.maxPacketFrames) {
      throw new Error('M4A packet duration exceeds the supported sample-allocation range')
    }
    duration += BigInt(count) * BigInt(delta)
    sampleCount += count
  }
  if (sampleCount === 0 || duration !== mdhdDuration) {
    throw new Error('M4A media duration does not match its time-to-sample table')
  }
  const declaredFrames = Number((duration * BigInt(track.sampleRate) + BigInt(timescale) - 1n) / BigInt(timescale))
  const decodedBytes = BigInt(declaredFrames) * BigInt(track.numberOfChannels) * BigInt(Int16Array.BYTES_PER_ELEMENT)
  if (!Number.isSafeInteger(declaredFrames) || decodedBytes > BigInt(MAX_M4A_NATIVE_PCM_BYTES)) {
    throw new Error('M4A decoded audio exceeds the local decoder memory limit')
  }
  return { declaredFrames, sampleCount }
}

function sampleSizes(buffer: Buffer, stbl: Mp4Box, expectedCount: number): number[] {
  const stsz = child(buffer, stbl, 'stsz')
  const payload = stsz.start + stsz.headerSize
  if (payload + 12 > stsz.end) throw new Error('M4A sample-size table is truncated')
  const constantSize = buffer.readUInt32BE(payload + 4)
  const count = buffer.readUInt32BE(payload + 8)
  if (count !== expectedCount) throw new Error('M4A sample-size count does not match its timing table')
  if (constantSize === 0 && count > Math.floor((stsz.end - payload - 12) / 4)) {
    throw new Error('M4A sample-size entry count exceeds its box size')
  }
  const sizes = new Array<number>(count)
  for (let index = 0; index < count; index++) {
    const size = constantSize || buffer.readUInt32BE(payload + 12 + index * 4)
    if (size === 0) throw new Error('M4A contains an empty encoded audio sample')
    sizes[index] = size
  }
  return sizes
}

function chunkOffsets(buffer: Buffer, stbl: Mp4Box): number[] {
  const tables = children(buffer, stbl).filter((box) => box.type === 'stco' || box.type === 'co64')
  if (tables.length !== 1) throw new Error('M4A audio track must contain exactly one chunk-offset table')
  const table = tables[0]!
  const payload = table.start + table.headerSize
  if (payload + 8 > table.end) throw new Error(`M4A ${table.type} table is truncated`)
  const count = buffer.readUInt32BE(payload + 4)
  const width = table.type === 'stco' ? 4 : 8
  if (count === 0 || count > MAX_M4A_PACKET_COUNT || count > Math.floor((table.end - payload - 8) / width)) {
    throw new Error(`M4A ${table.type} entry count exceeds the supported range`)
  }
  return Array.from({ length: count }, (_, index) => {
    const offset = payload + 8 + index * width
    const value = width === 4 ? BigInt(buffer.readUInt32BE(offset)) : buffer.readBigUInt64BE(offset)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('M4A chunk offset exceeds the safe integer range')
    return Number(value)
  })
}

function sampleRanges(buffer: Buffer, topLevelBoxes: Mp4Box[], track: AudioTrack, sizes: number[]): SampleRange[] {
  const offsets = chunkOffsets(buffer, track.stbl)
  const stsc = child(buffer, track.stbl, 'stsc')
  const payload = stsc.start + stsc.headerSize
  if (payload + 8 > stsc.end) throw new Error('M4A sample-to-chunk table is truncated')
  const entryCount = buffer.readUInt32BE(payload + 4)
  if (entryCount === 0 || entryCount > Math.floor((stsc.end - payload - 8) / 12)) {
    throw new Error('M4A sample-to-chunk entry count exceeds its box size')
  }
  const entries = Array.from({ length: entryCount }, (_, index) => {
    const offset = payload + 8 + index * 12
    return {
      firstChunk: buffer.readUInt32BE(offset),
      samplesPerChunk: buffer.readUInt32BE(offset + 4),
      sampleDescriptionIndex: buffer.readUInt32BE(offset + 8),
    }
  })
  if (entries[0]?.firstChunk !== 1) throw new Error('M4A sample-to-chunk table does not start at the first chunk')
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    const previous = entries[index - 1]
    if (
      entry.samplesPerChunk === 0 ||
      entry.sampleDescriptionIndex !== track.entryIndex ||
      entry.firstChunk > offsets.length ||
      (previous && entry.firstChunk <= previous.firstChunk)
    ) {
      throw new Error('M4A sample-to-chunk table is inconsistent')
    }
  }

  const ranges: SampleRange[] = []
  let sampleIndex = 0
  let descriptionIndex = 0
  for (let chunkIndex = 1; chunkIndex <= offsets.length; chunkIndex++) {
    while (descriptionIndex + 1 < entries.length && entries[descriptionIndex + 1]!.firstChunk <= chunkIndex) {
      descriptionIndex++
    }
    const samplesPerChunk = entries[descriptionIndex]!.samplesPerChunk
    let offset = offsets[chunkIndex - 1]!
    for (let index = 0; index < samplesPerChunk; index++) {
      const size = sizes[sampleIndex++]
      if (size === undefined || offset + size > Number.MAX_SAFE_INTEGER) {
        throw new Error('M4A chunk layout exceeds its sample-size table')
      }
      ranges.push({ start: offset, end: offset + size })
      offset += size
    }
  }
  if (sampleIndex !== sizes.length) throw new Error('M4A chunk layout does not cover every encoded sample')

  ranges.sort((left, right) => left.start - right.start || left.end - right.end)
  const media = topLevelBoxes
    .filter((box) => box.type === 'mdat')
    .map((box) => ({ start: box.start + box.headerSize, end: box.end }))
    .sort((left, right) => left.start - right.start)
  let mediaIndex = 0
  let previousEnd = -1
  for (const range of ranges) {
    if (range.start < previousEnd) throw new Error('M4A encoded audio samples overlap')
    while (mediaIndex < media.length && range.start >= media[mediaIndex]!.end) mediaIndex++
    const container = media[mediaIndex]
    if (!container || range.start < container.start || range.end > container.end) {
      throw new Error('M4A encoded audio sample points outside media data')
    }
    previousEnd = range.end
  }
  return ranges
}

function audioTrackMetadata(buffer: Buffer, moov: Mp4Box, topLevelBoxes: Mp4Box[]): Omit<PreparedM4a, 'data'> {
  const track = findAudioTrack(buffer, moov)
  const { duration, timescale } = mediaTiming(buffer, track)
  const timing = sampleTiming(buffer, track, timescale, duration)
  const sizes = sampleSizes(buffer, track.stbl, timing.sampleCount)
  sampleRanges(buffer, topLevelBoxes, track, sizes)
  return {
    codec: track.codec,
    declaredDurationSeconds: Number(duration) / timescale,
    declaredFrames: timing.declaredFrames,
    numberOfChannels: track.numberOfChannels,
    sampleRate: track.sampleRate,
  }
}

function sampleTables(buffer: Buffer, moov: Mp4Box): Mp4Box[] {
  const tables: Mp4Box[] = []
  for (const trak of children(buffer, moov).filter((box) => box.type === 'trak')) {
    const mdia = children(buffer, trak).find((box) => box.type === 'mdia')
    const minf = mdia && children(buffer, mdia).find((box) => box.type === 'minf')
    const stbl = minf && children(buffer, minf).find((box) => box.type === 'stbl')
    if (stbl) tables.push(...children(buffer, stbl).filter((box) => box.type === 'stco' || box.type === 'co64'))
  }
  return tables
}

function mappedOffset(offset: bigint, mappings: BoxMapping[]): bigint {
  for (const box of mappings) {
    const start = BigInt(box.start)
    const end = BigInt(box.end)
    if (offset >= start && offset < end) return BigInt(box.newStart) + (offset - start)
  }
  throw new Error('M4A chunk offset points outside the file')
}

function patchChunkOffsets(moov: Buffer, mappings: BoxMapping[]): void {
  const root = parseBoxes(moov)
  if (root.length !== 1 || root[0]?.type !== 'moov') throw new Error('M4A movie metadata is malformed')
  for (const table of sampleTables(moov, root[0])) {
    const payload = table.start + table.headerSize
    if (payload + 8 > table.end) throw new Error(`M4A ${table.type} table is truncated`)
    const count = moov.readUInt32BE(payload + 4)
    const width = table.type === 'stco' ? 4 : 8
    if (count > Math.floor((table.end - payload - 8) / width)) {
      throw new Error(`M4A ${table.type} entry count exceeds its box size`)
    }
    for (let index = 0; index < count; index++) {
      const position = payload + 8 + index * width
      const current = width === 4 ? BigInt(moov.readUInt32BE(position)) : moov.readBigUInt64BE(position)
      const next = mappedOffset(current, mappings)
      if (width === 4) {
        if (next > 0xffffffffn) throw new Error('M4A chunk offset exceeds the 32-bit table range')
        moov.writeUInt32BE(Number(next), position)
      } else {
        moov.writeBigUInt64BE(next, position)
      }
    }
  }
}

function moveMovieMetadataBeforeMedia(buffer: Buffer, boxes: Mp4Box[], moov: Mp4Box, mdat: Mp4Box): Buffer {
  if (moov.start < mdat.start) return buffer
  const beforeMedia = boxes.filter((box) => box.start < mdat.start && box !== moov)
  const fromMedia = boxes.filter((box) => box.start >= mdat.start && box !== moov)
  const order = [...beforeMedia, moov, ...fromMedia]
  let newStart = 0
  const mappings = order.map((box) => {
    const mapping = { ...box, newStart }
    newStart += box.size
    return mapping
  })
  const patchedMoov = Buffer.from(buffer.subarray(moov.start, moov.end))
  patchChunkOffsets(patchedMoov, mappings)
  return Buffer.concat(
    order.map((box) => (box === moov ? patchedMoov : buffer.subarray(box.start, box.end))),
    buffer.length,
  )
}

export function prepareM4aForDecode(buffer: Buffer): PreparedM4a {
  const boxes = parseBoxes(buffer)
  const moovBoxes = boxes.filter((box) => box.type === 'moov')
  const mdat = boxes.find((box) => box.type === 'mdat')
  if (moovBoxes.length !== 1 || !mdat)
    throw new Error('M4A must contain exactly one moov box and at least one mdat box')
  const moov = moovBoxes[0]!
  const data = moveMovieMetadataBeforeMedia(buffer, boxes, moov, mdat)
  const preparedBoxes = parseBoxes(data)
  const preparedMoov = preparedBoxes.find((box) => box.type === 'moov')!
  const metadata = audioTrackMetadata(data, preparedMoov, preparedBoxes)
  return {
    ...metadata,
    data,
  }
}
