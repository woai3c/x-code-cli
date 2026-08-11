import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import path from 'node:path'

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
      await harness.waitForText('X-Code wants to run a shell command')
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
      await harness.waitForText('X-Code wants to write a file')
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
      await harness.waitForText('X-Code wants to write a file')
      expect(harness.text()).toContain('all edits this session')
      harness.key('down')
      await harness.waitForScreen((screen) => screen.includes("❯ Yes, don't ask again"), 'always option selected')
      harness.key('enter')
      await harness.waitForText('first-write-done')
      await waitFor(() => pathExists(first), 'first always-approved file')

      await submitInput(harness, 'second edit')
      await harness.waitForText('second-write-done')
      await waitFor(() => pathExists(second), 'second edit auto-approved')

      await submitInput(harness, 'unrelated shell action')
      await harness.waitForText('X-Code wants to run a shell command')
      expect(await pathExists(shellTarget)).toBe(false)
      harness.write('n')
      await harness.waitForText('shell-denied-after-scope-check')
      expect(await pathExists(shellTarget)).toBe(false)
    })
  })

  it('keeps workspace writes gated in plan mode', async () => {
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
        await harness.waitForText('X-Code wants to write a file')
        expect(harness.text()).toContain('not-the-plan.txt')
        harness.write('n')
        await harness.waitForText('plan-write-denied')
        expect(await pathExists(target)).toBe(false)
      },
      { args: ['--plan'] },
    )
  })
})
