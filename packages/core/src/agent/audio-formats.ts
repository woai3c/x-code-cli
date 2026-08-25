import path from 'node:path'

export const SUPPORTED_AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(['.mp3', '.wav', '.flac', '.ogg'])

export const KNOWN_AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  ...SUPPORTED_AUDIO_EXTENSIONS,
  '.m4a',
  '.aac',
  '.aiff',
  '.aif',
  '.wma',
  '.webm',
  '.opus',
])

export function isSupportedAudioPath(filePath: string): boolean {
  return SUPPORTED_AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

export function isSupportedAudioBytes(mime: string, sample: Buffer): boolean {
  const normalized = mime.toLowerCase()
  if (
    normalized === 'audio/mpeg' ||
    normalized === 'audio/mp3' ||
    normalized === 'audio/wav' ||
    normalized === 'audio/x-wav' ||
    normalized === 'audio/flac' ||
    normalized === 'audio/x-flac'
  ) {
    return true
  }
  if (normalized !== 'audio/ogg' && normalized !== 'application/ogg') return false
  return sample.includes(Buffer.from([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]))
}
