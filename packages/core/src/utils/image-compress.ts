// @x-code-cli/core — Image compression for model delivery
//
// Downsamples and re-encodes oversized images before they reach the provider,
// using Jimp (pure JS, no native dependencies). The codec is lazy-loaded so
// startup and the within-budget fast path stay cheap.
//
// Design mirrors Kimi Code's approach:
//  - Fast path: if both byte size and pixel dimensions are within budget, the
//    original bytes are returned untouched — zero codec allocation.
//  - Pixel dimension ceiling: images wider/taller than MAX_EDGE_PX are scaled
//    down proportionally (preserving aspect ratio).
//  - Byte budget: after the edge fit, a quality/format ladder walks down
//    (PNG → JPEG q80/60/40/20) with progressively smaller edge fallbacks
//    until the result fits.
//  - PNG sources try lossless compression first (preserves text and alpha);
//    JPEG sources go straight to the quality ladder.
//  - Best effort: any decode/encode failure returns the original bytes with
//    `changed: false` — callers decide whether the oversized original is
//    acceptable downstream.
//  - Animated formats (GIF, animated WebP) are never re-encoded — doing so
//    would flatten to a single frame.

/** Longest-edge pixel ceiling. Images with either dimension above this are
 *  scaled down to fit. Matches Claude Code and Kimi Code's default of 2000.
 *  Anthropic's API internally resizes to 1568px, so 2000 keeps a slight
 *  margin of quality without being wasteful. */
export const MAX_EDGE_PX = 2000

/** Raw-byte budget for user-attached images (@ mentions, paste). 3.75 MB raw
 *  stays under the 5 MB base64 ceiling every major provider enforces. */
export const ATTACH_BYTE_BUDGET = 3.75 * 1024 * 1024

/** Progressively lower JPEG quality for the lossy ladder. */
const JPEG_QUALITY_STEPS = [80, 60, 40, 20] as const

/** Edge step-downs when the budget cannot be met at the fitted size. */
const FALLBACK_EDGES = [2000, 1000, 768, 512, 384, 256] as const

/** PNG lossless rescaling stops at this edge; below, the ladder goes lossy. */
const PNG_RESCALE_FLOOR = 1000

/** Pixel-count ceiling above which we skip compression entirely — a
 *  decompression-bomb guard. */
const MAX_DECODE_PIXELS = 100_000_000

/** Re-encodable MIME types. GIF is excluded (animation). */
const RECODABLE = new Set(['image/png', 'image/jpeg', 'image/webp'])

export interface CompressResult {
  /** Bytes to send: the re-encoded image, or the original when unchanged. */
  data: Buffer
  /** MIME of `data`. May differ from the input (e.g. png → jpeg). */
  mimeType: string
  /** Pixel width of the output (0 when unknown). */
  width: number
  /** Pixel height of the output (0 when unknown). */
  height: number
  /** Pixel width of the input image (0 when unknown). */
  originalWidth: number
  /** Pixel height of the input image (0 when unknown). */
  originalHeight: number
  /** True only when `data` differs from the input bytes. */
  changed: boolean
}

export interface CompressOptions {
  /** Override the longest-edge ceiling (px). */
  maxEdge?: number
  /** Override the raw-byte budget. */
  byteBudget?: number
}

// ── header sniff ─────────────────────────────────────────────────────
// Read pixel dimensions from the image header without decoding the full
// bitmap — keeps the fast path allocation-free.

interface SniffedDimensions {
  width: number
  height: number
}

