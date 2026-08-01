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

// ── tests ────────────────────────────────────────────────────────────

describe('compressImage', () => {
  describe('fast path (no codec)', () => {
    it('passes through a small PNG unchanged', async () => {
      const buf = await makePng(100, 100)
      const result = await compressImage(buf, 'image/png')
      expect(result.changed).toBe(false)
      expect(result.data).toBe(buf) // reference equality — zero-copy
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

    it('passes through unsupported mime type unchanged', async () => {
      const buf = await makePng(100, 100)
      const result = await compressImage(buf, 'image/bmp')
      expect(result.changed).toBe(false)
    })

    it('passes through GIF unchanged (animation preservation)', async () => {
      const buf = await makePng(100, 100)
      const result = await compressImage(buf, 'image/gif')
      expect(result.changed).toBe(false)
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
