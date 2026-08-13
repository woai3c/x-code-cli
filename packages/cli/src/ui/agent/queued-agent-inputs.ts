import type { QueuedAgentInput } from '@x-code-cli/core'

export function partitionQueuedInputsForDraft(inputs: readonly QueuedAgentInput[]): {
  draft: string
  retained: Extract<QueuedAgentInput, { source: 'peer' }>[]
} {
  const users = inputs.filter(
    (input): input is Extract<QueuedAgentInput, { source: 'user' }> => input.source === 'user',
  )
  return {
    draft: users.map((input) => input.display).join('\n\n'),
    retained: inputs.filter((input): input is Extract<QueuedAgentInput, { source: 'peer' }> => input.source === 'peer'),
  }
}

export function takeFreshQueuedInput(inputs: readonly QueuedAgentInput[]): {
  next?: QueuedAgentInput
  remaining: QueuedAgentInput[]
} {
  const userIndex = inputs.findIndex((input) => input.source === 'user')
  const index = userIndex >= 0 ? userIndex : 0
  const next = inputs[index]
  if (!next) return { remaining: [] }
  return { next, remaining: inputs.filter((_, candidateIndex) => candidateIndex !== index) }
}

export function ownerMayDrainQueuedInputs(
  owner: 'user' | 'peer' | 'goal' | 'compact' | 'resume' | 'rewind' | 'clear' | 'maintenance',
): boolean {
  return owner === 'user' || owner === 'peer'
}
