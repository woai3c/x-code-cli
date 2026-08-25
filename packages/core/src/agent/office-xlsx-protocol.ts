export const MAX_SPREADSHEET_SHEETS = 32
export const MAX_SPREADSHEET_ROWS = 10_000
export const MAX_SPREADSHEET_CELLS = 100_000
export const MAX_SPREADSHEET_COLUMNS = MAX_SPREADSHEET_CELLS

export interface ParsedXlsxSheet {
  sheet: string
  data: unknown[][]
}

export interface OfficeXlsxWorkerInput {
  archive: ArrayBuffer
}

export type OfficeXlsxWorkerOutput = { ok: true; text: string } | { ok: false; error: string }
