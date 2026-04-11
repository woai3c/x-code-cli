// @x-code-cli/cli — Paste-reference helpers.
//
// Large pastes aren't displayed inline in the input box. Instead we store the
// full content in a map and show a placeholder like `[Pasted text #2 +217 lines]`
// in its place. On Enter, the placeholder is expanded back to the full content
// before being handed to the agent. Modeled on Claude Code's PromptInput.

export interface PastedEntry {
  id: number
  content: string
  lineCount: number
}

export type PastedContents = Record<number, PastedEntry>

/** Regex for finding paste refs anywhere in a string (used on submit). */
const REF_ANY_RE = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g

/** Regex for checking whether a string ends with a paste ref (used on backspace). */
const REF_TAIL_RE = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]$/

export function formatPasteRef(id: number, lineCount: number): string {
  if (lineCount <= 1) return `[Pasted text #${id}]`
  return `[Pasted text #${id} +${lineCount} lines]`
}

/**
 * Replace every `[Pasted text #N …]` reference in `text` with the real
 * content stored in `contents`. Refs whose id is missing are left as-is.
 */
export function expandPasteRefs(text: string, contents: PastedContents): string {
  return text.replace(REF_ANY_RE, (match, idStr: string) => {
    const id = Number(idStr)
    const entry = contents[id]
    return entry ? entry.content : match
  })
}

/**
 * If `text` ends with a paste-ref placeholder, return the text with the ref
 * removed plus the id of the removed entry (so the caller can drop it from
 * the pasted-contents map). Otherwise return null — the caller should fall
 * back to removing a single character.
 */
export function stripTrailingRef(text: string): { without: string; id: number } | null {
  const m = text.match(REF_TAIL_RE)
  if (!m) return null
  return {
    without: text.slice(0, text.length - m[0].length),
    id: Number(m[1]),
  }
}
