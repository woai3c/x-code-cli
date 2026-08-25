import { describe, expect, it } from 'vitest'

import {
  ATTACH_BYTE_BUDGET,
  MAX_EDGE_PX,
  buildCompressionCaption,
  compressImage,
  formatBytes,
} from '../src/utils/image-compress.js'

// ── helpers ──────────────────────────────────────────────────────────

/** Generate a solid-color PNG of the given dimensions using Jimp. */
async function makePng(width: number, height: number, color = 0xff0000ff): Promise<Buffer> {
  const { Jimp } = await import('jimp')
  const img = new Jimp({ width, height, color })
  return img.getBuffer('image/png')
}

/** Generate a solid-color JPEG of the given dimensions. */
async function makeJpeg(width: number, height: number, color = 0xff0000ff): Promise<Buffer> {
  const { Jimp } = await import('jimp')
  const img = new Jimp({ width, height, color })
  return img.getBuffer('image/jpeg', { quality: 95 })
}

async function makeImage(width: number, height: number, mimeType: 'image/bmp' | 'image/tiff' | 'image/gif') {
  const { Jimp } = await import('jimp')
  const image = new Jimp({ width, height, color: 0xff0000ff })
  return image.getBuffer(mimeType)
}

// ── tests ────────────────────────────────────────────────────────────

