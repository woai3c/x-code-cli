import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import path from 'node:path'

import { submitInput, withTui } from './test-context.js'

// Regression guard: the committed diff band (add/remove row background)
// must reach the terminal's right edge at commit time. It does so via an
// in-span BCE erase (`\x1b[K` before the bg reset) rather than space
// padding — padded rows would be split into phantom blank rows by
// scrollback reflow when the terminal narrows. The band's printable
// width must still respect the reserved 1-cell delayed-wrap margin.
describe('diff band width', () => {
  it('diff bg band extends to the terminal edge on a wide terminal', async () => {
    const COLS = 200
    await withTui(
      'diff-width',
      [
        {
          type: 'tool-call',
          name: 'edit',
          input: { filePath: 'a.ts', oldString: 'line2', newString: 'line2 modified' },
        },
        { type: 'completion', text: 'done-all' },
      ],
      async ({ harness }) => {
        await submitInput(harness, 'edit the file')
        await harness.waitForText('Would you like to edit the following file?', 30000)
        harness.write('y')
        await harness.waitForText('done-all', 30000)
        await harness.settle()

        const raw = harness.raw()
        // The removed row: `\x1b[48;2;<removed-bg>m` … `\x1b[49m`. The live
        // frame may paint other bg spans earlier in the stream — measure
        // the LAST one, which is the committed diff row.
        const matches = [...raw.matchAll(/\x1b\[48;2;\d+;\d+;\d+m([\s\S]*?)\x1b\[49m/g)]
        expect(matches.length).toBeGreaterThan(0)
        const span = matches[matches.length - 1]![1]!
        // The band reaches the right edge via the in-span erase, which
        // must be the last thing inside the bg span.
        expect(span.endsWith('\x1b[K')).toBe(true)
        const bandWidth = span.replace(/\x1b\[[0-9;]*m/g, '').replace('\x1b[K', '').length
        // No space padding: printable width is gutter + code, bounded by
        // COLS - 1 (the delayed-wrap margin) minus the 6-cell RESULT_INDENT.
        expect(bandWidth).toBeLessThanOrEqual(COLS - 1 - 6)
        harness.key('ctrl-c')
      },
      {
        columns: COLS,
        rows: 30,
        beforeStart: async (ws) => {
          await fs.writeFile(path.join(ws.cwd, 'a.ts'), 'line1\nline2\nline3\n', 'utf-8')
        },
      },
    )
  }, 60000)
})
