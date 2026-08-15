import { formatBackgroundTerminals, formatStopResult } from '../src/ui/app/commands/background-terminal.js'

describe('background terminal slash command formatting', () => {
  it('lists only live managed trees and sanitizes terminal controls', () => {
    const text = formatBackgroundTerminals(
      [
        {
          managerInstanceId: 'manager',
          ownerSessionId: 'owner',
          shellId: 'bg_1',
          originToolCallId: 'call',
          command: '\x1b]0;owned\x07pnpm dev',
          effectiveCwd: 'C:\\repo',
          tty: false,
          status: 'running',
          yielded: true,
          spawnOutcome: 'ready',
          cleanupResidual: false,
          spawnRequestedAt: 1,
          startedAt: 1_000,
          rootExited: false,
          treeConfirmedExited: false,
          outputFinalized: false,
          timedOut: false,
          recentOutput: 'Local: http://localhost:3000',
          omittedBytes: 0,
          uiOmittedBytes: 0,
        },
      ],
      3_000,
    )

    expect(text).toContain('bg_1 · pnpm dev · 2s')
    expect(text).toContain('Local: http://localhost:3000')
    expect(text).not.toContain('\x1b')
  })

  it('does not report requested targets as stopped when confirmation failed', () => {
    const text = formatStopResult({
      managerInstanceId: 'manager',
      reason: 'stop-command',
      requested: 2,
      confirmed: 1,
      alreadyExited: 0,
      results: [
        {
          managerInstanceId: 'manager',
          shellId: 'bg_1',
          reason: 'stop-command',
          disposition: 'terminated',
          gracefulAttempted: true,
          forceAttempted: false,
          rootExited: true,
          treeConfirmedExited: true,
          terminationConfirmed: true,
          output: '',
        },
        {
          managerInstanceId: 'manager',
          shellId: 'bg_2',
          reason: 'stop-command',
          disposition: 'still-running',
          gracefulAttempted: true,
          forceAttempted: true,
          rootExited: false,
          treeConfirmedExited: false,
          terminationConfirmed: false,
          failure: { code: 'termination-unconfirmed', message: 'still live' },
          output: '',
        },
      ],
    })

    expect(text).toContain('Stopped 1 background terminal; 1 could not be confirmed stopped.')
    expect(text).toContain('bg_2 · termination-unconfirmed · still live')
  })
})
