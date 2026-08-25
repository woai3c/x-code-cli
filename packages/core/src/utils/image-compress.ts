import { Worker } from 'node:worker_threads'

/** Longest edge accepted by the model-facing image adapter. */
export const MAX_EDGE_PX = 2000

/** 3.75 MB raw stays below the common 5 MB Base64 request ceiling. */
export const ATTACH_BYTE_BUDGET = 3.75 * 1024 * 1024

/** Maximum source bytes read before image validation moves to a worker. */
export const MAX_IMAGE_SOURCE_BYTES = 25 * 1024 * 1024

/** Decode guard, checked from headers before allocating the full bitmap. */
export const MAX_DECODE_PIXELS = 100_000_000

const IMAGE_WORKER_TIMEOUT_MS = 30_000
const JPEG_QUALITY_STEPS = [80, 60, 40, 20] as const
const FALLBACK_EDGES = [2000, 1000, 768, 512, 384, 256] as const
const PNG_RESCALE_FLOOR = 1000
const STANDARD_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

// Jimp 1.6 ships PNG/JPEG/GIF/BMP/TIFF codecs, but not WebP. Keep this list
// tied to the codecs that are actually installed instead of assuming every
// provider-supported input can also be re-encoded locally.
const JIMP_DECODABLE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/tiff'])

export type ImageCompressionFailure =
  | 'animated-over-budget'
  | 'budget-unmet'
  | 'codec-unavailable'
  | 'decode-failed'
  | 'pixel-limit'
  | 'worker-failed'

export interface CompressResult {
  data: Buffer
  mimeType: string
  width: number
  height: number
  originalWidth: number
  originalHeight: number
  changed: boolean
  animated?: true
  failureReason?: ImageCompressionFailure
}

export interface CompressOptions {
  maxEdge?: number
  byteBudget?: number
  abortSignal?: AbortSignal
}

interface SniffedDimensions {
  width: number
  height: number
}

interface EncodedImage {
  data: Buffer
  mimeType: string
  width: number
  height: number
}

export interface ImageCompressWorkerInput {
  data: ArrayBuffer
  mimeType: string
  maxEdge: number
  byteBudget: number
}

export type ImageCompressWorkerOutput =
  | {
      ok: true
      result: Omit<CompressResult, 'data'> & { data: ArrayBuffer }
    }
  | { ok: false; error: string }

type JimpImage = Awaited<ReturnType<(typeof import('jimp'))['Jimp']['fromBuffer']>>

function normalizeMime(mime: string): string {
  const base = (mime.split(';', 1)[0] ?? '').trim().toLowerCase()
  return base === 'image/jpg' ? 'image/jpeg' : base
}

function validDimensions(width: number, height: number): SniffedDimensions | null {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null
}

function sniffJpegDimensions(buf: Buffer): SniffedDimensions | null {
  let offset = 2
  while (offset + 8 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++
      continue
    }
    while (buf[offset] === 0xff) offset++
    const marker = buf[offset++]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > buf.length) break
    const segmentLength = buf.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > buf.length) break
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isStartOfFrame && segmentLength >= 7) {
      return validDimensions(buf.readUInt16BE(offset + 5), buf.readUInt16BE(offset + 3))
    }
    offset += segmentLength
  }
  return null
}

function readTiffScalar(buf: Buffer, offset: number, littleEndian: boolean): number | null {
  if (offset + 12 > buf.length) return null
  const read16 = (at: number): number => (littleEndian ? buf.readUInt16LE(at) : buf.readUInt16BE(at))
  const read32 = (at: number): number => (littleEndian ? buf.readUInt32LE(at) : buf.readUInt32BE(at))
  const type = read16(offset + 2)
  const count = read32(offset + 4)
  if (count < 1) return null
  if (type === 3) return read16(offset + 8)
  if (type === 4) return read32(offset + 8)
  return null
}

