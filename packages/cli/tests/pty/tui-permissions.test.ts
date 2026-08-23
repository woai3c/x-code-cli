import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import path from 'node:path'

import { GLYPH_SELECT_POINTER } from '../../src/ui/render/terminal-glyphs.js'
import { waitFor } from '../fixtures/cli-test-helpers.js'
import { submitInput, withTui } from './test-context.js'

async function pathExists(file: string): Promise<boolean> {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false)
}

describe('TUI permissions', () => {
  it('shows the exact command and target before an ask-level shell action', async () => {
    await withTui('permissions-ask', [], async ({ harness, provider, workspace }) => {
      const target = path.join(workspace.cwd, 'ask-target.txt')
      provider.enqueue({
        type: 'tool-call',
        name: 'shell',
        input: { command: 'touch ask-target.txt' },
        finalText: 'ask-denied',
      })

      await submitInput(harness, 'run the requested command')
      await harness.waitForText('Would you like to run the following command?')
      expect(harness.text()).toContain('$ touch ask-target.txt')
      expect(harness.text()).toContain('[write]')
      expect(harness.text()).toContain("Yes, don't ask again")

      harness.write('n')
      await harness.waitForText('ask-denied')
      expect(await pathExists(target)).toBe(false)
    })
  })

  it('returns a structured denial to the agent without executing writeFile', async () => {
    await withTui('permissions-deny', [], async ({ harness, provider, workspace }) => {
      const target = path.join(workspace.cwd, 'denied.txt')
      provider.enqueue({
        type: 'tool-call',
        name: 'writeFile',
        input: { filePath: target, content: 'must not exist\n' },
        finalText: 'denial-observed',
      })

      await submitInput(harness, 'try a denied write')
      await harness.waitForText('Would you like to write the following file?')
      expect(harness.text()).toContain('denied.txt')
      harness.write('n')
      await harness.waitForText('denial-observed')

      expect(await pathExists(target)).toBe(false)
      const requests = await provider.waitForMainRequests(2)
      expect(JSON.stringify(requests[1]!.messages)).toMatch(/permission denied/i)
      expect(requests[1]!.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool' })]))
    })
  })

  it('scopes always-allow to edits and still asks for an unrelated shell command', async () => {
    await withTui('permissions-always-scope', [], async ({ harness, provider, workspace }) => {
      const first = path.join(workspace.cwd, 'always-one.txt')
      const second = path.join(workspace.cwd, 'always-two.txt')
      const shellTarget = path.join(workspace.cwd, 'shell-still-asks.txt')
      provider.enqueue(
        {
          type: 'tool-call',
          name: 'writeFile',
          input: { filePath: first, content: 'one\n' },
          finalText: 'first-write-done',
        },
        {
          type: 'tool-call',
          name: 'writeFile',
          input: { filePath: second, content: 'two\n' },
          finalText: 'second-write-done',
        },
        {
          type: 'tool-call',
          name: 'shell',
          input: { command: 'touch shell-still-asks.txt' },
          finalText: 'shell-denied-after-scope-check',
        },
      )

      await submitInput(harness, 'first edit')
      await harness.waitForText('Would you like to write the following file?')
      expect(harness.text()).toContain('all edits this session')
      harness.key('down')
      await harness.waitForScreen(
        (screen) => screen.includes(`${GLYPH_SELECT_POINTER} 2. Yes, don't ask again`),
        'always option selected',
      )
      harness.key('enter')
      await harness.waitForText('first-write-done')
      await waitFor(() => pathExists(first), 'first always-approved file')

      await submitInput(harness, 'second edit')
      await harness.waitForText('second-write-done')
      await waitFor(() => pathExists(second), 'second edit auto-approved')

      await submitInput(harness, 'unrelated shell action')
      await harness.waitForText('Would you like to run the following command?')
      expect(await pathExists(shellTarget)).toBe(false)
      harness.write('n')
      await harness.waitForText('shell-denied-after-scope-check')
      expect(await pathExists(shellTarget)).toBe(false)
    })
  })

  it('denies with inline feedback and returns it to the agent', async () => {
    await withTui('permissions-feedback', [], async ({ harness, provider, workspace }) => {
      const target = path.join(workspace.cwd, 'feedback-target.txt')
      provider.enqueue({
        type: 'tool-call',
        name: 'shell',
        input: { command: 'touch feedback-target.txt' },
        finalText: 'feedback-denied',
      })

      await submitInput(harness, 'run the requested command')
      await harness.waitForText('Would you like to run the following command?')
      expect(harness.text()).toContain('No, and tell X-Code what to do instead')

      // 'f' opens the inline feedback editor on the last option row.
      harness.write('f')
      await harness.waitForText('Type your feedback, then press Enter to submit')
      harness.write('use a different directory')
      // Wait for the typed text to paint so the Enter handler reads the
      // updated buffer (the whole string lands as one setState).
      await harness.waitForText('No: use a different directory')
      harness.key('enter')
      await harness.waitForText('feedback-denied')

      expect(await pathExists(target)).toBe(false)
      const requests = await provider.waitForMainRequests(2)
      expect(JSON.stringify(requests[1]!.messages)).toContain('User feedback: use a different directory')
    })
  })

  it('updates plan-mode context usage without leaving stale digits', async () => {
    await withTui(
      'permissions-plan-footer',
      [
        { type: 'completion', text: 'first-footer', usage: { promptTokens: 189000, completionTokens: 100 } },
        { type: 'completion', text: 'second-footer', usage: { promptTokens: 191700, completionTokens: 100 } },
      ],
      async ({ harness }) => {
        expect(harness.text()).toContain('plan mode')
        expect(harness.text()).not.toContain('\u23f8')

        await submitInput(harness, '/context 258400')
        await harness.waitForText('Context window forced to')
        await submitInput(harness, 'first context sample')
        await harness.waitForText('first-footer')
        await harness.waitForText('ctx 189.1k / 258.4k · 73%')

        await submitInput(harness, 'second context sample')
        await harness.waitForText('second-footer')
        await harness.waitForText('ctx 191.8k / 258.4k · 74%')
        expect(harness.text()).not.toContain('1891.8k')
        harness.key('ctrl-c')
      },
      { args: ['--plan'] },
    )
  })

  it('rejects workspace writes before approval in plan mode', async () => {
    await withTui(
      'permissions-plan-mode',
      [],
      async ({ harness, provider, workspace }) => {
        const target = path.join(workspace.cwd, 'not-the-plan.txt')
        provider.enqueue({
          type: 'tool-call',
          name: 'writeFile',
          input: { filePath: target, content: 'not allowed\n' },
          finalText: 'plan-write-denied',
        })

        expect(harness.text()).toContain('plan mode')
        await submitInput(harness, 'attempt a workspace write while planning')
        await harness.waitForText('plan mode may only modify the current session plan file')
        await harness.waitForText('plan-write-denied')
        expect(harness.text()).not.toContain('Would you like to write the following file?')
        expect(await pathExists(target)).toBe(false)
      },
      { args: ['--plan'] },
    )
  })
})
