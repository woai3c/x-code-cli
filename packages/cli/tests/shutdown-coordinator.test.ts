import { runShutdownPhases } from '../src/shutdown-coordinator.js'

const timing = {
  shellBudget: { gracefulMs: 1, forceMs: 1, confirmMs: 1 },
  ordinaryDrainMs: 10,
  hardCapMs: 40,
  emergencyReserveMs: 10,
}

describe('CLI shutdown coordinator', () => {
  it('runs shell cleanup before ordinary drains and shares one absolute deadline with emergency cleanup', async () => {
    const order: string[] = []
    let emergencyDeadline = 0
    const startedAt = performance.now()
    const result = await runShutdownPhases({
      controller: {
        terminateShells: async () => {
          order.push('shell')
          return null
        },
        drain: async () => {
          order.push('drain')
        },
      },
      reason: 'cli-shutdown',
      ordinaryFinalizers: [
        async () => {
          order.push('ordinary')
        },
      ],
      timing,
      startedAt,
      forceSync: (reason, deadline) => {
        order.push('emergency')
        emergencyDeadline = deadline
        return { reason, requested: 0, results: [] }
      },
    })

    expect(order[0]).toBe('shell')
    expect(order.at(-1)).toBe('emergency')
    expect(emergencyDeadline).toBe(result.absoluteDeadline)
    expect(result.absoluteDeadline).toBe(startedAt + timing.hardCapMs)
    expect(result.shellPhaseTimedOut).toBe(false)
    expect(result.ordinaryPhaseTimedOut).toBe(false)
  })

  it('enters emergency reserve without waiting forever for a stuck shell provider', async () => {
    const startedAt = performance.now()
    const result = await runShutdownPhases({
      controller: {
        terminateShells: () => new Promise(() => {}),
        drain: async () => {},
      },
      reason: 'sighup',
      ordinaryFinalizers: [],
      timing,
      startedAt,
      forceSync: (reason, deadline) => ({
        reason,
        requested: 1,
        results: [
          {
            managerInstanceId: 'manager',
            shellId: 'bg_1',
            disposition: deadline > 0 ? 'force-sent-unconfirmed' : 'failed',
          },
        ],
      }),
    })

    expect(result.shellPhaseTimedOut).toBe(true)
    expect(result.emergency.requested).toBe(1)
    expect(performance.now()).toBeLessThanOrEqual(result.absoluteDeadline + 20)
  })
})