function sniffTiffDimensions(buf: Buffer): SniffedDimensions | null {
  if (buf.length < 8) return null
  const littleEndian = buf[0] === 0x49 && buf[1] === 0x49
  const bigEndian = buf[0] === 0x4d && buf[1] === 0x4d
  if (!littleEndian && !bigEndian) return null
  const read16 = (at: number): number => (littleEndian ? buf.readUInt16LE(at) : buf.readUInt16BE(at))
  const read32 = (at: number): number => (littleEndian ? buf.readUInt32LE(at) : buf.readUInt32BE(at))
  if (read16(2) !== 42) return null
  const ifdOffset = read32(4)
  if (ifdOffset + 2 > buf.length) return null
  const entries = Math.min(read16(ifdOffset), 512)
  let width: number | null = null
  let height: number | null = null
  for (let index = 0; index < entries; index++) {
    const entryOffset = ifdOffset + 2 + index * 12
    if (entryOffset + 12 > buf.length) break
    const tag = read16(entryOffset)
    if (tag !== 256 && tag !== 257) continue
    const value = readTiffScalar(buf, entryOffset, littleEndian)
    if (tag === 256) width = value
    else height = value
  }
  return width !== null && height !== null ? validDimensions(width, height) : null
}

function sniffDimensions(buf: Buffer): SniffedDimensions | null {
  if (buf.length < 10) return null
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return validDimensions(buf.readUInt32BE(16), buf.readUInt32BE(20))
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return sniffJpegDimensions(buf)
  if (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return validDimensions(buf.readUInt16LE(6), buf.readUInt16LE(8))
  }
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    const dibSize = buf.readUInt32LE(14)
    if (dibSize === 12) return validDimensions(buf.readUInt16LE(18), buf.readUInt16LE(20))
    return validDimensions(Math.abs(buf.readInt32LE(18)), Math.abs(buf.readInt32LE(22)))
  }
  if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) {
    return sniffTiffDimensions(buf)
  }
  if (
    buf.length >= 30 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const chunk = buf.subarray(12, 16).toString('ascii')
    if (chunk === 'VP8 ') return validDimensions(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff)
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21)
      return validDimensions((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
    }
    if (chunk === 'VP8X') {
      const width = 1 + buf[24]! + (buf[25]! << 8) + (buf[26]! << 16)
      const height = 1 + buf[27]! + (buf[28]! << 8) + (buf[29]! << 16)
      return validDimensions(width, height)
    }
  }
  return null
}

function hasRequiredPngStructure(buf: Buffer): boolean {
  if (buf.length < 45 || !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return false
  }
  let offset = 8
  let chunks = 0
  let sawHeader = false
  let imageDataBytes = 0
  while (offset + 12 <= buf.length && chunks++ < 10_000) {
    const length = buf.readUInt32BE(offset)
    if (length > buf.length - offset - 12) return false
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii')
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return false
      sawHeader = true
    } else if (type === 'IHDR') {
      return false
    }
    if (type === 'IDAT') imageDataBytes += length
    const next = offset + length + 12
    if (type === 'IEND') return length === 0 && imageDataBytes > 0 && next === buf.length
    offset = next
  }
  return false
}

function structurallyComplete(buf: Buffer, mime: string): boolean {
  if (mime === 'image/png') return hasRequiredPngStructure(buf)
  if (mime === 'image/jpeg') return buf.lastIndexOf(Buffer.from([0xff, 0xd9])) >= 2
  if (mime === 'image/gif') return buf.lastIndexOf(0x3b) >= 10
  if (mime === 'image/webp') return buf.length >= 12 && buf.readUInt32LE(4) + 8 <= buf.length
  return true
}

function skipGifSubBlocks(buf: Buffer, start: number): number {
  let offset = start
  while (offset < buf.length) {
    const length = buf[offset++]!
    if (length === 0) return offset
    if (offset + length > buf.length) return buf.length
    offset += length
  }
  return offset
}

function isAnimatedGif(buf: Buffer): boolean {
  if (buf.length < 13) return false
  let offset = 13
  if ((buf[10]! & 0x80) !== 0) offset += 3 * 2 ** ((buf[10]! & 0x07) + 1)
  let frames = 0
  while (offset < buf.length) {
    const marker = buf[offset++]!
    if (marker === 0x3b) break
    if (marker === 0x21) {
      offset++
      offset = skipGifSubBlocks(buf, offset)
      continue
    }
    if (marker !== 0x2c || offset + 9 > buf.length) break
    frames++
    if (frames > 1) return true
    const packed = buf[offset + 8]!
    offset += 9
    if ((packed & 0x80) !== 0) offset += 3 * 2 ** ((packed & 0x07) + 1)
    offset++
    offset = skipGifSubBlocks(buf, offset)
  }
  return false
}

