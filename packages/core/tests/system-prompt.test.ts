import { describe, expect, it } from 'vitest'

import { asSchema, safeValidateTypes } from '@ai-sdk/provider-utils'

import { buildSubAgentSystemPrompt, buildSystemPrompt, formatMcpCapabilities } from '../src/agent/system-prompt.js'
import { shellOutput } from '../src/tools/background-shell.js'
import { shell } from '../src/tools/shell.js'
import { createTaskTool } from '../src/tools/task.js'

describe('system prompt budget and stability', () => {
  it('keeps the default prompt compact without dropping safety boundaries', () => {
    const prompt = buildSystemPrompt({
      modelId: 'test:model',
      isGitRepo: true,
      hasBrowserVisualCheck: true,
      hasPeerTools: true,
      hasTaskTool: true,
      hasMemoryService: true,
    })

    expect(prompt.length).toBeLessThan(5_000)
    expect(prompt).not.toContain('## Capabilities')
    expect(prompt).not.toContain('## Skills')
    expect(prompt).not.toContain('## Task Management')
    expect(prompt).not.toContain('todoWrite')
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
    expect(prompt).toMatch(/- Date: \d{4}-\d{2}-\d{2}/)
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
  it('keeps worktree and legacy flags out of wire schemas while preserving runtime compatibility', async () => {
    const shellWire = await asSchema(shell.inputSchema as any).jsonSchema
    expect(Object.keys(shellWire.properties ?? {})).toEqual([
      'command',
      'timeout',
      'yieldTimeMs',
      'cwd',
      'maxOutputTokens',
      'tty',
    ])
    const shellValidated = await safeValidateTypes({
      value: { command: 'npm run dev', runInBackground: true },
      schema: asSchema(shell.inputSchema as any),
    })
    expect(shellValidated).toMatchObject({
      success: true,
      value: { command: 'npm run dev', runInBackground: true },
    })

    const outputWire = await asSchema(shellOutput.inputSchema as any).jsonSchema
    expect(Object.keys(outputWire.properties ?? {})).toEqual([
      'shellId',
      'chars',
      'cols',
      'rows',
      'yieldTimeMs',
      'maxOutputTokens',
    ])
    const outputValidated = await safeValidateTypes({
      value: { shellId: 'sh-1', block: false, timeout: 1000 },
      schema: asSchema(shellOutput.inputSchema as any),
    })
    expect(outputValidated).toMatchObject({
      success: true,
      value: { shellId: 'sh-1', block: false, timeout: 1000 },
    })

    expect(shell.description).not.toContain('isolation')
    expect(shell.description).not.toContain('verify the parent with listDir')
  })

  it('omits deferred resource tools from ## MCP Tools when includeResourceTools is false and includes Date in sub-agent prompts', () => {
    const mcpBlock = formatMcpCapabilities(
      [{ serverName: 'srv', callableName: 'mcp__srv__ping', description: 'Ping' }],
      { includeResourceTools: false },
    )
    expect(mcpBlock).toContain('mcp__srv__ping')
    expect(mcpBlock).not.toContain('listMcpResources')
    expect(mcpBlock).not.toContain('readMcpResource')

    const subPrompt = buildSubAgentSystemPrompt({
      agentPrompt: 'Explore files',
      knowledgeContext: '',
      isGitRepo: true,
    })
    expect(subPrompt).toMatch(/- Date: \d{4}-\d{2}-\d{2}/)
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
})
