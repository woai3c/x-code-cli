// Integration tests for the background shell registry. These spawn real child
// processes (echo / sleep) through the same provider the shell tool uses, so
// they exercise the spawn → buffer → drain → exit-status path end-to-end.
import { describe, expect, it } from 'vitest'

import { BackgroundShellRegistry } from '../src/tools/background-shell.js'
import { getShellProvider } from '../src/tools/shell-provider.js'

const isPowerShell = getShellProvider().type === 'powershell'
// A command that runs long enough to be killed mid-flight on either platform.
const SLEEP_30 = isPowerShell ? 'Start-Sleep -Seconds 30' : 'sleep 30'

async function waitExited(reg: BackgroundShellRegistry, id: string, ms = 8000) {
  const entry = reg.get(id)!
  const deadline = Date.now() + ms
  while (entry.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  return entry
}

describe('BackgroundShellRegistry', () => {
  it('captures output and records the exit status of a finished command', async () => {
    const reg = new BackgroundShellRegistry()
    const id = reg.start('echo background-test')
    expect(id).toBe('bg_1')

    const entry = await waitExited(reg, id)
    expect(entry.status).toBe('exited')
    expect(entry.exitCode).toBe(0)

    const out = reg.drain(id)
    expect(out).toContain('background-test')
    // The cursor advanced — a second poll sees nothing new.
    expect(reg.drain(id)).toBe('')
  })

  it('ring-trims retained output to the buffer cap, dropping the oldest', async () => {
    // Tiny cap so a short echo (~15 bytes) overflows it without us having to
    // generate a real megabyte of output.
    const reg = new BackgroundShellRegistry(8)
    const id = reg.start('echo background-test')
    const entry = await waitExited(reg, id)
    expect(entry.status).toBe('exited')
    // The accumulator never exceeds the cap even though the command printed
    // more than 8 bytes — the oldest bytes were trimmed away.
    expect(entry.buffer.length).toBeLessThanOrEqual(8)
  })

  it('kill() terminates a running shell and marks it exited', () => {
    const reg = new BackgroundShellRegistry()
    const id = reg.start(SLEEP_30)
    const entry = reg.get(id)!
    expect(entry.status).toBe('running')

    expect(reg.kill(id)).toBe(true)
    expect(entry.status).toBe('exited')
  })

  it('assigns incrementing ids and lists every shell', () => {
    const reg = new BackgroundShellRegistry()
    const a = reg.start(SLEEP_30)
    const b = reg.start(SLEEP_30)
    expect([a, b]).toEqual(['bg_1', 'bg_2'])
    expect(reg.list().map((s) => s.id)).toEqual(['bg_1', 'bg_2'])
    // Don't leak the sleepers past the test.
    reg.kill(a)
    reg.kill(b)
  })

  it('returns falsy for unknown shell ids', () => {
    const reg = new BackgroundShellRegistry()
    expect(reg.get('bg_99')).toBeUndefined()
    expect(reg.drain('bg_99')).toBe('')
    expect(reg.kill('bg_99')).toBe(false)
  })
})
