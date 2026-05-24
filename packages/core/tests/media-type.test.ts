import { describe, expect, it } from 'vitest'

import { mediaTypeFor } from '../src/utils/media-type.js'

describe('mediaTypeFor', () => {
  it('maps .jpg to image/jpeg', () => {
    expect(mediaTypeFor('photo.jpg')).toBe('image/jpeg')
  })

  it('maps .jpeg to image/jpeg', () => {
    expect(mediaTypeFor('photo.jpeg')).toBe('image/jpeg')
  })

  it('maps .png to image/png', () => {
    expect(mediaTypeFor('screenshot.png')).toBe('image/png')
  })

  it('maps .webp to image/webp', () => {
    expect(mediaTypeFor('hero.webp')).toBe('image/webp')
  })

  it('maps .gif to image/gif', () => {
    expect(mediaTypeFor('animation.gif')).toBe('image/gif')
  })

  it('maps .bmp to image/bmp', () => {
    expect(mediaTypeFor('bitmap.bmp')).toBe('image/bmp')
  })

  it('defaults to image/png for unknown extensions', () => {
    expect(mediaTypeFor('file.tiff')).toBe('image/png')
    expect(mediaTypeFor('file.svg')).toBe('image/png')
    expect(mediaTypeFor('noext')).toBe('image/png')
  })

  it('handles case-insensitive extensions', () => {
    expect(mediaTypeFor('photo.JPG')).toBe('image/jpeg')
    expect(mediaTypeFor('photo.PNG')).toBe('image/png')
    expect(mediaTypeFor('photo.WebP')).toBe('image/webp')
  })
})
