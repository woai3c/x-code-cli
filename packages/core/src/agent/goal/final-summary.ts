import { buildFinalSummaryPrompt } from './prompts.js'
import type { GoalState, GoalStatus } from './types.js'

export interface RunFinalSummaryInput {
  goal: GoalState
  reason: Extract<GoalStatus, 'max_turns' | 'budget_limited'>
  runAgentTurn: (content: string, options: { silent: boolean; finalSummary: boolean }) => Promise<{ text?: string }>
}

export async function runFinalSummaryTurn(input: RunFinalSummaryInput): Promise<string> {
  const result = await input.runAgentTurn(buildFinalSummaryPrompt(input.goal, input.reason), {
    silent: true,
    finalSummary: true,
  })
  const summary = result.text?.trim()
  return summary || `${input.reason}: final summary turn completed without a text response.`
}
