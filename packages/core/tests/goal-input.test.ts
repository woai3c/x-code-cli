import { describe, expect, it } from 'vitest'

import { admitGoalInput, hasPendingGoalInput, promoteNextGoalInput } from '../src/agent/goal/input.js'
import { createGoal } from '../src/agent/goal/state.js'
import { createLoopState } from '../src/agent/loop-state.js'

describe('goal input queue', () => {
  it('admits and promotes durable goal inputs in order', () => {
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
})
