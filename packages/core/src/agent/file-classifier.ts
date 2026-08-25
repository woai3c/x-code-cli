import fs from 'node:fs/promises'
import path from 'node:path'

import { readFileHandleWithinLimit } from '../utils/bounded-read.js'
import { KNOWN_AUDIO_EXTENSIONS, SUPPORTED_AUDIO_EXTENSIONS, isSupportedAudioBytes } from './audio-formats.js'
import { MAX_OFFICE_SOURCE_BYTES, detectOfficeKindFromArchive, officeMediaType } from './office-archive.js'

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

  for (const char of decoded) {
    const code = char.codePointAt(0) ?? 0
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d) || code === 0x7f) {
      return null
    }
  }
  return encoding
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

async function readSample(filePath: string, abortSignal?: AbortSignal): Promise<{ data: Buffer; truncated: boolean }> {
  abortSignal?.throwIfAborted()
  const handle = await fs.open(filePath, 'r')
  try {
    // Read enough look-ahead to validate a UTF-8 code point or UTF-16
    // surrogate pair that starts at the nominal 32 KiB boundary. The extra
    // byte distinguishes a full sample from an exact-length file.
    const buffer = Buffer.allocUnsafe(FILE_TEXT_SAMPLE_BYTES + 5)
    abortSignal?.throwIfAborted()
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    abortSignal?.throwIfAborted()
    const length = Math.min(bytesRead, FILE_TEXT_SAMPLE_BYTES + 4)
    return { data: buffer.subarray(0, length), truncated: bytesRead > length }
  } finally {
    await handle.close()
  }
}

function isOfficeMime(mime: string): boolean {
  return mime.includes('officedocument') || mime.includes('opendocument')
}

async function inspectBytes(
  filePath: string,
  sample: Buffer,
  truncated: boolean,
  fullBuffer?: Buffer,
  abortSignal?: AbortSignal,
): Promise<FileClassification> {
  abortSignal?.throwIfAborted()
  const ext = path.extname(filePath).toLowerCase()
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
  abortSignal?.throwIfAborted()

  const mime = detected?.mime ?? null
  if (mime?.startsWith('image/')) return { kind: 'image', mediaType: mime, textEncoding: null }
  if (mime && isSupportedAudioBytes(mime, sample)) {
    return { kind: 'audio', mediaType: mime, textEncoding: null }
  }
  if (mime?.startsWith('audio/') || mime?.startsWith('video/')) {
    return { kind: 'binary', mediaType: mime, textEncoding: null }
  }
  if (mime === 'application/pdf' || sample.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    return { kind: 'pdf', mediaType: 'application/pdf', textEncoding: null }
  }
  if (mime && isOfficeMime(mime)) return { kind: 'office', mediaType: mime, textEncoding: null }
  if (mime === 'application/zip' && fullBuffer) {
    const officeKind = await detectOfficeKindFromArchive(fullBuffer, abortSignal)
    if (officeKind) return { kind: 'office', mediaType: officeMediaType(officeKind), textEncoding: null }
  }
  if (OFFICE_EXTENSIONS.has(ext) && sample[0] === 0x50 && sample[1] === 0x4b) {
    return { kind: 'office', mediaType: mime ?? 'application/zip', textEncoding: null }
  }
  if (mime && !mime.startsWith('text/')) return { kind: 'binary', mediaType: mime, textEncoding: null }

  const textEncoding = textEncodingOf(sample, truncated)
  if (ext === '.pdf' || IMAGE_EXTENSIONS.has(ext) || KNOWN_AUDIO_EXTENSIONS.has(ext) || OFFICE_EXTENSIONS.has(ext)) {
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

export async function inspectFileBuffer(
  filePath: string,
  buffer: Buffer,
  abortSignal?: AbortSignal,
): Promise<FileClassification> {
  return inspectBytes(filePath, buffer, false, buffer, abortSignal)
}

export async function inspectFile(filePath: string, abortSignal?: AbortSignal): Promise<FileClassification> {
  const { data: sample, truncated } = await readSample(filePath, abortSignal)
  const initial = await inspectBytes(filePath, sample, truncated, undefined, abortSignal)
  if (initial.kind !== 'binary' || initial.mediaType !== 'application/zip') return initial

  abortSignal?.throwIfAborted()
  const handle = await fs.open(filePath, 'r')
  try {
    const archive = await readFileHandleWithinLimit(handle, filePath, MAX_OFFICE_SOURCE_BYTES, abortSignal)
    return await inspectBytes(filePath, archive, false, archive, abortSignal)
  } catch {
    abortSignal?.throwIfAborted()
    return initial
  } finally {
    await handle.close()
  }
}

export async function classifyFile(filePath: string, abortSignal?: AbortSignal): Promise<FileKind> {
  abortSignal?.throwIfAborted()
  const ext = path.extname(filePath).toLowerCase()
  if (TEXT_EXTENSIONS.has(ext) || ext === '.ipynb') return 'text'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (SUPPORTED_AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (KNOWN_AUDIO_EXTENSIONS.has(ext)) return 'unknown'
  if (OFFICE_EXTENSIONS.has(ext)) return 'office'
  if (ext === '.pdf') return 'pdf'

  try {
    const inspected = await inspectFile(filePath, abortSignal)
    if (inspected.kind === 'text' || inspected.kind === 'notebook') return 'text'
    if (inspected.kind === 'binary') return 'unknown'
    return inspected.kind
  } catch {
    abortSignal?.throwIfAborted()
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
  const decoded = new TextDecoder(encoding, { fatal: true }).decode(buffer.subarray(offset))
  assertSafeTextContent(decoded)
  return decoded
}

export function assertSafeTextContent(content: string): void {
  for (const char of content) {
    const code = char.codePointAt(0) ?? 0
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d) || code === 0x7f) {
      throw new Error('File content contains binary control characters')
    }
  }
}
