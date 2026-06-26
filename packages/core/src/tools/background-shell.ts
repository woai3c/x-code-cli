// @x-code-cli/core — background shell registry + shellOutput / killShell tools
//
// A foreground shell call blocks the turn until the command exits — fine for
// `git status`, useless for `npm run dev` / `vitest --watch` / a long build
// the model wants to start and then keep working alongside. `runInBackground`
// spawns the command detached, accumulates its output in a buffer, and returns
// an id immediately. The model later polls with `shellOutput` or stops it with
// `killShell`.
//
// The registry lives on LoopState so each agent (sub-agents get a fresh
// LoopState) owns its own background shells — one agent can't read or kill
// another's. execa spawns with `cleanup: true` by default, so any still-running
// child is killed when the CLI process exits; no separate session teardown is
// needed.
import type { ResultPromise } from 'execa'

import { tool } from 'ai'

import { z } from 'zod'

import { getShellProvider } from './shell-provider.js'

// Hard ceiling so a forgotten background shell can't run forever. 30 min is
// generous for dev servers / watchers without being truly unbounded.
const BG_MAX_MS = 30 * 60 * 1000

// Cap on retained output per shell. We spawn with execa `buffer: false` (so a
// noisy dev server isn't SIGTERM'd at execa's 20 MB maxBuffer) and accumulate
// the streams ourselves — this ring cap keeps that accumulation from growing
// without bound over a long-lived process. Oldest output is dropped first.
const BG_BUFFER_MAX = 1024 * 1024 // 1 MB

export interface BackgroundShell {
  id: string
  command: string
  proc: ResultPromise
  /** Combined stdout + stderr in arrival order. */
  buffer: string
  /** How far into `buffer` shellOutput has already returned (moving cursor). */
  cursor: number
  status: 'running' | 'exited'
  exitCode: number | null
}

export class BackgroundShellRegistry {
  private shells = new Map<string, BackgroundShell>()
  private counter = 0

  /** bufferMax is injectable so tests can exercise ring-trimming with a tiny
   *  cap instead of having to generate a megabyte of real output. */
  constructor(private bufferMax: number = BG_BUFFER_MAX) {}

  /** Spawn a detached shell, begin accumulating its output, return its id. */
  start(command: string): string {
    const id = `bg_${++this.counter}`
    // No per-command timeout knob here: background shells are meant to outlive
    // the turn. BG_MAX_MS is only a runaway backstop. buffer:false hands us the
    // raw child streams instead of letting execa buffer (and 20 MB-cap) them —
    // we keep our own bounded copy below.
    const proc = getShellProvider().spawn(command, { timeout: BG_MAX_MS, buffer: false })
    const entry: BackgroundShell = {
      id,
      command,
      proc,
      buffer: '',
      cursor: 0,
      status: 'running',
      exitCode: null,
    }
    const bufferMax = this.bufferMax
    const onData = (chunk: Buffer) => {
      entry.buffer += chunk.toString()
      // Ring-trim to the cap: drop the oldest overflow and slide the read
      // cursor so still-unread output keeps lining up. A drain that lagged far
      // behind a flood may miss the very oldest bytes — acceptable for a
      // watcher that outran its reader; the alternative is unbounded memory.
      if (entry.buffer.length > bufferMax) {
        const overflow = entry.buffer.length - bufferMax
        entry.buffer = entry.buffer.slice(overflow)
        entry.cursor = Math.max(0, entry.cursor - overflow)
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    // The provider spawns with reject:false, so this settles on both normal and
    // failing exits; the rejection arm is defensive (e.g. the BG_MAX_MS timeout).
    void proc.then(
      (res) => {
        entry.status = 'exited'
        entry.exitCode = res.exitCode ?? null
      },
      () => {
        entry.status = 'exited'
        if (entry.exitCode == null) entry.exitCode = 1
      },
    )
    this.shells.set(id, entry)
    return id
  }

  get(id: string): BackgroundShell | undefined {
    return this.shells.get(id)
  }

  /** Return output appended since the last read and advance the cursor. */
  drain(id: string): string {
    const entry = this.shells.get(id)
    if (!entry) return ''
    const out = entry.buffer.slice(entry.cursor)
    entry.cursor = entry.buffer.length
    return out
  }

  kill(id: string): boolean {
    const entry = this.shells.get(id)
    if (!entry) return false
    entry.proc.kill()
    entry.status = 'exited'
    return true
  }

  list(): BackgroundShell[] {
    return [...this.shells.values()]
  }
}

export const shellOutput = tool({
  description: `Read new output from a background shell started by shell({ runInBackground: true }).

- Returns only the output produced since your last shellOutput call for this shell (a moving cursor), plus the shell's running/exited status and exit code.
- Set block: true to wait until the shell exits (or the timeout elapses) before returning — useful when you need the final result of a background build/test.`,
  inputSchema: z.object({
    shellId: z.string().describe('The background shell id returned by shell({ runInBackground: true }) (e.g. "bg_1")'),
    block: z.boolean().optional().describe('Wait until the shell exits (or timeout) before returning (default: false)'),
    timeout: z.number().optional().describe('Max ms to wait when block is true (default: 30000)'),
  }),
  // No execute — handled manually in tool-execution.ts (needs LoopState).
})

export const killShell = tool({
  description: `Terminate a background shell started by shell({ runInBackground: true }).`,
  inputSchema: z.object({
    shellId: z.string().describe('The background shell id to terminate (e.g. "bg_1")'),
  }),
  // No execute — handled manually in tool-execution.ts (needs LoopState).
})
