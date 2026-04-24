// @x-code-cli/core — Shell stderr noise folding
//
// PowerShell and cmd emit multi-line diagnostics for every parse/syntax error:
// the `At line:X char:Y` header, a line of the offending source, a caret
// underline (`+ ~~~~`), a free-form description line, then the tail markers
// (`+ CategoryInfo` and `+ FullyQualifiedErrorId`). When the agent loops on
// a misquoted command, those 5–10 line stacks stack up in context faster
// than the actual diagnostic signal. We collapse each block to a single line.
//
// The detection model:
//   - A block STARTS at a line matching `At line:X char:Y`.
//   - A block ENDS at whichever comes first: (a) a `FullyQualifiedErrorId`
//     line (that's always the PS-emitted terminator), (b) another block
//     start, (c) a hard scan cap.
//   - The scan cap guards against pathological input where a FQID line is
//     missing — we won't silently devour unrelated output.

/** Max lines we'll consume in a single block. PS stacks are ~5 lines and
 *  never approach 12; anything past that is probably not part of the block. */
const BLOCK_SCAN_LIMIT = 12

const PS_BLOCK_START = /^At line:\d+ char:\d+/
const PS_FQID_LINE = /^\s*\+\s*FullyQualifiedErrorId\s*:/

function isBlockStart(line: string): boolean {
  return PS_BLOCK_START.test(line)
}

function isFqidTerminator(line: string): boolean {
  return PS_FQID_LINE.test(line)
}

/**
 * Collapse PowerShell error blocks in `text` to a single summary line each.
 * The summary preserves the opening `At line:X char:Y` header (the only
 * diagnostic signal we keep) and discards the body, caret, category and
 * fully-qualified-id continuations.
 *
 * Returns the input unchanged if no recognisable block is found. Safe to call
 * on arbitrary shell output — lines that don't fall inside a block pass
 * through verbatim.
 */
export function foldShellErrorNoise(text: string): string {
  if (!text) return text
  // Fast path: most shell output isn't a PS error stack.
  if (!text.includes('At line:')) return text

  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!isBlockStart(line)) {
      out.push(line)
      i++
      continue
    }

    out.push(`${line.trim()} [PS parse error — details folded]`)
    i++

    // Consume the body of the block. We stop at the natural terminator
    // (`FullyQualifiedErrorId`) or at a new block header (in case multiple
    // errors were concatenated). The scan cap is a defensive safety net;
    // real PS errors never hit it.
    let scanned = 0
    while (i < lines.length && scanned < BLOCK_SCAN_LIMIT) {
      if (isBlockStart(lines[i])) break
      const terminator = isFqidTerminator(lines[i])
      i++
      scanned++
      if (terminator) break
    }
  }

  return out.join('\n')
}
