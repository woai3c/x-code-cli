import type { ShellSessionEvent } from '@x-code-cli/core'

import {
  createShellUiRuntime,
  flushCompletedShellWait,
  reduceShellSessionEvent,
  visibleBackgroundTerminals,
} from '../src/ui/agent/shell-session-ui.js'

const managerInstanceId = 'manager-a'

type EventInput = ShellSessionEvent extends infer Event
  ? Event extends ShellSessionEvent
    ? Omit<Event, 'ownerSessionId' | 'managerInstanceId' | 'occurredAt'>
    : never
  : never

function event(value: EventInput): ShellSessionEvent {
  return {
    ownerSessionId: 'owner-a',
    managerInstanceId,
    occurredAt: 100 + value.seq,
    ...value,
  } as ShellSessionEvent
}

describe('shell session UI reducer', () => {
  it('ignores stale generations and duplicate sequence numbers', () => {
    const initial = createShellUiRuntime(managerInstanceId)
    const started = event({
      kind: 'started',
      seq: 1,
      shellId: 'bg_1',
      originToolCallId: 'call-1',
      command: 'pnpm test',
      effectiveCwd: 'C:\\repo',
      tty: false,
      startedAt: 1,
    })
    const first = reduceShellSessionEvent(initial, started).runtime
    const duplicate = reduceShellSessionEvent(first, started).runtime
    const other = reduceShellSessionEvent(first, { ...started, managerInstanceId: 'manager-b', seq: 2 }).runtime

    expect(duplicate).toBe(first)
    expect(other).toBe(first)
  })

  it('shows a footer only after yield and removes it only on tree-confirmed exit', () => {
    let runtime = createShellUiRuntime(managerInstanceId)
    runtime = reduceShellSessionEvent(
      runtime,
      event({
        kind: 'started',
        seq: 1,
        shellId: 'bg_1',
        originToolCallId: 'call-1',
        command: 'pnpm test',
        effectiveCwd: 'C:\\repo',
        tty: false,
        startedAt: 1,
      }),
    ).runtime
    expect(visibleBackgroundTerminals(runtime.backgroundTerminals)).toHaveLength(0)

    runtime = reduceShellSessionEvent(
      runtime,
      event({ kind: 'yielded', seq: 2, shellId: 'bg_1', yieldAfterMs: 10_000, reason: 'deadline' }),
    ).runtime
    expect(visibleBackgroundTerminals(runtime.backgroundTerminals)).toHaveLength(1)

    runtime = reduceShellSessionEvent(
      runtime,
      event({ kind: 'root-exited', seq: 3, shellId: 'bg_1', exitCode: 0, treeConfirmedExited: false }),
    ).runtime
    expect(visibleBackgroundTerminals(runtime.backgroundTerminals)).toHaveLength(1)

    const finished = reduceShellSessionEvent(
      runtime,
      event({
        kind: 'exited',
        seq: 4,
        shellId: 'bg_1',
        exitCode: 0,
        durationMs: 1_000,
        wasYielded: true,
        timedOut: false,
        terminationConfirmed: true,
        spawnOutcome: 'ready',
        cleanupResidual: false,
        rootExited: true,
        treeConfirmedExited: true,
        recentOutput: '',
        uiOmittedBytes: 0,
      }),
    )
    expect(visibleBackgroundTerminals(finished.runtime.backgroundTerminals)).toHaveLength(0)
    expect(finished.notices[0]?.content).toContain('Background terminal finished')
  })

  it('keeps consecutive waits as one streak until the turn flushes it', () => {
    let runtime = createShellUiRuntime(managerInstanceId)
    runtime = reduceShellSessionEvent(
      runtime,
      event({
        kind: 'started',
        seq: 1,
        shellId: 'bg_1',
        originToolCallId: 'call-1',
        command: 'pnpm lint',
        effectiveCwd: 'C:\\repo',
        tty: false,
        startedAt: 1,
      }),
    ).runtime
    runtime = reduceShellSessionEvent(
      runtime,
      event({ kind: 'wait-started', seq: 2, shellId: 'bg_1', toolCallId: 'wait-1', chars: '' }),
    ).runtime
    runtime = reduceShellSessionEvent(
      runtime,
      event({ kind: 'wait-finished', seq: 3, shellId: 'bg_1', toolCallId: 'wait-1', chars: '', running: true }),
    ).runtime
    runtime = reduceShellSessionEvent(
      runtime,
      event({ kind: 'wait-started', seq: 4, shellId: 'bg_1', toolCallId: 'wait-2', chars: '' }),
    ).runtime
    runtime = reduceShellSessionEvent(
      runtime,
      event({ kind: 'wait-finished', seq: 5, shellId: 'bg_1', toolCallId: 'wait-2', chars: '', running: true }),
    ).runtime

    const flushed = flushCompletedShellWait(runtime, 200)
    expect(flushed.notices).toHaveLength(1)
    expect(flushed.notices[0]?.content).toBe('• Waited for background terminal · pnpm lint')
    expect(flushed.runtime.shellWaitStreak).toBeNull()
  })

  it('does not present PTY resize as a passive background wait', () => {
    const runtime = reduceShellSessionEvent(
      createShellUiRuntime(managerInstanceId),
      event({
        kind: 'wait-started',
        seq: 1,
        shellId: 'bg_1',
        toolCallId: 'resize-1',
        chars: '',
        cols: 100,
        rows: 35,
      }),
    ).runtime

    expect(runtime.shellWaitStreak).toBeNull()
  })
})
