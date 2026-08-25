import { unzipSync } from 'fflate'
import { Parser } from 'saxen'

import { MAX_OFFICE_ARCHIVE_ENTRIES, MAX_OFFICE_UNCOMPRESSED_BYTES } from './office-archive.js'
import {
  MAX_SPREADSHEET_CELLS,
  MAX_SPREADSHEET_COLUMNS,
  MAX_SPREADSHEET_ROWS,
  MAX_SPREADSHEET_SHEETS,
} from './office-xlsx-protocol.js'

const WORKBOOK_PATH = 'xl/workbook.xml'
const WORKBOOK_RELATIONSHIPS_PATH = 'xl/_rels/workbook.xml.rels'
const XML_STREAM_CHUNK_BYTES = 64 * 1024
const MAX_WORKBOOK_RELATIONSHIPS = 1_000
const WORKSHEET_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet',
])

interface XmlHandlers {
  onOpen(name: string, attributes: Readonly<Record<string, string>>): void
  onClose?(name: string): void
}

interface WorkbookSheet {
  relationId: string
}

interface WorkbookRelationship {
  target: string
  targetMode: string | null
  type: string
}

interface WorksheetAllocation {
  cells: number
  rows: number
}

function errorFromXmlParser(error: Error | string): Error {
  return error instanceof Error ? error : new Error(error)
}

function localName(name: string): string {
  const separator = name.lastIndexOf(':')
  return separator < 0 ? name : name.slice(separator + 1)
}

function attribute(attributes: Readonly<Record<string, string>>, name: string): string | null {
  const matches = Object.entries(attributes).filter(([key]) => localName(key) === name)
  if (matches.length > 1) throw new Error(`Spreadsheet XML contains duplicate ${name} attributes`)
  return matches[0]?.[1] ?? null
}

function parseXmlStreaming(bytes: Uint8Array, handlers: XmlHandlers): string {
  const parser = new Parser()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let root = ''
  parser.on('error', (error) => {
    throw errorFromXmlParser(error)
  })
  parser.on('warn', (warning) => {
    throw errorFromXmlParser(warning)
  })
  parser.on('attention', () => {
    throw new Error('Spreadsheet XML declarations other than the XML header are not supported')
  })
  parser.on('openTag', (name, getAttributes, decodeEntities) => {
    const parsed = getAttributes()
    if (parsed === false) throw new Error('Spreadsheet XML contains malformed attributes')
    const attributes: Record<string, string> = Object.create(null) as Record<string, string>
    for (const [key, value] of Object.entries(parsed)) attributes[key] = decodeEntities(value)
    const normalizedName = localName(name)
    if (!root) root = normalizedName
    handlers.onOpen(normalizedName, attributes)
  })
  parser.on('closeTag', (name) => handlers.onClose?.(localName(name)))

  for (let offset = 0; offset < bytes.length; offset += XML_STREAM_CHUNK_BYTES) {
    parser.write(decoder.decode(bytes.subarray(offset, offset + XML_STREAM_CHUNK_BYTES), { stream: true }))
  }
  const tail = decoder.decode()
  if (tail) parser.write(tail)
  const parseError = parser.end()
  if (parseError) throw parseError
  return root
}

function requiredAttribute(attributes: Readonly<Record<string, string>>, name: string, element: string): string {
  const value = attribute(attributes, name)
  if (!value) throw new Error(`Spreadsheet ${element} is missing its ${name} attribute`)
  return value
}

function parseWorkbook(bytes: Uint8Array): WorkbookSheet[] {
  const sheets: WorkbookSheet[] = []
  const relationIds = new Set<string>()
  const root = parseXmlStreaming(bytes, {
    onOpen(name, attributes) {
      if (name !== 'sheet') return
      requiredAttribute(attributes, 'name', 'sheet')
      const relationId = requiredAttribute(attributes, 'id', 'sheet')
      if (!relationIds.add(relationId)) throw new Error('Spreadsheet contains duplicate logical sheet relationships')
      sheets.push({ relationId })
      if (sheets.length > MAX_SPREADSHEET_SHEETS) {
        throw new Error('Spreadsheet exceeds the configured logical sheet-count limit')
      }
    },
  })
  if (root !== 'workbook') throw new Error('Spreadsheet workbook XML has an unexpected root element')
  return sheets
}

