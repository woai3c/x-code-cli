import { describe, expect, it, vi } from 'vitest'

import { createGoalRunCoordinator } from '../src/agent/goal/coordinator.js'
import { admitGoalInput, hasPendingGoalInput, promoteNextGoalInput } from '../src/agent/goal/input.js'
import { createGoal, pauseGoal, requestGoalBlocked, requestGoalComplete, resumeGoal } from '../src/agent/goal/state.js'
import { createLoopState } from '../src/agent/loop-state.js'
import { createGetGoalTool } from '../src/tools/get-goal.js'
import { createUpdateGoalTool } from '../src/tools/update-goal.js'

describe('goal state, input queue, tools, and run coordinator', () => {
  it('creates an active goal and blocks replacement while unfinished', () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'fix tests', maxTurns: 3, tokenBudget: 1000 })

    expect(goal.status).toBe('active')
    expect(goal.objective).toBe('fix tests')
    expect(goal.maxTurns).toBe(3)
    expect(goal.tokenBudget).toBe(1000)
    expect(() => createGoal(state, { objective: 'another goal' })).toThrow(/Cannot create/)
  })

  it('captures peer authority durably and restores the taint when resumed', () => {
    const state = createLoopState()
    state.executionAuthority = { source: 'peer', peerTainted: true }
    const goal = createGoal(state, { objective: 'do not elevate this goal' })

    expect(goal.authority).toEqual({ source: 'peer', peerTainted: true })
    pauseGoal(state)
    state.executionAuthority = { source: 'user', peerTainted: false }
    resumeGoal(state)

    expect(state.executionAuthority).toEqual({ source: 'peer', peerTainted: true })
  })

  it('leaves turn and token limits unlimited unless explicitly configured and supports pause/resume', () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'keep working until verified' })

    expect(goal.maxTurns).toBeUndefined()
    expect(goal.tokenBudget).toBeUndefined()
    expect(goal.repeatedVerificationFailureCount).toBe(0)
    expect(pauseGoal(state).status).toBe('paused')
    expect(resumeGoal(state).status).toBe('active')
  })

  it('records completion and blocked transitions as pending verifier gates', () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'verify completion' })

    const transition = requestGoalComplete(state, { evidence: 'pnpm test passed' })
    expect(goal.status).toBe('active')
    expect(transition.kind).toBe('complete_requested')
    expect(goal.pendingTransition?.evidence).toBe('pnpm test passed')

    expect(() => requestGoalBlocked(state, { blocker: '' })).toThrow(/Blocker/)
    expect(requestGoalBlocked(state, { blocker: 'missing API key' }).kind).toBe('blocked_requested')
  })

  it('admits and promotes durable goal inputs in FIFO order', () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'finish work' })
    const first = admitGoalInput(state, { goalId: goal.id, kind: 'initial', content: 'start' })
    admitGoalInput(state, { goalId: goal.id, kind: 'continuation', content: 'continue' })

    expect(hasPendingGoalInput(state, goal.id)).toBe(true)
    expect(promoteNextGoalInput(state, goal.id)?.id).toBe(first.id)
    expect(first.promotedAt).toBeTruthy()
    expect(promoteNextGoalInput(state, goal.id)?.content).toBe('continue')
    expect(hasPendingGoalInput(state, goal.id)).toBe(false)
  })

  it('exposes getGoal and updateGoal tool contracts without bypassing terminal verification', async () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'make verifier pass', maxTurns: 5 })

    const getResult = await (createGetGoalTool(state) as any).execute({}, { toolCallId: 'tc1' })
    expect(getResult).toMatchObject({ ok: true, goal: { id: goal.id, objective: 'make verifier pass' } })

    const updateResult = await (createUpdateGoalTool(state) as any).execute(
      { status: 'complete', evidence: 'tests passed' },
      { toolCallId: 'tc2' },
    )
    expect(updateResult.ok).toBe(true)
    expect(goal.status).toBe('active')
    expect(goal.pendingTransition?.kind).toBe('complete_requested')
  })

  it('joins an active coordinator run instead of duplicating execution and propagates interruption', async () => {
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

    let observedAbort = false
    const interruptible = coordinator.run('g2', async (signal) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      observedAbort = signal.aborted
    })
    await coordinator.interrupt('g2')
    await interruptible
    expect(observedAbort).toBe(true)
  })
})
