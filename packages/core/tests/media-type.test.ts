import { describe, expect, it } from 'vitest'

import { knownMediaTypeFor } from '../src/utils/media-type.js'

describe('knownMediaTypeFor', () => {
  it('maps .jpg to image/jpeg', () => {
    expect(knownMediaTypeFor('photo.jpg')).toBe('image/jpeg')
  })

  it('maps .jpeg to image/jpeg', () => {
    expect(knownMediaTypeFor('photo.jpeg')).toBe('image/jpeg')
  })

  it('maps .png to image/png', () => {
    expect(knownMediaTypeFor('screenshot.png')).toBe('image/png')
  })

  it('maps .webp to image/webp', () => {
    expect(knownMediaTypeFor('hero.webp')).toBe('image/webp')
  })

  it('maps .gif to image/gif', () => {
    expect(knownMediaTypeFor('animation.gif')).toBe('image/gif')
  })

  it('maps .bmp to image/bmp', () => {
    expect(knownMediaTypeFor('bitmap.bmp')).toBe('image/bmp')
  })

  it('maps TIFF explicitly and safely rejects unknown extensions', () => {
    expect(knownMediaTypeFor('file.tiff')).toBe('image/tiff')
    expect(knownMediaTypeFor('file.svg')).toBeNull()
    expect(knownMediaTypeFor('noext')).toBeNull()
  })

  it('handles case-insensitive extensions', () => {
    expect(knownMediaTypeFor('photo.JPG')).toBe('image/jpeg')
    expect(knownMediaTypeFor('photo.PNG')).toBe('image/png')
    expect(knownMediaTypeFor('photo.WebP')).toBe('image/webp')
  })
})
