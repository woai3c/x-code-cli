import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import path from 'node:path'

import { submitInput, withTui } from './test-context.js'

// Regression guard: the committed diff band (add/remove row background)
// must span the FULL terminal width at commit time (minus the reserved
// 1-cell delayed-wrap margin). The padding budget is computed from live
// `process.stdout.columns` — a stale/capped width shows up as the bg
// band stopping short of the right edge on wide terminals.
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
        const bandWidth = matches[matches.length - 1]![1]!.replace(/\x1b\[[0-9;]*m/g, '').length
        // indent(6) + gutter + code + padding = COLS - 1; the band starts
        // after the 6-cell RESULT_INDENT.
        expect(bandWidth).toBe(COLS - 1 - 6)
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
