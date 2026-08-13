import { describe, expect, it } from 'vitest'

import { createGoal, pauseGoal, requestGoalBlocked, requestGoalComplete, resumeGoal } from '../src/agent/goal/state.js'
import { createLoopState } from '../src/agent/loop-state.js'

describe('goal state', () => {
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

  it('leaves turn and token limits unlimited unless explicitly configured', () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'keep working until verified' })

    expect(goal.maxTurns).toBeUndefined()
    expect(goal.tokenBudget).toBeUndefined()
    expect(goal.repeatedVerificationFailureCount).toBe(0)
  })

  it('pauses and resumes a goal', () => {
    const state = createLoopState()
    createGoal(state, { objective: 'ship feature' })

    expect(pauseGoal(state).status).toBe('paused')
    expect(resumeGoal(state).status).toBe('active')
  })

  it('records completion as a pending transition instead of terminal state', () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'verify completion' })

    const transition = requestGoalComplete(state, { evidence: 'pnpm test passed' })

    expect(goal.status).toBe('active')
    expect(transition.kind).toBe('complete_requested')
    expect(goal.pendingTransition?.evidence).toBe('pnpm test passed')
  })

  it('requires blocker text for blocked requests', () => {
    const state = createLoopState()
    createGoal(state, { objective: 'deploy' })

    expect(() => requestGoalBlocked(state, { blocker: '' })).toThrow(/Blocker/)
    expect(requestGoalBlocked(state, { blocker: 'missing API key' }).kind).toBe('blocked_requested')
  })
})
