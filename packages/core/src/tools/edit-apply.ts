export const MAX_BATCH_EDITS = 100
export const MAX_BATCH_INPUT_BYTES = 1024 * 1024
export const MAX_BATCH_SCAN_BYTES = 64 * 1024 * 1024

export interface EditReplacement {
  oldString: string
  newString: string
}

export type NormalizedEditInput =
  | { mode: 'batch'; filePath: string; edits: EditReplacement[] }
  | { mode: 'legacy'; filePath: string; oldString: string; newString: string; replaceAll: boolean }

function validateReplacement(edit: EditReplacement, index?: number): void {
  const label = index === undefined ? 'edit' : `edits[${index}]`
  if (!edit.oldString) throw new Error(`${label}.oldString must not be empty.`)
  if (edit.oldString === edit.newString) throw new Error(`${label} must change the matched text.`)
}

function parseBatch(value: unknown): EditReplacement[] {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error('edits must be an array or a JSON-encoded array.')
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('edits must contain at least one replacement.')
  if (parsed.length > MAX_BATCH_EDITS) {
    throw new Error(`edits exceeds the ${MAX_BATCH_EDITS}-replacement limit; split it into multiple calls.`)
  }

  const edits = parsed.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`edits[${index}] must be an object.`)
    }
    const entry = value as Record<string, unknown>
    if (typeof entry.oldString !== 'string' || typeof entry.newString !== 'string') {
      throw new Error(`edits[${index}] requires string oldString and newString fields.`)
    }
    const edit = { oldString: entry.oldString, newString: entry.newString }
    validateReplacement(edit, index)
    return edit
  })

  const inputBytes = edits.reduce(
    (total, edit) => total + Buffer.byteLength(edit.oldString) + Buffer.byteLength(edit.newString),
    0,
  )
  if (inputBytes > MAX_BATCH_INPUT_BYTES) {
    throw new Error(`edits exceeds the ${MAX_BATCH_INPUT_BYTES}-byte input limit; split it into multiple calls.`)
  }
  const seen = new Set<string>()
  for (const [index, edit] of edits.entries()) {
    if (seen.has(edit.oldString)) throw new Error(`edits[${index}].oldString duplicates an earlier replacement.`)
    seen.add(edit.oldString)
  }
  return edits
}

/** Normalize after PreToolUse and before the loop guard / permission prompt. */
export function normalizeEditInput(input: Record<string, unknown>): NormalizedEditInput {
  const filePath = input.filePath
  if (typeof filePath !== 'string' || !filePath) throw new Error('filePath must be a non-empty string.')

  if (input.edits !== undefined) {
    if (input.oldString !== undefined || input.newString !== undefined || input.replaceAll !== undefined) {
      throw new Error('Do not combine edits with oldString, newString, or replaceAll.')
    }
    return { mode: 'batch', filePath, edits: parseBatch(input.edits) }
  }

  if (typeof input.oldString !== 'string' || typeof input.newString !== 'string') {
    throw new Error('Legacy edit input requires string oldString and newString fields.')
  }
  const edit = { oldString: input.oldString, newString: input.newString }
  validateReplacement(edit)
  return {
    mode: 'legacy',
    filePath,
    ...edit,
    replaceAll: input.replaceAll === true,
  }
}

export function normalizedEditRecord(input: NormalizedEditInput): Record<string, unknown> {
  return input.mode === 'batch'
    ? { filePath: input.filePath, edits: input.edits }
    : {
        filePath: input.filePath,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll,
      }
}

export function applyBatchEdits(content: string, edits: EditReplacement[]): string {
  if (edits.length === 0) throw new Error('edits must contain at least one replacement.')
  if (edits.length > MAX_BATCH_EDITS) throw new Error(`edits exceeds the ${MAX_BATCH_EDITS}-replacement limit.`)
  const inputBytes = edits.reduce(
    (total, edit) => total + Buffer.byteLength(edit.oldString) + Buffer.byteLength(edit.newString),
    0,
  )
  if (inputBytes > MAX_BATCH_INPUT_BYTES)
    throw new Error(`edits exceeds the ${MAX_BATCH_INPUT_BYTES}-byte input limit.`)
  if (Buffer.byteLength(content) * edits.length > MAX_BATCH_SCAN_BYTES) {
    throw new Error(`Batch scan exceeds the ${MAX_BATCH_SCAN_BYTES}-byte work limit; split it into multiple calls.`)
  }

  const seen = new Set<string>()
  for (const [index, edit] of edits.entries()) {
    if (seen.has(edit.oldString)) throw new Error(`edits[${index}].oldString duplicates an earlier replacement.`)
    seen.add(edit.oldString)
  }

  const matches = edits.map((edit, index) => {
    validateReplacement(edit, index)
    const start = content.indexOf(edit.oldString)
    if (start === -1) throw new Error(`edits[${index}].oldString was not found.`)
    if (content.indexOf(edit.oldString, start + 1) !== -1) {
      throw new Error(`edits[${index}].oldString is not unique.`)
    }
    return { index, start, end: start + edit.oldString.length, newString: edit.newString }
  })

  matches.sort((a, b) => a.start - b.start)
  for (let i = 1; i < matches.length; i++) {
    const previous = matches[i - 1]!
    const current = matches[i]!
    if (current.start < previous.end) {
      throw new Error(`edits[${current.index}] overlaps edits[${previous.index}].`)
    }
  }

  let result = content
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i]!
    result = result.slice(0, match.start) + match.newString + result.slice(match.end)
  }
  return result
}