function isAnimated(buf: Buffer, mime: string): boolean {
  if (mime === 'image/gif') return isAnimatedGif(buf)
  return (
    mime === 'image/webp' &&
    buf.length >= 21 &&
    buf.subarray(12, 16).toString('ascii') === 'VP8X' &&
    (buf[20]! & 0x02) !== 0
  )
}

function passthroughResult(
  bytes: Buffer,
  mimeType: string,
  dims: SniffedDimensions | null,
  failureReason?: ImageCompressionFailure,
): CompressResult {
  return {
    data: bytes,
    mimeType,
    width: dims?.width ?? 0,
    height: dims?.height ?? 0,
    originalWidth: dims?.width ?? 0,
    originalHeight: dims?.height ?? 0,
    changed: false,
    ...(isAnimated(bytes, mimeType) ? { animated: true as const } : {}),
    ...(failureReason ? { failureReason } : {}),
  }
}

function standardPassthroughCandidate(
  bytes: Buffer,
  mimeType: string,
  dims: SniffedDimensions | null,
  maxEdge: number,
  byteBudget: number,
): boolean {
  return (
    STANDARD_MIMES.has(mimeType) &&
    !!dims &&
    bytes.length <= byteBudget &&
    Math.max(dims.width, dims.height) <= maxEdge &&
    structurallyComplete(bytes, mimeType)
  )
}

function preflightResult(
  bytes: Buffer,
  mimeType: string,
  maxEdge: number,
  byteBudget: number,
  standardValidated = false,
): CompressResult | null {
  const normalizedMime = normalizeMime(mimeType)
  const dims = sniffDimensions(bytes)
  const passthrough = (failureReason?: ImageCompressionFailure): CompressResult =>
    passthroughResult(bytes, normalizedMime || mimeType, dims, failureReason)

  if (bytes.length === 0) return passthrough('decode-failed')
  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) return passthrough('pixel-limit')
  if (normalizedMime === 'image/png' && !hasRequiredPngStructure(bytes)) return passthrough('decode-failed')

  if (standardPassthroughCandidate(bytes, normalizedMime, dims, maxEdge, byteBudget)) {
    return standardValidated ? passthrough() : null
  }

  if (isAnimated(bytes, normalizedMime)) return passthrough('animated-over-budget')
  if (normalizedMime === 'image/webp') return passthrough('codec-unavailable')
  if (!JIMP_DECODABLE_MIMES.has(normalizedMime)) return passthrough('codec-unavailable')
  return null
}

async function validateStandardImage(bytes: Buffer, mimeType: string): Promise<SniffedDimensions> {
  if (mimeType === 'image/webp') {
    const { loadImage } = await import('@napi-rs/canvas')
    const image = await loadImage(bytes)
    const dimensions = validDimensions(image.width, image.height)
    if (!dimensions) throw new Error('Decoded image has invalid dimensions')
    return dimensions
  }

  const { Jimp } = await import('jimp')
  const image = await Jimp.fromBuffer(bytes)
  const dimensions = validDimensions(image.width, image.height)
  if (!dimensions) throw new Error('Decoded image has invalid dimensions')
  return dimensions
}

function fitWithinEdge(image: JimpImage, edge: number): boolean {
  const longest = Math.max(image.width, image.height)
  if (longest <= edge) return false
  const factor = edge / longest
  image.resize({
    w: Math.max(1, Math.round(image.width * factor)),
    h: Math.max(1, Math.round(image.height * factor)),
  })
  return true
}

