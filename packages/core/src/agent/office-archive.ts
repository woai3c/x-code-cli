export type OfficeKind = 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp'

export const MAX_OFFICE_SOURCE_BYTES = 20 * 1024 * 1024
export const MAX_OFFICE_ARCHIVE_ENTRIES = 1_000
export const MAX_OFFICE_UNCOMPRESSED_BYTES = 32 * 1024 * 1024

const OFFICE_MIME_BY_KIND: Readonly<Record<OfficeKind, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
}

const ODF_KIND_BY_MIME = new Map<string, OfficeKind>([
  ['application/vnd.oasis.opendocument.text', 'odt'],
  ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
  ['application/vnd.oasis.opendocument.presentation', 'odp'],
])

export function officeMediaType(kind: OfficeKind): string {
  return OFFICE_MIME_BY_KIND[kind]
}

function archiveLimitError(message: string): Error {
  return new Error(message)
}

export async function detectOfficeKindFromArchive(
  archive: Buffer,
  abortSignal?: AbortSignal,
): Promise<OfficeKind | null> {
  const { strFromU8, unzip } = await import('fflate')
  let entryCount = 0
  let uncompressedBytes = 0
  const detectedKinds = new Set<OfficeKind>()
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    let settled = false
    let terminate = (): void => {}
    const finish = (error?: Error | null, result?: Record<string, Uint8Array>): void => {
      if (settled) return
      settled = true
      abortSignal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result ?? {})
    }
    const onAbort = (): void => {
      terminate()
      finish(abortSignal?.reason instanceof Error ? abortSignal.reason : new Error('Office validation aborted'))
    }
    terminate = unzip(
      archive,
      {
        filter: (entry) => {
          entryCount++
          if (entryCount > MAX_OFFICE_ARCHIVE_ENTRIES) {
            throw archiveLimitError('Office archive exceeds the safe entry-count limit')
          }
          if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) {
            throw archiveLimitError('Office archive contains an invalid entry size')
          }
          uncompressedBytes += entry.originalSize
          if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > MAX_OFFICE_UNCOMPRESSED_BYTES) {
            throw archiveLimitError('Office archive exceeds the safe decompression limit')
          }
          const name = entry.name.replace(/^\/+/, '').toLowerCase()
          if (name === 'word/document.xml') detectedKinds.add('docx')
          else if (name === 'xl/workbook.xml') detectedKinds.add('xlsx')
          else if (name === 'ppt/presentation.xml' || /^ppt\/slides\/slide\d+\.xml$/.test(name)) {
            detectedKinds.add('pptx')
          }
          return name === 'mimetype'
        },
      },
      (error, result) => finish(error, result),
    )
    if (!settled) {
      abortSignal?.addEventListener('abort', onAbort, { once: true })
      if (abortSignal?.aborted) onAbort()
    }
  })

  const mimetypeEntry = Object.entries(files).find(([name]) => name.replace(/^\/+/, '').toLowerCase() === 'mimetype')
  if (mimetypeEntry) {
    const odfKind = ODF_KIND_BY_MIME.get(strFromU8(mimetypeEntry[1]).trim().toLowerCase())
    if (odfKind) detectedKinds.add(odfKind)
  }
  if (detectedKinds.size > 1) throw new Error('Office archive contains conflicting document structures')
  return detectedKinds.values().next().value ?? null
}
