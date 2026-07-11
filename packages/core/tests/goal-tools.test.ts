import { describe, expect, it } from 'vitest'

import { createGoal } from '../src/agent/goal/state.js'
import { createLoopState } from '../src/agent/loop-state.js'
import { createGetGoalTool } from '../src/tools/get-goal.js'
import { createUpdateGoalTool } from '../src/tools/update-goal.js'

describe('goal tools', () => {
  it('getGoal reports current goal state', async () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'make verifier pass', maxTurns: 5 })
    const result = await (createGetGoalTool(state) as any).execute({}, { toolCallId: 'tc1' })

    expect(result.ok).toBe(true)
    expect(result.goal.id).toBe(goal.id)
    expect(result.goal.objective).toBe('make verifier pass')
  })

  it('updateGoal requests completion without marking terminal complete', async () => {
    const state = createLoopState()
    const goal = createGoal(state, { objective: 'finish' })
    const result = await (createUpdateGoalTool(state) as any).execute(
      { status: 'complete', evidence: 'tests passed' },
      { toolCallId: 'tc2' },
    )

    expect(result.ok).toBe(true)
    expect(goal.status).toBe('active')
    expect(goal.pendingTransition?.kind).toBe('complete_requested')
  })
})
