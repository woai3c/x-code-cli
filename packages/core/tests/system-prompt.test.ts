import { describe, expect, it } from 'vitest'

import { buildSystemPrompt } from '../src/agent/system-prompt.js'
import { shell } from '../src/tools/shell.js'
import { createTaskTool } from '../src/tools/task.js'
import { todoWrite } from '../src/tools/todo-write.js'

describe('system prompt budget and stability', () => {
  it('keeps the default prompt compact without dropping safety boundaries', () => {
    const prompt = buildSystemPrompt({
      modelId: 'test:model',
      isGitRepo: true,
      hasBrowserVisualCheck: true,
      hasPeerTools: true,
      hasTaskTool: true,
      hasTodoTool: true,
      hasMemoryService: true,
    })

    expect(prompt.length).toBeLessThan(5_000)
    expect(prompt).not.toContain('## Capabilities')
    expect(prompt).not.toContain('## Skills')
    expect(prompt).not.toMatch(/curl|PowerShell|Invoke-WebRequest/)
    expect(prompt).not.toContain('`/skill install`')
    expect(prompt).toContain('Read a file before modifying it')
    expect(prompt).toContain('Use direct tools for focused work')
    expect(prompt).toContain('never run concurrent writers against the same files')
    expect(prompt).toContain('Never access the managed memory store')
    expect(prompt).toContain('If a tool result starts with [Truncated:]')
    expect(prompt).toContain('call browserVisualCheck once before finishing')
    expect(prompt).toContain('decide from task and repo state whether to use ordinary `git worktree` commands')
    expect(prompt).toContain('remove only the worktree and branch you created')
    expect(prompt).not.toContain('select worktree isolation for the shell call')
  })

  it('omits instructions for unavailable optional capabilities', () => {
    const prompt = buildSystemPrompt({ modelId: 'test:model', isGitRepo: false })

    expect(prompt).not.toContain('browserVisualCheck')
    expect(prompt).not.toContain('<peer_message>')
    expect(prompt).not.toContain('## Delegation')
    expect(prompt).not.toContain('## Task Management')
    expect(prompt).not.toContain('## Long-term Memory')
    expect(prompt).not.toContain('/skill install')
  })

  it('lists enabled skills once and keeps identical options byte-stable', () => {
    const options = {
      modelId: 'test:model',
      isGitRepo: false,
      skills: [
        { name: 'review', description: 'Review a patch' },
        { name: 'docs', description: 'Write documentation' },
      ],
    }
    const first = buildSystemPrompt(options)
    const second = buildSystemPrompt(options)

    expect(first).toBe(second)
    expect(first).toContain('## Available Skills')
    expect(first.match(/review: Review a patch/g)).toHaveLength(1)
    expect(first.match(/docs: Write documentation/g)).toHaveLength(1)
    expect(first).toContain('`/skill install`')
  })

  it('keeps default and plan prompts independently stable', () => {
    const baseOptions = { modelId: 'test:model', isGitRepo: true }
    const defaultPrompt = buildSystemPrompt(baseOptions)
    const planOptions = { ...baseOptions, planMode: true, planFilePath: '/tmp/plan.md' }

    expect(buildSystemPrompt(baseOptions)).toBe(defaultPrompt)
    expect(buildSystemPrompt(planOptions)).toBe(buildSystemPrompt(planOptions))
    expect(defaultPrompt).not.toContain('Plan mode is active')
    expect(buildSystemPrompt(planOptions)).toContain('Plan mode is active')
  })

  it('stays byte-identical across dynamic peer discovery and status changes', () => {
    const options = { modelId: 'test:model', isGitRepo: true }
    const before = buildSystemPrompt(options)
    const dynamicPeers = [
      { name: 'frontend', address: 'peer:dynamic-one', status: 'idle' },
      { name: 'backend', address: 'peer:dynamic-two', status: 'busy' },
    ]
    dynamicPeers[0]!.status = 'waiting'
    dynamicPeers.push({ name: 'worker', address: 'peer:dynamic-three', status: 'idle' })

    expect(buildSystemPrompt(options)).toBe(before)
    expect(before).not.toContain('dynamic-one')
    expect(before).not.toContain('frontend')
  })

  it('does not claim absent core tools are always directly loaded', () => {
    const prompt = buildSystemPrompt({
      modelId: 'test:model',
      deferredTools: [{ name: 'webFetch', source: 'builtin' }],
    })

    expect(prompt).not.toContain('task) are always loaded')
    expect(prompt).toContain('Do not search for a tool already present')
  })
})

describe('heavy tool description budgets', () => {
  it('keeps worktree decisions in the model instead of the shell runtime schema', () => {
    expect(Object.keys((shell.inputSchema as any).shape)).toEqual([
      'command',
      'timeout',
      'yieldTimeMs',
      'cwd',
      'maxOutputTokens',
      'tty',
      'runInBackground',
    ])
    expect(shell.description).not.toContain('isolation')
  })

  it('keeps task guidance focused without repeated dialogue examples', () => {
    const task = createTaskTool({
      list: () => [{ name: 'reviewer', description: 'Review pending code changes' }],
      names: () => ['reviewer'],
    } as any)
    const description = task.description ?? ''

    expect(description.length).toBeLessThan(2_500)
    expect(description).not.toContain('<example>')
    expect(description).toContain('Prompt contract')
    expect(description).toContain('Never run concurrent agents that can write the same files')
  })

  it('keeps todo replacement and lifecycle invariants in a compact description', () => {
    const description = todoWrite.description ?? ''

    expect(description.length).toBeLessThan(2_000)
    expect(description).toContain('Replace the complete live checklist')
    expect(description).toContain('exactly one item in_progress')
    expect(description).toContain('automatically cleared')
  })
})
