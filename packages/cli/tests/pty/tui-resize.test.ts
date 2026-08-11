import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import path from 'node:path'

import { occurrences } from './screen.js'
import { inputLine, submitInput, typeInput, withTui } from './test-context.js'

describe('TUI resize behavior', () => {
  it('preserves an in-progress input while shrinking and expanding', async () => {
    const draft = `resize-中文🙂-${'abcdefghij'.repeat(8)}-END`
    await withTui(
      'resize-input',
      [],
      async ({ harness }) => {
        harness.write(draft)
        await harness.waitForScreen(
          (screen) => screen.includes('resize-中文🙂') && screen.includes('-END'),
          'wide draft',
        )

        harness.resize(80, 24)
        await harness.waitForScreen(
          (screen) => screen.includes('resize-中文🙂') && screen.includes('-END'),
          'draft after shrinking',
        )
        harness.resize(140, 50)
        await harness.waitForScreen(
          (screen) => screen.includes('resize-中文🙂') && screen.includes('-END'),
          'draft after expanding',
        )

        expect(harness.text()).not.toContain('�')
      },
      { columns: 120, rows: 40 },
    )
  })

  it('does not duplicate streamed output when resized mid-response', async () => {
    await withTui(
      'resize-stream',
      [
        {
          type: 'completion',
          text: '',
          chunks: ['STREAM-BEGIN\n', 'STREAM-MIDDLE\n', 'STREAM-END'],
          chunkDelayMs: 150,
        },
      ],
      async ({ harness }) => {
        await submitInput(harness, 'hi')
        await harness.waitForText('STREAM-BEGIN')
        harness.resize(76, 24)
        await harness.waitForText('STREAM-MIDDLE')
        harness.resize(132, 44)
        await harness.waitForText('STREAM-END')
        await harness.waitForScreen((screen) => screen.includes('custom:test-model'), 'usable prompt after stream')

        expect(occurrences(harness.raw(), 'STREAM-BEGIN')).toBe(1)
        expect(occurrences(harness.raw(), 'STREAM-MIDDLE')).toBe(1)
        expect(occurrences(harness.raw(), 'STREAM-END')).toBe(1)
        await typeInput(harness, 'still-usable')
      },
      { columns: 110, rows: 36 },
    )
  })

  it('keeps slash and file completion menus operable across resize', async () => {
    await withTui(
      'resize-menus',
      [],
      async ({ harness }) => {
        await typeInput(harness, '/')
        await harness.waitForScreen((screen) => screen.includes('/clear'), 'slash completion menu')
        harness.resize(70, 24)
        await harness.waitForScreen((screen) => screen.includes('/clear'), 'slash menu after shrinking')

        harness.key('backspace')
        await harness.waitForScreen((screen) => !screen.includes('/clear'), 'slash menu closed')
        await typeInput(harness, '@resize')
        await harness.waitForScreen((screen) => screen.includes('@resize 菜单[1].txt'), 'file completion menu')
        harness.resize(136, 46)
        await harness.waitForScreen((screen) => screen.includes('@resize 菜单[1].txt'), 'file menu after expanding')
        harness.key('enter')
        await harness.waitForScreen(
          (screen) => screen.includes('❯ @resize 菜单[1].txt'),
          'file completion after resize',
        )
        expect(inputLine(harness)).toBe('❯ @resize 菜单[1].txt')
      },
      {
        columns: 120,
        rows: 40,
        beforeStart: async (workspace) => {
          await fs.writeFile(path.join(workspace.cwd, 'resize 菜单[1].txt'), 'resize\n')
        },
      },
    )
  })
})
