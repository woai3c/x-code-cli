import { truncateUtf8 } from '../utils.js'
import { readFileWithinLimit } from '../utils/bounded-read.js'

export const MAX_NOTEBOOK_SOURCE_BYTES = 5 * 1024 * 1024
export const MAX_NOTEBOOK_OUTPUT_BYTES = 256 * 1024

interface NotebookOutput {
  output_type?: string
  text?: string | string[]
  data?: Record<string, unknown>
  ename?: string
  evalue?: string
  traceback?: string[]
}

interface NotebookCell {
  cell_type?: string
  source?: string | string[]
  execution_count?: number | null
  outputs?: NotebookOutput[]
}

function joinNotebookSource(source: string | string[] | undefined): string {
  if (Array.isArray(source)) return source.join('')
  return typeof source === 'string' ? source : ''
}

const ANSI_ESCAPE = new RegExp('\\u001b\\[[0-9;]*m', 'g')

function boundNotebookOutput(text: string): { text: string; complete: boolean } {
  if (Buffer.byteLength(text, 'utf-8') <= MAX_NOTEBOOK_OUTPUT_BYTES) return { text, complete: true }
  return {
    text:
      truncateUtf8(text, MAX_NOTEBOOK_OUTPUT_BYTES) +
      `\n\n[Notebook output truncated at ${MAX_NOTEBOOK_OUTPUT_BYTES / 1024} KB. Use grep on the .ipynb to find specific cells or symbols.]`,
    complete: false,
  }
}

function renderNotebookOutput(output: NotebookOutput): string {
  switch (output.output_type) {
    case 'stream':
      return joinNotebookSource(output.text).trimEnd()
    case 'error': {
      const trace = Array.isArray(output.traceback) ? output.traceback.join('\n') : ''
      const head = [output.ename, output.evalue].filter(Boolean).join(': ')
      return (trace || head).replace(ANSI_ESCAPE, '').trimEnd()
    }
    case 'execute_result':
    case 'display_data': {
      const data = output.data ?? {}
      const parts: string[] = []
      const plain = data['text/plain']
      if (plain !== undefined) parts.push(joinNotebookSource(plain as string | string[]).trimEnd())
      for (const mime of Object.keys(data)) {
        if (mime !== 'text/plain') parts.push(`[${mime} output omitted]`)
      }
      return parts.join('\n')
    }
    default:
      return ''
  }
}

export async function renderNotebookFile(
  filePath: string,
  abortSignal?: AbortSignal,
): Promise<{ text: string; complete: boolean }> {
  const raw = (await readFileWithinLimit(filePath, MAX_NOTEBOOK_SOURCE_BYTES, abortSignal)).toString('utf-8')
  let parsed: { cells?: NotebookCell[] }
  try {
    parsed = JSON.parse(raw) as { cells?: NotebookCell[] }
  } catch {
    return boundNotebookOutput(raw)
  }

  const cells = Array.isArray(parsed.cells) ? parsed.cells : []
  const output: string[] = [`# Jupyter Notebook: ${filePath} (${cells.length} cell${cells.length === 1 ? '' : 's'})`]
  cells.forEach((cell, index) => {
    const type = cell.cell_type ?? 'unknown'
    const execution = type === 'code' && cell.execution_count != null ? ` (exec ${cell.execution_count})` : ''
    output.push('', `## Cell ${index + 1} [${type}]${execution}`)
    const source = joinNotebookSource(cell.source).trimEnd()
    if (source) output.push(source)
    for (const item of Array.isArray(cell.outputs) ? cell.outputs : []) {
      const rendered = renderNotebookOutput(item)
      if (rendered) output.push('### Output:', rendered)
    }
  })

  return boundNotebookOutput(output.join('\n'))
}