function parseWorkbookRelationships(bytes: Uint8Array): Map<string, WorkbookRelationship> {
  const relationships = new Map<string, WorkbookRelationship>()
  let relationshipCount = 0
  const root = parseXmlStreaming(bytes, {
    onOpen(name, attributes) {
      if (name !== 'Relationship') return
      if (++relationshipCount > MAX_WORKBOOK_RELATIONSHIPS) {
        throw new Error('Spreadsheet exceeds the configured relationship-count limit')
      }
      const id = requiredAttribute(attributes, 'Id', 'relationship')
      if (relationships.has(id)) throw new Error('Spreadsheet contains duplicate workbook relationship IDs')
      relationships.set(id, {
        target: requiredAttribute(attributes, 'Target', 'relationship'),
        targetMode: attribute(attributes, 'TargetMode'),
        type: requiredAttribute(attributes, 'Type', 'relationship'),
      })
    },
  })
  if (root !== 'Relationships') throw new Error('Spreadsheet relationships XML has an unexpected root element')
  return relationships
}

function worksheetPath(relationship: WorkbookRelationship): string {
  if (relationship.targetMode && relationship.targetMode.toLowerCase() !== 'internal') {
    throw new Error('Spreadsheet worksheet relationship must be internal')
  }
  if (!WORKSHEET_RELATIONSHIP_TYPES.has(relationship.type)) {
    throw new Error('Spreadsheet logical sheet does not reference a worksheet')
  }
  const target = relationship.target
  if (target.includes('\\') || target.includes('\0') || target.includes('?') || target.includes('#')) {
    throw new Error('Spreadsheet worksheet relationship contains an unsafe target')
  }
  const resolved = target.startsWith('/') ? target.slice(1) : `xl/${target}`
  const segments = resolved.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Spreadsheet worksheet relationship contains an unsafe target')
  }
  if (!resolved.toLowerCase().endsWith('.xml')) {
    throw new Error('Spreadsheet worksheet relationship does not target XML')
  }
  return resolved
}

