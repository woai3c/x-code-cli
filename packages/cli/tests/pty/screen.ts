import type { Terminal } from '@xterm/headless'

import { GLYPH_PROMPT_ARROW } from '../../src/ui/render/terminal-glyphs.js'

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

export function screenText(terminal: Terminal): string {
  return terminalScreen(terminal).join('\n')
}

export function lastPromptLine(lines: string[]): string {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    if (line === GLYPH_PROMPT_ARROW || line.startsWith(`${GLYPH_PROMPT_ARROW} `)) return line
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
