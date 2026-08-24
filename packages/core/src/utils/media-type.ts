import path from 'node:path'

/** Map a known file extension to an IANA media type without guessing. */
export function knownMediaTypeFor(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff'
  // Audio
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.m4a') return 'audio/mp4'
  if (ext === '.ogg' || ext === '.opus') return 'audio/ogg'
  if (ext === '.flac') return 'audio/flac'
  if (ext === '.aac') return 'audio/aac'
  if (ext === '.aiff' || ext === '.aif') return 'audio/aiff'
  if (ext === '.wma') return 'audio/x-ms-wma'
  if (ext === '.webm') return 'audio/webm'
  return null
}

/**
 * @deprecated Use knownMediaTypeFor() and handle null. This compatibility
 * fallback remains for one release cycle; ingestion code must not use it.
 */
export function mediaTypeFor(filePath: string): string {
  return knownMediaTypeFor(filePath) ?? 'image/png'
}
