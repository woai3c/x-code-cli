import type { GoalState, GoalVerificationResult } from './types.js'

export function buildInitialGoalPrompt(goal: GoalState): string {
  return [
    `<goal id="${goal.id}">`,
    `Objective: ${goal.objective}`,
    '',
    'You are now running under a durable goal loop. Continue working until the objective is fully satisfied.',
    'Use getGoal to inspect goal state. When you believe the objective is complete, call updateGoal with status "complete" and concrete evidence.',
    'If you are blocked by the same external condition repeatedly, call updateGoal with status "blocked" and explain the blocker.',
    'Do not claim terminal completion in normal text; terminal completion only happens after updateGoal and host verification.',
    '</goal>',
  ].join('\n')
}

export function buildContinuationPrompt(goal: GoalState): string {
  return [
    `<goal_continuation id="${goal.id}">`,
    `Objective: ${goal.objective}`,
    `Outer turn: ${goal.turnCount + 1}/${goal.maxTurns}`,
    'Continue from the current repository/session state. Inspect what remains, perform the next useful work, and request completion with updateGoal only when verifiable evidence is available.',
    '</goal_continuation>',
  ].join('\n')
}

export function buildVerifierFailurePrompt(
  goal: GoalState,
  results: GoalVerificationResult[],
  summary: string,
): string {
  const details = results
    .filter((result) => !result.ok)
    .map((result, index) => `${index + 1}. ${result.summary}`)
    .join('\n')
  return [
    `<goal_verifier_failure id="${goal.id}">`,
    `Objective: ${goal.objective}`,
    `Verifier summary: ${summary}`,
    details ? `Failures:\n${details}` : 'No detailed failure output was recorded.',
    '',
    'Fix the issues above, then request completion again with updateGoal when evidence is available.',
    '</goal_verifier_failure>',
  ].join('\n')
}

export function buildBlockedRetryPrompt(goal: GoalState, blocker: string, repeatedCount: number): string {
  return [
    `<goal_blocker_retry id="${goal.id}">`,
    `Objective: ${goal.objective}`,
    `Reported blocker (${repeatedCount}/3): ${blocker}`,
    'Try to make progress around the blocker if possible. Only request blocked again if the same external condition still prevents meaningful progress.',
    '</goal_blocker_retry>',
  ].join('\n')
}

export function buildFinalSummaryPrompt(goal: GoalState, reason: 'max_turns' | 'budget_limited'): string {
  const latestVerification = goal.verificationResults.at(-1)
  return [
    `<goal_final_summary id="${goal.id}">`,
    `Objective: ${goal.objective}`,
    `Stopping reason: ${reason}`,
    `Turns used: ${goal.turnCount}/${goal.maxTurns}`,
    latestVerification
      ? `Latest verifier: ${latestVerification.ok ? 'passed' : 'failed'} - ${latestVerification.summary}`
      : '',
    '',
    'Produce a concise final status report with: completed work, remaining work, latest verification evidence, and next recommended steps.',
    'Do not use tools. Do not claim verified completion unless the verifier passed.',
    '</goal_final_summary>',
  ]
    .filter(Boolean)
    .join('\n')
}
