import path from 'node:path'

/** Map a file extension to an IANA media type. Used for ImagePart mediaType
 *  hints; returning `image/png` for unknown extensions is safe — the SDK
 *  mostly treats mediaType as advisory. */
export function mediaTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/png'
}
