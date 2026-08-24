import fs from 'node:fs/promises'
import path from 'node:path'

/** Compatibility type retained for the public classifyFile() API. */
export type FileKind = 'text' | 'image' | 'pdf' | 'office' | 'audio' | 'unknown'
export type InspectedFileKind = 'text' | 'image' | 'pdf' | 'office' | 'audio' | 'notebook' | 'binary'
export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be'

export interface FileClassification {
  kind: InspectedFileKind
  mediaType: string | null
  textEncoding: TextEncoding | null
}

const FILE_TEXT_SAMPLE_BYTES = 32 * 1024

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.mdx',
  '.rst',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.env',
  '.cfg',
  '.conf',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.hpp',
  '.cs',
  '.php',
  '.pl',
  '.lua',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.sql',
  '.graphql',
  '.gql',
  '.proto',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.vue',
  '.svelte',
  '.xml',
  '.svg',
  '.dockerfile',
  '.makefile',
  '.gitignore',
  '.editorconfig',
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'])
const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.ogg',
  '.flac',
  '.aac',
  '.aiff',
  '.aif',
  '.wma',
  '.webm',
  '.opus',
])
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'])
const BINARY_EXTENSIONS = new Set([
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.zst',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.wasm',
  '.class',
  '.jar',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.dmg',
  '.iso',
  '.img',
  '.apk',
])

function textEncodingOf(sample: Buffer, truncated: boolean): TextEncoding | null {
  let encoding: TextEncoding = 'utf-8'
  let body = sample
  if (sample[0] === 0xff && sample[1] === 0xfe) {
    encoding = 'utf-16le'
    body = sample.subarray(2)
  } else if (sample[0] === 0xfe && sample[1] === 0xff) {
    encoding = 'utf-16be'
    body = sample.subarray(2)
  } else if (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    body = sample.subarray(3)
  }
  if (encoding === 'utf-8' && body.includes(0)) {
    return null
  }

  let decoded: string
  try {
    decoded = new TextDecoder(encoding, { fatal: true }).decode(body, { stream: truncated })
  } catch {
    return null
  }
  if (decoded.length === 0) return encoding

  let controls = 0
  for (const char of decoded) {
    const code = char.codePointAt(0) ?? 0
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d) || code === 0x7f) {
      controls++
    }
  }
  return controls / decoded.length <= 0.1 ? encoding : null
}

function hasTextBom(sample: Buffer): boolean {
  return (
    (sample[0] === 0xff && sample[1] === 0xfe) ||
    (sample[0] === 0xfe && sample[1] === 0xff) ||
    (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf)
  )
}

function withoutTextBom(sample: Buffer): Buffer {
  if (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) return sample.subarray(3)
  if ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff)) {
    return sample.subarray(2)
  }
  return sample
}

async function readSample(filePath: string): Promise<{ data: Buffer; truncated: boolean }> {
  const handle = await fs.open(filePath, 'r')
  try {
    // Read enough look-ahead to validate a UTF-8 code point or UTF-16
    // surrogate pair that starts at the nominal 32 KiB boundary. The extra
    // byte distinguishes a full sample from an exact-length file.
    const buffer = Buffer.allocUnsafe(FILE_TEXT_SAMPLE_BYTES + 5)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const length = Math.min(bytesRead, FILE_TEXT_SAMPLE_BYTES + 4)
    return { data: buffer.subarray(0, length), truncated: bytesRead > length }
  } finally {
    await handle.close()
  }
}

function isOfficeMime(mime: string): boolean {
  return mime.includes('officedocument') || mime.includes('opendocument')
}

export async function inspectFile(filePath: string): Promise<FileClassification> {
  const ext = path.extname(filePath).toLowerCase()
  const { data: sample, truncated } = await readSample(filePath)
  let detected: { mime: string } | undefined
  try {
    const { fileTypeFromBuffer } = await import('file-type')
    // A text BOM is an encoding marker, not part of a binary signature.
    // Inspect the bytes after it so UTF-16LE is not mistaken for AAC while
    // BOM-prefixed PNG/PDF/etc. still override a misleading text extension.
    detected = await fileTypeFromBuffer(withoutTextBom(sample))
  } catch {
    detected = undefined
  }

  const mime = detected?.mime ?? null
  if (mime?.startsWith('image/')) return { kind: 'image', mediaType: mime, textEncoding: null }
  if (mime?.startsWith('audio/') || (ext === '.webm' && mime?.startsWith('video/'))) {
    return { kind: 'audio', mediaType: mime, textEncoding: null }
  }
  if (mime === 'application/pdf' || sample.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    return { kind: 'pdf', mediaType: 'application/pdf', textEncoding: null }
  }
  if (mime && isOfficeMime(mime)) return { kind: 'office', mediaType: mime, textEncoding: null }
  if (OFFICE_EXTENSIONS.has(ext) && sample[0] === 0x50 && sample[1] === 0x4b) {
    return { kind: 'office', mediaType: mime ?? 'application/zip', textEncoding: null }
  }
  if (mime && !mime.startsWith('text/')) return { kind: 'binary', mediaType: mime, textEncoding: null }

  const textEncoding = textEncodingOf(sample, truncated)
  if (ext === '.pdf' || IMAGE_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext) || OFFICE_EXTENSIONS.has(ext)) {
    return { kind: 'binary', mediaType: mime, textEncoding: null }
  }
  if (BINARY_EXTENSIONS.has(ext) || textEncoding === null) {
    return { kind: 'binary', mediaType: mime, textEncoding: null }
  }
  return {
    kind: ext === '.ipynb' ? 'notebook' : 'text',
    mediaType: mime ?? (hasTextBom(sample) || TEXT_EXTENSIONS.has(ext) ? 'text/plain' : null),
    textEncoding,
  }
}

export async function classifyFile(filePath: string): Promise<FileKind> {
  const ext = path.extname(filePath).toLowerCase()
  if (TEXT_EXTENSIONS.has(ext) || ext === '.ipynb') return 'text'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (OFFICE_EXTENSIONS.has(ext)) return 'office'
  if (ext === '.pdf') return 'pdf'

  try {
    const { fileTypeFromFile } = await import('file-type')
    const detected = await fileTypeFromFile(filePath)
    if (!detected || detected.mime.startsWith('text/')) return 'text'
    if (detected.mime.startsWith('image/')) return 'image'
    if (detected.mime.startsWith('audio/')) return 'audio'
    if (detected.mime === 'application/pdf') return 'pdf'
    if (isOfficeMime(detected.mime)) return 'office'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export function decodeTextBuffer(buffer: Buffer, encoding: TextEncoding): string {
  const offset =
    encoding === 'utf-8' && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? 3
      : encoding !== 'utf-8' &&
          ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))
        ? 2
        : 0
  return new TextDecoder(encoding).decode(buffer.subarray(offset))
}
