import type {
  DisplayMessage,
  ShellFailure,
  ShellSessionEvent,
  ShellSessionSummary,
  TerminationReason,
} from '@x-code-cli/core'

export interface BackgroundTerminalView {
  managerInstanceId: string
  shellId: string
  command: string
  effectiveCwd: string
  status:
    | 'starting'
    | 'running'
    | 'root-exited'
    | 'terminating'
    | 'termination-failed'
    | 'finalizing'
    | 'exited'
    | 'failed'
  spawnOutcome: 'pending' | 'ready' | 'failed'
  cleanupResidual: boolean
  yielded: boolean
  exitCode?: number
  failure?: ShellFailure
  timedOut: boolean
  terminationReason?: TerminationReason
  terminationConfirmed?: boolean
  exitedSeq?: number
  rootExited: boolean
  treeConfirmedExited: boolean
  startedAt?: number
  recentLines: string[]
}

export interface ShellWaitStreak {
  managerInstanceId: string
  shellId: string
  toolCallId: string
  command?: string
  startedAt: number
  waiting: boolean
}

export interface ShellUiRuntime {
  managerInstanceId: string
  lastSeq: number
  backgroundTerminals: BackgroundTerminalView[]
  shellWaitStreak: ShellWaitStreak | null
}

export interface ShellUiReduction {
  runtime: ShellUiRuntime
  notices: DisplayMessage[]
}

function recentLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
}

function viewFromSummary(summary: ShellSessionSummary): BackgroundTerminalView {
  return {
    managerInstanceId: summary.managerInstanceId,
    shellId: summary.shellId,
    command: summary.command,
    effectiveCwd: summary.effectiveCwd,
    status: summary.status,
    spawnOutcome: summary.spawnOutcome,
    cleanupResidual: summary.cleanupResidual,
    yielded: summary.yielded,
    exitCode: summary.exitCode,
    failure: summary.failure,
    timedOut: summary.timedOut,
    terminationReason: summary.terminationReason,
    terminationConfirmed: summary.terminationConfirmed,
    exitedSeq: summary.exitedSeq,
    rootExited: summary.rootExited,
    treeConfirmedExited: summary.treeConfirmedExited,
    startedAt: summary.startedAt,
    recentLines: recentLines(summary.recentOutput),
  }
}

function notice(content: string, event: ShellSessionEvent, suffix: string): DisplayMessage {
  return {
    id: `shell-ui-${event.managerInstanceId}-${event.seq}-${suffix}`,
    role: 'assistant',
    content,
    timestamp: event.occurredAt,
    kind: 'command-result',
  }
}

export function waitNotice(wait: ShellWaitStreak, timestamp = Date.now()): DisplayMessage {
  return {
    id: `shell-wait-${wait.managerInstanceId}-${wait.toolCallId}-${timestamp}`,
    role: 'assistant',
    content: `• Waited for background terminal${wait.command ? ` · ${wait.command}` : ''}`,
    timestamp,
    kind: 'command-result',
  }
}

function replaceTerminal(
  terminals: BackgroundTerminalView[],
  shellId: string,
  update: (current: BackgroundTerminalView) => BackgroundTerminalView,
): BackgroundTerminalView[] {
  const index = terminals.findIndex((terminal) => terminal.shellId === shellId)
  if (index < 0) return terminals
  const next = terminals.slice()
  next[index] = update(next[index]!)
  return next
}

function commandFor(runtime: ShellUiRuntime, shellId: string): string | undefined {
  return runtime.backgroundTerminals.find((terminal) => terminal.shellId === shellId)?.command
}

export function createShellUiRuntime(managerInstanceId: string): ShellUiRuntime {
  return { managerInstanceId, lastSeq: -1, backgroundTerminals: [], shellWaitStreak: null }
}

