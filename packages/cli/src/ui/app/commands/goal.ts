import type { GoalVerifier } from '@x-code-cli/core'

const DEFAULT_SUBAGENT_VERIFIER_PROMPT =
  'Verify that the current goal objective is fully complete in the repository/session state.'

export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = []
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g
  for (const match of input.matchAll(re)) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\"/g, '"').replace(/\\'/g, "'"))
  }
  return tokens
}

export function parseGoalCreateArgs(arg: string): {
  objective: string
  maxTurns?: number
  tokenBudget?: number
  requiresUserConfirmation?: boolean
  verifiers: GoalVerifier[]
} {
  const tokens = tokenizeArgs(arg)
  const objectiveParts: string[] = []
  const verifiers: GoalVerifier[] = []
  let maxTurns: number | undefined
  let tokenBudget: number | undefined
  let requiresUserConfirmation = false
  let verifierPrompt = DEFAULT_SUBAGENT_VERIFIER_PROMPT

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--verify') {
      const command = tokens[++i]
      if (command) verifiers.push({ kind: 'shell', command, timeoutMs: 120000 })
      continue
    }
    if (token === '--max-turns') {
      const value = Number(tokens[++i])
      if (Number.isFinite(value) && value > 0) maxTurns = Math.floor(value)
      continue
    }
    if (token === '--token-budget') {
      const value = Number(tokens[++i])
      if (Number.isFinite(value) && value > 0) tokenBudget = Math.floor(value)
      continue
    }
    if (token === '--confirm') {
      requiresUserConfirmation = true
      continue
    }
    if (token === '--verifier-prompt') {
      verifierPrompt = tokens[++i] ?? verifierPrompt
      const latestSubAgent = findLatestSubAgentVerifier(verifiers)
      if (latestSubAgent?.kind === 'subagent') latestSubAgent.prompt = verifierPrompt
      continue
    }
    if (token === '--verifier-agent') {
      const agent = tokens[++i]
      if (agent) {
        verifiers.push({
          kind: 'subagent',
          agent,
          prompt: verifierPrompt,
          timeoutMs: 120000,
        })
      }
      continue
    }
    objectiveParts.push(token)
  }

  return {
    objective: objectiveParts.join(' ').trim(),
    maxTurns,
    tokenBudget,
    requiresUserConfirmation,
    verifiers,
  }
}

function findLatestSubAgentVerifier(
  verifiers: GoalVerifier[],
): Extract<GoalVerifier, { kind: 'subagent' }> | undefined {
  for (let i = verifiers.length - 1; i >= 0; i--) {
    const verifier = verifiers[i]
    if (verifier.kind === 'subagent') return verifier
  }
  return undefined
}
