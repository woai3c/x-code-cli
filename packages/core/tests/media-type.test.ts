import { describe, expect, it } from 'vitest'

import { knownMediaTypeFor } from '../src/utils/media-type.js'

describe('knownMediaTypeFor', () => {
  it('resolves supported raster image extensions case-insensitively', () => {
    expect(knownMediaTypeFor('photo.jpg')).toBe('image/jpeg')
    expect(knownMediaTypeFor('photo.JPEG')).toBe('image/jpeg')
    expect(knownMediaTypeFor('screenshot.PNG')).toBe('image/png')
    expect(knownMediaTypeFor('hero.WebP')).toBe('image/webp')
    expect(knownMediaTypeFor('animation.gif')).toBe('image/gif')
    expect(knownMediaTypeFor('bitmap.bmp')).toBe('image/bmp')
    expect(knownMediaTypeFor('scan.tiff')).toBe('image/tiff')
  })

  it('rejects SVG and unknown or missing extensions', () => {
    expect(knownMediaTypeFor('vector.svg')).toBeNull()
    expect(knownMediaTypeFor('archive.zip')).toBeNull()
    expect(knownMediaTypeFor('noext')).toBeNull()
  })
})
