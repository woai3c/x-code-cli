import { describe, expect, it } from 'vitest'

import { submitInput, withTui } from './test-context.js'

const CHUNKS = ['LINE-A\n', 'LINE-B\n', 'LINE-C\n', 'LINE-D\n', 'LINE-E\n', 'LINE-F\n']

function occurrences(haystack: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    count++
    from = at + needle.length
  }
  return count
}

function expectSingleUntornFrame(screen: string[], context: string): void {
  // The live frame is the only UI element with box-drawing borders; any
  // second ╭/╰/╯ occurrence is a reflowed remnant of an earlier frame.
  expect(screen.join('\n')).not.toContain('�')
  const topRow = screen.findIndex((row) => row.includes('╭'))
  expect(topRow, `input box top border present (${context})`).toBeGreaterThan(-1)
  expect(screen[topRow]!.includes('╮'), `input box top border closed (${context})`).toBe(true)
  for (let i = 0; i < topRow; i++) {
    expect(screen[i]!, `no frame remnant above the input box, row ${i} (${context})`).not.toMatch(/[╭╰╯┌┐└┘]/)
  }
  expect(occurrences(screen.join('\n'), '╭')).toBe(1)
  expect(occurrences(screen.join('\n'), '╰')).toBe(1)
  expect(occurrences(screen.join('\n'), '╯')).toBe(1)
}

describe('floating frame reflow remnants', () => {
  it('floating frame: narrow then widen during streaming (VS Code "+")', async () => {
    await withTui(
      'reflow-width-only',
      [{ type: 'completion', text: '', chunks: CHUNKS, chunkDelayMs: 200 }],
      async ({ harness }) => {
        await submitInput(harness, '查一下天津的')
        await harness.waitForText('LINE-A')
        harness.resize(64, 36)
        await harness.waitForText('LINE-B')
        harness.resize(120, 36)
        await harness.waitForText('LINE-F')
        await harness.waitForScreen((screen) => screen.includes('custom:test-model'), 'prompt after stream')
        await harness.settle()
        expectSingleUntornFrame(harness.screen(), 'floating narrow then widen')
      },
      { columns: 120, rows: 36 },
    )
  }, 60_000)

  it('floating frame: rows change at the same time as columns', async () => {
    await withTui(
      'reflow-width-only-h',
      [{ type: 'completion', text: '', chunks: CHUNKS, chunkDelayMs: 200 }],
      async ({ harness }) => {
        await submitInput(harness, '查一下天津的')
        await harness.waitForText('LINE-A')
        harness.resize(64, 24)
        await harness.waitForText('LINE-B')
        harness.resize(140, 40)
        await harness.waitForText('LINE-F')
        await harness.waitForScreen((screen) => screen.includes('custom:test-model'), 'prompt after stream')
        await harness.settle()
        expectSingleUntornFrame(harness.screen(), 'narrow+shrink then widen+grow')
      },
      { columns: 120, rows: 36 },
    )
  }, 60_000)

  it('floating frame: zigzag narrow/wide', async () => {
    await withTui(
      'reflow-width-only-z',
      [{ type: 'completion', text: '', chunks: CHUNKS, chunkDelayMs: 200 }],
      async ({ harness }) => {
        await submitInput(harness, '查一下天津的')
        await harness.waitForText('LINE-A')
        harness.resize(64, 36)
        await harness.waitForText('LINE-B')
        harness.resize(120, 36)
        await harness.waitForText('LINE-C')
        harness.resize(50, 36)
        await harness.waitForText('LINE-D')
        harness.resize(130, 36)
        await harness.waitForText('LINE-F')
        await harness.waitForScreen((screen) => screen.includes('custom:test-model'), 'prompt after stream')
        await harness.settle()
        expectSingleUntornFrame(harness.screen(), 'zigzag')
      },
      { columns: 120, rows: 36 },
    )
  }, 60_000)

  it('keeps resize cleanup when another render lands inside the deferred window', async () => {
    await withTui(
      'reflow-resize-deferred-race',
      [{ type: 'stall', afterHeaders: true }],
      async ({ harness }) => {
        await submitInput(harness, '查一下天津的')
        await harness.waitForText('Working')
        // Land after the 200ms spinner tick but before its 160ms deferred
        // flush. Before the regression fix the resize erase joined that
        // cancellable path, so settle() returned while xterm still showed
        // the old wide frame reflowed across multiple rows.
        await new Promise((resolve) => setTimeout(resolve, 210))
        harness.resize(64, 36)
        await harness.settle()
        expectSingleUntornFrame(harness.screen(), 'resize cleanup deferred race')
      },
      { columns: 120, rows: 36 },
    )
  }, 60_000)

  it('preserves visible transcript while height grows after a width reflow', async () => {
    await withTui(
      'reflow-height-growth-preserves-transcript',
      [{ type: 'completion', text: '', chunks: CHUNKS, chunkDelayMs: 150 }],
      async ({ harness }) => {
        await submitInput(harness, '查一下天津的')
        await harness.waitForText('LINE-A')
        // Establish the width-reflow cleanup zone, then let later stream
        // commits occupy rows below it before changing only the height.
        harness.resize(64, 24)
        await harness.waitForText('LINE-F')
        await harness.waitForScreen((screen) => screen.includes('custom:test-model'), 'prompt after stream')
        for (const rows of [25, 26, 28, 30, 35]) {
          harness.resize(64, rows)
          await harness.settle()
          const screen = harness.screen().join('\n')
          for (const chunk of CHUNKS) expect(screen).toContain(chunk.trim())
          expectSingleUntornFrame(harness.screen(), `height growth to ${rows} rows`)
        }
        harness.resize(120, 35)
        await harness.settle()

        const screen = harness.screen().join('\n')
        for (const chunk of CHUNKS) expect(screen).toContain(chunk.trim())
        expectSingleUntornFrame(harness.screen(), 'height growth after width reflow')
      },
      { columns: 120, rows: 24 },
    )
  }, 60_000)
})
