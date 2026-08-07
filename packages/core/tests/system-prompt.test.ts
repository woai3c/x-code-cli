import { describe, expect, it } from 'vitest'

import { buildSystemPrompt } from '../src/agent/system-prompt.js'
import { createTaskTool } from '../src/tools/task.js'
import { todoWrite } from '../src/tools/todo-write.js'

describe('system prompt budget and stability', () => {
  it('keeps the default prompt compact without dropping safety boundaries', () => {
    const prompt = buildSystemPrompt({ modelId: 'test:model', isGitRepo: true })

    expect(prompt.length).toBeLessThan(5_000)
    expect(prompt).not.toContain('## Capabilities')
    expect(prompt).not.toContain('## Skills')
    expect(prompt).not.toMatch(/curl|PowerShell|Invoke-WebRequest/)
    expect(prompt).toContain('`/skill install`')
    expect(prompt).toContain('shell may download the raw file directly')
    expect(prompt).toContain('never reconstruct `SKILL.md` with `webFetch + writeFile`')
    expect(prompt).toContain('run `/skill refresh` or restart `xc`')
    expect(prompt).toContain('Read a file before modifying it')
    expect(prompt).toContain('Try direct tools first')
    expect(prompt).toContain('independent read-only task calls in the same assistant turn')
    expect(prompt).toContain('Never run concurrent writers against the same files')
    expect(prompt).toContain('Never modify the managed memory store')
    expect(prompt).toContain('If a tool result starts with [Truncated:]')
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
    expect(description).toContain('Every call replaces the entire list')
    expect(description).toContain('exactly one item in_progress')
    expect(description).toContain('automatically cleared')
  })
})
