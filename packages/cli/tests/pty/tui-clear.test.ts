import { describe, expect, it } from 'vitest'

import { submitInput, typeInput, withTui } from './test-context.js'

const LONG_TEXT = Array.from({ length: 60 }, (_, i) => `LINE-${String(i + 1).padStart(2, '0')}`).join('\n')

describe('TUI /clear behavior', () => {
  // Regression: the /clear render carries one-shot erase+scroll bytes that
  // used to ride the cancellable deferred-flush path. A nearby re-render
  // (input reset, turn-teardown state) superseded it, the clear bytes were
  // lost forever, and the just-consumed justCleared seed still anchored the
  // fresh frame at row 1 — leaving the old conversation visible below it.
  // The second turn below exists to produce those racing renders.
  it('clears the visible viewport even with racing renders around the clear', async () => {
    await withTui(
      'clear-viewport',
      [
        { type: 'completion', text: LONG_TEXT },
        {
          type: 'tool-call',
          name: 'PowerShell',
          input: { command: 'git tag -d v0.5.0' },
          finalText: 'done',
        },
      ],
      async ({ harness }) => {
        await submitInput(harness, 'hi')
        await harness.waitForText('LINE-60')

        await submitInput(harness, 'delete the tag')
        await harness.waitForText('done')
        await harness.settle()

        // Submit /clear with the completion menu open, mirroring real usage.
        await typeInput(harness, '/clear')
        await harness.waitForScreen((screen) => screen.includes('Clear conversation history'), 'slash menu open')
        harness.key('enter')

        await harness.waitForScreen(
          (screen) => !screen.includes('LINE-01') && !screen.includes('PowerShell(') && screen.includes('test-model'),
          'viewport cleared after /clear',
        )

        const lines = harness.screen()
        expect(harness.text()).not.toContain('LINE-01')
        expect(harness.text()).not.toContain('done')
        // The retained /clear echo renders as the first content of the
        // fresh viewport — the same padded card every other command echo
        // gets: blank row, full-width bg pad row, text row, bg pad row —
        // with the fresh input frame directly below it.
        const echoRow = lines.findIndex((line) => /[▸›❯>] \/clear/.test(line))
        expect(echoRow).toBeGreaterThanOrEqual(2)
        expect((lines[echoRow - 1] ?? 'x').trim()).toBe('')
        expect((lines[echoRow + 1] ?? 'x').trim()).toBe('')
        expect(lines[echoRow + 2] ?? '').toMatch(/^╭/)
        // The card's bg rows must actually be emitted AFTER the clear's
        // home-cursor jump (they used to be pushed into scrollback where
        // some terminals drop bg-only rows from history).
        const postClear = harness.raw().slice(harness.raw().lastIndexOf('\x1b[H'))
        expect(postClear.split('\x1b[48;2;60;56;54m').length - 1).toBeGreaterThanOrEqual(3)
      },
      { columns: 80, rows: 40 },
    )
  })
})