describe('compressImage', () => {
  describe('validated pass-through', () => {
    it('passes through a small PNG unchanged', async () => {
      const buf = await makePng(100, 100)
      const result = await compressImage(buf, 'image/png')
      expect(result.changed).toBe(false)
      expect(result.data).toEqual(buf)
    })

    it('passes through a small JPEG unchanged', async () => {
      const buf = await makeJpeg(200, 150)
      const result = await compressImage(buf, 'image/jpeg')
      expect(result.changed).toBe(false)
    })

    it('passes through empty buffer unchanged', async () => {
      const buf = Buffer.alloc(0)
      const result = await compressImage(buf, 'image/png')
      expect(result.changed).toBe(false)
    })

    it('normalizes a BMP to a provider-safe format', async () => {
      const buf = await makeImage(100, 100, 'image/bmp')
      const result = await compressImage(buf, 'image/bmp')
      expect(result.changed).toBe(true)
      expect(result.mimeType).toBe('image/png')
      expect(result.failureReason).toBeUndefined()
    })

    it('does not pass parent-only Node flags to the image worker', async () => {
      const buf = await makeImage(2, 2, 'image/bmp')
      process.execArgv.push('--input-type=module')
      try {
        await expect(compressImage(buf, 'image/bmp')).resolves.toMatchObject({ changed: true, mimeType: 'image/png' })
      } finally {
        process.execArgv.splice(process.execArgv.lastIndexOf('--input-type=module'), 1)
      }
    })

    it('passes through a valid in-budget GIF unchanged', async () => {
      const buf = await makeImage(100, 100, 'image/gif')
      const result = await compressImage(buf, 'image/gif')
      expect(result.changed).toBe(false)
      expect(result.data).toEqual(buf)
    })

    it('decodes and passes through a valid in-budget WebP', async () => {
      const { createCanvas } = await import('@napi-rs/canvas')
      const canvas = createCanvas(2, 2)
      const context = canvas.getContext('2d')
      context.fillStyle = 'red'
      context.fillRect(0, 0, 2, 2)
      const buf = await canvas.encode('webp')

      const result = await compressImage(buf, 'image/webp')

      expect(result).toMatchObject({ changed: false, mimeType: 'image/webp', width: 2, height: 2 })
      expect(result.data).toEqual(buf)
    })

    it('rejects a structurally plausible PNG with no decodable image data', async () => {
      const malformed = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAElFTkSuQmCC', 'base64')
      const result = await compressImage(malformed, 'image/png')

      expect(result.changed).toBe(false)
      expect(['decode-failed', 'worker-failed']).toContain(result.failureReason)
    })
  })

  describe('pixel dimension downscaling', () => {
    it('scales down an image wider than MAX_EDGE_PX', async () => {
      const buf = await makePng(3000, 1000)
      const result = await compressImage(buf, 'image/png')
      expect(result.changed).toBe(true)
      expect(result.width).toBeLessThanOrEqual(MAX_EDGE_PX)
      expect(result.originalWidth).toBe(3000)
      expect(result.originalHeight).toBe(1000)
    })

    it('scales down an image taller than MAX_EDGE_PX', async () => {
      const buf = await makePng(800, 4000)
      const result = await compressImage(buf, 'image/png')
      expect(result.changed).toBe(true)
      expect(result.height).toBeLessThanOrEqual(MAX_EDGE_PX)
    })

    it('respects custom maxEdge option', async () => {
      const buf = await makePng(600, 600)
      const result = await compressImage(buf, 'image/png', { maxEdge: 400 })
      expect(result.changed).toBe(true)
      expect(result.width).toBeLessThanOrEqual(400)
      expect(result.height).toBeLessThanOrEqual(400)
    })
  })

  describe('byte budget enforcement', () => {
    it('compresses a PNG that exceeds the byte budget', async () => {
      const buf = await makePng(2000, 2000)
      const result = await compressImage(buf, 'image/png', { byteBudget: 8192 })
      expect(result.changed).toBe(true)
      expect(result.data.length).toBeLessThanOrEqual(8192)
    })

    it('compresses JPEG to fit a small budget via quality ladder', async () => {
      const buf = await makeJpeg(1000, 1000)
      const result = await compressImage(buf, 'image/jpeg', { byteBudget: 8192 })
      expect(result.changed).toBe(true)
      expect(result.data.length).toBeLessThanOrEqual(8192)
    })
  })

  describe('format handling', () => {
    it('normalizes image/jpg to image/jpeg', async () => {
      const buf = await makeJpeg(100, 100)
      const result = await compressImage(buf, 'image/jpg')
      expect(result.changed).toBe(false)
    })

    it('PNG sources prefer lossless re-encode over JPEG', async () => {
      const buf = await makePng(3000, 3000)
      const result = await compressImage(buf, 'image/png')
      expect(result.changed).toBe(true)
      // A solid-color 2000x2000 PNG compresses very well as PNG.
      // The result should be PNG (not JPEG) when it fits the budget.
      expect(result.mimeType).toBe('image/png')
    })

    it('normalizes TIFF to PNG', async () => {
      const buf = await makeImage(12, 8, 'image/tiff')
      const result = await compressImage(buf, 'image/tiff')
      expect(result).toMatchObject({ changed: true, mimeType: 'image/png' })
      expect(result.data.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    })

    it('refuses to flatten an over-budget animated GIF', async () => {
      const singleFrame = await makeImage(10, 10, 'image/gif')
      const frameStart = singleFrame.indexOf(0x2c)
      const trailer = singleFrame.lastIndexOf(0x3b)
      const animated = Buffer.concat([
        singleFrame.subarray(0, trailer),
        singleFrame.subarray(frameStart, trailer),
        singleFrame.subarray(trailer),
      ])
      const result = await compressImage(animated, 'image/gif', { byteBudget: animated.length - 1 })
      expect(result).toMatchObject({ changed: false, animated: true, failureReason: 'animated-over-budget' })
      expect(result.data).toBe(animated)
    })

    it('reports animation even when a GIF is within the passthrough budget', async () => {
      const singleFrame = await makeImage(10, 10, 'image/gif')
      const frameStart = singleFrame.indexOf(0x2c)
      const trailer = singleFrame.lastIndexOf(0x3b)
      const animated = Buffer.concat([
        singleFrame.subarray(0, trailer),
        singleFrame.subarray(frameStart, trailer),
        singleFrame.subarray(trailer),
      ])

      const result = await compressImage(animated, 'image/gif')

      expect(result).toMatchObject({ changed: false, animated: true })
      expect(result.failureReason).toBeUndefined()
    })

    it('rejects a declared image above the decode pixel limit before decoding', async () => {
      const header = Buffer.alloc(24)
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header)
      header.write('IHDR', 12, 'ascii')
      header.writeUInt32BE(20_000, 16)
      header.writeUInt32BE(20_000, 20)
      const result = await compressImage(header, 'image/png')
      expect(result).toMatchObject({ changed: false, failureReason: 'pixel-limit' })
    })

    it('honors an already-aborted slow-path operation', async () => {
      const buf = await makePng(3000, 1000)
      const controller = new AbortController()
      controller.abort()
      await expect(compressImage(buf, 'image/png', { abortSignal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      })
    })

    it('honors an already-aborted in-budget operation', async () => {
      const buf = await makePng(1, 1)
      const controller = new AbortController()
      controller.abort()
      await expect(compressImage(buf, 'image/png', { abortSignal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      })
    })
  })

  describe('result metadata', () => {
    it('reports original and final dimensions', async () => {
      const buf = await makePng(4000, 2000)
      const result = await compressImage(buf, 'image/png')
      expect(result.originalWidth).toBe(4000)
      expect(result.originalHeight).toBe(2000)
      expect(result.width).toBeLessThanOrEqual(MAX_EDGE_PX)
      expect(result.height).toBeGreaterThan(0)
    })
  })
})

describe('formatBytes', () => {
  it('formats small byte counts', () => {
    expect(formatBytes(512)).toBe('512 B')
  })
  it('formats kilobyte range', () => {
    expect(formatBytes(2048)).toBe('2 KB')
  })
  it('formats megabyte range', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('buildCompressionCaption', () => {
  it('includes original and final descriptions', () => {
    const caption = buildCompressionCaption({
      data: Buffer.alloc(100),
      mimeType: 'image/jpeg',
      width: 1000,
      height: 800,
      originalWidth: 4000,
      originalHeight: 3200,
      changed: true,
    })
    expect(caption).toContain('4000x3200')
    expect(caption).toContain('1000x800')
    expect(caption).toContain('image/jpeg')
    expect(caption).toContain('compressed')
  })
})

describe('constants', () => {
  it('ATTACH_BYTE_BUDGET is 3.75 MB', () => {
    expect(ATTACH_BYTE_BUDGET).toBe(3.75 * 1024 * 1024)
  })
  it('MAX_EDGE_PX is 2000', () => {
    expect(MAX_EDGE_PX).toBe(2000)
  })
})