async function encodeWithinBudget(
  image: JimpImage,
  options: { preferLossless: boolean; byteBudget: number },
): Promise<EncodedImage> {
  const { preferLossless, byteBudget } = options
  let smallest: EncodedImage | null = null
  const consider = (data: Buffer, mimeType: string): EncodedImage => {
    const candidate = { data, mimeType, width: image.width, height: image.height }
    if (smallest === null || data.length < smallest.data.length) smallest = candidate
    return candidate
  }
  const jpegLadder = async (): Promise<EncodedImage | null> => {
    for (const quality of JPEG_QUALITY_STEPS) {
      const jpeg = await image.getBuffer('image/jpeg', { quality })
      const candidate = consider(jpeg, 'image/jpeg')
      if (jpeg.length <= byteBudget) return candidate
    }
    return null
  }

  if (preferLossless) {
    const png = await image.getBuffer('image/png', { deflateLevel: 9 })
    if (png.length <= byteBudget) return consider(png, 'image/png')
    consider(png, 'image/png')
    for (const edge of FALLBACK_EDGES) {
      if (edge < PNG_RESCALE_FLOOR) break
      if (!fitWithinEdge(image, edge)) continue
      const smallerPng = await image.getBuffer('image/png', { deflateLevel: 9 })
      if (smallerPng.length <= byteBudget) return consider(smallerPng, 'image/png')
      consider(smallerPng, 'image/png')
    }
    const atFloor = await jpegLadder()
    if (atFloor) return atFloor
    for (const edge of FALLBACK_EDGES) {
      if (edge >= PNG_RESCALE_FLOOR || !fitWithinEdge(image, edge)) continue
      const atEdge = await jpegLadder()
      if (atEdge) return atEdge
    }
    return smallest!
  }

  const atFitted = await jpegLadder()
  if (atFitted) return atFitted
  for (const edge of FALLBACK_EDGES) {
    if (!fitWithinEdge(image, edge)) continue
    const atEdge = await jpegLadder()
    if (atEdge) return atEdge
  }
  return smallest!
}

/** Worker entrypoint. Call `compressImage()` from application code. */
export async function compressImageInProcess(
  bytes: Buffer,
  mimeType: string,
  options: Pick<CompressOptions, 'maxEdge' | 'byteBudget'> = {},
): Promise<CompressResult> {
  const maxEdge = options.maxEdge ?? MAX_EDGE_PX
  const byteBudget = options.byteBudget ?? ATTACH_BYTE_BUDGET
  const normalizedMime = normalizeMime(mimeType)
  const dimensions = sniffDimensions(bytes)
  const immediate = preflightResult(bytes, normalizedMime, maxEdge, byteBudget)
  if (immediate) return immediate

  try {
    if (standardPassthroughCandidate(bytes, normalizedMime, dimensions, maxEdge, byteBudget)) {
      const decoded = await validateStandardImage(bytes, normalizedMime)
      if (
        !dimensions ||
        decoded.width !== dimensions.width ||
        decoded.height !== dimensions.height ||
        decoded.width * decoded.height > MAX_DECODE_PIXELS
      ) {
        return passthroughResult(bytes, normalizedMime, dimensions, 'decode-failed')
      }
      return preflightResult(bytes, normalizedMime, maxEdge, byteBudget, true)!
    }

    const { Jimp } = await import('jimp')
    const image = await Jimp.fromBuffer(bytes)
    const decodedWidth = image.width
    const decodedHeight = image.height
    if (decodedWidth * decodedHeight > MAX_DECODE_PIXELS) {
      return passthroughResult(bytes, normalizedMime, dimensions, 'pixel-limit')
    }

    const requiresNormalization = !STANDARD_MIMES.has(normalizedMime) || !structurallyComplete(bytes, normalizedMime)
    fitWithinEdge(image, maxEdge)
    const encoded = await encodeWithinBudget(image, {
      preferLossless: normalizedMime !== 'image/jpeg',
      byteBudget,
    })
    const budgetMet = encoded.data.length <= byteBudget && Math.max(encoded.width, encoded.height) <= maxEdge
    const originalPixels = decodedWidth * decodedHeight
    const finalPixels = encoded.width * encoded.height
    if (!requiresNormalization && encoded.data.length >= bytes.length && finalPixels >= originalPixels) {
      return passthroughResult(bytes, normalizedMime, dimensions, budgetMet ? undefined : 'budget-unmet')
    }
    return {
      data: encoded.data,
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      originalWidth: decodedWidth,
      originalHeight: decodedHeight,
      changed: true,
      ...(budgetMet ? {} : { failureReason: 'budget-unmet' as const }),
    }
  } catch {
    return passthroughResult(bytes, normalizedMime, dimensions, 'decode-failed')
  }
}