function parsePositiveInteger(value: string, label: string, maximum: number): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`Spreadsheet contains an invalid ${label}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`Spreadsheet ${label} exceeds the configured safety limit`)
  }
  return parsed
}

function parseCellReference(value: string): { row: number; column: number } {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(value)
  if (!match) throw new Error('Spreadsheet contains an invalid cell coordinate')
  let column = 0
  for (const char of match[1]!) {
    column = column * 26 + char.charCodeAt(0) - 64
    if (!Number.isSafeInteger(column) || column > MAX_SPREADSHEET_COLUMNS) {
      throw new Error('Spreadsheet column coordinate exceeds the configured safety limit')
    }
  }
  const row = parsePositiveInteger(match[2]!, 'row coordinate', MAX_SPREADSHEET_ROWS)
  return { row, column }
}

function validateWorksheet(bytes: Uint8Array): WorksheetAllocation {
  let allocatedRows = 0
  let maximumColumn = 0
  let rowTags = 0
  let cellTags = 0
  let insideSheetData = false
  let insideRow = false
  let currentRowNumber: number | null = null
  let sawSheetData = false

  const rowsAfterCurrent = (): number => {
    if (!insideRow) return allocatedRows
    if (currentRowNumber === null) return allocatedRows + 1
    if (currentRowNumber <= allocatedRows) {
      throw new Error('Spreadsheet contains an out-of-place row coordinate')
    }
    return currentRowNumber
  }

  const assertAllocationLimit = (): void => {
    const rows = rowsAfterCurrent()
    if (rows > MAX_SPREADSHEET_ROWS) {
      throw new Error('Spreadsheet exceeds the configured row-allocation limit')
    }
    if (rows * maximumColumn > MAX_SPREADSHEET_CELLS) {
      throw new Error('Spreadsheet sparse coordinates exceed the configured cell-allocation limit')
    }
  }

  const root = parseXmlStreaming(bytes, {
    onOpen(name, attributes) {
      if (name === 'sheetData') {
        if (sawSheetData) throw new Error('Spreadsheet worksheet contains multiple sheetData elements')
        sawSheetData = true
        insideSheetData = true
        return
      }
      if (!insideSheetData) {
        if (name === 'row' || name === 'c') {
          throw new Error(`Spreadsheet ${name} element appears outside sheetData`)
        }
        return
      }
      if (name === 'row') {
        if (insideRow) throw new Error('Spreadsheet contains nested row elements')
        insideRow = true
        currentRowNumber = null
        rowTags++
        if (rowTags > MAX_SPREADSHEET_ROWS) {
          throw new Error('Spreadsheet exceeds the configured row-count limit')
        }
        const row = attribute(attributes, 'r')
        if (row !== null) {
          currentRowNumber = parsePositiveInteger(row, 'row coordinate', MAX_SPREADSHEET_ROWS)
        }
        return
      }
      if (name !== 'c') return
      if (!insideRow) throw new Error('Spreadsheet c element appears outside a row')

      cellTags++
      if (cellTags > MAX_SPREADSHEET_CELLS) {
        throw new Error('Spreadsheet exceeds the configured cell-count limit')
      }
      const reference = requiredAttribute(attributes, 'r', 'cell')
      const { row, column } = parseCellReference(reference)
      if (currentRowNumber === null) currentRowNumber = row
      maximumColumn = Math.max(maximumColumn, column)
      assertAllocationLimit()
    },
    onClose(name) {
      if (name === 'row') {
        allocatedRows = rowsAfterCurrent()
        insideRow = false
        currentRowNumber = null
        assertAllocationLimit()
      } else if (name === 'sheetData') {
        insideSheetData = false
      }
    },
  })
  if (root !== 'worksheet') throw new Error('Spreadsheet worksheet XML has an unexpected root element')
  return { rows: allocatedRows, cells: Math.max(cellTags, allocatedRows * maximumColumn) }
}

function requiredArchiveEntry(files: Record<string, Uint8Array>, name: string): Uint8Array {
  const value = files[name]
  if (!value) throw new Error(`Spreadsheet archive is missing ${name}`)
  return value
}

export function validateXlsxArchive(archive: Uint8Array): void {
  let entryCount = 0
  let uncompressedBytes = 0
  const fixedFiles = unzipSync(archive, {
    filter: (entry) => {
      if (++entryCount > MAX_OFFICE_ARCHIVE_ENTRIES) {
        throw new Error('Spreadsheet archive exceeds the safe entry-count limit')
      }
      if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) {
        throw new Error('Spreadsheet archive contains an invalid entry size')
      }
      uncompressedBytes += entry.originalSize
      if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > MAX_OFFICE_UNCOMPRESSED_BYTES) {
        throw new Error('Spreadsheet archive exceeds the safe decompression limit')
      }
      return entry.name === WORKBOOK_PATH || entry.name === WORKBOOK_RELATIONSHIPS_PATH
    },
  })
  const sheets = parseWorkbook(requiredArchiveEntry(fixedFiles, WORKBOOK_PATH))
  const relationships = parseWorkbookRelationships(requiredArchiveEntry(fixedFiles, WORKBOOK_RELATIONSHIPS_PATH))
  const targetPaths = new Set<string>()
  for (const sheet of sheets) {
    const relationship = relationships.get(sheet.relationId)
    if (!relationship) throw new Error(`Spreadsheet sheet relationship not found: ${sheet.relationId}`)
    const target = worksheetPath(relationship)
    if (!targetPaths.add(target)) throw new Error('Spreadsheet logical sheets must reference distinct worksheets')
  }

  const worksheetFiles = unzipSync(archive, { filter: (entry) => targetPaths.has(entry.name) })
  let allocatedRows = 0
  let allocatedCells = 0
  for (const target of targetPaths) {
    const allocation = validateWorksheet(requiredArchiveEntry(worksheetFiles, target))
    allocatedRows += allocation.rows
    allocatedCells += allocation.cells
    if (allocatedRows > MAX_SPREADSHEET_ROWS) {
      throw new Error('Spreadsheet exceeds the configured total row-allocation limit')
    }
    if (allocatedCells > MAX_SPREADSHEET_CELLS) {
      throw new Error('Spreadsheet exceeds the configured total cell-allocation limit')
    }
  }
}
