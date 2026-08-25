import { parentPort, workerData } from 'node:worker_threads'

import { errorMessage, truncateUtf8 } from '../utils.js'
import { MAX_INGEST_BYTES } from './file-ingest-limits.js'
import { MAX_SPREADSHEET_CELLS, MAX_SPREADSHEET_ROWS, MAX_SPREADSHEET_SHEETS } from './office-xlsx-protocol.js'
import type { OfficeXlsxWorkerInput, OfficeXlsxWorkerOutput, ParsedXlsxSheet } from './office-xlsx-protocol.js'
import { validateXlsxArchive } from './office-xlsx-validate.js'

if (!parentPort) throw new Error('Spreadsheet worker requires a parent port')

const port = parentPort
const input = workerData as OfficeXlsxWorkerInput
const MAX_WORKER_ERROR_BYTES = 4 * 1024
const TRUNCATION_NOTICE = '[Spreadsheet extraction truncated at configured sheet, row, cell, or byte limit.]'

function cellText(value: unknown): string {
  return value instanceof Date ? value.toISOString() : value == null ? '' : String(value)
}

function csvByteLength(text: string): number {
  let quotes = 0
  let needsQuotes = false
  for (let index = 0; index < text.length; index++) {
    const char = text.charCodeAt(index)
    if (char === 0x22) {
      quotes++
      needsQuotes = true
    } else if (char === 0x2c || char === 0x0a || char === 0x0d) {
      needsQuotes = true
    }
  }
  return Buffer.byteLength(text, 'utf8') + (needsQuotes ? quotes + 2 : 0)
}

function csvCell(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function formatSheets(sheets: ParsedXlsxSheet[]): string {
  const chunks: Array<{ bytes: number; text: string }> = []
  let outputBytes = 0
  let rowCount = 0
  let cellCount = 0
  let truncated = false

  const append = (text: string, bytes: number): boolean => {
    if (outputBytes + bytes > MAX_INGEST_BYTES) return false
    chunks.push({ bytes, text })
    outputBytes += bytes
    return true
  }

  for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {
    if (sheetIndex >= MAX_SPREADSHEET_SHEETS) {
      truncated = true
      break
    }
    const sheet = sheets[sheetIndex]!
    const separator = chunks.length === 0 ? '' : '\n\n'
    const headerPrefix = '--- Sheet: '
    const headerSuffix = ' ---'
    const headerBytes =
      Buffer.byteLength(separator + headerPrefix + headerSuffix, 'utf8') + Buffer.byteLength(sheet.sheet, 'utf8')
    if (outputBytes + headerBytes > MAX_INGEST_BYTES) {
      truncated = true
      break
    }
    append(`${separator}${headerPrefix}${sheet.sheet}${headerSuffix}`, headerBytes)

    for (const row of sheet.data) {
      rowCount++
      cellCount += row.length
      if (rowCount > MAX_SPREADSHEET_ROWS || cellCount > MAX_SPREADSHEET_CELLS) {
        truncated = true
        break
      }

      const texts: string[] = []
      let lineBytes = 1
      for (let index = 0; index < row.length; index++) {
        const text = cellText(row[index])
        lineBytes += csvByteLength(text) + (index === 0 ? 0 : 1)
        if (outputBytes + lineBytes > MAX_INGEST_BYTES) break
        texts.push(text)
      }
      if (texts.length !== row.length || !append(`\n${texts.map(csvCell).join(',')}`, lineBytes)) {
        truncated = true
        break
      }
    }
    if (truncated) break
  }

  if (truncated) {
    const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, 'utf8')
    while (chunks.length > 0 && outputBytes + noticeBytes + 2 > MAX_INGEST_BYTES) {
      outputBytes -= chunks.pop()!.bytes
    }
    const separator = chunks.length === 0 ? '' : '\n\n'
    append(separator + TRUNCATION_NOTICE, Buffer.byteLength(separator, 'utf8') + noticeBytes)
  }
  return chunks.map((chunk) => chunk.text).join('')
}

try {
  const archive = new Uint8Array(input.archive)
  validateXlsxArchive(archive)
  const { default: readExcelFile } = await import('read-excel-file/node')
  const sheets: ParsedXlsxSheet[] = await readExcelFile(Buffer.from(archive))
  const output: OfficeXlsxWorkerOutput = { ok: true, text: formatSheets(sheets) }
  port.postMessage(output)
} catch (error) {
  const output: OfficeXlsxWorkerOutput = {
    ok: false,
    error: truncateUtf8(errorMessage(error), MAX_WORKER_ERROR_BYTES),
  }
  port.postMessage(output)
} finally {
  port.close()
}
