import type { ShellSessionSummary, TerminateAllResult } from '@x-code-cli/core'

function safeText(value: string): string {
  return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

function elapsed(startedAt: number | undefined, now = Date.now()): string {
  if (!startedAt) return 'starting'
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

export function formatBackgroundTerminals(sessions: readonly ShellSessionSummary[], now = Date.now()): string {
  const allLive = sessions.filter((session) => !session.treeConfirmedExited)
  const live = allLive.slice(0, 16)
  if (live.length === 0) return 'No running background terminals.'
  const lines = ['Background terminals']
  for (const session of live) {
    const state = session.cleanupResidual
      ? 'cleanup unconfirmed'
      : session.status === 'termination-failed'
        ? 'stop unconfirmed'
        : elapsed(session.startedAt, now)
    lines.push(`  • ${safeText(session.shellId)} · ${safeText(session.command)} · ${state}`)
    for (const output of session.recentOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)) {
      lines.push(`    ↳ ${safeText(output)}`)
    }
  }
  if (allLive.length > live.length) {
    lines.push(`  … ${allLive.length - live.length} more`)
  }
  return lines.join('\n')
}

export function formatStopResult(result: TerminateAllResult | null): string {
  if (!result || result.requested === 0) return 'No running background terminals.'
  const failed = result.results.filter((entry) => !entry.treeConfirmedExited)
  const stopped = result.confirmed
  const alreadyExited =
    result.alreadyExited > 0
      ? `; ${result.alreadyExited} background terminal${result.alreadyExited === 1 ? '' : 's'} had already exited`
      : ''
  if (failed.length === 0) {
    return `Stopped ${stopped} background terminal${stopped === 1 ? '' : 's'}${alreadyExited}.`
  }
  const lines = [
    `Stopped ${stopped} background terminal${stopped === 1 ? '' : 's'}${alreadyExited}; ${failed.length} could not be confirmed stopped.`,
  ]
  for (const entry of failed) {
    lines.push(
      `  • ${safeText(entry.shellId)} · ${entry.failure?.code ?? 'termination-unconfirmed'} · ${safeText(entry.failure?.message ?? 'process tree may still be running')}`,
    )
  }
  return lines.join('\n')
}
