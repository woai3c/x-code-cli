import { getContextWindow } from '@x-code-cli/core'
import type { GoalState, TokenUsage } from '@x-code-cli/core'

export function compactionHintForResume(
  tokens: number | null,
  estimatedTokens: number,
  modelId: string,
): string | null {
  const window = getContextWindow(modelId)
  const used = Math.max(tokens ?? 0, estimatedTokens)
  if (used === 0) return null
  const pct = (used / window) * 100
  if (pct < 60) return null
  return `\n\n_Context is at **${pct.toFixed(0)}%** of the ${window.toLocaleString('en-US')}-token window — consider \`/compact\` before continuing, or it'll auto-compress on the next turn._`
}

export function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 48) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 14) return `${days}d ago`
  return new Date(epochMs).toISOString().slice(0, 10)
}

export function canResumeGoalStatus(goal: GoalState): boolean {
  return (
    goal.status === 'active' || goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'max_turns'
  )
}

function formatGoalTokenBudget(goal: GoalState, usage?: TokenUsage): string {
  if (!goal.tokenBudget) return 'unlimited'
  const used = usage ? Math.max(0, usage.totalTokens - goal.baselineTokens) : undefined
  const remaining = used === undefined ? undefined : Math.max(0, goal.tokenBudget - used)
  const total = goal.tokenBudget.toLocaleString('en-US')
  return remaining === undefined ? total : `${remaining.toLocaleString('en-US')} remaining / ${total}`
}

export function formatGoalStatus(goal: GoalState, usage?: TokenUsage): string {
  const latest = goal.verificationResults.at(-1)
  const verifiers = goal.verifiers.length
    ? [
        ...goal.verifiers.map((verifier, index) => {
          if (verifier.kind === 'shell') return `${index + 1}. shell: \`${verifier.command}\``
          if (verifier.kind === 'subagent') return `${index + 1}. subagent: ${verifier.agent}`
          return `${index + 1}. file: ${verifier.path}`
        }),
        `${goal.verifiers.length + 1}. automatic semantic verifier`,
      ].join('\n')
    : 'automatic semantic verifier'
  return [
    '**Goal Status**',
    '',
    `- Objective: ${goal.objective}`,
    `- Status: ${goal.status}`,
    goal.status === 'active'
      ? '- Background execution: running; `/goal status` does not pause it. Use `/goal pause` to stop after viewing status.'
      : '',
    `- Turns: ${goal.turnCount}/${goal.maxTurns ?? 'unlimited'}`,
    `- Token budget: ${formatGoalTokenBudget(goal, usage)}`,
    `- Pending transition: ${goal.pendingTransition?.kind ?? 'none'}`,
    `- Completion verification: ${goal.pendingTransition?.kind === 'complete_requested' ? 'running' : 'idle'}`,
    `- Latest verifier: ${latest ? `${latest.ok ? 'passed' : 'failed'} - ${latest.summary}` : 'none'}`,
    `- Repeated blocker: ${goal.repeatedBlockerCount}`,
    `- Repeated verification failure: ${goal.repeatedVerificationFailureCount}`,
    '',
    '**Verifiers**',
    verifiers,
    goal.finalSummary ? `\n**Final Summary**\n${goal.finalSummary}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
