import { describe, expect, it, vi } from 'vitest'

import { createGoalRunCoordinator } from '../src/agent/goal/coordinator.js'

describe('goal run coordinator', () => {
  it('joins an active run instead of starting a second runner', async () => {
    const coordinator = createGoalRunCoordinator()
    let release!: () => void
    const started = vi.fn()
    const first = coordinator.run('g1', async () => {
      started()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return 'done'
    })
    const second = coordinator.run('g1', async () => {
      started()
      return 'other'
    })

    release()
    await expect(first).resolves.toBe('done')
    await expect(second).resolves.toBe('done')
    expect(started).toHaveBeenCalledTimes(1)
  })

  it('interrupts the active run', async () => {
    const coordinator = createGoalRunCoordinator()
    let observed = false
    const run = coordinator.run('g1', async (signal) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      observed = signal.aborted
    })

    await coordinator.interrupt('g1')
    await run
    expect(observed).toBe(true)
  })
})