export function reduceShellSessionEvent(current: ShellUiRuntime, event: ShellSessionEvent): ShellUiReduction {
  if (event.managerInstanceId !== current.managerInstanceId || event.seq <= current.lastSeq) {
    return { runtime: current, notices: [] }
  }

  let runtime: ShellUiRuntime = { ...current, lastSeq: event.seq }
  const notices: DisplayMessage[] = []

  if (event.kind === 'snapshot') {
    runtime = {
      ...runtime,
      backgroundTerminals: event.sessions.map(viewFromSummary),
    }
    return { runtime, notices }
  }

  if (event.kind === 'started') {
    runtime = {
      ...runtime,
      backgroundTerminals: [
        ...runtime.backgroundTerminals.filter((terminal) => terminal.shellId !== event.shellId),
        {
          managerInstanceId: event.managerInstanceId,
          shellId: event.shellId,
          command: event.command,
          effectiveCwd: event.effectiveCwd,
          status: 'running',
          spawnOutcome: 'ready',
          cleanupResidual: false,
          yielded: false,
          timedOut: false,
          rootExited: false,
          treeConfirmedExited: false,
          startedAt: event.startedAt,
          recentLines: [],
        },
      ],
    }
  } else if (event.kind === 'residual-registered') {
    runtime = {
      ...runtime,
      backgroundTerminals: [
        ...runtime.backgroundTerminals.filter((terminal) => terminal.shellId !== event.shellId),
        {
          managerInstanceId: event.managerInstanceId,
          shellId: event.shellId,
          command: event.command,
          effectiveCwd: event.effectiveCwd,
          status: 'termination-failed',
          spawnOutcome: 'failed',
          cleanupResidual: true,
          yielded: false,
          failure: event.failure,
          timedOut: false,
          rootExited: false,
          treeConfirmedExited: false,
          recentLines: [],
        },
      ],
    }
  } else if (event.kind === 'yielded') {
    runtime = {
      ...runtime,
      backgroundTerminals: replaceTerminal(runtime.backgroundTerminals, event.shellId, (terminal) => ({
        ...terminal,
        yielded: true,
      })),
    }
  } else if (event.kind === 'output') {
    runtime = {
      ...runtime,
      backgroundTerminals: replaceTerminal(runtime.backgroundTerminals, event.shellId, (terminal) => ({
        ...terminal,
        recentLines: recentLines([...terminal.recentLines, event.chunk].join('\n')),
      })),
    }
  } else if (event.kind === 'root-exited') {
    const terminal = runtime.backgroundTerminals.find((entry) => entry.shellId === event.shellId)
    runtime = {
      ...runtime,
      backgroundTerminals: replaceTerminal(runtime.backgroundTerminals, event.shellId, (terminal) => ({
        ...terminal,
        status: 'root-exited',
        rootExited: true,
        exitCode: event.exitCode,
      })),
    }
    if (terminal?.yielded) {
      notices.push(
        notice(`• Root exited; cleaning up background process tree · ${terminal.command}`, event, 'root-exited'),
      )
    }
  } else if (event.kind === 'wait-started' && event.chars === '' && event.cols === undefined) {
    const previous = runtime.shellWaitStreak
    if (previous && !previous.waiting && previous.shellId !== event.shellId)
      notices.push(waitNotice(previous, event.occurredAt))
    runtime = {
      ...runtime,
      shellWaitStreak: {
        managerInstanceId: event.managerInstanceId,
        shellId: event.shellId,
        toolCallId: event.toolCallId,
        command: commandFor(runtime, event.shellId),
        startedAt: event.occurredAt,
        waiting: true,
      },
    }
  } else if (event.kind === 'wait-finished' && event.chars === '' && event.cols === undefined) {
    if (runtime.shellWaitStreak?.toolCallId === event.toolCallId) {
      runtime = { ...runtime, shellWaitStreak: { ...runtime.shellWaitStreak, waiting: false } }
    }
  } else if (event.kind === 'termination-failed') {
    const terminal = runtime.backgroundTerminals.find((entry) => entry.shellId === event.shellId)
    runtime = {
      ...runtime,
      backgroundTerminals: replaceTerminal(runtime.backgroundTerminals, event.shellId, (entry) => ({
        ...entry,
        status: 'termination-failed',
        failure: event.failure,
        terminationReason: event.reason,
        terminationConfirmed: false,
      })),
    }
    notices.push(
      notice(
        terminal?.cleanupResidual
          ? `• Command failed to start; cleanup is unconfirmed · ${terminal.command} · /stop to retry`
          : `• Could not confirm background terminal stopped${terminal ? ` · ${terminal.command}` : ''} · /stop to retry`,
        event,
        'termination-failed',
      ),
    )
  } else if (event.kind === 'exited') {
    const terminal = runtime.backgroundTerminals.find((entry) => entry.shellId === event.shellId)
    if (runtime.shellWaitStreak?.shellId === event.shellId) {
      notices.push(waitNotice({ ...runtime.shellWaitStreak, waiting: false }, event.occurredAt))
      runtime = { ...runtime, shellWaitStreak: null }
    }
    if (event.cleanupResidual) {
      notices.push(
        notice(
          `• Background process cleanup completed${terminal ? ` · ${terminal.command}` : ''}`,
          event,
          'cleanup-complete',
        ),
      )
    } else if (event.wasYielded) {
      const exit = event.exitCode !== undefined ? `exit ${event.exitCode}` : (event.signal ?? 'exited')
      notices.push(
        notice(
          `• Background terminal finished${terminal ? ` · ${terminal.command}` : ''} · ${exit} · ${(event.durationMs / 1_000).toFixed(1)}s`,
          event,
          'finished',
        ),
      )
    }
    runtime = {
      ...runtime,
      backgroundTerminals: runtime.backgroundTerminals.filter((entry) => entry.shellId !== event.shellId),
    }
  }

  return { runtime, notices }
}

export function flushCompletedShellWait(runtime: ShellUiRuntime, timestamp = Date.now()): ShellUiReduction {
  if (!runtime.shellWaitStreak || runtime.shellWaitStreak.waiting) return { runtime, notices: [] }
  return {
    runtime: { ...runtime, shellWaitStreak: null },
    notices: [waitNotice(runtime.shellWaitStreak, timestamp)],
  }
}

export function visibleBackgroundTerminals(terminals: readonly BackgroundTerminalView[]): BackgroundTerminalView[] {
  return terminals.filter((terminal) => !terminal.treeConfirmedExited && (terminal.yielded || terminal.cleanupResidual))
}
