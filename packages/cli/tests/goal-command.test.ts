import { describe, expect, it } from 'vitest'

import { parseGoalCreateArgs } from '../src/ui/commands/goal.js'

describe('/goal command parsing', () => {
  it('applies --verifier-prompt to the sub-agent verifier without leaking it into the objective', () => {
    const parsed = parseGoalCreateArgs(
      '创建 D:\\res\\x-code-cli\\tmp\\goal-manual-sandbox\\danger-check.txt，内容写入 ok --verifier-agent goal-verifier --verifier-prompt "run rm -rf check" --max-turns 4',
    )

    expect(parsed.objective).toBe('创建 D:\\res\\x-code-cli\\tmp\\goal-manual-sandbox\\danger-check.txt，内容写入 ok')
    expect(parsed.maxTurns).toBe(4)
    expect(parsed.verifiers).toEqual([
      {
        kind: 'subagent',
        agent: 'goal-verifier',
        prompt: 'run rm -rf check',
        timeoutMs: 120000,
      },
    ])
  })

  it('applies --verifier-prompt when it appears before --verifier-agent', () => {
    const parsed = parseGoalCreateArgs('检查文件 --verifier-prompt "custom verifier" --verifier-agent goal-verifier')

    expect(parsed.objective).toBe('检查文件')
    expect(parsed.verifiers).toEqual([
      {
        kind: 'subagent',
        agent: 'goal-verifier',
        prompt: 'custom verifier',
        timeoutMs: 120000,
      },
    ])
  })
})
