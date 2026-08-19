import { describe, expect, it } from 'vitest'

import { submitInput, typeInput, withTui } from './test-context.js'

// Regression: the TUI hides the hardware cursor app-wide, but macOS
// terminals still render the IME composition preview (marked text) AT the
// hardware cursor position. Every flush must therefore end by parking the
// cursor on the visible caret cell — otherwise the diff loop leaves it
// mid-Working-row (spinner tick) or one cell past the input box's right
// rail (keystroke), and pinyin previews paint there.

function lastCursorPosition(raw: string): { row: number; col: number } {
  const matches = [...raw.matchAll(/\x1b\[(\d+);(\d+)H/g)]
  const last = matches[matches.length - 1]
  if (!last) throw new Error('no cursor-position escape in output')
  return { row: Number(last[1]), col: Number(last[2]) }
}

describe('IME cursor park', () => {
  it('parks the hidden hardware cursor on the caret cell after typing', async () => {
    await withTui('ime-park', [], async ({ harness }) => {
      await typeInput(harness, 'ab中文')
      await harness.settle()

      const { row, col } = lastCursorPosition(harness.raw())
      // Caret visual column: 1-based col 5 is the first text cell
      // (│ space › space), then a(1) b(1) 中(2) 文(2) → caret at col 11.
      expect(col).toBe(11)

      // The parked row must be the screen row that contains the typed text.
      const inputRowIdx = harness.screen().findIndex((line) => line.includes('ab中文'))
      expect(inputRowIdx).toBeGreaterThanOrEqual(0)
      expect(row).toBe(inputRowIdx + 1) // screen[] is 0-based, CSI is 1-based
    })
  })

  it('keeps the cursor parked on the caret while the spinner ticks mid-stream', async () => {
    const streamed = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    await withTui(
      'ime-park-stream',
      [{ type: 'completion', text: streamed, chunks: streamed.split('\n'), chunkDelayMs: 120 }],
      async ({ harness }) => {
        await submitInput(harness, 'go')
        await typeInput(harness, 'xy')
        // Let spinner ticks + streaming commits land AFTER our last
        // keystroke — the final flush is then a spinner/commit flush, the
        // case that used to leave the cursor mid-Working-row.
        await harness.settle()
        await harness.settle()

        const { row, col } = lastCursorPosition(harness.raw())
        // Caret after "xy": first text cell is col 5, +2 chars → col 7.
        expect(col).toBe(7)
        const inputRowIdx = harness.screen().findIndex((line) => line.includes('xy'))
        expect(inputRowIdx).toBeGreaterThanOrEqual(0)
        expect(row).toBe(inputRowIdx + 1)
      },
    )
  })
})
