import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import path from 'node:path'

import { readSessionJsonl, waitFor } from '../fixtures/cli-test-helpers.js'
import { submitInput, typeInput, withTui } from './test-context.js'

const itPosix = it.runIf(process.platform !== 'win32')

async function pathExists(file: string): Promise<boolean> {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false)
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('TUI interruption', () => {
  it('cancels while waiting for the first token and accepts another prompt', async () => {
    await withTui(
      'interrupt-first-token',
      [
        { type: 'stall', afterHeaders: true },
        { type: 'completion', text: 'recovered-after-first-token' },
      ],
      async ({ harness, provider }) => {
        await submitInput(harness, 'hi')
        await provider.waitForMainRequests(1)
        await harness.waitForText('Thinking')
        harness.key('ctrl-c')
        await harness.waitForText('Press Ctrl+C again to exit')
        await waitFor(() => provider.mainRequests()[0]?.cancelled === true, 'first-token request cancellation')
        await harness.waitForScreen(
          (screen) => screen.includes('[Request interrupted by user]') && !screen.includes('Thinking'),
          'idle prompt after first-token interrupt',
        )

        await submitInput(harness, 'hi')
        await harness.waitForText('recovered-after-first-token')
        expect(provider.mainRequests()).toHaveLength(2)
      },
    )
  })

  it('cancels a response after streamed text without committing the remaining chunks', async () => {
    await withTui(
      'interrupt-stream',
      [
        {
          type: 'completion',
          text: '',
          chunks: ['VISIBLE-BEFORE-ABORT\n', 'MUST-NOT-COMMIT'],
          chunkDelayMs: 700,
        },
        { type: 'completion', text: 'stream-recovery-ok' },
      ],
      async ({ harness, provider }) => {
        await submitInput(harness, 'hi')
        await harness.waitForText('VISIBLE-BEFORE-ABORT')
        harness.key('ctrl-c')
        await harness.waitForText('Press Ctrl+C again to exit')
        await waitFor(() => provider.mainRequests()[0]?.cancelled === true, 'stream request cancellation')
        expect(harness.raw()).not.toContain('MUST-NOT-COMMIT')

        await submitInput(harness, 'hi')
        await harness.waitForText('stream-recovery-ok')
      },
    )
  })

  it('cancels a pending permission without executing the tool', async () => {
    await withTui('interrupt-permission', [], async ({ harness, provider, workspace }) => {
      const target = path.join(workspace.cwd, 'permission-interrupt.txt')
      provider.enqueue({
        type: 'tool-call',
        name: 'writeFile',
        input: { filePath: target, content: 'no\n' },
        finalText: 'permission-interrupt-recovery',
      })

      await submitInput(harness, 'interrupt this permission')
      await harness.waitForText('X-Code wants to write a file')
      harness.key('ctrl-c')
      await harness.waitForText('Press Ctrl+C again to exit')
      await harness.waitForScreen(
        (screen) => !screen.includes('X-Code wants to write a file'),
        'permission dialog closed after interrupt',
      )
      expect(await pathExists(target)).toBe(false)

      await submitInput(harness, 'hi')
      await harness.waitForText('permission-interrupt-recovery')
      expect(await pathExists(target)).toBe(false)
    })
  })

  itPosix('keeps an interrupted shell session alive until /stop terminates its process tree', async () => {
    await withTui('interrupt-shell', [], async ({ harness, provider, workspace }) => {
      const pidFile = path.join(workspace.cwd, 'shell-child.pid')
      const finishedFile = path.join(workspace.cwd, 'shell-child.finished')
      const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(finishedFile)},'done'),30000)`
      const encodedScript = Buffer.from(script).toString('base64')
      provider.enqueue({
        type: 'tool-call',
        name: 'shell',
        input: { command: `node -e "eval(Buffer.from('${encodedScript}','base64').toString())"` },
        finalText: 'shell-interrupt-recovery',
      })

      await submitInput(harness, 'run and interrupt a child')
      await harness.waitForText('X-Code wants to run a shell command')
      harness.write('y')
      await waitFor(() => pathExists(pidFile), 'shell child pid file')
      const pid = Number(await fs.readFile(pidFile, 'utf-8'))
      expect(processExists(pid)).toBe(true)

      harness.key('ctrl-c')
      await harness.waitForText('Press Ctrl+C again to exit')
      await harness.waitForText('[Request interrupted by user]')
      expect(processExists(pid)).toBe(true)

      await submitInput(harness, '/stop')
      await harness.waitForText('Stopped 1 background terminal.')
      await waitFor(() => !processExists(pid), 'shell child termination', 5000)
      expect(await pathExists(finishedFile)).toBe(false)

      await submitInput(harness, 'hi')
      await harness.waitForText('shell-interrupt-recovery')
    })
  })

  it('propagates cancellation into a running sub-agent', async () => {
    await withTui(
      'interrupt-sub-agent',
      [
        {
          type: 'tool-call',
          name: 'task',
          input: {
            description: 'Inspect test workspace',
            subagent_type: 'explore',
            prompt: 'Inspect the empty test workspace and report what you find.',
          },
        },
        { type: 'stall', afterHeaders: true },
        { type: 'completion', text: 'sub-agent-recovery-ok' },
      ],
      async ({ harness, provider }) => {
        await submitInput(harness, 'delegate this')
        await provider.waitForMainRequests(2, 10_000)
        await harness.waitForText(/Task|Explore|Running/i, 10_000)
        harness.key('ctrl-c')
        await harness.waitForText('Press Ctrl+C again to exit')
        await waitFor(() => provider.mainRequests()[1]?.cancelled === true, 'sub-agent request cancellation', 5000)
        await harness.waitForText('[Request interrupted by user')

        await submitInput(harness, 'hi')
        await harness.waitForText('sub-agent-recovery-ok', 10_000)
      },
    )
  })

  it('keeps session JSONL valid and usable after an interrupted turn', async () => {
    await withTui(
      'interrupt-session',
      [
        { type: 'stall', afterHeaders: true },
        { type: 'completion', text: 'session-recovery-ok' },
      ],
      async ({ harness, provider, workspace }) => {
        await submitInput(harness, 'session interruption check')
        await provider.waitForMainRequests(1)
        harness.key('ctrl-c')
        await harness.waitForText('Press Ctrl+C again to exit')
        await waitFor(() => provider.mainRequests()[0]?.cancelled === true, 'session request cancellation')
        await harness.waitForText('[Request interrupted by user]')

        await waitFor(
          async () => JSON.stringify(await readSessionJsonl(workspace.cwd)).includes('[Request interrupted by user]'),
          'interruption persisted to session JSONL',
        )
        const interrupted = await readSessionJsonl(workspace.cwd)
        expect(interrupted[0]).toMatchObject({ t: 'meta', kind: 'header' })
        expect(JSON.stringify(interrupted)).toContain('[Request interrupted by user]')

        await submitInput(harness, 'hi')
        await harness.waitForText('session-recovery-ok')
        const recovered = await readSessionJsonl(workspace.cwd)
        expect(JSON.stringify(recovered)).toContain('session-recovery-ok')
        await typeInput(harness, 'session-still-editable')
      },
    )
  })
})
