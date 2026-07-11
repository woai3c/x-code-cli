import type { GoalState, GoalVerificationResult } from './types.js'

export function buildInitialGoalPrompt(goal: GoalState): string {
  return [
    `<goal id="${goal.id}">`,
    `Objective: ${goal.objective}`,
    '',
    'You are now running under a durable goal loop. Continue working until the objective is fully satisfied.',
    'This is the only current goal. Treat any earlier goal messages in the transcript as historical context, not active work.',
    'Before acting, derive the concrete requirements and authoritative checks from the objective, referenced artifacts, repository instructions, and current project structure. Keep the full objective intact; do not narrow success to the easiest passing check.',
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
    `Outer turn: ${goal.turnCount + 1}/${formatMaxTurns(goal.maxTurns)}`,
    'Continue only this current goal. Do not resume or report earlier goals from the transcript as active.',
    'Continue from the current repository/session state. Inspect what remains, perform the next useful work, and request completion with updateGoal only when verifiable evidence is available.',
    'Before requesting completion, audit every requirement implied by the original objective and repository instructions against current authoritative evidence.',
    '</goal_continuation>',
  ].join('\n')
}

export function buildVerifierFailurePrompt(
  goal: GoalState,
  results: GoalVerificationResult[],
  summary: string,
  repeatedCount = 1,
): string {
  const details = results
    .filter((result) => !result.ok)
    .map((result, index) => {
      const evidence = [
        ...(result.findings?.map((finding) => `finding: ${finding}`) ?? []),
        ...(result.requiredFixes?.map((fix) => `required fix: ${fix}`) ?? []),
      ]
      return [`${index + 1}. ${result.summary}`, ...evidence.map((item) => `   - ${item}`)].join('\n')
    })
    .join('\n')
  return [
    `<goal_verifier_failure id="${goal.id}">`,
    `Objective: ${goal.objective}`,
    `Verifier summary: ${summary}`,
    'Fix only this current goal. Earlier goals in the transcript are historical and must not be advanced.',
    details ? `Failures:\n${details}` : 'No detailed failure output was recorded.',
    `Consecutive equivalent verification failures: ${repeatedCount}.`,
    '',
    repeatedCount === 1
      ? 'Fix the issues above, then request completion again with updateGoal when evidence is available.'
      : repeatedCount === 2
        ? 'This verification failure repeated. Reproduce it from current evidence, identify the root cause, and do not repeat the previous action unchanged. Then use a different justified fix strategy.'
        : 'This verification failure has repeated multiple times. Stop repeating the same approach. Re-check your assumptions and actual command/file output, explain what the previous strategy missed, choose a materially different strategy, and only then make the next change.',
    '</goal_verifier_failure>',
  ].join('\n')
}

export function buildBlockedRetryPrompt(goal: GoalState, blocker: string, repeatedCount: number): string {
  return [
    `<goal_blocker_retry id="${goal.id}">`,
    `Objective: ${goal.objective}`,
    `Reported blocker (${repeatedCount}/3): ${blocker}`,
    'Retry only this current goal. Earlier goals in the transcript are historical and must not be advanced.',
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
    `Turns used: ${goal.turnCount}/${formatMaxTurns(goal.maxTurns)}`,
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

function formatMaxTurns(maxTurns: number | undefined): string {
  return maxTurns === undefined ? 'unlimited' : String(maxTurns)
}
