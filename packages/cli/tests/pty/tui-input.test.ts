import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import path from 'node:path'

import { loadSession } from '@x-code-cli/core'

import { GLYPH_PROMPT_ARROW } from '../../src/ui/render/terminal-glyphs.js'
import { exitTui, inputLine, submitInput, typeInput, withTui } from './test-context.js'

describe('TUI input and lifecycle', () => {
  it('completes first-run setup and restores the parent shell on a clean exit', async () => {
    await withTui(
      'input-first-run-exit',
      [],
      async ({ harness, workspace }) => {
        expect(harness.text()).toContain('Welcome to X-Code!')
        expect(harness.text()).toContain('Pick a theme:')
        expect(harness.text()).toContain('custom:test-model')

        harness.key('enter')
        await harness.waitForText('Theme set to Dark mode')
        const config = JSON.parse(await fs.readFile(path.join(workspace.xcodeHome, 'config.json'), 'utf-8')) as {
          theme?: string
        }
        expect(config.theme).toBe('dark')

        await exitTui(harness)
        // ConPTY broadcasts Ctrl+C to the host PowerShell as well as the CLI,
        // so only POSIX harnesses can probe the same parent shell afterward.
        if (process.platform !== 'win32') {
          const shellOutput = await harness.shellProbe()
          expect(shellOutput).toMatch(/__X_CODE_SHELL_OK_\d+__/)
        }
        expect(harness.raw()).toContain('\x1b[?2004l')
        expect(harness.raw()).toContain('\x1b[?25h')
      },
      { seedTheme: false },
    )
  })

  it('edits CJK and emoji text without splitting a grapheme', async () => {
    await withTui('input-unicode', [], async ({ harness }) => {
      await typeInput(harness, '中文🙂abc')
      expect(inputLine(harness)).toContain('中文🙂abc')

      for (let i = 0; i < 3; i++) {
        harness.key('left')
        await harness.settle()
      }
      harness.key('backspace')
      await harness.waitForScreen((screen) => screen.includes(`${GLYPH_PROMPT_ARROW} 中文abc`), 'whole emoji deletion')

      expect(harness.text()).not.toContain('�')
      expect(inputLine(harness)).toBe(`${GLYPH_PROMPT_ARROW} 中文abc`)
    })
  })

  it('clears drafts with Unix and Windows shell shortcuts', async () => {
    await withTui('input-shell-clear', [], async ({ harness }) => {
      await typeInput(harness, 'clear with ctrl-u')
      harness.key('ctrl-u')
      await harness.waitForScreen(() => inputLine(harness) === GLYPH_PROMPT_ARROW, 'Ctrl+U input clear')

      harness.paste('first line\nsecond line\nthird line')
      await harness.waitForScreen((screen) => screen.includes('[Pasted text #1 +3 lines]'), 'paste placeholder')
      harness.key('ctrl-home')
      await harness.waitForScreen(
        (screen) => inputLine(harness) === GLYPH_PROMPT_ARROW && !screen.includes('[Pasted text #1 +3 lines]'),
        'Ctrl+Home input clear',
      )
    })
  })

  it('keeps bracketed multiline paste order through submission', async () => {
    const pasted = 'first line\n第二🙂\nthird line'
    await withTui('input-paste', [{ type: 'completion', text: 'paste-ok' }], async ({ harness, provider }) => {
      harness.paste(pasted)
      await harness.waitForScreen((screen) => screen.includes('[Pasted text #1 +3 lines]'), 'paste placeholder')
      harness.key('enter')
      await harness.waitForText('paste-ok')

      const [request] = await provider.waitForMainRequests(1)
      expect(request).toBeDefined()
      const body = request!.rawBody
      const first = body.indexOf('first line')
      const second = body.indexOf('第二🙂')
      const third = body.indexOf('third line')
      expect(first).toBeGreaterThanOrEqual(0)
      expect(second).toBeGreaterThan(first)
      expect(third).toBeGreaterThan(second)
    })
  })

  it('ingests file references submitted while another response is streaming', async () => {
    await withTui(
      'input-queued-file-ingest',
      [
        {
          type: 'completion',
          text: '',
          chunks: ['queue-window\n', 'initial-finished'],
          chunkDelayMs: 800,
        },
        { type: 'completion', text: 'queued-file-ingested' },
      ],
      async ({ harness, provider }) => {
        await submitInput(harness, 'start a response')
        await harness.waitForText('queue-window')
        await submitInput(harness, '@"queued attachment.txt" analyze this file')

        const requests = await provider.waitForMainRequests(2)
        expect(requests[1]?.rawBody).toContain('QUEUED_ATTACHMENT_CONTENT')
        await harness.waitForText('queued-file-ingested')
        const raw = harness.raw()
        const oldReplyTail = raw.lastIndexOf('initial-finished')
        const queuedUser = raw.lastIndexOf('@"queued attachment.txt" analyze this file')
        const readSummary = raw.lastIndexOf('Read')
        expect(oldReplyTail).toBeGreaterThanOrEqual(0)
        expect(queuedUser).toBeGreaterThan(oldReplyTail)
        expect(readSummary).toBeGreaterThan(queuedUser)
      },
      {
        beforeStart: async (workspace) => {
          await fs.writeFile(path.join(workspace.cwd, 'queued attachment.txt'), 'QUEUED_ATTACHMENT_CONTENT\n')
        },
      },
    )
  })

  it('forks completed context while the current request is still streaming', async () => {
    await withTui(
      'input-fork-mid-turn',
      [
        { type: 'completion', text: 'shared-answer' },
        { type: 'stall', afterHeaders: true },
      ],
      async ({ harness, provider, workspace }) => {
        await submitInput(harness, 'shared context')
        await harness.waitForText('shared-answer')

        await submitInput(harness, 'generate document A')
        await provider.waitForMainRequests(2)
        await harness.waitForText('Working')
        // Named fork: multi-word name exercises the `/fork <name...>` arg
        // reassembly; unnamed fork right after covers the no-arg path.
        await submitInput(harness, '/fork doc branch')
        await harness.waitForText('xc --resume "doc branch"')
        await submitInput(harness, '/fork')
        // Both forks race the stalled turn; wait for both branch files.
        const sessionDirectory = path.join(workspace.cwd, '.x-code', 'sessions')
        let files: string[] = []
        for (let attempt = 0; attempt < 50; attempt++) {
          files = (await fs.readdir(sessionDirectory)).filter((file) => file.endsWith('.jsonl'))
          if (files.length >= 3) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }

        const sessions = await Promise.all(files.map((file) => loadSession(path.join(sessionDirectory, file))))
        const branches = sessions.filter((session) => session?.forkedFrom)
        expect(branches).toHaveLength(2)
        const named = branches.find((session) => session?.name)
        const unnamed = branches.find((session) => !session?.name)
        expect(named!.name).toBe('doc branch')
        expect(unnamed).toBeDefined()
        for (const branch of branches) {
          expect(branch!.messages).toHaveLength(2)
          expect(JSON.stringify(branch!.messages)).toContain('shared context')
          expect(JSON.stringify(branch!.messages)).toContain('shared-answer')
          expect(JSON.stringify(branch!.messages)).not.toContain('generate document A')
        }
        await harness.waitForText(`xc --resume ${unnamed!.sessionId}`)
        expect(harness.raw()).toContain('xc --resume "doc branch"')
        expect(harness.raw()).toContain(`xc --resume ${unnamed!.sessionId}`)

        await exitTui(harness)
      },
    )
  })

  it('clears stale cells after deleting from a soft-wrapped line', async () => {
    const text = `${'0123456789'.repeat(5)}-TAILXYZ`
    await withTui(
      'input-wrap-delete',
      [],
      async ({ harness }) => {
        harness.write(text)
        await harness.waitForScreen((screen) => screen.includes('TAILXYZ'), 'wrapped input tail')
        expect(
          harness
            .screen()
            .filter(Boolean)
            .some((line) => line.includes('TAILXYZ')),
        ).toBe(true)

        harness.key('backspace')
        await harness.waitForScreen(
          (screen) => screen.includes('TAILXY') && !screen.includes('TAILXYZ'),
          'wrapped tail redraw after delete',
        )
      },
      { columns: 44, rows: 24 },
    )
  })

  it('navigates submitted history without mutating the stored entry', async () => {
    await withTui(
      'input-history',
      [
        { type: 'completion', text: 'answer-one' },
        { type: 'completion', text: 'answer-two' },
      ],
      async ({ harness }) => {
        await submitInput(harness, 'hi')
        await harness.waitForText('answer-one')
        await submitInput(harness, 'hey')
        await harness.waitForText('answer-two')

        harness.key('up')
        await harness.waitForScreen((screen) => screen.includes(`${GLYPH_PROMPT_ARROW} hey`), 'latest history entry')
        harness.key('end')
        await harness.settle()
        await typeInput(harness, '-edited')
        expect(inputLine(harness)).toBe(`${GLYPH_PROMPT_ARROW} hey-edited`)

        harness.key('down')
        await harness.waitForScreen(
          (screen) => screen.includes(GLYPH_PROMPT_ARROW) && !screen.includes(`${GLYPH_PROMPT_ARROW} hey-edited`),
          'draft restore',
        )
        harness.key('up')
        await harness.waitForScreen(
          (screen) => screen.includes(`${GLYPH_PROMPT_ARROW} hey`),
          'history entry restored again',
        )
        expect(inputLine(harness)).toBe(`${GLYPH_PROMPT_ARROW} hey`)
      },
    )
  })

  it('completes file names containing spaces, CJK, and special characters', async () => {
    await withTui(
      'input-file-completion',
      [],
      async ({ harness }) => {
        await typeInput(harness, '@设计')
        await harness.waitForScreen((screen) => screen.includes('@notes/设计 方案[1].md'), 'CJK file completion menu')

        harness.key('enter')
        await harness.waitForScreen(
          (screen) => screen.includes(`${GLYPH_PROMPT_ARROW} @"notes/设计 方案[1].md"`),
          'completed CJK file path',
        )
        await typeInput(harness, ' done')
        expect(inputLine(harness)).toContain('@"notes/设计 方案[1].md" done')
      },
      {
        beforeStart: async (workspace) => {
          await fs.mkdir(path.join(workspace.cwd, 'notes'), { recursive: true })
          await Promise.all([
            fs.writeFile(path.join(workspace.cwd, 'notes', '设计 方案[1].md'), 'design\n'),
            fs.writeFile(path.join(workspace.cwd, 'space file #1.txt'), 'space\n'),
          ])
        },
      },
    )
  })
})
