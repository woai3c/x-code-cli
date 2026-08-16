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
        // The fresh frame anchors at the top of the viewport (row 1-4).
        expect(lines[1] ?? '').toMatch(/^[❯>]\s*$/)
      },
      { columns: 80, rows: 40 },
    )
  })
})
