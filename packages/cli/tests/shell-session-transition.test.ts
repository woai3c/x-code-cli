import type { ShellSessionController, TerminateAllResult } from '@x-code-cli/core'

import { disposeShellSessionsForTransition } from '../src/ui/agent/shell-session-transition.js'

function disposalResult(treeConfirmedExited: boolean): TerminateAllResult {
  return {
    managerInstanceId: 'manager-a',
    reason: 'clear',
    requested: 1,
    confirmed: treeConfirmedExited ? 1 : 0,
    alreadyExited: 0,
    results: [
      {
        managerInstanceId: 'manager-a',
        shellId: 'bg_1',
        reason: 'clear',
        disposition: treeConfirmedExited ? 'terminated' : 'failed',
        gracefulAttempted: true,
        forceAttempted: !treeConfirmedExited,
        rootExited: true,
        treeConfirmedExited,
        terminationConfirmed: treeConfirmedExited,
        output: '',
      },
    ],
  }
}

function manager(dispose: ShellSessionController['dispose']): Pick<ShellSessionController, 'dispose'> {
  return { dispose }
}

describe('shell session transitions', () => {
  it.each(['clear', 'resume'] as const)('blocks %s when any process tree remains unconfirmed', async (reason) => {
    const result = disposalResult(false)
    result.reason = reason
    result.results[0]!.reason = reason

    await expect(
      disposeShellSessionsForTransition(manager(vi.fn().mockResolvedValue(result)), reason),
    ).resolves.toEqual({
      ok: false,
      reason: 'background terminal cleanup was not confirmed',
      result,
    })
  })

  it('allows the transition only after every process tree is confirmed exited', async () => {
    const result = disposalResult(true)

    await expect(
      disposeShellSessionsForTransition(manager(vi.fn().mockResolvedValue(result)), 'clear'),
    ).resolves.toEqual({ ok: true, result })
  })

  it('turns disposal failures into a transition failure', async () => {
    await expect(
      disposeShellSessionsForTransition(
        manager(vi.fn().mockRejectedValue(new Error('supervisor unavailable'))),
        'resume',
      ),
    ).resolves.toEqual({ ok: false, reason: 'supervisor unavailable' })
  })
})