function sniffDimensions(buf: Buffer): SniffedDimensions | null {
  if (buf.length < 24) return null
  // PNG: bytes 16-23 carry IHDR width (4B BE) and height (4B BE).
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // JPEG: scan for SOF0/SOF2 markers. Height at offset+5, width at offset+7.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset + 10 < buf.length) {
      if (buf[offset] !== 0xff) break
      const marker = buf[offset + 1]!
      if (marker === 0xc0 || marker === 0xc2) {
        return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) }
      }
      const segLen = buf.readUInt16BE(offset + 2)
      offset += 2 + segLen
    }
    return null
  }
  // WebP: bytes 24-29 for VP8 lossy; 26-29 for VP8L lossless.
  if (
    buf.length >= 30 &&
    buf[0] === 0x52 && // 'R'
    buf[1] === 0x49 && // 'I'
    buf[2] === 0x46 && // 'F'
    buf[3] === 0x46 && // 'F'
    buf[8] === 0x57 && // 'W'
    buf[9] === 0x45 && // 'E'
    buf[10] === 0x42 && // 'B'
    buf[11] === 0x50 // 'P'
  ) {
    // VP8 lossy: signature at 12..15 = "VP8 "
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
      // Skip 3 bytes of frame tag (bits 0..2 = frame type, etc.), then 3 bytes of start code.
      // Width at byte 26 (16-bit LE, lower 14 bits), height at byte 28.
      if (buf.length >= 30) {
        return {
          width: buf.readUInt16LE(26) & 0x3fff,
          height: buf.readUInt16LE(28) & 0x3fff,
        }
      }
    }
    // VP8L lossless: signature at 12..15 = "VP8L"
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x4c) {
      if (buf.length >= 25) {
        const bits = buf.readUInt32LE(21)
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1,
        }
      }
    }
  }
  return null
}

/** Check if a WebP buffer is animated (contains "ANIM" chunk). */
function isAnimatedWebp(buf: Buffer): boolean {
  // Extended format: bytes 12..15 = "VP8X", flags byte at 20.
  if (buf.length >= 21 && buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58) {
    return (buf[20]! & 0x02) !== 0 // animation flag
  }
  return false
}

// Normalize MIME: treat image/jpg as image/jpeg.
function normalizeMime(mime: string): string {
  const base = (mime.split(';', 1)[0] ?? '').trim().toLowerCase()
  return base === 'image/jpg' ? 'image/jpeg' : base
}

// ── jimp helpers (lazy-loaded) ───────────────────────────────────────

type JimpImage = Awaited<ReturnType<(typeof import('jimp'))['Jimp']['fromBuffer']>>

/** Scale `image` so its longest edge is at most `edge`. Returns true when
 *  a resize actually happened; no-op when the image already fits. */
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

interface EncodedImage {
  data: Buffer
  mimeType: string
  width: number
  height: number
}

/** Encode `image` under the byte budget via format/quality/size ladders. */
async function encodeWithinBudget(
  image: JimpImage,
  opts: { preferLossless: boolean; byteBudget: number },
): Promise<EncodedImage> {
  const { preferLossless, byteBudget } = opts
  let smallest: EncodedImage | null = null

  const consider = (data: Buffer, mimeType: string): EncodedImage => {
    const candidate: EncodedImage = { data, mimeType, width: image.width, height: image.height }
    if (smallest === null || candidate.data.length < smallest.data.length) smallest = candidate
    return candidate
  }

  const jpegLadder = async (): Promise<EncodedImage | null> => {
    for (const quality of JPEG_QUALITY_STEPS) {
      const jpeg = await image.getBuffer('image/jpeg', { quality })
      if (jpeg.length <= byteBudget) return consider(jpeg, 'image/jpeg')
      consider(jpeg, 'image/jpeg')
    }
    return null
  }

  if (preferLossless) {
    // PNG first: best for screenshots (sharp text, alpha).
    const png = await image.getBuffer('image/png', { deflateLevel: 9 })
    if (png.length <= byteBudget) return consider(png, 'image/png')
    consider(png, 'image/png')

    // Smaller PNGs down to the floor before going lossy.
    for (const edge of FALLBACK_EDGES) {
      if (edge < PNG_RESCALE_FLOOR) break
      if (!fitWithinEdge(image, edge)) continue
      const smallerPng = await image.getBuffer('image/png', { deflateLevel: 9 })
      if (smallerPng.length <= byteBudget) return consider(smallerPng, 'image/png')
      consider(smallerPng, 'image/png')
    }

    // Lossy JPEG ladder at the floored size, then at each sub-floor edge.
    const atFloor = await jpegLadder()
    if (atFloor !== null) return atFloor
    for (const edge of FALLBACK_EDGES) {
      if (edge >= PNG_RESCALE_FLOOR) continue
      if (!fitWithinEdge(image, edge)) continue
      const atEdge = await jpegLadder()
      if (atEdge !== null) return atEdge
    }
    return smallest!
  }

  // JPEG source: quality ladder at the fitted size, then the full ladder
  // again at each fallback edge.
  const atFitted = await jpegLadder()
  if (atFitted !== null) return atFitted
  for (const edge of FALLBACK_EDGES) {
    if (!fitWithinEdge(image, edge)) continue
    const atEdge = await jpegLadder()
    if (atEdge !== null) return atEdge
  }
  return smallest!
}

