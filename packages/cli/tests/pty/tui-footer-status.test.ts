import { describe, expect, it } from 'vitest'

import { formatCwdForFooter } from '../../src/ui/chat-input/text-helpers.js'
import { exitTui, submitInput, withTui } from './test-context.js'

describe('TUI footer status bar (tok/s and trailing cwd)', () => {
  it('renders tok/s before the trailing workspace directory and clears tok/s on /clear', async () => {
    await withTui(
      'footer-stat',
      [
        {
          type: 'completion',
          text: 'streamed-footer-reply',
          chunks: ['streamed-', 'footer-', 'reply'],
          chunkDelayMs: 100,
          usage: { promptTokens: 1200, completionTokens: 60 },
        },
      ],
      async ({ harness, workspace }) => {
        const expectedCwd = formatCwdForFooter(workspace.cwd, 24)
        expect(expectedCwd.length).toBeGreaterThan(0)

        // On startup: model label + trailing directory name are visible, no tok/s yet.
        await harness.waitForScreen(
          (screen) => screen.includes('custom:test-model') && screen.includes(expectedCwd),
          'initial footer with cwd',
        )
        expect(harness.text()).not.toContain('tok/s')

        await submitInput(harness, 'measure footer speed')
        await harness.waitForText('streamed-footer-reply')
        await harness.waitForScreen((screen) => screen.includes('tok/s'), 'finalized tok/s in footer')

        const footerLine = harness.screen().find((line) => line.includes('custom:test-model') && line.includes('tok/s'))
        expect(footerLine).toBeDefined()
        // Order check: modelLabel -> ctx -> tok/s -> cwd (directory at the very end)
        const modelIdx = footerLine!.indexOf('custom:test-model')
        const ctxIdx = footerLine!.indexOf('ctx ')
        const speedIdx = footerLine!.indexOf('tok/s')
        const cwdIdx = footerLine!.lastIndexOf(expectedCwd)
        expect(modelIdx).toBeGreaterThanOrEqual(0)
        expect(ctxIdx).toBeGreaterThan(modelIdx)
        expect(speedIdx).toBeGreaterThan(ctxIdx)
        expect(cwdIdx).toBeGreaterThan(speedIdx)

        // /clear resets session metrics (ctx + tok/s) while keeping model + trailing cwd.
        await submitInput(harness, '/clear')
        await harness.waitForScreen(
          (screen) =>
            !screen.includes('streamed-footer-reply') &&
            !screen.includes('tok/s') &&
            screen.includes('custom:test-model') &&
            screen.includes(expectedCwd),
          'footer reset after /clear',
        )

        await exitTui(harness)
      },
      { columns: 120 },
    )
  })
})
