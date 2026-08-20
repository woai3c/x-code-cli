import type { Terminal } from '@xterm/headless'

export function terminalScreen(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let row = 0; row < terminal.rows; row++) {
    lines.push(
      buffer
        .getLine(buffer.viewportY + row)
        ?.translateToString(true)
        .trimEnd() ?? '',
    )
  }
  return lines
}

/** The live prompt line reduced to just its editable content: box rails
 *  (`│ …… │`) and the `› ` prompt glyph stripped, trailing pad removed.
 *  Tests assert against what the user TYPED, not the frame around it. */
export function promptContent(line: string): string {
  return line.replace(/^│ /, '').replace(/^\| /, '').replace(/ │$/, '').replace(/ \|$/, '').trimEnd()
}

export function screenText(terminal: Terminal): string {
  return terminalScreen(terminal).join('\n')
}

export function lastPromptLine(lines: string[]): string {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    if (line === '>' || line.startsWith('> ') || line === '›' || line.startsWith('› ')) return line
    // Boxed prompt: `│ › …… │` — the rails are part of the live input box.
    // Permission-dialog option rows also start with `│ ` but their pointer
    // sits behind a 4-space indent, so they can't false-match `│ ›`.
    if (line.startsWith('│ ›') || line.startsWith('│ >') || line.startsWith('| >')) return line
  }
  return ''
}

export function occurrences(text: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while ((offset = text.indexOf(needle, offset)) >= 0) {
    count++
    offset += needle.length
  }
  return count
}