function imageWorkerUrl(): URL {
  const current = new URL(import.meta.url)
  if (current.pathname.endsWith('/src/utils/image-compress.ts')) {
    return new URL('../../dist/utils/image-compress-worker.js', current)
  }
  if (current.pathname.includes('/chunks/')) return new URL('../image-compress-worker.js', current)
  return new URL('./image-compress-worker.js', current)
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
}

async function runCompressionWorker(
  bytes: Buffer,
  mimeType: string,
  maxEdge: number,
  byteBudget: number,
  abortSignal?: AbortSignal,
): Promise<CompressResult> {
  abortSignal?.throwIfAborted()
  const inputBytes = Uint8Array.from(bytes)
  const worker = new Worker(imageWorkerUrl(), {
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 },
    workerData: {
      data: inputBytes.buffer,
      mimeType,
      maxEdge,
      byteBudget,
    } satisfies ImageCompressWorkerInput,
    transferList: [inputBytes.buffer],
  })

  return new Promise<CompressResult>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      void worker.terminate()
      reject(error)
    }
    const onAbort = (): void => fail(abortError(abortSignal))
    const timer = setTimeout(
      () => fail(new Error(`Image compression timed out after ${IMAGE_WORKER_TIMEOUT_MS} ms`)),
      IMAGE_WORKER_TIMEOUT_MS,
    )
    abortSignal?.addEventListener('abort', onAbort, { once: true })
    if (abortSignal?.aborted) onAbort()
    worker.once('message', (output: ImageCompressWorkerOutput) => {
      if (settled) return
      if (!output.ok) {
        fail(new Error(output.error))
        return
      }
      settled = true
      cleanup()
      void worker.terminate()
      resolve({ ...output.result, data: Buffer.from(output.result.data) })
    })
    worker.once('error', fail)
    worker.once('exit', (code) => {
      if (!settled) fail(new Error(`Image compression worker exited unexpectedly with code ${code}`))
    })
  })
}

/**
 * Validate, normalize and compress an image for model delivery. Header-only
 * rejection stays on the caller thread; every accepted standard image is
 * decoded in a task-owned worker before its original bytes may pass through.
 */
export async function compressImage(
  bytes: Buffer,
  mimeType: string,
  options: CompressOptions = {},
): Promise<CompressResult> {
  options.abortSignal?.throwIfAborted()
  const maxEdge = options.maxEdge ?? MAX_EDGE_PX
  const byteBudget = options.byteBudget ?? ATTACH_BYTE_BUDGET
  const immediate = preflightResult(bytes, mimeType, maxEdge, byteBudget)
  options.abortSignal?.throwIfAborted()
  if (immediate) return immediate
  try {
    return await runCompressionWorker(bytes, mimeType, maxEdge, byteBudget, options.abortSignal)
  } catch {
    options.abortSignal?.throwIfAborted()
    return passthroughResult(bytes, normalizeMime(mimeType), sniffDimensions(bytes), 'worker-failed')
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function buildCompressionCaption(result: CompressResult): string {
  const original =
    result.originalWidth > 0 ? `${result.originalWidth}x${result.originalHeight}` : formatBytes(result.data.length)
  const current = result.width > 0 ? `${result.width}x${result.height} ${result.mimeType}` : result.mimeType
  return `[Image compressed to fit model limits: ${original} → ${current}. Fine detail may be lost.]`
}

export function buildImageProcessingFailureNotice(name: string, result: CompressResult): string {
  switch (result.failureReason) {
    case 'animated-over-budget':
      return `[Image ${name} is animated and exceeds the image limits. Convert or resize it explicitly; animation is not silently flattened.]`
    case 'codec-unavailable':
      return `[Image ${name} uses ${result.mimeType}, which cannot be normalized by the installed local image codec.]`
    case 'decode-failed':
      return `[Image ${name} is corrupt or could not be decoded locally.]`
    case 'pixel-limit':
      return `[Image ${name} exceeds the ${MAX_DECODE_PIXELS.toLocaleString('en-US')}-pixel decode safety limit.]`
    case 'worker-failed':
      return `[Image ${name} could not be processed in the local image worker.]`
    default:
      return `[Image ${name} could not be reduced to provider limits (${formatBytes(result.data.length)}, ${result.width}x${result.height}).]`
  }
}