// ── public API ───────────────────────────────────────────────────────

/**
 * Downsample/re-encode `bytes` to fit the pixel + byte budget.
 *
 * Never throws: on any failure (unsupported format, decode error, a result
 * that would be larger than the input) the original bytes are returned with
 * `changed: false`.
 */
export async function compressImage(
  bytes: Buffer,
  mimeType: string,
  options: CompressOptions = {},
): Promise<CompressResult> {
  const maxEdge = options.maxEdge ?? MAX_EDGE_PX
  const byteBudget = options.byteBudget ?? ATTACH_BYTE_BUDGET
  const normalizedMime = normalizeMime(mimeType)
  const dims = sniffDimensions(bytes)

  const passthrough = (): CompressResult => ({
    data: bytes,
    mimeType,
    width: dims?.width ?? 0,
    height: dims?.height ?? 0,
    originalWidth: dims?.width ?? 0,
    originalHeight: dims?.height ?? 0,
    changed: false,
  })

  // Empty or unrecognizable format → pass through.
  if (bytes.length === 0 || !RECODABLE.has(normalizedMime)) return passthrough()

  // Animated WebP → pass through (would flatten to one frame).
  if (normalizedMime === 'image/webp' && isAnimatedWebp(bytes)) return passthrough()

  // GIF is excluded from RECODABLE entirely (animation).

  // Fast path: both byte size and pixel dimensions are within budget.
  const longestEdge = dims ? Math.max(dims.width, dims.height) : 0
  const withinBytes = bytes.length <= byteBudget
  const withinEdge = longestEdge > 0 && longestEdge <= maxEdge
  if (withinBytes && (withinEdge || longestEdge === 0)) return passthrough()

  // Decompression-bomb guard.
  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) return passthrough()

  try {
    const { Jimp } = await import('jimp')
    const image = await Jimp.fromBuffer(bytes)

    const decodedWidth = image.width
    const decodedHeight = image.height

    const preferLossless = normalizedMime !== 'image/jpeg'

    // Scale so the longest edge fits maxEdge (never enlarges).
    fitWithinEdge(image, maxEdge)

    const encoded = await encodeWithinBudget(image, { preferLossless, byteBudget })

    // Keep the result only when it actually helps (fewer bytes or fewer pixels).
    const originalPixels = decodedWidth * decodedHeight
    const finalPixels = encoded.width * encoded.height
    if (encoded.data.length >= bytes.length && finalPixels >= originalPixels) return passthrough()

    return {
      data: encoded.data,
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      originalWidth: decodedWidth,
      originalHeight: decodedHeight,
      changed: true,
    }
  } catch {
    // Decode/encode failure — keep the original bytes.
    return passthrough()
  }
}

/** Format bytes as a human-readable string: `640 B`, `128 KB`, `3.8 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Build a caption telling the model that an image was compressed. */
export function buildCompressionCaption(result: CompressResult): string {
  const orig =
    result.originalWidth > 0
      ? `${result.originalWidth}x${result.originalHeight} (${formatBytes(result.data.length)} from original)`
      : `${formatBytes(result.data.length)}`
  const now = result.width > 0 ? `${result.width}x${result.height} ${result.mimeType}` : `${result.mimeType}`
  return `[Image compressed to fit model limits: ${orig} → ${now}. Fine detail may be lost.]`
}
